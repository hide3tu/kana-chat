const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3001/callback'
  );

  // トークンが既にあれば読み込み
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    console.log('既存のトークンを使用します');

    // テスト：カレンダー一覧取得
    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
    const res = await calendar.calendarList.list();
    console.log('認証成功！カレンダー一覧:');
    res.data.items.forEach(cal => console.log(`  - ${cal.summary}`));
    return;
  }

  // 認証URLを生成
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('以下のURLをブラウザで開いて認証してください:');
  console.log(authUrl);

  // コールバックサーバー起動
  const server = http.createServer(async (req, res) => {
    const query = url.parse(req.url, true).query;

    if (query.code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>認証成功！このタブを閉じてください。</h1>');

      // トークン取得
      const { tokens } = await oAuth2Client.getToken(query.code);
      oAuth2Client.setCredentials(tokens);

      // トークン保存
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
      console.log('\nトークンを保存しました:', TOKEN_PATH);

      server.close();
      process.exit(0);
    }
  });

  server.listen(3001, () => {
    console.log('\n認証待機中... (ポート3001)');
  });
}

authorize().catch(console.error);
