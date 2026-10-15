const roleLabels = {
  developer: "Developer",
  admin: "Administrator",
  teacher: "Teacher",
  student: "Student",
};

const viewTitles = {
  overview: ["Overview", "Welcome to the Nag-iba National High School portal."],
  users: ["Accounts", "Manage school portal accounts permitted for your role."],
  messages: ["Messages", "Send and receive private messages with school accounts."],
  announcements: ["Announcements", "School and classroom updates."],
  tasks: ["Tasks", "School work and due dates."],
  documents: ["Documents", "Document requirements and submissions."],
  "lesson-plans": ["Lesson Plan Submission Center", "Dedicated workspace for lesson-plan submissions and progress."],
  settings: ["Settings", "Update your account security settings."],
};

let currentUser = null;
let currentView = "overview";
let managedUsers = [];
let directory = [];
let messages = [];
let announcements = [];
let tasks = [];
let subjects = [];
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
  document.querySelector("#tasks-nav-label").textContent = currentUser.role === "student" ? "My tasks" : "Tasks";
  document.querySelector("#announcement-compose-panel").hidden = currentUser.role === "student";
  document.querySelector("#task-compose-panel").hidden = currentUser.role === "student";
  document.querySelector("#lesson-plans-nav").hidden = !["admin","developer","teacher"].includes(currentUser.role);
  document.querySelector("#lesson-plan-admin-panel").hidden = !["admin","developer"].includes(currentUser.role);
  document.querySelector("#subject-compose-panel").hidden = currentUser.role !== "teacher";
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
  document.querySelector("#overview-tasks-title").textContent = currentUser.role === "student" ? "My tasks" : "School tasks";
}

function goToView(view) {
  if (!viewTitles[view]) return;
  if (view === "users" && !userCanManageAccounts()) return;
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
  if (view === "users") refreshUsers();
  if (view === "messages") refreshMessages();
  if (view === "announcements") refreshAnnouncements();
  if (view === "tasks") refreshTasks();
  if (view === "lesson-plans") refreshLessonPlans();
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
      { label: "My tasks", value: tasks.length, tone: "blue" },
      { label: "Unread messages", value: unread, tone: "teal" },
      { label: "Announcements", value: announcements.length, tone: "amber" },
    ]
    : [
      { label: accountLabel, value: managedUsers.filter((user) => user.active).length, tone: "blue" },
      { label: "Unread messages", value: unread, tone: "teal" },
      { label: "Announcements", value: announcements.length, tone: "amber" },
      { label: "Tasks", value: tasks.length, tone: "green" },
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
  document.querySelector("#overview-tasks").innerHTML = tasks.length
    ? tasks.slice(0, 3).map((item) => feedItem(item.title, item.description, `Due ${formatDate(item.due_at)} · ${item.creator_name}`)).join("")
    : emptyFeed("No tasks are available yet.");
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
  const [userResult, directoryResult, messageResult, announcementResult, taskResult] = await Promise.all([
    userCanManageAccounts() ? api("/api/users") : Promise.resolve({ users: [] }),
    api("/api/directory"),
    api("/api/messages"),
    api("/api/announcements"),
    api("/api/tasks"),
  ]);
  managedUsers = userResult.users;
  directory = directoryResult.users;
  messages = messageResult.messages;
  announcements = announcementResult.announcements;
  tasks = taskResult.tasks;
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
  const studentSelect = document.querySelector("#task-assignee");
  const assignees = currentUser.role === "admin" || currentUser.role === "developer"
    ? directory.filter((user) => user.role === "teacher")
    : directory.filter((user) => user.role === "student");
  studentSelect.innerHTML = (currentUser.role === "teacher" ? '<option value="">Choose a student</option>' : '<option value="">All students / no specific assignee</option>') + assignees.map((user) =>
    `<option value="${escapeHtml(user.id)}">${escapeHtml(user.displayName)}</option>`
  ).join("");
  studentSelect.required = currentUser.role === "teacher" && !document.querySelector("#task-subject").value;
  const subjectSelect = document.querySelector("#task-subject");
  subjectSelect.innerHTML = '<option value="">No subject</option>' + subjects.map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.name)}</option>`).join("");
}

function renderAnnouncements() {
  document.querySelector("#announcement-list").innerHTML = announcements.length
    ? announcements.map((item) => `<article class="content-card"><div class="content-card-heading"><h3>${escapeHtml(item.title)}</h3><span>${formatDate(item.created_at)}</span></div><p>${escapeHtml(item.body)}</p><small>Posted by ${escapeHtml(item.author_name || "School account")}</small>${(["admin","developer"].includes(currentUser.role) || String(item.author_id) === String(currentUser.id)) ? `<div class="row-actions"><button class="action-link danger-link" type="button" data-delete-announcement="${escapeHtml(item.id)}">Delete announcement</button></div>` : ""}</article>`).join("")
    : emptyFeed("No announcements have been published.");
}

function renderTasks() {
  document.querySelector("#task-list").innerHTML = tasks.length
    ? tasks.map((item) => `<article class="content-card"><div class="content-card-heading"><h3>${escapeHtml(item.title)}</h3><span class="deadline-chip">Due ${formatDate(item.due_at)}</span></div><p>${escapeHtml(item.description)}</p><small>${item.subject_name ? `Subject: ${escapeHtml(item.subject_name)} · ` : ""}${item.assigned_name ? `Assigned to ${escapeHtml(item.assigned_name)}` : "Shared with students"} · Posted by ${escapeHtml(item.creator_name)}</small>${(item.attachments || []).length ? `<div class="attachment-list"><strong>Attachments</strong>${item.attachments.map((file) => `<a class="action-link" href="/api/task-files/${encodeURIComponent(file.id)}" target="_blank" rel="noopener">📎 ${escapeHtml(file.fileName)} (${(Number(file.fileSize)/1024/1024).toFixed(2)} MB)</a>`).join("")}</div>` : ""}${(["admin","developer"].includes(currentUser.role) || String(item.created_by) === String(currentUser.id) || String(item.creator_id) === String(currentUser.id)) ? `<div class="row-actions"><button class="action-link danger-link" type="button" data-delete-task="${escapeHtml(item.id)}">Delete task</button></div>` : ""}</article>`).join("")
    : emptyFeed("No tasks have been assigned.");
  document.querySelector("#tasks-heading").textContent = currentUser.role === "student" ? "My tasks" : "Tasks and assigned work";
  document.querySelector("#tasks-description").textContent = currentUser.role === "student" ? "Tasks assigned to you and work shared with your classes." : "Admins assign tasks to teachers; teachers assign work to enrolled students.";
}


let lessonPlanTasks = [];
let lessonPlanAssignments = [];
let selectedLpSubject = null;
let selectedLpTeacherId = null;
let selectedLpSubjectId = null;
function isLpAdmin() { return ["admin","developer"].includes(currentUser?.role); }
function renderLessonPlanTasks() {
  const admin=isLpAdmin();
  const panel=document.querySelector("#lesson-plan-task-panel");
  const host=document.querySelector(admin ? "#lesson-plan-task-list" : "#lp-teacher-task-list");
  if (!host) return;
  const visibleTasks=admin ? lessonPlanTasks.filter(t=> selectedLpTeacherId!=null ? (String(t.teacher_id)===String(selectedLpTeacherId) && (selectedLpSubjectId==null || String(t.subject_id)===String(selectedLpSubjectId))) : (selectedLpSubject && t.subject_name===selectedLpSubject && (selectedLpSubjectId==null || String(t.subject_id)===String(selectedLpSubjectId)))) : lessonPlanTasks;
  if (admin && panel) panel.hidden=!selectedLpSubject;
  const grouped=new Map();
  for (const t of visibleTasks) {
    const key=`${t.subject_name}||${t.week_number}`;
    if(!grouped.has(key)) grouped.set(key,{subject:t.subject_name,week:t.week_number,tasks:[]});
    grouped.get(key).tasks.push(t);
  }
  const weekMarkup=visibleTasks.length ? [...grouped.values()].map(group=>`<section class="panel calendar-week"><div class="panel-heading"><div><h3>${escapeHtml(group.subject)} · Week ${group.week}</h3><p>Daily lesson-plan calendar</p></div></div><div class="calendar-days">${group.tasks.map(t=>{
    const submitted=!!t.upload_id;
    const late=String(t.status||"").toLowerCase()==="late" || String(t.status||"").toLowerCase()==="overdue";
    const controls=admin
      ? (submitted ? `<div class="attachment-list"><a class="action-link" href="/api/lesson-plans/uploads/${t.upload_id}/file" target="_blank" rel="noopener">Open PDF: ${escapeHtml(t.file_name)}</a><p>Status: <strong>${escapeHtml(t.status)}</strong>${t.admin_feedback ? ` · ${escapeHtml(t.admin_feedback)}` : ""}</p><p>Submitted: ${formatDate(t.submitted_at)}${Number(t.revision_count)>0 ? ` · ${t.revision_count} earlier revision(s)` : ""}</p><form class="lp-review-form" data-upload-id="${t.upload_id}"><select name="status"><option>Approved</option><option>For Revision</option></select><input name="feedback" maxlength="2000" placeholder="Revision notes / admin feedback" value="${escapeHtml(t.admin_feedback||"")}"><button class="button button-primary" type="submit">Save review</button></form>${Number(t.revision_count)>0 ? `<details><summary>View previous revisions (${t.revision_count})</summary><div class="lp-history" data-history-task="${t.id}">Loading revision history…</div></details>` : ""}</div>` : `<p>Status: <strong>${escapeHtml(t.status)}</strong></p><small>Waiting for teacher upload.</small>`)
      : `<form class="lp-upload-form" data-task-id="${t.id}"><label class="login-field">Upload lesson plan (PDF only, max 8 MB)<input type="file" name="file" accept="application/pdf,.pdf" required></label><button class="button button-primary" type="submit">${submitted ? "Upload revised PDF" : "Submit daily lesson plan"}</button>${submitted ? `<p>Status: <strong>${escapeHtml(t.status)}</strong>${t.admin_feedback ? ` · Admin feedback: ${escapeHtml(t.admin_feedback)}` : ""}</p><small>Submitted: ${formatDate(t.submitted_at)}</small>` : `<p>Status: <strong>${escapeHtml(t.status)}</strong></p>`}</form>`;
    return `<article class="calendar-day ${late?"calendar-day-late":""}"><div class="content-card-heading"><h4>Day ${t.day_number}</h4><span class="deadline-chip">Due ${formatDate(t.due_date)}</span></div>${admin?`<small>Teacher: ${escapeHtml(t.teacher_name)}</small>`:""}${controls}</article>`;
  }).join("")}</div></section>`).join("") : emptyFeed(admin ? "No calendar entries for this term and selection." : "No lesson-plan calendar assigned to you for this term yet.");
  if(admin) host.innerHTML=weekMarkup;
  else {
    const bySubject=new Map();
    for(const group of grouped.values()){ if(!bySubject.has(group.subject)) bySubject.set(group.subject,[]); bySubject.get(group.subject).push(group); }
    host.innerHTML=bySubject.size ? [...bySubject.entries()].map(([subject,weeks])=>`<details class="lp-teacher-subject"><summary><span>${escapeHtml(subject)}</span><small>${weeks.reduce((n,w)=>n+w.tasks.length,0)} daily tasks · ${weeks.length} weeks</small></summary><div class="lp-teacher-weeks">${weeks.map(w=>`<details class="lp-teacher-week"><summary>Week ${w.week}<small>${w.tasks.filter(t=>!!t.upload_id).length}/${w.tasks.length} submitted</small></summary><section class="calendar-week"><div class="calendar-days">${w.tasks.map(t=>{ const submitted=!!t.upload_id; const late=["late","overdue"].includes(String(t.status||"").toLowerCase()); return `<article class="calendar-day ${late?"calendar-day-late":""}"><div class="content-card-heading"><h4>Day ${t.day_number}</h4><span class="deadline-chip">Due ${formatDate(t.due_date)}</span></div><form class="lp-upload-form" data-task-id="${t.id}"><label class="login-field">Upload lesson plan (PDF only, max 8 MB)<input type="file" name="file" accept="application/pdf,.pdf" required></label><button class="button button-primary" type="submit">${submitted?"Upload revised PDF":"Submit daily lesson plan"}</button><p>Status: <strong>${escapeHtml(t.status)}</strong>${t.admin_feedback?` · Admin feedback: ${escapeHtml(t.admin_feedback)}`:""}</p>${submitted?`<small>Submitted: ${formatDate(t.submitted_at)}</small>`:""}</form></article>`; }).join("")}</div></section></details>`).join("")}</div></details>`).join("") : emptyFeed("No lesson-plan calendar assigned to you for this term yet.");
  }
  host.querySelectorAll("details[data-history-task], details").forEach(details=>{
    const wrap=details.querySelector("[data-history-task]"); if(!wrap || wrap.dataset.loaded) return;
    wrap.dataset.loaded="1";
    api(`/api/lesson-plans/tasks/${wrap.dataset.historyTask}/history`).then(result=>{
      wrap.innerHTML=result.versions.length ? result.versions.map(v=>`<p><a class="action-link" href="/api/lesson-plans/versions/${v.id}/file" target="_blank" rel="noopener">Revision ${v.version_number}: ${escapeHtml(v.file_name)}</a> · ${escapeHtml(v.status)} · ${formatDate(v.submitted_at)}${v.admin_feedback?`<br>Feedback: ${escapeHtml(v.admin_feedback)}`:""}</p>`).join("") : "No previous revisions.";
    }).catch(e=>{wrap.textContent=e.message;});
  });
}
function renderLessonPlanDashboard() {
  const statsHost=document.querySelector("#lp-dashboard-stats");
  if(!statsHost) return;
  const total=lessonPlanTasks.length;
  const submitted=lessonPlanTasks.filter(t=>!!t.upload_id).length;
  const approved=lessonPlanTasks.filter(t=>String(t.status||"").toLowerCase()==="approved").length;
  const pending=lessonPlanTasks.filter(t=>!t.upload_id).length;
  const cards=[
    {label:"Required lesson plans",value:total,tone:"blue"},
    {label:"Submitted",value:submitted,tone:"teal"},
    {label:"Approved",value:approved,tone:"green"},
    {label:"Awaiting upload",value:pending,tone:"amber"}
  ];
  statsHost.innerHTML=cards.map(c=>`<div class="stat-card overview-stat" data-tone="${c.tone}"><span class="stat-label"><i class="stat-marker"></i>${c.label}</span><span class="stat-value">${c.value}</span></div>`).join("");
  const admin=isLpAdmin();
  document.querySelector("#lp-progress-panel").hidden=!admin;
  document.querySelector("#lp-teacher-progress-panel").hidden=!admin;
  if(!admin) return;
  const group=(key)=>{
    const map=new Map();
    lessonPlanTasks.forEach(t=>{
      const name=t[key]||"Unassigned";
      if(!map.has(name)) map.set(name,{name,teachers:new Set(),subjects:new Set(),total:0,submitted:0,approved:0});
      const g=map.get(name); g.total++; if(t.teacher_name)g.teachers.add(t.teacher_name); if(t.subject_name)g.subjects.add(t.subject_name); if(t.upload_id)g.submitted++; if(String(t.status||"").toLowerCase()==="approved")g.approved++;
    });
    return [...map.values()];
  };
  const pct=(g)=>g.total?Math.round(g.submitted/g.total*100):0;
  const subjectRows=group("subject_name").map(g=>`<tr class="lp-subject-row" data-lp-subject="${escapeHtml(g.name)}" tabindex="0" role="button" aria-label="Open lesson plans for ${escapeHtml(g.name)}"><td><button type="button" class="action-link" data-lp-open-subject="${escapeHtml(g.name)}">${escapeHtml(g.name)} · View plans</button></td><td>${escapeHtml([...g.teachers].join(", ")||"—")}</td><td>${g.total}</td><td>${g.submitted}</td><td>${g.approved}</td><td>${pct(g)}%</td></tr>`).join("");
  document.querySelector("#lp-subject-progress").innerHTML=subjectRows||'<tr><td colspan="6">No tasks generated for this term yet.</td></tr>';
  const teacherRows=group("teacher_name").map(g=>`<tr><td><button type="button" class="action-link" data-lp-open-teacher="${escapeHtml(g.name)}">${escapeHtml(g.name)} · View plans</button></td><td>${escapeHtml([...g.subjects].join(", ")||"—")}</td><td>${g.total}</td><td>${g.submitted}</td><td>${g.approved}</td><td>${pct(g)}%</td></tr>`).join("");
  document.querySelector("#lp-teacher-progress").innerHTML=teacherRows||'<tr><td colspan="6">No teacher tasks generated for this term yet.</td></tr>';
}

async function refreshLessonPlans() {
  if (!currentUser) return;
  try {
    const term=document.querySelector("#lp-view-term")?.value || "1";
    const [assignments, taskResult, directoryResult] = await Promise.all([
      api("/api/lesson-plans/assignments"),
      api(`/api/lesson-plans/tasks?term=${term}`),
      api("/api/directory")
    ]);
    lessonPlanAssignments=assignments.assignments;
    lessonPlanTasks=taskResult.tasks;
    directory=directoryResult.users;
    const teacherSelect=document.querySelector("#lp-teacher");
    const prior=teacherSelect.value;
    const teachers=directory.filter(u=>u.role==="teacher" && u.active!==false);
    teacherSelect.innerHTML='<option value="">Choose a teacher</option>'+teachers.map(u=>`<option value="${u.id}">${escapeHtml(u.displayName)}</option>`).join("");
    if(prior && teachers.some(u=>String(u.id)===String(prior))) teacherSelect.value=prior;
    teacherSelect.disabled=teachers.length===0;
    document.querySelector("#lp-start-date").value ||= new Date().toISOString().slice(0,10);
    document.querySelector("#lp-assignment-list").innerHTML=lessonPlanAssignments.length ? lessonPlanAssignments.map(a=>`<article class="content-card lp-assignment-card"><div class="content-card-heading"><div><h3>${escapeHtml(a.teacher_name)} · ${escapeHtml(a.subject_name)}</h3><small>Teacher–subject assignment</small></div><div class="row-actions"><button type="button" class="button button-secondary" data-lp-edit="${a.id}">Edit</button><button type="button" class="action-link danger-link" data-lp-remove="${a.id}">Delete</button><button type="button" class="action-link" data-lp-assignment-open="${a.teacher_id}|${a.subject_id}|${escapeHtml(a.subject_name)}">View plans</button></div></div><form class="lp-assignment-edit" data-lp-edit-form="${a.id}" hidden><label class="login-field">Teacher<select name="teacherId" required>${teachers.map(u=>`<option value="${u.id}" ${String(u.id)===String(a.teacher_id)?"selected":""}>${escapeHtml(u.displayName)}</option>`).join("")}</select></label><label class="login-field">Subject name<input name="subjectName" maxlength="160" required value="${escapeHtml(a.subject_name)}"></label><div class="form-actions"><button class="button button-primary" type="submit">Save changes</button><button class="button button-secondary" type="button" data-lp-cancel-edit="${a.id}">Cancel</button></div><small>Changing the teacher or subject updates this assignment and its generated tasks. Uploaded files and revision history are retained.</small></form></article>`).join("") : emptyFeed("No teacher-subject assignments yet.");
    if (!isLpAdmin()) renderLessonPlanTasks();
    else if (selectedLpSubject) renderLessonPlanTasks();
    else { document.querySelector("#lesson-plan-task-panel").hidden=true; document.querySelector("#lesson-plan-task-list").innerHTML=""; }
    renderLessonPlanDashboard();
  } catch(error) { setGlobalError(error.message); }
}


async function refreshLpNotifications() {
  const panel=document.querySelector("#lp-dashboard-notifications");
  if(!panel || !currentUser || !["admin","developer","teacher"].includes(currentUser.role)) return;
  try {
    const results=await Promise.all([1,2,3].map(term=>api(`/api/lesson-plans/tasks?term=${term}`)));
    const all=results.flatMap(r=>r.tasks||[]);
    const items=currentUser.role==="teacher" ? all.filter(t=>!t.upload_id || t.status==="For Revision") : all.filter(t=>!!t.upload_id && ["Submitted","Late","For Revision"].includes(t.status));
    panel.hidden=items.length===0;
    const late=items.filter(t=>String(t.status).toLowerCase()==="late" || String(t.status).toLowerCase()==="overdue").length;
    document.querySelector("#lp-notification-summary").textContent=currentUser.role==="teacher" ? `${items.length} daily lesson plan(s) waiting for your PDF submission${late?`; ${late} overdue`:""}.` : `${items.length} lesson-plan submission(s) waiting for administrator review.`;
    document.querySelector("#lp-notification-list").innerHTML=items.slice(0,8).map(t=>feedItem(`${t.subject_name} · Term ${t.term_number}, Week ${t.week_number}, Day ${t.day_number}`, `${currentUser.role==="teacher"?"Submit the daily lesson plan as PDF":"Review teacher submission"}. Due ${String(t.due_date).slice(0,10)}${t.status?` · ${t.status}`:""}`, currentUser.role==="teacher"?"Daily submission required":t.teacher_name)).join("");
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

async function refreshTasks() {
  try {
    tasks = (await api("/api/tasks")).tasks;
    subjects = (await api("/api/subjects")).subjects;
    if (currentUser.role !== "student") directory = (await api("/api/directory")).users;
    populateRecipientOptions();
    renderSubjects();
    renderTasks();
    renderOverview();
    await refreshLessonPlans();
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
  goToView("overview");
  try {
    await refreshOverview();
    renderUsers();
    await refreshLpNotifications();
  } catch (error) {
    setGlobalError(error.message);
  }
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
  if (currentView === "messages") renderMessages();
  if (currentView === "announcements") renderAnnouncements();
  if (currentView === "tasks") renderTasks();
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

document.querySelector("#announcement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await api("/api/announcements", {
      method: "POST",
      body: { title: data.get("title"), body: data.get("body") },
    });
    event.currentTarget.reset();
    await refreshAfterMutation("Announcement published.");
  } catch (error) {
    setGlobalError(error.message);
  }
});

document.querySelector("#announcement-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-announcement]"); if (!button) return;
  if (!confirm("Delete this announcement? This cannot be undone.")) return;
  try { await api(`/api/announcements/${encodeURIComponent(button.dataset.deleteAnnouncement)}`, { method: "DELETE" }); await refreshAnnouncements(); showToast("Announcement deleted."); }
  catch (error) { setGlobalError(error.message); }
});
document.querySelector("#task-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-task]"); if (!button) return;
  if (!confirm("Delete this task and its attachments? This cannot be undone.")) return;
  try { await api(`/api/tasks/${encodeURIComponent(button.dataset.deleteTask)}`, { method: "DELETE" }); await refreshTasks(); showToast("Task deleted."); }
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

function renderSubjects() {
  const host = document.querySelector("#subject-list");
  if (!host) return;
  host.innerHTML = subjects.length ? subjects.map((subject) => `<article class="content-card"><div class="content-card-heading"><h3>${escapeHtml(subject.name)}${subject.code ? ` · ${escapeHtml(subject.code)}` : ""}</h3><span>${(subject.students || []).length} students</span></div><p>${escapeHtml(subject.description || "No description provided.")}</p>${currentUser.role === "teacher" ? `<label class="login-field">Assign students to this subject<select multiple size="5" data-subject-students="${escapeHtml(subject.id)}">${directory.filter((u) => u.role === "student").map((u) => `<option value="${escapeHtml(u.id)}" ${(subject.students || []).some((st) => String(st.id) === String(u.id)) ? "selected" : ""}>${escapeHtml(u.displayName)}</option>`).join("")}</select></label><div class="row-actions"><button class="button button-primary" type="button" data-save-subject-students="${escapeHtml(subject.id)}">Save assigned students</button></div>` : `<small>Teacher: ${escapeHtml(subject.teacher_name || "School teacher")}</small>`}</article>`).join("") : emptyFeed(currentUser.role === "teacher" ? "Create your first subject, then assign students to it." : "No subjects are available yet.");
}

document.querySelector("#task-subject").addEventListener("change", () => { const select = document.querySelector("#task-assignee"); select.required = currentUser.role === "teacher" && !document.querySelector("#task-subject").value; });

document.querySelector("#subject-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  try { await api("/api/subjects", { method: "POST", body: { name: data.get("name"), code: data.get("code"), description: data.get("description") } }); event.currentTarget.reset(); await refreshTasks(); showToast("Subject created."); }
  catch (error) { setGlobalError(error.message); }
});
document.querySelector("#subject-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-save-subject-students]"); if (!button) return;
  const select = document.querySelector(`[data-subject-students="${CSS.escape(button.dataset.saveSubjectStudents)}"]`);
  try { await api(`/api/subjects/${encodeURIComponent(button.dataset.saveSubjectStudents)}/students`, { method: "POST", body: { studentIds: [...select.selectedOptions].map((option) => option.value) } }); await refreshTasks(); showToast("Subject student assignments saved."); }
  catch (error) { setGlobalError(error.message); }
});

document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const selectedFiles = [...(document.querySelector("#task-files").files || [])];
    if (selectedFiles.some((file) => file.size > 8 * 1024 * 1024)) throw new Error("Each attachment must be 8 MB or smaller.");
    if (selectedFiles.length > 10) throw new Error("Choose no more than 10 files.");
    const files = await Promise.all(selectedFiles.map(fileToPayload));
    await api("/api/tasks", {
      method: "POST",
      body: {
        title: data.get("title"), description: data.get("description"),
        dueAt: data.get("dueAt") ? new Date(data.get("dueAt")).toISOString() : null,
        assignedTo: data.get("assignedTo") || null, subjectId: data.get("subjectId") || null, files,
      },
    });
    event.currentTarget.reset();
    await refreshAfterMutation("Task assigned.");
  } catch (error) {
    setGlobalError(error.message);
  }
});

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
  const subjectName=document.querySelector("#lp-subject").value.trim();
  const termNumber=Number(document.querySelector("#lp-generate-term").value);
  const weeks=Number(document.querySelector("#lp-weeks").value);
  const daysPerWeek=Number(document.querySelector("#lp-days").value);
  const startDate=document.querySelector("#lp-start-date").value;
  try {
    const result=await api("/api/lesson-plans/generate",{method:"POST",body:{termNumber,teacherId,subjectName,weeks,daysPerWeek,startDate}});
    document.querySelector("#lp-view-term").value=String(termNumber);
    selectedLpSubject=subjectName;
    document.querySelector("#lp-subject").value="";
    await refreshLessonPlans(); await refreshLpNotifications();
    showToast(`Term ${termNumber}: created/updated ${result.generatedOrUpdated} daily lesson-plan tasks.`);
  } catch(e){setGlobalError(e.message);}
});
document.querySelector("#lp-view-term").addEventListener("change",()=>{selectedLpSubject=null; refreshLessonPlans();});
document.querySelector("#lp-subject-progress").addEventListener("click",(event)=>{
  const trigger=event.target.closest("[data-lp-open-subject]");
  const row=event.target.closest("[data-lp-subject]");
  const subject=trigger?.dataset.lpOpenSubject || row?.dataset.lpSubject;
  if(!subject)return;
  selectedLpSubject=subject; selectedLpTeacherId=null; selectedLpSubjectId=null;
  document.querySelector("#lp-task-detail-heading").textContent=`${subject} · Term ${document.querySelector("#lp-view-term").value}`;
  document.querySelector("#lesson-plan-task-panel").hidden=false;
  renderLessonPlanTasks();
  document.querySelector("#lesson-plan-task-panel").scrollIntoView({behavior:"smooth",block:"start"});
});
document.querySelector("#lp-subject-progress").addEventListener("keydown",(event)=>{
  if(event.key!=="Enter" && event.key!==" ")return;
  const row=event.target.closest("[data-lp-subject]"); if(!row)return;
  event.preventDefault(); row.querySelector("[data-lp-open-subject]")?.click();
});
document.querySelector("#lp-close-details").addEventListener("click",()=>{selectedLpSubject=null;selectedLpTeacherId=null;selectedLpSubjectId=null;document.querySelector("#lesson-plan-task-panel").hidden=true;});
document.querySelector("#lp-teacher-progress").addEventListener("click",(event)=>{const b=event.target.closest("[data-lp-open-teacher]");if(!b)return;const teacherName=b.dataset.lpOpenTeacher;const match=lessonPlanTasks.find(t=>t.teacher_name===teacherName);if(!match)return;selectedLpSubject=match.subject_name;selectedLpTeacherId=match.teacher_id;selectedLpSubjectId=null;document.querySelector("#lp-task-detail-heading").textContent=`${teacherName} · ${match.subject_name} · Term ${document.querySelector("#lp-view-term").value}`;document.querySelector("#lesson-plan-task-panel").hidden=false;renderLessonPlanTasks();document.querySelector("#lesson-plan-task-panel").scrollIntoView({behavior:"smooth",block:"start"});});
document.querySelector("#lp-assignment-list").addEventListener("click",async(event)=>{
  const edit=event.target.closest("[data-lp-edit]");
  if(edit){const form=document.querySelector(`[data-lp-edit-form="${edit.dataset.lpEdit}"]`);if(form)form.hidden=!form.hidden;return;}
  const cancel=event.target.closest("[data-lp-cancel-edit]");if(cancel){const form=document.querySelector(`[data-lp-edit-form="${cancel.dataset.lpCancelEdit}"]`);if(form)form.hidden=true;return;}
  const open=event.target.closest("[data-lp-assignment-open]");if(open){const [teacherId,subjectId,subject]=open.dataset.lpAssignmentOpen.split("|");selectedLpSubject=subject;selectedLpTeacherId=teacherId;selectedLpSubjectId=subjectId;document.querySelector("#lp-task-detail-heading").textContent=`${subject} · Term ${document.querySelector("#lp-view-term").value}`;document.querySelector("#lesson-plan-task-panel").hidden=false;renderLessonPlanTasks();document.querySelector("#lesson-plan-task-panel").scrollIntoView({behavior:"smooth",block:"start"});return;}
  const remove=event.target.closest("[data-lp-remove]");if(remove){if(!confirm("Delete this teacher–subject assignment? Existing generated tasks and submitted files will remain accessible in progress."))return;try{await api(`/api/lesson-plans/assignments/${remove.dataset.lpRemove}`,{method:"DELETE"});await refreshLessonPlans();showToast("Assignment deleted.");}catch(e){setGlobalError(e.message);} }
});
document.querySelector("#lp-assignment-list").addEventListener("submit",async(event)=>{const form=event.target.closest("[data-lp-edit-form]");if(!form)return;event.preventDefault();const data=new FormData(form);try{await api(`/api/lesson-plans/assignments/${form.dataset.lpEdit}`,{method:"PUT",body:{teacherId:Number(data.get("teacherId")),subjectName:String(data.get("subjectName")).trim()}});await refreshLessonPlans();showToast("Teacher–subject assignment updated.");}catch(e){setGlobalError(e.message);}});
document.querySelector("#view-lesson-plans").addEventListener("submit",async(event)=>{
  const uploadForm=event.target.closest(".lp-upload-form");
  const reviewForm=event.target.closest(".lp-review-form");
  if(uploadForm){
    event.preventDefault();
    const file=uploadForm.querySelector('input[type="file"]').files[0];
    if(!file)return;
    if(!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type!=="application/pdf")){setGlobalError("Please upload a PDF file only.");return;}
    if(file.size>8*1024*1024){setGlobalError("Lesson-plan PDF files must be 8 MB or smaller.");return;}
    try { await api(`/api/lesson-plans/tasks/${uploadForm.dataset.taskId}/upload`,{method:"POST",body:{file:await fileToPayload(file)}}); await refreshLessonPlans(); await refreshLpNotifications(); showToast("Lesson plan submitted."); }
    catch(e){setGlobalError(e.message);}
  } else if(reviewForm){
    event.preventDefault();
    const data=new FormData(reviewForm);
    try { await api(`/api/lesson-plans/uploads/${reviewForm.dataset.uploadId}/review`,{method:"POST",body:{status:data.get("status"),feedback:data.get("feedback")}}); await refreshLessonPlans(); await refreshLpNotifications(); showToast("Lesson-plan review saved."); }
    catch(e){setGlobalError(e.message);}
  }
});

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

restoreSession();
