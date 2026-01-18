# Kana Chat

ブラウザで立ち絵を表示し、マイク入力で会話するローカルチャットアプリ。
「かな」と呼びかけると会話開始、30秒無音で会話モード終了（ウェイクワード待ちに戻る）。

## 機能

- **音声認識**: Web Speech API
- **音声合成**: VOICEVOX（春日部つむぎ）
- **通常会話**: Gemini 2.0 Flash
- **リアルタイム検索**: Gemini + Google Search（天気・ニュース等）
- **技術質問**: Claude CLI
- **スマートホーム**: SwitchBot API（照明、テレビ、温湿度等）
- **カレンダー**: Google Calendar API
- **Git連携**: コミット履歴確認
- **GitHub連携**: イシュー・PR・通知確認（GitHub CLI）
- **会話履歴**: SQLite

## セットアップ

### 1. 依存パッケージインストール

```bash
npm install
```

### 2. VOICEVOX

[VOICEVOX](https://voicevox.hiroshiba.jp/) をインストールして起動。
`localhost:50021` で動作している必要があります。

### 3. 環境変数

```bash
cp .env.example .env
```

`.env` を編集して各APIキーを設定。

---

## API設定方法

### Gemini API（必須）

1. [Google AI Studio](https://aistudio.google.com/) にアクセス
2. Googleアカウントでログイン
3. 「Get API key」→「Create API key」
4. キーをコピー → `.env` の `GEMINI_API_KEY` に設定

```env
GEMINI_API_KEY=AIzaSy...
```

---

### SwitchBot API（任意）

1. **SwitchBotアプリ**を開く
2. プロフィール → 設定 → **アプリバージョンを10回タップ**（隠しコマンド）
3. 「開発者向けオプション」が出現
4. トークンとシークレットをコピー

```env
SWITCHBOT_TOKEN=2c8f7cf9dfb353...
SWITCHBOT_SECRET=49e82789db506f2e...
```

**対応デバイス（server.jsのSWITCHBOT_DEVICESで設定）:**
- 温湿度計/CO2センサー
- 照明（赤外線リモート）
- テレビ（赤外線リモート）
- モニタ（赤外線リモート）
- プラグ

---

### Google Calendar API（任意）

#### Step 1: Google Cloud Console設定

1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを選択（Geminiと同じでOK）
3. 「APIとサービス」→「ライブラリ」
4. 「**Google Calendar API**」を検索 → **有効化**

#### Step 2: OAuth認証情報作成

1. 「APIとサービス」→「認証情報」
2. 「**認証情報を作成**」→「**OAuthクライアントID**」
3. アプリの種類: **デスクトップアプリ**
4. 作成 → **JSONをダウンロード**

#### Step 3: OAuth同意画面設定

1. 「APIとサービス」→「OAuth同意画面」
2. 「**テストユーザー**」セクションで「+ ADD USERS」
3. 自分のGmailアドレスを追加

#### Step 4: 認証実行

1. ダウンロードしたJSONをプロジェクトルートに配置
   ```bash
   mv ~/Downloads/client_secret_xxx.json ./credentials.json
   ```

2. 認証スクリプトを実行
   ```bash
   node scripts/google-auth.js
   ```

3. 表示されたURLをブラウザで開いて認証
4. `token.json` が自動生成される

---

### Claude CLI（任意）

技術質問やコード関連の質問で使用。

```bash
# インストール
npm install -g @anthropic-ai/claude-code

# ログイン（ブラウザが開く）
claude auth login
```

**確認:**
```bash
claude --version
```

---

### Codex CLI（任意）

コードレビューで使用。

```bash
# インストール
npm install -g @openai/codex

# ログイン（ブラウザ認証）
codex login

# またはAPIキーで
echo "your-openai-api-key" | codex login --with-api-key
```

**確認:**
```bash
codex login status
```

---

### GitHub CLI（任意）

GitHub のイシュー・プルリクエスト・通知の確認で使用。

```bash
# インストール（Homebrew）
brew install gh

# ログイン（ブラウザ認証）
gh auth login
```

**確認:**
```bash
gh auth status
```

---

## 起動

```bash
# VOICEVOXが起動していることを確認
npm start
```

ブラウザで http://localhost:3000 を開く。

## 使い方

1. **マイクボタン**を押して開始
2. 「**かな**」と呼びかけると会話モード開始
3. 30秒無音で会話モード終了（ウェイクワード待ちに戻る）

### 発話例

| 発話 | 動作 |
|------|------|
| 「今何時？」 | ローカル即答 |
| 「今日の天気は？」 | Gemini検索 |
| 「今日の予定は？」 | Googleカレンダー |
| 「電気つけて」 | SwitchBot |
| 「温度教えて」 | SwitchBot温湿度計 |
| 「コミット履歴見せて」 | Git |
| 「イシュー見せて」 | GitHub CLI |
| 「PRある？」 | GitHub CLI |
| 「クロード、このエラー直して」 | Claude CLI |

## ファイル構成

```
/kana-chat
├── server.js          # Express + 各種API連携
├── public/
│   ├── index.html     # 立ち絵 + チャットUI
│   ├── app.js         # Web Speech API + 通信
│   └── kana.png       # 立ち絵画像
├── prompts/
│   └── kana.txt       # キャラ設定
├── scripts/
│   └── google-auth.js # Calendar認証用
├── credentials.json   # Google OAuth認証情報（要取得）
├── token.json         # Google認証トークン（自動生成）
├── conversations.db   # 会話履歴（自動生成）
├── .env               # APIキー（.gitignore対象）
├── .env.example       # 環境変数テンプレート
└── package.json
```

## 注意事項

- `.env`、`credentials.json`、`token.json` はGitにコミットされません
- Google Calendar APIはテストモードで動作（本番公開不要）
- SwitchBotのデバイスIDは `server.js` の `SWITCHBOT_DEVICES` で設定
