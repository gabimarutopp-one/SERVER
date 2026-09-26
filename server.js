require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const assistantHits = new Map(); // userId -> [timestamps] simple in-memory rate limit
const ASSISTANT_LIMIT = 20; // messages
const ASSISTANT_WINDOW_MS = 60 * 60 * 1000; // per hour

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('XATO: JWT_SECRET muhit o\'zgaruvchisi berilmagan. .env faylida yoki hosting sozlamalarida belgilang.');
  process.exit(1);
}
const COOKIE_NAME = 'kt_session';
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_data (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json_data TEXT NOT NULL
  );
`);

const DEFAULT_STATE = JSON.stringify({
  tasks: [], schedule: {}, notes: '', habits: [], countdown: null, longtasks: [], budget: []
});

// ---------- Helpers ----------
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;

function signToken(userId, username) {
  return jwt.sign({ uid: userId, u: username }, JWT_SECRET, { expiresIn: '30d' });
}

function authRequired(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    req.username = payload.u;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_session' });
  }
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  maxAge: 30 * 24 * 60 * 60 * 1000
};

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const uname = username.trim();
  if (!USERNAME_RE.test(uname)) {
    return res.status(400).json({ error: 'invalid_username', message: 'Login 3-24 belgi, faqat harf/raqam/._' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Parol kamida 8 belgidan iborat bo\'lsin' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(uname);
  if (existing) {
    return res.status(409).json({ error: 'username_taken', message: 'Bu login band' });
  }
  const hash = await bcrypt.hash(password, 12);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(uname, hash);
  db.prepare('INSERT INTO user_data (user_id, json_data) VALUES (?, ?)').run(info.lastInsertRowid, DEFAULT_STATE);
  const token = signToken(info.lastInsertRowid, uname);
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ username: uname });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(401).json({ error: 'invalid_credentials', message: 'Login yoki parol xato' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials', message: 'Login yoki parol xato' });
  const token = signToken(user.id, user.username);
  res.cookie(COOKIE_NAME, token, cookieOpts);
  res.json({ username: user.username });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOpts);
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ username: req.username });
});

app.get('/api/data', authRequired, (req, res) => {
  const row = db.prepare('SELECT json_data FROM user_data WHERE user_id = ?').get(req.userId);
  res.json(JSON.parse(row ? row.json_data : DEFAULT_STATE));
});

app.put('/api/data', authRequired, (req, res) => {
  const body = req.body;
  if (typeof body !== 'object' || body === null) return res.status(400).json({ error: 'invalid_input' });
  db.prepare(`
    INSERT INTO user_data (user_id, json_data) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json_data = excluded.json_data
  `).run(req.userId, JSON.stringify(body));
  res.json({ ok: true });
});

app.post('/api/assistant', authRequired, async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ error: 'not_configured', message: 'ANTHROPIC_API_KEY sozlanmagan. .env fayliga qo\'shing.' });
  }
  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'too_long', message: 'Xabar juda uzun' });
  }

  // Simple per-user rate limit so a shared API key can't be run up unbounded.
  const now = Date.now();
  const hits = (assistantHits.get(req.userId) || []).filter(t => now - t < ASSISTANT_WINDOW_MS);
  if (hits.length >= ASSISTANT_LIMIT) {
    return res.status(429).json({ error: 'rate_limited', message: 'Soatlik limitga yetdingiz, birozdan keyin urinib ko\'ring.' });
  }
  hits.push(now);
  assistantHits.set(req.userId, hits);

  const row = db.prepare('SELECT json_data FROM user_data WHERE user_id = ?').get(req.userId);
  const state = JSON.parse(row ? row.json_data : DEFAULT_STATE);
  const dayNames = ["Dushanba","Seshanba","Chorshanba","Payshanba","Juma","Shanba","Yakshanba"];
  const todayIdx = (new Date().getDay() + 6) % 7;
  const todaysLessons = (state.schedule[todayIdx] || []).map(l => `${l.time || '?'} ${l.name || ''}`).join('; ') || 'yo\'q';
  const openTasks = state.tasks.filter(t => !t.done).map(t => t.text).join('; ') || 'yo\'q';
  const upcoming = (state.longtasks || []).slice(0, 5).map(t => `${t.text}${t.date ? ' (' + t.date + ')' : ''}`).join('; ') || 'yo\'q';
  const balance = (state.budget || []).reduce((s, b) => s + (b.type === 'in' ? b.amount : -b.amount), 0);

  const systemPrompt = `Sen "Kun tartibi" ilovasidagi talaba uchun AI yordamchisan. O'zbek tilida, qisqa, do'stona va amaliy javob ber. Talabaga bugungi kunni rejalashtirish, o'qishni tashkil qilish yoki byudjetini boshqarishda yordam ber. Agar tegishli bo'lsa, quyidagi joriy ma'lumotlardan foydalan, aks holda umumiy maslahat ber:
- Bugun (${dayNames[todayIdx]}) darslar: ${todaysLessons}
- Bajarilmagan vazifalar: ${openTasks}
- Yaqin muddatli ishlar: ${upcoming}
- Joriy byudjet balansi: ${balance.toLocaleString()} so'm

Javoblaringni qisqa (odatda 2-5 gap) va amaliy qil. Moliyaviy yoki tibbiy jiddiy qarorlarda ehtiyotkorlik bilan maslahat ber, lekin oddiy talaba savollariga to'g'ridan-to'g'ri javob ber.`;

  const historyMsgs = Array.isArray(history)
    ? history.slice(-10).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))
    : [];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 500,
      system: systemPrompt,
      messages: [...historyMsgs, { role: 'user', content: message.trim() }]
    });
    const reply = response.content.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim();
    res.json({ reply });
  } catch (err) {
    console.error('Assistant error:', err.message);
    res.status(502).json({ error: 'assistant_failed', message: 'Yordamchidan javob olib bo\'lmadi. Birozdan keyin qayta urinib ko\'ring.' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Kun Tartibi server http://localhost:${PORT} portida ishga tushdi`);
});
