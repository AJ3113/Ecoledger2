require('dotenv').config();
const { anchorDay } = require('../db');

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
anchorDay(date)
  .then((r) => { console.log(`Anchored ${r.date}: ${r.events} events, digest ${r.digest}, tx ${r.tx_hash}`); process.exit(0); })
  .catch((e) => { console.error('Anchor failed:', e.message); process.exit(1); });
