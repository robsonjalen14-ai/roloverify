// store.js — tiny json store, no db needed
// purpose: guild configs + verified members + snapshots + activity bus
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'roloverify.db.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { guilds: {}, users: {}, snapshots: {}, apiKeys: {}, activity: [] };
  }
}
function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function getGuild(db, guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      guildId,
      vpnBlock: true,
      altDetection: true,
      requireVerified: true,
      verifySlug: 'verify-' + guildId.slice(-6).toLowerCase(),
      embed: { title: '🔒 Verify For Access To Server!', description: 'Click Verify Now below to link your Discord — your role lands instantly, and you stay restorable forever.', color: '#2D7DFF', buttonLabel: 'Verify Now' },
      logChannelId: null,
      verifyRoleId: null,
      createdAt: Date.now()
    };
    return db.guilds[guildId];
  }
  // one-time facelift: untouched old defaults upgrade to the new gate look
  const g = db.guilds[guildId];
  if (g.embed && g.embed.title === 'Verify to enter' && String(g.embed.description || '').startsWith('Click verify to link')) {
    g.embed.title = '🔒 Verify For Access To Server!';
    g.embed.description = 'Click Verify Now below to link your Discord — your role lands instantly, and you stay restorable forever.';
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

// file-backed session store — logins survive restarts and sleep.
// MemoryStore forgets everything on reboot, which logged people out constantly.
// file: sessions.json next to the db. single-process only, plenty for this desk.
const SESS_PATH = path.join(__dirname, 'sessions.json');
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveSessions(s) {
  try { fs.writeFileSync(SESS_PATH, JSON.stringify(s)); } catch {}
}
class FileStore extends Store {
  constructor() { super(); this.sessions = loadSessions(); this.reap(); }
  reap() {
    const now = Date.now(); let dirty = false;
    for (const sid of Object.keys(this.sessions)) {
      try {
        const exp = this.sessions[sid] && this.sessions[sid].cookie && this.sessions[sid].cookie.expires;
        if (exp && new Date(exp).getTime() < now) { delete this.sessions[sid]; dirty = true; }
      } catch {}
    }
    if (dirty) saveSessions(this.sessions);
  }
  get(sid, cb) { cb(null, this.sessions[sid] || null); }
  set(sid, sess, cb) { this.sessions[sid] = sess; saveSessions(this.sessions); cb && cb(null); }
  destroy(sid, cb) { delete this.sessions[sid]; saveSessions(this.sessions); cb && cb(null); }
  touch(sid, sess, cb) { if (this.sessions[sid]) { this.sessions[sid].cookie = sess.cookie; saveSessions(this.sessions); } cb && cb(null); }
}
module.exports = { DB_PATH, load, save, getGuild, pushActivity, FileStore };
