// node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanSegments, mergeTurns, formatTurns, detectAnsweredBy } from '../../dashboard/transcript-core.js';
import { speechRegions } from '../../dashboard/transcriber.js';

test('server and dashboard use the same transcript rules (files identical)', () => {
  assert.equal(fs.readFileSync(new URL('../../dashboard/transcript-core.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../supabase/functions/_shared/transcript-core.js', import.meta.url), 'utf8'));
});

test('two speakers are interleaved by time and labelled Agent / Caller', () => {
  const agent = cleanSegments([{ start: 0, end: 3, text: ' Hi, this is Sara from Coco.' }, { start: 9, end: 12, text: ' Sure, I can help.' }, { start: 12.5, end: 14, text: ' One moment.' }]);
  const caller = cleanSegments([{ start: 3.5, end: 8, text: ' Hello, I need a refund.' }, { start: 20, end: 21, text: ' [BLANK_AUDIO]' }]);
  assert.equal(formatTurns(mergeTurns([agent, caller], ['Agent', 'Caller'])),
    '[0:00] Agent: Hi, this is Sara from Coco.\n[0:03] Caller: Hello, I need a refund.\n[0:09] Agent: Sure, I can help. One moment.');
});

test('typical Whisper mistakes on silence / noise are removed', () => {
  const out = cleanSegments([
    { start: 0, end: 1, text: 'Thank you.', no_speech_prob: 0.5, avg_logprob: -0.4 },     // invented on silence
    { start: 1, end: 4, text: 'Hello, is this the front desk?', no_speech_prob: 0.01, avg_logprob: -0.2 },
    { start: 4, end: 5, text: 'Hello, is this the front desk?', no_speech_prob: 0.01, avg_logprob: -0.2 }, // exact repeat
    { start: 5, end: 9, text: 'I am sorry I am sorry I am sorry', compression_ratio: 3.1 },          // repetition loop
    { start: 9, end: 10, text: 'gibberish', no_speech_prob: 0.8, avg_logprob: -1.0 },                  // low confidence
    { start: 10, end: 13, text: 'Thank you so much for calling.', no_speech_prob: 0.02, avg_logprob: -0.3 }, // real
  ]);
  assert.deepEqual(out.map((s) => s.text), ['Hello, is this the front desk?', 'Thank you so much for calling.']);
});

test('a short real talk is a person; a greeting is voicemail', () => {
  const talk = mergeTurns([
    [{ start: 0, end: 2, text: 'We want to test the extension.' }, { start: 20, end: 22, text: 'We want to test the first extension on US numbers.' }, { start: 27, end: 28, text: 'No, sorry.' }],
    [{ start: 3, end: 6, text: 'Good morning. This is the front desk. Excuse me?' }, { start: 21, end: 24, text: "If you're trying to extend your reservation." }, { start: 27.5, end: 29, text: "I'm very confused. What are you calling about?" }],
  ], ['Agent', 'Caller']);
  assert.equal(detectAnsweredBy(talk), 'human');
  const vm = mergeTurns([[], [{ start: 0, end: 6, text: "Hi, you've reached John. I can't take your call right now, please leave a message after the tone." }]], ['Agent', 'Caller']);
  assert.equal(detectAnsweredBy(vm), 'voicemail');
  assert.equal(detectAnsweredBy([{ text: 'The person you are calling is not available. Please leave a message.' }], { labelled: false }), 'voicemail');
  assert.equal(detectAnsweredBy(mergeTurns([[{ start: 0, end: 1, text: 'Hello?' }], []], ['Agent', 'Caller'])), null);
});

test('voice activity detection finds speech and its start time; silence gives nothing', () => {
  const rate = 16000; const x = new Float32Array(rate * 6);
  for (let i = 0; i < x.length; i++) x[i] = (Math.random() - 0.5) * 0.0005;               // line hiss
  for (let i = 2 * rate; i < 3.5 * rate; i++) x[i] += 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate); // "speech" 2.0–3.5 s
  const r = speechRegions(x, rate);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].start - 1.75) < 0.2 && Math.abs(r[0].end - 3.8) < 0.25, JSON.stringify(r));
  assert.deepEqual(speechRegions(new Float32Array(rate * 3), rate), []);
});
