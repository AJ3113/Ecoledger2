# EcoLedger: build rules (read first, keep short)

Project: municipal green-rewards prototype on Algorand. Full spec is in SPEC.md.

STATUS: P1-P6 done (DEMO.md skipped at user request). FRONTEND.md F1-F4 done (all pages migrated, legacy CSS/JS removed). Front-end checked in jsdom only, not a real browser. P5 verified only against a local mock node, not real TestNet. Smoke test: node scripts/smoke-test.js (sim mode, temp DB).

## Token rules (the account is shared, so usage is scarce)
- Be terse. No explanations, no plans, no code echoed into chat. Final reply of each phase: 5 lines maximum (what works, how to run, what failed).
- Read SPEC.md once per session. Do not re-read files you wrote this session. Use grep or head, not cat, for files you must inspect.
- Write each file once, complete and correct. No iterative rewrites, no refactors, no extra features, no boilerplate comments.
- No README beyond run commands. No tests beyond scripts/smoke-test.js.
- Run the smoke test once per phase, and fix only what fails.
- Build only the phase you are asked to build, then stop.

## Stack (do not change)
Node 20+, Express, better-sqlite3, bcryptjs, express-session, dotenv, qrcode, algosdk v3. Static HTML + vanilla JS in /public calling a JSON API. No build step, no frameworks. html5-qrcode via CDN.

## Run
npm install; copy .env.example to .env and fill it; node db.js --seed; node server.js
