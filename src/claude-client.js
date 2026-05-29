const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const PROMPT_FILE = path.join(__dirname, '..', 'system-prompt.md');
const FALLBACK_PROMPT = '你是一个智能助手，正在通过钉钉与用户对话。请用简洁清晰的中文回复。';

// ── 系统提示词热缓存 ──────────────────────────────────────────────────────────
let promptCache = null;

function loadSystemPrompt() {
  if (promptCache !== null) return promptCache;
  try {
    const content = fs.readFileSync(PROMPT_FILE, 'utf8').trim();
    promptCache = content || FALLBACK_PROMPT;
  } catch (err) {
    console.warn('[claude] 读取 system-prompt.md 失败，使用默认提示:', err.message);
    promptCache = FALLBACK_PROMPT;
  }
  return promptCache;
}

fs.watchFile(PROMPT_FILE, { interval: 1000 }, () => {
  promptCache = null;
  console.log('[claude] system-prompt.md 已变更，下一条消息将重新加载');
});

// 将技术标识映射为用户可读的模型名称
const MODEL_DISPLAY = {
  'claude-sonnet-4.6':      'Claude Sonnet 4.6',
  'claude-sonnet-4.5':      'Claude Sonnet 4.5',
  'anthropic/claude-|deepseek-v4-pro': 'DeepSeek V4 Pro',
};

function buildSystemPrompt() {
  const base = loadSystemPrompt();
  const display = MODEL_DISPLAY[config.claude.model] || config.claude.model;
  return `${base}\n\n---\n当前模型：${display}`;
}

// ── 模型路由判断 ──────────────────────────────────────────────────────────────// anthropic/ 前缀或 claude- 前缀 → 使用 Anthropic SDK 格式
// 其他 → 使用 OpenAI 兼容格式
function useAnthropicFormat() {
  const m = config.claude.model.toLowerCase();
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return true;
  // 未配置 OPENAI_BASE_URL 时，回退到 Anthropic SDK 格式
  if (!config.claude.openaiBaseURL) return true;
  return false;
}

// 只有纯 claude-* 模型才启用 cache_control（DeepSeek 等不支持此字段）
function supportsPromptCache() {
  return config.claude.model.toLowerCase().startsWith('claude');
}

// ── Anthropic SDK 客户端（claude-* / anthropic/* 模型用）────────────────────
const anthropicClient = new Anthropic({
  apiKey: config.claude.apiKey,
  ...(config.claude.baseURL ? { baseURL: config.claude.baseURL } : {}),
});

async function chatWithAnthropicSDK(messages, systemPrompt) {
  const systemField = supportsPromptCache()
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : systemPrompt;
  const response = await anthropicClient.messages.create({
    model: config.claude.model,
    max_tokens: 4096,
    system: systemField,
    messages,
  });
  if (response.content?.[0]?.type === 'text') return response.content[0].text;
  // 兼容含 thinking 块的响应（如 DeepSeek 扩展思考模式）：找第一个 text 类型块
  const textBlock = response.content?.find(item => item.type === 'text');
  if (textBlock) return textBlock.text;
  throw new Error(`Anthropic SDK 响应格式异常: ${JSON.stringify(response)}`);
}

// ── OpenAI 兼容格式（deepseek-* 等模型用）───────────────────────────────────
async function chatWithOpenAI(messages, systemPrompt) {
  const baseURL = config.claude.openaiBaseURL || config.claude.baseURL;
  if (!baseURL) throw new Error('使用非 Claude 模型时需要配置 OPENAI_BASE_URL');
  const url = `${baseURL}/chat/completions`;
  const body = {
    model: config.claude.model,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.claude.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI 格式请求失败 (${res.status}): ${detail}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (text) return text;
    throw new Error(`OpenAI 响应格式异常: ${JSON.stringify(data)}`);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时（60s）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── 统一入口（带历史） ────────────────────────────────────────────────────────
async function chat(messages) {
  const systemPrompt = buildSystemPrompt();
  if (useAnthropicFormat()) {
    return chatWithAnthropicSDK(messages, systemPrompt);
  } else {
    return chatWithOpenAI(messages, systemPrompt);
  }
}

// ── 单轮调用（自定义 system prompt，不走会话历史）────────────────────────────
async function chatOneShot(systemPrompt, userMessage) {
  const messages = [{ role: 'user', content: userMessage }];
  if (useAnthropicFormat()) {
    return chatWithAnthropicSDK(messages, systemPrompt);
  } else {
    return chatWithOpenAI(messages, systemPrompt);
  }
}

// ── 多轮调用（自定义 system prompt + 完整消息数组）───────────────────────────
async function chatMultiTurn(systemPrompt, messages) {
  if (useAnthropicFormat()) {
    return chatWithAnthropicSDK(messages, systemPrompt);
  } else {
    return chatWithOpenAI(messages, systemPrompt);
  }
}

module.exports = { chat, chatOneShot, chatMultiTurn };
