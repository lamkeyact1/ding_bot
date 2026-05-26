const fs = require('fs');
const path = require('path');
const { chat } = require('./claude-client');
const { reply } = require('./dingtalk-api');
const dwsHandler = require('./dws-handler');

// ── 会话存储 ──────────────────────────────────────────────────────────────────
const sessions = new Map();
const MAX_TURNS = 10;
const MAX_SESSIONS = 500;

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, session] of sessions) {
    if (session.lastActiveAt < cutoff) sessions.delete(key);
  }
}, 60 * 60 * 1000);

function getOrCreateSession(sessionKey) {
  if (!sessions.has(sessionKey)) {
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, s] of sessions) {
        if (s.lastActiveAt < oldestTime) { oldestTime = s.lastActiveAt; oldestKey = k; }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    sessions.set(sessionKey, { messages: [], lastActiveAt: Date.now() });
  }
  const session = sessions.get(sessionKey);
  session.lastActiveAt = Date.now();
  return session;
}

// ── 系统提示词读写 ────────────────────────────────────────────────────────────
const PROMPT_FILE = path.join(__dirname, '..', 'system-prompt.md');

function appendSystemPrompt(content) {
  const existing = fs.readFileSync(PROMPT_FILE, 'utf8').trimEnd();
  fs.writeFileSync(PROMPT_FILE, `${existing}\n\n${content.trim()}`, 'utf8');
}

function replaceSystemPrompt(content) {
  fs.writeFileSync(PROMPT_FILE, content.trim(), 'utf8');
}

// ── footer ────────────────────────────────────────────────────────────────────
const COMMANDS_FOOTER = `
---
💡 \`/clear\` 清除历史 · \`/prompt\` 追加提示词 · \`/dws\` 文档操作`.trim();

// ── 核心处理 ──────────────────────────────────────────────────────────────────
async function handle(payload) {
  const {
    msgtype, text, senderStaffId, conversationType, conversationId,
    sessionWebhook, sessionWebhookExpiredTime, chatbotUserId,
  } = payload;

  if (!sessionWebhook) return;
  if (sessionWebhookExpiredTime && Date.now() > sessionWebhookExpiredTime - 5000) return;

  let userMessage = '';
  if (msgtype === 'text') {
    userMessage = text?.content || '';
  } else {
    return;
  }

  if (conversationType === '2') {
    if (chatbotUserId) {
      userMessage = userMessage.replace(/^(@\S+\s*)/, '').trim();
    } else {
      userMessage = userMessage.replace(/@\S+/g, '').trim();
    }
  }

  if (!userMessage) return;

  const isGroup = conversationType === '2';
  const sessionKey = isGroup
    ? `${conversationId}:${senderStaffId}`
    : (senderStaffId || conversationId);

  console.log(`[handler] ${isGroup ? '群聊' : '单聊'} from=${senderStaffId} msg="${userMessage}"`);

  // ── /clear ──────────────────────────────────────────────────────────────────
  if (userMessage === '/clear' || userMessage === '清除历史') {
    sessions.delete(sessionKey);
    await reply(sessionWebhook, '✅ 对话历史已清除！').catch(err => console.error('[handler] /clear 回复失败:', err.message));
    return;
  }

  // ── /prompt ─────────────────────────────────────────────────────────────────
  const PROMPT_CMD = /^(?:\/prompt(?:-(replace))?\s+|(?:更新|修改|追加)(?:系统)?提示词[：:]\s*)([\s\S]+)/;
  const promptMatch = userMessage.match(PROMPT_CMD);
  if (promptMatch) {
    const isReplace = promptMatch[1] === 'replace';
    const newContent = promptMatch[2].trim();
    try {
      if (isReplace) {
        replaceSystemPrompt(newContent);
        await reply(sessionWebhook, '✅ 系统提示词已全量替换。').catch(err => console.error('[handler] /prompt 回复失败:', err.message));
      } else {
        appendSystemPrompt(newContent);
        await reply(sessionWebhook, '✅ 已追加到系统提示词末尾。').catch(err => console.error('[handler] /prompt 回复失败:', err.message));
      }
    } catch (err) {
      await reply(sessionWebhook, `❌ 更新失败：${err.message}`).catch(err2 => console.error('[handler] /prompt 错误回复失败:', err2.message));
    }
    return;
  }

  // ── /dws 确认流程拦截 ──────────────────────────────────────────────────────
  if (dwsHandler.hasPendingConfirmation(sessionKey)) {
    try {
      const handled = await dwsHandler.handleConfirmation(
        sessionKey, userMessage, sessionWebhook, sessionWebhookExpiredTime || null,
      );
      if (handled) return;
    } catch (err) {
      console.error('[handler] 确认流程失败:', err.message);
      await reply(sessionWebhook, `❌ 操作失败：${err.message}`).catch(err2 => console.error('[handler] 确认错误回复失败:', err2.message));
      return;
    }
  }

  // ── /dws ───────────────────────────────────────────────────────────────────
  if (userMessage.startsWith('/dws')) {
    const argText = userMessage.substring(4).trim();
    if (argText && argText !== '帮助' && argText !== 'help') {
      await reply(sessionWebhook, '⏳ 收到，正在处理...').catch(() => {});
    }
    try {
      await dwsHandler.handle(argText, sessionWebhook, sessionWebhookExpiredTime || null, sessionKey);
    } catch (err) {
      console.error('[handler] /dws 执行失败:', err.message);
      await reply(sessionWebhook, `❌ 操作失败：${err.message}`).catch(err2 => console.error('[handler] /dws 错误回复失败:', err2.message));
    }
    return;
  }

  // ── 普通对话 ────────────────────────────────────────────────────────────────
  const session = getOrCreateSession(sessionKey);
  session.messages.push({ role: 'user', content: userMessage });

  let replyText;
  try {
    replyText = await chat(session.messages);
  } catch (err) {
    console.error('[handler] Claude API 失败:', err.message);
    session.messages.pop();
    await reply(sessionWebhook, '抱歉，AI 服务暂时出现问题，请稍后再试。').catch(err2 => console.error('[handler] 错误回复发送失败:', err2.message));
    return;
  }

  session.messages.push({ role: 'assistant', content: replyText });
  if (session.messages.length > MAX_TURNS * 2) session.messages.splice(0, 2);

  try {
    await reply(sessionWebhook, replyText + '\n\n' + COMMANDS_FOOTER);
  } catch (err) {
    console.error('[handler] 发送回复失败:', err.message);
  }
}

module.exports = { handle };
