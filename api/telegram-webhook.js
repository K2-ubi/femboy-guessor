const { TG_API, isBanned, setSecurityHeaders, getToken, checkContentLength, checkRateLimit, fetchWithTimeout } = require('./_shared');

const WORKER_BASE = 'https://quiet-hat-2de7.konstasil777.workers.dev';

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    return res.status(200).json({ ok: true, message: 'POST is handled by Cloudflare Worker. Webhook URL: ' + WORKER_BASE });
  }

  const banResult = await isBanned(req);
  if (banResult) return res.status(403).json({ error: 'Banned' });

  if (req.method === 'GET' && req.query?.setup === '1') {
    try {
      const token = await getToken();
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      let setupUrl = `${TG_API}/bot${token}/setWebhook?url=${encodeURIComponent(WORKER_BASE)}`;
      if (secret) {
        setupUrl += `&secret_token=${encodeURIComponent(secret)}`;
      }
      const tgRes = await fetchWithTimeout(setupUrl);
      const data = await tgRes.json();
      return res.status(200).json({ ok: data.ok, description: data.description, webhookUrl: WORKER_BASE });
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
      message: 'Webhook processing moved to Cloudflare Worker: ' + WORKER_BASE,
      setup: WORKER_BASE + '/setup',
      status: WORKER_BASE + '/status'
    });
  }

  res.status(405).end();
}
