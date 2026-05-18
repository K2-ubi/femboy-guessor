const { isBanned, setSecurityHeaders, checkContentLength, checkRateLimit } = require('./_shared');

const MAX_EMAIL_LEN = 320;

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  if (!checkContentLength(req, res)) return;
  if (!checkRateLimit(req, res)) return;

  const banResult = await isBanned(req);
  if (banResult) return res.status(403).json({ error: 'Banned' });

  try {
    const { to, code, subject } = req.body || {};
    if (!to || !code) return res.status(400).json({ error: 'to and code required' });

    if (typeof to !== 'string' || to.length > MAX_EMAIL_LEN || !to.includes('@')) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT || '587';
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;

    if (!smtpHost || !smtpUser || !smtpPass) {
      return res.status(501).json({ error: 'SMTP not configured on server' });
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: smtpPort === '465',
      auth: { user: smtpUser, pass: smtpPass }
    });

    const info = await transporter.sendMail({
      from: smtpUser,
      to: to,
      subject: subject || 'Femboy Guessor — код подтверждения',
      text: `Ваш код: ${code}\n\nНикому не сообщайте этот код.\nFemboy Guessor`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#e91e63;">Femboy Guessor</h2>
        <p>Ваш код для входа:</p>
        <div style="font-size:32px;font-weight:900;letter-spacing:8px;text-align:center;padding:16px;background:#f5f5f5;border-radius:8px;margin:16px 0;">${code}</div>
        <p style="color:#666;font-size:12px;">Никому не сообщайте этот код.</p>
      </div>`
    });

    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
