# Dashboard — Scope (v1, built)

Location: `dashboard/` — static HTML + plain JS + `@supabase/supabase-js@2.45.4` (CDN). No build step; host on Netlify/Vercel/any static host. Login: Supabase email magic link. All data through RLS + security-definer RPCs.

Look & feel follows zero-restaurant.com: black surfaces, amber `#FFBA00` accent band, Oswald uppercase headings, DM Sans body. Shared tokens in `theme.css` (same file as `extension/shared/theme.css`).

## Pages

| Page | Who | Content |
|---|---|---|
| **Overview** | all | Range (Today / 7 d / 30 d / custom) + agent filter. KPI tiles: Outbound reaches (once per contact per day), Calls out (% connected), Texts out, Calls in (missed), Texts in (voicemails), Reply rate (avg reply time). Daily trend chart. Auto **Analysis** panel (missed calls, connect rate, reply speed, top agent, silent extensions, unclassified events). Agents table → click to filter. CSV report download. |
| **Conversations** | managers | Search list + chat timeline (texts, calls, voicemails) with Claude's review beside it; flagged messages outlined red. "Analyze this conversation" button. |
| **Reports** | managers (agents: "My coaching") | Analysis schedule + "Run analysis now", conversations reviewed, avg score, outcome mix, most common mistakes, lowest-scored conversations, weekly coaching reports. |
| **Settings** | admin | Business timezone (US zones), analysis schedule + models + retention, agents (add → one-time token, rotate token, account type, active), dashboard users and roles. |

## Non-goals for v1

No editing of messages, no sending texts/calls from the dashboard.
