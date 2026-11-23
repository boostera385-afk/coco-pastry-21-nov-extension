# Coco — Google Voice Activity Tracker

Chrome extension (no Google API) → Supabase → small dashboard + Claude analysis.
Plan and decisions: `docs/00-MASTER-PLAN.md`.

```
extension/   Chrome MV3 extension (popup = mini dashboard, options = setup + parser check)
supabase/    migration (schema, RLS, metrics RPCs) + /ingest Edge Function
dashboard/   static dashboard (open index.html via any static host)
docs/        plan, architecture, Claude analysis handoff (Ibraheem), dashboard scope
```

## Setup

1. **Supabase**
   - Create a project. Run `supabase/migrations/20261123000000_init.sql` (SQL editor or `supabase db push`).
   - Deploy ingest: `supabase functions deploy ingest --no-verify-jwt`.
   - Auth → URL configuration: add your dashboard URL as a redirect URL.
2. **Dashboard**
   - Put your project URL + anon key in `dashboard/config.js`, deploy the `dashboard/` folder to a static host.
   - Open it, sign in once, then make yourself admin in the SQL editor:
     `insert into profiles (user_id, role) select id, 'admin' from auth.users where email = 'you@company.com';`
   - Settings → pick the business timezone and the Claude analysis schedule → add agents (copy each token, shown once).
3. **Team logins** (no email needed) — admins only
   - Dashboard → Settings → **Create user**: name, email, role → shows a temporary password once (+ the extension token for agents). User must pick their own password at first sign-in.
   - **Admin** sees everything. **Agent** sees only their own numbers (no other agents, contacts or message text).
   - Server side: `supabase/functions/team` (service key never reaches the browser). Deploy: `supabase functions deploy team`.
4. **Each agent** (token is the only setup)
   - Admin: dashboard → Settings → Agents → **Add agent & create token** → copy and send it privately.
   - Agent: `chrome://extensions` → Developer mode → **Load unpacked** → choose the `extension/` folder (not the whole project).
   - Click the Coco icon → **Settings** → paste token → **Connect** → shows "Connected as <name>".
   - Keep a pinned `voice.google.com` tab open (Google Voice **business** account). Tracking starts the moment the token is connected — no old history.

## Department rules (2026-11-23)

Business Voice accounts only · every call and every text counts (per contact) · tracking starts at connect, no old history · Admin sees everything, agents see only their own numbers · Claude on hold — rule-based **Analysis** page instead (missed calls, unanswered texts, opt-outs, over-contacting, follow-ups, quiet hours, short calls; admin reviews each issue) · Pakistan time (Asia/Karachi). Details: `docs/00-MASTER-PLAN.md` §8.

## Using the extension

- **Side panel**: clicking the toolbar icon opens a panel that stays open while you work. To show it on the **left**: Chrome menu → Settings → Appearance → *Side panel position* → Left.
- **Left mini tracker** on the Google Voice page: a small tab on the left edge; click to expand, × to close. Hide it in Settings.
- **Close ≠ stop**: closing the panel or widget keeps tracking running in the background. **Pause** stops live capture; the dashboard shows the agent as *Paused*.
- **Icon badge**: today's outbound reaches (green = tracking, yellow = open Google Voice, red `!` = problem, `II` = paused).
- Robustness: re-injects into already-open Voice tabs after install/update, survives extension reloads, offline queue with retry/backoff, unlimited local storage, 30 s request timeout, clear errors (bad token / offline).
- The Supabase URL and dashboard URL are built in (`extension/src/config.js`); host access is limited to Voice and this one Supabase project.

## Parser check (do once before rollout)

Google's internal Voice payloads are undocumented, so `extension/src/parser/gv-protojson.js` → `FIELD_MAP` is a best guess (`PARSER_VERSION` ends in `-unverified`).

1. Extension Settings → tick **Record samples** → use Voice: open Calls, Messages, a thread, send a text, receive a text, make/receive a call, a voicemail.
2. **Download samples** (numbers redacted) and compare against `FIELD_MAP` (message id / timestamp / type code / text / duration / transcript positions and the type codes).
3. Fix the map, bump `PARSER_VERSION`, run tests. The Settings page shows a **sent-text self-check** (every text you send should be matched by a parsed outbound text) and an **unclassified** count — both should be clean.

Anything unclassified is still stored in `unclassified_events` with the raw payload, so nothing is lost while the map is being fixed.

## Tests

```
node --test extension/test                      # unit: metrics, timezone, parser (incl. real Voice SMS payload)
node tests/e2e/run.mjs                          # virtual end-to-end (94 checks), see below
node tests/e2e/team.mjs .env dashboard/config.js   # team/permissions (13 checks)
node scripts/reparse.mjs [--dry]                # re-run the current parser over stored raw events
```

`tests/e2e/run.mjs` loads the real extension in Playwright's Chromium, serves a mock `voice.google.com`
(Voice-format payloads from `tests/e2e/fixtures.mjs`), and talks to the **real** Supabase project with a
throwaway agent and users that are deleted afterwards. It covers: token connect, install-day cutoff,
texts/calls/voicemail/unknown capture, no history before connecting, every call/text counted, contacts page, rule-based analysis + admin review, badge, widget, side panel, sent-text self-check,
no duplicates on reload, pause/resume, sync, dashboard metrics, reply rate/time, live dashboard UI,
transcript security (agent vs manager vs anonymous) and revoked tokens. SMS format is verified from a
live account; call/voicemail codes are still a best guess until real calls are captured.
