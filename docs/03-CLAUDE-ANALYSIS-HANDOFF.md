# Claude Analysis — Handoff for Ibraheem

The extension + backend deliver clean data into Supabase. This doc is the contract for the analysis worker.
Schema: `supabase/migrations/20261123000000_init.sql`.

## When to run (admin-controlled)

The admin picks the schedule in Dashboard → Settings (stored in `app_settings`):

| `analysis_mode` | Meaning |
|---|---|
| `manual` | Only when someone clicks "Run analysis now" / "Analyze this conversation". |
| `hourly` | Once per hour. |
| `daily` | Every day at `analysis_time` (business timezone). |
| `weekly` | Every week on `analysis_weekday` (0 = Sun) at `analysis_time`. |

Worker loop (run every ~15 min, e.g. `pg_cron` → Edge Function, or a small cron worker):

1. `select analysis_due();` (service role) → if `false`, stop. It returns `true` when the scheduled slot has passed since `app_settings.last_analysis_run_at`, **or** any `analysis_requests.status = 'pending'` exists.
2. Mark pending `analysis_requests` as `running`. A request with `conversation_id` → only that conversation; with `agent_id` → only that agent; neither → everything due.
3. Analyze (below). Then set `app_settings.last_analysis_run_at = now()` and requests to `done` / `error` (+ `finished_at`).
4. Weekly coaching reports: generate on the `analysis_weekday` run (or the first run after it) for the previous 7 days.

Models come from `app_settings.analysis_model` (per conversation, default `claude-sonnet-5-5`) and `app_settings.coaching_model` (weekly, default `claude-opus-5-5`). For scheduled runs prefer the Message Batches API (cheaper); use the normal API for on-demand requests.

## Inputs (read, service role)

| Table | Use |
|---|---|
| `conversations` | Due rows: `last_activity_at > coalesce(last_analyzed_at, '-infinity')`. |
| `messages` | Ordered by `occurred_at`; `direction` = agent (`outbound`) vs customer (`inbound`); `kind='voicemail'` = transcript. |
| `calls` | Interleave call events (direction, outcome, duration) so Claude sees e.g. "missed call, no callback for 2 days". |
| `agents` | Agent name for reports. |
| `app_settings.business_timezone` | Render timestamps in local business time so "replied at 11 pm" is judged correctly. |

Calls have **no audio/transcript** — call analysis is behavioural only (missed calls not returned, very short calls, call timing).

## Outputs (write, service role)

1. `conversation_analysis` — one row per run per conversation, then update `conversations.last_analyzed_at`.
   - `overall_score` 1–10, `outcome` (`booked | interested | follow_up | not_interested | no_reply | opted_out`), `sentiment`, `summary` (2–3 sentences).
   - `scores`: `{ "<rule_id>": 1-5, ... }` for each rubric point that applies.
   - `mistakes`: `[{ "message_id": uuid|null, "rule": "<rule_id>", "issue": "...", "severity": "low|medium|high", "suggestion": "rewrite or action" }]` — `message_id` lets the dashboard highlight the exact bubble; `rule` drives the "Most common mistakes" table.
   - `improvements`: `["...", "..."]`.
2. `agent_coaching_reports` — weekly per agent: `{ "summary": "...", "strengths": [], "top_mistakes": [], "action_items": [], "example_conversation_ids": [] }`.

Use tool use / structured output with a JSON schema matching the above so every row validates.

## Review rubric — best practices (rule ids)

| Rule id | Best practice | Typical mistake |
|---|---|---|
| `speed_to_lead` | Reply to inbound texts within 15 min and return missed calls within 1 h during business hours. | Customer waited hours; missed call never returned. |
| `opener` | First outbound text says who you are, the company, and why you're reaching out. | "Hey" / no name / no reason. |
| `personalization` | Uses the customer's name and context; not a pasted template. | Same generic blast to everyone. |
| `answers_question` | Directly answers what the customer asked before pushing the agenda. | Ignores the question, repeats pitch. |
| `clarity` | Short, one idea per message, plain language, correct spelling and grammar. | Walls of text, typos, jargon. |
| `tone` | Friendly, professional, patient; matches the customer's tone. | Pushy, curt, or overly casual. |
| `call_to_action` | Every message ends with a clear next step (time slot, question, link). | Conversation drifts with no next step. |
| `follow_up` | Follows up on no reply (e.g. day 1, 3, 7) without spamming; switches channel (text ↔ call) when stuck. | One attempt then silence, or 5 texts in an hour. |
| `objection_handling` | Acknowledges concerns, asks a question, offers a solution. | Argues or drops the lead on first "no". |
| `timing` | Contacts customers between 8 am and 9 pm in *their* local time (TCPA quiet hours). | Texts at 11 pm. |
| `compliance` | Honors STOP/opt-out immediately; no misleading claims; no sensitive data over SMS. | Keeps texting after "stop". |
| `closing` | Confirms the outcome (appointment details, recap) and thanks the customer. | Booking left vague. |

Score each applicable rule 1–5, derive `overall_score` 1–10, and flag only real, specific mistakes (quote the message via `message_id`). For `compliance` violations always use `severity: "high"`.

## Privacy

- Mask phone numbers before sending to Claude (`+1•••••1234`); send only the transcript, call events and rubric.
- Only managers can read transcripts and analysis in the dashboard (RLS); agents see only their coaching reports.
- Respect `app_settings.retention_days` (delete older `messages`/`raw_events` in the same worker or a `pg_cron` job).
