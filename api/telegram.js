const { setSecurityHeaders, checkContentLength, checkRateLimit, fetchWithTimeout } = require('./_shared');

const WORKER_URL = process.env.WORKER_URL || 'https://quiet-hat-2de7.konstasil777.workers.dev';
const ALLOWED_CHAT_IDS = new Set(['1212294771', '8240197891']);
const ALLOWED_METHODS = new Set(['sendMessage', 'sendPhoto']);

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  if (!checkContentLength(req, res)) return;
  if (!checkRateLimit(req, res)) return;

  const { action, chat_id, text, photo, caption, reply_markup } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });
  if (!ALLOWED_METHODS.has(action)) return res.status(400).json({ error: `Method '${action}' is not allowed` });

  const targetChatId = String(chat_id || '').trim();
  if (!targetChatId || !ALLOWED_CHAT_IDS.has(targetChatId)) {
    return res.status(403).json({ error: 'chat_id is not allowed' });
  }

  if (action === 'sendMessage' && !text) return res.status(400).json({ error: 'text required' });

  try {
    const workerRes = await fetchWithTimeout(`${WORKER_URL}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, chat_id: targetChatId, text, photo, caption, reply_markup })
    });
    const data = await workerRes.json();
    return res.status(workerRes.ok ? 200 : 502).json(data);
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
