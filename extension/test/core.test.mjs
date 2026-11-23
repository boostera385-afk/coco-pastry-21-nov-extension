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

test('outbound reach counts a contact once per day', () => {
  const ev = [
    { k: 'call', d: 'out', c: '+15550000001', at: at('2026-11-23T14:00:00Z'), o: null, s: 0 },
    { k: 'text', d: 'out', c: '+15550000001', at: at('2026-11-23T15:00:00Z') },
    { k: 'text', d: 'out', c: '+15550000001', at: at('2026-11-23T16:00:00Z') },
    { k: 'text', d: 'out', c: '+15550000002', at: at('2026-11-23T16:00:00Z') },
    { k: 'call', d: 'out', c: '+15550000001', at: at('2026-11-24T15:00:00Z'), o: 'answered', s: 90 },
    { k: 'call', d: 'in', c: '+15550000003', at: at('2026-11-23T17:00:00Z'), o: 'missed', s: 0 },
    { k: 'text', d: 'in', c: '+15550000002', at: at('2026-11-23T17:00:00Z') },
    { k: 'voicemail', d: 'in', c: '+15550000003', at: at('2026-11-23T17:01:00Z'), o: 'voicemail' },
  ];
  const day = summarize(ev, '2026-11-23', '2026-11-23', TZ);
  assert.equal(day.outboundReaches, 2);
  assert.equal(day.outboundTexts, 3);
  assert.equal(day.outboundCalls, 1);
  assert.equal(day.connectedCalls, 0);
  assert.equal(day.missedCalls, 1);
  assert.equal(day.inboundTexts, 1);
  assert.equal(day.voicemails, 1);
  const two = summarize(ev, '2026-11-23', '2026-11-24', TZ);
  assert.equal(two.outboundReaches, 3); // contact 1 counted on both days
  assert.equal(two.connectedCalls, 1);
});

test('parser: thread list with known type codes', () => {
  const ts = at('2026-11-23T15:00:00Z');
  const msg = (id, t, code, text) => [id, t, null, null, null, code, null, null, null, text, null, null, null];
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
