// Smoke test for the section 7 rules. Sim chain, temp database, own server: never touches ecoledger.db.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');

const results = [];
let section = '';
const sec = (n) => { section = n; };
const t = (name, cond, detail) => {
  results.push({ section, ok: !!cond });
  if (!cond) console.log(`FAIL [${section}] ${name}${detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dbFile = path.join(os.tmpdir(), `ecoledger-smoke-${process.pid}.db`);
  const port = 3900 + Math.floor(Math.random() * 90);
  const KEYS = { SESSION_SECRET: 'smoke-session', TICKET_SECRET: 'smoke-ticket', CONDUCTOR_DEVICE_KEY: 'smoke-conductor-key', DEPT_KEY: 'smoke-dept-key' };
  const env = { ...process.env, ...KEYS, DB_FILE: dbFile, CHAIN_MODE: 'sim', ECOLEDGER_MNEMONIC: '', GRN_ASSET_ID: '', NODE_ENV: 'test' };
  const cleanup = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }); };
  cleanup();

  const seed = spawnSync(process.execPath, ['db.js', '--seed'], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) { console.error('Seed failed:', seed.stderr || seed.stdout); process.exit(2); }
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, PORT: String(port) } });
  let log = '';
  srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60 && !/EcoLedger on/.test(log); i++) await sleep(100);
  if (!/EcoLedger on/.test(log)) { console.error('Server did not start:\n' + log); srv.kill(); cleanup(); process.exit(2); }

  const base = `http://127.0.0.1:${port}`;
  class C {
    constructor() { this.cookie = ''; }
    async req(method, p, body, headers = {}) {
      const res = await fetch(base + p, {
        method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      });
      const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
      const txt = await res.text(); let j = null; try { j = JSON.parse(txt); } catch {}
      return { s: res.status, j, txt, loc: res.headers.get('location') };
    }
    get(p) { return this.req('GET', p); }
    post(p, b, h) { return this.req('POST', p, b === undefined ? {} : b, h); }
  }

  const db = new Database(dbFile);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const code = (h) => one('SELECT claim_code c FROM households WHERE house_id=?', h).c;
  const uid = (phone) => one('SELECT id FROM users WHERE phone=?', phone).id;
  const dk = { 'x-device-key': KEYS.CONDUCTOR_DEVICE_KEY };
  const dp = { 'x-dept-key': KEYS.DEPT_KEY };
  const ck = (a, b, c) => ({ separated: a, no_plastic_in_wet: b, no_hazardous: c });
  const bal = async (c) => (await c.get('/api/citizen/dashboard')).j.balance;
  const reg = (c, name, phone, house, cd) => c.post('/api/register', { name, phone, password: 'secret1', house_id: house, claim_code: cd === undefined ? code(house) : cd });
  const mk = async (bus, km, fare = 20, extra = {}) => (await new C().post('/api/conductor/tickets', { bus_number: bus, distance_km: km, fare, ...extra }, dk)).j;
  const claim = (c, payload) => c.post('/api/citizen/claim', { payload });
  const scan = (c, house) => c.post('/api/collector/scan', { house_id: house });
  const review = (c, visit, checklist, remark) => c.post('/api/collector/review', { visit_id: visit, checklist, remark });
  const old = (ms) => new Date(Date.now() - ms).toISOString();
  const DAY = 86400000;

  const c1 = new C(), c2 = new C(), c3 = new C(), c4 = new C(), col1 = new C(), col2 = new C(), adm = new C(), anon = new C();
  let r;

  try {
    // ---------------------------------------------------------------- registration
    sec('Registration & auth');
    const wrong = code('H-1001') === '111111' ? '222222' : '111111';
    r = await reg(anon, 'X', '9000000099', 'H-9999', '123456'); t('unknown house rejected', r.s === 400, r.j);
    r = await reg(anon, 'X', '9000000099', 'H-1001', wrong); t('wrong claim code rejected', r.s === 400, r.j);
    t('short password rejected', (await anon.post('/api/register', { name: 'X', phone: '9000000099', password: 'abc', house_id: 'H-1001', claim_code: code('H-1001') })).s === 400);
    t('bad phone rejected', (await anon.post('/api/register', { name: 'X', phone: '12ab', password: 'secret1', house_id: 'H-1001', claim_code: code('H-1001') })).s === 400);
    t('failed attempts did not claim the house', one("SELECT claimed_by FROM households WHERE house_id='H-1001'").claimed_by === null && !one("SELECT 1 FROM users WHERE phone='9000000099'"));
    r = await reg(c1, 'Asha', '9000000001', 'H-1001'); t('register H-1001 ok', r.s === 200 && r.j.ok, r.j);
    r = await c1.get('/api/citizen/dashboard');
    t('signed in on register; past waste points (good=10) credited', r.s === 200 && r.j.balance === 10 && r.j.bySource.some((s) => s.source === 'waste' && s.points === 10), r.j);
    t('house linked to user, ward copied', (() => { const u = one("SELECT * FROM users WHERE phone='9000000001'"); return u.house_id === 'H-1001' && u.ward === 'Ward 1' && one("SELECT claimed_by FROM households WHERE house_id='H-1001'").claimed_by === u.id; })());
    t('password stored as bcrypt hash', one("SELECT pw_hash p FROM users WHERE phone='9000000001'").p.startsWith('$2'));
    t('wallet created, no secret stored', one("SELECT wallet_address w FROM users WHERE phone='9000000001'").w.startsWith('SIMADDR') && !all('PRAGMA table_info(users)').some((c) => /secret|mnemonic|key/i.test(c.name)));
    t('seeded visit marked credited', one("SELECT credited c FROM waste_visits WHERE house_id='H-1001' AND remark='Seeded past visit'").c === 1);
    r = await reg(anon, 'Dup', '9000000098', 'H-1001'); t('already-claimed house rejected', r.s === 409, r.j);
    r = await reg(anon, 'Dup', '9000000001', 'H-1003'); t('duplicate phone rejected', r.s === 409, r.j);
    r = await reg(c2, 'Bala', '9000000002', 'H-1002'); t('register H-1002 ok', r.s === 200, r.j);
    t('H-1002 partial (5) credited', (await bal(c2)) === 5);
    await c1.post('/api/logout'); t('logout ends the session', (await c1.get('/api/citizen/dashboard')).s === 401);
    r = await c1.post('/api/login', { role: 'citizen', id: '9000000001', password: 'nope' }); t('wrong password rejected', r.s === 401);
    r = await c1.post('/api/login', { role: 'citizen', id: '9000000001', password: 'secret1' }); t('login ok', r.s === 200 && (await bal(c1)) === 10);
    r = await anon.post('/api/login', { role: 'collector', id: '9000000001', password: 'secret1' }); t('citizen cannot log in as collector', r.s === 401);
    let last; for (let i = 0; i < 11; i++) last = await anon.post('/api/login', { role: 'citizen', id: '9000000777', password: 'x' });
    t('login attempts are rate limited', last.s === 429, last.s);
    t('SQL-ish input is just a wrong login', (await anon.post('/api/login', { role: 'citizen', id: "' OR '1'='1", password: 'x' })).s === 401);

    // ---------------------------------------------------------------- tickets
    sec('Tickets');
    r = await new C().post('/api/conductor/tickets', { bus_number: 'EV-101', distance_km: 5, fare: 25 }); t('conductor without device key rejected', r.s === 401);
    r = await new C().post('/api/conductor/tickets', { bus_number: 'EV-101', distance_km: 5, fare: 25 }, { 'x-device-key': 'wrong' }); t('conductor wrong key rejected', r.s === 401);
    for (const [name, body] of [['unknown bus', { bus_number: 'X-1', distance_km: 5, fare: 25 }], ['distance 0', { bus_number: 'EV-101', distance_km: 0, fare: 25 }], ['negative distance', { bus_number: 'EV-101', distance_km: -3, fare: 25 }], ['fare 0', { bus_number: 'EV-101', distance_km: 5, fare: 0 }], ['text distance', { bus_number: 'EV-101', distance_km: 'abc', fare: 25 }]])
      t('create rejects ' + name, (await new C().post('/api/conductor/tickets', body, dk)).s === 400);
    const tk = await mk('EV-101', 5, 25);
    t('payload is exactly "T-12345.<16 hex>"', /^T-\d{5}\.[0-9a-f]{16}$/.test(tk.payload), tk.payload);
    t('QR is an image data URL; payload holds no points/distance/fare', tk.qr.startsWith('data:image/png') && !/points|km|fare/i.test(tk.payload));
    const spoof = await mk('D-205', 6, 30, { is_ev: 1 });
    t('is_ev comes from buses table, never the form', one('SELECT is_ev e FROM tickets WHERE ticket_id=?', spoof.ticket.ticket_id).e === 0);
    r = await claim(anon, tk.payload); t('claim needs sign-in', r.s === 401);
    r = await claim(c1, tk.payload); t('valid claim: 5 km x 10 = 50', r.s === 200 && r.j.points === 50 && r.j.balance === 60, r.j);
    r = await claim(c2, tk.payload); t('second claim (other user) rejected', r.s === 409, r.j);
    r = await claim(c1, tk.payload); t('second claim (same user) rejected', r.s === 409);
    const t2 = await mk('EV-101', 5, 25), [id2, sig2] = t2.payload.split('.');
    t('tampered signature rejected', (await claim(c1, `${id2}.${sig2.replace(/./, (x) => (x === '0' ? '1' : '0'))}`)).s === 400);
    t('valid signature on a different id rejected', (await claim(c1, `T-00000.${sig2}`)).s === 400);
    t('payload without dot / with extra parts rejected', (await claim(c1, id2)).s === 400 && (await claim(c1, t2.payload + '.x')).s === 400);
    t('unsigned ticket id from DB cannot be claimed without its signature', (await claim(c1, id2 + '.' + '0'.repeat(16))).s === 400);
    t('tampered attempts did not consume the ticket', one('SELECT status s FROM tickets WHERE ticket_id=?', id2).s === 'unclaimed');
    const te = await mk('EV-101', 5, 25); run('UPDATE tickets SET issued_at=? WHERE ticket_id=?', old(25 * 3600000), te.ticket.ticket_id);
    r = await claim(c1, te.payload); t('expired ticket (25 h) rejected and left unclaimed', r.s === 410 && one('SELECT status s FROM tickets WHERE ticket_id=?', te.ticket.ticket_id).s === 'unclaimed', r.j);
    r = await claim(c1, spoof.payload); t('diesel bus: 0 points but marked claimed', r.s === 200 && r.j.points === 0 && one('SELECT status s FROM tickets WHERE ticket_id=?', spoof.ticket.ticket_id).s === 'claimed', r.j);
    r = await claim(c1, (await mk('EV-102', 0.5, 5)).payload); t('trip under min_trip_km: 0 points, claimed', r.s === 200 && r.j.points === 0, r.j);
    r = await claim(c1, (await mk('EV-101', 40, 100)).payload); t('per-ticket cap: 40 km -> 200', r.j.points === 200, r.j);
    r = await claim(c1, t2.payload); t('2nd valid ticket 5 km -> 50 (bus today 300)', r.j.points === 50, r.j);
    r = await claim(c1, (await mk('EV-101', 20, 60)).payload); t('daily cap reduces 200 -> 100 (bus today 400)', r.j.points === 100, r.j);
    r = await claim(c1, (await mk('EV-101', 20, 60)).payload); t('daily cap reached: 0 points, ticket claimed', r.j.points === 0 && r.j.reason, r.j);
    t('bus points today sum to the cap', one("SELECT SUM(points) s FROM points_ledger WHERE source='bus' AND user_id=?", uid('9000000001')).s === 400);
    r = await claim(c2, (await mk('EV-101', 3, 10)).payload); t('daily cap is per user (other user gets 30)', r.j.points === 30, r.j);

    // ---------------------------------------------------------------- waste
    sec('Waste & contest');
    t('collector logs in', (await col1.post('/api/login', { role: 'collector', id: 'COL-01', password: 'demo123' })).s === 200 && (await col2.post('/api/login', { role: 'collector', id: 'COL-02', password: 'demo123' })).s === 200);
    r = await scan(col1, 'H-2001'); t('wrong-ward scan rejected', r.s === 403, r.j);
    r = await scan(col1, 'H-9999'); t('unknown house rejected', r.s === 404);
    r = await scan(anon, 'H-1001'); t('scan needs collector sign-in', r.s === 401);
    r = await scan(c1, 'H-1001'); t('citizen cannot scan', r.s === 401);
    r = await scan(col1, 'h-1001'); const v1 = r.j.visit_id; t('scan creates a visit (case-insensitive id)', r.s === 200 && v1 > 0, r.j);
    t('rescan returns the same visit', (await scan(col1, 'H-1001')).j.visit_id === v1);
    r = await review(col2, v1, ck(true, true, true)); t('other collector cannot review this visit', r.s === 404);
    r = await review(col1, v1, { separated: 'yes', no_plastic_in_wet: true, no_hazardous: true }); t('non-boolean checklist rejected', r.s === 400);
    r = await review(col1, v1, { separated: true }); t('incomplete checklist rejected', r.s === 400);
    const b0 = await bal(c1);
    r = await review(col1, v1, ck(true, true, true), 'Well done'); t('all true = good, 10 points', r.s === 200 && r.j.result === 'good' && r.j.points === 10, r.j);
    t('review credited the household owner', (await bal(c1)) === b0 + 10);
    r = await review(col1, v1, ck(true, true, true)); t('second review of same visit rejected', r.s === 409, r.j);
    r = await scan(col1, 'H-1001'); t('scan after completed visit today rejected', r.s === 409, r.j);
    t('credited flag set for claimed house', one('SELECT credited c FROM waste_visits WHERE id=?', v1).c === 1);
    const v2 = (await scan(col1, 'H-1002')).j.visit_id; const b2 = await bal(c2);
    r = await review(col1, v2, ck(true, false, true)); t('one false = partial, 5 points', r.j.result === 'partial' && r.j.points === 5, r.j);
    t('partial credited to H-1002 owner', (await bal(c2)) === b2 + 5);
    const v3 = (await scan(col1, 'H-1003')).j.visit_id; r = await review(col1, v3, ck(false, false, true)); t('two false = poor, 0 points', r.j.result === 'poor' && r.j.points === 0, r.j);
    t('poor result writes no ledger row', !one("SELECT 1 FROM points_ledger WHERE reference_id=?", `visit-${v3}`));
    const v4 = (await scan(col1, 'H-1004')).j.visit_id; r = await review(col1, v4, ck(true, true, false));
    t('unclaimed house: partial reviewed, credited=0, nothing paid yet', r.j.result === 'partial' && one('SELECT credited c FROM waste_visits WHERE id=?', v4).c === 0 && !one('SELECT 1 FROM points_ledger WHERE reference_id=?', `visit-${v4}`));
    r = await reg(c3, 'Chitra', '9000000003', 'H-1004'); t('registering later pays the stored visit', r.s === 200 && (await bal(c3)) === 5 && one('SELECT credited c FROM waste_visits WHERE id=?', v4).c === 1, r.j);
    const houses = await col1.get('/api/collector/houses');
    t('collector list: own ward only, status chips', houses.j.ward === 'Ward 1' && houses.j.houses.length === 4 && houses.j.houses.find((h) => h.house_id === 'H-1001').status === 'completed' && !houses.j.houses.some((h) => /^H-2/.test(h.house_id)), houses.j);
    t('collector response has no citizen data', !/phone|balance|wallet|claim|asha|bala|9000000/i.test(houses.txt), houses.txt.slice(0, 200));
    t('collector cannot read citizen/admin APIs', (await col1.get('/api/citizen/dashboard')).s === 401 && (await col1.get('/api/admin/stats')).s === 401 && (await col1.get('/api/dept/codes')).s === 401);
    t('citizen cannot use collector APIs', (await c1.get('/api/collector/houses')).s === 401);
    const wl = (await c1.get('/api/citizen/waste')).j;
    t('citizen sees own visits, contest open on today\'s', wl.length === 2 && wl.find((x) => x.id === v1).can_contest === true && !JSON.stringify(wl).includes('collector'), wl);
    const bc = await bal(c1);
    t('contest within window ok', (await c1.post('/api/citizen/contest', { visit_id: v1 })).s === 200);
    t('contest twice rejected', (await c1.post('/api/citizen/contest', { visit_id: v1 })).s === 409);
    t('contest another household\'s visit rejected', (await c1.post('/api/citizen/contest', { visit_id: v2 })).s === 404);
    const seeded = one("SELECT id FROM waste_visits WHERE house_id='H-1001' AND remark='Seeded past visit'").id;
    t('contest after window (24 h) rejected', (await c1.post('/api/citizen/contest', { visit_id: seeded })).s === 410);
    t('contest does not change points', (await bal(c1)) === bc && one('SELECT points_awarded p FROM waste_visits WHERE id=?', v1).p === 10);

    // ---------------------------------------------------------------- redeem + department
    sec('Redeem & department');
    const rb = await bal(c1);
    r = await c1.post('/api/citizen/redeem', { department: 'transit', points: 10, password: 'wrong' }); t('wrong password rejected', r.s === 403 && (await bal(c1)) === rb);
    for (const p of [0, -5, 2.5, '50', null]) t(`points ${JSON.stringify(p)} rejected`, (await c1.post('/api/citizen/redeem', { department: 'transit', points: p, password: 'secret1' })).s === 400);
    t('more than balance rejected', (await c1.post('/api/citizen/redeem', { department: 'transit', points: rb + 1, password: 'secret1' })).s === 400);
    t('unknown department rejected', (await c1.post('/api/citizen/redeem', { department: 'gas', points: 10, password: 'secret1' })).s === 400);
    t('redeem needs sign-in', (await anon.post('/api/citizen/redeem', { department: 'water', points: 10, password: 'x' })).s === 401);
    const rt = await c1.post('/api/citizen/redeem', { department: 'transit', points: 100, password: 'secret1' });
    t('transit redeem: TR- code, Rs = 100/10, balance down, QR', rt.s === 200 && /^TR-\d{5}$/.test(rt.j.code) && rt.j.rupee_value === 10 && rt.j.balance === rb - 100 && rt.j.qr.startsWith('data:image'), rt.j);
    const lr = one("SELECT * FROM points_ledger WHERE source='redeem' AND reference_id=?", rt.j.code);
    t('negative ledger row, chain row confirmed (sim)', lr && lr.points === -100 && lr.chain_status === 'confirmed' && lr.tx_hash.startsWith('SIM'), lr);
    const rw = await c1.post('/api/citizen/redeem', { department: 'water', points: 50, password: 'secret1' }); const re = await c1.post('/api/citizen/redeem', { department: 'electricity', points: 30, password: 'secret1' });
    t('WA- and EL- prefixes, unique codes', /^WA-\d{5}$/.test(rw.j.code) && /^EL-\d{5}$/.test(re.j.code) && new Set([rt.j.code, rw.j.code, re.j.code]).size === 3);
    const left = await bal(c1);
    const race = await Promise.all([1, 2, 3].map(() => c1.post('/api/citizen/redeem', { department: 'water', points: left, password: 'secret1' })));
    t('parallel redeems of the whole balance: exactly one wins', race.filter((x) => x.s === 200).length === 1 && (await bal(c1)) === 0, race.map((x) => x.s));
    const list = (await c1.get('/api/citizen/redemptions')).j; t('redemption list has QR for open codes', list.redemptions.length === 4 && list.redemptions.every((x) => x.qr));
    t('other citizen sees none of them', (await c2.get('/api/citizen/redemptions')).j.redemptions.length === 0);

    r = await anon.get('/api/dept/codes'); t('department desk needs key', r.s === 401);
    t('wrong key / citizen session rejected', (await new C().req('GET', '/api/dept/codes', undefined, { 'x-dept-key': 'bad' })).s === 401 && (await c1.get('/api/dept/codes')).s === 401);
    const dl = await new C().req('GET', '/api/dept/codes', undefined, dp);
    t('desk lists codes without user data', dl.s === 200 && dl.j.length === 4 && Object.keys(dl.j[0]).sort().join() === 'code,created_at,department,expires_at,points,rupee_value,status' && !/user|phone|name|wallet/i.test(dl.txt));
    t('lookup (case-insensitive) and department filter', (await new C().req('GET', `/api/dept/codes/${rt.j.code.toLowerCase()}`, undefined, dp)).j.status === 'pending' && (await new C().req('GET', '/api/dept/codes?department=water', undefined, dp)).j.every((x) => x.department === 'water'));
    t('bad format / unknown code', (await new C().req('GET', '/api/dept/codes/ZZ-1', undefined, dp)).s === 400 && (await new C().req('GET', '/api/dept/codes/TR-00000', undefined, dp)).s === 404);
    r = await new C().post('/api/dept/apply', { code: rt.j.code }, dp); t('mark applied', r.s === 200 && r.j.code.status === 'applied', r.j);
    r = await new C().post('/api/dept/apply', { code: rt.j.code }, dp); t('applying twice rejected', r.s === 409);
    run('UPDATE redemptions SET created_at=? WHERE code=?', old(31 * DAY), rw.j.code);
    r = await new C().post('/api/dept/apply', { code: rw.j.code }, dp); t('expired code (31 days) cannot be applied', r.s === 410, r.j);
    t('expired code shows as expired', (await new C().req('GET', `/api/dept/codes/${rw.j.code}`, undefined, dp)).j.status === 'expired');
    t('citizen list marks it expired, no QR', (await c1.get('/api/citizen/redemptions')).j.redemptions.find((x) => x.code === rw.j.code).expired === true);

    // ---------------------------------------------------------------- solar
    sec('Solar');
    t('admin logs in', (await adm.post('/api/login', { role: 'admin', id: 'admin', password: 'admin123' })).s === 200);
    t('bad installation id rejected', (await c1.post('/api/citizen/solar', { installation_id: 'a b' })).s === 400);
    t('submit pending, no points yet', (await c1.post('/api/citizen/solar', { installation_id: 'SOL-0001' })).s === 200 && (await bal(c1)) === 0);
    t('one solar claim per user', (await c1.post('/api/citizen/solar', { installation_id: 'SOL-0002' })).s === 409);
    t('installation id is unique across users', (await c2.post('/api/citizen/solar', { installation_id: 'SOL-0001' })).s === 409);
    const sid = (await adm.get('/api/admin/solar')).j[0].id;
    t('citizen cannot approve', (await c1.post('/api/admin/solar/approve', { id: sid })).s === 401);
    r = await adm.post('/api/admin/solar/approve', { id: sid }); t('admin approval credits solar_points (500)', r.s === 200 && r.j.points === 500 && (await bal(c1)) === 500, r.j);
    t('approval only once', (await adm.post('/api/admin/solar/approve', { id: sid })).s === 409 && (await bal(c1)) === 500);

    // ---------------------------------------------------------------- config & bonus
    sec('Config & bonus');
    for (const [name, vals] of [['negative', { waste_good: -1 }], ['text', { waste_good: 'abc' }], ['unknown key', { nope: 1 }], ['threshold > 100', { society_bonus_threshold_pct: 150 }], ['points_per_rupee 0', { points_per_rupee: 0 }], ['mixed valid+invalid', { waste_good: 99, daily_cap_bus: -5 }]])
      t('config rejects ' + name, (await adm.post('/api/admin/config', { values: vals })).s === 400);
    t('rejected save changed nothing', (await adm.get('/api/admin/config')).j.waste_good === 10);
    t('citizen cannot edit config', (await c1.post('/api/admin/config', { values: { waste_good: 99 } })).s === 401);
    t('config edit saved', (await adm.post('/api/admin/config', { values: { waste_good: 12 } })).s === 200);
    r = await reg(c4, 'Dev', '9000000004', 'H-2002'); t('register Ward 2 household', r.s === 200);
    const v5 = (await scan(col2, 'H-2002')).j.visit_id; r = await review(col2, v5, ck(true, true, true));
    t('new config applies at request time (good = 12)', r.j.points === 12 && (await bal(c4)) === 12, r.j);
    await adm.post('/api/admin/config', { values: { waste_good: 10 } });
    run("UPDATE waste_visits SET reviewed_at='2000-01-01T00:00:00.000Z' WHERE remark='Seeded past visit'");
    r = await adm.post('/api/admin/bonus'); t('bonus below threshold (50% < 70%): nobody credited', r.s === 200 && r.j.report.every((x) => !x.qualified && x.credited === 0), r.j);
    await adm.post('/api/admin/config', { values: { society_bonus_threshold_pct: 50 } });
    r = await adm.post('/api/admin/bonus'); t('bonus at 50%: claimed households of both societies credited (3 x 20)', r.s === 200 && r.j.report.reduce((s, x) => s + x.credited, 0) === 3, r.j.report);
    r = await adm.post('/api/admin/bonus'); t('bonus not paid twice in the same month', r.j.report.every((x) => x.credited === 0) && all("SELECT * FROM points_ledger WHERE source='bonus'").length === 3);
    const bonusRows = all("SELECT points, reference_id FROM points_ledger WHERE source='bonus'");
    t('bonus rows: 20 points, society+month reference', bonusRows.every((b) => b.points === 20 && /^society-\d+-\d{4}-\d{2}$/.test(b.reference_id)));
    await adm.post('/api/admin/config', { values: { society_bonus_threshold_pct: 70 } });

    // ---------------------------------------------------------------- ledger, chain (sim), admin
    sec('Ledger, chain & admin');
    const users = ['9000000001', '9000000002', '9000000003', '9000000004'];
    const clients = [c1, c2, c3, c4];
    let sumOk = true; for (let i = 0; i < 4; i++) if ((await bal(clients[i])) !== one('SELECT SUM(points) s FROM points_ledger WHERE user_id=?', uid(users[i])).s) sumOk = false;
    t('balance always equals SUM(ledger)', sumOk);
    const rows = all('SELECT * FROM points_ledger');
    t('every row: integer points, 64-hex event_hash, valid status', rows.every((x) => Number.isInteger(x.points) && /^[0-9a-f]{64}$/.test(x.event_hash) && ['confirmed', 'pending', 'failed'].includes(x.chain_status)));
    t('sim hashes only, all confirmed, no personal data in hashes', rows.every((x) => x.chain_status === 'confirmed' && x.tx_hash.startsWith('SIM')));
    t('dashboard marks sim hashes "simulated"', (await c1.get('/api/citizen/dashboard')).j.history.every((h) => h.simulated));
    const bonusRow = one("SELECT id FROM points_ledger WHERE source='bonus' LIMIT 1").id, redRow = one("SELECT id, reference_id FROM points_ledger WHERE source='redeem' LIMIT 1");
    const recent = one("SELECT id FROM points_ledger WHERE source='solar' LIMIT 1").id;
    run("UPDATE points_ledger SET chain_status='pending', tx_hash=NULL, created_at=? WHERE id IN (?,?)", old(300000), bonusRow, redRow.id);
    run("UPDATE redemptions SET tx_hash=NULL WHERE code=?", redRow.reference_id);
    run("UPDATE points_ledger SET chain_status='pending', tx_hash=NULL, created_at=? WHERE id=?", new Date().toISOString(), recent);
    t('stats count pending rows', (await adm.get('/api/admin/stats')).j.pending_chain === 3);
    r = await adm.post('/api/admin/retry-pending'); t('retry confirms old pending rows, skips the fresh one', r.j.tried === 2 && r.j.confirmed === 2 && (await adm.get('/api/admin/stats')).j.pending_chain === 1, r.j);
    t('retry restored redemption tx_hash', !!one('SELECT tx_hash t FROM redemptions WHERE code=?', redRow.reference_id).t);
    run("UPDATE points_ledger SET chain_status='confirmed', tx_hash='SIMX' WHERE id=?", recent);
    const stats = (await adm.get('/api/admin/stats')).j;
    t('stats: issued / redeemed / tickets match the ledger', stats.points_issued === one('SELECT SUM(points) s FROM points_ledger WHERE points>0').s && stats.points_redeemed === -one("SELECT SUM(points) s FROM points_ledger WHERE source='redeem'").s && stats.tickets_claimed === one("SELECT COUNT(*) c FROM tickets WHERE status='claimed'").c, stats);
    t('stats: waste results by ward match visits', stats.waste_by_ward.reduce((s, w) => s + w.good + w.partial + w.poor, 0) === one("SELECT COUNT(*) c FROM waste_visits WHERE status='completed'").c);
    await scan(col2, 'H-2003');
    const col2id = one("SELECT id FROM users WHERE login_id='COL-02'").id;
    for (let i = 0; i < 10; i++) run("INSERT INTO waste_visits(house_id,collector_id,visited_at,status,result,points_awarded,credited,reviewed_at) VALUES('H-2004',?,?, 'completed','good',10,0,?)", col2id, old(5 * DAY), old(5 * DAY));
    const al = (await adm.get('/api/admin/alerts')).j;
    t('alert: visited, not reviewed', al.unreviewed.some((x) => x.house_id === 'H-2003' && x.collector === 'COL-02'), al.unreviewed);
    t('alert: contested mark', al.contested.some((x) => x.visit_id === v1), al.contested);
    t('alert: collector with >90% good over 10+ visits (and not the other)', al.skewed.length === 1 && al.skewed[0].collector === 'COL-02', al.skewed);
    const today = new Date().toISOString().slice(0, 10);
    const digest = crypto.createHash('sha256').update(all("SELECT event_hash h FROM points_ledger WHERE substr(created_at,1,10)=? ORDER BY event_hash", today).map((x) => x.h).join('\n')).digest('hex');
    r = await adm.post('/api/admin/anchor'); t('anchor: digest = sha256 of sorted event hashes', r.s === 200 && r.j.digest === digest && r.j.tx_hash.startsWith('SIM'), r.j);
    t('anchor saved; repeat / empty day / bad date rejected', one('SELECT digest d FROM anchors WHERE date=?', today).d === digest && (await adm.post('/api/admin/anchor')).s === 409 && (await adm.post('/api/admin/anchor', { date: '2020-01-01' })).s === 400 && (await adm.post('/api/admin/anchor', { date: 'x' })).s === 400);
    const qr = (await adm.get('/api/admin/households')).j;
    t('QR sheet data: 8 households, 6-digit codes, QR images', qr.length === 8 && qr.every((h) => /^\d{6}$/.test(h.claim_code) && h.qr.startsWith('data:image') && /^H-[12]00\d$/.test(h.house_id)));

    // ---------------------------------------------------------------- guards, pages, secrets
    sec('Guards & pages');
    for (const [m, p] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/alerts'], ['GET', '/api/admin/config'], ['POST', '/api/admin/bonus'], ['POST', '/api/admin/retry-pending'], ['POST', '/api/admin/anchor'], ['GET', '/api/admin/households'], ['GET', '/api/admin/solar']])
      t(`${p} admin only`, (await anon.req(m, p, m === 'POST' ? {} : undefined)).s === 401 && (await c1.req(m, p, m === 'POST' ? {} : undefined)).s === 401 && (await col1.req(m, p, m === 'POST' ? {} : undefined)).s === 401);
    t('admin cannot use citizen / collector APIs', (await adm.get('/api/citizen/dashboard')).s === 401 && (await adm.get('/api/collector/houses')).s === 401);
    const red1 = async (c, p) => (await c.get(p)).loc;
    t('signed-out visitors redirected to the right login', /\/login$/.test(await red1(anon, '/dashboard')) && /\/collector\/login$/.test(await red1(anon, '/collector')) && /\/admin\/login$/.test(await red1(anon, '/admin')));
    t('wrong role redirected', /\/admin\/login$/.test(await red1(c1, '/admin')) && /\/login$/.test(await red1(col1, '/dashboard')) && /\/collector\/login$/.test(await red1(adm, '/collector')));
    for (const p of ['/login', '/register', '/demo', '/collector/login', '/admin/login', '/conductor', '/department'])
      t(`public page ${p} loads`, (await anon.get(p)).s === 200);
    for (const p of ['/dashboard', '/scan', '/waste', '/redeem', '/solar']) t(`citizen page ${p} loads`, (await c1.get(p)).s === 200);
    for (const p of ['/collector/', '/collector/scan', '/collector/review?visit=1']) t(`collector page ${p} loads`, (await col1.get(p)).s === 200);
    for (const p of ['/admin/', '/admin/qr']) t(`admin page ${p} loads`, (await adm.get(p)).s === 200);
    const dm = (await anon.get('/api/demo')).j; t('/demo data: unclaimed houses with codes + signed tickets only', dm.houses.every((h) => !one('SELECT claimed_by c FROM households WHERE house_id=?', h.house_id).c) && dm.tickets.every((x) => /^T-\d{5}\.[0-9a-f]{16}$/.test(x.payload)));
    const publicFiles = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : publicFiles.push(path.join(d, f.name)); })(path.join(ROOT, 'public'));
    const secrets = [...Object.values(KEYS), 'admin123', 'demo123']; try { const e = require('dotenv').parse(fs.readFileSync(path.join(ROOT, '.env'))); for (const k of ['SESSION_SECRET', 'TICKET_SECRET', 'CONDUCTOR_DEVICE_KEY', 'DEPT_KEY', 'ECOLEDGER_MNEMONIC']) if (e[k] && e[k].length >= 8) secrets.push(e[k]); } catch {}
    const leak = publicFiles.filter((f) => secrets.some((s) => fs.readFileSync(f, 'utf8').includes(s)));
    t('no secrets or demo passwords in client files', leak.length === 0, leak);
    t('server log has no secrets', !secrets.some((s) => log.includes(s)));
    t('responses never include password hashes', !/\$2[aby]\$/.test((await c1.get('/api/citizen/dashboard')).txt + (await adm.get('/api/admin/solar')).txt));
  } catch (e) {
    t('test run crashed', false, e.stack || String(e));
  } finally {
    srv.kill(); db.close(); await sleep(200); cleanup();
  }

  const names = [...new Set(results.map((x) => x.section))];
  for (const n of names) { const rs = results.filter((x) => x.section === n); console.log(`${rs.every((x) => x.ok) ? 'ok  ' : 'FAIL'} ${n}: ${rs.filter((x) => x.ok).length}/${rs.length}`); }
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
