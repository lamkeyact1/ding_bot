# 钉钉 AI 机器人

钉钉企业内部机器人，接入 Claude / DeepSeek 实现 AI 对话。

---

## 前置要求

- **Node.js 18+**（[下载](https://nodejs.org)）
- 钉钉开放平台应用（获取 Client ID / Client Secret）
- Anthropic API Key 或兼容接口

---

## 安装

```bash
# 1. 进入项目目录
cd 钉钉机器人

# 2. 安装依赖
npm install

# 3. 创建配置文件
copy .env.example .env
# 然后用文本编辑器打开 .env，填写下面的配置项
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

**方式一：双击启动（推荐 Windows 用户）**

双击 `启动机器人.vbs`（后台静默运行）或 `start.bat`（显示窗口）

**方式二：命令行**

```bash
node src/index.js
```

**方式三：Web 控制台**

```bash
node src/gui/server.js
```

启动后访问 `http://localhost:3000`，可通过浏览器管理启停、编辑配置、查看实时日志。

---

## 在钉钉中使用

| 命令 | 说明 |
|---|---|
| `/clear` | 清除当前对话历史 |
| `/prompt <内容>` | 追加自定义指令到系统提示词末尾 |
| `/prompt-replace <内容>` | 全量替换系统提示词 |
| `/dws <操作描述>` | 操作钉钉文档、日历、待办等（需配置 dws CLI）|

直接发送文字即为普通对话。群聊中需 @ 机器人触发。
