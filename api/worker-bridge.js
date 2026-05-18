const { admin, initAdmin, db, setSecurityHeaders } = require('./_shared');

const ALLOWED_PREFIXES = [
  'femboy_guessor/pendingRegistrations',
  'femboy_guessor/usedTelegramIds',
  'femboy_guessor/tgVerifyCodes',
  'femboy_guessor/regBotState',
  'femboy_guessor/users',
  'femboy_guessor/userStats',
  'femboy_guessor/registrationLogs',
  'femboy_guessor/photoCheck',
  'femboy_guessor/photos'
];

const WORKER_SECRET = process.env.WORKER_BRIDGE_SECRET;

module.exports = async function handler(req, res) {
  setSecurityHeaders(res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  const secret = req.headers['x-worker-secret'];
  if (!WORKER_SECRET || secret !== WORKER_SECRET) {
    return res.status(403).json({ error: 'Invalid worker secret' });
  }

  const { ops } = req.body || {};
  if (!Array.isArray(ops) || ops.length === 0) {
    return res.status(400).json({ error: 'ops array required' });
  }

  try {
    const database = db();
    const results = [];

    for (const op of ops) {
      const { type, path, data } = op;

      if (!path || typeof path !== 'string') {
        results.push({ error: 'path required' });
        continue;
      }

      const allowed = ALLOWED_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
      if (!allowed) {
        results.push({ error: `path '${path}' not allowed` });
        continue;
      }

      const ref = database.ref(path);

      try {
        switch (type) {
          case 'get': {
            const snap = await ref.get();
            results.push({ exists: snap.exists(), data: snap.val() });
            break;
          }
          case 'set': {
            if (data === undefined) { results.push({ error: 'data required' }); break; }
            await ref.set(data);
            results.push({ ok: true });
            break;
          }
          case 'update': {
            if (data === undefined) { results.push({ error: 'data required' }); break; }
            await ref.update(data);
            results.push({ ok: true });
            break;
          }
          case 'remove': {
            await ref.remove();
            results.push({ ok: true });
            break;
          }
          default:
            results.push({ error: `unknown type: ${type}` });
        }
      } catch (opErr) {
        results.push({ error: opErr.message });
      }
    }

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
