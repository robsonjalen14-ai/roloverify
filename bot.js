// bot.js — discord.js 14.14.1 gateway: verify embed deploy + join-gate + logging
// *GatewayIntentBits.GuildMembers privileged — flip it on in dev portal or guildMemberAdd never fires*
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { load, save, getGuild, pushActivity } = require('./store');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
if (!TOKEN) { console.error('missing DISCORD_BOT_TOKEN'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function dbLog(entry) {
  const db = load();
  pushActivity(db, entry);
}

client.once('ready', async () => {
  console.log('> rolo-verify v1.0\n> connecting to discord...\n> logged in as ' + client.user.tag + '\n> watching for new members...\n> verification enabled.\n> ready.');
  const cmds = [
    new SlashCommandBuilder().setName('verify-setup').setDescription('post the verify embed here')
      .addChannelOption(o => o.setName('log').setDescription('log channel').setRequired(false))
      .addRoleOption(o => o.setName('role').setDescription('role given after verify').setRequired(false)),
    new SlashCommandBuilder().setName('snapshot').setDescription('seal a member snapshot now'),
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try { await rest.put(Routes.applicationCommands(client.user.id), { body: cmds }); console.log('slash synced'); }
  catch (e) { console.error('slash sync fail:', e.message); }
});

client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;
  const db = load();
  const g = getGuild(db, ix.guildId); save(db);
  if (ix.commandName === 'verify-setup') {
    const log = ix.options.getChannel('log'); const role = ix.options.getRole('role');
    const db2 = load(); const g2 = getGuild(db2, ix.guildId);
    if (log) g2.logChannelId = log.id;
    if (role) g2.verifyRoleId = role.id;
    save(db2);
    const url = `${BASE_URL}/v/${g2.verifySlug}`;
    const emb = new EmbedBuilder().setTitle(g2.embed.title).setDescription(g2.embed.description + `\n\n[Verify here](${url})`).setColor(parseInt(g2.embed.color.replace('#', ''), 16) || 0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(g2.embed.buttonLabel || 'Verify Now').setStyle(ButtonStyle.Link).setURL(url));
    await ix.channel.send({ embeds: [emb], components: [row] });
    await ix.reply({ content: `verify live → ${url}`, ephemeral: true });
    dbLog({ kind: 'config', guildId: ix.guildId, actor: ix.user.username, msg: `verify embed deployed by ${ix.user.username}` });
  }
  if (ix.commandName === 'snapshot') {
    const db3 = load();
    const verified = Object.values(db3.users).filter(u => u.guilds && u.guilds[ix.guildId]);
    const snapId = 'snap_' + Date.now().toString(36);
    db3.snapshots[snapId] = { id: snapId, guildId: ix.guildId, at: Date.now(), by: ix.user.username, members: verified.map(v => ({ id: v.id, username: v.username })) };
    save(db3);
    dbLog({ kind: 'snapshot', guildId: ix.guildId, actor: ix.user.username, msg: `snapshot ${snapId} sealed (${verified.length})` });
    await ix.reply({ content: `snapshot ${snapId} sealed — ${verified.length} members`, ephemeral: true });
  }
});

client.on('guildMemberAdd', async (m) => {
  try {
    const db = load();
    const g = getGuild(db, m.guild.id); save(db);
    const rec = (load().users[m.id] || {});
    const verified = rec.guilds && rec.guilds[m.guild.id];
    const msg = verified ? `join: ${m.user.username} (verified)` : `join: ${m.user.username} (UNVERIFIED${g.requireVerified ? ' — gate on' : ''})`;
    dbLog({ kind: verified ? 'join' : 'join-unverified', guildId: m.guild.id, actor: m.user.username, msg });
    if (g.logChannelId) {
      const ch = await m.guild.channels.fetch(g.logChannelId).catch(() => null);
      if (ch && ch.isTextBased()) ch.send(`🛡️ ${msg}`).catch(() => {});
    }
    // optional hard gate: kick unverified after 30s if requireVerified (comment out for soft mode)
    // if (g.requireVerified && !verified) { setTimeout(()=>m.kick('unverified').catch(()=>{}), 30000); }
  } catch (e) { console.error('memberAdd fail', e.message); }
});

client.login(TOKEN);
