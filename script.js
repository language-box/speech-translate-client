// Backend WebSocket URL - automatically detects environment
const BACKEND_WS_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'ws://localhost:8080/ws'
    : 'wss://speech-translate-app.fly.dev/ws';

const micBtn = document.getElementById('micBtn');
const waveform = document.getElementById('waveform');
const status = document.getElementById('status');
const audioElement = document.getElementById('player');
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
let lastAudioUrl = null;
let isPlaying = false;
let pendingIdleMessage = null;

let sourceLangLabelText = '';
let targetLangLabelText = '';
let translationEnabled = false;
let currentOriginalBubble = null;
let currentConversationWindow = null;
let pendingTranslationQueue = [];

const audioQueue = [];
let isQueuePlaying = false;
const translationEntriesById = new Map();
const conversationEntriesByUtteranceId = new Map();
const historyAudioUrls = new Set();
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

function playNextInQueue() {
    if (isQueuePlaying || audioQueue.length === 0) return;
    isQueuePlaying = true;
    const url = audioQueue.shift();
    lastAudioUrl = url;
    audioElement.src = url;
    playAudioBtn.disabled = false;
    audioElement.play();
}

function playHistoryAudio(entry) {
    if (entry.replayAudio && !entry.replayAudio.paused) {
        entry.replayAudio.pause();
        return;
    }

    entry.replayAudio = new Audio(entry.replayUrl);
    entry.replayAudio.onplay = () => entry.replayBtn.classList.add('playing');
    entry.replayAudio.onpause = () => entry.replayBtn.classList.remove('playing');
    entry.replayAudio.onended = () => entry.replayBtn.classList.remove('playing');
    entry.replayAudio.play().catch(() => entry.replayBtn.classList.remove('playing'));
}

function enqueueTranslationAudio(base64, mimeType, translationId) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    if (translationId) {
        const entry = translationEntriesById.get(translationId);
        if (entry) {
            entry.replayUrl = url;
            entry.replayBtn.disabled = false;
            entry.replayBtn.onclick = () => playHistoryAudio(entry);
            historyAudioUrls.add(url);
        }
    }
    audioQueue.push(url);
    audioStatusEl.classList.add('active');
    audioStatusTextEl.textContent = 'Playing translation audio';
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
    historyAudioUrls.forEach((url) => URL.revokeObjectURL(url));
    historyAudioUrls.clear();
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
    isPlaying = false;
    audioElement.pause();
    audioElement.src = '';
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
        setIdleUi('Unable to connect to translation service.');
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

            mediaRecorder = new MediaRecorder(stream, { mimeType });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                    ws.send(e.data);
                }
            };
            mediaRecorder.start(250);
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
                }
                if (pendingTranslationQueue.length === 0) entry.translationRow.classList.remove('translation-pending');
                conversationEl.scrollTop = conversationEl.scrollHeight;
            }
            return;
        }

        if (message.type === 'translationAudio') {
            enqueueTranslationAudio(message.audioBase64, message.mimeType, message.translationId);
            return;
        }

        if (message.type === 'prompt') {
            status.textContent = message.text;
            if (message.audioBase64) enqueueTranslationAudio(message.audioBase64, message.mimeType);
            return;
        }

        if (message.type === 'closed') {
            pendingIdleMessage = message.reason === 'duration'
                ? 'Three-minute recording window ended.'
                : 'Session ended due to inactivity.';
            return;
        }

        if (message.type === 'error') {
            status.textContent = `Error: ${message.message}`;
            stopSession();
        }
    };

    ws.onclose = () => {
        ws = null;
        setIdleUi(pendingIdleMessage || undefined);
        pendingIdleMessage = null;
    };

    ws.onerror = () => {
        pendingIdleMessage = 'Unable to connect to translation service.';
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
    if (!lastAudioUrl) return;

    if (isPlaying) {
        audioElement.pause();
        return;
    }

    audioElement.play();
};

audioElement.onplay = () => {
    isPlaying = true;
    playAudioBtn.innerHTML = PAUSE_ICON;
};

audioElement.onpause = () => {
    isPlaying = false;
    playAudioBtn.innerHTML = PLAY_ICON;
};

audioElement.onended = () => {
    isPlaying = false;
    playAudioBtn.innerHTML = PLAY_ICON;
    if (!historyAudioUrls.has(lastAudioUrl)) URL.revokeObjectURL(lastAudioUrl);
    isQueuePlaying = false;
    if (audioQueue.length === 0) {
        audioStatusEl.classList.remove('active');
        audioStatusTextEl.textContent = '';
    }
    playNextInQueue();
};
