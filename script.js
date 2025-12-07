let mediaRecorder;
let audioChunks = [];

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const status = document.getElementById('status');
const audioElement = document.getElementById('player');
const audioContainer = document.getElementById('audioContainer');
const closeAudioBtn = document.getElementById('closeAudio');
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
            const response = await fetch('http://127.0.0.1:5000/translate', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error('Translation failed');

            const data = await response.json();
            
            // Decode base64 audio
            const audioBytes = atob(data.audio);
            const audioArray = new Uint8Array(audioBytes.length);
            for (let i = 0; i < audioBytes.length; i++) {
                audioArray[i] = audioBytes.charCodeAt(i);
            }
            const audioBlob = new Blob([audioArray], { type: data.mimetype });
            const audioUrl = URL.createObjectURL(audioBlob);

            // Set the audio player source and play
            audioElement.src = audioUrl;
            audioContainer.style.display = 'block';
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
            console.error(err);
            status.textContent = '❌ Error during translation.';
        }

        recordBtn.disabled = false;
        stopBtn.disabled = true;
    };
};

closeAudioBtn.onclick = () => {
    audioElement.pause();
    audioElement.src = '';
    audioContainer.style.display = 'none';
    englishTranslationDiv.style.display = 'none';
    englishTranslationDiv.textContent = '';
    status.textContent = '🔴 Ready to record';
};