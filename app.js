(() => {
  const state = {
    user: null,
    view: "overview",
    dashboard: null,
    students: [],
    accounts: [],
    events: [],
    structure: { departments: [], strands: [], grades: [], sections: [], settings: {} },
    attendance: [],
    formOpen: false,
    studentSearch: "",
    attendanceSearch: "",
    bulkResult: null,
    editStudent: null,
    editAccount: null,
    editEvent: null,
    editStructure: null,
    eventAttendanceId: "",
    eventAttendance: [],
    messageTarget: "",
    announcementEdit: null,
    helpMessages: [{ role: "assistant", body: "Welcome. I can point you to the attendance, events, account, and support tools in this portal." }],
    qrStudent: null,
    scannerStream: null,
    scannerTimer: null
  };
  const views = [
    { id: "overview", label: "Overview", icon: "⌂", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "attendance", label: "Attendance", icon: "◷", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "students", label: "Students", icon: "♙", roles: ["Admin", "Teacher", "SSG"] },
    { id: "events", label: "Events", icon: "▦", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "gallery", label: "Photo gallery", icon: "▧", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "community", label: "Community", icon: "✉", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "profile", label: "My profile", icon: "◉", roles: ["Admin", "Teacher", "SSG", "Student"] },
    { id: "accounts", label: "Staff accounts", icon: "♧", roles: ["Admin"] },
    { id: "structure", label: "School structure", icon: "⌘", roles: ["Admin"] },
    { id: "reports", label: "Reports", icon: "▤", roles: ["Admin", "Teacher", "SSG"] },
    { id: "settings", label: "Settings", icon: "⚙", roles: ["Admin", "Teacher", "SSG", "Student"] }
  ];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const localDate = () => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  const formatDate = (value, options = { month: "short", day: "numeric", year: "numeric" }) => {
    if (!value) return "—";
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    return Number.isNaN(date.getTime()) ? html(value) : date.toLocaleDateString(undefined, options);
  };
  const formatTime = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  const initials = (name) => String(name || "S").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  const notify = (message) => {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(notify.timeout);
    notify.timeout = window.setTimeout(() => toast.classList.remove("visible"), 3300);
  };
  function campusHelpReply(question) {
    const text = question.toLocaleLowerCase();
    if (text.includes("attendance") || text.includes("check in") || text.includes("check-in") || text.includes("qr")) {
      return "Open Attendance. Students can use Time in or show their assigned QR code; authorized staff can scan a student QR. Attendance history is retained, and the morning session closes at the schedule shown on that page.";
    }
    if (text.includes("event") || text.includes("gallery") || text.includes("announcement")) {
      return "Open Events to browse published activities and event details. The Photo gallery shows published event posters. School notices are in Community.";
    }
    if (text.includes("password") || text.includes("reset") || text.includes("login")) {
      return state.user?.role === "Student"
        ? "Use My profile or Account & session settings to change your password. If you cannot sign in, use the student reset link on the login page with your student ID and date of birth."
        : "Open My profile to update your display name, or Account & session settings to change your password.";
    }
    if (text.includes("support") || text.includes("concern") || text.includes("help")) {
      return "Open Community. Students can submit a private support concern; administrators and staff only see concerns in their authorized scope. You can also send a message to an authorized contact there.";
    }
    if (text.includes("student") || text.includes("teacher") || text.includes("account") || text.includes("section")) {
      return "Student and staff access is role-based. Administrators manage accounts and school structure; teachers and SSG accounts only see their assigned scope. Contact your administrator if your class or access is incorrect.";
    }
    return "I can help with attendance, QR check-in, events, passwords, accounts, and student support. For a question that needs staff review, use Community to contact an authorized school account.";
  }
  function renderHelpThread() {
    const thread = $("#help-thread");
    if (!thread) return;
    thread.innerHTML = state.helpMessages.map((message) =>
      `<p class="help-message ${message.role}">${html(message.body)}</p>`).join("");
    thread.scrollTop = thread.scrollHeight;
  }
  function submitHelpQuestion(question) {
    const trimmed = String(question || "").trim();
    if (!trimmed) return;
    state.helpMessages.push({ role: "user", body: trimmed }, { role: "assistant", body: campusHelpReply(trimmed) });
    renderHelpThread();
  }
  async function refreshNotificationBadge() {
    const result = await api("/api/notifications");
    const badge = $("#notifications-count");
    badge.textContent = result.unreadCount ? String(result.unreadCount) : "";
    badge.hidden = !result.unreadCount;
    return result;
  }
  async function openNotifications() {
    try {
      const result = await refreshNotificationBadge();
      $("#notifications-content").innerHTML = `${result.unreadMessages ? `<section class="notification-item"><strong>${result.unreadMessages} unread message${result.unreadMessages === 1 ? "" : "s"}</strong><p>Open your inbox to read private messages from authorized contacts.</p><button class="button outline" type="button" data-view="community" data-close-dialog="notifications-dialog">Open inbox</button></section>` : ""}
        <h3>Unread announcements</h3>${result.announcements.map((announcement) => `<article class="notification-item"><strong>${html(announcement.title)}</strong><small>${html(formatDate(announcement.createdAt))}</small><p>${html(announcement.body)}</p></article>`).join("") || `<div class="empty-state">You’re all caught up.</div>`}
        ${result.announcements.length ? `<button class="button primary" type="button" data-action="mark-notifications-read">Mark announcements as read</button>` : ""}`;
      $("#notifications-dialog").showModal();
    } catch (error) { notify(error.message); }
  }
  function showCredential(title, password) {
    $("#credential-title").textContent = title;
    $("#credential-value").value = password;
    $("#credential-status").textContent = "";
    $("#credential-dialog").showModal();
    $("#credential-value").select();
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.user && !url.endsWith("/auth/login")) {
        await signOut(false);
      }
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return payload;
  }

  function showLogin() {
    $("#login-screen").hidden = false;
    $("#app-screen").hidden = true;
    document.body.classList.remove("dark-mode");
  }

  async function signOut(announce = true) {
    stopScanner();
    try { await api("/api/auth/logout", { method: "POST" }); } catch { /* The server session may already have expired. */ }
    state.user = null;
    state.dashboard = null;
    state.bulkResult = null;
    state.messageTarget = "";
    state.announcementEdit = null;
    state.helpMessages = [{ role: "assistant", body: "Welcome. I can point you to the attendance, events, account, and support tools in this portal." }];
    window.clearTimeout(state.expiryTimer);
    showLogin();
    if (announce) notify("You have been signed out.");
  }

  function scheduleSessionExpiry(expiresAt) {
    window.clearTimeout(state.expiryTimer);
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      void signOut(false);
      notify("Your authorized session has expired. Please sign in again.");
      return;
    }
    state.expiryTimer = window.setTimeout(() => {
      void signOut(false);
      notify("Your authorized session has expired. Please sign in again.");
    }, remaining);
  }

  function startApp(user, expiresAt) {
    state.user = { ...user, expires_at: expiresAt };
    state.view = "overview";
    state.formOpen = false;
    state.studentSearch = "";
    state.bulkResult = null;
    state.messageTarget = "";
    state.announcementEdit = null;
    state.helpMessages = [{ role: "assistant", body: "Welcome. I can point you to the attendance, events, account, and support tools in this portal." }];
    $("#login-screen").hidden = true;
    $("#app-screen").hidden = false;
    $("#user-name").textContent = user.name;
    $("#user-role").textContent = user.role;
    $("#user-avatar").textContent = initials(user.name);
    $("#today-label").textContent = new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (localStorage.getItem("sti-theme") === "dark") document.body.classList.add("dark-mode");
    scheduleSessionExpiry(expiresAt);
    renderNavigation();
    void refreshNotificationBadge().catch((error) => console.error(error));
    void getStructure().then(() => loadView()).catch((error) => {
      $("#view-container").innerHTML = `<section class="panel empty-state">${html(error.message)}</section>`;
    });
  }

  function renderNavigation() {
    const allowed = views.filter((view) => view.roles.includes(state.user.role));
    $("#navigation").innerHTML = allowed.map((view) =>
      `<button type="button" class="${state.view === view.id ? "active" : ""}" data-view="${view.id}" aria-current="${state.view === view.id ? "page" : "false"}"><span class="nav-ico" aria-hidden="true">${view.icon}</span>${view.label}</button>`
    ).join("");
  }

  function setView(view) {
    if (!views.some((entry) => entry.id === view && entry.roles.includes(state.user.role))) return;
    state.view = view;
    state.formOpen = false;
    state.editStudent = null;
    state.qrStudent = null;
    renderNavigation();
    void loadView();
  }

  async function loadView() {
    if (!state.user) return;
    const titles = Object.fromEntries(views.map(({ id, label }) => [id, label]));
    $("#page-title").textContent = titles[state.view] || "Overview";
    $("#view-container").innerHTML = `<div class="empty-state">Loading your campus information…</div>`;
    try {
      if (state.view === "overview") return await renderOverview();
      if (state.view === "attendance") return await renderAttendance();
      if (state.view === "students") return await renderStudents();
      if (state.view === "events") return await renderEvents();
      if (state.view === "gallery") return await renderGallery();
      if (state.view === "community") return await renderCommunity();
      if (state.view === "profile") return await renderProfile();
      if (state.view === "accounts") return await renderAccounts();
      if (state.view === "structure") return await renderStructure();
      if (state.view === "reports") return await renderReports();
      if (state.view === "settings") return await renderSettings();
    } catch (error) {
      $("#view-container").innerHTML = `<section class="panel empty-state">${html(error.message)}</section>`;
    }
  }

  async function getStructure() {
    state.structure = await api("/api/structure");
    return state.structure;
  }

  async function renderOverview() {
    const data = await api("/api/dashboard");
    state.dashboard = data;
    const present = data.totals.Present + data.totals.Late;
    const absent = Math.max(0, data.students - present);
    const personalRecord = state.user.role === "Student" ? data.attendance.find((record) => record.date === data.date) : null;
    const attendanceRows = data.attendance.map((record) => `<tr>
      <td><div class="student-cell"><span class="avatar">${html(initials(record.name))}</span><span><strong>${html(record.name)}</strong><small>${html(record.section || "Section not set")}</small></span></div></td>
      <td>${html(record.date ? formatDate(record.date) : "")}</td><td>${html(record.session || "")}</td>
      <td><span class="badge ${record.status.toLowerCase()}">${html(record.status)}</span></td><td>${html(formatTime(record.timeIn))}</td>
    </tr>`).join("");
    const eventRows = data.events.map(eventRow).join("");
    const quickActions = state.user.role === "Student"
      ? [["attendance", "My attendance"], ["events", "Browse events"], ["community", "Student support"], ["profile", "My profile"]]
      : [["attendance", "Record attendance"], ["students", "Student roster"], ["events", "Manage events"], ["community", "Community inbox"]];
    $("#view-container").innerHTML = `
      <section class="welcome-card"><div><p class="eyebrow">STI ATTENDANCE MANAGEMENT SYSTEM</p><h2>Welcome back, ${html(state.user.name.split(" ")[0])}.</h2><p>${state.user.role === "Student" ? "Here’s your personal campus update for today." : "Your campus overview is ready. Here’s what’s happening today."}</p></div><img class="welcome-mark" src="assets/sti-logo.jpg" alt="STI College"></section>
      ${state.user.role === "Student" ? `
        <div class="stat-grid">
          <article class="stat-card"><div class="stat-top"><span>Today's attendance</span><span class="stat-icon">◷</span></div><strong>${personalRecord ? html(personalRecord.status) : "Not yet marked"}</strong><small>${personalRecord ? `Checked in at ${html(formatTime(personalRecord.timeIn))}` : "Your attendance will appear here"}</small></article>
          <article class="stat-card"><div class="stat-top"><span>Department</span><span class="stat-icon">⌂</span></div><strong>${html(state.user.department || "—")}</strong><small>${html([state.user.strand, state.user.grade, state.user.section].filter(Boolean).join(" · ") || "Class details")}</small></article>
          <article class="stat-card"><div class="stat-top"><span>Upcoming events</span><span class="stat-icon">▦</span></div><strong>${data.events.length}</strong><small>Published campus events</small></article>
          <article class="stat-card"><div class="stat-top"><span>Morning session closes</span><span class="stat-icon">◷</span></div><strong>${html(state.structure.settings?.morningClose || "13:00")}</strong><small>Afternoon attendance opens automatically</small></article>
        </div>` : `
        <div class="stat-grid">
          <article class="stat-card"><div class="stat-top"><span>Registered students</span><span class="stat-icon">♙</span></div><strong>${data.students}</strong><small>Active student accounts</small></article>
          <article class="stat-card"><div class="stat-top"><span>Present</span><span class="stat-icon">✓</span></div><strong>${present}</strong><small>Present or late today</small></article>
          <article class="stat-card"><div class="stat-top"><span>Not yet present</span><span class="stat-icon">◷</span></div><strong>${absent}</strong><small>Calculated from active roster</small></article>
          <article class="stat-card"><div class="stat-top"><span>Attendance rate</span><span class="stat-icon">⌁</span></div><strong>${data.percentage}%</strong><small>Today’s campus attendance</small></article>
        </div>`}
      <div class="content-grid">
        <section class="panel"><div class="panel-heading"><div><h2>${state.user.role === "Student" ? "My recent attendance" : "Recent attendance activity"}</h2><p>Live campus records · ${html(formatDate(data.date))}</p></div><button class="button outline" type="button" data-view="attendance">View attendance</button></div>
          ${attendanceRows ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Date</th><th>Session</th><th>Status</th><th>Time in</th></tr></thead><tbody>${attendanceRows}</tbody></table></div>` : `<div class="empty-state">No attendance records have been recorded yet.</div>`}
        </section>
        <section class="panel"><div class="panel-heading"><div><h2>Upcoming school events</h2><p>School announcements and activities</p></div><button class="button outline" type="button" data-view="events">All events</button></div>
          <div class="event-list">${eventRows || `<div class="empty-state">No published events yet.</div>`}</div>
        </section>
      </div>${state.user.role === "Student" ? "" : `<div class="content-grid dashboard-breakdowns">${breakdownPanel("Department attendance", data.departmentOverview)}${breakdownPanel("Strand attendance", data.strandOverview)}${breakdownPanel("Section attendance grid", data.sectionOverview)}</div>`}
      <section class="panel quick-actions-panel"><div class="panel-heading"><div><h2>Quick actions</h2><p>Jump directly to common campus tasks</p></div><button class="button outline" type="button" data-action="campus-help">Campus help</button></div><div class="quick-action-grid">${quickActions.map(([view, label]) => `<button class="button outline" type="button" data-view="${view}">${html(label)} <span aria-hidden="true">→</span></button>`).join("")}</div></section>`;
  }

  function breakdownPanel(title, entries) {
    const data = entries || [];
    return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2><p>Attendance by group</p></div></div>${data.map((entry) => {
      const percent = entry.total ? Math.round(entry.present / entry.total * 100) : 0;
      return `<div class="breakdown-row"><div><strong>${html(entry.name)}</strong><span>${entry.present} / ${entry.total}</span></div><div class="breakdown-track"><span style="width:${percent}%"></span></div></div>`;
    }).join("") || `<div class="empty-state">No groups configured.</div>`}</section>`;
  }

  function eventRow(event) {
    const date = new Date(event.startAt);
    const month = Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { month: "short" });
    const day = Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { day: "numeric" });
    return `<article class="event-row"><div class="event-date-box"><b>${html(day)}</b><small>${html(month)}</small></div><div><h3>${html(event.title)}</h3><p>${html(formatDate(event.startAt))} · ${html(event.location || "Campus")}</p>${event.leaderName ? `<p class="event-leader">Event leader: ${html(event.leaderName)}</p>` : ""}</div></article>`;
  }

  async function renderAttendance() {
    const today = localDate();
    const isStudent = state.user.role === "Student";
    const selectedDate = $("#view-container [name=attendanceDate]")?.value || today;
    const structure = state.structure.departments.length ? state.structure : await getStructure();
    const activeSession = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) < (structure.settings.morningClose || "13:00") ? "Morning" : "Afternoon";
    const selectedSession = $("#view-container [name=attendanceSession]")?.value ?? activeSession;
    const searchText = $("#view-container [name=attendanceSearch]")?.value ?? state.attendanceSearch;
    const [result, summary] = await Promise.all([
      api(`/api/attendance?date=${encodeURIComponent(selectedDate)}&session=${encodeURIComponent(selectedSession)}`),
      api("/api/dashboard")
    ]);
    state.attendance = result.records;
    const records = result.records;
    const rows = records.map((record) => `<tr>
      <td><div class="student-cell"><span class="avatar">${html(initials(record.name))}</span><span><strong>${html(record.name)}</strong><small>${html(record.schoolId || record.studentId || "")}</small></span></div></td>
      <td>${html(record.department || "—")}</td><td>${html(record.strand || "—")} ${html(record.grade || "")} · ${html(record.section || "—")}</td>
      <td><span class="badge ${String(record.status || "Absent").toLowerCase()}">${html(record.status || "Absent")}</span></td>
      <td>${html(formatTime(record.timeIn))}</td>
      <td>${record.id ? `<button class="button outline" type="button" data-timeout="${html(record.id)}" ${record.timeOut ? "disabled" : ""}>${record.timeOut ? `Out ${html(formatTime(record.timeOut))}` : "Time out"}</button>` : "—"}</td>
      ${state.user.role === "Admin" || state.user.role === "Teacher" ? `<td><select class="status-select" data-status-record="${html(record.id || "")}" data-status-student="${html(record.studentId)}" data-status-date="${html(selectedDate)}" data-status-session="${html(record.session || selectedSession)}" aria-label="Attendance status for ${html(record.name)}"><option ${record.status === "Present" ? "selected" : ""}>Present</option><option ${record.status === "Late" ? "selected" : ""}>Late</option><option ${record.status === "Absent" ? "selected" : ""}>Absent</option></select></td>` : ""}
    </tr>`).join("");
    const toolbar = isStudent ? "" : `<div class="toolbar">
      <label>Attendance date<input name="attendanceDate" type="date" value="${html(selectedDate)}"></label>
      <label>Session<select name="attendanceSession"><option ${selectedSession === "Morning" ? "selected" : ""}>Morning</option><option ${selectedSession === "Afternoon" ? "selected" : ""}>Afternoon</option><option value="" ${selectedSession === "" ? "selected" : ""}>All recorded sessions</option></select></label>
      <label class="grow">Search roster<input class="filter-input search-box" name="attendanceSearch" type="search" placeholder="Student name or ID"></label>
      <button class="button primary" type="button" data-action="scan-attendance">Scan QR</button>
    </div>`;
    const ownToday = records.find((record) => record.date === today && record.session === selectedSession);
    $("#view-container").innerHTML = `
      <section class="attendance-hero"><div><strong>${isStudent ? "Your attendance history" : `${summary.students} students · ${records.length} ${records.length === 1 ? "record" : "records"} in this view`}</strong><br><span>Morning closes at ${html(structure.settings.morningClose || "13:00")} · Afternoon follows automatically · History is retained</span></div>${isStudent ? `<div class="event-card-actions"><button class="button outline" type="button" data-action="my-qr">Show my QR</button><button class="button primary" type="button" data-action="${ownToday ? "time-out" : "student-time-in"}" ${ownToday && (ownToday.status === "Absent" || ownToday.timeOut) ? "disabled" : ""}>${ownToday ? ownToday.status === "Absent" ? "Marked absent" : ownToday.timeOut ? "Session complete" : "Time out" : "Time in now"}</button></div>` : ""}</section>
      ${toolbar}
      <section class="panel"><div class="panel-heading"><div><h2>Section attendance grid</h2><p>Present, late, and absent status by student</p></div><button class="button outline" type="button" data-action="export-attendance">Export CSV</button></div>
        ${rows ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Department</th><th>Strand · Grade · Section</th><th>Status</th><th>Time in</th><th>Time out</th>${state.user.role === "Admin" || state.user.role === "Teacher" ? "<th>Update status</th>" : ""}</tr></thead><tbody id="attendance-rows">${rows}</tbody></table></div>` : `<div class="empty-state">No students are registered in this view.</div>`}
      </section>`;
    $("#view-container [name=attendanceDate]")?.addEventListener("change", () => void renderAttendance());
    $("#view-container [name=attendanceSession]")?.addEventListener("change", () => void renderAttendance());
    const searchInput = $("#view-container [name=attendanceSearch]");
    if (searchInput) {
      searchInput.value = searchText;
      const filterAttendanceRows = () => {
        const query = searchInput.value.toLocaleLowerCase().trim();
        $$("#attendance-rows tr").forEach((row) => { row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
      };
      filterAttendanceRows();
      searchInput.addEventListener("input", () => {
        state.attendanceSearch = searchInput.value;
        filterAttendanceRows();
      });
    }
  }

  function structureOptions(type, selected = "") {
    const values = state.structure[type] || [];
    return `<option value="">Choose…</option>${values.map((entry) => `<option value="${html(entry.name)}" ${entry.name === selected ? "selected" : ""}>${html(entry.name)}</option>`).join("")}`;
  }

  async function renderStudents() {
    const [result] = await Promise.all([
      api(`/api/students?search=${encodeURIComponent(state.studentSearch)}`),
      state.structure.departments.length ? Promise.resolve() : getStructure()
    ]);
    state.students = result.students;
    const form = state.formOpen ? studentForm(state.editStudent) : "";
    const qr = state.qrStudent ? `<section class="panel qr-panel"><div class="panel-heading"><div><h2>Attendance QR · ${html(state.qrStudent.name)}</h2><p>Assigned QR credential for attendance check-in</p></div><button class="icon-close" type="button" data-action="close-qr">×</button></div><img class="qr-preview" src="${html(state.qrStudent.dataUrl)}" alt="Assigned attendance QR code for ${html(state.qrStudent.name)}"><p class="helper">${html(state.qrStudent.studentId)} · Keep this code private.</p></section>` : "";
    const bulkResult = state.bulkResult ? `<section class="panel bulk-result"><div class="panel-heading"><div><h2>Roster import result</h2><p>${state.bulkResult.created.length} account(s) created · ${state.bulkResult.rejected.length} row(s) need attention</p></div><div class="event-card-actions"><button class="button outline" type="button" data-action="download-bulk-credentials">Download credentials</button><button class="icon-close" type="button" data-action="clear-bulk-result" aria-label="Clear import credentials">×</button></div></div><p class="helper">Temporary passwords are displayed only for this session. Deliver them privately and ask each student to change their password.</p>${state.bulkResult.created.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Student ID</th><th>Temporary password</th></tr></thead><tbody>${state.bulkResult.created.map((student) => `<tr><td>${html(student.name)}</td><td>${html(student.studentId)}</td><td><code>${html(student.initialPassword)}</code></td></tr>`).join("")}</tbody></table></div>` : ""}${state.bulkResult.rejected.length ? `<ul>${state.bulkResult.rejected.map((item) => `<li>Row ${item.row} · ${html(item.studentId)}: ${html(item.error)}</li>`).join("")}</ul>` : ""}</section>` : "";
    const rows = state.students.map((student) => `<tr>
      <td><div class="student-cell"><span class="avatar">${html(initials(student.name))}</span><span><strong>${html(student.name)}</strong><small>${html(student.studentId)}</small></span></div></td>
      <td>${html(student.department || "—")}</td><td>${html(student.strand || "—")}</td><td>${html(student.grade || "—")}</td><td>${html(student.section || "—")}</td><td><span class="badge ${student.isActive ? "" : "disabled"}">${student.isActive ? "Active" : "Disabled"}</span></td>
      <td><div class="event-card-actions"><button class="button outline" type="button" data-qr="${html(student.id)}">QR</button>${state.user.role === "Admin" ? `<button class="button outline" type="button" data-edit-student="${html(student.id)}">Edit</button><button class="button outline" type="button" data-toggle-student="${html(student.id)}" data-active="${student.isActive ? "true" : "false"}">${student.isActive ? "Disable" : "Enable"}</button><button class="button outline" type="button" data-reset-student="${html(student.id)}">Reset password</button>` : ""}</div></td>
    </tr>`).join("");
    $("#view-container").innerHTML = `
      <div class="panel-heading"><div><h2>${state.user.role === "Student" ? "Students" : "Registered students"}</h2><p>${state.students.length} student${state.students.length === 1 ? "" : "s"} in your authorized roster</p></div>${state.user.role === "Admin" ? `<div class="event-card-actions"><button class="button outline" type="button" data-action="download-roster-template">CSV template</button><button class="button outline" type="button" data-action="upload-roster">Import CSV</button><input id="bulk-student-file" type="file" accept=".csv,text/csv" hidden><button class="button primary" type="button" data-action="toggle-form">${state.formOpen ? "Close form" : "＋ Register student"}</button></div>` : ""}</div>
      ${form}${qr}${bulkResult}
      <section class="panel"><div class="toolbar"><label class="grow">Search by student name, ID, or section<input class="filter-input search-box" id="student-search" type="search" value="${html(state.studentSearch)}" placeholder="Start typing to filter"></label><label>Grade<select id="student-grade-filter"><option value="">All grades</option>${state.structure.grades.map((grade) => `<option>${html(grade.name)}</option>`).join("")}</select></label><label>Strand<select id="student-strand-filter"><option value="">All strands</option>${state.structure.strands.map((strand) => `<option>${html(strand.name)}</option>`).join("")}</select></label></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Department</th><th>Strand</th><th>Grade</th><th>Section</th><th>Account</th><th>Actions</th></tr></thead><tbody id="students-rows">${rows}</tbody></table></div>` : `<div class="empty-state">No students match this search.</div>`}</section>`;
    $("#student-search")?.addEventListener("input", (event) => {
      state.studentSearch = event.target.value;
      const query = state.studentSearch.toLocaleLowerCase().trim();
      $$("#students-rows tr").forEach((row) => { row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
    });
    $("#student-grade-filter")?.addEventListener("change", (event) => {
      $$("#students-rows tr").forEach((row) => { row.hidden = (event.target.value && !row.children[3].textContent.includes(event.target.value)) || (state.studentSearch && !row.textContent.toLocaleLowerCase().includes(state.studentSearch.toLocaleLowerCase())); });
    });
    $("#student-strand-filter")?.addEventListener("change", (event) => {
      $$("#students-rows tr").forEach((row) => { row.hidden = (event.target.value && !row.children[2].textContent.includes(event.target.value)) || (state.studentSearch && !row.textContent.toLocaleLowerCase().includes(state.studentSearch.toLocaleLowerCase())); });
    });
    $("#student-form")?.addEventListener("submit", handleStudentSubmit);
    $("#bulk-student-file")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const students = parseStudentCsv(await file.text());
        if (!students.length || students.length > 100) throw new Error("CSV must contain between 1 and 100 student rows.");
        state.bulkResult = await api("/api/students/bulk", { method: "POST", body: JSON.stringify({ students }) });
        await renderStudents();
        notify(`Roster import finished: ${state.bulkResult.created.length} created, ${state.bulkResult.rejected.length} rejected.`);
      } catch (error) {
        notify(error.message);
      } finally {
        event.target.value = "";
      }
    });
  }

  function studentForm(student) {
    const editing = Boolean(student);
    return `<form id="student-form" class="inline-form"><h3>${editing ? "Update student record" : "Register student account"}</h3><div class="form-grid">
      <label>Full name<input name="name" required maxlength="120" value="${html(student?.name || "")}"></label>
      <label>Student ID<input name="studentId" required maxlength="50" value="${html(student?.studentId || "")}" ${editing ? "readonly" : ""}></label>
      <label>Date of birth<input name="dateOfBirth" type="date" value="${html(student?.dateOfBirth || "")}"></label>
      <label>Department<select name="department">${structureOptions("departments", student?.department)}</select></label>
      <label>Strand<select name="strand">${structureOptions("strands", student?.strand)}</select></label>
      <label>Grade level<select name="grade">${structureOptions("grades", student?.grade)}</select></label>
      <label>Section<select name="section">${structureOptions("sections", student?.section)}</select></label>
      ${editing ? "" : `<label>Initial password (optional)<input name="password" type="password" minlength="10" autocomplete="new-password" placeholder="Blank generates a temporary password"></label>`}
      <div class="form-actions"><button class="button outline" type="button" data-action="toggle-form">Cancel</button><button class="button primary" type="submit">${editing ? "Save changes" : "Create account"}</button></div>
      <p class="helper full">New accounts receive a private QR code and are stored in the campus database.</p>
    </div></form>`;
  }

  async function handleStudentSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const status = $(".form-status", form);
    try {
      if (state.editStudent) {
        await api(`/api/students/${encodeURIComponent(state.editStudent.id)}`, { method: "PATCH", body: JSON.stringify({ ...values, isActive: Boolean(state.editStudent.isActive) }) });
        notify("Student account updated.");
      } else {
        const result = await api("/api/students", { method: "POST", body: JSON.stringify(values) });
        showCredential(`Initial password · ${values.name}`, result.initialPassword);
      }
      state.formOpen = false;
      state.editStudent = null;
      await renderStudents();
    } catch (error) { status.textContent = error.message; }
  }

  async function renderEvents() {
    const [result] = await Promise.all([
      api("/api/events"),
      state.structure.departments.length ? Promise.resolve() : getStructure()
    ]);
    state.events = result.events;
    if (state.user.role === "Admin") state.accounts = (await api("/api/accounts")).accounts;
    const form = state.formOpen && state.user.role === "Admin" ? eventForm(state.editEvent) : "";
    const focused = state.eventAttendanceId ? await api(`/api/events/${encodeURIComponent(state.eventAttendanceId)}/attendance`) : null;
    state.eventAttendance = focused?.records || [];
    $("#view-container").innerHTML = `
      <div class="panel-heading"><div><h2>Event management</h2><p>Published school events, activities, and event attendance</p></div>${state.user.role === "Admin" ? `<button class="button primary" type="button" data-action="toggle-form">${state.formOpen ? "Close form" : "＋ Create event"}</button>` : ""}</div>
      ${form}
      ${focused ? `<section class="panel"><div class="panel-heading"><div><h2>Event attendance</h2><p>${state.eventAttendance.length} attendee${state.eventAttendance.length === 1 ? "" : "s"} · ${html(state.events.find((event) => event.id === state.eventAttendanceId)?.title || "")}</p></div><button class="button outline" type="button" data-action="close-event-attendance">Close</button></div><div class="toolbar"><label>Student ID or QR value<input id="event-student-id" placeholder="Enter student ID"></label><button class="button primary" type="button" data-event-checkin="${html(state.eventAttendanceId)}">Record event attendance</button><button class="button outline" type="button" data-action="scan-event" data-event-id="${html(state.eventAttendanceId)}">Scan student QR</button><button class="button outline" type="button" data-event-qr="${html(state.eventAttendanceId)}">Event QR</button></div>${eventAttendanceTable(state.eventAttendance)}</section>` : ""}
      <div class="event-cards">${state.events.map(eventCard).join("") || `<section class="panel empty-state">There are no published school events yet.</section>`}</div>`;
    $("#event-form")?.addEventListener("submit", handleEventSubmit);
  }

  function eventForm(event) {
    const localInputValue = (value) => {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "";
      const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
      return local.toISOString().slice(0, 16);
    };
    const staff = state.accounts.filter((account) => ["Teacher", "SSG"].includes(account.role) && account.isActive);
    return `<form id="event-form" class="inline-form"><h3>${event ? "Edit school event" : "Publish a school event"}</h3><div class="form-grid">
      <label>Event title<input name="title" required maxlength="140" value="${html(event?.title || "")}"></label>
      <label>Location<input name="location" maxlength="160" placeholder="Campus, room, or venue" value="${html(event?.location || "")}"></label>
      <label>Start date and time<input name="startAt" type="datetime-local" required value="${html(localInputValue(event?.startAt))}"></label>
      <label>End date and time<input name="endAt" type="datetime-local" value="${html(localInputValue(event?.endAt))}"></label>
      <label>Event leader<select name="leaderId"><option value="">No assigned leader</option>${staff.map((account) => `<option value="${html(account.id)}" ${event?.leaderId === account.id ? "selected" : ""}>${html(account.name)} · ${html(account.role)}</option>`).join("")}</select></label>
      <label>Temporary leader access expires<input name="leaderExpiresAt" type="datetime-local" value="${html(localInputValue(event?.leaderExpiresAt))}"></label>
      <label class="full">Description / announcement<textarea name="description" rows="3" maxlength="3000" placeholder="Event details for students, teachers, and staff">${html(event?.description || "")}</textarea></label>
      <label class="full">Event poster or photo<input name="poster" type="file" accept="image/*"><small class="helper">One image, up to 3 MB.</small></label>
      <div class="form-actions"><button class="button outline" type="button" data-action="toggle-form">Cancel</button><button class="button primary" type="submit">Publish event</button></div>
      <p class="form-status full" role="status"></p>
    </div></form>`;
  }

  function eventCard(event) {
    const canManage = state.user.role === "Admin" || state.user.id === event.leaderId;
    return `<article class="event-card">${event.poster ? `<img src="${html(event.poster)}" alt="Poster for ${html(event.title)}">` : `<div class="event-date-box" style="height:150px;border-radius:0"><b>${html(formatDate(event.startAt, { month: "short", day: "numeric" }))}</b><small>STI EVENT</small></div>`}
      <div class="event-card-body"><h3>${html(event.title)} ${event.published ? "" : '<span class="badge disabled">Draft</span>'}</h3><p>${html(formatDate(event.startAt))}${event.location ? ` · ${html(event.location)}` : ""}</p><p>${html(event.description || "No event description added.")}</p><p>${event.leaderName ? `Event leader: ${html(event.leaderName)}` : "No event leader assigned"} · ${event.attendeeCount} attendee${event.attendeeCount === 1 ? "" : "s"}</p>
      <div class="event-card-actions">${state.user.role === "Student" ? `<span class="badge ${event.attended ? "" : "upcoming"}">${event.attended ? "Checked in" : "Attendance not recorded"}</span>` : ""}${canManage ? `<button class="button primary" type="button" data-event-attendance="${html(event.id)}">Manage attendance</button><button class="button outline" type="button" data-event-qr="${html(event.id)}">Event QR</button>` : ""}${state.user.role === "Admin" ? `<button class="button outline" type="button" data-edit-event="${html(event.id)}">Edit</button><button class="button outline" type="button" data-publish-event="${html(event.id)}" data-published="${event.published ? "true" : "false"}">${event.published ? "Unpublish" : "Publish"}</button>` : ""}</div></div></article>`;
  }

  function eventAttendanceTable(records) {
    return records.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Strand</th><th>Grade</th><th>Section</th><th>Scanned</th></tr></thead><tbody>${records.map((record) => `<tr><td>${html(record.name)} · ${html(record.schoolId)}</td><td>${html(record.strand || "—")}</td><td>${html(record.grade || "—")}</td><td>${html(record.section || "—")}</td><td>${html(formatTime(record.scannedAt))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state">No attendees checked in yet.</div>`;
  }

  async function handleEventSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const file = form.elements.poster.files[0];
    if (file && (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type) || file.size > 3 * 1024 * 1024)) {
      $(".form-status", form).textContent = "Choose an image no larger than 3 MB.";
      return;
    }
    try {
      if (file) values.poster = await fileToDataUrl(file);
      for (const field of ["startAt", "endAt", "leaderExpiresAt"]) {
        if (values[field]) values[field] = new Date(values[field]).toISOString();
      }
      if (state.editEvent) {
        await api(`/api/events/${encodeURIComponent(state.editEvent.id)}`, { method: "PATCH", body: JSON.stringify(values) });
      } else {
        await api("/api/events", { method: "POST", body: JSON.stringify(values) });
      }
      notify(state.editEvent ? "Event updated." : "Event published to the campus portal.");
      state.formOpen = false;
      state.editEvent = null;
      await renderEvents();
    } catch (error) { $(".form-status", form).textContent = error.message; }
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("The selected image could not be read."));
      reader.readAsDataURL(file);
    });
  }

  async function renderGallery() {
    const { events } = await api("/api/events");
    $("#view-container").innerHTML = `<div class="panel-heading"><div><h2>Photo & event gallery</h2><p>Browse event posters and campus activity photos</p></div><button class="button outline" type="button" data-view="events">Event management</button></div>
      <div class="gallery-grid">${events.filter((event) => event.poster).map((event) => `<article class="gallery-tile"><img src="${html(event.poster)}" alt="${html(event.title)} event photo"><div><strong>${html(event.title)}</strong><p>${html(formatDate(event.startAt))} · ${html(event.location || "STI College")}</p></div></article>`).join("") || `<div class="panel empty-state">Event posters and photos will appear here when an administrator publishes an event with an image.</div>`}</div>
      <h2 class="section-title">All published events</h2><div class="event-list panel">${events.map(eventRow).join("") || `<div class="empty-state">No school events published.</div>`}</div>`;
  }

  async function renderCommunity() {
    const [announcementResult, concernResult, peopleResult, inboxResult] = await Promise.all([
      api("/api/announcements"),
      api("/api/concerns"),
      api("/api/community/people"),
      api("/api/messages")
    ]);
    const people = peopleResult.people;
    const selected = people.find((person) => person.id === state.messageTarget
      && (state.user.role !== "Student" || person.role !== "Student" || person.friendshipStatus === "accepted"));
    const activePerson = selected || people.find((person) => person.role !== "Student" || person.friendshipStatus === "accepted") || null;
    state.messageTarget = activePerson?.id || "";
    const thread = activePerson ? await api(`/api/messages?with=${encodeURIComponent(activePerson.id)}`) : { messages: [] };
    const announcements = announcementResult.announcements.map((announcement) => `<article class="community-item">
      <div class="community-item-heading"><div><h3>${html(announcement.title)}</h3><small>${html(announcement.author)} · ${html(formatDate(announcement.createdAt))}</small></div>
      ${state.user.role === "Admin" ? `<span><button class="button outline" type="button" data-edit-announcement="${html(announcement.id)}">Edit</button><button class="button danger" type="button" data-delete-announcement="${html(announcement.id)}">Delete</button></span>` : ""}</div>
      <p>${html(announcement.body)}</p></article>`).join("");
    const concerns = concernResult.concerns.map((concern) => `<article class="community-item">
      <div class="community-item-heading"><div><h3>${html(concern.title)}</h3><small>${html(concern.category)} · ${html(concern.studentName)} · ${html(formatDate(concern.createdAt))}</small></div>
      <span class="badge ${concern.status === "Resolved" ? "present" : concern.status === "In review" ? "late" : "absent"}">${html(concern.status)}</span></div>
      <p>${html(concern.description)}</p>${concern.response ? `<p class="community-response"><strong>Staff response${concern.reviewerName ? ` · ${html(concern.reviewerName)}` : ""}:</strong> ${html(concern.response)}</p>` : ""}
      ${state.user.role !== "Student" ? `<form class="concern-review-form" data-id="${html(concern.id)}"><label>Status<select name="status"><option ${concern.status === "Open" ? "selected" : ""}>Open</option><option ${concern.status === "In review" ? "selected" : ""}>In review</option><option ${concern.status === "Resolved" ? "selected" : ""}>Resolved</option></select></label><label>Reply<textarea name="response" rows="2" maxlength="3000">${html(concern.response)}</textarea></label><button class="button outline" type="submit">Save response</button></form>` : ""}</article>`).join("");
    const contacts = people.map((person) => {
      const cohortMate = state.user.role === "Student" && person.role === "Student";
      const status = person.friendshipStatus || "";
      const action = cohortMate
        ? status === "accepted"
          ? `<button class="button outline" type="button" data-friend-action="remove" data-user-id="${html(person.id)}">Remove</button>`
          : status === "pending" && person.requestDirection === "incoming"
            ? `<button class="button primary" type="button" data-friend-action="accept" data-user-id="${html(person.id)}">Accept</button><button class="button outline" type="button" data-friend-action="decline" data-user-id="${html(person.id)}">Decline</button>`
            : status === "pending" ? `<span class="helper">Request sent</span>`
              : `<button class="button outline" type="button" data-friend-action="request" data-user-id="${html(person.id)}">Connect</button>`
        : "";
      const canChat = state.user.role !== "Student" || !cohortMate || status === "accepted";
      return `<div class="community-contact"><div><strong>${html(person.name)}</strong><small>${html(person.role)}${person.section ? ` · ${html([person.strand, person.grade, person.section].filter(Boolean).join(" "))}` : ""}</small></div><div class="event-card-actions">${canChat ? `<button class="button outline" type="button" data-message-to="${html(person.id)}">Message</button>` : ""}${action}</div></div>`;
    }).join("");
    const conversationList = inboxResult.conversations.map((conversation) => `<button class="community-conversation ${activePerson?.id === conversation.id ? "active" : ""}" type="button" data-message-to="${html(conversation.id)}"><strong>${html(conversation.name)}</strong><span>${html(conversation.lastMessage || "")}</span>${conversation.unread ? `<b>${conversation.unread}</b>` : ""}</button>`).join("");
    const messageList = thread.messages.map((message) => `<article class="community-message ${message.senderId === state.user.id ? "mine" : ""}"><p>${html(message.body)}</p><small>${html(formatDate(message.createdAt))} · ${html(formatTime(message.createdAt))}</small></article>`).join("");
    const editing = state.announcementEdit;
    $("#view-container").innerHTML = `<div class="community-grid">
      <section class="panel"><div class="panel-heading"><div><h2>Campus announcements</h2><p>Updates and notices from the school</p></div></div>
        ${state.user.role === "Admin" ? `<form id="announcement-form" class="community-form"><h3>${editing ? "Edit announcement" : "Publish announcement"}</h3><input type="hidden" name="id" value="${html(editing?.id || "")}"><label>Title<input name="title" required maxlength="160" value="${html(editing?.title || "")}"></label><label>Announcement<textarea name="body" rows="3" required maxlength="3000">${html(editing?.body || "")}</textarea></label><div class="event-card-actions"><button class="button primary" type="submit">${editing ? "Save changes" : "Publish"}</button>${editing ? `<button class="button outline" type="button" data-action="cancel-announcement">Cancel</button>` : ""}</div><p class="form-status" role="status"></p></form>` : ""}
        <div class="community-list">${announcements || `<div class="empty-state">No announcements yet.</div>`}</div>
      </section>
      <section class="panel"><div class="panel-heading"><div><h2>${state.user.role === "Student" ? "Student support" : "Student concerns"}</h2><p>${state.user.role === "Student" ? "Send a private concern to authorized school staff." : "Review and respond within your authorized student scope."}</p></div></div>
        ${state.user.role === "Student" ? `<form id="concern-form" class="community-form"><label>Subject<input name="title" required maxlength="160"></label><label>Category<select name="category" required><option value="">Choose…</option><option>Attendance</option><option>Class or section</option><option>Campus safety</option><option>Wellbeing</option><option>Other</option></select></label><label>Details<textarea name="description" rows="3" required maxlength="3000"></textarea></label><button class="button primary" type="submit">Submit privately</button><p class="form-status" role="status"></p></form>` : ""}
        <div class="community-list">${concerns || `<div class="empty-state">No concerns to display.</div>`}</div>
      </section>
      <section class="panel community-messaging"><div class="panel-heading"><div><h2>Inbox & connections</h2><p>Private messages are limited to your section or assigned scope.</p></div></div>
        <div class="community-inbox"><aside><h3>Conversations</h3>${conversationList || `<p class="helper">No messages yet.</p>`}<h3>People in your authorized community</h3><div class="community-contacts">${contacts || `<p class="helper">No contacts are available in your assigned scope.</p>`}</div></aside>
          <div class="community-thread">${activePerson ? `<header><strong>${html(activePerson.name)}</strong><small>${html(activePerson.role)}</small></header><div class="community-thread-list">${messageList || `<div class="empty-state">Start a conversation.</div>`}</div><form id="message-form" class="community-form" data-recipient="${html(activePerson.id)}"><label class="sr-only" for="community-message">Message</label><textarea id="community-message" name="body" rows="2" maxlength="2000" required placeholder="Write a message…"></textarea><button class="button primary" type="submit">Send message</button><p class="form-status" role="status"></p></form>` : `<div class="empty-state">Choose an authorized contact to start messaging.</div>`}</div></div>
      </section>
    </div>`;
  }

  function renderProfile() {
    $("#view-container").innerHTML = `<section class="panel profile-settings"><div class="panel-heading"><div><h2>My profile</h2><p>Manage your display name and account security</p></div><span class="avatar">${html(initials(state.user.name))}</span></div>
      <dl class="profile-details"><div><dt>Account ID</dt><dd>${html(state.user.username || state.user.student_id || "—")}</dd></div><div><dt>Role</dt><dd>${html(state.user.role)}</dd></div>${state.user.role === "Student" ? `<div><dt>School ID</dt><dd>${html(state.user.student_id || "—")}</dd></div><div><dt>Class</dt><dd>${html([state.user.department, state.user.strand, state.user.grade, state.user.section].filter(Boolean).join(" · ") || "Not assigned")}</dd></div>` : `<div><dt>Assigned scope</dt><dd>${html([state.user.department, state.user.strand, state.user.grade, state.user.section].filter(Boolean).join(" · ") || "Not restricted")}</dd></div>`}</dl>
      <form id="profile-form" class="form-stack"><label>Display name<input name="name" required maxlength="120" value="${html(state.user.name)}"></label><button class="button primary" type="submit">Save profile</button><p class="form-status" role="status"></p></form>
      <p class="helper">Change your password any time from <button class="text-button" type="button" data-view="settings">Account & session settings</button>.</p>
    </section>`;
    $("#profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const result = await api("/api/auth/profile", {
          method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        state.user = { ...state.user, ...result.user };
        $("#user-name").textContent = state.user.name;
        $("#user-avatar").textContent = initials(state.user.name);
        $(".form-status", form).textContent = "Profile updated.";
        notify("Profile updated.");
      } catch (error) { $(".form-status", form).textContent = error.message; }
    });
  }

  async function renderAccounts() {
    const { accounts } = await api("/api/accounts");
    state.accounts = accounts;
    if (!state.structure.departments.length) await getStructure();
    const rows = accounts.map((account) => `<tr>
      <td><div class="student-cell"><span class="avatar">${html(initials(account.name))}</span><span><strong>${html(account.name)}</strong><small>${html(account.username)}</small></span></div></td><td>${html(account.role)}</td><td>${html(account.department || "—")}</td><td>${html([account.strand, account.grade, account.section].filter(Boolean).join(" · ") || "No student scope")}</td><td><span class="badge ${account.isActive ? "" : "disabled"}">${account.isActive ? "Active" : "Disabled"}</span></td><td><div class="event-card-actions"><button class="button outline" type="button" data-edit-account="${html(account.id)}">Edit scope</button><button class="button outline" type="button" data-toggle-account="${html(account.id)}" data-active="${account.isActive ? "true" : "false"}">${account.isActive ? "Disable" : "Enable"}</button></div></td>
    </tr>`).join("");
    $("#view-container").innerHTML = `<div class="panel-heading"><div><h2>Teacher & administrator access</h2><p>Create staff accounts and limit access to assigned sections</p></div><button class="button primary" type="button" data-action="toggle-form">${state.formOpen ? "Close form" : "＋ Add account"}</button></div>
      ${state.formOpen ? accountForm(state.editAccount) : ""}
      <section class="panel"><div class="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Department</th><th>Assigned scope</th><th>Status</th><th>Access</th></tr></thead><tbody>${rows || ""}</tbody></table></div>${rows ? "" : `<div class="empty-state">No staff accounts yet.</div>`}</section>`;
    $("#account-form")?.addEventListener("submit", handleAccountSubmit);
  }

  function accountForm(account) {
    return `<form id="account-form" class="inline-form"><h3>${account ? "Update account access" : "Create an authorized account"}</h3><div class="form-grid">
      <label>Full name<input name="name" required maxlength="120" value="${html(account?.name || "")}"></label>
      ${account ? `<label>Account ID<input value="${html(account.username)}" disabled></label>` : `<label>Account ID<input name="username" required maxlength="50" autocomplete="off"></label>`}
      ${account ? "" : `<label>Role<select name="role"><option>Teacher</option><option>SSG</option><option>Admin</option></select></label><label>Initial password<input name="password" type="password" minlength="10" placeholder="Blank generates a temporary password"></label>`}
      <label>Department<select name="department">${structureOptions("departments", account?.department)}</select></label>
      <label>Strand<select name="strand">${structureOptions("strands", account?.strand)}</select></label>
      <label>Grade level<select name="grade">${structureOptions("grades", account?.grade)}</select></label>
      <label>Section<select name="section">${structureOptions("sections", account?.section)}</select></label>
      <p class="helper full">Teachers and SSG accounts can only see students matching their assigned department, strand, grade, and section. An unassigned scope sees no student records.</p>
      <div class="form-actions"><button class="button outline" type="button" data-action="toggle-form">Cancel</button><button class="button primary" type="submit">Create account</button></div><p class="form-status full" role="status"></p>
    </div></form>`;
  }

  async function handleAccountSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      const result = state.editAccount
        ? await api(`/api/accounts/${encodeURIComponent(state.editAccount.id)}`, { method: "PATCH", body: JSON.stringify(values) })
        : await api("/api/accounts", { method: "POST", body: JSON.stringify(values) });
      state.formOpen = false;
      const updatedAccount = Boolean(state.editAccount);
      state.editAccount = null;
      if (updatedAccount) notify("Account access updated.");
      else showCredential(`Initial password · ${values.name}`, result.initialPassword);
      await renderAccounts();
    } catch (error) { $(".form-status", form).textContent = error.message; }
  }

  async function renderStructure() {
    await getStructure();
    const groups = [
      ["departments", "Departments"], ["strands", "Strands"], ["grades", "Grade levels"], ["sections", "Sections"]
    ];
    const structureCards = groups.map(([type, title]) => {
      const entries = state.structure[type];
      return `<section class="panel"><div class="panel-heading"><div><h2>${title}</h2><p>${entries.length} configured</p></div></div>
        <form class="toolbar structure-form" data-type="${type}">${type === "sections" ? `<label>Section<input name="name" required placeholder="e.g. 11A"></label><label>Department<select name="department">${structureOptions("departments")}</select></label><label>Strand<select name="strand">${structureOptions("strands")}</select></label><label>Grade<select name="grade">${structureOptions("grades")}</select></label>` : `<label class="grow">Add ${title.toLowerCase()}<input name="name" required maxlength="120" placeholder="New ${title.toLowerCase().slice(0, -1)}"></label>`}<button class="button primary" type="submit">Add</button></form>
        <div class="structure-list">${entries.map((entry) => {
          if (state.editStructure?.id === entry.id && state.editStructure.type === type) {
            return `<form class="structure-edit inline-form" data-type="${type}" data-id="${html(entry.id)}"><div class="form-grid"><label>${title}<input name="name" required value="${html(entry.name)}"></label>${type === "sections" ? `<label>Department<select name="department">${structureOptions("departments", entry.department)}</select></label><label>Strand<select name="strand">${structureOptions("strands", entry.strand)}</select></label><label>Grade<select name="grade">${structureOptions("grades", entry.grade)}</select></label>` : ""}<div class="form-actions"><button class="button outline" type="button" data-action="cancel-structure-edit">Cancel</button><button class="button primary" type="submit">Save changes</button></div></div></form>`;
          }
          return `<div class="structure-item"><div><strong>${html(entry.name)}</strong><small>${type === "sections" ? html([entry.department, entry.strand, entry.grade].filter(Boolean).join(" · ")) : html(title)}</small></div><div class="event-card-actions"><button class="button outline" type="button" data-edit-structure="${html(entry.id)}" data-type="${type}">Edit</button><button class="button outline" type="button" data-remove-structure="${type}" data-id="${html(entry.id)}">Remove</button></div></div>`;
        }).join("") || `<p class="helper">No entries have been added.</p>`}</div>
      </section>`;
    }).join("");
    $("#view-container").innerHTML = `<div class="panel-heading"><div><h2>School structure</h2><p>Manage campus departments and student classification</p></div></div><div class="content-grid">${structureCards}</div>`;
  }

  async function renderReports() {
    const date = $("#view-container [name=reportDate]")?.value || localDate();
    const [attendance, students] = await Promise.all([
      api(`/api/attendance?date=${encodeURIComponent(date)}`),
      api("/api/students")
    ]);
    const present = attendance.records.filter((record) => record.status === "Present").length;
    const late = attendance.records.filter((record) => record.status === "Late").length;
    const absent = attendance.records.filter((record) => record.status === "Absent").length;
    $("#view-container").innerHTML = `<div class="panel-heading"><div><h2>Attendance reports</h2><p>Review and export attendance records from the campus database</p></div><button class="button primary" type="button" data-action="export-attendance">Download CSV</button></div>
      <div class="toolbar"><label>Report date<input name="reportDate" type="date" value="${html(date)}"></label><span class="helper">${students.students.length} students in your authorized scope</span></div>
      <div class="report-summary"><article class="stat-card"><span class="muted">Present</span><strong>${present}</strong></article><article class="stat-card"><span class="muted">Late</span><strong>${late}</strong></article><article class="stat-card"><span class="muted">Absent / not marked</span><strong>${Math.max(absent, students.students.length - present - late)}</strong></article></div>
      <section class="panel"><div class="panel-heading"><div><h2>Daily records</h2><p>${html(formatDate(date))} · all attendance sessions</p></div></div>${attendance.records.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Department</th><th>Strand / Grade / Section</th><th>Date</th><th>Session</th><th>Status</th><th>Time in</th><th>Time out</th></tr></thead><tbody>${attendance.records.map((record) => `<tr><td>${html(record.name)} · ${html(record.schoolId || record.studentId)}</td><td>${html(record.department || "—")}</td><td>${html([record.strand, record.grade, record.section].filter(Boolean).join(" · "))}</td><td>${html(formatDate(record.date))}</td><td>${html(record.session)}</td><td><span class="badge ${record.status.toLowerCase()}">${html(record.status)}</span></td><td>${html(formatTime(record.timeIn))}</td><td>${html(formatTime(record.timeOut))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state">No attendance scans on this date yet.</div>`}</section>`;
    $("#view-container [name=reportDate]")?.addEventListener("change", () => void renderReports());
  }

  async function renderSettings() {
    if (!state.structure.departments.length) await getStructure();
    const settings = state.structure.settings;
    $("#view-container").innerHTML = `<section class="panel"><div class="panel-heading"><div><h2>Account & session settings</h2><p>Manage your password and authorized session preferences</p></div></div>
      <form id="password-form" class="form-stack">
        <label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label>
        <label>New password<input name="newPassword" type="password" required minlength="10" autocomplete="new-password"></label>
        <label>Confirm new password<input name="confirmPassword" type="password" required minlength="10" autocomplete="new-password"></label>
        <button class="button primary" type="submit">Update password</button><p class="form-status" role="status"></p>
      </form>
      ${state.user.role === "Admin" ? `<h2 class="section-title">Attendance schedule</h2><form id="schedule-form" class="form-grid">
        <label>Morning late after<input name="morningLateAfter" type="time" value="${html(settings.morningLateAfter || "08:15")}" required></label>
        <label>Morning session closing time<input name="morningClose" type="time" value="${html(settings.morningClose || "13:00")}" required></label>
        <label>Afternoon late after<input name="afternoonLateAfter" type="time" value="${html(settings.afternoonLateAfter || "13:15")}" required></label>
        <label>Afternoon session closing time<input name="afternoonClose" type="time" value="${html(settings.afternoonClose || "17:00")}" required></label>
        <label>Authorized session duration (hours)<input name="sessionHours" type="number" min="1" max="24" value="${html(settings.sessionHours || "8")}" required></label>
        <div class="form-actions"><button class="button primary" type="submit">Save schedule</button></div><p class="helper full">At the morning closing time, the morning session stops accepting scans and records remain available in history. The afternoon session opens automatically.</p><p class="form-status full" role="status"></p>
      </form>` : ""}
      <p class="helper" style="margin-top:24px">Signed in as ${html(state.user.name)} · ${html(state.user.role)} · Session expires ${html(new Date(state.user.expires_at || Date.now() + 8 * 60 * 60 * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}.</p>
    </section>`;
    $("#password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries());
      if (values.newPassword !== values.confirmPassword) return $(".form-status", form).textContent = "The new passwords do not match.";
      try {
        await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(values) });
        form.reset();
        $(".form-status", form).textContent = "Password updated successfully.";
      } catch (error) { $(".form-status", form).textContent = error.message; }
    });
    $("#schedule-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        await api("/api/settings", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        await getStructure();
        notify("Attendance schedule saved.");
      } catch (error) { $(".form-status", form).textContent = error.message; }
    });
  }

  function exportCsv(rows, filename) {
    const content = rows.map((row) => row.map((field) => `"${String(field ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function parseStudentCsv(contents) {
    const source = String(contents || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"' && quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = !quoted;
      } else if (!quoted && character === ",") {
        row.push(value.trim());
        value = "";
      } else if (!quoted && (character === "\n" || character === "\r")) {
        if (character === "\r" && source[index + 1] === "\n") index += 1;
        row.push(value.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        value = "";
      } else {
        value += character;
      }
    }
    if (quoted) throw new Error("CSV contains an unclosed quoted field.");
    row.push(value.trim());
    if (row.some(Boolean)) rows.push(row);
    if (rows.length < 2) throw new Error("CSV must include a header row and at least one student.");
    const fields = rows[0].map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
    const aliases = {
      name: ["name", "fullname", "studentname"],
      studentId: ["studentid", "id", "schoolid"],
      password: ["password", "initialpassword"],
      dateOfBirth: ["dateofbirth", "dob"],
      department: ["department"],
      strand: ["strand"],
      grade: ["grade", "gradelevel"],
      section: ["section"]
    };
    const columns = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [
      field, fields.findIndex((header) => names.includes(header))
    ]));
    if (columns.name < 0 || columns.studentId < 0) throw new Error("CSV headers must include name and studentId.");
    return rows.slice(1).map((cells) => Object.fromEntries(Object.entries(columns)
      .filter(([, column]) => column >= 0)
      .map(([field, column]) => [field, cells[column] || ""])));
  }

  async function exportAttendance() {
    const date = state.view === "reports" ? $("#view-container [name=reportDate]")?.value || localDate() : $("#view-container [name=attendanceDate]")?.value || localDate();
    const result = await api(`/api/attendance?date=${encodeURIComponent(date)}`);
    exportCsv([
      ["Student ID", "Student name", "Department", "Strand", "Grade", "Section", "Date", "Session", "Status", "Time in", "Time out"],
      ...result.records.map((record) => [record.schoolId || record.studentId, record.name, record.department, record.strand, record.grade, record.section, record.date, record.session, record.status, record.timeIn, record.timeOut])
    ], `sti-attendance-${date}.csv`);
  }

  async function scanAttendance(identifier, qrToken = false) {
    const activeSession = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" }) < (state.structure.settings.morningClose || "13:00") ? "Morning" : "Afternoon";
    await api("/api/attendance/check-in", {
      method: "POST",
      body: JSON.stringify({ [qrToken ? "qrToken" : "studentId"]: identifier, date: localDate(), session: activeSession })
    });
  }

  async function timeOutOwnAttendance() {
    const result = await api("/api/attendance");
    const record = result.records.find((entry) => entry.date === localDate() && !entry.timeOut);
    if (!record) throw new Error("No open attendance record was found for today.");
    await api(`/api/attendance/${encodeURIComponent(record.id)}/time-out`, { method: "POST" });
    notify("Time out recorded.");
    await renderAttendance();
  }

  async function startScanner(eventId = "") {
    const dialog = $("#scanner-dialog");
    const video = $("#scanner-video");
    const status = $("#scanner-status");
    state.scannerEventId = eventId;
    if (!("BarcodeDetector" in window)) {
      status.textContent = "QR scanning is not supported in this browser. Use the student ID field instead.";
      dialog.showModal();
      return;
    }
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      state.scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = state.scannerStream;
      await video.play();
      dialog.showModal();
      status.textContent = "Point the camera at the student’s QR code.";
      const scan = async () => {
        if (!state.scannerStream) return;
        let codes;
        try {
          codes = await detector.detect(video);
        } catch {
          codes = [];
        }
        if (codes?.length) {
          const token = codes[0].rawValue;
          stopScanner();
          dialog.close();
          try {
            if (state.scannerEventId) {
              await api(`/api/events/${encodeURIComponent(state.scannerEventId)}/attendance`, { method: "POST", body: JSON.stringify({ qrToken: token }) });
              notify("Event attendance recorded from QR scan.");
              await renderEvents();
            } else {
              await scanAttendance(token, true);
              notify("Attendance recorded from QR scan.");
              await renderAttendance();
            }
          } catch (error) {
            notify(error.message);
          }
          return;
        }
        state.scannerTimer = window.setTimeout(scan, 280);
      };
      void scan();
    } catch (error) {
      status.textContent = `Camera unavailable: ${error.message}. You can still enter the student ID manually.`;
      dialog.showModal();
    }
  }

  function stopScanner() {
    window.clearTimeout(state.scannerTimer);
    state.scannerTimer = null;
    if (state.scannerStream) state.scannerStream.getTracks().forEach((track) => track.stop());
    state.scannerStream = null;
    $("#scanner-video").srcObject = null;
  }

  async function showQr(studentId) {
    const student = state.students.find((entry) => entry.id === studentId);
    const result = await api(`/api/students/${encodeURIComponent(studentId)}/qr`);
    state.qrStudent = { name: student?.name || "Student", studentId: student?.studentId || "", dataUrl: result.dataUrl };
    await renderStudents();
  }

  async function handleClick(event) {
    const helpQuestion = event.target.closest("[data-help-question]");
    if (helpQuestion) {
      submitHelpQuestion(helpQuestion.dataset.helpQuestion);
      return;
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
      const dialogId = viewButton.dataset.closeDialog;
      if (dialogId) document.getElementById(dialogId)?.close();
      setView(viewButton.dataset.view);
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) {
      const action = actionButton.dataset.action;
      if (action === "campus-help") {
        renderHelpThread();
        $("#help-dialog").showModal();
      } else if (action === "mark-notifications-read") {
        try {
          await api("/api/notifications/read", { method: "POST" });
          $("#notifications-dialog").close();
          await openNotifications();
        } catch (error) { notify(error.message); }
      } else if (action === "clear-bulk-result") {
        state.bulkResult = null;
        await renderStudents();
      } else if (action === "toggle-form") {
        state.formOpen = !state.formOpen;
        state.editStudent = null;
        state.editAccount = null;
        state.editEvent = null;
        await loadView();
      } else if (action === "scan-attendance") await startScanner();
      else if (action === "scan-event") await startScanner(actionButton.dataset.eventId);
      else if (action === "my-qr") {
        try {
          const result = await api(`/api/students/${encodeURIComponent(state.user.id)}/qr`);
          $("#qr-dialog-image").src = result.dataUrl;
          $("#qr-dialog-caption").textContent = `Attendance QR for ${state.user.name}. Present this to an authorized staff member.`;
          $("#qr-dialog").showModal();
        } catch (error) { notify(error.message); }
      }
      else if (action === "student-time-in") {
        try {
          await scanAttendance(state.user.id);
          notify("Your attendance has been recorded.");
          await renderAttendance();
        } catch (error) { notify(error.message); }
      } else if (action === "time-out") {
        try { await timeOutOwnAttendance(); } catch (error) { notify(error.message); }
      } else if (action === "export-attendance") {
        try { await exportAttendance(); } catch (error) { notify(error.message); }
      } else if (action === "close-qr") { state.qrStudent = null; await renderStudents(); }
      else if (action === "close-event-attendance") { state.eventAttendanceId = ""; await renderEvents(); }
      else if (action === "cancel-structure-edit") { state.editStructure = null; await renderStructure(); }
      else if (action === "cancel-announcement") { state.announcementEdit = null; await renderCommunity(); }
      else if (action === "upload-roster") $("#bulk-student-file")?.click();
      else if (action === "download-roster-template") {
        exportCsv([["name", "studentId", "password", "dateOfBirth", "department", "strand", "grade", "section"]], "sti-student-roster-template.csv");
      } else if (action === "download-bulk-credentials") {
        if (state.bulkResult?.created.length) {
          exportCsv([["Name", "Student ID", "Temporary password"],
            ...state.bulkResult.created.map(({ name, studentId, initialPassword }) => [name, studentId, initialPassword])],
          "sti-temporary-student-credentials.csv");
        }
      }
      return;
    }
    if (event.target.closest("#logout") || event.target.closest("#top-logout")) {
      await signOut();
      return;
    }
    if (event.target.closest("#theme-toggle")) {
      document.body.classList.toggle("dark-mode");
      localStorage.setItem("sti-theme", document.body.classList.contains("dark-mode") ? "dark" : "light");
      return;
    }
    const messageTarget = event.target.closest("[data-message-to]");
    if (messageTarget) {
      state.messageTarget = messageTarget.dataset.messageTo;
      await renderCommunity();
      return;
    }
    const friendAction = event.target.closest("[data-friend-action]");
    if (friendAction) {
      try {
        await api("/api/community/friends", {
          method: "POST",
          body: JSON.stringify({ userId: friendAction.dataset.userId, action: friendAction.dataset.friendAction })
        });
        notify("Connection updated.");
        await renderCommunity();
      } catch (error) { notify(error.message); }
      return;
    }
    const editAnnouncement = event.target.closest("[data-edit-announcement]");
    if (editAnnouncement) {
      try {
        const { announcements } = await api("/api/announcements");
        state.announcementEdit = announcements.find((announcement) => announcement.id === editAnnouncement.dataset.editAnnouncement) || null;
        await renderCommunity();
      } catch (error) { notify(error.message); }
      return;
    }
    const deleteAnnouncement = event.target.closest("[data-delete-announcement]");
    if (deleteAnnouncement) {
      if (!window.confirm("Delete this announcement?")) return;
      try {
        await api(`/api/announcements/${encodeURIComponent(deleteAnnouncement.dataset.deleteAnnouncement)}`, { method: "DELETE" });
        await renderCommunity();
        notify("Announcement deleted.");
      } catch (error) { notify(error.message); }
      return;
    }
    const qrButton = event.target.closest("[data-qr]");
    if (qrButton) {
      try { await showQr(qrButton.dataset.qr); } catch (error) { notify(error.message); }
      return;
    }
    const editButton = event.target.closest("[data-edit-student]");
    if (editButton) {
      state.editStudent = state.students.find((student) => student.id === editButton.dataset.editStudent);
      state.formOpen = true;
      await renderStudents();
      return;
    }
    const resetButton = event.target.closest("[data-reset-student]");
    if (resetButton) {
      const student = state.students.find((entry) => entry.id === resetButton.dataset.resetStudent);
      try {
        const result = await api(`/api/students/${encodeURIComponent(student.id)}/reset-password`, { method: "POST", body: JSON.stringify({}) });
        showCredential(`Temporary password · ${student.name}`, result.initialPassword);
      } catch (error) { notify(error.message); }
      return;
    }
    const editAccount = event.target.closest("[data-edit-account]");
    if (editAccount) {
      state.editAccount = state.accounts.find((account) => account.id === editAccount.dataset.editAccount);
      state.formOpen = true;
      await renderAccounts();
      return;
    }
    const editEvent = event.target.closest("[data-edit-event]");
    if (editEvent) {
      state.editEvent = state.events.find((entry) => entry.id === editEvent.dataset.editEvent);
      state.formOpen = true;
      await renderEvents();
      return;
    }
    const editStructure = event.target.closest("[data-edit-structure]");
    if (editStructure) {
      state.editStructure = { id: editStructure.dataset.editStructure, type: editStructure.dataset.type };
      await renderStructure();
      return;
    }
    const toggleStudent = event.target.closest("[data-toggle-student]");
    if (toggleStudent) {
      const student = state.students.find((entry) => entry.id === toggleStudent.dataset.toggleStudent);
      try {
        await api(`/api/students/${encodeURIComponent(student.id)}`, { method: "PATCH", body: JSON.stringify({ isActive: !student.isActive }) });
        notify(`Student account ${student.isActive ? "disabled" : "enabled"}.`);
        await renderStudents();
      } catch (error) { notify(error.message); }
      return;
    }
    const toggleAccount = event.target.closest("[data-toggle-account]");
    if (toggleAccount) {
      const active = toggleAccount.dataset.active === "true";
      try {
        await api(`/api/accounts/${encodeURIComponent(toggleAccount.dataset.toggleAccount)}`, { method: "PATCH", body: JSON.stringify({ isActive: !active }) });
        notify(`Account ${active ? "disabled" : "enabled"}.`);
        await renderAccounts();
      } catch (error) { notify(error.message); }
      return;
    }
    const statusSelect = event.target.closest("[data-status-record]");
    if (statusSelect) {
      try {
        if (statusSelect.dataset.statusRecord) {
          await api(`/api/attendance/${encodeURIComponent(statusSelect.dataset.statusRecord)}`, { method: "PATCH", body: JSON.stringify({ status: statusSelect.value }) });
        } else {
          await api("/api/attendance/mark", { method: "POST", body: JSON.stringify({
            studentId: statusSelect.dataset.statusStudent,
            date: statusSelect.dataset.statusDate,
            session: statusSelect.dataset.statusSession,
            status: statusSelect.value
          }) });
        }
        notify("Attendance status updated.");
      } catch (error) { notify(error.message); }
      return;
    }
    const timeOut = event.target.closest("[data-timeout]");
    if (timeOut) {
      try {
        await api(`/api/attendance/${encodeURIComponent(timeOut.dataset.timeout)}/time-out`, { method: "POST" });
        notify("Time out recorded.");
        await renderAttendance();
      } catch (error) { notify(error.message); }
      return;
    }
    const eventManage = event.target.closest("[data-event-attendance]");
    if (eventManage) {
      state.eventAttendanceId = eventManage.dataset.eventAttendance;
      await renderEvents();
      return;
    }
    const eventCheckIn = event.target.closest("[data-event-checkin]");
    if (eventCheckIn) {
      const input = $("#event-student-id");
      try {
        await api(`/api/events/${encodeURIComponent(eventCheckIn.dataset.eventCheckin)}/attendance`, { method: "POST", body: JSON.stringify({ studentId: input.value.trim() }) });
        input.value = "";
        notify("Event attendance recorded.");
        await renderEvents();
      } catch (error) { notify(error.message); }
      return;
    }
    const eventQr = event.target.closest("[data-event-qr]");
    if (eventQr) {
      try {
        const result = await api(`/api/events/${encodeURIComponent(eventQr.dataset.eventQr)}/qr`);
        $("#qr-dialog-image").src = result.dataUrl;
        $("#qr-dialog-caption").textContent = "Event check-in QR";
        $("#qr-dialog").showModal();
      } catch (error) { notify(error.message); }
      return;
    }
    const publish = event.target.closest("[data-publish-event]");
    if (publish) {
      try {
        await api(`/api/events/${encodeURIComponent(publish.dataset.publishEvent)}`, { method: "PATCH", body: JSON.stringify({ published: publish.dataset.published !== "true" }) });
        notify("Event publication status updated.");
        await renderEvents();
      } catch (error) { notify(error.message); }
      return;
    }
    const remove = event.target.closest("[data-remove-structure]");
    if (remove) {
      if (!window.confirm("Remove this school structure item? Existing student records will keep their saved classification.")) return;
      try {
        await api(`/api/structure/${encodeURIComponent(remove.dataset.removeStructure)}/${encodeURIComponent(remove.dataset.id)}`, { method: "DELETE" });
        await renderStructure();
        notify("School structure updated.");
      } catch (error) { notify(error.message); }
    }
  }

  async function handleSubmit(event) {
    if (event.target.id === "login-form") {
      event.preventDefault();
      const form = event.target;
      const values = Object.fromEntries(new FormData(form).entries());
      const status = $("#login-status");
      status.textContent = "";
      try {
        const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify(values) });
        startApp(result.user, result.expiresAt);
      } catch (error) { status.textContent = error.message; }
      return;
    }
    if (event.target.id === "reset-form") {
      event.preventDefault();
      const form = event.target;
      const values = Object.fromEntries(new FormData(form).entries());
      if (values.newPassword.length < 10) return $(".form-status", form).textContent = "Use at least 10 characters.";
      try {
        await api("/api/auth/reset-student-password", { method: "POST", body: JSON.stringify(values) });
        form.reset();
        $(".form-status", form).textContent = "Password reset. You can now sign in.";
      } catch (error) { $(".form-status", form).textContent = error.message; }
      return;
    }
    if (event.target.id === "announcement-form") {
      event.preventDefault();
      const form = event.target;
      const values = Object.fromEntries(new FormData(form).entries());
      const id = values.id;
      delete values.id;
      try {
        await api(id ? `/api/announcements/${encodeURIComponent(id)}` : "/api/announcements", {
          method: id ? "PATCH" : "POST", body: JSON.stringify(values)
        });
        state.announcementEdit = null;
        await renderCommunity();
        notify(id ? "Announcement updated." : "Announcement published.");
      } catch (error) { $(".form-status", form).textContent = error.message; }
      return;
    }
    if (event.target.id === "concern-form") {
      event.preventDefault();
      const form = event.target;
      try {
        await api("/api/concerns", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        await renderCommunity();
        notify("Your concern was sent to authorized school staff.");
      } catch (error) { $(".form-status", form).textContent = error.message; }
      return;
    }
    if (event.target.matches(".concern-review-form")) {
      event.preventDefault();
      const form = event.target;
      try {
        await api(`/api/concerns/${encodeURIComponent(form.dataset.id)}`, {
          method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        await renderCommunity();
        notify("Concern response saved.");
      } catch (error) {
        const status = $(".form-status", form);
        if (status) status.textContent = error.message;
      }
      return;
    }
    if (event.target.id === "message-form") {
      event.preventDefault();
      const form = event.target;
      try {
        await api("/api/messages", {
          method: "POST",
          body: JSON.stringify({ toUserId: form.dataset.recipient, body: new FormData(form).get("body") })
        });
        state.messageTarget = form.dataset.recipient;
        await renderCommunity();
      } catch (error) { $(".form-status", form).textContent = error.message; }
      return;
    }
    if (event.target.matches(".structure-form")) {
      event.preventDefault();
      const form = event.target;
      const type = form.dataset.type;
      try {
        await api(`/api/structure/${encodeURIComponent(type)}`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        await renderStructure();
        notify("School structure item added.");
      } catch (error) { notify(error.message); }
    }
    if (event.target.matches(".structure-edit")) {
      event.preventDefault();
      const form = event.target;
      try {
        await api(`/api/structure/${encodeURIComponent(form.dataset.type)}/${encodeURIComponent(form.dataset.id)}`, {
          method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form).entries()))
        });
        state.editStructure = null;
        await renderStructure();
        notify("School structure item updated.");
      } catch (error) { notify(error.message); }
    }
  }

  function initialize() {
    const roleSelect = $("#login-form [name=role]");
    const idLabel = $("#login-id-label");
    roleSelect.addEventListener("change", () => {
      idLabel.textContent = roleSelect.value === "Student" ? "Student ID" : "Account ID";
    });
    $("#login-form").addEventListener("submit", (event) => void handleSubmit(event));
    $("#reset-form").addEventListener("submit", (event) => void handleSubmit(event));
    $("#forgot-password").addEventListener("click", () => $("#reset-dialog").showModal());
    $("#stop-scanner").addEventListener("click", stopScanner);
    $("#help-open").addEventListener("click", () => {
      renderHelpThread();
      $("#help-dialog").showModal();
    });
    $("#notifications-open").addEventListener("click", () => void openNotifications());
    $("#help-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#help-question");
      submitHelpQuestion(input.value);
      input.value = "";
    });
    $("#credential-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#credential-value").value);
        $("#credential-status").textContent = "Copied to clipboard.";
      } catch {
        $("#credential-value").select();
        $("#credential-status").textContent = "Select and copy the password.";
      }
    });
    document.addEventListener("click", (event) => void handleClick(event));
    document.addEventListener("submit", (event) => {
      if (event.target.id === "login-form" || event.target.id === "reset-form") return;
      void handleSubmit(event);
    });
    document.addEventListener("click", (event) => {
      const close = event.target.closest("[data-close]");
      if (close) document.getElementById(close.dataset.close)?.close();
    });
    $("#scanner-dialog").addEventListener("close", stopScanner);
    $("#login-form [name=role]").dispatchEvent(new Event("change"));
    $("#login-form").elements.password.value = "";
    void api("/api/auth/me").then(({ user, expiresAt }) => startApp(user, expiresAt)).catch(() => showLogin());
    window.setInterval(() => {
      if (!state.user || $("dialog[open]")) return;
      void refreshNotificationBadge().catch((error) => console.error(error));
      if (state.view === "overview") void renderOverview().catch((error) => console.error(error));
      if (state.view === "attendance") void renderAttendance().catch((error) => console.error(error));
      if (state.view === "events" && state.eventAttendanceId) void renderEvents().catch((error) => console.error(error));
    }, 20000);
  }

  initialize();
})();
