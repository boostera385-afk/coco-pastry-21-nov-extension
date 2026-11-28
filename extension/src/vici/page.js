// Runs in the PAGE (MAIN world) on the Vici Dialer agent screen (dm26.callengine.org/agc/vicidial.php) at document_start.
// Observes only, never changes a request. Two signals, whichever the agent screen gives:
//   1. the screen's own state: VD_live_customer_call (customer on the line) + the lead form (lead_id, uniqueid, phone…)
//   2. its AJAX calls: manDiaLlogCaLL stage=start/end, manDiaLonly / manDiaLnextCaLL (manual dial), updateDISPO (status)
// Emits one event per change of a call (start, end, disposition) to the bridge; the server merges them per call.
// Passwords (pass=, phone_pass=…) are removed before anything leaves this page.
(() => {
  if (window.__cocoVici) return;
  window.__cocoVici = 1;
  const top = window === window.top;
  const post = (msg) => window.postMessage({ source: 'coco-vici', ...msg }, window.location.origin);
  // any field named like a password (pass, orig_pass, phone_pass, VD_pass, pwd, secret, token…) never leaves this page
  const SECRET = /pass|pwd|secret|token/i;

  const params = (s) => { try { return new URLSearchParams(typeof s === 'string' ? s : ''); } catch { return new URLSearchParams(); } };
  const clean = (u, body) => {
    const p = new URLSearchParams();
    for (const src of [params(String(u).split('?')[1] || ''), params(body)]) for (const [k, v] of src) if (!SECRET.test(k)) p.set(k, v);
    return p;
  };
  const redact = (t) => String(t ?? '').replace(/([\w-]*(?:pass|pwd|secret|token)[\w-]*)=[^&\s"'<]*/gi, '$1=***')
    .replace(/\d{7,}/g, (d) => `#${d.length}#`).slice(0, 600);

  /** Status names the screen itself shows (system + campaign statuses), e.g. N -> "No Answer". */
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[|,]/) : []);
  const dispoName = (code) => {
    for (const [a, b] of [['VARstatuses', 'VARstatusnames'], ['VARCBstatuses', 'VARCBstatusnames'], ['statuses', 'statusnames']]) {
      const c = list(g(a)); const nm = list(g(b));
      const i = c.findIndex((x) => x.trim().toUpperCase() === code.toUpperCase());
      if (i >= 0 && nm[i] && nm[i].trim()) return nm[i].trim().slice(0, 60);
    }
    return null;
  };
  /** Where the screen's frames load from (address + path only): finds the browser phone frame. */
  const frames = () => {
    const out = new Set();
    const walk = (doc, depth) => {
      if (!doc || depth > 3) return;
      for (const f of doc.querySelectorAll?.('iframe, frame') || []) {
        try { const u = new URL(f.src || f.getAttribute('src') || '', doc.baseURI); if (/^https?:$/.test(u.protocol)) out.add(`${u.origin}${u.pathname}`.slice(0, 120)); } catch { /* ignore */ }
        try { walk(f.contentDocument, depth + 1); } catch { /* cross-origin */ }
      }
    };
    try { walk(document, 0); } catch { /* ignore */ }
    return [...out].slice(0, 20);
  };

  // ---------- call state ----------
  const S = { live: false, call: null, last: null, xhrLive: null, dialed: null, actions: {}, globals: null };
  const g = (name) => { try { return window[name]; } catch { return undefined; } };
  const field = (name) => {
    try {
      const f = document.forms?.vicidial_form?.elements?.[name] || document.getElementById(name);
      const v = f && 'value' in f ? String(f.value).trim() : '';
      return v || null;
    } catch { return null; }
  };
  const phoneOf = (code, num) => {
    const d = String(num || '').replace(/\D/g, '');
    if (!d) return null;
    const c = String(code || '').replace(/\D/g, '');
    if (d.length === 10 && (!c || c === '1')) return `+1${d}`;
    if (d.length === 11 && d[0] === '1') return `+${d}`;
    return c && !d.startsWith(c) ? `+${c}${d}` : d.length > 10 ? `+${d}` : d;
  };
  const viciUser = () => {
    const u = g('user') ?? field('user');
    return typeof u === 'string' && /^[\w.-]{1,30}$/.test(u) ? u : null;
  };
  /** Everything the screen knows about the current lead right now. */
  const snapshot = () => {
    const first = field('first_name'); const lastN = field('last_name');
    const inOut = String(g('inOUT') ?? '').toUpperCase();
    const group = g('VDCL_group_id');
    const level = Number(g('auto_dial_level') ?? NaN);
    const inbound = inOut === 'IN' || (typeof group === 'string' && group && group !== String(g('campaign') ?? ''));
    return {
      lead_id: field('lead_id') || (S.xhrLive?.lead_id ?? null),
      uniqueid: field('uniqueid') || (S.xhrLive?.uniqueid ?? null),
      phone: phoneOf(field('phone_code'), field('phone_number')) || S.xhrLive?.phone || S.dialed?.phone || null,
      contact_name: [first, lastN].filter(Boolean).join(' ') || null,
      campaign: (typeof g('campaign') === 'string' && g('campaign')) || field('campaign') || null,
      direction: inbound ? 'inbound' : 'outbound',
      dial_type: inbound ? 'inbound' : (S.dialed && Date.now() - S.dialed.at < 120e3) ? 'manual' : level > 0 ? 'auto' : level === 0 ? 'manual' : 'unknown',
      vici_user: viciUser(),
    };
  };
  const emit = (stage, c, extra = {}) => post({ type: 'event', event: {
    stage, vici_uid: c.uid, ...c.info, started_at: new Date(c.startedAt).toISOString(),
    ended_at: c.endedAt ? new Date(c.endedAt).toISOString() : null,
    talk_sec: c.endedAt ? Math.round((c.endedAt - c.startedAt) / 1000) : 0, disposition: c.disposition || null, ...extra,
  } });

  function startCall() {
    const info = snapshot();
    const at = Date.now();
    const uid = info.uniqueid || (info.lead_id ? `lead:${info.lead_id}:${at}` : `t:${at}`);
    S.call = { uid, startedAt: at, info };
    emit('start', S.call);
    post({ type: 'call-state', on: true, uid });
  }
  function endCall() {
    const c = S.call;
    if (!c) return;
    c.endedAt = Date.now();
    const info = snapshot();
    for (const [k, v] of Object.entries(info)) if (v && !c.info[k]) c.info[k] = v; // fill what arrived during the call
    emit('end', c);
    post({ type: 'call-state', on: false, uid: c.uid });
    S.last = c; S.call = null; S.xhrLive = null; S.dialed = null;
  }

  function tick() {
    if (!top) return;
    const flag = g('VD_live_customer_call');
    const live = flag !== undefined ? Number(flag) === 1 || flag === true : !!S.xhrLive;
    if (live && !S.live) startCall();
    else if (!live && S.live) endCall();
    else if (live && S.call) { // fill lead details that load a moment after the call starts
      const info = snapshot(); let changed = false;
      for (const [k, v] of Object.entries(info)) if (v && !S.call.info[k]) { S.call.info[k] = v; changed = true; }
      if (changed) emit('update', S.call);
    }
    S.live = live;
    if (!S.globals) {
      S.globals = Object.fromEntries(['VD_live_customer_call', 'inOUT', 'VDCL_group_id', 'auto_dial_level', 'campaign', 'user', 'AutoDialReady']
        .map((k) => [k, g(k) === undefined ? 'missing' : typeof g(k)]));
      S.globals.form = !!document.forms?.vicidial_form;
    }
  }
  setInterval(tick, 1000);

  // ---------- AJAX ----------
  function onAjax(url, body, text) {
    const u = String(url);
    if (!/\.php/i.test(u)) return;
    const p = clean(u, body);
    const file = (u.split('?')[0].match(/([\w-]+)\.php/i) || [])[1] || 'php';
    const action = p.get('ACTION') || p.get('action') || p.get('function') || '';
    const key = `${file}:${action}`.slice(0, 60);
    S.actions[key] = (S.actions[key] || 0) + 1;
    // redacted sample (no passwords, phone-like numbers masked) for checking the map from the dashboard
    if (file !== 'conf_exten_check' || S.actions[key] <= 2) post({ type: 'sample', sample: { key, req: redact(p.toString()), res: redact(text), at: Date.now() } });
    if (!top) return;
    if (action === 'manDiaLonly' || action === 'manDiaLnextCaLL') {
      S.dialed = { at: Date.now(), phone: phoneOf(p.get('phone_code'), p.get('phone_number')) };
    } else if (action === 'manDiaLlogCaLL') {
      const stage = (p.get('stage') || '').toLowerCase();
      if (stage === 'start') S.xhrLive = { lead_id: p.get('lead_id'), uniqueid: p.get('uniqueid'), phone: phoneOf(p.get('phone_code'), p.get('phone_number')) };
      if (stage === 'end') { if (S.call) endCall(); S.xhrLive = null; }
    } else if (action === 'updateDISPO') {
      const dispo = (p.get('dispo_choice') || p.get('status') || '').trim().slice(0, 30);
      const c = S.call || S.last;
      if (dispo && c && Date.now() - (c.endedAt || c.startedAt) < 30 * 60e3) { c.disposition = dispo; emit('dispo', c, { disposition_name: dispoName(dispo) }); }
    }
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { try { this.__cocoUrl = url; } catch { /* ignore */ } return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__cocoUrl;
      if (url && /\.php/i.test(String(url))) {
        const b = typeof body === 'string' ? body : '';
        this.addEventListener('load', () => { try { onAjax(url, b, this.responseType === '' || this.responseType === 'text' ? this.responseText : ''); } catch { /* never break the page */ } });
      }
    } catch { /* ignore */ }
    return XS.apply(this, arguments);
  };
  const F = window.fetch;
  if (F) {
    window.fetch = function (input, init) {
      const p = F.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && /\.php/i.test(url)) {
          const b = typeof init?.body === 'string' ? init.body : '';
          p.then((r) => r.clone().text()).then((t) => onAjax(url, b, t)).catch(() => {});
        }
      } catch { /* ignore */ }
      return p;
    };
  }

  // ---------- click-to-dial (asked by the Coco dashboard through the extension) ----------
  // 1) Vici Agent API external_dial with the agent's OWN logged-in session (POST, same origin; the password never
  //    leaves this page). Needs "Agent API Access" on the Vici user. 2) Fallback: the screen's own manual-dial box.
  async function dial(code, number) {
    if (S.call || S.live) return { ok: false, error: 'A call is live — finish it first' };
    const u = viciUser();
    if (!u) return { ok: false, error: 'Log in to the Vici agent screen first' };
    S.dialed = { at: Date.now(), phone: phoneOf(code, number) };
    let apiErr = null;
    const pass = g('pass');
    if (typeof pass === 'string' && pass) {
      try {
        const body = new URLSearchParams({ source: 'coco', user: u, pass, agent_user: u, function: 'external_dial', value: number,
          phone_code: code, search: 'YES', preview: 'NO', focus: 'YES' });
        const r = await F.call(window, '/agc/api.php', { method: 'POST', body, credentials: 'same-origin' });
        const t = (await r.text()).trim();
        if (/^SUCCESS/i.test(t)) return { ok: true, method: 'api' };
        apiErr = t.replace(/pass=\S+/gi, '').slice(0, 160) || `HTTP ${r.status}`;
      } catch (e) { apiErr = String(e?.message || e).slice(0, 120); }
    }
    const fn = g('NeWManuaLDiaLCalLSubmiT');
    const f = document.forms?.vicidial_form?.elements;
    if (typeof fn === 'function' && f?.MDPhonENumbeR) {
      try {
        f.MDPhonENumbeR.value = number;
        if (f.MDDiaLCodE) f.MDDiaLCodE.value = code;
        fn.call(window, 'NOW');
        return { ok: true, method: 'screen' };
      } catch (e) { return { ok: false, error: `Vici screen dial failed: ${String(e?.message || e).slice(0, 100)}` }; }
    }
    S.dialed = null;
    return { ok: false, error: apiErr ? `Vici refused: ${apiErr}` : 'This Vici screen has no manual dial — ask the admin to allow manual dial or Agent API access' };
  }
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'coco-ext' || ev.data.type !== 'dial' || !top) return;
    const { reqId, code, number } = ev.data;
    if (!/^\d{1,3}$/.test(String(code)) || !/^\d{7,15}$/.test(String(number))) { post({ type: 'dial-result', reqId, ok: false, error: 'bad number' }); return; }
    dial(String(code), String(number)).then((r) => post({ type: 'dial-result', reqId, ...r }), (e) => post({ type: 'dial-result', reqId, ok: false, error: String(e) }));
  });

  // diagnostics for the dashboard (counts + which screen variables exist; no lead data)
  // Sent right away, whenever login / call state changes, on request (ping) and every 30 s as a heartbeat.
  const diag = () => post({ type: 'diag', diag: { actions: S.actions, globals: S.globals, live: S.live, user: viciUser(),
    loginForm: !viciUser() && !!document.querySelector?.('input[name="VD_login"], input[name="user"], input[name="phone_login"]'), frames: frames(),
    page: location.pathname.slice(0, 60), title: String(document.title || '').slice(0, 60) } });
  if (top) {
    let sig = '';
    setInterval(() => { const s = `${viciUser()}|${S.live}`; if (s !== sig) { sig = s; diag(); } }, 1000);
    setInterval(diag, 30e3);
    window.addEventListener('message', (ev) => { if (ev.source === window && ev.data?.source === 'coco-ext' && ev.data.type === 'diag-now') diag(); });
  }
  window.addEventListener('pagehide', () => { if (S.call) endCall(); });
})();
