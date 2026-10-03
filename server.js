// node 20, express 4.19.2, discord.js 14.14.1, express-session 1.18.0, dotenv 16.4.5
// *express-session 1.18.0 — must set saveUninitialized:false or sessions leak file handles*
// *discord.js 14.14.1 — GatewayIntentBits.GuildMembers is privileged, enable in portal or members stay empty*
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { load, save, getGuild, pushActivity, FileStore } = require('./store');

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
  DISCORD_REDIRECT_URI, SESSION_SECRET, PORT = 3000, BASE_URL = `http://localhost:${PORT}`
} = process.env;

// session salt: persistent value wins. missing on hosting? mint a random one per
// boot — unguessable, so no forgery. only cost: logins expire on restart.
// set a real SESSION_SECRET for sessions that survive redeploys.
let sessionSecret = SESSION_SECRET;
if (!sessionSecret) {
  if (process.env.NODE_ENV === 'production') {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('WARN: SESSION_SECRET missing — temporary salt minted. Set a persistent value for stable logins.');
  } else {
    sessionSecret = 'roloverify-dev';
  }
}

// test mode = no real discord app configured. localhost demo login + demo server work end to end.
const TEST_MODE = !DISCORD_CLIENT_ID || DISCORD_CLIENT_ID.startsWith('test_');
const DEMO_GUILD_ID = '111111111111111111';
// owner override: this discord user id sees EVERY server on their account,
// admin or not. set OWNER_ID in env. everyone else keeps the admin gate.
const OWNER_ID = String(process.env.OWNER_ID || '').trim();
// verify ping: this user gets @mentioned on every log card. blank = silent.
const PING_USER_ID = process.env.PING_USER_ID || '';
function isOwner(req) { return !!OWNER_ID && !!req.session.user && req.session.user.id === OWNER_ID; }

const app = express();
app.set('trust proxy', 1); // hosting runs behind a proxy — real client ip for vpn checks
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: sessionSecret,
  store: new FileStore(),
  resave: false,
  rolling: true,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 }
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
// admin gate: only servers where you hold Manage Server (0x20) open their dashboard.
// purpose: stops members opening another server's config by guessing its id.
// inputs: session token + :id param. outputs: next() or 401/403/500 json.
// guild cache: discord throttles hard (429). fetch once per login, reuse 10 min,
// serve the last good list on 429 instead of dying. inputs: session w/ token.
const GUILD_TTL = 10 * 60 * 1000;
async function myGuilds(req) {
  if (req.session.user.demo) return { guilds: [{ id: DEMO_GUILD_ID, name: 'Demo Server (local test)' }], stale: false };
  const fresh = req.session.guilds && req.session.guildsAt && (Date.now() - req.session.guildsAt < GUILD_TTL);
  if (fresh) {
    const g = req.session.guilds;
    return isOwner(req) ? { guilds: withBotGuilds(g), stale: false } : { guilds: g, stale: false };
  }
  try {
    const guilds = await discordFetch('Bearer', req.session.user.accessToken, '/users/@me/guilds');
    req.session.guilds = guilds; req.session.guildsAt = Date.now();
    return isOwner(req) ? { guilds: withBotGuilds(guilds), stale: false } : { guilds, stale: false };
  } catch (e) {
    if (req.session.guilds && req.session.guilds.length) {
      const g = req.session.guilds;
      return isOwner(req) ? { guilds: withBotGuilds(g), stale: true } : { guilds: g, stale: true };
    }
    throw e;
  }
}
// manager = admin bit OR guild-owner flag. owners rule their servers without
// needing Manage Server ticked — discord says so right on the guild (owner:true).
function canManage(g) { try { if (g.owner === true) return true; const p = BigInt(g.permissions); return (p & 0x20n) !== 0n || (p & 0x8n) !== 0n; } catch { return false; } }
function adminOnly(guilds) { return guilds.filter(canManage); }
// owner merge: every server the bot sits in joins the list, tagged • bot
function withBotGuilds(guilds) {
  const dbx = load();
  const seen = new Set(guilds.map(g => g.id));
  const extra = ((dbx.botGuilds) || []).filter(b => b && b.id && !seen.has(b.id))
    .map(b => ({ id: b.id, name: `${b.name} • bot`, permissions: '0', owner: false, botOnly: true }));
  return guilds.concat(extra);
}
async function requireGuildAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'login required' });
  try {
    if (req.session.user.demo) {
      if (req.params.id !== DEMO_GUILD_ID) return res.status(403).json({ error: 'demo mode: this server is not yours' });
      return next();
    }
    if (isOwner(req)) {
      const { guilds } = await myGuilds(req);
      if (!guilds.some(g => g.id === req.params.id)) return res.status(404).json({ error: 'server not found on your account' });
      return next();
    }
    const { guilds } = await myGuilds(req);
    if (!adminOnly(guilds).some(g => g.id === req.params.id)) return res.status(403).json({ error: 'admin only: you need Manage Server permission on this server' });
    next();
  } catch (e) { res.status(e.status === 429 ? 429 : 500).json({ error: 'could not check your permissions: ' + e.message }); }
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
  if (!r.ok) {
    // 429 carries retry_after — surface real seconds instead of a bare number
    let wait = 0;
    if (r.status === 429) { try { wait = Math.ceil((JSON.parse(await r.text())).retry_after || 5); } catch { wait = 5; } }
    const e = new Error(wait ? `discord rate limit — wait ${wait}s and reload` : `discord ${endpoint} -> ${r.status}`);
    e.status = r.status; e.wait = wait;
    throw e;
  }
  return r.json();
}
// ip intel: country/region/isp/asn come free with the vpn lookup — stored for
// the log embed + members table. no fraud-score vendor here; vpn/alt verdicts instead.
async function vpnCheck(ip) {
  if (!ip || ip.startsWith('127.') || ip === '::1' || ip === '::ffff:127.0.0.1') return { vpn: false, reason: 'local connection, check skipped' };
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,isp,org,as,mobile,proxy,hosting,query`);
    const j = await r.json();
    if (j.status === 'fail') return { vpn: false, reason: 'lookup failed: ' + (j.message || 'unknown') };
    const vpn = !!(j.proxy || j.hosting);
    return { vpn, reason: vpn ? `proxy=${j.proxy} hosting=${j.hosting} ${j.isp}` : `clean connection (${j.isp})`, raw: j };
  } catch (e) { return { vpn: false, reason: 'lookup failed, allowed through: ' + e.message }; }
}
function pickGeo(raw) {
  if (!raw || raw.status === 'fail') return null;
  return { country: raw.country || null, countryCode: raw.countryCode || null, region: raw.regionName || null, city: raw.city || null, isp: raw.isp || null, org: raw.org || null, as: raw.as || null, mobile: !!raw.mobile, proxy: !!raw.proxy, hosting: !!raw.hosting };
}
function ageText(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const d = Math.floor(ms / 86400000);
  if (d < 1) return 'today';
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  if (d < 365) { const m = Math.floor(d / 30); return `${m} month${m === 1 ? '' : 's'} ago`; }
  const y = Math.floor(d / 365); return `${y} year${y === 1 ? '' : 's'} ago`;
}
const FLAG_NAMES = [[1, 'Staff'], [2, 'Partner'], [4, 'HypeSquad Events'], [8, 'Bug Hunter I'], [64, 'House Bravery'], [128, 'House Brilliance'], [256, 'House Balance'], [512, 'Early Supporter'], [16384, 'Bug Hunter II'], [131072, 'Early Verified Bot Dev'], [262144, 'Active Developer']];
function decodeBadges(flags) {
  try { return FLAG_NAMES.filter(([bit]) => (Number(flags) & bit) !== 0).map(([, n]) => n).join(', ') || 'None'; }
  catch { return 'None'; }
}
function parseUA(ua) {
  ua = ua || ''; let b = 'unknown', os = '', m;
  if ((m = ua.match(/Edg\/([\d.]+)/) || ua.match(/Edge\/([\d.]+)/))) b = 'Edge ' + m[1].split('.')[0];
  else if (/OPR\//.test(ua)) b = 'Opera';
  else if (/Chrome\//.test(ua)) b = 'Chrome';
  else if (/Firefox\//.test(ua)) b = 'Firefox';
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) b = 'Safari';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${b} on ${os}` : b;
}
// rich log embed in the discord channel — mirrors the classic verification card.
// fire-and-forget: a dead channel never breaks verification itself.
async function postVerifyEmbed(g, u, alt) {
  if (!g.logChannelId || !DISCORD_BOT_TOKEN || String(DISCORD_BOT_TOKEN).startsWith('test_')) return;
  const fields = [
    { name: '👤 User', value: `<@${u.id}>\n@${u.username}`, inline: false },
    { name: '📬 Email & Contact', value: `Email: ${u.email || 'N/A'}\nEmail verified: ${u.emailVerified === null || u.emailVerified === undefined ? 'N/A' : u.emailVerified}\nID: ${u.id}\nLocale: ${u.locale || 'N/A'}\n2FA enabled: ${u.mfa}`, inline: false },
    { name: '💻 Tech Details', value: `IP Address: ${u.ip || 'N/A'}\nBrowser: ${parseUA(u.ua)}\nRegistered: ${ageText(u.createdAt)}`, inline: false },
    { name: '🌍 Location & Provider', value: u.geo ? `Country: ${u.geo.country || 'N/A'}${u.geo.countryCode ? ` (${u.geo.countryCode})` : ''}\nRegion: ${u.geo.region || 'N/A'}${u.geo.city ? `, ${u.geo.city}` : ''}\nISP: ${u.geo.isp || 'N/A'}${u.geo.as ? ` (${u.geo.as})` : ''}\nConnection Type: ${u.geo.mobile ? 'Mobile' : 'Business/Broadband'}` : 'lookup skipped (local connection or check off)', inline: false },
    { name: '🏅 Badges', value: decodeBadges(u.flags), inline: false }
  ];
  if (alt && alt.isAlt) fields.push({ name: '⚠️ Alt flags', value: alt.flags.join(', ') });
  await fetch(`https://discord.com/api/v10/channels/${g.logChannelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(PING_USER_ID ? { content: `<@${PING_USER_ID}> fresh verification 👀` } : {}), embeds: [{ title: alt && alt.isAlt ? 'Member verified (flagged)' : 'New member verified', color: alt && alt.isAlt ? 0xFF2D4D : 0x2D7DFF, author: { name: 'Rolo Verify' }, thumbnail: u.avatar ? { url: `https://cdn.discord.com/avatars/${u.id}/${u.avatar}.png` } : undefined, fields, footer: { text: 'Rolo Verify • automated check' }, timestamp: new Date().toISOString() }] })
  });
}
// discord snowflake -> account creation iso. BigInt math stays BigInt until the
// final Number() — new Date() throws on a raw BigInt and kills the callback.
function createdFromId(id) {
  try { return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString(); }
  catch { return new Date().toISOString(); }
}
function altScore(newUser, guildVerified) {  // flags: young account (<14d), no avatar, same ip as another verified user
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
// setup check: the EXACT strings discord must hold registered. compare letter for letter.
// nothing secret here — these ride inside authorize urls in the open.
app.get('/api/setup-check', (req, res) => {
  res.json({
    testMode: TEST_MODE,
    clientId: TEST_MODE ? null : DISCORD_CLIENT_ID,
    baseUrl: BASE_URL,
    loginRedirect: TEST_MODE ? null : (DISCORD_REDIRECT_URI || 'MISSING — set DISCORD_REDIRECT_URI'),
    verifyRedirect: TEST_MODE ? null : `${BASE_URL}/verify-callback.html`
  });
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
  // authorize url built byte-exact: %20 scopes, matching the registered link
  const q = `client_id=${encodeURIComponent(DISCORD_CLIENT_ID)}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent('identify guilds guilds.join email')}`;
  res.redirect('https://discord.com/oauth2/authorize?' + q);
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
    // prime the guild cache at login so the dashboard never hammers discord
    try {
      req.session.guilds = await discordFetch('Bearer', tok.access_token, '/users/@me/guilds');
      req.session.guildsAt = Date.now();
    } catch { req.session.guilds = []; req.session.guildsAt = 0; }
    // stash token for 1-click restore (guilds.join) — file store demo, use vault in prod
    db = load();
    db.users[me.id] = { ...(db.users[me.id] || {}), id: me.id, username: me.username, avatar: me.avatar, accessToken: tok.access_token, refreshToken: tok.refresh_token, createdAt: createdFromId(me.id), email: me.email || null, ip: req.ip };
    save(db);
    res.redirect('/dashboard.html');
  } catch (e) { res.status(500).send('Login error: ' + e.message + ' <a href="/">Back home</a>'); }
});
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'no session' });
  res.json({ user: { id: req.session.user.id, username: req.session.user.username, avatar: req.session.user.avatar, demo: !!req.session.user.demo, isOwner: isOwner(req) } });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

// user guilds (bot must share these; filter where user has MANAGE_GUILD via permissions bit 0x20)
app.get('/api/my-guilds', requireLogin, async (req, res) => {
  try {
    const { guilds, stale } = await myGuilds(req);
    res.json({ guilds: (req.session.user.demo || isOwner(req)) ? guilds : adminOnly(guilds), stale });
  } catch (e) { res.status(e.status === 429 ? 429 : 500).json({ error: e.message }); }
});

// ---- dashboard config api ----
app.get('/api/guild/:id/config', requireGuildAdmin, (req, res) => {
  db = load();
  res.json({ config: getGuild(db, req.params.id) });
  save(db);
});
app.post('/api/guild/:id/config', requireGuildAdmin, (req, res) => {
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
app.get('/api/guild/:id/apikey', requireGuildAdmin, (req, res) => {
  res.json({ apiKey: guildApiKey(req.params.id) });
});
app.post('/api/guild/:id/rotate-key', requireGuildAdmin, (req, res) => {
  db = load();
  db.apiKeys[req.params.id] = 'rv_' + crypto.randomBytes(24).toString('hex');
  save(db);
  res.json({ apiKey: db.apiKeys[req.params.id] });
});

// ---- live activity console (SSE) ----
app.get('/api/guild/:id/activity', requireGuildAdmin, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  sseClients.add(res);
  db = load();
  const rows = (db.activity || []).filter(a => !req.params.id || a.guildId === req.params.id).slice(0, 50).reverse();
  for (const r of rows) res.write(`data: ${JSON.stringify(r)}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ---- member snapshot + 1-click restore ----
app.post('/api/guild/:id/snapshot', requireGuildAdmin, (req, res) => {
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
app.get('/api/guild/:id/snapshots', requireGuildAdmin, (req, res) => {
  db = load();
  res.json({ snapshots: Object.values(db.snapshots).filter(s => s.guildId === req.params.id).reverse() });
});
app.post('/api/guild/:id/restore', requireGuildAdmin, async (req, res) => {
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
    const ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const vpn = g.vpnBlock ? await vpnCheck(ip) : { vpn: false, reason: 'vpn check off' };
    if (g.vpnBlock && vpn.vpn) {
      logActivity({ kind: 'blocked', guildId: g.guildId, actor: me.username, msg: `vpn blocked ${me.username} (${vpn.reason}) ip=${ip}` });
      return res.status(403).json({ error: 'vpn or proxy detected — turn it off and try again', detail: vpn.reason });
    }
    db = load();
    const prev = db.users[me.id] || {};
    const guildVerified = Object.fromEntries(Object.entries(db.users).filter(([_, u]) => u.guilds && u.guilds[g.guildId]));
    const alt = g.altDetection ? altScore({ createdAt: createdFromId(me.id), avatar: me.avatar, ip }, guildVerified) : { score: 0, flags: [], isAlt: false };
    db.users[me.id] = { ...prev, id: me.id, username: me.username, avatar: me.avatar, accessToken: tok.access_token, refreshToken: tok.refresh_token, createdAt: createdFromId(me.id), ip, ua, email: me.email || prev.email || null, locale: me.locale || null, mfa: !!me.mfa_enabled, emailVerified: me.verified === true ? true : me.verified === false ? false : null, flags: typeof me.flags === 'number' ? me.flags : 0, geo: pickGeo(vpn.raw), guilds: { ...(prev.guilds || {}), [g.guildId]: { at: Date.now(), altScore: alt.score } } };
    save(db);
    // verified role straight away — bot needs Manage Roles + the role below its own
    let roleMsg = '';
    if (g.verifyRoleId && DISCORD_BOT_TOKEN && !String(DISCORD_BOT_TOKEN).startsWith('test_')) {
      try {
        const rr = await fetch(`https://discord.com/api/v10/guilds/${g.guildId}/members/${me.id}/roles/${g.verifyRoleId}`, {
          method: 'PUT', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
        });
        roleMsg = rr.ok ? ' + role given'
          : rr.status === 403 ? ' (role failed 403: give the bot Manage Roles + drag its role above the verified one)'
          : rr.status === 404 ? ' (role failed 404: role or member gone — re-run /verify-setup)'
          : ` (role failed: discord said ${rr.status})`;
      } catch (e) { roleMsg = ' (role failed: ' + e.message + ')'; }
    }
    logActivity({ kind: alt.isAlt ? 'alt-flag' : 'verified', guildId: g.guildId, actor: me.username, msg: `${me.username} verified${alt.isAlt ? ' FLAGGED alt [' + alt.flags.join(', ') + ']' : ''} ip=${ip}${roleMsg}` });
    postVerifyEmbed(g, db.users[me.id], alt).catch(() => {});
    res.json({ ok: true, userId: me.id, alt, guildId: g.guildId });
  } catch (e) { res.status(500).json({ error: 'something went wrong: ' + e.message }); }
});

// ---- members page: who verified on this server ----
app.get('/api/guild/:id/members', requireGuildAdmin, (req, res) => {
  db = load();
  const list = Object.values(db.users)
    .filter(u => u.guilds && u.guilds[req.params.id])
    .map(u => ({ id: u.id, username: u.username, avatar: u.avatar, at: u.guilds[req.params.id].at, altScore: u.guilds[req.params.id].altScore || 0, ip: u.ip || null, email: u.email || null, country: (u.geo && (u.geo.countryCode || u.geo.country)) || null, registered: u.createdAt || null, mfa: !!u.mfa }));
  res.json({ count: list.length, members: list });
});
app.delete('/api/guild/:id/members/:uid', requireGuildAdmin, async (req, res) => {
  db = load();
  const u = db.users[req.params.uid];
  if (!u || !u.guilds || !u.guilds[req.params.id]) return res.status(404).json({ error: 'member is not verified on this server' });
  delete u.guilds[req.params.id];
  save(db);
  // pull the verified role back on revoke — same guards as granting
  const rg = (load().guilds || {})[req.params.id];
  if (rg && rg.verifyRoleId && DISCORD_BOT_TOKEN && !String(DISCORD_BOT_TOKEN).startsWith('test_')) {
    try { await fetch(`https://discord.com/api/v10/guilds/${req.params.id}/members/${req.params.uid}/roles/${rg.verifyRoleId}`, { method: 'DELETE', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } }); } catch {}
  }
  logActivity({ kind: 'revoke', guildId: req.params.id, actor: req.session.user.username, msg: `${u.username} verification revoked` });
  res.json({ ok: true });
});

// setup doctor: can the bot actually hand out the configured role + reach the log?
// answers why-not in plain words instead of a silent missing role.
app.get('/api/guild/:id/rolecheck', requireGuildAdmin, async (req, res) => {
  try {
    db = load();
    const g = getGuild(db, req.params.id); save(db);
    if (!DISCORD_BOT_TOKEN || String(DISCORD_BOT_TOKEN).startsWith('test_')) return res.json({ ok: false, reasons: ['no real bot token on this server'] });
    if (!g.verifyRoleId) return res.json({ ok: false, reasons: ['no verified role picked — run /verify-setup with a role'] });
    if (!g.logChannelId) return res.json({ ok: false, reasons: ['no log channel picked — run /verify-setup with a channel'] });
    const headers = { Authorization: `Bot ${DISCORD_BOT_TOKEN}` };
    const guild = await fetch(`https://discord.com/api/v10/guilds/${req.params.id}`, { headers }).then(r => { if (!r.ok) throw new Error('bot is not in this server (or the token is wrong): discord ' + r.status); return r.json(); });
    let botId = null;
    try { botId = Buffer.from(String(DISCORD_BOT_TOKEN).split('.')[0], 'base64').toString().replace(/[^0-9]/g, ''); } catch {}
    if (!botId || !/^[0-9]{10,}$/.test(botId)) botId = await fetch('https://discord.com/api/v10/users/@me', { headers }).then(r => r.json()).then(j => j.id);
    const member = await fetch(`https://discord.com/api/v10/guilds/${req.params.id}/members/${botId}`, { headers }).then(r => { if (!r.ok) throw new Error('cannot see the bot in this server: discord ' + r.status); return r.json(); });
    const byId = Object.fromEntries((guild.roles || []).map(r => [r.id, r]));
    const target = byId[g.verifyRoleId];
    const reasons = [];
    if (!target) reasons.push('verified role no longer exists — re-run /verify-setup');
    const owner = guild.owner_id === botId;
    let top = 0, canManage = owner;
    for (const rid of (member.roles || [])) {
      const r = byId[rid]; if (!r) continue;
      top = Math.max(top, r.position);
      try {
        const p = BigInt(r.permissions);
        if ((p & 0x8n) !== 0n || (p & 0x10000000n) !== 0n) canManage = true;
      } catch {}
    }
    if (!canManage) reasons.push('bot lacks Manage Roles (or Administrator) — server settings → roles → tick it');
    if (target && !owner && top <= target.position) reasons.push('bot role sits below the verified role — drag the bot role above it');
    const ch = await fetch(`https://discord.com/api/v10/channels/${g.logChannelId}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!ch) reasons.push('log channel unreadable — re-pick it in /verify-setup');
    res.json({ ok: reasons.length === 0, reasons });
  } catch (e) { res.status(500).json({ ok: false, reasons: [e.message] }); }
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
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'roloverify-local', base: BASE_URL, testMode: TEST_MODE, commit: process.env.RENDER_GIT_COMMIT || 'local', ts: Date.now() }));
app.listen(PORT, () => console.log(`roloverify local on ${BASE_URL}${TEST_MODE ? ' (test mode: demo login on)' : ''}`));
module.exports = { app, logActivity, ageText, decodeBadges, parseUA, pickGeo, canManage };
