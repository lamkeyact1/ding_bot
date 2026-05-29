const { exec } = require('child_process');
const { chatMultiTurn } = require('./claude-client');
const { reply } = require('./dingtalk-api');

const DWS_BIN = process.env.DWS_PATH || 'dws';
const EXEC_TIMEOUT_MS = 30_000;
const MAX_AGENT_STEPS = 15;
const WEBHOOK_SAFETY_MARGIN_MS = 10_000;
const CONFIRM_EXPIRY_MS = 5 * 60 * 1000;
const MAX_RESULT_LEN = 6000;
const MAX_REPLY_LEN = 8000;

const pendingConfirmations = new Map();

// ── Agent 系统提示词 ─────────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `你是钉钉操作 Agent。你通过执行 dws CLI 命令来完成用户的请求。

## 回复格式

始终输出纯 JSON（不要 markdown 代码块包裹），格式为以下三种之一：

### 1. 执行命令
{"type":"execute","command":["doc","search","--query","周报"],"thought":"先搜索找到目标文档"}

command 是 dws 的参数数组。不要包含 "dws" 本身，也不要包含 "--format json" 或 "--yes"（系统自动加）。

### 2. 回复用户（任务完成）
{"type":"reply","text":"搜索到 3 篇文档：\\n- [周报](https://alidocs.dingtalk.com/i/nodes/xxx)\\n..."}

text 支持钉钉 Markdown。操作成功时必须提供：
1. 正文中的可点击链接：[文档名](https://alidocs.dingtalk.com/i/nodes/{nodeId})
2. 回复最末尾单独一行纯文本 URL（方便用户复制），与正文之间空一行

### 3. 请求用户确认（危险操作前）
{"type":"confirm","text":"即将覆盖文档「周报」的全部内容，确认吗？","pendingCommand":["doc","update","--node","xxx","--content","新内容","--mode","overwrite"]}

## 可用命令 — doc（完整参数）

| 命令 | 必选参数 | 可选参数 | 说明 |
|------|----------|----------|------|
| doc search | | --query <关键词> --page-size N | 搜索文档（不传 query 返回最近访问） |
| doc list | | --folder <ID或URL> --workspace <ID> --page-size N | 浏览文件列表 |
| doc read | --node <ID或URL> | | 读取文档 Markdown 内容 |
| doc info | --node <ID或URL> | | 查看文档元信息 |
| doc create | --name <名称> | --markdown <Markdown内容> --folder <文件夹ID> --workspace <知识库ID> | 创建文档 |
| doc update | --node <ID或URL> --content <Markdown内容> --mode append | --mode overwrite（危险，需确认） | 更新文档。必须始终显式带 --mode append 或 --mode overwrite，绝不能省略 |
| doc folder create | --name <名称> | --folder <父文件夹ID> --workspace <知识库ID> | 创建文件夹 |
| doc file create | --name <名称> --type <类型> | --folder <ID> --workspace <ID> | 创建非文档文件（axls/amind/adraw/able/appt/folder） |
| doc copy | --node <ID或URL> | --folder <目标ID> --workspace <目标ID> | 复制文档 |
| doc move | --node <ID或URL> | --folder <目标ID> --workspace <目标ID> | 移动文档 |
| doc rename | --node <ID或URL> --name <新名称> | | 重命名 |
| doc upload | --file <本地路径> | --name <显示名> --folder <ID> --workspace <ID> --convert | 上传文件 |
| doc download | --node <ID或URL> --output <本地路径> | | 下载文件 |
| doc block list | --node <ID或URL> | --block-type <类型> | 查询文档块结构 |
| doc block insert | --node <ID或URL> | --text <段落> --heading <标题> --level N --ref-block <块ID> --where before/after | 插入块 |
| doc block update | --node <ID或URL> --block-id <块ID> | --text <内容> --heading <标题> --level N | 更新块 |
| doc block delete | --node <ID或URL> --block-id <块ID> | | 删除块（危险） |
| doc comment list | --node <ID或URL> | --type inline/global --resolve-status resolved/unresolved | 查看评论 |
| doc comment create | --node <ID或URL> --content <内容> | --mention <uid1,uid2> | 创建评论 |
| doc comment reply | --node <ID或URL> --comment-key <KEY> --content <内容> | --emoji --mention <uid> | 回复评论 |

## 可用命令 — sheet（在线电子表格 / axls）

钉钉在线电子表格（axls 类型）使用 sheet 服务，不要用 doc read 读取表格。
当用户发送的链接对应的是电子表格时，应使用 sheet 命令操作。

| 命令 | 必选参数 | 可选参数 | 说明 |
|------|----------|----------|------|
| sheet create | --name <名称> | --folder <ID> --workspace <ID> | 创建电子表格 |
| sheet list | --node <ID或URL> | | 列出表格中所有工作表 |
| sheet info | --node <ID或URL> | --sheet-id <工作表ID或名称> | 查看工作表详情（默认第一个） |
| sheet range read | --node <ID或URL> | --sheet-id <ID或名称> --range <A1范围如A1:D10> | 读取单元格数据（省略 range 读全部） |
| sheet range update | --node <ID或URL> --sheet-id <ID> --range <A1范围> --values <二维JSON数组> | --hyperlinks <JSON> --number-format <格式> | 写入单元格 |
| sheet append | --node <ID或URL> --sheet-id <ID> --values <二维JSON数组> | | 追加行数据 |
| sheet find | --node <ID或URL> --sheet-id <ID> --find <搜索文本> | --range <A1> --match-case --use-regexp | 搜索单元格内容 |
| sheet replace | --node <ID或URL> --sheet-id <ID> --find <查找> --replacement <替换> | --range <A1> --use-regexp | 查找替换（危险，需确认） |
| sheet new | --node <ID或URL> --name <名称> | | 新建工作表 |
| sheet add-dimension | --node <ID> --sheet-id <ID> --dimension ROWS/COLUMNS --length <数量> | | 追加空行/列 |
| sheet delete-dimension | --node <ID> --sheet-id <ID> --dimension ROWS/COLUMNS --position <A1位置> --length <数量> | | 删除行/列（危险，需确认） |
| sheet merge-cells | --node <ID> --sheet-id <ID> --range <A1范围> | --merge-type mergeAll/mergeRows/mergeColumns | 合并单元格 |
| sheet unmerge-cells | --node <ID> --sheet-id <ID> --range <A1范围> | | 取消合并 |

### sheet 链式操作示例

用户: 总结一下这个表格 https://alidocs.dingtalk.com/i/nodes/Gl6Pm2xxx
Step 1: {"type":"execute","command":["sheet","list","--node","Gl6Pm2xxx"],"thought":"先获取工作表列表"}
→ 收到: {"items":[{"sheetId":"abc","name":"Sheet1"}]}
Step 2: {"type":"execute","command":["sheet","range","read","--node","Gl6Pm2xxx","--sheet-id","abc"],"thought":"读取全部数据"}
→ 收到表格数据
Step 3: {"type":"reply","text":"表格包含 XX 行数据，主要内容..."}

## 可用命令 — 其他常用服务

| 服务 | 示例命令 | 说明 |
|------|----------|------|
| todo | todo task create --title "xxx" --due-date "2026-06-01" | 待办任务 |
| todo | todo task list | 查看待办 |
| calendar | calendar event create --title "xxx" --start "2026-06-01T14:00:00+08:00" --end "..." | 创建日程 |
| calendar | calendar event list --start "..." --end "..." | 查看日程 |
| contact | contact user search --query "张三" | 搜索联系人 |
| contact | contact user get-self | 获取当前用户信息 |
| chat | chat search --query "群名" | 搜索群聊 |
| chat | chat message send-by-bot --robot-code <code> --group <id> --title "标题" --text "内容" | 机器人发群消息 |
| mail | mail search --query "关键词" | 搜索邮件 |
| report | report inbox | 查看收到的日报周报 |
| attendance | attendance my-record --from "2026-06-01" --to "2026-06-07" | 查看考勤 |

对于不熟悉的服务，可以先执行 ["<service>", "--help"] 查看子命令。

## 链式操作示例

用户: 搜索周报然后读取最新一篇
Step 1: {"type":"execute","command":["doc","search","--query","周报"],"thought":"搜索周报"}
→ 收到结果: {"items":[{"nodeId":"abc123","name":"周报0519"}, ...]}
Step 2: {"type":"execute","command":["doc","read","--node","abc123"],"thought":"读取第一篇"}
→ 收到文档内容
Step 3: {"type":"reply","text":"📄 [周报0519](https://alidocs.dingtalk.com/i/nodes/abc123)\\n\\n文档内容...\\n\\nhttps://alidocs.dingtalk.com/i/nodes/abc123"}

用户: 创建一个文档介绍西瓜
Step 1: {"type":"execute","command":["doc","create","--name","西瓜简介","--markdown","# 西瓜简介\\n\\n西瓜是一种常见水果..."],"thought":"创建文档并写入内容"}
→ 收到结果: {"nodeId":"xyz789","name":"西瓜简介"}
Step 2: {"type":"reply","text":"✅ 文档已创建！\\n\\n👉 [点击打开「西瓜简介」](https://alidocs.dingtalk.com/i/nodes/xyz789)\\n\\nhttps://alidocs.dingtalk.com/i/nodes/xyz789"}

## 危险操作（必须用 confirm）

以下操作必须先用 confirm 请求用户确认，pendingCommand 中放完整命令参数：
- doc block delete（删除文档块）
- doc move（移动文档）
- doc update --mode overwrite（覆盖全部内容）
- sheet replace（批量替换）
- sheet delete-dimension（删除行/列）
- 任何 delete/remove 操作

安全操作（直接执行）：search、list、read、info、create、copy、rename、doc update --mode append、sheet range read、sheet append、sheet find

## 错误处理

命令失败时你会收到 [命令执行失败] 前缀的错误信息。你可以：
1. 分析错误，添加 --verbose 重试
2. 如果看到 RECOVERY_EVENT_ID=xxx，可执行 ["recovery","execute","--event-id","xxx"] 获取恢复方案
3. 多次失败后用 reply 向用户友好地解释情况

## 规则

1. 不要伪造 nodeId 或任何 ID——必须从命令结果中获取
2. --content 和 --markdown 中的换行用真实换行符（不是字面量 \\n）
3. 单次生成内容不超过 4000 字符
4. 回复中涉及文档操作成功时，正文放可点击链接，回复最末尾单独一行放纯文本 URL（方便复制）
5. 用简洁的中文回复
6. doc update 必须始终显式带 --mode append 或 --mode overwrite，绝不能省略 --mode`;

// ── 执行 dws 命令 ────────────────────────────────────────────────────────────

function runDws(args) {
  const fullArgs = [...args, '--format', 'json', '--yes'];
  if (fullArgs[0] === 'doc' && fullArgs.includes('update') && !fullArgs.includes('--mode')) {
    fullArgs.push('--mode', 'append');
    console.log('[dws] 安全兜底：doc update 未指定 --mode，已自动补充 --mode append');
  }
  const cmd = [DWS_BIN, ...fullArgs].map(arg => {
    if (/[\s"&|<>^%!]/.test(arg)) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  }).join(' ');
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const recoveryMatch = (stderr || '').match(/RECOVERY_EVENT_ID=(\S+)/);
        reject({
          message: stderr.trim() || err.message,
          recoveryEventId: recoveryMatch ? recoveryMatch[1] : null,
        });
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseJsonOutput(raw) {
  try {
    const data = JSON.parse(raw);
    if (data.success === false) {
      throw new Error(data.message || data.error || JSON.stringify(data));
    }
    return data.body || data;
  } catch (err) {
    if (err instanceof SyntaxError) return raw;
    throw err;
  }
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max) + '\n\n...(内容过长已截断)';
}

function parseLlmJson(raw) {
  const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  return JSON.parse(cleaned);
}

// ── Agent 循环 ───────────────────────────────────────────────────────────────

async function _runLoop(messages, sessionWebhook, webhookExpiry, sessionKey) {
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (webhookExpiry && Date.now() > webhookExpiry - WEBHOOK_SAFETY_MARGIN_MS) {
      await reply(sessionWebhook, '⚠️ 会话即将过期，当前进度已中断。请重新发起操作。');
      return;
    }

    console.log(`[dws] Agent step ${step + 1}/${MAX_AGENT_STEPS}`);

    let llmRaw;
    try {
      llmRaw = await chatMultiTurn(AGENT_SYSTEM_PROMPT, messages);
    } catch (err) {
      console.error('[dws] LLM 调用失败:', err.message);
      await reply(sessionWebhook, `❌ AI 服务异常：${err.message}`);
      return;
    }

    console.log('[dws] LLM 原始输出:', llmRaw.substring(0, 500));

    let action;
    try {
      action = parseLlmJson(llmRaw);
    } catch {
      await reply(sessionWebhook, truncate(llmRaw, MAX_REPLY_LEN));
      return;
    }

    switch (action.type) {
      case 'execute': {
        if (!action.command || !Array.isArray(action.command)) {
          await reply(sessionWebhook, '⚠️ AI 生成了无效的命令，请换个说法重试。');
          return;
        }

        messages.push({ role: 'assistant', content: llmRaw });

        console.log('[dws] 执行: dws', action.command.join(' '));

        try {
          const raw = await runDws(action.command);
          const data = parseJsonOutput(raw);
          const resultStr = typeof data === 'string' ? data : JSON.stringify(data);
          messages.push({
            role: 'user',
            content: `[命令执行成功]\n${truncate(resultStr, MAX_RESULT_LEN)}`,
          });
        } catch (errorInfo) {
          const errMsg = typeof errorInfo === 'object' ? errorInfo.message : String(errorInfo);
          const recovery = errorInfo?.recoveryEventId
            ? `\nRECOVERY_EVENT_ID=${errorInfo.recoveryEventId}`
            : '';
          messages.push({
            role: 'user',
            content: `[命令执行失败]\n${errMsg}${recovery}`,
          });
        }
        break;
      }

      case 'reply': {
        const text = truncate(action.text || '操作完成。', MAX_REPLY_LEN);
        await reply(sessionWebhook, text);
        return;
      }

      case 'confirm': {
        pendingConfirmations.set(sessionKey, {
          pendingCommand: action.pendingCommand,
          conversationHistory: [...messages, { role: 'assistant', content: llmRaw }],
          createdAt: Date.now(),
        });
        await reply(sessionWebhook, (action.text || '确认执行此操作吗？') + '\n\n💡 回复 **确认** 执行，或 **取消** 放弃。');
        return;
      }

      default: {
        await reply(sessionWebhook, action.text || '操作完成。');
        return;
      }
    }
  }

  messages.push({
    role: 'user',
    content: '[系统提示] 已达到最大操作步数，请立即用 {"type":"reply","text":"..."} 总结当前进展。',
  });

  try {
    const summaryRaw = await chatMultiTurn(AGENT_SYSTEM_PROMPT, messages);
    const parsed = parseLlmJson(summaryRaw);
    await reply(sessionWebhook, truncate((parsed.text || summaryRaw) + '\n\n---\n⚠️ 已达到最大操作步数', MAX_REPLY_LEN));
  } catch {
    await reply(sessionWebhook, '⚠️ 操作步数已达上限，请分步操作。');
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

async function handle(userText, sessionWebhook, webhookExpiry, sessionKey) {
  if (!userText || userText === '帮助' || userText === 'help') {
    await reply(sessionWebhook, buildHelpText());
    return;
  }

  console.log('[dws] 用户请求:', userText);
  const messages = [{ role: 'user', content: userText }];
  await _runLoop(messages, sessionWebhook, webhookExpiry, sessionKey);
}

// ── 确认流程 ──────────────────────────────────────────────────────────────────

function hasPendingConfirmation(sessionKey) {
  const pending = pendingConfirmations.get(sessionKey);
  if (!pending) return false;
  if (Date.now() - pending.createdAt > CONFIRM_EXPIRY_MS) {
    pendingConfirmations.delete(sessionKey);
    return false;
  }
  return true;
}

async function handleConfirmation(sessionKey, userText, sessionWebhook, webhookExpiry) {
  const pending = pendingConfirmations.get(sessionKey);
  if (!pending) return false;

  pendingConfirmations.delete(sessionKey);

  if (Date.now() - pending.createdAt > CONFIRM_EXPIRY_MS) {
    await reply(sessionWebhook, '⚠️ 确认已过期，请重新发起操作。');
    return true;
  }

  const normalized = userText.trim();
  if (/^(确认|确定|是|yes|y|ok|好的|执行)$/i.test(normalized)) {
    const messages = pending.conversationHistory;
    messages.push({ role: 'user', content: '[用户已确认] 请执行待确认的操作。' });
    await _runLoop(messages, sessionWebhook, webhookExpiry, sessionKey);
    return true;
  }

  if (/^(取消|不|no|n|cancel|算了|放弃)$/i.test(normalized)) {
    await reply(sessionWebhook, '✅ 已取消操作。');
    return true;
  }

  pendingConfirmations.set(sessionKey, { ...pending });
  await reply(sessionWebhook, '请回复 **确认** 或 **取消**。');
  return true;
}

// ── 帮助 ─────────────────────────────────────────────────────────────────────

function buildHelpText() {
  return [
    '**📄 钉钉操作助手 (`/dws`)**',
    '',
    '用自然语言描述你要做的事，我会自动执行：',
    '',
    '**文档操作**',
    '- `/dws 创建一个文档介绍西瓜`',
    '- `/dws 搜一下项目周报`',
    '- `/dws 看看我最近的文档`',
    '- `/dws 读取 https://alidocs.dingtalk.com/i/nodes/xxx`',
    '- `/dws 往文档xxx追加一段总结`',
    '',
    '**其他能力**',
    '- `/dws 帮我创建一个明天下午的日程`',
    '- `/dws 创建一个待办：提交周报`',
    '- `/dws 搜一下张三的联系方式`',
    '',
    '支持链式操作，例如"搜索周报然后读取最新一篇"。',
  ].join('\n');
}

module.exports = { handle, handleConfirmation, hasPendingConfirmation, buildHelpText };
