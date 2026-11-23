// Parser for Google Voice web's internal "protojson" responses (positional arrays).
// No official API is called: we only read responses the Voice web app already loaded.
//
// IMPORTANT: Google does not document these payloads. FIELD_MAP below is a best guess
// and MUST be verified in Phase 0 (options page -> "Record samples"). Anything the map
// can't classify is still sent with direction/kind = 'unknown' plus the raw array, so it
// can be re-parsed server-side later and is visible on the dashboard as "unclassified".

export const PARSER_VERSION = '0.6.0-voicemail-verified';

export const FIELD_MAP = {
  // thread = [threadId, isRead, [messages...], ...]
  thread: { id: 0, messages: 2 },
  // message = [msgId, timestampMs, phone, [phones], typeCode, read, …, text, …, threadId]
  // VERIFIED 2026-11-23 from live SMS (sent + received): id@0, timestamp ms@1, type@4, text@9.
  // VERIFIED 2026-11-23 from live calls: call threads are "c.<id>", type 14 = outgoing call,
  // duration (seconds) @8, contact = participants[0] @3.
  // VERIFIED 2026-11-23 from a live voicemail: type 2, audio URL @11, transcript block @21 ([[segments], _, status]).
  // NOT yet verified: incoming answered / missed call codes.
  message: { id: 0, timestamp: 1, participants: 3, type: 4, duration: 8, text: 9, media: 11, transcript: 21 },
  // typeCode -> { kind, direction, outcome }   (2/10/11/14 verified; others still a best guess)
  typeCodes: {
    1:  { kind: 'call', direction: 'inbound', outcome: 'answered' },
    2:  { kind: 'voicemail', direction: 'inbound', outcome: 'voicemail' },
    4:  { kind: 'call', direction: 'inbound', outcome: 'missed' },
    5:  { kind: 'call', direction: 'inbound', outcome: 'rejected' },
    7:  { kind: 'call', direction: 'outbound', outcome: null },
    10: { kind: 'text', direction: 'inbound', outcome: null },
    11: { kind: 'text', direction: 'outbound', outcome: null },
    14: { kind: 'call', direction: 'outbound', outcome: null },
  },
};

const E164 = /^\+[1-9]\d{6,14}$/;
const isTs = (v) => {
  const n = typeof v === 'string' && /^\d{13}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && n > 1.4e12 && n < 2.5e12 ? n : null;
};

export function stripXssi(text) {
  return String(text || '').replace(/^\)\]\}'\s*/, '');
}

export function safeJson(text) {
  try { return JSON.parse(stripXssi(text)); } catch { return null; }
}

/** Find the first E.164 number anywhere in a value (depth-limited). */
export function findPhone(v, depth = 4, exclude = null) {
  if (typeof v === 'string') return E164.test(v) && v !== exclude ? v : null;
  if (!Array.isArray(v) || depth < 0) return null;
  for (const x of v) {
    const p = findPhone(x, depth - 1, exclude);
    if (p) return p;
  }
  return null;
}

/** Thread ids look like "t.+15551234567" for 1:1 threads. */
export function contactFromThreadId(id) {
  const m = /^t\.(\+\d{7,15})$/.exec(String(id || ''));
  return m ? m[1] : null;
}

function looksLikeThread(t) {
  return Array.isArray(t) && typeof t[FIELD_MAP.thread.id] === 'string'
    && /^[tgc]\./.test(t[FIELD_MAP.thread.id]) && Array.isArray(t[FIELD_MAP.thread.messages]);
}

/** Collect thread arrays wherever they sit in the response. */
function collectThreads(node, out = [], depth = 0) {
  if (!Array.isArray(node) || depth > 6) return out;
  if (looksLikeThread(node)) { out.push(node); return out; }
  for (const x of node) collectThreads(x, out, depth + 1);
  return out;
}

/** Google's transcript block: a string, or nested arrays of word/segment strings. */
export function transcriptText(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (!Array.isArray(v)) return null;
  const words = [];
  const walk = (x, d) => { if (d > 5) return; if (typeof x === 'string') words.push(x); else if (Array.isArray(x)) x.forEach((y) => walk(y, d + 1)); };
  walk(v[0], 0);
  const t = words.join(' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

function parseMessage(m, threadId, agentNumber) {
  if (!Array.isArray(m) || typeof m[FIELD_MAP.message.id] !== 'string') return null;
  const at = isTs(m[FIELD_MAP.message.timestamp]) ?? m.map(isTs).find(Boolean);
  if (!at) return null;
  const code = m[FIELD_MAP.message.type];
  const cls = FIELD_MAP.typeCodes[code] || { kind: 'unknown', direction: 'unknown', outcome: null };
  const parts = m[FIELD_MAP.message.participants];
  const first = Array.isArray(parts) && typeof parts[0] === 'string' && E164.test(parts[0]) && parts[0] !== agentNumber ? parts[0] : null;
  const contact = contactFromThreadId(threadId) || first || findPhone(parts, 2, agentNumber) || findPhone(m, 4, agentNumber);
  const text = typeof m[FIELD_MAP.message.text] === 'string' ? m[FIELD_MAP.message.text] : null;
  const transcript = transcriptText(m[FIELD_MAP.message.transcript]);
  const media = typeof m[FIELD_MAP.message.media] === 'string' && /^https:\/\/[a-z0-9.-]*google\.com\/voice\/media\//.test(m[FIELD_MAP.message.media])
    ? m[FIELD_MAP.message.media] : null;
  const dur = Number(m[FIELD_MAP.message.duration]);
  return {
    type: cls.kind,
    gv_id: m[FIELD_MAP.message.id],
    gv_thread_id: threadId,
    agent_number: agentNumber || null,
    contact_number: contact,
    direction: cls.direction,
    occurred_at: new Date(at).toISOString(),
    body: cls.kind === 'voicemail' ? (transcript || text || null) : (cls.kind === 'text' ? text : null),
    media_url: media,
    transcript: cls.kind === 'call' ? transcript : null,
    call_outcome: cls.outcome,
    duration_sec: Number.isFinite(dur) && dur >= 0 && dur < 86400 ? Math.round(dur) : 0,
    type_code: code ?? null,
    raw: m,
  };
}

/**
 * Parse one captured response.
 * @returns {{ events: object[], agentNumber?: string }}
 */
export function parseResponse(url, bodyText, ctx = {}) {
  const data = safeJson(bodyText);
  if (!data) return { events: [] };

  if (/account\/get/.test(url)) {
    return { events: [], agentNumber: findPhone(data, 6) };
  }
  if (/api2thread\/sendsms/.test(url)) return { events: [] }; // request echo, handled by parseSendRequest
  // Any other voiceclient response: Google may deliver threads through several endpoints.

  const events = [];
  for (const t of collectThreads(data)) {
    const tid = t[FIELD_MAP.thread.id];
    for (const m of t[FIELD_MAP.thread.messages]) {
      const e = parseMessage(m, tid, ctx.agentNumber);
      if (e) events.push(e);
    }
  }
  return { events };
}

/**
 * Outbound text detected from the agent's own send request (high confidence,
 * independent of FIELD_MAP). Id is provisional; the real one arrives on next list refresh.
 */
export function parseSendRequest(url, reqBody, ctx = {}) {
  if (!/api2thread\/sendsms/.test(url)) return null;
  const req = safeJson(reqBody);
  if (!req) return null;
  const strings = JSON.stringify(req).match(/"(?:[^"\\]|\\.)*"/g)?.map((s) => JSON.parse(s)) || [];
  const threadId = strings.find((s) => /^[tg]\./.test(s)) || null;
  const contact = contactFromThreadId(threadId) || findPhone(req, 6, ctx.agentNumber);
  const text = strings.filter((s) => !/^[tg]\./.test(s) && !E164.test(s)).sort((a, b) => b.length - a.length)[0] || null;
  return { contact, threadId, text, at: Date.now() };
}
