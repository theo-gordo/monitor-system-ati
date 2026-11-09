const DEMO_ACCOUNTS = {
  teacher: {
    role: "Teacher",
    username: "demo-teacher",
    password: "TeacherDemo2026!",
    name: "Taylor Demo Teacher"
  },
  ssg: {
    role: "SSG",
    username: "demo-ssg",
    password: "SsgDemo2026!Pass",
    name: "Sam Demo SSG"
  },
  students: [
    {
      role: "Student",
      username: "DEMO-STU-1001",
      studentId: "DEMO-STU-1001",
      password: "StudentDemo2026!",
      name: "Alex Demo Student",
      dateOfBirth: "2008-05-14",
      department: "IT Department",
      strand: "STEM",
      grade: "12",
      section: "DEMO-12-STEM"
    },
    {
      role: "Student",
      username: "DEMO-STU-1002",
      studentId: "DEMO-STU-1002",
      password: "StudentDemo2026!",
      name: "Jamie Sample Student",
      dateOfBirth: "2008-09-22",
      department: "IT Department",
      strand: "STEM",
      grade: "12",
      section: "DEMO-12-STEM"
    }
  ]
};

const BASE_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const POSTER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=";

async function api(route, { cookie, method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new Error(`Could not connect to ${BASE_URL}. Start the server first. ${error.message}`);
  }

  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${route} failed (${response.status}): ${payload.error || response.statusText}`);
  }
  return payload;
}

async function login(account) {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role: account.role,
      username: account.username,
      password: account.password
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Could not verify ${account.role} account "${account.username}": ${payload.error || response.statusText}. No existing account was changed.`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Login succeeded for ${account.username}, but the server did not issue a session cookie.`);
  return setCookie.split(";")[0];
}

async function ensureStructure(adminCookie) {
  const structure = await api("/api/structure", { cookie: adminCookie });
  for (const [type, name] of [
    ["departments", "IT Department"],
    ["strands", "STEM"],
    ["grades", "12"]
  ]) {
    if (!structure[type].some((entry) => entry.name === name)) {
      await api(`/api/structure/${type}`, { cookie: adminCookie, method: "POST", body: { name } });
    }
  }

  const refreshed = await api("/api/structure", { cookie: adminCookie });
  if (!refreshed.sections.some((entry) => entry.name === "DEMO-12-STEM")) {
    await api("/api/structure/sections", {
      cookie: adminCookie,
      method: "POST",
      body: {
        name: "DEMO-12-STEM",
        department: "IT Department",
        strand: "STEM",
        grade: "12"
      }
    });
  }
}

async function ensureStaff(adminCookie, account) {
  const { accounts } = await api("/api/accounts", { cookie: adminCookie });
  const existing = accounts.find((entry) => entry.username.toLowerCase() === account.username.toLowerCase());
  if (existing) {
    if (existing.role !== account.role) {
      throw new Error(`Account ID "${account.username}" is already used by a ${existing.role} account. No existing account was changed.`);
    }
    return existing;
  }
  const { account: created } = await api("/api/accounts", {
    cookie: adminCookie,
    method: "POST",
    body: {
      ...account,
      department: "IT Department",
      strand: "STEM",
      grade: "12",
      section: "DEMO-12-STEM"
    }
  });
  return created;
}

async function ensureStudent(adminCookie, student) {
  const roster = await api(`/api/students?search=${encodeURIComponent(student.studentId)}`, { cookie: adminCookie });
  const existing = roster.students.find((entry) => entry.studentId === student.studentId);
  if (existing) return existing;
  const { student: created } = await api("/api/students", {
    cookie: adminCookie,
    method: "POST",
    body: student
  });
  return created;
}

async function ensureEvent(adminCookie, title, leaderId, startAt) {
  const { events } = await api("/api/events", { cookie: adminCookie });
  const existing = events.find((event) => event.title === title);
  if (existing) return existing;
  const { id } = await api("/api/events", {
    cookie: adminCookie,
    method: "POST",
    body: {
      title,
      description: "Sample event created by the optional demo data seeder. Use it to explore event details, QR codes, and attendance.",
      location: "STI College · Demo Room",
      startAt: startAt.toISOString(),
      endAt: new Date(startAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      poster: POSTER,
      leaderId,
      leaderExpiresAt: new Date(startAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    }
  });
  return { id, title };
}

async function ensureAnnouncement(adminCookie) {
  const { announcements } = await api("/api/announcements", { cookie: adminCookie });
  if (announcements.some((item) => item.title === "Welcome to the STI demo portal")) return;
  await api("/api/announcements", {
    cookie: adminCookie,
    method: "POST",
    body: {
      title: "Welcome to the STI demo portal",
      body: "This sample notice was added by the optional demo seeder. Browse the portal using the demo accounts in README.md."
    }
  });
}

async function ensureAttendance(adminCookie, studentIds) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  for (const [index, studentId] of studentIds.entries()) {
    for (const session of ["Morning", "Afternoon"]) {
      const { records } = await api(
        `/api/attendance?date=${encodeURIComponent(date)}&session=${encodeURIComponent(session)}`,
        { cookie: adminCookie }
      );
      const existing = records.find((record) => record.schoolId === studentId);
      if (existing?.id && existing.source !== "Session archive") continue;
      await api("/api/attendance/mark", {
        cookie: adminCookie,
        method: "POST",
        body: {
          studentId,
          date,
          session,
          status: index === 0 ? (session === "Morning" ? "Present" : "Late") : "Present"
        }
      });
    }
  }
}

async function ensureEventAttendance(adminCookie, eventId, studentIds) {
  const { records } = await api(`/api/events/${encodeURIComponent(eventId)}/attendance`, { cookie: adminCookie });
  for (const studentId of studentIds) {
    if (records.some((record) => record.schoolId === studentId)) continue;
    await api(`/api/events/${encodeURIComponent(eventId)}/attendance`, {
      cookie: adminCookie,
      method: "POST",
      body: { studentId }
    });
  }
}

async function ensureCommunitySamples(studentCookies, studentIds, teacherId) {
  const [firstCookie, secondCookie] = studentCookies;
  const [firstId, secondId] = studentIds;
  const firstPeople = await api("/api/community/people", { cookie: firstCookie });
  const firstPeer = firstPeople.people.find((person) => person.id === secondId);
  if (firstPeer?.friendshipStatus !== "accepted") {
    if (firstPeer?.friendshipStatus === "pending" && firstPeer.requestDirection === "incoming") {
      await api("/api/community/friends", {
        cookie: firstCookie,
        method: "POST",
        body: { userId: secondId, action: "accept" }
      });
    } else {
      if (firstPeer?.friendshipStatus !== "pending") {
        await api("/api/community/friends", {
          cookie: firstCookie,
          method: "POST",
          body: { userId: secondId, action: "request" }
        });
      }
      await api("/api/community/friends", {
        cookie: secondCookie,
        method: "POST",
        body: { userId: firstId, action: "accept" }
      });
    }
  }

  const thread = await api(`/api/messages?with=${encodeURIComponent(secondId)}`, { cookie: firstCookie });
  if (!thread.messages.some((message) => message.body === "Hello from the demo student inbox.")) {
    await api("/api/messages", {
      cookie: firstCookie,
      method: "POST",
      body: { toUserId: secondId, body: "Hello from the demo student inbox." }
    });
  }
  const teacherThread = await api(`/api/messages?with=${encodeURIComponent(teacherId)}`, { cookie: firstCookie });
  if (!teacherThread.messages.some((message) => message.body === "Hello, I am testing the student support inbox.")) {
    await api("/api/messages", {
      cookie: firstCookie,
      method: "POST",
      body: { toUserId: teacherId, body: "Hello, I am testing the student support inbox." }
    });
  }

  const concerns = await api("/api/concerns", { cookie: firstCookie });
  if (!concerns.concerns.some((concern) => concern.title === "Demo support request")) {
    await api("/api/concerns", {
      cookie: firstCookie,
      method: "POST",
      body: {
        title: "Demo support request",
        category: "General question",
        description: "Sample concern for demonstrating the student support and staff response workflow."
      }
    });
  }
}

async function main() {
  const health = await api("/api/health");
  if (health.status !== "ready") throw new Error("The attendance API is not ready.");
  const adminCookie = await login({ role: "Admin", username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  await ensureStructure(adminCookie);

  const teacher = await ensureStaff(adminCookie, DEMO_ACCOUNTS.teacher);
  const ssg = await ensureStaff(adminCookie, DEMO_ACCOUNTS.ssg);
  const students = [];
  for (const student of DEMO_ACCOUNTS.students) {
    students.push(await ensureStudent(adminCookie, student));
  }

  const teacherCookie = await login(DEMO_ACCOUNTS.teacher);
  await login(DEMO_ACCOUNTS.ssg);
  const studentCookies = [];
  for (const student of DEMO_ACCOUNTS.students) studentCookies.push(await login(student));

  const now = new Date();
  const firstEvent = await ensureEvent(adminCookie, "Demo STEM Showcase", teacher.id, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  await ensureEvent(adminCookie, "Demo SSG Campus Activity", ssg.id, new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000));
  await ensureAnnouncement(adminCookie);
  await ensureAttendance(adminCookie, students.map((student) => student.studentId));
  await ensureEventAttendance(adminCookie, firstEvent.id, students.map((student) => student.studentId));
  await ensureCommunitySamples(studentCookies, students.map((student) => student.id), teacher.id);
  await api("/api/concerns", { cookie: teacherCookie });

  console.log(`Demo data is ready at ${BASE_URL}. Existing accounts and records were not overwritten.`);
  console.log("\nSign-in accounts:");
  console.log(`Admin    ID: ${ADMIN_USERNAME}  Password: ${process.env.ADMIN_PASSWORD ? "(value provided in ADMIN_PASSWORD)" : ADMIN_PASSWORD}`);
  console.log(`Teacher  ID: ${DEMO_ACCOUNTS.teacher.username}  Password: ${DEMO_ACCOUNTS.teacher.password}`);
  console.log(`SSG      ID: ${DEMO_ACCOUNTS.ssg.username}  Password: ${DEMO_ACCOUNTS.ssg.password}`);
  for (const student of DEMO_ACCOUNTS.students) {
    console.log(`Student  ID: ${student.studentId}  Password: ${student.password}  DOB: ${student.dateOfBirth}`);
  }
  console.log("\nDemo data includes a scoped class section, today's attendance, two led events, an announcement, an open support concern, and sample inbox messages.");
  console.log("The student passwords are public demo credentials. Do not use these accounts or passwords for real student data.");
}

main().catch((error) => {
  console.error(`Demo data setup failed: ${error.message}`);
  process.exitCode = 1;
});
