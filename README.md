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
3. **Each agent**
   - `chrome://extensions` → Developer mode → Load unpacked → `extension/` (or publish unlisted / force-install via Workspace admin).
   - Extension Settings → Supabase URL + their token (+ dashboard URL) → Save & test.
   - Keep a pinned `voice.google.com` tab open. Works for personal and Workspace Voice accounts.

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
