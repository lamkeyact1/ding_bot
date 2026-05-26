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
