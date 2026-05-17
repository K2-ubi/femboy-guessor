/**
 * Vercel Serverless Function — проверка фото
 *
 * Использует Firebase Admin SDK (ключ из FIREBASE_SERVICE_ACCOUNT).
 *
 * GET /api/photo-check?url=... — проверить одно фото (вызывается с клиента)
 * GET /api/photo-check         — полная проверка всех фото (крон/вручную)
 */

const admin = require('firebase-admin');

const TG_API = 'https://api.telegram.org';
const ADMIN_TG_CHAT_IDS = ['1212294771', '8240197891'];
const CHECK_DELAY_MS = 10000;
const BATCH_SIZE = 3;

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

  const remoteIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  if (remoteIp && BANNED_IPS.has(remoteIp.split(',')[0].trim())) {
    return res.status(403).json({ error: 'Banned' });
  }

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
  const database = db();

  // Читаем курсор
  const cursorSnap = await database.ref('femboy_guessor/photoCheck/cursor').get().catch(() => null);
  const cursorData = cursorSnap ? cursorSnap.val() : null;
  let startIdx = (cursorData && typeof cursorData === 'object' && cursorData.lastIndex != null)
    ? Number(cursorData.lastIndex) + 1 : 0;
  let isFirstRun = cursorData === null || cursorData === undefined ||
    (typeof cursorData === 'object' && cursorData.lastIndex == null);

  // Читаем фото
  const photosSnap = await database.ref('femboy_guessor/photos').get();
  let photos = photosSnap.val();
  if (!Array.isArray(photos) || !photos.length) {
    await database.ref('femboy_guessor/photoCheck/cursor').remove();
    return;
  }

  // Если проверка завершена (дошли до конца) — сбрасываем и выходим
  if (startIdx >= photos.length) {
    const token = await getToken();
    const allCheckedSnap = await database.ref('femboy_guessor/photoCheck/results').get().catch(() => null);
    const allChecked = allCheckedSnap ? allCheckedSnap.val() : null;
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

    await database.ref('femboy_guessor/photoCheck/cursor').remove();
    await database.ref('femboy_guessor/photoCheck/results').remove();
    return;
  }

  // Первый запуск — очищаем старые pending
  if (isFirstRun) {
    await database.ref('femboy_guessor/photoCheck/pending').remove();
    await database.ref('femboy_guessor/photoCheck/results').remove();
  }

  // Обрабатываем batch
  const batch = photos.slice(startIdx, startIdx + BATCH_SIZE);
  let problemCount = 0;

  const prevResultsSnap = await database.ref('femboy_guessor/photoCheck/results').get().catch(() => null);
  const prevResults = prevResultsSnap ? prevResultsSnap.val() : null;
  const prevProblematic = (prevResults && prevResults.problematic) || 0;

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    const idx = startIdx + i;

    if (!item || !item.url) continue;

    const ok = await checkUrl(item.url);

    if (!ok) {
      problemCount++;
      const pendingId = 'pc_cron_' + Date.now() + '_' + idx;
      await database.ref(`femboy_guessor/photoCheck/pending/${pendingId}`).set({
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

    if (i < batch.length - 1) {
      await sleep(CHECK_DELAY_MS);
    }
  }

  // Обновляем курсор и результаты
  const newLastIdx = startIdx + batch.length - 1;
  await database.ref('femboy_guessor/photoCheck/cursor').set({
    lastIndex: newLastIdx,
    updatedAt: Date.now()
  });

  await database.ref('femboy_guessor/photoCheck/results').set({
    total: photos.length,
    problematic: prevProblematic + problemCount,
    checked: Math.min(newLastIdx + 1, photos.length),
    updatedAt: Date.now()
  });
}
