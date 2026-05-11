/**
 * Vercel Serverless Function — Webhook для Telegram бота
 *
 * Обрабатывает callback_query от inline-кнопок (удалить/оставить фото).
 *
 * Настройка webhook (выполнить один раз):
 *   curl -F "url=https://ТВОЙ_ДОМЕН.vercel.app/api/telegram-webhook" \
 *        https://api.telegram.org/bot<ТОКЕН>/setWebhook
 *
 * Удобный эндпоинт для настройки:
 *   Открой в браузере: https://ТВОЙ_ДОМЕН.vercel.app/api/telegram-webhook?setup=1
 */

const TG_API = 'https://api.telegram.org';
const FB_DB_URL = 'https://project-3861147147890788156-default-rtdb.europe-west1.firebasedatabase.app';
const FB_TOKEN_PATH = 'femboy_guessor/apitg';
const FB_PHOTOS_PATH = 'femboy_guessor/photos';
const FB_CHECK_PATH = 'femboy_guessor/photoCheck';

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

async function fbGet(path) {
  const res = await fetch(`${FB_DB_URL}/${path}.json`);
  if (!res.ok) return null;
  return res.json();
}

async function fbSet(path, data) {
  await fetch(`${FB_DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function fbRemove(path) {
  await fetch(`${FB_DB_URL}/${path}.json`, { method: 'DELETE' });
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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

  // POST — обработка обновлений от Telegram
  if (req.method !== 'POST') return res.status(405).end();

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });

  // Обработка callback_query
  if (update.callback_query) {
    const cq = update.callback_query;
    const callbackId = cq.id;
    const data = cq.data || '';
    const chatId = cq.message?.chat?.id;

    // Формат: pc:{action}:{pendingId}
    // action: d (delete), k (keep)
    const parts = data.split(':');
    if (parts[0] === 'pc' && parts.length === 3) {
      const action = parts[1];
      const pendingId = parts.slice(2).join(':');

      try {
        // Читаем pending запись
        const pendingData = await fbGet(`${FB_CHECK_PATH}/pending/${pendingId}`);

        if (pendingData && pendingData.url) {
          if (action === 'd') {
            // Удаляем фото из Firebase
            const photos = await fbGet(FB_PHOTOS_PATH);
            if (Array.isArray(photos)) {
              const idx = photos.findIndex(p => p.url === pendingData.url || p.url === pendingData.url);
              if (idx !== -1) {
                photos.splice(idx, 1);
                await fbSet(FB_PHOTOS_PATH, photos);
              }
            }
            // Удаляем pending
            await fbRemove(`${FB_CHECK_PATH}/pending/${pendingId}`);
            await answerCallback(callbackId, '🗑 Фото удалено из базы');
          } else if (action === 'k') {
            // Просто удаляем pending
            await fbRemove(`${FB_CHECK_PATH}/pending/${pendingId}`);
            await answerCallback(callbackId, '✅ Фото оставлено');
          }
        } else {
          // Pending не найден (возможно уже обработан)
          await answerCallback(callbackId, '⏳ Запись устарела или уже обработана');
        }
      } catch (err) {
        console.error('Callback processing error:', err);
        await answerCallback(callbackId, '❌ Ошибка обработки').catch(() => {});
      }
    } else {
      // Неизвестный callback_data
      await answerCallback(callbackId, '✅ Принято').catch(() => {});
    }
  }

  res.status(200).json({ ok: true });
}
