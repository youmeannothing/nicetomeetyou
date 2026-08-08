// ————————————————————————————————————————————
// Nice to Meet You — 하루짜리 지인 게시판
// 매일 한국시간 자정에 게시글이 사라진다.
// Firebase 설정이 있으면 공유 모드, 없으면 로컬 모드.
// ————————————————————————————————————————————

const KST_OFFSET = 9 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

// 오늘 KST 자정의 UTC ms — 이 시각 이전 글은 만료
function todayBoundary() {
  const kst = new Date(Date.now() + KST_OFFSET);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - KST_OFFSET;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const fmtTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
});
const fmtDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "long",
});

// ——— 저장소: 로컬 모드 ———

function makeLocalStore() {
  const KEY = "ntmy_posts";
  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  };
  const save = posts => localStorage.setItem(KEY, JSON.stringify(posts));
  const alive = posts => posts.filter(p => p.createdAt >= todayBoundary());

  let listeners = [];
  const notify = () => {
    const posts = alive(load()).sort((a, b) => b.createdAt - a.createdAt);
    listeners.forEach(cb => cb(posts));
  };
  // 다른 탭에서의 변경도 반영
  window.addEventListener("storage", e => { if (e.key === KEY) notify(); });

  return {
    mode: "local",
    subscribe(cb) { listeners.push(cb); notify(); },
    async add(post) {
      const posts = alive(load());
      posts.push({ ...post, id: crypto.randomUUID() });
      save(posts); notify();
    },
    async update(id, data) {
      const posts = alive(load()).map(p => p.id === id ? { ...p, ...data } : p);
      save(posts); notify();
    },
    async remove(id) {
      save(alive(load()).filter(p => p.id !== id));
      notify();
    },
    refresh: notify,
  };
}

// ——— 저장소: Firebase 공유 모드 ———

async function makeFirebaseStore(cfg) {
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const fs = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const db = fs.getFirestore(initializeApp(cfg));
  const col = fs.collection(db, "posts");

  let listeners = [];
  let current = [];
  let unsub = null;

  const listen = () => {
    if (unsub) unsub();
    const q = fs.query(
      col,
      fs.where("createdAt", ">=", todayBoundary()),
      fs.orderBy("createdAt", "desc"),
    );
    unsub = fs.onSnapshot(q, snap => {
      current = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      listeners.forEach(cb => cb(current));
    });
  };
  listen();

  return {
    mode: "firebase",
    subscribe(cb) { listeners.push(cb); cb(current); },
    async add(post) { await fs.addDoc(col, post); },
    async update(id, data) { await fs.updateDoc(fs.doc(db, "posts", id), data); },
    async remove(id) { await fs.deleteDoc(fs.doc(db, "posts", id)); },
    refresh: listen, // 자정이 지나면 쿼리 경계를 갱신
  };
}

// ——— UI ———

const $ = id => document.getElementById(id);

let store;
let posts = [];
let editingId = null; // 수정 중인 글 id

function renderMasthead() {
  $("date-str").textContent = fmtDate.format(new Date());
}

function renderPosts() {
  const list = $("post-list");
  list.innerHTML = "";
  $("post-count").textContent = posts.length;
  $("empty-state").hidden = posts.length > 0;

  posts.forEach(p => {
    const li = document.createElement("li");
    li.className = "post";

    const meta = document.createElement("div");
    meta.className = "post-meta";
    const time = document.createElement("span");
    time.textContent = fmtTime.format(new Date(p.createdAt))
      + (p.editedAt ? " (수정됨)" : "");
    meta.appendChild(time);

    const head = document.createElement("div");
    head.className = "post-head";
    const title = document.createElement("h3");
    title.className = "post-title";
    title.textContent = p.title;
    const byline = document.createElement("span");
    byline.className = "post-byline";
    byline.textContent = p.name || "익명";
    head.append(title, byline);

    const body = document.createElement("p");
    body.className = "post-body";
    body.textContent = p.body;

    li.append(meta, head, body);

    if (p.contact) {
      const contact = document.createElement("div");
      contact.className = "post-contact";
      const label = document.createElement("b");
      label.textContent = "연락";
      contact.append(label, document.createTextNode(p.contact));
      li.appendChild(contact);
    }

    const actions = document.createElement("div");
    actions.className = "post-actions";
    const editBtn = document.createElement("button");
    editBtn.textContent = "수정";
    editBtn.onclick = () => beginEdit(p);
    const delBtn = document.createElement("button");
    delBtn.textContent = "삭제";
    delBtn.onclick = () => confirmDelete(p);
    actions.append(editBtn, delBtn);
    li.appendChild(actions);

    list.appendChild(li);
  });
}

// ——— 글쓰기 폼 ———

function openForm() {
  $("compose-form").hidden = false;
  $("compose-toggle").hidden = true;
  $("f-name").focus();
}

function closeForm() {
  const form = $("compose-form");
  form.reset();
  form.hidden = true;
  $("compose-toggle").hidden = false;
  editingId = null;
  $("form-heading").textContent = "새 글 쓰기";
  $("submit-btn").textContent = "게재하기";
  $("f-password").required = true;
  $("f-password").placeholder = "4자 이상";
}

async function handleSubmit(e) {
  e.preventDefault();
  const btn = $("submit-btn");
  btn.disabled = true;
  try {
    const data = {
      name: $("f-name").value.trim() || "익명",
      title: $("f-title").value.trim(),
      body: $("f-body").value.trim(),
      contact: $("f-contact").value.trim(),
    };
    if (editingId) {
      data.editedAt = Date.now();
      const pw = $("f-password").value;
      if (pw) data.pwHash = await sha256(pw); // 비밀번호 변경도 허용
      await store.update(editingId, data);
    } else {
      data.pwHash = await sha256($("f-password").value);
      data.createdAt = Date.now();
      await store.add(data);
    }
    closeForm();
  } catch (err) {
    alert("저장에 실패했습니다. 잠시 후 다시 시도해주세요.");
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

// ——— 비밀번호 확인 다이얼로그 ———

function askPassword(heading, showError) {
  return new Promise(resolve => {
    const dialog = $("pw-dialog");
    $("pw-heading").textContent = heading;
    $("pw-input").value = "";
    $("pw-error").hidden = !showError;
    dialog.returnValue = "cancel";
    dialog.onclose = () => {
      resolve(dialog.returnValue === "confirm" ? $("pw-input").value : null);
    };
    dialog.showModal();
    $("pw-input").focus();
  });
}

async function verifyPassword(post, heading) {
  let wrong = false;
  while (true) {
    const pw = await askPassword(heading, wrong);
    if (pw === null) return false;
    if (await sha256(pw) === post.pwHash) return true;
    wrong = true;
  }
}

async function beginEdit(post) {
  if (!await verifyPassword(post, "수정하려면 비밀번호를 입력하세요")) return;
  editingId = post.id;
  openForm();
  $("form-heading").textContent = `「${post.title}」 수정 중`;
  $("submit-btn").textContent = "수정 완료";
  $("f-name").value = post.name;
  $("f-title").value = post.title;
  $("f-body").value = post.body;
  $("f-contact").value = post.contact || "";
  $("f-password").required = false;
  $("f-password").placeholder = "변경할 때만 입력";
  $("compose-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function confirmDelete(post) {
  if (!await verifyPassword(post, "삭제하려면 비밀번호를 입력하세요")) return;
  await store.remove(post.id);
}

// ——— 자정 카운트다운 & 초기화 ———

function startCountdown() {
  let boundary = todayBoundary();
  const tick = () => {
    const remain = boundary + DAY - Date.now();
    if (remain <= 0) {
      // 자정 도래 — 새 하루 시작
      boundary = todayBoundary();
      renderMasthead();
      store.refresh();
      return;
    }
    const h = Math.floor(remain / 3600000);
    const m = Math.floor(remain % 3600000 / 60000);
    const s = Math.floor(remain % 60000 / 1000);
    $("countdown").textContent =
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ——— 시작 ———

async function main() {
  renderMasthead();

  if (window.FIREBASE_CONFIG) {
    try {
      store = await makeFirebaseStore(window.FIREBASE_CONFIG);
    } catch (err) {
      console.error("Firebase 연결 실패, 로컬 모드로 전환:", err);
      store = makeLocalStore();
    }
  } else {
    store = makeLocalStore();
  }
  $("mode-badge").hidden = store.mode !== "local";

  store.subscribe(list => { posts = list; renderPosts(); });

  $("compose-toggle").onclick = openForm;
  $("cancel-btn").onclick = closeForm;
  $("compose-form").onsubmit = handleSubmit;
  // 다이얼로그의 확인 버튼은 빈 비밀번호로도 닫히도록 폼 검증 없음
  $("pw-form").onsubmit = () => {};

  startCountdown();
}

main();
