// Google Voice-format payloads for the virtual test.
// SMS layout is VERIFIED from a live account (2026-11-23): id@0, ts@1, phone@2, [phones]@3, type@4, read@5, text@9, threadId@last.
// Codes, duration@8, audio@11 and transcript@21 follow FIELD_MAP (2/10/11/14 verified from live data; others a best guess).

export const AGENT = '+13075550100';
export const A = '+15550100001'; // texts + outbound call
export const B = '+15550100002'; // inbound missed call + voicemail
export const C = '+15550100003'; // old event (before tracking start)
export const D = '+15550100004'; // inbound answered call, agent never replies
export const E = '+15550100005'; // arrives while paused
export const G1 = '+15550100006'; // group thread member
export const H = '+15550100007'; // activity 10 min BEFORE connecting (must be ignored)

let seq = 0;
const id = (tag) => `e2e${tag}${(++seq).toString(16).padStart(6, '0')}${'0'.repeat(28)}`.slice(0, 40);

/** Build one Voice message array. */
export function msg({ tag, at, phone, type, text = null, duration = null, transcript = null, thread }) {
  const m = new Array(32).fill(null);
  m[0] = id(tag); m[1] = at; m[2] = phone; m[3] = [phone, AGENT, null, null, null, null, 0];
  m[4] = type; m[5] = 1; m[9] = text; m[8] = duration; m[21] = transcript ? [[transcript.split(' ')], null, 1] : null;
  m[31] = thread;
  return m;
}
export const thread = (tid, msgs) => [tid, 1, msgs];
export const listBody = (threads) => `)]}'\n${JSON.stringify([threads, 'cursor-e2e'])}`;
export const accountBody = () => `)]}'\n${JSON.stringify([[null, [[AGENT]], 'e2e@example.com']])}`;

/** Scenario 1 — a working session that happens after the agent connected (now = end of the session).
 *  connectAt = the moment the token was connected; anything before it must be ignored. */
export function scenario(now, connectAt) {
  const min = 60e3;
  const t = (m) => now - m * min;
  const tA = `t.${A}`; const tB = `t.${B}`; const tC = `t.${C}`; const tD = `t.${D}`;
  const tG = 'g.Group Message.e2e';
  const threads = [
    thread(tA, [
      msg({ tag: 'a1', at: t(50), phone: A, type: 11, text: 'Hi Ali, this is Sam from Coco — are you free for a quick call today?', thread: tA }),
      msg({ tag: 'a2', at: t(45), phone: A, type: 10, text: 'Sure, call me at 3', thread: tA }),
      msg({ tag: 'a3', at: t(40), phone: A, type: 7, duration: 125, thread: tA }),         // outbound call, 2m05s
      msg({ tag: 'a4', at: t(30), phone: A, type: 11, text: 'Thanks Ali! Booked you for Friday 10am.', thread: tA }),
    ]),
    thread(tB, [
      msg({ tag: 'b1', at: t(35), phone: B, type: 4, thread: tB }),                        // inbound missed call
      msg({ tag: 'b2', at: t(34), phone: B, type: 2, transcript: 'Hi, please call me back about my order.', thread: tB }),
    ]),
    thread(tC, [
      msg({ tag: 'c1', at: now - 3 * 864e5, phone: C, type: 11, text: 'old message (before install)', thread: tC }),
    ]),
    thread(tD, [
      msg({ tag: 'd1', at: t(20), phone: D, type: 1, duration: 40, thread: tD }),          // inbound answered call
    ]),
    thread(tG, [
      msg({ tag: 'g1', at: t(15), phone: G1, type: 11, text: 'Group hello', thread: tG }),
    ]),
    thread(tA, [
      msg({ tag: 'u1', at: t(10), phone: A, type: 99, thread: tA }),                       // unknown code
    ]),
    thread(`t.${H}`, [
      msg({ tag: 'h1', at: connectAt - 10 * min, phone: H, type: 11, text: 'sent before connecting', thread: `t.${H}` }),
    ]),
  ];
  const expect = {
    // local panel / DB (today, Pakistan time). Every call and every text counts.
    outboundTotal: 4,        // a1 text, a3 call, a4 text, g1 text
    inboundTotal: 4,         // a2 text, b1 call, b2 voicemail, d1 call
    contactsReached: 2,      // A, G1
    outboundCalls: 1, connectedCalls: 1,
    outboundTexts: 3,        // a1, a4, g1   (c1 3 days ago and h1 before connecting are ignored)
    inboundCalls: 2, missedCalls: 1,   // b1 missed, d1 answered
    inboundTexts: 1,         // a2
    voicemails: 1,           // b2
    unclassified: 1,         // u1
    dbMessages: 5,           // a1 a2 a4 g1 + voicemail b2
    dbCalls: 3,              // a3 b1 d1
  };
  return { threads, expect };
}

/** Scenario 2 — a new inbound text from E (used for the pause test). */
export function scenarioPaused(now) {
  const tE = `t.${E}`;
  return thread(tE, [msg({ tag: 'e1', at: now - 60e3, phone: E, type: 10, text: 'Are you open today?', thread: tE })]);
}

/** Body the Voice web app sends for an outgoing SMS (used for the sent-text self-check). */
export const sendSmsBody = (text, to) => JSON.stringify([null, null, null, null, text, `t.${to}`, [], null, [Date.now()]]);
