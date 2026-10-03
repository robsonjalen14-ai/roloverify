// bot.js — discord.js 14.14.1 gateway: verify embed deploy + join-gate + logging
// *GatewayIntentBits.GuildMembers privileged — flip it on in dev portal or guildMemberAdd never fires*
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder, ActivityType } = require('discord.js');
const { load, save, getGuild, pushActivity } = require('./store');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
if (!TOKEN) { console.error('missing DISCORD_BOT_TOKEN'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function dbLog(entry) {
  const db = load();
  pushActivity(db, entry);
}
// tells the dashboard every server the bot sits in — owner sees them all
function syncGuilds() {
  try {
    const db = load();
    db.botGuilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, members: g.memberCount || 0 }));
    save(db);
  } catch {}
}

client.once('ready', async () => {
  console.log('> rolo-verify v1.0\n> connecting to discord...\n> logged in as ' + client.user.tag + '\n> watching for new members...\n> verification enabled.\n> ready.');
  client.user.setPresence({ activities: [{ name: 'Rolo Verify', type: ActivityType.Playing }], status: 'dnd' });
  console.log('> status: dnd, playing Rolo Verify');
  syncGuilds();
  const cmds = [
    new SlashCommandBuilder().setName('verify-setup').setDescription('post the verify embed here')
      .addRoleOption(o => o.setName('role').setDescription('role members get after verifying').setRequired(true))
      .addChannelOption(o => o.setName('log').setDescription('channel for verify log cards').setRequired(true)),
    new SlashCommandBuilder().setName('snapshot').setDescription('seal a member snapshot now'),
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // global commands: every server sees them. discord caches up to 1 hour on first sync.
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    console.log('slash synced global — visible in every server (discord cache up to 1h first time)');
  } catch (e) { console.error('slash sync fail:', e.message); }
  if (process.env.DISCORD_CLIENT_ID) console.log('> invite (tick applications.commands): https://discord.com/oauth2/authorize?client_id=' + process.env.DISCORD_CLIENT_ID + '&permissions=8&scope=bot+applications.commands');
});

client.on('interactionCreate', async (ix) => {
  if (!ix.isChatInputCommand()) return;
  const db = load();
  const g = getGuild(db, ix.guildId); save(db);
  if (ix.commandName === 'verify-setup') {
    await ix.deferReply({ ephemeral: true });
    try {
      const log = ix.options.getChannel('log'); const role = ix.options.getRole('role');
      const db2 = load(); const g2 = getGuild(db2, ix.guildId);
      g2.logChannelId = log.id; g2.verifyRoleId = role.id;
      save(db2);
      const url = `${BASE_URL}/v/${g2.verifySlug}`;
      const icon = ix.guild.iconURL({ size: 128 });
      const emb = new EmbedBuilder()
        .setTitle(g2.embed.title)
        .setDescription(g2.embed.description + `\n\n[**Verify here**](${url})`)
        .setColor(parseInt(String(g2.embed.color || '').replace('#', ''), 16) || 0x2D7DFF)
        .setFooter({ text: 'Rolo Verify' })
        .setTimestamp();
      if (icon) { emb.setAuthor({ name: `${ix.guild.name} • Verification`, iconURL: icon }); emb.setThumbnail(icon); }
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(g2.embed.buttonLabel || 'Verify Now').setStyle(ButtonStyle.Link).setURL(url));
      // setup-time diagnosis: say what's broken now, not after a failed verify
      const warns = [];
      try {
        const me = await ix.guild.members.fetch(client.user.id);
        if (!me.permissions.has('ManageRoles')) warns.push('I lack Manage Roles — roles will not grant until it is ticked.');
        if (role.position >= me.roles.highest.position) warns.push(`my top role sits below @${role.name} — drag the bot role above it.`);
      } catch { warns.push('could not inspect roles — re-run setup if grants fail.'); }
      try {
        await ix.channel.send({ embeds: [emb], components: [row] });
      } catch {
        await ix.editReply(`Saved, but I cannot post in this channel — run setup where I can send messages.${warns.length ? '\nAlso: ' + warns.join(' ') : ''}`);
        return;
      }
      await ix.editReply(`verify live → ${url}\nrole <@&${role.id}> on verify, cards in <#${log.id}>${warns.length ? '\nWarnings: ' + warns.join(' ') : ''}`);
      dbLog({ kind: 'config', guildId: ix.guildId, actor: ix.user.username, msg: `verify embed deployed by ${ix.user.username}` });
    } catch (e) {
      try { await ix.editReply('Setup hit an error: ' + e.message); } catch {}
    }
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

client.on('guildCreate', syncGuilds);
client.on('guildDelete', syncGuilds);
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
