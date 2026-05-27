const fs = require('fs');
const path = require('path');
const { chat, chatOneShot } = require('./claude-client');
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

const PROMPT_FUSION_SYSTEM = `你是一个 System Prompt 编辑助手。你的任务是将用户提供的新信息智能融合到现有的 System Prompt 中。

## 输入
你会收到两部分内容：
1. 当前的完整 System Prompt（在 <current-prompt> 标签中）
2. 用户的自然语言描述（在 <user-request> 标签中）

## 规则
1. 理解用户意图：用户可能想添加角色背景、调整回答风格、增加约束规则、补充上下文信息等
2. 智能归位：将新信息放到现有 prompt 中最合适的位置（如角色相关放「角色定义」下，回答规范放「回答规范」下）
3. 如果现有结构中没有合适的章节，创建一个新的章节
4. 保持一致性：新内容的格式（Markdown 标题层级、列表风格）与现有内容保持一致
5. 去重与冲突：如果新信息与现有内容重复，合并而不重复；如果矛盾，以用户最新指令为准
6. 清理痕迹：如果现有 prompt 末尾有明显未经处理的原始用户输入（看起来像聊天指令而非 prompt 内容的文本），将其信息提取并融合到合适位置，然后删除原始文本
7. 不要添加任何用户未提到的内容，不要擅自修改用户没有要求修改的部分

## 输出
直接输出融合后的完整 System Prompt 文本。不要加任何解释、说明、代码块包裹。只输出 prompt 本身。`;

function replaceSystemPrompt(content) {
  fs.writeFileSync(PROMPT_FILE, content.trim(), 'utf8');
}

async function mergeSystemPrompt(userRequest) {
  const currentPrompt = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
  const userMessage = `<current-prompt>\n${currentPrompt}\n</current-prompt>\n\n<user-request>\n${userRequest}\n</user-request>`;
  const merged = await chatOneShot(PROMPT_FUSION_SYSTEM, userMessage);
  fs.writeFileSync(PROMPT_FILE, merged.trim(), 'utf8');
  return merged.trim();
}

// ── footer ────────────────────────────────────────────────────────────────────
const COMMANDS_FOOTER = `
---
💡 \`/clear\` 清除历史 · \`/prompt\` 更新提示词 · 发送含「文档」的消息自动操作文档`.trim();

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
        await reply(sessionWebhook, '⏳ 正在理解你的意图并更新系统提示词...').catch(() => {});
        const after = await mergeSystemPrompt(newContent);
        const preview = after.length > 200 ? after.substring(0, 200) + '...' : after;
        await reply(sessionWebhook, `✅ 系统提示词已智能更新。\n\n**更新后预览：**\n\n${preview}`).catch(err => console.error('[handler] /prompt 回复失败:', err.message));
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

  // ── 自动触发 dws：消息含「文档」───────────────────────────────────────────
  if (userMessage.includes('文档')) {
    if (userMessage.trim() === '文档') {
      await reply(sessionWebhook, dwsHandler.buildHelpText()).catch(err => console.error('[handler] 帮助回复失败:', err.message));
    } else {
      await reply(sessionWebhook, '⏳ 收到，正在处理...').catch(() => {});
      try {
        await dwsHandler.handle(userMessage, sessionWebhook, sessionWebhookExpiredTime || null, sessionKey);
      } catch (err) {
        console.error('[handler] dws 自动触发失败:', err.message);
        await reply(sessionWebhook, `❌ 操作失败：${err.message}`).catch(err2 => console.error('[handler] dws 自动触发错误回复失败:', err2.message));
      }
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
