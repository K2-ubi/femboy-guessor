const admin = require('firebase-admin');
const crypto = require('crypto');

const TG_API = 'https://api.telegram.org';
const MAX_BODY_SIZE = 1024 * 100;
const FETCH_TIMEOUT = 10000;
const RATE_LIMIT_WINDOW = 10000;
const RATE_LIMIT_MAX = 20;

const rateLimitMap = new Map();

let BANNED_IPS = new Set();
let bannedCacheTime = 0;
const BAN_CACHE_TTL = 60000;

function makeToken(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

function generateVerifyCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

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

async function refreshBannedIps() {
  if (Date.now() - bannedCacheTime < BAN_CACHE_TTL) return;
  try {
    initAdmin();
    const snap = await admin.database().ref('femboy_guessor/banned/ips').get();
    if (snap.exists()) {
      const data = snap.val();
      const newSet = new Set();
      if (Array.isArray(data)) {
        data.forEach(ip => { if (ip) newSet.add(String(ip).trim()); });
      } else if (typeof data === 'object' && data !== null) {
        Object.values(data).forEach(ip => { if (ip) newSet.add(String(ip).trim()); });
      }
      BANNED_IPS = newSet;
    }
    bannedCacheTime = Date.now();
  } catch (e) {
    console.error('refreshBannedIps error:', e);
  }
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

function db() {
  initAdmin();
  return admin.database();
}

function getClientIp(req) {
  const remoteIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  return remoteIp ? remoteIp.split(',')[0].trim() : '';
}

async function isBanned(req) {
  await refreshBannedIps();
  const clientIp = getClientIp(req);
  if (!clientIp) return false;
  if (BANNED_IPS.has(clientIp)) return true;
  const ipPrefix = clientIp.split('.').slice(0, 2).join('.');
  if (BANNED_IPS.has(ipPrefix + '.0.0')) return true;
  return false;
}

function setSecurityHeaders(res, methods) {
  methods = methods || 'POST, OPTIONS';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Cache-Control', 'no-store');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function checkContentLength(req, res) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > MAX_BODY_SIZE) {
    res.status(413).json({ error: 'Payload too large' });
    return false;
  }
  return true;
}

function checkRateLimit(req, res) {
  const clientIp = getClientIp(req);
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  let entries = rateLimitMap.get(clientIp);
  if (!entries) {
    entries = [];
    rateLimitMap.set(clientIp, entries);
  }

  const recent = entries.filter(t => t > windowStart);
  if (recent.length >= RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'Too many requests' });
    return false;
  }

  recent.push(now);
  rateLimitMap.set(clientIp, recent);

  if (rateLimitMap.size > 50000) {
    const cutoff = now - 60000;
    for (const [ip, times] of rateLimitMap) {
      const valid = times.filter(t => t > cutoff);
      if (valid.length === 0) rateLimitMap.delete(ip);
      else rateLimitMap.set(ip, valid);
    }
  }

  return true;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || FETCH_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateIP(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 198 && parts[1] === 18) return true;
  if (parts[0] === 198 && parts[1] === 19) return true;
  return false;
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '[::1]') return false;
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    if (isPrivateIP(hostname)) return false;
    if (hostname.endsWith('metadata.google.internal') || hostname.endsWith('metadata.googleapis.com')) return false;
    if (hostname === '169.254.169.254') return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  admin,
  TG_API,
  BANNED_IPS,
  crypto,
  makeToken,
  generateVerifyCode,
  initAdmin,
  refreshBannedIps,
  getToken,
  db,
  getClientIp,
  isBanned,
  setSecurityHeaders,
  escapeHtml,
  checkContentLength,
  checkRateLimit,
  fetchWithTimeout,
  isValidUrl,
};
