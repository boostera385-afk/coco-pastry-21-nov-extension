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
3. **Team logins** (no email needed)
   - Dashboard → Settings (admins) / Team (managers) → **Create user**: name, email, role → shows a temporary password once (+ the extension token for agents). User must pick their own password at first sign-in.
   - Admins: any role, change roles, reset passwords, remove users. Managers: agent users only.
   - Server side: `supabase/functions/team` (service key never reaches the browser). Deploy: `supabase functions deploy team`.
4. **Each agent** (token is the only setup)
   - Admin: dashboard → Settings → Agents → **Add agent & create token** → copy and send it privately.
   - Agent: `chrome://extensions` → Developer mode → **Load unpacked** → choose the `extension/` folder (not the whole project).
   - Click the Coco icon → **Settings** → paste token → **Connect** → shows "Connected as <name>".
   - Keep a pinned `voice.google.com` tab open. Works for personal and Workspace Voice.

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
node --test extension/test
```
