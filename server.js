/**
 * server.js
 * Bingo for Happy Trip — Render 배포용 Express 서버
 *
 * 역할
 *  1. public/ 정적 파일 서빙 (index.html 포함)
 *  2. /api/generate  — LLM API 프록시 (API Key를 클라이언트에 노출하지 않음)
 *  3. /api/ping      — UptimeRobot keep-alive 엔드포인트
 *  4. /api/encrypt, /api/decrypt — AES-256 키 암호화 유틸 (서버-사이드)
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const CryptoJS = require('crypto-js');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.ENCRYPTION_SECRET || 'bingo_default_secret_change_me!!';

// ─────────────────────────────────────────
// 미들웨어
// ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────
// 암호화 유틸
// ─────────────────────────────────────────
function encrypt(plainText) {
  return CryptoJS.AES.encrypt(plainText, SECRET).toString();
}

function decrypt(cipherText) {
  const bytes = CryptoJS.AES.decrypt(cipherText, SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ─────────────────────────────────────────
// [POST] /api/encrypt
// Body: { text: "raw_api_key" }
// Res:  { cipher: "encrypted_string" }
// ─────────────────────────────────────────
app.post('/api/encrypt', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    res.json({ cipher: encrypt(text) });
  } catch (e) {
    res.status(500).json({ error: 'Encryption failed' });
  }
});

// ─────────────────────────────────────────
// [POST] /api/generate
// Body: { provider, encryptedKey, model, prompt }
// 서버에서 복호화 후 LLM 호출 → 결과 반환
// ─────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { provider, encryptedKey, model, prompt } = req.body;

  if (!encryptedKey) {
    return res.status(400).json({ error: 'API key not provided' });
  }

  let apiKey;
  try {
    apiKey = decrypt(encryptedKey);
    if (!apiKey) throw new Error('Decryption returned empty string');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid encrypted key' });
  }

  try {
    let result;

    // ── Claude (Anthropic) ──
    if (provider === 'claude') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model || 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Claude API error');
      result = data.content?.[0]?.text || '[]';
    }

    // ── OpenAI (GPT) ──
    else if (provider === 'gpt') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');
      result = data.choices?.[0]?.message?.content || '[]';
    }

    // ── Google (Gemini) ──
    else if (provider === 'google') {
      const modelName = model || 'gemini-2.0-flash';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Gemini API error');
      result = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    }

    else {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    // JSON 파싱 시도
    const clean = result.replace(/```json|```/g, '').trim();
    let missions;
    try {
      missions = JSON.parse(clean);
    } catch {
      // JSON 파싱 실패 시 줄 단위로 분리
      missions = clean.split('\n').filter(l => l.trim()).map(l => l.replace(/^[-•\d.]\s*/, '').trim());
    }

    res.json({ missions });

  } catch (err) {
    console.error('[/api/generate] error:', err.message);
    res.status(500).json({ error: err.message || 'LLM API call failed' });
  }
});

// ─────────────────────────────────────────
// [GET] /api/ping  — UptimeRobot keep-alive
// Render 무료 플랜은 15분 비활성 시 슬립
// UptimeRobot이 5분마다 이 엔드포인트를 호출
// ─────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'bingo-happy-trip',
  });
});

// ─────────────────────────────────────────
// SPA fallback — 모든 경로를 index.html로
// ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────
// 서버 시작
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Bingo Happy Trip server running on port ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
});
