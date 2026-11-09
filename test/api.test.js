const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const net = require("node:net");
const test = require("node:test");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sti-attendance-test-"));
const databasePath = path.join(temporaryDirectory, "test.sqlite");
let server;
let baseUrl;
let adminCookie;
let teacherCookie;
let studentCookie;
let studentId;
let secondStudentId;
let teacherId;
let eventId;
let date;
let session;

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(route, { method = "GET", body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json() };
}

async function login(role, username, password) {
  const { response, data } = await request("/api/auth/login", {
    method: "POST", body: { role, username, password }
  });
  assert.equal(response.status, 200, data.error);
  return response.headers.get("set-cookie").split(";")[0];
}

test.before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, ADMIN_PASSWORD: "test-admin-password-2026" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Test server exited unexpectedly: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* Wait for the test server to bind its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${output}`);
});

test.after(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("authenticates, scopes access, preserves session history, and manages event attendance", async () => {
  const unauthorized = await request("/api/students");
  assert.equal(unauthorized.response.status, 401);

  adminCookie = await login("Admin", "admin", "test-admin-password-2026");
  const structure = await request("/api/structure", { cookie: adminCookie });
  assert.equal(structure.response.status, 200);
  const department = structure.data.departments[0].name;
  const strand = structure.data.strands[0].name;
  const grade = structure.data.grades[0].name;
  const section = "API Test Section";
  await request("/api/structure/sections", {
    method: "POST", cookie: adminCookie,
    body: { name: section, department, strand, grade }
  });

  const first = await request("/api/students", {
    method: "POST", cookie: adminCookie,
    body: { name: "Test Student One", studentId: "TEST-STU-001", password: "student-password-123", dateOfBirth: "2008-04-15", department, strand, grade, section }
  });
  assert.equal(first.response.status, 201, first.data.error);
  studentId = first.data.student.id;
  const second = await request("/api/students", {
    method: "POST", cookie: adminCookie,
    body: { name: "Test Student Two", studentId: "TEST-STU-002", password: "student-password-456", department: "IT Department", strand: "STEM", grade: "12", section: "Other" }
  });
  assert.equal(second.response.status, 201, second.data.error);
  secondStudentId = second.data.student.id;
  const peer = await request("/api/students", {
    method: "POST", cookie: adminCookie,
    body: { name: "Test Student Peer", studentId: "TEST-STU-003", password: "student-password-789", department, strand, grade, section }
  });
  assert.equal(peer.response.status, 201, peer.data.error);

  const roster = await request("/api/students", { cookie: adminCookie });
  assert.equal(roster.data.students.length, 3);
  assert.equal("qrToken" in roster.data.students[0], false);

  const teacher = await request("/api/accounts", {
    method: "POST", cookie: adminCookie,
    body: { name: "Scoped Teacher", username: "teacher-api-test", role: "Teacher", password: "teacher-password-123", department, strand, grade, section }
  });
  assert.equal(teacher.response.status, 201, teacher.data.error);
  teacherId = teacher.data.account.id;
  teacherCookie = await login("Teacher", "teacher-api-test", "teacher-password-123");
  const scopedRoster = await request("/api/students", { cookie: teacherCookie });
  assert.deepEqual(scopedRoster.data.students.map((student) => student.id), [studentId, peer.data.student.id]);
  const forbidden = await request("/api/accounts", { cookie: teacherCookie });
  assert.equal(forbidden.response.status, 403);

  const currentTime = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" });
  session = currentTime < "13:00" ? "Morning" : currentTime < "17:00" ? "Afternoon" : "Morning";
  if (currentTime >= "17:00") {
    const close = new Date(Date.now() + 30 * 60 * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" });
    const later = new Date(Date.now() + 60 * 60 * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit" });
    await request("/api/settings", { method: "PUT", cookie: adminCookie, body: { morningClose: close, afternoonClose: later } });
  }
  date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const checkIn = await request("/api/attendance/check-in", {
    method: "POST", cookie: teacherCookie,
    body: { studentId: "TEST-STU-001", date, session }
  });
  assert.equal(checkIn.response.status, 201, checkIn.data.error);
  const outsideScope = await request("/api/attendance/check-in", {
    method: "POST", cookie: teacherCookie,
    body: { studentId: "TEST-STU-002", date, session }
  });
  assert.equal(outsideScope.response.status, 404);
  const markedAbsent = await request("/api/attendance/mark", {
    method: "POST", cookie: teacherCookie,
    body: { studentId: studentId, date, session, status: "Absent" }
  });
  assert.equal(markedAbsent.response.status, 200);
  const records = await request(`/api/attendance?date=${date}&session=${session}`, { cookie: teacherCookie });
  assert.equal(records.data.records.length, 2);
  assert.equal(records.data.records[0].status, "Absent");

  const secondStudentCookie = await login("Student", "TEST-STU-001", "student-password-123");
  studentCookie = secondStudentCookie;
  const studentAccounts = await request("/api/accounts", { cookie: studentCookie });
  assert.equal(studentAccounts.response.status, 403);
  const ownAttendance = await request("/api/attendance/check-in", {
    method: "POST", cookie: studentCookie, body: { studentId, date, session }
  });
  assert.equal(ownAttendance.response.status, 409);

  const announcement = await request("/api/announcements", {
    method: "POST", cookie: adminCookie, body: { title: "Test announcement", body: "Campus notice for the test." }
  });
  assert.equal(announcement.response.status, 201, announcement.data.error);
  const unauthorizedAnnouncement = await request("/api/announcements", {
    method: "POST", cookie: teacherCookie, body: { title: "Unauthorized", body: "Must not publish." }
  });
  assert.equal(unauthorizedAnnouncement.response.status, 403);
  const visibleAnnouncement = await request("/api/announcements", { cookie: studentCookie });
  assert.equal(visibleAnnouncement.data.announcements.some((entry) => entry.id === announcement.data.id), true);
  const unreadNotifications = await request("/api/notifications", { cookie: studentCookie });
  assert.equal(unreadNotifications.data.announcements.some((entry) => entry.id === announcement.data.id), true);
  await request("/api/notifications/read", { method: "POST", cookie: studentCookie });
  const readNotifications = await request("/api/notifications", { cookie: studentCookie });
  assert.equal(readNotifications.data.announcements.some((entry) => entry.id === announcement.data.id), false);

  const concern = await request("/api/concerns", {
    method: "POST", cookie: studentCookie,
    body: { title: "Attendance question", category: "Attendance", description: "Please review my attendance record." }
  });
  assert.equal(concern.response.status, 201, concern.data.error);
  const scopedConcerns = await request("/api/concerns", { cookie: teacherCookie });
  assert.equal(scopedConcerns.data.concerns.some((entry) => entry.id === concern.data.id), true);
  const reviewedConcern = await request(`/api/concerns/${concern.data.id}`, {
    method: "PATCH", cookie: teacherCookie, body: { status: "In review", response: "We are reviewing this." }
  });
  assert.equal(reviewedConcern.response.status, 200);
  const studentConcerns = await request("/api/concerns", { cookie: studentCookie });
  assert.equal(studentConcerns.data.concerns[0].response, "We are reviewing this.");

  const peerCookie = await login("Student", "TEST-STU-003", "student-password-789");
  const contacts = await request("/api/community/people", { cookie: studentCookie });
  assert.equal(contacts.data.people.some((person) => person.id === secondStudentId), false);
  assert.equal(contacts.data.people.some((person) => person.id === teacherId), true);
  const outsideFriendRequest = await request("/api/community/friends", {
    method: "POST", cookie: studentCookie, body: { userId: secondStudentId, action: "request" }
  });
  assert.equal(outsideFriendRequest.response.status, 404);
  const outsideMessage = await request("/api/messages", {
    method: "POST", cookie: teacherCookie, body: { toUserId: secondStudentId, body: "Not in scope." }
  });
  assert.equal(outsideMessage.response.status, 404);
  const unconnectedMessage = await request("/api/messages", {
    method: "POST", cookie: studentCookie, body: { toUserId: peer.data.student.id, body: "Hello" }
  });
  assert.equal(unconnectedMessage.response.status, 404);
  const friendRequest = await request("/api/community/friends", {
    method: "POST", cookie: studentCookie, body: { userId: peer.data.student.id, action: "request" }
  });
  assert.equal(friendRequest.response.status, 201, friendRequest.data.error);
  const acceptedFriend = await request("/api/community/friends", {
    method: "POST", cookie: peerCookie, body: { userId: studentId, action: "accept" }
  });
  assert.equal(acceptedFriend.response.status, 200, acceptedFriend.data.error);
  const peerMessage = await request("/api/messages", {
    method: "POST", cookie: studentCookie, body: { toUserId: peer.data.student.id, body: "Hello, classmate." }
  });
  assert.equal(peerMessage.response.status, 201, peerMessage.data.error);
  const unreadMessageNotifications = await request("/api/notifications", { cookie: peerCookie });
  assert.equal(unreadMessageNotifications.data.unreadMessages, 1);
  const peerThread = await request(`/api/messages?with=${encodeURIComponent(studentId)}`, { cookie: peerCookie });
  assert.equal(peerThread.data.messages[0].body, "Hello, classmate.");
  const messageNotifications = await request("/api/notifications", { cookie: peerCookie });
  assert.equal(messageNotifications.data.unreadMessages, 0);

  const outOfScopeConcern = await request("/api/concerns", {
    method: "POST", cookie: await login("Student", "TEST-STU-002", "student-password-456"),
    body: { title: "Private concern", category: "Other", description: "Not in this teacher scope." }
  });
  assert.equal(outOfScopeConcern.response.status, 201);
  const forbiddenConcern = await request(`/api/concerns/${outOfScopeConcern.data.id}`, {
    method: "PATCH", cookie: teacherCookie, body: { status: "Resolved" }
  });
  assert.equal(forbiddenConcern.response.status, 404);
  const profile = await request("/api/auth/profile", {
    method: "PATCH", cookie: studentCookie, body: { name: "Updated Test Student" }
  });
  assert.equal(profile.data.user.name, "Updated Test Student");
  const bulkImport = await request("/api/students/bulk", {
    method: "POST", cookie: adminCookie,
    body: { students: [
      { name: "Bulk Import Student", studentId: "TEST-STU-004", department, strand, grade, section },
      { name: "Duplicate Student", studentId: "TEST-STU-001" }
    ] }
  });
  assert.equal(bulkImport.response.status, 201, bulkImport.data.error);
  assert.equal(bulkImport.data.created.length, 1);
  assert.equal(bulkImport.data.rejected.length, 1);
  assert.equal(bulkImport.data.created[0].initialPassword.length >= 10, true);

  const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const leaderExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const createdEvent = await request("/api/events", {
    method: "POST", cookie: adminCookie,
    body: { title: "Test Campus Event", description: "Testing event check-in.", location: "Test Hall", startAt, leaderId: teacherId, leaderExpiresAt }
  });
  assert.equal(createdEvent.response.status, 201, createdEvent.data.error);
  eventId = createdEvent.data.id;
  const eventCheckIn = await request(`/api/events/${eventId}/attendance`, {
    method: "POST", cookie: teacherCookie, body: { studentId: "TEST-STU-001" }
  });
  assert.equal(eventCheckIn.response.status, 201, eventCheckIn.data.error);
  const eventDuplicate = await request(`/api/events/${eventId}/attendance`, {
    method: "POST", cookie: teacherCookie, body: { studentId: "TEST-STU-001" }
  });
  assert.equal(eventDuplicate.response.status, 409);
  const ownEventRecord = await request(`/api/events/${eventId}/attendance`, { cookie: studentCookie });
  assert.equal(ownEventRecord.data.records.length, 1);

  const qr = await request(`/api/students/${studentId}/qr`, { cookie: adminCookie });
  assert.match(qr.data.dataUrl, /^data:image\/png;base64,/);

  const reset = await request("/api/auth/reset-student-password", {
    method: "POST",
    body: { studentId: "TEST-STU-001", dateOfBirth: "2008-04-15", newPassword: "updated-student-password" }
  });
  assert.equal(reset.response.status, 200, reset.data.error);
  studentCookie = await login("Student", "TEST-STU-001", "updated-student-password");
  const me = await request("/api/auth/me", { cookie: studentCookie });
  assert.equal(me.data.user.id, studentId);
});
