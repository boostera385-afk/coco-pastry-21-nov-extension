// Coco Voice dashboard — plain JS, no build step.
const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.COCO_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const TZ_NAMES = {
  'Asia/Karachi': 'Pakistan',
  'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain',
  'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii',
};

const state = { user: null, role: null, agentId: null, settings: null, agents: [], range: '7d', from: null, to: null, agent: '' };
const isMgr = () => state.role === 'admin'; // admin sees everything; agents see only their own numbers
const tz = () => state.settings?.business_timezone || 'Asia/Karachi';

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
  if (session.user.user_metadata?.must_change_password) passwordMode = 'first';
  if (passwordMode) return showNewPassword();
  state.user = session.user;
  const { data: prof } = await sb.from('profiles').select('role, agent_id').eq('user_id', state.user.id).maybeSingle();
  if (!prof) {
    showLogin(`Signed in as ${state.user.email}, but you don't have access yet. Ask an admin to add you in Settings → Users, then reload this page.`, true);
    return;
  }
  if (prof.role !== 'admin' && prof.role !== 'agent') {
    showLogin(`Signed in as ${state.user.email}, but this account has no dashboard access. Ask an admin.`, true);
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

  const links = [['overview', 'Overview'], ...(isMgr() ? [['contacts', 'Contacts'], ['conversations', 'Conversations'], ['analysis', 'Analysis'], ['settings', 'Settings']] : []), ['account', 'Account']];
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
  $('#loginIntro').textContent = passwordMode === 'first' ? 'Welcome! You signed in with a temporary password. Choose your own password to continue.'
    : passwordMode === 'invite' ? 'Welcome! Choose a password for your account.' : 'Choose a new password for your account.';
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
    const { error } = await sb.auth.updateUser({ password: a, data: { must_change_password: false } });
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
    else if (page === 'contacts' && isMgr()) await renderContacts(view);
    else if (page === 'analysis' && isMgr()) await renderAnalysis(view);
    else if (page === 'settings' && isMgr()) await renderSettings(view);
    else if (page === 'account') await renderAccount(view);
    else await renderOverview(view);
  } catch (err) {
    view.innerHTML = `<div class="card empty">Something went wrong: ${esc(err.message || err)}</div>`;
  }
}

// ---------- overview ----------
// Department rule: every call and every text counts (no "once per day" de-duplication).
function totals(rows) {
  const t = {};
  const keys = ['outbound_total', 'inbound_total', 'contacts_reached', 'outbound_calls', 'connected_calls', 'conversations', 'outbound_texts',
    'inbound_calls', 'missed_calls', 'inbound_texts', 'voicemails', 'unclassified'];
  keys.forEach((k) => { t[k] = rows.reduce((s, r) => s + Number(r[k] || 0), 0); });
  const w = rows.filter((r) => r.response_rate != null);
  const ww = w.reduce((s, r) => s + Number(r.contacts_reached), 0);
  t.response_rate = ww ? w.reduce((s, r) => s + r.response_rate * r.contacts_reached, 0) / ww : null;
  const rr = rows.filter((r) => r.avg_reply_min != null);
  t.avg_reply_min = rr.length ? rr.reduce((s, r) => s + Number(r.avg_reply_min), 0) / rr.length : null;
  return t;
}

function insights(t, rows, daily) {
  const out = [];
  if (t.missed_calls) out.push(['bad', `${n(t.missed_calls)} inbound call${t.missed_calls > 1 ? 's were' : ' was'} missed. Best practice: call back within 1 hour.`]);
  if (t.outbound_calls) {
    const c = t.connected_calls / t.outbound_calls;
    const v = t.conversations / t.outbound_calls;
    out.push([c < 0.2 ? 'bad' : '', `${pct(t.connected_calls, t.outbound_calls)} of outbound calls were picked up (by a person, voicemail or a bot)${c < 0.2 ? ' — try a text before calling, or call at a different time of day.' : '.'}`]);
    out.push([v < 0.1 ? 'bad' : 'good', `${n(t.conversations)} real conversation${t.conversations === 1 ? '' : 's'} (${pct(t.conversations, t.outbound_calls)} of calls lasted ${state.settings?.analysis_rules?.conversation_sec || 60}s+)${v < 0.1 ? ' — most pickups were voicemail/bots or quick hang-ups; leave a voicemail and follow up by text.' : '.'}`]);
  }
  if (t.avg_reply_min != null) out.push([t.avg_reply_min > 60 ? 'bad' : 'good', `Average reply time to customers: ${mins(t.avg_reply_min)}${t.avg_reply_min > 60 ? ' — target is under 15 min during business hours.' : '.'}`]);
  if (t.response_rate != null) out.push(['', `${t.response_rate.toFixed(0)}% of contacts reached replied within 7 days.`]);
  const top = rows.filter((r) => r.outbound_total > 0)[0];
  if (top && rows.length > 1) out.push(['good', `Most outbound: ${top.agent_name} with ${n(top.outbound_total)} calls + texts.`]);
  const best = [...daily].sort((a, b) => b.outbound_total - a.outbound_total)[0];
  if (best && best.outbound_total > 0 && daily.length > 1) out.push(['', `Busiest day: ${fmtDay(best.day)} (${n(best.outbound_total)} outbound).`]);
  rows.filter((r) => isSilent(r)).forEach((r) => out.push(['bad', `${r.agent_name}: extension not reporting (last seen ${ago(r.last_heartbeat_at)}). Ask them to open Google Voice in Chrome.`]));
  if (t.unclassified) out.push(['bad', `${n(t.unclassified)} Voice events could not be classified yet — the parser map needs checking.`]);
  if (!out.length) out.push(['', 'No activity in this period yet.']);
  return out;
}
const isSilent = (r) => !r.last_heartbeat_at || Date.now() - Date.parse(r.last_heartbeat_at) > 24 * 3600e3;

/** Extension connection status for an agent row (needs last_heartbeat_at, optional last_health). */
function connBadge(a) {
  if (!a.last_heartbeat_at) return '<span class="dot"></span> Not connected yet';
  if (a.last_health?.paused) return `<span class="dot warn"></span> Paused <span class="small muted">${ago(a.last_health.pausedAt || a.last_heartbeat_at)}</span>`;
  const m = (Date.now() - Date.parse(a.last_heartbeat_at)) / 60e3;
  if (m <= 30) return `<span class="dot ok"></span> Tracking <span class="small muted">${ago(a.last_heartbeat_at)}</span>`;
  return `<span class="dot ${m > 1440 ? 'bad' : 'warn'}"></span> Last seen ${ago(a.last_heartbeat_at)}`;
}

function barChart(daily) {
  if (!daily.length) return '<div class="empty">No data</div>';
  const W = 720, H = 220, P = 26;
  const peak = Math.max(0, ...daily.map((d) => Math.max(Number(d.outbound_total), Number(d.inbound_total))));
  const max = Math.max(4, Math.ceil(peak / 2) * 2); // even number >= 4 so axis ticks are distinct integers
  const bw = (W - P) / daily.length;
  const bar = Math.max(2, Math.min(18, bw / 2 - 3));
  const y = (v) => H - P - ((H - P - 8) * v) / max;
  const every = Math.ceil(daily.length / 10);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily outbound and inbound calls and texts">`;
  [0, max / 2, max].forEach((v) => { s += `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#262626"/><text x="${P - 6}" y="${y(v) + 4}" fill="#c0c0c0" font-size="10" text-anchor="end">${v}</text>`; });
  daily.forEach((d, i) => {
    const x = P + i * bw + bw / 2;
    const o = Number(d.outbound_total);
    const inb = Number(d.inbound_total);
    s += `<rect x="${x - bar - 1}" y="${y(o)}" width="${bar}" height="${H - P - y(o)}" fill="#ffba00" rx="2"><title>${fmtDay(d.day)}: ${o} outbound (${d.outbound_calls} calls, ${d.outbound_texts} texts)</title></rect>`;
    s += `<rect x="${x + 1}" y="${y(inb)}" width="${bar}" height="${H - P - y(inb)}" fill="#00843d" rx="2"><title>${fmtDay(d.day)}: ${inb} inbound</title></rect>`;
    if (i % every === 0) s += `<text x="${x}" y="${H - 8}" fill="#c0c0c0" font-size="10" text-anchor="middle">${fmtDay(d.day)}</text>`;
  });
  return `${s}</svg><div class="legend"><span><i style="background:#ffba00"></i>Outbound calls + texts</span><span><i style="background:#00843d"></i>Inbound calls + texts + voicemails</span></div>`;
}

// Simple line icons for KPI tiles (stroke = currentColor)
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  out: svg('<path d="M4 20 20 4M9 4h11v11"/>'),
  in: svg('<path d="M20 4 4 20M15 20H4V9"/>'),
  callOut: svg('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 3h6v6M21 3l-6 6"/>'),
  callIn: svg('<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M21 3l-6 6M15 3v6h6"/>'),
  textOut: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 12h6M13 10l2 2-2 2"/>'),
  textIn: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M15 12H9M11 10l-2 2 2 2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
};
/** tone: 'y' outbound/primary, 'g' inbound/good, 'r' missed/alerts */
const kpi = (label, value, sub = '', { hero = false, tone = 'y', icon = ICON.check } = {}) =>
  `<div class="card kpi ${tone}${hero ? ' hero' : ''}"><div class="ico">${icon}</div>`
  + `<div class="txt"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div></div>`;

async function renderOverview(view) {
  const agent = isMgr() ? state.agent || null : state.agentId;
  const [rows, daily, healthRows] = await Promise.all([
    rpc('metrics_summary', { p_from: state.from, p_to: state.to, p_agent: agent }),
    rpc('metrics_daily', { p_from: state.from, p_to: state.to, p_agent: agent }),
    sb.from('agents').select('id, last_health').then((r) => r.data || []),
  ]);
  const health = Object.fromEntries(healthRows.map((h) => [h.id, h.last_health]));
  const t = totals(rows);
  const openIssues = isMgr() ? (await rpc('analysis_issues', { p_from: state.from, p_to: state.to, p_agent: agent })).filter((i) => i.status === 'open') : [];
  const period = state.from === state.to ? fmtDay(state.from) : `${fmtDay(state.from)} – ${fmtDay(state.to)}`;
  view.innerHTML = `
    <div class="section-title"><h2>${isMgr() ? 'Activity' : 'My activity'} · ${esc(period)}</h2><div class="row" style="align-items:center"><button class="btn dark" id="csv" title="One row per agent: totals for the period">Summary (CSV)</button><button class="btn dark" id="csvDetail" title="One row per call, text and voicemail with time, contact, outcome and duration">Every call &amp; text (CSV)</button></div></div>
    <div class="kpis">
      ${kpi('Outbound', n(t.outbound_total), `every call + text · ${n(t.contacts_reached)} contact${t.contacts_reached === 1 ? '' : 's'}`, { hero: true, icon: ICON.out })}
      ${kpi('Calls out', n(t.outbound_calls), t.outbound_calls ? `${n(t.connected_calls)} picked up · ${n(t.conversations)} conversation${t.conversations === 1 ? '' : 's'}` : 'no calls yet', { icon: ICON.callOut })}
      ${kpi('Texts out', n(t.outbound_texts), 'sent', { icon: ICON.textOut })}
      ${kpi('Inbound', n(t.inbound_total), 'every call + text + voicemail', { tone: 'g', icon: ICON.in })}
      ${kpi('Calls in', n(t.inbound_calls), `${n(t.missed_calls)} missed`, { tone: t.missed_calls ? 'r' : 'g', icon: ICON.callIn })}
      ${kpi('Texts in', n(t.inbound_texts), `${n(t.voicemails)} voicemails`, { tone: 'g', icon: ICON.textIn })}
      ${kpi('Reply rate', t.response_rate == null ? '—' : `${t.response_rate.toFixed(0)}%`, `avg reply ${mins(t.avg_reply_min)}`, { tone: t.avg_reply_min > 60 ? 'r' : 'g', icon: ICON.clock })}
    </div>
    <div class="two">
      <div class="card chart"><h3>Daily trend</h3>${barChart(daily)}</div>
      <div class="card"><h3>Analysis</h3><ul class="insights">${isMgr() ? `<li class="${openIssues.some((i) => i.severity === 'high') ? 'bad' : openIssues.length ? '' : 'good'}"><a href="#/analysis">${openIssues.length ? `${n(openIssues.length)} issue${openIssues.length > 1 ? 's' : ''} to check (${n(openIssues.filter((i) => i.severity === 'high').length)} high) →` : 'No open issues — all checks passed'}</a></li>` : ''}${insights(t, rows, daily).map(([c, s]) => `<li class="${c}">${esc(s)}</li>`).join('')}</ul></div>
    </div>
    <div class="card">
      <h3>${isMgr() ? 'Agents' : 'My extension'}</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Agent</th><th class="num">Outbound</th><th class="num">Contacts</th><th class="num">Calls out</th><th class="num" title="Picked up by a person, voicemail or a bot (call lasted more than 0 s)">Picked up</th><th class="num" title="Picked-up calls that lasted at least the conversation threshold">Conversations</th><th class="num">Texts out</th><th class="num">Inbound</th><th class="num">Calls in</th><th class="num">Missed</th><th class="num">Texts in</th><th class="num">Reply rate</th><th class="num">Avg reply</th><th>Extension</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="${isMgr() ? 'click' : ''}" data-agent="${r.agent_id}">
            <td>${esc(r.agent_name)}<div class="small muted">${esc(r.gv_number || '')}</div></td>
            <td class="num"><b>${n(r.outbound_total)}</b></td><td class="num">${n(r.contacts_reached)}</td>
            <td class="num">${n(r.outbound_calls)}</td><td class="num">${pct(r.connected_calls, r.outbound_calls)}</td><td class="num">${n(r.conversations)}</td><td class="num">${n(r.outbound_texts)}</td>
            <td class="num"><b>${n(r.inbound_total)}</b></td><td class="num">${n(r.inbound_calls)}</td><td class="num">${n(r.missed_calls)}</td><td class="num">${n(r.inbound_texts)}</td>
            <td class="num">${r.response_rate == null ? '—' : `${r.response_rate}%`}</td><td class="num">${mins(r.avg_reply_min)}</td>
            <td>${connBadge({ last_heartbeat_at: r.last_heartbeat_at, last_health: health[r.agent_id] })}<div class="small muted">since ${r.tracking_start ? fmtTime(r.tracking_start) : '—'}</div></td>
          </tr>`).join('') || '<tr><td colspan="13" class="empty">No agents yet</td></tr>'}</tbody>
      </table></div>
    </div>`;
  view.querySelectorAll('tr.click').forEach((tr) => tr.addEventListener('click', () => {
    state.agent = tr.dataset.agent;
    $('#agentFilter').value = state.agent;
    route();
  }));
  $('#csv').addEventListener('click', () => downloadCsv(rows, `coco-report-${state.from}-to-${state.to}.csv`,
    ['agent_name', 'gv_number', 'outbound_total', 'contacts_reached', 'outbound_calls', 'connected_calls', 'conversations', 'outbound_texts',
      'inbound_total', 'inbound_calls', 'missed_calls', 'inbound_texts', 'voicemails', 'response_rate', 'avg_reply_min']));
  $('#csvDetail').addEventListener('click', async () => {
    const log = await rpc('activity_log', { p_from: state.from, p_to: state.to, p_agent: agent });
    const rowsOut = log.map((r) => ({ ...r, conversation: r.channel === 'call' && r.direction === 'outbound' ? (r.conversation ? 'yes' : 'no') : '' }));
    downloadCsv(rowsOut, `coco-activity-${state.from}-to-${state.to}.csv`,
      ['local_time', 'agent_name', 'contact', 'contact_name', 'channel', 'direction', 'outcome', 'duration_sec', 'conversation', ...(isMgr() ? ['body'] : [])]);
  });
}
const dayKeyIso = (iso) => dayKey(Date.parse(iso));

function downloadCsv(rows, filename, cols) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: filename }).click();
}

// ---------- contacts (admin): every call and text, under each contact ----------
async function renderContacts(view) {
  view.innerHTML = `
    <div class="section-title"><h2>Contacts</h2>
      <div class="row" style="align-items:center"><input id="csearch" placeholder="Search number or name" style="max-width:260px"><button class="btn dark" id="ccsv">Download (CSV)</button></div></div>
    <div class="card"><div class="table-wrap" id="ctable"><div class="empty">Loading…</div></div></div>`;
  let rows = [];
  const load = async () => {
    rows = await rpc('contact_activity', { p_from: state.from, p_to: state.to, p_agent: state.agent || null, p_search: $('#csearch').value.trim() || null });
    $('#ctable').innerHTML = `<table>
      <thead><tr><th>Contact</th><th>Agent</th><th class="num">Calls out</th><th class="num" title="Picked up by a person, voicemail or a bot">Picked up</th><th class="num">Texts out</th><th class="num">Calls in</th><th class="num">Missed</th><th class="num">Texts in</th><th class="num">Voicemails</th><th class="num">Total</th><th>Last activity</th></tr></thead>
      <tbody>${rows.map((c) => `<tr class="click" data-conv="${c.conversation_id || ''}">
        <td><b>${esc(c.contact_name || c.contact)}</b>${c.contact_name ? `<div class="small muted">${esc(c.contact)}</div>` : ''}</td>
        <td>${esc(c.agent_name)}</td>
        <td class="num">${n(c.calls_out)}</td><td class="num">${n(c.connected)}</td><td class="num">${n(c.texts_out)}</td>
        <td class="num">${n(c.calls_in)}</td><td class="num">${c.missed ? `<span style="color:var(--red)">${n(c.missed)}</span>` : 0}</td>
        <td class="num">${n(c.texts_in)}</td><td class="num">${n(c.voicemails)}</td><td class="num"><b>${n(c.total)}</b></td>
        <td>${fmtTime(c.last_at)}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">No contacts in this period</td></tr>'}</tbody></table>`;
    $('#ctable').querySelectorAll('tr[data-conv]').forEach((tr) => tr.addEventListener('click', () => {
      if (tr.dataset.conv) location.hash = `#/conversations/${tr.dataset.conv}`;
    }));
  };
  let timer;
  $('#csearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  $('#ccsv').addEventListener('click', () => downloadCsv(rows, `coco-contacts-${state.from}-to-${state.to}.csv`,
    ['contact', 'contact_name', 'agent_name', 'calls_out', 'connected', 'texts_out', 'calls_in', 'missed', 'texts_in', 'voicemails', 'total', 'first_at', 'last_at']));
  await load();
}

// ---------- analysis (admin): rule-based checks from the database, reviewed by an admin ----------
const RULES = {
  missed_call_not_returned: { label: 'Missed call not returned', why: 'Return missed calls and voicemails quickly — customers who call usually want something now.' },
  text_not_answered: { label: 'Text not answered', why: 'Reply to customer texts within the target time; only the first text of a burst is measured.' },
  opt_out_ignored: { label: 'Opt-out ignored', why: 'If a customer texts STOP / unsubscribe / "don\'t text me", never contact them again (compliance).' },
  over_contacting: { label: 'Over-contacting', why: 'Too many attempts in one day without any reply feels like spam — space them out.' },
  no_follow_up: { label: 'No follow-up', why: 'A single unanswered attempt is rarely enough — follow up after the set hours.' },
  quiet_hours: { label: 'Quiet hours', why: 'Don\'t call or text customers late at night or early morning in their timezone.' },
  very_short_call: { label: 'Very short call', why: 'Picked-up calls that end in a few seconds usually mean a hang-up or a bot — check the opener.' },
};
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
let anFilter = { status: 'open', severity: '', rule: '' };

const scoreTone = (s) => (s >= 85 ? 'g' : s >= 60 ? 'y' : 'r');

async function renderAnalysis(view) {
  const args = { p_from: state.from, p_to: state.to, p_agent: state.agent || null };
  const [cards, issues] = await Promise.all([rpc('analysis_scorecard', args), rpc('analysis_issues', args)]);
  const r = state.settings.analysis_rules || {};
  const counts = {};
  issues.forEach((i) => { if (i.status === 'open') counts[i.rule] = (counts[i.rule] || 0) + 1; });
  const shown = issues.filter((i) => (!anFilter.status || i.status === anFilter.status)
    && (!anFilter.severity || i.severity === anFilter.severity) && (!anFilter.rule || i.rule === anFilter.rule));
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;

  view.innerHTML = `
    <div class="section-title"><h2>Analysis</h2>
      <span class="small">Rule-based checks from Voice activity · targets: reply ${r.reply_target_min ?? 15} min · call back ${r.callback_target_min ?? 60} min · change in Settings</span></div>

    <div class="kpis">${cards.map((c) => kpi(esc(c.agent_name), `${c.score}<span class="small"> /100</span>`,
      `${n(c.high_open)} high · ${n(c.medium_open)} medium · ${n(c.low_open)} low open`, { tone: scoreTone(c.score), icon: ICON.check })).join('') || '<div class="empty">No active agents</div>'}</div>

    <div class="card"><h3>Agent scorecard</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Agent</th><th class="num">Score</th><th class="num">Customer texts</th><th class="num">Replied on time</th><th class="num">Median reply</th>
          <th class="num">Missed calls</th><th class="num">Returned on time</th><th class="num">Opt-out violations</th><th class="num">Open issues</th><th class="num">Reviewed</th><th class="num">Dismissed</th></tr></thead>
        <tbody>${cards.map((c) => `<tr>
          <td>${esc(c.agent_name)}</td>
          <td class="num"><b style="color:var(--${scoreTone(c.score) === 'g' ? 'green' : scoreTone(c.score) === 'y' ? 'yellow' : 'red'})">${c.score}</b></td>
          <td class="num">${n(c.customer_texts)}</td><td class="num">${c.replied_on_time_pct == null ? '—' : `${c.replied_on_time_pct}%`}</td>
          <td class="num">${mins(c.median_reply_min == null ? null : Number(c.median_reply_min))}</td>
          <td class="num">${n(c.missed_calls)}</td><td class="num">${c.returned_on_time_pct == null ? '—' : `${c.returned_on_time_pct}%`}</td>
          <td class="num">${c.opt_out_violations ? `<b style="color:var(--red)">${n(c.opt_out_violations)}</b>` : 0}</td>
          <td class="num">${n(Number(c.high_open) + Number(c.medium_open) + Number(c.low_open))}</td><td class="num">${n(c.reviewed)}</td><td class="num">${n(c.dismissed)}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="small">Score = 100 − 8 per high, 4 per medium, 1 per low issue in the period. Dismissed issues don't count; reviewed ones still do (they happened).</p>
    </div>

    <div class="card">
      <div class="section-title"><h3>Issues to check</h3>
        <div class="row" style="align-items:center">
          <select id="fStatus">${opt('open', anFilter.status, 'Open')}${opt('reviewed', anFilter.status, 'Reviewed')}${opt('dismissed', anFilter.status, 'Dismissed')}${opt('', anFilter.status, 'All')}</select>
          <select id="fSev">${opt('', anFilter.severity, 'All severities')}${opt('high', anFilter.severity, 'High')}${opt('medium', anFilter.severity, 'Medium')}${opt('low', anFilter.severity, 'Low')}</select>
          <select id="fRule">${opt('', anFilter.rule, 'All rules')}${Object.entries(RULES).map(([k, v]) => opt(k, anFilter.rule, `${v.label}${counts[k] ? ` (${counts[k]})` : ''}`)).join('')}</select>
          <button class="btn dark" id="aCsv">Download (CSV)</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Severity</th><th>Rule</th><th>Agent</th><th>Contact</th><th>When</th><th>Detail</th><th>Status</th><th></th></tr></thead>
        <tbody>${shown.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Date.parse(b.occurred_at) - Date.parse(a.occurred_at)).map((i) => `
          <tr data-key="${esc(i.issue_key)}">
            <td><span class="badge ${i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : ''}">${i.severity}</span></td>
            <td>${esc(RULES[i.rule]?.label || i.rule)}</td>
            <td>${esc(i.agent_name)}</td>
            <td>${i.conversation_id ? `<a href="#/conversations/${i.conversation_id}">${esc(i.contact || '—')}</a>` : esc(i.contact || '—')}</td>
            <td>${fmtTime(i.occurred_at)}</td>
            <td style="white-space:normal;min-width:220px">${esc(i.detail)}${i.note ? `<div class="small muted">Note: ${esc(i.note)}</div>` : ''}</td>
            <td>${i.status === 'open' ? '<span class="small">open</span>' : `<span class="small">${esc(i.status)}${i.reviewed_by ? ` by ${esc(i.reviewed_by)}` : ''}<br>${ago(i.reviewed_at)}</span>`}</td>
            <td style="white-space:nowrap">${i.status === 'open'
              ? '<button class="btn dark aRev">✓ Reviewed</button> <button class="btn dark aDis">Dismiss</button>'
              : '<button class="btn dark aReopen">Reopen</button>'}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing to check here 🎉</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card"><h3>Rules &amp; best practices</h3>
      <ul class="insights">${Object.entries(RULES).map(([k, v]) => `<li><b style="color:var(--text)">${v.label}</b> — ${esc(v.why)}</li>`).join('')}</ul>
    </div>`;

  const reload = () => renderAnalysis(view);
  $('#fStatus').addEventListener('change', (e) => { anFilter.status = e.target.value; reload(); });
  $('#fSev').addEventListener('change', (e) => { anFilter.severity = e.target.value; reload(); });
  $('#fRule').addEventListener('change', (e) => { anFilter.rule = e.target.value; reload(); });
  $('#aCsv').addEventListener('click', () => downloadCsv(shown, `coco-analysis-${state.from}-to-${state.to}.csv`,
    ['severity', 'rule', 'agent_name', 'contact', 'occurred_at', 'detail', 'delay_min', 'status', 'note', 'reviewed_by', 'reviewed_at']));

  const review = async (key, status) => {
    const note = status === 'dismissed' ? prompt('Why dismiss this issue? (optional note)') : prompt('Note for this review (optional)');
    if (note === null) return; // cancelled
    const { error } = await sb.from('analysis_reviews').upsert({ issue_key: key, status, note: note.trim() || null, reviewed_at: new Date().toISOString() }, { onConflict: 'issue_key' });
    if (error) return toast(error.message);
    toast(status === 'reviewed' ? 'Marked as reviewed' : 'Dismissed');
    reload();
  };
  view.querySelectorAll('tr[data-key]').forEach((tr) => {
    const key = tr.dataset.key;
    $('.aRev', tr)?.addEventListener('click', () => review(key, 'reviewed'));
    $('.aDis', tr)?.addEventListener('click', () => review(key, 'dismissed'));
    $('.aReopen', tr)?.addEventListener('click', async () => {
      const { error } = await sb.from('analysis_reviews').delete().eq('issue_key', key);
      if (error) return toast(error.message);
      reload();
    });
  });
}

// ---------- conversations (admin only): one row per contact, every call + text inside ----------
const OUTCOME = { connected: 'picked up (person, voicemail or bot)', no_answer: 'no answer', answered: 'answered', missed: 'missed', voicemail: 'went to voicemail', rejected: 'declined', unknown: 'unknown' };
const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s || 0}s`);
const plural = (k, word) => `${n(k)} ${word}${Number(k) === 1 ? '' : 's'}`;

async function renderConversations(view, selected) {
  view.innerHTML = `
    <div class="section-title"><h2>Conversations</h2><input id="search" placeholder="Search number, name or text" style="max-width:300px"></div>
    <div class="convo"><div class="list" id="clist"></div><div class="card" id="detail"><div class="empty">Select a contact</div></div></div>`;
  // older links point at one Voice thread id: map it to that thread's agent + contact
  if (selected && /^[0-9a-f-]{36}$/.test(selected)) {
    const { data } = await sb.from('conversations').select('agent_id, contact_id').eq('id', selected).maybeSingle();
    if (data) selected = `${data.agent_id}~${data.contact_id || ''}`;
  }
  let list = [];
  const load = async () => {
    list = await rpc('contact_threads', { p_from: state.from, p_to: state.to, p_agent: state.agent || null, p_search: $('#search').value.trim() || null });
    $('#clist').innerHTML = list.map((c) => {
      const key = `${c.agent_id}~${c.contact_id || ''}`;
      const calls = Number(c.calls_out) + Number(c.calls_in);
      const texts = Number(c.texts_out) + Number(c.texts_in);
      const parts = [];
      if (calls) parts.push(`${plural(calls, 'call')}${Number(c.calls_out) ? ` (${n(c.picked_up)} picked up · ${n(c.conversations)} conv.)` : ''}`);
      if (texts) parts.push(`${plural(texts, 'text')} (${n(c.texts_out)} out · ${n(c.texts_in)} in)`);
      if (Number(c.voicemails)) parts.push(plural(c.voicemails, 'voicemail'));
      return `
      <div class="item ${key === selected ? 'on' : ''}" data-key="${key}">
        <div class="item-top"><b>${esc(c.contact_name || c.contact || 'Group / unknown')}</b><span class="small muted">${fmtTime(c.last_activity_at)}</span></div>
        <div class="small">${parts.join(' · ') || 'no activity'}</div>
        <div class="snip muted">${esc(c.agent_name)}${c.last_text ? ` · ${esc(c.last_text)}` : ''}</div>
      </div>`;
    }).join('') || '<div class="empty">No conversations in this period</div>';
    $('#clist').querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => { location.hash = `#/conversations/${el.dataset.key}`; }));
  };
  let timer;
  $('#search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  await load();
  if (selected) await renderDetail(selected, list.find((c) => `${c.agent_id}~${c.contact_id || ''}` === selected));
}

async function renderDetail(key, head) {
  const [agentId, contactId] = key.split('~');
  const items = await rpc('contact_timeline', { p_agent: agentId, p_contact: contactId || null });
  // private audio (voicemails / recorded calls): short-lived signed links, admins only (storage policy)
  const paths = items.map((i) => i.recording_path).filter(Boolean);
  const signed = paths.length ? ((await sb.storage.from('recordings').createSignedUrls(paths, 3600)).data || []) : [];
  const audioUrl = Object.fromEntries(signed.filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
  const player = (it) => (audioUrl[it.recording_path] ? `<audio class="rec" controls preload="none" src="${esc(audioUrl[it.recording_path])}"></audio>` : '');
  const calls = items.filter((i) => i.kind === 'call');
  const out = calls.filter((c) => c.direction === 'outbound');
  const stat = (label, v) => `<div class="stat"><div class="value">${v}</div><div class="small muted">${label}</div></div>`;
  let lastDay = '';
  const rows = items.map((it) => {
    const day = fmtDay(dayKeyIso(it.occurred_at));
    const sep = day !== lastDay ? `<div class="daysep">${esc(day)}</div>` : '';
    lastDay = day;
    const time = new Date(it.occurred_at).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' });
    if (it.kind === 'call') {
      const o = it.direction === 'outbound';
      const cls = it.outcome === 'no_answer' || it.outcome === 'missed' ? 'bad' : it.conversation ? 'good' : '';
      return `${sep}<div class="callrow ${cls}"><span class="ci">${o ? ICON.callOut : ICON.callIn}</span>
        <div><b>${o ? 'Outgoing' : 'Incoming'} call</b> · ${esc(OUTCOME[it.outcome] || it.outcome || 'unknown')}${it.conversation ? ' · <span class="badge good">conversation</span>' : ''}
        <div class="small muted">${time} · ${it.duration_sec ? dur(it.duration_sec) : '0s'}</div>
        ${it.body ? `<div class="small">${esc(it.body)}</div>` : ''}${player(it)}</div></div>`;
    }
    return `${sep}<div class="bubble ${it.direction === 'outbound' ? 'out' : ''}">
      ${it.kind === 'voicemail' ? '<b>Voicemail</b> ' : ''}${esc(it.body || (it.kind === 'voicemail' ? '(no transcript)' : '(no text)'))}
      ${player(it)}<div class="meta">${it.direction === 'outbound' ? 'Sent' : 'Received'} · ${time}${it.kind === 'voicemail' && !it.recording_path ? ' · audio not saved yet' : ''}</div></div>`;
  }).join('');
  const texts = (dir) => n(items.filter((i) => i.kind === 'text' && i.direction === dir).length);
  $('#detail').innerHTML = `
    <div class="section-title"><h3>${esc(head?.contact_name || head?.contact || 'Contact')}</h3><span class="small muted">${esc(head?.agent_name || '')} · full history</span></div>
    <div class="stats">
      ${stat('calls out', n(out.length))}${stat('picked up', n(out.filter((c) => c.duration_sec > 0).length))}
      ${stat('conversations', n(out.filter((c) => c.conversation).length))}${stat('no answer', n(out.filter((c) => !c.duration_sec).length))}
      ${stat('talk time', dur(calls.reduce((s, c) => s + (c.duration_sec || 0), 0)))}
      ${stat('texts out / in', `${texts('outbound')} / ${texts('inbound')}`)}
      ${stat('calls in', n(calls.length - out.length))}${stat('voicemails', n(items.filter((i) => i.kind === 'voicemail').length))}
    </div>
    <div class="timeline">${rows || '<div class="empty">Empty</div>'}</div>`;
}

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
    const { error } = await sb.auth.updateUser({ password: a, data: { must_change_password: false } });
    $('#acctMsg').textContent = error ? friendly(error) : 'Password saved. A confirmation email is on its way.';
    if (!error) e.target.reset();
  });
}

// ---------- settings (admin) ----------
/** Call the `team` Edge Function (create / reset / set_role / remove users). */
async function team(body) {
  const { data, error } = await sb.functions.invoke('team', { body });
  if (error) {
    let m = error.message;
    try { m = (await error.context.json()).error || m; } catch { /* keep generic message */ }
    throw new Error(m);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

const ROLE_LABEL = { admin: 'Admin', agent: 'Agent' };
const copyBtn = (id, value) => {
  const b = document.getElementById(id);
  b?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); b.textContent = 'Copied ✓'; } catch { toast('Select the text and copy it manually'); }
  });
};

/** Extension health/diagnostics reported with each sync (no message content). */
function diagHtml(a) {
  const h = a.last_health || {};
  const net = Object.entries(h.net || {}).sort((x, y) => y[1] - x[1]).slice(0, 12);
  const row = (k, v) => `<tr><td class="muted">${esc(k)}</td><td>${v}</td></tr>`;
  return `<div class="two"><div class="table-wrap"><table class="wrap"><tbody>
      ${row('Status', esc(h.status || '—'))}
      ${row('Extension / parser', `${esc(h.extensionVersion || '?')} / ${esc(h.parserVersion || a.parser_version || '?')}`)}
      ${row('Last check-in', a.last_heartbeat_at ? `${fmtTime(a.last_heartbeat_at)} (${ago(a.last_heartbeat_at)})` : 'never')}
      ${row('Voice page loaded', h.pageLoadAt ? ago(new Date(h.pageLoadAt).toISOString()) : '—')}
      ${row('Voice data read since page load', n(h.capturesSinceLoad))}
      ${row('Voice API calls seen since page load', n(h.apiSinceLoad))}
      ${row('Total responses read / events parsed', `${n(h.captures)} / ${n(h.parsed)} (unclassified ${n(h.unknown)})`)}
      ${row('Last data read', h.lastCaptureAt ? ago(new Date(h.lastCaptureAt).toISOString()) : 'never')}
      ${row('Needs Voice reload', h.needsVoiceReload ? '<b style="color:var(--yellow)">yes</b>' : 'no')}
    </tbody></table></div>
    <div><div class="small muted">Google endpoints the Voice page called (count)</div>
      <table><tbody>${net.map(([k, v]) => `<tr><td class="small" style="white-space:normal;word-break:break-all">${esc(k)}</td><td class="num">${n(v)}</td></tr>`).join('') || '<tr><td class="muted small">none reported yet</td></tr>'}</tbody></table></div></div>`;
}

async function renderSettings(view) {
  const [{ data: agents }, users] = await Promise.all([
    sb.from('agents').select('id, name, email, gv_number, active, tracking_start, last_heartbeat_at, last_health, parser_version, token_hint').order('name'),
    rpc('list_users', {}),
  ]);
  const s = state.settings;
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const agentName = (id) => (agents || []).find((a) => a.id === id)?.name || '';
  const isMe = (u) => u.user_id === state.user.id;

  view.innerHTML = `
    <div class="section-title"><h2>Settings</h2></div>

    <div class="card"><h3>Dashboard users</h3>
      <p class="small"><b>Admin</b> sees everything (all agents, contacts, conversations). <b>Agent</b> sees only their own numbers — no other agents, no message text.
      Create logins here — no email needed: each new user gets a temporary password (shown once) and must choose their own password at first sign-in.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>User</th><th>Role</th><th>Tracking agent</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${(users || []).map((u) => `<tr data-uid="${u.user_id}" data-email="${esc(u.email)}">
          <td>${esc(u.name || '')}<div class="small muted">${esc(u.email)}${isMe(u) ? ' · you' : ''}</div></td>
          <td>${isMe(u) ? 'Admin' : `<select class="uRoleSel">${opt('agent', u.role === 'admin' ? 'admin' : 'agent', 'Agent')}${opt('admin', u.role === 'admin' ? 'admin' : 'agent', 'Admin')}</select>`}</td>
          <td>${isMe(u) ? '—' : `<select class="uAgentSel"><option value="">—</option>${(agents || []).map((a) => opt(a.id, u.agent_id, a.name)).join('')}</select>`}</td>
          <td>${u.last_sign_in_at ? ago(u.last_sign_in_at) : '<span class="small muted">never</span>'}${u.must_change_password ? '<div class="small muted">temporary password</div>' : ''}</td>
          <td style="white-space:nowrap">${isMe(u) ? '' : '<button class="btn dark uSave">Save</button> <button class="btn dark uReset">Reset password</button> <button class="btn dark uRemove">Remove</button>'}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No users yet</td></tr>'}</tbody>
      </table></div>

      <h3 style="margin-top:18px;font-size:16px">Create user</h3>
      <div class="row">
        <div><label>Name</label><input id="cName" placeholder="e.g. Sarah Khan"></div>
        <div><label>Email</label><input id="cEmail" type="email" placeholder="name@company.com"></div>
        <div><label>Role</label><select id="cRole"><option value="agent" selected>Agent (own numbers only)</option><option value="admin">Admin (everything)</option></select></div>
      </div>
      <div class="row" id="cAgentRow">
        <div><label>Tracking</label><select id="cAgentMode">
          <option value="new">Create a tracking agent + extension token</option>
          ${(agents || []).map((a) => `<option value="${a.id}">Link to existing agent: ${esc(a.name)}</option>`).join('')}
        </select></div>
        <div><label>Google Voice account</label><input value="Business (Google Workspace)" disabled></div>
      </div>
      <div class="row"><div><button class="btn" id="createUser">Create user</button></div></div>
      <div id="credOut"></div>
    </div>

    <div class="card"><h3>Agents (Google Voice business numbers)</h3>
      <p class="small">One agent = one person / Voice number. The agent pastes their token into the Coco Voice extension (Settings → Connect) — no other setup.
      Tracking starts the moment they connect (no old history). Tokens are shown once and stored only as a hash; use <b>New token</b> if one is lost or a laptop changes hands.</p>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Extension</th><th>Voice number</th><th>Token</th><th>Tracking since</th><th>Active</th><th></th></tr></thead>
      <tbody>${(agents || []).map((a) => `<tr data-id="${a.id}">
        <td><input class="aName" value="${esc(a.name)}"><div class="small muted">${esc(a.email || '')}</div></td>
        <td>${connBadge(a)}</td>
        <td>${esc(a.gv_number || 'detected on first sync')}</td>
        <td class="small">${a.token_hint ? `…${esc(a.token_hint)}` : '—'}</td>
        <td>${a.tracking_start ? fmtTime(a.tracking_start) : 'when connected'}</td>
        <td><input type="checkbox" class="aActive" ${a.active ? 'checked' : ''} style="width:auto"></td>
        <td style="white-space:nowrap"><button class="btn dark aSave">Save</button> <button class="btn dark aRotate">New token</button> <button class="btn dark aDiag">Diagnostics</button></td></tr>
        <tr class="diag" data-for="${a.id}" hidden><td colspan="7">${diagHtml(a)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No agents yet — create an Agent user above, or add a tracking-only agent below.</td></tr>'}</tbody></table></div>
      <div class="row" style="margin-top:12px">
        <div><label>Name</label><input id="nName" placeholder="tracking-only agent (no login)"></div>
        <div><label>Email</label><input id="nEmail" type="email" placeholder="optional"></div>
        <div><button class="btn dark" id="addAgent">Add agent &amp; create token</button></div>
      </div>
      <div id="tokenOut"></div>
    </div>

    <div class="card"><h3>Business</h3>
      <div class="row">
        <div><label>Business timezone</label><select id="sTz">${Object.entries(TZ_NAMES).map(([k, v]) => opt(k, s.business_timezone, `${v} (${k})`)).join('')}</select></div>
        <div><label>Keep data (days)</label><input id="sRet" type="number" min="30" value="${s.retention_days}"></div>
        <div><label>Claude analysis</label><input value="On hold" disabled></div>
      </div>
      <h3 style="margin-top:18px;font-size:16px">Analysis rules</h3>
      <div class="row">
        <div><label>Reply to texts within (min)</label><input id="rReply" type="number" min="1" value="${s.analysis_rules?.reply_target_min ?? 15}"></div>
        <div><label>Return missed calls within (min)</label><input id="rCb" type="number" min="1" value="${s.analysis_rules?.callback_target_min ?? 60}"></div>
        <div><label>Follow up after (hours)</label><input id="rFu" type="number" min="1" value="${s.analysis_rules?.followup_after_hours ?? 48}"></div>
        <div><label>Max unanswered / contact / day</label><input id="rMax" type="number" min="1" value="${s.analysis_rules?.max_unanswered_per_day ?? 3}"></div>
      </div>
      <div class="row">
        <div><label>Quiet hours start</label><input id="rQs" type="time" value="${s.analysis_rules?.quiet_start ?? '21:00'}"></div>
        <div><label>Quiet hours end</label><input id="rQe" type="time" value="${s.analysis_rules?.quiet_end ?? '08:00'}"></div>
        <div><label>Customer timezone (quiet hours)</label><select id="rQtz">${Object.entries(TZ_NAMES).map(([k, v]) => opt(k, s.analysis_rules?.quiet_tz ?? 'America/New_York', `${v} (${k})`)).join('')}</select></div>
        <div><label>Very short call under (sec)</label><input id="rShort" type="number" min="1" value="${s.analysis_rules?.short_call_sec ?? 15}"></div>
        <div><label>Conversation = call of at least (sec)</label><input id="rConv" type="number" min="10" value="${s.analysis_rules?.conversation_sec ?? 60}"></div>
      </div>
      <div class="row"><div><button class="btn" id="saveSettings">Save</button></div></div>
    </div>`;

  // ---- credentials card (shown once) ----
  const showCreds = ({ email, name, role, password, token }) => {
    const msg = [
      `Coco Voice dashboard: ${location.origin}`,
      `Email: ${email}`,
      `Temporary password: ${password}`,
      ...(token ? [`Extension token: ${token}`, 'Extension: click the Coco icon → Settings → paste token → Connect.'] : []),
      'You will be asked to choose your own password at first sign-in.',
    ].join('\n');
    $('#credOut').innerHTML = `
      <div class="card token-card">
        <h3>${esc(name || email)} · ${esc(ROLE_LABEL[role] || role)}</h3>
        <p class="small">Shown only once. Send it to the person privately (not in a group chat).</p>
        <label>Email</label><div class="token-row"><div class="token">${esc(email)}</div></div>
        <label>Temporary password</label><div class="token-row"><div class="token">${esc(password)}</div><button class="btn" id="cpPw">Copy</button></div>
        ${token ? `<label>Extension token</label><div class="token-row"><div class="token">${esc(token)}</div><button class="btn" id="cpTok">Copy</button></div>` : ''}
        <button class="btn dark" id="cpAll" style="margin-top:8px">Copy all as a message</button>
      </div>`;
    copyBtn('cpPw', password);
    if (token) copyBtn('cpTok', token);
    copyBtn('cpAll', msg);
    $('#credOut').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const syncAgentRow = () => { $('#cAgentRow').hidden = $('#cRole').value !== 'agent'; };
  $('#cRole').addEventListener('change', syncAgentRow);
  syncAgentRow();

  $('#createUser').addEventListener('click', async (e) => {
    const email = $('#cEmail').value.trim();
    const name = $('#cName').value.trim();
    const role = $('#cRole').value;
    const mode = $('#cAgentMode').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Enter a valid email');
    e.target.disabled = true;
    try {
      const r = await team({ action: 'create', email, name, role, agent_id: role === 'agent' && mode !== 'new' ? mode : null });
      await renderSettings(view);
      showCreds({ email, name, role, password: r.temp_password, token: r.agent_token });
    } catch (err) { toast(err.message); e.target.disabled = false; }
  });

  view.querySelectorAll('tr[data-uid]').forEach((tr) => {
    const uid = tr.dataset.uid;
    const email = tr.dataset.email;
    $('.uSave', tr)?.addEventListener('click', async () => {
      try { await team({ action: 'set_role', user_id: uid, role: $('.uRoleSel', tr).value, agent_id: $('.uAgentSel', tr).value || null }); toast('Saved'); } catch (err) { toast(err.message); }
    });
    $('.uReset', tr)?.addEventListener('click', async () => {
      if (!confirm(`Reset the password for ${email}? Their current password stops working.`)) return;
      try {
        const r = await team({ action: 'reset_password', user_id: uid });
        showCreds({ email, name: '', role: $('.uRoleSel', tr)?.value || 'agent', password: r.temp_password });
      } catch (err) { toast(err.message); }
    });
    $('.uRemove', tr)?.addEventListener('click', async () => {
      if (!confirm(`Remove ${email}? They can no longer sign in. Their tracked activity stays in reports.`)) return;
      try { await team({ action: 'remove', user_id: uid }); toast('User removed'); renderSettings(view); } catch (err) { toast(err.message); }
    });
  });

  $('#saveSettings').addEventListener('click', async () => {
    const num = (id, min = 1) => Math.max(min, Number($(id).value) || min);
    const upd = {
      business_timezone: $('#sTz').value, retention_days: Number($('#sRet').value), updated_at: new Date().toISOString(),
      analysis_rules: {
        reply_target_min: num('#rReply'), callback_target_min: num('#rCb'), followup_after_hours: num('#rFu'),
        max_unanswered_per_day: num('#rMax'), quiet_start: $('#rQs').value || '21:00', quiet_end: $('#rQe').value || '08:00',
        quiet_tz: $('#rQtz').value, short_call_sec: num('#rShort'), conversation_sec: num('#rConv'),
      },
    };
    const { data, error } = await sb.from('app_settings').update(upd).eq('id', 1).select().single();
    if (error) return toast(error.message);
    state.settings = data;
    $('#tzLabel').textContent = `${TZ_NAMES[tz()] || tz()} time`;
    toast('Settings saved');
  });
  const showToken = (name, token) => {
    $('#tokenOut').innerHTML = `
      <div class="card token-card">
        <h3>Token for ${esc(name)}</h3>
        <p class="small">Copy it now — it is shown only once. Send it to the agent privately (not in a group chat).</p>
        <div class="token-row"><div class="token">${esc(token)}</div><button class="btn" id="tokCopy">Copy</button></div>
        <ol class="small">
          <li>Agent installs the Coco Voice extension in Chrome.</li>
          <li>Clicks the extension → <b>Settings</b> → pastes the token → <b>Connect</b>. It shows "Connected as ${esc(name)}". Tracking starts now.</li>
          <li>Keeps the Google Voice (business account) tab open. Status here turns green within a few minutes.</li>
        </ol>
      </div>`;
    copyBtn('tokCopy', token);
    $('#tokenOut').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('#addAgent').addEventListener('click', async () => {
    const name = $('#nName').value.trim();
    if (!name) return toast('Name is required');
    try {
      const r = await rpc('create_agent', { p_name: name, p_email: $('#nEmail').value.trim(), p_account_type: 'workspace' });
      await renderSettings(view);
      showToken(name, r.token);
    } catch (e) { toast(e.message); }
  });
  view.querySelectorAll('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    $('.aSave', tr).addEventListener('click', async () => {
      try { await rpc('update_agent', { p_agent: id, p_name: $('.aName', tr).value, p_account_type: 'workspace', p_active: $('.aActive', tr).checked }); toast('Saved'); } catch (e) { toast(e.message); }
    });
    $('.aDiag', tr).addEventListener('click', () => { const d = view.querySelector(`tr.diag[data-for="${id}"]`); d.hidden = !d.hidden; });
    $('.aRotate', tr).addEventListener('click', async () => {
      if (!confirm('Generate a new token? The old one stops working immediately.')) return;
      try { showToken($('.aName', tr).value, await rpc('rotate_agent_token', { p_agent: id })); } catch (e) { toast(e.message); }
    });
  });
}

start();

document.querySelectorAll('.cy').forEach((e) => { e.textContent = String(new Date().getFullYear()); });
