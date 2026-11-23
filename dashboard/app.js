// Coco Voice dashboard — plain JS, no build step.
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.COCO_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const TZ_NAMES = {
  'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain',
  'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii',
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const state = { user: null, role: null, agentId: null, settings: null, agents: [], range: '7d', from: null, to: null, agent: '' };
const isMgr = () => state.role === 'admin' || state.role === 'manager';
const tz = () => state.settings?.business_timezone || 'America/New_York';

// ---------- dates (business timezone) ----------
const dayKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (key, d) => { const [y, m, dd] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10); };
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: tz(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (iso) => {
  if (!iso) return 'never';
  const m = (Date.now() - Date.parse(iso)) / 60e3;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const mins = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

function computeRange() {
  const today = dayKey(Date.now());
  if (state.range === 'today') { state.from = today; state.to = today; }
  if (state.range === '7d') { state.from = addDays(today, -6); state.to = today; }
  if (state.range === '30d') { state.from = addDays(today, -29); state.to = today; }
  if (state.range === 'custom') { state.from = $('#from').value || today; state.to = $('#to').value || today; }
}

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

// ---------- auth ----------
// Supported: password sign-in, forgot/reset password, email link, 8-digit email code,
// set/change password (Account page). Email links arrive as ?token_hash=...&type=...
const OTP_TYPES = ['email', 'magiclink', 'signup', 'invite', 'recovery', 'email_change'];
const msg = (t) => { $('#loginMsg').textContent = t; };
const friendly = (error) => {
  const m = error?.message || String(error);
  if (/rate limit/i.test(m)) return 'Too many emails were sent in the last hour. Use the code or link from your latest email, or try again later.';
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password. If you never set a password, use "Email link / code" or "Forgot password?".';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first. Use "Email link / code" to get a new confirmation email.';
  return m;
};

const pwProblem = (p) => (p.length < 6 ? 'Use at least 6 characters.' : !/[a-zA-Z]/.test(p) || !/[0-9]/.test(p) ? 'Use a mix of letters and numbers.' : '');

let passwordMode = null; // 'recovery' | 'invite' -> ask for a new password before entering the app

async function handleAuthRedirect() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const clean = () => history.replaceState(null, '', location.pathname + (location.hash.startsWith('#/') ? location.hash : ''));
  const errText = q.get('error_description') || h.get('error_description');
  if (errText) { clean(); return `That link didn't work: ${errText.replace(/\+/g, ' ')}. Request a new one below.`; }
  const tokenHash = q.get('token_hash');
  const type = q.get('type');
  if (!tokenHash) return '';
  msg('Verifying your link…');
  const { error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: OTP_TYPES.includes(type) ? type : 'email' });
  clean();
  if (error) return `That link has expired or was already used. Request a new one below. (${error.message})`;
  if (type === 'recovery' || type === 'invite') passwordMode = type;
  return '';
}

async function boot() {
  const linkError = await handleAuthRedirect();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin(linkError);
  if (passwordMode) return showNewPassword();
  state.user = session.user;
  const { data: prof } = await sb.from('profiles').select('role, agent_id').eq('user_id', state.user.id).maybeSingle();
  if (!prof) {
    showLogin(`Signed in as ${state.user.email}, but you don't have access yet. Ask an admin to add you in Settings → Users, then reload this page.`, true);
    return;
  }
  state.role = prof.role;
  state.agentId = prof.agent_id;
  const [{ data: settings }, { data: agents }] = await Promise.all([
    sb.from('app_settings').select('*').eq('id', 1).single(),
    sb.from('agents').select('id, name, active').order('name'),
  ]);
  state.settings = settings;
  state.agents = agents || [];

  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#meEmail').innerHTML = `<a href="#/account">${esc(state.user.email)}</a> · ${esc(state.role)}`;
  $('#tzLabel').textContent = `${TZ_NAMES[tz()] || tz()} time`;
  $('#agentFilter').innerHTML = '<option value="">All agents</option>'
    + state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}${a.active ? '' : ' (inactive)'}</option>`).join('');
  $('#agentFilter').hidden = !isMgr();

  const links = [['overview', 'Overview'], ...(isMgr() ? [['conversations', 'Conversations']] : []), ['reports', isMgr() ? 'Reports' : 'My coaching'], ...(state.role === 'admin' ? [['settings', 'Settings']] : []), ['account', 'Account']];
  $('#navLinks').innerHTML = links.map(([k, l]) => `<a href="#/${k}" data-k="${k}">${l}</a>`).join('');
  route();
}

function showLogin(text = '', signedInNoAccess = false) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#newPwForm').hidden = true;
  $('#signinBlock').hidden = signedInNoAccess;
  $('#loginIntro').textContent = 'Sign in to your team dashboard.';
  msg(text);
  if (signedInNoAccess) {
    const b = Object.assign(document.createElement('button'), { className: 'btn dark', textContent: 'Sign out' });
    b.onclick = async () => { await sb.auth.signOut(); location.reload(); };
    $('#loginMsg').append(document.createElement('br'), b);
  }
}

function showNewPassword() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#signinBlock').hidden = true;
  $('#newPwForm').hidden = false;
  $('#loginIntro').textContent = passwordMode === 'invite' ? 'Welcome! Choose a password for your account.' : 'Choose a new password for your account.';
  msg('');
  $('#newPw').focus();
}

function setTab(t) {
  document.querySelectorAll('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
  $('#pwForm').hidden = t !== 'password';
  $('#loginForm').hidden = t !== 'link';
  $('#codeForm').hidden = t !== 'link' || !$('#codeForm').dataset.sent;
  msg('');
}
$('#authTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.t); });

const needEmail = () => {
  const email = $('#email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { msg('Enter your email address first.'); $('#email').focus(); return null; }
  return email;
};
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

$('#pwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = needEmail(); if (!email) return;
  busy(e.submitter, async () => {
    const { error } = await sb.auth.signInWithPassword({ email, password: $('#password').value });
    if (error) msg(friendly(error)); else { state.user = null; start(); }
  });
});
$('#forgot').addEventListener('click', (e) => {
  e.preventDefault();
  const email = needEmail(); if (!email) return;
  busy($('#pwForm button'), async () => {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    msg(error ? friendly(error) : `If ${email} has an account, a password reset email is on its way. Check spam too.`);
  });
});
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = needEmail(); if (!email) return;
  busy(e.submitter, async () => {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    msg(error ? friendly(error) : 'Check your inbox (and spam) and click the link in the email. If the email shows a code, you can type it below.');
    $('#codeForm').dataset.sent = '1';
    $('#codeForm').hidden = false;
  });
});
$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = needEmail(); if (!email) return;
  busy(e.submitter, async () => {
    const { error } = await sb.auth.verifyOtp({ email, token: $('#code').value.replace(/\D/g, ''), type: 'email' });
    if (error) msg(`Code not accepted: ${friendly(error)}`); else { state.user = null; start(); }
  });
});
$('#newPwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const a = $('#newPw').value;
  const b = $('#newPw2').value;
  const bad = pwProblem(a); if (bad) return msg(bad);
  if (a !== b) return msg("The two passwords don't match.");
  busy(e.submitter, async () => {
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return msg(friendly(error));
    passwordMode = null;
    toast('Password saved');
    state.user = null;
    start();
  });
});
$('#logout').addEventListener('click', async () => { await sb.auth.signOut(); location.hash = ''; location.reload(); });
let booting = null;
const start = () => (booting ||= boot().finally(() => { booting = null; }));
sb.auth.onAuthStateChange((ev) => {
  if (ev === 'PASSWORD_RECOVERY') passwordMode = 'recovery';
  if (ev === 'SIGNED_IN' && !state.user) start();
});

// ---------- filters + router ----------
$('#range').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.range = b.dataset.r;
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
  $('#customRange').hidden = state.range !== 'custom';
  route();
});
['#from', '#to'].forEach((s) => $(s).addEventListener('change', route));
$('#agentFilter').addEventListener('change', (e) => { state.agent = e.target.value; route(); });
window.addEventListener('hashchange', route);

async function route() {
  if (!state.role) return;
  computeRange();
  const [, page = 'overview', arg] = location.hash.split('/');
  document.querySelectorAll('#navLinks a').forEach((a) => a.classList.toggle('on', a.dataset.k === page));
  $('#filters').hidden = page === 'settings' || page === 'account';
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (page === 'conversations' && isMgr()) await renderConversations(view, arg);
    else if (page === 'reports') await renderReports(view);
    else if (page === 'settings' && state.role === 'admin') await renderSettings(view);
    else if (page === 'account') await renderAccount(view);
    else await renderOverview(view);
  } catch (err) {
    view.innerHTML = `<div class="card empty">Something went wrong: ${esc(err.message || err)}</div>`;
  }
}

// ---------- overview ----------
function totals(rows) {
  const t = {};
  const keys = ['outbound_reaches', 'outbound_calls', 'connected_calls', 'outbound_texts', 'inbound_calls', 'missed_calls', 'inbound_texts', 'voicemails', 'inbound_contacts', 'unclassified'];
  keys.forEach((k) => { t[k] = rows.reduce((s, r) => s + Number(r[k] || 0), 0); });
  const w = rows.filter((r) => r.response_rate != null);
  const ww = w.reduce((s, r) => s + Number(r.outbound_reaches), 0);
  t.response_rate = ww ? w.reduce((s, r) => s + r.response_rate * r.outbound_reaches, 0) / ww : null;
  const rr = rows.filter((r) => r.avg_reply_min != null);
  t.avg_reply_min = rr.length ? rr.reduce((s, r) => s + Number(r.avg_reply_min), 0) / rr.length : null;
  return t;
}

function insights(t, rows, daily) {
  const out = [];
  if (t.missed_calls) out.push(['bad', `${n(t.missed_calls)} inbound call${t.missed_calls > 1 ? 's were' : ' was'} missed. Best practice: call back within 1 hour.`]);
  if (t.outbound_calls) {
    const c = t.connected_calls / t.outbound_calls;
    out.push([c < 0.2 ? 'bad' : 'good', `${pct(t.connected_calls, t.outbound_calls)} of outbound calls connected${c < 0.2 ? ' — try a text before calling, or call at a different time of day.' : '.'}`]);
  }
  if (t.avg_reply_min != null) out.push([t.avg_reply_min > 60 ? 'bad' : 'good', `Average reply time to customers: ${mins(t.avg_reply_min)}${t.avg_reply_min > 60 ? ' — target is under 15 min during business hours.' : '.'}`]);
  if (t.response_rate != null) out.push(['', `${t.response_rate.toFixed(0)}% of contacts reached replied within 7 days.`]);
  const top = rows.filter((r) => r.outbound_reaches > 0)[0];
  if (top && rows.length > 1) out.push(['good', `Top outreach: ${top.agent_name} with ${n(top.outbound_reaches)} reaches.`]);
  const best = [...daily].sort((a, b) => b.outbound_reaches - a.outbound_reaches)[0];
  if (best && best.outbound_reaches > 0 && daily.length > 1) out.push(['', `Busiest day: ${fmtDay(best.day)} (${n(best.outbound_reaches)} reaches).`]);
  rows.filter((r) => isSilent(r)).forEach((r) => out.push(['bad', `${r.agent_name}: extension not reporting (last seen ${ago(r.last_heartbeat_at)}). Ask them to open Google Voice in Chrome.`]));
  if (t.unclassified) out.push(['bad', `${n(t.unclassified)} Voice events could not be classified yet — the parser map needs checking.`]);
  if (!out.length) out.push(['', 'No activity in this period yet.']);
  return out;
}
const isSilent = (r) => !r.last_heartbeat_at || Date.now() - Date.parse(r.last_heartbeat_at) > 24 * 3600e3;

function barChart(daily) {
  if (!daily.length) return '<div class="empty">No data</div>';
  const W = 720, H = 220, P = 26;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.outbound_reaches, Number(d.inbound_calls) + Number(d.inbound_texts))));
  const bw = (W - P) / daily.length;
  const bar = Math.max(2, Math.min(18, bw / 2 - 3));
  const y = (v) => H - P - ((H - P - 8) * v) / max;
  const every = Math.ceil(daily.length / 10);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily outbound reaches and inbound activity">`;
  [0, 0.5, 1].forEach((f) => { const v = Math.round(max * f); s += `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#262626"/><text x="${P - 6}" y="${y(v) + 4}" fill="#c0c0c0" font-size="10" text-anchor="end">${v}</text>`; });
  daily.forEach((d, i) => {
    const x = P + i * bw + bw / 2;
    const inb = Number(d.inbound_calls) + Number(d.inbound_texts);
    s += `<rect x="${x - bar - 1}" y="${y(d.outbound_reaches)}" width="${bar}" height="${H - P - y(d.outbound_reaches)}" fill="#ffba00" rx="2"><title>${fmtDay(d.day)}: ${d.outbound_reaches} outbound reaches</title></rect>`;
    s += `<rect x="${x + 1}" y="${y(inb)}" width="${bar}" height="${H - P - y(inb)}" fill="#8a8a8a" rx="2"><title>${fmtDay(d.day)}: ${inb} inbound calls + texts</title></rect>`;
    if (i % every === 0) s += `<text x="${x}" y="${H - 8}" fill="#c0c0c0" font-size="10" text-anchor="middle">${fmtDay(d.day)}</text>`;
  });
  return `${s}</svg><div class="legend"><span><i style="background:#ffba00"></i>Outbound reaches</span><span><i style="background:#8a8a8a"></i>Inbound calls + texts</span></div>`;
}

const kpi = (label, value, sub = '', hero = false) => `<div class="card kpi${hero ? ' hero' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

async function renderOverview(view) {
  const agent = isMgr() ? state.agent || null : state.agentId;
  const [rows, daily] = await Promise.all([
    rpc('metrics_summary', { p_from: state.from, p_to: state.to, p_agent: agent }),
    rpc('metrics_daily', { p_from: state.from, p_to: state.to, p_agent: agent }),
  ]);
  const t = totals(rows);
  const period = state.from === state.to ? fmtDay(state.from) : `${fmtDay(state.from)} – ${fmtDay(state.to)}`;
  view.innerHTML = `
    <div class="section-title"><h2>Activity · ${esc(period)}</h2><button class="btn dark" id="csv">Download report (CSV)</button></div>
    <div class="kpis">
      ${kpi('Outbound reaches', n(t.outbound_reaches), 'unique contacts, once per day', true)}
      ${kpi('Calls out', n(t.outbound_calls), `${pct(t.connected_calls, t.outbound_calls)} connected`)}
      ${kpi('Texts out', n(t.outbound_texts))}
      ${kpi('Calls in', n(t.inbound_calls), `${n(t.missed_calls)} missed`)}
      ${kpi('Texts in', n(t.inbound_texts), `${n(t.voicemails)} voicemails`)}
      ${kpi('Reply rate', t.response_rate == null ? '—' : `${t.response_rate.toFixed(0)}%`, `avg reply ${mins(t.avg_reply_min)}`)}
    </div>
    <div class="two">
      <div class="card chart"><h3>Daily trend</h3>${barChart(daily)}</div>
      <div class="card"><h3>Analysis</h3><ul class="insights">${insights(t, rows, daily).map(([c, s]) => `<li class="${c}">${esc(s)}</li>`).join('')}</ul></div>
    </div>
    <div class="card">
      <h3>Agents</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Agent</th><th>Account</th><th class="num">Reaches</th><th class="num">Calls out</th><th class="num">Connected</th><th class="num">Texts out</th><th class="num">Calls in</th><th class="num">Missed</th><th class="num">Texts in</th><th class="num">Reply rate</th><th class="num">Avg reply</th>${isMgr() ? '<th class="num">AI score</th>' : ''}<th>Extension</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="${isMgr() ? 'click' : ''}" data-agent="${r.agent_id}">
            <td>${esc(r.agent_name)}<div class="small muted">${esc(r.gv_number || '')}</div></td>
            <td>${r.account_type === 'workspace' ? 'Workspace' : 'Personal'}</td>
            <td class="num"><b>${n(r.outbound_reaches)}</b></td><td class="num">${n(r.outbound_calls)}</td>
            <td class="num">${pct(r.connected_calls, r.outbound_calls)}</td><td class="num">${n(r.outbound_texts)}</td>
            <td class="num">${n(r.inbound_calls)}</td><td class="num">${n(r.missed_calls)}</td><td class="num">${n(r.inbound_texts)}</td>
            <td class="num">${r.response_rate == null ? '—' : `${r.response_rate}%`}</td><td class="num">${mins(r.avg_reply_min)}</td>
            ${isMgr() ? `<td class="num">${r.avg_score ?? '—'}</td>` : ''}
            <td><span class="dot ${isSilent(r) ? 'bad' : 'ok'}"></span> ${ago(r.last_heartbeat_at)}<div class="small muted">since ${r.tracking_start ? fmtDay(dayKeyIso(r.tracking_start)) : '—'}</div></td>
          </tr>`).join('') || '<tr><td colspan="13" class="empty">No agents yet</td></tr>'}</tbody>
      </table></div>
    </div>`;
  view.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => {
    state.agent = tr.dataset.agent;
    $('#agentFilter').value = state.agent;
    route();
  }));
  $('#csv').addEventListener('click', () => downloadCsv(rows));
}
const dayKeyIso = (iso) => dayKey(Date.parse(iso));

function downloadCsv(rows) {
  const cols = ['agent_name', 'account_type', 'gv_number', 'outbound_reaches', 'outbound_calls', 'connected_calls', 'outbound_texts', 'inbound_calls', 'missed_calls', 'inbound_texts', 'voicemails', 'inbound_contacts', 'response_rate', 'avg_reply_min', ...(isMgr() ? ['avg_score'] : [])];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `coco-report-${state.from}-to-${state.to}.csv`,
  });
  a.click();
}

// ---------- conversations (managers only) ----------
async function renderConversations(view, selected) {
  view.innerHTML = `
    <div class="section-title"><h2>Conversations</h2><input id="search" placeholder="Search number, name or text" style="max-width:300px"></div>
    <div class="convo"><div class="list" id="clist"></div><div class="card" id="detail"><div class="empty">Select a conversation</div></div></div>`;
  const load = async () => {
    const list = await rpc('conversation_list', { p_from: state.from, p_to: state.to, p_agent: state.agent || null, p_search: $('#search').value.trim() || null });
    $('#clist').innerHTML = list.map((c) => `
      <div class="item ${c.id === selected ? 'on' : ''}" data-id="${c.id}">
        <div style="display:flex;justify-content:space-between"><b>${esc(c.contact_name || c.contact || 'Group / unknown')}</b>${c.score ? `<span class="badge">${c.score}/10</span>` : ''}</div>
        <div class="small">${esc(c.agent_name)} · ${fmtTime(c.last_activity_at)} · ${c.messages} msg · ${c.calls} calls</div>
        <div class="snip muted">${esc(c.last_text || '')}</div>
      </div>`).join('') || '<div class="empty">No conversations in this period</div>';
    $('#clist').querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => { location.hash = `#/conversations/${el.dataset.id}`; }));
  };
  let timer;
  $('#search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  await load();
  if (selected) await renderDetail(selected);
}

async function renderDetail(id) {
  const [{ data: msgs }, { data: calls }, { data: an }] = await Promise.all([
    sb.from('messages').select('id, direction, kind, body, occurred_at').eq('conversation_id', id).order('occurred_at'),
    sb.from('calls').select('id, direction, outcome, duration_sec, occurred_at').eq('conversation_id', id).order('occurred_at'),
    sb.from('conversation_analysis').select('*').eq('conversation_id', id).order('created_at', { ascending: false }).limit(1),
  ]);
  const a = an?.[0];
  const flagged = new Map((a?.mistakes || []).filter((m) => m.message_id).map((m) => [m.message_id, m]));
  const items = [
    ...(msgs || []).map((m) => ({ ...m, t: 'm' })),
    ...(calls || []).map((c) => ({ ...c, t: 'c' })),
  ].sort((x, y) => Date.parse(x.occurred_at) - Date.parse(y.occurred_at));
  const callLabel = (c) => `${c.direction === 'outbound' ? '↗ Outgoing' : '↙ Incoming'} call · ${c.outcome}${c.duration_sec ? ` · ${Math.round(c.duration_sec / 60)} min ${c.duration_sec % 60}s` : ''}`;

  $('#detail').innerHTML = `
    <div class="two">
      <div>
        <h3>Timeline</h3>
        <div class="timeline">${items.map((it) => it.t === 'c'
          ? `<div class="event">${esc(callLabel(it))} · ${fmtTime(it.occurred_at)}</div>`
          : `<div class="bubble ${it.direction === 'outbound' ? 'out' : ''} ${flagged.has(it.id) ? 'flag' : ''}" title="${esc(flagged.get(it.id)?.issue || '')}">
               ${it.kind === 'voicemail' ? '<b>Voicemail:</b> ' : ''}${esc(it.body || '(no text)')}
               <div class="meta">${fmtTime(it.occurred_at)}</div></div>`).join('') || '<div class="empty">Empty</div>'}
        </div>
      </div>
      <div>
        <h3>Claude review</h3>
        ${a ? `
          <div style="display:flex;gap:14px;align-items:center;margin:8px 0"><div class="score">${a.overall_score ?? '—'}</div>
            <div><span class="badge">${esc(a.outcome || '—')}</span> <span class="badge">${esc(a.sentiment || '—')}</span><div class="small muted">${fmtTime(a.created_at)} · ${esc(a.model)}</div></div></div>
          <p style="color:var(--text)">${esc(a.summary || '')}</p>
          ${(a.mistakes || []).map((m) => `<div class="mistake"><span class="badge ${esc(m.severity)}">${esc(m.severity)}</span> <b style="color:var(--text)">${esc(m.issue)}</b><div class="small">→ ${esc(m.suggestion)}</div></div>`).join('')}
          ${(a.improvements || []).length ? `<h3 style="margin-top:14px;font-size:14px">Improve</h3><ul>${a.improvements.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}`
        : '<p class="muted">Not analyzed yet.</p>'}
        <button class="btn" id="analyzeOne" style="margin-top:12px">Analyze this conversation</button>
      </div>
    </div>`;
  $('#analyzeOne').addEventListener('click', async () => {
    const { error } = await sb.from('analysis_requests').insert({ conversation_id: id });
    toast(error ? error.message : 'Queued — Claude will review it on the next worker run.');
  });
}

// ---------- reports ----------
async function renderReports(view) {
  const t0 = new Date(`${state.from}T00:00:00Z`).getTime() - 864e5; // padded; tz-exact filtering below
  const agentId = isMgr() ? state.agent || null : state.agentId;
  let cq = sb.from('agent_coaching_reports').select('*, agents(name)').order('period_end', { ascending: false }).limit(20);
  if (agentId) cq = cq.eq('agent_id', agentId);
  const [{ data: coaching }, analyses, { data: lastReq }] = await Promise.all([
    cq,
    isMgr() ? (async () => {
      let q = sb.from('conversation_analysis').select('conversation_id, agent_id, overall_score, outcome, mistakes, created_at, agents(name)')
        .gte('created_at', new Date(t0).toISOString()).order('created_at', { ascending: false }).limit(1000);
      if (agentId) q = q.eq('agent_id', agentId);
      const { data } = await q;
      return (data || []).filter((r) => { const d = dayKeyIso(r.created_at); return d >= state.from && d <= state.to; });
    })() : [],
    isMgr() ? sb.from('analysis_requests').select('status, created_at').order('created_at', { ascending: false }).limit(1) : { data: [] },
  ]);

  const s = state.settings;
  const sched = s.analysis_mode === 'manual' ? 'Manual only'
    : s.analysis_mode === 'hourly' ? 'Every hour'
      : s.analysis_mode === 'daily' ? `Daily at ${s.analysis_time.slice(0, 5)}`
        : `Weekly, ${DAYS[s.analysis_weekday]} at ${s.analysis_time.slice(0, 5)}`;

  const latest = new Map();
  analyses.forEach((a) => { if (!latest.has(a.conversation_id)) latest.set(a.conversation_id, a); });
  const list = [...latest.values()];
  const avg = list.length ? (list.reduce((x, a) => x + (a.overall_score || 0), 0) / list.length).toFixed(1) : '—';
  const outcomes = {};
  const rules = {};
  list.forEach((a) => {
    outcomes[a.outcome || 'unknown'] = (outcomes[a.outcome || 'unknown'] || 0) + 1;
    (a.mistakes || []).forEach((m) => { const k = m.rule || m.issue; rules[k] = (rules[k] || 0) + 1; });
  });
  const topRules = Object.entries(rules).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const low = list.filter((a) => a.overall_score != null).sort((a, b) => a.overall_score - b.overall_score).slice(0, 6);

  view.innerHTML = `
    ${isMgr() ? `
    <div class="section-title"><h2>Claude analysis</h2>
      <div><span class="small">Schedule: <b style="color:var(--text)">${esc(sched)}</b> (${TZ_NAMES[tz()]}) · last run ${ago(s.last_analysis_run_at)}${lastReq?.[0]?.status === 'pending' ? ' · request pending' : ''}</span>
      <button class="btn" id="runNow">Run analysis now</button></div></div>
    <div class="kpis">
      ${kpi('Conversations reviewed', n(list.length), '', true)}
      ${kpi('Average score', avg, 'out of 10')}
      ${Object.entries(outcomes).slice(0, 4).map(([k, v]) => kpi(esc(k.replace('_', ' ')), n(v), pct(v, list.length))).join('')}
    </div>
    <div class="two">
      <div class="card"><h3>Most common mistakes</h3>
        ${topRules.length ? `<table><tbody>${topRules.map(([k, v]) => `<tr><td style="white-space:normal">${esc(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No mistakes recorded in this period</div>'}
      </div>
      <div class="card"><h3>Needs attention</h3>
        ${low.length ? `<table><tbody>${low.map((a) => `<tr class="click" data-c="${a.conversation_id}"><td>${esc(a.agents?.name)}</td><td>${esc(a.outcome || '')}</td><td class="num"><b>${a.overall_score}/10</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing yet</div>'}
      </div>
    </div>` : '<div class="section-title"><h2>My coaching</h2></div>'}
    <div class="card"><h3>Coaching reports</h3>
      ${(coaching || []).map((c) => {
        const r = c.report || {};
        return `<div class="mistake"><b style="color:var(--text)">${esc(c.agents?.name || '')}</b> <span class="small">${fmtDay(c.period_start)} – ${fmtDay(c.period_end)}</span>
          ${r.summary ? `<p style="color:var(--text)">${esc(r.summary)}</p>` : ''}
          <div class="two"><div>${listBlock('Strengths', r.strengths)}${listBlock('Top mistakes', r.top_mistakes)}</div><div>${listBlock('Action items', r.action_items)}</div></div></div>`;
      }).join('') || '<div class="empty">No coaching reports yet</div>'}
    </div>`;

  view.querySelectorAll('tr[data-c]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/conversations/${tr.dataset.c}`; }));
  $('#runNow')?.addEventListener('click', async () => {
    const { error } = await sb.from('analysis_requests').insert({ agent_id: state.agent || null });
    toast(error ? error.message : 'Analysis requested — results appear here when the worker finishes.');
  });
}
const listBlock = (title, arr) => (Array.isArray(arr) && arr.length
  ? `<div class="small" style="margin-top:8px;text-transform:uppercase;letter-spacing:.05em">${title}</div><ul>${arr.map((x) => `<li>${esc(typeof x === 'string' ? x : x.text || x.issue || JSON.stringify(x))}</li>`).join('')}</ul>` : '');

// ---------- account (everyone) ----------
async function renderAccount(view) {
  view.innerHTML = `
    <div class="section-title"><h2>Account</h2></div>
    <div class="card" style="max-width:460px">
      <h3>${esc(state.user.email)}</h3>
      <p class="small">Role: ${esc(state.role)}. You can sign in with a password, or with an email link / code.</p>
      <form id="acctPw">
        <label for="aPw">New password (min 6, letters + numbers)</label><input id="aPw" type="password" autocomplete="new-password" minlength="6">
        <label for="aPw2">Repeat new password</label><input id="aPw2" type="password" autocomplete="new-password" minlength="6">
        <button class="btn" type="submit" style="margin-top:14px">Set / change password</button>
      </form>
      <p class="small" id="acctMsg"></p>
    </div>`;
  $('#acctPw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('#aPw').value;
    const b = $('#aPw2').value;
    const bad = pwProblem(a); if (bad) { $('#acctMsg').textContent = bad; return; }
    if (a !== b) { $('#acctMsg').textContent = "The two passwords don't match."; return; }
    const { error } = await sb.auth.updateUser({ password: a });
    $('#acctMsg').textContent = error ? friendly(error) : 'Password saved. A confirmation email is on its way.';
    if (!error) e.target.reset();
  });
}

// ---------- settings (admin) ----------
async function renderSettings(view) {
  const [{ data: agents }, users] = await Promise.all([
    sb.from('agents').select('id, name, email, gv_number, account_type, active, tracking_start, last_heartbeat_at, parser_version').order('name'),
    rpc('list_users', {}),
  ]);
  const s = state.settings;
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  view.innerHTML = `
    <div class="section-title"><h2>Settings</h2></div>
    <div class="card"><h3>Business &amp; Claude analysis</h3>
      <div class="row">
        <div><label>Business timezone</label><select id="sTz">${Object.entries(TZ_NAMES).map(([k, v]) => opt(k, s.business_timezone, `${v} (${k})`)).join('')}</select></div>
        <div><label>Analysis runs</label><select id="sMode">${[['manual', 'Manual only'], ['hourly', 'Every hour'], ['daily', 'Daily'], ['weekly', 'Weekly']].map(([k, v]) => opt(k, s.analysis_mode, v)).join('')}</select></div>
        <div><label>At (local time)</label><input id="sTime" type="time" value="${s.analysis_time.slice(0, 5)}"></div>
        <div><label>Weekly report day</label><select id="sDay">${DAYS.map((d, i) => opt(String(i), String(s.analysis_weekday), d)).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>Conversation model</label><input id="sModel" value="${esc(s.analysis_model)}"></div>
        <div><label>Coaching model</label><input id="sCoach" value="${esc(s.coaching_model)}"></div>
        <div><label>Keep data (days)</label><input id="sRet" type="number" min="30" value="${s.retention_days}"></div>
        <div><button class="btn" id="saveSettings">Save</button></div>
      </div>
    </div>

    <div class="card"><h3>Agents (Google Voice numbers)</h3>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Voice number</th><th>Account</th><th>Tracking since</th><th>Last seen</th><th>Parser</th><th>Active</th><th></th></tr></thead>
      <tbody>${(agents || []).map((a) => `<tr data-id="${a.id}">
        <td><input class="aName" value="${esc(a.name)}"></td><td>${esc(a.gv_number || 'auto-detected on first sync')}</td>
        <td><select class="aType">${opt('personal', a.account_type, 'Personal')}${opt('workspace', a.account_type, 'Workspace')}</select></td>
        <td>${a.tracking_start ? fmtTime(a.tracking_start) : 'on first sync'}</td><td>${ago(a.last_heartbeat_at)}</td><td class="small">${esc(a.parser_version || '')}</td>
        <td><input type="checkbox" class="aActive" ${a.active ? 'checked' : ''} style="width:auto"></td>
        <td><button class="btn dark aSave">Save</button> <button class="btn dark aRotate">New token</button></td></tr>`).join('')}</tbody></table></div>
      <div class="row" style="margin-top:12px">
        <div><label>Name</label><input id="nName"></div>
        <div><label>Email</label><input id="nEmail" type="email"></div>
        <div><label>Account</label><select id="nType"><option value="personal">Personal Google Voice</option><option value="workspace">Google Workspace Voice</option></select></div>
        <div><button class="btn" id="addAgent">Add agent</button></div>
      </div>
      <div id="tokenOut"></div>
    </div>

    <div class="card"><h3>Dashboard users</h3>
      <p class="small">The person must open this dashboard and sign in once first. Only managers and admins can read message transcripts.</p>
      <table><tbody>${(users || []).map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${esc(state.agents.find((a) => a.id === u.agent_id)?.name || '')}</td></tr>`).join('')}</tbody></table>
      <div class="row" style="margin-top:12px">
        <div><label>Email</label><input id="uEmail" type="email"></div>
        <div><label>Role</label><select id="uRole"><option value="agent">Agent (own numbers, no transcripts)</option><option value="manager">Manager (everything + transcripts)</option><option value="admin">Admin</option></select></div>
        <div><label>Linked agent</label><select id="uAgent"><option value="">—</option>${(agents || []).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div>
        <div><button class="btn" id="setRole">Save user</button></div>
      </div>
    </div>`;

  $('#saveSettings').addEventListener('click', async () => {
    const upd = {
      business_timezone: $('#sTz').value, analysis_mode: $('#sMode').value, analysis_time: $('#sTime').value,
      analysis_weekday: Number($('#sDay').value), analysis_model: $('#sModel').value.trim(), coaching_model: $('#sCoach').value.trim(),
      retention_days: Number($('#sRet').value), updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb.from('app_settings').update(upd).eq('id', 1).select().single();
    if (error) return toast(error.message);
    state.settings = data;
    $('#tzLabel').textContent = `${TZ_NAMES[tz()]} time`;
    toast('Settings saved');
  });
  const showToken = (name, token) => {
    $('#tokenOut').innerHTML = `<p class="small" style="margin-top:12px">Token for <b>${esc(name)}</b> — copy it now, it is shown only once. Paste it in the extension's Settings.</p><div class="token">${esc(token)}</div>`;
  };
  $('#addAgent').addEventListener('click', async () => {
    const name = $('#nName').value.trim();
    if (!name) return toast('Name is required');
    try {
      const r = await rpc('create_agent', { p_name: name, p_email: $('#nEmail').value.trim(), p_account_type: $('#nType').value });
      await renderSettings(view);
      showToken(name, r.token);
    } catch (e) { toast(e.message); }
  });
  view.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    $('.aSave', tr).addEventListener('click', async () => {
      try { await rpc('update_agent', { p_agent: id, p_name: $('.aName', tr).value, p_account_type: $('.aType', tr).value, p_active: $('.aActive', tr).checked }); toast('Saved'); } catch (e) { toast(e.message); }
    });
    $('.aRotate', tr).addEventListener('click', async () => {
      if (!confirm('Generate a new token? The old one stops working immediately.')) return;
      try { showToken($('.aName', tr).value, await rpc('rotate_agent_token', { p_agent: id })); } catch (e) { toast(e.message); }
    });
  });
  $('#setRole').addEventListener('click', async () => {
    try {
      await rpc('set_user_role', { p_email: $('#uEmail').value.trim(), p_role: $('#uRole').value, p_agent: $('#uAgent').value || null });
      toast('User saved');
      renderSettings(view);
    } catch (e) { toast(e.message); }
  });
}

start();
