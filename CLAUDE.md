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
transcribes it (Deepgram) and translates the finalized text (the Claude API).
This frontend then speaks the translated text with the browser's own
`speechSynthesis`; no audio comes back over the WebSocket. It's a live conversational tool, not a record-then-submit
form — audio streams continuously over a WebSocket while the mic is on.

```
Browser (mic capture, MediaRecorder)
   |  audio chunks over WebSocket (/ws)
   v
Node backend (server/wsHandler.js)
   |  relays audio, holds provider API keys — browser never sees them
   v
Deepgram streaming STT  --transcript-->  Claude API (translation)
   v
Node backend -> browser: { type: "transcript" }, { type: "translation", targetLocale }
   v
this frontend speaks the translated text via speechSynthesis
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
  `translation` server messages, speaking each finalized translation through
  `speechSynthesis`.
- **Google Cloud was dropped entirely (2026-10-01).** Translation moved to
  the Claude API (backend `server/claudeClient.js`) and text-to-speech moved
  into this frontend via `speechSynthesis`. The reason was payment, not
  technology: Google Cloud billing rejects prepaid and virtual cards
  globally, plus debit cards requiring 2FA, which rules out the Nigerian
  virtual-card options available to the user. The tradeoff accepted: Marathi
  and Telugu playback now depends on voices installed on the viewer's device,
  and this frontend falls back to captions-only when none exists. Do not
  reintroduce a server-side TTS stage without first solving billing.
- Only **English, Marathi, and Telugu** are supported right now (matches
  backend `server/config.js` → `SUPPORTED_LANGUAGES`). The frontend's
  `<select>` options were trimmed from an earlier 21-language list down to
  just these three to match — if you add a language, it must be added in
  *both* places (see "Adding a language" below).

## Current state / known issues (read before doing anything else)

1. **Dead credential in backend git history (no longer a security issue).**
   The Google service-account key `silicon-reason-476705-s8-8c0c5f788436.json`
   is in the backend's commits `7d84639` and `7367d09` on `origin/main`. That
   repo is private and the GCP account behind the key has been disqualified,
   so the key is inert. Scrubbing it is housekeeping now, not remediation.
2. **Backend is deployed to Fly.io.** App `speech-translate-app`, region
   `cdg`, and this repo's `BACKEND_WS_URL` production branch already points
   at `wss://speech-translate-app.fly.dev/ws`. **This frontend itself is not
   hosted anywhere yet** — that is now the remaining blocker, and it has a
   dependency: once it has an origin, the backend needs `ALLOWED_ORIGINS` set
   to it (see #3) or the WebSocket will be rejected with a 403.
3. ~~**No Origin/CORS allowlisting on the WS server.**~~ **Done
   (2026-10-01).** The backend enforces an allowlist at the WebSocket
   handshake. Rules: origins listed in its `ALLOWED_ORIGINS` env var,
   same-origin always, any localhost port while no allowlist is configured.
   Local dev is therefore unaffected, but a hosted copy of this frontend gets
   a 403 until its origin is added on the backend.
4. **Backend's bundled `public/client.js` is now badly out of sync and will
   be silent.** The backend serves a minimal reference frontend from its own
   `public/` folder (reachable at `http://localhost:8080` when the backend is
   running). It still waits for `translationAudio` messages, which no longer
   exist, and has no `speechSynthesis` path — so it will never speak
   anything. It also predates `prompt` / `closed`. Nothing crashes (unknown
   message types are ignored), but prefer this repo's frontend, and retire
   `public/` or port the speech path across.
5. ~~**Backend README's roadmap section is partially stale.**~~ **Fixed
   (2026-10-01).** Former note: it lists
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
   at `speech-translate-app-cuvh.onrender.com`. All three facts are now wrong:
   the backend is Node on Fly, the contract is WebSocket, and the user's
   Render subscription has lapsed. Needs a rewrite once this frontend's own
   hosting is picked. `README.md` here is just a one-line stub.
9. **Interim translations are received and thrown away.** `script.js` handles
   `{ type: "translation", isFinal: false }` by assigning to
   `entry.partialTranslationText` and returning — and that field is never
   read anywhere, so partial captions have no visible effect. Because each
   one is a separate billable Claude call, the backend now has
   `TRANSLATE_INTERIM` **off by default** (added 2026-10-01) and stops
   sending them. To get live partial captions, render
   `partialTranslationText` in the translation bubble *first*, then set
   `TRANSLATE_INTERIM=true` on the backend. Note it lands ~900ms behind the
   speech, so it may not be worth it.
10. **No conversation persistence.** The conversation thread lives in the
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
- `{ type: "translation", text, targetLanguage, targetLocale, translationId, utteranceId, isFinal }`
  — translated text, streamed as a caption. Finalized ones carry
  `targetLocale` (BCP-47, e.g. `mr-IN`) and a `translationId`; this frontend
  speaks those and wires its per-line replay button to them. Interim ones
  (`isFinal: false`) carry neither and are never spoken.
- `{ type: "prompt", text, locale }` — "are you still there?" after 2
  minutes of silence (`SILENCE_PROMPT_MS`). `locale` is the *source*
  language's BCP-47 code, since the prompt addresses the speaker.
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
  and queues finalized translations through `speechSynthesis` so overlapping
  utterances don't talk over each other. Voice selection is
  `availableVoiceFor(locale)` (exact BCP-47 match, then language-only); when
  no voice matches, `noteMissingVoice` switches the audio row to a
  captions-only notice and leaves the replay button disabled. Stopping is
  `cancelSpeech()` — `speechSynthesis.pause()`/`resume()` are too
  inconsistent across browsers to rely on, so replay re-speaks instead.
- `README.md` — one-line stub, not updated.
- `DEPLOYMENT.md` — **stale**, describes the old Flask/Render setup (see
  known issue #8).

### Backend repo (`~/Desktop/speech_translate_app/`)
- `server/index.js` — Express + `ws` bootstrap; serves `public/` statically;
  `GET /languages` returns `SUPPORTED_LANGUAGES`.
- `server/config.js` — `SUPPORTED_LANGUAGES` (en/mr/te), `TTS_LOCALES`,
  Deepgram model (`nova-3`), silence-timing constants.
- `server/wsHandler.js` — per-connection state machine: session start/stop,
  audio relay to Deepgram, silence-prompt/close timers, batched TTS trigger.
- `server/deepgramClient.js` — opens the Deepgram streaming STT connection.
- `server/claudeClient.js` — Claude API translation (`translateText`,
  `hasCredentials`).
- `server/pipeline.js` — pluggable post-transcript processor registry
  (`registerTranscriptProcessor`).
- `server/processors/translate.js` — the one registered processor; translates
  and emits the caption. No TTS stage exists any more.
- `public/` — bundled minimal reference frontend, **out of sync** with the
  current protocol (see known issue #4).
- `.env` / `.env.example` — `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PORT`
  (default 8080), plus optional `TRANSLATION_MODEL` and `ALLOWED_ORIGINS`.
- `scripts/check-translation.js` (`npm run check:translation`) — preflight
  making real Claude calls, reporting per-language latency.
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
cp .env.example .env   # fill in DEEPGRAM_API_KEY + ANTHROPIC_API_KEY
npm run check:translation  # verify translation before starting
npm start              # listens on :8080, also serves its own public/ reference frontend there

# Frontend (this repo) — separate static server
cd ~/Desktop/translation-frontend
python3 -m http.server 8124
```

Open `http://localhost:8124` (this repo's `index.html`, not the backend's
bundled `public/index.html`) in a real browser — mic access requires a real
browser context, not the sandboxed preview tool.

**Choosing which backend to talk to** (`resolveBackendUrl` in `script.js`):
- default: `localhost`/`127.0.0.1` pages use `ws://localhost:8080/ws`, anything
  else uses `wss://speech-translate-app.fly.dev/ws`
- `?backend=prod` points a locally-served page at the **deployed** backend,
  which is the only way to test a deployment without hosting this frontend
- `?backend=local` points it back
- the override is sticky for the browser session (`sessionStorage`), so a
  reload without the query param keeps the last choice. The resolved URL is
  logged to the console on every load.

**Do not open `index.html` as a `file://` URL.** The browser sends
`Origin: null`, which the backend's allowlist rejects with a 403 that looks
exactly like the backend being down. `script.js` warns about this in the
console.

**Testing from a phone on the same wifi** (worth doing, since Android ships
much better Marathi and Telugu voices than a Linux desktop): browse to
`http://<dev-machine-lan-ip>:8124`. `PRIVATE_HOST` in `script.js` treats
RFC1918 addresses as local, so the page targets
`ws://<that-same-host>:8080/ws` instead of falling through to production. The
backend needs `ALLOW_LAN_ORIGINS=true` in its local `.env` to accept that
origin. Pointing a LAN-IP page at `?backend=prod` will **not** work, because
production only accepts localhost and same-origin.

**"Translation service is unavailable" is deliberately vague** — it is what an
end user sees. The real cause is in the console. Because a browser never
exposes the HTTP status of a failed WebSocket handshake, `diagnoseConnection()`
probes `/languages` over plain HTTP and logs whether the handshake was
*refused* (service up, origin not allowed) or the service is genuinely
unreachable. Always read the console before concluding the backend is down.

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
2. Host this frontend, then set `ALLOWED_ORIGINS` on the backend's Fly app to
   its origin, or the WebSocket handshake will 403.
3. Add Origin allowlisting to `wsHandler.js` once a frontend domain exists.
4. Reconcile or retire the backend's `public/` reference client so it stops
   drifting from the real protocol.
5. (Deferred by user choice, not forgotten) Figma "About us" page and pricing
   popup.
