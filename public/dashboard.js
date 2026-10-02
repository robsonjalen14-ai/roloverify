// dashboard brain — plain english, every button answers back
const $ = (id) => document.getElementById(id);
let GID = null, ES = null;

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
  } catch {
    location.href = '/auth/discord';
    return;
  }
  try {
    const g = await j('/api/my-guilds');
    const sel = $('guild');
    if (!g.guilds || !g.guilds.length) {
      sel.innerHTML = '<option value="">No servers found</option>';
      banner('No servers found. Invite the bot to your server first, then refresh.', true);
      return;
    }
    sel.innerHTML = g.guilds.map(x => `<option value="${x.id}"></option>`).join('');
    [...sel.options].forEach((o, i) => { o.textContent = g.guilds[i].name; });
    GID = sel.value;
    sel.onchange = () => { GID = sel.value; load(); };
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
    const k = await j(`/api/guild/${GID}/apikey`);
    $('apikey').textContent = k.apiKey;
    const s = await j(`/api/guild/${GID}/snapshots`);
    $('snaps').innerHTML = s.snapshots.length
      ? s.snapshots.map(x => `<div>${x.id} — ${x.members.length} members — ${new Date(x.at).toLocaleString()} by ${x.by}</div>`).join('')
      : 'No snapshots yet. Take one above.';
  } catch (e) { banner('Could not load settings: ' + e.message, true); return; }
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
$('rot').onclick = async () => {
  if (!confirm('Generate a new API key? The old one stops working.')) return;
  try {
    const r = await j(`/api/guild/${GID}/rotate-key`, { method: 'POST' });
    $('apikey').textContent = r.apiKey;
    banner('New API key generated.');
  } catch (e) { banner('Key rotation failed: ' + e.message, true); }
};
$('logout').onclick = () => fetch('/logout', { method: 'POST' }).then(() => { location.href = '/'; });
boot();
