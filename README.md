<div align="center">🌱 EcoLedger
Green Transit & Sustainability Rewards on Algorand
A municipal incentive platform that rewards citizens for sustainable actions and turns earned points into everyday public-service discounts.
<p>
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/Database-SQLite-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Blockchain-Algorand-000000?logo=algorand&logoColor=white" alt="Algorand" />
  <img src="https://img.shields.io/badge/Mode-Simulation%20%7C%20TestNet-6C63FF" alt="Simulation and TestNet" />
  <img src="https://img.shields.io/badge/Status-Working%20Prototype-2E8B57" alt="Working prototype" />
</p></div>📌 Overview
EcoLedger encourages greener communities by rewarding citizens for three activities:
- 🚌 Electric bus travel
- ♻️ Household waste segregation
- ☀️ Rooftop solar installation
Citizens earn GRN points and can redeem them for discounts on transit fares, water tax, and electricity bills.

The prototype uses Algorand to provide a shared transaction record across departments that may otherwise maintain separate databases. It supports two modes:
Mode	Description
Simulation	Default mode. Uses simulated transaction IDs and does not require a blockchain account.
Algorand TestNet	Connects to Algorand TestNet for token and transaction operations. Requires a funded treasury account and configuration.


Prototype notice: EcoLedger is a working prototype. Simulation mode is the easiest way to explore the application. TestNet mode requires additional setup.

✨ Features by Role
Role	Main capabilities	Pages
Citizen	Register with a household claim code, scan bus tickets, view waste visits, submit solar installations, and redeem points.	/register, /login, /dashboard, /scan, /waste, /redeem, /solar
Waste collector	View households in an assigned ward, scan a household, and submit a checklist review.	/collector/login, /collector/
Admin	View statistics and alerts, approve solar submissions, manage settings, generate household QR sheets, manage society bonuses, and review blockchain actions.	/admin/login, /admin/
Conductor	Generate signed ticket QR codes through the ticket-machine simulator.	/conductor
Department desk	Look up redemption codes and mark them as used.	/department
Demo visitor	Explore demo households and tickets.	/demo


The Express server also serves the frontend from public/, so the application runs through a single server command.
🚀 Quick Start
Prerequisites
- Node.js 20 or newer
- npm (included with Node.js)
1. Get the project
Open a terminal in the project directory:
cd path/to/ecoledger
2. Install dependencies
npm install
3. Seed the demo database
npm run seed
The seed command loads demo data. You can run it again when you want to reset the demo data.
4. Start the application
npm start
Open http://localhost:3000/ in your browser.

When the server starts in simulation mode, the terminal should display:
EcoLedger on :3000 (sim)
Configuration is read from the .env file. See Environment Configuration.

🔐 Demo Logins
Role	How to sign in
Citizen	Open /demo, choose a household, then register at /register using its house ID and claim code. Example house ID: H-1001.
Collector	ID: COL-01 or COL-02 · Password: demo123
Admin	Username: admin · Password: admin123
Conductor	Use the CONDUCTOR_DEVICE_KEY configured in .env.
Department desk	Use the DEPT_KEY configured in .env.


⚠️ These are demonstration credentials only. Change them before any real deployment.
🔄 Try the Full Demo Flow
Follow this sequence to see how a green action becomes a redeemable reward:
1. Choose a household: Open /demo, select a house, and register at /register using its claim code.
2. Generate a bus ticket: Open /conductor, unlock the page with the device key, and generate a ticket for an electric-bus trip.
3. Claim travel points: Sign in as the citizen, open the Scan page, and submit the ticket code. The points will appear on the citizen's Home page.
4. Record a waste visit: Sign in as a collector, start a visit for the household, complete the checklist, and submit it. Review the result on the citizen's Waste page.
5. Redeem points: Open the citizen's Redeem page and redeem available points. The application generates a redemption code and QR.
6. Validate the redemption: Open /department, look up the code, and mark it as used.
7. Review activity: Sign in as admin and explore Overview, Alerts, and Blockchain.
🎯 Reward Rules
The default rules are editable under Admin → Settings.
Green action	Default reward / rule
🚌 Electric bus	10 points per kilometre. Trips must be at least 1 km. Maximum 200 points per ticket and 400 points per day. Tickets can be claimed within 24 hours and only once.
♻️ Waste visit	Good: 10 points · Partial: 5 points · Poor: 0 points. A household can contest a result within 24 hours.
☀️ Solar installation	500 points once per installation ID, after admin approval.
🎟️ Redemption	10 points = ₹1. The citizen confirms the redemption using their password.
🏘️ Society bonus	20 points per household when at least 70% of a society's houses are marked good during the month.


Rule changes apply only to new points. Previously earned points are not recalculated.
⚙️ Environment Configuration
Create a .env file in the project root. The variables below are used by the application:
Variable	Purpose
PORT	Server port. Defaults to 3000.
SESSION_SECRET	Secret used to protect sessions. Use a long, random value.
TICKET_SECRET	Secret used to sign ticket data. Use a long, random value.
CONDUCTOR_DEVICE_KEY	Access key for the conductor page.
DEPT_KEY	Access key for the department desk.
CHAIN_MODE	Blockchain mode: sim or testnet.
ALGOD_SERVER	Algorand node endpoint used in TestNet mode.
ALGOD_TOKEN	Authentication token for the Algorand node, if required by the endpoint.
ECOLEDGER_MNEMONIC	Treasury account's 25-word recovery phrase. Keep this secret.
GRN_ASSET_ID	ID of the GRN asset created on TestNet.
DEPT_TRANSIT_ADDR	Transit department wallet address.
DEPT_WATER_ADDR	Water department wallet address.
DEPT_ELECTRICITY_ADDR	Electricity department wallet address.
EXPLORER_TX_URL	Base URL used by the application for “View on blockchain” links.
DB_FILE	Optional path to the SQLite database file.


Security checklist
- Never commit .env to Git.
- Never publish or share ECOLEDGER_MNEMONIC.
- Use long, unique values for session and signing secrets.
- Do not use demo credentials in a real deployment.
⛓️ Algorand TestNet Setup
Simulation mode does not require a blockchain account. To use Algorand TestNet:
1. Set CHAIN_MODE=testnet, ALGOD_SERVER, ALGOD_TOKEN, and ECOLEDGER_MNEMONIC in .env.
2. Fund the treasury address using the Algorand TestNet dispenser. Each new citizen wallet costs the treasury approximately 0.3 ALGO, so fund it with several ALGO.
3. Check the treasury address, balance, and spendable amount:
   node scripts/check-treasury.js
4. Create the GRN token and department accounts:
   node scripts/setup-chain.js
   Copy the generated asset ID and department wallet addresses into .env.
5. Restart the application:
   npm start
How the blockchain is used
Component	On-chain operation
GRN token	The treasury issues GRN points to a citizen's wallet.
Citizen wallets	A wallet is created for each citizen and opted in to GRN in one atomic step. The backend manages the keys (custodial); citizens do not handle private keys.
Redemptions	GRN points move from the citizen's wallet to the relevant department wallet.
Daily anchor	A fingerprint (hash) of the day's ledger is written into a transaction note.


If the blockchain is unavailable, points are still credited in the database with a pending status. From Admin → Blockchain:
- Use Retry pending rows to submit pending blockchain operations later.
- Use Run daily anchor to write the daily ledger fingerprint.
Privacy design: Personal information such as names, phone numbers, tickets, and checklists remains in the database. The blockchain stores only anonymous IDs and event hashes.
🗂️ Project Structure
ecoledger/
├── server.js             # Express app, sessions, and page guards
├── db.js                 # SQLite schema, seed data, points ledger, and settings
├── chain.js              # Blockchain layer (simulation and TestNet)
├── routes/               # Authentication, citizen, collector, conductor,
│                         # department, and admin APIs
├── public/               # Frontend HTML, CSS, and JavaScript
│   ├── app.css            # Design system
│   └── common.js          # Shared API, toast, modal, and navigation helpers
└── scripts/
    ├── setup-chain.js     # Set up GRN and department accounts
    ├── check-treasury.js  # Display treasury address and balance
    ├── anchor.js          # Run the daily anchor from the command line
    └── smoke-test.js      # End-to-end backend test
🧪 Testing
Stop the server before running the smoke test:
node scripts/smoke-test.js
The script starts the app in simulation mode with a temporary database and checks the main application flows.
⚠️ Current Prototype Limitations
- OTP and multi-factor authentication (MFA) are not implemented.
- Wallets are custodial, so the backend must securely protect wallet keys.
- The ticket machine is simulated through the conductor page.
- Solar installations are approved by an admin; they are not verified against utility-provider records.
- Live TestNet operation requires a funded treasury account.
- Points are closed-loop rewards and cannot be cashed out. Cash-out would require a banking partner, KYC, and regulatory review.
<div align="center">EcoLedger — Rewarding everyday actions for a greener tomorrow. 🌍
</div>
