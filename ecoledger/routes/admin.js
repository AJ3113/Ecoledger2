const express = require('express');
const QRCode = require('qrcode');
const chain = require('../chain');
const { db, getConfig, issuePoints, anchorDay, DEFAULT_CONFIG } = require('../db');
const { requireRole } = require('./auth');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().n;
  const byWard = {};
  for (const r of db.prepare(
    `SELECT h.ward, v.result, COUNT(*) AS n FROM waste_visits v JOIN households h ON h.house_id=v.house_id
     WHERE v.status='completed' GROUP BY h.ward, v.result`).all()) {
    byWard[r.ward] = byWard[r.ward] || { ward: r.ward, good: 0, partial: 0, poor: 0 };
    byWard[r.ward][r.result] = r.n;
  }
  res.json({
    points_issued: one('SELECT COALESCE(SUM(points),0) AS n FROM points_ledger WHERE points>0'),
    points_redeemed: -one(`SELECT COALESCE(SUM(points),0) AS n FROM points_ledger WHERE source='redeem'`),
    tickets_claimed: one(`SELECT COUNT(*) AS n FROM tickets WHERE status='claimed'`),
    pending_chain: one(`SELECT COUNT(*) AS n FROM points_ledger WHERE chain_status='pending'`),
    waste_by_ward: Object.values(byWard).sort((a, b) => a.ward.localeCompare(b.ward)),
    anchors: db.prepare('SELECT date, digest, tx_hash FROM anchors ORDER BY date DESC LIMIT 5').all(),
    explorer: process.env.EXPLORER_TX_URL || 'https://lora.algokit.io/testnet/transaction/',
  });
});

router.get('/alerts', (req, res) => {
  const now = Date.now();
  const unreviewed = db.prepare(
    `SELECT v.id AS visit_id, v.house_id, v.visited_at, u.login_id AS collector FROM waste_visits v
     JOIN users u ON u.id=v.collector_id WHERE v.status='visited' ORDER BY v.visited_at`).all()
    .map((r) => ({ ...r, hours_ago: Math.round((now - new Date(r.visited_at).getTime()) / 360000) / 10 }));
  const contested = db.prepare(
    `SELECT v.id AS visit_id, v.house_id, v.result, v.points_awarded, v.remark, v.contested_at, u.login_id AS collector
     FROM waste_visits v JOIN users u ON u.id=v.collector_id WHERE v.contested=1 ORDER BY v.contested_at DESC`).all();
  const skewed = db.prepare(
    `SELECT u.login_id AS collector, COUNT(*) AS visits, SUM(v.result='good') AS good FROM waste_visits v
     JOIN users u ON u.id=v.collector_id WHERE v.status='completed' GROUP BY v.collector_id
     HAVING COUNT(*) >= 10 AND SUM(v.result='good') * 1.0 / COUNT(*) > 0.9`).all()
    .map((r) => ({ ...r, good_pct: Math.round((r.good / r.visits) * 100) }));
  res.json({ unreviewed, contested, skewed });
});

router.get('/solar', (req, res) => {
  res.json(db.prepare(
    `SELECT s.id, s.installation_id, s.points, s.status, s.created_at, u.name, u.house_id FROM solar_claims s
     JOIN users u ON u.id=s.user_id ORDER BY (s.status='pending') DESC, s.id DESC LIMIT 100`).all());
});

router.post('/solar/approve', async (req, res) => {
  const id = Number((req.body || {}).id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid claim' });
  const points = getConfig('solar_points');
  const out = db.transaction(() => {
    const c = db.prepare('SELECT * FROM solar_claims WHERE id=?').get(id);
    if (!c) return { status: 404, error: 'Claim not found' };
    const u = db.prepare(`UPDATE solar_claims SET status='approved', points=? WHERE id=? AND status='pending'`).run(points, id);
    if (!u.changes) return { status: 409, error: 'Already approved' };
    return { userId: c.user_id, ref: c.installation_id };
  })();
  if (out.error) return res.status(out.status).json({ error: out.error });
  if (points > 0) await issuePoints(out.userId, points, 'solar', out.ref);
  res.json({ ok: true, points });
});

router.get('/config', (req, res) => {
  const cfg = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) cfg[k] = getConfig(k);
  res.json(cfg);
});

router.post('/config', (req, res) => {
  const values = (req.body || {}).values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ error: 'Missing values' });
  const clean = {};
  for (const [k, raw] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, k)) return res.status(400).json({ error: `Unknown setting: ${k}` });
    const v = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v < 0 || v > 1000000) return res.status(400).json({ error: `${k} must be a number from 0 to 1000000` });
    if (k === 'points_per_rupee' && v <= 0) return res.status(400).json({ error: 'points_per_rupee must be above 0' });
    if (k === 'society_bonus_threshold_pct' && v > 100) return res.status(400).json({ error: 'Threshold must be 0-100' });
    clean[k] = v;
  }
  const up = db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(clean)) up.run(k, String(v)); })();
  res.json({ ok: true });
});

router.post('/bonus', async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const threshold = getConfig('society_bonus_threshold_pct');
  const bonus = getConfig('society_bonus');
  const report = [];
  for (const s of db.prepare('SELECT id, name FROM societies ORDER BY id').all()) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM households WHERE society_id=?').get(s.id).n;
    const good = db.prepare(
      `SELECT COUNT(DISTINCT v.house_id) AS n FROM waste_visits v JOIN households h ON h.house_id=v.house_id
       WHERE h.society_id=? AND v.status='completed' AND v.result='good' AND v.reviewed_at>=?`).get(s.id, monthStart).n;
    const pct = total ? Math.round((good / total) * 100) : 0;
    const row = { society: s.name, good_houses: good, houses: total, pct, qualified: total > 0 && (good * 100) / total >= threshold, credited: 0, already: 0 };
    if (row.qualified && bonus > 0) {
      const ref = `society-${s.id}-${month}`;
      const owners = db.prepare('SELECT claimed_by AS uid FROM households WHERE society_id=? AND claimed_by IS NOT NULL').all(s.id);
      for (const { uid } of owners) {
        if (db.prepare(`SELECT 1 FROM points_ledger WHERE user_id=? AND source='bonus' AND reference_id=?`).get(uid, ref)) { row.already++; continue; }
        await issuePoints(uid, bonus, 'bonus', ref);
        row.credited++;
      }
    }
    report.push(row);
  }
  res.json({ month, threshold, bonus, report });
});

let retrying = false;
router.post('/retry-pending', async (req, res) => {
  if (retrying) return res.status(409).json({ error: 'A retry is already running' });
  retrying = true;
  try {
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const rows = db.prepare(
      `SELECT l.id, l.source, l.points, l.reference_id, l.event_hash, u.wallet_address FROM points_ledger l
       JOIN users u ON u.id=l.user_id WHERE l.chain_status='pending' AND l.created_at<? ORDER BY l.id LIMIT 200`).all(cutoff);
    let confirmed = 0, failed = 0;
    for (const r of rows) {
      try {
        let tx;
        if (r.source === 'redeem') {
          const rd = db.prepare('SELECT department FROM redemptions WHERE code=?').get(r.reference_id);
          tx = await chain.redeem(r.wallet_address, -r.points, rd.department, r.reference_id);
          db.prepare('UPDATE redemptions SET tx_hash=? WHERE code=?').run(tx, r.reference_id);
        } else if (r.points > 0) tx = await chain.issue(r.wallet_address, r.points, r.event_hash);
        else continue;
        db.prepare(`UPDATE points_ledger SET tx_hash=?, chain_status='confirmed' WHERE id=?`).run(tx, r.id);
        confirmed++;
      } catch (e) { failed++; console.error('retry failed for ledger row', r.id, '-', e.message); }
    }
    res.json({ tried: rows.length, confirmed, still_pending: failed });
  } finally { retrying = false; }
});

router.post('/anchor', async (req, res) => {
  const date = typeof (req.body || {}).date === 'string' ? req.body.date : new Date().toISOString().slice(0, 10);
  try { res.json(await anchorDay(date)); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('anchor failed -', e.message);
    res.status(502).json({ error: 'Chain call failed, try again' });
  }
});

router.get('/households', async (req, res) => {
  const rows = db.prepare('SELECT house_id, ward, claim_code, address FROM households ORDER BY house_id').all();
  res.json(await Promise.all(rows.map(async (h) => ({ ...h, qr: await QRCode.toDataURL(h.house_id, { margin: 1, width: 200 }) }))));
});

module.exports = { router };
