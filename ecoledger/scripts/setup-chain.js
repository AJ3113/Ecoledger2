require('dotenv').config();
const chain = require('../chain');

const DEPTS = ['DEPT_TRANSIT_ADDR', 'DEPT_WATER_ADDR', 'DEPT_ELECTRICITY_ADDR'];
const die = (m) => { console.error(m); process.exit(1); };

(async () => {
  if (!process.env.ECOLEDGER_MNEMONIC) die('Set ECOLEDGER_MNEMONIC in .env first (the treasury account; fund it from the TestNet dispenser).');
  if (!process.env.ALGOD_SERVER) die('Set ALGOD_SERVER in .env first.');
  const L = chain.lowLevel;
  const sdk = L.sdk();
  const T = L.treasury();
  const c = L.algod();
  console.log('Treasury address:', T.addr);

  let assetId = Number(process.env.GRN_ASSET_ID) || 0;
  const missing = DEPTS.filter((k) => !process.env[k]);
  const need = BigInt((assetId ? 0 : 100000) + missing.length * 300000 + 40000);
  const acct = await c.accountInformation(T.addr).do();
  const free = BigInt(acct.amount) - BigInt(acct.minBalance);
  if (free < need) die(`Treasury has ${free} spendable microALGO, needs about ${need}. Fund ${T.addr} from the TestNet dispenser and run again.`);

  if (!assetId) {
    const create = sdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      sender: T.addr, total: 1_000_000_000, decimals: 0, defaultFrozen: true,
      unitName: 'GRN', assetName: 'Eco Ledger Green Points',
      manager: T.addr, reserve: T.addr, freeze: T.addr, clawback: T.addr,
      suggestedParams: await L.params(),
    });
    const { info } = await L.signAndSubmit(create, T.sk);
    assetId = Number(info.assetIndex);
    console.log('Created GRN asset', assetId);
  } else console.log('Reusing GRN asset', assetId);

  const out = { GRN_ASSET_ID: String(assetId) };
  for (const k of DEPTS) {
    try { out[k] = process.env[k] || (await L.createOptedInAccount(assetId)); }
    catch (e) { console.error(`Could not create ${k}: ${e.message}`); }
  }
  console.log('\nPut these in .env:');
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  if (DEPTS.some((k) => !out[k])) die('\nSome department accounts failed. Save the lines above to .env and run this script again.');
  process.exit(0);
})().catch((e) => die('Setup failed: ' + e.message));
