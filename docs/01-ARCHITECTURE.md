# Architecture — Extension & Sync Pipeline

## 1. Chrome extension (Manifest V3)

### manifest.json (sketch)

```json
{
  "manifest_version": 3,
  "name": "Coco Voice Tracker",
  "version": "0.1.0",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://voice.google.com/*", "https://<project>.supabase.co/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["https://voice.google.com/*"], "js": ["src/interceptor.js"],
      "world": "MAIN", "run_at": "document_start" },
    { "matches": ["https://voice.google.com/*"], "js": ["src/content.js"],
      "run_at": "document_start" }
  ],
  "action": { "default_popup": "popup/popup.html" },
  "options_page": "options/options.html"
}
```

`"world": "MAIN"` (Chrome 111+) lets `interceptor.js` run inside the page so it can wrap `window.fetch` and `XMLHttpRequest` before Google's code loads.

### Capture flow

1. **interceptor.js (MAIN world)** — wraps `fetch` / `XHR`. For responses whose URL matches `/voice/v1/voiceclient/(api2thread/(list|get)|account/get)`, clone the body and `window.postMessage({source:'coco', url, body})`. It never alters or blocks the request.
2. **content.js (ISOLATED world)** — listens for `coco` messages, checks `event.source === window`, forwards to background via `chrome.runtime.sendMessage`. Also runs the **DOM fallback** observer and the **health heartbeat** (page loaded, logged-in account, last capture time).
3. **background.js (service worker)**
   - `parser/gv-protojson.js` turns positional arrays into normalized events (field map from Phase 0).
   - Dedupes by `gv_id` against a local set of recently-seen IDs.
   - Appends to a queue in `chrome.storage.local` (survives service-worker shutdown).
   - `chrome.alarms` every 1 min + immediately when queue ≥ 50 → POST batch to `/ingest`. On failure: exponential backoff, keep queue.
   - Keeps rolling local counters for the popup (today / 7 days) so the popup works offline.

### Normalized event shape (extension → backend)

```json
{
  "type": "call | message | voicemail",
  "gv_id": "Google's message/call id",
  "gv_thread_id": "Google's thread id",
  "agent_number": "+13072281262",
  "contact_number": "+1XXXXXXXXXX",
  "contact_name": "optional",
  "direction": "inbound | outbound",
  "occurred_at": "2026-11-21T17:41:00Z",
  "body": "text (messages) or transcript (voicemail)",
  "call_outcome": "answered | missed | voicemail | rejected | null",
  "duration_sec": 0,
  "raw": { "...": "original array slice, for re-parsing later" }
}
```

Sending `raw` lets us **re-parse server-side** if we discover a field mapping bug, without re-capturing.

### Popup

- Today / This week: Outbound calls · Outbound texts · Outbound reaches · Inbound calls (missed) · Inbound texts.
- Status: ● Connected / ● Queue pending (n) / ● Not capturing (open Voice tab) · last sync time.

### Breakage protection

- Heartbeat event sent every 15 min while a Voice tab is open. Backend flags an agent "silent" if a heartbeat arrives but zero events parse for 24 h despite page loads → parser probably broken.
- Parser version is sent with every batch (`parser_version`), stored on `raw_events`.

## 2. Supabase

- **Edge Function `/ingest`** (Deno/TS): header `x-agent-token: coco_…` → look up `agents.token_hash` (SHA-256) → `rpc ingest_batch` (drops events before `tracking_start`, upserts contacts, conversations, calls, messages, unclassified on `(agent_id, gv_id)`). Returns `{accepted, skipped_before_tracking_start, config}`. Deploy with `--no-verify-jwt`.
- Uses the service-role key **only inside the function**.
- **Views** compute metrics (`v_daily_agent_metrics`), see schema file.
- **pg_cron** (optional) to refresh a materialized view hourly if data grows large.

## 3. Data flow guarantees

| Concern | Handling |
|---|---|
| Duplicates (same thread loaded many times) | Unique `gv_id`; idempotent upserts. |
| Offline / Supabase down | Persistent queue in `chrome.storage.local`, retry with backoff. |
| Tab closed when message arrives | Captured on next load from thread list history. |
| Multiple Voice tabs open | Same IDs → dedupe; harmless. |
| Edited / status-changed message | Upsert updates fields. |
| Google changes payload | `raw` kept; heartbeat alert; DOM fallback. |

## 4. Phase 0 checklist (discovery)

1. Chrome → `voice.google.com` → DevTools → Network → filter `voiceclient`.
2. Reload Calls, Messages, Voicemail tabs; open one thread; send a test text; receive a test text; place and receive a test call; leave a test voicemail.
3. For each request, save URL + response to `docs/samples/` (**redact phone numbers and names**).
4. Fill `docs/gv-payload-map.md`: which array index = id, thread id, timestamp (ms epoch?), direction flag, text, duration, voicemail transcript.
5. Note whether new messages arrive via a push channel (signaler) followed by an `api2thread/list` refetch — that decides how real-time capture is.
