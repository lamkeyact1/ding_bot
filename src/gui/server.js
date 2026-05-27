const http = require('http');
const fs = require('fs');
const path = require('path');
const { fork, exec } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const BOT_ENTRY = path.join(__dirname, '..', 'index.js');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const HTML_FILE = path.join(__dirname, 'index.html');
const PORT = parseInt(process.env.GUI_PORT, 10) || 3000;

const ENV_FIELDS = [
  { key: 'DINGTALK_CLIENT_ID', label: '钉钉 Client ID', required: true, secret: false },
  { key: 'DINGTALK_CLIENT_SECRET', label: '钉钉 Client Secret', required: true, secret: true },
  { key: 'ANTHROPIC_API_KEY', label: 'API Key', required: true, secret: true },
  { key: 'ANTHROPIC_BASE_URL', label: 'Anthropic Base URL', required: false, secret: false },
  { key: 'OPENAI_BASE_URL', label: 'OpenAI Base URL', required: false, secret: false },
  { key: 'CLAUDE_MODEL', label: '模型', required: false, secret: false, placeholder: 'claude-sonnet-4-5' },
];

// ── Bot 子进程管理 ───────────────────────────────────────────────────────────

let bot = null;
let botStatus = 'stopped';
let startedAt = null;
let messageCount = 0;

const LOG_MAX = 1000;
const logBuffer = [];
const sseClients = new Set();

function broadcast(type, text) {
  const line = { type, text, time: Date.now() };
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  if (type === 'stdout' && text.includes('[handler]')) messageCount++;
  const data = JSON.stringify(line);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

function startBot() {
  if (bot) return;
  botStatus = 'starting';
  messageCount = 0;
  broadcast('system', '正在启动机器人...');

  bot = fork(BOT_ENTRY, [], {
    cwd: PROJECT_ROOT,
    silent: true,
    env: { ...process.env },
  });

  bot.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    broadcast('stdout', text);
    if (text.includes('已连接到钉钉')) {
      botStatus = 'running';
      startedAt = Date.now();
    }
  });

  bot.stderr.on('data', (chunk) => {
    broadcast('stderr', chunk.toString());
  });

  bot.on('exit', (code) => {
    const prev = botStatus;
    botStatus = code === 0 ? 'stopped' : 'error';
    bot = null;
    startedAt = null;
    broadcast('system', `机器人已${prev === 'running' ? '停止' : '退出'}（exit code: ${code}）`);
  });
}

function stopBot() {
  return new Promise((resolve) => {
    if (!bot) { resolve(); return; }
    const botToStop = bot;
    bot = null;
    botStatus = 'stopped';
    startedAt = null;
    broadcast('system', '正在停止机器人...');
    botToStop.on('exit', () => resolve());
    botToStop.kill('SIGTERM');
    setTimeout(() => {
      try { botToStop.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
  });
}

async function restartBot() {
  await stopBot();
  startBot();
}

// ── .env 读写 ────────────────────────────────────────────────────────────────

function readEnv() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    const values = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch {
    return {};
  }
}

function writeEnv(values) {
  const lines = [];
  lines.push('# === 钉钉开放平台 ===');
  if (values.DINGTALK_CLIENT_ID) lines.push(`DINGTALK_CLIENT_ID=${values.DINGTALK_CLIENT_ID}`);
  if (values.DINGTALK_CLIENT_SECRET) lines.push(`DINGTALK_CLIENT_SECRET=${values.DINGTALK_CLIENT_SECRET}`);
  lines.push('');
  lines.push('# === Claude API ===');
  if (values.ANTHROPIC_API_KEY) lines.push(`ANTHROPIC_API_KEY=${values.ANTHROPIC_API_KEY}`);
  if (values.ANTHROPIC_BASE_URL) lines.push(`ANTHROPIC_BASE_URL=${values.ANTHROPIC_BASE_URL}`);
  if (values.OPENAI_BASE_URL) lines.push(`OPENAI_BASE_URL=${values.OPENAI_BASE_URL}`);
  if (values.CLAUDE_MODEL) lines.push(`CLAUDE_MODEL=${values.CLAUDE_MODEL}`);
  lines.push('');
  fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
}

// ── HTTP 请求体解析 ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ── HTTP 路由 ────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(HTML_FILE, 'utf8'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, {
      status: botStatus,
      model: readEnv().CLAUDE_MODEL || 'claude-sonnet-4-5',
      uptime: startedAt ? Date.now() - startedAt : 0,
      pid: bot ? bot.pid : null,
      messageCount,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (bot) { json(res, { error: '机器人已在运行' }, 400); return; }
    startBot();
    json(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    if (!bot) { json(res, { error: '机器人未在运行' }, 400); return; }
    await stopBot();
    json(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/restart') {
    await restartBot();
    json(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/exit') {
    await stopBot();
    json(res, { ok: true });
    setTimeout(() => process.exit(0), 500);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/env') {
    json(res, { fields: ENV_FIELDS, values: readEnv() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/env') {
    try {
      const body = await readBody(req);
      writeEnv(body);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    for (const line of logBuffer) {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
}

// ── 启动 ─────────────────────────────────────────────────────────────────────

// ── 单实例保护 ──────────────────────────────────────────────────────────────

const LOCK_FILE = path.join(PROJECT_ROOT, '.gui.lock');

async function checkExistingInstance() {
  if (!fs.existsSync(LOCK_FILE)) return false;
  try {
    const port = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!port) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/api/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => exec(`start http://localhost:${port}?duplicate=1`, resolve));
      }
      return true;
    }
  } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  return false;
}

let lockOwner = false;

function writeLock(port) {
  fs.writeFileSync(LOCK_FILE, String(port), 'utf8');
  lockOwner = true;
}

process.on('exit', () => {
  if (lockOwner) { try { fs.unlinkSync(LOCK_FILE); } catch {} }
});

// ── 启动 ─────────────────────────────────────────────────────────────────────

const MAX_PORT_TRIES = 10;

function tryListen(port, attempt) {
  if (attempt > MAX_PORT_TRIES) {
    console.error(`尝试了 ${MAX_PORT_TRIES} 个端口均被占用，请手动指定: GUI_PORT=xxxx npm run gui`);
    process.exit(1);
  }
  const s = http.createServer(handleRequest);
  s.listen(port, () => {
    writeLock(port);
    console.log(`GUI 控制台已启动: http://localhost:${port}`);
    if (process.platform === 'win32') {
      exec(`start http://localhost:${port}`);
    }
    startBot();
  });
  s.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 被占用，尝试 ${port + 1}...`);
      tryListen(port + 1, attempt + 1);
    } else {
      console.error('服务器启动失败:', err);
      process.exit(1);
    }
  });
}

(async () => {
  if (await checkExistingInstance()) process.exit(0);
  tryListen(PORT, 1);
})();
