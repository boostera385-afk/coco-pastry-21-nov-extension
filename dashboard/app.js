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

const state = { user: null, role: null, agentId: null, settings: null, agents: [], range: '7d', from: null, to: null, fromTs: null, toTs: null, agent: '' };
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

/** UTC ISO time for a wall-clock date + time in the business timezone. */
function zoned(key, hhmm = '00:00') {
  const [y, m, d] = key.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asUtc - guess)).toISOString();
}

/**
 * Range presets. Whole days use Pakistan-time midnights (state.from/to); hour ranges and custom times also
 * set exact instants (state.fromTs/toTs, end exclusive) that override the day boundaries on the server.
 */
function computeRange() {
  const now = Date.now();
  const today = dayKey(now);
  state.fromTs = null; state.toTs = null;
  const rolling = (h) => { state.fromTs = new Date(now - h * 3600e3).toISOString(); state.toTs = new Date(now + 60e3).toISOString(); state.from = dayKey(now - h * 3600e3); state.to = today; };
  switch (state.range) {
    case '1h': rolling(1); break;
    case '4h': rolling(4); break;
    case 'today': state.from = today; state.to = today; break;
    case 'yesterday': state.from = addDays(today, -1); state.to = state.from; break;
    case '7d': state.from = addDays(today, -6); state.to = today; break;
    case '30d': state.from = addDays(today, -29); state.to = today; break;
    case 'month': state.from = `${today.slice(0, 8)}01`; state.to = today; break;
    case 'shift': {
      const w = shiftWindow(isMgr() ? state.agent : state.agentId);
      if (!w) { state.from = today; state.to = today; break; }
      state.fromTs = w[0]; state.toTs = w[1]; state.from = dayKey(Date.parse(w[0])); state.to = dayKey(Math.min(Date.parse(w[1]), now) - 1);
      if (state.to < state.from) state.to = state.from;
      break;
    }
    case 'custom': {
      state.from = $('#from').value || today;
      state.to = $('#to').value || state.from;
      if (state.to < state.from) [state.from, state.to] = [state.to, state.from];
      const ft = $('#fromT').value || '00:00';
      const tt = $('#toT').value || '23:59';
      if (ft !== '00:00' || tt !== '23:59') { state.fromTs = zoned(state.from, ft); state.toTs = new Date(Date.parse(zoned(state.to, tt)) + 60e3).toISOString(); }
      break;
    }
    default: state.from = addDays(today, -6); state.to = today;
  }
}
/** Latest shift (in progress or last finished) of an agent, as [startIso, endIso]; null when no shift is set. */
function shiftWindow(agentId) {
  const a = state.agents.find((x) => x.id === agentId);
  if (!a?.shift_start || !a?.shift_end) return null;
  const today = dayKey(Date.now());
  const days = a.shift_days?.length ? a.shift_days : [1, 2, 3, 4, 5];
  for (let k = 0; k <= 8; k++) {
    const day = addDays(today, -k);
    const dow = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; // ISO 1 = Mon
    if (!days.includes(dow)) continue;
    const s0 = zoned(day, a.shift_start.slice(0, 5));
    const overnight = a.shift_end.slice(0, 5) <= a.shift_start.slice(0, 5);
    const s1 = zoned(overnight ? addDays(day, 1) : day, a.shift_end.slice(0, 5));
    if (Date.parse(s0) <= Date.now()) return [s0, s1];
  }
  return null;
}
const fmtShift = (a) => (a?.shift_start ? `${a.shift_start.slice(0, 5)}–${a.shift_end.slice(0, 5)}` : '');
/** The period just before the current one, same length (partial "today/this month" compare to the same elapsed time). */
function prevRangeArgs() {
  if (state.fromTs) {
    const a = Date.parse(state.fromTs); const b = Math.min(Date.parse(state.toTs), Date.now() + 60e3); const len = b - a;
    return { p_from: dayKey(a - len), p_to: dayKey(a - 1), p_from_ts: new Date(a - len).toISOString(), p_to_ts: state.fromTs };
  }
  const days = Math.round((Date.parse(state.to) - Date.parse(state.from)) / 864e5) + 1;
  const pf = addDays(state.from, -days); const pt = addDays(state.from, -1);
  if (state.to === dayKey(Date.now())) return { p_from: pf, p_to: pt, p_from_ts: zoned(pf), p_to_ts: new Date(Date.now() - days * 864e5).toISOString() };
  return { p_from: pf, p_to: pt };
}
/** Arguments every report RPC takes. */
const rangeArgs = () => ({ p_from: state.from, p_to: state.to, ...(state.fromTs ? { p_from_ts: state.fromTs, p_to_ts: state.toTs } : {}) });
/** Exact start/end instants of the current range (for the timeline chart). */
const rangeInstants = () => (state.fromTs ? [state.fromTs, state.toTs] : [zoned(state.from), zoned(addDays(state.to, 1))]);
const fmtClock = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' });
/** Human label of the current range, e.g. "Nov 23, 9:00 AM – 1:00 PM". */
function periodLabel() {
  if (state.fromTs) {
    const a = dayKey(Date.parse(state.fromTs)); const b = dayKey(Date.parse(state.toTs) - 60e3);
    const end = new Date(Date.parse(state.toTs) - (state.range === 'custom' ? 60e3 : 0)).toISOString();
    if (state.range === 'shift') {
      const a = state.agents.find((x) => x.id === (isMgr() ? state.agent : state.agentId));
      return `${a?.name ? `${a.name} · ` : ''}shift ${fmtDay(a0Key(state.fromTs))} ${fmtShift(a)}${Date.parse(state.toTs) > Date.now() ? ' (in progress)' : ''}`;
    }
    if (state.range === '1h' || state.range === '4h') return `Last ${state.range === '1h' ? 'hour' : '4 hours'} · since ${fmtClock(state.fromTs)}`;
    return a === b ? `${fmtDay(a)}, ${fmtClock(state.fromTs)} – ${fmtClock(end)}` : `${fmtDay(a)} ${fmtClock(state.fromTs)} – ${fmtDay(b)} ${fmtClock(end)}`;
  }
  return state.from === state.to ? fmtDay(state.from) : `${fmtDay(state.from)} – ${fmtDay(state.to)}`;
}
const a0Key = (iso) => dayKey(Date.parse(iso));
const rangeFile = () => (state.fromTs ? `${state.fromTs.slice(0, 16)}-to-${state.toTs.slice(0, 16)}`.replace(/:/g, '') : `${state.from}-to-${state.to}`);

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
  const [{ data: settings }, { data: agents }, ext] = await Promise.all([
    sb.from('app_settings').select('*').eq('id', 1).single(),
    sb.from('agents').select('id, name, active, shift_start, shift_end, shift_days, record_calls').order('name'),
    fetch('extension.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.ext = ext;
  state.settings = settings;
  state.agents = agents || [];

  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#meEmail').innerHTML = `<a href="#/account">${esc(state.user.email)}</a> · ${esc(state.role)}`;
  $('#tzLabel').textContent = `${TZ_NAMES[tz()] || tz()} time`;
  $('#agentFilter').innerHTML = '<option value="">All agents</option>'
    + state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}${a.active ? '' : ' (inactive)'}</option>`).join('');
  $('#agentFilter').hidden = !isMgr();

  const links = [['overview', 'Overview'], ...(isMgr() ? [['contacts', 'Contacts'], ['conversations', 'Conversations'], ['analysis', 'Analysis'], ['recordings', 'Recordings'], ['settings', 'Settings']] : []), ['extension', 'Extension'], ['account', 'Account']];
  $('#navLinks').innerHTML = links.map(([k, l]) => `<a href="#/${k}" data-k="${k}">${l}</a>`).join('');
  route();
  renderUpdateBanner().catch(() => {});
  showSetupGuide();
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
  if (b.dataset.r === 'shift' && !shiftWindow(isMgr() ? state.agent : state.agentId)) {
    return toast(isMgr() ? (state.agent ? 'No shift set for this agent — set it in Settings → Agents.' : 'Pick an agent first (shift times are per agent).') : 'No shift set for you yet — ask your admin.');
  }
  state.range = b.dataset.r;
  document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b));
  $('#customRange').hidden = state.range !== 'custom';
  if (state.range === 'custom' && !$('#from').value) { const t = dayKey(Date.now()); $('#from').value = t; $('#to').value = t; }
  saveRangePref();
  route();
});
['#from', '#to', '#fromT', '#toT'].forEach((s) => $(s).addEventListener('change', () => { saveRangePref(); route(); }));
// remember the chosen range on this browser (per-viewer convenience; safe if storage is blocked)
function saveRangePref() {
  try { localStorage.setItem('coco.range', JSON.stringify({ r: state.range, from: $('#from').value, to: $('#to').value, ft: $('#fromT').value, tt: $('#toT').value })); } catch { /* ignore */ }
}
(function loadRangePref() {
  try {
    const p = JSON.parse(localStorage.getItem('coco.range') || 'null');
    if (!p?.r || p.r === 'shift' || !document.querySelector(`#range [data-r="${p.r}"]`)) return;
    state.range = p.r;
    Object.assign($('#from'), { value: p.from || '' }); Object.assign($('#to'), { value: p.to || '' });
    $('#fromT').value = p.ft || '00:00'; $('#toT').value = p.tt || '23:59';
    document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x.dataset.r === p.r));
    $('#customRange').hidden = p.r !== 'custom';
  } catch { /* ignore */ }
}());
// rolling / today ranges refresh themselves every 2 minutes while the tab is visible (not while typing)
setInterval(() => {
  if (document.hidden || $('#app').hidden) return;
  if (document.activeElement?.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const page = location.hash.split('/')[1] || 'overview';
  if (!['1h', '4h', 'today', 'shift'].includes(state.range)) return;
  if (['overview', 'contacts', 'conversations', 'analysis'].includes(page) && !location.hash.split('/')[2]) route();
}, 120e3);
$('#agentFilter').addEventListener('change', (e) => {
  state.agent = e.target.value;
  if (state.range === 'shift' && !shiftWindow(state.agent)) { // shift preset needs an agent with a shift
    state.range = 'today';
    document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x.dataset.r === 'today'));
  }
  route();
});
window.addEventListener('hashchange', route);

async function route() {
  if (!state.role) return;
  computeRange();
  const [, page = 'overview', arg] = location.hash.split('/');
  document.querySelectorAll('#navLinks a').forEach((a) => a.classList.toggle('on', a.dataset.k === page));
  $('#filters').hidden = page === 'settings' || page === 'account' || page === 'extension';
  const view = $('#view');
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (page === 'conversations' && isMgr()) await renderConversations(view, arg);
    else if (page === 'contacts' && isMgr()) await renderContacts(view);
    else if (page === 'analysis' && isMgr()) await renderAnalysis(view);
    else if (page === 'recordings' && isMgr()) await renderRecordings(view);
    else if (page === 'settings' && isMgr()) await renderSettings(view);
    else if (page === 'account') await renderAccount(view);
    else if (page === 'extension') await renderExtension(view);
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
  if (t.missed_calls) out.push(['bad', `${n(t.missed_calls)} incoming call${t.missed_calls > 1 ? 's were' : ' was'} missed (no message left). Best practice: call back within 1 hour.`]);
  if (t.voicemails) out.push(['bad', `${n(t.voicemails)} voicemail${t.voicemails > 1 ? 's' : ''} received — listen in Conversations and call back within 1 hour.`]);
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
  if (best && best.outbound_total > 0 && daily.length > 1) {
    const hourly = bucketOf() === 'hour';
    const h = Number(best.bucket.slice(11, 13));
    out.push(['', hourly ? `Busiest hour: ${h % 12 || 12}${h < 12 ? 'am' : 'pm'} (${n(best.outbound_total)} outbound).` : `Busiest day: ${fmtDay(best.bucket.slice(0, 10))} (${n(best.outbound_total)} outbound).`]);
  }
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

/** Hourly buckets for ranges up to 2 days, otherwise daily. */
const bucketOf = () => { const [a, b] = rangeInstants(); return Date.parse(b) - Date.parse(a) <= 48 * 3600e3 ? 'hour' : 'day'; };
const bucketLabel = (k, hourly, multiDay) => {
  const day = fmtDay(k.slice(0, 10));
  if (!hourly) return day;
  const h = Number(k.slice(11, 13));
  const t = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  return multiDay ? `${day} ${t}` : t;
};

/** Group daily buckets into weeks (Mon–Sun) for long ranges. */
function weekly(daily) {
  const out = new Map();
  for (const d of daily) {
    const day = d.bucket.slice(0, 10);
    const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
    const k = addDays(day, -dow);
    const w = out.get(k) || { bucket: `${k}T00:00:00`, week: true };
    for (const f of ['outbound_total', 'inbound_total', 'outbound_calls', 'outbound_texts', 'inbound_calls', 'missed_calls', 'inbound_texts', 'voicemails']) w[f] = (w[f] || 0) + Number(d[f] || 0);
    out.set(k, w);
  }
  return [...out.values()];
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
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Outbound and inbound calls and texts over time">`;
  [0, max / 2, max].forEach((v) => { s += `<line x1="${P}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#262626"/><text x="${P - 6}" y="${y(v) + 4}" fill="#c0c0c0" font-size="10" text-anchor="end">${v}</text>`; });
  const hourly = bucketOf() === 'hour';
  const multiDay = new Set(daily.map((d) => d.bucket.slice(0, 10))).size > 1;
  daily.forEach((d, i) => {
    d.day = d.bucket.slice(0, 10);
    const lbl = d.week ? `Wk ${fmtDay(d.day)}` : bucketLabel(d.bucket, hourly, multiDay);
    const x = P + i * bw + bw / 2;
    const o = Number(d.outbound_total);
    const inb = Number(d.inbound_total);
    // a full-height transparent hit area per bucket makes small bars easy to click
    s += `<rect class="hit" data-b="${i}" x="${x - bw / 2}" y="0" width="${bw}" height="${H - P}" fill="transparent"><title>${lbl}: ${o} outbound (${d.outbound_calls} calls, ${d.outbound_texts} texts), ${inb} inbound — click for the list</title></rect>`;
    s += `<rect x="${x - bar - 1}" y="${y(o)}" width="${bar}" height="${H - P - y(o)}" fill="#ffba00" rx="2" pointer-events="none"/>`;
    s += `<rect x="${x + 1}" y="${y(inb)}" width="${bar}" height="${H - P - y(inb)}" fill="#00843d" rx="2" pointer-events="none"/>`;
    if (i % every === 0) s += `<text x="${x}" y="${H - 8}" fill="#c0c0c0" font-size="10" text-anchor="middle">${lbl}</text>`;
  });
  return `${s}</svg><div class="legend"><span><i style="background:#ffba00"></i>Outbound calls + texts</span><span><i style="background:#00843d"></i>Inbound calls + texts + voicemails</span><span class="muted">Click a bar for the list</span></div>`;
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
  talk: svg('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>'),
};
/** tone: 'y' outbound/primary, 'g' inbound/good, 'r' missed/alerts. drill = key for the click-through list. */
const kpi = (label, value, sub = '', { hero = false, tone = 'y', icon = ICON.check, drill = '' } = {}) =>
  `<div class="card kpi ${tone}${hero ? ' hero' : ''}${drill ? ' click' : ''}"${drill ? ` data-drill="${drill}" role="button" tabindex="0" title="Click to see the list"` : ''}><div class="ico">${icon}</div>`
  + `<div class="txt"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div></div>`;

/** "▲ 12%" vs the previous period. Up = good unless invert (e.g. missed calls). */
function delta(cur, prev, { invert = false, what = '' } = {}) {
  cur = Number(cur || 0); prev = Number(prev || 0);
  if (!cur && !prev) return '';
  if (!prev) return `<span class="delta ${invert ? 'down' : 'up'}" title="None in the previous period">new${what}</span>`;
  const p = Math.round(((cur - prev) / prev) * 100);
  if (!p) return `<span class="delta" title="Same as the previous period">±0%${what}</span>`;
  const good = invert ? p < 0 : p > 0;
  return `<span class="delta ${good ? 'up' : 'down'}" title="Previous period: ${n(prev)}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%${what}</span>`;
}
const hms = (sec) => { sec = Number(sec || 0); if (sec < 60) return `${Math.round(sec)}s`; const h = Math.floor(sec / 3600); const m = Math.round((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLbl = (h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

// Filters for click-through lists (rows from activity_log)
const DRILL = {
  outbound: ['Outbound calls + texts', (r) => r.direction === 'outbound' && r.channel !== 'voicemail'],
  calls_out: ['Outbound calls', (r) => r.channel === 'call' && r.direction === 'outbound'],
  texts_out: ['Texts sent', (r) => r.channel === 'text' && r.direction === 'outbound'],
  inbound: ['Inbound calls, texts and voicemails', (r) => r.direction === 'inbound'],
  calls_in: ['Incoming calls (incl. voicemails)', (r) => r.direction === 'inbound' && (r.channel === 'call' || r.channel === 'voicemail')],
  texts_in: ['Texts received', (r) => r.channel === 'text' && r.direction === 'inbound'],
  conv: ['Conversations (outbound, long enough)', (r) => r.channel === 'call' && r.direction === 'outbound' && r.conversation],
  short: ['Picked up but short (person, voicemail or bot)', (r) => r.channel === 'call' && r.direction === 'outbound' && /^picked/.test(r.outcome) && !r.conversation],
  no_answer: ['Outbound calls not answered', (r) => r.channel === 'call' && r.direction === 'outbound' && r.outcome === 'no answer'],
  answered: ['Incoming calls answered', (r) => r.channel === 'call' && r.direction === 'inbound' && r.outcome === 'answered'],
  missed: ['Missed incoming calls', (r) => r.channel === 'call' && r.direction === 'inbound' && r.outcome === 'missed'],
  voicemail: ['Voicemails', (r) => r.channel === 'voicemail'],
  talk: ['Calls with talk time', (r) => r.channel === 'call' && r.duration_sec > 0],
};

/** Click-through list: the exact calls / texts behind a number (Quo-style drill-down). */
async function openDrill(title, filter, args) {
  let dlg = $('#drill');
  if (!dlg) {
    dlg = Object.assign(document.createElement('dialog'), { id: 'drill', className: 'guide drill' });
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }
  const head = (extra = '') => `<div class="brand-stripe"><i></i><i></i><i></i></div><div class="section-title"><h3>${esc(title)}${extra}</h3><div class="row" style="align-items:center"><button class="btn dark" data-csv hidden>CSV</button><button class="btn dark" data-close>Close</button></div></div>`;
  dlg.innerHTML = `${head()}<div class="empty">Loading…</div>`;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  let rows;
  try { rows = (await rpc('activity_log', args)).filter(filter); } catch (e) { dlg.querySelector('.empty').textContent = e.message; return; }
  const shown = rows.slice(-500).reverse();
  dlg.innerHTML = `${head(` · ${n(rows.length)}`)}
    <div class="table-wrap"><table><thead><tr><th>Time</th>${isMgr() ? '<th>Agent</th>' : ''}<th>Contact</th><th>Type</th><th>Result</th><th class="num">Length</th></tr></thead>
    <tbody>${shown.map((r) => `<tr><td>${esc(r.local_time.slice(5, 16))}</td>${isMgr() ? `<td>${esc(r.agent_name)}</td>` : ''}<td>${esc(r.contact_name || r.contact || '—')}</td>
      <td>${r.direction === 'outbound' ? '↗' : '↙'} ${esc(r.channel)}</td><td class="small">${esc(r.outcome || '')}${r.conversation ? ' · conversation' : ''}</td><td class="num">${r.duration_sec ? dur(r.duration_sec) : ''}</td></tr>`).join('')
      || `<tr><td colspan="${isMgr() ? 6 : 5}" class="empty">Nothing here</td></tr>`}</tbody></table></div>
    ${rows.length > 500 ? '<p class="small muted">Showing the latest 500 — download the CSV for all.</p>' : ''}`;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  const csvBtn = dlg.querySelector('[data-csv]');
  csvBtn.hidden = !rows.length;
  csvBtn.onclick = () => downloadCsv(rows, `coco-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${rangeFile()}.csv`,
    ['local_time', 'agent_name', 'contact', 'contact_name', 'channel', 'direction', 'outcome', 'duration_sec', 'conversation']);
}

function outcomesCard(t, talkSec) {
  const seg = (label, v, color, drill) => (v > 0 ? `<button class="segm" style="flex:${v};background:${color}" data-drill="${drill}" title="${esc(label)}: ${n(v)} — click for the list"><span>${n(v)}</span></button>` : '');
  const bar = (title, total, parts) => `<div class="obar"><div class="obar-h"><b>${title}</b><span class="muted small">${n(total)}</span></div>
    <div class="stack">${total ? parts.map((p) => seg(...p)).join('') : '<span class="small muted">none</span>'}</div>
    <div class="legend">${parts.filter((p) => p[1] > 0).map(([l, v, c]) => `<span><i style="background:${c}"></i>${esc(l)} ${pct(v, total)}</span>`).join('')}</div></div>`;
  const short = Math.max(0, t.connected_calls - t.conversations);
  const answered = Math.max(0, t.inbound_calls - t.missed_calls - t.voicemails);
  return `<div class="card"><h3>Call outcomes</h3>
    ${bar('Outbound calls', t.outbound_calls, [['Conversation', t.conversations, '#00843d', 'conv'], ['Picked up, short', short, '#ffba00', 'short'], ['No answer', t.outbound_calls - t.connected_calls, '#555555', 'no_answer']])}
    ${bar('Incoming calls', t.inbound_calls, [['Answered', answered, '#00843d', 'answered'], ['Missed', t.missed_calls, '#cc3433', 'missed'], ['Voicemail', t.voicemails, '#ffba00', 'voicemail']])}
    <p class="small muted" style="margin:8px 0 0">Talk time ${hms(talkSec)} · picked up = a person, voicemail or bot answered (Voice can't tell which).</p></div>`;
}

function heatCard(heat, metric) {
  const val = (c) => Number(metric === 'outbound' ? Number(c.outbound_calls) + Number(c.outbound_texts) : metric === 'calls_in' ? c.inbound_calls : metric === 'missed' ? c.missed : c.total);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  heat.forEach((c) => { grid[c.dow - 1][c.hour] = val(c); });
  const max = Math.max(1, ...grid.flat());
  let best = null;
  grid.forEach((row, d) => row.forEach((v, h) => { if (v && (!best || v > best.v)) best = { d, h, v }; }));
  const color = metric === 'missed' ? '204,52,51' : metric === 'calls_in' ? '0,132,61' : '255,186,0';
  const opt = (k, l) => `<option value="${k}" ${k === metric ? 'selected' : ''}>${l}</option>`;
  return `<div class="card"><div class="section-title"><h3>Busiest times</h3>
      <select id="heatMetric" aria-label="Busiest times metric" style="width:auto">${opt('total', 'All activity')}${opt('outbound', 'Outbound calls + texts')}${opt('calls_in', 'Incoming calls')}${opt('missed', 'Missed calls')}</select></div>
    <div class="heat-wrap"><div class="heat" aria-label="Activity by weekday and hour">
      <div></div>${Array.from({ length: 24 }, (_, h) => `<div class="hh">${h % 3 === 0 ? hourLbl(h) : ''}</div>`).join('')}
      ${grid.map((row, d) => `<div class="hd">${DOW[d]}</div>${row.map((v, h) => `<button class="hc" data-d="${d + 1}" data-h="${h}" style="background:${v ? `rgba(${color},${(0.18 + 0.82 * (v / max)).toFixed(2)})` : '#171717'}" title="${DOW[d]} ${hourLbl(h)}m: ${n(v)}" aria-label="${DOW[d]} ${hourLbl(h)}m: ${n(v)}">${v || ''}</button>`).join('')}`).join('')}
    </div></div>
    <p class="small muted" style="margin:8px 0 0">${best ? `Busiest: <b style="color:var(--text)">${DOW[best.d]} ${hourLbl(best.h)}m</b> (${n(best.v)}). ` : 'No activity in this period. '}${esc(TZ_NAMES[tz()] || tz())} time · click a cell for the list · plan shifts and call blocks around it.</p></div>`;
}

const TEAM_COLS = [
  ['agent_name', 'Agent', 'text'], ['outbound_total', 'Outbound'], ['contacts_reached', 'Contacts'], ['outbound_calls', 'Calls out'],
  ['pickup_pct', 'Picked up', 'pct'], ['conversations', 'Conv.'], ['outbound_texts', 'Texts out'], ['inbound_calls', 'Calls in'],
  ['missed_calls', 'Missed'], ['answer_pct', 'Answered', 'pct'], ['inbound_texts', 'Texts in'], ['talk_sec', 'Talk time', 'hms'],
  ['avg_call_sec', 'Avg call', 'hms'], ['avg_reply_min', 'Avg reply', 'min'], ['recorded', 'Recorded'], ['in_shift_pct', 'In shift', 'pct'],
];
let teamSort = { k: 'outbound_total', dir: -1 };
const teamPick = new Set();

function teamRows(rows, prevRows, stats) {
  const prev = Object.fromEntries(prevRows.map((r) => [r.agent_id, r]));
  const st = Object.fromEntries(stats.map((r) => [r.agent_id, r]));
  return rows.map((r) => {
    const s = st[r.agent_id] || {};
    const answered = Math.max(0, r.inbound_calls - r.missed_calls - r.voicemails);
    const out = Number(s.in_shift || 0) + Number(s.off_shift || 0);
    return { ...r, ...s, agent_id: r.agent_id, prev_out: prev[r.agent_id]?.outbound_total || 0,
      pickup_pct: r.outbound_calls ? (100 * r.connected_calls) / r.outbound_calls : null,
      answer_pct: r.inbound_calls ? (100 * answered) / r.inbound_calls : null,
      in_shift_pct: s.has_shift && out ? (100 * s.in_shift) / out : null };
  });
}
function teamCell(r, [k, , kind]) {
  const v = r[k];
  if (kind === 'text') return `${esc(v)}<div class="small muted">${esc(r.gv_number || '')}</div>`;
  if (v == null) return '—';
  if (kind === 'pct') return `${Math.round(v)}%`;
  if (kind === 'hms') return hms(v);
  if (kind === 'min') return mins(Number(v));
  if (k === 'outbound_total') return `<b>${n(v)}</b> ${delta(v, r.prev_out)}`;
  if (k === 'missed_calls' && v > 0) return `<span style="color:var(--red)">${n(v)}</span>`;
  return n(v);
}

function compareCard(list) {
  const metrics = [['outbound_total', 'Outbound', n], ['outbound_calls', 'Calls out', n], ['conversations', 'Conversations', n], ['inbound_calls', 'Calls in', n],
    ['missed_calls', 'Missed', n], ['talk_sec', 'Talk time', hms], ['avg_reply_min', 'Avg reply (lower is better)', (v) => mins(Number(v))]];
  return `<div class="card" id="compare"><div class="section-title"><h3>Compare ${list.length} agents</h3><button class="btn dark" id="cmpClear">Clear selection</button></div>
    <div class="cmp">${metrics.map(([k, label, f]) => {
      const max = Math.max(1, ...list.map((r) => Number(r[k] || 0)));
      return `<div><div class="small muted">${label}</div>${list.map((r) => `<div class="cmp-row"><span class="cmp-name">${esc(r.agent_name)}</span>
        <span class="cmp-bar"><i style="width:${(100 * Number(r[k] || 0)) / max}%"></i></span><span class="cmp-v">${r[k] == null ? '—' : f(r[k])}</span></div>`).join('')}</div>`;
    }).join('')}</div></div>`;
}

function shiftCard(shifts) {
  const lim = state.settings?.analysis_rules || {};
  const late = lim.late_start_min ?? 15; const early = lim.early_end_min ?? 15; const idle = lim.idle_gap_min ?? 60;
  const flag = (v, max) => (v == null ? '—' : Number(v) > max ? `<span style="color:var(--red)">${mins(Number(v))}</span>` : mins(Number(v)));
  const clockT = (iso) => (iso ? fmtClock(iso) : '—');
  return `<div class="card"><h3>Shifts</h3>
    <div class="table-wrap"><table><thead><tr>${isMgr() ? '<th>Agent</th>' : ''}<th>Day</th><th>Shift</th><th>First outbound</th><th>Last outbound</th>
      <th class="num" title="First outbound after shift start (flag over ${late} min)">Late start</th><th class="num" title="Last outbound before shift end (flag over ${early} min)">Early finish</th>
      <th class="num" title="Longest stretch without an outbound call or text (flag over ${idle} min)">Longest idle</th><th class="num">Outbound</th><th class="num">Inbound</th><th class="num">Missed</th></tr></thead>
    <tbody>${shifts.slice(0, 60).map((s) => `<tr>${isMgr() ? `<td>${esc(s.agent_name)}</td>` : ''}<td>${fmtDay(s.day)}</td>
      <td>${fmtClock(s.shift_from)}–${fmtClock(s.shift_to)}${s.in_progress ? ' <span class="badge good">now</span>' : ''}</td>
      <td>${clockT(s.first_out)}</td><td>${clockT(s.last_out)}</td>
      <td class="num">${s.first_out ? flag(s.late_min, late) : s.in_progress ? '—' : '<span style="color:var(--red)">no activity</span>'}</td>
      <td class="num">${flag(s.early_min, early)}</td><td class="num">${flag(s.max_idle_min, idle)}</td>
      <td class="num"><b>${n(s.outbound)}</b></td><td class="num">${n(s.inbound)}</td><td class="num">${n(s.missed)}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">Shift times are set per agent in Settings → Agents (${esc(TZ_NAMES[tz()] || tz())} time). The <b>Shift</b> button above shows one agent's latest shift.</p></div>`;
}

let heatMetric = 'total';
let trendMode = 'day';

async function renderOverview(view) {
  const agent = isMgr() ? state.agent || null : state.agentId;
  const args = { ...rangeArgs(), p_agent: agent };
  const hasShifts = state.agents.some((a) => a.shift_start && (!agent || a.id === agent));
  const [rows, prevRows, daily, healthRows, stats, heat, shifts] = await Promise.all([
    rpc('metrics_summary', args),
    rpc('metrics_summary', { ...prevRangeArgs(), p_agent: agent }).catch(() => []),
    rpc('metrics_timeline', { p_from_ts: rangeInstants()[0], p_to_ts: rangeInstants()[1], p_agent: agent, p_bucket: bucketOf() }),
    sb.from('agents').select('id, last_health').then((r) => r.data || []),
    rpc('team_stats', args).catch(() => []),
    rpc('metrics_heatmap', args).catch(() => []),
    hasShifts ? rpc('shift_report', { p_from: state.from, p_to: state.to, p_agent: agent }).catch(() => []) : [],
  ]);
  const health = Object.fromEntries(healthRows.map((h) => [h.id, h.last_health]));
  const t = totals(rows);
  const p = totals(prevRows);
  const talk = stats.reduce((s, r) => s + Number(r.talk_sec || 0), 0);
  const talkCalls = t.connected_calls + Math.max(0, t.inbound_calls - t.missed_calls - t.voicemails);
  const openIssues = isMgr() ? (await rpc('analysis_issues', args)).filter((i) => i.status === 'open') : [];
  const period = periodLabel();
  const canWeek = bucketOf() === 'day' && daily.length >= 14;
  const series = canWeek && trendMode === 'week' ? weekly(daily) : daily;
  const team = teamRows(rows, prevRows, stats);
  const multi = isMgr() && rows.length > 1;
  const picked = team.filter((r) => teamPick.has(r.agent_id));
  const sorted = [...team].sort((a, b) => {
    const x = a[teamSort.k]; const y = b[teamSort.k];
    if (typeof x === 'string' || typeof y === 'string') return String(x ?? '').localeCompare(String(y ?? '')) * teamSort.dir;
    return ((x ?? -Infinity) - (y ?? -Infinity)) * teamSort.dir || 0;
  });
  view.innerHTML = `
    <div class="section-title"><h2>${isMgr() ? 'Activity' : 'My activity'} · ${esc(period)}</h2><div class="row" style="align-items:center"><button class="btn dark" id="csv" title="One row per agent: totals for the period (25+ fields)">Summary (CSV)</button><button class="btn dark" id="csvDetail" title="One row per call, text and voicemail with time, contact, outcome and duration">Every call &amp; text (CSV)</button></div></div>
    <div class="kpis" title="▲▼ = change vs the previous period of the same length">
      ${kpi('Outbound', n(t.outbound_total), `${delta(t.outbound_total, p.outbound_total)} every call + text · ${n(t.contacts_reached)} contact${t.contacts_reached === 1 ? '' : 's'}`, { hero: true, icon: ICON.out, drill: 'outbound' })}
      ${kpi('Calls out', n(t.outbound_calls), `${delta(t.outbound_calls, p.outbound_calls)} ${t.outbound_calls ? `${n(t.connected_calls)} picked up · ${n(t.conversations)} conv.` : 'no calls yet'}`, { icon: ICON.callOut, drill: 'calls_out' })}
      ${kpi('Texts out', n(t.outbound_texts), `${delta(t.outbound_texts, p.outbound_texts)} sent`, { icon: ICON.textOut, drill: 'texts_out' })}
      ${kpi('Inbound', n(t.inbound_total), `${delta(t.inbound_total, p.inbound_total)} calls + texts + voicemails`, { tone: 'g', icon: ICON.in, drill: 'inbound' })}
      ${kpi('Calls in', n(t.inbound_calls), `${n(t.inbound_calls - t.missed_calls - t.voicemails)} answered · ${n(t.missed_calls)} missed ${delta(t.missed_calls, p.missed_calls, { invert: true })} · ${plural(t.voicemails, 'voicemail')}`, { tone: t.missed_calls || t.voicemails ? 'r' : 'g', icon: ICON.callIn, drill: 'calls_in' })}
      ${kpi('Texts in', n(t.inbound_texts), `${delta(t.inbound_texts, p.inbound_texts)} received`, { tone: 'g', icon: ICON.textIn, drill: 'texts_in' })}
      ${kpi('Reply rate', t.response_rate == null ? '—' : `${t.response_rate.toFixed(0)}%`, `avg reply ${mins(t.avg_reply_min)}${p.avg_reply_min != null && t.avg_reply_min != null ? ` (was ${mins(p.avg_reply_min)})` : ''}`, { tone: t.avg_reply_min > 60 ? 'r' : 'g', icon: ICON.clock })}
      ${kpi('Talk time', hms(talk), talkCalls ? `avg ${hms(Math.round(talk / talkCalls))} per connected call` : 'no connected calls', { tone: 'g', icon: ICON.talk, drill: 'talk' })}
    </div>
    <div class="two">
      <div class="card chart"><div class="section-title"><h3>${bucketOf() === 'hour' ? 'Hourly' : canWeek && trendMode === 'week' ? 'Weekly' : 'Daily'} trend</h3>
        ${canWeek ? `<div class="seg seg-sm" id="trendMode" role="group" aria-label="Trend grouping"><button data-m="day" class="${trendMode !== 'week' ? 'on' : ''}">Daily</button><button data-m="week" class="${trendMode === 'week' ? 'on' : ''}">Weekly</button></div>` : ''}</div>
        <div id="trend">${barChart(series)}</div></div>
      <div class="card"><h3>Analysis</h3><ul class="insights">${isMgr() ? `<li class="${openIssues.some((i) => i.severity === 'high') ? 'bad' : openIssues.length ? '' : 'good'}"><a href="#/analysis">${openIssues.length ? `${n(openIssues.length)} issue${openIssues.length > 1 ? 's' : ''} to check (${n(openIssues.filter((i) => i.severity === 'high').length)} high) →` : 'No open issues — all checks passed'}</a></li>` : ''}${insights(t, rows, daily).map(([c, s]) => `<li class="${c}">${esc(s)}</li>`).join('')}</ul></div>
    </div>
    <div class="two top">
      ${heatCard(heat, heatMetric)}
      ${outcomesCard(t, talk)}
    </div>
    ${shifts.length ? shiftCard(shifts) : ''}
    ${picked.length >= 2 ? compareCard(picked) : ''}
    <div class="card">
      <div class="section-title"><h3>${isMgr() ? 'Team' : 'My numbers'}</h3>${multi ? '<span class="small muted">Tick 2+ agents to compare · click a column to sort · click a name to filter</span>' : ''}</div>
      <div class="table-wrap"><table class="team">
        <thead><tr>${multi ? '<th><span class="sr-only">Compare</span></th>' : ''}${TEAM_COLS.map(([k, l, kind]) => `<th class="${kind === 'text' ? '' : 'num'} sort" data-k="${k}" tabindex="0" aria-sort="${teamSort.k === k ? (teamSort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${teamSort.k === k ? (teamSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}<th>Extension</th></tr></thead>
        <tbody>${sorted.map((r) => `
          <tr data-agent="${r.agent_id}">
            ${multi ? `<td><input type="checkbox" class="pick" aria-label="Compare ${esc(r.agent_name)}" ${teamPick.has(r.agent_id) ? 'checked' : ''} style="width:auto"></td>` : ''}
            ${TEAM_COLS.map((c) => `<td class="${c[2] === 'text' ? (isMgr() ? 'click' : '') : 'num'}">${teamCell(r, c)}</td>`).join('')}
            <td>${connBadge({ last_heartbeat_at: r.last_heartbeat_at, last_health: health[r.agent_id] })}<div class="small muted">since ${r.tracking_start ? fmtTime(r.tracking_start) : '—'}</div></td>
          </tr>`).join('') || `<tr><td colspan="${TEAM_COLS.length + 2}" class="empty">No agents yet</td></tr>`}</tbody>
      </table></div>
    </div>`;

  const open = (key) => { const [title, f] = DRILL[key]; openDrill(`${title} · ${period}`, f, args); };
  view.querySelectorAll('[data-drill]').forEach((el) => {
    el.addEventListener('click', () => open(el.dataset.drill));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(el.dataset.drill); } });
  });
  // trend bar -> that hour / day / week
  view.querySelectorAll('#trend .hit').forEach((el) => el.addEventListener('click', () => {
    const b = series[Number(el.dataset.b)];
    const day = b.bucket.slice(0, 10);
    const hourly = bucketOf() === 'hour';
    const start = zoned(day, hourly ? b.bucket.slice(11, 16) : '00:00');
    const end = hourly ? new Date(Date.parse(start) + 3600e3).toISOString() : zoned(addDays(day, b.week ? 7 : 1));
    const [r0, r1] = rangeInstants();
    const s0 = Date.parse(start) < Date.parse(r0) ? r0 : start; const s1 = Date.parse(end) > Date.parse(r1) ? r1 : end;
    const label = b.week ? `week of ${fmtDay(day)}` : hourly ? `${fmtDay(day)} ${bucketLabel(b.bucket, true, false)}` : fmtDay(day);
    openDrill(`All activity · ${label}`, () => true, { p_from: dayKey(Date.parse(s0)), p_to: dayKey(Date.parse(s1) - 1), p_from_ts: s0, p_to_ts: s1, p_agent: agent });
  }));
  $('#trendMode')?.addEventListener('click', (e) => { const m = e.target.closest('button')?.dataset.m; if (m) { trendMode = m; route(); } });
  $('#heatMetric').addEventListener('change', (e) => { heatMetric = e.target.value; route(); });
  view.querySelectorAll('.heat .hc').forEach((el) => el.addEventListener('click', () => {
    const d = Number(el.dataset.d); const h = Number(el.dataset.h);
    const f = { total: () => true, outbound: DRILL.outbound[1], calls_in: DRILL.calls_in[1], missed: DRILL.missed[1] }[heatMetric];
    const at = (r) => { const dt = r.local_time; const dow = ((new Date(`${dt.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7) + 1; return dow === d && Number(dt.slice(11, 13)) === h; };
    openDrill(`${DOW[d - 1]} ${hourLbl(h)}m · ${$('#heatMetric').selectedOptions[0].textContent}`, (r) => at(r) && f(r), args);
  }));
  const sortBy = (k) => { teamSort = { k, dir: teamSort.k === k ? -teamSort.dir : k === 'agent_name' || k === 'avg_reply_min' ? 1 : -1 }; route(); };
  view.querySelectorAll('th.sort').forEach((th) => {
    th.addEventListener('click', () => sortBy(th.dataset.k));
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') sortBy(th.dataset.k); });
  });
  view.querySelectorAll('input.pick').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.closest('tr').dataset.agent;
    if (cb.checked) teamPick.add(id); else teamPick.delete(id);
    route();
  }));
  $('#cmpClear')?.addEventListener('click', () => { teamPick.clear(); route(); });
  if (isMgr()) view.querySelectorAll('table.team td.click').forEach((td) => td.addEventListener('click', () => {
    state.agent = td.closest('tr').dataset.agent;
    $('#agentFilter').value = state.agent;
    route();
  }));
  $('#csv').addEventListener('click', () => downloadCsv(team, `coco-report-${rangeFile()}.csv`,
    ['agent_name', 'gv_number', 'outbound_total', 'prev_out', 'contacts_reached', 'outbound_calls', 'connected_calls', 'conversations', 'outbound_texts',
      'inbound_total', 'inbound_calls', 'answered_in', 'missed_calls', 'voicemails', 'inbound_texts', 'response_rate', 'avg_reply_min',
      'talk_sec', 'avg_call_sec', 'short_calls', 'recorded', 'transcribed', 'in_shift', 'off_shift', 'active_days', 'first_at', 'last_at']));
  $('#csvDetail').addEventListener('click', async () => {
    const log = await rpc('activity_log', { ...rangeArgs(), p_agent: agent });
    const rowsOut = log.map((r) => ({ ...r, conversation: r.channel === 'call' && r.direction === 'outbound' ? (r.conversation ? 'yes' : 'no') : '' }));
    downloadCsv(rowsOut, `coco-activity-${rangeFile()}.csv`,
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
    rows = await rpc('contact_activity', { ...rangeArgs(), p_agent: state.agent || null, p_search: $('#csearch').value.trim() || null });
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
  $('#ccsv').addEventListener('click', () => downloadCsv(rows, `coco-contacts-${rangeFile()}.csv`,
    ['contact', 'contact_name', 'agent_name', 'calls_out', 'connected', 'texts_out', 'calls_in', 'missed', 'texts_in', 'voicemails', 'total', 'first_at', 'last_at']));
  await load();
}

// ---------- analysis (admin): rule-based checks from the database, reviewed by an admin ----------
const RULES = {
  missed_call_not_returned: { label: 'Missed call / voicemail not returned', why: 'Return missed calls and voicemails quickly — customers who call usually want something now.' },
  text_not_answered: { label: 'Text not answered', why: 'Reply to customer texts within the target time; only the first text of a burst is measured.' },
  opt_out_ignored: { label: 'Opt-out ignored', why: 'If a customer texts STOP / unsubscribe / "don\'t text me", never contact them again (compliance).' },
  over_contacting: { label: 'Over-contacting', why: 'Too many attempts in one day without any reply feels like spam — space them out.' },
  no_follow_up: { label: 'No follow-up', why: 'A single unanswered attempt is rarely enough — follow up after the set hours.' },
  quiet_hours: { label: 'Quiet hours', why: 'Don\'t call or text customers late at night or early morning in their timezone.' },
  very_short_call: { label: 'Very short call', why: 'Picked-up calls that end in a few seconds usually mean a hang-up or a bot — check the opener.' },
  shift_no_activity: { label: 'Shift: no activity', why: 'A scheduled shift passed without a single outbound call or text — check the extension was running, or the agent was off.' },
  shift_late_start: { label: 'Shift: late start', why: 'The first outbound call or text came well after the shift started. Start calling in the first minutes of the shift.' },
  shift_early_finish: { label: 'Shift: early finish', why: 'The last outbound call or text came well before the shift ended.' },
  shift_idle_gap: { label: 'Shift: long idle gap', why: 'A long stretch inside the shift without outbound activity. Plan call blocks; texts count as activity too.' },
};
const SEV_ORDER = { high: 0, medium: 1, low: 2 };
let anFilter = { status: 'open', severity: '', rule: '' };

const scoreTone = (s) => (s >= 85 ? 'g' : s >= 60 ? 'y' : 'r');

async function renderAnalysis(view) {
  const args = { ...rangeArgs(), p_agent: state.agent || null };
  const hasShifts = state.agents.some((a) => a.shift_start);
  const [cards, baseIssues, shiftIssues] = await Promise.all([rpc('analysis_scorecard', args), rpc('analysis_issues', args),
    hasShifts ? rpc('shift_issues', { p_from: state.from, p_to: state.to, p_agent: state.agent || null }).catch(() => []) : []]);
  const issues = [...baseIssues, ...shiftIssues];
  const r = state.settings.analysis_rules || {};
  const counts = {};
  issues.forEach((i) => { if (i.status === 'open') counts[i.rule] = (counts[i.rule] || 0) + 1; });
  const shown = issues.filter((i) => (!anFilter.status || i.status === anFilter.status)
    && (!anFilter.severity || i.severity === anFilter.severity) && (!anFilter.rule || i.rule === anFilter.rule));
  const opt = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;

  view.innerHTML = `
    <div class="section-title"><h2>Analysis</h2>
      <span class="small">Rule-based checks from Voice activity · targets: reply ${r.reply_target_min ?? 15} min · call back ${r.callback_target_min ?? 60} min${hasShifts ? ` · shift: late ${r.late_start_min ?? 15} min, idle ${r.idle_gap_min ?? 60} min` : ''} · change in Settings</span></div>

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
  $('#aCsv').addEventListener('click', () => downloadCsv(shown, `coco-analysis-${rangeFile()}.csv`,
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
    list = await rpc('contact_threads', { ...rangeArgs(), p_agent: state.agent || null, p_search: $('#search').value.trim() || null });
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
        ${player(it)}${transcriptHtml(it)}</div></div>`;
    }
    return `${sep}<div class="bubble ${it.direction === 'outbound' ? 'out' : ''}">
      ${it.kind === 'voicemail' ? '<b>Voicemail</b> ' : ''}${esc(it.body || (it.kind === 'voicemail' ? '(no transcript)' : '(no text)'))}
      ${player(it)}${it.kind === 'voicemail' && !it.body && it.recording_path ? transcriptHtml(it) : ''}<div class="meta">${it.direction === 'outbound' ? 'Sent' : 'Received'} · ${time}${it.kind === 'voicemail' && !it.recording_path ? ' · audio not saved yet' : ''}${it.transcript_source === 'whisper' ? ' · transcribed by Coco' : ''}</div></div>`;
  }).join('');
  const texts = (dir) => n(items.filter((i) => i.kind === 'text' && i.direction === dir).length);
  $('#detail').innerHTML = `
    <div class="section-title"><h3>${esc(head?.contact_name || head?.contact || 'Contact')}</h3><span class="small muted">${esc(head?.agent_name || '')} · full history</span></div>
    <div class="stats">
      ${stat('calls out', n(out.length))}${stat('picked up', n(out.filter((c) => c.duration_sec > 0).length))}
      ${stat('conversations', n(out.filter((c) => c.conversation).length))}${stat('no answer', n(out.filter((c) => !c.duration_sec).length))}
      ${stat('talk time', dur(calls.reduce((s, c) => s + (c.duration_sec || 0), 0)))}
      ${stat('texts out / in', `${texts('outbound')} / ${texts('inbound')}`)}
      ${stat('calls in', n(calls.length - out.length + items.filter((i) => i.kind === 'voicemail').length))}${stat('missed', n(calls.filter((c) => c.direction === 'inbound' && c.outcome === 'missed').length))}${stat('voicemails', n(items.filter((i) => i.kind === 'voicemail').length))}
    </div>
    <div class="timeline">${rows || '<div class="empty">Empty</div>'}</div>`;
  $('#detail').querySelectorAll('[data-tx]').forEach((btn) => btn.addEventListener('click', async () => {
    const it = items.find((x) => x.id === btn.dataset.tx);
    const ok = await transcribeItem({ kind: it.kind, id: it.id, recording_path: it.recording_path }, btn, audioUrl[it.recording_path]);
    if (ok) renderDetail(key, head);
  }));
}

/** Call transcript (dual-channel recordings read "Agent: … / Caller: …") or a Transcribe button. */
function transcriptHtml(it) {
  if (it.kind === 'call' && it.body) return `<details class="tx" open><summary class="small">Transcript${it.transcript_source === 'whisper' ? ' · by Coco' : ''}</summary><div class="tx-body">${esc(it.body)}</div></details>`;
  if (it.recording_path && !it.body) return `<div class="tx-row"><button class="btn dark tx-btn" data-tx="${it.id}">Transcribe</button><span class="small muted tx-msg"></span></div>`;
  return '';
}

const TX_DEFAULT = 'onnx-community/whisper-base.en';
const txModel = () => { try { return localStorage.getItem('coco.txModel') || TX_DEFAULT; } catch { return TX_DEFAULT; } };

/** Transcribe one recording on this computer and save the text. Returns true when saved. */
async function transcribeItem(item, btn, signedUrl) {
  const msgEl = btn?.parentElement?.querySelector('.tx-msg');
  const say = (t) => { if (msgEl) msgEl.textContent = ` ${t}`; };
  if (btn) btn.disabled = true;
  try {
    const url = signedUrl || (await sb.storage.from('recordings').createSignedUrl(item.recording_path, 600)).data?.signedUrl;
    if (!url) throw new Error('could not open the audio file');
    const tr = await import('./transcriber.js');
    const text = await tr.transcribeUrl(url, { model: txModel(), onProgress: (p) => say(p.text) });
    await rpc('save_transcript', { p_kind: item.kind === 'voicemail' ? 'voicemail' : 'call', p_id: item.id, p_text: text || '(no speech detected)', p_source: 'whisper' });
    say('Saved ✓');
    return true;
  } catch (e) {
    say(`Failed: ${e.message || e}`);
    if (btn) btn.disabled = false;
    return false;
  }
}

const escRe = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- recordings (admin): transcription queue + transcript search ----------
async function renderRecordings(view) {
  const [tr, queue] = await Promise.all([import('./transcriber.js'), rpc('transcription_queue', { p_limit: 200 })]);
  const model = txModel();
  view.innerHTML = `
    <div class="section-title"><h2>Recordings &amp; transcripts</h2>
      <div class="row" style="align-items:center">
        <select id="txModel" aria-label="Speech model" style="width:auto">${Object.entries(tr.MODELS).map(([k, l]) => `<option value="${k}" ${k === model ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <button class="btn" id="txAll" ${queue.length ? '' : 'disabled'}>Transcribe all pending (${n(queue.length)})</button>
      </div></div>
    <div class="card"><h3>Search transcripts</h3>
      <div class="row"><input id="txQ" placeholder="Word or phrase, e.g. refund, price, cancel" style="max-width:420px" aria-label="Search transcripts"></div>
      <div id="txFound" class="table-wrap"></div>
      <p class="small muted">Searches call transcripts and voicemail text in the selected period${state.agent ? ' for the selected agent' : ''}.</p></div>
    <div class="card"><h3>Waiting for a transcript</h3>
      <div class="table-wrap"><table><thead><tr><th>When</th><th>Agent</th><th>Contact</th><th>Type</th><th class="num">Length</th><th></th></tr></thead>
      <tbody>${queue.map((q) => `<tr data-id="${q.id}"><td>${fmtTime(q.occurred_at)}</td><td>${esc(q.agent_name)}</td><td>${esc(q.contact || '—')}</td><td>${esc(q.kind)}</td>
        <td class="num">${q.duration_sec ? dur(q.duration_sec) : ''}</td><td style="white-space:nowrap"><button class="btn dark tx-btn">Transcribe</button><span class="small muted tx-msg"></span></td></tr>`).join('')
        || '<tr><td colspan="6" class="empty">Every recording has a transcript 🎉</td></tr>'}</tbody></table></div></div>
    <div class="card note small">
      <b>How it works.</b> Transcription runs <b>on this computer</b> with Whisper (free and private: the audio never leaves your browser, only the text is saved).
      The first run downloads the speech model once (then it is cached). Speed ≈ 10–60 s per minute of audio; Chrome/Edge with WebGPU is much faster.
      Coco's own call recordings are two-channel (agent left, caller right), so transcripts read <i>Agent: … / Caller: …</i>. Keep this tab open while it works.
    </div>`;
  $('#txModel').addEventListener('change', (e) => { try { localStorage.setItem('coco.txModel', e.target.value); } catch { /* ignore */ } });
  const rowOf = (row) => queue.find((q) => q.id === row.dataset.id);
  view.querySelectorAll('tr[data-id] .tx-btn').forEach((btn) => btn.addEventListener('click', async () => {
    if (await transcribeItem(rowOf(btn.closest('tr')), btn)) btn.closest('tr').classList.add('done');
  }));
  $('#txAll')?.addEventListener('click', async (e) => {
    const all = e.currentTarget;
    all.disabled = true;
    let done = 0; let i = 0;
    for (const row of view.querySelectorAll('tr[data-id]')) {
      i++;
      const btn = row.querySelector('.tx-btn');
      if (btn.disabled || row.classList.contains('done')) continue;
      all.textContent = `Transcribing ${i} of ${queue.length}…`;
      if (await transcribeItem(rowOf(row), btn)) { row.classList.add('done'); done++; }
      if (!all.isConnected) return; // left the page
    }
    all.textContent = `Done: ${n(done)} transcribed`;
  });
  let timer;
  $('#txQ').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = $('#txQ').value.trim();
      if (q.length < 2) { $('#txFound').innerHTML = ''; return; }
      const found = await rpc('search_transcripts', { ...rangeArgs(), p_q: q, p_agent: state.agent || null });
      const re = new RegExp(escRe(esc(q)), 'gi');
      $('#txFound').innerHTML = `<table><tbody>${found.map((f) => `<tr class="click" data-key="${f.agent_id}~${f.contact_id || ''}"><td>${fmtTime(f.occurred_at)}</td><td>${esc(f.agent_name)}</td><td>${esc(f.contact || '—')}</td>
        <td style="white-space:normal">${esc(f.snippet).replace(re, (m) => `<mark>${m}</mark>`)}</td></tr>`).join('') || '<tr><td class="empty">No matches</td></tr>'}</tbody></table>`;
      $('#txFound').querySelectorAll('tr[data-key]').forEach((row) => row.addEventListener('click', () => { location.hash = `#/conversations/${row.dataset.key}`; }));
    }, 300);
  });
}


// ---------- extension: download, versions, updates (everyone) ----------
const semverNewer = (a, b) => {
  const x = String(a || '0').split('.').map(Number); const y = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const extUrl = (p) => new URL(p || '/downloads/coco-voice-extension.zip', location.origin).href;
/** 'current' | 'outdated' | 'none' for an agent's installed extension. */
const extState = (a) => {
  const v = a?.last_health?.extensionVersion;
  if (!v) return 'none';
  return state.ext && semverNewer(state.ext.version, v) ? 'outdated' : 'current';
};
const extChip = (a) => {
  const v = a?.last_health?.extensionVersion;
  const s = extState(a);
  return s === 'none' ? '<span class="badge">not installed yet</span>'
    : s === 'outdated' ? `<span class="badge medium" title="Latest is v${esc(state.ext.version)}">v${esc(v)} · update</span>`
      : `<span class="badge good">v${esc(v)} · latest</span>`;
};

async function loadAgentHealth() {
  const { data } = await sb.from('agents').select('id, name, active, last_health, last_heartbeat_at, gv_number').order('name');
  state.agentHealth = data || [];
  return state.agentHealth;
}

/** Top banner: agent -> own extension is old; admin -> some agents run an old version. */
async function renderUpdateBanner() {
  const el = $('#updateBanner');
  if (!state.ext) { el.hidden = true; return; }
  const agents = await loadAgentHealth();
  let html = '';
  if (isMgr()) {
    const old = agents.filter((a) => a.active && extState(a) === 'outdated');
    if (old.length) html = `${old.length} agent${old.length > 1 ? 's run' : ' runs'} an old Coco extension (${old.map((a) => esc(a.name)).join(', ')}). Latest is <b>v${esc(state.ext.version)}</b>. <a href="#/extension">See versions →</a>`;
  } else {
    const me = agents.find((a) => a.id === state.agentId);
    if (me && extState(me) === 'outdated') html = `Your Coco extension is <b>v${esc(me.last_health.extensionVersion)}</b> — <b>v${esc(state.ext.version)}</b> is available. <a href="#/extension">Update now →</a>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}

async function renderExtension(view) {
  const x = state.ext;
  const agents = await loadAgentHealth();
  const me = agents.find((a) => a.id === state.agentId);
  const size = x?.size ? `${Math.max(1, Math.round(x.size / 1024))} KB` : '';
  view.innerHTML = `
    <div class="section-title"><h2>Chrome extension</h2></div>
    <div class="two top">
      <div class="card">
        ${x ? `
        <div class="ext-head">
          <img src="icons/icon-192.png" alt="" width="56" height="56">
          <div><h3 style="margin:0">Coco Voice Tracker <span class="badge good">v${esc(x.version)}</span></h3>
            <div class="small muted">Released ${fmtTime(x.released)}${size ? ` · ${size}` : ''}${x.min_chrome ? ` · Chrome ${esc(x.min_chrome)}+` : ''}</div></div>
        </div>
        ${!isMgr() ? `<p style="margin:12px 0 0">Your installed version: ${me ? extChip(me) : '<span class="badge">not linked to an agent</span>'}</p>` : ''}
        <div class="ext-actions">
          <a class="btn" href="${esc(extUrl(x.download))}" download>Download extension (.zip)</a>
          <button class="btn dark" id="cpExtLink">Copy download link</button>
        </div>
        <p class="small muted" style="margin-top:8px">SHA-256 <code>${esc(x.sha256.slice(0, 16))}…</code> · direct link always points to the latest version.</p>`
        : '<div class="empty">Extension package not published yet.</div>'}
      </div>
      <div class="card">
        <h3>First install (2 minutes)</h3>
        <ol class="steps">
          <li>Download the .zip and <b>unzip</b> it to a folder you keep, e.g. <code>Documents\\coco-voice-extension</code>.</li>
          <li>Open <code>chrome://extensions</code> and switch on <b>Developer mode</b> (top right).</li>
          <li>Click <b>Load unpacked</b> → choose the <code>coco-voice-extension</code> folder.</li>
          <li>Pin it: puzzle icon → pin <b>Coco Voice Tracker</b>.</li>
          <li>Click the Coco icon → <b>Settings</b> → paste the token your admin sent → <b>Connect</b>.</li>
          <li>Open Google Voice (business account) and keep the tab open — <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.</li>
        </ol>
        <h3 style="margin-top:16px">Update to a new version</h3>
        <ol class="steps">
          <li>Download the new .zip and unzip it <b>over the same folder</b> (replace the files).</li>
          <li>On <code>chrome://extensions</code> click the <b>reload ⟳</b> icon on Coco Voice Tracker.</li>
          <li>Reload the Google Voice tab. Your token and numbers stay — no need to connect again.</li>
        </ol>
        <p class="small muted">Using a different folder gives Chrome a new extension id, and the token would have to be pasted again.</p>
      </div>
    </div>
    ${isMgr() ? `
    <div class="card"><h3>Agents' installed versions</h3>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Voice number</th><th>Extension</th><th>Last check-in</th></tr></thead>
      <tbody>${agents.map((a) => `<tr><td>${esc(a.name)}${a.active ? '' : ' <span class="small muted">(inactive)</span>'}</td><td>${esc(a.gv_number || '—')}</td>
        <td>${extChip(a)}</td><td>${a.last_heartbeat_at ? ago(a.last_heartbeat_at) : '<span class="small muted">never</span>'}</td></tr>`).join('')}</tbody></table></div>
    </div>` : ''}
    ${x?.history?.length ? `
    <div class="card"><h3>What's new</h3>
      ${x.history.map((h) => `<div class="release"><b>v${esc(h.version)}</b> <span class="small muted">${fmtTime(h.released)}</span>
        ${h.notes?.length ? `<ul>${h.notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`).join('')}
    </div>` : ''}`;
  if (x) copyBtn('cpExtLink', extUrl(x.download));
}

// ---------- first sign-in: short setup guide (once per user; reopen from Account) ----------
function showSetupGuide(force = false) {
  if (!force && state.user?.user_metadata?.onboarded) return;
  document.getElementById('setupGuide')?.remove();
  const agent = !isMgr();
  const steps = agent ? [
    ['Install the Chrome extension', `Download it below, unzip, then <code>chrome://extensions</code> → Developer mode → <b>Load unpacked</b>.`],
    ['Connect it with your token', 'Click the Coco icon → <b>Settings</b> → paste the token from your admin\'s message → <b>Connect</b>. Tracking starts at that moment (no old history).'],
    ['Keep Google Voice open', 'Use your business Google Voice account in Chrome and keep the tab open. Shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>. Pause anytime from the panel.'],
    ['See your numbers here', 'Every call and text you make counts under each contact, in Pakistan time. The side panel shows the same numbers.'],
  ] : [
    ['Create your team', '<b>Settings → Users</b>: create each agent. Use <b>Copy message for Slack</b> and send it privately.'],
    ['Agents install the extension', 'They follow the message: download, load unpacked, paste token, keep Google Voice open.'],
    ['Watch the results', '<b>Overview</b> for totals, <b>Conversations</b> for every call and text per contact, <b>Analysis</b> for issues to review.'],
    ['Set your rules', '<b>Settings</b>: business time zone, analysis thresholds, conversation length and voicemail/recording storage.'],
  ];
  const d = document.createElement('dialog');
  d.id = 'setupGuide';
  d.className = 'guide';
  d.setAttribute('aria-labelledby', 'guideTitle');
  d.innerHTML = `
    <div class="brand-stripe" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="guide-head">
      <img src="icons/icon-192.png" alt="" width="48" height="48">
      <div><h2 id="guideTitle">Welcome to Coco <span>Voice</span></h2>
        <div class="small muted">by Pastry Marketing</div></div>
    </div>
    <p class="small muted">${agent ? 'Four steps to start tracking your calls and texts.' : 'Four steps to get your team tracking.'}</p>
    <ol class="guide-steps">${steps.map(([t, b]) => `<li><b>${t}</b><div class="small">${b}</div></li>`).join('')}</ol>
    <div class="row" style="justify-content:flex-end">
      ${state.ext ? `<a class="btn dark" href="${esc(extUrl(state.ext.download))}" download>Download extension v${esc(state.ext.version)}</a>` : ''}
      <button class="btn dark" id="guideLater">Later</button>
      <button class="btn" id="guideDone" autofocus>Got it</button>
    </div>`;
  document.body.append(d);
  const close = async (remember) => {
    d.close(); d.remove();
    if (remember && !state.user?.user_metadata?.onboarded) {
      const { data } = await sb.auth.updateUser({ data: { onboarded: true } });
      if (data?.user) state.user = data.user;
    }
  };
  $('#guideDone').addEventListener('click', () => close(true));
  $('#guideLater').addEventListener('click', () => close(false));
  d.addEventListener('cancel', () => close(false));
  d.showModal();
}

/** Ready-to-paste Slack message for a new user (Slack mrkdwn). Without an email = extension token only. */
function slackMessage({ name, email, role, password, token }) {
  let step = 0;
  const h = (t) => `*${++step}. ${t}*`;
  const lines = [`:wave: Hi *${name || (email || '').split('@')[0] || 'there'}*, your *Coco Voice* access is ready.`];
  if (email) {
    lines.push('', h('Sign in to the dashboard'), `• ${location.origin}`, `• Email: \`${email}\``,
      ...(password ? [`• Temporary password: \`${password}\` _(you'll choose your own at first sign-in)_`] : []));
  }
  if (token || role === 'agent') {
    lines.push('', h('Install the Chrome extension'),
      `• Download: ${state.ext ? extUrl(state.ext.download) : `${location.origin}/#/extension`}${state.ext ? ` (v${state.ext.version})` : ''}`,
      '• Unzip → open `chrome://extensions` → turn on *Developer mode* → *Load unpacked* → choose the `coco-voice-extension` folder',
      '• Pin it, click the Coco icon → *Settings* → paste your token → *Connect*');
    if (token) lines.push(`• Token: \`${token}\``);
    lines.push('', h('Start tracking'),
      '• Open Google Voice (business account) and keep the tab open — shortcut `Alt+Shift+V`',
      '• Every call and text counts from the moment you connect (Pakistan time)',
      `• Full guide: ${location.origin}/#/extension`);
  }
  lines.push('', '_Please keep this message private — it contains your login details._');
  return lines.join('\n');
}

// ---------- credentials hand-off (new user / password reset / new token) ----------
/** Plain-text version (email, download, print). */
function plainMessage({ name, email, role, password, token }) {
  const L = [`Hello ${name || (email || '').split('@')[0] || ''},`.replace(/,\s*$/, ',').replace('Hello ,', 'Hello,'), '',
    'Your Coco Voice access is ready.', ''];
  let step = 0;
  if (email) {
    L.push(`${++step}. Sign in to the dashboard`, `   ${location.origin}`, `   Email: ${email}`);
    if (password) L.push(`   Temporary password: ${password}`, '   (you will choose your own password at first sign-in)');
    L.push('');
  }
  if (token || role === 'agent') {
    L.push(`${++step}. Install the Chrome extension`,
      `   Download: ${state.ext ? extUrl(state.ext.download) : `${location.origin}/#/extension`}${state.ext ? ` (v${state.ext.version})` : ''}`,
      '   Unzip -> chrome://extensions -> Developer mode -> Load unpacked -> choose the coco-voice-extension folder',
      '   Click the Coco icon -> Settings -> paste your token -> Connect');
    if (token) L.push(`   Token: ${token}`);
    L.push('', `${++step}. Start tracking`,
      '   Open Google Voice (business account) and keep the tab open (shortcut Alt+Shift+V).',
      '   Every call and text counts from the moment you connect (Pakistan time).', '');
  }
  L.push('Please keep these details private.', '', '— Pastry Marketing · Coco Voice');
  return L.join('\n');
}

/** One professional panel for every hand-off: Slack, email, download, print. Shown once. */
function credentialsPanel(target, { title, name, email, role, password, token, rotated = false }) {
  const slack = slackMessage({ name, email, role, password, token });
  const plain = plainMessage({ name, email, role, password, token });
  const subject = 'Your Coco Voice access';
  const file = `coco-voice-${(name || email || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.txt`;
  const field = (label, value, id) => `<label>${label}</label><div class="token-row"><div class="token">${esc(value)}</div><button class="btn" id="${id}">Copy</button></div>`;
  target.innerHTML = `
    <div class="card token-card creds">
      <div class="creds-head">
        <div><h3 style="margin:0">${esc(title)}</h3>
          <div class="small muted">${esc(name || '')}${email ? ` · ${esc(email)}` : ''} · ${esc(ROLE_LABEL[role] || role || 'Agent')}</div></div>
        <span class="badge medium">Shown once</span>
      </div>
      <p class="small">Send privately — Slack <b>direct message</b> or email to the person only, never a shared channel.
        ${password ? 'They choose their own password at first sign-in.' : ''}${rotated ? ' The previous token has stopped working.' : ''}</p>
      ${email ? field('Email', email, 'cpEmail') : ''}
      ${password ? field('Temporary password', password, 'cpPw') : ''}
      ${token ? field('Extension token', token, 'cpTok') : ''}
      <div class="send-row">
        <button class="btn" id="cpSlack">Copy for Slack</button>
        ${email ? `<a class="btn dark" id="mailBtn" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(plain)}">Email it</a>` : ''}
        <button class="btn dark" id="dlBtn">Download (.txt)</button>
        <button class="btn dark" id="prBtn">Print</button>
      </div>
      <details style="margin-top:10px"><summary class="small">Preview message</summary><pre class="slack-preview">${esc(slack)}</pre></details>
    </div>`;
  if (email) copyBtn('cpEmail', email);
  if (password) copyBtn('cpPw', password);
  if (token) copyBtn('cpTok', token);
  copyBtn('cpSlack', slack);
  $('#dlBtn').addEventListener('click', () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([plain], { type: 'text/plain' })), download: file });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#prBtn').addEventListener('click', () => {
    const w = window.open('', '_blank', 'noopener=no,width=720,height=800');
    if (!w) return toast('Allow pop-ups to print');
    w.document.write(`<!doctype html><title>${esc(subject)}</title><style>body{font:14px/1.6 system-ui,sans-serif;margin:40px;color:#111}
      h1{font-size:20px;margin:0 0 4px}.by{color:#666;margin:0 0 24px}pre{white-space:pre-wrap;font:14px/1.6 ui-monospace,monospace;border:1px solid #ddd;padding:16px;border-radius:8px}</style>
      <h1>Coco Voice — access details</h1><p class="by">Pastry Marketing · confidential</p><pre>${esc(plain)}</pre>`);
    w.document.close(); w.focus(); w.print();
  });
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// exposed for the end-to-end test only (no secrets)
window.__coco = { slackMessage, plainMessage, credentialsPanel };

// ---------- account (everyone) ----------
async function renderAccount(view) {
  view.innerHTML = `
    <div class="section-title"><h2>Account</h2></div>
    <div class="card" style="max-width:460px">
      <h3>${esc(state.user.email)}</h3>
      <p class="small">Role: ${esc(state.role)}. You can sign in with a password, or with an email link / code.</p>
      <p><button class="btn dark" id="openGuide" type="button">Open setup guide</button> <a class="btn dark" href="#/extension">Extension &amp; updates</a></p>
      <form id="acctPw">
        <label for="aPw">New password (min 6, letters + numbers)</label><input id="aPw" type="password" autocomplete="new-password" minlength="6">
        <label for="aPw2">Repeat new password</label><input id="aPw2" type="password" autocomplete="new-password" minlength="6">
        <button class="btn" type="submit" style="margin-top:14px">Set / change password</button>
      </form>
      <p class="small" id="acctMsg"></p>
    </div>`;
  $('#openGuide').addEventListener('click', () => showSetupGuide(true));
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
      ${h.callRecording ? row('Call recording', `${h.callRecording.enabled ? 'on' : 'off'} · ${n(h.callRecording.uploaded)} uploaded · ${n(Math.max(0, h.callRecording.pending))} waiting${h.callRecording.lastError ? ` · last error: ${esc(h.callRecording.lastError)}` : ''}${h.callRecording.page ? `<div class="small muted">page: ${n(h.callRecording.page.pcs)} calls seen, ${n(h.callRecording.page.files)} files${h.callRecording.page.lastError ? `, error: ${esc(h.callRecording.page.lastError)}` : ''}</div>` : ''}`) : ''}
      ${h.audio ? row('Voicemail audio', `${n(h.audio.uploaded)} copied · ${n(h.audio.pending)} waiting${h.audio.lastError ? ` · ${esc(h.audio.lastError)}` : ''}`) : ''}
    </tbody></table></div>
    <div><div class="small muted">Google endpoints the Voice page called (count)</div>
      <table><tbody>${net.map(([k, v]) => `<tr><td class="small" style="white-space:normal;word-break:break-all">${esc(k)}</td><td class="num">${n(v)}</td></tr>`).join('') || '<tr><td class="muted small">none reported yet</td></tr>'}</tbody></table></div></div>`;
}

async function renderSettings(view) {
  const [{ data: agents }, users] = await Promise.all([
    sb.from('agents').select('id, name, email, gv_number, active, tracking_start, last_heartbeat_at, last_health, parser_version, token_hint, record_calls, shift_start, shift_end, shift_days').order('name'),
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
        <thead><tr><th>User</th><th>Role</th><th>Tracking agent</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${(users || []).map((u) => `<tr data-uid="${u.user_id}" data-email="${esc(u.email)}">
          <td>${esc(u.name || '')}<div class="small muted">${esc(u.email)}${isMe(u) ? ' · you' : ''}</div></td>
          <td>${isMe(u) ? 'Admin' : `<select class="uRoleSel">${opt('agent', u.role === 'admin' ? 'admin' : 'agent', 'Agent')}${opt('admin', u.role === 'admin' ? 'admin' : 'agent', 'Admin')}</select>`}</td>
          <td>${isMe(u) ? '—' : `<select class="uAgentSel"><option value="">—</option>${(agents || []).map((a) => opt(a.id, u.agent_id, a.name)).join('')}</select>`}</td>
          <td>${u.suspended ? '<span class="badge high">Suspended</span>' : '<span class="badge good">Active</span>'}</td>
          <td>${u.last_sign_in_at ? ago(u.last_sign_in_at) : '<span class="small muted">never</span>'}${u.must_change_password ? '<div class="small muted">temporary password</div>' : ''}</td>
          <td style="white-space:nowrap">${isMe(u) ? '' : `<button class="btn dark uSave">Save</button> <button class="btn dark uReset">Reset password</button>
            <button class="btn dark uActive" data-active="${u.suspended ? '0' : '1'}">${u.suspended ? 'Reactivate' : 'Suspend'}</button> <button class="btn danger uRemove">Delete</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="6" class="empty">No users yet</td></tr>'}</tbody>
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
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Extension</th><th>Voice number</th><th>Token</th><th>Tracking since</th><th>Status</th><th title="Coco records this agent's Google Voice calls (two-channel audio)">Call recording</th><th title="Shift in ${esc(TZ_NAMES[tz()] || tz())} time — used for the Shift view, shift report and shift rules">Shift</th><th></th></tr></thead>
      <tbody>${(agents || []).map((a) => `<tr data-id="${a.id}">
        <td><input class="aName" value="${esc(a.name)}"><div class="small muted">${esc(a.email || '')}</div></td>
        <td>${connBadge(a)}</td>
        <td>${esc(a.gv_number || 'detected on first sync')}</td>
        <td class="small">${a.token_hint ? `…${esc(a.token_hint)}` : '—'}</td>
        <td>${a.tracking_start ? fmtTime(a.tracking_start) : 'when connected'}</td>
        <td><button class="switch aActive" role="switch" aria-checked="${a.active}" title="${a.active ? 'Tracking allowed — click to deactivate' : 'Deactivated — click to activate'}"><i></i>${a.active ? 'Active' : 'Inactive'}</button></td>
        <td><button class="switch aRec" role="switch" aria-checked="${a.record_calls !== false}" title="Record this agent's calls"><i></i>${a.record_calls !== false ? 'On' : 'Off'}</button></td>
        <td style="white-space:nowrap"><div class="shift-edit"><input type="time" class="aS0" value="${esc(a.shift_start?.slice(0, 5) || '')}" aria-label="Shift start" step="900"> – <input type="time" class="aS1" value="${esc(a.shift_end?.slice(0, 5) || '')}" aria-label="Shift end" step="900"></div>
          <div class="days">${DOW.map((d, i) => `<label title="${d}"><input type="checkbox" class="aDay" value="${i + 1}" ${(a.shift_days || [1, 2, 3, 4, 5]).includes(i + 1) ? 'checked' : ''}>${d[0]}</label>`).join('')}</div></td>
        <td style="white-space:nowrap"><button class="btn dark aSave">Save</button> <button class="btn dark aRotate">New token</button> <button class="btn dark aDiag">Diagnostics</button> <button class="btn danger aDelete">Delete</button></td></tr>
        <tr class="diag" data-for="${a.id}" hidden><td colspan="9">${diagHtml(a)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No agents yet — create an Agent user above, or add a tracking-only agent below.</td></tr>'}</tbody></table></div>
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
      <h3 style="margin-top:18px;font-size:16px">Call recordings &amp; voicemails</h3>
      <div class="row" style="align-items:center">
        <div><label class="check"><input type="checkbox" id="sRec" ${s.save_recordings !== false ? 'checked' : ''} style="width:auto"> Save call recordings and voicemail audio in this dashboard (master switch)</label>
          <div class="small muted">On: the extension records each agent's Google Voice calls (per-agent switch in Agents above, on by default) and copies voicemails into private storage that only admins can play. Off: nothing new is recorded or stored.</div></div>
      </div>
      <div class="note small">
        <b>Coco records calls itself</b> — no Google Workspace admin setting is needed, so it works on any business Voice account.
        The extension records the call in the agent's browser (agent on the left channel, caller on the right) and uploads it after the call; it shows a red <b>REC</b> badge while recording.
        If a Workspace admin <i>also</i> turned on Google's own call recording, Coco keeps Google's copy too.
        <br><b>Consent:</b> many US states require every party to agree to recording — agents should say <i>"this call may be recorded"</i> at the start of each call. Transcribe recordings on the <a href="#/recordings">Recordings</a> page.
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
      <div class="row">
        <div><label>Shift: late start after (min)</label><input id="rLate" type="number" min="1" value="${s.analysis_rules?.late_start_min ?? 15}"></div>
        <div><label>Shift: early finish over (min)</label><input id="rEarly" type="number" min="1" value="${s.analysis_rules?.early_end_min ?? 15}"></div>
        <div><label>Shift: idle gap over (min)</label><input id="rIdle" type="number" min="5" value="${s.analysis_rules?.idle_gap_min ?? 60}"></div>
      </div>
      <div class="row"><div><button class="btn" id="saveSettings">Save</button></div></div>
    </div>`;

  const showCreds = ({ email, name, role, password, token }) =>
    credentialsPanel($('#credOut'), { title: 'New user created', name, email, role, password, token });

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
        credentialsPanel($('#credOut'), { title: 'New temporary password', name: tr.querySelector('td')?.firstChild?.textContent?.trim() || '', email, role: $('.uRoleSel', tr)?.value || 'agent', password: r.temp_password });
      } catch (err) { toast(err.message); }
    });
    $('.uActive', tr)?.addEventListener('click', async (e) => {
      const suspend = e.target.dataset.active === '1';
      if (suspend && !confirm(`Suspend ${email}? They can't sign in until you reactivate them. Nothing is deleted.`)) return;
      try { await team({ action: 'set_active', user_id: uid, active: !suspend }); toast(suspend ? 'User suspended' : 'User reactivated'); renderSettings(view); } catch (err) { toast(err.message); }
    });
    $('.uRemove', tr)?.addEventListener('click', async () => {
      if (!confirm(`Delete the login ${email}? This can't be undone. Their tracked calls and texts stay in reports (delete the agent below to remove those).`)) return;
      try { await team({ action: 'remove', user_id: uid }); toast('User deleted'); renderSettings(view); } catch (err) { toast(err.message); }
    });
  });

  $('#saveSettings').addEventListener('click', async () => {
    const num = (id, min = 1) => Math.max(min, Number($(id).value) || min);
    const upd = {
      business_timezone: $('#sTz').value, retention_days: Number($('#sRet').value), save_recordings: $('#sRec').checked, updated_at: new Date().toISOString(),
      analysis_rules: {
        reply_target_min: num('#rReply'), callback_target_min: num('#rCb'), followup_after_hours: num('#rFu'),
        max_unanswered_per_day: num('#rMax'), quiet_start: $('#rQs').value || '21:00', quiet_end: $('#rQe').value || '08:00',
        quiet_tz: $('#rQtz').value, short_call_sec: num('#rShort'), conversation_sec: num('#rConv'),
        late_start_min: num('#rLate'), early_end_min: num('#rEarly'), idle_gap_min: num('#rIdle', 5),
      },
    };
    const { data, error } = await sb.from('app_settings').update(upd).eq('id', 1).select().single();
    if (error) return toast(error.message);
    state.settings = data;
    $('#tzLabel').textContent = `${TZ_NAMES[tz()] || tz()} time`;
    toast('Settings saved');
  });
  const showToken = (name, token, rotated = false) =>
    credentialsPanel($('#tokenOut'), { title: rotated ? 'Replacement extension token' : 'New agent token', name, role: 'agent', token, rotated });
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
    const saveAgentSettings = async () => {
      const s0 = $('.aS0', tr).value || null; const s1 = $('.aS1', tr).value || null;
      if (!!s0 !== !!s1) throw new Error('Set both shift start and end (or clear both)');
      const days = [...tr.querySelectorAll('.aDay:checked')].map((c) => Number(c.value));
      if (s0 && !days.length) throw new Error('Pick at least one shift day');
      await rpc('update_agent_settings', { p_agent: id, p_record_calls: $('.aRec', tr).getAttribute('aria-checked') === 'true', p_shift_start: s0, p_shift_end: s1, p_shift_days: days.length ? days : null });
      const a = state.agents.find((x) => x.id === id);
      if (a) Object.assign(a, { shift_start: s0 ? `${s0}:00` : null, shift_end: s1 ? `${s1}:00` : null, shift_days: days, record_calls: $('.aRec', tr).getAttribute('aria-checked') === 'true' });
    };
    $('.aSave', tr).addEventListener('click', async () => {
      try {
        await rpc('update_agent', { p_agent: id, p_name: $('.aName', tr).value, p_account_type: 'workspace', p_active: $('.aActive', tr).getAttribute('aria-checked') === 'true' });
        await saveAgentSettings();
        toast('Saved');
      } catch (e) { toast(e.message); }
    });
    $('.aRec', tr).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const on = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(on)); btn.lastChild.textContent = on ? 'On' : 'Off';
      try { await saveAgentSettings(); toast(on ? 'Call recording on — the extension picks it up within a minute' : 'Call recording off for this agent'); } catch (err) {
        btn.setAttribute('aria-checked', String(!on)); btn.lastChild.textContent = !on ? 'On' : 'Off'; toast(err.message);
      }
    });
    $('.aActive', tr).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const on = btn.getAttribute('aria-checked') !== 'true';
      if (!on && !confirm(`Deactivate ${$('.aName', tr).value}? Their extension stops tracking right away ("turned off by your admin"). Existing data stays.`)) return;
      try {
        await rpc('update_agent', { p_agent: id, p_name: $('.aName', tr).value, p_account_type: 'workspace', p_active: on });
        btn.setAttribute('aria-checked', String(on)); btn.lastChild.textContent = on ? 'Active' : 'Inactive';
        toast(on ? 'Agent activated' : 'Agent deactivated');
      } catch (err) { toast(err.message); }
    });
    $('.aDelete', tr).addEventListener('click', async () => {
      const name = $('.aName', tr).defaultValue;
      const typed = prompt(`Delete agent "${name}" permanently?\n\nThis removes ALL their calls, texts, voicemails, recordings and analysis. It can't be undone.\nTip: use Inactive instead to keep the history.\n\nType the agent name to confirm:`);
      if (typed === null) return;
      if (typed !== name) return toast('Name did not match — nothing deleted');
      try { await team({ action: 'delete_agent', agent_id: id, confirm_name: typed }); toast('Agent deleted'); renderSettings(view); } catch (err) { toast(err.message); }
    });
    $('.aDiag', tr).addEventListener('click', () => { const d = view.querySelector(`tr.diag[data-for="${id}"]`); d.hidden = !d.hidden; });
    $('.aRotate', tr).addEventListener('click', async () => {
      if (!confirm('Generate a new token? The old one stops working immediately.')) return;
      try { showToken($('.aName', tr).value, await rpc('rotate_agent_token', { p_agent: id }), true); } catch (e) { toast(e.message); }
    });
  });
}

start();

document.querySelectorAll('.cy').forEach((e) => { e.textContent = String(new Date().getFullYear()); });
