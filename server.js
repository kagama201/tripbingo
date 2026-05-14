require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const fetch     = require('node-fetch');
const CryptoJS  = require('crypto-js');
const path      = require('path');
const Database  = require('better-sqlite3');
const fs        = require('fs');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.ENCRYPTION_SECRET || 'bingo_default_secret_change_me!!';

// ─── DB 초기화 ───────────────────────────────────────────
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);
const db = new Database(path.join(DB_DIR, 'bingo.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    userid     TEXT    UNIQUE NOT NULL,
    name       TEXT    NOT NULL,
    birth      TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS trips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    userid     TEXT    NOT NULL,
    city       TEXT,
    days       INTEGER,
    type       TEXT,
    mode       TEXT,
    missions   TEXT,
    checks     TEXT    DEFAULT '[]',
    created_at TEXT    DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (userid) REFERENCES users(userid)
  );
`);

// 기존 DB에 checks 컬럼 없으면 추가 (마이그레이션)
try {
  db.exec(`ALTER TABLE trips ADD COLUMN checks TEXT DEFAULT '[]'`);
  console.log('trips.checks column added (migration)');
} catch {}

// ─── 미들웨어 ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 암호화 유틸 ──────────────────────────────────────────
function encrypt(text) {
  return CryptoJS.AES.encrypt(text, SECRET).toString();
}
function decrypt(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
}
function makeUserId(name, birth) {
  return CryptoJS.MD5(name.trim().toLowerCase() + birth.replace(/-/g, '')).toString().slice(0, 16);
}

// ─── 유저 API ─────────────────────────────────────────────

// [POST] /api/auth/register
app.post('/api/auth/register', (req, res) => {
  const { name, birth } = req.body;
  if (!name || !birth) return res.status(400).json({ error: '이름과 생년월일을 입력해주세요.' });

  const userid = makeUserId(name, birth);
  if (db.prepare('SELECT userid FROM users WHERE userid=?').get(userid))
    return res.status(409).json({ error: '이미 등록된 사용자입니다. 로그인해주세요.' });

  db.prepare('INSERT INTO users (userid,name,birth) VALUES (?,?,?)').run(userid, name.trim(), birth);
  const user = db.prepare('SELECT * FROM users WHERE userid=?').get(userid);
  res.json({ user: { userid: user.userid, name: user.name, birth: user.birth, created_at: user.created_at } });
});

// [POST] /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { name, birth } = req.body;
  if (!name || !birth) return res.status(400).json({ error: '이름과 생년월일을 입력해주세요.' });

  const userid = makeUserId(name, birth);
  const user = db.prepare('SELECT * FROM users WHERE userid=?').get(userid);
  if (!user) return res.status(404).json({ error: '등록된 사용자가 없습니다. 새로 가입해주세요.' });

  res.json({ user: { userid: user.userid, name: user.name, birth: user.birth, created_at: user.created_at } });
});

// ─── 여행 기록 API ────────────────────────────────────────

// [POST] /api/trips — 저장
app.post('/api/trips', (req, res) => {
  const { userid, city, days, type, mode, missions, checks } = req.body;
  if (!userid) return res.status(400).json({ error: 'userid required' });

  const result = db.prepare(
    'INSERT INTO trips (userid,city,days,type,mode,missions,checks) VALUES (?,?,?,?,?,?,?)'
  ).run(userid, city, days, type, mode, JSON.stringify(missions), JSON.stringify(checks || []));

  res.json({ id: result.lastInsertRowid });
});

// [GET] /api/trips/:userid — 목록 조회 (missions + checks 함께 반환)
app.get('/api/trips/:userid', (req, res) => {
  const trips = db.prepare(
    'SELECT * FROM trips WHERE userid=? ORDER BY created_at DESC LIMIT 50'
  ).all(req.params.userid);

  res.json({
    trips: trips.map(t => ({
      ...t,
      missions: JSON.parse(t.missions || '[]'),
      checks:   JSON.parse(t.checks   || '[]'),
    }))
  });
});

// [PATCH] /api/trips/:id/checks — 체크 상태만 업데이트 (핵심)
// body: { checks: [...] }
// Daily:  checks = [ [false,true,...], [true,...], ... ]  (페이지별 배열의 배열)
// Whole:  checks = [ false, true, ... ]                   (단일 배열)
app.patch('/api/trips/:id/checks', (req, res) => {
  const { checks } = req.body;
  if (checks === undefined) return res.status(400).json({ error: 'checks required' });

  db.prepare('UPDATE trips SET checks=? WHERE id=?')
    .run(JSON.stringify(checks), req.params.id);

  res.json({ ok: true });
});

// [PATCH] /api/trips/:id/missions — 미션 텍스트 업데이트
// Daily:  missions = [ ["미션1",...], ["미션1",...], ... ]  (페이지별)
// Whole:  missions = [ "미션1", "미션2", ... ]
app.patch('/api/trips/:id/missions', (req, res) => {
  const { missions } = req.body;
  if (missions === undefined) return res.status(400).json({ error: 'missions required' });
  db.prepare('UPDATE trips SET missions=? WHERE id=?')
    .run(JSON.stringify(missions), req.params.id);
  res.json({ ok: true });
});

// [DELETE] /api/trips/:id — 삭제
app.delete('/api/trips/:id', (req, res) => {
  db.prepare('DELETE FROM trips WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── 암호화 API ───────────────────────────────────────────
app.post('/api/encrypt', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try { res.json({ cipher: encrypt(text) }); }
  catch { res.status(500).json({ error: 'Encryption failed' }); }
});

// ─── LLM 프록시 API ───────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { provider, encryptedKey, model, prompt } = req.body;
  if (!encryptedKey) return res.status(400).json({ error: 'API key not provided' });

  let apiKey;
  try {
    apiKey = decrypt(encryptedKey);
    if (!apiKey) throw new Error('Decryption empty');
  } catch { return res.status(400).json({ error: 'Invalid encrypted key' }); }

  try {
    let result;
    if (provider === 'claude') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Claude error');
      result = d.content?.[0]?.text || '[]';
    } else if (provider === 'gpt') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'GPT error');
      result = d.choices?.[0]?.message?.content || '[]';
    } else if (provider === 'google') {
      const modelName = model || 'gemini-2.0-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error?.message || 'Gemini error');
      result = d.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    } else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    const clean = result.replace(/```json|```/g, '').trim();
    let missions;
    try { missions = JSON.parse(clean); }
    catch { missions = clean.split('\n').filter(l => l.trim()).map(l => l.replace(/^[-•\d.]\s*/, '').trim()); }

    res.json({ missions });
  } catch (err) {
    console.error('[/api/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Keep-alive ping ──────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 서버 시작 ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Bingo Happy Trip running on port ${PORT}`);
  const SELF = process.env.RENDER_EXTERNAL_URL;
  if (SELF) {
    setInterval(async () => {
      try { await fetch(`${SELF}/api/ping`); } catch {}
    }, 10 * 60 * 1000);
  }
});
