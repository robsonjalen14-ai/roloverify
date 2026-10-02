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
      embed: { title: 'Verify to enter', description: 'Click verify to link your Discord and get restored anytime.', color: '#5865F2', buttonLabel: 'Verify Now' },
      logChannelId: null,
      verifyRoleId: null,
      createdAt: Date.now()
    };
  }
  return db.guilds[guildId];
}
function pushActivity(db, entry) {
  const row = { ts: Date.now(), ...entry };
  db.activity.unshift(row);
  db.activity = db.activity.slice(0, 300);
  save(db);
  return row;
}
module.exports = { DB_PATH, load, save, getGuild, pushActivity };
