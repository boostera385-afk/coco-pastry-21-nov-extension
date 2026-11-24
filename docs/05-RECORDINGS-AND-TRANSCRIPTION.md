# Recordings & transcription

_Updated 2026-11-24._ **Plan B is live: Coco records calls itself.** No Google Workspace admin setting is needed, so it
works on every agent's business Voice account, whether or not their Workspace allows Google's own recording.

## How it works

| Step | Where | Detail |
|---|---|---|
| Record | Extension (`src/recorder.js`, page script) | Watches Google Voice's own WebRTC call (never changes it). Agent mic → **left** channel, caller → **right** channel. Opus/WebM, 32 kbps (≈14 MB per hour). Calls over 90 min are split into parts. Calls under 2 s are dropped. |
| Hand-off | `src/content.js` → service worker | File goes to an IndexedDB queue (`src/lib/recstore.js`). It survives offline time, a closed tab and browser restarts. |
| Upload | `ingest?rec=<uuid>&start=&dur=` | Stored as `recordings/<agent>/rec-<uuid>.webm` (private bucket, admins only). Row in `call_recordings`. |
| Link to call | `match_call_recordings()` | Matched by time: the call starts up to 3 min before audio flows. Runs on upload and after every synced batch, so the order doesn't matter. If Google's own recording exists, Google's copy stays on the call. |
| Transcribe (automatic) | `supabase/functions/transcribe` | Starts by itself when a recording or voicemail arrives. **Server first:** Groq Whisper large-v3-turbo transcribes each speaker's mono file (the extension uploads `rec-<id>-agent.webm` / `-caller.webm` next to the stereo file), then merges them into `[0:05] Agent: … / Caller: …`. **Fallback:** without `GROQ_API_KEY`, or if Groq keeps failing, jobs go to any open admin dashboard. That runs Whisper in the browser: large-v3-turbo on WebGPU, small.en otherwise. Queue: `transcription_jobs` (claim with a lease, retries, never done twice). |
| Clean-up & conversation | `transcript-core.js` (same file in `dashboard/` and `supabase/functions/_shared/`) | Drops Whisper's made-up words on silence ("Thank you."), repetition loops and low-confidence pieces. Decides **who answered**: a real back-and-forth means *talked to a person*, which counts as a **conversation** even when short. A voicemail greeting never counts. Without a transcript, the old rule applies (≥ conversation seconds). |
| Agent laptops | — | Nothing to install or download. The extension only records and uploads; models never run on agent PCs. |
| Search | Recordings → Search transcripts | `search_transcripts()` covers call transcripts and voicemail text. |

### Switches

- **Per agent:** Settings → Agents → *Call recording* (default **on**). Reaches the extension on its next sync (≤1 min).
- **Master:** Settings → *Save call recordings and voicemail audio* (`app_settings.save_recordings`).
- Paused or disconnected extension = nothing is recorded.
- While recording, the in-page widget shows a red **REC** badge and the side panel says "recording this call".

### Consent (important)

Many US states require **all parties** to agree to recording. Agents should say *"this call may be recorded"*
at the start of every call. The REC badge only tells the agent; it does not tell the caller.

### Transcription details

- Models: `whisper-base.en` (fast, ~80 MB, default), `whisper-small.en` (more accurate, ~250 MB) and `whisper-base`
  (any language). Downloaded from Hugging Face once, then cached by the browser.
- WebGPU when available (Chrome/Edge), WebAssembly otherwise. Roughly 10–60 s per minute of audio. Verified on a real
  voicemail: 78 s including the first model download.
- A silent channel (for example a muted mic) is skipped, so Whisper doesn't make up words.
- Voicemails: Google's own transcript is used when present. Otherwise Whisper fills `messages.body` (`transcript_source = 'whisper'`).

### Known limits

- Only calls made **in the browser** (voice.google.com) can be recorded. Calls answered on a phone or the mobile app
  bypass the browser. Google's own recording, if enabled, still covers those.
- If the Voice tab is closed **during** a call, that call's audio is lost (the file is built when the call ends).
- Transcription only runs while an admin has the Recordings page open. If volume grows, the same worker code can run
  on an always-on PC (Option 3 below).

## Tests

- `node tests/e2e/recording.mjs` (33 checks): a loopback WebRTC call in a mocked Voice page. It checks that the extension
  records, uploads and links the file to the call, that both channels contain audio, that the admin switch stops
  recording, and it also covers transcript permissions, shifts, the busiest-times grid and team stats.
- `node tests/e2e/transcribe.mjs`: read-only. Runs in-browser Whisper on the newest recording waiting for a transcript.
- `node --test tests/unit`: transcript merge (Agent/Caller interleaving).

## Later options (only if volume grows)

- **Option 3:** faster-whisper / whisper.cpp on an always-on PC: polls `transcription_queue()`, writes with the service key.
- **Option 4:** hosted APIs (Groq, Deepgram, AssemblyAI…). Faster, but customer audio leaves our system and they cost money.

## Counting rules (unchanged)

Incoming call outcomes are separate: **answered / missed / voicemail**; *Calls in* = all three. A voicemail counts as one
incoming call (deduped against an inbound call from the same number in the previous 5 minutes). See migrations
`20261123140000` and `20261123160000`.
