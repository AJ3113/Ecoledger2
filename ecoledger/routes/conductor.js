const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db, signTicket } = require('../db');

const router = express.Router();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

router.use((req, res, next) => {
  const want = process.env.CONDUCTOR_DEVICE_KEY;
  if (!want) return res.status(503).json({ error: 'Conductor key not configured' });
  if (!crypto.timingSafeEqual(sha(req.get('x-device-key') || ''), sha(want)))
    return res.status(401).json({ error: 'Wrong device key' });
  next();
});

router.get('/buses', (req, res) => {
  res.json(db.prepare('SELECT bus_number, is_ev FROM buses ORDER BY bus_number').all());
});

router.post('/tickets', async (req, res) => {
  const { bus_number, distance_km, fare } = req.body || {};
  const km = typeof distance_km === 'number' || typeof distance_km === 'string' ? Number(distance_km) : NaN;
  const fr = typeof fare === 'number' || typeof fare === 'string' ? Number(fare) : NaN;
  if (typeof bus_number !== 'string') return res.status(400).json({ error: 'Choose a bus' });
  if (!Number.isFinite(km) || km <= 0 || km > 1000) return res.status(400).json({ error: 'Distance must be above 0' });
  if (!Number.isFinite(fr) || fr <= 0 || fr > 100000) return res.status(400).json({ error: 'Fare must be above 0' });
  const bus = db.prepare('SELECT bus_number, is_ev FROM buses WHERE bus_number=?').get(bus_number);
  if (!bus) return res.status(400).json({ error: 'Unknown bus' });

  const issuedAt = new Date().toISOString();
  let ticketId;
  for (let i = 0; i < 20 && !ticketId; i++) {
    const id = 'T-' + String(crypto.randomInt(0, 100000)).padStart(5, '0');
    const r = db.prepare(
      'INSERT OR IGNORE INTO tickets(ticket_id,bus_number,is_ev,distance_km,fare,issued_at) VALUES(?,?,?,?,?,?)'
    ).run(id, bus.bus_number, bus.is_ev, km, fr, issuedAt);
    if (r.changes) ticketId = id;
  }
  if (!ticketId) return res.status(500).json({ error: 'Could not create ticket, retry' });
  const payload = `${ticketId}.${signTicket(ticketId)}`;
  res.json({
    payload,
    ticket: { ticket_id: ticketId, bus_number: bus.bus_number, distance_km: km, fare: fr, issued_at: issuedAt },
    qr: await QRCode.toDataURL(payload, { margin: 1, width: 320 }),
  });
});

module.exports = { router };
