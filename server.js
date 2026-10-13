// SmartPark backend: Express + SQLite + secure cookie sessions.
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || 'development';
const DB_PATH = path.resolve(process.env.DB_PATH || './data/smartpark.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters.');
  process.env.SESSION_SECRET = 'development-only-secret-change-this-before-deployment-2026';
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'driver' CHECK(role IN ('driver','admin')),
  wallet_balance INTEGER NOT NULL DEFAULT 0 CHECK(wallet_balance >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS slots (
  id TEXT PRIMARY KEY,
  zone TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'regular',
  base_rate INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'free' CHECK(status IN ('free','occupied','reserved')),
  UNIQUE(zone, number)
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot_id TEXT NOT NULL REFERENCES slots(id),
  driver_name TEXT NOT NULL,
  vehicle_no TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  hours INTEGER NOT NULL CHECK(hours > 0),
  amount INTEGER NOT NULL CHECK(amount >= 0),
  payment_method TEXT NOT NULL DEFAULT 'UPI',
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(status IN ('CONFIRMED','CANCELLED','COMPLETED','EXPIRED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id, created_at);
CREATE INDEX IF NOT EXISTS bookings_slot_time_idx ON bookings(slot_id, start_time, end_time);
`);
const slotCount = db.prepare('SELECT COUNT(*) AS n FROM slots').get().n;
if (slotCount === 0) {
  const insert = db.prepare('INSERT INTO slots (id, zone, number, type, base_rate, status) VALUES (?, ?, ?, ?, ?, ?)');
  const seed = db.transaction(() => {
    for (const zone of ['A','B','C','D']) {
      for (let n = 1; n <= 12; n++) {
        const type = n % 4 === 0 ? 'handicap' : (n % 5 === 0 ? 'ev' : 'regular');
        const base = type === 'ev' ? 30 : (type === 'handicap' ? 15 : 20);
        const status = [4,7,10,12].includes(n) ? (n === 10 ? 'reserved' : 'occupied') : 'free';
        insert.run(`${zone}${String(n).padStart(2,'0')}`, zone, n, type, base, status);
      }
    }
  });
  seed();
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'smartpark.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(DB_PATH) }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// Browser requests that change data must originate from this same application.
app.use('/api', (req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Request origin rejected.' });
      } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
  }
  next();
});
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please wait and try again.' } });

function safeUser(row) {
  return { id: String(row.id), name: row.name, email: row.email, role: row.role, walletBalance: row.wallet_balance, avatar: row.role === 'admin' ? '🛡️' : '👤', plate: '' };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please log in to continue.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.status(401).json({ error: 'Session expired. Please log in again.' }); }
  req.user = user;
  next();
}
function validateText(value, max = 100) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!validateText(name, 80) || !validateText(email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Enter your name, a valid email, and a password between 8 and 72 characters.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name.trim(), email.trim().toLowerCase(), hash);
    req.session.userId = Number(result.lastInsertRowid);
    res.status(201).json({ user: safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid)) });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create your account.' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!validateText(email, 254) || typeof password !== 'string' || password.length > 72) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  const valid = row ? await bcrypt.compare(password, row.password_hash) : false;
  if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start a secure session.' });
    req.session.userId = row.id;
    req.session.save(saveErr => {
      if (saveErr) return res.status(500).json({ error: 'Could not save your session.' });
      res.json({ user: safeUser(row) });
    });
  });
});
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.json({ user: null });
  res.json({ user: safeUser(row) });
});
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Could not log out. Please try again.' });
    res.clearCookie('smartpark.sid', { httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production' });
    res.json({ success: true });
  });
});

app.get('/api/slots', (req, res) => {
  res.json({ slots: db.prepare('SELECT id, zone, number, type, base_rate AS baseRate, status FROM slots ORDER BY zone, number').all() });
});
app.get('/api/bookings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, user_id AS userId, slot_id AS slotId, driver_name AS driverName, vehicle_no AS vehicleNo, phone, start_time AS entryTime, end_time AS endTime, hours, amount, payment_method AS paymentMethod, payment_status AS paymentStatus, status AS bookingStatus, created_at AS createdAt FROM bookings WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ bookings: rows });
});
app.post('/api/bookings', requireAuth, (req, res) => {
  const { slotId, driverName, vehicleNo, phone = '', entryTime, hours = 1, paymentMethod = 'UPI' } = req.body || {};
  const validDate = typeof entryTime === 'string' && !Number.isNaN(Date.parse(entryTime));
  if (!validateText(slotId, 8) || !validateText(driverName, 80) || !validateText(vehicleNo, 20) ||
      !validDate || !Number.isInteger(hours) || hours < 1 || hours > 24 || !['UPI','CARD','WALLET'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Booking details are invalid.' });
  }
  const start = new Date(entryTime);
  const end = new Date(start.getTime() + hours * 3600000);
  const bookingId = 'SP' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
  try {
    const create = db.transaction(() => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slotId);
      if (!slot || slot.status !== 'free') throw new Error('SLOT_UNAVAILABLE');
      // The server calculates the price; a client cannot submit a smaller amount.
      const occupancy = db.prepare("SELECT COUNT(*) AS n FROM slots WHERE status IN ('occupied','reserved')").get().n;
      const totalSlots = db.prepare('SELECT COUNT(*) AS n FROM slots').get().n || 1;
      const ratio = occupancy / totalSlots;
      const multiplier = ratio >= 0.75 ? 1.5 : (ratio >= 0.50 ? 1.25 : 1);
      const amount = Math.round(slot.base_rate * multiplier * hours);
      const conflict = db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND status = 'CONFIRMED' AND start_time < ? AND end_time > ?`).get(slotId, end.toISOString(), start.toISOString());
      if (conflict) throw new Error('SLOT_CONFLICT');
      if (paymentMethod === 'WALLET') {
        const update = db.prepare('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ? AND wallet_balance >= ?').run(amount, req.user.id, amount);
        if (!update.changes) throw new Error('INSUFFICIENT_WALLET');
      }
      db.prepare(`INSERT INTO bookings (id,user_id,slot_id,driver_name,vehicle_no,phone,start_time,end_time,hours,amount,payment_method,payment_status,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'CONFIRMED')`).run(bookingId, req.user.id, slotId, driverName.trim(), vehicleNo.trim().toUpperCase(), String(phone).slice(0,20), start.toISOString(), end.toISOString(), hours, amount, paymentMethod, paymentMethod === 'WALLET' ? 'PAID' : 'PENDING');
      db.prepare('UPDATE slots SET status = ? WHERE id = ?').run('reserved', slotId);
    });
    create();
    res.status(201).json({ booking: db.prepare('SELECT id, user_id AS userId, slot_id AS slotId, driver_name AS driverName, vehicle_no AS vehicleNo, phone, start_time AS entryTime, end_time AS endTime, hours, amount, payment_method AS paymentMethod, payment_status AS paymentStatus, status AS bookingStatus, created_at AS createdAt FROM bookings WHERE id = ?').get(bookingId) });
  } catch (err) {
    if (['SLOT_UNAVAILABLE','SLOT_CONFLICT'].includes(err.message)) return res.status(409).json({ error: 'This slot is no longer available for the selected time.' });
    if (err.message === 'INSUFFICIENT_WALLET') return res.status(400).json({ error: 'Insufficient wallet balance.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create booking.' });
  }
});
app.post('/api/bookings/:id/cancel', requireAuth, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.status !== 'CONFIRMED') return res.status(409).json({ error: 'Only confirmed bookings can be cancelled.' });
  const cancel = db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?").run(booking.id);
    db.prepare("UPDATE slots SET status = 'free' WHERE id = ? AND status = 'reserved'").run(booking.slot_id);
  });
  cancel();
  res.json({ success: true, bookingId: booking.id });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});
app.listen(PORT, () => console.log(`SmartPark server running at http://localhost:${PORT}`));
