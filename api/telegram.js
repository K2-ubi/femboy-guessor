/**
 * Vercel Serverless Function — прокси для Telegram Bot API
 *
 * Зачем: браузер не может отправлять запросы напрямую к api.telegram.org
 * из-за CORS (политики одного источника). Этот файл работает как посредник:
 *
 *   Браузер → (своего же origin) /api/telegram → Vercel → api.telegram.org
 *
 * Vercel хостится в облаке (EU/US) — Telegram там не заблокирован.
 *
 * Токен бота читается из Firebase Realtime Database (femboy_guessor/apitg),
 * а не из переменных окружения — единый источник правды.
 *
 * ---------------------------------------------------------------
 *  Использование из браузера (JS):
 *
 *   fetch('/api/telegram', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({
 *       method: 'sendMessage',
 *       chat_id: '12345',
 *       text: 'hello'
 *     })
 *   })
 *
 *   // с фото (base64):
 *   fetch('/api/telegram', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({
 *       method: 'sendPhoto',
 *       chat_id: '12345',
 *       photo: 'data:image/jpeg;base64,...',
 *       caption: 'текст'
 *     })
 *   })
 *
 */

const TG_API = 'https://api.telegram.org';
const FB_DB_URL = 'https://project-3861147147890788156-default-rtdb.europe-west1.firebasedatabase.app';
const FB_TOKEN_PATH = 'femboy_guessor/apitg';

// Кеш на время жизни функции (Vercel может переиспользовать инстанс)
let cachedToken = null;
let tokenFetchPromise = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    const url = `${FB_DB_URL}/${FB_TOKEN_PATH}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firebase HTTP ${res.status}`);
    const v = await res.json();
    if (typeof v === 'string') {
      cachedToken = v.trim();
    } else if (typeof v === 'object' && v !== null) {
      const vals = Object.values(v).filter(x => typeof x === 'string');
      cachedToken = vals.length ? vals[0].trim() : null;
    }
    if (!cachedToken) throw new Error('Токен не найден в Firebase');
    return cachedToken;
  })();

  return tokenFetchPromise;
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { method, chat_id, text, photo, caption } = req.body || {};

  if (!method || !chat_id) {
    return res.status(400).json({ error: 'method and chat_id required' });
  }

  if (method === 'sendMessage' && !text) {
    return res.status(400).json({ error: 'text required for sendMessage' });
  }

  try {
    // Проверяем доступность токена при первом обращении
    await getToken();
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Token error: ${e.message}` });
  }

  try {
    const params = { chat_id };
    if (method === 'sendMessage') {
      params.text = text;
    } else if (method === 'sendPhoto') {
      if (photo) params.photo = photo;
      if (caption) params.caption = caption;
    } else {
      return res.status(400).json({ error: `Unsupported method: ${method}` });
    }

    const result = await sendToTelegram(method, params);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
}
