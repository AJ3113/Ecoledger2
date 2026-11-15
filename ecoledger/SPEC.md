# EcoLedger: Build Spec

## 1. What it is
Citizens earn points for (a) riding electric buses via a signed ticket QR, (b) household waste segregation reviewed by a collector, (c) a one-time rooftop solar installation. Points are a non-transferable Algorand token (GRN). Citizens redeem points as discounts on transit fare, water tax or electricity bill using a code. Points move on-chain to the department wallet. All rules run on the server.

Look: mobile-first, one CSS file, accent #B0D68C, dark green #14301F text on white, big touch targets.

## 2. Layout
server.js, db.js (schema + `--seed`), chain.js, routes/{auth,citizen,conductor,collector,admin,dept}.js, public/{app.css, common.js, *.html}, scripts/{setup-chain.js, anchor.js, smoke-test.js}, .env.example, DEMO.md

.env keys: PORT, SESSION_SECRET, TICKET_SECRET, CONDUCTOR_DEVICE_KEY, DEPT_KEY, CHAIN_MODE (sim|testnet), ALGOD_SERVER, ALGOD_TOKEN, ECOLEDGER_MNEMONIC, GRN_ASSET_ID, DEPT_TRANSIT_ADDR, DEPT_WATER_ADDR, DEPT_ELECTRICITY_ADDR, EXPLORER_TX_URL (default https://lora.algokit.io/testnet/transaction/). Never hardcode secrets. Never log them.

## 3. Config table (editable by admin, read at request time)
points_per_km=10, min_trip_km=1, max_points_ticket=200, daily_cap_bus=400, points_per_rupee=10, waste_good=10, waste_partial=5, waste_poor=0, solar_points=500, claim_window_hours=24, contest_window_hours=24, society_bonus=20, society_bonus_threshold_pct=70

## 4. Roles and auth
Session cookie. Passwords hashed with bcryptjs.
- citizen: phone + password
- collector: collector ID + password (e.g. COL-01)
- admin: username + password
- conductor machine: no account; header `x-device-key` must equal CONDUCTOR_DEVICE_KEY (the page asks once, keeps it in sessionStorage)
- department desk: header `x-dept-key` must equal DEPT_KEY
Route guards by role on the server. A collector must never receive balances, ledger rows, phones or names of citizens.

## 5. Tables (SQLite)
users(id, role citizen|collector|admin, name, phone UNIQUE null, login_id UNIQUE null, pw_hash, house_id null, ward null, wallet_address null, created_at)
societies(id, name, ward)
households(house_id PK, address, ward, society_id, claim_code, claimed_by null)
buses(bus_number PK, is_ev)
tickets(ticket_id PK, bus_number, is_ev, distance_km, fare, issued_at, status unclaimed|claimed, claimed_by null, claimed_at null)
points_ledger(id, user_id, source bus|waste|solar|redeem|bonus, points INT signed, reference_id, event_hash, tx_hash null, chain_status confirmed|pending|failed, created_at)
waste_visits(id, house_id, collector_id, visited_at, status visited|completed, checklist json, result good|partial|poor null, remark, points_awarded, credited 0|1, contested 0|1, contested_at null, reviewed_at null)
redemptions(id, user_id, department transit|water|electricity, points, rupee_value, code UNIQUE, status pending|applied, tx_hash null, created_at)
solar_claims(id, user_id, installation_id UNIQUE, points, status pending|approved, created_at)
anchors(date PK, digest, tx_hash)
config(key PK, value)
Balance is always SUM(points_ledger.points) for the user. Never store it separately.

## 6. Ticket signing
ticket_id = "T-" + 5 random digits (unique). sig = first 16 hex chars of HMAC-SHA256(ticket_id, TICKET_SECRET). QR payload = "ticket_id.sig" and NOTHING else (no points, distance or fare). Verify with crypto.timingSafeEqual.

## 7. Rules (server side only; never trust the client)
**Registration:** name, phone, password, house_id, claim_code. Reject wrong code, unknown house, already claimed. Link house (claimed_by, users.house_id, ward), create wallet (chain.createWallet), then credit every completed, uncredited waste_visit for that house through the ledger (source waste) and mark credited=1. Sign the user in. No email, no OTP, no self-generated QR.
**Conductor create_ticket(bus_number, distance_km, fare):** valid device key; bus must exist (is_ev comes from buses table, never from the form); distance>0, fare>0. Return payload, ticket data and a QR image (data URL from qrcode).
**Claim ticket (citizen, payload):** split at "."; verify signature; ticket exists, unclaimed; issued within claim_window_hours; bus electric and distance>=min_trip_km else 0 points. points = min(distance_km*points_per_km, max_points_ticket) rounded down, then reduced so the user's bus points today <= daily_cap_bus. Mark claimed, ledger credit (source bus, reference ticket_id). Claiming a ticket with 0 points still marks it claimed.
**Collector scan(house_id):** house must be in the collector's ward; reject if a completed visit exists for that house today; else create or return today's visit with status visited.
**Collector review(visit_id, checklist):** visit belongs to this collector and is status visited. checklist = {separated, no_plastic_in_wet, no_hazardous} booleans. result: all true = good, one false = partial, two or more false = poor. points from config. Set completed. If the house is claimed, ledger credit to that user (source waste, credited=1); else credited=0 (paid out at registration). One completed visit per house per day.
**Contest:** the household owner may contest within contest_window_hours of reviewed_at; sets contested=1. Points are not changed automatically; the admin sees an alert.
**Redeem(department, points, password):** re-check the password; points>0 and <= balance; rupee_value = points / points_per_rupee; generate code like "TR-48213" (TR/WA/EL prefix); write a negative ledger row (source redeem); chain.redeem moves points to the department wallet; code valid 30 days.
**Department desk:** list or look up a code with the dept key; mark applied (once only).
**Solar:** user submits installation_id (unique); pending. Admin approval credits solar_points once (source solar).
**Society bonus (admin button):** for each society, if >= society_bonus_threshold_pct of its houses have a completed "good" visit in the current month, credit society_bonus to every claimed household in it (source bonus, reference society id plus month). Not twice for the same month.
**Ledger writes:** one function issuePoints(userId, points, source, referenceId). event_hash = sha256 of `${source}|${referenceId}|${isoTime}`. Credit off-chain first (chain_status pending), then call the chain; on success set tx_hash and confirmed, on failure keep pending. Admin button retries pending rows.

## 8. Pages (static HTML + fetch JSON)
Public: /login, /register, /demo (seed house IDs with claim codes, 3 demo tickets, note "demo only"), /collector/login, /admin/login
Citizen: /dashboard (balance, points by source, history; "View on blockchain" link only when tx_hash is real; SIM hashes show "simulated" and no link), /scan (camera via html5-qrcode plus manual paste box for the full payload), /waste (visits with result, remark, points, Contest button within the window), /redeem (department, points, password, code shown as text and QR; list of past redemptions), /solar
Conductor: /conductor (bus dropdown, distance, fare, Generate; shows printable ticket card with QR and payload text)
Collector (mobile, big buttons): /collector (today's houses in own ward with status chips, plus "Visited but not reviewed"), /collector/scan (QR reader plus manual house ID box; no photo or image upload anywhere), /collector/review?visit=ID (three toggles, computed result shown, remark)
Admin: /admin (stats cards: points issued/redeemed, tickets claimed, waste results by ward; alerts: visited-not-reviewed, contested marks, collectors whose share of "good" exceeds 90% over 10+ visits; approve solar; edit config; society bonus button; retry pending chain rows; run daily anchor; printable QR sheet: for each household a QR encoding the house_id with the house ID and claim code printed under it)
Department desk: /department (dept key, code lookup, mark applied)

## 9. Blockchain (chain.js)
Interface: createWallet() -> address; issue(address, points, eventHash) -> txId; redeem(address, points, department, code) -> txId; anchor(date, digest) -> txId.
**CHAIN_MODE=sim:** fake addresses and fake tx ids ("SIM" + random). Everything works offline.
**CHAIN_MODE=testnet (algosdk v3 field names: sender, receiver, assetSender):**
- scripts/setup-chain.js: creates ASA "GRN" (name "Eco Ledger Green Points", total 1_000_000_000, decimals 0, defaultFrozen true, manager/reserve/freeze/clawback = treasury); creates 3 department accounts, funds each with 0.3 ALGO, opts each into GRN, prints GRN_ASSET_ID and the three addresses for .env. It prints addresses only, never mnemonics.
- createWallet: generate an account, fund 0.3 ALGO from treasury, opt in to GRN (signed by the new account), return the address, then discard the secret key. Citizens never hold keys.
- issue and redeem are BOTH clawback transfers signed by the treasury: sender=treasury, assetSender=(treasury for issue, user address for redeem), receiver=(user for issue, department address for redeem). Note = "EL|"+eventHash (issue) or "EL-REDEEM|"+code (redeem), max 200 bytes. No personal data on-chain, ever.
- anchor: zero-ALGO payment treasury to treasury, note "EL-ANCHOR|"+date+"|"+digest, where digest = sha256 of the day's sorted event hashes joined. Save in anchors. scripts/anchor.js and the admin button both call it.
- Wait for confirmation (waitForConfirmation, 4 rounds). Add short retries for rate limits.
- TestNet cannot be verified without keys. After writing the code, state in the final reply what still needs the user's mnemonic and funding.
Do NOT ask for the mnemonic in chat. It is read only from .env.

## 10. Seed (db.js --seed)
Societies: "Green Residency" (Ward 1), "Lake View Apartments" (Ward 2). Households: H-1001..H-1004 in "Ward 1", H-2001..H-2004 in "Ward 2" (exact names), 6-digit claim codes, H-1001/H-1002 in Green Residency, H-2001/H-2002 in Lake View, all unclaimed. Buses: EV-101 (electric), EV-102 (electric), D-205 (diesel). Users: admin (username admin, password admin123), COL-01 (Ward 1), COL-02 (Ward 2), demo password "demo123", printed in the README run section. Past completed visits, uncredited: H-1001 good, H-1002 partial, H-2001 good. 3 unclaimed demo tickets with valid signatures. Config defaults from section 3.

## 11. Security must-haves
Every rule in section 7 enforced server-side. HMAC verify constant-time. Parameterised SQL only. Role guards on every route. Collectors cannot read citizen data. No secrets in client code or logs. No personal data on-chain. Passwords hashed. Rate-limit login attempts lightly.

## 12. Phases (build ONLY the phase requested, then stop)
P1 Foundation: project setup, db.js schema and seed, config, auth for all roles, chain.js in sim mode, issuePoints, /demo, shared CSS and page shell. Done when: registering with a seeded house and claim code lands on /dashboard with the past waste points credited, and sign-in works.
P2 Tickets: /conductor, citizen /scan claim with all ticket rules. Done when: valid claim works; second claim, tampered payload, diesel bus and expired ticket behave per section 7.
P3 Waste: collector login, list, scan, review; citizen /waste with contest. Done when: wrong-ward scan is rejected, review credits the household, a second review the same day is rejected.
P4 Redeem, solar, department desk, admin (stats, alerts, solar approval, config, QR sheet, bonus).
P5 Real Algorand: scripts/setup-chain.js, testnet mode, pending retry, anchor, explorer links.
P6 Finish: scripts/smoke-test.js covering the section 7 rules (against sim mode, run once), DEMO.md with a 90-second demo script and the pre-demo checklist.
