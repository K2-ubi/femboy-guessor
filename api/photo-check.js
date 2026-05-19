const { isBanned, setSecurityHeaders, db, checkRateLimit, verifyAppCheck, fetchWithTimeout, isValidUrl } = require('./_shared');

const WORKER_URL = process.env.WORKER_URL || 'https://quiet-hat-2de7.konstasil777.workers.dev';

const ADMIN_TG_CHAT_IDS = ['1212294771', '8240197891'];
const CHECK_DELAY_MS = 10000;
const BATCH_SIZE = 3;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function tgSendViaWorker(chatId, text, replyMarkup) {
  const payload = { action: 'sendMessage', chat_id: String(chatId), text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetchWithTimeout(`${WORKER_URL}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || `Worker returned ${res.status}`);
  return data;
}

async function checkUrl(url) {
  if (!isValidUrl(url)) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhotoCheck/1.0)' }
    });
    clearTimeout(timer);
    return response.status === 200;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (!checkRateLimit(req, res)) return;
    if (!(await verifyAppCheck(req, res))) return;
  }

  const banResult = await isBanned(req);
  if (banResult) return res.status(403).json({ error: 'Banned' });

  const { url } = req.query || {};

  if (req.method === 'GET' && url) {
    const ok = await checkUrl(url);
    return res.json({ ok });
  }

  res.json({ ok: true, message: 'Photo check started' });

  try {
    await runFullCheck();
  } catch (err) {
    console.error('Full check error:', err);
    for (const chatId of ADMIN_TG_CHAT_IDS) {
      tgSendViaWorker(chatId, `❌ Ошибка проверки фото: ${err.message}`).catch(() => {});
    }
  }
}

async function runFullCheck() {
  const database = db();

  const cursorSnap = await database.ref('femboy_guessor/photoCheck/cursor').get().catch(() => null);
  const cursorData = cursorSnap ? cursorSnap.val() : null;
  let startIdx = (cursorData && typeof cursorData === 'object' && cursorData.lastIndex != null)
    ? Number(cursorData.lastIndex) + 1 : 0;
  let isFirstRun = cursorData === null || cursorData === undefined ||
    (typeof cursorData === 'object' && cursorData.lastIndex == null);

  const photosSnap = await database.ref('femboy_guessor/photos').get();
  let photos = photosSnap.val();
  if (!Array.isArray(photos) || !photos.length) {
    await database.ref('femboy_guessor/photoCheck/cursor').remove();
    return;
  }

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
      const ipResp = await fetchWithTimeout('https://api.ipify.org?format=json');
      const ipData = await ipResp.json();
      serverIp = ipData.ip || 'Vercel';
    } catch (_) {}

    const fullMsg = msg + '\n\n🌐 IP сервера: ' + serverIp;

    for (const chatId of ADMIN_TG_CHAT_IDS) {
      await tgSendViaWorker(chatId, fullMsg).catch(() => {});
    }

    await database.ref('femboy_guessor/photoCheck/cursor').remove();
    await database.ref('femboy_guessor/photoCheck/results').remove();
    return;
  }

  if (isFirstRun) {
    await database.ref('femboy_guessor/photoCheck/pending').remove();
    await database.ref('femboy_guessor/photoCheck/results').remove();
  }

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

      for (const chatId of ADMIN_TG_CHAT_IDS) {
        await tgSendViaWorker(chatId, text, inlineKeyboard).catch(() => {});
      }
    }

    if (i < batch.length - 1) {
      await sleep(CHECK_DELAY_MS);
    }
  }

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
