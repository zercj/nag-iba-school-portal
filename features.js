/* Features added on top of app.js: profile settings, new-announcement tab (photos + expiry), memos,
   class schedule, attendance and in-app notices. Loaded after app.js and shares its globals. */

const $ = (selector, root = document) => root.querySelector(selector);
const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
const fmtBytes = (n) => Number(n) >= 1048576 ? `${(Number(n) / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(n) / 1024))} KB`;
const isAdminUser = () => ["admin", "developer"].includes(currentUser?.role);

function to12h(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function minutesOf(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; }
function timeOptions(selected, placeholder) {
  let html = `<option value="">${escapeHtml(placeholder)}</option>`;
  for (let minutes = 5 * 60; minutes <= 20 * 60; minutes += 5) {
    const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    html += `<option value="${value}"${value === selected ? " selected" : ""}>${to12h(value)}</option>`;
  }
  return html;
}

/* ====================== Notices (e.g. an administrator removed a lesson plan) ====================== */
async function loadNotices() {
  const panel = $("#notice-panel");
  if (!panel || !currentUser) return;
  try {
    const { notifications } = await api("/api/notifications");
    panel.hidden = notifications.length === 0;
    $("#notice-list").innerHTML = notifications.map((n) => `<article class="feed-item notice-item"><div class="lp-feed-top"><h3>${escapeHtml(n.title)}</h3><button type="button" class="action-link" data-notice-read="${escapeHtml(n.id)}">Dismiss</button></div><p>${escapeHtml(n.body)}</p><small>${escapeHtml(formatDate(n.created_at))}</small></article>`).join("");
  } catch (_) { /* notices are supplementary */ }
}
$("#notice-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-notice-read]"); if (!button) return;
  try { await api(`/api/notifications/${encodeURIComponent(button.dataset.noticeRead)}/read`, { method: "POST" }); await loadNotices(); } catch (e) { setGlobalError(e.message); }
});
$("#notice-clear-all").addEventListener("click", async () => {
  try { await api("/api/notifications/read-all", { method: "POST" }); await loadNotices(); } catch (e) { setGlobalError(e.message); }
});
viewRegistry.overview = { onEnter: loadNotices };
portalHooks.onLogin.push(loadNotices);

/* ====================== Settings: profile ====================== */
function fillProfileForm() {
  $("#profile-name-input").value = currentUser.displayName || "";
  $("#profile-email").value = currentUser.email || "";
  $("#profile-phone").value = currentUser.phone || "";
  $("#profile-username").value = currentUser.username || "";
  $("#profile-current-password").value = "";
  $("#profile-password-wrap").hidden = true;
  $("#profile-form-error").hidden = true;
}
$("#profile-username").addEventListener("input", (event) => {
  $("#profile-password-wrap").hidden = event.target.value.trim() === currentUser.username;
  $("#profile-current-password").required = !$("#profile-password-wrap").hidden;
});
$("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#profile-form-error"); error.hidden = true;
  const data = new FormData(event.currentTarget);
  const body = { displayName: data.get("displayName"), email: data.get("email"), phone: data.get("phone"), username: String(data.get("username")).trim() };
  if (body.username !== currentUser.username) body.currentPassword = data.get("currentPassword");
  try {
    const { user } = await api("/api/account/profile", { method: "PATCH", body });
    currentUser = { ...currentUser, ...user };
    $("#profile-name").textContent = user.displayName;
    $("#welcome-heading").textContent = `Welcome, ${user.displayName}`;
    $("#profile-avatar").textContent = user.displayName.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    fillProfileForm();
    showToast("Profile saved.");
  } catch (requestError) { error.textContent = requestError.message; error.hidden = false; }
});

/* ====================== Class schedule: editor (Settings + admin) and weekly grid ====================== */
function createScheduleEditor({ formHost, listHost, getTeacherId, onChange }) {
  let options = { subjects: [], mySubjects: [], sections: [], leaveTypes: [] };
  let entries = [];
  let editingId = null;

  const formMarkup = (entry = {}) => {
    const subjectKnown = !entry.subject || options.subjects.includes(entry.subject);
    const sectionKnown = !entry.section || options.sections.some((s) => s.name === entry.section);
    const subjectsBlock = `<div class="my-subjects"><strong>My subjects</strong><div class="subject-chips">${options.mySubjects.length ? options.mySubjects.map((s) => `<span class="subject-chip">${escapeHtml(s.name)}${s.assigned ? "" : `<button type="button" data-remove-subject="${s.id}" aria-label="Remove ${escapeHtml(s.name)}">&times;</button>`}</span>`).join("") : '<small class="form-hint">No subjects yet.</small>'}</div>
      <form class="subject-add-form" novalidate><input name="names" maxlength="600" placeholder="Add subjects, separated by commas (e.g. Math 7, Science 8)" aria-label="Add subjects" /><button class="button button-secondary" type="submit">Add subjects</button></form></div>`;
    return `${subjectsBlock}<form class="portal-form schedule-form" novalidate>
      <fieldset class="day-picker schedule-days"><legend>${editingId ? "Day" : "Days (pick one or more)"}</legend>${[1, 2, 3, 4, 5].map((d) => `<label class="day-chip"><input type="checkbox" name="weekday" value="${d}"${Number(entry.weekday) === d ? " checked" : ""} /><span>${WEEKDAY_SHORT[d]}</span></label>`).join("")}</fieldset>
      <div class="schedule-fields">
        <label class="login-field">Time in<select name="timeIn" required>${timeOptions(entry.timeIn, "Time in")}</select></label>
        <label class="login-field">Time out<select name="timeOut" required>${timeOptions(entry.timeOut, "Time out")}</select></label>
        <label class="login-field">Subject<select name="subjectChoice" required><option value="">Subject</option>${options.subjects.map((n) => `<option${n === entry.subject ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}<option value="__other"${subjectKnown ? "" : " selected"}>Other (type it)…</option></select></label>
        <label class="login-field">Section<select name="sectionChoice" required><option value="">Section</option>${options.sections.map((s) => `<option${s.name === entry.section ? " selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}<option value="__new"${sectionKnown ? "" : " selected"}>＋ New section…</option></select></label>
      </div>
      <div class="schedule-fields">
        <label class="login-field" data-subject-other${subjectKnown ? " hidden" : ""}>Subject name<input name="subjectOther" maxlength="160" value="${subjectKnown ? "" : escapeHtml(entry.subject)}" /></label>
        <label class="login-field" data-section-new${sectionKnown ? " hidden" : ""}>New section name<input name="sectionNew" maxlength="80" placeholder="e.g. Grade 7 – Sampaguita" value="${sectionKnown ? "" : escapeHtml(entry.section)}" /></label>
      </div>
      <p class="form-error schedule-error" role="alert" hidden></p>
      <div class="form-actions"><span class="form-hint">Tick every day this class meets. Subjects come from “My subjects” above; choose “Other” to type a one-off.</span><span class="row-actions">${editingId ? '<button class="button button-secondary" type="button" data-cancel-edit>Cancel edit</button>' : ""}<button class="button button-primary" type="submit">${editingId ? "Save changes" : "Save class"}</button></span></div>
    </form>`;
  };

  const renderList = () => {
    if (!entries.length) { listHost.innerHTML = emptyFeed("No classes added yet."); return; }
    listHost.innerHTML = [1, 2, 3, 4, 5].map((day) => {
      const list = entries.filter((e) => e.weekday === day);
      if (!list.length) return "";
      return `<div class="schedule-day"><h4>${WEEKDAY_NAMES[day]}</h4>${list.map((e) => `<div class="schedule-entry"><div><strong>${to12h(e.timeIn)} – ${to12h(e.timeOut)}</strong><span>${escapeHtml(e.subject)} · ${escapeHtml(e.section)}</span></div><div class="row-actions"><button type="button" class="action-link" data-edit-entry="${e.id}">Edit</button><button type="button" class="action-link danger-link" data-delete-entry="${e.id}">Delete</button></div></div>`).join("")}</div>`;
    }).join("");
  };

  const renderForm = () => { formHost.innerHTML = formMarkup(entries.find((e) => e.id === editingId)); };

  async function load() {
    const teacherId = getTeacherId();
    if (!teacherId) { formHost.innerHTML = ""; listHost.innerHTML = emptyFeed("Choose a teacher."); return; }
    const [opt, list] = await Promise.all([api(`/api/schedule/options?teacherId=${encodeURIComponent(teacherId)}`), api(`/api/schedule?teacherId=${encodeURIComponent(teacherId)}`)]);
    options = { mySubjects: [], subjects: [], sections: [], ...opt }; entries = list.entries; editingId = null;
    renderForm(); renderList();
  }

  formHost.addEventListener("change", (event) => {
    if (event.target.name === "subjectChoice") $("[data-subject-other]", formHost).hidden = event.target.value !== "__other";
    if (event.target.name === "sectionChoice") $("[data-section-new]", formHost).hidden = event.target.value !== "__new";
    if (event.target.name === "timeIn") {
      const out = $('select[name="timeOut"]', formHost);
      if (event.target.value && !out.value) { const end = minutesOf(event.target.value) + 50; out.value = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`; }
    }
  });
  formHost.addEventListener("click", async (event) => {
    if (event.target.closest("[data-cancel-edit]")) { editingId = null; renderForm(); return; }
    const remove = event.target.closest("[data-remove-subject]");
    if (!remove) return;
    try { await api(`/api/schedule/subjects/${remove.dataset.removeSubject}`, { method: "DELETE" }); await load(); } catch (e) { setGlobalError(e.message); }
  });
  formHost.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.classList.contains("subject-add-form")) {
      const names = String(new FormData(event.target).get("names")).split(/[,;\n]/).map((n) => n.trim()).filter(Boolean);
      if (!names.length) return;
      try { await api("/api/schedule/subjects", { method: "POST", body: { teacherId: Number(getTeacherId()), names } }); showToast("Subjects added."); await load(); } catch (e) { setGlobalError(e.message); }
      return;
    }
    const form = event.target, data = new FormData(form), error = $(".schedule-error", form);
    error.hidden = true;
    const subject = data.get("subjectChoice") === "__other" ? String(data.get("subjectOther")).trim() : data.get("subjectChoice");
    const section = data.get("sectionChoice") === "__new" ? String(data.get("sectionNew")).trim() : data.get("sectionChoice");
    const fail = (m) => { error.textContent = m; error.hidden = false; };
    const days = data.getAll("weekday").map(Number);
    if (!days.length || !data.get("timeIn") || !data.get("timeOut")) return fail("Choose at least one day, the time in and the time out.");
    if (!subject) return fail("Choose or type the subject.");
    if (!section) return fail("Choose or type the section.");
    const body = { teacherId: Number(getTeacherId()), weekday: days[0], timeIn: data.get("timeIn"), timeOut: data.get("timeOut"), subject, section };
    const button = $('button[type="submit"]', form); button.disabled = true;
    try {
      if (editingId) {
        await api(`/api/schedule/${editingId}`, { method: "PUT", body });
        // Extra ticked days become additional classes with the same subject and time.
        if (days.length > 1) await api("/api/schedule", { method: "POST", body: { ...body, weekdays: days.slice(1) } });
      } else await api("/api/schedule", { method: "POST", body: { ...body, weekdays: days } });
      showToast(editingId ? "Class updated." : days.length > 1 ? `Class saved on ${days.length} days.` : "Class saved.");
      await load(); onChange?.();
    } catch (e) { fail(e.message); button.disabled = false; }
  });
  listHost.addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-entry]");
    if (edit) { editingId = Number(edit.dataset.editEntry); renderForm(); formHost.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    const del = event.target.closest("[data-delete-entry]");
    if (!del || !confirm("Remove this class from the schedule?")) return;
    try { await api(`/api/schedule/${del.dataset.deleteEntry}`, { method: "DELETE" }); showToast("Class removed."); await load(); onChange?.(); } catch (e) { setGlobalError(e.message); }
  });
  return { load };
}

const settingsEditor = createScheduleEditor({
  formHost: $("#settings-schedule-form-host"), listHost: $("#settings-schedule-list"),
  getTeacherId: () => currentUser?.id,
});

function weekGridMarkup(entries) {
  if (!entries.length) return emptyFeed("No classes have been added to this schedule yet.");
  const starts = entries.map((e) => minutesOf(e.timeIn)), ends = entries.map((e) => minutesOf(e.timeOut));
  const from = Math.floor(Math.min(...starts) / 60) * 60, to = Math.ceil(Math.max(...ends) / 60) * 60;
  const px = 1.15, height = (to - from) * px;
  const hue = (text) => [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const hours = []; for (let m = from; m < to; m += 60) hours.push(m);
  const labels = hours.map((m) => `<div class="wk-hour" style="top:${(m - from) * px}px">${to12h(`${Math.floor(m / 60)}:00`)}</div>`).join("");
  const columns = [1, 2, 3, 4, 5].map((day) => {
    const blocks = entries.filter((e) => e.weekday === day).map((e) => {
      const top = (minutesOf(e.timeIn) - from) * px, h = (minutesOf(e.timeOut) - minutesOf(e.timeIn)) * px - 2, hh = hue(e.subject);
      return `<div class="wk-block" style="top:${top}px;height:${h}px;background:hsl(${hh} 70% 94%);border-color:hsl(${hh} 55% 62%);color:hsl(${hh} 55% 24%)" title="${escapeHtml(`${e.subject} · ${e.section} · ${to12h(e.timeIn)}–${to12h(e.timeOut)}`)}"><strong>${escapeHtml(e.subject)}</strong><span>${escapeHtml(e.section)}</span><small>${to12h(e.timeIn)} – ${to12h(e.timeOut)}</small></div>`;
    }).join("");
    return `<div class="wk-col"><div class="wk-head">${WEEKDAY_SHORT[day]}</div><div class="wk-body" style="height:${height}px">${blocks}</div></div>`;
  }).join("");
  return `<div class="wk-grid"><div class="wk-col wk-times"><div class="wk-head">&nbsp;</div><div class="wk-body" style="height:${height}px">${labels}</div></div>${columns}</div>`;
}

let scheduleTeacherId = null;
let scheduleAdminEditor = null;
async function loadScheduleView() {
  const admin = isAdminUser();
  $("#schedule-teacher-bar").hidden = !admin;
  $("#schedule-admin-panel").hidden = !admin;
  $("#schedule-subtitle").textContent = admin
    ? "Pick a teacher to see their weekly timetable. It is built automatically from what the teacher saved in Settings."
    : "Your weekly timetable, generated from the classes you saved in Settings.";
  try {
    if (admin) {
      const select = $("#schedule-teacher");
      const teachers = (directory || []).filter((u) => u.role === "teacher");
      if (!scheduleTeacherId || !teachers.some((u) => String(u.id) === String(scheduleTeacherId))) scheduleTeacherId = teachers[0]?.id ?? null;
      select.innerHTML = teachers.map((u) => `<option value="${escapeHtml(u.id)}"${String(u.id) === String(scheduleTeacherId) ? " selected" : ""}>${escapeHtml(u.displayName)}</option>`).join("") || '<option value="">No teachers</option>';
      if (!scheduleAdminEditor) scheduleAdminEditor = createScheduleEditor({ formHost: $("#schedule-admin-form-host"), listHost: $("#schedule-admin-list"), getTeacherId: () => scheduleTeacherId, onChange: loadScheduleGrid });
      await scheduleAdminEditor.load();
    }
    await loadScheduleGrid();
  } catch (e) { setGlobalError(e.message); }
}
async function loadScheduleGrid() {
  const id = isAdminUser() ? scheduleTeacherId : currentUser.id;
  if (!id) { $("#schedule-grid").innerHTML = emptyFeed("No teachers yet."); return; }
  const { entries } = await api(`/api/schedule?teacherId=${encodeURIComponent(id)}`);
  $("#schedule-grid").innerHTML = weekGridMarkup(entries);
}
$("#schedule-teacher").addEventListener("change", async (event) => { scheduleTeacherId = event.target.value; try { await scheduleAdminEditor.load(); await loadScheduleGrid(); } catch (e) { setGlobalError(e.message); } });
registerView("schedule", ["Schedule", "Weekly class schedules of teachers."], { allowed: () => currentUser.role !== "student", onEnter: loadScheduleView });

registerView("settings", viewTitles.settings, {
  onEnter: async () => {
    fillProfileForm();
    const teacher = currentUser.role === "teacher";
    $("#settings-schedule-panel").hidden = !teacher;
    if (teacher) { try { await settingsEditor.load(); } catch (e) { setGlobalError(e.message); } }
  },
});

/* ====================== Announcements: "New announcement" pop-up ====================== */
let announcementPhotos = [];
const loadImage = (url) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("That image could not be read.")); img.src = url; });
const readAsDataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error(`Could not read ${file.name}.`)); r.readAsDataURL(file); });

// Shrinks big photos in the browser so a pubmat uploads fast and stays under the 3 MB limit.
async function compressImage(file) {
  const img = await loadImage(await readAsDataUrl(file));
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.88, 0.75, 0.6, 0.45]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length * 0.75 < 2.8 * 1024 * 1024) return { url, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" };
  }
  throw new Error(`${file.name} is too large even after shrinking. Please choose a smaller picture.`);
}

function renderPhotoPreview() {
  $("#announcement-photo-preview").innerHTML = announcementPhotos.map((p, i) => `<figure class="photo-thumb"><img src="${p.url}" alt="Selected photo ${i + 1}" /><button type="button" class="photo-remove" data-remove-photo="${i}" aria-label="Remove photo ${i + 1}">&times;</button></figure>`).join("");
}
$("#announcement-photos").addEventListener("change", async (event) => {
  const error = $("#announcement-form-error"); error.hidden = true;
  const files = [...event.target.files];
  event.target.value = "";
  try {
    for (const file of files) {
      if (announcementPhotos.length >= 4) throw new Error("You can attach up to 4 photos.");
      announcementPhotos.push(await compressImage(file));
    }
  } catch (e) { error.textContent = e.message; error.hidden = false; }
  renderPhotoPreview();
});
$("#announcement-photo-preview").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-photo]"); if (!button) return;
  announcementPhotos.splice(Number(button.dataset.removePhoto), 1); renderPhotoPreview();
});

function announcementExpiry() {
  const choice = $("#announcement-duration").value;
  if (choice === "custom") {
    const value = $("#announcement-until").value;
    if (!value) return null;
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 0);
  }
  return new Date(Date.now() + Number(choice.replace("d", "")) * 86400000);
}
function updateExpiryHint() {
  $("#announcement-until-wrap").hidden = $("#announcement-duration").value !== "custom";
  const end = announcementExpiry();
  $("#announcement-expiry-hint").textContent = end ? `Will be deleted automatically on ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(end)}.` : "Pick the last day it should be shown.";
}
$("#announcement-duration").addEventListener("change", updateExpiryHint);
$("#announcement-until").addEventListener("change", updateExpiryHint);

$("#announcement-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget, error = $("#announcement-form-error"); error.hidden = true;
  const end = announcementExpiry();
  if (!end || end.getTime() < Date.now() + 60000) { error.textContent = "Choose an end date in the future."; error.hidden = false; return; }
  const data = new FormData(form), button = $('button[type="submit"]', form); button.disabled = true;
  try {
    await api("/api/announcements", { method: "POST", body: { title: data.get("title"), body: data.get("body"), expiresAt: end.toISOString(), images: announcementPhotos.map((p) => ({ name: p.name, type: "image/jpeg", data: p.url.split(",")[1] })) } });
    form.reset(); announcementPhotos = []; renderPhotoPreview(); updateExpiryHint();
    showToast("Announcement published.");
    $("#announcement-dialog").close();
    goToView("announcements");
  } catch (e) { error.textContent = e.message; error.hidden = false; } finally { button.disabled = false; }
});
// "New announcement" is a pop-up on the Announcements page, not a separate tab.
function openAnnouncementDialog() {
  if (currentUser.role === "student") return;
  $("#announcement-form-error").hidden = true;
  updateExpiryHint();
  $("#announcement-dialog").showModal();
}
$("#go-new-announcement").addEventListener("click", openAnnouncementDialog);
$("#announcement-dialog-close").addEventListener("click", () => $("#announcement-dialog").close());

/* ====================== Memos ====================== */
let memos = [];
function renderMemos() {
  const query = $("#memo-search").value.trim().toLowerCase();
  const list = memos.filter((m) => `${m.title} ${m.description} ${m.uploader_name}`.toLowerCase().includes(query));
  $("#memo-count").textContent = `${list.length} of ${memos.length} memo${memos.length === 1 ? "" : "s"}`;
  $("#memo-list").innerHTML = list.length ? list.map((m) => `<article class="memo-item"><div class="memo-icon" aria-hidden="true">PDF</div><div class="memo-main"><h3>${escapeHtml(m.title)}</h3>${m.description ? `<p>${escapeHtml(m.description)}</p>` : ""}<small>${escapeHtml(m.uploader_name)} · ${escapeHtml(formatDate(m.created_at))} · ${fmtBytes(m.file_size)}</small></div><div class="row-actions"><button type="button" class="button button-secondary" data-view-file="/api/memos/${encodeURIComponent(m.id)}/file" data-view-title="${escapeHtml(m.title)}">View</button>${isAdminUser() ? `<button type="button" class="action-link danger-link" data-delete-memo="${escapeHtml(m.id)}">Delete</button>` : ""}</div></article>`).join("") : emptyFeed(memos.length ? "No memo matches your search." : "No memos have been uploaded yet.");
}
async function loadMemos() {
  $("#memo-compose-panel").hidden = !isAdminUser();
  try { memos = (await api("/api/memos")).memos; renderMemos(); } catch (e) { setGlobalError(e.message); }
}
$("#memo-search").addEventListener("input", renderMemos);
$("#memo-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-memo]"); if (!button || !confirm("Delete this memo for everyone?")) return;
  try { await api(`/api/memos/${encodeURIComponent(button.dataset.deleteMemo)}`, { method: "DELETE" }); await loadMemos(); showToast("Memo deleted."); } catch (e) { setGlobalError(e.message); }
});
$("#memo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#memo-file").files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type !== "application/pdf")) { setGlobalError("Memos must be PDF files."); return; }
  if (file.size > 8 * 1024 * 1024) { setGlobalError("Memo PDFs must be 8 MB or smaller."); return; }
  const button = $('button[type="submit"]', event.currentTarget); button.disabled = true; setGlobalError();
  try {
    await api("/api/memos", { method: "POST", body: { title: $("#memo-title").value, description: $("#memo-description").value, file: await fileToPayload(file) } });
    event.currentTarget.reset(); $("#memo-compose-details").open = false; await loadMemos(); showToast("Memo uploaded.");
  } catch (e) { setGlobalError(e.message); window.scrollTo({ top: 0, behavior: "smooth" }); } finally { button.disabled = false; }
});
registerView("memos", ["Memos", "Official memos from the school administration."], { onEnter: loadMemos });

/* ====================== Attendance ====================== */
const STATUS_LABEL = { present: "Present", leave: "On leave", travel: "On travel" };
let attendanceMe = null;      // { date, record, needsPrompt, leaveTypes }
let attendanceData = null;
let attendanceChoice = null;
let attendanceTimer = null;
let attendanceGuardTimer = null;

async function loadAttendanceMe() {
  if (currentUser?.role !== "teacher") return null;
  attendanceMe = await api("/api/attendance/me");
  return attendanceMe;
}

function openAttendanceDialog({ required }) {
  const dialog = $("#attendance-dialog");
  attendanceChoice = attendanceMe?.record?.status || null;
  const hour = new Date().getHours();
  $("#attendance-kicker").textContent = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("#attendance-title").textContent = required ? "Record your attendance" : "Update today's attendance";
  $("#attendance-intro").textContent = required ? "Tell us where you are today. You need to record your attendance before you can use the portal." : "Change what you reported for today.";
  $("#attendance-cancel").hidden = required;
  dialog.dataset.required = required ? "1" : "";
  $("#attendance-leave-type").innerHTML = '<option value="">Choose the type of leave</option>' + (attendanceMe?.leaveTypes || []).map((t) => `<option${attendanceMe?.record?.leaveType === t ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
  $("#attendance-details").value = attendanceMe?.record?.details || "";
  $("#attendance-error").hidden = true;
  syncAttendanceChoice();
  if (!dialog.open) dialog.showModal();
}
function syncAttendanceChoice() {
  document.querySelectorAll("[data-att-choice]").forEach((b) => { const on = b.dataset.attChoice === attendanceChoice; b.classList.toggle("is-selected", on); b.setAttribute("aria-checked", String(on)); });
  $("#attendance-leave-wrap").hidden = attendanceChoice !== "leave";
  $("#attendance-details-wrap").hidden = !["leave", "travel"].includes(attendanceChoice);
  $("#attendance-details-label").textContent = attendanceChoice === "travel" ? "Travel details (where and why)" : "Short details (required if the leave type is Other)";
  $("#attendance-details").required = attendanceChoice === "travel";
  $("#attendance-save").disabled = !attendanceChoice;
}
$("#attendance-dialog").addEventListener("click", (event) => { const b = event.target.closest("[data-att-choice]"); if (b) { attendanceChoice = b.dataset.attChoice; syncAttendanceChoice(); } });
// The first prompt of the day cannot be dismissed with Escape; the teacher has to choose.
$("#attendance-dialog").addEventListener("cancel", (event) => { if ($("#attendance-dialog").dataset.required) event.preventDefault(); });
$("#attendance-cancel").addEventListener("click", () => $("#attendance-dialog").close());
$("#attendance-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#attendance-error"); error.hidden = true;
  const body = { status: attendanceChoice, leaveType: $("#attendance-leave-type").value, details: $("#attendance-details").value };
  if (attendanceChoice === "leave" && !body.leaveType) { error.textContent = "Choose the type of leave."; error.hidden = false; return; }
  const button = $("#attendance-save"); button.disabled = true;
  try {
    await api("/api/attendance/me", { method: "POST", body });
    $("#attendance-dialog").dataset.required = ""; $("#attendance-dialog").close();
    await loadAttendanceMe(); showToast("Attendance saved.");
    if (currentView === "attendance") loadAttendance();
  } catch (e) { error.textContent = e.message; error.hidden = false; } finally { button.disabled = false; }
});

async function checkAttendancePrompt() {
  if (!currentUser || currentUser.role !== "teacher") return;
  const dialog = $("#attendance-dialog");
  if (dialog.open && dialog.dataset.required) return;
  try { await loadAttendanceMe(); } catch (_) { return; }
  if (attendanceMe?.needsPrompt) openAttendanceDialog({ required: true });
}
portalHooks.onLogin.push(async (user) => {
  if (user.role !== "teacher") return;
  await checkAttendancePrompt();
  // Attendance resets every midnight (school time): re-check while the portal stays open.
  clearInterval(attendanceGuardTimer);
  attendanceGuardTimer = setInterval(checkAttendancePrompt, 60000);
});
portalHooks.onLogout.push(() => { attendanceMe = null; attendanceData = null; clearInterval(attendanceTimer); clearInterval(attendanceGuardTimer); const d = $("#attendance-dialog"); d.dataset.required = ""; if (d.open) d.close(); });
// The required pop-up cannot be dismissed (Esc or otherwise) until attendance is saved.
$("#attendance-dialog").addEventListener("close", () => { if ($("#attendance-dialog").dataset.required && currentUser?.role === "teacher") setTimeout(() => openAttendanceDialog({ required: true }), 0); });

function attendanceRemark(t) {
  const r = t.record;
  if (!r) return "No record yet";
  if (r.status === "leave") return r.leaveType ? `${r.leaveType}${r.details ? ` · ${r.details}` : ""}` : "On leave";
  if (r.status === "travel") return r.details || "On travel";
  if (t.current?.state === "class") return `In class · ${t.current.entry.subject} (${t.current.entry.section})`;
  if (t.current?.state === "vacant") return "Present · Vacant";
  if (t.current?.state === "none") return "Present";
  return `Present · ${to12h(timeOfDay(r.loggedAt))}`;
}
function timeOfDay(iso) { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; }

function renderAttendance() {
  const data = attendanceData; if (!data) return;
  const tally = { present: 0, leave: 0, travel: 0, none: 0 };
  data.teachers.forEach((t) => { tally[t.record?.status || "none"]++; });
  $("#attendance-totals").innerHTML = [["Present", tally.present, "green"], ["On leave", tally.leave, "red"], ["On travel", tally.travel, "blue"], ["No record", tally.none, "amber"]]
    .map(([label, value, tone]) => `<div class="stat-card overview-stat" data-tone="${tone}"><span class="stat-label"><i class="stat-marker"></i>${label}</span><span class="stat-value">${value}</span></div>`).join("");
  const entries = data.teachers.map((t) => ({ ...t, group: lpTeacherGroup(t.id, t.name) }));
  $("#attendance-list").innerHTML = data.teachers.length
    ? lpGroupedMarkup(entries, (t) => `<button type="button" class="att-card att-card-${t.record?.status || "none"}" data-att-teacher="${escapeHtml(t.id)}"><i class="att-dot att-${t.record?.status || "none"}"></i><span class="att-card-main"><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(attendanceRemark(t))}</small></span></button>`)
    : emptyFeed("There are no active teacher accounts yet.");
  // Group cards sit side by side: wrap each group's cards in a grid.
  $("#attendance-list").querySelectorAll(".teacher-group").forEach((g) => {
    const cards = [...g.querySelectorAll(":scope > .att-card")];
    const grid = document.createElement("div"); grid.className = "att-grid"; cards.forEach((c) => grid.appendChild(c)); g.appendChild(grid);
  });
}

function renderAttendanceMe() {
  const host = $("#attendance-me");
  if (currentUser.role !== "teacher" || !attendanceMe || !attendanceData?.isToday) { host.hidden = true; return; }
  const r = attendanceMe.record;
  host.hidden = false;
  host.innerHTML = `<div class="att-me"><i class="att-dot att-${r?.status || "none"}"></i><div><strong>Your status today: ${r ? STATUS_LABEL[r.status] : "not recorded yet"}</strong><small>${r ? escapeHtml([r.leaveType, r.details].filter(Boolean).join(" · ") || "") : "Choose a status so the school knows where you are."}</small></div><button type="button" class="button button-secondary" id="attendance-update">${r ? "Update" : "Record now"}</button></div>`;
}

async function loadAttendance() {
  const input = $("#attendance-date");
  try {
    if (currentUser.role === "teacher") await loadAttendanceMe();
    attendanceData = await api(`/api/attendance${input.value ? `?date=${encodeURIComponent(input.value)}` : ""}`);
    if (!input.value) input.value = attendanceData.date;
    renderAttendanceMe(); renderAttendance();
  } catch (e) { setGlobalError(e.message); }
}
$("#attendance-date").addEventListener("change", loadAttendance);
$("#attendance-today").addEventListener("click", () => { $("#attendance-date").value = ""; loadAttendance(); });
$("#attendance-me").addEventListener("click", (event) => { if (event.target.closest("#attendance-update")) openAttendanceDialog({ required: false }); });

function showAttendanceDetail(teacher) {
  const r = teacher.record, data = attendanceData;
  $("#attendance-detail-kicker").textContent = `${WEEKDAY_NAMES[data.weekday] || ""} · ${data.date}`;
  $("#attendance-detail-title").textContent = teacher.name;
  const status = r?.status || "none";
  const label = r ? STATUS_LABEL[r.status] : "No record yet";
  let body = `<div class="att-detail-status att-card-${status}"><i class="att-dot att-${status}"></i><strong>${label}</strong></div>`;
  if (r) {
    body += `<p class="lp-meta">Reported at ${to12h(timeOfDay(r.loggedAt))}</p>`;
    if (r.status === "leave") body += `<p><strong>Leave type:</strong> ${escapeHtml(r.leaveType || "Not shown")}</p>`;
    if (r.details) body += `<p><strong>${r.status === "travel" ? "Travel details" : "Details"}:</strong> ${escapeHtml(r.details)}</p>`;
    if (r.status !== "present" && !r.leaveType && !r.details) body += '<p class="lp-note">Details are visible only to administrators.</p>';
  }
  if (r?.status === "present") {
    if (teacher.current?.state === "class") body += `<div class="att-now att-now-class"><small>Right now</small><strong>In class</strong><span>${escapeHtml(teacher.current.entry.subject)} · ${escapeHtml(teacher.current.entry.section)}</span><span>${to12h(teacher.current.entry.timeIn)} – ${to12h(teacher.current.entry.timeOut)}</span></div>`;
    else if (teacher.current?.state === "vacant") body += '<div class="att-now att-now-vacant"><small>Right now</small><strong>Vacant</strong><span>No class at this time.</span></div>';
    else if (teacher.current?.state === "none") body += '<p class="lp-note">No classes on weekends.</p>';
  }
  if (r?.status === "present" || !r) {
    body += `<h4 class="att-sched-title">Schedule for ${WEEKDAY_NAMES[data.weekday] || "this day"}</h4>`;
    body += teacher.schedule.length ? `<ul class="att-sched">${teacher.schedule.map((e) => { const now = teacher.current?.state === "class" && teacher.current.entry.id === e.id; return `<li class="${now ? "is-now" : ""}"><span>${to12h(e.timeIn)} – ${to12h(e.timeOut)}</span><span>${escapeHtml(e.subject)} · ${escapeHtml(e.section)}</span></li>`; }).join("")}</ul>` : '<p class="lp-note">No classes saved for this day.</p>';
  }
  $("#attendance-detail-body").innerHTML = body;
  $("#attendance-detail").showModal();
}
$("#attendance-list").addEventListener("click", (event) => {
  const card = event.target.closest("[data-att-teacher]"); if (!card) return;
  const teacher = attendanceData?.teachers.find((t) => String(t.id) === card.dataset.attTeacher);
  if (teacher) showAttendanceDetail(teacher);
});
$("#attendance-detail-close").addEventListener("click", () => $("#attendance-detail").close());
$("#attendance-detail").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });

registerView("attendance", ["Attendance", "Who is in school today."], {
  allowed: () => currentUser.role !== "student",
  onEnter: () => {
    $("#attendance-date").value = "";
    loadAttendance();
    clearInterval(attendanceTimer);
    // Keep "in class / vacant" fresh while the page is open.
    attendanceTimer = setInterval(() => { if (currentView === "attendance" && attendanceData?.isToday && !document.querySelector("dialog[open]")) loadAttendance(); }, 60000);
  },
});
