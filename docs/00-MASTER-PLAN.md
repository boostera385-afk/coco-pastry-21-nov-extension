# Coco — Google Voice Activity Tracker: Master Plan

_Last updated: 2026-11-23_

## 1. Goal

A Chrome extension that runs on `voice.google.com` and, **without any official API**:

1. Counts **outbound reach** (calls placed + texts sent) per agent over any time window.
2. Counts **inbound activity** (calls received/missed, texts received, voicemails).
3. Syncs **every text message, call log entry and voicemail transcript** to **Supabase** automatically.
4. Feeds a **Claude analysis job** (built by Ibraheem) that reviews conversations and reports mistakes and what to improve.
5. Shows everything in a **simple dashboard** that reads from Supabase.

## 2. System at a glance

```
 voice.google.com tab
 ┌─────────────────────────────────────────────┐
 │ interceptor.js (MAIN world)                 │  wraps fetch/XHR, copies GV's own
 │   └─ postMessage ─► content.js (ISOLATED)   │  JSON responses (no extra requests)
 └───────────────────────────┬─────────────────┘
                             │ chrome.runtime.sendMessage
                    background.js (service worker)
                    parse → normalize → dedupe → queue (chrome.storage) → batch POST
                             │ HTTPS + agent token
                    Supabase Edge Function  /ingest
                             │ upsert (idempotent on Google IDs)
                    Supabase Postgres  ── raw_events, calls, messages, conversations …
                     │                         │
         Dashboard (React + supabase-js)   Claude analysis worker (Ibraheem)
         KPIs, charts, transcripts          writes conversation_analysis rows
```

Details: [01-ARCHITECTURE.md](01-ARCHITECTURE.md) · schema: [02-DATABASE-SCHEMA.sql](02-DATABASE-SCHEMA.sql) · Claude handoff: [03-CLAUDE-ANALYSIS-HANDOFF.md](03-CLAUDE-ANALYSIS-HANDOFF.md) · dashboard: [04-DASHBOARD.md](04-DASHBOARD.md)

## 3. Key research findings (read before building)

| Finding | Impact |
|---|---|
| Google Voice web has no public API, but the web app itself loads data from internal JSON endpoints (`clients6.google.com/voice/v1/voiceclient/api2thread/list`, `.../api2thread/get`, `.../account/get`, responses in `protojson` = positional arrays). | **Primary capture method:** passively intercept these responses inside the page. Much more stable and complete than reading the DOM. Exact endpoint names/field positions **must be verified in Phase 0**. |
| DOM scraping (MutationObserver on the Calls / Messages lists) works but breaks whenever Google changes class names. | Use as **fallback only**, with a health check that alerts when nothing is captured. |
| Call **audio/content is not available** — Google Voice doesn't record calls by default. Only **call metadata** (number, direction, time, duration, missed) and **voicemail transcripts** exist. | Claude can analyze **SMS conversations and voicemails** fully; for calls it can only analyze patterns (timing, duration, follow-up behaviour). Set this expectation with the team. |
| The thread list contains history, including calls/texts made from the phone app or while the tab was closed. | Activity is captured the next time the GV tab loads. Dedupe on Google's thread/message IDs makes re-sync safe. |
| The extension only sees data while a Voice tab is open and logged in. | Agents keep a Voice tab open (pinned). Popup shows "last synced" so gaps are visible. |
| The screenshot shows a "Work" Chrome profile — possibly **Google Workspace Voice**. | If so, a Workspace admin also has Voice audit logs / reports (call counts). Useful to cross-check numbers, but they don't contain SMS text, so the extension is still needed. |
| Google ToS discourages automated access. Passive reading of data the logged-in user already loaded is low-risk; **sending requests or auto-dialing is not** — out of scope. | v1 is read-only and never sends requests to Google on its own. |

## 4. Metric definitions (to confirm — see §8)

| Metric | Definition |
|---|---|
| Outbound calls | Calls with direction = outgoing, any outcome. |
| Connected outbound calls | Outgoing calls with duration ≥ 1 s (or answered flag). |
| Outbound texts | Every SMS/MMS with direction = outgoing. |
| **Outbound reaches** | Unique contacts the agent contacted (call or text). **A contact counts once per day** (business TZ); over a range = sum of daily uniques. |
| New-contact reaches | Contacts whose first-ever event was outbound in the window. |
| Inbound calls | Incoming calls, split answered / missed / voicemail. |
| Inbound texts | SMS/MMS with direction = incoming. |
| Response rate | % of contacts reached outbound who replied (text or call) within 7 days. |
| Avg reply time | For inbound texts: time until the agent's next outbound text in that thread. |

All counts come from SQL views, so the definitions can be changed later without touching the extension.

## 5. Phased plan

| Phase | Output | Est. | Owner |
|---|---|---|---|
| **0. Discovery** | Open DevTools on `voice.google.com` (logged in), record the network calls when you load Calls, Messages, a thread and receive a text. Save 3–5 sample responses (redact numbers). Write `docs/gv-payload-map.md` mapping array positions → fields. Confirm account type (personal vs Workspace). | 1–2 days | Dev |
| **1. Extension MVP** | MV3 extension: interceptor + parser + local store; popup shows today/this week counts and last-sync time. No backend yet. | 3–4 days | Dev |
| **2. Supabase backend** | Project, schema (02), RLS, `/ingest` Edge Function with per-agent tokens; extension syncs with retry queue. | 2–3 days | Dev |
| **3. Dashboard** | Login, KPI tiles, per-agent table, daily trend chart, conversation viewer, analysis panel. | 3–4 days | Dev |
| **4. Claude analysis** | Scheduled worker reads new conversations, writes `conversation_analysis` + weekly coaching summary. | per Ibraheem | Ibraheem |
| **5. Hardening & rollout** | Parser-break alerting, DOM fallback, options page, packaging (unlisted Chrome Web Store or managed install), onboarding doc for agents. | 2–3 days | Dev |

Milestone gates: Phase 1 is done when the popup counts match a manual count of one day's activity exactly.

## 6. Repository layout (planned)

```
Coco/
  docs/                  this plan + payload map
  extension/             Chrome MV3 extension (plain JS, no build step for v1)
    manifest.json
    src/interceptor.js   MAIN world, wraps fetch/XHR
    src/content.js       ISOLATED world bridge
    src/background.js    parse, dedupe, queue, sync
    src/parser/          gv-protojson.js
    popup/               counts + status
    options/             Supabase URL, agent token
  supabase/
    migrations/          SQL from 02-DATABASE-SCHEMA.sql
    functions/ingest/    Edge Function (Deno/TS)
  dashboard/             static HTML + JS + supabase-js (CDN)
```

## 7. Security & compliance

- Extension stores only: Supabase URL, the agent's ingest token, and an unsent-events queue. **Never** the Google password/cookies.
- Ingest goes through an Edge Function that validates the token — the extension never holds the service-role key.
- Row Level Security on all tables; dashboard users are Supabase Auth users with a role (`admin`, `manager`, `agent`).
- Customer messages are personal data: define a retention period, restrict who can read transcripts, and check local rules on storing/analyzing customer communications (and on outbound texting consent, e.g. TCPA in the US).
- Host permission limited to `https://voice.google.com/*` and the Supabase project URL.

## 8. Decisions (confirmed 2026-11-23)

| # | Question | Decision | Where it lives |
|---|---|---|---|
| 1 | Personal or Workspace Voice? How many numbers? | **Both supported.** Any number of agents; one token per agent. Capture is identical (same voice.google.com web app). | `agents.account_type`, Settings → Agents |
| 2 | "Outbound reach" | **Unique contact once per agent per business day** (call or text). Raw call/text counts shown alongside. | `metrics_summary`, `metrics_daily`, popup `summarize()` |
| 3 | Backfill history? | **No.** Tracking starts 00:00 (business TZ) of the install day. Older events are dropped in the extension *and* in `ingest_batch`. | `agents.tracking_start` |
| 4 | Who sees transcripts? | **Managers/admins only.** Agents see their own counts + coaching reports, never message text. | RLS in migration |
| 5 | Claude analysis timing | **Admin setting:** manual / hourly / daily at HH:MM / weekly on a day. Plus "Run analysis now" button. | `app_settings`, `analysis_due()`, `analysis_requests` |
| 6 | Review points | **Sales/customer-service best practices** rubric — see [03](03-CLAUDE-ANALYSIS-HANDOFF.md). | worker prompt |
| 7 | Business timezone | **US, admin-selectable** (Eastern default; Central, Mountain, Arizona, Pacific, Alaska, Hawaii). | `app_settings.business_timezone` |
| 8 | Dashboard stack | Static HTML + plain JS + supabase-js (CDN), no build step. Host on any static host. | `dashboard/` |

Still open: verify the Google Voice payload field map (Phase 0) — see `README.md` → "Parser check".
