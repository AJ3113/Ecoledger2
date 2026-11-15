const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const chain = require('../chain');
const { db, balanceOf, getConfig, signTicket, issuePoints } = require('../db');
const { requireRole } = require('./auth');

const router = express.Router();
router.use(requireRole('citizen'));

router.get('/dashboard', (req, res) => {
  const uid = req.session.userId;
  const user = db.prepare('SELECT name, house_id, ward FROM users WHERE id=?').get(uid);
  const bySource = db.prepare('SELECT source, SUM(points) AS points FROM points_ledger WHERE user_id=? GROUP BY source').all(uid);
  const history = db.prepare(
    'SELECT id, source, points, reference_id, tx_hash, chain_status, created_at FROM points_ledger WHERE user_id=? ORDER BY id DESC LIMIT 100'
  ).all(uid).map((r) => ({ ...r, simulated: !!(r.tx_hash && r.tx_hash.startsWith('SIM')) }));
  res.json({
    user, balance: balanceOf(uid), bySource, history,
    explorer: process.env.EXPLORER_TX_URL || 'https://lora.algokit.io/testnet/transaction/',
  });
});

router.post('/claim', async (req, res) => {
  const raw = req.body && req.body.payload;
  if (typeof raw !== 'string') return res.status(400).json({ error: 'Invalid ticket' });
  const parts = raw.trim().split('.');
  const bad = () => res.status(400).json({ error: 'Invalid ticket' });
  if (parts.length !== 2) return bad();
  const [ticketId, sig] = parts;
  if (!/^T-\d{5}$/.test(ticketId) || !/^[0-9a-f]{16}$/.test(sig)) return bad();
  const good = Buffer.from(signTicket(ticketId));
  if (!crypto.timingSafeEqual(good, Buffer.from(sig))) return bad();

  const uid = req.session.userId;
  const outcome = db.transaction(() => {
    const t = db.prepare('SELECT * FROM tickets WHERE ticket_id=?').get(ticketId);
    if (!t) return { status: 404, error: 'Ticket not found' };
    if (t.status !== 'unclaimed') return { status: 409, error: 'Ticket already claimed' };
    const ageHours = (Date.now() - new Date(t.issued_at).getTime()) / 3600000;
    if (ageHours > getConfig('claim_window_hours')) return { status: 410, error: 'Ticket expired' };

    let points = 0;
    let reason = null;
    if (!t.is_ev) reason = 'Not an electric bus, so no points';
    else if (t.distance_km < getConfig('min_trip_km')) reason = 'Trip too short for points';
    else {
      points = Math.floor(Math.min(t.distance_km * getConfig('points_per_km'), getConfig('max_points_ticket')));
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const today = db.prepare(
        `SELECT COALESCE(SUM(points),0) AS p FROM points_ledger WHERE user_id=? AND source='bus' AND points>0 AND created_at>=?`
      ).get(uid, dayStart.toISOString()).p;
      const room = Math.max(0, getConfig('daily_cap_bus') - today);
      if (points > room) { points = room; if (room === 0) reason = 'Daily bus points limit reached'; }
    }
    const upd = db.prepare(
      `UPDATE tickets SET status='claimed', claimed_by=?, claimed_at=? WHERE ticket_id=? AND status='unclaimed'`
    ).run(uid, new Date().toISOString(), ticketId);
    if (!upd.changes) return { status: 409, error: 'Ticket already claimed' };
    return { points, reason };
  })();

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  if (outcome.points > 0) await issuePoints(uid, outcome.points, 'bus', ticketId);
  res.json({ ok: true, ticket_id: ticketId, points: outcome.points, reason: outcome.reason, balance: balanceOf(uid) });
});

const houseOf = (uid) => db.prepare('SELECT house_id FROM users WHERE id=?').get(uid).house_id;

router.get('/waste', (req, res) => {
  const windowMs = getConfig('contest_window_hours') * 3600000;
  const rows = db.prepare(
    `SELECT id, result, remark, points_awarded, reviewed_at, contested FROM waste_visits
     WHERE house_id=? AND status='completed' ORDER BY reviewed_at DESC`).all(houseOf(req.session.userId));
  res.json(rows.map((r) => ({
    ...r,
    can_contest: !r.contested && Date.now() - new Date(r.reviewed_at).getTime() <= windowMs,
  })));
});

router.post('/contest', (req, res) => {
  const id = Number((req.body || {}).visit_id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid visit' });
  const v = db.prepare(`SELECT * FROM waste_visits WHERE id=? AND house_id=? AND status='completed'`).get(id, houseOf(req.session.userId));
  if (!v) return res.status(404).json({ error: 'Visit not found' });
  if (v.contested) return res.status(409).json({ error: 'Already contested' });
  if (Date.now() - new Date(v.reviewed_at).getTime() > getConfig('contest_window_hours') * 3600000)
    return res.status(410).json({ error: 'Contest window has closed' });
  const upd = db.prepare('UPDATE waste_visits SET contested=1, contested_at=? WHERE id=? AND contested=0').run(new Date().toISOString(), id);
  if (!upd.changes) return res.status(409).json({ error: 'Already contested' });
  res.json({ ok: true });
});

const DEPTS = { transit: 'TR', water: 'WA', electricity: 'EL' };
const CODE_DAYS = 30;
const expiryOf = (createdAt) => new Date(new Date(createdAt).getTime() + CODE_DAYS * 86400000).toISOString();
const redeemFails = new Map();

router.post('/redeem', async (req, res) => {
  const { department, points, password } = req.body || {};
  const prefix = typeof department === 'string' && Object.hasOwn(DEPTS, department) ? DEPTS[department] : null;
  if (!prefix) return res.status(400).json({ error: 'Choose a department' });
  if (!Number.isInteger(points) || points <= 0) return res.status(400).json({ error: 'Enter a whole number of points above 0' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password' });

  const uid = req.session.userId;
  const f = redeemFails.get(uid);
  if (f && f.n >= 5 && Date.now() - f.t < 600000) return res.status(429).json({ error: 'Too many wrong passwords. Try later.' });
  const user = db.prepare('SELECT pw_hash, wallet_address FROM users WHERE id=?').get(uid);
  if (!(await bcrypt.compare(password, user.pw_hash))) {
    redeemFails.set(uid, { n: f && Date.now() - f.t < 600000 ? f.n + 1 : 1, t: f && Date.now() - f.t < 600000 ? f.t : Date.now() });
    return res.status(403).json({ error: 'Wrong password' });
  }
  redeemFails.delete(uid);

  const out = db.transaction(() => {
    if (points > balanceOf(uid)) return { status: 400, error: 'Not enough points' };
    let code = null;
    for (let i = 0; i < 50 && !code; i++) {
      const c = `${prefix}-${String(crypto.randomInt(0, 100000)).padStart(5, '0')}`;
      if (!db.prepare('SELECT 1 FROM redemptions WHERE code=?').get(c)) code = c;
    }
    if (!code) return { status: 500, error: 'Could not create code, retry' };
    const now = new Date().toISOString();
    const eventHash = crypto.createHash('sha256').update(`redeem|${code}|${now}`).digest('hex');
    const ledgerId = db.prepare(
      `INSERT INTO points_ledger(user_id,source,points,reference_id,event_hash,chain_status,created_at) VALUES(?,'redeem',?,?,?,'pending',?)`
    ).run(uid, -points, code, eventHash, now).lastInsertRowid;
    const rupee = points / getConfig('points_per_rupee');
    db.prepare(`INSERT INTO redemptions(user_id,department,points,rupee_value,code,status,created_at) VALUES(?,?,?,?,?,'pending',?)`)
      .run(uid, department, points, rupee, code, now);
    return { code, ledgerId, rupee, now };
  })();
  if (out.error) return res.status(out.status).json({ error: out.error });

  try {
    const tx = await chain.redeem(user.wallet_address, points, department, out.code);
    db.prepare(`UPDATE points_ledger SET tx_hash=?, chain_status='confirmed' WHERE id=?`).run(tx, out.ledgerId);
    db.prepare('UPDATE redemptions SET tx_hash=? WHERE code=?').run(tx, out.code);
  } catch (e) {
    console.error('chain redeem failed for ledger row', out.ledgerId, '-', e.message);
  }
  res.json({
    code: out.code, department, points, rupee_value: out.rupee, expires_at: expiryOf(out.now),
    qr: await QRCode.toDataURL(out.code, { margin: 1, width: 240 }), balance: balanceOf(uid),
  });
});

router.get('/redemptions', async (req, res) => {
  const uid = req.session.userId;
  const rows = db.prepare(
    'SELECT id, department, points, rupee_value, code, status, tx_hash, created_at FROM redemptions WHERE user_id=? ORDER BY id DESC LIMIT 50'
  ).all(uid);
  const list = await Promise.all(rows.map(async (r) => {
    const expires_at = expiryOf(r.created_at);
    const expired = r.status === 'pending' && Date.now() > new Date(expires_at).getTime();
    return { ...r, expires_at, expired, qr: r.status === 'pending' && !expired ? await QRCode.toDataURL(r.code, { margin: 1, width: 160 }) : null };
  }));
  res.json({ balance: balanceOf(uid), points_per_rupee: getConfig('points_per_rupee'), redemptions: list,
    explorer: process.env.EXPLORER_TX_URL || 'https://lora.algokit.io/testnet/transaction/' });
});

router.get('/solar', (req, res) => {
  res.json(db.prepare('SELECT installation_id, points, status, created_at FROM solar_claims WHERE user_id=? ORDER BY id DESC')
    .all(req.session.userId));
});

router.post('/solar', (req, res) => {
  const id = typeof (req.body || {}).installation_id === 'string' ? req.body.installation_id.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(id)) return res.status(400).json({ error: 'Installation ID: 3-40 letters, digits, dot, dash' });
  const uid = req.session.userId;
  const out = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM solar_claims WHERE user_id=?').get(uid)) return { status: 409, error: 'You already submitted a solar installation' };
    const r = db.prepare(`INSERT OR IGNORE INTO solar_claims(user_id,installation_id,points,status,created_at) VALUES(?,?,0,'pending',?)`)
      .run(uid, id, new Date().toISOString());
    return r.changes ? { ok: true } : { status: 409, error: 'This installation ID was already submitted' };
  })();
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true, status: 'pending' });
});

module.exports = { router };
