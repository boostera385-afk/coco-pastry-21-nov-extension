// node --test tests/unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDialogue } from '../../dashboard/transcriber.js';

test('two-channel transcript is interleaved by time and labelled Agent / Caller', () => {
  const agent = { chunks: [{ timestamp: [0, 3], text: ' Hi, this is Sara from Coco.' }, { timestamp: [9, 12], text: ' Sure, I can help.' }, { timestamp: [12.5, 14], text: ' One moment.' }] };
  const caller = { chunks: [{ timestamp: [3.5, 8], text: ' Hello, I need a refund.' }, { timestamp: [20, 21], text: ' [BLANK_AUDIO]' }] };
  assert.equal(mergeDialogue([agent, caller], ['Agent', 'Caller']),
    '[0:00] Agent: Hi, this is Sara from Coco.\n[0:03] Caller: Hello, I need a refund.\n[0:09] Agent: Sure, I can help. One moment.');
});

test('a silent side (null) is skipped', () => {
  assert.equal(mergeDialogue([null, { chunks: [{ timestamp: [65, 70], text: 'Call me back please' }] }], ['Agent', 'Caller']),
    '[1:05] Caller: Call me back please');
});
