// DOM要素
const messagesEl = document.getElementById('messages');
const textInput = document.getElementById('textInput');
const sendButton = document.getElementById('sendButton');
const micButton = document.getElementById('micButton');
const statusEl = document.getElementById('status');

// 状態管理
let isConversationMode = false;
let isListening = false;
let isSpeaking = false;
let silenceTimeout = null;
let recognition = null;
let micEnabled = false;

// 設定
const CONVERSATION_TIMEOUT = 30000;
const SPEECH_END_DELAY = 1000;
const POST_SPEECH_DELAY = 500;

// Web Speech API初期化
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    console.error('Web Speech API not supported');
    setStatus('音声認識非対応', 'waiting');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => {
    console.log('Speech recognition started');
    isListening = true;
    if (isConversationMode) {
      setStatus('聞いています...', 'listening');
    }
  };

  rec.onend = () => {
    console.log('Speech recognition ended');
    isListening = false;
    if (micEnabled && !isSpeaking) {
      setTimeout(() => { if (micEnabled && !isSpeaking) startListening(); }, 100);
    }
  };

  rec.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }

    // 最終結果があれば処理
    if (finalTranscript) {
      handleSpeechResult(finalTranscript);
    }

    // 無音タイマーリセット
    resetSilenceTimer();
  };

  rec.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      setStatus('マイク許可が必要です', 'waiting');
    }
  };

  return rec;
}

// 音声認識結果の処理
function handleSpeechResult(text) {
  console.log('Recognized:', text);

  // 待機モード中：ウェイクワード検出
  if (!isConversationMode) {
    if (text.includes('かな') || text.includes('カナ')) {
      console.log('Wake word detected!');
      isConversationMode = true;
      setStatus('会話モード', 'listening');

      // ウェイクワード含めてそのまま送信
      sendMessage(text);

      resetConversationTimer();
      return;
    }
    return; // ウェイクワードなしは無視
  }

  // 会話モード中
  sendMessage(text);
  resetConversationTimer();
}

// メッセージ送信
async function sendMessage(text) {
  if (!text.trim()) return;

  // ユーザーメッセージ表示
  addMessage(text, 'user');
  setStatus('考え中...', 'thinking');

  try {
    const response = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });

    const data = await response.json();

    if (data.error && !data.display) {
      throw new Error(data.error);
    }

    // かなのメッセージ表示
    addMessage(data.display, 'kana');

    // 音声再生
    if (data.audio) {
      await playAudio(data.audio);
    }

  } catch (error) {
    console.error('Send error:', error);
    addMessage('ごめんなさい、エラーが発生しちゃいました...', 'kana');
  }

  // マイク有効かつ会話モード中なら聞き取り再開
  if (micEnabled && isConversationMode && !isSpeaking) {
    setStatus('聞いています...', 'listening');
  }
}

// 音声再生
function playAudio(base64Audio) {
  return new Promise((resolve) => {
    isSpeaking = true;
    setStatus('話しています...', 'speaking');

    // 音声認識停止（自己フィードバック防止）
    if (recognition && isListening) {
      recognition.stop();
    }

    const audio = new Audio('data:audio/wav;base64,' + base64Audio);

    audio.onended = () => {
      isSpeaking = false;
      setTimeout(() => {
        if (micEnabled) {
          startListening();
          setStatus(isConversationMode ? '聞いています...' : '「かな」と呼んでね', 'listening');
        } else {
          setStatus('マイクボタンを押して開始', 'waiting');
        }
        resolve();
      }, POST_SPEECH_DELAY);
    };

    audio.onerror = () => {
      isSpeaking = false;
      console.error('Audio playback error');
      resolve();
    };

    audio.play().catch(e => {
      console.error('Audio play failed:', e);
      isSpeaking = false;
      resolve();
    });
  });
}

// メッセージ表示
function addMessage(text, type) {
  const messageEl = document.createElement('div');
  messageEl.className = `message message-${type}`;
  messagesEl.appendChild(messageEl);

  // かなの返答はタイプライター表示
  if (type === 'kana') {
    typeWriter(messageEl, text, 0);
  } else {
    messageEl.textContent = text;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// タイプライター効果
function typeWriter(element, text, index) {
  if (index < text.length) {
    element.textContent += text.charAt(index);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setTimeout(() => typeWriter(element, text, index + 1), 30);
  }
}

// ステータス表示
function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status-indicator status-${type}`;
}

// 無音タイマー（会話終了用）
let conversationTimer = null;

function resetConversationTimer() {
  clearTimeout(conversationTimer);
  // 会話モード中のみタイムアウト設定
  if (isConversationMode) {
    conversationTimer = setTimeout(() => {
      endConversation();
    }, CONVERSATION_TIMEOUT);
  }
}

function resetSilenceTimer() {
  clearTimeout(silenceTimeout);
}

// 会話終了
function endConversation() {
  console.log('Conversation ended');
  isConversationMode = false;
  clearTimeout(conversationTimer);

  if (micEnabled) {
    setStatus('「かな」と呼んでね', 'listening');
    if (!isListening) startListening();
  } else {
    setStatus('マイクボタンを押して開始', 'waiting');
  }

  fetch('/reset', { method: 'POST' });
}

// 音声認識開始
function startListening() {
  if (!recognition) {
    recognition = initSpeechRecognition();
  }

  if (recognition && !isListening && !isSpeaking) {
    try {
      recognition.start();
    } catch (e) {
      // already started
    }
  }
}

// 音声認識停止
function stopListening() {
  if (recognition && isListening) {
    recognition.stop();
  }
  isListening = false;
}

// イベントリスナー
sendButton.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text) return;
  isConversationMode = true;
  sendMessage(text);
  textInput.value = '';
  resetConversationTimer();
});

textInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendButton.click();
});

micButton.addEventListener('click', () => {
  micEnabled = !micEnabled;
  micButton.classList.toggle('active', micEnabled);
  if (micEnabled) {
    startListening();
    setStatus('「かな」と呼んでね', 'listening');
  } else {
    stopListening();
    setStatus('マイクボタンを押して開始', 'waiting');
  }
});

// 初期化
recognition = initSpeechRecognition();
setStatus('マイクボタンを押して開始', 'waiting');

console.log('Kana Chat initialized');
console.log('Say "かな" to start conversation');
