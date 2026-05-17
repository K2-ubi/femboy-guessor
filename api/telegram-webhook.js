





const admin = require('firebase-admin');

const TG_API = 'https://api.telegram.org';

const BANNED_IPS = new Set([
  '94.181.18.114',
]);

const ALLOWED_CHAT_IDS = new Set([
  '1212294771',
  '8240197891',
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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


  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      message: 'Telegram webhook endpoint. Add ?setup=1 to configure or ?status=1 to check.'
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const update = req.body;
  if (!update) return res.status(200).json({ ok: true });


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

  if (update.message && update.message.text) {
    const text = update.message.text.trim();
    const chatId = update.message.chat.id;

    const userMatch = text.match(/^\/user\s+(.+)/i);
    if (userMatch) {
      if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
        const token = await getToken();
        await fetch(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Команда доступна только администраторам'
          })
        });
        return res.status(200).json({ ok: true });
      }
      const nickPattern = userMatch[1].trim().toLowerCase();
      try {
        const database = db();
        const [usersSnap, statsSnap, regLogsSnap] = await Promise.all([
          database.ref('femboy_guessor/users').get(),
          database.ref('femboy_guessor/userStats').get(),
          database.ref('femboy_guessor/registrationLogs').get()
        ]);

        const usersData = usersSnap.exists() ? usersSnap.val() : {};
        const statsData = statsSnap.exists() ? statsSnap.val() : {};
        const regLogsData = regLogsSnap.exists() ? regLogsSnap.val() : {};

        const matches = [];
        for (const [uid, userInfo] of Object.entries(usersData)) {
          const username = (userInfo && userInfo.username || '').toLowerCase();
          if (username && username.includes(nickPattern)) {
            const stats = statsData[uid] || {};
            let regLogIp = 'N/A';
            for (const log of Object.values(regLogsData)) {
              if (log && log.uid === uid && log.ip) {
                regLogIp = log.ip;
                break;
              }
            }
            matches.push({
              uid,
              username: userInfo.username || '?',
              createdAt: userInfo.createdAt ? new Date(userInfo.createdAt).toLocaleString() : '?',
              runs: stats.runs || 0,
              bestStreak: stats.bestStreak || 0,
              wins: stats.wins || 0,
              losses: stats.losses || 0,
              totalCorrect: stats.totalCorrect || 0,
              totalIncorrect: stats.totalIncorrect || 0,
              totalScore: stats.totalScore || 0,
              avgStreak: stats.avgStreak || 0,
              regIp: regLogIp
            });
          }
        }

        let responseText;
        if (matches.length === 0) {
          responseText = `❌ Пользователи с ником, содержащим "${nickPattern}", не найдены`;
        } else {
          responseText = `🔍 Найдено пользователей: ${matches.length}\n\n`;
          for (const m of matches.slice(0, 10)) {
            responseText += `👤 <b>${escapeHtml(m.username)}</b>\n🆔 <code>${m.uid}</code>\n📅 Создан: ${m.createdAt}\n`;
            if (m.regIp !== 'N/A') responseText += `🌐 IP: ${m.regIp}\n`;
            responseText += `📊 Статистика:\n`;
            responseText += `  • Забегов: ${m.runs}\n`;
            responseText += `  • Лучшая серия: ${m.bestStreak}\n`;
            responseText += `  • Средняя серия: ${(m.avgStreak).toFixed(1)}\n`;
            responseText += `  • Правильно: ${m.totalCorrect}\n`;
            responseText += `  • Ошибок: ${m.totalIncorrect}\n`;
            responseText += `  • Побед: ${m.wins} / Поражений: ${m.losses}\n`;
            responseText += `  • Всего очков: ${m.totalScore}\n`;
            responseText += `━━━━━━━━━━━━━━━━\n`;
          }
          if (matches.length > 10) {
            responseText += `... и ещё ${matches.length - 10} пользователей`;
          }
        }

        const token = await getToken();
        await fetch(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: responseText,
            parse_mode: 'HTML'
          })
        });
      } catch (err) {
        console.error('/user command error:', err);
        const token = await getToken();
        await fetch(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Ошибка: ' + err.message
          })
        });
      }
    }
  }

  res.status(200).json({ ok: true });
}
