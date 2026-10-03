// store.js — app state + sessions. two backends, one face.
// local (no DATABASE_URL): json files, exactly like before. zero setup.
// hosting (DATABASE_URL set): postgres — survives redeploys, which wiped the
// json files every push and forgot configs, members, snapshots and logins.
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'roloverify.db.json');

const PG_URL = process.env.DATABASE_URL || '';
let pool = null;
if (PG_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });
    pool.on('error', (e) => console.error('[store] pg pool error:', e.message));
  } catch (e) { console.error('[store] pg load failed, file mode:', e.message); pool = null; }
}

function blank() { return { guilds: {}, users: {}, snapshots: {}, apiKeys: {}, activity: [], blacklist: {} }; }
// blacklist matcher: id, username (any case) or ip. pure, unit-tested.
function isBlacklisted(list, who) {
  const id = String((who && who.id) || '').toLowerCase();
  const name = String((who && who.username) || '').toLowerCase();
  const ip = String((who && who.ip) || '');
  return (list || []).some((e) => {
    const eu = String((e && e.user) || '').toLowerCase();
    const eip = String((e && e.ip) || '');
    return (eu && (eu === id || eu === name)) || (eip && ip && eip === ip);
  });
}
function readFile() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return blank(); }
}
async function pgSetup() {
  await pool.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess JSONB NOT NULL, expire TIMESTAMPTZ)');
}
async function pgRead() {
  try {
    const r = await pool.query('SELECT v FROM kv WHERE k = $1', ['state']);
    if (r.rows.length && r.rows[0].v) return r.rows[0].v;
  } catch (e) { console.error('[store] pg read failed:', e.message); }
  return null;
}
function pgWrite(db) {
  if (!pool) return;
  pool.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', ['state', JSON.stringify(db)])
    .catch((e) => console.error('[store] pg write failed:', e.message));
}

// in-memory mirror: routes stay sync, boot waits for the real read first.
let mem = null;
async function storeReady() {
  if (pool) {
    try { await pgSetup(); } catch (e) { console.error('[store] pg setup failed:', e.message); }
    mem = (await pgRead()) || readFile();
    if (mem && (mem.guilds || mem.users)) pgWrite(mem); // first boot seeds pg from any file
    if (!mem || (!mem.guilds && !mem.users)) mem = blank();
  } else {
    mem = readFile();
  }
  return mem;
}
function load() {
  if (!mem) mem = readFile();
  return mem;
}
function save(db) {
  mem = db;
  if (pool) { pgWrite(db); return; }
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch {}
}
function getGuild(db, guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      guildId,
      vpnBlock: true,
      altDetection: true,
      requireVerified: true,
      verifySlug: 'verify-' + guildId.slice(-6).toLowerCase(),
      embed: { title: 'Verify to get in', description: 'One click with Discord and you are in. Takes about ten seconds.', color: '#2D7DFF', buttonLabel: 'Verify Now' },
      logChannelId: null,
      verifyRoleId: null,
      createdAt: Date.now()
    };
    return db.guilds[guildId];
  }
  // one-time facelift: untouched stock wordings upgrade to the plain version
  const g = db.guilds[guildId];
  const d = String((g.embed && g.embed.description) || '');
  const stockV1 = g.embed && g.embed.title === 'Verify to enter' && d.startsWith('Click verify to link');
  const stockV2 = g.embed && g.embed.title === '🔒 Verify For Access To Server!';
  if (stockV1 || stockV2) {
    g.embed.title = 'Verify to get in';
    g.embed.description = 'One click with Discord and you are in. Takes about ten seconds.';
  }
  if (g.embed && g.embed.color === '#5865F2') g.embed.color = '#2D7DFF';
  return g;
}
function pushActivity(db, entry) {
  const row = { ts: Date.now(), ...entry };
  db.activity.unshift(row);
  db.activity = db.activity.slice(0, 300);
  save(db);
  return row;
}
const { Store } = require('express-session');

// session store — file locally, postgres table on hosting. both survive restarts;
// memory never holds sessions, so nothing evaporates on reboot or sleep.
const SESS_PATH = path.join(__dirname, 'sessions.json');
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveSessions(s) {
  try { fs.writeFileSync(SESS_PATH, JSON.stringify(s)); } catch {}
}
function sessExpire(s) {
  try {
    const exp = s && s.cookie && s.cookie.expires;
    return exp ? new Date(exp).getTime() : null;
  } catch { return null; }
}
class FileStore extends Store {
  constructor() {
    super();
    this.usePg = !!pool;
    if (!this.usePg) { this.sessions = loadSessions(); this.reap(); }
  }
  reap() {
    if (this.usePg) return;
    const now = Date.now(); let dirty = false;
    for (const sid of Object.keys(this.sessions)) {
      try { const e = sessExpire(this.sessions[sid]); if (e && e < now) { delete this.sessions[sid]; dirty = true; } } catch {}
    }
    if (dirty) saveSessions(this.sessions);
  }
  get(sid, cb) {
    if (this.usePg) {
      pool.query('SELECT sess FROM sessions WHERE sid = $1', [sid]).then(
        (r) => cb(null, (r.rows[0] && r.rows[0].sess) || null),
        () => cb(null, null));
      return;
    }
    cb(null, this.sessions[sid] || null);
  }
  set(sid, sess, cb) {
    if (this.usePg) {
      const exp = sessExpire(sess);
      pool.query('INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire',
        [sid, JSON.stringify(sess), exp ? new Date(exp).toISOString() : null]).then(
        () => cb && cb(null), () => cb && cb(null));
      return;
    }
    this.sessions[sid] = sess; saveSessions(this.sessions); cb && cb(null);
  }
  destroy(sid, cb) {
    if (this.usePg) {
      pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(
        () => cb && cb(null), () => cb && cb(null));
      return;
    }
    delete this.sessions[sid]; saveSessions(this.sessions); cb && cb(null);
  }
  touch(sid, sess, cb) {
    if (this.usePg) {
      const exp = sessExpire(sess);
      pool.query('UPDATE sessions SET expire = $2 WHERE sid = $1', [sid, exp ? new Date(exp).toISOString() : null]).then(
        () => cb && cb(null), () => cb && cb(null));
      return;
    }
    if (this.sessions[sid]) { this.sessions[sid].cookie = sess.cookie; saveSessions(this.sessions); } cb && cb(null);
  }
}
module.exports = { DB_PATH, load, save, getGuild, pushActivity, FileStore, storeReady, usingPg: () => !!pool, isBlacklisted };
