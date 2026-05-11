/**
 * Vercel Serverless Function — проверка фото
 *
 * GET /api/photo-check?url=... — проверить одно фото (вызывается с клиента)
 * GET /api/photo-check         — полная проверка всех фото (крон/вручную)
 */

const TG_API = 'https://api.telegram.org';
const FB_DB_URL = 'https://project-3861147147890788156-default-rtdb.europe-west1.firebasedatabase.app';
const FB_TOKEN_PATH = 'femboy_guessor/apitg';
const FB_PHOTOS_PATH = 'femboy_guessor/photos';
const FB_CHECK_PATH = 'femboy_guessor/photoCheck';
const ADMIN_TG_CHAT_IDS = ['1212294771', '8240197891'];
const CHECK_DELAY_MS = 10000;
const BATCH_SIZE = 3;

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
  if (!res.ok) throw new Error(`FB GET ${path} HTTP ${res.status}`);
  return res.json();
}

async function fbSet(path, data) {
  const res = await fetch(`${FB_DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`FB PUT ${path} HTTP ${res.status}`);
  return res.json();
}

async function fbRemove(path) {
  await fetch(`${FB_DB_URL}/${path}.json`, { method: 'DELETE' });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function tgSendMessage(chatId, text, replyMarkup) {
  const token = await getToken();
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `TG HTTP ${res.status}`);
  return data;
}

async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhotoCheck/1.0)' }
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function getServerIp(req) {
  return req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'N/A';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query || {};

  // Режим 1: проверка одного URL (с клиента)
  if (url) {
    const ok = await checkUrl(url);
    return res.json({ ok, ip: getServerIp(req) });
  }

  // Режим 2: полная проверка (крон)
  res.json({ ok: true, message: 'Photo check started' });

  try {
    await runFullCheck();
  } catch (err) {
    console.error('Full check error:', err);
    try {
      const token = await getToken();
      for (const chatId of ADMIN_TG_CHAT_IDS) {
        await fetch(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `❌ Ошибка проверки фото: ${err.message}`
          })
        }).catch(() => {});
      }
    } catch (_) {}
  }
}

async function runFullCheck() {
  // Читаем курсор
  const cursorData = await fbGet(`${FB_CHECK_PATH}/cursor`).catch(() => null);
  let startIdx = (cursorData && typeof cursorData === 'object' && cursorData.lastIndex != null)
    ? Number(cursorData.lastIndex) + 1 : 0;
  let isFirstRun = cursorData === null || cursorData === undefined ||
    (typeof cursorData === 'object' && cursorData.lastIndex == null);

  // Читаем фото
  let photos = await fbGet(FB_PHOTOS_PATH);
  if (!Array.isArray(photos) || !photos.length) {
    // Сброс — нечего проверять
    await fbRemove(`${FB_CHECK_PATH}/cursor`);
    return;
  }

  // Если проверка завершена (дошли до конца) — сбрасываем и выходим
  if (startIdx >= photos.length) {
    const token = await getToken();
    const allChecked = await fbGet(`${FB_CHECK_PATH}/results`).catch(() => null);
    const totalChecked = allChecked ? (allChecked.total || photos.length) : photos.length;
    const problemCount = allChecked ? (allChecked.problematic || 0) : 0;
    const msg = '📊 АВТО-ПРОВЕРКА ФОТО ЗАВЕРШЕНА' +
      '\n\nВсего фото: ' + photos.length +
      '\nПроблемных: ' + problemCount;

    let serverIp = 'Vercel';
    try {
      const ipResp = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipResp.json();
      serverIp = ipData.ip || 'Vercel';
    } catch (_) {}

    const fullMsg = msg + '\n\n🌐 IP сервера: ' + serverIp;

    for (const chatId of ADMIN_TG_CHAT_IDS) {
      await tgSendMessage(chatId, fullMsg).catch(() => {});
    }

    // Сбрасываем курсор
    await fbRemove(`${FB_CHECK_PATH}/cursor`);
    await fbRemove(`${FB_CHECK_PATH}/results`);
    return;
  }

  // Первый запуск — очищаем старые pending
  if (isFirstRun) {
    await fbRemove(`${FB_CHECK_PATH}/pending`);
    await fbRemove(`${FB_CHECK_PATH}/results`);
  }

  // Обрабатываем batch
  const batch = photos.slice(startIdx, startIdx + BATCH_SIZE);
  let problemCount = 0;

  const prevResults = await fbGet(`${FB_CHECK_PATH}/results`).catch(() => null);
  const prevProblematic = (prevResults && prevResults.problematic) || 0;

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    const idx = startIdx + i;

    if (!item || !item.url) continue;

    const ok = await checkUrl(item.url);

    if (!ok) {
      problemCount++;
      const pendingId = 'pc_cron_' + Date.now() + '_' + idx;
      await fbSet(`${FB_CHECK_PATH}/pending/${pendingId}`, {
        url: item.url,
        timestamp: Date.now()
      }).catch(() => {});

      const categoryLabel = (item.answer === 'boy' || item.gender === 'boy') ? '👨 ПАРЕНЬ' : '👩 ДЕВУШКА';
      const text = '❌ Проблемное фото (авто-проверка) #' + problemCount +
        '\n\n📷 ' + item.url +
        '\n\nКатегория: ' + categoryLabel +
        '\nСервер: ❌ не открывается';

      const inlineKeyboard = {
        inline_keyboard: [[
          { text: '🗑 Удалить', callback_data: 'pc:d:' + pendingId },
          { text: '✅ Оставить', callback_data: 'pc:k:' + pendingId }
        ]]
      };

      const token = await getToken();
      for (const chatId of ADMIN_TG_CHAT_IDS) {
        await tgSendMessage(chatId, text, inlineKeyboard).catch(() => {});
      }
    }

    // Задержка между проверками
    if (i < batch.length - 1) {
      await sleep(CHECK_DELAY_MS);
    }
  }

  // Обновляем курсор и результаты
  const newLastIdx = startIdx + batch.length - 1;
  await fbSet(`${FB_CHECK_PATH}/cursor`, {
    lastIndex: newLastIdx,
    updatedAt: Date.now()
  });

  await fbSet(`${FB_CHECK_PATH}/results`, {
    total: photos.length,
    problematic: prevProblematic + problemCount,
    checked: Math.min(newLastIdx + 1, photos.length),
    updatedAt: Date.now()
  });
}
