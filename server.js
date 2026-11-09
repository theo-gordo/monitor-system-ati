const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const QRCode = require("qrcode");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATABASE_DIR = path.join(ROOT_DIR, "data");
const DATABASE_PATH = process.env.DATABASE_PATH || path.join(DATABASE_DIR, "monitoring.sqlite");
const SESSION_COOKIE = "sti_session";
const SESSION_HOURS = 8;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAILURE_LIMIT = 8;
const ROLES = new Set(["Admin", "Teacher", "SSG", "Student"]);
const ALLOWED_STRUCTURE = new Set(["departments", "strands", "grades", "sections"]);
const authFailures = new Map();
let archiveTimer = null;

fs.mkdirSync(DATABASE_DIR, { recursive: true });

const db = new sqlite3.Database(DATABASE_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) return reject(error);
      resolve(rows || []);
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = String(storedHash || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safeUser(user) {
  if (!user) return null;
  const { password_hash: _passwordHash, dob: _dob, ...safe } = user;
  return safe;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function validateText(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw Object.assign(new Error(`${label} is required and must be at most ${max} characters.`), { status: 400 });
  }
  return value.trim();
}

function randomPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

function blockedAuthAttempt(key) {
  const attempt = authFailures.get(key);
  if (!attempt) return false;
  if (Date.now() - attempt.startedAt >= AUTH_WINDOW_MS) {
    authFailures.delete(key);
    return false;
  }
  return attempt.count >= AUTH_FAILURE_LIMIT;
}

function recordAuthFailure(key) {
  const current = authFailures.get(key);
  if (!current || Date.now() - current.startedAt >= AUTH_WINDOW_MS) {
    authFailures.set(key, { startedAt: Date.now(), count: 1 });
    return;
  }
  current.count += 1;
}

function schoolDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function schoolTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(date);
}

function createSchema() {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        await run("PRAGMA foreign_keys = ON");
        await run(`CREATE TABLE IF NOT EXISTS app_data (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('Admin','Teacher','SSG','Student')),
          name TEXT NOT NULL,
          student_id TEXT UNIQUE,
          dob TEXT,
          department TEXT,
          strand TEXT,
          grade TEXT,
          section TEXT,
          qr_token TEXT UNIQUE,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL
        )`);
        await run(`CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`);
        await run(`CREATE TABLE IF NOT EXISTS strands (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`);
        await run(`CREATE TABLE IF NOT EXISTS grades (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`);
        await run(`CREATE TABLE IF NOT EXISTS sections (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL DEFAULT '',
          strand TEXT NOT NULL DEFAULT '', grade TEXT NOT NULL DEFAULT '',
          UNIQUE(name, department, strand, grade)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS attendance (
          id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          date TEXT NOT NULL, session TEXT NOT NULL CHECK(session IN ('Morning','Afternoon')),
          status TEXT NOT NULL CHECK(status IN ('Present','Late','Absent')),
          time_in TEXT, time_out TEXT, source TEXT NOT NULL DEFAULT 'Manual',
          UNIQUE(student_id, date, session)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          location TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL, end_at TEXT,
          poster TEXT, leader_id TEXT REFERENCES users(id) ON DELETE SET NULL, leader_expires_at TEXT,
          published INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS event_attendance (
          event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          scanned_at TEXT NOT NULL, PRIMARY KEY(event_id, student_id)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS announcements (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS announcement_reads (
          announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(announcement_id, user_id)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS concerns (
          id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','In review','Resolved')),
          response TEXT NOT NULL DEFAULT '', updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS friend_requests (
          id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(requester_id, recipient_id), CHECK(requester_id != recipient_id)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT,
          CHECK(sender_id != recipient_id)
        )`);
        await run(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

        const defaults = [
          ["departments", ["Tourism Department", "HM Department", "IT Department"]],
          ["strands", ["TVL", "HUMSS", "TOURISM", "STEM", "ABM"]],
          ["grades", ["11", "12"]]
        ];
        for (const [table, names] of defaults) {
          for (const name of names) {
            await run(`INSERT OR IGNORE INTO ${table} (id, name) VALUES (?, ?)`, [crypto.randomUUID(), name]);
          }
        }
        await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('morningClose', '13:00')");
        await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('afternoonClose', '17:00')");
        await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('morningLateAfter', '08:15')");
        await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('afternoonLateAfter', '13:15')");
        await run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('sessionHours', '8')");
        const migrationDone = await get("SELECT value FROM app_settings WHERE key = 'legacy_data_migrated'");
        if (!migrationDone) {
          const legacyRows = await all("SELECT key, value FROM app_data WHERE key IN (?, ?)", [
            "sti-attendance-students", "sti-attendance-records"
          ]);
          const legacy = Object.fromEntries(legacyRows.map(({ key, value }) => [key, value]));
          let legacyStudents = [];
          let legacyAttendance = [];
          try { legacyStudents = JSON.parse(legacy["sti-attendance-students"] || "[]"); }
          catch (error) { console.warn("Legacy student records could not be imported:", error.message); }
          try { legacyAttendance = JSON.parse(legacy["sti-attendance-records"] || "[]"); }
          catch (error) { console.warn("Legacy attendance records could not be imported:", error.message); }
          const oldIds = new Map();
          for (const oldStudent of Array.isArray(legacyStudents) ? legacyStudents : []) {
            if (!oldStudent?.id || !oldStudent?.name) continue;
            const studentId = String(oldStudent.studentId || oldStudent.id).trim();
            const id = crypto.randomUUID();
            await run(
              `INSERT OR IGNORE INTO users (id, username, password_hash, role, name, student_id, dob, department, strand, grade, section, qr_token)
               VALUES (?, ?, ?, 'Student', ?, ?, ?, ?, ?, ?, ?, ?)`,
              [id, studentId, hashPassword(String(oldStudent.password || randomPassword())),
                String(oldStudent.name).trim(), studentId, oldStudent.dateOfBirth || oldStudent.dob || null,
                oldStudent.department || "", oldStudent.strand || "", oldStudent.grade || "",
                oldStudent.section || oldStudent.program || "", crypto.randomUUID()]
            );
            const inserted = await get("SELECT id FROM users WHERE student_id = ?", [studentId]);
            if (inserted) {
              oldIds.set(String(oldStudent.id), inserted.id);
              oldIds.set(studentId, inserted.id);
            }
          }
          for (const oldRecord of Array.isArray(legacyAttendance) ? legacyAttendance : []) {
            const studentUserId = oldIds.get(String(oldRecord?.id || oldRecord?.studentId || ""));
            const session = oldRecord?.session === "Afternoon" ? "Afternoon" : "Morning";
            if (!studentUserId || !/^\d{4}-\d{2}-\d{2}$/.test(String(oldRecord?.date || ""))) continue;
            const status = ["Present", "Absent", "Late"].includes(oldRecord.status) ? oldRecord.status : "Present";
            await run(
              `INSERT OR IGNORE INTO attendance (id, student_id, date, session, status, time_in, time_out, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'Legacy import')`,
              [crypto.randomUUID(), studentUserId, oldRecord.date, session, status,
                oldRecord.timeIn || null, oldRecord.timeOut || null]
            );
          }
          await run("INSERT INTO app_settings (key, value) VALUES ('legacy_data_migrated', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
        }
        const existingAdmin = await get("SELECT id FROM users WHERE username = 'admin'");
        if (!existingAdmin) {
          const password = process.env.ADMIN_PASSWORD || "admin123";
          await run(
            "INSERT INTO users (id, username, password_hash, role, name) VALUES (?, ?, ?, ?, ?)",
            [crypto.randomUUID(), "admin", hashPassword(password), "Admin", "STI Administrator"]
          );
          if (!process.env.ADMIN_PASSWORD) {
            console.warn("Using the demo admin password. Set ADMIN_PASSWORD before deployment.");
          }
        }
        const eventColumns = await all("PRAGMA table_info(events)");
        if (!eventColumns.some((column) => column.name === "leader_expires_at")) {
          await run("ALTER TABLE events ADD COLUMN leader_expires_at TEXT");
        }
          resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));
app.use((req, _res, next) => {
  const cookies = String(req.headers.cookie || "").split(";");
  req.cookies = Object.fromEntries(cookies.map((cookie) => {
    const separator = cookie.indexOf("=");
    return separator < 0
      ? ["", ""]
      : [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
  }).filter(([name]) => name));
  next();
});

app.use(asyncRoute(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = await get(
    `SELECT users.*, sessions.expires_at FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND julianday(sessions.expires_at) > julianday('now') AND users.is_active = 1`,
    [tokenHash]
  );
  if (session) req.user = session;
  next();
}));

function authRequired(req, res, next) {
  if (!req.user) return sendError(res, 401, "Please sign in to continue.");
  next();
}

function roles(...roles) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, "Please sign in to continue.");
    if (!roles.includes(req.user.role)) return sendError(res, 403, "You do not have permission to do that.");
    next();
  };
}

function studentScope(user, alias = "u") {
  if (user.role === "Admin") return { sql: "1 = 1", params: [] };
  if (user.role === "Student") return { sql: `${alias}.id = ?`, params: [user.id] };
  const filters = [];
  const params = [];
  for (const field of ["department", "strand", "grade", "section"]) {
    if (user[field]) {
      filters.push(`${alias}.${field} = ?`);
      params.push(user[field]);
    }
  }
  return { sql: filters.length ? filters.join(" AND ") : "1 = 0", params };
}

function ensureStudentScope(req, student) {
  return userCanAccessStudent(req.user, student);
}

function userCanAccessStudent(user, student) {
  if (!student || student.role !== "Student") return false;
  const scope = studentScope(user);
  if (scope.sql === "1 = 1") return true;
  if (user.role === "Student") return student.id === user.id;
  return ["department", "strand", "grade", "section"].some((field) => user[field])
    && ["department", "strand", "grade", "section"].every((field) => !user[field] || user[field] === student[field]);
}

function sameCohort(first, second) {
  const fields = ["department", "strand", "grade", "section"];
  return fields.every((field) => first[field] && second[field] && first[field] === second[field]);
}

async function canMessage(sender, recipient) {
  if (!recipient || recipient.is_active === 0 || sender.id === recipient.id) return false;
  if (sender.role === "Admin") return true;
  if (sender.role === "Student" && recipient.role === "Student") {
    const friendship = await get(
      `SELECT id FROM friend_requests WHERE status = 'accepted'
       AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
      [sender.id, recipient.id, recipient.id, sender.id]
    );
    return Boolean(friendship);
  }
  if (sender.role === "Student" && ["Teacher", "SSG"].includes(recipient.role)) {
    return userCanAccessStudent(recipient, sender);
  }
  return ["Teacher", "SSG"].includes(sender.role) && recipient.role === "Student"
    && userCanAccessStudent(sender, recipient);
}

async function findStudent(identifier) {
  return get("SELECT * FROM users WHERE role = 'Student' AND is_active = 1 AND (id = ? OR student_id = ? OR qr_token = ?)", [
    identifier, identifier, identifier
  ]);
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
    path: "/"
  });
}

app.get("/api/health", (_req, res) => res.json({ ok: true, status: "ready" }));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const role = String(req.body?.role || "");
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!ROLES.has(role) || !username || !password) return sendError(res, 400, "Choose an account type and enter your ID and password.");
  const attemptKey = `login:${req.ip}`;
  if (blockedAuthAttempt(attemptKey)) return sendError(res, 429, "Too many unsuccessful sign-in attempts. Try again in 15 minutes.");
  const user = await get("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND role = ?", [username, role]);
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    recordAuthFailure(attemptKey);
    return sendError(res, 401, "The account ID or password is incorrect.");
  }
  authFailures.delete(attemptKey);
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionHoursSetting = await get("SELECT value FROM app_settings WHERE key = 'sessionHours'");
  const sessionHours = Math.min(24, Math.max(1, Number(sessionHoursSetting?.value) || SESSION_HOURS));
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
    crypto.createHash("sha256").update(token).digest("hex"), user.id, expiresAt
  ]);
  setSessionCookie(res, token, expiresAt);
  res.json({ user: safeUser(user), expiresAt });
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    await run("DELETE FROM sessions WHERE token_hash = ?", [crypto.createHash("sha256").update(token).digest("hex")]);
  }
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
  res.json({ ok: true });
}));

app.get("/api/auth/me", authRequired, (req, res) => {
  res.json({ user: safeUser(req.user), expiresAt: req.user.expires_at });
});

app.post("/api/auth/change-password", authRequired, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 10) return sendError(res, 400, "Use a password with at least 10 characters.");
  if (!verifyPassword(currentPassword, req.user.password_hash)) return sendError(res, 400, "Current password is incorrect.");
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(newPassword), req.user.id]);
  res.json({ ok: true });
}));

app.patch("/api/auth/profile", authRequired, asyncRoute(async (req, res) => {
  const name = validateText(req.body?.name, "Display name");
  await run("UPDATE users SET name = ? WHERE id = ?", [name, req.user.id]);
  res.json({ user: safeUser(await get("SELECT * FROM users WHERE id = ?", [req.user.id])) });
}));

app.post("/api/auth/reset-student-password", asyncRoute(async (req, res) => {
  const studentId = String(req.body?.studentId || "").trim();
  const dob = String(req.body?.dateOfBirth || "");
  const newPassword = String(req.body?.newPassword || "");
  if (!studentId || !dob || newPassword.length < 10) return sendError(res, 400, "Enter your student ID, date of birth, and a password of at least 10 characters.");
  const attemptKey = `reset:${req.ip}`;
  if (blockedAuthAttempt(attemptKey)) return sendError(res, 429, "Too many unsuccessful verification attempts. Try again in 15 minutes.");
  const student = await get("SELECT id, dob FROM users WHERE role = 'Student' AND student_id = ?", [studentId]);
  if (!student || !student.dob || student.dob !== dob) {
    recordAuthFailure(attemptKey);
    return sendError(res, 401, "Student ID or date-of-birth verification failed.");
  }
  authFailures.delete(attemptKey);
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(newPassword), student.id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [student.id]);
  res.json({ ok: true });
}));

app.get("/api/announcements", authRequired, asyncRoute(async (_req, res) => {
  const announcements = await all(
    `SELECT a.id, a.title, a.body, a.created_at AS createdAt, u.name AS author
     FROM announcements a JOIN users u ON u.id = a.created_by
     ORDER BY a.created_at DESC LIMIT 100`
  );
  res.json({ announcements });
}));

app.post("/api/announcements", roles("Admin"), asyncRoute(async (req, res) => {
  const title = validateText(req.body?.title, "Announcement title", 160);
  const body = validateText(req.body?.body, "Announcement", 3000);
  const id = crypto.randomUUID();
  await run("INSERT INTO announcements (id, title, body, created_by) VALUES (?, ?, ?, ?)", [id, title, body, req.user.id]);
  res.status(201).json({ id });
}));

app.patch("/api/announcements/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const announcement = await get("SELECT id FROM announcements WHERE id = ?", [req.params.id]);
  if (!announcement) return sendError(res, 404, "Announcement not found.");
  const title = validateText(req.body?.title, "Announcement title", 160);
  const body = validateText(req.body?.body, "Announcement", 3000);
  await run("UPDATE announcements SET title = ?, body = ? WHERE id = ?", [title, body, req.params.id]);
  res.json({ ok: true });
}));

app.delete("/api/announcements/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const result = await run("DELETE FROM announcements WHERE id = ?", [req.params.id]);
  if (!result.changes) return sendError(res, 404, "Announcement not found.");
  res.json({ ok: true });
}));

app.get("/api/notifications", authRequired, asyncRoute(async (req, res) => {
  const [announcements, unreadAnnouncements, unreadMessages] = await Promise.all([
    all(
      `SELECT a.id, a.title, a.body, a.created_at AS createdAt
       FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
       WHERE r.announcement_id IS NULL ORDER BY a.created_at DESC LIMIT 10`,
      [req.user.id]
    ),
    get(
      `SELECT count(*) AS total FROM announcements a
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = ?
       WHERE r.announcement_id IS NULL`,
      [req.user.id]
    ),
    get("SELECT count(*) AS total FROM messages WHERE recipient_id = ? AND read_at IS NULL", [req.user.id])
  ]);
  res.json({
    announcements,
    unreadMessages: unreadMessages?.total || 0,
    unreadCount: (unreadAnnouncements?.total || 0) + (unreadMessages?.total || 0)
  });
}));

app.post("/api/notifications/read", authRequired, asyncRoute(async (req, res) => {
  await run(
    `INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id)
     SELECT id, ? FROM announcements`,
    [req.user.id]
  );
  res.json({ ok: true });
}));

app.get("/api/concerns", authRequired, asyncRoute(async (req, res) => {
  const scope = studentScope(req.user, "u");
  const concerns = await all(
    `SELECT c.id, c.student_id AS studentId, u.name AS studentName, u.student_id AS schoolId,
      c.title, c.category, c.description, c.status, c.response, c.created_at AS createdAt,
      c.updated_at AS updatedAt, reviewer.name AS reviewerName
     FROM concerns c JOIN users u ON u.id = c.student_id
     LEFT JOIN users reviewer ON reviewer.id = c.updated_by
     WHERE ${scope.sql} ORDER BY c.updated_at DESC LIMIT 200`,
    scope.params
  );
  res.json({ concerns });
}));

app.post("/api/concerns", roles("Student"), asyncRoute(async (req, res) => {
  const title = validateText(req.body?.title, "Concern title", 160);
  const category = validateText(req.body?.category, "Concern category", 60);
  const description = validateText(req.body?.description, "Concern details", 3000);
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO concerns (id, student_id, title, category, description) VALUES (?, ?, ?, ?, ?)",
    [id, req.user.id, title, category, description]
  );
  res.status(201).json({ id });
}));

app.patch("/api/concerns/:id", roles("Admin", "Teacher", "SSG"), asyncRoute(async (req, res) => {
  const concern = await get(
    `SELECT c.id, u.* FROM concerns c JOIN users u ON u.id = c.student_id WHERE c.id = ?`,
    [req.params.id]
  );
  if (!concern) return sendError(res, 404, "Concern not found.");
  if (!userCanAccessStudent(req.user, concern)) return sendError(res, 404, "Concern not found in your authorized sections.");
  const status = req.body?.status === undefined ? undefined : String(req.body.status);
  if (status !== undefined && !["Open", "In review", "Resolved"].includes(status)) {
    return sendError(res, 400, "Choose Open, In review, or Resolved.");
  }
  const response = req.body?.response === undefined ? undefined : String(req.body.response).trim().slice(0, 3000);
  const current = await get("SELECT status, response FROM concerns WHERE id = ?", [req.params.id]);
  await run(
    `UPDATE concerns SET status = ?, response = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status ?? current.status, response ?? current.response, req.user.id, req.params.id]
  );
  res.json({ ok: true });
}));

app.get("/api/community/people", authRequired, asyncRoute(async (req, res) => {
  let candidates;
  if (req.user.role === "Admin") {
    candidates = await all(
      "SELECT id, name, role, department, strand, grade, section FROM users WHERE id != ? AND is_active = 1 ORDER BY name",
      [req.user.id]
    );
  } else if (req.user.role === "Student") {
    const peers = ["department", "strand", "grade", "section"].every((field) => req.user[field])
      ? await all(
        `SELECT id, name, role, department, strand, grade, section FROM users
         WHERE role = 'Student' AND is_active = 1 AND id != ?
         AND department = ? AND strand = ? AND grade = ? AND section = ? ORDER BY name`,
        [req.user.id, req.user.department, req.user.strand, req.user.grade, req.user.section]
      )
      : [];
    const staff = await all(
      "SELECT id, name, role, department, strand, grade, section FROM users WHERE role IN ('Teacher','SSG') AND is_active = 1 ORDER BY name"
    );
    candidates = [...peers, ...staff.filter((person) => userCanAccessStudent(person, req.user))];
  } else {
    const scope = studentScope(req.user, "u");
    candidates = await all(
      `SELECT u.id, u.name, u.role, u.department, u.strand, u.grade, u.section
       FROM users u WHERE u.role = 'Student' AND u.is_active = 1 AND (${scope.sql}) ORDER BY u.name`,
      scope.params
    );
  }
  const people = [];
  for (const person of candidates) {
    if (await canMessage(req.user, person)) {
      people.push({ ...person, ...(req.user.role === "Student" && person.role === "Student" ? { friendshipStatus: "accepted" } : {}) });
    }
    else if (req.user.role === "Student" && person.role === "Student") {
      const request = await get(
        `SELECT status, requester_id AS requesterId, recipient_id AS recipientId FROM friend_requests
         WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
        [req.user.id, person.id, person.id, req.user.id]
      );
      people.push({ ...person, friendshipStatus: request?.status || "", requestDirection:
        request?.requesterId === req.user.id ? "outgoing" : request ? "incoming" : "" });
    } else {
      people.push(person);
    }
  }
  res.json({ people });
}));

app.post("/api/community/friends", roles("Student"), asyncRoute(async (req, res) => {
  const other = await get("SELECT * FROM users WHERE id = ? AND role = 'Student' AND is_active = 1", [req.body?.userId]);
  if (!other || !sameCohort(req.user, other)) return sendError(res, 404, "Student is not available in your section.");
  const action = String(req.body?.action || "");
  const existing = await get(
    `SELECT * FROM friend_requests
     WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
    [req.user.id, other.id, other.id, req.user.id]
  );
  if (action === "request") {
    if (existing?.status === "accepted") return sendError(res, 409, "You are already connected.");
    if (existing?.status === "pending") return sendError(res, 409, "A connection request is already pending.");
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO friend_requests (id, requester_id, recipient_id, status)
       VALUES (?, ?, ?, 'pending')
       ON CONFLICT(requester_id, recipient_id) DO UPDATE SET status = 'pending', updated_at = CURRENT_TIMESTAMP`,
      [id, req.user.id, other.id]
    );
    return res.status(201).json({ ok: true });
  }
  if (action === "accept" || action === "decline") {
    if (!existing || existing.recipient_id !== req.user.id || existing.status !== "pending") {
      return sendError(res, 404, "Pending connection request not found.");
    }
    await run("UPDATE friend_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [action === "accept" ? "accepted" : "declined", existing.id]);
    return res.json({ ok: true });
  }
  if (action === "remove") {
    if (!existing || existing.status !== "accepted") return sendError(res, 404, "Connection not found.");
    await run("UPDATE friend_requests SET status = 'declined', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [existing.id]);
    return res.json({ ok: true });
  }
  return sendError(res, 400, "Choose request, accept, decline, or remove.");
}));

app.get("/api/messages", authRequired, asyncRoute(async (req, res) => {
  const otherId = String(req.query.with || "");
  if (otherId) {
    const other = await get("SELECT * FROM users WHERE id = ?", [otherId]);
    if (!await canMessage(req.user, other)) return sendError(res, 404, "Conversation not found.");
    await run(
      "UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
      [otherId, req.user.id]
    );
    const messages = await all(
      `SELECT id, sender_id AS senderId, recipient_id AS recipientId, body,
        created_at AS createdAt, read_at AS readAt
       FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at`,
      [req.user.id, otherId, otherId, req.user.id]
    );
    return res.json({ messages, person: { id: other.id, name: other.name, role: other.role } });
  }
  const rows = await all(
    `SELECT u.id, u.name, u.role, MAX(m.created_at) AS lastMessageAt,
      (SELECT body FROM messages latest
       WHERE ((latest.sender_id = ? AND latest.recipient_id = u.id) OR (latest.sender_id = u.id AND latest.recipient_id = ?))
       ORDER BY latest.created_at DESC LIMIT 1) AS lastMessage,
      (SELECT count(*) FROM messages unread WHERE unread.sender_id = u.id AND unread.recipient_id = ? AND unread.read_at IS NULL) AS unread
     FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
     WHERE (m.sender_id = ? OR m.recipient_id = ?) AND u.is_active = 1
     GROUP BY u.id ORDER BY lastMessageAt DESC`,
    [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
  );
  const conversations = [];
  for (const person of rows) {
    if (await canMessage(req.user, await get("SELECT * FROM users WHERE id = ?", [person.id]))) conversations.push(person);
  }
  res.json({ conversations });
}));

app.post("/api/messages", authRequired, asyncRoute(async (req, res) => {
  const otherId = String(req.body?.toUserId || "");
  const recipient = await get("SELECT * FROM users WHERE id = ?", [otherId]);
  if (!await canMessage(req.user, recipient)) return sendError(res, 404, "Recipient is not available for messaging.");
  const body = validateText(req.body?.body, "Message", 2000);
  const id = crypto.randomUUID();
  await run("INSERT INTO messages (id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)",
    [id, req.user.id, recipient.id, body]);
  res.status(201).json({ id });
}));

app.get("/api/structure", authRequired, asyncRoute(async (_req, res) => {
  const [departments, strands, grades, sections, settings] = await Promise.all([
    all("SELECT id, name FROM departments ORDER BY name"),
    all("SELECT id, name FROM strands ORDER BY name"),
    all("SELECT id, name FROM grades ORDER BY name"),
    all("SELECT id, name, department, strand, grade FROM sections ORDER BY grade, strand, name"),
    all("SELECT key, value FROM app_settings")
  ]);
  res.json({ departments, strands, grades, sections, settings: Object.fromEntries(settings.map(({ key, value }) => [key, value])) });
}));

app.post("/api/structure/:type", roles("Admin"), asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!ALLOWED_STRUCTURE.has(type)) return sendError(res, 404, "Unknown structure type.");
  if (type === "sections") {
    const name = validateText(req.body?.name, "Section");
    const department = String(req.body?.department || "").trim();
    const strand = String(req.body?.strand || "").trim();
    const grade = String(req.body?.grade || "").trim();
    const id = crypto.randomUUID();
    await run("INSERT INTO sections (id, name, department, strand, grade) VALUES (?, ?, ?, ?, ?)", [id, name, department, strand, grade]);
    return res.status(201).json({ section: { id, name, department, strand, grade } });
  }
  const name = validateText(req.body?.name, "Name");
  const id = crypto.randomUUID();
  await run(`INSERT INTO ${type} (id, name) VALUES (?, ?)`, [id, name]);
  res.status(201).json({ item: { id, name } });
}));

app.delete("/api/structure/:type/:id", roles("Admin"), asyncRoute(async (req, res) => {
  if (!ALLOWED_STRUCTURE.has(req.params.type)) return sendError(res, 404, "Unknown structure type.");
  await run(`DELETE FROM ${req.params.type} WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
}));

app.patch("/api/structure/:type/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const { type, id } = req.params;
  if (!ALLOWED_STRUCTURE.has(type)) return sendError(res, 404, "Unknown structure type.");
  const name = validateText(req.body?.name, "Name");
  if (type === "sections") {
    const previous = await get("SELECT * FROM sections WHERE id = ?", [id]);
    if (!previous) return sendError(res, 404, "Section not found.");
    await run(
      "UPDATE sections SET name = ?, department = ?, strand = ?, grade = ? WHERE id = ?",
      [name, String(req.body?.department || ""), String(req.body?.strand || ""), String(req.body?.grade || ""), id]
    );
    await run(
      "UPDATE users SET section = ?, department = ?, strand = ?, grade = ? WHERE section = ? AND department = ? AND strand = ? AND grade = ?",
      [name, String(req.body?.department || ""), String(req.body?.strand || ""), String(req.body?.grade || ""),
        previous.name, previous.department, previous.strand, previous.grade]
    );
  } else {
    const previous = await get(`SELECT name FROM ${type} WHERE id = ?`, [id]);
    if (!previous) return sendError(res, 404, "School structure item not found.");
    await run(`UPDATE ${type} SET name = ? WHERE id = ?`, [name, id]);
    const userField = { departments: "department", strands: "strand", grades: "grade" }[type];
    await run(`UPDATE users SET ${userField} = ? WHERE ${userField} = ?`, [name, previous.name]);
    const sectionField = { departments: "department", strands: "strand", grades: "grade" }[type];
    await run(`UPDATE sections SET ${sectionField} = ? WHERE ${sectionField} = ?`, [name, previous.name]);
  }
  res.json({ ok: true });
}));

app.put("/api/settings", roles("Admin"), asyncRoute(async (req, res) => {
  const { morningClose, afternoonClose, morningLateAfter, afternoonLateAfter, sessionHours } = req.body || {};
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if ([morningClose, afternoonClose, morningLateAfter, afternoonLateAfter].some((value) => value && !timePattern.test(value))) {
    return sendError(res, 400, "Attendance schedule times must use 24-hour HH:MM format.");
  }
  if (morningClose && afternoonClose && afternoonClose <= morningClose) {
    return sendError(res, 400, "Afternoon closing time must be after morning closing time.");
  }
  const savedSchedule = Object.fromEntries((await all(
    "SELECT key, value FROM app_settings WHERE key IN ('morningClose','afternoonClose','morningLateAfter','afternoonLateAfter')"
  )).map(({ key, value }) => [key, value]));
  const effective = { ...savedSchedule, morningClose, afternoonClose, morningLateAfter, afternoonLateAfter };
  if ((effective.morningLateAfter && effective.morningClose && effective.morningLateAfter >= effective.morningClose)
    || (effective.afternoonLateAfter && effective.afternoonClose && effective.afternoonLateAfter >= effective.afternoonClose)) {
    return sendError(res, 400, "Late thresholds must be before their session closing times.");
  }
  if (sessionHours !== undefined && (!/^\d+$/.test(String(sessionHours)) || Number(sessionHours) < 1 || Number(sessionHours) > 24)) {
    return sendError(res, 400, "Session duration must be from 1 to 24 hours.");
  }
  for (const [key, value] of Object.entries({ morningClose, afternoonClose, morningLateAfter, afternoonLateAfter, sessionHours })) {
    if (value !== undefined) await run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }
  await archiveClosedSessions();
  scheduleAttendanceArchive();
  res.json({ ok: true });
}));

app.get("/api/students", authRequired, asyncRoute(async (req, res) => {
  const scope = studentScope(req.user);
  const search = String(req.query.search || "").trim().toLowerCase();
  const dateOfBirthColumn = req.user.role === "Admin" ? ", u.dob AS dateOfBirth" : "";
  const rows = await all(
    `SELECT u.id, u.student_id AS studentId, u.name, u.department, u.strand, u.grade, u.section, u.is_active AS isActive${dateOfBirthColumn}
     FROM users u WHERE u.role = 'Student' AND (${scope.sql})
     AND (? = '' OR lower(u.name || ' ' || u.student_id || ' ' || coalesce(u.section,'')) LIKE ?)
     ORDER BY u.name COLLATE NOCASE`,
    [...scope.params, search, `%${search}%`]
  );
  res.json({ students: rows });
}));

app.post("/api/students", roles("Admin"), asyncRoute(async (req, res) => {
  const name = validateText(req.body?.name, "Student name");
  const studentId = validateText(req.body?.studentId, "Student ID", 50);
  const password = String(req.body?.password || randomPassword());
  if (password.length < 10) return sendError(res, 400, "Password must be at least 10 characters.");
  const id = crypto.randomUUID();
  const qrToken = crypto.randomUUID();
  await run(
    `INSERT INTO users (id, username, password_hash, role, name, student_id, dob, department, strand, grade, section, qr_token)
     VALUES (?, ?, ?, 'Student', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, studentId, hashPassword(password), name, studentId, req.body?.dateOfBirth || null,
      req.body?.department || "", req.body?.strand || "", req.body?.grade || "", req.body?.section || "", qrToken]
  );
  res.status(201).json({ student: { id, studentId, name }, initialPassword: password });
}));

app.post("/api/students/bulk", roles("Admin"), asyncRoute(async (req, res) => {
  const rows = req.body?.students;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    return sendError(res, 400, "Upload between 1 and 100 student rows at a time.");
  }
  const created = [];
  const rejected = [];
  for (const [index, row] of rows.entries()) {
    try {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw Object.assign(new Error("Invalid row."), { status: 400 });
      const name = validateText(row.name, "Name");
      const studentId = validateText(row.studentId, "Student ID", 50);
      const password = String(row.password || randomPassword());
      if (password.length < 10) throw Object.assign(new Error("Password must be at least 10 characters."), { status: 400 });
      const dateOfBirth = String(row.dateOfBirth || "");
      if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
        throw Object.assign(new Error("Date of birth must use YYYY-MM-DD format."), { status: 400 });
      }
      const id = crypto.randomUUID();
      await run(
        `INSERT INTO users (id, username, password_hash, role, name, student_id, dob, department, strand, grade, section, qr_token)
         VALUES (?, ?, ?, 'Student', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, studentId, hashPassword(password), name, studentId, dateOfBirth || null,
          String(row.department || "").trim().slice(0, 120), String(row.strand || "").trim().slice(0, 120),
          String(row.grade || "").trim().slice(0, 40), String(row.section || "").trim().slice(0, 120), crypto.randomUUID()]
      );
      created.push({ id, name, studentId, initialPassword: password });
    } catch (error) {
      if (error.code && error.code !== "SQLITE_CONSTRAINT") throw error;
      rejected.push({ row: index + 2, studentId: String(row?.studentId || ""), error: error.code ? "Student ID already exists." : error.message });
    }
  }
  res.status(201).json({ created, rejected });
}));

app.post("/api/students/:id/reset-password", roles("Admin"), asyncRoute(async (req, res) => {
  const student = await get("SELECT id FROM users WHERE id = ? AND role = 'Student'", [req.params.id]);
  if (!student) return sendError(res, 404, "Student not found.");
  const password = String(req.body?.password || randomPassword());
  if (password.length < 10) return sendError(res, 400, "Password must be at least 10 characters.");
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), student.id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [student.id]);
  res.json({ initialPassword: password });
}));

app.patch("/api/students/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const student = await get("SELECT * FROM users WHERE id = ? AND role = 'Student'", [req.params.id]);
  if (!student) return sendError(res, 404, "Student not found.");
  const fields = ["name", "studentId", "dateOfBirth", "department", "strand", "grade", "section", "isActive"];
  const values = fields.map((field) => req.body?.[field] === undefined ? ({
    name: student.name, studentId: student.student_id, dateOfBirth: student.dob,
    department: student.department, strand: student.strand, grade: student.grade,
    section: student.section, isActive: student.is_active
  })[field] : req.body[field]);
  await run(
    `UPDATE users SET name=?, student_id=?, username=?, dob=?, department=?, strand=?, grade=?, section=?, is_active=? WHERE id=?`,
    [String(values[0]).trim(), String(values[1]).trim(), String(values[1]).trim(), values[2] || null,
      values[3] || "", values[4] || "", values[5] || "", values[6] || "", values[7] ? 1 : 0, student.id]
  );
  res.json({ ok: true });
}));

app.post("/api/accounts", roles("Admin"), asyncRoute(async (req, res) => {
  const role = String(req.body?.role || "");
  if (!["Admin", "Teacher", "SSG"].includes(role)) return sendError(res, 400, "Choose an administrator, teacher, or SSG account.");
  const name = validateText(req.body?.name, "Name");
  const username = validateText(req.body?.username, "Account ID", 50);
  const password = String(req.body?.password || randomPassword());
  if (password.length < 10) return sendError(res, 400, "Password must be at least 10 characters.");
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO users (id, username, password_hash, role, name, department, strand, grade, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, username, hashPassword(password), role, name, req.body?.department || "",
      req.body?.strand || "", req.body?.grade || "", req.body?.section || ""]
  );
  res.status(201).json({ account: { id, username, role, name }, initialPassword: password });
}));

app.get("/api/accounts", roles("Admin"), asyncRoute(async (_req, res) => {
  const accounts = await all(
    `SELECT id, username, role, name, department, strand, grade, section, is_active AS isActive, created_at AS createdAt
     FROM users WHERE role != 'Student' ORDER BY role, name COLLATE NOCASE`
  );
  res.json({ accounts });
}));

app.patch("/api/accounts/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const active = req.body?.isActive;
  if (typeof active === "boolean") {
    if (req.params.id === req.user.id && !active) return sendError(res, 400, "You cannot disable your own account.");
    await run("UPDATE users SET is_active = ? WHERE id = ? AND role != 'Student'", [active ? 1 : 0, req.params.id]);
    if (!active) await run("DELETE FROM sessions WHERE user_id = ?", [req.params.id]);
    return res.json({ ok: true });
  }
  const account = await get("SELECT * FROM users WHERE id = ? AND role != 'Student'", [req.params.id]);
  if (!account) return sendError(res, 404, "Staff account not found.");
  const name = req.body?.name === undefined ? account.name : validateText(req.body.name, "Name");
  const department = req.body?.department === undefined ? account.department : String(req.body.department).trim();
  const strand = req.body?.strand === undefined ? account.strand : String(req.body.strand).trim();
  const grade = req.body?.grade === undefined ? account.grade : String(req.body.grade).trim();
  const section = req.body?.section === undefined ? account.section : String(req.body.section).trim();
  await run("UPDATE users SET name=?, department=?, strand=?, grade=?, section=? WHERE id=?", [
    name, department || "", strand || "", grade || "", section || "", req.params.id
  ]);
  res.json({ ok: true });
}));

app.get("/api/attendance", authRequired, asyncRoute(async (req, res) => {
  const date = String(req.query.date || schoolDate());
  const session = String(req.query.session || "");
  const scope = studentScope(req.user);
  const records = req.user.role === "Student"
    ? await all(
      `SELECT a.id, a.student_id AS studentId, u.student_id AS schoolId, u.name, u.department, u.strand, u.grade, u.section,
        a.date, a.session, a.status, a.time_in AS timeIn, a.time_out AS timeOut, a.source
       FROM attendance a JOIN users u ON u.id = a.student_id WHERE ${scope.sql}
       ORDER BY a.date DESC, a.session`,
      scope.params
    )
    : session
      ? await all(
        `SELECT a.id, u.id AS studentId, u.student_id AS schoolId, u.name, u.department, u.strand, u.grade, u.section,
          ? AS date, ? AS session, COALESCE(a.status, 'Absent') AS status, a.time_in AS timeIn,
          a.time_out AS timeOut, a.source
         FROM users u LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ? AND a.session = ?
         WHERE u.role = 'Student' AND u.is_active = 1 AND ${scope.sql}
         ORDER BY u.section, u.name COLLATE NOCASE`,
        [date, session, date, session, ...scope.params]
      )
      : await all(
        `SELECT a.id, a.student_id AS studentId, u.student_id AS schoolId, u.name, u.department, u.strand, u.grade, u.section,
          a.date, a.session, a.status, a.time_in AS timeIn, a.time_out AS timeOut, a.source
         FROM attendance a JOIN users u ON u.id = a.student_id
         WHERE a.date = ? AND ${scope.sql} ORDER BY a.session, u.name COLLATE NOCASE`,
        [date, ...scope.params]
      );
  res.json({ records });
}));

async function currentSession() {
  const rows = await all("SELECT key, value FROM app_settings WHERE key IN ('morningClose','afternoonClose','morningLateAfter','afternoonLateAfter')");
  const settings = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  const time = schoolTime();
  const morningClose = settings.morningClose || "13:00";
  const afternoonClose = settings.afternoonClose || "17:00";
  const session = time < morningClose ? "Morning" : time < afternoonClose ? "Afternoon" : null;
  return { session, settings };
}

app.post("/api/attendance/check-in", authRequired, asyncRoute(async (req, res) => {
  const identifier = String(req.body?.studentId || req.body?.qrToken || "").trim();
  const date = String(req.body?.date || schoolDate());
  const session = String(req.body?.session || (await currentSession()).session);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["Morning", "Afternoon"].includes(session)) {
    return sendError(res, 400, "Choose a valid attendance date and session.");
  }
  const student = await findStudent(identifier);
  if (!student || !ensureStudentScope(req, student)) return sendError(res, 404, "Student not found in your authorized sections.");
  if (req.user.role === "Student" && req.user.id !== student.id) return sendError(res, 403, "You can only record your own attendance.");
  const today = schoolDate();
  const active = await currentSession();
  if (req.user.role !== "Admin" && (!active.session || date !== today || session !== active.session)) {
    return sendError(res, 409, "The selected attendance session is closed.");
  }
  const timestamp = new Date().toISOString();
  const requestedStatus = String(req.body?.status || "");
  const lateAfter = active.settings[session === "Morning" ? "morningLateAfter" : "afternoonLateAfter"] || (session === "Morning" ? "08:15" : "13:15");
  const automaticStatus = schoolTime() >= lateAfter ? "Late" : "Present";
  const status = req.user.role !== "Student" && ["Present", "Late", "Absent"].includes(requestedStatus)
    ? requestedStatus
    : automaticStatus;
  const id = crypto.randomUUID();
  await run(
    "INSERT INTO attendance (id, student_id, date, session, status, time_in, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, student.id, date, session, status, status === "Absent" ? null : timestamp, req.body?.qrToken ? "QR scan" : "Manual"]
  );
  res.status(201).json({ record: { id, studentId: student.id, schoolId: student.student_id, name: student.name, date, session, status, timeIn: status === "Absent" ? null : timestamp } });
}));

app.post("/api/attendance/mark", roles("Admin", "Teacher"), asyncRoute(async (req, res) => {
  const student = await findStudent(String(req.body?.studentId || "").trim());
  const date = String(req.body?.date || schoolDate());
  const session = String(req.body?.session || "");
  const status = String(req.body?.status || "");
  if (!student || !ensureStudentScope(req, student)) return sendError(res, 404, "Student not found in your authorized sections.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["Morning", "Afternoon"].includes(session) || !["Present", "Absent", "Late"].includes(status)) {
    return sendError(res, 400, "Provide a valid date, session, and attendance status.");
  }
  const active = await currentSession();
  if (req.user.role !== "Admin" && (date !== schoolDate() || session !== active.session)) {
    return sendError(res, 409, "The selected attendance session is closed.");
  }
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO attendance (id, student_id, date, session, status, time_in, source)
     VALUES (?, ?, ?, ?, ?, ?, 'Manual')
     ON CONFLICT(student_id, date, session) DO UPDATE SET status = excluded.status,
       time_in = CASE WHEN excluded.status = 'Absent' THEN NULL ELSE COALESCE(attendance.time_in, excluded.time_in) END`,
    [id, student.id, date, session, status, status === "Absent" ? null : timestamp]
  );
  const record = await get(
    "SELECT id, date, session, status, time_in AS timeIn FROM attendance WHERE student_id = ? AND date = ? AND session = ?",
    [student.id, date, session]
  );
  res.json({ record });
}));

app.patch("/api/attendance/:id", roles("Admin", "Teacher"), asyncRoute(async (req, res) => {
  const status = String(req.body?.status || "");
  if (!["Present", "Absent", "Late"].includes(status)) return sendError(res, 400, "Choose Present, Absent, or Late.");
  const record = await get(
    "SELECT attendance.id, users.* FROM attendance JOIN users ON users.id = attendance.student_id WHERE attendance.id = ?",
    [req.params.id]
  );
  if (!record || !ensureStudentScope(req, record)) return sendError(res, 404, "Attendance record not found in your authorized sections.");
  await run("UPDATE attendance SET status = ? WHERE id = ?", [status, req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/attendance/:id/time-out", authRequired, asyncRoute(async (req, res) => {
  const record = await get("SELECT * FROM attendance WHERE id = ?", [req.params.id]);
  if (!record) return sendError(res, 404, "Attendance record not found.");
  if (req.user.role === "Student" && record.student_id !== req.user.id) return sendError(res, 403, "You can only update your own attendance.");
  const student = await get("SELECT * FROM users WHERE id = ?", [record.student_id]);
  if (!ensureStudentScope(req, student)) return sendError(res, 403, "This student is outside your assigned sections.");
  if (record.time_out) return sendError(res, 409, "Time out has already been recorded.");
  const timeOut = new Date().toISOString();
  await run("UPDATE attendance SET time_out = ? WHERE id = ?", [timeOut, record.id]);
  res.json({ timeOut });
}));

app.get("/api/dashboard", authRequired, asyncRoute(async (req, res) => {
  const date = schoolDate();
  const scope = studentScope(req.user);
  const students = await get(`SELECT count(*) AS total FROM users u WHERE u.role = 'Student' AND u.is_active = 1 AND (${scope.sql})`, scope.params);
  const records = await all(
    `SELECT CASE WHEN max(a.status = 'Present') THEN 'Present'
      WHEN max(a.status = 'Late') THEN 'Late' ELSE 'Absent' END AS status, count(*) AS count
     FROM attendance a JOIN users u ON u.id = a.student_id
     WHERE a.date = ? AND (${scope.sql}) GROUP BY a.student_id`,
    [date, ...scope.params]
  );
  const totals = { Present: 0, Absent: 0, Late: 0 };
  records.forEach((record) => { totals[record.status] = record.count; });
  totals.Absent = Math.max(0, students.total - totals.Present - totals.Late);
  const attendance = await all(
    `SELECT a.id, a.student_id AS studentId, u.name, u.section, a.date, a.session, a.status, a.time_in AS timeIn
     FROM attendance a JOIN users u ON u.id = a.student_id WHERE (${scope.sql})
     ORDER BY a.time_in DESC LIMIT 8`,
    scope.params
  );
  const events = await all(
    `SELECT e.id, e.title, e.description, e.location, e.start_at AS startAt, e.end_at AS endAt,
     e.poster, e.leader_id AS leaderId, leader.name AS leaderName
     FROM events e LEFT JOIN users leader ON leader.id = e.leader_id
     WHERE e.published = 1 ORDER BY e.start_at LIMIT 6`
  );
  const aggregate = async (field) => all(
    `SELECT COALESCE(NULLIF(u.${field}, ''), 'Unassigned') AS name, count(DISTINCT u.id) AS total,
      count(DISTINCT CASE WHEN a.status IN ('Present','Late') THEN u.id END) AS present
     FROM users u LEFT JOIN attendance a ON a.student_id = u.id AND a.date = ?
     WHERE u.role = 'Student' AND u.is_active = 1 AND (${scope.sql})
     GROUP BY COALESCE(NULLIF(u.${field}, ''), 'Unassigned') ORDER BY name`,
    [date, ...scope.params]
  );
  const [departmentOverview, strandOverview, sectionOverview] = await Promise.all([
    aggregate("department"), aggregate("strand"), aggregate("section")
  ]);
  res.json({
    date, students: students.total, totals, attendance, events, departmentOverview, strandOverview, sectionOverview,
    percentage: students.total ? Math.round((totals.Present + totals.Late) / students.total * 100) : 0
  });
}));

app.get("/api/events", authRequired, asyncRoute(async (req, res) => {
  const events = await all(
    `SELECT e.id, e.title, e.description, e.location, e.start_at AS startAt, e.end_at AS endAt,
      e.poster, e.leader_id AS leaderId, e.leader_expires_at AS leaderExpiresAt, leader.name AS leaderName, e.published,
      (SELECT count(*) FROM event_attendance ea WHERE ea.event_id = e.id) AS attendeeCount,
      EXISTS (SELECT 1 FROM event_attendance mine WHERE mine.event_id = e.id AND mine.student_id = ?) AS attended
     FROM events e LEFT JOIN users leader ON leader.id = e.leader_id
     WHERE e.published = 1 OR ? = 'Admin' OR e.leader_id = ?
     ORDER BY e.start_at`,
    [req.user.id, req.user.role, req.user.id]
  );
  res.json({ events });
}));

app.post("/api/events", roles("Admin"), asyncRoute(async (req, res) => {
  const title = validateText(req.body?.title, "Event title");
  const startAt = validateText(req.body?.startAt, "Event date");
  if (Number.isNaN(Date.parse(startAt))) return sendError(res, 400, "Enter a valid event start date.");
  if (req.body?.endAt && (Number.isNaN(Date.parse(req.body.endAt)) || Date.parse(req.body.endAt) < Date.parse(startAt))) {
    return sendError(res, 400, "Event end date must be after the start date.");
  }
  if (req.body?.leaderExpiresAt && Number.isNaN(Date.parse(req.body.leaderExpiresAt))) {
    return sendError(res, 400, "Enter a valid temporary access expiration.");
  }
  if (req.body?.leaderId) {
    const leader = await get("SELECT id FROM users WHERE id = ? AND role IN ('Teacher','SSG') AND is_active = 1", [req.body.leaderId]);
    if (!leader) return sendError(res, 400, "Choose an enabled teacher or SSG account as event leader.");
    if (!req.body.leaderExpiresAt) return sendError(res, 400, "Set an expiration date for temporary event leader access.");
  }
  const id = crypto.randomUUID();
  const poster = req.body?.poster;
  if (poster && (typeof poster !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(poster) || poster.length > 5 * 1024 * 1024)) {
    return sendError(res, 400, "Event image must be PNG, JPEG, GIF, or WebP and no larger than 3 MB.");
  }
  await run(
    `INSERT INTO events (id, title, description, location, start_at, end_at, poster, leader_id, leader_expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, String(req.body?.description || "").slice(0, 3000), String(req.body?.location || "").slice(0, 160),
      startAt, req.body?.endAt || null, poster || null, req.body?.leaderId || null, req.body?.leaderExpiresAt || null, req.user.id]
  );
  res.status(201).json({ id });
}));

app.patch("/api/events/:id", roles("Admin"), asyncRoute(async (req, res) => {
  const published = req.body?.published;
  if (typeof published === "boolean") {
    await run("UPDATE events SET published = ? WHERE id = ?", [published ? 1 : 0, req.params.id]);
    return res.json({ ok: true });
  }
  const event = await get("SELECT * FROM events WHERE id = ?", [req.params.id]);
  if (!event) return sendError(res, 404, "Event not found.");
  const title = req.body?.title === undefined ? event.title : validateText(req.body.title, "Event title");
  const startAt = req.body?.startAt === undefined ? event.start_at : validateText(req.body.startAt, "Event start date");
  if (Number.isNaN(Date.parse(startAt))) return sendError(res, 400, "Enter a valid event start date.");
  if (req.body?.leaderId) {
    const leader = await get("SELECT id FROM users WHERE id = ? AND role IN ('Teacher','SSG') AND is_active = 1", [req.body.leaderId]);
    if (!leader || !req.body.leaderExpiresAt) return sendError(res, 400, "Select an enabled teacher or SSG leader and set an access expiration.");
  }
  const poster = req.body?.poster;
  if (poster && (typeof poster !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(poster) || poster.length > 5 * 1024 * 1024)) {
    return sendError(res, 400, "Event image must be PNG, JPEG, GIF, or WebP and no larger than 3 MB.");
  }
  await run(
    `UPDATE events SET title=?, description=?, location=?, start_at=?, end_at=?, poster=?, leader_id=?, leader_expires_at=? WHERE id=?`,
    [title, String(req.body?.description ?? event.description).slice(0, 3000),
      String(req.body?.location ?? event.location).slice(0, 160), startAt,
      req.body?.endAt === undefined ? event.end_at : req.body.endAt || null,
      poster || event.poster, req.body?.leaderId === undefined ? event.leader_id : req.body.leaderId || null,
      req.body?.leaderExpiresAt === undefined ? event.leader_expires_at : req.body.leaderExpiresAt || null, req.params.id]
  );
  res.json({ ok: true });
}));

app.get("/api/events/:id/attendance", authRequired, asyncRoute(async (req, res) => {
  const event = await get("SELECT * FROM events WHERE id = ?", [req.params.id]);
  if (!event) return sendError(res, 404, "Event not found.");
  if (req.user.role === "Student" && event.published) {
    const ownRecord = await get("SELECT scanned_at AS scannedAt FROM event_attendance WHERE event_id = ? AND student_id = ?", [event.id, req.user.id]);
    return res.json({ records: ownRecord ? [{ studentId: req.user.id, scannedAt: ownRecord.scannedAt }] : [] });
  }
  if (req.user.role !== "Admin" && (req.user.id !== event.leader_id || (event.leader_expires_at && event.leader_expires_at < new Date().toISOString()))) {
    return sendError(res, 403, "You are not assigned to manage this event.");
  }
  const records = await all(
    `SELECT ea.student_id AS studentId, u.student_id AS schoolId, u.name, u.strand, u.grade, u.section, ea.scanned_at AS scannedAt
     FROM event_attendance ea JOIN users u ON u.id = ea.student_id
     WHERE ea.event_id = ? ORDER BY ea.scanned_at DESC`,
    [req.params.id]
  );
  res.json({ records });
}));

app.post("/api/events/:id/attendance", roles("Admin", "Teacher", "SSG"), asyncRoute(async (req, res) => {
  const event = await get("SELECT * FROM events WHERE id = ?", [req.params.id]);
  if (!event) return sendError(res, 404, "Event not found.");
  if (req.user.role !== "Admin" && (req.user.id !== event.leader_id || (event.leader_expires_at && event.leader_expires_at < new Date().toISOString()))) {
    return sendError(res, 403, "You are not assigned to manage this event or your temporary access has expired.");
  }
  const student = await findStudent(String(req.body?.studentId || req.body?.qrToken || "").trim());
  if (!student || !ensureStudentScope(req, student)) return sendError(res, 404, "Student not found in your authorized sections.");
  const scannedAt = new Date().toISOString();
  await run("INSERT INTO event_attendance (event_id, student_id, scanned_at) VALUES (?, ?, ?)", [event.id, student.id, scannedAt]);
  res.status(201).json({ student: { id: student.id, name: student.name, studentId: student.student_id }, scannedAt });
}));

app.get("/api/events/:id/qr", authRequired, asyncRoute(async (req, res) => {
  const event = await get("SELECT id, leader_id FROM events WHERE id = ?", [req.params.id]);
  if (!event) return sendError(res, 404, "Event not found.");
  const dataUrl = await QRCode.toDataURL(`STI-EVENT:${event.id}`, { width: 240, margin: 2, color: { dark: "#123d75", light: "#ffffff" } });
  res.json({ dataUrl });
}));

app.get("/api/students/:id/qr", authRequired, asyncRoute(async (req, res) => {
  const student = await get("SELECT * FROM users WHERE id = ? AND role = 'Student' AND is_active = 1", [req.params.id]);
  if (!ensureStudentScope(req, student)) return sendError(res, 404, "Student not found.");
  const dataUrl = await QRCode.toDataURL(student.qr_token, { width: 240, margin: 2, color: { dark: "#123d75", light: "#ffffff" } });
  res.json({ dataUrl });
}));

app.use(express.static(ROOT_DIR));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const duplicate = String(error.code || "").startsWith("SQLITE_CONSTRAINT");
  const status = error.status || (duplicate ? 409 : 500);
  const message = duplicate ? "This record already exists or conflicts with an existing record." : error.message;
  res.status(status).json({ error: status === 500 ? "The request could not be completed." : message });
});

async function archiveClosedSessions() {
  const { settings } = await currentSession();
  const date = schoolDate();
  const time = schoolTime();
  for (const [session, closeTime] of [
    ["Morning", settings.morningClose || "13:00"],
    ["Afternoon", settings.afternoonClose || "17:00"]
  ]) {
    if (time < closeTime) continue;
    const archiveKey = `attendance-archived:${date}:${session}`;
    if (await get("SELECT value FROM app_settings WHERE key = ?", [archiveKey])) continue;
    await run(
      `INSERT OR IGNORE INTO attendance (id, student_id, date, session, status, time_in, source)
       SELECT lower(hex(randomblob(16))), students.id, ?, ?, 'Absent', NULL, 'Session archive'
       FROM users students WHERE students.role = 'Student' AND students.is_active = 1
       AND NOT EXISTS (
         SELECT 1 FROM attendance records
         WHERE records.student_id = students.id AND records.date = ? AND records.session = ?
       )`,
      [date, session, date, session]
    );
    await run("INSERT INTO app_settings (key, value) VALUES (?, 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'", [archiveKey]);
  }
}

function scheduleAttendanceArchive() {
  clearTimeout(archiveTimer);
  const now = Date.now();
  const tomorrow = schoolDate(new Date(now + 24 * 60 * 60 * 1000));
  void all("SELECT key, value FROM app_settings WHERE key IN ('morningClose','afternoonClose')").then((rows) => {
    const times = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
    const today = schoolDate();
    const targets = [
      new Date(`${today}T${times.morningClose || "13:00"}:00+08:00`),
      new Date(`${today}T${times.afternoonClose || "17:00"}:00+08:00`),
      new Date(`${tomorrow}T${times.morningClose || "13:00"}:00+08:00`)
    ].filter((date) => date.getTime() > now).sort((first, second) => first - second);
    const next = targets[0] || new Date(`${tomorrow}T13:00:00+08:00`);
    archiveTimer = setTimeout(async () => {
      try {
        await archiveClosedSessions();
      } catch (error) {
        console.error("Failed to archive the closed attendance session:", error);
      }
      scheduleAttendanceArchive();
    }, Math.max(100, next.getTime() - now));
    archiveTimer.unref();
  }).catch((error) => console.error("Failed to schedule attendance archival:", error));
}

createSchema()
  .then(async () => {
    await archiveClosedSessions();
    scheduleAttendanceArchive();
    app.listen(PORT, () => {
      console.log(`STI Attendance Management System running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize attendance database:", error);
    process.exit(1);
  });
