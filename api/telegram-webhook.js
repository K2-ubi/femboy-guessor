/**
 * Vercel Serverless Function — Webhook для Telegram бота
 *
 * Использует Firebase Admin SDK (ключ из FIREBASE_SERVICE_ACCOUNT).
 */

const admin = require('firebase-admin');

const TG_API = 'https://api.telegram.org';

const BANNED_IPS = new Set([
  '94.181.18.114',
]);

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

function db() {
  initAdmin();
  return admin.database();
}

async function getToken() {
  initAdmin();
  const snap = await admin.database().ref('femboy_guessor/apitg').get();
  const v = snap.val();
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object' && v !== null) {
    const vals = Object.values(v).filter(x => typeof x === 'string');
    if (vals.length) return vals[0].trim();
  }
  throw new Error('Токен не найден в Firebase');
}

async function answerCallback(callbackQueryId, text) {
  const token = await getToken();
  await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || '✅ Готово',
      show_alert: false
    })
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const remoteIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  if (remoteIp && BANNED_IPS.has(remoteIp.split(',')[0].trim())) {
    return res.status(403).json({ error: 'Banned' });
  }

  // Режим установки webhook
  if (req.method === 'GET' && req.query?.setup === '1') {
    try {
      const token = await getToken();
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'unknown';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const webhookUrl = `${proto}://${host}/api/telegram-webhook`;
      const tgRes = await fetch(`${TG_API}/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const data = await tgRes.json();
      return res.status(200).json({ ok: data.ok, description: data.description, webhookUrl });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // Проверка статуса webhook
  if (req.method === 'GET' && req.query?.status === '1') {
    try {
      const token = await getToken();
      const tgRes = await fetch(`${TG_API}/bot${token}/getWebhookInfo`);
      const data = await tgRes.json();
      return res.status(200).json(data.result || data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // Простой GET — информация
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Telegram webhook endpoint. Add ?setup=1 to configure or ?status=1 to check.'
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });

  // Обработка callback_query
  if (update.callback_query) {
    const cq = update.callback_query;
    const callbackId = cq.id;
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id;

    const parts = data.split(':');
    if (parts[0] === 'pc' && parts.length === 3) {
      const action = parts[1];
      const pendingId = parts.slice(2).join(':');

      try {
        const database = db();
        const pendingSnap = await database.ref(`femboy_guessor/photoCheck/pending/${pendingId}`).get();
        const pendingData = pendingSnap.val();

        if (pendingData && pendingData.url) {
          if (action === 'd') {
            const photosSnap = await database.ref('femboy_guessor/photos').get();
            const photos = photosSnap.val();
            if (Array.isArray(photos)) {
              const idx = photos.findIndex(p => p.url === pendingData.url);
              if (idx !== -1) {
                photos.splice(idx, 1);
                await database.ref('femboy_guessor/photos').set(photos);
              }
            }
            await database.ref(`femboy_guessor/photoCheck/pending/${pendingId}`).remove();
            await answerCallback(callbackId, '🗑 Фото удалено из базы');
          } else if (action === 'k') {
            await database.ref(`femboy_guessor/photoCheck/pending/${pendingId}`).remove();
            await answerCallback(callbackId, '✅ Фото оставлено');
          }
        } else {
          await answerCallback(callbackId, '⏳ Запись устарела или уже обработана');
        }
      } catch (err) {
        console.error('Callback processing error:', err);
        await answerCallback(callbackId, '❌ Ошибка обработки').catch(() => {});
      }
    } else {
      await answerCallback(callbackId, '✅ Принято').catch(() => {});
    }
  }

  res.status(200).json({ ok: true });
}
