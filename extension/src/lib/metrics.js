// Shared date + metric helpers (used by background and popup).
// Rule (department, 2026-11-23): every call and every text counts; contacts = distinct numbers in the range.

export const DEFAULT_TZ = 'Asia/Karachi';
/** Outgoing call of at least this many seconds = a real conversation (dashboard setting, default 60). */
export const CONVERSATION_SEC = 60;

/** YYYY-MM-DD of a timestamp in the given IANA timezone. */
export function dayKey(ms, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Hour 0-23 of a timestamp in the given timezone. */
export function hourOf(ms, tz = DEFAULT_TZ) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms));
  return Number(h) % 24;
}

/** Offset (ms) of tz from UTC at instant ms. */
function tzOffset(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - (ms - (ms % 1000));
}

/** UTC ms of 00:00 on the business day containing ms. */
export function startOfDay(ms, tz = DEFAULT_TZ) {
  const [y, m, d] = dayKey(ms, tz).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // two passes handle DST edges
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

/** Shift a YYYY-MM-DD key by n days. */
export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Summarize compact local events.
 * event: { id, k: 'call'|'text'|'voicemail', d: 'in'|'out', c: contact, at: ms, o: outcome, s: durationSec }
 */
export function summarize(events, fromKey, toKey, tz = DEFAULT_TZ) {
  const r = {
    outboundTotal: 0, inboundTotal: 0, contactsReached: 0,
    outboundCalls: 0, connectedCalls: 0, conversations: 0, outboundTexts: 0,
    inboundCalls: 0, missedCalls: 0, inboundTexts: 0, voicemails: 0,
  };
  const reached = new Set();
  for (const e of events) {
    const day = dayKey(e.at, tz);
    if (day < fromKey || day > toKey) continue;
    if (e.k === 'call' && e.d === 'out') {
      r.outboundCalls++;
      // Voice can't tell a person from voicemail/bots on outgoing calls: >0 s = picked up, >= 60 s = conversation
      if (e.s > 0) r.connectedCalls++;
      if (e.s >= CONVERSATION_SEC) r.conversations++;
    }
    if (e.k === 'text' && e.d === 'out') r.outboundTexts++;
    if (e.k === 'call' && e.d === 'in') { r.inboundCalls++; if (e.o === 'missed' || e.o === 'voicemail') r.missedCalls++; }
    if (e.k === 'text' && e.d === 'in') r.inboundTexts++;
    // Voice stores a missed call that went to voicemail ONLY as the voicemail: count it as a missed incoming
    // call too, unless an incoming call from the same number was recorded in the 5 minutes before it
    if (e.k === 'voicemail') {
      r.voicemails++;
      const already = events.some((x) => x.k === 'call' && x.d === 'in' && x.c === e.c && x.at <= e.at && e.at - x.at <= 5 * 60e3);
      if (!already) { r.inboundCalls++; r.missedCalls++; }
    }
    if (e.d === 'out' && (e.k === 'call' || e.k === 'text')) r.outboundTotal++;
    if (e.d === 'in') r.inboundTotal++;
    if (e.d === 'out' && e.c) reached.add(e.c);
  }
  r.contactsReached = reached.size;
  return r;
}
