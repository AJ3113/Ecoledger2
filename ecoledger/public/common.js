/* EcoLedger shared front-end helpers (companion to app.css).
   Globals use unusual names (EL, esc, api...) so pages can declare their own $, day and so on without clashing. */
const EL = {};
EL.$ = (s, r = document) => r.querySelector(s);
EL.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
EL.home = { citizen: '/dashboard', collector: '/collector/', admin: '/admin/' };
EL.loginUrl = { citizen: '/login', collector: '/collector/login', admin: '/admin/login' };
EL.roleFromPath = () => (location.pathname.startsWith('/admin') ? 'admin' : location.pathname.startsWith('/collector') ? 'collector' : 'citizen');
EL.onPublicPage = () => /^\/($|login|register|demo|collector\/login|admin\/login|conductor|department)/.test(location.pathname);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- api ----------
   api(path)                          GET
   api(path, { method, body, headers, noRedirect })
   Throws Error(plain-language message) with .status. A 401 sends the user to the right login page. */
function friendlyError(status, msg) {
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  if (status === 429) return msg || 'Too many attempts. Please wait a few minutes and try again.';
  return msg || 'Something went wrong. Please try again.';
}
async function api(path, opts) {
  let o = opts;
  o = o || {};
  const init = { method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers: { ...(o.headers || {}) } };
  if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  let res;
  try { res = await fetch(path, init); }
  catch (e) { const err = new Error('Cannot reach the server. Check your connection and try again.'); err.status = 0; throw err; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(friendlyError(res.status, data.error));
    err.status = res.status; err.data = data;
    if (res.status === 401 && !o.noRedirect && !EL.onPublicPage()) location.href = EL.loginUrl[EL.roleFromPath()];
    throw err;
  }
  return data;
}
async function logout(to) {
  try { await api('/api/logout', { method: 'POST', body: {}, noRedirect: true }); } catch (e) { /* already signed out */ }
  location.href = to || '/login';
}

/* ---------- icons ---------- */
const ICON_PATHS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
  waste: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  redeem: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  solar: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  bus: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 11h18M7 21v-4M17 21v-4"/><circle cx="7.5" cy="14" r=".6"/><circle cx="16.5" cy="14" r=".6"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-6 7-10 16-10 0 9-4 17-9 17z"/><path d="M4 21c3-6 6-9 11-12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17.01"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M20 20h.01M17 17h3v3"/>',
  ticket: '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><line x1="13" y1="5" x2="13" y2="19"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
};
function icon(name, size = 22) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;
}
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 24); });
}

/* ---------- formatting ---------- */
function money(points) {
  const n = Number(points || 0) / 10;
  return 'Rs ' + (Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 }));
}
function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 172800) return 'yesterday';
  if (s < 7 * 86400) return Math.round(s / 86400) + ' days ago';
  return new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeLeft(until) {
  const m = Math.floor((new Date(until).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(m) || m <= 0) return 'closed';
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (x) { /* ignore */ } t.remove();
  }
  toast('Copied', 'success');
}
/* blockchain badge: confirmed (link), pending (grey), simulated (no link) */
function chainBadge(row, explorer) {
  const tx = row && row.tx_hash;
  if (tx && String(tx).startsWith('SIM')) return '<span class="chip simulated" title="Simulated, not on a public chain">simulated</span>';
  if (tx) return `<a class="chip confirmed" href="${esc((explorer || '') + tx)}" target="_blank" rel="noopener">${icon('link', 12)} on-chain</a>`;
  return '<span class="chip pending" title="Waiting to be recorded on the blockchain">pending</span>';
}

/* ---------- feedback: toast, confirm modal, busy buttons ---------- */
function toast(msg, type = 'info', ms) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap); }
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${type === 'error' ? icon('alert', 18) : type === 'success' ? icon('check', 18) : ''}<span>${esc(msg)}</span><button type="button" aria-label="Dismiss">&times;</button>`;
  el.querySelector('button').onclick = () => el.remove();
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms || (type === 'error' ? 6000 : 3500));
}
function confirmModal(text, o = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><h2 id="m-title">${esc(o.title || 'Are you sure?')}</h2><p>${esc(text)}</p>
      <div class="modal-actions"><button type="button" class="btn ghost" data-no>${esc(o.cancelText || 'Cancel')}</button><button type="button" class="btn ${o.danger ? 'danger' : ''}" data-yes>${esc(o.confirmText || 'Confirm')}</button></div></div>`;
    document.body.appendChild(wrap);
    const done = (v) => { document.removeEventListener('keydown', onKey); wrap.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    function onKey(e) {
      if (e.key === 'Escape') return done(false);
      if (e.key !== 'Tab') return;
      const f = Array.from(wrap.querySelectorAll('button')); const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-no]').onclick = () => done(false);
    wrap.querySelector('[data-yes]').onclick = () => done(true);
    document.addEventListener('keydown', onKey);
    wrap.querySelector('[data-yes]').focus();
  });
}
/* disables the button with a spinner while fn runs; return 'keep' from fn to stay busy (e.g. while navigating away) */
async function withBusy(btn, fn) {
  btn.disabled = true; btn.classList.add('loading'); btn.setAttribute('aria-busy', 'true');
  let keep = false;
  try { const r = await fn(); keep = r === 'keep'; return r; }
  finally { if (!keep) { btn.disabled = false; btn.classList.remove('loading'); btn.removeAttribute('aria-busy'); } }
}
function setFieldError(id, msg) {
  const el = document.getElementById(id); if (!el) return;
  const f = el.closest('.field'); const err = document.getElementById(id + '-error');
  if (f) f.classList.toggle('invalid', !!msg);
  if (err) err.textContent = msg || '';
  el.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

/* ---------- loading / empty / error states for every list ---------- */
function skeleton(n = 3) { return Array.from({ length: n }, () => '<span class="skeleton tall"></span>').join(''); }
function emptyState(o = {}) {
  return `<div class="empty"><div class="ic-wrap">${icon(o.icon || 'leaf', 26)}</div><h3>${esc(o.title || 'Nothing here yet')}</h3>${o.text ? `<p>${esc(o.text)}</p>` : ''}${o.action ? `<a class="btn auto" href="${esc(o.action.href)}">${esc(o.action.label)}</a>` : ''}</div>`;
}
function errorState(msg) {
  return `<div class="empty"><div class="ic-wrap">${icon('alert', 26)}</div><h3>We could not load this</h3><p>${esc(msg || 'Please try again.')}</p><button type="button" class="btn ghost auto" data-retry>Try again</button></div>`;
}
async function loadInto(el, fetcher, render, o = {}) {
  const go = async () => {
    el.setAttribute('aria-busy', 'true'); el.innerHTML = skeleton(o.rows || 3);
    try {
      const data = await fetcher();
      const empty = o.isEmpty ? o.isEmpty(data) : (Array.isArray(data) && data.length === 0);
      el.innerHTML = empty ? emptyState(o.empty || {}) : render(data);
      hydrateIcons(el);
      return data;
    } catch (e) {
      el.innerHTML = errorState(e.message);
      const b = el.querySelector('[data-retry]'); if (b) b.onclick = go;
    } finally { el.removeAttribute('aria-busy'); }
  };
  return go();
}

/* ---------- role-aware navigation ----------
   mountNav({ role, title, back, links })
   role: 'citizen' | 'collector' | 'admin' | undefined (public page). Citizens also get the bottom tab bar.
   Public pages show "Go to your dashboard" when a session exists. Returns a promise of /api/me. */
function adminNavHtml(active) {
  const items = [['overview', 'Overview', 'grid'], ['alerts', 'Alerts', 'alert'], ['solar', 'Solar', 'solar'], ['households', 'Households and QR', 'qr'], ['settings', 'Settings', 'sliders'], ['blockchain', 'Blockchain', 'link']];
  return items.map(([id, label, ic]) => `<a href="#${id}" ${id === active ? 'aria-current="page"' : ''}>${icon(ic, 20)}<span>${label}</span></a>`).join('');
}
function mountNav(o = {}) {
  const role = o.role || null;
  if (o.title) document.title = o.title + ' - EcoLedger';
  const roleLabel = { citizen: 'Citizen', collector: 'Collector', admin: 'Admin' }[role];
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const links = (o.links || []).map((l) => `<a class="iconbtn" href="${esc(l.href)}">${esc(l.label)}</a>`).join('');
  bar.innerHTML = `<div class="topbar-in">
    ${o.back ? `<a class="iconbtn" href="${esc(o.back)}" aria-label="Back">${icon('back', 22)}</a>` : ''}
    <a class="brand" href="${role ? EL.home[role] : '/'}"><span class="logo">${icon('leaf', 20)}</span><span>EcoLedger</span></a>
    ${roleLabel ? `<span class="chip">${roleLabel}</span>` : ''}
    <span class="spacer"></span>
    ${role ? `<button class="iconbtn" type="button" id="el-logout">${icon('logout', 20)}<span class="hide-sm">Sign out</span></button>` : `${links}<span id="el-auth"></span>`}
  </div>`;
  document.body.prepend(bar);
  if (role) {
    bar.querySelector('#el-logout').onclick = (e) => withBusy(e.currentTarget, () => logout(EL.loginUrl[role]).then(() => 'keep'));
    if (role === 'citizen' && o.tabs !== false) {
      const tabs = [['Home', '/dashboard', 'home'], ['Scan', '/scan', 'scan'], ['Waste', '/waste', 'waste'], ['Redeem', '/redeem', 'redeem'], ['Solar', '/solar', 'solar']];
      const nav = document.createElement('nav');
      nav.className = 'tabbar'; nav.setAttribute('aria-label', 'Main');
      nav.innerHTML = tabs.map(([l, h, i]) => `<a href="${h}" ${location.pathname === h ? 'aria-current="page"' : ''}>${icon(i, 22)}<span>${l}</span></a>`).join('');
      document.body.appendChild(nav);
      document.body.classList.add('has-tabbar');
    }
    return Promise.resolve({ role });
  }
  return api('/api/me', { noRedirect: true }).then((me) => {
    if (me.role) {
      const slot = bar.querySelector('#el-auth');
      slot.innerHTML = `<a class="iconbtn" href="${EL.home[me.role]}">Dashboard</a><button class="iconbtn" type="button" id="el-out">${icon('logout', 20)}<span class="hide-sm">Sign out</span></button>`;
      slot.querySelector('#el-out').onclick = (e) => withBusy(e.currentTarget, () => logout('/').then(() => 'keep'));
    }
    return me;
  }).catch(() => ({ role: null }));
}

/* ---------- login form wiring (citizen, collector and admin share it) ----------
   Page needs: form#login-form, input#id, input#password, button#submit, div#form-error (alert), .field wrappers with #id-error / #password-error */
function wireLogin(cfg) {
  const $id = (x) => document.getElementById(x);
  const form = $id('login-form'), idEl = $id('id'), pwEl = $id('password'), btn = $id('submit'), box = $id('form-error');
  const showBox = (msg) => { box.textContent = msg; box.hidden = !msg; };
  api('/api/me', { noRedirect: true }).then((m) => { if (m.role === cfg.role) location.replace(cfg.next); }).catch(() => {});
  idEl.addEventListener('input', () => setFieldError('id', ''));
  pwEl.addEventListener('input', () => setFieldError('password', ''));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showBox('');
    const idv = cfg.normalize(idEl.value);
    setFieldError('id', idv.error || ''); setFieldError('password', pwEl.value ? '' : 'Enter your password');
    if (idv.error) return idEl.focus();
    if (!pwEl.value) return pwEl.focus();
    await withBusy(btn, async () => {
      try {
        await api('/api/login', { method: 'POST', body: { role: cfg.role, id: idv.value, password: pwEl.value }, noRedirect: true });
        location.href = cfg.next;
        return 'keep';
      } catch (err) {
        showBox(err.status === 401 ? cfg.failMsg : err.message);
        pwEl.focus(); pwEl.select();
      }
    });
  });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pw-toggle]'); if (!b) return;
  const input = document.getElementById(b.dataset.pwToggle); if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show'; b.setAttribute('aria-pressed', String(show));
});
document.addEventListener('DOMContentLoaded', () => hydrateIcons());
