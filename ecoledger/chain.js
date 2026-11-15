const crypto = require('crypto');

const mode = () => process.env.CHAIN_MODE || 'sim';
const sim = (p) => p + crypto.randomBytes(10).toString('hex').toUpperCase();
const FUND_MICROALGO = 300000; // 0.3 ALGO per wallet / department account
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => new TextEncoder().encode(s);
const leaseOf = (s) => new Uint8Array(crypto.createHash('sha256').update(s).digest());

let _sdk, _algod, _treasury;
const sdk = () => (_sdk = _sdk || require('algosdk'));

function algod() {
  if (!_algod) {
    if (!process.env.ALGOD_SERVER) throw new Error('ALGOD_SERVER is not set');
    _algod = new (sdk().Algodv2)(process.env.ALGOD_TOKEN || '', process.env.ALGOD_SERVER);
  }
  return _algod;
}

function treasury() {
  if (!_treasury) {
    const m = process.env.ECOLEDGER_MNEMONIC;
    if (!m || !m.trim()) throw new Error('ECOLEDGER_MNEMONIC is not set in .env');
    const a = sdk().mnemonicToSecretKey(m.trim());
    _treasury = { addr: String(a.addr), sk: a.sk };
  }
  return _treasury;
}

function assetId() {
  const n = Number(process.env.GRN_ASSET_ID);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('GRN_ASSET_ID is not set. Run: node scripts/setup-chain.js');
  return n;
}

const transient = (e) =>
  !!e && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 ||
    /429|rate.?limit|too many requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(String(e.message)));

async function withRetry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= 3 || !transient(e)) throw e; await sleep(1000 * 2 ** i); }
  }
}

const params = () => withRetry(() => algod().getTransactionParams().do());

// Send signed bytes, wait up to 4 rounds. A resend of an already-landed txn is not an error.
async function submit(blobs, txId) {
  const c = algod();
  try { await withRetry(() => c.sendRawTransaction(blobs).do()); }
  catch (e) { if (!/already in ledger/i.test(String(e.message))) throw e; }
  const info = await withRetry(() => sdk().waitForConfirmation(c, txId, 4));
  return { txId, info };
}

const signAndSubmit = (txn, sk) => submit([txn.signTxn(sk)], txn.txID());

async function submitGroup(items) {
  const g = sdk().assignGroupID(items.map((i) => i.txn));
  const txns = Array.isArray(g) ? g : items.map((i) => i.txn);
  return submit(txns.map((t, i) => t.signTxn(items[i].sk)), txns[txns.length - 1].txID());
}

// New account funded and opted in as ONE atomic group; the secret key is dropped on return.
async function createOptedInAccount(asset) {
  const T = treasury();
  const acct = sdk().generateAccount();
  const addr = String(acct.addr);
  const sp = await params();
  const pay = sdk().makePaymentTxnWithSuggestedParamsFromObject({ sender: T.addr, receiver: addr, amount: FUND_MICROALGO, suggestedParams: sp });
  const optIn = sdk().makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: addr, receiver: addr, amount: 0, assetIndex: asset, suggestedParams: sp });
  await submitGroup([{ txn: pay, sk: T.sk }, { txn: optIn, sk: acct.sk }]);
  return addr;
}

function clawback({ assetSender, receiver, points, note, leaseKey }) {
  if (!Number.isSafeInteger(points) || points <= 0) throw new Error('points must be a positive integer');
  const noteBytes = enc(note);
  if (noteBytes.length > 200) throw new Error('note too long');
  if (!sdk().isValidAddress(receiver) || !sdk().isValidAddress(assetSender))
    throw new Error('Invalid wallet address (was this database seeded under CHAIN_MODE=sim?)');
  return params().then((sp) => {
    const T = treasury();
    const txn = sdk().makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: T.addr, assetSender, receiver, amount: points, assetIndex: assetId(),
      note: noteBytes, lease: leaseOf(leaseKey), suggestedParams: sp,
    });
    return signAndSubmit(txn, T.sk);
  }).then((r) => r.txId);
}

const DEPT_ENV = { transit: 'DEPT_TRANSIT_ADDR', water: 'DEPT_WATER_ADDR', electricity: 'DEPT_ELECTRICITY_ADDR' };

function requireTestnet() {
  if (mode() !== 'testnet') throw new Error('CHAIN_MODE must be sim or testnet');
}

module.exports = {
  async createWallet() {
    if (mode() === 'sim') return sim('SIMADDR');
    requireTestnet();
    return createOptedInAccount(assetId());
  },
  async issue(address, points, eventHash) {
    if (mode() === 'sim') return sim('SIM');
    requireTestnet();
    return clawback({ assetSender: treasury().addr, receiver: address, points, note: 'EL|' + eventHash, leaseKey: 'issue|' + eventHash });
  },
  async redeem(address, points, department, code) {
    if (mode() === 'sim') return sim('SIM');
    requireTestnet();
    const envKey = Object.hasOwn(DEPT_ENV, department) ? DEPT_ENV[department] : null;
    const dept = envKey && process.env[envKey];
    if (!dept) throw new Error(`${envKey || 'department'} address is not set. Run: node scripts/setup-chain.js`);
    return clawback({ assetSender: address, receiver: dept, points, note: 'EL-REDEEM|' + code, leaseKey: 'redeem|' + code });
  },
  async anchor(date, digest) {
    if (mode() === 'sim') return sim('SIM');
    requireTestnet();
    const T = treasury();
    const txn = sdk().makePaymentTxnWithSuggestedParamsFromObject({
      sender: T.addr, receiver: T.addr, amount: 0, note: enc(`EL-ANCHOR|${date}|${digest}`), suggestedParams: await params(),
    });
    return (await signAndSubmit(txn, T.sk)).txId;
  },
  lowLevel: { sdk, algod, treasury, params, signAndSubmit, createOptedInAccount },
};
