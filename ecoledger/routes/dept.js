const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const CODE_DAYS = 30;

router.use((req, res, next) => {
  const want = process.env.DEPT_KEY;
  if (!want) return res.status(503).json({ error: 'Department key not configured' });
  if (!crypto.timingSafeEqual(sha(req.get('x-dept-key') || ''), sha(want)))
    return res.status(401).json({ error: 'Wrong department key' });
  next();
});

// No user ids, names or phones: the desk only sees what it needs to apply a discount.
const view = (r) => {
  const expires_at = new Date(new Date(r.created_at).getTime() + CODE_DAYS * 86400000).toISOString();
  const expired = r.status === 'pending' && Date.now() > new Date(expires_at).getTime();
  return { code: r.code, department: r.department, points: r.points, rupee_value: r.rupee_value, status: expired ? 'expired' : r.status, created_at: r.created_at, expires_at };
};
const COLS = 'code, department, points, rupee_value, status, created_at';
const normCode = (c) => (typeof c === 'string' ? c.trim().toUpperCase() : '');
const validCode = (c) => /^(TR|WA|EL)-\d{5}$/.test(c);

router.get('/codes', (req, res) => {
  const dept = ['transit', 'water', 'electricity'].includes(req.query.department) ? req.query.department : null;
  const rows = dept
    ? db.prepare(`SELECT ${COLS} FROM redemptions WHERE department=? ORDER BY id DESC LIMIT 200`).all(dept)
    : db.prepare(`SELECT ${COLS} FROM redemptions ORDER BY id DESC LIMIT 200`).all();
  res.json(rows.map(view));
});

router.get('/codes/:code', (req, res) => {
  const code = normCode(req.params.code);
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid code format' });
  const r = db.prepare(`SELECT ${COLS} FROM redemptions WHERE code=?`).get(code);
  if (!r) return res.status(404).json({ error: 'Code not found' });
  res.json(view(r));
});

router.post('/apply', (req, res) => {
  const code = normCode((req.body || {}).code);
  if (!validCode(code)) return res.status(400).json({ error: 'Invalid code format' });
  const out = db.transaction(() => {
    const r = db.prepare(`SELECT ${COLS} FROM redemptions WHERE code=?`).get(code);
    if (!r) return { status: 404, error: 'Code not found' };
    if (r.status === 'applied') return { status: 409, error: 'Code already applied' };
    if (view(r).status === 'expired') return { status: 410, error: 'Code expired' };
    const u = db.prepare(`UPDATE redemptions SET status='applied' WHERE code=? AND status='pending'`).run(code);
    return u.changes ? { ok: true, code: view({ ...r, status: 'applied' }) } : { status: 409, error: 'Code already applied' };
  })();
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
});

module.exports = { router };
