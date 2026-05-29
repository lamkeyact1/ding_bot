const config = require('./config');
const { start } = require('./stream-client');

const isClaudeModel = config.claude.model.toLowerCase().startsWith('claude');
const activeURL = isClaudeModel
  ? (config.claude.baseURL || '官方 Anthropic API')
  : (config.claude.openaiBaseURL || config.claude.baseURL || '未配置');

console.log('=== 钉钉 Claude 机器人（Stream 模式）===');
console.log(`模型: ${config.claude.model}`);
console.log(`Base URL: ${activeURL}`);
console.log('正在连接钉钉...');

let client;

start()
  .then((c) => { client = c; })
  .catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });

function shutdown(signal) {
  console.log(`\n[shutdown] 收到 ${signal}，正在关闭...`);
  if (client) {
    try { client.disconnect(); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── 全局异常捕获：避免未处理异常导致进程静默挂死 ──────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[fatal] 未捕获异常:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] 未处理的 Promise 拒绝:', reason);
});

// ── 健康心跳日志：每隔一段时间打印，方便定位异常发生时间 ──────────────────────
setInterval(() => {
  const mem = process.memoryUsage();
  console.log(`[health] ${new Date().toISOString()} | 内存: ${Math.round(mem.rss / 1024 / 1024)}MB | 运行中`);
}, 10 * 60 * 1000); // 每 10 分钟
