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

function getDb() {
  initAdmin();
  return admin.database();
}

async function isAdminUid(uid) {
  const db = getDb();
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
  const db = getDb();
  const promises = [];
  promises.push(db.ref('femboy_guessor/users/' + uid).remove());
  promises.push(db.ref('femboy_guessor/userStats/' + uid).remove());
  const statsSnap = await db.ref('femboy_guessor/stats').get();
  if (statsSnap.exists()) {
    const updates = {};
    statsSnap.forEach(child => {
      const val = child.val();
      if (val && val.userId === uid) {
        updates[child.key] = null;
      }
    });
    if (Object.keys(updates).length) {
      promises.push(db.ref('femboy_guessor/stats').update(updates));
    }
  }
  const usedTgSnap = await db.ref('femboy_guessor/usedTelegramIds').get();
  if (usedTgSnap.exists()) {
    const tgUpdates = {};
    usedTgSnap.forEach(child => {
      const val = child.val();
      if (val && val.uid === uid) {
        tgUpdates['femboy_guessor/usedTelegramIds/' + child.key + '/deleted'] = true;
        tgUpdates['femboy_guessor/usedTelegramIds/' + child.key + '/deletedAt'] = Date.now();
      }
    });
    if (Object.keys(tgUpdates).length) {
      promises.push(db.ref().update(tgUpdates));
    }
  }
  await Promise.all(promises);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'delete-user endpoint. Use POST.' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  try {
    const { adminUid, targetUid, nickPattern, action } = req.body || {};

    if (!adminUid) return res.status(400).json({ error: 'adminUid required' });

    const adminValid = await isAdminUid(adminUid);
    if (!adminValid) return res.status(403).json({ error: 'Not admin' });

    if (action === 'deleteRecent') {
      const db = getDb();
      const cutoff = Date.now() - 3600000;
      const logsSnap = await db.ref('femboy_guessor/registrationLogs').get();
      const toDelete = [];
      if (logsSnap.exists()) {
        logsSnap.forEach(child => {
          const val = child.val();
          if (val && val.uid && val.timestamp && val.timestamp >= cutoff) {
            toDelete.push(val.uid);
          }
        });
      }
      const usersSnap = await db.ref('femboy_guessor/users').get();
      if (usersSnap.exists()) {
        usersSnap.forEach(child => {
          const val = child.val();
          if (val && val.createdAt && val.createdAt >= cutoff) {
            if (!toDelete.includes(child.key)) toDelete.push(child.key);
          }
        });
      }
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
        total: toDelete.length,
        deleted: results.filter(r => !r.error).length,
        results
      });
    }

    if (action === 'cleanupOrphans') {
      initAdmin();
      const db = getDb();
      const dbUsersSnap = await db.ref('femboy_guessor/users').get();
      const dbUsers = dbUsersSnap.exists() ? dbUsersSnap.val() : {};
      const authUsersResult = await admin.auth().listUsers(1000);
      const orphans = [];
      for (const authUser of authUsersResult.users) {
        if (!dbUsers[authUser.uid]) {
          orphans.push(authUser.uid);
        }
      }
      const results = [];
      for (const uid of orphans) {
        try {
          await admin.auth().deleteUser(uid);
          await deleteUserDataFromDb(uid);
          results.push({ uid, deleted: true });
        } catch (e) {
          results.push({ uid, error: e.message });
        }
      }
      return res.status(200).json({
        ok: true,
        totalOrphans: orphans.length,
        deleted: results.filter(r => r.deleted).length,
        results
      });
    }

    if (targetUid) {
      const authDeleted = await deleteUserFromAuth(targetUid);
      await deleteUserDataFromDb(targetUid);
      return res.status(200).json({ ok: true, deleted: true, authDeleted, uid: targetUid });
    }

    if (nickPattern) {
      const db = getDb();
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

    return res.status(400).json({ error: 'targetUid, nickPattern, or action required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
