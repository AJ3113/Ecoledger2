const express = require('express');
const bcrypt = require('bcryptjs');
const { db, issuePoints, signTicket } = require('../db');
const chain = require('../chain');

const router = express.Router();
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// light login rate limit: 10 failures / 10 min per ip+identifier
const fails = new Map();
const keyOf = (req, id) => `${req.ip}|${String(id).toLowerCase()}`;
function limited(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.t > 600000) { fails.delete(key); return false; }
  return f.n >= 10;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.t > 600000) fails.set(key, { n: 1, t: Date.now() });
  else f.n++;
}

const requireRole = (role) => (req, res, next) => {
  if (req.session && req.session.role === role) return next();
  res.status(401).json({ error: 'Not signed in' });
};

function startSession(req, user) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.save((e) => (e ? reject(e) : resolve()));
    }));
}

router.post('/login', async (req, res) => {
  const { role, id, password } = req.body || {};
  if (!['citizen', 'collector', 'admin'].includes(role) || typeof id !== 'string' || typeof password !== 'string')
    return res.status(400).json({ error: 'Missing fields' });
  const key = keyOf(req, id);
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Try later.' });
  const user = role === 'citizen'
    ? db.prepare(`SELECT * FROM users WHERE role='citizen' AND phone=?`).get(id.trim())
    : db.prepare(`SELECT * FROM users WHERE role=? AND login_id=?`).get(role, id.trim());
  const ok = await bcrypt.compare(password, user ? user.pw_hash : DUMMY_HASH);
  if (!user || !ok) { noteFail(key); return res.status(401).json({ error: 'Wrong ID or password' }); }
  fails.delete(key);
  await startSession(req, user);
  res.json({ ok: true, role: user.role });
});

router.post('/register', async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
  const houseId = typeof b.house_id === 'string' ? b.house_id.trim().toUpperCase() : '';
  const code = typeof b.claim_code === 'string' ? b.claim_code.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'Enter your name' });
  if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Phone must be 10-15 digits' });
  if (typeof b.password !== 'string' || b.password.length < 6) return res.status(400).json({ error: 'Password needs 6+ characters' });
  const key = keyOf(req, 'register');
  if (limited(key)) return res.status(429).json({ error: 'Too many attempts. Try later.' });

  const house = db.prepare('SELECT * FROM households WHERE house_id=?').get(houseId);
  if (!house || house.claim_code !== code) { noteFail(key); return res.status(400).json({ error: 'Invalid house ID or claim code' }); }
  if (house.claimed_by) return res.status(409).json({ error: 'This house is already claimed' });
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) return res.status(409).json({ error: 'Phone already registered' });

  const wallet = await chain.createWallet();
  const pwHash = bcrypt.hashSync(b.password, 10);
  let user;
  try {
    user = db.transaction(() => {
      const uid = db.prepare(
        `INSERT INTO users(role,name,phone,pw_hash,house_id,ward,wallet_address,created_at)
         VALUES('citizen',?,?,?,?,?,?,?)`
      ).run(name, phone, pwHash, houseId, house.ward, wallet, new Date().toISOString()).lastInsertRowid;
      const claim = db.prepare('UPDATE households SET claimed_by=? WHERE house_id=? AND claimed_by IS NULL').run(uid, houseId);
      if (!claim.changes) throw new Error('claimed');
      return { id: uid, role: 'citizen' };
    })();
  } catch (e) {
    return res.status(409).json({ error: e.message === 'claimed' ? 'This house is already claimed' : 'Registration failed' });
  }

  const visits = db.prepare(`SELECT id, points_awarded FROM waste_visits WHERE house_id=? AND status='completed' AND credited=0`).all(houseId);
  for (const v of visits) {
    if (v.points_awarded > 0) await issuePoints(user.id, v.points_awarded, 'waste', `visit-${v.id}`);
    db.prepare('UPDATE waste_visits SET credited=1 WHERE id=?').run(v.id);
  }
  await startSession(req, user);
  res.json({ ok: true, role: 'citizen' });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ role: null });
  const u = db.prepare('SELECT name, role FROM users WHERE id=?').get(req.session.userId);
  res.json(u ? { role: u.role, name: u.name } : { role: null });
});

// demo-only data for the public /demo page
router.get('/demo', (req, res) => {
  const houses = db.prepare(
    `SELECT house_id, ward, claim_code FROM households WHERE claimed_by IS NULL ORDER BY house_id`).all();
  const tickets = db.prepare(`SELECT ticket_id, bus_number, distance_km, fare FROM tickets WHERE status='unclaimed' ORDER BY issued_at DESC LIMIT 3`)
    .all().map((t) => ({ ...t, payload: `${t.ticket_id}.${signTicket(t.ticket_id)}` }));
  res.json({ houses, tickets });
});

module.exports = { router, requireRole };
