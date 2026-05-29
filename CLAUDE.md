# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

钉钉企业内部机器人，接入 Claude / DeepSeek 等大模型，支持多轮对话、系统提示词智能管理、钉钉文档/表格/日历/待办等操作。

## 常用命令

```bash
npm start          # 仅启动机器人主进程
npm run dev        # 启动机器人 + --watch 热重载
npm run gui        # 启动 Web 控制台（端口 3000，自动打开浏览器）
node src/gui/server.js  # 等同于 npm run gui
```

没有 lint、test 脚本。

## 架构

```
启动.vbs
 └─ node src/gui/server.js          ← Web 控制台（HTTP 3000）
      └─ fork(src/index.js)          ← 机器人主进程
           ├─ stream-client.js       ← 钉钉 Stream 长连接（dingtalk-stream SDK）
           │    └─ message-handler.js ← 消息路由与命令分发
           │         ├─ claude-client.js  ← AI 对话（双模式）
           │         └─ dws-handler.js   ← 钉钉产品操作（Agent 循环）
           ├─ config.js              ← 环境变量加载与热更新
           └─ dingtalk-api.js        ← sessionWebhook 回复
```

## 核心设计决策

### AI 客户端双模式（claude-client.js）

路由优先级（`useAnthropicFormat()`）：
1. **`claude-*` 前缀** → Anthropic SDK，启用 Prompt Cache（`cache_control: ephemeral`）
2. **`anthropic/` 前缀** → Anthropic SDK，不启用 Prompt Cache（兼容代理网关透传）
3. **已配置 `OPENAI_BASE_URL`** → OpenAI 兼容 `/chat/completions` 格式
4. **以上都不满足** → 回退到 Anthropic SDK（适用于只配了 `ANTHROPIC_BASE_URL` 的纯 Anthropic-format 网关）

三个导出函数：`chat(messages)` 带系统提示词 + 历史，`chatOneShot(systemPrompt, userMessage)` 单轮自定义提示词，`chatMultiTurn(systemPrompt, messages)` 多轮自定义提示词。

### 会话管理（message-handler.js）

- 内存 `Map<sessionKey, { messages, lastActiveAt }>`，单聊 key 为 `senderStaffId`，群聊 key 为 `conversationId:senderStaffId`
- 最多 500 会话 × 10 轮对话，LRU 淘汰 + 每 1 小时清理 24h 过期会话

### DWS Agent 循环（dws-handler.js）

AI 驱动的命令行编排：用户自然语言 → LLM 生成 JSON 指令 `{type, command/thought}` → `execFile('dws', args)` 执行 → 结果反馈 LLM → 循环，最多 15 步。危险操作（删除、覆盖、移动）走 `confirm` 流程要求用户确认。

### 消息去重（stream-client.js）

30 分钟滑动窗口 `Map<msgId, timestamp>`，每 5 分钟清理过期记录。必须在收到消息后立即 `socketCallBackResponse(SUCCESS)` 避免钉钉 60s 重推。

### 系统提示词热更新（claude-client.js）

`fs.watchFile` 监听 `system-prompt.md`，变更后将缓存置 null，下一条消息自动重新加载。

### 单实例保护（gui/server.js）

`.gui.lock` 文件记录端口号，启动时 HTTP 探测已有实例，存在则跳转浏览器到已有控制台。进程退出时清理 lock 文件。端口冲突自动递增（最多 10 次）。

### 模型热切换（config.js）

`updateModel()` 同时更新内存中的 `config.claude.model` 和 `.env` 文件中的 `CLAUDE_MODEL` 行，支持运行时切换无需手动编辑配置。

## 消息处理流程

1. `stream-client.js` 收到钉钉回调 → JSON 解析 → 立即 ACK → 去重检查
2. `message-handler.js` 检查 webhook 有效性 → 解析消息类型 → 群聊 @ 提及剥离
3. 命令路由优先级：`/clear` → `/prompt` → dws 待确认 → `/dws` → 自动触发（含「文档」「表格」关键词）→ 普通 AI 对话
4. 普通对话：取/建会话 → 追加 user message → `chat()` → 追加 assistant reply → LRU 裁剪 → webhook 回复

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 是 | 钉钉应用 Client ID |
| `DINGTALK_CLIENT_SECRET` | 是 | 钉钉应用 Client Secret |
| `ANTHROPIC_API_KEY` | 是 | AI API Key |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic 格式接口地址 |
| `OPENAI_BASE_URL` | 否 | OpenAI 兼容格式接口地址 |
| `CLAUDE_MODEL` | 否 | 模型名称，默认 `claude-sonnet-4-5` |
| `GUI_PORT` | 否 | 控制台端口，默认 3000 |
| `DWS_PATH` | 否 | dws 二进制路径，默认 `dws`（从 PATH 查找） |

## 外部依赖

- **dws CLI**：钉钉工作空间命令行工具，处理钉钉产品操作（文档/表格/日历/待办/审批/考勤/邮件等）。安装方式：
  ```powershell
  irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex
  ```
  安装后执行 `dws login` 完成钉钉账号认证。
- **dingtalk-stream SDK**：`2.1.6-beta.1`，提供 Stream 模式长连接，支持自动重连和心跳
