// Data layer. Two backends with the same shape:
//  - firebase: phone + family PIN login + Firestore (live sync, offline cache)
//  - demo:     localStorage only, for trying the app before Firebase is set up
// Every item (payment, vendor, …) is its own document, so two people editing
// different items can never overwrite each other.
import { firebaseConfig } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
export const isConfigured = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'PASTE_ME';
export const PHONE_DOMAIN = 'phone.shaadi-planner.app';   // must match firestore.rules
const pinPassword = pin => `sp-${pin}-shaadi`;               // Firebase wants 6+ characters

export async function makeStore({ demo }) {
  return (demo || !isConfigured) ? demoStore() : firebaseStore();
}

/* ------------------------------ Firebase ------------------------------ */
async function firebaseStore() {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = F.initializeFirestore(app, {
    localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
  });
  const ref = p => F.doc(db, p);
  const plain = d => {                        // Timestamps → ms so the UI only sees numbers
    const o = {};
    for (const [k, v] of Object.entries(d || {})) o[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v;
    return o;
  };
  const toUser = u => u && { uid: u.uid, phone: (u.email || '').split('@')[0] };

  return {
    mode: 'firebase',
    onAuth: cb => A.onAuthStateChanged(auth, u => cb(toUser(u))),
    // Phone + family PIN login. Under the hood each phone is a Firebase email/password
    // account (<phone>@PHONE_DOMAIN, password made from the PIN), so Firebase rate-limits PIN guessing.
    async signIn({ phone, pin }) {
      const email = phone + '@' + PHONE_DOMAIN, pw = pinPassword(pin);
      try { await A.signInWithEmailAndPassword(auth, email, pw); return { fresh: false }; }
      catch (e) {
        if (!/invalid-credential|user-not-found|wrong-password|invalid-login/.test(e.code || '')) throw e;
        try { await A.createUserWithEmailAndPassword(auth, email, pw); return { fresh: true }; }
        catch (e2) { throw e2.code === 'auth/email-already-in-use' ? { code: 'wrong-pin' } : e2; }
      }
    },
    async deleteMe() { try { await A.deleteUser(auth.currentUser); } catch (e) { await A.signOut(auth); } },
    signOut: () => A.signOut(auth),
    ts: ms => F.Timestamp.fromMillis(ms),
    async get(path) { const s = await F.getDoc(ref(path)); return s.exists() ? { id: s.id, ...plain(s.data()) } : null; },
    set: (path, data, merge = true) => F.setDoc(ref(path), data, { merge }),
    del: path => F.deleteDoc(ref(path)),
    async batch(ops) {
      const b = F.writeBatch(db);
      ops.forEach(o => o.del ? b.delete(ref(o.path)) : b.set(ref(o.path), o.data, { merge: o.merge !== false }));
      await b.commit();
    },
    listenDoc(path, cb, onErr) {
      return F.onSnapshot(ref(path), s => cb(s.exists() ? { id: s.id, ...plain(s.data()) } : null), onErr);
    },
    listenCol(path, cb, onErr) {
      return F.onSnapshot(F.collection(db, path), { includeMetadataChanges: true },
        s => cb(s.docs.map(d => ({ id: d.id, ...plain(d.data()) })), s.metadata.hasPendingWrites, s.metadata.fromCache), onErr);
    },
  };
}

/* ------------------------------ Demo ------------------------------ */
function demoStore() {
  const KEY = 'sp.demo.db', UKEY = 'sp.demo.user', AKEY = 'sp.demo.accounts';
  let data = {}, accounts = {};
  try { data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  try { accounts = JSON.parse(localStorage.getItem(AKEY) || '{}'); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} };
  const saveAcc = () => { try { localStorage.setItem(AKEY, JSON.stringify(accounts)); } catch (e) {} };
  const docL = [], colL = [], authL = [];
  let user = null;
  try { user = JSON.parse(localStorage.getItem(UKEY) || 'null'); } catch (e) {}
  // Demo data from the old Google-style login belongs to 'demo-user': the first phone
  // that logs in on this browser takes it over, so earlier test entries are kept.
  const legacy = !!user && !user.phone && user.uid === 'demo-user';
  if (user && !user.phone) user = null;
  const setUser = u => { user = u; u ? localStorage.setItem(UKEY, JSON.stringify(u)) : localStorage.removeItem(UKEY); authL.forEach(cb => cb(user)); };

  const clone = v => JSON.parse(JSON.stringify(v));
  const colDocs = p => Object.keys(data)
    .filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
    .map(k => ({ id: k.split('/').pop(), ...clone(data[k]) }));
  const emit = () => {
    docL.forEach(l => l.cb(data[l.path] ? { id: l.path.split('/').pop(), ...clone(data[l.path]) } : null));
    colL.forEach(l => l.cb(colDocs(l.path), false));
  };
  const write = (path, d, merge) => { data[path] = merge && data[path] ? { ...data[path], ...d } : { ...d }; };
  const later = fn => Promise.resolve().then(fn);

  return {
    mode: 'demo',
    onAuth(cb) { authL.push(cb); later(() => cb(user)); return () => {}; },
    async signIn({ phone, pin }) {
      let a = accounts[phone], fresh = false;
      if (a && a.pin !== pin) throw { code: 'wrong-pin' };
      if (!a) {
        const takeOver = legacy && !Object.values(accounts).some(x => x.uid === 'demo-user');
        a = accounts[phone] = { pin, uid: takeOver ? 'demo-user' : 'demo-' + phone }; saveAcc(); fresh = true;
      }
      setUser({ uid: a.uid, phone });
      return { fresh };
    },
    async deleteMe() { if (user) { delete accounts[user.phone]; saveAcc(); } setUser(null); },
    async signOut() { setUser(null); },
    ts: ms => ms,
    async get(path) { return data[path] ? { id: path.split('/').pop(), ...clone(data[path]) } : null; },
    async set(path, d, merge = true) { write(path, clone(d), merge); save(); later(emit); },
    async del(path) { delete data[path]; save(); later(emit); },
    async batch(ops) {
      ops.forEach(o => o.del ? delete data[o.path] : write(o.path, clone(o.data), o.merge !== false));
      save(); later(emit);
    },
    listenDoc(path, cb) {
      const l = { path, cb }; docL.push(l);
      later(() => cb(data[path] ? { id: path.split('/').pop(), ...clone(data[path]) } : null));
      return () => docL.splice(docL.indexOf(l), 1);
    },
    listenCol(path, cb) {
      const l = { path, cb }; colL.push(l);
      later(() => cb(colDocs(path), false));
      return () => colL.splice(colL.indexOf(l), 1);
    },
  };
}
