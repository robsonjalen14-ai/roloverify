// node 20, express 4.19.2, discord.js 14.14.1, express-session 1.18.0, dotenv 16.4.5
// *express-session 1.18.0 — must set saveUninitialized:false or sessions leak file handles*
// *discord.js 14.14.1 — GatewayIntentBits.GuildMembers is privileged, enable in portal or members stay empty*
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { load, save, getGuild, pushActivity } = require('./store');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
  DISCORD_REDIRECT_URI, SESSION_SECRET, PORT = 3000, BASE_URL = `http://localhost:${PORT}`
} = process.env;

// test mode = no real discord app configured. localhost demo login + demo server work end to end.
const TEST_MODE = !DISCORD_CLIENT_ID || DISCORD_CLIENT_ID.startsWith('test_');
const DEMO_GUILD_ID = '111111111111111111';

const app = express();
app.set('trust proxy', 1); // hosting runs behind a proxy — real client ip for vpn checks
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET || 'roloverify-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

let db = load();
const sseClients = new Set();
function broadcastActivity(row) {
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(row)}\n\n`); } catch {}
  }
}
function logActivity(entry) {
  db = load();
  const row = pushActivity(db, entry);
  db = load();
  broadcastActivity(row);
  return row;
}

// ---- helpers ----
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'login required' });
  next();
}
function guildApiKey(guildId) {
  db = load();
  if (!db.apiKeys[guildId]) {
    db.apiKeys[guildId] = 'rv_' + crypto.randomBytes(24).toString('hex');
    save(db);
  }
  return db.apiKeys[guildId];
}
function cleanColor(c) {
  const n = parseInt(String(c || '').replace('#', ''), 16);
  return Number.isFinite(n) && n >= 0 && n <= 0xFFFFFF ? '#' + n.toString(16).padStart(6, '0') : '#5865F2';
}
async function discordFetch(tokenType, accessToken, endpoint, opts = {}) {
  const r = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...opts,
    headers: { Authorization: `${tokenType} ${accessToken}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (!r.ok) throw new Error(`discord ${endpoint} -> ${r.status}`);
  return r.json();
}
// naive vpn/proxy heuristic: datacenter ASN check via ip-api (no key, rate-limited)
// for prod swap to ipinfo/maxmind; this keeps the free plan working
async function vpnCheck(ip) {
  if (!ip || ip.startsWith('127.') || ip === '::1' || ip === '::ffff:127.0.0.1') return { vpn: false, reason: 'local connection, check skipped' };
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=proxy,hosting,mobile,isp,org`);
    const j = await r.json();
    const vpn = !!(j.proxy || j.hosting);
    return { vpn, reason: vpn ? `proxy=${j.proxy} hosting=${j.hosting} ${j.isp}` : `clean connection (${j.isp})`, raw: j };
  } catch (e) { return { vpn: false, reason: 'lookup failed, allowed through: ' + e.message }; }
}
function altScore(newUser, guildVerified) {
  // flags: young account (<14d), no avatar, same ip as another verified user
  const ageDays = (Date.now() - new Date(newUser.createdAt).getTime()) / 86400000;
  let score = 0; const flags = [];
  if (ageDays < 14) { score += 40; flags.push(`young account (${ageDays.toFixed(1)} days old)`); }
  if (!newUser.avatar) { score += 20; flags.push('no avatar'); }
  const sameIp = Object.values(guildVerified).filter(u => u.ip && u.ip === newUser.ip);
  if (sameIp.length > 0) { score += 40; flags.push(`shared network with ${sameIp.length} other member(s)`); }
  return { score, flags, isAlt: score >= 40 };
}

// ---- public client config (safe: id only, never the secret) ----
app.get('/api/public-config', (req, res) => {
  res.json({ clientId: TEST_MODE ? null : DISCORD_CLIENT_ID, testMode: TEST_MODE, baseUrl: BASE_URL });
});

// ---- auth: Login with Discord (OAuth2 code flow) ----
app.get('/auth/discord', (req, res) => {
  if (TEST_MODE) {
    // local demo login — full dashboard testable with zero discord setup
    req.session.user = { id: '999999999999999999', username: 'LocalTester', avatar: null, accessToken: 'demo', demo: true };
    db = load();
    const g = getGuild(db, DEMO_GUILD_ID);
    g.verifySlug = 'demo-verify';
    db.users['999999999999999999'] = { ...(db.users['999999999999999999'] || {}), id: '999999999999999999', username: 'LocalTester', avatar: null, accessToken: 'demo', refreshToken: null, createdAt: new Date().toISOString(), ip: '127.0.0.1' };
    save(db);
    return res.redirect('/dashboard.html');
  }
  const p = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code', scope: 'identify guilds guilds.join'
  });
  res.redirect('https://discord.com/oauth2/authorize?' + p.toString());
});
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).send('Discord login was cancelled. <a href="/">Back home</a>');
    if (!code) return res.status(400).send('Missing login code. <a href="/">Back home</a>');
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI
      })
    }).then(r => r.json());
    if (!tok.access_token) return res.status(400).send('Login failed, please try again. <a href="/">Back home</a>');
    const me = await discordFetch('Bearer', tok.access_token, '/users/@me');
    req.session.user = {
      id: me.id, username: me.username, avatar: me.avatar,
      accessToken: tok.access_token, refreshToken: tok.refresh_token
    };
    // stash token for 1-click restore (guilds.join) — file store demo, use vault in prod
    db = load();
    db.users[me.id] = { ...(db.users[me.id] || {}), id: me.id, username: me.username, avatar: me.avatar, accessToken: tok.access_token, refreshToken: tok.refresh_token, createdAt: me.id ? new Date((BigInt(me.id) >> 22n) + 1420070400000n).toISOString() : new Date().toISOString(), ip: req.ip };
    save(db);
    res.redirect('/dashboard.html');
  } catch (e) { res.status(500).send('Login error: ' + e.message + ' <a href="/">Back home</a>'); }
});
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'no session' });
  res.json({ user: { id: req.session.user.id, username: req.session.user.username, avatar: req.session.user.avatar, demo: !!req.session.user.demo } });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// user guilds (bot must share these; filter where user has MANAGE_GUILD via permissions bit 0x20)
app.get('/api/my-guilds', requireLogin, async (req, res) => {
  try {
    if (req.session.user.demo) return res.json({ guilds: [{ id: DEMO_GUILD_ID, name: 'Demo Server (local test)' }] });
    const guilds = await discordFetch('Bearer', req.session.user.accessToken, '/users/@me/guilds');
    res.json({ guilds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- dashboard config api ----
app.get('/api/guild/:id/config', requireLogin, (req, res) => {
  db = load();
  res.json({ config: getGuild(db, req.params.id) });
  save(db);
});
app.post('/api/guild/:id/config', requireLogin, (req, res) => {
  db = load();
  const g = getGuild(db, req.params.id);
  const { vpnBlock, altDetection, requireVerified, verifySlug, embed, logChannelId, verifyRoleId } = req.body || {};
  if (typeof vpnBlock === 'boolean') g.vpnBlock = vpnBlock;
  if (typeof altDetection === 'boolean') g.altDetection = altDetection;
  if (typeof requireVerified === 'boolean') g.requireVerified = requireVerified;
  if (typeof verifySlug === 'string' && /^[a-z0-9-]{3,40}$/.test(verifySlug)) {
    db = load();
    const taken = Object.values(db.guilds).some(x => x.guildId !== req.params.id && x.verifySlug === verifySlug);
    if (taken) return res.status(400).json({ error: 'that verify link is already taken, pick another' });
    const gg = getGuild(db, req.params.id);
    gg.verifySlug = verifySlug;
    // re-apply the rest onto the fresh copy
    if (typeof vpnBlock === 'boolean') gg.vpnBlock = vpnBlock;
    if (typeof altDetection === 'boolean') gg.altDetection = altDetection;
    if (typeof requireVerified === 'boolean') gg.requireVerified = requireVerified;
    if (embed && typeof embed === 'object') gg.embed = { title: String(embed.title || '').slice(0, 120) || gg.embed.title, description: String(embed.description || '').slice(0, 1000) || gg.embed.description, color: cleanColor(embed.color), buttonLabel: String(embed.buttonLabel || '').slice(0, 40) || gg.embed.buttonLabel };
    if (typeof logChannelId === 'string' || logChannelId === null) gg.logChannelId = logChannelId;
    if (typeof verifyRoleId === 'string' || verifyRoleId === null) gg.verifyRoleId = verifyRoleId;
    save(db);
    logActivity({ kind: 'config', guildId: req.params.id, actor: req.session.user.username, msg: 'config updated' });
    return res.json({ ok: true, config: gg });
  }
  if (embed && typeof embed === 'object') g.embed = { title: String(embed.title || '').slice(0, 120) || g.embed.title, description: String(embed.description || '').slice(0, 1000) || g.embed.description, color: cleanColor(embed.color), buttonLabel: String(embed.buttonLabel || '').slice(0, 40) || g.embed.buttonLabel };
  if (typeof logChannelId === 'string' || logChannelId === null) g.logChannelId = logChannelId;
  if (typeof verifyRoleId === 'string' || verifyRoleId === null) g.verifyRoleId = verifyRoleId;
  save(db);
  logActivity({ kind: 'config', guildId: req.params.id, actor: req.session.user.username, msg: 'config updated' });
  res.json({ ok: true, config: g });
});
app.get('/api/guild/:id/apikey', requireLogin, (req, res) => {
  res.json({ apiKey: guildApiKey(req.params.id) });
});
app.post('/api/guild/:id/rotate-key', requireLogin, (req, res) => {
  db = load();
  db.apiKeys[req.params.id] = 'rv_' + crypto.randomBytes(24).toString('hex');
  save(db);
  res.json({ apiKey: db.apiKeys[req.params.id] });
});

// ---- live activity console (SSE) ----
app.get('/api/guild/:id/activity', requireLogin, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sseClients.add(res);
  db = load();
  const rows = (db.activity || []).filter(a => !req.params.id || a.guildId === req.params.id).slice(0, 50).reverse();
  for (const r of rows) res.write(`data: ${JSON.stringify(r)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ---- member snapshot + 1-click restore ----
app.post('/api/guild/:id/snapshot', requireLogin, (req, res) => {
  db = load();
  getGuild(db, req.params.id); save(db);
  const verified = Object.values(db.users).filter(u => u.guilds && u.guilds[req.params.id]);
  const snapId = 'snap_' + Date.now().toString(36);
  db = load();
  db.snapshots[snapId] = { id: snapId, guildId: req.params.id, at: Date.now(), by: req.session.user.username, members: verified.map(v => ({ id: v.id, username: v.username })) };
  save(db);
  logActivity({ kind: 'snapshot', guildId: req.params.id, actor: req.session.user.username, msg: `snapshot ${snapId} sealed (${verified.length} members)` });
  res.json({ ok: true, snapId, count: verified.length });
});
app.get('/api/guild/:id/snapshots', requireLogin, (req, res) => {
  db = load();
  res.json({ snapshots: Object.values(db.snapshots).filter(s => s.guildId === req.params.id).reverse() });
});
app.post('/api/guild/:id/restore', requireLogin, async (req, res) => {
  // re-adds verified members to a NEW guild via guilds.join (needs user tokens + bot in target guild)
  if (req.session.user.demo) return res.status(400).json({ error: 'demo mode: connect a real Discord app to restore real members' });
  const targetGuildId = (req.body || {}).targetGuildId || req.params.id;
  db = load();
  const snap = Object.values(db.snapshots).filter(s => s.guildId === req.params.id).sort((a, b) => b.at - a.at)[0];
  if (!snap) return res.status(400).json({ error: 'no snapshot yet — take one first' });
  let ok = 0; const failed = [];
  for (const m of snap.members) {
    const u = db.users[m.id];
    if (!u || !u.accessToken || u.accessToken === 'demo') { failed.push(m.id); continue; }
    try {
      const r = await fetch(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${m.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: u.accessToken })
      });
      if (r.status === 201 || r.status === 204) ok++; else failed.push(m.id);
    } catch { failed.push(m.id); }
  }
  logActivity({ kind: 'restore', guildId: targetGuildId, actor: req.session.user.username, msg: `restore ${ok} ok / ${failed.length} failed from ${snap.id}` });
  res.json({ ok: true, restored: ok, failed, from: snap.id });
});

// ---- public verify page (custom URL slug): /v/:slug ----
app.get('/v/:slug', (req, res) => {
  db = load();
  const g = Object.values(db.guilds).find(x => x.verifySlug === req.params.slug);
  if (!g) return res.status(404).send('<!doctype html><html lang="en"><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Unknown verify link</h2><p>This link is expired or mistyped. Ask the server staff for a fresh one.</p><a href="/">Back home</a></body></html>');
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});
app.get('/api/verify/:slug', (req, res) => {
  db = load();
  const g = Object.values(db.guilds).find(x => x.verifySlug === req.params.slug);
  if (!g) return res.status(404).json({ error: 'unknown verify link' });
  res.json({ guildId: g.guildId, embed: g.embed, testMode: TEST_MODE });
});
app.post('/api/verify/:slug', async (req, res) => {
  // body: { code } — discord oauth code from verify page (same client), links account for restore
  // body: { demo:true, username? } — local test mode, no discord needed
  try {
    const { code, demo, username } = req.body || {};
    db = load();
    const g = Object.values(db.guilds).find(x => x.verifySlug === req.params.slug);
    if (!g) return res.status(404).json({ error: 'unknown verify link' });
    if (demo && TEST_MODE) {
      const name = String(username || 'LocalTester').slice(0, 32) || 'LocalTester';
      const id = '9' + String(Math.floor(Math.random() * 1e16)).padStart(16, '0');
      db = load();
      db.users[id] = { id, username: name, avatar: null, accessToken: 'demo', refreshToken: null, createdAt: new Date().toISOString(), ip: req.ip, guilds: { ...(db.users[id] && db.users[id].guilds), [g.guildId]: { at: Date.now(), altScore: 0 } } };
      save(db);
      logActivity({ kind: 'verified', guildId: g.guildId, actor: name, msg: `${name} verified (local demo)` });
      return res.json({ ok: true, userId: id, demo: true, guildId: g.guildId });
    }
    if (!code) return res.status(400).json({ error: 'missing login code, please try again' });
    const tok = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${BASE_URL}/verify-callback.html` })
    }).then(r => r.json());
    if (!tok.access_token) return res.status(400).json({ error: 'verification failed, please try again' });
    const me = await discordFetch('Bearer', tok.access_token, '/users/@me');
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const vpn = g.vpnBlock ? await vpnCheck(ip) : { vpn: false, reason: 'vpn check off' };
    if (g.vpnBlock && vpn.vpn) {
      logActivity({ kind: 'blocked', guildId: g.guildId, actor: me.username, msg: `vpn blocked ${me.username} (${vpn.reason})` });
      return res.status(403).json({ error: 'vpn or proxy detected — turn it off and try again', detail: vpn.reason });
    }
    db = load();
    const prev = db.users[me.id] || {};
    const guildVerified = Object.fromEntries(Object.entries(db.users).filter(([_, u]) => u.guilds && u.guilds[g.guildId]));
    const alt = g.altDetection ? altScore({ createdAt: new Date((BigInt(me.id) >> 22n) + 1420070400000n).toISOString(), avatar: me.avatar, ip }, guildVerified) : { score: 0, flags: [], isAlt: false };
    db.users[me.id] = { ...prev, id: me.id, username: me.username, avatar: me.avatar, accessToken: tok.access_token, refreshToken: tok.refresh_token, createdAt: new Date((BigInt(me.id) >> 22n) + 1420070400000n).toISOString(), ip, guilds: { ...(prev.guilds || {}), [g.guildId]: { at: Date.now(), altScore: alt.score } } };
    save(db);
    logActivity({ kind: alt.isAlt ? 'alt-flag' : 'verified', guildId: g.guildId, actor: me.username, msg: `${me.username} verified${alt.isAlt ? ' FLAGGED alt [' + alt.flags.join(', ') + ']' : ''}` });
    res.json({ ok: true, userId: me.id, alt, guildId: g.guildId });
  } catch (e) { res.status(500).json({ error: 'something went wrong: ' + e.message }); }
});

// ---- developer API (header x-api-key) ----
app.get('/api/v1/:guildId/members', (req, res) => {
  db = load();
  if (db.apiKeys[req.params.guildId] !== req.headers['x-api-key']) return res.status(401).json({ error: 'wrong api key' });
  const members = Object.values(db.users).filter(u => u.guilds && u.guilds[req.params.guildId]);
  res.json({ count: members.length, members: members.map(m => ({ id: m.id, username: m.username, at: m.guilds[req.params.guildId].at })) });
});

app.get('/pricing.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
// local test probe — no auth, proves localhost is up
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'roloverify-local', base: BASE_URL, testMode: TEST_MODE, ts: Date.now() }));
app.listen(PORT, () => console.log(`roloverify local on ${BASE_URL}${TEST_MODE ? ' (test mode: demo login on)' : ''}`));
module.exports = { app, logActivity };
