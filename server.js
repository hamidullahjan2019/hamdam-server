#!/usr/bin/env node
/* Hamdam production server — implements API-CONTRACT.md with zero dependencies.
   Storage: Supabase Postgres (via PostgREST, using Node's built-in fetch) when
   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; otherwise the original
   JSON file (data/db.json) is used, so local testing still works with no setup.
   The server keeps the whole state in memory as its working set and persists
   every change to the configured store (debounced, as before). Supabase is the
   durable source of truth in production; the JSON file is only a dev fallback.
   Run one instance only: the in-memory working set is not shared between
   processes. Profile/chat photos live in Supabase Storage (bucket hamdam-photos,
   public read; see supabase-storage-photos.sql). The client uploads
   straight to Storage and registers the public URL via POST
   /api/media-url; /media on local disk stays only as a fallback for
   already-uploaded files and for voice audio (out of scope here).

   Run:  node server.js            (serves the app at http://localhost:8787)
   Env:  PORT, PUBLIC_URL, DATA_FILE, ADMIN_KEY, ADMIN_EMAIL, ALLOW_ORIGIN,
         SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
         DEV_OTP=1 (return the code in the response — local dev only, default off),
         DEV_GOLD=1 (trial gold without billing — dev only),
         HESABPAY_API_KEY (live Gold payments; without it /api/checkout stays disabled),
         HESABPAY_ENV=sandbox (use the HesabPay sandbox API),
         HESABPAY_BASE_URL, HESABPAY_RATE (tests only — override the API base / AFN rate) */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 8787;
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const UPLOADS = path.join(path.dirname(DATA_FILE), 'uploads');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const DEV_OTP = process.env.DEV_OTP === '1';   // OFF by default: codes are never returned or logged
const DEV_GOLD = process.env.DEV_GOLD === '1';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_ANON = process.env.SUPABASE_ANON_KEY || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SB = !!(SB_URL && SB_SERVICE);       // Supabase store enabled only when both are set

/* ---------- HesabPay Gold payments ($5 / 30 days) ----------
   Contract — read from the official WooCommerce plugins (2026-11-08):
   - habib-studio/hesabpay-payment-gateway, includes/class-wc-gateway-hesabpay.php:
     POST https://api.hesab.com/api/v1/payment/create-session
     headers: Authorization: 'API-KEY <key>', Content-Type: application/json
     body: {items:[{id, name, price}]} ; response: {url} (the payment page).
     Webhook payload: {status_code, signature, timestamp, transaction_id,
     items:[{id,...}], success}; success = status_code===10 && success===true;
     order id = items[0].id; signature verified locally as md5(api_key+timestamp).
   - XAbubakr/hesabpay-gateway-for-woocommerce v1.0.2 (main file):
     same endpoint; payload {order_id, items:[{id, product_id, name, price}],
     email, callback_url, success_url, cancel_url}; price is an INTEGER in AFN
     (USD total x live USD->AFN rate, rounded); webhook verified via
     POST {base}/api/v1/hesab/webhooks/verify-signature with header
     Authorization: 'API-KEY <key>' and body {signature, timestamp};
     response {success:true} means valid. Sandbox base:
     https://api-sandbox.hesab.com (sandbox API key from the dashboard).
   NOT settled by the plugin sources (assumptions — confirm with HesabPay):
   - whether per-session callback_url/success_url are honoured, or the merchant
     dashboard's URLs override them (both are sent AND the webhook URL must
     also be registered in the HesabPay Developer Dashboard);
   - sandbox key availability (a dashboard setting per the plugin);
   - HesabPay's per-transaction fee (not in the plugin source).
   Pending Gold orders live in db.goldOrders and are persisted to the Supabase
   kv table (key 'gold_orders') so a server restart/sleep between checkout and
   the webhook cannot lose them. Gold expiry lives in the user's profile
   (me.goldUntil, milliseconds) — no schema change; PUT /api/me preserves it
   from the previous profile, exactly like myFilters. */
const GOLD_PRICE_USD = 5;
const GOLD_DAYS = 30;
const GOLD_DAY_MS = 86400000;
const HESABPAY_KEY = process.env.HESABPAY_API_KEY || '';
const HESABPAY_LIVE = 'https://api.hesab.com';
const HESABPAY_SANDBOX = 'https://api-sandbox.hesab.com';
const HESABPAY_BASE = process.env.HESABPAY_BASE_URL || (process.env.HESABPAY_ENV === 'sandbox' ? HESABPAY_SANDBOX : HESABPAY_LIVE);
const HESABPAY_FALLBACK_RATE = 70;   // AFN per USD — used only if the live rate fetch fails
const APP_URL = 'https://fastidious-pixie-4c8929.netlify.app';   // return URL host for Gold payments
function isGold(u) { return !!u && !!u.gold && !(u.me && u.me.goldUntil && u.me.goldUntil <= Date.now()); }
function isBoosted(u) { return !!u && !!u.me && !!u.me.boostUntil && u.me.boostUntil > Date.now(); }

/* ---------- free daily limits (batch 3, item 2) ----------
   Free users: 10 likes (a super-like counts as a like) and 1 compliment
   per day. When an allowance runs out it refills 12h after running out.
   Gold users (effective gold via isGold, so expired Gold counts as free)
   are unlimited and never consume. Stored in u.me.limits, inside the me
   JSONB like goldUntil, so it survives restarts in both Supabase mode
   (the existing me column - no schema change) and JSON-file mode;
   PUT /api/me preserves it like goldUntil. */
const LIMITS_LIKES_PER_DAY = 10;
const LIMITS_COMPLIMENTS_PER_DAY = 1;
const LIMITS_REFILL_MS = 12 * 3600000;
function normLimits(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const n = v => (Number.isFinite(+v) && +v > 0) ? Math.floor(+v) : 0;
  return { likesUsed: n(r.likesUsed), likesResetAt: n(r.likesResetAt), complimentsUsed: n(r.complimentsUsed), complimentsResetAt: n(r.complimentsResetAt) };
}
function limitsOf(u) { return normLimits(u && u.me && u.me.limits); }
function limitsView(u) {
  const l = limitsOf(u), now = Date.now();
  const likesUsed = (l.likesResetAt && now > l.likesResetAt) ? 0 : l.likesUsed;
  const likesResetAt = (l.likesResetAt && now > l.likesResetAt) ? 0 : l.likesResetAt;
  const complimentsUsed = (l.complimentsResetAt && now > l.complimentsResetAt) ? 0 : l.complimentsUsed;
  const complimentsResetAt = (l.complimentsResetAt && now > l.complimentsResetAt) ? 0 : l.complimentsResetAt;
  return { likesUsed, likesLeft: Math.max(0, LIMITS_LIKES_PER_DAY - likesUsed), likesResetAt, complimentsUsed, complimentsLeft: Math.max(0, LIMITS_COMPLIMENTS_PER_DAY - complimentsUsed), complimentsResetAt };
}
// Returns null when the react may proceed (allowance consumed), or
// { kind: 'likes'|'compliments', resetAt } when a free user is past it.
// A like/super-like consumes the like allowance; a react carrying a
// compliment also consumes the compliment allowance.
function consumeLimits(u, countsLike, countsCompliment) {
  if (isGold(u)) return null;
  if (!u.me || typeof u.me !== 'object') u.me = {};
  const l = normLimits(u.me.limits), now = Date.now();
  if (l.likesResetAt && now > l.likesResetAt) { l.likesUsed = 0; l.likesResetAt = 0; }
  if (l.complimentsResetAt && now > l.complimentsResetAt) { l.complimentsUsed = 0; l.complimentsResetAt = 0; }
  u.me.limits = l;
  if (countsLike && l.likesUsed >= LIMITS_LIKES_PER_DAY) return { kind: 'likes', resetAt: l.likesResetAt || now + LIMITS_REFILL_MS };
  if (countsCompliment && l.complimentsUsed >= LIMITS_COMPLIMENTS_PER_DAY) return { kind: 'compliments', resetAt: l.complimentsResetAt || now + LIMITS_REFILL_MS };
  if (countsLike) { l.likesUsed += 1; if (l.likesUsed >= LIMITS_LIKES_PER_DAY) l.likesResetAt = now + LIMITS_REFILL_MS; }
  if (countsCompliment) { l.complimentsUsed += 1; if (l.complimentsUsed >= LIMITS_COMPLIMENTS_PER_DAY) l.complimentsResetAt = now + LIMITS_REFILL_MS; }
  return null;
}
async function afnRate() {
  if (process.env.HESABPAY_RATE) { const v = +process.env.HESABPAY_RATE; if (v > 0) return v; }
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!r.ok) return HESABPAY_FALLBACK_RATE;
    const j = await r.json();
    const v = j && j.rates && +j.rates.AFN;
    return (v > 0) ? v : HESABPAY_FALLBACK_RATE;
  } catch (e) { return HESABPAY_FALLBACK_RATE; }
}
async function hesabpayCreateSession(payload) {
  let r;
  try {
    r = await fetch(HESABPAY_BASE + '/api/v1/payment/create-session', {
      method: 'POST',
      headers: { Authorization: 'API-KEY ' + HESABPAY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { throw new Error('hesabpay create-session failed: ' + e.message); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('hesabpay create-session failed: HTTP ' + r.status + ' ' + t.slice(0, 200)); }
  return r.json();
}
async function hesabpayVerifySignature(signature, timestamp) {
  // Primary: the remote verify endpoint (XAbubakr plugin). If that call itself
  // fails on the network, fall back to the local md5 check (habib-studio plugin:
  // md5(api_key + timestamp)). A remote "not valid" answer is final — no fallback.
  try {
    const r = await fetch(HESABPAY_BASE + '/api/v1/hesab/webhooks/verify-signature', {
      method: 'POST',
      headers: { Authorization: 'API-KEY ' + HESABPAY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: String(signature), timestamp: String(timestamp) }),
    });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return !!(j && j.success === true);
  } catch (e) {
    const expected = crypto.createHash('md5').update(HESABPAY_KEY + String(timestamp)).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))); }
    catch (e2) { return false; }
  }
}
function grantGold(u) {
  u.gold = true;
  if (!u.me || typeof u.me !== 'object') u.me = {};
  u.me.goldUntil = Date.now() + GOLD_DAYS * GOLD_DAY_MS;
  save();
}
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- store ----------
   Working set is kept in memory (as before) so every route handler stays
   synchronous and unchanged. Persistence is pluggable:
   - JSON mode (default): the whole state is written to DATA_FILE (debounced).
   - Supabase mode: at boot the state is loaded from Postgres; every change is
     persisted by diffing against the last synced snapshot and upserting only
     the changed rows (users / sessions / matches / reports / events / seq).
   Tables (see supabase-schema.sql): users, sessions, matches, reports,
   events, kv. Nested data (profile, reacts, messages) is stored as jsonb,
   mirroring the JSON structure 1:1. OTP codes are NOT stored here in
   Supabase mode — they live in Supabase Auth (see sendOtpEmail). */
let db = { seq: 1, users: {}, sessions: {}, matches: {}, reports: [], events: {}, goldOrders: {} };
function loadJson() { try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run: keep empty db */ } }
const otps = {}, hits = {};            // volatile (JSON mode OTPs + rate limits)

/* --- Supabase REST client (PostgREST, zero dependencies, global fetch) --- */
async function sbReq(method, path, body, prefer) {
  const headers = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  let r;
  try { r = await fetch(SB_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new Error('supabase request failed (' + method + ' ' + path + '): ' + e.message); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('supabase ' + method + ' ' + path + ' -> HTTP ' + r.status + ' ' + t.slice(0, 200)); }
  return r;
}
async function sbSelect(table) {           // all rows, paginated
  let out = [], offset = 0;
  for (;;) {
    const rows = await (await sbReq('GET', '/rest/v1/' + table + '?select=*&limit=1000&offset=' + offset)).json();
    out = out.concat(rows);
    if (rows.length < 1000) return out;
    offset += 1000;
  }
}
async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return;
  await sbReq('POST', '/rest/v1/' + table + '?on_conflict=' + onConflict, rows, 'resolution=merge-duplicates,return=minimal');
}
async function sbDelete(table, col, val) {
  await sbReq('DELETE', '/rest/v1/' + table + '?' + col + '=eq.' + encodeURIComponent(val), undefined, 'return=minimal');
}
const userToRow = u => ({ id: u.id, contact: u.contact, me: u.me || null, ver: u.ver || 0, gold: !!u.gold, blocked: u.blocked || {}, reacts: u.reacts || {}, hist: u.hist || [], unlocked: u.unlocked || {}, media: u.media || [], selfie: u.selfie || null, seen: u.seen || 0, created_at: u.createdAt || 0, compliments: u.compliments || {}, react_at: u.reactAt || {}, visits: u.visits || {} });
const userFromRow = r => ({ id: r.id, contact: r.contact, me: r.me, ver: r.ver, gold: !!r.gold, blocked: r.blocked || {}, reacts: r.reacts || {}, hist: r.hist || [], unlocked: r.unlocked || {}, media: r.media || [], createdAt: r.created_at || 0, seen: r.seen || 0, selfie: r.selfie || undefined, compliments: r.compliments || {}, reactAt: r.react_at || {}, visits: r.visits || {} });
const reportToRow = r => ({ id: r.id, t: r.t, by_user: r.by, about: r.about, reason: r.reason || '', context: r.context || [], status: r.status || 'open' });
const reportFromRow = r => ({ id: r.id, t: r.t, by: r.by_user, about: r.about, reason: r.reason, context: r.context || [], status: r.status });
async function storeLoad() {               // Supabase -> in-memory db (throws on failure)
  const [users, sessions, matches, reports, events, kv] = await Promise.all([
    sbSelect('users'), sbSelect('sessions'), sbSelect('matches'), sbSelect('reports'), sbSelect('events'), sbSelect('kv'),
  ]);
  db = { seq: 1, users: {}, sessions: {}, matches: {}, reports: [], events: {}, goldOrders: {} };
  for (const r of users) db.users[r.id] = userFromRow(r);
  for (const r of sessions) db.sessions[r.token] = r.user_id;
  for (const r of matches) db.matches[r.match_key] = { t: r.t, msgs: r.msgs || [] };
  db.reports = reports.map(reportFromRow).sort((a, b) => a.id - b.id);
  for (const r of events) db.events[r.user_id] = r.events || [];
  const seqRow = kv.find(k => k.key === 'seq');
  if (seqRow) db.seq = +seqRow.value || (Math.max(0, ...Object.keys(db.users).map(Number)) + 1);
  else db.seq = Math.max(0, ...Object.keys(db.users).map(Number)) + 1;
  const goRow = kv.find(k => k.key === 'gold_orders');
  if (goRow && goRow.value) { try { db.goldOrders = (typeof goRow.value === 'string' ? JSON.parse(goRow.value) : goRow.value) || {}; } catch (e) { db.goldOrders = {}; } }
}
let lastSynced = null, persistRunning = false, persistQueued = false;
async function persistOnce() {             // diff lastSynced snapshot -> Supabase
  const cur = JSON.stringify(db);
  if (cur === lastSynced) return;
  const prev = lastSynced ? JSON.parse(lastSynced) : { seq: 1, users: {}, sessions: {}, matches: {}, reports: [], events: {}, goldOrders: {} };
  if (prev.seq !== db.seq) await sbUpsert('kv', [{ key: 'seq', value: db.seq }], 'key');
  if (JSON.stringify(prev.goldOrders || {}) !== JSON.stringify(db.goldOrders)) await sbUpsert('kv', [{ key: 'gold_orders', value: db.goldOrders }], 'key');
  const diffMap = async (prevObj, curObj, toRow, table, pkCol) => {
    const rows = [], dels = [];
    for (const k of new Set([...Object.keys(prevObj || {}), ...Object.keys(curObj || {})])) {
      const a = JSON.stringify((prevObj || {})[k]), b = JSON.stringify((curObj || {})[k]);
      if (a === b) continue;
      if ((curObj || {})[k] !== undefined) rows.push(toRow((curObj || {})[k], k)); else dels.push(k);
    }
    await sbUpsert(table, rows, pkCol);
    for (const k of dels) await sbDelete(table, pkCol, k);
  };
  await diffMap(prev.users, db.users, userToRow, 'users', 'id');
  await diffMap(prev.sessions, db.sessions, (uid, token) => ({ token, user_id: uid, created_at: 0 }), 'sessions', 'token');
  await diffMap(prev.matches, db.matches, (m, k) => ({ match_key: k, t: m.t, msgs: m.msgs }), 'matches', 'match_key');
  const prevRep = new Map((prev.reports || []).map(r => [r.id, JSON.stringify(r)]));
  await sbUpsert('reports', db.reports.filter(r => JSON.stringify(r) !== prevRep.get(r.id)).map(reportToRow), 'id');
  await diffMap(prev.events, db.events, (evs, uid) => ({ user_id: +uid, events: evs }), 'events', 'user_id');
  lastSynced = cur;
}
async function persist() {                 // serialized, retry-on-next-save on failure
  if (persistRunning) { persistQueued = true; return; }
  persistRunning = true;
  try { await persistOnce(); } catch (e) { console.error('supabase persist failed:', e.message); }
  persistRunning = false;
  if (persistQueued) { persistQueued = false; save(); }
}
let saveT = null;
function save() {                          // debounced persist (both stores)
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (USE_SB) { persist(); return; }
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); }
    catch (e) { console.error('save failed', e.message); }
  }, 200);
}
async function bootStore() {               // called once before listening
  if (!USE_SB) { loadJson(); console.log('store: json file (' + DATA_FILE + ')'); return; }
  try {
    await storeLoad();
    lastSynced = JSON.stringify(db);
    console.log('store: supabase (' + SB_URL + ') — ' + Object.keys(db.users).length + ' users, ' + Object.keys(db.matches).length + ' matches');
  } catch (e) {
    console.error('FATAL: could not load data from Supabase: ' + e.message);
    console.error('Check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and run supabase-schema.sql in the Supabase SQL editor.');
    process.exit(1);
  }
}
function rate(key, max, ms) { const n = Date.now(), a = (hits[key] = (hits[key] || []).filter(t => n - t < ms)); if (a.length >= max) return false; a.push(n); return true; }
const err = (res, status, code) => json(res, status, { error: code });
function json(res, status, body) { res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors)); res.end(JSON.stringify(body)); }
let cors = {};
if (process.env.ALLOW_ORIGIN) cors = { 'Access-Control-Allow-Origin': process.env.ALLOW_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };

/* ---------- helpers ---------- */
const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const mkey = (a, b) => a < b ? a + '-' + b : b + '-' + a;
const otherOf = (k, me) => { const [a, b] = k.split('-').map(Number); return a === me ? b : a; };
function emit(uid, ev) { const q = db.events[uid] || (db.events[uid] = []); const id = (q.length ? q[q.length - 1].id : 0) + 1; q.push(Object.assign({}, ev, { id, t: Date.now() })); if (q.length > 500) q.splice(0, q.length - 500); }
function isBlocked(a, b) { const A = db.users[a], B = db.users[b]; return !!((A && A.blocked[b]) || (B && B.blocked[a])); }
function hasProfile(u) { return !!(u && u.me && u.me.name && u.me.age >= 18 && u.me.photos && u.me.photos.length > 0); }
function matchesOf(uid) { return Object.keys(db.matches).filter(k => k.split('-').map(Number).includes(uid)); }
function activeChats(uid) { return matchesOf(uid).filter(k => db.matches[k].msgs.some(m => m.from === uid)).length; }
function viewMsg(m, uid) { const o = { f: m.from === uid ? 'me' : 'them', t: m.t }; if (m.text) o.text = m.text; if (m.img) o.img = m.img; if (m.audio) { o.audio = m.audio; o.dur = m.dur; } if (m.from === uid && m.readAt) o.read = true; return o; }
function validLoc(lat, lng) { return typeof lat === 'number' && isFinite(lat) && typeof lng === 'number' && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180; }
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLa = rad(bLat - aLat), dLn = rad(bLng - aLng);
  const h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLn / 2) * Math.sin(dLn / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function parseLoc(b, prev) {
  // Returns { lat, lng } to store. Explicit null clears; absent or invalid
  // (out of range, non-numeric, or only one side given) keeps prev.
  if (b.lat === null || b.lng === null) return { lat: null, lng: null };
  if (b.lat === undefined || b.lng === undefined) return { lat: prev.lat, lng: prev.lng };
  const la = +b.lat, ln = +b.lng;
  if (!isFinite(la) || !isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) return { lat: prev.lat, lng: prev.lng };
  return { lat: la, lng: ln };
}
function activeTravel(me) { return (me && me.travel && me.travel.until > Date.now()) ? me.travel : null; }
function publicProfile(u, viewer) {
  const me = u.me, unlocked = !!(viewer.unlocked && viewer.unlocked[u.id]);
  const tr = activeTravel(me);
  const dist = (!tr && me.dist !== false && viewer && viewer.me && validLoc(viewer.me.lat, viewer.me.lng) && validLoc(me.lat, me.lng)) ? haversineKm(viewer.me.lat, viewer.me.lng, me.lat, me.lng) : null;
  return { id: u.id, name: me.name, username: me.username || '', age: me.age, height: me.height || 0, country: tr ? tr.country : (me.country || ''), state: tr ? (tr.state || me.state || '') : (me.state || ''), city: tr ? tr.city : me.city, job: me.job, edu: me.edu || '', marital: me.marital || '', children: me.children || '', smoke: me.smoke || '', drink: me.drink || '', g: me.g, intent: me.intent, prayer: me.prayer, langs: me.langs || '', about: me.about, q: me.q || [], int: me.int || [],
    nationality: me.nationality || '', grewUp: me.grewUp || '', sect: me.sect || '', ethnicity: me.ethnicity || '', marriagePlans: me.marriagePlans || '', relocationPlans: me.relocationPlans || '', familyPlans: me.familyPlans || '', dress: me.dress || '', diet: me.diet || '', faith: me.faith || [], personality: me.personality || [], polygamy: me.polygamy || '', parents: me.parents || '', top3: me.top3 || '',
    joined: u.createdAt || 0, gold: isGold(u), filters: (viewer && isGold(viewer)) ? (me.myFilters || null) : null, seen: u.seen || 0, bornMuslim: (me.bornMuslim === true || me.bornMuslim === false) ? me.bornMuslim : null,
    ver: u.ver === 2, priv: !!me.blur, photos: (!me.blur || unlocked) ? (me.photos || []) : [], dist: dist, online: Date.now() - (u.seen || 0) < 120000, boosted: isBoosted(u) };
}
function ownMe(u) { const o = Object.assign({}, u.me, { id: u.id, contact: u.contact, ver: u.ver, gold: isGold(u), done: true, joined: u.createdAt || 0 }); delete o.lat; delete o.lng; o.loc = validLoc(u.me.lat, u.me.lng); o.limits = limitsView(u); return o; }
function stateFor(u) {
  const matches = {}; for (const k of matchesOf(u.id)) { const m = db.matches[k], o = otherOf(k, u.id); matches[o] = { t: m.t, unread: m.msgs.filter(x => x.from !== u.id && !x.readAt).length, msgs: m.msgs.map(x => viewMsg(x, u.id)) }; }
  const acted = {}; for (const k in u.reacts) acted[k] = u.reacts[k];
  const blockedUsers = Object.keys(u.blocked || {}).map(k => { const b = db.users[+k]; return b ? { id: b.id, name: (b.me && b.me.name) || '' } : null; }).filter(Boolean);
  return { matches, blocked: u.blocked, blockedUsers, acted, unlocked: u.unlocked || {}, notifs: [], limits: limitsView(u) };
}
const MEDIA_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
const EXT_TYPE = { jpg: 'image/jpeg', png: 'image/png', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
function saveDataUrl(dataUrl, maxBytes, allowed) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[^,;]*)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || !MEDIA_EXT[m[1]] || (allowed && !m[1].startsWith(allowed))) return null;
  const buf = Buffer.from(m[2], 'base64'); if (!buf.length || buf.length > maxBytes) return null;
  const name = crypto.randomBytes(16).toString('hex') + '.' + MEDIA_EXT[m[1]];
  fs.writeFileSync(path.join(UPLOADS, name), buf); return name;
}
const mediaUrl = n => PUBLIC_URL + '/media/' + n;

/* ---------- Supabase Storage photos (bucket: hamdam-photos, public read) ----------
   Profile + chat photos are uploaded by the client straight to Storage
   (PUT {SB_URL}/storage/v1/object/hamdam-photos/<name>, anon key) and then
   registered here via POST /api/media-url, which records the public URL in
   u.media so PUT /api/me and POST /api/messages accept it (both already
   gate on u.media.includes(x) — no change needed there). The anon key is
   public by design; the bucket policies govern access (see
   supabase-storage-photos.sql). /media on local disk stays as a fallback
   for already-uploaded files and for voice audio, which is out of scope. */
const SB_BUCKET = 'hamdam-photos';
const storagePublicPrefix = () => SB_URL + '/storage/v1/object/public/' + SB_BUCKET + '/';
function isStoragePhotoUrl(x) {
  if (typeof x !== 'string' || !SB_URL) return false;
  if (!x.startsWith(storagePublicPrefix())) return false;
  const rest = x.slice(storagePublicPrefix().length);
  return rest.length > 0 && rest.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/.test(rest) && !rest.includes('..') && /\.(jpg|jpeg|png|webp)$/i.test(rest);
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, opts, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });

/* ---------- OTP via Supabase Auth (production) ----------
   Supabase Auth sends the 8-digit code by e-mail and owns verification.
   The code is never generated, stored, logged or returned by this server.
   NOTE: Supabase's built-in e-mail only delivers to project team members
   (2/hour). For real users, configure a custom SMTP server in the Supabase
   dashboard (Authentication -> SMTP Settings) — e.g. Gmail with an app
   password — otherwise users never receive their code. */
async function sendOtpEmail(contact) {
  let r;
  try {
    r = await fetch(SB_URL + '/auth/v1/otp', {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: contact, create_user: true }),
    });
  } catch (e) { throw new Error('supabase otp send failed: ' + e.message); }
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('supabase otp send failed: HTTP ' + r.status + ' ' + t.slice(0, 200)); }
}
async function verifyOtpEmail(contact, code) {
  let r;
  try {
    r = await fetch(SB_URL + '/auth/v1/verify', {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: contact, token: code, type: 'email' }),
    });
  } catch (e) { throw new Error('supabase otp verify failed: ' + e.message); }
  return r.ok;
}

/* ---------- Google OAuth sign-in ----------
   The app redirects the user to Supabase's Google authorize URL; Supabase
   returns to the app with a Supabase access_token in the URL hash. The app
   POSTs that token here; we validate it against Supabase Auth (GET
   /auth/v1/user) and, on success, sign the user into the Hamdam app with the
   exact same find-or-create + session logic as the OTP verify route. The
   Google Client Secret is never used here — it lives only in Supabase. */
function sessionForContact(contact) {
  let u = Object.values(db.users).find(x => x.contact === contact);
  if (!u) { u = db.users[db.seq] = { id: db.seq++, contact, me: null, ver: 0, gold: false, blocked: {}, reacts: {}, hist: [], unlocked: {}, media: [], createdAt: Date.now(), compliments: {}, reactAt: {}, visits: {} }; }
  const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = u.id; save();
  return token;
}
async function supabaseUserByToken(token) {
  let r;
  try {
    r = await fetch(SB_URL + '/auth/v1/user', {
      signal: AbortSignal.timeout(15000),
      method: 'GET',
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token },
    });
  } catch (e) { throw new Error('supabase user lookup failed: ' + e.message); }
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const email = j && typeof j.email === 'string' ? j.email.trim() : '';
  return email || null;
}

route('POST', '/api/auth/start', { anon: true }, async (c) => {
  const contact = S(c.body.contact, 120).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(contact)) return c.err(400, 'bad_contact');
  if (!rate('otp:' + contact, 5, 3600000) || !rate('otpip:' + c.ip, 30, 3600000)) return c.err(429, 'rate_limited');
  if (USE_SB) {
    if (!SB_ANON) return c.err(500, 'server_error');   // SUPABASE_ANON_KEY required for Auth OTP
    try { await sendOtpEmail(contact); } catch (e) { console.error('otp send failed for', contact + ':', e.message); return c.err(500, 'server_error'); }
    return c.json(200, { ok: true });
  }
  const code = String(10000000 + crypto.randomInt(90000000));   // 8 digits, matching Supabase Auth OTP length
  otps[contact] = { code, exp: Date.now() + 600000, tries: 0 };
  c.json(200, DEV_OTP ? { ok: true, devCode: code } : { ok: true });   // DEV_OTP=1 only, local dev
});
route('POST', '/api/auth/verify', { anon: true }, async (c) => {
  const contact = S(c.body.contact, 120).toLowerCase();
  if (!rate('verifyip:' + c.ip, 40, 3600000)) return c.err(429, 'rate_limited');
  if (USE_SB) {
    let ok = false;
    try { ok = await verifyOtpEmail(contact, S(c.body.code, 8)); } catch (e) { console.error('otp verify failed for', contact + ':', e.message); return c.err(500, 'server_error'); }
    if (!ok) return c.err(400, 'bad_code');
  } else {
    const o = otps[contact];
    if (!o || o.exp < Date.now() || ++o.tries > 5) return c.err(400, 'bad_code');
    if (S(c.body.code, 8) !== o.code) return c.err(400, 'bad_code');
    delete otps[contact];
  }
  c.json(200, { token: sessionForContact(contact) });
});
route('POST', '/api/auth/oauth', { anon: true }, async (c) => {
  if (!rate('oauthip:' + c.ip, 40, 3600000)) return c.err(429, 'rate_limited');
  const token = String(c.body.token || '').trim();
  if (!token) return c.err(400, 'bad_token');
  if (!SB_URL || !SB_ANON) return c.err(500, 'server_error');   // Supabase Auth not configured
  let email = null;
  try { email = await supabaseUserByToken(token); } catch (e) { console.error('oauth user lookup failed:', e.message); return c.err(500, 'server_error'); }
  if (!email) return c.err(401, 'bad_token');
  c.json(200, { token: sessionForContact(email.toLowerCase()) });
});
route('POST', '/api/logout', {}, (c) => { delete db.sessions[c.token]; save(); c.json(200, { ok: true }); });

route('GET', '/api/me', {}, (c) => {
  const u = c.user, q = db.events[u.id] || [];
  const compliments = Object.values(db.users).filter(x => x.compliments && x.compliments[u.id]).length;
  c.json(200, { me: hasProfile(u) ? ownMe(u) : null, state: stateFor(u), cursor: q.length ? q[q.length - 1].id : 0, compliments });
});
route('PUT', '/api/me', {}, (c) => {
  const b = c.body, u = c.user, age = Math.floor(+b.age);
  if (!(age >= 18 && age <= 90)) return c.err(400, 'age_invalid');
  const prev = u.me || {};
  var travel = (prev.travel && typeof prev.travel === 'object') ? prev.travel : null;
  if (b.travel !== undefined) {
    if (b.travel === null) travel = null;
    else if (b.travel && typeof b.travel === 'object') {
      var tc = S(b.travel.city, 40), tco = S(b.travel.country, 40), tst = S(b.travel.state, 40), tu = +b.travel.until;
      if (!isFinite(tu)) return c.err(400, 'travel_invalid');
      if (tu <= Date.now()) travel = null;
      else {
        if (!tc || !tco || tu > Date.now() + 25 * 3600000) return c.err(400, 'travel_invalid');
        travel = { city: tc, country: tco, state: tst, until: tu };
      }
    } else return c.err(400, 'travel_invalid');
  }
  const loc = parseLoc(b, prev);
  const photos = (Array.isArray(b.photos) ? b.photos : []).filter(x => u.media.includes(x)).slice(0, 3);
  const username = (b.username || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 20);
  if (username && !/[a-z0-9]/.test(username)) return c.err(400, 'bad_username'); // a username needs at least one letter or number
  if (username && username !== (prev.username || '') && Object.values(db.users).some(x => x.id !== u.id && x.me && x.me.username === username)) return c.err(400, 'username_taken');
  u.me = {
    name: S(b.name, 24) || 'You', username: username, age, country: S(b.country, 40), state: S(b.state, 40), city: S(b.city, 40), job: S(b.job, 30), edu: S(b.edu, 40),
    marital: ['single', 'divorced', 'widowed'].includes(b.marital) ? b.marital : '', children: ['none', 'have', 'want'].includes(b.children) ? b.children : '',
    height: Math.max(0, Math.min(250, Math.floor(+b.height) || prev.height || 0)),
    smoke: ['no', 'sometimes', 'yes'].includes(b.smoke) ? b.smoke : '', drink: ['no', 'sometimes', 'yes'].includes(b.drink) ? b.drink : '',
    about: S(b.about, 140), g: b.g === 'f' ? 'f' : 'm',
    intent: ['marriage', 'friends', 'both'].includes(b.intent) ? b.intent : 'both', prayer: ['a', 's', 't'].includes(b.prayer) ? b.prayer : 'a',
    int: (Array.isArray(b.int) ? b.int : []).map(x => S(x, 20)).slice(0, 10), langs: S(b.langs, 120),
    nationality: S(b.nationality, 40), grewUp: S(b.grewUp, 40), sect: S(b.sect, 40), ethnicity: S(b.ethnicity, 40),
    marriagePlans: ['soon', 'year', 'two', 'unsure'].includes(b.marriagePlans) ? b.marriagePlans : '', relocationPlans: ['open', 'global', 'no', 'unsure'].includes(b.relocationPlans) ? b.relocationPlans : '', familyPlans: ['want', 'notwant', 'unsure', 'have'].includes(b.familyPlans) ? b.familyPlans : '',
    dress: S(b.dress, 20), diet: ['halal', 'veg', 'vegan', 'any'].includes(b.diet) ? b.diet : '',
    faith: (Array.isArray(b.faith) ? b.faith : []).map(x => S(x, 30)).slice(0, 12), personality: (Array.isArray(b.personality) ? b.personality : []).map(x => S(x, 20)).slice(0, 12),
    polygamy: ['no', 'open', 'unsure'].includes(b.polygamy) ? b.polygamy : '', parents: S(b.parents, 80), top3: S(b.top3, 120),
    bornMuslim: b.bornMuslim === true ? true : b.bornMuslim === false ? false : (prev.bornMuslim === true || prev.bornMuslim === false ? prev.bornMuslim : null),
    q: Array.isArray(b.q) ? b.q.filter(function (x) { return Array.isArray(x) && x[0] && x[1]; }).map(function (x) { return [S(x[0], 60), S(x[1], 120)]; }).filter(function (x) { return x[0] && x[1]; }).slice(0, 5) : (Array.isArray(prev.q) ? prev.q : []),
    myFilters: (() => { const mf = b.myFilters; if (mf === undefined) return prev.myFilters || null; if (!mf || typeof mf !== 'object') return null; const pick = (src, keys) => { const o = {}; for (const k of keys) if (src[k] !== undefined) o[k] = src[k]; return o; }; return { f: pick(mf.f || {}, ['min', 'max', 'country', 'state', 'city', 'nationality', 'hmin', 'hmax', 'marital', 'children', 'grewUp', 'lang', 'edu', 'profession', 'int', 'marriagePlans', 'relocationPlans', 'familyPlans', 'prayer', 'dress', 'diet', 'smoke', 'drink', 'sect', 'ethnicity']), fg: pick(mf.fg || {}, ['liked', 'bio', 'online', 'goldMember', 'justJoined', 'priv', 'ver', 'born']), fmode: mf.fmode === 'gold' ? 'gold' : 'simple' }; })(),
    goldUntil: prev.goldUntil || 0, boostUntil: prev.boostUntil || 0, limits: normLimits(prev.limits), travel: travel, blur: !!b.blur, womenFirst: !!b.womenFirst, incog: !!b.incog, dist: b.dist !== false, theme: ['dark', 'light'].includes(b.theme) ? b.theme : '', lang: b.lang === 'en' ? 'en' : 'ps', photos
  };
  if (loc.lat == null) { delete u.me.lat; delete u.me.lng; } else { u.me.lat = loc.lat; u.me.lng = loc.lng; }
  save(); c.json(200, { me: ownMe(u) });
});
route('DELETE', '/api/me', {}, (c) => {
  const id = c.user.id;
  matchesOf(id).forEach(k => delete db.matches[k]); delete db.users[id]; delete db.events[id];
  for (const t in db.sessions) if (db.sessions[t] === id) delete db.sessions[t];
  save(); c.json(200, { ok: true });
});

route('GET', '/api/profiles', {}, (c) => {
  const u = c.user; if (!hasProfile(u)) return c.json(200, { profiles: [] });
  const want = u.me.g === 'm' ? 'f' : 'm', out = [];
  for (const o of Object.values(db.users)) {
    if (o.id === u.id || !hasProfile(o) || o.me.g !== want || isBlocked(u.id, o.id)) continue;
    const likedMe = o.reacts[u.id] === 'like' || o.reacts[u.id] === 'super';
    if (o.me.incog && !likedMe) continue;
    out.push(publicProfile(o, u));
  }
  out.sort(function (a, b) { return (b.boosted ? 1 : 0) - (a.boosted ? 1 : 0); });
  c.json(200, { profiles: out.slice(0, 200) });
});
route('GET', '/api/likes-you', {}, (c) => {
  const u = c.user; if (!isGold(u)) return c.json(200, { ids: [] }); const ids = []; // free users get an empty list (the live app has no 403 handler here — a 403 breaks its boot)
  for (const o of Object.values(db.users)) { if (o.id !== u.id && hasProfile(o) && !isBlocked(u.id, o.id) && (o.reacts[u.id] === 'like' || o.reacts[u.id] === 'super') && !u.reacts[o.id]) ids.push({ id: o.id, t: (o.reactAt && o.reactAt[u.id]) || 0 }); }
  c.json(200, { ids });
});
route('POST', '/api/react', {}, (c) => {
  const u = c.user, id = +c.body.id, kind = c.body.kind, o = db.users[id];
  if (!hasProfile(u)) return c.err(400, 'no_profile');
  if (!['like', 'pass', 'super'].includes(kind) || !hasProfile(o) || o.id === u.id || o.me.g === u.me.g || isBlocked(u.id, id)) return c.err(400, 'blocked');
  if (!rate('react:' + u.id, 300, 3600000)) return c.err(429, 'rate_limited');
  const compliment = S(c.body.compliment, 120);
  const limitBlock = consumeLimits(u, kind !== 'pass', !!(compliment && kind !== 'pass'));
  if (limitBlock) return c.json(403, { error: 'limit_reached', kind: limitBlock.kind, resetAt: limitBlock.resetAt });
  u.reacts[id] = kind; u.hist.push(id); u.reactAt = u.reactAt || {}; u.reactAt[id] = Date.now();
  if (compliment && kind !== 'pass') { u.compliments = u.compliments || {}; u.compliments[id] = { text: compliment, t: Date.now() }; }
  let match = false, matchMsgs = null;
  if (kind !== 'pass') {
    if (o.reacts[u.id] === 'like' || o.reacts[u.id] === 'super') {
      const k = mkey(u.id, id); if (!db.matches[k]) db.matches[k] = { t: Date.now(), msgs: [] };
      const pushComp = (fromId, text) => {
        if (!text) return;
        // Women-first: a man's compliment must not become the first message while the woman has womenFirst and has not spoken yet — it is held and delivered after her first message (see /api/messages).
        const from = db.users[fromId], other = db.users[fromId === u.id ? id : u.id];
        if (from && from.me.g === 'm' && other && other.me.g === 'f' && other.me.womenFirst && !db.matches[k].msgs.some(x => x.from === other.id)) return;
        if (!db.matches[k].msgs.some(x => x.text === text && x.from === fromId)) db.matches[k].msgs.push({ from: fromId, t: Date.now(), text });
      };
      if (o.compliments && o.compliments[u.id]) pushComp(o.id, o.compliments[u.id].text);
      pushComp(u.id, compliment);
      match = true; matchMsgs = db.matches[k].msgs.map(x => viewMsg(x, u.id)); emit(id, { type: 'match', from: u.id, compliment: compliment || '' });
    } else {
      emit(id, { type: 'like', from: u.id });
    }
  }
  save(); c.json(200, { match, msgs: matchMsgs, limits: limitsView(u) });
});
route('POST', '/api/visit', {}, (c) => {
  const u = c.user, id = +c.body.id, o = db.users[id];
  if (!hasProfile(u) || !hasProfile(o) || o.id === u.id || isBlocked(u.id, id) || u.me.incog) return c.json(200, { ok: true });
  o.visits = o.visits || {}; o.visits[u.id] = Date.now(); save(); c.json(200, { ok: true });
});
route('GET', '/api/visits', {}, (c) => {
  const u = c.user, out = [], now = Date.now();
  for (const k in (u.visits || {})) { const t = u.visits[k]; if (now - t > 30 * 86400000) { delete u.visits[k]; continue; } const v = db.users[+k]; if (v && hasProfile(v) && !isBlocked(u.id, v.id)) out.push({ id: v.id, t }); }
  out.sort((a, b) => b.t - a.t); c.json(200, out);
});
route('POST', '/api/reset-history', {}, (c) => {
  const u = c.user; u.reacts = {}; u.hist = []; save(); c.json(200, { ok: true });
});
route('POST', '/api/undo', {}, (c) => {
  const u = c.user; if (!isGold(u)) return c.err(403, 'not_gold');
  const id = u.hist.pop(); if (!id) return c.json(200, { id: 0 });
  delete u.reacts[id]; const k = mkey(u.id, id), m = db.matches[k]; if (m && !m.msgs.length) delete db.matches[k];
  save(); c.json(200, { id });
});

route('POST', '/api/messages', {}, (c) => {
  const u = c.user, to = +c.body.to, k = mkey(u.id, to), m = db.matches[k], o = db.users[to];
  if (!m || !o || isBlocked(u.id, to)) return c.err(403, 'not_matched');
  if (!rate('msg:' + u.id, 60, 60000)) return c.err(429, 'rate_limited');
  const first = !m.msgs.some(x => x.from === u.id);
  if (first && activeChats(u.id) >= (isGold(u) ? 10 : 5)) return c.err(403, 'chat_limit');
  if (first && o.me.g === 'f' && o.me.womenFirst && !m.msgs.some(x => x.from === to)) return c.err(403, 'women_first');
  if (!m.msgs.length && Date.now() - m.t > 48 * 3600000) return c.err(403, 'match_expired'); // the first message must go within 48h of matching
  const cid = typeof c.body.cid === 'string' ? c.body.cid.slice(0, 64) : '';
  if (cid) { const dup = m.msgs.find(x => x.cid === cid && x.from === u.id); if (dup) return c.json(200, { msg: { t: dup.t }, dup: true }); } // retry after a lost response — do not store twice
  const msg = { from: u.id, t: Date.now() };
  if (cid) msg.cid = cid;
  if (c.body.text) msg.text = S(c.body.text, 2000);
  else if (c.body.img && u.media.includes(c.body.img)) msg.img = c.body.img;
  else if (c.body.audio && u.media.includes(c.body.audio)) { msg.audio = c.body.audio; msg.dur = Math.min(600, Math.max(1, +c.body.dur || 1)); }
  else return c.err(400, 'empty');
  m.msgs.push(msg);
  let held = null;
  if (first && u.me.g === 'f') { const him = db.users[to]; if (him && him.compliments && him.compliments[u.id]) { const ct = him.compliments[u.id].text; if (ct && !m.msgs.some(x => x.text === ct && x.from === to)) { held = { from: to, t: Date.now(), text: ct }; m.msgs.push(held); } } } // a compliment held by women-first is delivered after her first message, so hers stays first
  emit(to, { type: 'message', from: u.id, msg: viewMsg(msg, to) }); save();
  c.json(200, { msg: { t: msg.t }, held: held ? { text: held.text, t: held.t } : null });
});
route('POST', '/api/typing', {}, (c) => {
  const u = c.user, to = +c.body.to, o = db.users[to];
  if (!o || !db.matches[mkey(u.id, to)] || isBlocked(u.id, to)) return c.json(200, { ok: true });
  if (!rate('typing:' + u.id, 20, 60000)) return c.err(429, 'rate_limited');
  emit(to, { type: 'typing', from: u.id });
  c.json(200, { ok: true });
});
route('POST', '/api/call/signal', {}, (c) => {
  const u = c.user, to = +c.body.to, kind = String(c.body.kind || '');
  if (!['offer', 'answer', 'ice', 'end'].includes(kind)) return c.err(400, 'bad_kind');
  const o = db.users[to];
  if (!o || !db.matches[mkey(u.id, to)] || isBlocked(u.id, to)) return c.err(403, 'not_matched');
  if (!rate('call:' + u.id, 120, 60000)) return c.err(429, 'rate_limited');
  let payload = null;
  if (kind === 'offer' || kind === 'answer') {
    const p = c.body.payload || {};
    if (typeof p !== 'object' || typeof p.sdp !== 'string' || !p.sdp) return c.err(400, 'bad_payload');
    payload = { sdp: S(p.sdp, 8000), type: kind === 'offer' ? 'offer' : 'answer' };
  } else if (kind === 'ice') {
    const p = c.body.payload || {};
    if (typeof p !== 'object' || typeof p.candidate !== 'string' || !p.candidate) return c.err(400, 'bad_payload');
    payload = { candidate: S(p.candidate, 2000), sdpMid: S(p.sdpMid, 64), sdpMLineIndex: Math.max(0, Math.min(99, +p.sdpMLineIndex || 0)) };
  }
  emit(to, { type: 'call', from: u.id, kind, payload });
  c.json(200, { ok: true });
});
route('POST', '/api/matches/:id/read', {}, (c) => {
  const u = c.user, id = +c.params.id, m = db.matches[mkey(u.id, id)]; if (!m) return c.json(200, { ok: true });
  let ch = false; m.msgs.forEach(x => { if (x.from !== u.id && !x.readAt) { x.readAt = Date.now(); ch = true; } });
  if (ch) { emit(id, { type: 'read', from: u.id }); save(); } c.json(200, { ok: true });
});
route('POST', '/api/media', {}, (c) => {
  const photo = c.body.kind === 'photo';
  if (!rate('media:' + c.user.id, 60, 3600000)) return c.err(429, 'rate_limited');
  const name = saveDataUrl(c.body.dataUrl, photo ? 2e6 : 6e6, photo ? 'image/' : null); if (!name) return c.err(400, 'bad_media');
  const url = mediaUrl(name); c.user.media.push(url); save(); c.json(200, { url });
});
route('POST', '/api/media-url', {}, (c) => {
  if (!rate('media-url:' + c.user.id, 60, 3600000)) return c.err(429, 'rate_limited');
  const url = c.body.url;
  if (!isStoragePhotoUrl(url)) return c.err(400, 'bad_media');
  if (!c.user.media.includes(url)) c.user.media.push(url);
  save(); c.json(200, { url });
});

route('POST', '/api/unmatch', {}, (c) => { delete db.matches[mkey(c.user.id, +c.body.id)]; save(); c.json(200, { ok: true }); });
route('POST', '/api/block', {}, (c) => { const id = +c.body.id; if (db.users[id]) { c.user.blocked[id] = 1; delete db.matches[mkey(c.user.id, id)]; save(); } c.json(200, { ok: true }); });
route('POST', '/api/unblock', {}, (c) => { delete c.user.blocked[+c.body.id]; save(); c.json(200, { ok: true }); });
route('POST', '/api/report', {}, (c) => {
  const id = +c.body.id; if (!db.users[id]) return c.err(400, 'blocked');
  const m = db.matches[mkey(c.user.id, id)];
  db.reports.push({ id: db.reports.length + 1, t: Date.now(), by: c.user.id, about: id, reason: S(c.body.reason, 80), context: m ? m.msgs.slice(-20) : [], status: 'open' });
  save(); c.json(200, { ok: true });
});
route('POST', '/api/report-problem', {}, (c) => {
  const text = S(c.body.text, 1000);
  if (!text) return c.err(400, 'empty');
  if (!rate('report-problem:' + c.user.id, 5, 3600000)) return c.err(429, 'rate_limited');
  const cat = ['login', 'profile', 'chat', 'gold', 'other'].includes(c.body.category) ? c.body.category : 'other';
  // Problem report: no "about" user. reports.about is NOT NULL (see
  // supabase-schema.sql), so store about: 0 and mark the reason; the
  // category also rides in context for the admin page.
  db.reports.push({ id: db.reports.length + 1, t: Date.now(), by: c.user.id, about: 0, reason: '[problem] [' + cat + '] ' + text, context: [{ type: 'problem', category: cat }], status: 'open' });
  save(); c.json(200, { ok: true });
});

route('POST', '/api/photo-request', {}, (c) => {
  const u = c.user, id = +c.body.id;
  if (!db.matches[mkey(u.id, id)] || isBlocked(u.id, id)) return c.json(200, { status: 'no_match' });   // only matches can unlock — no dead-end request
  u.unlocked[id] = 1; save(); c.json(200, { status: 'approved' });
});
route('POST', '/api/verify', {}, (c) => {
  let selfie = null;
  if (typeof c.body.selfie === 'string' && isStoragePhotoUrl(c.body.selfie)) selfie = c.body.selfie; // Storage URL (preferred — survives restarts)
  else { const name = saveDataUrl(c.body.selfie, 4e6, 'image/'); if (!name) return c.err(400, 'bad_media'); selfie = name; } // legacy disk upload
  c.user.ver = 1; c.user.selfie = selfie; save(); emit(c.user.id, { type: 'verify', status: 'pending' });
  c.json(200, { status: 'pending' });
});
route('POST', '/api/boost', {}, (c) => {
  const u = c.user;
  if (!isGold(u)) return c.err(403, 'not_gold');
  const now = Date.now();
  if (u.me.boostUntil && u.me.boostUntil > now) return c.json(200, { ok: true, until: u.me.boostUntil, active: true }); // already boosted — keep the existing end time, do not extend
  u.me.boostUntil = now + 3 * 3600000; save();
  c.json(200, { ok: true, until: u.me.boostUntil });
});
route('POST', '/api/checkout', {}, async (c) => {
  if (DEV_GOLD) { c.user.gold = true; save(); return c.json(200, { ok: true, trial: true }); }
  if (!HESABPAY_KEY) return c.json(200, { ok: false, error: 'billing_not_configured' });
  if (!rate('checkout:' + c.user.id, 5, 3600000)) return c.err(429, 'rate_limited');
  const u = c.user;
  if (isGold(u)) return c.json(200, { ok: true, active: true });   // already Gold — nothing to buy
  const _now = Date.now(); for (const _oid in db.goldOrders) { const _o = db.goldOrders[_oid]; if (_o.uid === u.id && _o.status === 'pending' && _o.url && _now - _o.created < 30 * 60000) return c.json(200, { ok: true, url: _o.url, order: _oid, afn: _o.afn, reused: true }); } // a double-tap reuses the pending session, it never creates a second one
  const afn = Math.max(1, Math.round(GOLD_PRICE_USD * await afnRate()));
  const orderId = 'gold-' + u.id + '-' + crypto.randomBytes(4).toString('hex');
  const email = (u.contact || '').indexOf('@') >= 0 ? u.contact : '';
  const payload = {
    order_id: orderId,
    items: [{ id: orderId, product_id: 'hamdam-gold-1mo', name: 'Hamdam Gold — 1 month | Qty 1 Pcs', price: afn }],
    email: email,
    callback_url: PUBLIC_URL + '/api/hesabpay/webhook',
    success_url: APP_URL + '/?gold=paid',
    cancel_url: APP_URL + '/?gold=cancelled',
  };
  let res;
  try { res = await hesabpayCreateSession(payload); } catch (e) { console.error('hesabpay create-session failed:', e.message); return c.err(500, 'server_error'); }
  if (!res || typeof res.url !== 'string' || !res.url) return c.err(500, 'server_error');
  db.goldOrders[orderId] = { uid: u.id, afn: afn, usd: GOLD_PRICE_USD, created: Date.now(), status: 'pending', url: res.url };
  save();
  c.json(200, { ok: true, url: res.url, order: orderId, afn: afn });
});
route('POST', '/api/hesabpay/webhook', { anon: true }, async (c) => {
  const d = (c.body && typeof c.body === 'object') ? c.body : {};
  const statusCode = (d.status_code === undefined || d.status_code === null) ? null : parseInt(d.status_code, 10);
  const signature = d.signature ? String(d.signature) : '';
  const timestamp = d.timestamp ? String(d.timestamp) : '';
  const txnId = d.transaction_id ? String(d.transaction_id) : '';
  const success = d.success === true;
  if (statusCode === null || !signature || !timestamp || !txnId) return c.json(400, { error: 'invalid_payload' });
  if (!HESABPAY_KEY) return c.json(500, { error: 'billing_not_configured' });
  let okSig = false;
  try { okSig = await hesabpayVerifySignature(signature, timestamp); } catch (e) { console.error('hesabpay verify failed:', e.message); return c.json(500, { error: 'server_error' }); }
  if (!okSig) return c.json(403, { error: 'invalid_signature' });
  const orderId = d.order_id ? String(d.order_id) : (d.items && d.items[0] && d.items[0].id ? String(d.items[0].id) : '');
  const order = orderId ? db.goldOrders[orderId] : null;
  if (!order) return c.json(404, { error: 'order_not_found' });
  if (order.status === 'paid') return c.json(200, { ok: true, already: true });   // idempotent: duplicate webhooks never re-grant
  if (!(statusCode === 10 && success)) { order.status = 'failed'; save(); return c.json(200, { ok: true, paid: false }); }
  const paidPrice = (d.items && d.items[0] && d.items[0].price !== undefined) ? +d.items[0].price : null;
  if (paidPrice !== null && paidPrice !== order.afn) { order.status = 'amount_mismatch'; save(); return c.json(400, { error: 'amount_mismatch' }); }
  const u = db.users[order.uid];
  if (!u) return c.json(404, { error: 'user_not_found' });
  grantGold(u);
  order.status = 'paid'; order.txn = txnId; order.paidAt = Date.now(); save();
  c.json(200, { ok: true, paid: true });
});
route('GET', '/api/config', { anon: true }, (c) => {
  c.json(200, { supabaseUrl: SB_URL, supabaseAnonKey: SB_ANON, storageBucket: SB_BUCKET, storageConfigured: !!(SB_URL && SB_ANON) });
});
route('GET', '/api/health', { anon: true }, (c) => {
  c.json(200, { ok: true, store: USE_SB ? 'supabase' : 'json', time: Date.now() });
});
route('GET', '/api/events', {}, (c) => {
  const after = +c.query.get('after') || 0, q = db.events[c.user.id] || [];
  c.user.seen = Date.now();
  c.json(200, { events: q.filter(e => e.id > after), cursor: q.length ? q[q.length - 1].id : after });
});

/* admin (X-Admin-Key) — kept for API/script use */
const admin = fn => (c) => (ADMIN_KEY && c.req.headers['x-admin-key'] === ADMIN_KEY) ? fn(c) : c.err(403, 'forbidden');
/* admin (session-based, ADMIN_EMAIL) — the app's Admin page. The client never
   holds an admin key: the signed-in user's contact e-mail must equal
   ADMIN_EMAIL (case-insensitive). If ADMIN_EMAIL is unset, nobody is admin. */
const isAdminUser = u => !!(ADMIN_EMAIL && u && u.contact && String(u.contact).toLowerCase() === ADMIN_EMAIL);
const requireAdmin = fn => (c) => isAdminUser(c.user) ? fn(c) : c.err(403, 'forbidden');
const pendingVerifications = () => Object.values(db.users).filter(u => u.ver === 1).map(u => ({ id: u.id, name: u.me && u.me.name, selfie: u.selfie || null, selfieUrl: u.selfie ? (u.selfie.indexOf('http') === 0 ? u.selfie : mediaUrl(u.selfie)) : null }));
const decideVerification = (id, approve) => { const u = db.users[+id]; if (!u) return null; u.ver = approve ? 2 : 0; emit(u.id, { type: 'verify', status: approve ? 'approved' : 'rejected' }); save(); return u; };
const listAdminUsers = () => Object.values(db.users).map(u => ({ id: u.id, name: u.me && u.me.name, contact: u.contact, age: u.me && u.me.age, gold: isGold(u), ver: u.ver, joined: u.createdAt || 0 }));
const listAdminReports = () => db.reports;
route('GET', '/api/admin/reports', { anon: true }, admin(c => c.json(200, { reports: listAdminReports() })));
route('GET', '/api/admin/verifications', { anon: true }, admin(c => c.json(200, { pending: pendingVerifications() })));
route('POST', '/api/admin/verify', { anon: true }, admin(c => {
  if (!decideVerification(c.body.id, c.body.approve)) return c.err(404, 'bad_code');
  c.json(200, { ok: true });
}));
/* session-based admin panel (auth required, ADMIN_EMAIL check server-side) */
route('GET', '/api/admin/check', {}, (c) => c.json(200, { admin: isAdminUser(c.user) }));
route('GET', '/api/admin/panel/verifications', {}, requireAdmin(c => c.json(200, { pending: pendingVerifications() })));
route('POST', '/api/admin/panel/verify', {}, requireAdmin(c => {
  if (!decideVerification(c.body.id, c.body.approve)) return c.err(404, 'bad_code');
  c.json(200, { ok: true });
}));
route('GET', '/api/admin/panel/users', {}, requireAdmin(c => c.json(200, { users: listAdminUsers() })));
route('GET', '/api/admin/panel/reports', {}, requireAdmin(c => c.json(200, { reports: listAdminReports() })));
route('POST', '/api/admin/panel/report/resolve', {}, requireAdmin(c => {
  const r = db.reports.find(x => x.id === +c.body.id); if (!r) return c.err(404, 'bad_code');
  r.status = 'resolved'; save(); c.json(200, { ok: true });
}));
route('POST', '/api/admin/panel/ban', {}, requireAdmin(c => {
  const id = +c.body.id; if (!db.users[id]) return c.err(404, 'bad_code');
  matchesOf(id).forEach(k => delete db.matches[k]); delete db.users[id];
  for (const t in db.sessions) if (db.sessions[t] === id) delete db.sessions[t]; save(); c.json(200, { ok: true });
}));
route('POST', '/api/admin/ban', { anon: true }, admin(c => {
  const id = +c.body.id; matchesOf(id).forEach(k => delete db.matches[k]); delete db.users[id];
  for (const t in db.sessions) if (db.sessions[t] === id) delete db.sessions[t]; save(); c.json(200, { ok: true });
}));

/* ---------- http ---------- */
const INDEX = path.join(__dirname, 'index.html');
const STATIC = {
  '/manifest.webmanifest': { file: 'manifest.webmanifest', type: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript', cache: 'no-cache', extra: { 'Service-Worker-Allowed': '/' } },
  '/.well-known/assetlinks.json': { file: '.well-known/assetlinks.json', type: 'application/json', cache: 'no-cache' },
};
for (const n of ['icon-192', 'icon-512', 'maskable-512', 'apple-touch-icon']) STATIC['/icons/' + n + '.png'] = { file: 'icons/' + n + '.png', type: 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    let h = fs.readFileSync(INDEX, 'utf8');
    h = h.replace('<title>Hamdam</title>', '<title>Hamdam</title><script>window.HAMDAM_CONFIG={mode:"remote",baseUrl:""}</script>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return res.end(h);
  }
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const f = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, f.file), (e, buf) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, Object.assign({ 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': f.cache || 'public, max-age=86400' }, f.extra || {})); res.end(buf);
    });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    const n = path.basename(url.pathname), ext = n.split('.').pop();
    if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(n) || !EXT_TYPE[ext]) { res.writeHead(404); return res.end(); }
    return fs.readFile(path.join(UPLOADS, n), (e, buf) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, Object.assign({ 'Content-Type': EXT_TYPE[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' }, cors)); res.end(buf); });
  }
  if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  let size = 0; const chunks = [];
  req.on('data', d => { size += d.length; if (size > 9e6) { req.destroy(); } else chunks.push(d); });
  req.on('end', () => {
    let body = {}; if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return err(res, 400, 'bad_json'); } }
    for (const r of routes) {
      if (r.method !== req.method) continue; const m = r.re.exec(url.pathname); if (!m) continue;
      const c = { req, body, ip, query: url.searchParams, params: m.groups || {}, json: (s, b) => json(res, s, b), err: (s, code) => err(res, s, code) };
      if (!r.opts.anon) {
        const h = req.headers.authorization || '', token = h.startsWith('Bearer ') ? h.slice(7) : '', uid = db.sessions[token];
        if (!uid || !db.users[uid]) return err(res, 401, 'unauthorized');
        c.token = token; c.user = db.users[uid]; c.user.seen = Date.now();
      }
      try {
        const out = r.fn(c);
        if (out && typeof out.then === 'function') out.catch(e => { console.error(e); if (!res.writableEnded) err(res, 500, 'server_error'); });
        return out;
      } catch (e) { console.error(e); return err(res, 500, 'server_error'); }
    }
    err(res, 404, 'not_found');
  });
});
if (require.main === module) {
  bootStore().then(() => server.listen(PORT, () => console.log('Hamdam server on ' + PUBLIC_URL + ' (store: ' + (USE_SB ? 'supabase' : 'json') + ')')));
}
module.exports = server;
