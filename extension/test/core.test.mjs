// Run: node --test extension/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, dayKey, startOfDay, addDays } from '../src/lib/metrics.js';
import { parseResponse, parseSendRequest, contactFromThreadId, stripXssi } from '../src/parser/gv-protojson.js';

const TZ = 'America/New_York';
const at = (iso) => Date.parse(iso);

test('dayKey uses business timezone', () => {
  // 03:30 UTC on Nov 24 is still Nov 23 in New York
  assert.equal(dayKey(at('2026-11-24T03:30:00Z'), TZ), '2026-11-23');
  assert.equal(dayKey(at('2026-11-24T03:30:00Z'), 'America/Los_Angeles'), '2026-11-23');
  assert.equal(dayKey(at('2026-11-24T06:30:00Z'), TZ), '2026-11-24');
});

test('startOfDay returns local midnight, incl. DST day', () => {
  assert.equal(new Date(startOfDay(at('2026-11-23T18:00:00Z'), TZ)).toISOString(), '2026-11-23T05:00:00.000Z');
  assert.equal(new Date(startOfDay(at('2026-07-01T18:00:00Z'), TZ)).toISOString(), '2026-07-01T04:00:00.000Z');
  assert.equal(new Date(startOfDay(at('2026-03-08T18:00:00Z'), TZ)).toISOString(), '2026-03-08T05:00:00.000Z');
});

test('addDays crosses months', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('every call and every text counts; contacts = distinct numbers (Pakistan time)', () => {
  const PK = 'Asia/Karachi';
  const ev = [
    { k: 'call', d: 'out', c: '+15550000001', at: at('2026-11-23T05:00:00Z'), o: null, s: 0 },
    { k: 'text', d: 'out', c: '+15550000001', at: at('2026-11-23T06:00:00Z') },
    { k: 'text', d: 'out', c: '+15550000001', at: at('2026-11-23T07:00:00Z') },
    { k: 'text', d: 'out', c: '+15550000002', at: at('2026-11-23T07:00:00Z') },
    { k: 'call', d: 'out', c: '+15550000001', at: at('2026-11-23T20:00:00Z'), o: 'answered', s: 90 }, // 01:00 PKT next day
    { k: 'call', d: 'in', c: '+15550000003', at: at('2026-11-23T08:00:00Z'), o: 'missed', s: 0 },
    { k: 'text', d: 'in', c: '+15550000002', at: at('2026-11-23T08:00:00Z') },
    { k: 'voicemail', d: 'in', c: '+15550000003', at: at('2026-11-23T08:01:00Z'), o: 'voicemail' },
  ];
  const day = summarize(ev, '2026-11-23', '2026-11-23', PK);
  assert.equal(day.outboundTotal, 4);   // 1 call + 3 texts, each counted
  assert.equal(day.contactsReached, 2);
  assert.equal(day.outboundTexts, 3);
  assert.equal(day.outboundCalls, 1);
  assert.equal(day.connectedCalls, 0);
  assert.equal(day.inboundTotal, 3);    // missed call + text + voicemail
  assert.equal(day.missedCalls, 1);
  assert.equal(day.inboundTexts, 1);
  assert.equal(day.voicemails, 1);
  // a voicemail with no call record before it = an incoming call whose outcome is "voicemail" (not "missed")
  const vmOnly = summarize([{ k: 'voicemail', d: 'in', c: '+15550000009', at: at('2026-11-23T09:00:00Z') }], '2026-11-23', '2026-11-23', PK);
  assert.deepEqual([vmOnly.inboundCalls, vmOnly.missedCalls, vmOnly.voicemails, vmOnly.inboundTotal], [1, 0, 1, 1]);
  const two = summarize(ev, '2026-11-23', '2026-11-24', PK);
  assert.equal(two.outboundTotal, 5);   // 20:00 UTC call falls on Nov 24 in Pakistan
  assert.equal(two.contactsReached, 2);
  assert.equal(two.connectedCalls, 1);
});

test('dayKey uses Pakistan time by default', () => {
  assert.equal(dayKey(at('2026-11-23T19:30:00Z')), '2026-11-24'); // 00:30 PKT
});

test('parser: thread list with known type codes', () => {
  const ts = at('2026-11-23T15:00:00Z');
  const msg = (id, t, code, text) => [id, t, null, null, code, null, null, null, null, text, null, null, null];
  const body = `)]}'\n${JSON.stringify([[
    ['t.+15550000001', 1, [msg('m1', ts, 11, 'Hi, this is Sam'), msg('m2', String(ts + 60000), 10, 'Who?')]],
    ['t.+15550000002', 0, [msg('m3', ts, 99, 'odd')]],
  ], 'cursor']) }`;
  const { events } = parseResponse('https://clients6.google.com/voice/v1/voiceclient/api2thread/list?alt=protojson', body, {});
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => [e.gv_id, e.type, e.direction, e.contact_number]), [
    ['m1', 'text', 'outbound', '+15550000001'],
    ['m2', 'text', 'inbound', '+15550000001'],
    ['m3', 'unknown', 'unknown', '+15550000002'],
  ]);
  assert.equal(events[1].occurred_at, new Date(ts + 60000).toISOString());
  assert.equal(events[0].body, 'Hi, this is Sam');
});

test('parser: real Google Voice SMS payload (verified 2026-11-23, numbers redacted)', () => {
  const N = '+15550001111';
  const sent = ['256de863b94af335722ef92db53b54902f21a75b', 1795418264432, N, [N, N, null, null, null, null, 0], 11, 1, null, null, null, 'Hi', null, null, 6, 1, null, N, 0, '4821821224143405226', [null, 1], null, null, null, null, null, null, null, null, null, null, `t.${N}`];
  const recv = ['3d12844c924e931262753841b2ca06b3fb15f7e6', 1795418265098, N, [N, N, null, null, null, null, 0], 10, 1, null, null, null, 'Hi', null, null, 5, 1, null, N, 0, null, [null, 1], null, null, null, null, null, null, null, null, null, null, `t.${N}`];
  const body = `)]}'\n${JSON.stringify([[[`t.${N}`, 1, [sent, recv]]]])}`;
  const { events } = parseResponse('https://clients6.google.com/voice/v1/voiceclient/api2thread/list', body, { agentNumber: N });
  assert.deepEqual(events.map((e) => [e.type, e.direction, e.body, e.contact_number]), [
    ['text', 'outbound', 'Hi', N],
    ['text', 'inbound', 'Hi', N],
  ]);
  assert.equal(events[0].occurred_at, new Date(1795418264432).toISOString());
});

test('parser: real Google Voice outgoing call (verified 2026-11-23, numbers redacted)', () => {
  const A = '+15550001111'; const C = '+15550002222';
  const call = ['PCIFFQVSCJJBVKWSEJZLRUBQIAIIAKIAC', 1795426607582, A, [C, C, null, null, null, null, 0], 14, 1, null, null, 22, '', null, null, 2, 0, null, C, 0, null, [null, 1], null, null, null, null, null, null, null, null, null, null, 'c.PCIFFQVSCJJBVKWSEJZLRUBQIAIIAKIAC'];
  const body = JSON.stringify([[['c.PCIFFQVSCJJBVKWSEJZLRUBQIAIIAKIAC', 1, [call], null, [[C, C, null, null, null, null, 0]], [1, 3]]]]);
  for (const agentNumber of [A, undefined]) {
    const { events } = parseResponse('https://clients6.google.com/voice/v1/voiceclient/api2thread/list', body, { agentNumber });
    assert.deepEqual(events.map((e) => [e.type, e.direction, e.contact_number, e.duration_sec, e.body]), [['call', 'outbound', C, 22, null]]);
  }
});

test('parser: real Google Voice voicemail (verified 2026-11-23, numbers redacted)', () => {
  const A = '+15550001111'; const C = '+15550002222';
  const url = 'https://www.google.com/voice/media/svm/123/AbC-xyz';
  const vm = ['PCIFEETKGIZBFOU2ELBGBUBQIAUIAKIAC', 1795430477644, A, [C, C, null, null, null, null, 0], 2, 0, null, null, 3, '', null, url, 3, 8, null, C, 0, null, [null, 2], null, null, [[], null, 1], null, null, null, null, null, null, null, 'c.PCIFEETKGIZBFOU2ELBGBUBQIAUIAKIAC'];
  const body = JSON.stringify([[['c.PCIFEETKGIZBFOU2ELBGBUBQIAUIAKIAC', 0, [vm]]]]);
  const [e] = parseResponse('https://clients6.google.com/voice/v1/voiceclient/api2thread/list', body, { agentNumber: A }).events;
  assert.deepEqual([e.type, e.direction, e.contact_number, e.duration_sec, e.media_url, e.body], ['voicemail', 'inbound', C, 3, url, null]);
  const said = structuredClone(vm); said[21] = [[['Hi', 'call', 'me'], ['back']], null, 1];
  const [e2] = parseResponse('https://x/voiceclient/api2thread/list', JSON.stringify([[['c.X', 0, [said]]]]), { agentNumber: A }).events;
  assert.equal(e2.body, 'Hi call me back');
});

test('parser: ignores unrelated urls and bad json', () => {
  assert.deepEqual(parseResponse('https://x/other', '[]').events, []);
  assert.deepEqual(parseResponse('https://x/api2thread/list', 'not json').events, []);
});

test('parser: account/get finds agent number', () => {
  assert.equal(parseResponse('https://x/voiceclient/account/get', JSON.stringify([[null, [['+13072281262']]]])).agentNumber, '+13072281262');
});

test('helpers', () => {
  assert.equal(contactFromThreadId('t.+15551234567'), '+15551234567');
  assert.equal(contactFromThreadId('g.Group Message.abc'), null);
  assert.equal(stripXssi(")]}'\n[1]"), '[1]');
  const s = parseSendRequest('https://x/api2thread/sendsms', JSON.stringify([null, null, null, null, 'Hello there', 't.+15550000009']));
  assert.equal(s.contact, '+15550000009');
  assert.equal(s.text, 'Hello there');
});
