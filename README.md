# STI College Attendance Management System

A responsive attendance and event portal backed by SQLite and an authenticated Express API.

## Run locally

1. Install dependencies with `npm install`.
2. Start the server with `npm start`.
3. Open `http://localhost:3000`.

The local demo administrator is `admin` / `admin123`. Set `ADMIN_PASSWORD` before starting the server to choose a different initial password. Existing administrator records are not overwritten on restart.

## Optional demo data

Start the server, then run `npm run seed:demo` from the project folder. This adds sample accounts and records to the current database without deleting existing data. The command is safe to rerun; it verifies existing demo credentials and does not reset them.

If the administrator password was set when the server was created, set the same value before seeding. In PowerShell, use `$env:ADMIN_PASSWORD = "your-admin-password"; npm run seed:demo`. To use another local server URL or port, set `APP_URL` or `PORT`.

The demo credentials are:

| Role | Sign-in ID | Password | Extra |
|---|---|---|---|
| Admin | `admin` | `admin123` by default, or your configured `ADMIN_PASSWORD` | Existing admin account |
| Teacher | `demo-teacher` | `TeacherDemo2026!` | Assigned to the demo STEM section and event |
| SSG | `demo-ssg` | `SsgDemo2026!Pass` | Assigned to the demo STEM section and event |
| Student | `DEMO-STU-1001` | `StudentDemo2026!` | Date of birth: `2008-05-14` |
| Student | `DEMO-STU-1002` | `StudentDemo2026!` | Date of birth: `2008-09-22` |

The seeder adds a sample class section, current-day attendance, two upcoming events with posters and assigned leaders, an announcement, an open support concern, and sample inbox activity. These are public demo credentials and must never be used for real student data or production deployments.

## Features

- Separate Administrator, Teacher, SSG, and Student sign-in, with expiring, HTTP-only sessions and role-checked API routes.
- Administrator-managed student and staff accounts, department/strand/grade/section catalogs, teacher section assignments, and account enable/disable.
- QR-code attendance, duplicate-scan protection, morning and afternoon sessions, time-in/time-out, present/absent/late records, and CSV reports.
- Morning attendance closes at 1:00 PM by default. Session closing times and the authorized session duration can be configured by an administrator. Attendance history is retained.
- School event publishing, leader assignment with temporary access expiry, event QR codes, event check-in, and event poster/photo gallery.
- Campus announcements, private student support concerns with scoped staff replies, and an inbox for authorized contacts. Student-to-student messages require an accepted connection and are limited to the same class section.
- Student and staff self-service display-name updates, password management, an unread notification center, local campus help guide, and quick dashboard shortcuts.
- Administrator CSV roster import (up to 100 rows per upload), duplicate reporting, and one-time temporary credential download.
- Responsive layouts, light/dark mode, scoped student data for teachers and SSG accounts, and a student self-service password reset using student ID and date of birth.
- Existing student roster and attendance values in the former SQLite `app_data` store are imported once during startup; legacy passwords are re-hashed.

## Tests

Run API and authorization tests with `npm test`. Tests use an isolated temporary database.

## Deployment notes

The demo password is for local evaluation only. For deployment, use a unique `ADMIN_PASSWORD`, HTTPS, a protected SQLite backup, and the campus-approved retention and privacy policies. Student date of birth is collected only for the requested account recovery flow. QR values are bearer credentials and should be shared only with the student and authorized attendance staff.
