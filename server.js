require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { google } = require('googleapis');

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

// SwitchBotデバイスマッピング（環境変数から取得）
const SWITCHBOT_DEVICES = {
  '温湿度計': { id: process.env.SWITCHBOT_METER_ID, type: 'meter' },
  'CO2センサー': { id: process.env.SWITCHBOT_METER_ID, type: 'meter' },
  'PC電源': { id: process.env.SWITCHBOT_PLUG_ID, type: 'plug' },
  '灯り': { id: process.env.SWITCHBOT_LIGHT_ID, type: 'light' },
  '照明': { id: process.env.SWITCHBOT_LIGHT_ID, type: 'light' },
  '電気': { id: process.env.SWITCHBOT_LIGHT_ID, type: 'light' },
  'テレビ': { id: process.env.SWITCHBOT_TV_ID, type: 'tv' },
  'BDレコーダー': { id: process.env.SWITCHBOT_DVD_ID, type: 'dvd' },
  'LGモニタ': { id: process.env.SWITCHBOT_MONITOR_ID, type: 'monitor' },
  'モニタ': { id: process.env.SWITCHBOT_MONITOR_ID, type: 'monitor' }
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
  const result = await callSwitchBot(`devices/${process.env.SWITCHBOT_METER_ID}/status`);
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
  const lower = text.toLowerCase();
  const triggers = [
    '電気', '照明', 'ライト', '灯り',
    'テレビ', 'tv', 'モニタ',
    'pc電源', 'パソコン',
    '温度', '湿度', '室温', 'co2', '二酸化炭素',
    'つけて', '消して', 'オン', 'オフ'
  ];
  return triggers.some(t => lower.includes(t));
}

// デバイス操作定義
const DEVICE_CONTROLS = [
  { keywords: ['電気', '照明', 'ライト', '灯り'], device: '灯り', name: '照明', speakName: '' },
  { keywords: ['テレビ', 'TV'], device: 'テレビ', name: 'テレビ', speakName: 'テレビ' },
  { keywords: ['モニタ', 'LG'], device: 'モニタ', name: 'モニタ', speakName: 'モニタ' },
  { keywords: ['PC電源', 'パソコン'], device: 'PC電源', name: 'PC電源', speakName: 'ピーシー電源' }
];

async function handleSwitchBotCommand(text) {
  try {
    const lower = text.toLowerCase();
    // 温度・湿度・CO2の問い合わせ
    if (['温度', '湿度', '室温', 'co2', '二酸化炭素', '何度'].some(t => lower.includes(t))) {
      const data = await getSensorData();
      if (data) {
        return {
          display: `温度: ${data.temperature}℃ / 湿度: ${data.humidity}% / CO2: ${data.co2}ppm`,
          speak: `今${data.temperature}度で、湿度は${data.humidity}パーセント、CO2は${data.co2}ピーピーエムですね！`
        };
      }
    }

    // デバイス操作（共通処理）
    for (const ctrl of DEVICE_CONTROLS) {
      if (ctrl.keywords.some(k => text.includes(k))) {
        const device = SWITCHBOT_DEVICES[ctrl.device];
        const isOn = text.includes('つけて') || text.includes('オン');
        const isOff = text.includes('消して') || text.includes('オフ');

        if (isOn || isOff) {
          await executeDeviceCommand(device.id, isOn ? 'turnOn' : 'turnOff');
          const action = isOn ? 'つけ' : '消し';
          const suffix = ctrl.speakName ? ctrl.speakName : '';
          return {
            display: `${ctrl.name}を${action}ました！`,
            speak: `はーい、${suffix}${action}ましたよ！`
          };
        }
      }
    }

    return null;
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

  if (['何時', '今何時', '時間教えて'].some(t => text.includes(t))) {
    const h = now.getHours();
    const m = now.getMinutes();
    return {
      display: `今は${h}:${String(m).padStart(2, '0')}ですよ！`,
      speak: `今は${h}時${m}分ですよ！`
    };
  }

  if (['何曜日', '何日', '今日何日', '今日は何日', '今日は何曜'].some(t => text.includes(t))) {
    const date = now.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' });
    return { display: `今日は${date}ですね！`, speak: `今日は${date}ですね！` };
  }

  if (['何年', '今年は'].some(t => text.includes(t))) {
    return { display: `${now.getFullYear()}年ですよ！`, speak: `${now.getFullYear()}年ですよ！` };
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
    '株価', '為替', '探して', '教えて',
    'について', 'とは', '何？', 'どう？'
  ];
  return triggers.some(t => text.includes(t));
}

// Geminiの返答が検索意図を示しているか判定
function responseNeedsSearch(text) {
  const patterns = [
    '検索します', '調べます', '調べてみます', '探します',
    '確認します', '探してみます', '調べてきます', '探してきます'
  ];
  return patterns.some(p => text.includes(p));
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

// Gemini API呼び出し
async function callGemini(message, useSearch = false) {
  const recentHistory = conversationHistory.slice(-MAX_HISTORY);
  const contents = recentHistory.map(h => ({
    role: h.role === 'user' ? 'user' : 'model',
    parts: [{ text: h.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents
  };
  if (useSearch) {
    requestBody.tools = [{ google_search: {} }];
  }

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();

  if (data.error) {
    console.error('Gemini API error:', data.error);
    if (data.error.code === 429) throw new Error('RATE_LIMIT');
    throw new Error(`API_ERROR: ${data.error.message}`);
  }

  // 全partsのテキストを結合（検索時は複数partsが返る）
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter(p => p.text).map(p => p.text);

  if (useSearch) {
    console.log(`Gemini response parts: ${parts.length}`);
  }

  // 最後のテキストpartを返す（検索結果を踏まえた回答）
  return textParts[textParts.length - 1] || '';
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

// Codex CLI呼び出し
async function callCodexCLI(code) {
  try {
    const prompt = `以下のコードをレビューしてください：\n\n${code}`;
    const result = execSync(
      `codex -p "${prompt.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 180000 }
    );
    return result;
  } catch (error) {
    console.error('Codex CLI error:', error);
    return 'コーデックスに聞けなかったみたいです…';
  }
}

// Git連携
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();

function needsGit(text) {
  const triggers = ['コミット', 'ログ', '履歴', 'git', '進捗', 'プッシュ'];
  return triggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

function getGitLog(count = 5) {
  try {
    const log = execSync(
      `git log --oneline -${count}`,
      { encoding: 'utf-8', cwd: PROJECT_DIR }
    );
    return log.trim().split('\n');
  } catch (e) {
    return null;
  }
}

function getTodayCommits() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const log = execSync(
      `git log --oneline --since="${today} 00:00:00"`,
      { encoding: 'utf-8', cwd: PROJECT_DIR }
    );
    return log.trim().split('\n').filter(l => l);
  } catch (e) {
    return [];
  }
}

function handleGitCommand(text) {
  // 今日のコミット
  if (text.includes('今日') && (text.includes('コミット') || text.includes('進捗'))) {
    const commits = getTodayCommits();
    if (commits.length === 0) {
      return { display: '今日のコミットはまだないですね', speak: '今日のコミットはまだないですね' };
    }
    const list = commits.join('\n');
    return {
      display: `今日のコミット（${commits.length}件）:\n${list}`,
      speak: `今日は${commits.length}件コミットされてますね！`
    };
  }

  // 直近のコミット
  if (text.includes('コミット') || text.includes('履歴') || text.includes('ログ')) {
    const logs = getGitLog(5);
    if (!logs) {
      return { display: 'Gitリポジトリが見つかりません', speak: 'ギットリポジトリが見つからないみたいです' };
    }
    const list = logs.join('\n');
    return {
      display: `直近のコミット:\n${list}`,
      speak: `直近5件のコミット、画面に出しましたよ！`
    };
  }

  return null;
}

// GitHub CLI連携
function needsGitHub(text) {
  const triggers = ['イシュー', 'issue', 'プルリク', 'PR', 'プルリクエスト', '通知', 'GitHub', 'ギットハブ'];
  return triggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}

function getGitHubList(type, repo = null) {
  try {
    const repoFlag = repo ? `-R ${repo}` : '';
    const result = execSync(
      `gh ${type} list ${repoFlag} --limit 5 --json number,title,state --jq '.[] | "#\\(.number) \\(.title) [\\(.state)]"'`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    return result.trim().split('\n').filter(l => l);
  } catch (e) {
    return null;
  }
}

function getGitHubNotifications() {
  try {
    const result = execSync(
      `gh api notifications --jq '.[:5] | .[] | "\\(.subject.type): \\(.subject.title)"'`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    return result.trim().split('\n').filter(l => l);
  } catch (e) {
    return null;
  }
}

function handleGitHubCommand(text) {
  // リポジトリ指定の抽出（例: "hide3tu/kana-chat"）
  const repoMatch = text.match(/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)/);
  const repo = repoMatch ? repoMatch[1] : null;

  // 通知
  if (text.includes('通知')) {
    const notifications = getGitHubNotifications();
    if (!notifications || notifications.length === 0) {
      return { display: 'GitHubの通知はありません', speak: 'ギットハブの通知はないですよ！' };
    }
    return {
      display: `GitHub通知:\n${notifications.join('\n')}`,
      speak: `ギットハブの通知が${notifications.length}件ありますね！`
    };
  }

  // プルリクエスト
  if (['プルリク', 'PR', 'プルリクエスト'].some(t => text.includes(t))) {
    const prs = getGitHubList('pr', repo);
    if (!prs || prs.length === 0) {
      return { display: 'オープンなPRはありません', speak: 'オープンなプルリクエストはないですよ！' };
    }
    return {
      display: `プルリクエスト:\n${prs.join('\n')}`,
      speak: `プルリクエストが${prs.length}件ありますね！`
    };
  }

  // イシュー
  if (['イシュー', 'issue'].some(t => text.toLowerCase().includes(t.toLowerCase()))) {
    const issues = getGitHubList('issue', repo);
    if (!issues || issues.length === 0) {
      return { display: 'オープンなイシューはありません', speak: 'オープンなイシューはないですよ！' };
    }
    return {
      display: `イシュー:\n${issues.join('\n')}`,
      speak: `イシューが${issues.length}件ありますね！`
    };
  }

  return null;
}

// Google Calendar連携
let calendarAuth = null;

function initCalendarAuth() {
  try {
    const credentialsPath = path.join(__dirname, 'credentials.json');
    const tokenPath = path.join(__dirname, 'token.json');

    if (!fs.existsSync(credentialsPath) || !fs.existsSync(tokenPath)) {
      console.log('Calendar: credentials.json または token.json がありません');
      return null;
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath));
    const token = JSON.parse(fs.readFileSync(tokenPath));
    const { client_secret, client_id } = credentials.installed || credentials.web;

    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret);
    oAuth2Client.setCredentials(token);

    console.log('Calendar: 認証OK');
    return oAuth2Client;
  } catch (error) {
    console.error('Calendar auth error:', error);
    return null;
  }
}

// 起動時に認証
calendarAuth = initCalendarAuth();

function needsCalendar(text) {
  const triggers = ['予定', 'スケジュール', 'カレンダー'];
  const excludes = ['天気', '気温', 'ニュース'];
  if (excludes.some(e => text.includes(e))) return false;
  return triggers.some(t => text.includes(t));
}

async function getCalendarEvents(targetDate = null) {
  if (!calendarAuth) return null;

  const calendar = google.calendar({ version: 'v3', auth: calendarAuth });
  const start = targetDate ? new Date(targetDate) : new Date();
  start.setHours(targetDate ? 0 : start.getHours(), targetDate ? 0 : start.getMinutes(), 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

function formatEventTime(event) {
  if (!event.start.dateTime) return '終日';
  const d = new Date(event.start.dateTime);
  return d.getMinutes() > 0 ? `${d.getHours()}時${d.getMinutes()}分` : `${d.getHours()}時`;
}

function parseDateFromText(text) {
  const year = new Date().getFullYear();
  const match = text.match(/(\d{1,2})[月\/](\d{1,2})日?/);
  return match ? new Date(year, parseInt(match[1]) - 1, parseInt(match[2])) : null;
}

async function handleCalendarCommand(text) {
  if (!calendarAuth) {
    return {
      display: 'カレンダーが設定されていません',
      speak: 'カレンダーがまだ設定されてないみたいです'
    };
  }

  try {
    let dayLabel, events;

    const specificDate = parseDateFromText(text);
    if (specificDate) {
      dayLabel = `${specificDate.getMonth() + 1}月${specificDate.getDate()}日`;
      events = await getCalendarEvents(specificDate);
    } else if (text.includes('明日')) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      dayLabel = '明日';
      events = await getCalendarEvents(tomorrow);
    } else {
      dayLabel = '今日';
      events = await getCalendarEvents();
    }

    if (events.length === 0) {
      return { display: `${dayLabel}の予定はありません`, speak: `${dayLabel}の予定はないですよ！` };
    }

    const list = events.map(e => `${formatEventTime(e)} ${e.summary}`).join('\n');

    // 記念日・誕生日チェック
    const celebrationKeywords = ['誕生日', '記念日', 'birthday', 'anniversary'];
    const celebrations = events.filter(e =>
      celebrationKeywords.some(k => e.summary.toLowerCase().includes(k.toLowerCase()))
    );

    let speak = `${dayLabel}は${events.length}件の予定がありますね！`;
    if (celebrations.length > 0) {
      const names = celebrations.map(e => e.summary).join('と');
      speak += `あ、${names}ですね！おめでとうございます！`;
    }

    return { display: `${dayLabel}の予定:\n${list}`, speak };
  } catch (error) {
    console.error('Calendar error:', error);
    return {
      display: 'カレンダー取得エラー',
      speak: 'カレンダーの取得に失敗しちゃいました…'
    };
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
    // 3. Git判定
    else if (needsGit(message)) {
      console.log('Using Git...');
      const gitResponse = handleGitCommand(message);
      if (gitResponse) {
        display = gitResponse.display;
        speak = gitResponse.speak;
      } else {
        responseText = await callGemini(message);
        const parsed = parseResponse(responseText);
        display = parsed.display;
        speak = parsed.speak;
      }
    }
    // 4. GitHub判定
    else if (needsGitHub(message)) {
      console.log('Using GitHub CLI...');
      const ghResponse = handleGitHubCommand(message);
      if (ghResponse) {
        display = ghResponse.display;
        speak = ghResponse.speak;
      } else {
        responseText = await callGemini(message);
        const parsed = parseResponse(responseText);
        display = parsed.display;
        speak = parsed.speak;
      }
    }
    // 5. カレンダー判定
    else if (needsCalendar(message)) {
      console.log('Using Calendar...');
      const calendarResponse = await handleCalendarCommand(message);
      display = calendarResponse.display;
      speak = calendarResponse.speak;
    }
    // 6. Claude判定
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
    // 7. 検索判定
    else if (needsSearch(message)) {
      console.log('Using Gemini with Search...');
      responseText = await callGemini(message, true);
      // <search>タグが残っていたら除去
      responseText = responseText.replace(/<search>.+?<\/search>/g, '');
      const parsed = parseResponse(responseText);
      display = parsed.display;
      speak = parsed.speak;
    }
    // 8. 通常のGemini
    else {
      console.log('Using Gemini...');
      responseText = await callGemini(message);

      // <search>タグをチェック
      const searchMatch = responseText.match(/<search>(.+?)<\/search>/);
      if (searchMatch) {
        const keyword = searchMatch[1];
        console.log(`Search tag detected: "${keyword}"`);

        // まず過去会話を検索
        const logs = searchConversations(keyword);

        if (logs.length > 0) {
          // 過去会話が見つかった場合
          console.log('Found past conversations, using context...');
          const context = logs.map(l => `${l.role}: ${l.content}`).join('\n');
          const contextPrompt = `【過去の会話】\n${context}\n\n【現在の質問】\n${message}\n\nこれを踏まえてカナとして応答して。JSON形式で出力して：`;
          responseText = await callGemini(contextPrompt);
        } else {
          // 過去会話がない場合はGoogle検索で再試行
          console.log('No past conversations, retrying with Google Search...');
          responseText = await callGemini(message, true);
        }
      }
      // 「検索します」「調べます」系の返答なら検索付きで再試行
      else if (responseNeedsSearch(responseText)) {
        console.log('Response indicates search intent, retrying with Google Search...');
        responseText = await callGemini(message, true);
      }

      // <search>タグが残っていたら除去
      responseText = responseText.replace(/<search>.+?<\/search>/g, '');

      const parsed = parseResponse(responseText);
      display = parsed.display;
      speak = parsed.speak;
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
