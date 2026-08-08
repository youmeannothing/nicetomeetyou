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

// ——— 본문 꾸미기 (**굵게** *기울임* __밑줄__ ~~취소선~~ ==형광==) ———

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRich(text) {
  let h = escapeHtml(text);
  h = h
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  h = h.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return h.replace(/\n/g, "<br>");
}

// 카드 미리보기용 — 꾸밈 표시 제거한 순수 텍스트
function stripMarks(s) {
  return s.replace(/(\*\*|__|~~|==|\*)/g, "");
}

// "#러닝 #홍대" → ["러닝","홍대"] (최대 5개, 중복 제거)
function parseTags(raw) {
  return [...new Set(
    raw.split(/[\s,]+/)
      .map(t => t.replace(/^#+/, "").trim())
      .filter(Boolean)
      .map(t => t.slice(0, 15))
  )].slice(0, 5);
}

function normalizeUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w-]+(\.[\w-]+)+/.test(u)) return "https://" + u;
  return "";
}

// ——— 이미지 첨부: 리사이즈 + JPEG 압축 → data URL ———

function compressImage(file, maxDim = 1000, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없습니다")); };
    img.src = url;
  });
}

async function pickImage(file) {
  let data = await compressImage(file);
  if (data.length > 700_000) data = await compressImage(file, 800, 0.6);
  if (data.length > 700_000) throw new Error("이미지가 너무 큽니다. 더 작은 이미지를 선택해주세요.");
  return data;
}

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
let editingId = null;    // 수정 중인 글 id
let attachedImage = null; // 첨부 이미지 data URL
let activeTag = null;    // 태그 필터

function renderMasthead() {
  $("date-str").textContent = fmtDate.format(new Date());
}

function postMetaText(p) {
  return `${p.name || "익명"} · ${fmtTime.format(new Date(p.createdAt))}`
    + (p.editedAt ? " (수정됨)" : "");
}

function setFilter(tag) {
  activeTag = activeTag === tag ? null : tag;
  renderPosts();
}

function renderTagBar() {
  const bar = $("tag-bar");
  const counts = new Map();
  posts.forEach(p => (p.tags || []).forEach(t =>
    counts.set(t, (counts.get(t) || 0) + 1)));

  if (activeTag && !counts.has(activeTag)) activeTag = null;
  bar.hidden = counts.size === 0;
  bar.innerHTML = "";
  if (counts.size === 0) return;

  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip" + (activeTag === null ? " on" : "");
  all.textContent = "전체";
  all.onclick = () => { activeTag = null; renderPosts(); };
  bar.appendChild(all);

  [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a)).forEach(t => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (activeTag === t ? " on" : "");
    chip.textContent = "#" + t;
    chip.onclick = () => setFilter(t);
    bar.appendChild(chip);
  });
}

function renderPosts() {
  const list = $("post-list");
  list.innerHTML = "";
  renderTagBar();

  const shown = activeTag
    ? posts.filter(p => (p.tags || []).includes(activeTag))
    : posts;

  $("post-count").textContent = shown.length;
  const empty = $("empty-state");
  empty.hidden = shown.length > 0;
  empty.textContent = activeTag
    ? `#${activeTag} 태그의 글이 없습니다.`
    : "아직 글이 없습니다. 오늘의 첫 글을 남겨보세요.";

  shown.forEach(p => {
    const li = document.createElement("li");
    li.className = "card";
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    if (p.image) {
      const thumb = document.createElement("img");
      thumb.className = "card-thumb";
      thumb.src = p.image;
      thumb.alt = "";
      li.appendChild(thumb);
    }

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = p.title;

    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = postMetaText(p);

    const preview = document.createElement("p");
    preview.className = "card-preview";
    preview.textContent = stripMarks(p.body);

    li.append(title, meta, preview);

    if (p.tags?.length || p.link || p.contact) {
      const tags = document.createElement("div");
      tags.className = "card-tags";
      (p.tags || []).forEach(t => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "hash";
        chip.textContent = "#" + t;
        chip.onclick = e => { e.stopPropagation(); setFilter(t); };
        tags.appendChild(chip);
      });
      if (p.link) tags.append(Object.assign(document.createElement("span"), { textContent: "링크" }));
      if (p.contact) tags.append(Object.assign(document.createElement("span"), { textContent: "연락" }));
      li.appendChild(tags);
    }

    const open = () => viewPost(p);
    li.onclick = open;
    li.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };

    list.appendChild(li);
  });
}

// ——— 전체 글 보기 모달 ———

function viewPost(p) {
  const dlg = $("view-dialog");
  $("v-title").textContent = p.title;
  $("v-meta").textContent = postMetaText(p);
  $("v-body").innerHTML = renderRich(p.body);

  const vTags = $("v-tags");
  vTags.hidden = !p.tags?.length;
  vTags.innerHTML = "";
  (p.tags || []).forEach(t => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "hash";
    chip.textContent = "#" + t;
    chip.onclick = () => { dlg.close(); setFilter(t); };
    vTags.appendChild(chip);
  });

  const img = $("v-image");
  img.hidden = !p.image;
  if (p.image) img.src = p.image;

  const link = $("v-link");
  const url = normalizeUrl(p.link);
  link.hidden = !url;
  if (url) { link.href = url; link.textContent = "🔗 " + url; }

  const contact = $("v-contact");
  contact.hidden = !p.contact;
  if (p.contact) {
    contact.innerHTML = "";
    const label = document.createElement("b");
    label.textContent = "연락";
    contact.append(label, document.createTextNode(p.contact));
  }

  $("v-edit").onclick = () => { dlg.close(); beginEdit(p); };
  $("v-del").onclick = () => { dlg.close(); confirmDelete(p); };
  dlg.showModal();
}

// ——— 글쓰기 폼 ———

function setImageNote(name) {
  $("image-note").hidden = !name;
  $("image-name").textContent = name ? "🖼 " + name : "";
}

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
  attachedImage = null;
  setImageNote(null);
  $("link-row").hidden = true;
  $("form-heading").textContent = "새 글 쓰기";
  $("submit-btn").textContent = "게재";
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
      link: $("f-link").value.trim(),
      tags: parseTags($("f-tags").value),
      contact: $("f-contact").value.trim(),
      image: attachedImage,
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
  $("f-link").value = post.link || "";
  $("link-row").hidden = !post.link;
  $("f-tags").value = (post.tags || []).map(t => "#" + t).join(" ");
  $("f-contact").value = post.contact || "";
  $("f-password").required = false;
  $("f-password").placeholder = "변경할 때만 입력";
  attachedImage = post.image || null;
  setImageNote(attachedImage ? "기존 이미지 유지" : null);
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
  $("pw-form").onsubmit = () => {};

  // 텍스트 꾸미기 툴바
  $("toolbar").addEventListener("click", e => {
    const btn = e.target.closest("button[data-mark]");
    if (!btn) return;
    const mark = btn.dataset.mark;
    const ta = $("f-body");
    const { selectionStart: s, selectionEnd: en, value: v } = ta;
    const sel = v.slice(s, en) || "텍스트";
    ta.value = v.slice(0, s) + mark + sel + mark + v.slice(en);
    ta.focus();
    ta.setSelectionRange(s + mark.length, s + mark.length + sel.length);
  });

  // 링크 첨부 (툴바 아이콘 → 입력줄 토글)
  $("link-btn").onclick = () => {
    const row = $("link-row");
    row.hidden = !row.hidden;
    if (!row.hidden) $("f-link").focus();
  };

  // 이미지 첨부
  $("image-btn").onclick = () => $("f-image").click();
  $("f-image").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      attachedImage = await pickImage(file);
      setImageNote(file.name);
    } catch (err) {
      alert(err.message);
      e.target.value = "";
    }
  };
  $("image-remove").onclick = () => {
    attachedImage = null;
    $("f-image").value = "";
    setImageNote(null);
  };

  $("v-close").onclick = () => $("view-dialog").close();

  startCountdown();
}

main();
