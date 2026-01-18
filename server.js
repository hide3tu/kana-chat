require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// SQLite初期化
const db = new Database('conversations.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_content ON conversations(content)');

// キャラ設定読み込み
const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'kana.txt'), 'utf-8');

// 会話履歴（セッション内）
let conversationHistory = [];
let currentSessionId = null;

// Gemini API設定
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// VOICEVOX設定
const VOICEVOX_URL = 'http://localhost:50021';
const VOICEVOX_SPEAKER = 8; // 春日部つむぎ

// 会話履歴設定
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY) || 20; // 直近N件のやり取り

// SwitchBot設定
const SWITCHBOT_TOKEN = process.env.SWITCHBOT_TOKEN;
const SWITCHBOT_SECRET = process.env.SWITCHBOT_SECRET;

// SwitchBotデバイスマッピング
const SWITCHBOT_DEVICES = {
  '温湿度計': { id: '***REMOVED***', type: 'meter' },
  'CO2センサー': { id: '***REMOVED***', type: 'meter' },
  'PC電源': { id: '***REMOVED***', type: 'plug' },
  '灯り': { id: '***REMOVED***', type: 'light' },
  '照明': { id: '***REMOVED***', type: 'light' },
  '電気': { id: '***REMOVED***', type: 'light' },
  'テレビ': { id: '***REMOVED***', type: 'tv' },
  'BDレコーダー': { id: '***REMOVED***', type: 'dvd' },
  'LGモニタ': { id: '***REMOVED***', type: 'monitor' },
  'モニタ': { id: '***REMOVED***', type: 'monitor' }
};

// SwitchBot API呼び出し
async function callSwitchBot(endpoint, method = 'GET', body = null) {
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const sign = crypto.createHmac('sha256', SWITCHBOT_SECRET)
    .update(SWITCHBOT_TOKEN + t + nonce).digest('base64');

  const response = await fetch(`https://api.switch-bot.com/v1.1/${endpoint}`, {
    method,
    headers: {
      'Authorization': SWITCHBOT_TOKEN,
      'sign': sign,
      't': t,
      'nonce': nonce,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : null
  });
  return response.json();
}

// 温湿度・CO2取得
async function getSensorData() {
  const result = await callSwitchBot('devices/***REMOVED***/status');
  if (result.statusCode === 100) {
    return {
      temperature: result.body.temperature,
      humidity: result.body.humidity,
      co2: result.body.CO2
    };
  }
  return null;
}

// デバイスコマンド実行
async function executeDeviceCommand(deviceId, command, parameter = 'default') {
  return callSwitchBot(`devices/${deviceId}/commands`, 'POST', {
    command,
    parameter,
    commandType: 'command'
  });
}

// SwitchBot判定
function needsSwitchBot(text) {
  const triggers = [
    '電気', '照明', 'ライト', '灯り',
    'テレビ', 'TV', 'モニタ',
    'PC電源', 'パソコン',
    '温度', '湿度', '室温', 'CO2', '二酸化炭素',
    'つけて', '消して', 'オン', 'オフ'
  ];
  return triggers.some(t => text.includes(t));
}

// SwitchBotコマンド処理
async function handleSwitchBotCommand(text) {
  try {
    // 温度・湿度・CO2の問い合わせ
    if (['温度', '湿度', '室温', 'CO2', '二酸化炭素', '何度'].some(t => text.includes(t))) {
      const data = await getSensorData();
      if (data) {
        const temp = data.temperature;
        const hum = data.humidity;
        const co2 = data.co2;
        return {
          display: `温度: ${temp}℃ / 湿度: ${hum}% / CO2: ${co2}ppm`,
          speak: `今${temp}度で、湿度は${hum}パーセント、CO2は${co2}ピーピーエムですね！`
        };
      }
    }

    // 照明操作
    if (['電気', '照明', 'ライト', '灯り'].some(t => text.includes(t))) {
      const device = SWITCHBOT_DEVICES['灯り'];
      if (text.includes('つけて') || text.includes('オン')) {
        await executeDeviceCommand(device.id, 'turnOn');
        return { display: '照明をつけました！', speak: 'はーい、つけましたよ！' };
      } else if (text.includes('消して') || text.includes('オフ')) {
        await executeDeviceCommand(device.id, 'turnOff');
        return { display: '照明を消しました！', speak: 'はーい、消しましたよ！' };
      }
    }

    // テレビ操作
    if (['テレビ', 'TV'].some(t => text.includes(t))) {
      const device = SWITCHBOT_DEVICES['テレビ'];
      if (text.includes('つけて') || text.includes('オン')) {
        await executeDeviceCommand(device.id, 'turnOn');
        return { display: 'テレビをつけました！', speak: 'はーい、テレビつけましたよ！' };
      } else if (text.includes('消して') || text.includes('オフ')) {
        await executeDeviceCommand(device.id, 'turnOff');
        return { display: 'テレビを消しました！', speak: 'はーい、テレビ消しましたよ！' };
      }
    }

    // モニタ操作
    if (['モニタ', 'LG'].some(t => text.includes(t))) {
      const device = SWITCHBOT_DEVICES['モニタ'];
      if (text.includes('つけて') || text.includes('オン')) {
        await executeDeviceCommand(device.id, 'turnOn');
        return { display: 'モニタをつけました！', speak: 'はーい、モニタつけましたよ！' };
      } else if (text.includes('消して') || text.includes('オフ')) {
        await executeDeviceCommand(device.id, 'turnOff');
        return { display: 'モニタを消しました！', speak: 'はーい、モニタ消しましたよ！' };
      }
    }

    // PC電源操作
    if (['PC電源', 'パソコン'].some(t => text.includes(t))) {
      const device = SWITCHBOT_DEVICES['PC電源'];
      if (text.includes('つけて') || text.includes('オン')) {
        await executeDeviceCommand(device.id, 'turnOn');
        return { display: 'PC電源をONにしました！', speak: 'はーい、ピーシー電源オンにしましたよ！' };
      } else if (text.includes('消して') || text.includes('オフ')) {
        await executeDeviceCommand(device.id, 'turnOff');
        return { display: 'PC電源をOFFにしました！', speak: 'はーい、ピーシー電源オフにしましたよ！' };
      }
    }

    return null; // 該当なし
  } catch (error) {
    console.error('SwitchBot error:', error);
    return {
      display: `SwitchBotエラー: ${error.message}`,
      speak: 'あれ、うまくいかなかったみたいです…'
    };
  }
}

// ローカル即答（API不要）
function getLocalResponse(text) {
  const now = new Date();

  // 時刻
  if (['何時', '今何時', '時間教えて'].some(t => text.includes(t))) {
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeDisplay = `${hour}:${minute.toString().padStart(2, '0')}`;
    const timeSpeak = `${hour}時${minute}分`;
    return {
      display: `今は${timeDisplay}ですよ！`,
      speak: `今は${timeSpeak}ですよ！`
    };
  }

  // 日付・曜日
  if (['何曜', '何日', '今日何日', '今日は何'].some(t => text.includes(t))) {
    const date = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' });
    return {
      display: `今日は${date}ですね！`,
      speak: `今日は${date}ですね！`
    };
  }

  // 年
  if (['何年', '今年は'].some(t => text.includes(t))) {
    const year = now.getFullYear();
    return {
      display: `${year}年ですよ！`,
      speak: `${year}年ですよ！`
    };
  }

  return null;
}

// Claude CLI判定
function shouldUseClaude(text) {
  const triggers = [
    'クロード', 'claude',
    'コード書いて', 'プログラム',
    'エラー', 'バグ', 'デバッグ',
    '教えてクロード', '実装'
  ];
  return triggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

// 検索判定（Gemini Search Grounding用）
function needsSearch(text) {
  const triggers = [
    '今日の', '明日の', '最新', '現在',
    '天気', 'ニュース', '調べて', '検索して',
    '株価', '為替'
  ];
  return triggers.some(t => text.includes(t));
}

// VOICEVOX音声合成
async function synthesize(text) {
  try {
    // 音声合成用クエリ作成
    const queryRes = await fetch(`${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${VOICEVOX_SPEAKER}`, {
      method: 'POST'
    });
    const query = await queryRes.json();

    // 話速調整（1.0がデフォルト、1.2で少し速く）
    query.speedScale = 1.2;

    // 音声合成
    const audioRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${VOICEVOX_SPEAKER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query)
    });

    const audioBuffer = await audioRes.arrayBuffer();
    return Buffer.from(audioBuffer).toString('base64');
  } catch (error) {
    console.error('VOICEVOX error:', error);
    return null;
  }
}

// Gemini API呼び出し（通常）
async function callGemini(message) {
  // 直近MAX_HISTORY件のみ使用
  const recentHistory = conversationHistory.slice(-MAX_HISTORY);
  const contents = recentHistory.map(h => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents
    })
  });

  const data = await response.json();

  // エラーチェック
  if (data.error) {
    console.error('Gemini API error:', data.error);
    if (data.error.code === 429) {
      throw new Error('RATE_LIMIT');
    }
    throw new Error(`API_ERROR: ${data.error.message}`);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Gemini API呼び出し（検索付き）
async function callGeminiWithSearch(message) {
  // 直近MAX_HISTORY件のみ使用
  const recentHistory = conversationHistory.slice(-MAX_HISTORY);
  const contents = recentHistory.map(h => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.content }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: contents,
      tools: [{
        google_search: {}
      }]
    })
  });

  const data = await response.json();

  // エラーチェック
  if (data.error) {
    console.error('Gemini API error:', data.error);
    if (data.error.code === 429) {
      throw new Error('RATE_LIMIT');
    }
    throw new Error(`API_ERROR: ${data.error.message}`);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Claude CLI呼び出し
async function callClaudeCLI(message) {
  try {
    const result = execSync(
      `claude -p "${message.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 120000 }
    );
    return result;
  } catch (error) {
    console.error('Claude CLI error:', error);
    return 'クロードに聞けなかったみたいです…';
  }
}

// 過去会話検索
function searchConversations(keyword) {
  const logs = db.prepare(`
    SELECT role, content, created_at
    FROM conversations
    WHERE content LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(`%${keyword}%`);
  return logs;
}

// レスポンスをJSON形式にパース
function parseResponse(text) {
  try {
    // JSON部分を抽出
    const jsonMatch = text.match(/\{[\s\S]*"display"[\s\S]*"speak"[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // パース失敗時はテキストをそのまま使用
  }

  // JSONでない場合はそのまま
  return {
    display: text,
    speak: text
  };
}

// 会話履歴保存
function saveConversation(role, content) {
  if (!currentSessionId) {
    currentSessionId = Date.now().toString();
  }

  db.prepare(`
    INSERT INTO conversations (session_id, role, content)
    VALUES (?, ?, ?)
  `).run(currentSessionId, role, content);

  conversationHistory.push({ role, content });
}

// メインチャットエンドポイント
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  console.log('User:', message);

  try {
    let responseText;
    let display, speak;

    // 1. ローカル即答チェック（最優先）
    const localResponse = getLocalResponse(message);
    if (localResponse) {
      display = localResponse.display;
      speak = localResponse.speak;
    }
    // 2. SwitchBot判定
    else if (needsSwitchBot(message)) {
      console.log('Using SwitchBot...');
      const switchBotResponse = await handleSwitchBotCommand(message);
      if (switchBotResponse) {
        display = switchBotResponse.display;
        speak = switchBotResponse.speak;
      } else {
        // SwitchBotで処理できなかった場合は通常のGeminiへ
        responseText = await callGemini(message);
        const parsed = parseResponse(responseText);
        display = parsed.display;
        speak = parsed.speak;
      }
    }
    // 3. Claude判定
    else if (shouldUseClaude(message)) {
      console.log('Using Claude CLI...');
      const claudeResponse = await callClaudeCLI(message);

      // カナ口調でラップ
      const wrapPrompt = `以下の技術的な回答をカナちゃんの口調で簡潔に伝えて。専門用語はそのまま使ってOK。JSON形式で出力して：\n\n${claudeResponse}`;
      responseText = await callGemini(wrapPrompt);
      const parsed = parseResponse(responseText);
      display = parsed.display;
      speak = parsed.speak;
    }
    // 4. 検索判定
    else if (needsSearch(message)) {
      console.log('Using Gemini with Search...');
      responseText = await callGeminiWithSearch(message);
      const parsed = parseResponse(responseText);
      display = parsed.display;
      speak = parsed.speak;
    }
    // 4. 通常のGemini
    else {
      console.log('Using Gemini...');
      responseText = await callGemini(message);
      const parsed = parseResponse(responseText);
      display = parsed.display;
      speak = parsed.speak;

      // 過去会話検索タグをチェック
      const searchMatch = responseText.match(/<search>(.+?)<\/search>/);
      if (searchMatch) {
        const keyword = searchMatch[1];
        const logs = searchConversations(keyword);

        if (logs.length > 0) {
          const context = logs.map(l => `${l.role}: ${l.content}`).join('\n');
          const contextPrompt = `【過去の会話】\n${context}\n\n【現在の質問】\n${message}\n\nこれを踏まえてカナとして応答して。JSON形式で出力して：`;
          responseText = await callGemini(contextPrompt);
          const parsed = parseResponse(responseText);
          display = parsed.display;
          speak = parsed.speak;
        }
      }
    }

    console.log('Kana:', display);

    // 会話履歴保存
    saveConversation('user', message);
    saveConversation('assistant', display);

    // 音声合成
    const audio = await synthesize(speak);

    res.json({
      display,
      speak,
      audio
    });

  } catch (error) {
    console.error('Chat error:', error);

    let display, speak;

    if (error.message === 'RATE_LIMIT') {
      display = 'APIのレート制限に引っかかっちゃいました…少し待ってからまた話しかけてください！';
      speak = 'エーピーアイのレート制限に引っかかっちゃいました。少し待ってからまた話しかけてください！';
    } else if (error.message?.startsWith('API_ERROR')) {
      display = `APIエラーです: ${error.message.replace('API_ERROR: ', '')}`;
      speak = 'エーピーアイエラーが発生しちゃいました…';
    } else {
      display = 'あれ、なんかエラーが出ちゃったみたいです…';
      speak = 'あれ、なんかエラーが出ちゃったみたいです…';
    }

    const audio = await synthesize(speak);

    res.status(500).json({
      error: error.message,
      display,
      speak,
      audio
    });
  }
});

// 会話リセット
app.post('/reset', (req, res) => {
  conversationHistory = [];
  currentSessionId = null;
  res.json({ status: 'ok' });
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Kana-chat server running at http://localhost:${PORT}`);
  console.log('Make sure VOICEVOX Engine is running at localhost:50021');
});
