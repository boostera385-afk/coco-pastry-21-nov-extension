# Recordings & transcription — plan and status

_Decided 2026-11-23._ **Wait for the first real recorded call.** If Google provides its own transcript, nothing more
is needed. If not, build **Option 2** (in-browser Whisper "Transcribe" button).

## Current status

| Item | Status |
|---|---|
| Voicemail audio copied to private storage (`recordings` bucket, admin-only) | Built, tested (`tests/e2e/media.mjs`) |
| Voicemail transcript from Google (message field @21) | Built — shown as the voicemail text |
| Admin switch "Save voicemail and call-recording audio" | Built (Settings → Call recordings & voicemails) |
| Live call recording | **Waiting** — must be enabled by a Workspace admin in Google Admin → Apps → Google Workspace → Google Voice → Call recording |
| Call-recording transcript | **Unknown** — verify on the first recorded call |

## Step 1 — verify with the first recorded call (do this first)

1. Workspace admin enables Call recording for the agent's organisational unit.
2. Agent makes one test call and records it (Google announces the recording to the caller).
3. Agent opens Voice → Calls (so the thread loads), then downloads samples from the extension Settings page.
4. Check in the samples / `raw_events`:
   - the call message has an audio URL at index 11 (`https://www.google.com/voice/media/...`) → the extension uploads it automatically (`calls.recording_path`);
   - whether index 21 holds transcript text for the call.
5. Confirm the recording plays in Dashboard → Conversations for that contact.

**If Google's transcript is present:** store it in `calls.transcript` (the parser already emits `transcript` for calls;
`ingest_batch` still needs to write it — small change) and stop here.

**If there is no transcript:** go to Step 2.

## Step 2 — Option 2: in-browser Whisper (free, private)

- Library: Transformers.js (`@huggingface/transformers`, Whisper models, MIT licence), loaded from a CDN in the dashboard.
- Admin clicks **Transcribe** on a recording in Conversations → the browser downloads the audio via its signed URL,
  runs Whisper locally (WebGPU, falls back to WASM) and saves the text to `calls.transcript` / `messages.body`.
- Cost $0; audio never leaves our system. First use downloads the model once (≈40–250 MB by size, then cached).
  Speed on a normal laptop ≈10–60 s per minute of audio. Fine for a few calls per day.
- Needs approval before adding the library (new dependency).

## Later options (only if volume grows)

- **Option 3:** faster-whisper / whisper.cpp script on an always-on PC or small server: polls storage for
  untranscribed recordings, writes text back. Free, private, automatic.
- **Option 4:** hosted APIs (Groq Whisper, Google Speech-to-Text, Azure, Deepgram, AssemblyAI, Cloudflare Workers AI).
  Free tiers are limited/trial credit, and customer audio leaves our system — check privacy obligations first.
- Not Claude: Claude does not transcribe audio, and Claude analysis is on hold (department rule).

## Counting rules (for reference)

Incoming call outcomes are separate: **answered / missed / voicemail**; *Calls in* = all three. Google stores a call
that went to voicemail only as the voicemail, so a voicemail counts as one incoming call (deduped against an inbound
call from the same number within the previous 5 minutes). See migrations `20261123140000` and `20261123160000`.
