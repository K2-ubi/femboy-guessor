const { TG_API, isBanned, setSecurityHeaders, getToken, checkContentLength, checkRateLimit, fetchWithTimeout } = require('./_shared');

const ALLOWED_CHAT_IDS = new Set(['1212294771', '8240197891']);
const ALLOWED_METHODS = new Set(['sendMessage', 'sendPhoto']);

async function sendToTelegram(method, params) {
  const token = await getToken();
  let url = `${TG_API}/bot${token}/${method}`;
  let options = { method: 'POST' };

  if (method === 'sendPhoto' && params.photo && params.photo.startsWith('data:')) {
    const b64 = params.photo.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 5 * 1024 * 1024) {
      throw new Error('Photo too large');
    }
    const boundary = '----' + Date.now().toString(36);
    const ext = params.photo.includes('png') ? 'png' : 'jpg';
    const parts = [];

    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${params.chat_id}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.${ext}"\r\nContent-Type: image/${ext === 'png' ? 'png' : 'jpeg'}\r\n\r\n`);
    parts.push(buf.toString('binary'));
    if (params.caption) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${params.caption}`);
    }
    parts.push(`--${boundary}--`);

    const bufBody = Buffer.concat(
      parts.map(p => typeof p === 'string' ? Buffer.from(p, 'utf-8') : p)
    );

    options.headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
    options.body = bufBody;
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(params);
  }

  const res = await fetchWithTimeout(url, options);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('Telegram API: ' + (await res.text()).slice(0, 200));
  }
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `HTTP ${res.status}`);
  }
  return data;
}

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  if (!checkContentLength(req, res)) return;
  if (!checkRateLimit(req, res)) return;

  const banResult = await isBanned(req);
  if (banResult) return res.status(403).json({ error: 'Banned' });

  const { action, chat_id, text, photo, caption, reply_markup } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });
  if (!ALLOWED_METHODS.has(action)) return res.status(400).json({ error: `Method '${action}' is not allowed` });

  const targetChatId = String(chat_id || '').trim();
  if (!targetChatId || !ALLOWED_CHAT_IDS.has(targetChatId)) {
    return res.status(403).json({ error: 'chat_id is not allowed' });
  }

  if (action === 'sendMessage' && !text) return res.status(400).json({ error: 'text required' });

  try {
    const params = { chat_id: targetChatId };
    if (reply_markup) params.reply_markup = reply_markup;
    if (action === 'sendMessage') {
      params.text = text;
    } else if (action === 'sendPhoto') {
      if (photo) params.photo = photo;
      if (caption) params.caption = caption;
    }

    const result = await sendToTelegram(action, params);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
