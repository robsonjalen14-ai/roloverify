// dashboard brain — plain english, every button answers back
const $ = (id) => document.getElementById(id);
let GID = null, ES = null, GUILDS = [];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function iconFor(x) { return x.icon ? `https://cdn.discord.com/icons/${x.id}/${x.icon}.png` : null; }
function badgeFor(x) { if (x.botOnly) return 'bot'; if (x.owner) return 'owner'; return 'admin'; }
function paintServers() {
  $('guildList').innerHTML = GUILDS.map((x) => {
    const ic = iconFor(x);
    return `<button class="srv${x.id === GID ? ' active' : ''}" data-id="${x.id}"><span class="srv-ic">${ic ? `<img src="${ic}" alt="" loading="lazy" onerror="this.remove()">` : esc(x.name.charAt(0).toUpperCase())}</span><span class="srv-name">${esc(x.name)}</span><span class="pill">${badgeFor(x)}</span></button>`;
  }).join('') || '<div class="muted">No servers.</div>';
  [...document.querySelectorAll('.srv')].forEach((b) => { b.onclick = () => { GID = b.dataset.id; paintServers(); load(); }; });
}

function banner(msg, isError) {
  const b = $('banner');
  b.textContent = msg;
  b.classList.add('show');
  b.classList.toggle('error', !!isError);
}
async function j(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-json error page */ }
  if (!r.ok) throw new Error((data && data.error) || text || ('request failed (' + r.status + ')'));
  return data;
}

async function boot() {
  try {
    const me = await j('/api/me');
    $('me').textContent = me.user.username + (me.user.demo ? ' (demo)' : '');
    if (me.user.demo) banner('Demo mode: you are logged in as LocalTester. Add real Discord keys to .env to manage a live server.');
    else if (me.user.isOwner) banner('Owner mode — your servers plus every server the bot sits in.');
  } catch {
    location.href = '/auth/discord';
    return;
  }
  try {
    const g = await j('/api/my-guilds');
    if (!g.guilds.length) {
      banner('No servers found. Invite the bot to your server first, then refresh.', true);
      return;
    }
    GUILDS = g.guilds; GID = g.guilds[0].id;
    paintServers();
    load();
  } catch (e) { banner('Could not load your servers: ' + e.message, true); }
}

async function load() {
  if (!GID) return;
  try {
    const c = await j(`/api/guild/${GID}/config`);
    $('vpnBlock').checked = c.config.vpnBlock;
    $('altDetection').checked = c.config.altDetection;
    $('requireVerified').checked = c.config.requireVerified;
    $('verifySlug').value = c.config.verifySlug;
    $('logChannelId').value = c.config.logChannelId || '';
    $('verifyRoleId').value = c.config.verifyRoleId || '';
    $('eTitle').value = c.config.embed.title;
    $('eDesc').value = c.config.embed.description;
    $('eColor').value = c.config.embed.color;
    $('eBtn').value = c.config.embed.buttonLabel;
    $('vurl').href = $('vurl').textContent = `/v/${c.config.verifySlug}`;
    const s = await j(`/api/guild/${GID}/snapshots`);
    $('statSnaps').textContent = s.snapshots.length;
    $('statProt').textContent = (c.config.vpnBlock && c.config.altDetection) ? 'ON' : 'PARTIAL';
    try {
      const mm = await j(`/api/guild/${GID}/members`);
      $('statMembers').textContent = mm.count;
    } catch { $('statMembers').textContent = '–'; }
    $('snaps').innerHTML = s.snapshots.length
      ? s.snapshots.map(x => `<div>${x.id} — ${x.members.length} members — ${new Date(x.at).toLocaleString()} by ${x.by}</div>`).join('')
      : 'No snapshots yet. Take one above.';
  } catch (e) {
    if (/login required|401/.test(e.message)) { location.href = '/auth/discord'; return; }
    if (/rate limit|429/.test(e.message) && !load.retried) {
      load.retried = true;
      banner('Discord is busy — retrying once in 5 seconds…');
      setTimeout(load, 5000);
      return;
    }
    banner('Could not load settings: ' + e.message, true); return;
  }
  if (ES) ES.close();
  const box = $('console');
  box.innerHTML = '<div class="muted">Connecting…</div>';
  try {
    ES = new EventSource(`/api/guild/${GID}/activity`);
    ES.onmessage = (e) => {
      const a = JSON.parse(e.data);
      if (box.querySelector('.muted')) box.innerHTML = '';
      const d = document.createElement('div');
      d.textContent = `[${new Date(a.ts).toLocaleTimeString()}] [${a.kind}] ${a.msg}`;
      box.prepend(d);
    };
    ES.onerror = () => { box.innerHTML = '<div class="muted">Live feed disconnected. Reload the page.</div>'; ES.close(); };
  } catch { box.innerHTML = '<div class="muted">Live feed unavailable.</div>'; }
}

$('save').onclick = async () => {
  $('saveMsg').textContent = 'Saving…';
  const body = {
    vpnBlock: $('vpnBlock').checked, altDetection: $('altDetection').checked,
    requireVerified: $('requireVerified').checked, verifySlug: $('verifySlug').value.trim().toLowerCase(),
    logChannelId: $('logChannelId').value.trim() || null, verifyRoleId: $('verifyRoleId').value.trim() || null,
    embed: { title: $('eTitle').value, description: $('eDesc').value, color: $('eColor').value, buttonLabel: $('eBtn').value }
  };
  try {
    await j(`/api/guild/${GID}/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('saveMsg').textContent = 'Saved.';
    load();
  } catch (e) { $('saveMsg').textContent = 'Save failed: ' + e.message; }
};
$('rolecheck').onclick = async () => {
  banner('Checking bot permissions…');
  try {
    const r = await j(`/api/guild/${GID}/rolecheck`);
    banner(r.ok ? 'Bot setup green: role grant plus log channel ready.' : 'Bot setup needs work: ' + r.reasons.join(' '), !r.ok);
  } catch (e) { banner('Check failed: ' + e.message, true); }
};
$('snap').onclick = async () => {
  try {
    const r = await j(`/api/guild/${GID}/snapshot`, { method: 'POST' });
    banner(`Snapshot saved: ${r.count} members.`);
    load();
  } catch (e) { banner('Snapshot failed: ' + e.message, true); }
};
$('restore').onclick = async () => {
  if (!confirm('Restore verified members now?')) return;
  try {
    const r = await j(`/api/guild/${GID}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetGuildId: $('targetGuild').value.trim() || GID }) });
    banner(`Restore done: ${r.restored} back, ${r.failed.length} failed.`);
  } catch (e) { banner('Restore failed: ' + e.message, true); }
};
$('logout').onclick = () => fetch('/logout', { method: 'POST' }).then(() => { location.href = '/'; });
boot();
