/**
 * Vercel Serverless Function — прокси для Telegram Bot API
 *
 * Использует Firebase Admin SDK. Ключ сервис-аккаунта берётся
 * из переменной окружения FIREBASE_SERVICE_ACCOUNT (base64).
 *
 * Безопасность:
 *   - Только разрешённые методы (sendMessage, sendPhoto)
 *   - Только разрешённые chat_id (ADMIN_TG_CHAT_IDS)
 *   - IP из хардкод-списка блокируются на уровне сервера
 */

const admin = require('firebase-admin');

const TG_API = 'https://api.telegram.org';

const BANNED_IPS = new Set([
  '94.181.18.114',
]);

const ALLOWED_CHAT_IDS = new Set([
  '1212294771',
  '8240197891',
]);

const ALLOWED_METHODS = new Set(['sendMessage', 'sendPhoto']);

function initAdmin() {
  if (admin.apps.length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
  const json = Buffer.from(b64, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(json);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: serviceAccount.databaseURL || 'https://project-3861147147890788156-default-rtdb.europe-west1.firebasedatabase.app'
  });
}

async function getToken() {
  initAdmin();
  const db = admin.database();
  const snap = await db.ref('femboy_guessor/apitg').get();
  const v = snap.val();
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v !== null) {
    const vals = Object.values(v).filter(x => typeof x === 'string');
    if (vals.length) return vals[0].trim();
  }
  throw new Error('Токен не найден в Firebase');
}

async function sendToTelegram(method, params) {
  const token = await getToken();
  let url = `${TG_API}/bot${token}/${method}`;
  let options = { method: 'POST' };

  if (method === 'sendPhoto' && params.photo && params.photo.startsWith('data:')) {
    const b64 = params.photo.split(',')[1];
    const buf = Buffer.from(b64, 'base64');
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

  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.description || `HTTP ${res.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  // IP-бан на уровне сервера
  const remoteIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  if (remoteIp && BANNED_IPS.has(remoteIp.split(',')[0].trim())) {
    return res.status(403).json({ error: 'Banned' });
  }

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
