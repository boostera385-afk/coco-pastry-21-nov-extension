// Run: node --test extension/test
// Vici agent-screen hook (src/vici/page.js) in a fake page: call start/end from the screen state and from AJAX,
// disposition, phone formatting, and that passwords never leave the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../src/vici/page.js', import.meta.url), 'utf8');

function page({ withGlobals = true, fetch = undefined } = {}) {
  const posted = [];
  const listeners = [];
  const timers = [];
  const form = { elements: {} };
  const setField = (k, v) => { form.elements[k] = { value: v }; };
  class XHR {
    constructor() { this.listeners = {}; this.responseType = ''; this.responseText = ''; }
    addEventListener(t, f) { this.listeners[t] = f; }
  }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  const win = {
    location: { origin: 'https://dm26.callengine.org', pathname: '/agc/vicidial.php' },
    postMessage: (m) => posted.push(m),
    addEventListener: (t, f) => { if (t === 'message') listeners.push(f); },
    fetch,
    XMLHttpRequest: XHR,
    URLSearchParams,
    setInterval: (f) => { timers.push(f); return timers.length; },
  };
  win.window = win; win.top = win;
  win.document = { forms: { vicidial_form: form }, getElementById: () => null };
  if (withGlobals) Object.assign(win, { VD_live_customer_call: 0, auto_dial_level: 1, campaign: 'SALES1', user: '8001', inOUT: 'OUT', VDCL_group_id: '' });
  vm.createContext(win);
  vm.runInContext(SRC, win);
  const tick = () => timers[0]();
  const ajax = (url, body, res = 'OK') => {
    const x = new win.XMLHttpRequest();
    x.open('POST', url); x.send(body); x.responseText = res; x.listeners.load?.();
  };
  const events = () => posted.filter((m) => m.type === 'event').map((m) => m.event);
  const pageWindow = vm.runInContext('window', win); // the page's own window object inside the VM
  const toPage = (data) => listeners.forEach((f) => f({ source: pageWindow, data }));
  /** Ask the page to dial (as the bridge does) and wait for its answer. */
  const dial = (code, number) => new Promise((res) => {
    const reqId = `r${Math.random()}`;
    const t = setInterval(() => { const r = posted.find((m) => m.type === 'dial-result' && m.reqId === reqId); if (r) { clearInterval(t); res(r); } }, 5);
    toPage({ source: 'coco-ext', type: 'dial', reqId, code, number });
  });
  return { win, posted, tick, ajax, setField, events, dial };
}

test('auto-dial call: start and end from the screen state, lead details, one id per call', () => {
  const p = page();
  p.tick();
  p.setField('lead_id', '555'); p.setField('uniqueid', '1764321234.77'); p.setField('phone_code', '1'); p.setField('phone_number', '3075551234');
  p.setField('first_name', 'Ann'); p.setField('last_name', 'Lee');
  p.win.VD_live_customer_call = 1; p.tick();
  p.win.VD_live_customer_call = 0; p.tick();
  const [start, end] = p.events();
  assert.equal(start.stage, 'start');
  assert.equal(start.vici_uid, '1764321234.77');
  assert.equal(start.phone, '+13075551234');
  assert.equal(start.contact_name, 'Ann Lee');
  assert.equal(start.dial_type, 'auto');
  assert.equal(start.direction, 'outbound');
  assert.equal(start.vici_user, '8001');
  assert.equal(start.campaign, 'SALES1');
  assert.equal(end.stage, 'end');
  assert.equal(end.vici_uid, start.vici_uid);
  assert.ok(end.ended_at);
  const gates = p.posted.filter((m) => m.type === 'call-state');
  assert.deepEqual(gates.map((g) => g.on), [true, false], 'recording gate opens and closes with the call');
});

test('manual dial + disposition after hangup lands on the same call', () => {
  const p = page();
  p.ajax('/agc/vdc_db_query.php', 'ACTION=manDiaLonly&user=8001&pass=SECRET1&phone_code=1&phone_number=2025550199');
  p.win.VD_live_customer_call = 1; p.tick();
  p.win.VD_live_customer_call = 0; p.tick();
  p.ajax('/agc/vdc_db_query.php', 'ACTION=updateDISPO&dispo_choice=SALE&lead_id=9&pass=SECRET1');
  const ev = p.events();
  assert.equal(ev[0].dial_type, 'manual');
  assert.equal(ev[0].phone, '+12025550199');
  const dispo = ev.find((e) => e.stage === 'dispo');
  assert.equal(dispo.disposition, 'SALE');
  assert.equal(dispo.vici_uid, ev[0].vici_uid);
});

test('screen without the live flag: AJAX call log start/end drives the call', () => {
  const p = page({ withGlobals: false });
  p.ajax('/agc/vdc_db_query.php', 'ACTION=manDiaLlogCaLL&stage=start&lead_id=42&uniqueid=17.5&phone_code=1&phone_number=4155550100');
  p.tick();
  p.ajax('/agc/vdc_db_query.php', 'ACTION=manDiaLlogCaLL&stage=end&lead_id=42&uniqueid=17.5');
  const ev = p.events();
  assert.deepEqual(ev.map((e) => e.stage), ['start', 'end']);
  assert.equal(ev[0].vici_uid, '17.5');
  assert.equal(ev[0].phone, '+14155550100');
});

test('inbound call is labelled inbound', () => {
  const p = page();
  p.win.inOUT = 'IN'; p.win.VDCL_group_id = 'SUPPORT_IN';
  p.win.VD_live_customer_call = 1; p.tick();
  assert.equal(p.events()[0].direction, 'inbound');
  assert.equal(p.events()[0].dial_type, 'inbound');
});

test('passwords never leave the page; phone numbers are masked in samples', () => {
  const p = page();
  p.ajax('/agc/conf_exten_check.php?pass=URLPASS', 'ACTION=refresh&user=8001&pass=SECRET1&phone_pass=SECRET2&lead=3075551234', 'Status: INCALL|3075551234');
  const all = JSON.stringify(p.posted);
  assert.ok(!/SECRET1|SECRET2|URLPASS/.test(all), all);
  assert.ok(!/3075551234/.test(all), 'phone-like numbers masked');
  const s = p.posted.find((m) => m.type === 'sample').sample;
  assert.equal(s.key, 'conf_exten_check:refresh');
});

const okFetch = (calls, text = 'SUCCESS: external_dial function set - 8001|3075550199') => async (url, init) => {
  calls.push({ url, body: String(init?.body) });
  return { status: 200, text: async () => text, clone() { return this; } };
};

test('click-to-dial: Agent API external_dial with the agent session, POST, marked manual', async () => {
  const calls = [];
  const p = page({ fetch: okFetch(calls) });
  p.win.pass = 'AGENTPW';
  const r = await p.dial('1', '3075550199');
  assert.equal(r.ok, true); assert.equal(r.method, 'api');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/agc/api.php');
  const b = new URLSearchParams(calls[0].body);
  assert.equal(b.get('function'), 'external_dial'); assert.equal(b.get('value'), '3075550199'); assert.equal(b.get('agent_user'), '8001');
  assert.ok(!calls[0].url.includes('AGENTPW'), 'password never in the URL');
  assert.ok(!JSON.stringify(p.posted).includes('AGENTPW'), 'password never posted out of the page');
  p.win.VD_live_customer_call = 1; p.tick();
  assert.equal(p.events()[0].dial_type, 'manual');
  assert.equal(p.events()[0].phone, '+13075550199');
});

test('click-to-dial: API refused -> falls back to the screen manual-dial box', async () => {
  const calls = [];
  const p = page({ fetch: okFetch(calls, 'ERROR: auth USER DOES NOT HAVE PERMISSION TO USE THIS FUNCTION - 8001') });
  p.win.pass = 'AGENTPW';
  let submitted = null;
  p.win.NeWManuaLDiaLCalLSubmiT = (how) => { submitted = how; };
  p.setField('MDPhonENumbeR', ''); p.setField('MDDiaLCodE', '');
  const r = await p.dial('1', '3075550199');
  assert.equal(r.ok, true); assert.equal(r.method, 'screen'); assert.equal(submitted, 'NOW');
});

test('click-to-dial: refused during a live call, and with no way to dial', async () => {
  const p = page({ fetch: okFetch([], 'ERROR: nope') });
  p.win.VD_live_customer_call = 1; p.tick();
  assert.match((await p.dial('1', '3075550199')).error, /call is live/);
  const q = page({ fetch: okFetch([], 'ERROR: agent_user is not logged in') });
  q.win.pass = 'x';
  const r = await q.dial('1', '3075550199');
  assert.equal(r.ok, false); assert.match(r.error, /Vici refused: ERROR: agent_user is not logged in/);
  assert.equal((await q.dial('1', '12')).error, 'bad number');
});
