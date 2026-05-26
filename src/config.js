require('dotenv').config();
const fs = require('fs');
const path = require('path');

const REQUIRED = ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'ANTHROPIC_API_KEY'];

for (const key of REQUIRED) {
  if (!process.env[key] || process.env[key].includes('请填写')) {
    throw new Error(`缺少必要环境变量: ${key}，请检查 .env 文件`);
  }
}

const ENV_FILE = path.join(__dirname, '..', '.env');

module.exports = {
  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID,
    clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    openaiBaseURL: process.env.OPENAI_BASE_URL || undefined,
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
  },
};

// 运行时切换模型：更新内存 + 持久化到 .env
module.exports.updateModel = function updateModel(newModel) {
  module.exports.claude.model = newModel;
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  const updated = raw.replace(/^CLAUDE_MODEL=.*$/m, `CLAUDE_MODEL=${newModel}`);
  // 若 .env 中原本没有 CLAUDE_MODEL 行，追加到末尾
  const final = updated === raw ? raw + `\nCLAUDE_MODEL=${newModel}` : updated;
  fs.writeFileSync(ENV_FILE, final, 'utf8');
};
