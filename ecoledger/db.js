require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const chain = require('./chain');

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'ecoledger.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('citizen','collector','admin')),
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  login_id TEXT UNIQUE,
  pw_hash TEXT NOT NULL,
  house_id TEXT,
  ward TEXT,
  wallet_address TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS societies(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ward TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS households(
  house_id TEXT PRIMARY KEY, address TEXT, ward TEXT NOT NULL,
  society_id INTEGER REFERENCES societies(id), claim_code TEXT NOT NULL,
  claimed_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS buses(bus_number TEXT PRIMARY KEY, is_ev INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(
  ticket_id TEXT PRIMARY KEY, bus_number TEXT NOT NULL, is_ev INTEGER NOT NULL,
  distance_km REAL NOT NULL, fare REAL NOT NULL, issued_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unclaimed' CHECK(status IN ('unclaimed','claimed')),
  claimed_by INTEGER, claimed_at TEXT
);
CREATE TABLE IF NOT EXISTS points_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK(source IN ('bus','waste','solar','redeem','bonus')),
  points INTEGER NOT NULL, reference_id TEXT, event_hash TEXT NOT NULL, tx_hash TEXT,
  chain_status TEXT NOT NULL DEFAULT 'pending' CHECK(chain_status IN ('confirmed','pending','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ledger_user ON points_ledger(user_id);
CREATE TABLE IF NOT EXISTS waste_visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT, house_id TEXT NOT NULL, collector_id INTEGER NOT NULL,
  visited_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visited' CHECK(status IN ('visited','completed')),
  checklist TEXT, result TEXT CHECK(result IN ('good','partial','poor')), remark TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0, credited INTEGER NOT NULL DEFAULT 0,
  contested INTEGER NOT NULL DEFAULT 0, contested_at TEXT, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS redemptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  department TEXT NOT NULL CHECK(department IN ('transit','water','electricity')),
  points INTEGER NOT NULL, rupee_value REAL NOT NULL, code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied')),
  tx_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS solar_claims(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, installation_id TEXT UNIQUE NOT NULL,
  points INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS anchors(date TEXT PRIMARY KEY, digest TEXT NOT NULL, tx_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const DEFAULT_CONFIG = {
  points_per_km: 10, min_trip_km: 1, max_points_ticket: 200, daily_cap_bus: 400,
  points_per_rupee: 10, waste_good: 10, waste_partial: 5, waste_poor: 0, solar_points: 500,
  claim_window_hours: 24, contest_window_hours: 24, society_bonus: 20, society_bonus_threshold_pct: 70,
};
const insCfg = db.prepare('INSERT OR IGNORE INTO config(key,value) VALUES(?,?)');
for (const [k, v] of Object.entries(DEFAULT_CONFIG)) insCfg.run(k, String(v));

const getConfig = (key) => {
  const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
  return r ? Number(r.value) : DEFAULT_CONFIG[key];
};

const balanceOf = (userId) =>
  db.prepare('SELECT COALESCE(SUM(points),0) AS b FROM points_ledger WHERE user_id=?').get(userId).b;

const signTicket = (ticketId) =>
  crypto.createHmac('sha256', process.env.TICKET_SECRET).update(ticketId).digest('hex').slice(0, 16);

// Credit off-chain first (pending), then chain; on chain failure the row stays pending.
async function issuePoints(userId, points, source, referenceId) {
  const now = new Date().toISOString();
  const ref = String(referenceId);
  const eventHash = crypto.createHash('sha256').update(`${source}|${ref}|${now}`).digest('hex');
  const id = db.prepare(
    `INSERT INTO points_ledger(user_id,source,points,reference_id,event_hash,chain_status,created_at)
     VALUES(?,?,?,?,?,'pending',?)`
  ).run(userId, source, points, ref, eventHash, now).lastInsertRowid;
  if (points > 0) {
    try {
      const u = db.prepare('SELECT wallet_address FROM users WHERE id=?').get(userId);
      const tx = await chain.issue(u.wallet_address, points, eventHash);
      db.prepare(`UPDATE points_ledger SET tx_hash=?, chain_status='confirmed' WHERE id=?`).run(tx, id);
    } catch (e) {
      console.error('chain issue failed for ledger row', id, '-', e.message);
    }
  }
  return id;
}

function seed() {
  if (!process.env.TICKET_SECRET) { console.error('Set TICKET_SECRET in .env first'); process.exit(1); }
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const tx = db.transaction(() => {
    for (const t of ['points_ledger','waste_visits','redemptions','solar_claims','anchors','tickets','households','societies','buses','users'])
      db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence`);
    const pw = bcrypt.hashSync('demo123', 10);
    const addUser = db.prepare(`INSERT INTO users(role,name,login_id,pw_hash,ward,created_at) VALUES(?,?,?,?,?,?)`);
    addUser.run('admin', 'Administrator', 'admin', bcrypt.hashSync('admin123', 10), null, now.toISOString());
    const c1 = addUser.run('collector', 'Collector 1', 'COL-01', pw, 'Ward 1', now.toISOString()).lastInsertRowid;
    const c2 = addUser.run('collector', 'Collector 2', 'COL-02', pw, 'Ward 2', now.toISOString()).lastInsertRowid;
    const addSoc = db.prepare('INSERT INTO societies(name,ward) VALUES(?,?)');
    const s1 = addSoc.run('Green Residency', 'Ward 1').lastInsertRowid;
    const s2 = addSoc.run('Lake View Apartments', 'Ward 2').lastInsertRowid;
    const addHouse = db.prepare('INSERT INTO households(house_id,address,ward,society_id,claim_code) VALUES(?,?,?,?,?)');
    const code = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    for (let i = 1; i <= 4; i++) addHouse.run(`H-100${i}`, `House ${i}, Ward 1`, 'Ward 1', i <= 2 ? s1 : null, code());
    for (let i = 1; i <= 4; i++) addHouse.run(`H-200${i}`, `House ${i}, Ward 2`, 'Ward 2', i <= 2 ? s2 : null, code());
    const addBus = db.prepare('INSERT INTO buses(bus_number,is_ev) VALUES(?,?)');
    addBus.run('EV-101', 1); addBus.run('EV-102', 1); addBus.run('D-205', 0);
    const addVisit = db.prepare(
      `INSERT INTO waste_visits(house_id,collector_id,visited_at,status,checklist,result,remark,points_awarded,credited,reviewed_at)
       VALUES(?,?,?,'completed',?,?,'Seeded past visit',?,0,?)`);
    addVisit.run('H-1001', c1, yesterday, JSON.stringify({ separated: true, no_plastic_in_wet: true, no_hazardous: true }), 'good', getConfig('waste_good'), yesterday);
    addVisit.run('H-1002', c1, yesterday, JSON.stringify({ separated: true, no_plastic_in_wet: false, no_hazardous: true }), 'partial', getConfig('waste_partial'), yesterday);
    addVisit.run('H-2001', c2, yesterday, JSON.stringify({ separated: true, no_plastic_in_wet: true, no_hazardous: true }), 'good', getConfig('waste_good'), yesterday);
    const addTicket = db.prepare('INSERT INTO tickets(ticket_id,bus_number,is_ev,distance_km,fare,issued_at) VALUES(?,?,?,?,?,?)');
    for (const [bus, ev, km, fare] of [['EV-101', 1, 5, 25], ['EV-102', 1, 8, 40], ['D-205', 0, 6, 30]]) {
      let id;
      do { id = 'T-' + String(crypto.randomInt(0, 100000)).padStart(5, '0'); }
      while (db.prepare('SELECT 1 FROM tickets WHERE ticket_id=?').get(id));
      addTicket.run(id, bus, ev, km, fare, now.toISOString());
    }
  });
  tx();
  console.log('Seeded. Logins (demo only): admin/admin123, COL-01/demo123 (Ward 1), COL-02/demo123 (Ward 2)');
}

const anchoring = new Set();
async function anchorDay(date) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Invalid date');
  if (anchoring.has(date) || db.prepare('SELECT 1 FROM anchors WHERE date=?').get(date)) throw fail(409, 'Already anchored');
  const hashes = db.prepare('SELECT event_hash FROM points_ledger WHERE substr(created_at,1,10)=? ORDER BY event_hash').all(date).map((r) => r.event_hash);
  if (!hashes.length) throw fail(400, 'No ledger events on that date');
  anchoring.add(date);
  try {
    const digest = crypto.createHash('sha256').update(hashes.join('\n')).digest('hex');
    const tx = await chain.anchor(date, digest);
    db.prepare('INSERT INTO anchors(date,digest,tx_hash) VALUES(?,?,?)').run(date, digest, tx);
    return { date, digest, tx_hash: tx, events: hashes.length };
  } finally { anchoring.delete(date); }
}

module.exports = { db, getConfig, balanceOf, signTicket, issuePoints, anchorDay, DEFAULT_CONFIG };

if (require.main === module && process.argv.includes('--seed')) seed();
