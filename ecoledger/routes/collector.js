const express = require('express');
const { db, getConfig, issuePoints } = require('../db');
const { requireRole } = require('./auth');

const router = express.Router();
router.use(requireRole('collector'));

const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const myWard = (req) => db.prepare('SELECT ward FROM users WHERE id=?').get(req.session.userId).ward;
const completedToday = (houseId) =>
  db.prepare(`SELECT 1 FROM waste_visits WHERE house_id=? AND status='completed' AND (visited_at>=? OR reviewed_at>=?)`)
    .get(houseId, dayStart(), dayStart());

// Only house IDs, addresses and visit state: never citizen names, phones, balances or ledger rows.
router.get('/houses', (req, res) => {
  const ward = myWard(req), ds = dayStart();
  const houses = db.prepare('SELECT house_id, address FROM households WHERE ward=? ORDER BY house_id').all(ward);
  const visits = db.prepare(
    `SELECT v.id, v.house_id, v.status FROM waste_visits v JOIN households h ON h.house_id=v.house_id
     WHERE h.ward=? AND (v.visited_at>=? OR v.reviewed_at>=?)`).all(ward, ds, ds);
  const state = {};
  for (const v of visits) {
    if (state[v.house_id] && state[v.house_id].status === 'completed') continue;
    state[v.house_id] = { status: v.status, visit_id: v.id };
  }
  const pending = db.prepare(
    `SELECT id AS visit_id, house_id, visited_at FROM waste_visits WHERE collector_id=? AND status='visited' ORDER BY visited_at`
  ).all(req.session.userId);
  res.json({
    ward,
    houses: houses.map((h) => ({ ...h, status: state[h.house_id] ? state[h.house_id].status : 'todo', visit_id: state[h.house_id] ? state[h.house_id].visit_id : null })),
    pending,
  });
});

router.post('/scan', (req, res) => {
  const houseId = typeof (req.body || {}).house_id === 'string' ? req.body.house_id.trim().toUpperCase() : '';
  const house = db.prepare('SELECT house_id, address, ward FROM households WHERE house_id=?').get(houseId);
  if (!house) return res.status(404).json({ error: 'Unknown house' });
  if (house.ward !== myWard(req)) return res.status(403).json({ error: 'This house is not in your ward' });
  const out = db.transaction(() => {
    if (completedToday(houseId)) return { status: 409, error: 'This house was already reviewed today' };
    let v = db.prepare(`SELECT id, collector_id FROM waste_visits WHERE house_id=? AND status='visited' AND visited_at>=?`).get(houseId, dayStart());
    if (v && v.collector_id !== req.session.userId) return { status: 409, error: 'Another collector already scanned this house today' };
    if (!v) {
      const id = db.prepare(`INSERT INTO waste_visits(house_id,collector_id,visited_at,status) VALUES(?,?,?,'visited')`)
        .run(houseId, req.session.userId, new Date().toISOString()).lastInsertRowid;
      v = { id };
    }
    return { visit_id: v.id, house_id: houseId, address: house.address };
  })();
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json(out);
});

router.get('/visits/:id', (req, res) => {
  const v = db.prepare(
    `SELECT v.id, v.house_id, v.status, h.address FROM waste_visits v JOIN households h ON h.house_id=v.house_id
     WHERE v.id=? AND v.collector_id=?`).get(Number(req.params.id), req.session.userId);
  if (!v) return res.status(404).json({ error: 'Visit not found' });
  res.json(v);
});

router.post('/review', async (req, res) => {
  const b = req.body || {};
  const c = b.checklist || {};
  const keys = ['separated', 'no_plastic_in_wet', 'no_hazardous'];
  if (!keys.every((k) => typeof c[k] === 'boolean')) return res.status(400).json({ error: 'Answer all three checks' });
  const remark = typeof b.remark === 'string' ? b.remark.trim().slice(0, 300) : '';
  const visitId = Number(b.visit_id);
  if (!Number.isInteger(visitId)) return res.status(400).json({ error: 'Invalid visit' });

  const falses = keys.filter((k) => !c[k]).length;
  const result = falses === 0 ? 'good' : falses === 1 ? 'partial' : 'poor';
  const points = getConfig(`waste_${result}`);

  const out = db.transaction(() => {
    const v = db.prepare('SELECT * FROM waste_visits WHERE id=? AND collector_id=?').get(visitId, req.session.userId);
    if (!v) return { status: 404, error: 'Visit not found' };
    if (v.status !== 'visited') return { status: 409, error: 'Visit already reviewed' };
    if (completedToday(v.house_id)) return { status: 409, error: 'This house was already reviewed today' };
    const owner = db.prepare('SELECT claimed_by FROM households WHERE house_id=?').get(v.house_id).claimed_by;
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE waste_visits SET status='completed', checklist=?, result=?, remark=?, points_awarded=?, credited=?, reviewed_at=? WHERE id=?`
    ).run(JSON.stringify({ separated: c.separated, no_plastic_in_wet: c.no_plastic_in_wet, no_hazardous: c.no_hazardous }), result, remark, points, owner ? 1 : 0, now, visitId);
    return { owner, visitId };
  })();

  if (out.error) return res.status(out.status).json({ error: out.error });
  if (out.owner && points > 0) await issuePoints(out.owner, points, 'waste', `visit-${out.visitId}`);
  res.json({ ok: true, result, points });
});

module.exports = { router };
