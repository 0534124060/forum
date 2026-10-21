// =====================================================================
//  פורום מידע – קהילת המתמידים עכו
//  קוד האתר. אין צורך לערוך כאן בהתקנה; ההגדרות נמצאות ב-config.js.
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendEmailVerification, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, setDoc, getDocs, addDoc, updateDoc, deleteDoc, onSnapshot,
  query, orderBy, limit, serverTimestamp, increment, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { FIREBASE_CONFIG, SITE_DEFAULTS } from "./config.js";

// ---------------------------------------------------------------- state
const S = {
  settings: { ...SITE_DEFAULTS },
  user: null, authReady: false,
  profile: undefined,   // my document in users/ (registration details + status)
  member: undefined,    // my document in members/ (exists only once approved)
  isAdmin: false,
  view: "home", open: null, q: "", composing: false, confirm: null, authTab: "login",
  threads: [], updates: [], replies: [], users: [],
  loaded: { threads: false, updates: false },
  flash: "",
};
const configured = FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith("PASTE");
let auth, db;
let personalSubs = [], contentSubs = [], repliesSub = null, repliesFor = null;

// ---------------------------------------------------------------- helpers
const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};
const field = (id, label, attrs = {}, multi = false) => $("div", { class: "field" },
  $("label", { for: id, text: label }), $(multi ? "textarea" : "input", { id, ...attrs }));
const val = (root, id) => (root.querySelector("#" + id)?.value || "").trim();
const ms = ts => (ts && typeof ts.toMillis === "function") ? ts.toMillis() : Date.now();
const rtf = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
function ago(ts) {
  const t = ms(ts), s = (t - Date.now()) / 1000, a = Math.abs(s);
  if (a < 60) return "ממש עכשיו";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(t).toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" });
}
const fullDate = ts => new Date(ms(ts)).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const canUse = () => S.isAdmin || !!S.member;
const myName = () => (S.member && S.member.name) || (S.isAdmin ? "מנהל הפורום" : "");
const mayDelete = authorId => S.isAdmin || (!!S.member && S.user && authorId === S.user.uid);
const pendingCount = () => S.users.filter(u => u.status === "pending").length;

function draft(key, el) {
  if (!el) return;
  try { const v = localStorage.getItem("d:" + key); if (v && !el.value) el.value = v; } catch {}
  el.addEventListener("input", () => { try { localStorage.setItem("d:" + key, el.value); } catch {} });
}
const clearDraft = (...keys) => keys.forEach(k => { try { localStorage.removeItem("d:" + k); } catch {} });

function authError(e) {
  const c = e && e.code;
  return ({
    "auth/email-already-in-use": "כתובת המייל הזו כבר רשומה. נסו להיכנס, או לחצו ״שכחתי סיסמה״.",
    "auth/invalid-email": "כתובת המייל אינה תקינה.",
    "auth/weak-password": "הסיסמה קצרה מדי. יש לבחור לפחות 6 תווים.",
    "auth/invalid-credential": "המייל או הסיסמה שגויים.",
    "auth/wrong-password": "המייל או הסיסמה שגויים.",
    "auth/user-not-found": "המייל או הסיסמה שגויים.",
    "auth/too-many-requests": "היו יותר מדי ניסיונות. המתינו כמה דקות ונסו שוב.",
    "auth/network-request-failed": "אין חיבור לאינטרנט. בדקו את החיבור ונסו שוב.",
  })[c] || "הפעולה לא הצליחה. נסו שוב.";
}
function dbError(e) {
  if (e && e.code === "permission-denied") return "אין לך הרשאה לבצע פעולה זו.";
  if (e && e.code === "unavailable") return "אין חיבור לשרת. בדקו את החיבור ונסו שוב.";
  return "הפעולה לא הצליחה. נסו שוב.";
}
function deleteControl(key, onYes) {
  if (S.confirm === key) return $("span", { class: "confirm" }, $("span", { text: "למחוק?" }),
    $("button", { class: "btn ghost", text: "כן, למחוק", on: { click: e => { e.stopPropagation(); S.confirm = null; onYes(); } } }),
    $("button", { class: "btn ghost", text: "ביטול", on: { click: e => { e.stopPropagation(); S.confirm = null; render(); } } }));
  return $("button", { class: "btn ghost", text: "מחיקה", on: { click: e => { e.stopPropagation(); S.confirm = key; render(); } } });
}

// ---------------------------------------------------------------- routing
function go(view, open = null) {
  const h = view === "thread" ? "t-" + open : view === "home" ? "" : view;
  if (location.hash.slice(1) !== h) { location.hash = h; return; } // hashchange will call route()
  route();
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  S.composing = false; S.confirm = null;
  if (h.startsWith("t-")) { S.view = "thread"; S.open = h.slice(2); }
  else if (["updates", "admin", "settings"].includes(h)) { S.view = h; S.open = null; }
  else { S.view = "home"; S.open = null; }
  syncReplies();
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

// ---------------------------------------------------------------- data
function stopAll(list) { list.forEach(u => { try { u(); } catch {} }); list.length = 0; }

function startContent() {
  if (contentSubs.length) return;
  contentSubs.push(onSnapshot(query(collection(db, "threads"), orderBy("lastActivity", "desc"), limit(300)), s => {
    S.threads = s.docs.map(d => ({ id: d.id, ...d.data() })); S.loaded.threads = true; render();
  }, () => { S.loaded.threads = true; render(); }));
  contentSubs.push(onSnapshot(query(collection(db, "updates"), orderBy("createdAt", "desc"), limit(100)), s => {
    S.updates = s.docs.map(d => ({ id: d.id, ...d.data() })); S.loaded.updates = true; render();
  }, () => { S.loaded.updates = true; render(); }));
  if (S.isAdmin) contentSubs.push(onSnapshot(collection(db, "users"), s => {
    S.users = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
  }, () => {}));
  syncReplies();
}
function stopContent() {
  stopAll(contentSubs); if (repliesSub) repliesSub(); repliesSub = null; repliesFor = null;
  S.threads = []; S.updates = []; S.replies = []; S.users = []; S.loaded = { threads: false, updates: false };
}
function syncReplies() {
  const want = canUse() && S.view === "thread" ? S.open : null;
  if (want === repliesFor) return;
  if (repliesSub) repliesSub(); repliesSub = null; S.replies = []; repliesFor = want;
  if (!want) return;
  repliesSub = onSnapshot(query(collection(db, "threads", want, "replies"), orderBy("createdAt", "asc"), limit(1000)), s => {
    S.replies = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
  }, () => {});
}
async function checkAdmin() {
  // Only the admin may list the users collection; the security rules decide.
  try { await getDocs(query(collection(db, "users"), limit(1))); return true; } catch { return false; }
}
async function refreshAccess() {
  const wasAdmin = S.isAdmin;
  S.isAdmin = await checkAdmin();
  if (S.isAdmin !== wasAdmin) stopContent();
  if (canUse()) startContent(); else stopContent();
  render();
}

function onUser(user) {
  stopAll(personalSubs); stopContent();
  S.user = user; S.profile = undefined; S.member = undefined; S.isAdmin = false; S.authReady = true;
  if (!user) { render(); return; }
  personalSubs.push(onSnapshot(doc(db, "users", user.uid), s => { S.profile = s.exists() ? s.data() : null; render(); },
    () => { S.profile = null; render(); }));
  personalSubs.push(onSnapshot(doc(db, "members", user.uid), s => {
    const had = !!S.member; S.member = s.exists() ? s.data() : null;
    if (!!S.member !== had) refreshAccess(); else render();
  }, () => { S.member = null; render(); }));
  refreshAccess();
}

// ---------------------------------------------------------------- header
function renderChrome() {
  const st = S.settings;
  document.getElementById("topline").textContent = st.topLine || "";
  document.getElementById("community").textContent = st.community || "";
  document.getElementById("site-title").textContent = st.siteTitle || "";
  document.getElementById("blessing").textContent = st.blessing || "";
  document.getElementById("footer").textContent = st.footerText || "";
  document.title = [st.siteTitle, st.community].filter(Boolean).join(" – ");

  const nav = document.getElementById("nav"), who = document.getElementById("who");
  nav.replaceChildren(); who.replaceChildren();
  if (!S.user) return;
  if (canUse()) {
    const cur = v => (S.view === v || (v === "home" && S.view === "thread")) ? "page" : null;
    const n = pendingCount();
    nav.append(...[
      $("button", { class: "btn", "aria-current": cur("home"), text: "הפורומים", on: { click: () => go("home") } }),
      $("button", { class: "btn official", "aria-current": cur("updates"), text: "עדכונים רשמיים – " + (st.committeeName || "ועדת הדיור"), on: { click: () => go("updates") } }),
      S.isAdmin ? $("button", { class: "btn", "aria-current": cur("admin"), on: { click: () => go("admin") } }, "ניהול נרשמים", n ? $("span", { class: "badge", text: String(n) }) : null) : null,
      S.isAdmin ? $("button", { class: "btn", "aria-current": cur("settings"), text: "הגדרות האתר", on: { click: () => go("settings") } }) : null].filter(Boolean));
  }
  who.append($("span", { text: (myName() || S.user.email) + " · " }),
    $("button", { class: "btn link", text: "יציאה", on: { click: () => signOut(auth) } }));
}

// ---------------------------------------------------------------- screens: not signed in
function renderNotConfigured(main) {
  main.append($("div", { class: "panel warn" }, $("h3", { text: "האתר עדיין לא מחובר ל-Firebase" }),
    $("p", { class: "hint", text: "יש להדביק את פרטי החיבור בקובץ config.js, לפי מדריך ההתקנה." })));
}

function renderAuth(main) {
  const box = $("div", { class: "auth" });
  if (S.settings.welcomeText) box.append($("p", { class: "hint", style: "margin-bottom:14px;font-size:1rem", text: S.settings.welcomeText }));
  box.append($("div", { class: "tabs", style: "margin-bottom:12px" },
    $("button", { class: "btn", "aria-current": S.authTab === "login" ? "page" : null, text: "כניסה", on: { click: () => { S.authTab = "login"; render(); } } }),
    $("button", { class: "btn", "aria-current": S.authTab === "register" ? "page" : null, text: "הרשמה", on: { click: () => { S.authTab = "register"; render(); } } })));
  const err = $("div", { class: "err", role: "alert" }), ok = $("div", { class: "okmsg", role: "status", text: S.flash });
  S.flash = "";

  if (S.authTab === "login") {
    const f = $("form", { class: "panel", on: { submit: async e => {
      e.preventDefault(); err.textContent = "";
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      try { await signInWithEmailAndPassword(auth, val(f, "li-email"), f.querySelector("#li-pass").value); }
      catch (x) { err.textContent = authError(x); btn.disabled = false; }
    } } },
      $("h3", { text: "כניסה לפורום" }),
      field("li-email", "כתובת מייל", { type: "email", autocomplete: "email", dir: "ltr", required: true }),
      field("li-pass", "סיסמה", { type: "password", autocomplete: "current-password", dir: "ltr", required: true }),
      err, ok,
      $("div", { class: "row" },
        $("button", { type: "button", class: "btn link", text: "שכחתי סיסמה", on: { click: async () => {
          const email = val(f, "li-email"); err.textContent = "";
          if (!email) { err.textContent = "כתבו את כתובת המייל ואז לחצו ״שכחתי סיסמה״."; return; }
          try { await sendPasswordResetEmail(auth, email); ok.textContent = "אם הכתובת רשומה, נשלח אליה קישור לאיפוס הסיסמה."; }
          catch (x) { err.textContent = authError(x); }
        } } }),
        $("button", { type: "submit", class: "btn primary", text: "כניסה" })));
    box.append(f);
  } else {
    const f = $("form", { class: "panel", on: { submit: async e => {
      e.preventDefault(); err.textContent = "";
      const data = detailsFrom(f); const email = val(f, "rg-email"), pass = f.querySelector("#rg-pass").value;
      const problem = checkDetails(data) || (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && "כתובת המייל אינה תקינה.") || (pass.length < 6 && "הסיסמה צריכה להכיל לפחות 6 תווים.");
      if (problem) { err.textContent = problem; return; }
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await saveApplication(cred.user, data, true);
        try { await sendEmailVerification(cred.user); } catch {}
        clearDraft("rg-name", "rg-phone", "rg-address", "rg-notes");
      } catch (x) { err.textContent = x.code && x.code.startsWith("auth/") ? authError(x) : dbError(x); btn.disabled = false; }
    } } },
      $("h3", { text: "הרשמה לפורום" }),
      $("p", { class: "hint", text: "הפרטים מגיעים למנהל הפורום בלבד. החשבון ייפתח לאחר אישורו." }),
      detailsFields(),
      $("div", { class: "grid2" },
        field("rg-email", "כתובת מייל *", { type: "email", autocomplete: "email", dir: "ltr" }),
        field("rg-pass", "בחירת סיסמה * (לפחות 6 תווים)", { type: "password", autocomplete: "new-password", dir: "ltr" })),
      err,
      $("div", { class: "row" }, $("span"), $("button", { type: "submit", class: "btn primary", text: "שליחת בקשת הרשמה" })));
    ["rg-name", "rg-phone", "rg-address", "rg-notes"].forEach(k => draft(k, f.querySelector("#" + k)));
    box.append(f);
  }
  main.append(box);
}

function detailsFields(prefill = {}) {
  const wrap = $("div", { style: "display:grid;gap:10px" },
    $("div", { class: "grid2" },
      field("rg-name", "שם מלא *", { maxlength: "80", autocomplete: "name", value: prefill.name || "" }),
      field("rg-phone", "טלפון *", { type: "tel", maxlength: "30", autocomplete: "tel", dir: "ltr", value: prefill.phone || "" }),
      field("rg-address", "כתובת בעכו", { maxlength: "120", value: prefill.address || "" })),
    field("rg-notes", "הערות למנהל", { maxlength: "1000", style: "min-height:70px" }, true));
  if (prefill.notes) wrap.querySelector("#rg-notes").value = prefill.notes;
  return wrap;
}
const detailsFrom = f => ({ name: val(f, "rg-name"), phone: val(f, "rg-phone"), address: val(f, "rg-address"), notes: val(f, "rg-notes") });
const checkDetails = d => (!d.name && "יש למלא שם מלא.") || (!d.phone && "יש למלא מספר טלפון.") || "";
async function saveApplication(user, data, isNew) {
  const body = { ...data, email: user.email, status: "pending", updatedAt: serverTimestamp() };
  if (isNew) body.createdAt = serverTimestamp();
  await setDoc(doc(db, "users", user.uid), body, { merge: !isNew });
}

// ---------------------------------------------------------------- screens: signed in, not approved
function verifyBanner() {
  if (!S.user || S.user.emailVerified) return null;
  const msg = $("div", { class: "okmsg", role: "status" });
  return $("div", { class: "panel warn" },
    $("h3", { text: "אימות כתובת המייל" }),
    $("p", { class: "hint", text: "שלחנו קישור אימות אל " + S.user.email + ". לחצו על הקישור במייל (בדקו גם בתיקיית הספאם), ואז לחצו כאן על ״אימתתי״." }),
    msg,
    $("div", { class: "row start" },
      $("button", { class: "btn primary", text: "אימתתי", on: { click: async () => {
        await S.user.reload(); await S.user.getIdToken(true);
        if (S.user.emailVerified) { msg.textContent = "הכתובת אומתה."; await refreshAccess(); }
        else msg.textContent = "הכתובת עדיין לא אומתה. לחצו על הקישור שבמייל.";
      } } }),
      $("button", { class: "btn", text: "שליחת המייל שוב", on: { click: async () => {
        try { await sendEmailVerification(S.user); msg.textContent = "המייל נשלח שוב."; } catch (x) { msg.textContent = authError(x); }
      } } })));
}

function renderWaiting(main) {
  const vb = verifyBanner(); if (vb) main.append(vb);
  const p = S.profile;
  if (p === undefined || S.member === undefined) { main.append($("div", { class: "empty" }, $("strong", { text: "טוען…" }))); return; }
  if (p && p.status === "pending") {
    main.append($("div", { class: "panel" }, $("h3", { text: "הבקשה שלך ממתינה לאישור" }),
      $("p", { class: "hint", text: "פרטי ההרשמה הגיעו למנהל הפורום. ברגע שיאשר, הפורום ייפתח כאן אוטומטית." })));
    return;
  }
  const err = $("div", { class: "err", role: "alert" });
  const rejected = p && p.status === "rejected";
  const f = $("form", { class: "panel", on: { submit: async e => {
    e.preventDefault(); const data = detailsFrom(f); const problem = checkDetails(data);
    if (problem) { err.textContent = problem; return; }
    const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
    try { await saveApplication(S.user, data, !p); } catch (x) { err.textContent = dbError(x); btn.disabled = false; }
  } } },
    $("h3", { text: rejected ? "הבקשה לא אושרה" : "השלמת פרטי הרשמה" }),
    $("p", { class: "hint", text: rejected ? "אפשר לעדכן את הפרטים ולשלוח את הבקשה שוב, או לפנות למנהל הפורום." : "כדי שמנהל הפורום יוכל לאשר אותך, מלאו את הפרטים הבאים." }),
    detailsFields(p || {}), err,
    $("div", { class: "row" }, $("span"), $("button", { type: "submit", class: "btn primary", text: "שליחת הבקשה" })));
  main.append(f);
}

// ---------------------------------------------------------------- screens: forum
function renderHome(main) {
  const latest = S.updates[0];
  if (latest) main.append($("div", { class: "notice", role: "link", tabindex: "0",
    on: { click: () => go("updates"), keydown: e => { if (e.key === "Enter") go("updates"); } } },
    $("span", { class: "lbl", text: "עדכון אחרון מ" + (S.settings.committeeName || "ועדת הדיור") + " · " + ago(latest.createdAt) }),
    $("b", { text: latest.title })));

  main.append($("div", { class: "tools" },
    $("h2", { text: "פורומים שנפתחו" }),
    $("input", { type: "search", id: "q", placeholder: "חיפוש", value: S.q, "aria-label": "חיפוש בפורומים", on: { input: e => { S.q = e.target.value; renderList(); } } }),
    !S.composing ? $("button", { class: "btn primary", text: "+ פתיחת פורום", on: { click: () => { S.composing = true; render(); setTimeout(() => document.getElementById("nt-title")?.focus()); } } }) : null));

  if (S.composing) {
    const err = $("div", { class: "err", role: "alert" });
    const f = $("form", { class: "panel", on: { submit: async e => {
      e.preventDefault();
      const title = val(f, "nt-title"), body = val(f, "nt-body");
      if (!title) { err.textContent = "חסרה כותרת."; return; }
      if (!body) { err.textContent = "כתבו כמה מילים לפתיחת הפורום."; return; }
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      try {
        const ref = await addDoc(collection(db, "threads"), {
          title, body, authorId: S.user.uid, authorName: myName(),
          createdAt: serverTimestamp(), lastActivity: serverTimestamp(), replyCount: 0,
        });
        clearDraft("nt-title", "nt-body"); go("thread", ref.id);
      } catch (x) { err.textContent = dbError(x); btn.disabled = false; }
    } } },
      $("h3", { text: "פתיחת פורום חדש" }),
      field("nt-title", "כותרת", { maxlength: "140" }),
      field("nt-body", "תוכן", { maxlength: "8000" }, true),
      err,
      $("div", { class: "row" }, $("span"), $("div", { class: "row" },
        $("button", { type: "button", class: "btn", text: "ביטול", on: { click: () => { S.composing = false; render(); } } }),
        $("button", { type: "submit", class: "btn primary", text: "פרסום" }))));
    draft("nt-title", f.querySelector("#nt-title")); draft("nt-body", f.querySelector("#nt-body"));
    main.append(f);
  }
  main.append($("div", { id: "list-body" }));
  renderList();
}

function renderList() {
  const host = document.getElementById("list-body"); if (!host) return;
  host.replaceChildren();
  if (!S.loaded.threads) { host.append($("div", { class: "empty" }, $("strong", { text: "טוען…" }))); return; }
  const q = S.q.trim().toLowerCase();
  const list = S.threads.filter(t => !q || ((t.title || "") + " " + (t.body || "")).toLowerCase().includes(q));
  if (!list.length) {
    host.append($("div", { class: "empty" },
      $("strong", { text: q ? "לא נמצאו פורומים" : "עדיין לא נפתחו פורומים" }),
      $("span", { text: q ? "נסו מילת חיפוש אחרת." : "לחצו על ״פתיחת פורום״ כדי לפתוח את הראשון." })));
    return;
  }
  host.append($("ol", { class: "threads" }, ...list.map(t => {
    const n = t.replyCount || 0;
    return $("li", { class: "thread", tabindex: "0", role: "link",
      on: { click: () => go("thread", t.id), keydown: e => { if (e.key === "Enter") go("thread", t.id); } } },
      $("p", { class: "t-title", text: t.title }),
      $("div", { class: "t-meta", text: (t.authorName || "חבר/ת קהילה") + " · פעילות " + ago(t.lastActivity) }),
      $("div", { class: "count" }, $("b", { text: String(n) }), $("span", { text: n === 1 ? "תגובה" : "תגובות" })));
  })));
}

function renderThread(main) {
  const t = S.threads.find(x => x.id === S.open);
  main.append($("button", { class: "btn back", text: "→ חזרה לרשימת הפורומים", on: { click: () => go("home") } }));
  if (!t) { main.append($("div", { class: "empty" }, $("strong", { text: S.loaded.threads ? "הפורום לא נמצא. ייתכן שנמחק." : "טוען…" }))); return; }
  main.append($("article", { class: "post" },
    $("h2", { text: t.title }),
    $("div", { class: "byline" }, $("span", { class: "name", text: t.authorName || "חבר/ת קהילה" }), $("span", { text: "· " + ago(t.createdAt) }),
      mayDelete(t.authorId) ? deleteControl("t:" + t.id, () => deleteThread(t)) : null),
    $("div", { class: "body", style: "margin-top:12px" }, t.body)));
  const replies = S.replies;
  main.append($("h3", { class: "sec-h", text: replies.length === 1 ? "תגובה אחת" : replies.length ? replies.length + " תגובות" : "אין עדיין תגובות" }));
  if (replies.length) main.append($("ol", { class: "replies" }, ...replies.map(r => $("li", { class: "reply" },
    $("div", { class: "byline" }, $("span", { class: "name", text: r.authorName || "חבר/ת קהילה" }), $("span", { text: "· " + ago(r.createdAt) }),
      (mayDelete(r.authorId) || mayDelete(t.authorId)) ? deleteControl("r:" + r.id, () => deleteReply(t, r)) : null),
    $("div", { class: "body" }, r.body)))));

  const err = $("div", { class: "err", role: "alert" });
  const f = $("form", { class: "panel", style: "margin-top:18px", on: { submit: async e => {
    e.preventDefault();
    const ta = f.querySelector("#reply-body"), body = ta.value.trim();
    if (!body) { err.textContent = "התגובה ריקה."; return; }
    const btn = f.querySelector("button"); btn.disabled = true;
    try {
      await addDoc(collection(db, "threads", t.id, "replies"), { body, authorId: S.user.uid, authorName: myName(), createdAt: serverTimestamp() });
      updateDoc(doc(db, "threads", t.id), { lastActivity: serverTimestamp(), replyCount: increment(1) }).catch(() => {});
      clearDraft("reply-" + t.id); ta.value = ""; err.textContent = "";
    } catch (x) { err.textContent = dbError(x); }
    btn.disabled = false;
  } } },
    field("reply-body", "הוספת תגובה", { maxlength: "8000" }, true), err,
    $("div", { class: "row" }, $("span"), $("button", { type: "submit", class: "btn primary", text: "פרסום תגובה" })));
  draft("reply-" + t.id, f.querySelector("#reply-body"));
  main.append(f);
}
async function deleteReply(t, r) {
  try {
    await deleteDoc(doc(db, "threads", t.id, "replies", r.id));
    updateDoc(doc(db, "threads", t.id), { replyCount: increment(-1) }).catch(() => {});
  } catch { render(); }
}
async function deleteThread(t) {
  try {
    const snap = await getDocs(collection(db, "threads", t.id, "replies"));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const b = writeBatch(db); snap.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
    }
    await deleteDoc(doc(db, "threads", t.id));
    go("home");
  } catch { render(); }
}

// ---------------------------------------------------------------- screens: official updates
function renderUpdates(main) {
  const name = S.settings.committeeName || "ועדת הדיור";
  main.append($("div", { class: "tools" }, $("h2", { text: "עדכונים רשמיים – " + name })));
  if (S.isAdmin) {
    const err = $("div", { class: "err", role: "alert" });
    const f = $("form", { class: "panel official", on: { submit: async e => {
      e.preventDefault();
      const title = val(f, "up-title"), body = val(f, "up-body");
      if (!title || !body) { err.textContent = "יש למלא כותרת ונוסח."; return; }
      const btn = f.querySelector("button"); btn.disabled = true;
      try {
        await addDoc(collection(db, "updates"), { title, body, createdAt: serverTimestamp() });
        clearDraft("up-title", "up-body"); f.reset(); err.textContent = "";
      } catch (x) { err.textContent = dbError(x); }
      btn.disabled = false;
    } } },
      $("h3", { text: "פרסום עדכון רשמי" }),
      $("p", { class: "hint", text: "רק מנהל הפורום רואה טופס זה. העדכון יוצג לכל חברי הקהילה בשם " + name + "." }),
      field("up-title", "כותרת העדכון", { maxlength: "160" }),
      field("up-body", "נוסח העדכון", { maxlength: "10000" }, true),
      err, $("div", { class: "row" }, $("span"), $("button", { type: "submit", class: "btn official", text: "פרסום העדכון" })));
    draft("up-title", f.querySelector("#up-title")); draft("up-body", f.querySelector("#up-body"));
    main.append(f);
  }
  if (!S.loaded.updates) { main.append($("div", { class: "empty" }, $("strong", { text: "טוען…" }))); return; }
  if (!S.updates.length) { main.append($("div", { class: "empty" }, $("strong", { text: "אין עדיין עדכונים רשמיים" }), $("span", { text: "העדכונים של " + name + " יפורסמו כאן." }))); return; }
  main.append($("ol", { class: "updates" }, ...S.updates.map(u => $("li", {},
    $("article", { class: "post official" },
      $("div", { class: "row" }, $("span", { class: "stamp", text: name + " · " + fullDate(u.createdAt) }),
        S.isAdmin ? deleteControl("u:" + u.id, () => deleteDoc(doc(db, "updates", u.id)).catch(() => render())) : null),
      $("h2", { text: u.title }), $("div", { class: "body" }, u.body))))));
}

// ---------------------------------------------------------------- screens: admin
function renderAdmin(main) {
  main.append($("div", { class: "tools" }, $("h2", { text: "ניהול נרשמים" })));
  if (!S.isAdmin) { main.append($("div", { class: "empty" }, $("strong", { text: "עמוד זה זמין למנהל הפורום בלבד" }))); return; }
  const order = { pending: 0, approved: 1, rejected: 2 };
  const users = S.users.slice().sort((a, b) => (order[a.status] ?? 0) - (order[b.status] ?? 0) || ms(b.createdAt) - ms(a.createdAt));
  if (!users.length) { main.append($("div", { class: "empty" }, $("strong", { text: "אין בקשות הרשמה" }), $("span", { text: "בקשות חדשות יופיעו כאן לאישור." }))); return; }
  const label = { pending: ["ממתין לאישור", "pill"], approved: ["מאושר", "pill ok"], rejected: ["נדחה", "pill no"] };
  main.append($("ul", { class: "apps" }, ...users.map(u => {
    const [txt, cls] = label[u.status] || label.pending;
    return $("li", { class: "app" },
      $("div", { class: "row" }, $("b", { text: u.name || "ללא שם" }), $("span", { class: cls, text: txt })),
      $("dl", {},
        $("dt", { text: "מייל" }), $("dd", { dir: "ltr", text: u.email || "—" }),
        $("dt", { text: "טלפון" }), $("dd", { dir: "ltr", text: u.phone || "—" }),
        $("dt", { text: "כתובת" }), $("dd", { text: u.address || "—" }),
        u.notes ? [$("dt", { text: "הערות" }), $("dd", { text: u.notes })] : null,
        $("dt", { text: "נרשם/ה" }), $("dd", { text: ago(u.createdAt) })),
      $("div", { class: "row start" },
        u.status !== "approved" ? $("button", { class: "btn primary", text: "אישור", on: { click: () => decide(u, true) } }) : null,
        u.status !== "rejected" ? $("button", { class: "btn", text: u.status === "approved" ? "ביטול חברות" : "דחייה", on: { click: () => decide(u, false) } }) : null));
  })));
}
async function decide(u, approve) {
  const b = writeBatch(db);
  if (approve) b.set(doc(db, "members", u.id), { name: u.name || "חבר/ת קהילה", approvedAt: serverTimestamp() });
  else b.delete(doc(db, "members", u.id));
  b.update(doc(db, "users", u.id), { status: approve ? "approved" : "rejected", decidedAt: serverTimestamp() });
  try { await b.commit(); } catch { render(); }
}

function renderSettings(main) {
  main.append($("div", { class: "tools" }, $("h2", { text: "הגדרות האתר" })));
  if (!S.isAdmin) { main.append($("div", { class: "empty" }, $("strong", { text: "עמוד זה זמין למנהל הפורום בלבד" }))); return; }
  const st = S.settings, msg = $("div", { class: "okmsg", role: "status" }), err = $("div", { class: "err", role: "alert" });
  const fields = [
    ["topLine", "שורה עליונה קטנה", false], ["community", "שם הקהילה", false], ["siteTitle", "כותרת האתר", false],
    ["blessing", "שורת ברכה מתחת לכותרת", false], ["committeeName", "שם הוועדה בעדכונים הרשמיים", false],
    ["welcomeText", "טקסט פתיחה במסך הכניסה", true], ["footerText", "טקסט בתחתית האתר (למשל פרטי קשר)", true],
  ];
  const f = $("form", { class: "panel", on: { submit: async e => {
    e.preventDefault(); msg.textContent = ""; err.textContent = "";
    const data = {}; for (const [k] of fields) data[k] = f.querySelector("#st-" + k).value.trim();
    try { await setDoc(doc(db, "settings", "site"), data, { merge: true }); msg.textContent = "ההגדרות נשמרו."; }
    catch (x) { err.textContent = dbError(x); }
  } } },
    $("p", { class: "hint", text: "השינויים מופיעים באתר מיד אחרי השמירה, אצל כל המשתמשים." }),
    ...fields.map(([k, label, multi]) => field("st-" + k, label, multi ? { maxlength: "2000", style: "min-height:80px" } : { maxlength: "200", value: st[k] || "" }, multi)),
    msg, err,
    $("div", { class: "row" }, $("span"), $("button", { type: "submit", class: "btn primary", text: "שמירת ההגדרות" })));
  for (const [k, , multi] of fields) if (multi) f.querySelector("#st-" + k).value = st[k] || "";
  main.append(f);
}

// ---------------------------------------------------------------- render
function render() {
  renderChrome();
  const main = document.getElementById("main");
  // Keep text the person is typing when live data re-renders the screen.
  const active = document.activeElement && document.activeElement.id;
  const keep = {};
  for (const el of main.querySelectorAll("input[id],textarea[id]")) if (el.type !== "password") keep[el.id] = [el.value, el.selectionStart];
  main.replaceChildren();

  if (!configured) renderNotConfigured(main);
  else if (!S.authReady) main.append($("div", { class: "empty" }, $("strong", { text: "טוען…" })));
  else if (!S.user) renderAuth(main);
  else if (!canUse()) renderWaiting(main);
  else if (S.view === "thread") renderThread(main);
  else if (S.view === "updates") renderUpdates(main);
  else if (S.view === "admin") renderAdmin(main);
  else if (S.view === "settings") renderSettings(main);
  else renderHome(main);

  for (const [id, [v, pos]] of Object.entries(keep)) {
    const el = document.getElementById(id);
    if (el && v) { el.value = v; if (id === active) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }
  }
}

// ---------------------------------------------------------------- start
document.getElementById("site-title").addEventListener("click", e => { e.preventDefault(); go("home"); });
route();
if (configured) {
  const app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app); auth.languageCode = "he";
  db = getFirestore(app);
  onSnapshot(doc(db, "settings", "site"), s => { S.settings = { ...SITE_DEFAULTS, ...(s.exists() ? s.data() : {}) }; render(); }, () => {});
  onAuthStateChanged(auth, onUser);
}
