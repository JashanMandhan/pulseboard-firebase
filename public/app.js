// PulseBoard – real-time cloud notice board
// Firebase services used: Authentication (Google sign-in), Cloud Firestore (database + real-time listener),
// Firebase Hosting (serves this page). Config lives in firebase-config.js.

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, deleteDoc, doc, query, orderBy, limit,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const CATEGORIES = ["All", "General", "Academic", "Events", "Placement"];

// ---------- small UI helpers ----------
let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function setStatus(state, text) {
  $("status").dataset.state = state;
  $("status-text").textContent = text;
}

// ---------- configuration check ----------
const configured = !Object.values(firebaseConfig).some((v) => String(v).startsWith("YOUR_"));
if (!configured) {
  $("config-banner").hidden = false;
  setStatus("offline", "Not configured");
  $("btn-signin").disabled = true;
  $("btn-guest-test").disabled = true;
  throw new Error("Firebase config not set. Edit public/firebase-config.js");
}

// ---------- Firebase initialisation ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const noticesRef = collection(db, "notices");

// ---------- state ----------
let currentUser = null;
let activeFilter = "All";
let notices = [];
let initialLoaded = false;
const flashIds = new Set();

// ---------- filters ----------
function renderChips() {
  const wrap = $("chips");
  wrap.replaceChildren();
  for (const c of CATEGORIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = c;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(c === activeFilter));
    b.addEventListener("click", () => { activeFilter = c; renderChips(); renderNotices(); });
    wrap.appendChild(b);
  }
}

// ---------- notices list ----------
function formatTime(ts) {
  if (!ts) return "just now";
  return ts.toDate().toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
}

function noticeElement(n) {
  const li = document.createElement("li");
  li.className = "notice" + (n.pinned ? " pinned" : "") + (flashIds.has(n.id) ? " flash" : "");

  const h = document.createElement("h3");
  h.textContent = (n.pinned ? "\u{1F4CC} " : "") + n.title;
  const p = document.createElement("p");
  p.textContent = n.message;

  const meta = document.createElement("div");
  meta.className = "meta";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = n.category;
  const by = document.createElement("span");
  by.textContent = `${n.authorName} · ${formatTime(n.createdAt)}`;
  meta.append(tag, by);

  if (n.pending) {
    const s = document.createElement("span");
    s.className = "pending";
    s.textContent = "Syncing…";
    meta.appendChild(s);
  }
  if (currentUser && currentUser.uid === n.authorUid) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn small danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      deleteDoc(doc(db, "notices", n.id)).catch((e) => toast(`Delete failed: ${e.code}`, true));
    });
    meta.appendChild(del);
  }

  li.append(h, p, meta);
  return li;
}

function renderNotices() {
  const list = $("notices");
  list.replaceChildren();
  const shown = notices
    .filter((n) => activeFilter === "All" || n.category === activeFilter)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)); // pinned first; Firestore already sorted by time
  shown.forEach((n) => list.appendChild(noticeElement(n)));
  $("count").textContent = `${shown.length} notice${shown.length === 1 ? "" : "s"}`;
  $("empty").hidden = shown.length > 0;
  flashIds.clear();
}

// ---------- real-time listener (the core of the demo) ----------
const q = query(noticesRef, orderBy("createdAt", "desc"), limit(50));
onSnapshot(
  q,
  { includeMetadataChanges: true },
  (snap) => {
    setStatus(snap.metadata.fromCache ? "offline" : "live",
              snap.metadata.fromCache ? "Offline (cached)" : "Live");
    if (initialLoaded) {
      snap.docChanges().forEach((c) => { if (c.type === "added") flashIds.add(c.doc.id); });
    }
    if (!snap.metadata.fromCache) initialLoaded = true;
    notices = snap.docs.map((d) => ({
      id: d.id,
      ...d.data({ serverTimestamps: "estimate" }),
      pending: d.metadata.hasPendingWrites
    }));
    renderNotices();
  },
  (err) => {
    setStatus("offline", "Error");
    toast(`Could not load notices: ${err.code}`, true);
  }
);

// ---------- authentication ----------
const provider = new GoogleAuthProvider();
$("btn-signin").addEventListener("click", () => {
  signInWithPopup(auth, provider).catch((e) => {
    if (e.code === "auth/popup-blocked") return toast("Popup blocked: allow popups for this site, then click Sign in again.", true);
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    toast(`Sign-in failed: ${e.code}`, true);
  });
});
$("btn-signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  const signedIn = Boolean(user);
  $("btn-signin").hidden = signedIn;
  $("btn-signout").hidden = !signedIn;
  $("user-name").hidden = !signedIn;
  $("user-name").textContent = signedIn ? (user.displayName || user.email || "Signed in") : "";
  $("composer").hidden = !signedIn;
  $("guest-card").hidden = signedIn;
  renderNotices(); // refresh so Delete buttons appear/disappear
});

// ---------- publish a notice ----------
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const data = {
    title: $("f-title").value.trim(),
    message: $("f-message").value.trim(),
    category: $("f-category").value,
    pinned: $("f-pinned").checked,
    authorUid: currentUser.uid,
    authorName: currentUser.displayName || "Anonymous",
    createdAt: serverTimestamp()
  };
  if (!data.title || !data.message) return;
  e.target.reset();
  addDoc(noticesRef, data)
    .then(() => toast("Notice published"))
    .catch((err) => toast(`Publish failed: ${err.code}`, true));
});

// ---------- security demo: a guest write must be rejected by Firestore Security Rules ----------
$("btn-guest-test").addEventListener("click", async () => {
  try {
    await addDoc(noticesRef, {
      title: "Guest test", message: "This write should be rejected.", category: "General",
      pinned: false, authorUid: "guest", authorName: "Guest", createdAt: serverTimestamp()
    });
    toast("Unexpected: the guest write was allowed. Check firestore.rules", true);
  } catch (err) {
    toast(`Blocked by Firestore Security Rules (${err.code})`);
  }
});

renderChips();
renderNotices();
