require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

for (const k of ['SESSION_SECRET', 'TICKET_SECRET']) {
  if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}
require('./db');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3600 * 1000 },
}));

const auth = require('./routes/auth');
app.use('/api', auth.router);
app.use('/api/citizen', require('./routes/citizen').router);
app.use('/api/conductor', require('./routes/conductor').router);
app.use('/api/collector', require('./routes/collector').router);
app.use('/api/dept', require('./routes/dept').router);
app.use('/api/admin', require('./routes/admin').router);

// page guards: send signed-out visitors to the right login
const pageGuards = {
  citizen: { login: '/login', pages: ['/dashboard', '/scan', '/waste', '/redeem', '/solar'] },
  collector: { login: '/collector/login', pages: ['/collector', '/collector/scan', '/collector/review'] },
  admin: { login: '/admin/login', pages: ['/admin', '/admin/qr'] },
};
for (const [role, g] of Object.entries(pageGuards))
  for (const p of g.pages)
    app.get(p, (req, res, next) => (req.session.role === role ? next() : res.redirect(g.login)));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Server error' });
});

app.listen(process.env.PORT || 3000, () => console.log(`EcoLedger on :${process.env.PORT || 3000} (${process.env.CHAIN_MODE || 'sim'})`));
