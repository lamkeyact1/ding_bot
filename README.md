# 钉钉 AI 机器人

钉钉企业内部机器人，接入 Claude / DeepSeek 等大模型，支持多轮对话、系统提示词智能管理、钉钉文档操作等能力。

---

## 架构概览

```
启动.vbs / start.bat
 └─ node src/gui/server.js          ← Web 控制台（端口 3000）
      └─ fork(src/index.js)          ← 机器人主进程
           ├─ stream-client.js       ← 钉钉 Stream 长连接
           │    └─ message-handler.js ← 消息路由与命令分发
           │         ├─ claude-client.js  ← AI 对话（Anthropic SDK / OpenAI 兼容）
           │         └─ dws-handler.js   ← 钉钉文档/日历/待办等操作（Agent 循环）
           ├─ config.js              ← 环境变量加载与校验
           └─ dingtalk-api.js        ← sessionWebhook 回复
```

**关键设计：**

- **双格式 AI 接口**：自动识别模型名称，`claude-*` 走 Anthropic SDK（含 Prompt Cache），其他走 OpenAI 兼容格式
- **会话管理**：内存 Map 存储，按用户隔离，最多 500 会话 × 10 轮，LRU 淘汰 + 24h 过期清理
- **消息去重**：Stream 回调中 30 分钟滑动窗口去重，防止钉钉 60s 重推
- **单实例保护**：lockfile + HTTP 探测，防止重复启动多个实例
- **系统提示词热更新**：`fs.watchFile` 监听 `system-prompt.md`，修改后下一条消息自动生效

---

## 前置要求

- **Node.js 18+**（[下载](https://nodejs.org)）
- 钉钉开放平台应用（获取 Client ID / Client Secret）
- Anthropic API Key 或兼容接口
- （可选）[dws CLI](https://www.npmjs.com/package/@anthropic-ai/dws) —— 启用文档操作功能

---

## 安装

```bash
# 1. 进入项目目录
cd 钉钉机器人

# 2. 安装依赖
npm install

# 3. 创建配置文件
copy .env.example .env
# 然后用文本编辑器打开 .env，填写配置项
```

---

## 配置（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DINGTALK_CLIENT_ID` | 是 | 钉钉应用 Client ID |
| `DINGTALK_CLIENT_SECRET` | 是 | 钉钉应用 Client Secret |
| `ANTHROPIC_API_KEY` | 是 | API Key |
| `ANTHROPIC_BASE_URL` | 否 | 自定义 Anthropic 格式接口地址（使用代理时填写） |
| `OPENAI_BASE_URL` | 否 | OpenAI 兼容格式接口地址（接入 DeepSeek 等模型时填写） |
| `CLAUDE_MODEL` | 否 | 模型名称，默认 `claude-sonnet-4-5` |

---

## 启动

### 方式一：双击启动（推荐 Windows 用户）

双击 `启动.vbs`（后台静默运行）或 `start.bat`（显示控制台窗口）。

自动打开浏览器 Web 控制台。重复双击不会启动多个实例，会跳转到已运行的控制台页面。

### 方式二：命令行（仅机器人）

```bash
node src/index.js
```

### 方式三：命令行（Web 控制台）

```bash
node src/gui/server.js
```

---

## Web 控制台

启动后访问 `http://localhost:3000`，提供：

- **状态监控**：运行状态、当前模型、运行时间、今日消息数
- **一键操控**：启动 / 重启 / 停止机器人
- **实时日志**：SSE 推送，支持复制、清空、暂停滚动
- **在线配置**：修改 .env 参数，可保存后立即重启生效

---

## 钉钉中使用

### 命令

| 命令 | 说明 |
|---|---|
| `/clear` | 清除当前对话历史 |
| `/prompt <描述>` | AI 理解你的意图后智能更新系统提示词 |
| `/prompt-replace <内容>` | 全量替换系统提示词 |
| `/dws <操作描述>` | 操作钉钉文档、日历、待办等（需配置 dws CLI） |

### 快捷方式

- 消息中包含 **「文档」** 会自动触发文档操作，无需输入 `/dws`
- 中文别名：`更新提示词：<内容>`、`修改提示词：<内容>` 等同 `/prompt`

### 使用示例

```
你好                          → 普通 AI 对话
帮我搜一下文档周报              → 自动触发文档搜索
创建一篇文档介绍产品线           → 自动创建钉钉文档
/prompt 我负责PMO专项管理       → AI 理解后融合到系统提示词中
/clear                        → 清除对话历史
```

群聊中需 **@机器人** 触发。

---

## 项目文件说明

```
├── .env.example          # 环境变量模板
├── system-prompt.md      # 系统提示词（可通过 /prompt 命令在线修改）
├── 启动.vbs              # Windows 静默启动脚本
├── start.bat             # Windows 控制台启动脚本
└── src/
    ├── index.js          # 机器人入口
    ├── config.js         # 配置加载与校验
    ├── stream-client.js  # 钉钉 Stream 连接与消息去重
    ├── message-handler.js# 消息路由（命令解析 → AI 对话 → 文档操作）
    ├── claude-client.js  # AI 客户端（Anthropic SDK + OpenAI 兼容双模式）
    ├── dingtalk-api.js   # 钉钉 webhook 回复
    ├── dws-handler.js    # 文档操作 Agent（AI 驱动的 dws CLI 编排）
    └── gui/
        ├── server.js     # Web 控制台后端
        └── index.html    # Web 控制台前端
```
