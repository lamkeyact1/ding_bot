const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时（${FETCH_TIMEOUT_MS}ms）: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── 发送文本/Markdown（用 sessionWebhook）────────────────────────────────────
async function reply(sessionWebhook, text) {
  const res = await fetchWithTimeout(sessionWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'AI 回复', text } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`sessionWebhook 回复失败 (${res.status}): ${detail}`);
  }
  return await res.json();
}

module.exports = { reply };
