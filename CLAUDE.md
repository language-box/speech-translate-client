# Speech Translate — Project Context

Real-time speech-to-speech translation web app. Two separate local git repos,
developed together but not in a monorepo:

- **Frontend (this repo):** `~/Desktop/translation-frontend`
- **Backend:** `~/Desktop/speech_translate_app`

A twin copy of this file lives in the backend repo as well, so whichever repo
you open first, you have the full picture. If the two ever drift, the backend
repo's copy is more likely to be current for backend internals and vice versa
— cross-check against the actual code, not just this doc.

## What this is

The user speaks into the mic; speech is streamed live to the backend, which
transcribes it (Deepgram), translates the finalized text (Google Cloud
Translate), and synthesizes translated audio (Google Cloud TTS) that plays
back in the browser. It's a live conversational tool, not a record-then-submit
form — audio streams continuously over a WebSocket while the mic is on.

```
Browser (mic capture, MediaRecorder)
   |  audio chunks over WebSocket (/ws)
   v
Node backend (server/wsHandler.js)
   |  relays audio, holds provider API keys — browser never sees them
   v
Deepgram streaming STT  --transcript-->  Google Cloud Translate  --text-->  Google Cloud TTS
   v
Node backend -> browser: { type: "transcript" }, { type: "translation" }, { type: "translationAudio" }
```

## Architecture decision history (don't re-litigate without reason)

- The backend was originally a **Python/Flask REST API** deployed on Render,
  with a single `POST /translate` endpoint that took a full audio blob and
  returned translated audio + an English gloss in one shot. **This has been
  fully replaced** by a Node/Express/WebSocket streaming backend
  (`speech_translate_app`, current `package.json` requires Node >=18). The old
  Flask files (`app.py`, `requirements.txt`, `render.yaml`, `RENDER_DEPLOY.md`,
  `TESTING.md`, `run.sh`) were deleted from the backend repo as part of this
  rewrite — do not resurrect the REST `/translate` contract.
- This frontend (`translation-frontend`) was **rebuilt to match a Figma
  design** (dark hero, glass translator card, purple gradient theme — see
  "Design reference" below) and then **updated again to speak the WebSocket
  protocol** instead of the old REST contract. `script.js` now opens a
  `WebSocket` to `BACKEND_WS_URL`, sends `{ type: "start", language,
  targetLanguage }`, streams `MediaRecorder` chunks as binary WS frames, and
  renders a running conversation thread of bubbles from `transcript` /
  `translation` / `translationAudio` server messages.
- Only **English, Marathi, and Telugu** are supported right now (matches
  backend `server/config.js` → `SUPPORTED_LANGUAGES`). The frontend's
  `<select>` options were trimmed from an earlier 21-language list down to
  just these three to match — if you add a language, it must be added in
  *both* places (see "Adding a language" below).

## Current state / known issues (read before doing anything else)

1. **Security — leaked credential in backend git history.** A Google Cloud
   service account key (`silicon-reason-476705-s8-8c0c5f788436.json`) was
   committed in the backend's first commit (`7d84639`), before `.gitignore`
   was updated to exclude `*.json`. The file is gitignored *now* but is still
   present in git history. The backend README already tells the user to use a
   fresh key and treat the old one as compromised — confirm that key has
   actually been revoked in the GCP console, and consider scrubbing it from
   history (`git filter-repo` / BFG) before this repo is ever made public or
   pushed anywhere shared.
2. **No backend deployment target configured yet.** `render.yaml` was deleted
   along with the rest of the Flask app; nothing has replaced it. This
   frontend's production WebSocket URL is still a literal placeholder:
   `script.js` → `BACKEND_WS_URL` → `'wss://your-backend-url/ws' // TODO:
   update once the Node backend is deployed`. This is the #1 blocker to using
   the app outside `localhost`. Whatever host you pick must support long-lived
   WebSocket connections (Render, Fly.io, Railway — not a static host).
3. **No Origin/CORS allowlisting on the WS server.** `server/wsHandler.js`
   accepts connections from any origin. Fine for local dev; revisit once a
   frontend domain is finalized and this is exposed publicly.
4. **Backend's bundled `public/client.js` is out of sync with its own
   protocol.** The backend serves a minimal reference frontend from its own
   `public/` folder (reachable at `http://localhost:3000` when the backend is
   running). It predates `translationAudio` / `prompt` / `closed` message
   types the server now sends, and it plays each translation chunk
   immediately rather than batching audio per pause like this repo's
   `script.js` does. It's not broken (unrecognized message types are just
   ignored), just confusing to reference — prefer this repo's frontend, or
   update/delete `public/` if the duplication becomes a maintenance problem.
5. **Backend README's roadmap section is partially stale.** It lists
   "silence-timeout prompts" under "not yet built," but `server/config.js`
   (`SILENCE_PROMPT_MS`, `SILENCE_CLOSE_GRACE_MS`, `SILENCE_PROMPT_TEXT`) and
   `server/wsHandler.js` (`armSilenceTimer`, `promptStillThere`,
   `closeForSilence`) show it's implemented, and this frontend already
   handles the resulting `prompt` / `closed` messages. Verify behavior by
   testing rather than trusting the README roadmap list at face value.
6. **Node version gotcha.** The default `node` on this machine is v12.22.9
   (`/usr/bin/node`), too old for `@deepgram/sdk` and this repo's ESM syntax
   (`package.json` requires `>=18`). `nvm use 20` is blocked by a `~/.npmrc`
   globalconfig/prefix conflict on this machine — don't fight it; instead
   PATH-prepend the binary directly:
   `/home/vivian/.nvm/versions/node/v20.19.6/bin/node` (and the matching
   `npm` next to it) before running `npm install`/`npm start` in the backend
   repo.
7. **Hero copy still oversells scope.** The hero subtitle ("...in over 100
   languages"), the stats bar ("100+ Languages"), and one feature card
   ("100+ Languages") are leftover from the original marketing-design intent
   and don't reflect the real 3-language (en/mr/te) product. Flagged, not
   fixed — needs a copy decision from the user before changing (could be
   "ship the honest 3-language copy now" or "keep aspirational copy since
   more languages are a near-term roadmap item").
8. **`DEPLOYMENT.md` in this repo is stale.** It describes deploying this
   frontend as a static site on Render talking to the old Flask REST backend
   at `speech-translate-app-cuvh.onrender.com`. Needs a full rewrite once the
   new backend's hosting is decided (see issue #2). `README.md` here is just
   a one-line stub and hasn't been touched.
9. **No conversation persistence.** The conversation thread lives in the
   DOM/JS memory only; a page refresh loses it. Not currently a goal per the
   backend's roadmap ("session persistence" is listed as not-yet-built).

## WebSocket message contract

Keep both repos' code in sync if you change any of this — it's the only
coupling between them.

**Client → server:**
- `{ type: "start", language, targetLanguage }` — opens the Deepgram session;
  `language` must be a key in `SUPPORTED_LANGUAGES`; translation is skipped
  server-side if `targetLanguage` equals `language` or is omitted.
- Binary WS frames — raw `audio/webm;codecs=opus` chunks from `MediaRecorder`,
  sent every 250ms once the server replies `ready`.
- `{ type: "stop" }` — ends the session; server flushes any pending
  translated-audio synthesis before closing.

**Server → client:**
- `{ type: "ready", language }` — Deepgram connection is open, safe to start
  streaming audio.
- `{ type: "transcript", text, isFinal }` — interim or finalized STT result.
- `{ type: "translation", text, targetLanguage }` — translated text for a
  finalized transcript (text only, streamed as a caption).
- `{ type: "translationAudio", audioBase64, mimeType }` — synthesized speech
  for the accumulated translated text since the last pause (batched, not
  1:1 with each `translation` message — see `wsHandler.js`
  `speakPendingTranslation`).
- `{ type: "prompt", text, audioBase64?, mimeType? }` — "are you still
  there?" after 2 minutes of silence (`SILENCE_PROMPT_MS`).
- `{ type: "closed", reason }` — server is closing the session (e.g.
  `reason: "silence"` after 30s grace past the prompt).
- `{ type: "error", message }` — session-ending or rejected-`start` error.

## File map

### This repo (`translation-frontend/`)
- `index.html` — page structure: nav, hero, translator card (language pills +
  swap, live conversation thread `#conversation`, audio-status/play row, mic
  button + waveform), stats bar, features grid, footer.
- `style.css` — dark gradient theme matching the Figma design, fully
  responsive (900/768/480/320px breakpoints).
- `script.js` — WebSocket client: opens `BACKEND_WS_URL`, drives
  `MediaRecorder`, renders original/translation bubbles as messages arrive,
  queues and sequentially plays translated-audio blobs so overlapping
  utterances don't talk over each other.
- `README.md` — one-line stub, not updated.
- `DEPLOYMENT.md` — **stale**, describes the old Flask/Render setup (see
  known issue #7).

### Backend repo (`~/Desktop/speech_translate_app/`)
- `server/index.js` — Express + `ws` bootstrap; serves `public/` statically;
  `GET /languages` returns `SUPPORTED_LANGUAGES`.
- `server/config.js` — `SUPPORTED_LANGUAGES` (en/mr/te), `TTS_LOCALES`,
  Deepgram model (`nova-3`), silence-timing constants.
- `server/wsHandler.js` — per-connection state machine: session start/stop,
  audio relay to Deepgram, silence-prompt/close timers, batched TTS trigger.
- `server/deepgramClient.js` — opens the Deepgram streaming STT connection.
- `server/googleClients.js` — Google Cloud Translate + TTS thin wrappers.
- `server/pipeline.js` — pluggable post-transcript processor registry
  (`registerTranscriptProcessor`).
- `server/processors/translate.js` — the one registered processor; translates
  and forwards to TTS.
- `public/` — bundled minimal reference frontend, **out of sync** with the
  current protocol (see known issue #4).
- `.env` / `.env.example` — `DEEPGRAM_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`
  (path to service-account JSON), `PORT` (default 3000).
- `silicon-reason-476705-s8-8c0c5f788436.json` — **leaked credential**, see
  known issue #1.
- `README.md` — the most accurate architecture doc that exists right now;
  read it, but cross-check the roadmap section against known issue #5.

## Design reference (this repo only)

Figma file: `https://www.figma.com/design/KWwvKeAco3k1rCiRELC9ju/translate`
- Node `15:2` ("Desktop - 1") — the main landing/translator frame. **Built.**
- Node `56:3` ("Desktop - 2") — an "About us" page. **Not built** (deliberate
  scope decision — user chose "main landing page only" when asked).
- Node `63:298` ("pop up price") — a pricing modal (Free/Max/Pro plans).
  **Not built**, same reason.

## Running the full stack locally

```bash
# Backend (needs Node >=18 — check `node --version` first, use nvm if it's not)
cd ~/Desktop/speech_translate_app
npm install
cp .env.example .env   # fill in DEEPGRAM_API_KEY + GOOGLE_APPLICATION_CREDENTIALS
npm start              # listens on :3000, also serves its own public/ reference frontend there

# Frontend (this repo) — separate static server
cd ~/Desktop/translation-frontend
python3 -m http.server 8124
```

Open `http://localhost:8124` (this repo's `index.html`, not the backend's
bundled `public/index.html`) in a real browser — mic access requires a real
browser context, not the sandboxed preview tool. `BACKEND_WS_URL` in
`script.js` auto-detects `localhost` and points at `ws://localhost:3000/ws`.

## Adding a supported language

Must be changed in both repos or the two will disagree:
1. Backend `server/config.js` — add to `SUPPORTED_LANGUAGES` and
   `TTS_LOCALES`; confirm Deepgram's `nova-3` model actually supports the
   language for streaming STT (not all languages support Deepgram's
   auto-detect/code-switching — this project selects the source language
   explicitly up front specifically to work around that limit).
2. This repo's `index.html` — add the matching `<option>` to both
   `#sourceLang` and `#targetLang`.

## Next steps, priority order

1. Rotate/verify-revoked the leaked Google credential (security, do first,
   independent of everything else).
2. Decide backend hosting (must support persistent WebSockets) and update the
   `BACKEND_WS_URL` placeholder in `script.js`.
3. Add Origin allowlisting to `wsHandler.js` once a frontend domain exists.
4. Reconcile or retire the backend's `public/` reference client so it stops
   drifting from the real protocol.
5. (Deferred by user choice, not forgotten) Figma "About us" page and pricing
   popup.
