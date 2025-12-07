// API Configuration - automatically detects environment
const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:5000'  // Local development
    : 'https://speech-translate-app-cuvh.onrender.com';  // Production backend URL

// Warn if API URL is still placeholder
if (API_BASE_URL.includes('your-backend-url')) {
    console.error('⚠️ API_BASE_URL is not configured! Please update script.js with your backend URL.');
}

let mediaRecorder;
let audioChunks = [];
let currentAudioBlob = null; // Store the current audio blob for downloading
let currentAudioUrl = null; // Store the current audio URL for cleanup
let currentMimeType = null; // Store the current audio mimetype

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const audioElement = document.getElementById('player');
const audioContainer = document.getElementById('audioContainer');
const closeAudioBtn = document.getElementById('closeAudio');
const downloadBtn = document.getElementById('downloadBtn');
const targetLangSelect = document.getElementById('targetLang');
const englishTranslationDiv = document.getElementById('englishTranslation');

// Note: Languages are now hardcoded in HTML for simplicity
// You can still load from API if needed, but basic languages are already in the select elements


recordBtn.onclick = async () => {
    audioChunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.start();
    status.textContent = '🔴 Recording...';

    mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) audioChunks.push(e.data);
    };

    recordBtn.disabled = true;
    stopBtn.disabled = false;
};


stopBtn.onclick = async () => {
    mediaRecorder.stop();
    status.textContent = '⏳ Processing...';

    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: 'audio/wav' });
        const formData = new FormData();
        formData.append('input_audio', blob, 'recording.wav');

        const sourceLang = document.getElementById('sourceLang').value;
        const targetLang = document.getElementById('targetLang').value;

        formData.append('source_lang', sourceLang);
        formData.append('target_lang', targetLang);

        try {
            const apiUrl = `${API_BASE_URL}/translate`;
            console.log('🌐 Calling API:', apiUrl);
            console.log('📤 Sending data:', { sourceLang, targetLang, audioSize: blob.size });
            
            const response = await fetch(apiUrl, {
                method: 'POST',
                body: formData,
            });

            console.log('📥 Response status:', response.status, response.statusText);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ API Error:', errorText);
                throw new Error(`Translation failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            
            // Decode base64 audio
            const audioBytes = atob(data.audio);
            const audioArray = new Uint8Array(audioBytes.length);
            for (let i = 0; i < audioBytes.length; i++) {
                audioArray[i] = audioBytes.charCodeAt(i);
            }
            const audioBlob = new Blob([audioArray], { type: data.mimetype });
            
            // Clean up previous URL if it exists
            if (currentAudioUrl) {
                URL.revokeObjectURL(currentAudioUrl);
            }
            
            const audioUrl = URL.createObjectURL(audioBlob);
            
            // Store the blob, URL, and mimetype for downloading and cleanup
            currentAudioBlob = audioBlob;
            currentAudioUrl = audioUrl;
            currentMimeType = data.mimetype || 'audio/mpeg';
            
            // Set the audio player source and play
            audioElement.src = audioUrl;
            audioContainer.style.display = 'block';
            downloadBtn.style.display = 'inline-block';
            
            // Update download button text based on format
            const format = currentMimeType.includes('mp3') || currentMimeType.includes('mpeg') ? 'MP3' :
                          currentMimeType.includes('wav') ? 'WAV' :
                          currentMimeType.includes('ogg') ? 'OGG' : 'Audio';
            downloadBtn.textContent = `⬇️ Download ${format}`;
            
            audioElement.play();

            // Display English translation if available
            if (data.english_translation) {
                // Decode HTML entities (e.g., &#39; -> ')
                const textarea = document.createElement('textarea');
                textarea.innerHTML = data.english_translation;
                const decodedText = textarea.value;
                englishTranslationDiv.textContent = `English: "${decodedText}"`;
                englishTranslationDiv.style.display = 'block';
                status.textContent = '✅ Translation complete! Play audio...';
            } else {
                englishTranslationDiv.style.display = 'none';
                status.textContent = '✅ Translation complete! Play audio...';
            }
        } catch (err) {
            console.error('❌ Full error:', err);
            console.error('❌ Error message:', err.message);
            console.error('❌ Error stack:', err.stack);
            
            let errorMsg = '❌ Error during translation.';
            if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
                errorMsg = '❌ Network error: Cannot reach backend. Check API URL and CORS settings.';
            } else if (err.message) {
                errorMsg = `❌ ${err.message}`;
            }
            status.textContent = errorMsg;
        }

        recordBtn.disabled = false;
        stopBtn.disabled = true;
    };
};

closeAudioBtn.onclick = () => {
    audioElement.pause();
    audioElement.src = '';
    if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
    }
    audioContainer.style.display = 'none';
    downloadBtn.style.display = 'none';
    englishTranslationDiv.style.display = 'none';
    englishTranslationDiv.textContent = '';
    currentAudioBlob = null;
    currentMimeType = null;
    status.textContent = '🔴 Ready to record';
};

downloadBtn.onclick = () => {
    if (!currentAudioBlob) return;
    
    // Determine file extension from mimetype (default to mp3)
    let extension = 'mp3';
    if (currentMimeType) {
        if (currentMimeType.includes('mp3') || currentMimeType.includes('mpeg')) {
            extension = 'mp3';
        } else if (currentMimeType.includes('wav')) {
            extension = 'wav';
        } else if (currentMimeType.includes('ogg')) {
            extension = 'ogg';
        } else if (currentMimeType.includes('webm')) {
            extension = 'webm';
        }
    }
    
    // Create a download link
    const url = URL.createObjectURL(currentAudioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `translated-audio-${Date.now()}.${extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};