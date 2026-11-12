import { STR, DEFAULT_CATEGORIES, DEFAULT_FUNCTIONS } from './i18n.js';
import { makeStore } from './store.js';

/* ============================== helpers ============================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const t = (k, ...a) => { const v = STR[S.lang || 'hi'][k] ?? STR.en[k]; return typeof v === 'function' ? v(...a) : v; };

const inr = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
const words = n => {
  n = +n || 0; const hi = S.lang === 'hi', f = x => String(Math.round(x * 100) / 100);
  if (n >= 1e7) return f(n / 1e7) + (hi ? ' करोड़' : ' crore');
  if (n >= 1e5) return f(n / 1e5) + (hi ? ' लाख' : ' lakh');
  if (n >= 1e3) return f(n / 1e3) + (hi ? ' हज़ार' : ' thousand');
  return '';
};
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const todayStr = () => ymd(new Date());
const parseD = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const locale = () => S.lang === 'hi' ? 'hi-IN' : 'en-IN';
const fmtD = (s, o = { day: 'numeric', month: 'short' }) => s ? parseD(s).toLocaleDateString(locale(), o) : '';
const daysUntil = s => Math.round((parseD(s) - parseD(todayStr())) / 864e5);
const newId = (n = 16) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, b => (b % 36).toString(36)).join(''); };
const digits = s => String(s || '').replace(/[^\d]/g, '');
const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0);

const MODES = ['cash', 'upi', 'card', 'cheque', 'bank'];
const MODE_IC = { cash: 'money', upi: 'device-mobile', card: 'credit-card', cheque: 'note-pencil', bank: 'bank' };

/* ============================== state ============================== */
const S = {
  lang: LS.get('sp.lang'), screen: 'boot', demo: false,
  user: null, userDoc: {}, wid: null, wedding: null, members: [], me: null,
  payments: [], vendors: [], categories: [], functions: [], tasks: [], pend: {},
  view: 'home', moneyTab: 'occasions', cat: 'all', occ: 'all', q: '', occasions: [],
  taskFilter: 'all', showDone: {}, setupSel: null,
  guests: [], shagun: [], guestTab: 'list', gFilter: 'all', gq: '', shDir: 'all', shq: '',
};
let store, unsubs = [], moneyUnsubs = [];

const role = () => S.me?.role;
const canEdit = () => role() === 'owner' || role() === 'editor';
const isOwner = () => role() === 'owner';
const seesMoney = () => canEdit() || !!S.me?.money;
const myWeddings = () => Object.entries(S.userDoc?.weddings || {}).filter(([, w]) => w && !w.gone).map(([id, w]) => ({ id, ...w }));
const catName = c => c ? (c.name || (S.lang === 'hi' ? c.hi || c.en : c.en || c.hi) || '') : '';

function derive() {
  const P = S.payments.filter(p => !p.deleted), V = S.vendors.filter(v => !v.deleted);
  const vById = Object.fromEntries(S.vendors.map(v => [v.id, v]));
  const cats = S.categories.filter(c => !c.deleted).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const cById = Object.fromEntries(S.categories.map(c => [c.id, c]));
  const catOf = p => (p.vendorId && vById[p.vendorId]?.categoryId) || p.categoryId || 'other';
  const paidV = {}, catPaid = {}, catDue = {};
  let paid = 0, due = 0;
  P.forEach(p => {
    const a = +p.amount || 0; paid += a;
    if (p.vendorId) paidV[p.vendorId] = (paidV[p.vendorId] || 0) + a;
    const c = catOf(p); catPaid[c] = (catPaid[c] || 0) + a;
  });
  const vs = {};                                  // per-vendor paid / balance
  V.forEach(v => {
    const pd = paidV[v.id] || 0, bal = Math.max((+v.agreed || 0) - pd, 0);
    vs[v.id] = { paid: pd, bal };
    if (bal > 0) { due += bal; const c = v.categoryId || 'other'; catDue[c] = (catDue[c] || 0) + bal; }
  });
  const dues = V.filter(v => vs[v.id].bal > 0).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const planned = cats.reduce((s, c) => s + (+c.planned || 0), 0);
  const budget = +S.wedding?.budget || planned;
  return { P, V, vById, cats, cById, catOf, vs, catPaid, catDue, paid, due, dues, planned, budget };
}

/* ============================== writes ============================== */
function fail(e) {
  console.error(e);
  toast(e && e.code === 'permission-denied' ? t('errPerm') : t('errGeneric'));
}
const stamp = isNew => ({
  updatedAt: Date.now(), updatedBy: S.user.uid,
  ...(isNew ? { createdAt: Date.now(), createdBy: S.user.uid, createdByName: S.me?.name || '', deleted: false } : {}),
});
// Never await item writes: Firestore saves to the phone instantly and syncs later,
// but the promise only settles once the server answers (which can be hours offline).
const put = (path, data) => { store.set(path, data).catch(fail); };
const wpath = (col, id) => `weddings/${S.wid}/${col}/${id}`;

function softDelete(col, id, label) {
  put(wpath(col, id), { deleted: true, deletedAt: Date.now(), ...stamp(false) });
  toast(label || t('deleted'), () => put(wpath(col, id), { deleted: false, ...stamp(false) }));
}

/* ============================== toast ============================== */
let toastT;
function toast(msg, undo) {
  const r = $('#toast-root');
  r.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${undo ? `<button id="t-undo">${t('undo')}</button>` : ''}</div>`;
  if (undo) $('#t-undo').onclick = () => { undo(); r.innerHTML = ''; };
  clearTimeout(toastT);
  toastT = setTimeout(() => { r.innerHTML = ''; }, undo ? 6000 : 2200);
}

/* ============================== sheets ==============================
   Bottom drawers. Each open sheet adds a history entry so the phone's Back
   button closes the sheet instead of leaving the app. */
const sheets = [];
function openSheet(sh) { sheets.push(sh); history.pushState({ sheet: sheets.length }, ''); drawSheet(); }
function closeSheet() { if (sheets.length) history.back(); }
window.addEventListener('popstate', e => {      // one event even for history.go(-2), so trust the landed state
  const n = Math.min(e.state?.sheet || 0, sheets.length);
  if (n !== sheets.length) { sheets.length = n; drawSheet(); }
});
function drawSheet() {
  const root = $('#sheet-root'), sh = sheets[sheets.length - 1];
  if (!sh) { root.innerHTML = ''; document.body.style.overflow = ''; return; }
  const old = root.querySelector('.sheet'), keep = old && root.dataset.n == sheets.length ? old.scrollTop : 0;
  root.dataset.n = sheets.length;
  root.innerHTML = `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${sh.html()}</div></div>`;
  document.body.style.overflow = 'hidden';
  const el = root.querySelector('.sheet'); el.scrollTop = keep;
  sh.bind && sh.bind(el);
}
const sheetHead = (title, extra = '') =>
  `<div class="sh-h"><h3>${esc(title)}</h3>${extra}<button class="x" data-act="close" aria-label="close"><i class="ph ph-x"></i></button></div>`;

/* ============================== render ============================== */
let renderT = 0;
function render() {                    // coalesces bursts of snapshot updates into one redraw
  clearTimeout(renderT);
  renderT = setTimeout(() => {
    const ae = document.activeElement, keepId = ae && ae.id && $('#app').contains(ae) ? ae.id : null;
    const sel = keepId ? ae.selectionStart : null;
    document.documentElement.lang = S.lang || 'hi';
    $('#app').innerHTML = screenHTML();
    if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch (e) {} } }
    if (sheets.length && sheets[sheets.length - 1].live) drawSheet();
  });
}

const LOGO = `<img class="logo" src="icon-512.png" alt="">`;
const spinner = () => `<div class="screen"><div class="wrap" style="text-align:center"><span class="spin"></span><p class="muted">${t('loading')}</p></div></div>`;
const langToggle = () => `<div class="lang-toggle"><button data-act="lang" data-v="hi" class="${S.lang === 'hi' ? 'on' : ''}">हिन्दी</button><button data-act="lang" data-v="en" class="${S.lang === 'en' ? 'on' : ''}">English</button></div>`;
/* ---------- install as an app ---------- */
let installEvt = null;                       // Chrome/Android's install prompt, saved for our own button
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; render(); });
window.addEventListener('appinstalled', () => { installEvt = null; LS.set('sp.installed', '1'); render(); toast(t('installed')); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && !LS.get('sp.installed') && (!!installEvt || isIOS() || /android/i.test(navigator.userAgent));
const installBanner = () => canInstall() && !LS.get('sp.installHide') ? `<div class="install"><img src="icon-192.png" alt="">
  <div class="mid"><div class="t">${t('installTitle')}</div><div class="s">${t('installHint')}</div></div>
  <button class="btn gold sm" data-act="install">${t('installBtn')}</button>
  <button class="x" data-act="install-hide" aria-label="${esc(t('notNow'))}"><i class="ph ph-x"></i></button></div>` : '';
async function installApp() {
  if (installEvt) {
    const e = installEvt; installEvt = null;
    e.prompt();
    try { const r = await e.userChoice; if (r.outcome === 'accepted') LS.set('sp.installed', '1'); } catch (err) {}
    render(); return;
  }
  const ios = isIOS(), steps = ios ? t('installIos') : t('installAndroid');
  openSheet({ html: () => `${sheetHead(t('installTitle'))}
    <ol class="steps">${steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    ${ios ? `<p class="small muted">${t('installIosNote')}</p>` : ''}
    <button class="btn gold block" data-act="close"><i class="ph ph-check"></i> OK</button>` });
}
const demoBar = () => S.demo ? `<div class="demo-bar"><i class="ph ph-info"></i> ${t('demoBanner')}</div>` : '';

function screenHTML() {
  switch (S.screen) {
    case 'lang': return `<div class="screen"><div class="wrap"><div class="brand">${LOGO}<h1>Shaadi Planner</h1></div>
      <p style="text-align:center;font-weight:700">भाषा चुनें · Choose language</p>
      <div class="lang-big"><button data-act="pick-lang" data-v="hi">हिन्दी</button><button data-act="pick-lang" data-v="en">English</button></div></div></div>`;
    case 'signin': return loginHTML();
    case 'onboard': return onboardHTML();
    case 'join': return joinHTML();
    case 'app': return appHTML();
    case 'error': return `<div class="screen"><div class="wrap" style="text-align:center"><p>${esc(S.error || t('errGeneric'))}</p><button class="btn" data-act="reload">↻</button></div></div>`;
    default: return spinner();
  }
}

/* ---------- login: name + phone + family PIN ---------- */
const numInp = (id, max, extra = '') =>
  `<input class="inp" id="${id}" inputmode="numeric" pattern="[0-9]*" maxlength="${max}" autocomplete="off" ${extra}>`;
function loginHTML() {
  return `${demoBar()}<div class="screen"><div class="wrap"><div class="brand">${LOGO}<h1>${t('appName')}</h1><p>${LS.get('sp.join') ? t('loginToJoin') : t('tagline')}</p></div>
    <div class="card">
      <div class="field"><label for="li-name">${t('yourName')}</label><input class="inp" id="li-name" autocomplete="name" placeholder="${esc(t('yourNamePh'))}" value="${esc(LS.get('sp.lastName', ''))}"></div>
      <div class="field"><label for="li-phone">${t('yourPhone')}</label>${numInp('li-phone', 10, `type="tel" placeholder="${esc(t('phonePh'))}" value="${esc(LS.get('sp.lastPhone', ''))}"`)}</div>
      <div class="field"><label for="li-pin">${t('familyPin')}</label>${numInp('li-pin', 4, 'type="password" placeholder="••••" style="letter-spacing:.4em"')}</div>
      <p class="muted small" style="margin:0 0 12px">${t('pinHint')}</p>
      <div class="err ${S.loginErr ? '' : 'hidden'}" id="li-err">${esc(S.loginErr || '')}</div>
      <button class="btn block gold" data-act="login" id="login-btn"><i class="ph ph-sign-in"></i> ${t('login')}</button>
    </div>${installBanner()}${langToggle()}</div></div>`;
}
const cleanPhone = s => { const d = digits(s); return d.length > 10 && /^(91|0)/.test(d) ? d.slice(-10) : d; };
function authMsg(e) {
  const c = e?.code || '';
  if (c === 'wrong-pin') return t('wrongPin');
  if (/too-many-requests/.test(c)) return t('tooMany');
  if (/network/.test(c) || !navigator.onLine) return t('offline');
  console.error(e); return t('errGeneric');
}

/* ---------- onboarding ---------- */
function onboardHTML() {
  const ws = myWeddings();
  return `${demoBar()}<main class="no-nav"><div class="wrap">
    <div class="brand" style="margin:18px 0 20px">${LOGO}<h1>${t('welcome')}</h1></div>
    ${ws.length ? `<div class="sec-h"><h2>${t('yourWeddings')}</h2></div><div class="list">${ws.map(w =>
      `<button class="row" data-act="open-wedding" data-id="${w.id}"><span class="ic"><i class="ph ph-heart"></i></span><span class="mid"><div class="t">${esc(w.name)}</div><div class="s">${t('roles')[w.role] || ''}</div></span><i class="ph ph-caret-right muted"></i></button>`).join('')}</div>` : ''}
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:1.1rem">${t('newWedding')}</h2>
      <p class="muted small" style="margin:0 0 14px">${t('newWeddingHint')}</p>
      <div class="field"><label for="ob-name">${t('weddingName')}</label><input class="inp" id="ob-name" placeholder="${esc(t('weddingNamePh'))}"></div>
      <div class="field"><label for="ob-date">${t('weddingDate')}</label><input class="inp" id="ob-date" type="date"></div>
      <div class="field"><label for="ob-me">${t('yourName')}</label><input class="inp" id="ob-me" placeholder="${esc(t('yourNamePh'))}" value="${esc(S.userDoc.name || S.loginName || '')}"></div>
      <div class="field"><label for="ob-pin">${t('familyPin')}</label>${numInp('ob-pin', 4, `value="${esc(S.pin || '')}" style="letter-spacing:.4em"`)}<p class="muted small" style="margin:6px 0 0">${t('obPinHint')}</p></div>
      <div class="err hidden" id="ob-err"></div>
      <button class="btn block gold" data-act="create-wedding"><i class="ph ph-plus"></i> ${t('create')}</button>
    </div>
    <p class="muted small" style="text-align:center"><i class="ph ph-link"></i> ${t('joinHint')}</p>
    ${langToggle()}
    <p style="text-align:center"><button class="link" data-act="signout">${t('signOut')}</button></p>
  </div></main>`;
}

/* ---------- join via invite ---------- */
function joinHTML() {
  const j = S.join || {};
  if (j.loading) return spinner();
  if (j.bad) return `<div class="screen"><div class="wrap" style="text-align:center"><div class="brand">${LOGO}</div>
    <p>${t('inviteBad')}</p><button class="btn" data-act="join-skip">OK</button></div></div>`;
  return `${demoBar()}<div class="screen"><div class="wrap"><div class="brand">${LOGO}<h1>${t('joinTitle')}</h1><p style="font-size:1.2rem;color:var(--ink);font-weight:700">${esc(j.inv.weddingName)}</p></div>
    <div class="card">
      <p style="margin:0 0 14px">${t('joinAs')}: <b>${t('roles')[j.inv.role]}</b>${j.inv.role === 'viewer' && j.inv.money ? ' · ' + t('seesMoney') : ''}</p>
      <div class="field"><label for="jn-me">${t('yourName')}</label><input class="inp" id="jn-me" placeholder="${esc(t('yourNamePh'))}" value="${esc(S.userDoc.name || S.loginName || '')}"></div>
      <div class="field"><label for="jn-pin">${t('familyPin')}</label>${numInp('jn-pin', 4, `value="${esc(S.pin || '')}" style="letter-spacing:.4em"`)}</div>
      <div class="err ${j.err ? '' : 'hidden'}" id="jn-err">${esc(j.err || '')}</div>
      <button class="btn block gold" data-act="join-go"><i class="ph ph-check"></i> ${t('join')}</button>
    </div>${langToggle()}</div></div>`;
}

/* ---------- main app shell ---------- */
function appHTML() {
  const chips = [];
  if (!navigator.onLine) chips.push(`<span class="chip grey"><i class="ph ph-wifi-slash"></i> ${t('offline')}</span>`);
  else if (Object.values(S.pend).some(Boolean)) chips.push(`<span class="chip" title="${esc(t('pendingSync'))}"><i class="ph ph-cloud-arrow-up"></i></span>`);
  if (S.me && !canEdit()) chips.push(`<span class="chip grey"><i class="ph ph-eye"></i> ${t('readOnly')}</span>`);
  const nav = [['home', 'house', t('navHome')], ['tasks', 'check-square', t('navTasks')], ['guests', 'users-three', t('navGuests')], ...(seesMoney() ? [['money', 'wallet', t('navMoney')]] : []), ['more', 'list', t('navMore')]];
  let body = '';
  if (!S.me || !S.wedding) body = `<div style="text-align:center;padding:60px 0"><span class="spin"></span></div>`;
  else if (S.view === 'money' && seesMoney()) body = moneyHTML();
  else if (S.view === 'more') body = moreHTML();
  else if (S.view === 'tasks') body = tasksHTML();
  else if (S.view === 'guests') body = guestsHTML();
  else body = installBanner() + homeHTML();
  return `${demoBar()}
  <header class="top"><div class="wrap"><h1>${esc(S.wedding?.name || '')}</h1>${chips.join('')}</div></header>
  <main><div class="wrap">${body}</div></main>
  ${fabHTML()}
  <nav class="nav"><div class="wrap">${nav.map(([v, ic, lb]) =>
    `<button data-act="view" data-v="${v}" class="${S.view === v ? 'on' : ''}"><i class="ph${S.view === v ? '-fill' : ''} ph-${ic}"></i>${lb}</button>`).join('')}</div></nav>`;
}

function fabHTML() {
  if (S.me && canEdit() && S.view === 'guests' && (S.guestTab !== 'shagun' || !seesMoney())) return `<button class="fab" data-act="add-guest"><i class="ph ph-plus"></i> ${t('addGuest')}</button>`;
  if (S.me && canEdit() && S.view === 'tasks' && tderive().fns.length) return `<button class="fab" data-act="add-task"><i class="ph ph-plus"></i> ${t('addTask')}</button>`;
  if (!S.me || !canEdit() || S.view !== 'money') return '';
  if (S.moneyTab === 'payments' || S.moneyTab === 'occasions') return `<button class="fab" data-act="add-pay"><i class="ph ph-plus"></i> ${t('addPayment')}</button>`;
  if (S.moneyTab === 'vendors') return `<button class="fab" data-act="add-vendor"><i class="ph ph-plus"></i> ${t('addVendor')}</button>`;
  return '';
}

/* ---------- home ---------- */
function heroHTML() {
  const w = S.wedding; let cd = '';
  if (w.date) { const n = daysUntil(w.date); cd = n > 0 ? t('daysLeft', n) : n === 0 ? t('today') : t('daysAgo', -n); }
  return `<div class="hero"><div class="nm">${esc(w.name)}</div>
    <div class="dt">${w.date ? fmtD(w.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : t('noDate')}</div>
    ${cd ? `<div class="cd"><i class="ph-fill ph-heart"></i> ${cd}</div>` : ''}</div>`;
}

function budgetBar(paid, due, budget) {
  const base = Math.max(budget, paid + due) || 1, over = budget && paid + due > budget;
  return `<div class="bar ${over ? 'over' : ''}"><span class="p" style="width:${paid / base * 100}%"></span><span class="d" style="width:${due / base * 100}%"></span></div>`;
}

function homeHTML() {
  if (!seesMoney()) return heroHTML() + fnStripHTML() + nextJobsHTML() + `<div class="card muted small">${t('noMoneyAccess')}</div>`;
  const d = derive(), est = d.paid + d.due;
  const tf = todayFn();
  return `${heroHTML()}${tf && canEdit() ? `<button class="big-btn primary" style="width:100%;margin-bottom:14px" data-act="add-shagun" data-dir="in"><i class="ph ph-arrow-down-left"></i>${t('addShagun')}<span class="small" style="font-weight:600">${esc(t('todayShagun', fnName(tf)))}</span></button>` : ''}${fnStripHTML()}
  <div class="stats">
    <div class="stat"><div class="lb">${t('totalPaid')}</div><div class="v">${inr(d.paid)}</div><div class="w">${words(d.paid)}</div></div>
    <div class="stat due"><div class="lb">${t('stillDue')}</div><div class="v">${inr(d.due)}</div><div class="w">${words(d.due)}</div></div>
    <button class="stat full" style="text-align:left" data-act="money-tab" data-v="budget">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div><div class="lb">${t('estTotal')}</div><div class="v">${inr(est)}</div></div>
        <div style="text-align:right"><div class="lb">${t('budget')}</div><div style="font-weight:700">${d.budget ? inr(d.budget) : `<span class="link">${t('noBudget')}</span>`}</div></div>
      </div>${budgetBar(d.paid, d.due, d.budget)}
      <div class="legend"><span><i style="background:var(--maroon)"></i>${t('legendPaid')}</span><span><i style="background:var(--due)"></i>${t('legendDue')}</span></div>
    </button>
  </div>
  ${canEdit() ? `<div class="actions">
    <button class="big-btn primary" data-act="add-pay"><i class="ph ph-hand-coins"></i>${t('actPaid')}</button>
    <button class="big-btn" data-act="add-vendor"><i class="ph ph-storefront"></i>${t('actVendor')}</button></div>` : ''}
  ${nextJobsHTML()}
  <div class="sec-h"><h2>${t('upcoming')}</h2>${d.dues.length > 4 ? `<button class="link" data-act="money-tab" data-v="vendors">${t('seeAll')}</button>` : ''}</div>
  ${d.dues.length ? `<div class="list">${d.dues.slice(0, 4).map(v => dueRow(v, d)).join('')}</div>` : `<div class="card empty">${t('nothingDue')}</div>`}
  <div class="sec-h"><h2>${t('recent')}</h2>${d.P.length > 5 ? `<button class="link" data-act="money-tab" data-v="payments">${t('seeAll')}</button>` : ''}</div>
  ${d.P.length ? `<div class="list">${[...d.P].sort(byDateDesc).slice(0, 5).map(p => payRow(p, d)).join('')}</div>` : `<div class="card empty">${t('noPayments')}</div>`}`;
}

const dueChip = v => {
  if (!v.dueDate) return '';
  const n = daysUntil(v.dueDate);
  return n < 0 ? `<span class="chip red">${t('overdue')} · ${fmtD(v.dueDate)}</span>`
    : `<span class="chip ${n <= 7 ? '' : 'grey'}">${t('dueOn', fmtD(v.dueDate))}</span>`;
};
function dueRow(v, d) {
  const c = d.cById[v.categoryId];
  return `<button class="row" data-act="vendor" data-id="${v.id}"><span class="ic gold"><i class="ph ph-${c?.icon || 'storefront'}"></i></span>
    <span class="mid"><div class="t">${esc(v.name)}</div><div class="s">${dueChip(v) || esc(catName(c))}</div></span>
    <span class="amt" style="color:var(--red)">${inr(d.vs[v.id].bal)}</span></button>`;
}
function payRow(p, d) {
  const v = d.vById[p.vendorId], c = d.cById[d.catOf(p)];
  const sub = [occName(p), v && v.name !== p.what ? v.name : p.paidTo || '', p.paidBy, t('modes')[p.mode]].filter(Boolean).join(' · ');
  return `<button class="row" data-act="pay" data-id="${p.id}"><span class="ic"><i class="ph ph-${c?.icon || 'tag'}"></i></span>
    <span class="mid"><div class="t">${esc(p.what || v?.name || '—')}${p.hasReceipt ? ' <i class="ph ph-paperclip muted"></i>' : ''}</div><div class="s">${esc(sub)}</div></span>
    <span class="amt">${inr(p.amount)}<div class="s">${fmtD(p.date)}</div></span></button>`;
}

/* ---------- money ---------- */
function moneyHTML() {
  const tabs = [['occasions', t('tabOcc')], ['payments', t('tabPayments')], ['vendors', t('tabVendors')], ['budget', t('tabBudget')]];
  const seg = `<div class="seg">${tabs.map(([v, lb]) => `<button data-act="money-tab" data-v="${v}" class="${S.moneyTab === v ? 'on' : ''}">${lb}</button>`).join('')}</div>`;
  const d = derive();
  if (S.moneyTab === 'occasions') return seg + occasionsHTML(d);
  if (S.moneyTab === 'vendors') return seg + vendorsHTML(d);
  if (S.moneyTab === 'budget') return seg + budgetHTML(d);
  const used = d.cats.filter(c => d.catPaid[c.id]);
  const occs = [...new Map(d.P.filter(occKey).map(p => [occKey(p), occName(p)])).entries()].filter(([, n]) => n);
  return `${seg}
    ${occs.length ? `<div class="filters"><button class="pill ${S.occ === 'all' ? 'on' : ''}" data-act="focc" data-id="all"><i class="ph ph-calendar-star"></i> ${t('allOcc')}</button>${occs.map(([k, n]) =>
      `<button class="pill ${S.occ === k ? 'on' : ''}" data-act="focc" data-id="${esc(k)}">${esc(n)}</button>`).join('')}</div>` : ''}
    ${used.length > 1 ? `<div class="filters"><button class="pill ${S.cat === 'all' ? 'on' : ''}" data-act="fcat" data-id="all">${t('allCats')}</button>${used.map(c =>
      `<button class="pill ${S.cat === c.id ? 'on' : ''}" data-act="fcat" data-id="${c.id}">${esc(catName(c))}</button>`).join('')}</div>` : ''}
    ${d.P.length > 6 ? `<label class="searchbox"><i class="ph ph-magnifying-glass muted"></i><input id="q" data-in="q" type="search" placeholder="${t('search')}" value="${esc(S.q)}"></label>` : ''}
    <div id="pay-list">${payListHTML(d)}</div>`;
}
function payListHTML(d) {
  if (!d.P.length) return `<div class="card empty">${t('noPayments')}</div>`;
  const q = S.q.trim().toLowerCase();
  const list = d.P.filter(p => (S.cat === 'all' || d.catOf(p) === S.cat) && (S.occ === 'all' || occKey(p) === S.occ) &&
    (!q || [p.what, d.vById[p.vendorId]?.name, p.paidTo, occName(p), p.paidBy, p.note, String(p.amount)].join(' ').toLowerCase().includes(q))).sort(byDateDesc);
  if (!list.length) return `<div class="card empty">${t('noMatch')}</div>`;
  const total = list.reduce((s, p) => s + (+p.amount || 0), 0);
  let html = `<div class="total-line"><span>${t('total')} (${list.length})</span><span>${inr(total)}</span></div><div class="list">`, last = '';
  list.forEach(p => {
    if (p.date !== last) { last = p.date; html += `<div class="day-h">${fmtD(p.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</div>`; }
    html += payRow(p, d);
  });
  return html + '</div>';
}

function vendorsHTML(d) {
  if (!d.V.length) return `<div class="card empty">${t('noVendors')}</div>`;
  const list = [...d.V].sort((a, b) => (d.vs[b.id].bal > 0) - (d.vs[a.id].bal > 0) ||
    (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || byName(a, b));
  return list.map(v => {
    const c = d.cById[v.categoryId], s = d.vs[v.id], ag = +v.agreed || 0;
    return `<button class="vcard" data-act="vendor" data-id="${v.id}">
      <div class="top-l"><span class="row" style="padding:0;border:0;width:auto"><span class="ic gold"><i class="ph ph-${c?.icon || 'storefront'}"></i></span></span>
        <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(v.name)}</div><div class="small muted">${esc(catName(c))}</div></div>
        ${s.bal > 0 ? dueChip(v) : ag ? `<span class="chip green"><i class="ph ph-check"></i> ${t('fullyPaid')}</span>` : ''}</div>
      ${ag ? budgetBar(s.paid, s.bal, ag).replace('class="bar', 'class="bar thin') : ''}
      <div class="nums"><span>${t('paid')}: <b>${inr(s.paid)}</b></span>${ag ? `<span>${t('balance')}: <b style="color:${s.bal ? 'var(--red)' : 'var(--green)'}">${inr(s.bal)}</b></span>` : `<span class="muted">${t('noAgreed')}</span>`}</div>
    </button>`;
  }).join('');
}

function budgetHTML(d) {
  const est = d.paid + d.due, B = d.budget, over = B && est > B;
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div><div class="lb muted small" style="font-weight:600">${t('totalBudget').replace(' (₹)', '')}</div>
        <div style="font-size:1.5rem;font-weight:800">${B ? inr(B) : '—'}</div><div class="small muted">${words(B)}</div></div>
      ${canEdit() ? `<button class="btn ghost sm" data-act="edit-budget"><i class="ph ph-pencil-simple"></i> ${B ? '' : t('setBudget')}</button>` : ''}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:12px;font-size:.9rem"><span>${t('estTotal')}</span><b>${inr(est)}</b></div>
    ${budgetBar(d.paid, d.due, B)}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
      <div class="legend" style="margin:0"><span><i style="background:var(--maroon)"></i>${t('legendPaid')} ${inr(d.paid)}</span><span><i style="background:var(--due)"></i>${t('legendDue')} ${inr(d.due)}</span></div>
      ${B ? `<b class="small" style="color:${over ? 'var(--red)' : 'var(--green)'}">${over ? t('overBy', inr(est - B)) : t('leftAmt', inr(B - est))}</b>` : ''}
    </div>
  </div>
  <p class="muted small" style="margin:0 4px 10px">${t('budgetHint')}</p>
  <div class="list">${d.cats.map(c => catRow(c, d)).join('')}</div>
  ${canEdit() ? `<button class="btn ghost block" data-act="add-cat">${t('addCategory')}</button>` : ''}`;
}
function catRow(c, d) {
  const paid = d.catPaid[c.id] || 0, due = d.catDue[c.id] || 0, pl = +c.planned || 0, over = pl && paid + due > pl;
  return `<button class="row" data-act="cat" data-id="${c.id}" style="flex-wrap:wrap;row-gap:0">
    <span class="ic gold"><i class="ph ph-${c.icon || 'tag'}"></i></span>
    <span class="mid"><div class="t">${esc(catName(c))}</div><div class="s">${inr(paid)}${due ? ` + ${inr(due)} ${t('legendDue')}` : ''}</div></span>
    <span class="amt">${pl ? inr(pl) : '<span class="muted">—</span>'}<div class="s">${pl ? (over ? `<span style="color:var(--red)">${t('overBy', inr(paid + due - pl))}</span>` : t('leftAmt', inr(pl - paid - due))) : t('planned')}</div></span>
    ${pl || paid || due ? `<div style="flex-basis:100%;padding-left:52px">${budgetBar(paid, due, pl).replace('class="bar', 'class="bar thin')}</div>` : ''}
  </button>`;
}

/* ---------- tasks (functions + to-do) ---------- */
const fnName = f => f ? (f.name || (S.lang === 'hi' ? f.hi || f.en : f.en || f.hi) || '') : t('noFn');
function tderive() {
  const fns = S.functions.filter(f => !f.deleted)
    // ritual order (roka → reception) unless both have dates
    .sort((a, b) => (a.date && b.date && a.date.localeCompare(b.date)) || (a.order ?? 99) - (b.order ?? 99));
  const fnById = Object.fromEntries(fns.map(f => [f.id, f]));
  // a deleted function hides its tasks too (restoring it brings them back)
  const gone = new Set(S.functions.filter(f => f.deleted).map(f => f.id));
  const T = S.tasks.filter(x => !x.deleted && !gone.has(x.fnId)).map(x => fnById[x.fnId] ? x : { ...x, fnId: '' });
  const byOrder = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.order || 0) - (b.order || 0);
  return { fns, fnById, T, byOrder };
}
const mine = x => !!S.me?.name && x.who === S.me.name;
const fnCountdown = f => f.date ? t('fnCount', daysUntil(f.date)) : t('noDateShort');

function fnStripHTML() {
  const { fns } = tderive(), up = fns.filter(f => !f.date || daysUntil(f.date) >= 0);
  if (!up.length) return '';
  return `<div class="fn-strip">${up.map(f => `<button class="fn-chip" data-act="view" data-v="tasks">
    <div class="n"><i class="ph ph-${f.icon || 'star'}"></i> ${esc(fnName(f))}</div>
    <div class="d">${f.date ? fmtD(f.date, { day: 'numeric', month: 'short' }) : '&nbsp;'}</div>
    <div class="c">${fnCountdown(f)}</div></button>`).join('')}</div>`;
}

function nextJobsHTML() {
  const { fns, fnById, T } = tderive();
  if (!fns.length) return canEdit() ? `<button class="card" style="display:flex;width:100%;align-items:center;gap:12px;text-align:left" data-act="view" data-v="tasks">
    <span class="ic-c"><i class="ph ph-check-square"></i></span><b style="flex:1">${t('setupTasksCta')}</b><i class="ph ph-caret-right muted"></i></button>` : '';
  const key = x => x.due || fnById[x.fnId]?.date || '9999';
  const open = T.filter(x => !x.done).sort((a, b) => key(a).localeCompare(key(b)) || (a.order || 0) - (b.order || 0));
  return `<div class="sec-h"><h2>${t('nextJobs')}</h2>${open.length > 5 ? `<button class="link" data-act="view" data-v="tasks">${t('seeAll')}</button>` : ''}</div>
    ${open.length ? `<div class="list">${open.slice(0, 5).map(x => taskRow(x, fnById, true)).join('')}</div>` : `<div class="card empty">${t('allJobsDone')}</div>`}`;
}

const taskDueChip = x => {
  if (!x.due || x.done) return '';
  const n = daysUntil(x.due);
  return n < 0 ? `<span class="chip red">${t('overdue')} · ${fmtD(x.due)}</span>` : `<span class="chip ${n <= 7 ? '' : 'grey'}">${t('dueOn', fmtD(x.due))}</span>`;
};
function taskRow(x, fnById, showFn) {
  const sub = [showFn && x.fnId ? esc(fnName(fnById[x.fnId])) : '', x.who ? `<i class="ph ph-user"></i> ${esc(x.who)}` : ''].filter(Boolean).join(' · ');
  const chipH = taskDueChip(x);
  const tick = canEdit()
    ? `<button class="tick ${x.done ? 'on' : ''}" data-act="tdone" data-id="${x.id}" aria-label="${esc(t('markDone'))}"><span>${x.done ? '<i class="ph ph-check"></i>' : ''}</span></button>`
    : `<span class="tick ${x.done ? 'on' : ''}"><span>${x.done ? '<i class="ph ph-check"></i>' : ''}</span></span>`;
  return `<div class="trow ${x.done ? 'done' : ''}">${tick}
    <button class="tmain" data-act="task" data-id="${x.id}"><div class="t">${esc(x.title)}</div>${sub || chipH ? `<div class="s">${chipH} ${sub}</div>` : ''}</button></div>`;
}

function tasksHTML() {
  const { fns, fnById, T, byOrder } = tderive();
  if (!fns.length) return setupHTML();
  const seg = `<div class="seg">${[['all', t('tasksAll')], ['mine', t('tasksMine')]].map(([v, lb]) =>
    `<button data-act="tfilter" data-v="${v}" class="${S.taskFilter === v ? 'on' : ''}">${lb}</button>`).join('')}</div>`;
  const list = S.taskFilter === 'mine' ? T.filter(mine) : T;
  if (S.taskFilter === 'mine' && !list.length) return seg + `<div class="card empty">${t('noMine')}</div>`;
  const groups = [...fns, ...(list.some(x => !x.fnId) || !S.functions.length ? [{ id: '' }] : [])];
  return seg + groups.map(f => {
    const all = list.filter(x => (x.fnId || '') === f.id).sort(byOrder);
    if (S.taskFilter === 'mine' && !all.length) return '';
    const open = all.filter(x => !x.done), done = all.filter(x => x.done), showD = !!S.showDone[f.id || '_'];
    const doneN = T.filter(x => (x.fnId || '') === f.id && x.done).length, totalN = T.filter(x => (x.fnId || '') === f.id).length;
    return `<div class="list">
      <button class="fn-h" data-act="${f.id && canEdit() ? 'fn' : 'noop'}" data-id="${f.id}">
        <span class="ic-c"><i class="ph ph-${f.icon || 'list-checks'}"></i></span>
        <span class="mid"><div class="t">${esc(fnName(f.id ? f : null))}</div>
          <div class="s">${f.id ? `${f.date ? fmtD(f.date, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' : ''}${fnCountdown(f)}` : ''}${totalN ? `${f.id ? ' · ' : ''}${t('progress', doneN, totalN)}` : ''}</div>
          ${totalN ? `<div class="prog"><span style="width:${doneN / totalN * 100}%"></span></div>` : ''}</span>
        ${f.id && canEdit() ? '<i class="ph ph-pencil-simple muted"></i>' : ''}</button>
      ${open.map(x => taskRow(x, fnById, false)).join('') || (done.length ? '' : `<div class="empty small" style="padding:14px">${t('noTasksFn')}</div>`)}
      ${done.length ? `<button class="add-row muted" data-act="show-done" data-id="${f.id || '_'}"><i class="ph ph-caret-${showD ? 'up' : 'down'}"></i> ${t('doneCount', done.length)}</button>` : ''}
      ${showD ? done.map(x => taskRow(x, fnById, false)).join('') : ''}
      ${canEdit() ? `<button class="add-row" data-act="add-task" data-fn="${f.id}">${t('addTaskHere')}</button>` : ''}
    </div>`;
  }).join('') + (canEdit() ? `<button class="btn ghost block" data-act="add-fn">${t('addFn')}</button>` : '');
}

function setupHTML() {
  if (!canEdit()) return `<div class="card empty">${t('setupViewer')}</div>`;
  if (!S.setupSel) S.setupSel = DEFAULT_FUNCTIONS.filter(f => f.on).map(f => f.id);
  return `<div class="card"><h2 style="margin:0 0 4px;font-size:1.1rem">${t('setupTitle')}</h2>
    <p class="muted small" style="margin:0 0 14px">${t('setupHint')}</p>
    <div class="chips">${DEFAULT_FUNCTIONS.map(f => `<button type="button" data-act="setup-pick" data-id="${f.id}" class="${S.setupSel.includes(f.id) ? 'on' : ''}">
      <i class="ph ph-${S.setupSel.includes(f.id) ? 'check-circle' : f.icon}"></i> ${esc(fnName(f))}</button>`).join('')}</div>
    <div class="err hidden" id="su-err"></div>
    <button class="btn gold block" data-act="setup-go" style="margin-top:16px"><i class="ph ph-list-checks"></i> ${t('setupGo')}</button></div>`;
}

// New function docs + their starter tasks. Re-adding a deleted starter function just restores it.
function fnOps(defs, startOrder) {
  const ops = [], now = Date.now();
  defs.forEach((f, i) => {
    const old = S.functions.find(x => x.id === f.id);
    if (old) { ops.push({ path: wpath('functions', f.id), data: { deleted: false, ...(f.date ? { date: f.date } : {}), ...stamp(false) } }); return; }
    ops.push({ path: wpath('functions', f.id), data: { en: f.en || '', hi: f.hi || '', ...(f.name ? { name: f.name } : {}), icon: f.icon || 'star', date: f.date || '', order: startOrder + i, ...stamp(true) } });
    (f.tasks || []).forEach((x, j) => ops.push({ path: wpath('tasks', newId()), data: {
      title: S.lang === 'en' ? x.en : x.hi, fnId: f.id, who: '', due: '', note: '', vendorId: null, done: false, order: now + i * 100 + j, ...stamp(true) } }));
  });
  return ops;
}
function setupGo() {
  if (!S.setupSel?.length) { const e = $('#su-err'); e.textContent = t('needOne'); e.classList.remove('hidden'); return; }
  const defs = DEFAULT_FUNCTIONS.filter(f => S.setupSel.includes(f.id))
    .map(f => f.id === 'shaadi' && S.wedding?.date ? { ...f, date: S.wedding.date } : f);
  const ops = fnOps(defs, 0);
  for (let i = 0; i < ops.length; i += 400) store.batch(ops.slice(i, i + 400)).catch(fail);
  S.setupSel = null; toast(t('saved'));
}

function toggleDone(id) {
  const x = S.tasks.find(y => y.id === id); if (!x) return;
  const done = !x.done;
  put(wpath('tasks', id), { done, doneAt: done ? Date.now() : null, doneBy: done ? (S.me?.name || '') : '', ...stamp(false) });
  if (done) toast(t('taskDone'), () => put(wpath('tasks', id), { done: false, doneAt: null, doneBy: '', ...stamp(false) }));
}

function taskSheet(x, presetFn) {
  const { fns, fnById } = tderive();
  const f = { fnId: x ? (fnById[x.fnId] ? x.fnId : '') : (presetFn || ''), who: x?.who || '' };
  const names = [...new Set([S.me?.name, ...S.members.map(m => m.name), ...S.tasks.map(y => y.who), x?.who].filter(Boolean))].slice(0, 12);
  const vendors = seesMoney() ? [...derive().V].sort(byName) : [];
  openSheet({
    html: () => `${sheetHead(x ? t('editTask') : t('addTask'))}
      <div class="field"><label for="t-title">${t('taskTitle')}</label><input class="inp" id="t-title" placeholder="${esc(t('taskTitlePh'))}" value="${esc(x?.title || '')}"><div class="err hidden" id="e-title"></div></div>
      <div class="field"><label>${t('fnLabel')}</label><div class="chips" data-group="fnId">${fns.map(fn => chip(fn.id, fnName(fn), f.fnId === fn.id)).join('')}${chip('', t('noFn'), !f.fnId)}</div></div>
      <div class="field"><label>${t('who')}</label>
        <div class="chips" data-group="who">${chip('', t('nobody'), !f.who)}${names.map(n => chip(n, n, f.who === n)).join('')}<button type="button" class="add" id="add-who">${t('addName')}</button></div>
        <input class="inp hidden" id="t-who" placeholder="${esc(t('needName'))}" style="margin-top:8px"></div>
      <div class="field"><label for="t-due">${t('dueBy')}</label><input class="inp" id="t-due" type="date" value="${x?.due || ''}"></div>
      ${vendors.length ? `<div class="field"><label for="t-vendor">${t('linkVendor')}</label><select class="inp" id="t-vendor"><option value="">${t('noVendor')}</option>${vendors.map(v =>
        `<option value="${v.id}" ${x?.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="t-note">${t('note')}</label><textarea class="inp" id="t-note" rows="2" placeholder="${esc(t('notePh'))}">${esc(x?.note || '')}</textarea></div>
      ${x ? `<label class="check"><input type="checkbox" id="t-done" ${x.done ? 'checked' : ''}> ${t('markDone')}</label>` : ''}
      ${x?.done && x.doneBy ? `<div class="small muted">${esc(t('doneBy', x.doneBy, x.doneAt ? fmtD(ymd(new Date(x.doneAt))) : ''))}</div>` : ''}
      <div class="btns">${x ? `<button class="btn danger" id="t-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="t-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      const whoInp = root.querySelector('#t-who');
      bindChips(root, f, g => { if (g === 'who') { whoInp.value = ''; whoInp.classList.add('hidden'); } });
      root.querySelector('#add-who').addEventListener('click', () => {
        whoInp.classList.remove('hidden'); whoInp.focus();
        root.querySelectorAll('[data-group=who] button[data-val]').forEach(b => b.classList.remove('on'));
      });
      if (!x) setTimeout(() => root.querySelector('#t-title').focus(), 250);
      root.querySelector('#t-save').addEventListener('click', () => {
        const title = root.querySelector('#t-title').value.trim();
        if (!title) return showErr(root, 'e-title', t('needTask'));
        const done = x ? root.querySelector('#t-done').checked : false;
        const data = {
          title, fnId: f.fnId || '', who: whoInp.value.trim() || f.who || '', due: root.querySelector('#t-due').value || '',
          note: root.querySelector('#t-note').value.trim(), done, ...stamp(!x),
        };
        const vs = root.querySelector('#t-vendor'); if (vs) data.vendorId = vs.value || null;
        if (!x) Object.assign(data, { order: Date.now(), vendorId: data.vendorId ?? null });
        if (done !== !!x?.done) Object.assign(data, { doneAt: done ? Date.now() : null, doneBy: done ? (S.me?.name || '') : '' });
        put(wpath('tasks', x ? x.id : newId()), data);
        closeSheet(); toast(t('saved'));
      });
      x && root.querySelector('#t-del').addEventListener('click', () => { closeSheet(); softDelete('tasks', x.id); });
    },
  });
}

function fnSheet(fn) {
  const used = new Set(S.functions.filter(x => !x.deleted).map(x => x.id));
  const choices = fn ? [] : DEFAULT_FUNCTIONS.filter(d => !used.has(d.id));
  const f = { pick: choices[0]?.id || 'other' };
  openSheet({
    html: () => `${sheetHead(fn ? t('editFn') : t('addFn').replace('+ ', ''))}
      ${fn ? '' : `<div class="field"><div class="chips" data-group="pick">${choices.map(d => chip(d.id, fnName(d), f.pick === d.id, d.icon)).join('')}${chip('other', t('fnOther'), f.pick === 'other', 'plus')}</div></div>`}
      <div class="field ${fn || f.pick === 'other' ? '' : 'hidden'}" id="fn-name-f"><label for="fn-name">${t('fnName')}</label><input class="inp" id="fn-name" value="${esc(fn ? fnName(fn) : '')}"><div class="err hidden" id="e-fname"></div></div>
      <div class="field"><label for="fn-date">${t('date')}</label><input class="inp" id="fn-date" type="date" value="${fn?.date || ''}"></div>
      <div class="btns">${fn ? `<button class="btn danger" id="fn-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="fn-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      bindChips(root, f, () => root.querySelector('#fn-name-f').classList.toggle('hidden', f.pick !== 'other'));
      root.querySelector('#fn-save').addEventListener('click', () => {
        const name = root.querySelector('#fn-name').value.trim(), date = root.querySelector('#fn-date').value || '';
        if (fn) {
          if (!name) return showErr(root, 'e-fname', t('needName'));
          put(wpath('functions', fn.id), { date, ...(name !== fnName(fn) ? { name } : {}), ...stamp(false) });
        } else if (f.pick === 'other') {
          if (!name) return showErr(root, 'e-fname', t('needName'));
          store.batch(fnOps([{ id: newId(), name, icon: 'star', date }], 50 + S.functions.length)).catch(fail);
        } else {
          store.batch(fnOps([{ ...DEFAULT_FUNCTIONS.find(d => d.id === f.pick), date }], 50 + S.functions.length)).catch(fail);
        }
        closeSheet(); toast(t('saved'));
      });
      fn && root.querySelector('#fn-del').addEventListener('click', () => { closeSheet(); softDelete('functions', fn.id); });
    },
  });
}

/* ---------- guests ---------- */
const ppl = g => (+g.adults || 0) + (+g.kids || 0);
const norm = s => String(s || '').trim().toLowerCase();
const canPickContacts = () => 'contacts' in navigator && navigator.contacts && 'select' in navigator.contacts;
const liveGuests = () => S.guests.filter(g => !g.deleted);
const groupList = extra => [...new Set([...t('groups'), ...liveGuests().map(g => g.group), extra].filter(Boolean))];
const defaultFns = () => { const { fns } = tderive(); return fns.some(f => f.id === 'shaadi') ? ['shaadi'] : fns.map(f => f.id); };
const rsvpChip = g => g.rsvp === 'yes' ? `<span class="chip green">${t('rsvpOpts').yes}</span>`
  : g.rsvp === 'no' ? `<span class="chip grey">${t('rsvpOpts').no}</span>` : `<span class="chip">${t('rsvpOpts').maybe}</span>`;

function guestsHTML() {
  const seg = seesMoney() ? `<div class="seg">${[['list', t('segGuests')], ['shagun', t('segShagun')]].map(([v, lb]) =>
    `<button data-act="gtab" data-v="${v}" class="${S.guestTab === v ? 'on' : ''}">${lb}</button>`).join('')}</div>` : '';
  if (S.guestTab === 'shagun' && seesMoney()) return seg + shagunHTML();
  const G = liveGuests(), { fns } = tderive();
  const pick = canEdit() && canPickContacts() ? `<button class="btn ghost block" data-act="pick-contacts" style="margin-bottom:14px"><i class="ph ph-address-book"></i> ${t('fromContacts')}</button>` : '';
  if (!G.length) return seg + `<div class="card empty">${t('noGuests')}</div>` + pick;
  const sum = a => a.reduce((s, g) => s + ppl(g), 0);
  const hc = fns.map(f => {
    const inv = G.filter(g => (g.fns || []).includes(f.id) && g.rsvp !== 'no');
    return { f, n: sum(inv), u: sum(inv.filter(g => g.rsvp !== 'yes')) };
  }).filter(x => x.n);
  const filters = [['all', t('allCats')], ['nocard', t('fNoCard')], ['unconf', t('fUnconf')], ['room', t('fRoom')]];
  return `${seg}
    <div class="stats">
      <div class="stat"><div class="lb">${t('statFamilies')}</div><div class="v">${G.length}</div></div>
      <div class="stat"><div class="lb">${t('statPeople')}</div><div class="v">${sum(G.filter(g => g.rsvp !== 'no'))}</div></div>
      <div class="stat"><div class="lb">${t('statComing')}</div><div class="v" style="color:var(--green)">${sum(G.filter(g => g.rsvp === 'yes'))}</div></div>
      <div class="stat"><div class="lb">${t('statRooms')}</div><div class="v">${G.filter(g => g.needsRoom && g.rsvp !== 'no').length}</div></div>
    </div>
    ${hc.length ? `<div class="sec-h" style="margin-top:8px"><h2>${t('headcount')}</h2></div><div class="list">${hc.map(({ f, n, u }) =>
      `<div class="row"><span class="ic"><i class="ph ph-${f.icon || 'star'}"></i></span><span class="mid"><div class="t">${esc(fnName(f))}</div><div class="s">${t('hcLine', n, u)}</div></span><span class="amt">${n}</span></div>`).join('')}</div>` : ''}
    ${pick}
    <div class="filters">${filters.map(([v, lb]) => `<button class="pill ${S.gFilter === v ? 'on' : ''}" data-act="gfilter" data-v="${v}">${lb}</button>`).join('')}</div>
    ${G.length > 6 ? `<label class="searchbox"><i class="ph ph-magnifying-glass muted"></i><input id="gq" data-in="gq" type="search" placeholder="${t('search')}" value="${esc(S.gq)}"></label>` : ''}
    <div id="guest-list">${guestListHTML()}</div>`;
}
function guestListHTML() {
  const q = norm(S.gq), F = S.gFilter;
  const list = liveGuests().filter(g => (F === 'all' || (F === 'nocard' && !g.card) || (F === 'unconf' && !g.rsvp) || (F === 'room' && g.needsRoom)) &&
    (!q || norm([g.name, g.phone, g.city, g.group, g.note].join(' ')).includes(q)));
  if (!list.length) return `<div class="card empty">${t('noMatch')}</div>`;
  const groups = {};
  list.forEach(g => (groups[g.group || ''] ||= []).push(g));
  const keys = Object.keys(groups).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  return `<div class="total-line"><span>${t('total')} (${list.length})</span><span>${t('peopleN', list.reduce((s, g) => s + ppl(g), 0))}</span></div><div class="list">` +
    keys.map(k => `<div class="day-h">${esc(k || t('noGroup'))} · ${groups[k].length}</div>` + groups[k].sort(byName).map(g =>
      `<button class="row" data-act="guest" data-id="${g.id}"><span class="avatar">${esc((g.name.trim()[0] || '?').toUpperCase())}</span>
        <span class="mid"><div class="t">${esc(g.name)}</div><div class="s">${[t('peopleN', ppl(g)), esc(g.city || ''), g.needsRoom ? '<i class="ph ph-bed"></i>' : '', g.card ? '<i class="ph ph-envelope-simple-open"></i>' : ''].filter(Boolean).join(' · ')}</div></span>
        ${rsvpChip(g)}</button>`).join('')).join('') + '</div>';
}

const stepper = (id, val) => `<div class="stepper"><button type="button" data-step="-1" data-for="${id}" aria-label="minus"><i class="ph ph-minus"></i></button>
  <input class="inp" id="${id}" inputmode="numeric" value="${val}"><button type="button" data-step="1" data-for="${id}" aria-label="plus"><i class="ph ph-plus"></i></button></div>`;
function bindSteppers(root) {
  root.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
    const inp = root.querySelector('#' + b.dataset.for); inp.value = Math.max(0, (+digits(inp.value) || 0) + +b.dataset.step);
  }));
}
function bindMulti(root) {
  root.querySelectorAll('.chips[data-multi]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button[data-val]'); if (b) b.classList.toggle('on');
  }));
}
const multiVal = (root, name) => [...root.querySelectorAll(`.chips[data-multi="${name}"] button.on`)].map(b => b.dataset.val);
const fnMultiChips = sel => { const { fns } = tderive(); return fns.length
  ? `<div class="field"><label>${t('invitedTo')}</label><div class="chips" data-multi="fns">${fns.map(f => chip(f.id, fnName(f), sel.includes(f.id))).join('')}</div></div>` : ''; };
// group picker: one chip per group + "new group" text box
const groupField = cur => `<div class="field"><label>${t('group')}</label>
  <div class="chips" data-group="group">${groupList(cur).map(n => chip(n, n, cur === n)).join('')}${chip('', t('noGroup'), !cur)}<button type="button" class="add" id="add-group">${t('addGroup')}</button></div>
  <input class="inp hidden" id="g-group" placeholder="${esc(t('groupPh'))}" style="margin-top:8px"></div>`;
function bindGroup(root, f) {
  const inp = root.querySelector('#g-group');
  bindChips(root, f, g => { if (g === 'group') { inp.value = ''; inp.classList.add('hidden'); } });
  root.querySelector('#add-group').addEventListener('click', () => {
    inp.classList.remove('hidden'); inp.focus();
    root.querySelectorAll('[data-group=group] button[data-val]').forEach(b => b.classList.remove('on'));
  });
  return () => inp.value.trim() || f.group || '';
}

function guestSheet(g) {
  const f = { group: g?.group || '', rsvp: g?.rsvp || '' };
  const contact = g?.phone ? `<div class="btns" style="margin:-6px 0 14px"><a class="btn ghost sm" href="tel:${esc(digits(g.phone))}"><i class="ph ph-phone"></i> ${t('call')}</a>
    <a class="btn ghost sm" href="https://wa.me/${waNum(g.phone)}" target="_blank" rel="noopener"><i class="ph ph-whatsapp-logo"></i> ${t('whatsapp')}</a></div>` : '';
  const ledger = g && seesMoney() ? `<div class="sec-h"><h2>${t('familyLedger')}</h2></div>${ledgerHTML(g.id, g.name)}
    ${canEdit() ? `<div class="btns" style="margin-top:0"><button class="btn gold sm" data-act="add-shagun" data-dir="in" data-guest="${g.id}"><i class="ph ph-arrow-down-left"></i> ${t('addShagun')}</button>
      <button class="btn ghost sm" data-act="add-shagun" data-dir="out" data-guest="${g.id}"><i class="ph ph-arrow-up-right"></i> ${t('addGiven')}</button></div>` : ''}` : '';
  if (!canEdit()) {
    const { fnById } = tderive();
    return openSheet({ live: true, html: () => `${sheetHead(g.name)}${contact}
      <div class="card small">${[g.group, t('peopleN', ppl(g)), g.city, g.needsRoom ? t('needsRoom') : '', (g.fns || []).map(id => fnName(fnById[id])).filter(Boolean).join(', ')].filter(Boolean).map(esc).join('<br>')}
      <div style="margin-top:8px">${rsvpChip(g)}</div>${g.note ? `<p style="margin:8px 0 0">${esc(g.note)}</p>` : ''}</div>${ledger}` });
  }
  openSheet({
    html: () => `${sheetHead(g ? t('editGuest') : t('addGuest'))}${contact}
      <div class="field"><label for="g-name">${t('guestName')}</label><input class="inp" id="g-name" placeholder="${esc(t('guestNamePh'))}" value="${esc(g?.name || '')}"><div class="err hidden" id="e-gname"></div></div>
      <div class="field"><label for="g-phone">${t('phone')}</label><input class="inp" id="g-phone" type="tel" inputmode="tel" value="${esc(g?.phone || '')}"></div>
      ${groupField(f.group)}
      <div class="field two"><div><label class="lbl" for="g-adults">${t('adults')}</label>${stepper('g-adults', g ? +g.adults || 0 : 2)}</div>
        <div><label class="lbl" for="g-kids">${t('kids')}</label>${stepper('g-kids', g ? +g.kids || 0 : 0)}</div></div>
      ${fnMultiChips(g ? g.fns || [] : defaultFns())}
      <div class="field"><label>${t('rsvp')}</label><div class="chips" data-group="rsvp">${chip('yes', t('rsvpOpts').yes, f.rsvp === 'yes')}${chip('no', t('rsvpOpts').no, f.rsvp === 'no')}${chip('', t('rsvpOpts').maybe, !f.rsvp)}</div></div>
      <label class="check"><input type="checkbox" id="g-card" ${g?.card ? 'checked' : ''}> ${t('cardSent')}</label>
      <div class="field" style="margin-top:8px"><label for="g-city">${t('city')}</label><input class="inp" id="g-city" value="${esc(g?.city || '')}"></div>
      <label class="check"><input type="checkbox" id="g-room" ${g?.needsRoom ? 'checked' : ''}> ${t('needsRoom')}</label>
      <div class="field" style="margin-top:8px"><label for="g-note">${t('note')}</label><textarea class="inp" id="g-note" rows="2" placeholder="${esc(t('notePh'))}">${esc(g?.note || '')}</textarea></div>
      <div class="btns">${g ? `<button class="btn danger" id="g-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="g-save"><i class="ph ph-check"></i> ${t('save')}</button></div>
      ${ledger}`,
    bind: root => {
      bindSteppers(root); bindMulti(root);
      const groupOf = bindGroup(root, f);
      if (!g) setTimeout(() => root.querySelector('#g-name').focus(), 250);
      root.querySelector('#g-save').addEventListener('click', () => {
        const name = root.querySelector('#g-name').value.trim();
        if (!name) return showErr(root, 'e-gname', t('needName'));
        put(wpath('guests', g ? g.id : newId()), {
          name, phone: root.querySelector('#g-phone').value.trim(), group: groupOf(),
          adults: +digits(root.querySelector('#g-adults').value) || 0, kids: +digits(root.querySelector('#g-kids').value) || 0,
          fns: tderive().fns.length ? multiVal(root, 'fns') : (g?.fns || []), rsvp: f.rsvp || '',
          card: root.querySelector('#g-card').checked, city: root.querySelector('#g-city').value.trim(),
          needsRoom: root.querySelector('#g-room').checked, note: root.querySelector('#g-note').value.trim(), ...stamp(!g),
        });
        closeSheet(); toast(t('saved'));
      });
      g && root.querySelector('#g-del').addEventListener('click', () => { closeSheet(); softDelete('guests', g.id); });
    },
  });
}

// Android Chrome contact picker → one household per contact (skips numbers already in the list)
async function pickContacts() {
  let cs;
  try { cs = await navigator.contacts.select(['name', 'tel'], { multiple: true }); } catch (e) { return; }
  if (!cs || !cs.length) return;
  const have = new Set(liveGuests().map(g => cleanPhone(g.phone)).filter(Boolean));
  const fresh = []; let skipped = 0;
  cs.forEach(c => {
    const name = ((c.name || [])[0] || '').trim(), phone = cleanPhone((c.tel || [])[0] || '');
    if (phone && have.has(phone)) { skipped++; return; }
    if (name || phone) { fresh.push({ name: name || phone, phone }); if (phone) have.add(phone); }
  });
  if (!fresh.length) { toast(t('importSkipped', skipped)); return; }
  importSheet(fresh, skipped);
}
function importSheet(list, skipped) {
  const f = { group: '' };
  openSheet({
    html: () => `${sheetHead(t('importTitle', list.length))}
      <p class="small muted" style="margin:-6px 0 12px">${list.slice(0, 8).map(c => esc(c.name)).join(', ')}${list.length > 8 ? ' …' : ''}</p>
      ${skipped ? `<p class="small" style="margin:0 0 12px">${t('importSkipped', skipped)}</p>` : ''}
      ${groupField('')}
      <div class="field"><label class="lbl" for="i-ppl">${t('importPeople')}</label>${stepper('i-ppl', 2)}</div>
      ${fnMultiChips(defaultFns())}
      <button class="btn gold block" id="i-save"><i class="ph ph-check"></i> ${t('addedN', list.length).replace(/^\d+ /, '')} (${list.length})</button>`,
    bind: root => {
      bindSteppers(root); bindMulti(root);
      const groupOf = bindGroup(root, f);
      root.querySelector('#i-save').addEventListener('click', () => {
        const n = +digits(root.querySelector('#i-ppl').value) || 1, group = groupOf(), fns = multiVal(root, 'fns');
        const ops = list.map(c => ({ path: wpath('guests', newId()), data: {
          name: c.name, phone: c.phone, group, adults: n, kids: 0, fns, rsvp: '', card: false, city: '', needsRoom: false, note: '', ...stamp(true) } }));
        for (let i = 0; i < ops.length; i += 400) store.batch(ops.slice(i, i + 400)).catch(fail);
        closeSheet(); toast(t('addedN', list.length));
      });
    },
  });
}

/* ---------- shagun / lena-dena ---------- */
const liveShagun = () => S.shagun.filter(x => !x.deleted);
const sumAmt = a => a.reduce((s, x) => s + (+x.amount || 0), 0);
function shRow(x, fnById) {
  const isIn = x.dir !== 'out';
  const what = x.kind && x.kind !== 'cash' ? (x.item || t('kinds')[x.kind]) : '';
  const when = x.fnId && fnById[x.fnId] ? fnName(fnById[x.fnId]) : (x.date ? fmtD(x.date, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  return `<button class="row" data-act="sh" data-id="${x.id}"><span class="ic ${isIn ? 'green' : ''}"><i class="ph ph-arrow-${isIn ? 'down-left' : 'up-right'}"></i></span>
    <span class="mid"><div class="t">${esc(x.name)}</div><div class="s">${esc([when, what].filter(Boolean).join(' · '))}</div></span>
    <span class="amt" style="color:${isIn ? 'var(--green)' : 'var(--maroon)'}">${x.amount ? (isIn ? '+' : '−') + inr(x.amount) : '<i class="ph ph-gift"></i>'}</span></button>`;
}
function ledgerHTML(guestId, name) {
  const { fnById } = tderive(), n = norm(name);
  const E = liveShagun().filter(x => (guestId && x.guestId === guestId) || (n && norm(x.name) === n))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  if (!E.length) return `<div class="card empty">${t('ledgerNone')}</div>`;
  const tin = sumAmt(E.filter(x => x.dir !== 'out')), tout = sumAmt(E.filter(x => x.dir === 'out'));
  return `<div class="total-line"><span style="color:var(--green)">${t('segIn')} ${inr(tin)}</span><span style="color:var(--maroon)">${t('segOut')} ${inr(tout)}</span></div>
    <div class="list">${E.map(x => shRow(x, fnById)).join('')}</div>`;
}
function shagunHTML() {
  const E = liveShagun(), { fns, fnById } = tderive();
  const IN = E.filter(x => x.dir !== 'out'), OUT = E.filter(x => x.dir === 'out');
  const perFn = [...fns, { id: '' }].map(f => ({ f, a: sumAmt(IN.filter(x => (fnById[x.fnId] ? x.fnId : '') === f.id)), n: IN.filter(x => (fnById[x.fnId] ? x.fnId : '') === f.id).length })).filter(x => x.n);
  return `${canEdit() ? `<div class="actions">
      <button class="big-btn primary" data-act="add-shagun" data-dir="in"><i class="ph ph-arrow-down-left"></i>${t('addShagun')}</button>
      <button class="big-btn" data-act="add-shagun" data-dir="out"><i class="ph ph-arrow-up-right"></i>${t('addGiven')}</button></div>` : ''}
    <div class="stats" style="margin-top:12px">
      <div class="stat"><div class="lb">${t('segIn')} (${IN.length})</div><div class="v" style="color:var(--green)">${inr(sumAmt(IN))}</div><div class="w">${words(sumAmt(IN))}</div></div>
      <div class="stat"><div class="lb">${t('segOut')} (${OUT.length})</div><div class="v" style="color:var(--maroon)">${inr(sumAmt(OUT))}</div><div class="w">${words(sumAmt(OUT))}</div></div>
    </div>
    ${perFn.length > 1 ? `<div class="list">${perFn.map(({ f, a, n }) => `<div class="row"><span class="mid"><div class="t">${esc(f.id ? fnName(f) : t('otherOccasion'))}</div><div class="s">${n}</div></span><span class="amt" style="color:var(--green)">${inr(a)}</span></div>`).join('')}</div>` : ''}
    ${E.length ? `<div class="filters">${[['all', t('allCats')], ['in', t('segIn')], ['out', t('segOut')]].map(([v, lb]) =>
      `<button class="pill ${S.shDir === v ? 'on' : ''}" data-act="shdir" data-v="${v}">${lb}</button>`).join('')}</div>
    ${E.length > 6 ? `<label class="searchbox"><i class="ph ph-magnifying-glass muted"></i><input id="shq" data-in="shq" type="search" placeholder="${t('search')}" value="${esc(S.shq)}"></label>` : ''}` : ''}
    <div id="sh-list">${shListHTML()}</div>`;
}
function shListHTML() {
  const E = liveShagun(), { fnById } = tderive(), q = norm(S.shq);
  if (!E.length) return `<div class="card empty">${t('noShagun')}</div>`;
  const list = E.filter(x => (S.shDir === 'all' || (S.shDir === 'out') === (x.dir === 'out')) &&
    (!q || norm([x.name, x.item, x.note, String(x.amount || '')].join(' ')).includes(q)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!list.length) return `<div class="card empty">${t('noMatch')}</div>`;
  return `<div class="list">${list.map(x => shRow(x, fnById)).join('')}</div>`;
}
const todayFn = () => tderive().fns.find(f => f.date === todayStr());

function shagunSheet(x, opts = {}) {
  const { fns } = tderive();
  const g0 = opts.guestId ? S.guests.find(g => g.id === opts.guestId) : null;
  const lastFn = LS.get('sp.shfn', '');
  const f = {
    dir: x?.dir || opts.dir || 'in', kind: x?.kind || 'cash',
    fnId: x ? (fns.some(y => y.id === x.fnId) ? x.fnId : '') : (todayFn()?.id || (fns.some(y => y.id === lastFn) ? lastFn : '')),
  };
  const names = [...new Set([...liveGuests().map(g => g.name), ...liveShagun().map(y => y.name)].filter(Boolean))];
  openSheet({
    html: () => `${sheetHead(x ? t('editShagun') : f.dir === 'out' ? t('addGiven') : t('addShagun'))}
      <div class="seg" data-dirseg>${[['in', t('segIn')], ['out', t('segOut')]].map(([v, lb]) => `<button type="button" data-dir="${v}" class="${f.dir === v ? 'on' : ''}">${lb}</button>`).join('')}</div>
      <div class="field"><label for="s-name" id="s-name-l">${f.dir === 'out' ? t('toWhom') : t('fromWhom')}</label>
        <input class="inp" id="s-name" list="s-names" autocomplete="off" placeholder="${esc(t('guestNamePh'))}" value="${esc(x?.name || g0?.name || '')}">
        <datalist id="s-names">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist><div class="err hidden" id="e-sname"></div></div>
      <div class="field"><label>${t('kind')}</label><div class="chips" data-group="kind">${['cash', 'item', 'clothes'].map(k => chip(k, t('kinds')[k], f.kind === k)).join('')}</div></div>
      <div class="field ${f.kind === 'cash' ? 'hidden' : ''}" id="s-item-f"><label for="s-item">${t('itemWhat')}</label><input class="inp" id="s-item" placeholder="${esc(t('itemPh'))}" value="${esc(x?.item || '')}"></div>
      <div class="field"><label for="s-amt" id="s-amt-l">${f.kind === 'cash' ? t('amount') : t('valueOpt')}</label>
        <input class="inp amt-inp" id="s-amt" inputmode="numeric" autocomplete="off" placeholder="0" value="${x?.amount ? Math.round(x.amount) : ''}"><div class="amt-words" id="s-words"></div><div class="err hidden" id="e-samt"></div></div>
      <div class="field"><label>${t('occasion')}</label><div class="chips" data-group="fnId">${fns.map(y => chip(y.id, fnName(y), f.fnId === y.id)).join('')}${chip('', t('otherOccasion'), !f.fnId)}</div></div>
      <details class="more" ${x && (x.note || (x.date && x.date !== todayStr())) ? 'open' : ''}><summary><i class="ph ph-caret-down"></i> ${t('moreDetails')}</summary>
        <div class="field"><label for="s-date">${t('date')}</label><input class="inp" type="date" id="s-date" value="${x?.date || todayStr()}"></div>
        <div class="field"><label for="s-note">${t('note')}</label><textarea class="inp" id="s-note" rows="2" placeholder="${esc(t('notePh'))}">${esc(x?.note || '')}</textarea></div></details>
      <div class="btns">${x ? `<button class="btn danger" id="s-del"><i class="ph ph-trash"></i> ${t('delete')}</button>`
        : `<button class="btn ghost" id="s-next"><i class="ph ph-plus"></i> ${t('saveNext')}</button>`}
        <button class="btn gold" id="s-save"><i class="ph ph-check"></i> ${t('save')}</button></div>
      ${x ? `<div class="sec-h"><h2>${t('familyLedger')}</h2></div>${ledgerHTML(x.guestId, x.name)}` : ''}`,
    bind: root => {
      bindAmount(root, '#s-amt', '#s-words');
      bindChips(root, f, g => {
        if (g !== 'kind') return;
        root.querySelector('#s-item-f').classList.toggle('hidden', f.kind === 'cash');
        root.querySelector('#s-amt-l').textContent = f.kind === 'cash' ? t('amount') : t('valueOpt');
      });
      root.querySelector('[data-dirseg]').addEventListener('click', e => {
        const b = e.target.closest('button[data-dir]'); if (!b) return;
        f.dir = b.dataset.dir;
        root.querySelectorAll('[data-dirseg] button').forEach(y => y.classList.toggle('on', y === b));
        root.querySelector('#s-name-l').textContent = f.dir === 'out' ? t('toWhom') : t('fromWhom');
        root.querySelector('.sh-h h3').textContent = x ? t('editShagun') : f.dir === 'out' ? t('addGiven') : t('addShagun');
      });
      const nameInp = root.querySelector('#s-name');
      if (!x) setTimeout(() => (g0 ? root.querySelector('#s-amt') : nameInp).focus(), 250);
      const save = () => {
        const name = nameInp.value.trim(), amount = +digits(root.querySelector('#s-amt').value) || 0;
        const item = f.kind === 'cash' ? '' : root.querySelector('#s-item').value.trim();
        if (!name) { showErr(root, 'e-sname', t('needName')); return false; }
        if (!amount && !item) { showErr(root, 'e-samt', t('needItem')); return false; }
        const g = (g0 && norm(g0.name) === norm(name)) ? g0 : liveGuests().find(y => norm(y.name) === norm(name));
        put(wpath('shagun', x ? x.id : newId()), {
          dir: f.dir, name, guestId: g ? g.id : (x?.guestId && norm(x.name) === norm(name) ? x.guestId : null),
          kind: f.kind, amount, item, fnId: f.fnId || '', date: root.querySelector('#s-date').value || todayStr(),
          note: root.querySelector('#s-note').value.trim(), ...stamp(!x),
        });
        LS.set('sp.shfn', f.fnId || '');
        return true;
      };
      root.querySelector('#s-save').addEventListener('click', () => { if (save()) { closeSheet(); toast(t('saved')); } });
      x ? root.querySelector('#s-del').addEventListener('click', () => { closeSheet(); softDelete('shagun', x.id); })
        : root.querySelector('#s-next').addEventListener('click', () => {
          if (!save()) return;
          toast(t('saved'));
          ['#s-name', '#s-amt', '#s-item', '#s-note'].forEach(s => { root.querySelector(s).value = ''; });
          root.querySelector('#s-words').textContent = '';
          root.querySelectorAll('.err').forEach(e => e.classList.add('hidden'));
          nameInp.focus();
        });
    },
  });
}

/* ---------- more ---------- */
function moreHTML() {
  const order = { owner: 0, editor: 1, viewer: 2 };
  const ms = [...S.members].sort((a, b) => order[a.role] - order[b.role] || (a.joinedAt || 0) - (b.joinedAt || 0));
  const w = S.wedding, ws = myWeddings();
  return `<div class="sec-h" style="margin-top:4px"><h2>${t('family')}</h2></div>
  <div class="list">${ms.map(memberRow).join('')}</div>
  ${isOwner() ? `<button class="btn block gold" data-act="invite"><i class="ph ph-user-plus"></i> ${t('invite')}</button>` : ''}
  <div class="sec-h"><h2>${t('weddingDetails')}</h2></div>
  <div class="list">
    ${isOwner() && S.famPin ? `<div class="menu-row"><i class="ph ph-key"></i>${t('familyPinRow')}<span class="r" style="font-weight:800;letter-spacing:.2em;color:var(--ink)">${esc(S.famPin)}</span></div>` : ''}
    <button class="menu-row" data-act="${isOwner() ? 'edit-wedding' : 'noop'}"><i class="ph ph-heart"></i>${esc(w.name)}<span class="r">${w.date ? fmtD(w.date, { day: 'numeric', month: 'short', year: 'numeric' }) : ''} ${isOwner() ? '<i class="ph ph-caret-right" style="font-size:1rem;color:var(--muted)"></i>' : ''}</span></button>
    <div class="menu-row"><i class="ph ph-translate"></i>${t('language')}<span class="r">${langToggle().replace('lang-toggle', 'lang-toggle" style="margin:0')}</span></div>
    ${seesMoney() ? `<button class="menu-row" data-act="export" data-v="payments"><i class="ph ph-download-simple"></i>${t('exportCsv')}</button>` : ''}
    ${liveGuests().length ? `<button class="menu-row" data-act="export" data-v="guests"><i class="ph ph-download-simple"></i>${t('exportGuests')}</button>` : ''}
    ${seesMoney() && liveShagun().length ? `<button class="menu-row" data-act="export" data-v="shagun"><i class="ph ph-download-simple"></i>${t('exportShagun')}</button>` : ''}
    ${canEdit() ? `<button class="menu-row" data-act="trash"><i class="ph ph-trash"></i>${t('trash')}</button>` : ''}
    ${ws.length > 1 ? `<button class="menu-row" data-act="switch"><i class="ph ph-swap"></i>${t('switchWedding')}</button>` : ''}
    ${!isStandalone() ? `<button class="menu-row" data-act="install"><i class="ph ph-download-simple"></i>${t('installTitle')}</button>` : ''}
    <button class="menu-row" data-act="new-wedding"><i class="ph ph-plus-circle"></i>${t('newWedding')}</button>
    <button class="menu-row" data-act="signout"><i class="ph ph-sign-out"></i>${t('signOut')}<span class="r">${esc(S.user?.phone || '')}</span></button>
    ${S.demo ? `<button class="menu-row" data-act="reset-demo"><i class="ph ph-arrow-counter-clockwise"></i>${t('resetDemo')}</button>` : ''}
  </div>
  <p class="muted small" style="text-align:center">${t('appName')} · v1 ${S.demo ? '· demo' : ''}</p>`;
}
function memberRow(m) {
  const me = m.id === S.user.uid, r = m.role;
  const acts = isOwner() && !me ? `<div class="acts">
      ${r === 'viewer'
        ? `<button class="btn ghost sm" data-act="mrole" data-id="${m.id}" data-v="editor">${t('makeEditor')}</button>
           <button class="btn ghost sm" data-act="mmoney" data-id="${m.id}"><i class="ph ph-${m.money ? 'check-square' : 'square'}"></i> ${t('seesMoney')}</button>`
        : `<button class="btn ghost sm" data-act="mrole" data-id="${m.id}" data-v="viewer">${t('makeViewer')}</button>`}
      <button class="btn danger sm" data-act="mremove" data-id="${m.id}">${t('remove')}</button></div>` : '';
  return `<div class="member"><div class="avatar">${esc(((m.name || m.phone || '?').trim()[0] || '?').toUpperCase())}</div>
    <div class="mid"><div style="font-weight:700">${esc(m.name || m.phone)} ${me ? `<span class="muted small">(${t('you')})</span>` : ''}</div>
    <div class="small muted">${t('roles')[r]}${r === 'viewer' && m.money ? ' · ' + t('seesMoney') : ''}${m.phone && isOwner() ? ' · ' + esc(m.phone) : ''}</div>${acts}</div></div>`;
}

/* ============================== forms ============================== */
const chip = (val, label, on, icon) =>
  `<button type="button" data-val="${esc(val)}" class="${on ? 'on' : ''}">${icon ? `<i class="ph ph-${icon}"></i> ` : ''}${esc(label)}</button>`;

// Chip groups: <div class="chips" data-group="x"> … one selected at a time, value goes to f.x
function bindChips(root, f, onPick) {
  root.querySelectorAll('.chips[data-group]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button[data-val]'); if (!b) return;
    f[g.dataset.group] = b.dataset.val;
    g.querySelectorAll('button[data-val]').forEach(x => x.classList.toggle('on', x === b));
    onPick && onPick(g.dataset.group, b.dataset.val);
  }));
}
function bindAmount(root, inputSel, wordsSel) {
  const inp = root.querySelector(inputSel), out = root.querySelector(wordsSel);
  const upd = () => { const n = +digits(inp.value); out.textContent = n ? [inr(n), words(n)].filter(Boolean).join(' · ') : ''; };
  inp.addEventListener('input', () => { const c = digits(inp.value); if (c !== inp.value) inp.value = c; upd(); });
  upd();
}
const showErr = (root, id, msg) => { const e = root.querySelector('#' + id); e.textContent = msg; e.classList.remove('hidden'); };

/* ---------- payment ---------- */
// A payment's occasion is a wedding function (fnId) or any other occasion typed once (occasion), e.g. Diwali gifts.
// Own occasions (Diwali gifts, Bhaat…) live in weddings/{wid}/occasions and payments point at them by occId.
const occKey = p => p.fnId ? 'fn:' + p.fnId : p.occId ? 'oc:' + p.occId : p.occasion ? 'o:' + p.occasion : '';
const occName = p => {
  if (p.fnId) { const f = S.functions.find(x => x.id === p.fnId); if (f) return fnName(f); }
  if (p.occId) { const o = S.occasions.find(x => x.id === p.occId); if (o) return o.name; }
  return p.occasion || '';
};
// Every live occasion, in order: wedding functions (ritual order), then own occasions by date.
function occList() {
  const { fns } = tderive();
  const own = S.occasions.filter(o => !o.deleted).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  return [...fns.map(f => ({ key: 'fn:' + f.id, name: fnName(f), date: f.date || '', icon: f.icon || 'star' })),
    ...own.map(o => ({ key: 'oc:' + o.id, name: o.name, date: o.date || '', icon: 'calendar-star', own: o }))];
}
const occLabel = k => !k ? t('noOccasion') : (occList().find(o => o.key === k)?.name || (k.startsWith('o:') ? k.slice(2) : t('noOccasion')));
// payments grouped by occasion; payments of a deleted occasion fall under "none in particular"
function occTotals(d) {
  const live = new Set(occList().map(o => o.key)), by = {};
  d.P.forEach(p => { let k = occKey(p); if (k && !live.has(k) && !k.startsWith('o:')) k = ''; (by[k] ||= []).push(p); });
  return by;
}

function occasionsHTML(d) {
  const by = occTotals(d), list = occList();
  const legacy = Object.keys(by).filter(k => k.startsWith('o:')).map(k => ({ key: k, name: k.slice(2), date: '', icon: 'calendar-star' }));
  const cards = [...list, ...legacy, ...(by[''] ? [{ key: '', name: t('noOccasion'), date: '', icon: 'dots-three-circle' }] : [])];
  if (!cards.length) return `<div class="card empty">${t('noOccYet')}</div>${canEdit() ? `<button class="btn ghost block" data-act="occ-new">${t('newOccasion')}</button>` : ''}`;
  return cards.map(o => {
    const ps = by[o.key] || [], tot = ps.reduce((s, p) => s + (+p.amount || 0), 0);
    return `<button class="vcard occ-card" data-act="occ-open" data-k="${esc(o.key)}">
      <div class="top-l"><span class="ic-c"><i class="ph ph-${o.icon}"></i></span>
        <div style="flex:1;min-width:0"><div style="font-weight:700">${esc(o.name)}</div>
          <div class="small muted">${[o.date ? fmtD(o.date, { day: 'numeric', month: 'short' }) : '', t('payN', ps.length)].filter(Boolean).join(' · ')}</div></div>
        <div style="text-align:right"><div style="font-weight:800;font-size:1.1rem">${inr(tot)}</div><div class="small muted">${words(tot)}</div></div></div>
    </button>`;
  }).join('') + (canEdit() ? `<button class="btn ghost block" data-act="occ-new">${t('newOccasion')}</button>` : '');
}

// One occasion's screen (live): total, split by category, its payments, and "paid money" pre-set to it.
function occDetail(key) {
  openSheet({
    live: true,
    html: () => {
      const d = derive(), ps = (occTotals(d)[key] || []).sort(byDateDesc), o = occList().find(x => x.key === key);
      const tot = ps.reduce((s, p) => s + (+p.amount || 0), 0), byCat = {};
      ps.forEach(p => { const c = d.catOf(p); byCat[c] = (byCat[c] || 0) + (+p.amount || 0); });
      const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      return `${sheetHead(occLabel(key), o?.own && canEdit() ? `<button class="x" data-act="occ-edit" data-id="${o.own.id}" aria-label="edit"><i class="ph ph-pencil-simple"></i></button>` : '')}
        ${o?.date ? `<div class="muted small" style="margin:-8px 0 12px">${fmtD(o.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>` : ''}
        <div class="stats">
          <div class="stat full"><div class="lb">${t('totalPaid')} · ${t('payN', ps.length)}</div><div class="v">${inr(tot)}</div><div class="w">${words(tot)}</div></div>
        </div>
        ${canEdit() ? `<button class="big-btn primary" style="width:100%;min-height:72px;flex-direction:row;gap:10px;margin-bottom:6px" data-act="add-pay" data-occ="${esc(key)}"><i class="ph ph-hand-coins"></i>${t('actPaid')}</button>` : ''}
        ${cats.length > 1 ? `<div class="sec-h"><h2>${t('byCategory')}</h2></div><div class="list">${cats.map(([c, a]) => {
          const cc = d.cById[c]; return `<div class="row"><span class="ic gold"><i class="ph ph-${cc?.icon || 'tag'}"></i></span><span class="mid"><div class="t">${esc(catName(cc) || t('noGroup'))}</div></span><span class="amt">${inr(a)}</span></div>`; }).join('')}</div>` : ''}
        <div class="sec-h"><h2>${t('tabPayments')}</h2></div>
        ${ps.length ? `<div class="list">${ps.map(p => payRow(p, d)).join('')}</div>` : `<div class="card empty">${t('noOccPays')}</div>`}`;
    },
  });
}

function occSheet(o) {
  openSheet({
    html: () => `${sheetHead(o ? t('editOcc') : t('newOccasion').replace('+ ', ''))}
      <div class="field"><label for="o-name">${t('occNameLbl')}</label><input class="inp" id="o-name" placeholder="${esc(t('occasionPh'))}" value="${esc(o?.name || '')}"><div class="err hidden" id="e-oname"></div></div>
      <div class="field"><label for="o-date">${t('date')}</label><input class="inp" id="o-date" type="date" value="${o?.date || ''}"></div>
      <div class="btns">${o ? `<button class="btn danger" id="o-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="o-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      if (!o) setTimeout(() => root.querySelector('#o-name').focus(), 250);
      root.querySelector('#o-save').addEventListener('click', () => {
        const name = root.querySelector('#o-name').value.trim();
        if (!name) return showErr(root, 'e-oname', t('needName'));
        const id = o ? o.id : newId();
        put(wpath('occasions', id), { name, date: root.querySelector('#o-date').value || '', ...stamp(!o) });
        closeSheet(); toast(t('saved'));
        if (!o) setTimeout(() => occDetail('oc:' + id), 350);
      });
      o && root.querySelector('#o-del').addEventListener('click', () => { history.go(-2); softDelete('occasions', o.id); });
    },
  });
}

// Phone photos are 3–10 MB; shrink to a readable JPEG that fits in one Firestore document (max 1 MB).
function compressImage(file, max = 1400, q = 0.62) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      const draw = sc => { const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', q); };
      let sc = Math.min(1, max / Math.max(w, h)), out = draw(sc);
      while (out.length > 700000 && sc > 0.15) { sc *= 0.75; out = draw(sc); }
      res(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
    img.src = url;
  });
}
function receiptView(pid) {
  const st = { img: '' };
  openSheet({
    html: () => `${sheetHead(t('receipt'))}${st.img ? `<img src="${st.img}" alt="" style="width:100%;border-radius:14px;display:block">` : `<div style="text-align:center;padding:40px 0"><span class="spin"></span></div>`}`,
    bind: () => { if (!st.img) store.get(wpath('receipts', pid)).then(r => { st.img = r?.img || ''; if (st.img) drawSheet(); }).catch(() => {}); },
  });
}

function paymentSheet(p, presetVendor, presetOcc) {
  const d = derive(), tf = todayFn(), occs = occList();
  const f = {
    vendorId: p ? p.vendorId || (p.paidTo ? '__other' : '') : presetVendor || '',
    categoryId: p?.categoryId || (presetVendor && d.vById[presetVendor]?.categoryId) || 'other',
    paidBy: p?.paidBy || S.me?.name || '',
    mode: p?.mode || LS.get('sp.mode', 'cash'),
    occ: p ? occKey(p) : presetOcc !== undefined ? presetOcc : (tf ? 'fn:' + tf.id : ''),
    img: '', hadImg: !!p?.hasReceipt, removed: false, loading: !!p?.hasReceipt,
  };
  const payers = [...new Set([S.me?.name, ...S.members.map(m => m.name),
    ...[...d.P].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(x => x.paidBy), p?.paidBy].filter(Boolean))].slice(0, 10);
  const vendors = [...d.V].sort(byName);
  if (p?.vendorId && !vendors.find(v => v.id === p.vendorId) && d.vById[p.vendorId]) vendors.push(d.vById[p.vendorId]);
  const recent = [...d.P].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const purposes = [...new Set(recent.map(x => x.what).filter(w => w && !d.V.some(v => v.name === w)))].slice(0, 8);
  const rcHTML = () => f.img || (f.hadImg && !f.removed && f.loading)
    ? (f.img ? `<div class="rc"><img src="${f.img}" alt="" id="rc-img"><div class="btns" style="margin-top:8px">
        <button type="button" class="btn ghost sm" id="rc-change"><i class="ph ph-camera"></i> ${t('changeReceipt')}</button>
        <button type="button" class="btn danger sm" id="rc-remove"><i class="ph ph-trash"></i> ${t('removeReceipt')}</button></div></div>`
      : `<div class="small muted"><span class="spin" style="width:16px;height:16px;vertical-align:-3px"></span> ${t('loading')}</div>`)
    : `<button type="button" class="btn ghost block" id="rc-add"><i class="ph ph-camera"></i> ${t('addReceipt')}</button>`;

  openSheet({
    html: () => `${sheetHead(p ? t('editPayment') : t('addPayment'))}
      <div class="field"><label for="f-amount">${t('amount')}</label>
        <input class="inp amt-inp" id="f-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${p ? Math.round(p.amount) : ''}">
        <div class="amt-words" id="f-words"></div><div class="err hidden" id="e-amount"></div></div>
      <div class="field"><label for="f-what">${t('whatFor')}</label>
        <input class="inp" id="f-what" placeholder="${esc(t('whatForPh'))}" value="${esc(p?.what || '')}"><div class="err hidden" id="e-what"></div>
        ${purposes.length ? `<div class="chips mini" style="margin-top:8px">${purposes.map(w => `<button type="button" data-fill="${esc(w)}">${esc(w)}</button>`).join('')}</div>` : ''}</div>
      <div class="field"><div class="occ-line"><i class="ph ph-calendar-star"></i> ${t('occLine')}: <b id="occ-cur">${esc(occLabel(f.occ))}</b>
          <button type="button" class="link" id="occ-change">${t('changeReceipt')}</button></div>
        <div class="hidden" id="occ-pick" style="margin-top:10px"><div class="chips" data-group="occ">${chip('', t('noOccasion'), !f.occ)}${occs.map(o => chip(o.key, o.name, f.occ === o.key)).join('')}${f.occ.startsWith('o:') ? chip(f.occ, f.occ.slice(2), true) : ''}<button type="button" class="add" id="add-occ">${t('newOccasion')}</button></div>
        <input class="inp hidden" id="f-occ" placeholder="${esc(t('occasionPh'))}" style="margin-top:8px"></div></div>
      <div class="field" id="cat-field"><label>${t('category')}</label>
        <div class="chips" data-group="categoryId">${d.cats.map(c => chip(c.id, catName(c), f.categoryId === c.id)).join('')}</div></div>
      <div class="field"><label for="f-vendor">${t('paidTo')}</label>
        <select class="inp" id="f-vendor"><option value="">${t('noVendor')}</option>${vendors.map(v =>
          `<option value="${v.id}" ${f.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}<option value="__other" ${f.vendorId === '__other' ? 'selected' : ''}>${t('paidToOther')}</option><option value="__new">${t('newVendorInline')}</option></select>
        <input class="inp hidden" id="f-paidto" placeholder="${esc(t('paidToPh'))}" value="${esc(p?.paidTo || '')}" style="margin-top:8px">
        <input class="inp hidden" id="f-newvendor" placeholder="${esc(t('vendorNamePh'))}" style="margin-top:8px">
        <div class="err hidden" id="e-vendor"></div></div>
      <div class="field"><label>${t('paidBy')}</label>
        <div class="chips" data-group="paidBy">${payers.map(n => chip(n, n, f.paidBy === n)).join('')}<button type="button" class="add" id="add-payer">${t('addName')}</button></div>
        <input class="inp hidden" id="f-payer" placeholder="${esc(t('addNamePrompt'))}" style="margin-top:8px"></div>
      <div class="field"><label>${t('mode')}</label>
        <div class="chips" data-group="mode">${MODES.map(m => chip(m, t('modes')[m], f.mode === m, MODE_IC[m])).join('')}</div></div>
      <div class="field"><label>${t('receipt')}</label><div id="rc-box">${rcHTML()}</div>
        <input type="file" accept="image/*" id="f-photo" class="hidden"><div class="err hidden" id="e-photo"></div></div>
      <details class="more" ${p && (p.note || p.date !== todayStr()) ? 'open' : ''}><summary><i class="ph ph-caret-down"></i> ${t('moreDetails')}</summary>
        <div class="field"><label for="f-date">${t('date')}</label><input class="inp" type="date" id="f-date" value="${p?.date || todayStr()}"></div>
        <div class="field"><label for="f-note">${t('note')}</label><textarea class="inp" id="f-note" rows="2" placeholder="${esc(t('notePh'))}">${esc(p?.note || '')}</textarea></div>
      </details>
      ${p ? `<div class="small muted">${esc(t('enteredBy', p.createdByName || '—', p.createdAt ? fmtD(ymd(new Date(p.createdAt)), { day: 'numeric', month: 'short', year: 'numeric' }) : ''))}</div>` : ''}
      <div class="btns">${p ? `<button class="btn danger" id="f-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="f-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      bindAmount(root, '#f-amount', '#f-words');
      const sel = root.querySelector('#f-vendor'), nv = root.querySelector('#f-newvendor'), pt = root.querySelector('#f-paidto');
      const payerInp = root.querySelector('#f-payer'), occInp = root.querySelector('#f-occ'), what = root.querySelector('#f-what');
      const syncVendor = () => {
        const v = sel.value, known = !!v && !v.startsWith('__');
        nv.classList.toggle('hidden', v !== '__new');
        pt.classList.toggle('hidden', v !== '__other');
        root.querySelector('#cat-field').classList.toggle('hidden', known);    // a saved vendor already has its category
        if (v === '__new') nv.focus(); else if (v === '__other' && !pt.value) pt.focus();
      };
      sel.addEventListener('change', syncVendor); syncVendor();
      root.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => { what.value = b.dataset.fill; root.querySelector('#e-what').classList.add('hidden'); }));
      bindChips(root, f, g => {
        if (g === 'paidBy') { payerInp.value = ''; payerInp.classList.add('hidden'); }
        if (g === 'occ') { occInp.value = ''; occInp.classList.add('hidden'); root.querySelector('#occ-cur').textContent = occLabel(f.occ); }
      });
      root.querySelector('#add-payer').addEventListener('click', () => {
        payerInp.classList.remove('hidden'); payerInp.focus();
        root.querySelectorAll('[data-group=paidBy] button[data-val]').forEach(x => x.classList.remove('on'));
      });
      root.querySelector('#occ-change').addEventListener('click', e => { root.querySelector('#occ-pick').classList.remove('hidden'); e.currentTarget.classList.add('hidden'); });
      occInp.addEventListener('input', () => { root.querySelector('#occ-cur').textContent = occInp.value.trim() || occLabel(f.occ); });
      root.querySelector('#add-occ').addEventListener('click', () => {
        occInp.classList.remove('hidden'); occInp.focus();
        root.querySelectorAll('[data-group=occ] button[data-val]').forEach(x => x.classList.remove('on'));
      });
      // receipt photo: camera or gallery (the phone offers both), shrunk before saving
      const photo = root.querySelector('#f-photo'), box = root.querySelector('#rc-box');
      const drawRc = () => {
        box.innerHTML = rcHTML();
        box.querySelector('#rc-add')?.addEventListener('click', () => photo.click());
        box.querySelector('#rc-change')?.addEventListener('click', () => photo.click());
        box.querySelector('#rc-remove')?.addEventListener('click', () => { f.img = ''; f.removed = true; drawRc(); });
        box.querySelector('#rc-img')?.addEventListener('click', () => openSheet({ html: () => `${sheetHead(t('receipt'))}<img src="${f.img}" alt="" style="width:100%;border-radius:14px;display:block">` }));
      };
      photo.addEventListener('change', async () => {
        const file = photo.files && photo.files[0]; photo.value = '';
        if (!file) return;
        try { f.img = await compressImage(file); f.changed = true; f.removed = false; root.querySelector('#e-photo').classList.add('hidden'); }
        catch (e) { showErr(root, 'e-photo', t('photoErr')); }
        drawRc();
      });
      drawRc();
      if (f.hadImg) store.get(wpath('receipts', p.id)).then(r => { if (!f.img && !f.removed) { f.img = r?.img || ''; f.loading = false; drawRc(); } })
        .catch(() => { f.loading = false; drawRc(); });
      if (!p) setTimeout(() => root.querySelector('#f-amount').focus(), 250);

      root.querySelector('#f-save').addEventListener('click', () => {
        const amount = +digits(root.querySelector('#f-amount').value);
        if (!amount) return showErr(root, 'e-amount', t('needAmount'));
        let vendorId = sel.value, ops = [], paidTo = '';
        if (vendorId === '__new') {
          const name = nv.value.trim();
          if (!name) return showErr(root, 'e-vendor', t('needName'));
          vendorId = newId();
          ops.push({ path: wpath('vendors', vendorId), data: { name, categoryId: f.categoryId, agreed: 0, phone: '', dueDate: '', note: '', ...stamp(true) } });
        } else if (vendorId === '__other') { paidTo = pt.value.trim(); vendorId = ''; }
        const vName = vendorId ? (d.vById[vendorId]?.name || nv.value.trim()) : '';
        const purpose = what.value.trim() || vName;
        if (!purpose) return showErr(root, 'e-what', t('needWhat'));
        // a newly typed occasion becomes its own occasion card (weddings/{wid}/occasions)
        const typedOcc = occInp.value.trim();
        let occ = f.occ || '';
        if (typedOcc) {
          const same = occList().find(o => norm(o.name) === norm(typedOcc));
          if (same) occ = same.key;
          else { const oid = newId(); ops.push({ path: wpath('occasions', oid), data: { name: typedOcc, date: '', ...stamp(true) } }); occ = 'oc:' + oid; }
        }
        const id = p ? p.id : newId();
        const data = {
          amount, what: purpose, vendorId: vendorId || null, paidTo,
          fnId: occ.startsWith('fn:') ? occ.slice(3) : '', occId: occ.startsWith('oc:') ? occ.slice(3) : '', occasion: occ.startsWith('o:') ? occ.slice(2) : '',
          categoryId: vendorId && d.vById[vendorId] ? d.vById[vendorId].categoryId || 'other' : f.categoryId || 'other',
          paidBy: payerInp.value.trim() || f.paidBy, mode: f.mode, date: root.querySelector('#f-date').value || todayStr(),
          note: root.querySelector('#f-note').value.trim(), ...stamp(!p),
        };
        if (f.changed && f.img) {            // new or replaced photo; an unchanged one is not re-uploaded
          ops.push({ path: wpath('receipts', id), data: { img: f.img, ...stamp(true) }, merge: false });
          data.hasReceipt = true;
        } else if (f.removed && f.hadImg) { ops.push({ path: wpath('receipts', id), del: true }); data.hasReceipt = false; }
        ops.push({ path: wpath('payments', id), data });
        LS.set('sp.mode', f.mode);
        store.batch(ops).catch(fail);
        closeSheet(); toast(t('saved'));
      });
      p && root.querySelector('#f-del').addEventListener('click', () => { closeSheet(); softDelete('payments', p.id); });
    },
  });
}

/* ---------- vendor form ---------- */
function vendorSheet(v) {
  const d = derive(), f = { categoryId: v?.categoryId || 'decor' };
  openSheet({
    html: () => `${sheetHead(v ? t('editVendor') : t('addVendor'))}
      <div class="field"><label for="v-name">${t('vendorName')}</label><input class="inp" id="v-name" placeholder="${esc(t('vendorNamePh'))}" value="${esc(v?.name || '')}"><div class="err hidden" id="e-vname"></div></div>
      <div class="field"><label>${t('category')}</label><div class="chips" data-group="categoryId">${d.cats.map(c => chip(c.id, catName(c), f.categoryId === c.id)).join('')}</div></div>
      <div class="field"><label for="v-agreed">${t('agreed')}</label><input class="inp" id="v-agreed" inputmode="numeric" autocomplete="off" placeholder="0" value="${v?.agreed ? Math.round(v.agreed) : ''}">
        <div class="amt-words" id="v-words"></div><div class="hint">${t('agreedHint')}</div></div>
      <div class="field"><label for="v-phone">${t('phone')}</label><input class="inp" id="v-phone" type="tel" inputmode="tel" value="${esc(v?.phone || '')}"></div>
      <div class="field"><label for="v-due">${t('nextDue')}</label><input class="inp" id="v-due" type="date" value="${v?.dueDate || ''}"></div>
      <div class="field"><label for="v-note">${t('note')}</label><textarea class="inp" id="v-note" rows="2" placeholder="${esc(t('notePh'))}">${esc(v?.note || '')}</textarea></div>
      <div class="btns">${v ? `<button class="btn danger" id="v-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="v-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      bindAmount(root, '#v-agreed', '#v-words');
      bindChips(root, f);
      if (!v) setTimeout(() => root.querySelector('#v-name').focus(), 250);
      root.querySelector('#v-save').addEventListener('click', () => {
        const name = root.querySelector('#v-name').value.trim();
        if (!name) return showErr(root, 'e-vname', t('needName'));
        put(wpath('vendors', v ? v.id : newId()), {
          name, categoryId: f.categoryId, agreed: +digits(root.querySelector('#v-agreed').value) || 0,
          phone: root.querySelector('#v-phone').value.trim(), dueDate: root.querySelector('#v-due').value || '',
          note: root.querySelector('#v-note').value.trim(), ...stamp(!v),
        });
        closeSheet(); toast(t('saved'));
      });
      v && root.querySelector('#v-del').addEventListener('click', () => { history.go(-2); softDelete('vendors', v.id); });
    },
  });
}

/* ---------- vendor detail (live) ---------- */
const waNum = ph => { const n = digits(ph); return n.length === 10 ? '91' + n : n; };
function vendorDetail(vid) {
  openSheet({
    live: true,
    html: () => {
      const d = derive(), v = d.vById[vid];
      if (!v || v.deleted) return sheetHead('') + `<div class="empty">—</div>`;
      const s = d.vs[vid] || { paid: 0, bal: 0 }, c = d.cById[v.categoryId], ag = +v.agreed || 0;
      const pays = d.P.filter(p => p.vendorId === vid).sort(byDateDesc);
      return `${sheetHead(v.name, canEdit() ? `<button class="x" data-act="edit-vendor" data-id="${vid}" aria-label="edit"><i class="ph ph-pencil-simple"></i></button>` : '')}
        <div style="margin:-8px 0 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted small">${esc(catName(c))}</span>${s.bal > 0 ? dueChip(v) : ''}</div>
        <div class="stats">
          <div class="stat"><div class="lb">${t('paid')}</div><div class="v">${inr(s.paid)}</div><div class="w">${words(s.paid)}</div></div>
          <div class="stat due"><div class="lb">${t('balance')}</div><div class="v">${ag ? inr(s.bal) : '—'}</div><div class="w">${ag ? t('agreed').replace(' (₹)', '') + ': ' + inr(ag) : t('noAgreed')}</div></div>
        </div>
        ${ag ? budgetBar(s.paid, s.bal, ag) : ''}
        ${v.note ? `<p class="small" style="background:#fff;border-radius:12px;padding:10px 12px;margin:12px 0 0">${esc(v.note)}</p>` : ''}
        <div class="btns" style="flex-wrap:wrap">
          ${v.phone ? `<a class="btn ghost" href="tel:${esc(digits(v.phone))}"><i class="ph ph-phone"></i> ${t('call')}</a>
            <a class="btn ghost" href="https://wa.me/${waNum(v.phone)}" target="_blank" rel="noopener"><i class="ph ph-whatsapp-logo"></i> ${t('whatsapp')}</a>` : ''}
          ${canEdit() ? `<button class="btn gold block" data-act="pay-vendor" data-id="${vid}"><i class="ph ph-hand-coins"></i> ${t('payThisVendor')}</button>` : ''}
        </div>
        <div class="sec-h"><h2>${t('paymentsMade')}</h2></div>
        ${pays.length ? `<div class="list">${pays.map(p => payRow(p, d)).join('')}</div>` : `<div class="card empty">${t('noVendorPayments')}</div>`}`;
    },
  });
}

/* ---------- budget & categories ---------- */
function budgetSheet() {
  openSheet({
    html: () => `${sheetHead(t('setBudget'))}
      <div class="field"><label for="b-amt">${t('totalBudget')}</label><input class="inp amt-inp" id="b-amt" inputmode="numeric" placeholder="0" value="${S.wedding.budget ? Math.round(S.wedding.budget) : ''}"><div class="amt-words" id="b-words"></div></div>
      <button class="btn gold block" id="b-save"><i class="ph ph-check"></i> ${t('save')}</button>`,
    bind: root => {
      bindAmount(root, '#b-amt', '#b-words');
      setTimeout(() => root.querySelector('#b-amt').focus(), 250);
      root.querySelector('#b-save').addEventListener('click', () => {
        put(`weddings/${S.wid}`, { budget: +digits(root.querySelector('#b-amt').value) || 0, updatedAt: Date.now() });
        closeSheet(); toast(t('saved'));
      });
    },
  });
}
function categorySheet(c) {
  const isDefault = c && DEFAULT_CATEGORIES.some(x => x.id === c.id);
  openSheet({
    html: () => `${sheetHead(c ? t('editCategory') : t('addCategory').replace('+ ', ''))}
      <div class="field"><label for="c-name">${t('categoryName')}</label><input class="inp" id="c-name" value="${esc(catName(c))}"><div class="err hidden" id="e-cname"></div></div>
      <div class="field"><label for="c-amt">${t('plannedAmt')}</label><input class="inp amt-inp" id="c-amt" inputmode="numeric" placeholder="0" value="${c?.planned ? Math.round(c.planned) : ''}"><div class="amt-words" id="c-words"></div></div>
      <div class="btns">${c && !isDefault ? `<button class="btn danger" id="c-del"><i class="ph ph-trash"></i> ${t('delete')}</button>` : ''}
        <button class="btn gold" id="c-save"><i class="ph ph-check"></i> ${t('save')}</button></div>`,
    bind: root => {
      bindAmount(root, '#c-amt', '#c-words');
      setTimeout(() => root.querySelector(c ? '#c-amt' : '#c-name').focus(), 250);
      root.querySelector('#c-save').addEventListener('click', () => {
        const name = root.querySelector('#c-name').value.trim();
        if (!name) return showErr(root, 'e-cname', t('needName'));
        const planned = +digits(root.querySelector('#c-amt').value) || 0;
        const data = { planned, ...stamp(!c) };
        if (!c) Object.assign(data, { name, icon: 'tag', order: 100 + S.categories.length });
        else if (name !== catName(c)) data.name = name;     // renaming a starter category overrides both languages
        put(wpath('categories', c ? c.id : newId()), data);
        closeSheet(); toast(t('saved'));
      });
      c && !isDefault && root.querySelector('#c-del').addEventListener('click', () => { closeSheet(); softDelete('categories', c.id); });
    },
  });
}

/* ---------- wedding details ---------- */
function weddingSheet() {
  const w = S.wedding;
  openSheet({
    html: () => `${sheetHead(t('weddingDetails'))}
      <div class="field"><label for="w-name">${t('weddingName')}</label><input class="inp" id="w-name" value="${esc(w.name)}"><div class="err hidden" id="e-wname"></div></div>
      <div class="field"><label for="w-date">${t('weddingDate')}</label><input class="inp" id="w-date" type="date" value="${w.date || ''}"></div>
      <button class="btn gold block" id="w-save"><i class="ph ph-check"></i> ${t('save')}</button>`,
    bind: root => root.querySelector('#w-save').addEventListener('click', () => {
      const name = root.querySelector('#w-name').value.trim();
      if (!name) return showErr(root, 'e-wname', t('needName'));
      put(`weddings/${S.wid}`, { name, date: root.querySelector('#w-date').value || '', updatedAt: Date.now() });
      put(`users/${S.user.uid}`, { weddings: { [S.wid]: { name, role: role() } } });
      S.userDoc.weddings = { ...(S.userDoc.weddings || {}), [S.wid]: { name, role: role() } };
      closeSheet(); toast(t('saved'));
    }),
  });
}

/* ---------- invite ---------- */
function inviteSheet() {
  const f = { role: 'editor', money: false, link: '' };
  openSheet({
    html: () => f.link ? `${sheetHead(t('invite'))}
        <p style="margin:0">${t('inviteReady')}</p><div class="linkbox" id="i-link">${esc(f.link)}</div>
        ${S.famPin ? `<p class="small" style="margin:0 0 12px"><i class="ph ph-key"></i> ${t('pinShareHint', esc(S.famPin))}</p>` : ''}
        <a class="btn block gold" href="https://wa.me/?text=${encodeURIComponent(t('inviteMsg', S.wedding.name, f.link))}" target="_blank" rel="noopener"><i class="ph ph-whatsapp-logo"></i> ${t('shareWA')}</a>
        <div class="btns"><button class="btn ghost" id="i-copy"><i class="ph ph-copy"></i> ${t('copy')}</button></div>`
      : `${sheetHead(t('invite'))}
        <div class="field"><label>${t('inviteRole')}</label>
          <div class="chips" data-group="role">${chip('editor', t('roleHelp').editor, true, 'pencil-simple')}${chip('viewer', t('roleHelp').viewer, false, 'eye')}</div></div>
        <label class="check hidden" id="i-money-row"><input type="checkbox" id="i-money"> ${t('seesMoney')}</label>
        <div class="err hidden" id="e-inv"></div>
        <button class="btn gold block" id="i-make" style="margin-top:12px"><i class="ph ph-link"></i> ${t('makeLink')}</button>`,
    bind: root => {
      if (f.link) {
        root.querySelector('#i-copy').addEventListener('click', async e => {
          try { await navigator.clipboard.writeText(f.link); } catch (err) {
            const r = document.createRange(); r.selectNodeContents(root.querySelector('#i-link'));
            const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy');
          }
          e.currentTarget.innerHTML = `<i class="ph ph-check"></i> ${t('copied')}`;
        });
        return;
      }
      bindChips(root, f, (g, v) => root.querySelector('#i-money-row').classList.toggle('hidden', v !== 'viewer'));
      root.querySelector('#i-make').addEventListener('click', async e => {
        if (!navigator.onLine) return showErr(root, 'e-inv', t('offline'));
        e.currentTarget.disabled = true;
        const code = newId(18), now = Date.now();
        try {
          await store.set('invites/' + code, {
            weddingId: S.wid, weddingName: S.wedding.name, role: f.role,
            money: f.role === 'editor' ? true : root.querySelector('#i-money').checked,
            createdBy: S.user.uid, createdAt: now, expiresAt: store.ts(now + 14 * 864e5),
          }, false);
          f.link = location.origin + location.pathname + location.search + '#join=' + code;
          drawSheet();
        } catch (err) { fail(err); e.currentTarget.disabled = false; }
      });
    },
  });
}

/* ---------- recently deleted (live) ---------- */
function trashSheet() {
  openSheet({
    live: true,
    html: () => {
      const items = [
        ...S.payments.filter(x => x.deleted).map(x => ({ col: 'payments', id: x.id, icon: 'hand-coins', title: x.what, sub: inr(x.amount), at: x.deletedAt })),
        ...S.vendors.filter(x => x.deleted).map(x => ({ col: 'vendors', id: x.id, icon: 'storefront', title: x.name, sub: t('vendor'), at: x.deletedAt })),
        ...S.categories.filter(x => x.deleted).map(x => ({ col: 'categories', id: x.id, icon: 'tag', title: catName(x), sub: t('category'), at: x.deletedAt })),
        ...S.occasions.filter(x => x.deleted).map(x => ({ col: 'occasions', id: x.id, icon: 'calendar-star', title: x.name, sub: t('tabOcc'), at: x.deletedAt })),
        ...S.guests.filter(x => x.deleted).map(x => ({ col: 'guests', id: x.id, icon: 'users-three', title: x.name, sub: t('navGuests'), at: x.deletedAt })),
        ...S.shagun.filter(x => x.deleted).map(x => ({ col: 'shagun', id: x.id, icon: 'gift', title: x.name, sub: t('segShagun') + (x.amount ? ' · ' + inr(x.amount) : ''), at: x.deletedAt })),
        ...S.tasks.filter(x => x.deleted).map(x => ({ col: 'tasks', id: x.id, icon: 'check-square', title: x.title, sub: t('navTasks'), at: x.deletedAt })),
        ...S.functions.filter(x => x.deleted).map(x => ({ col: 'functions', id: x.id, icon: x.icon || 'star', title: fnName(x), sub: t('fnName'), at: x.deletedAt })),
      ].sort((a, b) => (b.at || 0) - (a.at || 0));
      return sheetHead(t('trash')) + (items.length ? `<div class="list">${items.map(i => `<div class="row"><span class="ic"><i class="ph ph-${i.icon}"></i></span>
        <span class="mid"><div class="t">${esc(i.title)}</div><div class="s">${esc(i.sub)}</div></span>
        <button class="btn ghost sm" data-act="restore" data-col="${i.col}" data-id="${i.id}">${t('restore')}</button></div>`).join('')}</div>`
        : `<div class="card empty">${t('trashEmpty')}</div>`);
    },
  });
}

/* ---------- switch wedding ---------- */
function switchSheet() {
  openSheet({
    html: () => sheetHead(t('switchWedding')) + `<div class="list">${myWeddings().map(w =>
      `<button class="row" data-act="open-wedding" data-id="${w.id}"><span class="ic"><i class="ph ph-heart"></i></span><span class="mid"><div class="t">${esc(w.name)}</div><div class="s">${t('roles')[w.role] || ''}</div></span>${w.id === S.wid ? '<i class="ph-fill ph-check-circle" style="color:var(--green)"></i>' : ''}</button>`).join('')}</div>`,
  });
}

/* ---------- CSV export ---------- */
function exportCsv() {
  const d = derive();
  const rows = [['Date', 'Purpose', 'Occasion', 'Paid to', 'Category', 'Amount', 'Paid by', 'Mode', 'Receipt photo', 'Note', 'Added by']];
  [...d.P].sort(byDateDesc).forEach(p => rows.push([p.date, p.what, occName(p), d.vById[p.vendorId]?.name || p.paidTo || '', catName(d.cById[d.catOf(p)]),
    p.amount, p.paidBy, STR.en.modes[p.mode] || p.mode, p.hasReceipt ? 'Yes' : '', p.note, p.createdByName]));
  rows.push([], ['Vendor', 'Category', 'Agreed', 'Paid', 'Balance', 'Next due', 'Phone']);
  [...d.V].sort(byName).forEach(v => rows.push([v.name, catName(d.cById[v.categoryId]), v.agreed || 0, d.vs[v.id].paid, d.vs[v.id].bal, v.dueDate, v.phone]));
  downloadCsv(rows, '');
}
function downloadCsv(rows, suffix) {
  const cell = x => { x = String(x ?? ''); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');   // BOM so Excel reads Hindi correctly
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${(S.wedding.name || 'wedding').replace(/[^\wऀ-ॿ]+/g, '-')}${suffix}-${todayStr()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
}
function exportGuests() {
  const { fns, fnById } = tderive(), R = STR.en.rsvpOpts;
  const rows = [['Name', 'Phone', 'Group', 'Adults', 'Children', 'City', 'Needs room', 'Card sent', 'Coming', ...fns.map(f => fnName(f)), 'Note']];
  [...liveGuests()].sort((a, b) => (a.group || '').localeCompare(b.group || '') || byName(a, b)).forEach(g => rows.push([g.name, g.phone, g.group, g.adults || 0, g.kids || 0, g.city,
    g.needsRoom ? 'Yes' : '', g.card ? 'Yes' : '', g.rsvp === 'yes' ? R.yes : g.rsvp === 'no' ? R.no : R.maybe, ...fns.map(f => (g.fns || []).includes(f.id) ? 'Yes' : ''), g.note]));
  downloadCsv(rows, '-guests');
}
function exportShagun() {
  const { fnById } = tderive();
  const rows = [['Date', 'Received / Given', 'Name', 'Function', 'What', 'Item', 'Amount', 'Note', 'Added by']];
  [...liveShagun()].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0)).forEach(x => rows.push([x.date,
    x.dir === 'out' ? 'Given' : 'Received', x.name, x.fnId && fnById[x.fnId] ? fnName(fnById[x.fnId]) : 'Other', STR.en.kinds[x.kind] || x.kind, x.item, x.amount || '', x.note, x.createdByName]));
  downloadCsv(rows, '-shagun');
}

/* ============================== actions ============================== */
const ACT = {
  noop() {},
  reload() { location.reload(); },
  scrim(el, e) { if (e.target === el && sheets[sheets.length - 1]?.live) closeSheet(); },
  close() { closeSheet(); },
  'pick-lang'(el) { setLang(el.dataset.v); start(); },
  lang(el) { setLang(el.dataset.v); },
  async login(el) {
    const name = $('#li-name').value.trim(), phone = cleanPhone($('#li-phone').value), pin = digits($('#li-pin').value);
    const err = m => { const e = $('#li-err'); e.textContent = m; e.classList.remove('hidden'); };
    if (!name) return err(t('needName'));
    if (phone.length !== 10) return err(t('needPhone'));
    if (pin.length !== 4) return err(t('needPin'));
    const label = el.innerHTML; el.disabled = true; el.textContent = t('signingIn');
    Object.assign(S, { pin, loginName: name, loginErr: '' });
    LS.set('sp.lastName', name); LS.set('sp.lastPhone', phone);
    try { await store.signIn({ phone, pin }); }
    catch (e) { el.disabled = false; el.innerHTML = label; err(authMsg(e)); }
  },
  async signout() { closeAllSheets(); stopAll(); S.pin = ''; S.famPin = ''; await store.signOut(); },
  view(el) { S.view = el.dataset.v; render(); window.scrollTo(0, 0); },
  'money-tab'(el) { S.view = 'money'; S.moneyTab = el.dataset.v; render(); window.scrollTo(0, 0); },
  fcat(el) { S.cat = el.dataset.id; render(); },
  focc(el) { S.occ = el.dataset.id; render(); },
  'add-pay'(el) { paymentSheet(null, undefined, el.dataset.occ); },
  'occ-open'(el) { occDetail(el.dataset.k); },
  'occ-new'() { occSheet(null); },
  'occ-edit'(el) { const o = S.occasions.find(x => x.id === el.dataset.id); if (o) occSheet(o); },
  'add-vendor'() { vendorSheet(null); },
  pay(el) { const p = S.payments.find(x => x.id === el.dataset.id); if (p && canEdit()) paymentSheet(p); else if (p?.hasReceipt) receiptView(p.id); else if (p?.vendorId) vendorDetail(p.vendorId); },
  vendor(el) { vendorDetail(el.dataset.id); },
  'edit-vendor'(el) { vendorSheet(S.vendors.find(x => x.id === el.dataset.id)); },
  'pay-vendor'(el) { paymentSheet(null, el.dataset.id); },
  'edit-budget'() { budgetSheet(); },
  cat(el) { if (canEdit()) categorySheet(S.categories.find(x => x.id === el.dataset.id)); },
  'add-cat'() { categorySheet(null); },
  'edit-wedding'() { weddingSheet(); },
  invite() { inviteSheet(); },
  trash() { trashSheet(); },
  restore(el) { put(wpath(el.dataset.col, el.dataset.id), { deleted: false, ...stamp(false) }); toast(t('saved')); },
  export(el) { el.dataset.v === 'guests' ? exportGuests() : el.dataset.v === 'shagun' ? exportShagun() : exportCsv(); },
  switch() { switchSheet(); },
  'open-wedding'(el) { closeAllSheets(); openWedding(el.dataset.id); },
  'new-wedding'() { stopAll(); S.screen = 'onboard'; render(); },
  mrole(el) { put(`weddings/${S.wid}/members/${el.dataset.id}`, { role: el.dataset.v }); },
  mmoney(el) { const m = S.members.find(x => x.id === el.dataset.id); m && put(`weddings/${S.wid}/members/${m.id}`, { money: !m.money }); },
  mremove(el) {
    const m = S.members.find(x => x.id === el.dataset.id);
    if (m && confirm(t('removeConfirm', m.name || m.phone))) store.del(`weddings/${S.wid}/members/${m.id}`).catch(fail);
  },
  'reset-demo'() {
    if (!confirm(t('resetDemoConfirm'))) return;
    ['sp.demo.db', 'sp.demo.user', 'sp.demo.accounts', 'sp.join', 'sp.mode'].forEach(LS.del);
    location.reload();
  },
  tdone(el) { toggleDone(el.dataset.id); },
  task(el) { const x = S.tasks.find(y => y.id === el.dataset.id); if (x && canEdit()) taskSheet(x); },
  'add-task'(el) { taskSheet(null, el.dataset.fn); },
  tfilter(el) { S.taskFilter = el.dataset.v; render(); },
  'show-done'(el) { S.showDone[el.dataset.id] = !S.showDone[el.dataset.id]; render(); },
  fn(el) { const f = S.functions.find(x => x.id === el.dataset.id); if (f) fnSheet(f); },
  'add-fn'() { fnSheet(null); },
  'setup-pick'(el) { const id = el.dataset.id, a = S.setupSel || []; S.setupSel = a.includes(id) ? a.filter(x => x !== id) : [...a, id]; render(); },
  'setup-go': setupGo,
  install() { installApp(); },
  'install-hide'() { LS.set('sp.installHide', '1'); render(); },
  gtab(el) { S.guestTab = el.dataset.v; render(); window.scrollTo(0, 0); },
  gfilter(el) { S.gFilter = el.dataset.v; render(); },
  guest(el) { const g = S.guests.find(x => x.id === el.dataset.id); if (g) guestSheet(g); },
  'add-guest'() { guestSheet(null); },
  'pick-contacts'() { pickContacts(); },
  shdir(el) { S.shDir = el.dataset.v; render(); },
  sh(el) { const x = S.shagun.find(y => y.id === el.dataset.id); if (x && canEdit()) shagunSheet(x); },
  'add-shagun'(el) { shagunSheet(null, { dir: el.dataset.dir, guestId: el.dataset.guest }); },
  'create-wedding': createWedding,
  'join-go': joinWedding,
  'join-skip'() { LS.del('sp.join'); S.join = null; afterLogin(); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  e.preventDefault(); fn(el, e);
});
document.addEventListener('input', e => {
  if (e.target.dataset.in === 'gq') { S.gq = e.target.value; const box = $('#guest-list'); if (box) box.innerHTML = guestListHTML(); }
  if (e.target.dataset.in === 'shq') { S.shq = e.target.value; const box = $('#sh-list'); if (box) box.innerHTML = shListHTML(); }
  if (e.target.dataset.in === 'q') { S.q = e.target.value; const box = $('#pay-list'); if (box) box.innerHTML = payListHTML(derive()); }
});
window.addEventListener('online', render);
window.addEventListener('offline', render);

function closeAllSheets() { if (sheets.length) { const n = sheets.length; sheets.length = 0; drawSheet(); history.go(-n); } }
function setLang(l) {
  S.lang = l; LS.set('sp.lang', l);
  if (S.user && store) store.set(`users/${S.user.uid}`, { lang: l }).catch(() => {});
  render(); if (sheets.length) drawSheet();
}

/* ============================== flows ============================== */
function stopAll() {
  [...unsubs, ...moneyUnsubs].forEach(u => { try { u(); } catch (e) {} });
  if (pinUnsub) { try { pinUnsub(); } catch (e) {} pinUnsub = null; }
  unsubs = []; moneyUnsubs = [];
  Object.assign(S, { wid: null, wedding: null, members: [], me: null, payments: [], vendors: [], categories: [], pend: {}, cat: 'all', occ: 'all', q: '', famPin: '', functions: [], tasks: [], showDone: {}, setupSel: null, guests: [], shagun: [], occasions: [], gq: '', shq: '' });
}
let pinUnsub = null;
// Only the owner can read the family PIN. Weddings made before PINs existed get the owner's login PIN.
function watchFamilyPin() {
  if (!isOwner() || pinUnsub) return;
  const wid = S.wid, path = `weddings/${wid}/private/pin`;
  pinUnsub = store.listenDoc(path, p => {
    if (S.wid !== wid) return;
    if (p?.pin) { S.famPin = p.pin; render(); }
    else if (S.pin) store.set(path, { pin: S.pin }).catch(() => {});
  }, () => {});
}

async function start() {
  S.screen = 'loading'; render();
  try { store = await makeStore({ demo: new URLSearchParams(location.search).has('demo') }); }
  catch (e) { console.error(e); S.screen = 'error'; S.error = 'Could not load. Check the internet and try again.'; render(); return; }
  S.demo = store.mode === 'demo';
  store.onAuth(async u => {
    S.user = u;
    if (!u) { stopAll(); S.screen = 'signin'; render(); return; }
    await afterLogin();
  });
}

async function afterLogin() {
  S.screen = 'loading'; render();
  try { S.userDoc = (await store.get('users/' + S.user.uid)) || {}; } catch (e) { S.userDoc = {}; }
  if (S.loginName && S.userDoc.name !== S.loginName) {
    S.userDoc.name = S.loginName;
    store.set('users/' + S.user.uid, { name: S.loginName }).catch(() => {});
  }
  const code = LS.get('sp.join');
  if (code) return showJoin(code);
  const ws = myWeddings(), cur = S.userDoc.current;
  if (cur && ws.find(w => w.id === cur)) return openWedding(cur);
  if (ws.length) return openWedding(ws[0].id);
  S.screen = 'onboard'; render();
}

function openWedding(wid) {
  stopAll();
  Object.assign(S, { wid, screen: 'app', view: 'home', moneyTab: 'occasions' });
  render();
  if (S.userDoc.current !== wid) { S.userDoc.current = wid; store.set('users/' + S.user.uid, { current: wid }).catch(() => {}); }
  unsubs.push(store.listenDoc(`weddings/${wid}`, w => { S.wedding = w; render(); }, () => lostWedding(wid)));
  unsubs.push(store.listenCol(`weddings/${wid}/members`, (ms, pend, fromCache) => {
    S.members = ms; S.me = ms.find(m => m.id === S.user.uid) || null;
    if (!S.me) { if (!fromCache) lostWedding(wid); return; }
    // the name typed at login is the name family sees
    if (S.loginName && S.me.name !== S.loginName && !pend) put(`weddings/${wid}/members/${S.user.uid}`, { name: S.loginName });
    syncMoneyListeners(); watchFamilyPin(); render();
  }, () => lostWedding(wid)));
  // tasks are visible to every member, money or not
  ['functions', 'tasks', 'guests'].forEach(col => unsubs.push(store.listenCol(`weddings/${wid}/${col}`,
    (docs, pend) => { S[col] = docs; S.pend[col] = pend; render(); },
    e => { console.warn(col, e); S[col] = []; render(); })));
}

function syncMoneyListeners() {
  const want = seesMoney();
  if (want && !moneyUnsubs.length) {
    ['payments', 'vendors', 'categories', 'shagun', 'occasions'].forEach(col => moneyUnsubs.push(store.listenCol(`weddings/${S.wid}/${col}`,
      (docs, pend) => { S[col] = docs; S.pend[col] = pend; render(); },
      e => { console.warn(col, e); S[col] = []; render(); })));
  } else if (!want && moneyUnsubs.length) {
    moneyUnsubs.forEach(u => u()); moneyUnsubs = [];
    S.payments = []; S.vendors = []; S.categories = []; S.shagun = []; S.occasions = [];
    if (S.view === 'money') S.view = 'home';
    S.guestTab = 'list';
  }
}

function lostWedding(wid) {             // removed from the wedding, or it no longer exists
  if (S.wid !== wid) return;
  stopAll();
  const w = S.userDoc.weddings?.[wid];
  if (w) { w.gone = true; store.set('users/' + S.user.uid, { weddings: { [wid]: { gone: true } }, current: '' }).catch(() => {}); }
  S.userDoc.current = '';
  afterLogin();
}

async function createWedding(el) {
  const name = $('#ob-name').value.trim(), date = $('#ob-date').value, me = $('#ob-me').value.trim(), pin = digits($('#ob-pin').value);
  const err = $('#ob-err');
  if (!name || !me) { err.textContent = t('needName'); err.classList.remove('hidden'); return; }
  if (pin.length !== 4) { err.textContent = t('needPin'); err.classList.remove('hidden'); return; }
  el.disabled = true;
  const wid = newId(), uid = S.user.uid, now = Date.now();
  S.pin = S.pin || pin;
  try {
    await store.batch([
      { path: `weddings/${wid}`, data: { name, date, budget: 0, createdBy: uid, createdAt: now }, merge: false },
      { path: `weddings/${wid}/members/${uid}`, data: { role: 'owner', money: true, name: me, phone: S.user.phone, joinedAt: now }, merge: false },
      { path: `weddings/${wid}/private/pin`, data: { pin }, merge: false },
      { path: `users/${uid}`, data: { name: me, current: wid, weddings: { [wid]: { name, role: 'owner' } } } },
    ]);
    // starter categories go in a second write: the rules need the owner membership to exist first
    store.batch(DEFAULT_CATEGORIES.map((c, i) => ({
      path: `weddings/${wid}/categories/${c.id}`, data: { en: c.en, hi: c.hi, icon: c.icon, planned: 0, order: i, deleted: false },
    }))).catch(fail);
    S.userDoc = { ...S.userDoc, name: me, current: wid, weddings: { ...(S.userDoc.weddings || {}), [wid]: { name, role: 'owner' } } };
    openWedding(wid);
  } catch (e) { fail(e); el.disabled = false; }
}

async function showJoin(code) {
  S.screen = 'join'; S.join = { loading: true }; render();
  let inv = null;
  try { inv = await store.get('invites/' + code); } catch (e) {}
  if (!inv || (inv.expiresAt && inv.expiresAt < Date.now())) { S.join = { bad: true }; render(); return; }
  try {
    const m = await store.get(`weddings/${inv.weddingId}/members/${S.user.uid}`);
    if (m) { LS.del('sp.join'); toast(t('alreadyMember')); return openWedding(inv.weddingId); }
  } catch (e) {}
  S.join = { code, inv };
  // Just logged in from the invite link with name + PIN: join straight away, no second screen.
  if (S.loginName && S.pin) return joinWedding(null, S.loginName, S.pin);
  render();
}

async function joinWedding(el, me, pin) {
  const { code, inv } = S.join;
  if (el) { me = $('#jn-me').value.trim(); pin = digits($('#jn-pin').value); }
  const showErr = m => { S.join.err = m; S.screen = 'join'; render(); };
  if (!me) return showErr(t('needName'));
  if (pin.length !== 4) return showErr(t('needPin'));
  if (el) el.disabled = true;
  const uid = S.user.uid;
  try {
    if (S.demo) {                     // the real check happens in firestore.rules
      const p = await store.get(`weddings/${inv.weddingId}/private/pin`);
      if (p?.pin && p.pin !== pin) throw { code: 'permission-denied' };
    }
    await store.batch([
      { path: `weddings/${inv.weddingId}/members/${uid}`, data: { role: inv.role, money: !!inv.money, name: me, phone: S.user.phone, pin, invite: code, joinedAt: Date.now() }, merge: false },
      { path: `users/${uid}`, data: { name: me, current: inv.weddingId, weddings: { [inv.weddingId]: { name: inv.weddingName, role: inv.role } } } },
    ]);
    LS.del('sp.join');
    S.userDoc = { ...S.userDoc, name: me, current: inv.weddingId, weddings: { ...(S.userDoc.weddings || {}), [inv.weddingId]: { name: inv.weddingName, role: inv.role } } };
    openWedding(inv.weddingId);
  } catch (e) {
    if (e?.code !== 'permission-denied') { fail(e); return showErr(t('errGeneric')); }
    // Wrong family PIN. A brand-new account was made with that wrong PIN, so remove it;
    // otherwise this phone could never log in with the right one.
    if (!myWeddings().length) {
      S.pin = ''; S.loginErr = t('wrongFamilyPin');
      await store.del('users/' + uid).catch(() => {});   // its name-only profile, so nothing is left behind
      await store.deleteMe();
      return;
    }
    showErr(t('wrongFamilyPin'));
  }
}

/* ============================== boot ============================== */
(function boot() {
  const m = location.hash.match(/join=([a-z0-9]+)/i);
  if (m) { LS.set('sp.join', m[1]); history.replaceState(null, '', location.pathname + location.search); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!S.lang) { S.screen = 'lang'; render(); return; }
  start();
})();
