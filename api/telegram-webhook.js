const { admin, TG_API, isBanned, setSecurityHeaders, getToken, db, escapeHtml, checkContentLength, checkRateLimit, fetchWithTimeout, generateVerifyCode } = require('./_shared');

const ALLOWED_CHAT_IDS = new Set(['1212294771', '8240197891']);

async function answerCallback(callbackQueryId, text) {
  const token = await getToken();
  await fetchWithTimeout(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text: text || '✅ Готово',
      show_alert: false
    })
  });
}

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    if (!checkContentLength(req, res)) return;
    if (!checkRateLimit(req, res)) return;

    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      const received = req.headers['x-telegram-bot-api-secret-token'];
      if (!received || received !== webhookSecret) {
        return res.status(403).json({ error: 'Invalid webhook secret' });
      }
    }
  }

  const banResult = await isBanned(req);
  if (banResult) return res.status(403).json({ error: 'Banned' });

  if (req.method === 'GET' && req.query?.setup === '1') {
    try {
      const token = await getToken();
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'unknown';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const webhookUrl = `${proto}://${host}/api/telegram-webhook`;
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      let setupUrl = `${TG_API}/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
      if (secret) {
        setupUrl += `&secret_token=${encodeURIComponent(secret)}`;
      }
      const tgRes = await fetchWithTimeout(setupUrl);
      const data = await tgRes.json();
      return res.status(200).json({ ok: data.ok, description: data.description, webhookUrl });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'GET' && req.query?.status === '1') {
    try {
      const token = await getToken();
      const tgRes = await fetchWithTimeout(`${TG_API}/bot${token}/getWebhookInfo`);
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
      return res.status(200).json({ ok: true });
    }

    if (parts[0] === 'verify' && parts.length === 2) {
      const code = parts[1];
      try {
        const database = db();
        const codeSnap = await database.ref(`femboy_guessor/tgVerifyCodes/${code}`).get();
        if (!codeSnap.exists()) {
          await answerCallback(callbackId, '❌ Код устарел. Отправьте /start заново.');
          return res.status(200).json({ ok: true });
        }
        const codeData = codeSnap.val();
        if (String(codeData.chatId) !== String(chatId)) {
          await answerCallback(callbackId, '❌ Этот код не для вашего Telegram аккаунта');
          return res.status(200).json({ ok: true });
        }
        const usedId = `tg_${chatId}`;
        const usedSnap = await database.ref('femboy_guessor/usedTelegramIds/' + usedId).get();
        if (usedSnap.exists()) {
          await answerCallback(callbackId, '❌ Этот Telegram уже привязан к другому аккаунту или заблокирован');
          return res.status(200).json({ ok: true });
        }
        await database.ref(`femboy_guessor/tgVerifyCodes/${code}/confirmed`).set(true);
        await database.ref(`femboy_guessor/tgVerifyCodes/${code}/confirmedAt`).set(Date.now());
        await answerCallback(callbackId, '✅ Telegram подтверждён! Теперь введите код на сайте для регистрации.');
        const token = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `✅ Подтверждено! Ваш код: <code>${code}</code>\n\nВведите его на сайте в поле "Код из Telegram".`,
            parse_mode: 'HTML'
          })
        });
      } catch (err) {
        console.error('verify callback error:', err);
        await answerCallback(callbackId, '❌ Ошибка: ' + err.message).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    if (parts[0] === 'start_verify') {
      try {
        const code = generateVerifyCode();
        const database = db();
        await database.ref(`femboy_guessor/tgVerifyCodes/${code}`).set({
          chatId: String(chatId),
          createdAt: Date.now(),
          confirmed: false
        });
        const token = await getToken();
        const siteUrl = process.env.SITE_URL || 'https://femboy-guessor.vercel.app';
        await fetchWithTimeout(`${TG_API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🔐 Ваш код подтверждения: <code>${code}</code>\n\n1. Нажмите кнопку ниже, чтобы подтвердить\n2. Откройте сайт: ${siteUrl}\n3. Введите код в поле "Код из Telegram"\n\nКод действителен 10 минут.`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Подтвердить код', callback_data: `verify:${code}` }]]
            }
          })
        });
        await answerCallback(callbackId, '✅ Код отправлен!');
      } catch (err) {
        console.error('start_verify error:', err);
        await answerCallback(callbackId, '❌ Ошибка: ' + err.message).catch(() => {});
      }
      return res.status(200).json({ ok: true });
    }

    await answerCallback(callbackId, '✅ Принято').catch(() => {});
    return res.status(200).json({ ok: true });
  }

  if (update.message && update.message.text) {
    const text = update.message.text.trim();
    const chatId = update.message.chat.id;

    const startMatch = text.match(/^\/start\s+(.+)/i);
    if (startMatch) {
      const token = startMatch[1].trim();
      const database = db();
      const pendingSnap = await database.ref(`femboy_guessor/pendingRegistrations/${token}`).get();
      if (!pendingSnap.exists()) {
        const botToken = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Код регистрации не найден или устарел. Начните регистрацию на сайте заново.'
          })
        });
        return res.status(200).json({ ok: true });
      }
      const usedId = `tg_${chatId}`;
      const usedSnap = await database.ref('femboy_guessor/usedTelegramIds/' + usedId).get();
      if (usedSnap.exists()) {
        const botToken = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Этот Telegram уже привязан к другому аккаунту'
          })
        });
        return res.status(200).json({ ok: true });
      }
      await database.ref(`femboy_guessor/pendingRegistrations/${token}/confirmed`).set(true);
      await database.ref(`femboy_guessor/pendingRegistrations/${token}/chatId`).set(String(chatId));
      const botToken = await getToken();
      await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ Аккаунт подтверждён! Возвращайтесь на сайт для завершения регистрации.'
        })
      });
      return res.status(200).json({ ok: true });
    }

    if (text === '/start') {
      const database = db();
      const usedId = `tg_${chatId}`;
      const usedSnap = await database.ref('femboy_guessor/usedTelegramIds/' + usedId).get();
      if (usedSnap.exists()) {
        const botToken = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `ℹ️ Ваш Telegram (ID: ${chatId}) уже привязан к аккаунту.`
          })
        });
        return res.status(200).json({ ok: true });
      }
      const botToken = await getToken();
      await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `👋 Добро пожаловать!\n\nВаш Telegram ID: <code>${chatId}</code>\n\nНа сайте сейчас открыта регистрация? Отправьте мне ник, который вы указали на сайте, и я подтвержу регистрацию.\n\nИли перейдите по ссылке с сайта — тогда всё произойдёт автоматически.`,
          parse_mode: 'HTML'
        })
      });
      await database.ref('femboy_guessor/regBotState/' + chatId).set({
        waitingForNick: true,
        createdAt: Date.now()
      });
      return res.status(200).json({ ok: true });
    }

    const regStateSnap = await db().ref('femboy_guessor/regBotState/' + chatId).get();
    const regState = regStateSnap.val();
    if (regState && regState.waitingForNick) {
      const database = db();
      const nick = text.trim().toLowerCase();
      const pendingSnap = await database.ref('femboy_guessor/pendingRegistrations').get();
      let foundToken = null;
      let foundData = null;
      if (pendingSnap.exists()) {
        pendingSnap.forEach(child => {
          const val = child.val();
          if (val && val.nick && val.nick.toLowerCase() === nick && !val.confirmed) {
            foundToken = child.key;
            foundData = val;
          }
        });
      }
      if (foundToken) {
        const usedId = `tg_${chatId}`;
        const usedSnap = await database.ref('femboy_guessor/usedTelegramIds/' + usedId).get();
        if (usedSnap.exists()) {
          const botToken = await getToken();
          await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '❌ Этот Telegram уже привязан к другому аккаунту'
            })
          });
          await database.ref('femboy_guessor/regBotState/' + chatId).remove();
          return res.status(200).json({ ok: true });
        }
        await database.ref(`femboy_guessor/pendingRegistrations/${foundToken}/confirmed`).set(true);
        await database.ref(`femboy_guessor/pendingRegistrations/${foundToken}/chatId`).set(String(chatId));
        await database.ref('femboy_guessor/regBotState/' + chatId).remove();
        const botToken = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '✅ Аккаунт подтверждён! Возвращайтесь на сайт для завершения регистрации.'
          })
        });
      } else {
        await database.ref('femboy_guessor/regBotState/' + chatId).remove();
        const botToken = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Регистрация с таким ником не найдена. Убедитесь, что вы начали регистрацию на сайте и указали тот же ник.'
          })
        });
      }
      return res.status(200).json({ ok: true });
    }

    const userMatch = text.match(/^\/user\s+(.+)/i);
    if (userMatch) {
      if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
        const token = await getToken();
        await fetchWithTimeout(`${TG_API}/bot${token}/sendMessage`, {
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
        await fetchWithTimeout(`${TG_API}/bot${token}/sendMessage`, {
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
        await fetchWithTimeout(`${TG_API}/bot${token}/sendMessage`, {
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
