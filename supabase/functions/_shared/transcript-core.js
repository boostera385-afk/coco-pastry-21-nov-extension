// Shared transcript logic — used by the dashboard (browser Whisper) AND the `transcribe` Edge Function (Groq).
// KEEP IN SYNC: supabase/functions/_shared/transcript-core.js is a byte-for-byte copy (a unit test checks it).
//
// 1. cleanSegments: drop Whisper's typical mistakes — text invented on silence ("Thank you.", "Bye."),
//    low-confidence fragments, repetition loops and exact repeats.
// 2. mergeTurns / formatTurns: interleave per-speaker segments by time -> "[0:05] Agent: … / [0:09] Caller: …".
// 3. detectAnsweredBy: decide from the words whether a real person talked with the agent or the call hit a
//    voicemail greeting. Used for "conversation" (a short real talk counts; a voicemail never does).

const SILENCE_WORDS = /^(thank you|thanks|thank you very much|thanks for watching|bye|bye-bye|you|okay|ok|so|um|uh|hmm|mm-hmm|\.+)[.!?]*$/i;
const NOISE = /^[\s[(♪*-]*(blank_audio|music|silence|inaudible|no speech|sound|noise|beep|applause|laughter)?[\])♪*\s.]*$/i;

/**
 * segs: [{ start, end, text, no_speech_prob?, avg_logprob?, compression_ratio? }]
 * Returns cleaned segments (same shape).
 */
export function cleanSegments(segs) {
  const out = [];
  for (const s of segs || []) {
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text || NOISE.test(text)) continue;
    const dur = Math.max(0, Number(s.end ?? 0) - Number(s.start ?? 0));
    const nsp = Number(s.no_speech_prob ?? 0);
    const lp = Number(s.avg_logprob ?? 0);
    const cr = Number(s.compression_ratio ?? 0);
    if (nsp > 0.6 && lp < -0.7) continue;              // probably silence / line noise
    if (lp < -1.2) continue;                           // the model itself is unsure
    if (cr > 2.4) continue;                            // repetition loop ("I'm sorry, I'm sorry, I'm sorry…")
    if (SILENCE_WORDS.test(text) && (nsp > 0.2 || dur < 1.5)) continue; // classic silence hallucinations
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === text.toLowerCase()) continue;
    out.push({ start: Number(s.start ?? 0), end: Number(s.end ?? s.start ?? 0), text });
  }
  return out;
}

/** Interleave speakers by time; consecutive lines of one speaker are joined. lists[i] = cleaned segments of labels[i]. */
export function mergeTurns(lists, labels, joinGap = 2) {
  const lines = [];
  lists.forEach((segs, i) => (segs || []).forEach((s) => lines.push({ at: s.start, end: s.end, who: labels[i], text: s.text })));
  lines.sort((a, b) => a.at - b.at || a.end - b.end);
  const merged = [];
  for (const l of lines) {
    const last = merged[merged.length - 1];
    if (last && last.who === l.who && l.at - last.end <= joinGap) { last.text += ` ${l.text}`; last.end = Math.max(last.end, l.end); } else merged.push({ ...l });
  }
  return merged;
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
export const formatTurns = (turns) => turns.map((l) => (l.who ? `[${clock(l.at)}] ${l.who}: ${l.text}` : `[${clock(l.at)}] ${l.text}`)).join('\n');

const VOICEMAIL = /(leave (me |us )?(a |your )?(brief |short )?(message|name|number|voicemail)|after the (tone|beep)|at the (tone|beep)|(is|are) (not|un)available|isn'?t available|can'?t (come to|take|get to|answer) the (phone|call)|unable to (take|answer)|voice ?mail|mailbox|record your message|not in service|has been disconnected|please try (your call )?again later|the (person|number|subscriber) you (are|have) (calling|called|dialed)|google (voice )?subscriber|press (1|one|pound)|stay on the line)/i;
const words = (s) => (String(s).match(/[a-z0-9']+/gi) || []).length;

/**
 * turns: output of mergeTurns (labels 'Agent' / 'Caller'), or unlabelled [{ text }].
 * Returns 'human' | 'voicemail' | null (unknown).
 */
export function detectAnsweredBy(turns, { labelled = true } = {}) {
  if (!turns?.length) return null;
  if (!labelled) return VOICEMAIL.test(turns.map((t) => t.text).join(' ')) ? 'voicemail' : null;
  const caller = turns.filter((t) => t.who === 'Caller');
  const agent = turns.filter((t) => t.who === 'Agent');
  const callerText = caller.map((t) => t.text).join(' ');
  const callerWords = words(callerText);
  const firstCaller = caller[0]?.at ?? Infinity;
  const agentAfter = agent.filter((t) => t.at > firstCaller);
  const agentWordsAfter = agentAfter.reduce((n, t) => n + words(t.text), 0);
  let switches = 0;
  for (let i = 1; i < turns.length; i++) if (turns[i].who !== turns[i - 1].who) switches++;
  // a real back-and-forth: caller spoke, agent answered them, and the caller came back at least once
  const dialogue = callerWords >= 3 && agentWordsAfter >= 3 && caller.length >= 2 && switches >= 2;
  if (VOICEMAIL.test(callerText) && !(dialogue && caller.length >= 3)) return 'voicemail';
  if (dialogue) return 'human';
  if (callerWords >= 6 && agentWordsAfter >= 3) return 'human';
  return null;
}
