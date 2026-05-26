const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream');
const config = require('./config');
const handler = require('./message-handler');

// 去重：用 Map 存 msgId -> 接收时间戳，按时间滑动清理（保留 30 分钟内的记录）
// 避免整体 clear 导致的重推窗口漏洞
const processedIds = new Map();
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [id, ts] of processedIds) {
    if (ts < cutoff) processedIds.delete(id);
  }
}, 5 * 60 * 1000); // 每 5 分钟清理一次过期记录

function createClient() {
  const client = new DWClient({
    clientId: config.dingtalk.clientId,
    clientSecret: config.dingtalk.clientSecret,
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    const messageId = res.headers?.messageId;

    let payload;
    try {
      payload = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (err) {
      console.error('[stream] 解析消息体失败:', err.message);
      client.socketCallBackResponse(messageId, { status: 'SUCCESS' });
      return;
    }

    // 立即确认，避免服务端 60s 重推
    client.socketCallBackResponse(messageId, { status: 'SUCCESS' });

    // 滑动窗口去重：30 分钟内同一 msgId 只处理一次
    const msgId = payload.msgId || messageId;
    if (msgId) {
      if (processedIds.has(msgId)) {
        console.log('[stream] 重复消息，跳过:', msgId);
        return;
      }
      processedIds.set(msgId, Date.now());
    }

    console.log('[stream] 收到消息:', JSON.stringify(payload));

    handler.handle(payload).catch((err) => {
      console.error('[stream] 消息处理异常:', err);
    });
  });

  return client;
}

async function start() {
  const client = createClient();
  await client.connect();
  console.log('[stream] 已连接到钉钉，等待消息中...');
  return client;
}

module.exports = { start };
