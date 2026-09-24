// Backend WebSocket URL - automatically detects environment
const BACKEND_WS_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'ws://localhost:8080/ws'
    : 'wss://speech-translate-viv.fly.dev/ws';

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
let pendingTranslationQueue = [];

const audioQueue = [];
let isQueuePlaying = false;

function playNextInQueue() {
    if (isQueuePlaying || audioQueue.length === 0) return;
    isQueuePlaying = true;
    const url = audioQueue.shift();
    lastAudioUrl = url;
    audioElement.src = url;
    playAudioBtn.disabled = false;
    audioElement.play();
}

function enqueueTranslationAudio(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    audioQueue.push(URL.createObjectURL(new Blob([bytes], { type: mimeType })));
    audioStatusEl.classList.add('active');
    audioStatusTextEl.textContent = 'Playing translation audio';
    playNextInQueue();
}

swapLangsBtn.onclick = () => {
    const tmp = sourceLangSelect.value;
    sourceLangSelect.value = targetLangSelect.value;
    targetLangSelect.value = tmp;
};

function createBubble(kind, labelText) {
    conversationEmptyEl.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = `bubble bubble-${kind}`;
    const label = document.createElement('span');
    label.className = 'bubble-label';
    label.textContent = labelText;
    const p = document.createElement('p');
    bubble.appendChild(label);
    bubble.appendChild(p);
    conversationEl.appendChild(bubble);
    conversationEl.scrollTop = conversationEl.scrollHeight;
    return { bubble, textEl: p };
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

function resetConversation() {
    conversationEl.querySelectorAll('.bubble').forEach((el) => el.remove());
    conversationEmptyEl.style.display = '';
    currentOriginalBubble = null;
    pendingTranslationQueue.forEach((entry) => clearTimeout(entry.timeoutId));
    pendingTranslationQueue = [];
}

function resetPanels() {
    resetConversation();
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

    ws = new WebSocket(BACKEND_WS_URL);

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

            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                    ws.send(e.data);
                }
            };
            mediaRecorder.start(250);
            return;
        }

        if (message.type === 'transcript') {
            if (!currentOriginalBubble) {
                currentOriginalBubble = createBubble('original', `ORIGINAL · ${sourceLangLabelText}`);
            }
            currentOriginalBubble.textEl.textContent = message.text;
            conversationEl.scrollTop = conversationEl.scrollHeight;

            if (message.isFinal) {
                currentOriginalBubble = null;
                if (translationEnabled) {
                    pendingTranslationQueue.push(createPendingTranslationBubble());
                }
            }
            return;
        }

        if (message.type === 'translation') {
            const pending = pendingTranslationQueue.shift();
            if (pending) {
                clearTimeout(pending.timeoutId);
                pending.bubble.classList.remove('bubble-pending');
                pending.textEl.textContent = message.text;
                conversationEl.scrollTop = conversationEl.scrollHeight;
            }
            return;
        }

        if (message.type === 'translationAudio') {
            enqueueTranslationAudio(message.audioBase64, message.mimeType);
            return;
        }

        if (message.type === 'prompt') {
            status.textContent = message.text;
            if (message.audioBase64) enqueueTranslationAudio(message.audioBase64, message.mimeType);
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
        ws = null;
        setIdleUi(pendingIdleMessage || undefined);
        pendingIdleMessage = null;
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
    URL.revokeObjectURL(lastAudioUrl);
    isQueuePlaying = false;
    if (audioQueue.length === 0) {
        audioStatusEl.classList.remove('active');
        audioStatusTextEl.textContent = '';
    }
    playNextInQueue();
};
