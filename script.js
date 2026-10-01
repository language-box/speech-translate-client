// Backend WebSocket URL. Defaults by hostname, but `?backend=prod` or
// `?backend=local` overrides it and the choice sticks for the session, so a
// page served from localhost can be pointed at the deployed backend. Without
// this there is no way to test a deployment except from the deployed origin.
const PROD_WS_URL = 'wss://speech-translate-app.fly.dev/ws';

// Loopback plus the RFC1918 ranges. A page opened from a phone on the same
// wifi (http://192.168.x.x:8124) is still local development, and must target
// this machine's backend rather than falling through to production.
const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

// Derived from the page's own hostname so the backend is reachable from
// whichever device is viewing, not just from this machine.
const LOCAL_WS_URL = `ws://${PRIVATE_HOST.test(window.location.hostname) ? window.location.hostname : 'localhost'}:8080/ws`;

function resolveBackendUrl() {
    const servedLocally = PRIVATE_HOST.test(window.location.hostname);

    let override = null;
    try {
        override = new URLSearchParams(window.location.search).get('backend');
        if (override) {
            sessionStorage.setItem('backendOverride', override);
        } else {
            override = sessionStorage.getItem('backendOverride');
        }
    } catch {
        // Private mode or blocked storage: fall through to the hostname default.
    }

    if (override === 'prod') return PROD_WS_URL;
    if (override === 'local') return LOCAL_WS_URL;
    return servedLocally ? LOCAL_WS_URL : PROD_WS_URL;
}

const BACKEND_WS_URL = resolveBackendUrl();
// Logged because a failed connection is otherwise indistinguishable between
// "wrong target" and "target is down".
console.info(`[speech-translate] backend: ${BACKEND_WS_URL}`);

// A file:// page sends `Origin: null`, which the backend's allowlist rejects
// with a 403. Flag it here rather than letting it look like an outage.
if (window.location.protocol === 'file:') {
    console.warn('[speech-translate] Opened from file://. The backend rejects Origin: null — serve this over http instead, e.g. `python3 -m http.server 8124`.');
}

const micBtn = document.getElementById('micBtn');
const waveform = document.getElementById('waveform');
const status = document.getElementById('status');
const sourceLangSelect = document.getElementById('sourceLang');
const targetLangSelect = document.getElementById('targetLang');
const swapLangsBtn = document.getElementById('swapLangs');
const conversationEl = document.getElementById('conversation');
const conversationEmptyEl = document.getElementById('conversationEmpty');
const audioStatusEl = document.getElementById('audioStatus');
const audioStatusTextEl = document.getElementById('audioStatusText');
const playAudioBtn = document.getElementById('playAudioBtn');

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>';
const SPEAKER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9.5a4 4 0 010 5M18.5 7a7.5 7.5 0 010 10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
playAudioBtn.innerHTML = PLAY_ICON;

const TRANSLATION_TIMEOUT_MS = 10000;

let ws = null;
let mediaRecorder = null;
let stream = null;
let isRecording = false;
let lastSpokenLine = null;
let isPlaying = false;
let pendingIdleMessage = null;

let sourceLangLabelText = '';
let targetLangLabelText = '';
let translationEnabled = false;
let currentOriginalBubble = null;
let currentConversationWindow = null;
let pendingTranslationQueue = [];

// Translated lines are spoken by the browser's own speech synthesis, so the
// queue holds text rather than audio blobs. Nothing is fetched or revoked.
const speechQueue = [];
let isQueuePlaying = false;
let missingVoiceLocales = new Set();
const translationEntriesById = new Map();
const conversationEntriesByUtteranceId = new Map();
function normalizeTranscriptText(text) {
    return text
        .replace(/\b(?:uh+|um+|erm+|hmm+|mm+|ah+)\b[,.!?]?\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function appendTranscriptText(existingText, nextText) {
    if (!existingText) return nextText;
    if (/^[,.!?;:]/.test(nextText)) return `${existingText}${nextText}`;
    return `${existingText} ${nextText}`;
}

const speechSupported = 'speechSynthesis' in window;

// getVoices() is empty until the engine has loaded its list, so prime it and
// re-check when it changes rather than deciding once at startup.
if (speechSupported) {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => {
        missingVoiceLocales = new Set();
    });
}

function availableVoiceFor(locale) {
    if (!speechSupported || !locale) return null;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return null;
    const wanted = locale.toLowerCase();
    const wantedLang = wanted.split('-')[0];
    const normalize = (lang) => (lang || '').toLowerCase().replace('_', '-');
    return voices.find((voice) => normalize(voice.lang) === wanted)
        || voices.find((voice) => normalize(voice.lang).split('-')[0] === wantedLang)
        || null;
}

function noteMissingVoice(locale) {
    missingVoiceLocales.add(locale);
    audioStatusEl.classList.add('active');
    audioStatusTextEl.textContent = speechSupported
        ? `No ${locale} voice on this device - captions only`
        : 'This browser cannot speak text - captions only';
}

// speechSynthesis.pause()/resume() behave inconsistently across browsers, so
// stopping means cancel, and resuming means speaking the line again.
function cancelSpeech() {
    speechQueue.length = 0;
    isQueuePlaying = false;
    if (speechSupported) speechSynthesis.cancel();
    isPlaying = false;
    playAudioBtn.innerHTML = PLAY_ICON;
}

function speak(line, onFinished) {
    const utterance = new SpeechSynthesisUtterance(line.text);
    utterance.lang = line.locale;
    const voice = availableVoiceFor(line.locale);
    if (voice) utterance.voice = voice;

    utterance.onstart = () => {
        isPlaying = true;
        playAudioBtn.innerHTML = PAUSE_ICON;
    };
    // onerror has to settle the same way as onend, or a failed utterance
    // would wedge the queue permanently.
    const finish = () => {
        isPlaying = false;
        playAudioBtn.innerHTML = PLAY_ICON;
        if (onFinished) onFinished();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    speechSynthesis.speak(utterance);
}

function playNextInQueue() {
    if (isQueuePlaying || speechQueue.length === 0 || !speechSupported) return;
    isQueuePlaying = true;
    const line = speechQueue.shift();
    lastSpokenLine = line;
    playAudioBtn.disabled = false;
    speak(line, () => {
        isQueuePlaying = false;
        if (speechQueue.length === 0) {
            audioStatusEl.classList.remove('active');
            audioStatusTextEl.textContent = '';
        }
        playNextInQueue();
    });
}

function replayLine(entry) {
    if (!entry.replayText) return;
    if (isPlaying) {
        cancelSpeech();
        entry.replayBtn.classList.remove('playing');
        return;
    }
    entry.replayBtn.classList.add('playing');
    speak({ text: entry.replayText, locale: entry.replayLocale }, () => {
        entry.replayBtn.classList.remove('playing');
    });
}

function enqueueTranslationSpeech(text, locale, translationId) {
    if (!text || !locale) return;

    const voice = availableVoiceFor(locale);
    if (translationId) {
        const entry = translationEntriesById.get(translationId);
        if (entry) {
            entry.replayText = text;
            entry.replayLocale = locale;
            // Replay stays disabled while the device has no voice for this
            // language, since pressing it would be silent.
            entry.replayBtn.disabled = !voice;
            entry.replayBtn.onclick = () => replayLine(entry);
        }
    }

    if (!voice) {
        noteMissingVoice(locale);
        return;
    }

    speechQueue.push({ text, locale });
    audioStatusEl.classList.add('active');
    audioStatusTextEl.textContent = 'Speaking translation';
    playNextInQueue();
}

swapLangsBtn.onclick = () => {
    const tmp = sourceLangSelect.value;
    sourceLangSelect.value = targetLangSelect.value;
    targetLangSelect.value = tmp;
};

function createBubble(kind, labelText, parent = conversationEl) {
    conversationEmptyEl.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${kind}`;
    const label = document.createElement('span');
    label.className = 'bubble-label';
    label.textContent = labelText;
    const p = document.createElement('p');
    bubble.appendChild(label);
    bubble.appendChild(p);
    let replayBtn = null;
    if (kind === 'translation') {
        replayBtn = document.createElement('button');
        replayBtn.className = 'translation-replay';
        replayBtn.type = 'button';
        replayBtn.disabled = true;
        replayBtn.setAttribute('aria-label', 'Replay translation');
        replayBtn.title = 'Replay translation';
        replayBtn.innerHTML = SPEAKER_ICON;
        bubble.appendChild(replayBtn);
    }
    parent.appendChild(bubble);
    conversationEl.scrollTop = conversationEl.scrollHeight;
    return { bubble, textEl: p, replayBtn };
}

function createPendingTranslationBubble() {
    const entry = createBubble('translation', `TRANSLATION · ${targetLangLabelText}`);
    entry.bubble.classList.add('bubble-pending');
    entry.textEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    entry.timeoutId = setTimeout(() => {
        entry.bubble.classList.remove('bubble-pending');
        entry.textEl.textContent = 'Translation unavailable';
    }, TRANSLATION_TIMEOUT_MS);
    return entry;
}

function createUtteranceEntry() {
    conversationEmptyEl.style.display = 'none';
    if (!currentConversationWindow) {
        currentConversationWindow = document.createElement('div');
        currentConversationWindow.className = 'conversation-window';
        conversationEl.appendChild(currentConversationWindow);
    }

    let originalBubble = currentConversationWindow.querySelector('.bubble-original');
    let translationBubble = currentConversationWindow.querySelector('.bubble-translation');

    if (!originalBubble) {
        originalBubble = createBubble('original', `ORIGINAL · ${sourceLangLabelText}`, currentConversationWindow).bubble;
        originalBubble.replaceChildren();
    }
    if (!translationBubble) {
        translationBubble = createBubble('translation', `TRANSLATION · ${targetLangLabelText}`, currentConversationWindow).bubble;
        translationBubble.replaceChildren();
    }

    let originalRow = currentConversationWindow.querySelector('.utterance-original');
    let originalTextEl = currentConversationWindow.querySelector('.utterance-original-text');
    if (!originalRow) {
        const originalLabel = document.createElement('span');
        originalLabel.className = 'bubble-label';
        originalLabel.textContent = `ORIGINAL · ${sourceLangLabelText}`;
        originalTextEl = document.createElement('p');
        originalTextEl.className = 'utterance-original-text';
        originalRow = document.createElement('div');
        originalRow.className = 'utterance-original';
        originalRow.appendChild(originalLabel);
        originalRow.appendChild(originalTextEl);
        originalBubble.appendChild(originalRow);
        currentConversationWindow.originalText = '';
        currentConversationWindow.interimText = '';
    }

    let translationRow = currentConversationWindow.querySelector('.utterance-translation');
    let translationTextEl = currentConversationWindow.querySelector('.utterance-translation-text');
    let replayBtn = currentConversationWindow.querySelector('.translation-replay');
    if (!translationRow) {
        const translationLabel = document.createElement('span');
        translationLabel.className = 'bubble-label';
        translationLabel.textContent = `TRANSLATION · ${targetLangLabelText}`;
        translationTextEl = document.createElement('p');
        translationTextEl.className = 'utterance-translation-text';
        translationTextEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        replayBtn = document.createElement('button');
        replayBtn.className = 'translation-replay';
        replayBtn.type = 'button';
        replayBtn.disabled = true;
        replayBtn.setAttribute('aria-label', 'Replay translation');
        replayBtn.title = 'Replay translation';
        replayBtn.innerHTML = SPEAKER_ICON;
        translationRow = document.createElement('div');
        translationRow.className = 'utterance-translation';
        translationRow.appendChild(translationLabel);
        translationRow.appendChild(translationTextEl);
        translationRow.appendChild(replayBtn);
        translationBubble.appendChild(translationRow);
        currentConversationWindow.translationText = '';
        currentConversationWindow.translationUnavailableShown = false;
    }
    conversationEl.scrollTop = conversationEl.scrollHeight;
    return {
        bubble: translationBubble,
        originalTextEl,
        translationTextEl,
        replayBtn,
        translationRow,
        conversationWindow: currentConversationWindow,
        partialTranslationText: '',
    };
}

function resetConversation() {
    conversationEl.querySelectorAll('.conversation-window').forEach((el) => el.remove());
    conversationEl.querySelectorAll(':scope > .bubble').forEach((el) => el.remove());
    conversationEmptyEl.style.display = '';
    currentConversationWindow = null;
    currentOriginalBubble = null;
    pendingTranslationQueue.forEach((entry) => clearTimeout(entry.timeoutId));
    pendingTranslationQueue = [];
    translationEntriesById.clear();
    conversationEntriesByUtteranceId.clear();
    cancelSpeech();
}

function resetPanels() {
    currentConversationWindow = null;
    currentOriginalBubble = null;
    pendingTranslationQueue.forEach((entry) => clearTimeout(entry.timeoutId));
    pendingTranslationQueue = [];
    translationEntriesById.clear();
    conversationEntriesByUtteranceId.clear();
    playAudioBtn.disabled = true;
    playAudioBtn.innerHTML = PLAY_ICON;
    audioStatusEl.classList.remove('active');
    audioStatusTextEl.textContent = '';
    lastSpokenLine = null;
    missingVoiceLocales = new Set();
    cancelSpeech();
}

// What the user sees. Deliberately free of hostnames, ports and flag names:
// the person using this is not debugging it, and the detail goes to the
// console instead via diagnoseConnection().
const USER_FACING_CONNECT_ERROR = 'Translation service is unavailable. Please try again in a moment.';

function backendProbeUrl() {
    return BACKEND_WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/languages');
}

// A browser never exposes the HTTP status of a failed WebSocket handshake, so
// `onerror` alone cannot tell a refused origin from a server that is down.
// Probing the plain HTTP endpoint separates the two: if that responds, the
// service is up and the handshake was refused.
async function diagnoseConnection() {
    const probeUrl = backendProbeUrl();
    let reachable = false;
    try {
        await fetch(probeUrl, { mode: 'no-cors', cache: 'no-store' });
        reachable = true;
    } catch {
        reachable = false;
    }

    if (reachable) {
        console.error(
            `[speech-translate] ${probeUrl} responded, so the WebSocket handshake was REFUSED, not unreachable.\n`
            + `  This page's origin: ${window.location.origin}\n`
            + `  The backend accepts localhost and same-origin only by default.\n`
            + `  Fix: add this origin to ALLOWED_ORIGINS on the backend, or set ALLOW_LAN_ORIGINS=true for local testing.`,
        );
    } else {
        console.error(
            `[speech-translate] ${probeUrl} is unreachable: the backend is down, still cold-starting, or blocked by the network.\n`
            + `  Target was ${BACKEND_WS_URL}. Use ?backend=local or ?backend=prod to switch.`,
        );
    }
}

function setIdleUi(message = 'Ready to record') {
    isRecording = false;
    micBtn.disabled = false;
    micBtn.classList.remove('recording');
    micBtn.setAttribute('aria-label', 'Start recording');
    waveform.classList.remove('recording');
    sourceLangSelect.disabled = false;
    targetLangSelect.disabled = false;
    swapLangsBtn.disabled = false;
    status.textContent = message;
}

micBtn.onclick = async () => {
    if (!isRecording) {
        await startSession();
    } else {
        stopSession();
    }
};

async function startSession() {
    resetPanels();
    sourceLangLabelText = sourceLangSelect.selectedOptions[0].textContent.toUpperCase();
    targetLangLabelText = targetLangSelect.selectedOptions[0].textContent.toUpperCase();
    translationEnabled = sourceLangSelect.value !== targetLangSelect.value;

    micBtn.disabled = true;
    sourceLangSelect.disabled = true;
    targetLangSelect.disabled = true;
    swapLangsBtn.disabled = true;
    status.textContent = 'Requesting microphone access...';

    if (!navigator.mediaDevices?.getUserMedia) {
        setIdleUi('Microphone access requires a secure browser context.');
        return;
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        status.textContent = 'Microphone access denied.';
        micBtn.disabled = false;
        sourceLangSelect.disabled = false;
        targetLangSelect.disabled = false;
        swapLangsBtn.disabled = false;
        return;
    }

    try {
        ws = new WebSocket(BACKEND_WS_URL);
    } catch (err) {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        setIdleUi(USER_FACING_CONNECT_ERROR);
        diagnoseConnection();
        return;
    }

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'start',
            language: sourceLangSelect.value,
            targetLanguage: targetLangSelect.value,
        }));
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'ready') {
            isRecording = true;
            micBtn.disabled = false;
            micBtn.classList.add('recording');
            micBtn.setAttribute('aria-label', 'Stop recording');
            waveform.classList.add('recording');
            status.textContent = 'Listening...';

            const mimeType = 'audio/webm;codecs=opus';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                stream?.getTracks().forEach((track) => track.stop());
                stream = null;
                setIdleUi('This browser cannot record WebM audio.');
                ws.close();
                return;
            }

            if (!mediaRecorder) {
                mediaRecorder = new MediaRecorder(stream, { mimeType });
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0 && ws?.readyState === WebSocket.OPEN) {
                        ws.send(e.data);
                    }
                };
                mediaRecorder.start(250);
            }
            return;
        }

        if (message.type === 'transcript') {
            const transcriptText = normalizeTranscriptText(message.text || '');
            if (!transcriptText) return;
            if (!currentOriginalBubble) {
                currentOriginalBubble = createUtteranceEntry();
            }
            const conversationWindow = currentOriginalBubble.conversationWindow;
            if (message.isFinal) {
                conversationWindow.originalText = appendTranscriptText(conversationWindow.originalText, transcriptText);
                conversationWindow.interimText = '';
            } else {
                conversationWindow.interimText = transcriptText;
            }
            currentOriginalBubble.originalTextEl.textContent = appendTranscriptText(
                conversationWindow.originalText,
                conversationWindow.interimText,
            );
            if (message.utteranceId) {
                conversationEntriesByUtteranceId.set(message.utteranceId, currentOriginalBubble);
            }
            conversationEl.scrollTop = conversationEl.scrollHeight;

            if (message.isFinal) {
                const entry = currentOriginalBubble;
                entry.translationRow.classList.add('translation-pending');
                entry.timeoutId = setTimeout(() => {
                    if (!entry.conversationWindow.translationUnavailableShown) {
                        entry.conversationWindow.translationText = appendTranscriptText(
                            entry.conversationWindow.translationText,
                            'Translation unavailable',
                        );
                        entry.translationTextEl.textContent = entry.conversationWindow.translationText;
                        entry.conversationWindow.translationUnavailableShown = true;
                    }
                    pendingTranslationQueue = pendingTranslationQueue.filter((item) => item !== entry);
                    if (pendingTranslationQueue.length === 0) entry.translationRow.classList.remove('translation-pending');
                }, TRANSLATION_TIMEOUT_MS);
                pendingTranslationQueue.push(entry);
                currentOriginalBubble = null;
            }
            return;
        }

        if (message.type === 'translation') {
            const entry = conversationEntriesByUtteranceId.get(message.utteranceId) || pendingTranslationQueue[0];
            if (entry) {
                if (message.isFinal === false) {
                    entry.partialTranslationText = message.text;
                    return;
                }
                entry.conversationWindow.translationText = appendTranscriptText(
                    entry.conversationWindow.translationText,
                    message.text,
                );
                entry.translationTextEl.textContent = entry.conversationWindow.translationText;
                if (message.isFinal !== false) {
                    clearTimeout(entry.timeoutId);
                    pendingTranslationQueue = pendingTranslationQueue.filter((item) => item !== entry);
                    entry.translationId = message.translationId;
                    if (message.translationId) translationEntriesById.set(message.translationId, entry);
                    enqueueTranslationSpeech(message.text, message.targetLocale, message.translationId);
                }
                if (pendingTranslationQueue.length === 0) entry.translationRow.classList.remove('translation-pending');
                conversationEl.scrollTop = conversationEl.scrollHeight;
            }
            return;
        }

        if (message.type === 'prompt') {
            status.textContent = message.text;
            enqueueTranslationSpeech(message.text, message.locale);
            return;
        }

        if (message.type === 'closed') {
            pendingIdleMessage = 'Session ended due to inactivity.';
            return;
        }

        if (message.type === 'error') {
            status.textContent = `Error: ${message.message}`;
            stopSession();
        }
    };

    ws.onclose = () => {
        if (mediaRecorder) {
            mediaRecorder.stop();
            mediaRecorder = null;
        }
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        ws = null;
        setIdleUi(pendingIdleMessage || undefined);
        pendingIdleMessage = null;
    };

    ws.onerror = () => {
        pendingIdleMessage = USER_FACING_CONNECT_ERROR;
        diagnoseConnection();
    };
}

function stopSession() {
    mediaRecorder?.stop();
    stream?.getTracks().forEach((track) => track.stop());
    mediaRecorder = null;
    stream = null;

    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
    } else {
        setIdleUi();
    }
}

playAudioBtn.onclick = () => {
    if (isPlaying) {
        cancelSpeech();
        return;
    }
    if (!lastSpokenLine) return;
    speak(lastSpokenLine);
};
