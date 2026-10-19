const roleLabels = {
  developer: "Developer",
  admin: "Administrator",
  teacher: "Teacher",
  student: "Student",
};

const viewTitles = {
  overview: ["Overview", "Welcome to the Nag-iba National High School portal."],
  users: ["Accounts", "Manage school portal accounts permitted for your role."],
  announcements: ["Announcements", "School and classroom updates."],
  "lesson-plans": ["Lesson Plans", "Schedule, submit and review daily lesson plans."],
  ancillary: ["Ancillary Tasks", "Manually assigned tasks and document submissions."],
  settings: ["Settings", "Your profile, sign-in details and class schedule."],
};

// New tabs register themselves from features.js: registerView(name, [title, subtitle], { allowed, onEnter }).
const viewRegistry = {};
function registerView(name, titles, options = {}) { viewTitles[name] = titles; viewRegistry[name] = options; }
const portalHooks = { onLogin: [], onLogout: [] };

let currentUser = null;
let currentView = "overview";
let managedUsers = [];
let directory = [];
let messages = [];
let announcements = [];
let editingUserId = null;
let toastTimer;
const isStaticHost = window.location.protocol === "file:"
  || window.location.hostname === "github.io"
  || window.location.hostname.endsWith(".github.io");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

function formatDate(value) {
  if (!value) return "No deadline";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No deadline";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function roleClass(role) {
  return `role-${role}`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = response.headers.get("content-type") || "";
  if (response.status !== 204 && !contentType.includes("application/json")) {
    throw new Error("This website is missing its application server. Open the deployed school portal URL, not the GitHub Pages preview.");
  }
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (response.status === 401 && currentUser) showLogin();
    throw new Error(payload.error || "The request could not be completed.");
  }
  return payload;
}

function setGlobalError(message = "") {
  const element = document.querySelector("#global-error");
  element.textContent = message;
  element.hidden = !message;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

function showLogin() {
  portalHooks.onLogout.forEach((hook) => { try { hook(); } catch (_) {} });
  currentUser = null;
  document.querySelector("#dashboard-app").hidden = true;
  document.querySelector("#login-screen").hidden = false;
  document.querySelector("#login-password").value = "";
  document.querySelector("#login-username").focus();
}

function userCanManageAccounts() {
  return ["developer", "admin", "teacher"].includes(currentUser.role);
}

function rolesActorCanCreate() {
  if (currentUser.role === "developer") return ["admin"];
  if (currentUser.role === "admin") return ["admin", "teacher", "student"];
  if (currentUser.role === "teacher") return ["student"];
  return [];
}

function updateNavigation() {
  const canManage = userCanManageAccounts();
  document.querySelector("#users-nav").hidden = !canManage;
  document.querySelector("#users-nav-label").textContent = currentUser.role === "developer" ? "Admins" : "Accounts";
  document.querySelectorAll("[data-roles]").forEach((el) => { el.hidden = !el.dataset.roles.split(",").includes(currentUser.role); });
  document.querySelector("#lesson-plans-nav").hidden = !["admin","developer","teacher"].includes(currentUser.role);
  const lpAdminRole = ["admin","developer"].includes(currentUser.role);
  document.querySelector("#ancillary-nav").hidden = currentUser.role === "student";
  document.querySelector("#anc-compose-panel").hidden = !lpAdminRole;
  document.querySelector("#anc-subtitle").textContent = lpAdminRole ? "Create manual tasks (like MPS), assign them to all or selected teachers, and review the documents they upload." : "Tasks assigned to you by the administrator. Upload any document to submit.";
  document.querySelectorAll("#view-lesson-plans [data-admin-only]").forEach(el => { el.hidden = !lpAdminRole; });
  document.querySelector("#lesson-plan-admin-panel").hidden = !lpAdminRole;
  document.querySelector("#lp-page-subtitle").textContent = lpAdminRole
    ? "Schedule instruction, assign subjects to teachers, and review submissions."
    : "Choose a term, pick one of your subjects, then select a day on the calendar to open or upload that day's lesson plan.";
  setLpTab("overview");
  document.querySelector("#add-user-button").hidden = !canManage;
  document.querySelector("#active-role").textContent = roleLabels[currentUser.role];
  document.querySelector("#profile-name").textContent = currentUser.displayName;
  document.querySelector("#profile-role").textContent = roleLabels[currentUser.role];
  document.querySelector("#profile-avatar").textContent = currentUser.displayName
    .split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  document.querySelector("#welcome-heading").textContent = `Welcome, ${currentUser.displayName}`;
  document.querySelector("#users-heading").textContent = currentUser.role === "developer"
    ? "Administrator accounts" : currentUser.role === "teacher" ? "Student accounts" : "School accounts";
  document.querySelector("#users-description").textContent = currentUser.role === "developer"
    ? "Create and manage administrator access for the school portal."
    : currentUser.role === "teacher"
      ? "Create and manage student accounts for your classes."
      : "Manage administrator, teacher, and student portal accounts.";
}

let previousView = null;
function goToView(view) {
  // Retired tabs now live elsewhere: keep any old link working.
  if (view === "messages") { openMessagesPanel(); return; }
  if (view === "create-announcement") { if (typeof openAnnouncementDialog === "function") openAnnouncementDialog(); return; }
  if (view === "summary") { if (!isLpAdmin()) return; goToView("lesson-plans"); setLpTab("summary"); return; }
  if (!viewTitles[view]) return;
  if (view === "users" && !userCanManageAccounts()) return;
  if (view === "ancillary" && currentUser.role === "student") return;
  if (view === "lesson-plans" && currentUser.role === "student") return;
  if (viewRegistry[view]?.allowed && !viewRegistry[view].allowed()) return;
  previousView = currentView;
  currentView = view;
  for (const section of document.querySelectorAll(".portal-view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  document.querySelector("#breadcrumb-current").textContent = viewTitles[view][0];
  document.querySelector("#page-title").textContent = viewTitles[view][0];
  document.querySelector("#page-description").textContent = viewTitles[view][1];
  setGlobalError();
  closeSidebar();
  try { sessionStorage.setItem("portalView", view); } catch (_) {}
  document.querySelector("#main-content").scrollTo?.(0, 0); window.scrollTo(0, 0);
  if (view === "users") refreshUsers();
  if (view === "announcements") refreshAnnouncements();
  if (view === "ancillary") refreshAncillary();
  if (view === "lesson-plans") refreshLessonPlans();
  if (view !== "lesson-plans") closeLpDrawer();
  if (view === "announcements" || view === "memos") setAnnounceOpen(true);
  viewRegistry[view]?.onEnter?.();
}

function renderOverview() {
  const unread = messages.filter((message) =>
    String(message.recipient_id) === String(currentUser.id) && !message.read_at
  ).length;
  const accountLabel = currentUser.role === "developer"
    ? "Administrator accounts"
    : currentUser.role === "teacher" ? "Student accounts" : "School accounts";
  const cards = currentUser.role === "student"
    ? [
      { label: "Unread messages", value: unread, tone: "teal" },
      { label: "Announcements", value: announcements.length, tone: "amber" },
    ]
    : [
      { label: accountLabel, value: managedUsers.filter((user) => user.active).length, tone: "blue" },
      { label: "Unread messages", value: unread, tone: "teal" },
      { label: "Announcements", value: announcements.length, tone: "amber" },
    ];
  document.querySelector("#overview-stats").innerHTML = cards.map((card) => `
    <div class="stat-card overview-stat" data-tone="${card.tone}">
      <span class="stat-label"><i class="stat-marker"></i>${escapeHtml(card.label)}</span>
      <span class="stat-value">${card.value}</span>
    </div>
  `).join("");

  document.querySelector("#overview-announcements").innerHTML = announcements.length
    ? announcements.slice(0, 3).map((item) => feedItem(item.title, item.body, `${item.author_name} · ${formatDate(item.created_at)}`)).join("")
    : emptyFeed("No announcements have been posted yet.");
  const unreadBadge = document.querySelector("#unread-count");
  unreadBadge.textContent = unread ? String(unread) : "";
  unreadBadge.hidden = unread === 0;
}

function emptyFeed(message) {
  return `<div class="empty-feed">${escapeHtml(message)}</div>`;
}

function feedItem(title, body, meta) {
  return `<article class="feed-item"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p><small>${escapeHtml(meta)}</small></article>`;
}

async function refreshOverview() {
  const [userResult, directoryResult, messageResult, announcementResult] = await Promise.all([
    userCanManageAccounts() ? api("/api/users") : Promise.resolve({ users: [] }),
    api("/api/directory"),
    api("/api/messages"),
    api("/api/announcements"),
  ]);
  managedUsers = userResult.users;
  directory = directoryResult.users;
  messages = messageResult.messages;
  announcements = announcementResult.announcements;
  renderOverview();
}

function renderUsers() {
  const search = document.querySelector("#user-search").value.trim().toLowerCase();
  const users = managedUsers.filter((user) =>
    `${user.displayName} ${user.username} ${user.role}`.toLowerCase().includes(search)
  );
  const rows = document.querySelector("#user-rows");
  rows.innerHTML = users.length ? users.map((user) => `
    <tr>
      <td><span class="doc-name">${escapeHtml(user.displayName)}</span><span class="doc-subtitle">${escapeHtml(user.email || "No email")}</span></td>
      <td>${escapeHtml(user.username)}</td>
      <td><span class="role-badge ${roleClass(user.role)}">${escapeHtml(roleLabels[user.role])}</span></td>
      <td><span class="status-pill status-${user.active ? "accepted" : "pending"}">${user.active ? "Active" : "Inactive"}</span></td>
      <td><div class="row-actions"><button class="action-link" type="button" data-edit-user="${escapeHtml(user.id)}">Edit</button><button class="action-link danger-link" type="button" data-delete-user="${escapeHtml(user.id)}">Delete</button></div></td>
    </tr>
  `).join("") : '<tr><td class="empty-row" colspan="5">No accounts found.</td></tr>';
  document.querySelector("#user-count").textContent = `Showing ${users.length} of ${managedUsers.length} accounts`;
}

function renderMessages() {
  const list = document.querySelector("#message-list");
  list.innerHTML = messages.length ? messages.map((message) => {
    const received = String(message.recipient_id) === String(currentUser.id);
    const person = received ? message.sender_name : message.recipient_name;
    const direction = received ? "Received" : "Sent";
    const unread = received && !message.read_at;
    return `<article class="message-item${unread ? " unread" : ""}">
      <div class="message-avatar">${escapeHtml(person.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase())}</div>
      <div class="message-content"><div class="message-meta"><strong>${escapeHtml(person)}</strong><span>${direction} · ${formatDate(message.created_at)}</span></div><p>${escapeHtml(message.body)}</p>${unread ? `<button class="action-link" type="button" data-read-message="${escapeHtml(message.id)}">Mark as read</button>` : ""}</div>
    </article>`;
  }).join("") : emptyFeed("No messages yet. Start a conversation using the form.");
}

function populateRecipientOptions() {
  const recipients = directory.filter((user) => String(user.id) !== String(currentUser.id));
  const recipientSelect = document.querySelector("#message-recipient");
  recipientSelect.innerHTML = '<option value="">Choose a school account</option>' + recipients.map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)} · ${escapeHtml(roleLabels[user.role])}</option>`
  ).join("");
}

function announcementEndLabel(item) {
  if (!item.expires_at) return "No end date";
  const end = new Date(item.expires_at);
  const hours = (end.getTime() - Date.now()) / 3600000;
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(end);
  if (hours <= 0) return "Ending now";
  if (hours < 24) return `Ends today · ${when}`;
  return `Ends in ${Math.ceil(hours / 24)} day${Math.ceil(hours / 24) === 1 ? "" : "s"} · ${when}`;
}

function renderAnnouncements() {
  document.querySelector("#announcement-list").innerHTML = announcements.length
    ? announcements.map((item) => {
      const photos = item.images || [];
      const gallery = photos.length
        ? `<div class="pubmat-gallery pubmat-${Math.min(photos.length, 4)}">${photos.map((photo) => `<button type="button" class="pubmat-photo" data-photo="${escapeHtml(photo.id)}" data-photo-title="${escapeHtml(item.title)}" aria-label="Enlarge photo for ${escapeHtml(item.title)}"><img loading="lazy" src="/api/announcements/images/${encodeURIComponent(photo.id)}" alt="${escapeHtml(item.title)}" /></button>`).join("")}</div>`
        : "";
      const canDelete = ["admin", "developer"].includes(currentUser.role) || String(item.author_id) === String(currentUser.id);
      return `<article class="content-card announcement-card${photos.length ? " has-photos" : ""}">${gallery}<div class="announcement-text"><div class="content-card-heading"><h3>${escapeHtml(item.title)}</h3><span>${formatDate(item.created_at)}</span></div><p>${escapeHtml(item.body)}</p><small>Posted by ${escapeHtml(item.author_name || "School account")} · <span class="announcement-end">${escapeHtml(announcementEndLabel(item))}</span></small>${canDelete ? `<div class="row-actions"><button class="action-link danger-link" type="button" data-delete-announcement="${escapeHtml(item.id)}">Delete announcement</button></div>` : ""}</div></article>`;
    }).join("")
    : emptyFeed("No announcements right now.");
}

/* ---------- Lesson plans: status model ---------- */
const LP_MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const LP_WEEKDAYS=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
function lpInfo(t){
  const s=String(t.status||"").toLowerCase();
  const late=!!t.submitted_late;
  if(!t.upload_id && t.retained_submitted_at) return {tone:"revision",label:"Re-upload requested",short:"Re-upload"};
  if(s==="overdue") return {tone:"overdue",label:"Overdue",short:"Overdue"};
  if(s==="completed") return late?{tone:"done-late",label:"Completed late",short:"Done late"}:{tone:"done",label:"Completed on time",short:"Done"};
  if(s==="approved") return late?{tone:"done-late",label:"Approved · completed late",short:"Done late"}:{tone:"done",label:"Approved · on time",short:"Approved"};
  if(s==="late") return {tone:"done-late",label:"Submitted late",short:"Late"};
  if(s==="for revision") return {tone:"revision",label:"For revision",short:"Revise"};
  if(s==="submitted") return {tone:"review",label:"Submitted · awaiting review",short:"In review"};
  return {tone:"pending",label:"Awaiting upload",short:"To do"};
}
const lpDay=t=>String(t.due_date).slice(0,10);
// Yellow warning triangle: shown to admins while a flagged upload (blank, not a lesson plan, or duplicate) is not yet approved.
const LP_TRI='<svg class="lp-tri" viewBox="0 0 24 24" role="img" aria-label="Warning"><path class="lp-tri-body" d="M12 2.6 1.9 20.4h20.2z"/><path class="lp-tri-mark" d="M12 9.2v5.3M12 17.3v.2"/></svg>';
const lpFlagged=t=>!!t.upload_id && !!t.flag_codes && !["approved","completed"].includes(String(t.status||"").toLowerCase());
const lpTriBadge=(n,label)=>n>0?`<span class="lp-tri-badge" title="${n} ${label||"flagged"}">${LP_TRI}${n>1?`<b>${n}</b>`:""}</span>`:"";
function lpDateLabel(iso,opts){ const [y,m,d]=iso.split("-").map(Number); return new Intl.DateTimeFormat(undefined,opts||{weekday:"long",month:"long",day:"numeric",year:"numeric"}).format(new Date(y,m-1,d)); }
function lpChip(t){ const i=lpInfo(t); return `<span class="lp-chip lp-${i.tone}">${i.label}</span>`; }
function lpTodayIso(){ const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`; }

/* ---------- Lesson plans: state ---------- */
let lessonPlanTasks = [];
let lessonPlanAssignments = [];
let selectedLpSubject = null;
let selectedLpTeacherId = null;
let selectedLpSubjectId = null;
let lpTeacherSubjectId = null;
const lpCal = { teacher:{month:null,key:""}, admin:{month:null,key:""} };
let lpOpenDay = null;
let lpNotifTasks = new Map();
function isLpAdmin() { return ["admin","developer"].includes(currentUser?.role); }
function lpTerm(){ return document.querySelector("#lp-view-term")?.value || ""; }

function setLpTab(tab){
  if(tab!=="progress") closeLpDrawer();
  const view=document.querySelector("#view-lesson-plans");
  view.dataset.lpTab=tab;
  view.querySelectorAll("[data-lp-pane]").forEach(el=>el.classList.toggle("lp-pane-off",el.dataset.lpPane!==tab));
  view.querySelectorAll(".lp-tab").forEach(b=>{const on=b.dataset.lpTab===tab;b.classList.toggle("is-active",on);b.setAttribute("aria-selected",on);});
  // The Summary tab has its own term filter, so hide the shared term picker there.
  document.querySelector("#lp-term-panel")?.classList.toggle("lp-pane-off",tab==="summary");
  if(tab==="summary") refreshSummary();
}


/* ---------- Admin helpers: JHS / SHS grouping, review counters, collapsible teachers ---------- */
const LP_JHS_USERNAMES=["bennie","joven","rio","andria","gesabeth","angie","mycel","jen","johnbryan","charize","marjorie","jane","reagan","pablo","mechelle","shally","zheanyth","jhunness","irene","clarenze"];
const LP_SHS_USERNAMES=["alfrancis","alex","amie","ancen","sircj","francis","pauline","jed","lester","kiana","meann","mau","monica","rachiel","renan"];
const LP_SHS_NAME_KEYS=["rona joy","christian james"];
const LP_GROUPS=[{key:"jhs",label:"Junior High School Teachers"},{key:"shs",label:"Senior High School Teachers"},{key:"other",label:"Other Teachers"}];
function lpTeacherGroup(teacherId,teacherName){
  const u=(directory||[]).find(x=>String(x.id)===String(teacherId));
  const uname=String(u?.username||"").toLowerCase();
  if(LP_JHS_USERNAMES.includes(uname)) return "jhs";
  if(LP_SHS_USERNAMES.includes(uname)) return "shs";
  const nm=String(teacherName||"").toLowerCase().replace(/[^a-z ]/g," ").replace(/\s+/g," ").trim();
  if(LP_SHS_NAME_KEYS.some(k=>nm.startsWith(k))) return "shs";
  return "other";
}
const lpNeedsReview=t=>!!t.upload_id && ["submitted","late"].includes(String(t.status||"").toLowerCase());
const lpDot=n=>n>0?`<span class="review-dot" title="${n} to review" aria-label="${n} to review">${n}</span>`:"";
const accOpen={assign:null,summary:null};
let lpAssignQuery="", summaryQuery="", lpTeachersCache=[];
const lpNorm=v=>String(v||"").toLowerCase().replace(/\s+/g," ").trim();
// Keep a teacher if the query matches the teacher or any subject; if only subjects match, keep just those subjects.
function lpFilterSubjects(teacherName,subjects,nameOf,query){
  const q=lpNorm(query); if(!q) return subjects;
  if(lpNorm(teacherName).includes(q)) return subjects;
  return subjects.filter(s=>lpNorm(nameOf(s)).includes(q));
}
function lpGroupedMarkup(entries,renderEntry){
  // entries: [{group, ...}] -> grouped sections in JHS, SHS, Other order
  return LP_GROUPS.map(g=>{
    const list=entries.filter(e=>e.group===g.key);
    if(!list.length) return "";
    return `<section class="teacher-group"><h3 class="teacher-group-title">${g.label}<span class="teacher-group-count">${list.length}</span></h3>${list.map(renderEntry).join("")}</section>`;
  }).join("");
}
function accItem(scope,id,headInner,bodyInner,extraClass){
  const open=String(accOpen[scope])===String(id);
  return `<article class="acc-item ${extraClass||""}${open?" is-open":""}" data-acc-scope="${scope}" data-acc-id="${id}"><button type="button" class="acc-head" aria-expanded="${open}"><span class="acc-chevron" aria-hidden="true">&#9656;</span><span class="acc-title">${headInner}</span></button><div class="acc-body"${open?"":" hidden"}>${bodyInner}</div></article>`;
}
document.addEventListener("click",(event)=>{
  const head=event.target.closest(".acc-head"); if(!head) return;
  const item=head.closest(".acc-item"); const scope=item.dataset.accScope; const root=item.closest("[data-acc-root]")||document;
  const willOpen=!item.classList.contains("is-open");
  root.querySelectorAll(`.acc-item[data-acc-scope="${scope}"]`).forEach(el=>{el.classList.remove("is-open");el.querySelector(".acc-head").setAttribute("aria-expanded","false");el.querySelector(".acc-body").hidden=true;});
  if(willOpen){item.classList.add("is-open");head.setAttribute("aria-expanded","true");item.querySelector(".acc-body").hidden=false;accOpen[scope]=item.dataset.accId;}
  else accOpen[scope]=null;
});

/* Notification "seen" tracking (admin only) */
function lpSeenKey(){ return `lpSeen:${currentUser?.id}`; }
function lpSeenSet(){ try{ return new Set(JSON.parse(localStorage.getItem(lpSeenKey())||"[]")); }catch(_){ return new Set(); } }
const lpNotifKey=t=>`${t.id}|${String(t.status||"").toLowerCase()}|${t.submitted_at||""}`;
function lpMarkSeen(t){ try{ const s=lpSeenSet(); s.add(lpNotifKey(t)); localStorage.setItem(lpSeenKey(),JSON.stringify([...s].slice(-500))); }catch(_){} }

/* ---------- Lesson plans: calendar ---------- */
function lpCalendarMarkup(scope, tasks){
  const state=lpCal[scope];
  const days=new Map();
  tasks.forEach(t=>{const k=lpDay(t); if(!days.has(k))days.set(k,[]); days.get(k).push(t);});
  const keys=[...days.keys()].sort();
  if(!keys.length) return emptyFeed("No calendar entries for this term and selection.");
  const monthOf=k=>k.slice(0,7);
  const first=monthOf(keys[0]), last=monthOf(keys[keys.length-1]);
  const dataKey=`${keys[0]}|${keys[keys.length-1]}|${tasks.length&&tasks[0].subject_id}`;
  if(state.key!==dataKey){ state.key=dataKey; const nowM=lpTodayIso().slice(0,7); state.month = (nowM>=first&&nowM<=last)?nowM:first; }
  if(state.month<first) state.month=first; if(state.month>last) state.month=last;
  const [y,m]=state.month.split("-").map(Number);
  const firstDow=(new Date(y,m-1,1).getDay()+6)%7;
  const dim=new Date(y,m,0).getDate();
  const today=lpTodayIso();
  let cells=LP_WEEKDAYS.map(d=>`<div class="lp-cal-dow">${d}</div>`).join("");
  for(let i=0;i<firstDow;i++) cells+=`<div class="lp-cal-cell lp-cal-empty"></div>`;
  for(let d=1; d<=dim; d++){
    const iso=`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const list=days.get(iso);
    const todayCls=iso===today?" is-today":"";
    if(!list){ cells+=`<div class="lp-cal-cell lp-cal-none${todayCls}"><span class="lp-cal-num">${d}</span></div>`; continue; }
    const t=list[0], info=lpInfo(t);
    const flagged=scope==="admin" && list.some(lpFlagged);
    const wk=list.length>1?`${list.length} plans`:`Wk ${t.week_number} · D${t.day_number}`;
    cells+=`<button type="button" class="lp-cal-cell lp-cal-task lp-${info.tone}${todayCls}" data-lp-day="${iso}" data-lp-scope="${scope}" aria-label="${escapeHtml(lpDateLabel(iso))}: ${escapeHtml(info.label)}${flagged?" (warning: check this upload)":""}"><span class="lp-cal-num">${d}</span>${flagged?`<span class="lp-cal-tri" title="Needs a closer look: ${escapeHtml(list.find(lpFlagged).flag_reason||"flagged upload")}">${LP_TRI}</span>`:""}<span class="lp-cal-wk">${wk}</span><span class="lp-cal-status">${info.short}</span></button>`;
  }
  const counts={}; tasks.forEach(t=>{const k=lpInfo(t).tone; counts[k]=(counts[k]||0)+1;});
  const done=(counts.done||0)+(counts["done-late"]||0);
  const pct=tasks.length?Math.round(done/tasks.length*100):0;
  const legend=[["overdue","Overdue"],["done","Completed on time"],["done-late","Completed late"],["review","In review"],["revision","For revision"],["pending","Awaiting upload"]].map(([k,l])=>`<span class="lp-legend-item"><i class="lp-dot lp-${k}"></i>${l}${counts[k]?` <b>${counts[k]}</b>`:""}</span>`).join("");
  return `<div class="lp-cal">
    <div class="lp-cal-bar"><div class="lp-cal-nav"><button type="button" class="lp-nav-btn" data-lp-cal-nav="-1" data-lp-scope="${scope}" aria-label="Previous month" ${state.month<=first?"disabled":""}>&#8249;</button><h3>${LP_MONTHS[m-1]} ${y}</h3><button type="button" class="lp-nav-btn" data-lp-cal-nav="1" data-lp-scope="${scope}" aria-label="Next month" ${state.month>=last?"disabled":""}>&#8250;</button></div>
    <div class="lp-cal-progress" title="${done} of ${tasks.length} completed"><span>${done}/${tasks.length} completed</span><div class="lp-bar"><i style="width:${pct}%"></i></div></div></div>
    <div class="lp-cal-grid">${cells}</div>
    <div class="lp-legend">${legend}</div>
    <p class="lp-cal-hint">Select a highlighted day to open that day's lesson plan.</p></div>`;
}

function lpAdminVisibleTasks(){
  return lessonPlanTasks.filter(t=>String(t.teacher_id)===String(selectedLpTeacherId) && (selectedLpSubjectId==null || String(t.subject_id)===String(selectedLpSubjectId)));
}

/* Admin calendar: a drawer that slides in from the right. Pick a teacher, then move between their subjects. */
const lpDrawer={open:false};
function closeLpDrawer(){
  lpDrawer.open=false;
  const panel=document.querySelector("#lesson-plan-task-panel"); if(!panel) return;
  panel.classList.remove("is-open"); panel.setAttribute("aria-hidden","true");
  document.querySelector("#lp-drawer-scrim")?.classList.remove("is-open");
}
function openLpDrawer(teacherId,subjectId){
  if(!lpTerm()){ setGlobalError("Choose a term first to view lesson plans."); return; }
  selectedLpTeacherId=teacherId!=null?String(teacherId):null;
  selectedLpSubjectId=subjectId!=null?String(subjectId):null;
  lpDrawer.open=true;
  const panel=document.querySelector("#lesson-plan-task-panel");
  panel.classList.add("is-open"); panel.setAttribute("aria-hidden","false");
  document.querySelector("#lp-drawer-scrim").classList.add("is-open");
  renderLpDrawer();
  panel.querySelector("select")?.focus({preventScroll:true});
}
function renderLpDrawer(){
  const panel=document.querySelector("#lesson-plan-task-panel");
  const select=document.querySelector("#lp-drawer-teacher");
  const teachers=new Map();
  lessonPlanTasks.forEach(t=>{ if(!teachers.has(String(t.teacher_id))) teachers.set(String(t.teacher_id),{id:String(t.teacher_id),name:t.teacher_name,review:0,flagged:0}); const g=teachers.get(String(t.teacher_id)); if(lpNeedsReview(t)) g.review++; if(lpFlagged(t)) g.flagged++; });
  const list=[...teachers.values()].sort((a,b)=>a.name.localeCompare(b.name));
  document.querySelector("#lp-drawer-kicker").textContent=`Term ${lpTerm()||"–"} · Lesson plans`;
  if(!list.length){
    select.innerHTML='<option value="">No teachers scheduled</option>'; document.querySelector("#lp-drawer-subjects").innerHTML="";
    document.querySelector("#lp-task-detail-heading").textContent="Lesson-plan calendar";
    document.querySelector("#lesson-plan-task-list").innerHTML=emptyFeed("No teacher has a lesson-plan schedule for this term yet."); return;
  }
  if(!teachers.has(String(selectedLpTeacherId))) selectedLpTeacherId=list[0].id;
  select.innerHTML=list.map(g=>`<option value="${escapeHtml(g.id)}" ${g.id===String(selectedLpTeacherId)?"selected":""}>${escapeHtml(g.name)}${g.flagged?" \u26A0":""}${g.review?` (${g.review} to review)`:""}</option>`).join("");
  const subjects=new Map();
  lessonPlanTasks.filter(t=>String(t.teacher_id)===String(selectedLpTeacherId)).forEach(t=>{ const k=String(t.subject_id); if(!subjects.has(k)) subjects.set(k,{id:k,name:t.subject_name,review:0,flagged:0,overdue:0}); const g=subjects.get(k); if(lpNeedsReview(t)) g.review++; if(lpFlagged(t)) g.flagged++; if(lpInfo(t).tone==="overdue") g.overdue++; });
  const subjectList=[...subjects.values()].sort((a,b)=>a.name.localeCompare(b.name));
  if(!subjects.has(String(selectedLpSubjectId))) selectedLpSubjectId=subjectList[0]?.id??null;
  const teacherName=teachers.get(String(selectedLpTeacherId)).name;
  const current=subjects.get(String(selectedLpSubjectId));
  document.querySelector("#lp-task-detail-heading").textContent=current?`${teacherName} · ${current.name}`:teacherName;
  document.querySelector("#lp-drawer-subjects").innerHTML=subjectList.map(g=>`<button type="button" role="tab" aria-selected="${g.id===String(selectedLpSubjectId)}" class="lp-subject-pill${g.id===String(selectedLpSubjectId)?" is-active":""}" data-lp-drawer-subject="${escapeHtml(g.id)}">${escapeHtml(g.name)}${g.flagged?`<span class="lp-pill-tri">${LP_TRI}</span>`:""}${g.review?`<span class="lp-pill-alert" title="${g.review} to review">${g.review}</span>`:""}</button>`).join("");
  document.querySelector("#lesson-plan-task-list").innerHTML=lpCalendarMarkup("admin",lpAdminVisibleTasks());
}

function renderLessonPlanTasks() {
  const admin=isLpAdmin();
  const term=lpTerm();
  if(admin){
    if(!term && lpDrawer.open) closeLpDrawer();
    if(lpDrawer.open) renderLpDrawer();
  } else {
    const host=document.querySelector("#lp-teacher-task-list");
    if(!term){ host.innerHTML=""; return; }
    const subjects=new Map();
    lessonPlanTasks.forEach(t=>{ const sid=String(t.subject_id); if(!subjects.has(sid)) subjects.set(sid,{id:sid,name:t.subject_name,tasks:[]}); subjects.get(sid).tasks.push(t); });
    if(!subjects.size){ host.innerHTML=`<section class="panel lp-cal-panel">${emptyFeed("No lesson-plan calendar assigned to you for this term yet.")}</section>`; return; }
    if(!subjects.has(String(lpTeacherSubjectId))) lpTeacherSubjectId=[...subjects.keys()][0]; lpTeacherSubjectId=String(lpTeacherSubjectId);
    const pills=[...subjects.values()].map(s=>{
      const over=s.tasks.filter(t=>lpInfo(t).tone==="overdue").length;
      return `<button type="button" class="lp-subject-pill${s.id===lpTeacherSubjectId?" is-active":""}" data-lp-subject-pill="${s.id}">${escapeHtml(s.name)}${over?`<span class="lp-pill-alert" title="${over} overdue">${over}</span>`:""}</button>`;
    }).join("");
    host.innerHTML=`<section class="panel lp-cal-panel"><div class="lp-subject-pills" role="tablist" aria-label="Your subjects">${pills}</div>${lpCalendarMarkup("teacher",subjects.get(lpTeacherSubjectId).tasks)}</section>`;
  }
  if(lpOpenDay && document.querySelector("#lp-day-dialog").open) renderLpDialog();
}

/* ---------- Lesson plans: day pop-up ---------- */
function lpTaskControls(t, admin){
  const submitted=!!t.upload_id;
  const state=String(t.status||"").toLowerCase();
  const revisionLink=t.admin_revision_file_name?`<button type="button" class="action-link" data-view-file="/api/lesson-plans/uploads/${t.upload_id}/revision-file" data-view-title="${escapeHtml(t.admin_revision_file_name)}">Attached PDF from the administrator: ${escapeHtml(t.admin_revision_file_name)}</button>`:"";
  const feedback=t.admin_feedback?`<p class="lp-feedback"><strong>Administrator's comment:</strong> ${escapeHtml(t.admin_feedback)}</p>`:"";
  const history=Number(t.revision_count)>0?`<details><summary>View previous revisions (${t.revision_count})</summary><div class="lp-history" data-history-task="${t.id}">Loading revision history…</div></details>`:"";
  const subInfo=submitted?`<p class="lp-meta">Passed ${formatDate(t.submitted_at)}${t.submitted_late?" · after the due date":""}${Number(t.revision_count)>0?` · ${t.revision_count} earlier revision(s)`:""}</p>`:"";
  const pdfLink=submitted?`<div class="lp-pdf-row"><button type="button" class="button button-primary lp-view-pdf" data-view-file="/api/lesson-plans/uploads/${t.upload_id}/file" data-view-title="${escapeHtml(t.file_name)}">View lesson plan</button><a class="action-link" href="/api/lesson-plans/uploads/${t.upload_id}/file?download=1">Download</a><small class="lp-pdf-name">${escapeHtml(t.file_name)}</small></div>`:"";
  const flagBanner=lpFlagged(t)?`<div class="lp-flag-banner" role="note">${LP_TRI}<div><strong>${admin?"Needs a closer look":"Submitted with a warning"}</strong><p>${escapeHtml(t.flag_reason||"This upload was flagged.")}</p>${t.appeal_note?`<p><em>${admin?"Teacher's note":"Your note"}:</em> ${escapeHtml(t.appeal_note)}</p>`:""}<small>${admin?"The warning clears when you approve this lesson plan.":"The warning clears once the administrator approves it."}</small></div></div>`:"";
  const retained=(!submitted&&t.retained_submitted_at)?`<p class="lp-note">${admin?"Submission deleted. The teacher keeps the original passing date":"An administrator removed your earlier submission. Your original passing date"} (${escapeHtml(formatDate(t.retained_submitted_at))}) ${admin?"and must upload again.":"is kept. Please upload again."}</p>`:"";
  if(admin){
    if(!submitted) return `${retained||`<p class="lp-note">${state==="overdue"?"This lesson plan is overdue. The teacher has not uploaded it yet.":"Waiting for the teacher to upload."}</p>`}`;
    const review=["submitted","late"].includes(state)
      ? `<form class="lp-review-form" data-upload-id="${t.upload_id}"><label class="login-field">Decision<select name="status"><option>Approved</option><option>For Revision</option></select></label><label class="login-field">Comments for the teacher<textarea name="feedback" rows="3" maxlength="2000" placeholder="Required for a revision. Optional when approving."></textarea></label><label class="login-field">Attach a PDF (optional, max 8 MB)<input name="revisionFile" type="file" accept="application/pdf,.pdf"></label><button class="button button-primary" type="submit">Save review decision</button></form>`
      : `<p class="lp-note">${state==="approved"?"Approved — waiting for the teacher to confirm.":state==="completed"?"Completed and confirmed by the teacher.":state==="for revision"?"Revision requested — waiting for the teacher's new upload.":"This submission is not awaiting review."}</p>`;
    const del=`<button type="button" class="button button-danger-outline lp-delete-upload" data-upload-id="${t.upload_id}" data-task-label="${escapeHtml(`${t.teacher_name} · ${t.subject_name} · ${lpDateLabel(lpDay(t),{month:"short",day:"numeric",year:"numeric"})}`)}">Delete this lesson plan…</button>`;
    return `${flagBanner}${pdfLink}${revisionLink?`<p>${revisionLink}</p>`:""}${feedback}${subInfo}${review}${history}${del}`;
  }
  const uploadForm=(label,button,resubmit)=>`<form class="lp-upload-form" data-task-id="${t.id}"${resubmit?' data-resubmit="1"':""}><label class="login-field">${label} (PDF only, max 8 MB)<input type="file" name="file" accept="application/pdf,.pdf" required></label><button class="button button-primary" type="submit">${button}</button></form>`;
  if(submitted && state!=="for revision"){
    // The teacher can always open what they passed. Resubmit is only offered while it is waiting for review.
    const action=state==="approved"?`<p class="lp-note">The administrator approved this lesson plan. Confirm to mark it completed.</p><button class="button button-primary lp-confirm-approval" data-upload-id="${t.upload_id}" type="button">Confirm approval and complete</button>`
      :state==="completed"?`<p class="lp-note">Completed. Your approval has been confirmed.</p>`
      :`<p class="lp-note">Under review. Passed the wrong file? You can resubmit — the passing date becomes the day you resubmit.</p><details class="lp-resubmit"><summary class="button button-secondary">Resubmit lesson plan</summary>${uploadForm("Choose the replacement lesson plan","Resubmit lesson plan",true)}</details>`;
    return `${flagBanner}${pdfLink}${feedback}${revisionLink?`<p>${revisionLink}</p>`:""}${subInfo}${action}${history}`;
  }
  const rev=state==="for revision"?(revisionLink?`<p>${revisionLink}</p>`:(t.admin_feedback?"":`<p class="lp-note">Check with the administrator for revision instructions.</p>`)):"";
  return `${retained}${submitted?`${flagBanner}${pdfLink}`:""}${feedback}${rev}${uploadForm(submitted?"Upload revised lesson plan":"Upload lesson plan",submitted?"Upload revised lesson plan":"Submit daily lesson plan",false)}${history}`;
}
function renderLpDialog(){
  if(!lpOpenDay) return;
  const admin=isLpAdmin();
  const source=admin?lpAdminVisibleTasks():lessonPlanTasks.filter(t=>String(t.subject_id)===String(lpTeacherSubjectId));
  const list=source.filter(t=>lpDay(t)===lpOpenDay.date);
  const dlg=document.querySelector("#lp-day-dialog");
  if(!list.length){ dlg.close(); return; }
  document.querySelector("#lp-day-kicker").textContent=`Term ${list[0].term_number} · ${list[0].subject_name}`;
  document.querySelector("#lp-day-title").textContent=lpDateLabel(lpOpenDay.date);
  document.querySelector("#lp-day-body").innerHTML=list.map(t=>{
    const i=lpInfo(t);
    return `<article class="lp-day-card lp-${i.tone}"><div class="lp-day-card-head"><div><strong>Week ${t.week_number} · Day ${t.day_number}</strong>${admin?`<small>${escapeHtml(t.teacher_name)}</small>`:""}</div>${lpChip(t)}</div><div class="lp-day-card-body">${lpTaskControls(t,admin)}</div></article>`;
  }).join("");
  lpLoadHistory(document.querySelector("#lp-day-body"));
}
function lpLoadHistory(root){
  root.querySelectorAll("[data-history-task]").forEach(wrap=>{
    if(wrap.dataset.loaded) return; wrap.dataset.loaded="1";
    api(`/api/lesson-plans/tasks/${wrap.dataset.historyTask}/history`).then(result=>{
      wrap.innerHTML=result.versions.length ? result.versions.map(v=>`<p><button type="button" class="action-link" data-view-file="/api/lesson-plans/versions/${v.id}/file" data-view-title="${escapeHtml(v.file_name)}">Revision ${v.version_number}: ${escapeHtml(v.file_name)}</button> · ${escapeHtml(v.status)} · ${formatDate(v.submitted_at)}${v.admin_feedback?`<br>Feedback: ${escapeHtml(v.admin_feedback)}`:""}</p>`).join("") : "No previous revisions.";
    }).catch(()=>{wrap.textContent="Revision history could not be loaded.";});
  });
}
function openLpDay(scope,date){
  lpOpenDay={scope,date}; const dlg=document.querySelector("#lp-day-dialog");
  renderLpDialog(); if(lpOpenDay && !dlg.open) dlg.showModal();
}

function renderLessonPlanDashboard() {
  const statsHost=document.querySelector("#lp-dashboard-stats");
  if(!statsHost) return;
  const term=lpTerm();
  const total=lessonPlanTasks.length;
  const submitted=lessonPlanTasks.filter(t=>!!t.upload_id).length;
  const approved=lessonPlanTasks.filter(t=>["approved","completed"].includes(String(t.status||"").toLowerCase())).length;
  const pending=lessonPlanTasks.filter(t=>!t.upload_id).length;
  const cards=[
    {label:"Required lesson plans",value:total,tone:"blue"},
    {label:"Submitted",value:submitted,tone:"teal"},
    {label:"Approved",value:approved,tone:"green"},
    {label:"Awaiting upload",value:pending,tone:"amber"}
  ];
  statsHost.innerHTML=cards.map(c=>`<div class="stat-card overview-stat" data-tone="${c.tone}"><span class="stat-label"><i class="stat-marker"></i>${c.label}</span><span class="stat-value">${c.value}</span></div>`).join("");
  const tones={overdue:0,done:0,"done-late":0};
  lessonPlanTasks.forEach(t=>{const k=lpInfo(t).tone; if(k in tones) tones[k]++;});
  const sum=document.querySelector("#lp-status-summary");
  sum.hidden=!term;
  sum.innerHTML=`<span class="lp-sum lp-overdue"><i class="lp-dot lp-overdue"></i><b>${tones.overdue}</b> Overdue</span><span class="lp-sum lp-done"><i class="lp-dot lp-done"></i><b>${tones.done}</b> Completed on time</span><span class="lp-sum lp-done-late"><i class="lp-dot lp-done-late"></i><b>${tones["done-late"]}</b> Completed late</span>`;
  const admin=isLpAdmin();
  if(!admin) return;
  const group=(key)=>{
    const map=new Map();
    lessonPlanTasks.forEach(t=>{
      const name=t[key]||"Unassigned";
      if(!map.has(name)) map.set(name,{name,teachers:new Set(),subjects:new Set(),total:0,submitted:0,approved:0,overdue:0});
      const g=map.get(name); g.total++; if(t.teacher_name)g.teachers.add(t.teacher_name); if(t.subject_name)g.subjects.add(t.subject_name); if(t.upload_id)g.submitted++; if(["approved","completed"].includes(String(t.status||"").toLowerCase()))g.approved++; if(lpInfo(t).tone==="overdue")g.overdue++;
    });
    return [...map.values()];
  };
  const pct=(g)=>g.total?Math.round(g.submitted/g.total*100):0;
  const od=g=>g.overdue?`<span class="lp-chip lp-overdue">${g.overdue} overdue</span>`:`<span class="lp-muted">0</span>`;
  const bar=g=>`<div class="lp-progress-cell"><div class="lp-bar"><i style="width:${pct(g)}%"></i></div><span>${pct(g)}%</span></div>`;
  const subjectRows=group("subject_name").map(g=>`<tr class="lp-subject-row${g.overdue?" lp-row-overdue":""}" data-lp-subject="${escapeHtml(g.name)}" tabindex="0" role="button" aria-label="Open lesson plans for ${escapeHtml(g.name)}"><td><button type="button" class="action-link" data-lp-open-subject="${escapeHtml(g.name)}">${escapeHtml(g.name)} · View plans</button></td><td>${escapeHtml([...g.teachers].join(", ")||"—")}</td><td>${g.total}</td><td>${g.submitted}</td><td>${g.approved}</td><td>${od(g)}</td><td>${bar(g)}</td></tr>`).join("");
  document.querySelector("#lp-subject-progress").innerHTML=subjectRows||'<tr><td colspan="7">No tasks generated for this term yet.</td></tr>';
  const teacherIdByName=new Map(lessonPlanTasks.map(t=>[t.teacher_name,t.teacher_id]));
  const teacherGroups=group("teacher_name").map(g=>({...g,group:lpTeacherGroup(teacherIdByName.get(g.name),g.name)}));
  const teacherRows=LP_GROUPS.map(gr=>{
    const list=teacherGroups.filter(g=>g.group===gr.key); if(!list.length) return "";
    return `<tr class="teacher-group-row"><td colspan="7">${gr.label}</td></tr>`+list.map(g=>`<tr class="${g.overdue?"lp-row-overdue":""}"><td><button type="button" class="action-link" data-lp-open-teacher="${escapeHtml(g.name)}">${escapeHtml(g.name)} · View plans</button></td><td>${escapeHtml([...g.subjects].join(", ")||"—")}</td><td>${g.total}</td><td>${g.submitted}</td><td>${g.approved}</td><td>${od(g)}</td><td>${bar(g)}</td></tr>`).join("");
  }).join("");
  document.querySelector("#lp-teacher-progress").innerHTML=teacherRows||'<tr><td colspan="7">No teacher tasks generated for this term yet.</td></tr>';
}

function renderLpAssignments(teachers){
  const term=lpTerm();
  const host=document.querySelector("#lp-assignment-list");
  if(!term){ host.innerHTML=""; return; }
  document.querySelector("#lp-assignments-heading").textContent=`Teachers and subjects · Term ${term}`;
  const stats=new Map();
  lessonPlanTasks.forEach(t=>{const k=`${t.teacher_id}|${t.subject_id}`; const g=stats.get(k)||{total:0,submitted:0}; g.total++; if(t.upload_id)g.submitted++; stats.set(k,g);});
  const scheduled=lessonPlanAssignments.filter(a=>stats.has(`${a.teacher_id}|${a.subject_id}`));
  if(!scheduled.length){ host.innerHTML=emptyFeed(`No teachers or subjects are scheduled for Term ${term} yet. Use the Schedule tab to add them.`); return; }
  const reviewBySubject=new Map();
  lessonPlanTasks.forEach(t=>{ if(lpNeedsReview(t)){const k=`${t.teacher_id}|${t.subject_id}`; reviewBySubject.set(k,(reviewBySubject.get(k)||0)+1);} });
  const byTeacher=new Map();
  scheduled.forEach(a=>{ if(!byTeacher.has(a.teacher_id)) byTeacher.set(a.teacher_id,{id:a.teacher_id,name:a.teacher_name,items:[]}); byTeacher.get(a.teacher_id).items.push(a); });
  lpTeachersCache=teachers;
  const entries=[...byTeacher.values()].sort((x,y)=>x.name.localeCompare(y.name)).map(g=>({...g,items:lpFilterSubjects(g.name,g.items,a=>a.subject_name,lpAssignQuery),group:lpTeacherGroup(g.id,g.name)})).filter(g=>g.items.length);
  if(!entries.length){ host.innerHTML=emptyFeed(`No teacher or subject matches "${lpAssignQuery}".`); return; }
  if(lpNorm(lpAssignQuery) && entries.length===1) accOpen.assign=entries[0].id;
  host.setAttribute("data-acc-root","");
  host.innerHTML=lpGroupedMarkup(entries,g=>{
    const tReview=g.items.reduce((n,a)=>n+(reviewBySubject.get(`${a.teacher_id}|${a.subject_id}`)||0),0);
    const tFlag=lessonPlanTasks.filter(t=>String(t.teacher_id)===String(g.id)&&lpFlagged(t)).length;const head=`<span class="acc-name">${escapeHtml(g.name)}</span>${lpDot(tReview)}${lpTriBadge(tFlag)}<small>${g.items.length} subject${g.items.length>1?"s":""}</small>`;
    const daysOf=(a)=>{const set=new Set();lessonPlanTasks.forEach(t=>{if(String(t.teacher_id)===String(a.teacher_id)&&String(t.subject_id)===String(a.subject_id)){const [y,m,d]=lpDay(t).split("-").map(Number);const wd=new Date(y,m-1,d).getDay();if(wd>=1&&wd<=5)set.add(wd);}});return set;};
    const dayChips=(a)=>{const cur=daysOf(a);return `<fieldset class="day-picker lp-edit-days" data-orig="${[...cur].sort().join(",")}"><legend>Days taught \u00b7 Term ${term}</legend>${[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"]].map(([v,l])=>`<label class="day-chip"><input type="checkbox" name="weekday" value="${v}" ${cur.has(v)?"checked":""}/><span>${l}</span></label>`).join("")}</fieldset>`;};
    const body=g.items.map(a=>{const st=stats.get(`${a.teacher_id}|${a.subject_id}`);const rv=reviewBySubject.get(`${a.teacher_id}|${a.subject_id}`)||0;const fl=lessonPlanTasks.filter(t=>String(t.teacher_id)===String(a.teacher_id)&&String(t.subject_id)===String(a.subject_id)&&lpFlagged(t)).length;return `<div class="lp-assignment-row"><div><strong>${escapeHtml(a.subject_name)}${lpDot(rv)}${lpTriBadge(fl)}</strong><small>${st.submitted} of ${st.total} submitted</small></div><div class="row-actions"><button type="button" class="action-link" data-lp-assignment-open="${a.teacher_id}|${a.subject_id}|${escapeHtml(a.subject_name)}">View plans</button><button type="button" class="action-link" data-lp-edit="${a.id}">Edit</button><button type="button" class="action-link danger-link" data-lp-remove="${a.id}">Delete</button></div></div><form class="lp-assignment-edit" data-lp-edit-form="${a.id}" hidden><label class="login-field">Teacher<select name="teacherId" required>${teachers.map(u=>`<option value="${u.id}" ${String(u.id)===String(a.teacher_id)?"selected":""}>${escapeHtml(u.displayName)}</option>`).join("")}</select></label><label class="login-field">Subject name<input name="subjectName" maxlength="160" required value="${escapeHtml(a.subject_name)}"></label>${dayChips(a)}<div class="form-actions"><button class="button button-primary" type="submit">Save changes</button><button class="button button-secondary" type="button" data-lp-cancel-edit="${a.id}">Cancel</button></div><small>Uploaded files and revision history are retained. Days with a submission are never removed.</small></form>`;}).join("");
    return accItem("assign",g.id,head,body,"content-card lp-assignment-card");
  });
}

async function refreshLessonPlans() {
  if (!currentUser) return;
  try {
    const term=document.querySelector("#lp-view-term")?.value || "";
    const [assignments, taskResult, directoryResult] = await Promise.all([
      api("/api/lesson-plans/assignments"),
      term ? api(`/api/lesson-plans/tasks?term=${term}`) : Promise.resolve({tasks:[]}),
      api("/api/directory")
    ]);
    lessonPlanAssignments=assignments.assignments || [];
    // Treat the current assignment list as the source of truth. This prevents
    // orphaned/stale generated tasks from appearing in progress totals, even
    // if an older deployment or database migration left task rows behind.
    const activeAssignmentKeys = new Set(lessonPlanAssignments.map(a => `${String(a.teacher_id)}|${String(a.subject_id)}`));
    lessonPlanTasks=(taskResult.tasks || []).filter(t => activeAssignmentKeys.has(`${String(t.teacher_id)}|${String(t.subject_id)}`));
    directory=directoryResult.users;
    const teacherSelect=document.querySelector("#lp-teacher");
    const prior=teacherSelect.value;
    const teachers=directory.filter(u=>u.role==="teacher" && u.active!==false);
    teacherSelect.innerHTML='<option value="">Choose a teacher</option>'+teachers.map(u=>`<option value="${u.id}">${escapeHtml(u.displayName)}</option>`).join("");
    if(prior && teachers.some(u=>String(u.id)===String(prior))) teacherSelect.value=prior;
    teacherSelect.disabled=teachers.length===0;
    document.querySelector("#lp-start-date").value ||= new Date().toISOString().slice(0,10);
    renderLpAssignments(teachers);
    const termSelected=!!term;
    renderLessonPlanDashboard();
    renderLessonPlanTasks();
    document.querySelector("#lp-term-prompt").hidden=termSelected;
    document.querySelector("#lp-assignments-panel").hidden=!isLpAdmin() || !termSelected;
    document.querySelector("#lp-dashboard-stats").hidden=!termSelected;
    document.querySelector("#lp-progress-panel").hidden=!isLpAdmin() || !termSelected;
    document.querySelector("#lp-teacher-progress-panel").hidden=!isLpAdmin() || !termSelected;
  } catch(error) { setGlobalError(error.message); }
}


async function refreshLpNotifications() {
  const panel=document.querySelector("#lp-dashboard-notifications");
  if(!panel || !currentUser || !["admin","developer","teacher"].includes(currentUser.role)) return;
  try {
    const results=await Promise.all([1,2,3].map(term=>api(`/api/lesson-plans/tasks?term=${term}`)));
    const all=results.flatMap(r=>r.tasks||[]);
    const teacher=currentUser.role==="teacher";
    const overdue=all.filter(t=>lpInfo(t).tone==="overdue");
    const others=teacher ? all.filter(t=>lpInfo(t).tone!=="overdue" && (t.status==="For Revision" || t.status==="Approved"))
                         : all.filter(t=>!!t.upload_id && ["Submitted","Late"].includes(t.status));
    const seen=teacher?new Set():lpSeenSet();
    lpNotifTasks=new Map(all.map(t=>[String(t.id),t]));
    const unseen=t=>teacher||!seen.has(lpNotifKey(t));
    const overdueV=overdue.filter(unseen), othersV=others.filter(unseen);
    const items=[...overdueV,...othersV];
    panel.hidden=items.length===0;
    panel.classList.toggle("lp-has-overdue",overdueV.length>0);
    const parts=[];
    if(overdueV.length) parts.push(`<strong class="lp-text-overdue">${overdueV.length} overdue</strong>`);
    parts.push(teacher?`${othersV.length} awaiting your action`:`${othersV.length} waiting for your review`);
    document.querySelector("#lp-notification-summary").innerHTML=parts.join(" · ");
    document.querySelector("#lp-notification-list").innerHTML=items.slice(0,10).map(t=>{
      const i=lpInfo(t);
      const what=i.tone==="overdue" ? (teacher?"Upload your lesson plan now — it is past its due date":"Teacher has not uploaded this lesson plan")
        : teacher ? (t.status==="Approved"?"Confirm administrator approval":"Revise and re-upload the PDF") : "Review teacher submission";
      return `<article class="feed-item lp-feed lp-${i.tone}${teacher?"":" lp-feed-link"}"${teacher?"":` data-lp-notif="${t.id}" tabindex="0" role="button" aria-label="Open this lesson plan"`}><div class="lp-feed-top"><h3>${escapeHtml(t.subject_name)} · Term ${t.term_number}, Week ${t.week_number}, Day ${t.day_number}</h3><span class="lp-chip lp-${i.tone}">${i.label}</span></div><p>${escapeHtml(what)}. Due ${escapeHtml(lpDateLabel(lpDay(t),{month:"short",day:"numeric",year:"numeric"}))}</p><small>${escapeHtml(teacher?"Daily submission":t.teacher_name)}</small>${teacher?"":`<span class="lp-open-hint">Open lesson plan \u2192</span>`}</article>`;
    }).join("") + (items.length>10?`<p class="lp-more">+ ${items.length-10} more in Lesson Plans</p>`:"");
  } catch(error) { /* Dashboard notification is supplementary; page-level errors are shown by the main workspace. */ }
}

async function refreshUsers() {
  try {
    const result = await api("/api/users");
    managedUsers = result.users;
    renderUsers();
  } catch (error) {
    setGlobalError(error.message);
  }
}

async function refreshMessages() {
  try {
    const [messageResult, directoryResult] = await Promise.all([api("/api/messages"), api("/api/directory")]);
    messages = messageResult.messages;
    directory = directoryResult.users;
    populateRecipientOptions();
    renderMessages();
    renderOverview();
  } catch (error) {
    setGlobalError(error.message);
  }
}

async function refreshAnnouncements() {
  try {
    announcements = (await api("/api/announcements")).announcements;
    renderAnnouncements();
    renderOverview();
  } catch (error) {
    setGlobalError(error.message);
  }
}

async function loadDashboard(user) {
  currentUser = user;
  document.querySelector("#login-screen").hidden = true;
  document.querySelector("#dashboard-app").hidden = false;
  document.querySelector("#login-error").hidden = true;
  updateNavigation();
  let saved = "overview";
  try { saved = sessionStorage.getItem("portalView") || "overview"; } catch (_) {}
  goToView(viewTitles[saved] ? saved : "overview");
  if (currentView !== saved) goToView("overview");
  try {
    await refreshOverview();
    renderUsers();
    await refreshLpNotifications();
  } catch (error) {
    setGlobalError(error.message);
  }
  for (const hook of portalHooks.onLogin) { try { await hook(user); } catch (error) { console.error(error); } }
}

function openCreateUser() {
  editingUserId = null;
  const form = document.querySelector("#user-form");
  form.reset();
  document.querySelector("#user-dialog-title").textContent = "Add account";
  document.querySelector("#save-user-button").textContent = "Create account";
  document.querySelector("#account-username").readOnly = false;
  document.querySelector("#account-role").disabled = false;
  document.querySelector("#account-active-wrap").hidden = true;
  document.querySelector("#account-password").required = true;
  document.querySelector("#password-hint").textContent = "At least 12 characters. Share the initial password securely.";
  document.querySelector("#user-form-error").hidden = true;
  const roleSelect = document.querySelector("#account-role");
  roleSelect.innerHTML = rolesActorCanCreate().map((role) =>
    `<option value="${role}">${roleLabels[role]}</option>`
  ).join("");
  document.querySelector("#user-dialog").showModal();
}

function openEditUser(user) {
  editingUserId = user.id;
  document.querySelector("#user-form").reset();
  document.querySelector("#user-dialog-title").textContent = "Edit account";
  document.querySelector("#save-user-button").textContent = "Save changes";
  document.querySelector("#account-username").readOnly = false;
  const allowedRoles = rolesActorCanCreate();
  document.querySelector("#account-role").innerHTML = allowedRoles.map((role) =>
    `<option value="${role}" ${role === user.role ? "selected" : ""}>${roleLabels[role]}</option>`
  ).join("");
  document.querySelector("#account-name").value = user.displayName;
  document.querySelector("#account-username").value = user.username;
  document.querySelector("#account-email").value = user.email || "";
  document.querySelector("#account-active").checked = user.active;
  document.querySelector("#account-active-wrap").hidden = false;
  document.querySelector("#account-password").required = false;
  document.querySelector("#password-hint").textContent = "Leave blank to keep the current password. A replacement must be at least 12 characters.";
  document.querySelector("#user-form-error").hidden = true;
  document.querySelector("#user-dialog").showModal();
}

async function refreshAfterMutation(message) {
  await refreshOverview();
  if (currentView === "users") renderUsers();
  renderMessages();
  if (currentView === "announcements") renderAnnouncements();
  showToast(message);
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#login-error");
  error.hidden = true;
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: {
        role: document.querySelector("#login-role").value,
        username: document.querySelector("#login-username").value,
        password: document.querySelector("#login-password").value,
      },
    });
    document.querySelector("#login-password").value = "";
    await loadDashboard(result.user);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

(() => {
  const gear = document.querySelector("#profile-gear"), menu = document.querySelector("#profile-menu");
  const close = () => { menu.hidden = true; gear.setAttribute("aria-expanded", "false"); };
  gear.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; gear.setAttribute("aria-expanded", String(!menu.hidden)); });
  menu.addEventListener("click", close);
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".profile")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();

document.querySelector("#sign-out").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    showToast(error.message);
  } finally {
    showLogin();
  }
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => goToView(button.dataset.view));
});
document.querySelectorAll("[data-go-view]").forEach((button) => {
  button.addEventListener("click", () => goToView(button.dataset.goView));
});

document.querySelector("#add-user-button").addEventListener("click", openCreateUser);
document.querySelector("#user-search").addEventListener("input", renderUsers);
document.querySelector("#user-rows").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-user]");
  if (editButton) {
    const user = managedUsers.find((item) => String(item.id) === editButton.dataset.editUser);
    if (user) openEditUser(user);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-user]");
  if (!deleteButton) return;
  const user = managedUsers.find((item) => String(item.id) === deleteButton.dataset.deleteUser);
  if (!user || !window.confirm(`Permanently delete ${user.displayName}'s account? Related messages will also be deleted.`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    await refreshAfterMutation("Account deleted.");
  } catch (error) {
    setGlobalError(error.message);
  }
});

document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const payload = {
    displayName: data.get("displayName"),
    username: data.get("username"),
    email: data.get("email"),
    role: data.get("role"),
  };
  const password = data.get("password");
  if (password) payload.password = password;
  if (editingUserId) payload.active = document.querySelector("#account-active").checked;
  const error = document.querySelector("#user-form-error");
  error.hidden = true;
  try {
    if (editingUserId) await api(`/api/users/${encodeURIComponent(editingUserId)}`, { method: "PATCH", body: payload });
    else await api("/api/users", { method: "POST", body: payload });
    document.querySelector("#user-dialog").close();
    await refreshAfterMutation(editingUserId ? "Account updated." : "Account created. Share the initial password securely.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  }
});

document.querySelector("#close-user-dialog").addEventListener("click", () => document.querySelector("#user-dialog").close());
document.querySelector("#cancel-user-dialog").addEventListener("click", () => document.querySelector("#user-dialog").close());

document.querySelector("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api("/api/messages", {
      method: "POST",
      body: { recipientId: data.get("recipientId"), body: data.get("body") },
    });
    form.reset();
    await refreshAfterMutation("Message sent.");
  } catch (error) {
    setGlobalError(error.message);
  }
});

document.querySelector("#message-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-read-message]");
  if (!button) return;
  try {
    await api(`/api/messages/${encodeURIComponent(button.dataset.readMessage)}/read`, { method: "POST" });
    await refreshMessages();
  } catch (error) {
    setGlobalError(error.message);
  }
});
document.querySelector("#refresh-messages").addEventListener("click", refreshMessages);

document.querySelector("#announcement-list").addEventListener("click", async (event) => {
  const photo = event.target.closest("[data-photo]");
  if (photo) {
    document.querySelector("#photo-dialog-img").src = `/api/announcements/images/${encodeURIComponent(photo.dataset.photo)}`;
    document.querySelector("#photo-dialog-title").textContent = photo.dataset.photoTitle || "Photo";
    document.querySelector("#photo-dialog").showModal();
    return;
  }
  const button = event.target.closest("[data-delete-announcement]"); if (!button) return;
  if (!confirm("Delete this announcement? This cannot be undone.")) return;
  try { await api(`/api/announcements/${encodeURIComponent(button.dataset.deleteAnnouncement)}`, { method: "DELETE" }); await refreshAnnouncements(); showToast("Announcement deleted."); }
  catch (error) { setGlobalError(error.message); }
});
async function fileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type || "application/octet-stream", data: String(reader.result).split(",")[1] || "" });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const error = document.querySelector("#password-form-error");
  error.hidden = true;
  if (data.get("newPassword") !== data.get("confirmPassword")) {
    error.textContent = "The new password and confirmation do not match.";
    error.hidden = false;
    return;
  }
  try {
    await api("/api/account/password", {
      method: "POST",
      body: {
        currentPassword: data.get("currentPassword"),
        newPassword: data.get("newPassword"),
      },
    });
    form.reset();
    showToast("Password updated. Your other active sessions have been signed out.");
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  }
});


document.querySelector("#lp-generate-form").addEventListener("submit", async (event)=>{
  event.preventDefault();
  const teacherId=document.querySelector("#lp-teacher").value;
  const subjectNames=document.querySelector("#lp-subject").value.split(/[,;\n]/).map(x=>x.trim()).filter(Boolean);
  const termNumber=Number(document.querySelector("#lp-generate-term").value);
  const weeks=Number(document.querySelector("#lp-weeks").value);
  const weekdays=[...document.querySelectorAll('#lp-days input[name="weekday"]:checked')].map(i=>Number(i.value));
  const startDate=document.querySelector("#lp-start-date").value;
  if(!weekdays.length){setGlobalError("Tick at least one instruction day (Monday to Friday).");return;}
  if(!subjectNames.length){setGlobalError("Enter at least one subject.");return;}
  setGlobalError();
  const submit=event.currentTarget.querySelector("button[type=submit]"); submit.disabled=true;
  try {
    const result=await api("/api/lesson-plans/generate",{method:"POST",body:{termNumber,teacherId,subjectNames,weeks,weekdays,startDate}});
    document.querySelector("#lp-view-term").value=String(termNumber);
    selectedLpSubject=null; selectedLpTeacherId=null; selectedLpSubjectId=null; lpCal.admin.key=""; lpCal.teacher.key="";
    document.querySelector("#lp-subject").value=""; setLpTab("overview");
    await refreshLessonPlans(); await refreshLpNotifications();
    showToast(`Term ${termNumber}: ${result.generatedOrUpdated} daily lesson-plan days scheduled for ${subjectNames.length} subject${subjectNames.length>1?"s":""}.`);
  } catch(e){setGlobalError(e.message);} finally { submit.disabled=false; }
});

document.querySelector("#lp-assign-search").addEventListener("input",(e)=>{lpAssignQuery=e.target.value;renderLpAssignments(lpTeachersCache);});
document.querySelector("#summary-search").addEventListener("input",(e)=>{summaryQuery=e.target.value;renderSummary();});

/* Admin: open a lesson plan straight from a notification; it is cleared once viewed */
async function openLpFromNotification(taskId){
  const t=lpNotifTasks.get(String(taskId)); if(!t||!isLpAdmin()) return;
  lpMarkSeen(t);
  document.querySelector("#lp-view-term").value=String(t.term_number);
  lpTeacherSubjectId=null; lpCal.admin.key=""; lpCal.teacher.key="";
  goToView("lesson-plans");
  setLpTab("progress");
  await refreshLessonPlans();
  openLpDrawer(t.teacher_id,t.subject_id);
  openLpDay("admin",lpDay(t));
  refreshLpNotifications();
}
const lpNotifList=document.querySelector("#lp-notification-list");
lpNotifList.addEventListener("click",(event)=>{const el=event.target.closest("[data-lp-notif]"); if(el) openLpFromNotification(el.dataset.lpNotif);});
lpNotifList.addEventListener("keydown",(event)=>{if(event.key!=="Enter"&&event.key!==" ")return; const el=event.target.closest("[data-lp-notif]"); if(!el)return; event.preventDefault(); openLpFromNotification(el.dataset.lpNotif);});
document.querySelector("#lp-view-term").addEventListener("change",()=>{closeLpDrawer();selectedLpSubject=null;selectedLpTeacherId=null;selectedLpSubjectId=null;lpTeacherSubjectId=null;lpCal.teacher.key="";lpCal.admin.key="";document.querySelector("#lp-day-dialog").open&&document.querySelector("#lp-day-dialog").close(); refreshLessonPlans();});
document.querySelector("#lp-tabs").addEventListener("click",(event)=>{const b=event.target.closest("[data-lp-tab]");if(b)setLpTab(b.dataset.lpTab);});
document.querySelector("#lp-day-close").addEventListener("click",()=>document.querySelector("#lp-day-dialog").close());
document.querySelector("#lp-day-dialog").addEventListener("click",(event)=>{if(event.target===event.currentTarget)event.currentTarget.close();});
document.querySelector("#lp-day-dialog").addEventListener("close",()=>{lpOpenDay=null;});
document.querySelector("#view-lesson-plans").addEventListener("click",(event)=>{
  const day=event.target.closest("[data-lp-day]");
  if(day){openLpDay(day.dataset.lpScope,day.dataset.lpDay);return;}
  const nav=event.target.closest("[data-lp-cal-nav]");
  if(nav){const st=lpCal[nav.dataset.lpScope];const [y,m]=st.month.split("-").map(Number);const d=new Date(y,m-1+Number(nav.dataset.lpCalNav),1);st.month=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;renderLessonPlanTasks();return;}
  const pill=event.target.closest("[data-lp-subject-pill]");
  if(pill){lpTeacherSubjectId=String(pill.dataset.lpSubjectPill);renderLessonPlanTasks();}
});
document.querySelector("#lp-subject-progress").addEventListener("click",(event)=>{
  const trigger=event.target.closest("[data-lp-open-subject]");
  const row=event.target.closest("[data-lp-subject]");
  const subject=trigger?.dataset.lpOpenSubject || row?.dataset.lpSubject;
  if(!subject)return;
  const match=lessonPlanTasks.find(t=>t.subject_name===subject); if(!match)return;
  openLpDrawer(match.teacher_id,match.subject_id);
});
document.querySelector("#lp-subject-progress").addEventListener("keydown",(event)=>{
  if(event.key!=="Enter" && event.key!==" ")return;
  const row=event.target.closest("[data-lp-subject]"); if(!row)return;
  event.preventDefault(); row.querySelector("[data-lp-open-subject]")?.click();
});
document.querySelector("#lp-close-details").addEventListener("click",closeLpDrawer);
document.querySelector("#lp-drawer-scrim").addEventListener("click",closeLpDrawer);
document.addEventListener("keydown",(event)=>{ if(event.key==="Escape" && lpDrawer.open && !document.querySelector("dialog[open]")) closeLpDrawer(); });
document.querySelector("#lp-drawer-teacher").addEventListener("change",(event)=>{ selectedLpTeacherId=event.target.value; selectedLpSubjectId=null; renderLpDrawer(); });
document.querySelector("#lp-drawer-subjects").addEventListener("click",(event)=>{ const b=event.target.closest("[data-lp-drawer-subject]"); if(!b)return; selectedLpSubjectId=b.dataset.lpDrawerSubject; renderLpDrawer(); });
document.querySelector("#lp-teacher-progress").addEventListener("click",(event)=>{
  const b=event.target.closest("[data-lp-open-teacher]"); if(!b)return;
  const match=lessonPlanTasks.find(t=>t.teacher_name===b.dataset.lpOpenTeacher); if(!match)return;
  openLpDrawer(match.teacher_id,null);
});
document.querySelector("#lp-assignment-list").addEventListener("click",async(event)=>{
  const edit=event.target.closest("[data-lp-edit]");
  if(edit){const form=document.querySelector(`[data-lp-edit-form="${edit.dataset.lpEdit}"]`);if(form)form.hidden=!form.hidden;return;}
  const cancel=event.target.closest("[data-lp-cancel-edit]");if(cancel){const form=document.querySelector(`[data-lp-edit-form="${cancel.dataset.lpCancelEdit}"]`);if(form)form.hidden=true;return;}
  const open=event.target.closest("[data-lp-assignment-open]");if(open){const [teacherId,subjectId]=open.dataset.lpAssignmentOpen.split("|");setLpTab("progress");openLpDrawer(teacherId,subjectId);return;}
  const remove=event.target.closest("[data-lp-remove]");if(remove){if(!confirm("Delete this subject for this teacher? Its calendars in ALL terms will be removed. Uploaded PDFs and revision history attached to those tasks will also be permanently deleted."))return;try{await api(`/api/lesson-plans/assignments/${remove.dataset.lpRemove}`,{method:"DELETE"});await refreshLessonPlans();showToast("Assignment deleted.");}catch(e){setGlobalError(e.message);} }
});
document.querySelector("#lp-assignment-list").addEventListener("submit",async(event)=>{
  const form=event.target.closest("[data-lp-edit-form]"); if(!form)return; event.preventDefault();
  const data=new FormData(form), submit=form.querySelector('button[type="submit"]');
  let error=form.querySelector(".lp-edit-error");
  if(!error){ error=document.createElement("p"); error.className="form-error lp-edit-error"; error.setAttribute("role","alert"); form.querySelector(".form-actions").before(error); }
  error.hidden=true;
  const fail=(m)=>{ error.textContent=m; error.hidden=false; error.scrollIntoView({block:"nearest"}); };
  const days=[...form.querySelectorAll('input[name="weekday"]:checked')].map(i=>Number(i.value)).sort((a,b)=>a-b);
  const picker=form.querySelector(".lp-edit-days");
  if(picker&&!days.length){ fail("Choose at least one day the subject is taught."); return; }
  const body={teacherId:Number(data.get("teacherId")),subjectName:String(data.get("subjectName")).trim()};
  // Days are saved in the same request as the teacher/subject, so one click either saves everything or nothing.
  if(picker&&days.join(",")!==picker.dataset.orig){ body.termNumber=Number(lpTerm()); body.weekdays=days; }
  submit.disabled=true;
  try{ await api(`/api/lesson-plans/assignments/${form.dataset.lpEditForm}`,{method:"PUT",body}); await refreshLessonPlans(); await refreshLpNotifications(); showToast("Schedule saved."); }
  catch(e){ fail(e.message); } finally { submit.disabled=false; }
});
document.querySelector("#view-lesson-plans").addEventListener("click",async(event)=>{const button=event.target.closest(".lp-confirm-approval");if(!button)return;if(!confirm("Confirm that you have received the administrator's approval? This will mark the lesson plan as completed."))return;try{await api(`/api/lesson-plans/uploads/${button.dataset.uploadId}/confirm`,{method:"POST",body:{}});await refreshLessonPlans();await refreshLpNotifications();showToast("Approval confirmed. Lesson plan completed.");}catch(e){setGlobalError(e.message);}});

/* Upload flow: the server checks the file. If it looks blank, is not a lesson plan, or was already submitted,
   it sends back warnings and saves nothing until the teacher appeals ("yes, this is my lesson plan"). */
let lpPendingUpload=null;
async function lpSubmitUpload(taskId,file,resubmit,appeal,appealNote){
  const result=await api(`/api/lesson-plans/tasks/${taskId}/upload`,{method:"POST",body:{file:await fileToPayload(file),resubmit:!!resubmit,appeal:!!appeal,appealNote:appealNote||""}});
  if(result.needsConfirmation){
    lpPendingUpload={taskId,file,resubmit};
    document.querySelector("#lp-warning-file").textContent=file.name;
    document.querySelector("#lp-warning-list").innerHTML=result.flags.map(f=>`<li>${escapeHtml(f.message)}</li>`).join("");
    document.querySelector("#lp-warning-form").reset();
    document.querySelector("#lp-warning-dialog").showModal();
    return false;
  }
  await refreshLessonPlans(); await refreshLpNotifications();
  showToast(resubmit?"Lesson plan resubmitted. The passing date is now today.":result.flagged?"Submitted with a warning for the administrator to check.":"Lesson plan submitted.");
  return true;
}
document.querySelector("#lp-warning-cancel").addEventListener("click",()=>{lpPendingUpload=null;document.querySelector("#lp-warning-dialog").close();});
document.querySelector("#lp-warning-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); if(!lpPendingUpload)return;
  const {taskId,file,resubmit}=lpPendingUpload, note=new FormData(event.currentTarget).get("appealNote");
  try{ await lpSubmitUpload(taskId,file,resubmit,true,String(note||"")); lpPendingUpload=null; document.querySelector("#lp-warning-dialog").close(); }
  catch(e){ document.querySelector("#lp-warning-dialog").close(); setGlobalError(e.message); }
});

/* Admin: delete a submission (even an approved one), then choose what happens to the passing date. */
let lpDeleteTarget=null;
document.querySelector("#view-lesson-plans").addEventListener("click",(event)=>{
  const b=event.target.closest(".lp-delete-upload"); if(!b)return;
  lpDeleteTarget=b.dataset.uploadId;
  document.querySelector("#lp-delete-summary").textContent=b.dataset.taskLabel;
  document.querySelector("#lp-delete-form").reset();
  document.querySelector("#lp-delete-dialog").showModal();
});
for(const id of ["#lp-delete-cancel","#lp-delete-close"]) document.querySelector(id).addEventListener("click",()=>document.querySelector("#lp-delete-dialog").close());
document.querySelector("#lp-delete-form").addEventListener("submit",async(event)=>{
  event.preventDefault(); if(!lpDeleteTarget)return;
  const data=new FormData(event.currentTarget);
  try{
    await api(`/api/lesson-plans/uploads/${lpDeleteTarget}`,{method:"DELETE",body:{keepDate:data.get("keepDate")==="keep",reason:data.get("reason")}});
    document.querySelector("#lp-delete-dialog").close(); lpDeleteTarget=null;
    await refreshLessonPlans(); await refreshLpNotifications(); showToast("Lesson plan deleted. The teacher has been notified.");
  }catch(e){ document.querySelector("#lp-delete-dialog").close(); setGlobalError(e.message); }
});

document.querySelector("#view-lesson-plans").addEventListener("submit",async(event)=>{
  const uploadForm=event.target.closest(".lp-upload-form");
  const reviewForm=event.target.closest(".lp-review-form");
  if(uploadForm){
    event.preventDefault();
    const file=uploadForm.querySelector('input[type="file"]').files[0];
    if(!file)return;
    if(!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type!=="application/pdf")){setGlobalError("Please upload a PDF file only.");return;}
    if(file.size>8*1024*1024){setGlobalError("Lesson-plan PDF files must be 8 MB or smaller.");return;}
    const button=uploadForm.querySelector('button[type="submit"]'); button.disabled=true;
    try { await lpSubmitUpload(uploadForm.dataset.taskId,file,uploadForm.dataset.resubmit==="1",false,""); }
    catch(e){setGlobalError(e.message);} finally { button.disabled=false; }
  } else if(reviewForm){
    event.preventDefault();
    const data=new FormData(reviewForm);
    const status=data.get("status");
    const feedback=String(data.get("feedback")||"").trim();
    const revisionFile=reviewForm.querySelector('input[name="revisionFile"]')?.files?.[0];
    if(revisionFile){
      if(!revisionFile.name.toLowerCase().endsWith(".pdf") || (revisionFile.type && revisionFile.type!=="application/pdf")){setGlobalError("The attached document must be a PDF file.");return;}
      if(revisionFile.size>8*1024*1024){setGlobalError("The attached PDF must be 8 MB or smaller.");return;}
    }
    if(status==="For Revision" && !feedback && !revisionFile){setGlobalError("Write a comment (or attach a PDF) telling the teacher what to revise.");return;}
    try { await api(`/api/lesson-plans/uploads/${reviewForm.dataset.uploadId}/review`,{method:"POST",body:{status,feedback,revisionFile:revisionFile?await fileToPayload(revisionFile):null}}); await refreshLessonPlans(); await refreshLpNotifications(); showToast(status==="For Revision" ? "Revision request sent to the teacher." : "Lesson plan approved."); }
    catch(e){setGlobalError(e.message);}
  }
});

/* ---------- Summary (admin): teacher -> bulleted subjects -> submission counts ---------- */
let summaryTerm = "all";
let summaryTasks = [];
async function refreshSummary() {
  if (!isLpAdmin()) return;
  try {
    const [assignments, ...terms] = await Promise.all([api("/api/lesson-plans/assignments"), ...[1,2,3].map(t => api(`/api/lesson-plans/tasks?term=${t}`))]);
    lessonPlanAssignments = assignments.assignments || [];
    const keys = new Set(lessonPlanAssignments.map(a => `${a.teacher_id}|${a.subject_id}`));
    summaryTasks = terms.flatMap(r => r.tasks || []).filter(t => keys.has(`${t.teacher_id}|${t.subject_id}`));
    renderSummary();
  } catch (error) { setGlobalError(error.message); }
}
function renderSummary() {
  document.querySelectorAll("[data-summary-term]").forEach(b => b.classList.toggle("is-active", b.dataset.summaryTerm === summaryTerm));
  const tasks = summaryTasks.filter(t => summaryTerm === "all" || String(t.term_number) === summaryTerm);
  const tally = list => {
    const r = { total: list.length, submitted: 0, approved: 0, revision: 0, overdue: 0, waiting: 0 };
    list.forEach(t => {
      const s = String(t.status || "").toLowerCase();
      if (t.upload_id) r.submitted++;
      if (s === "approved" || s === "completed") r.approved++;
      if (s === "for revision") r.revision++;
      if (lpInfo(t).tone === "overdue") r.overdue++;
      if (!t.upload_id) r.waiting++;
    });
    return r;
  };
  const all = tally(tasks);
  const teacherIds = new Set(tasks.map(t => String(t.teacher_id)));
  const subjectKeys = new Set(tasks.map(t => `${t.teacher_id}|${t.subject_id}`));
  const cards = [
    { label: "Teachers", value: teacherIds.size, tone: "blue" },
    { label: "Subjects", value: subjectKeys.size, tone: "teal" },
    { label: "Lesson plans submitted", value: `${all.submitted}/${all.total}`, tone: "green" },
    { label: "Overdue", value: all.overdue, tone: "amber" },
  ];
  document.querySelector("#summary-totals").innerHTML = cards.map(c => `<div class="stat-card overview-stat" data-tone="${c.tone}"><span class="stat-label"><i class="stat-marker"></i>${c.label}</span><span class="stat-value">${c.value}</span></div>`).join("");
  const byTeacher = new Map();
  tasks.forEach(t => {
    if (!byTeacher.has(t.teacher_id)) byTeacher.set(t.teacher_id, { name: t.teacher_name, subjects: new Map() });
    const g = byTeacher.get(t.teacher_id);
    if (!g.subjects.has(t.subject_id)) g.subjects.set(t.subject_id, { name: t.subject_name, tasks: [] });
    g.subjects.get(t.subject_id).tasks.push(t);
  });
  const host = document.querySelector("#summary-list");
  if (!byTeacher.size) { host.innerHTML = emptyFeed(summaryTerm === "all" ? "No lesson-plan schedules have been created yet." : `No lesson-plan schedules exist for Term ${summaryTerm}.`); return; }
  host.setAttribute("data-acc-root", "");
  const summaryEntries = [...byTeacher.entries()].map(([id, v]) => {
    const kept = lpFilterSubjects(v.name, [...v.subjects.entries()], ([, s]) => s.name, summaryQuery);
    return { ...v, subjects: new Map(kept), id, group: lpTeacherGroup(id, v.name) };
  }).filter(e => e.subjects.size).sort((a, b) => a.name.localeCompare(b.name));
  if (!summaryEntries.length) { host.innerHTML = emptyFeed(`No teacher or subject matches "${summaryQuery}".`); return; }
  if (lpNorm(summaryQuery) && summaryEntries.length === 1) accOpen.summary = summaryEntries[0].id;
  host.innerHTML = lpGroupedMarkup(summaryEntries, teacher => {
    const t = tally([...teacher.subjects.values()].flatMap(s => s.tasks));
    const pct = t.total ? Math.round(t.submitted / t.total * 100) : 0;
    const items = [...teacher.subjects.values()].sort((a, b) => a.name.localeCompare(b.name)).map(subject => {
      const x = tally(subject.tasks);
      const terms = [...new Set(subject.tasks.map(k => k.term_number))].sort().map(n => `T${n}`).join(", ");
      const rv = subject.tasks.filter(lpNeedsReview).length;
      return `<li><div class="summary-subject"><strong>${escapeHtml(subject.name)}${lpDot(rv)}</strong><small>${terms}</small></div>
        <div class="summary-counts"><span><b>${x.submitted}</b> of ${x.total} submitted</span><span><b>${x.approved}</b> approved</span>${x.revision ? `<span class="lp-text-revision"><b>${x.revision}</b> for revision</span>` : ""}${x.overdue ? `<span class="lp-text-overdue"><b>${x.overdue}</b> overdue</span>` : ""}<span><b>${x.waiting}</b> awaiting upload</span></div></li>`;
    }).join("");
    const trev = [...teacher.subjects.values()].flatMap(s => s.tasks).filter(lpNeedsReview).length;
    const head = `<span class="acc-name">${escapeHtml(teacher.name)}</span>${lpDot(trev)}<small>${teacher.subjects.size} subject${teacher.subjects.size > 1 ? "s" : ""} · ${t.submitted} of ${t.total} submitted${t.overdue ? ` · <span class="lp-text-overdue">${t.overdue} overdue</span>` : ""}</small><span class="lp-progress-cell"><span class="lp-bar"><i style="width:${pct}%"></i></span><span>${pct}%</span></span>`;
    return accItem("summary", teacher.id, head, `<ul class="summary-subjects">${items}</ul>`, "panel summary-card");
  });
}
document.querySelector("#lp-summary-pane").addEventListener("click", (event) => {
  const b = event.target.closest("[data-summary-term]");
  if (b) { summaryTerm = b.dataset.summaryTerm; renderSummary(); }
});

/* ---------- Ancillary tasks: manual, admin-assigned, any-file submissions ---------- */
let ancTasks = [];
let ancSelected = null;
function ancInfo(target, task) {
  const st = String(target.status || "");
  if (!target.submissionId) return lpTodayIso() > task.due_date ? { tone: "overdue", label: "Overdue", short: "Overdue" } : { tone: "pending", label: "Awaiting upload", short: "To do" };
  if (st === "Approved") return target.late ? { tone: "done-late", label: "Approved · late", short: "Done late" } : { tone: "done", label: "Approved", short: "Approved" };
  if (st === "For Revision") return { tone: "revision", label: "For revision", short: "Revise" };
  if (st === "Late") return { tone: "done-late", label: "Submitted late · awaiting review", short: "Late" };
  return { tone: "review", label: "Submitted · awaiting review", short: "In review" };
}
const ancChip = (target, task) => { const i = ancInfo(target, task); return `<span class="lp-chip lp-${i.tone}">${i.label}</span>`; };
const ancSize = n => Number(n) >= 1048576 ? `${(Number(n) / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(n) / 1024))} KB`;

async function refreshAncillary() {
  if (!currentUser || currentUser.role === "student") return;
  try {
    const calls = [api("/api/ancillary")];
    if (isLpAdmin()) calls.push(api("/api/directory"));
    const [result, dir] = await Promise.all(calls);
    ancTasks = result.tasks || [];
    if (dir) directory = dir.users;
    if (!ancTasks.some(t => String(t.id) === String(ancSelected))) ancSelected = ancTasks[0] ? String(ancTasks[0].id) : null;
    renderAncTeacherPicker();
    renderAncillary();
  } catch (error) { setGlobalError(error.message); }
}
function renderAncTeacherPicker() {
  const host = document.querySelector("#anc-teacher-picker");
  if (!host) return;
  const checked = new Set([...host.querySelectorAll("input:checked")].map(i => i.value));
  const teachers = directory.filter(u => u.role === "teacher" && u.active !== false);
  host.innerHTML = teachers.length ? teachers.map(u => `<label class="anc-check"><input type="checkbox" value="${escapeHtml(u.id)}" ${checked.has(String(u.id)) ? "checked" : ""}><span>${escapeHtml(u.displayName)}</span></label>`).join("") : '<p class="form-hint">No active teacher accounts yet.</p>';
}
function renderAncillary() {
  const admin = isLpAdmin();
  const pills = document.querySelector("#anc-pills"), detail = document.querySelector("#anc-detail");
  if (!ancTasks.length) {
    pills.innerHTML = ""; detail.innerHTML = emptyFeed(admin ? "No ancillary tasks yet. Use “New ancillary task” above to create one." : "No ancillary tasks have been assigned to you.");
    document.querySelector("#anc-board-hint").textContent = ""; return;
  }
  document.querySelector("#anc-board-hint").textContent = "Select a task to open it.";
  pills.innerHTML = ancTasks.map(t => {
    const alerts = t.targets.filter(x => ancInfo(x, t).tone === "overdue").length;
    return `<button type="button" role="tab" aria-selected="${String(t.id) === ancSelected}" class="lp-subject-pill${String(t.id) === ancSelected ? " is-active" : ""}" data-anc-pill="${t.id}">${escapeHtml(t.title)}${alerts ? `<span class="lp-pill-alert" title="${alerts} overdue">${alerts}</span>` : ""}</button>`;
  }).join("");
  const task = ancTasks.find(t => String(t.id) === ancSelected);
  const files = (task.attachments || []).length ? `<div class="anc-files"><strong>Reference files</strong>${task.attachments.map(f => `<a class="action-link" href="/api/ancillary/attachments/${encodeURIComponent(f.id)}" target="_blank" rel="noopener">📎 ${escapeHtml(f.fileName)} (${ancSize(f.fileSize)})</a>`).join("")}</div>` : "";
  const head = `<div class="anc-head"><div><h3>${escapeHtml(task.title)}</h3><small>Due ${escapeHtml(lpDateLabel(task.due_date, { weekday: "short", month: "long", day: "numeric", year: "numeric" }))} · ${task.all_teachers ? "All teachers" : `${task.targets.length} teacher${task.targets.length === 1 ? "" : "s"}`}</small></div>${admin ? `<button type="button" class="action-link danger-link" data-anc-delete="${task.id}">Delete task</button>` : ""}</div>${task.description ? `<p class="anc-desc">${escapeHtml(task.description)}</p>` : ""}${files}`;
  if (admin) {
    const done = task.targets.filter(x => x.submissionId).length;
    const rows = task.targets.map(x => {
      const i = ancInfo(x, task), review = ["Submitted", "Late"].includes(x.status) && x.submissionId;
      return `<article class="anc-row lp-${i.tone}"><div class="anc-row-head"><strong>${escapeHtml(x.teacherName)}</strong>${ancChip(x, task)}</div>${x.submissionId ? `<p class="lp-meta"><a class="action-link" href="/api/ancillary/submissions/${x.submissionId}/file" target="_blank" rel="noopener">📄 ${escapeHtml(x.fileName)} (${ancSize(x.fileSize)})</a> · ${escapeHtml(formatDate(x.submittedAt))}</p>` : `<p class="lp-note">${i.tone === "overdue" ? "Past the due date; nothing uploaded yet." : "Waiting for upload."}</p>`}${x.feedback ? `<p class="lp-feedback">${escapeHtml(x.feedback)}</p>` : ""}${review ? `<form class="anc-review-form" data-submission="${x.submissionId}"><label class="login-field">Decision<select name="status"><option>Approved</option><option>For Revision</option></select></label><label class="login-field">Feedback (required for revision)<textarea name="feedback" rows="2" maxlength="2000"></textarea></label><button class="button button-primary" type="submit">Save decision</button></form>` : ""}</article>`;
    }).join("");
    detail.innerHTML = `${head}<p class="anc-progress"><b>${done}</b> of ${task.targets.length} teachers have submitted</p><div class="anc-rows">${rows}</div>`;
  } else {
    const x = task.targets[0], i = ancInfo(x, task);
    const canUpload = !x.submissionId || x.status === "For Revision";
    detail.innerHTML = `${head}<div class="anc-mine lp-${i.tone}"><div class="anc-row-head"><strong>Your submission</strong>${ancChip(x, task)}</div>${x.submissionId ? `<p class="lp-meta"><a class="action-link" href="/api/ancillary/submissions/${x.submissionId}/file" target="_blank" rel="noopener">📄 ${escapeHtml(x.fileName)} (${ancSize(x.fileSize)})</a> · ${escapeHtml(formatDate(x.submittedAt))}</p>` : ""}${x.feedback ? `<p class="lp-feedback">${escapeHtml(x.feedback)}</p>` : ""}${canUpload ? `<form class="anc-upload-form" data-task="${task.id}"><label class="login-field">${x.submissionId ? "Upload a revised document" : "Upload your document"} (any file type, max 8 MB)<input type="file" name="file" required></label><button class="button button-primary" type="submit">${x.submissionId ? "Submit revision" : "Submit"}</button></form>` : `<p class="lp-note">${x.status === "Approved" ? "Approved — nothing more to do." : "Under review. You can upload again only if a revision is requested."}</p>`}</div>`;
  }
}
document.querySelector("#view-ancillary").addEventListener("click", async (event) => {
  const pill = event.target.closest("[data-anc-pill]");
  if (pill) { ancSelected = String(pill.dataset.ancPill); renderAncillary(); return; }
  const del = event.target.closest("[data-anc-delete]");
  if (del) {
    if (!confirm("Delete this ancillary task and all teacher submissions for it? This cannot be undone.")) return;
    try { await api(`/api/ancillary/${encodeURIComponent(del.dataset.ancDelete)}`, { method: "DELETE" }); await refreshAncillary(); showToast("Ancillary task deleted."); }
    catch (e) { setGlobalError(e.message); }
  }
});
document.querySelector("#view-ancillary").addEventListener("change", (event) => {
  if (event.target.name === "anc-target") document.querySelector("#anc-teacher-picker").hidden = event.target.value !== "selected";
});
document.querySelector("#view-ancillary").addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  setGlobalError();
  try {
    if (form.id === "anc-form") {
      const all = form.querySelector('input[name="anc-target"]:checked').value === "all";
      const teacherIds = [...document.querySelectorAll("#anc-teacher-picker input:checked")].map(i => i.value);
      if (!all && !teacherIds.length) throw new Error("Select at least one teacher, or choose All teachers.");
      const picked = [...document.querySelector("#anc-files").files];
      if (picked.length > 10) throw new Error("Attach no more than 10 files.");
      if (picked.some(f => f.size > 8 * 1024 * 1024)) throw new Error("Each file must be 8 MB or smaller.");
      const files = await Promise.all(picked.map(fileToPayload));
      await api("/api/ancillary", { method: "POST", body: { title: document.querySelector("#anc-title").value, description: document.querySelector("#anc-description").value, dueDate: document.querySelector("#anc-due").value, allTeachers: all, teacherIds, files } });
      form.reset(); document.querySelector("#anc-teacher-picker").hidden = true; document.querySelector("#anc-compose-details").open = false;
      ancSelected = null; await refreshAncillary(); showToast("Ancillary task assigned.");
    } else if (form.classList.contains("anc-upload-form")) {
      const file = form.querySelector('input[type="file"]').files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error("Files must be 8 MB or smaller.");
      await api(`/api/ancillary/${form.dataset.task}/submit`, { method: "POST", body: { file: await fileToPayload(file) } });
      await refreshAncillary(); showToast("Document submitted.");
    } else if (form.classList.contains("anc-review-form")) {
      const data = new FormData(form);
      await api(`/api/ancillary/submissions/${form.dataset.submission}/review`, { method: "POST", body: { status: data.get("status"), feedback: data.get("feedback") } });
      await refreshAncillary(); showToast(data.get("status") === "Approved" ? "Submission approved." : "Revision requested.");
    }
  } catch (e) { setGlobalError(e.message); window.scrollTo({ top: 0, behavior: "smooth" }); }
});

/* ---------- Sidebar: Announcements expands to show Memos (linktree style) ---------- */
function setAnnounceOpen(open) {
  const sub = document.querySelector("#announce-sub"), toggle = document.querySelector("#announce-toggle");
  if (!sub || !toggle) return;
  sub.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.closest(".nav-group").classList.toggle("is-open", open);
}
document.querySelector("#announce-toggle").addEventListener("click", () => {
  // The generic data-view handler has already navigated; collapse only when the tab was already open.
  if (previousView === "announcements") setAnnounceOpen(document.querySelector("#announce-sub").hidden);
});

/* ---------- Floating messages: pop-up opened from the bottom-right icon ---------- */
function openMessagesPanel() {
  const panel = document.querySelector("#msg-panel");
  panel.hidden = false;
  document.querySelector("#msg-fab").setAttribute("aria-expanded", "true");
  refreshMessages();
  document.querySelector("#message-body")?.focus({ preventScroll: true });
}
function closeMessagesPanel() {
  document.querySelector("#msg-panel").hidden = true;
  document.querySelector("#msg-fab").setAttribute("aria-expanded", "false");
}
document.querySelector("#msg-fab").addEventListener("click", () => {
  if (document.querySelector("#msg-panel").hidden) openMessagesPanel(); else closeMessagesPanel();
});
document.querySelector("#msg-close").addEventListener("click", closeMessagesPanel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("#msg-panel").hidden && !document.querySelector("dialog[open]")) closeMessagesPanel();
});
portalHooks.onLogout.push(closeMessagesPanel);

/* ---------- Ergonomics: mobile menu, remembered view, keyboard ---------- */
function closeSidebar() {
  document.querySelector("#sidebar")?.classList.remove("is-open");
  const scrim = document.querySelector("#sidebar-scrim"); if (scrim) scrim.hidden = true;
  document.querySelector("#menu-toggle")?.setAttribute("aria-expanded", "false");
}
document.querySelector("#menu-toggle").addEventListener("click", () => {
  const open = !document.querySelector("#sidebar").classList.contains("is-open");
  document.querySelector("#sidebar").classList.toggle("is-open", open);
  document.querySelector("#sidebar-scrim").hidden = !open;
  document.querySelector("#menu-toggle").setAttribute("aria-expanded", String(open));
});
document.querySelector("#sidebar-scrim").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSidebar(); });

async function restoreSession() {
  if (isStaticHost) return;
  try {
    const result = await api("/api/me");
    await loadDashboard(result.user);
  } catch (error) {
    if (error.message !== "Please sign in to continue.") setGlobalError(error.message);
  }
}

if (isStaticHost) {
  const notice = document.querySelector("#hosting-notice");
  notice.textContent = "This GitHub Pages preview cannot sign in or create accounts. The portal needs its application server and database to be deployed first.";
  notice.hidden = false;
  document.querySelectorAll("#login-form input, #login-form select, #login-form button").forEach((field) => {
    field.disabled = true;
  });
}

document.addEventListener("DOMContentLoaded", restoreSession);

document.querySelector("#photo-dialog-close").addEventListener("click", () => document.querySelector("#photo-dialog").close());

/* ---------- In-page PDF viewer: lets administrators read a lesson plan without downloading it ---------- */
function openPdfViewer(url, title) {
  const dialog = document.querySelector("#pdf-viewer-dialog");
  document.querySelector("#pdf-viewer-title").textContent = title || "Document";
  document.querySelector("#pdf-viewer-open").href = url;
  document.querySelector("#pdf-viewer-download").href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  document.querySelector("#pdf-viewer-frame").src = url;
  if (!dialog.open) dialog.showModal();
}
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-view-file]");
  if (!trigger) return;
  event.preventDefault();
  openPdfViewer(trigger.dataset.viewFile, trigger.dataset.viewTitle);
});
document.querySelector("#pdf-viewer-close")?.addEventListener("click", () => document.querySelector("#pdf-viewer-dialog")?.close());
document.querySelector("#pdf-viewer-dialog")?.addEventListener("close", () => { document.querySelector("#pdf-viewer-frame").src = "about:blank"; });
document.querySelector("#photo-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
