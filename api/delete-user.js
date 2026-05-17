const admin = require('firebase-admin');

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

async function isAdminUid(uid) {
  initAdmin();
  const db = admin.database();
  const snap = await db.ref('femboy_guessor/admins/' + uid).get();
  return snap.exists() && (snap.val() === true || snap.val() === 1 || snap.val() === '1');
}

async function deleteUserFromAuth(uid) {
  try {
    await admin.auth().deleteUser(uid);
    return true;
  } catch (err) {
    if (err.code === 'auth/user-not-found') return false;
    throw err;
  }
}

async function deleteUserDataFromDb(uid) {
  initAdmin();
  const db = admin.database();
  const promises = [];
  promises.push(db.ref('femboy_guessor/users/' + uid).remove());
  promises.push(db.ref('femboy_guessor/userStats/' + uid).remove());
  const statsSnap = await db.ref('femboy_guessor/stats').orderByChild('userId').equalTo(uid).get();
  if (statsSnap.exists()) {
    const updates = {};
    statsSnap.forEach(child => { updates[child.key] = null; });
    promises.push(db.ref('femboy_guessor/stats').update(updates));
  }
  await Promise.all(promises);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  const { adminUid, targetUid, nickPattern } = req.body || {};

  if (!adminUid) return res.status(400).json({ error: 'adminUid required' });

  try {
    const adminValid = await isAdminUid(adminUid);
    if (!adminValid) return res.status(403).json({ error: 'Not admin' });

    if (targetUid) {
      const authDeleted = await deleteUserFromAuth(targetUid);
      await deleteUserDataFromDb(targetUid);
      return res.status(200).json({ ok: true, deleted: true, authDeleted, uid: targetUid });
    }

    if (nickPattern) {
      initAdmin();
      const db = admin.database();
      const usersSnap = await db.ref('femboy_guessor/users').get();
      if (!usersSnap.exists()) return res.status(200).json({ ok: true, deleted: 0, uids: [] });

      const pattern = String(nickPattern).toLowerCase();
      const toDelete = [];
      usersSnap.forEach(child => {
        const val = child.val();
        const username = (val && val.username || '').toLowerCase();
        if (username && username.includes(pattern)) {
          toDelete.push(child.key);
        }
      });

      const results = [];
      for (const uid of toDelete) {
        try {
          const authDeleted = await deleteUserFromAuth(uid);
          await deleteUserDataFromDb(uid);
          results.push({ uid, authDeleted });
        } catch (e) {
          results.push({ uid, error: e.message });
        }
      }

      return res.status(200).json({
        ok: true,
        deleted: results.filter(r => !r.error).length,
        total: toDelete.length,
        results
      });
    }

    return res.status(400).json({ error: 'targetUid or nickPattern required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
