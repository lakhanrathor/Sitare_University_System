/**
 * Resets every collection and creates exactly one admin account — a clean
 * slate for building the ERP up for real, through the app's own Admin UI
 * (Admin -> People, Academics, Manage Timetable), with no synthetic
 * students, faculty, subjects or timetable sitting in the way.
 *
 * This still fully wipes the database first, which is what makes it a
 * dev/staging tool only — never run this against a database holding real
 * people. Adding an admin to a database that must not be touched otherwise
 * is what create-admin.mjs (in server/) is for.
 *
 * Run:  npm run seed
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import User from '../models/User.js';
import Section from '../models/Section.js';
import Subject from '../models/Subject.js';
import Enrollment from '../models/Enrollment.js';
import ClassSession from '../models/ClassSession.js';
import Attendance from '../models/Attendance.js';
import Timetable from '../models/Timetable.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ScheduleChange from '../models/ScheduleChange.js';
import SwapRequest from '../models/SwapRequest.js';
import Notification from '../models/Notification.js';

async function seed() {
  await mongoose.connect(env.mongoUri);
  console.log(`[seed] Connected to ${mongoose.connection.name}`);

  await Promise.all([
    Attendance.deleteMany({}),
    ClassSession.deleteMany({}),
    Enrollment.deleteMany({}),
    Subject.deleteMany({}),
    User.deleteMany({}),
    Section.deleteMany({}),
    Timetable.deleteMany({}),
    TimetableEntry.deleteMany({}),
    ScheduleChange.deleteMany({}),
    SwapRequest.deleteMany({}),
    Notification.deleteMany({}),
  ]);
  /*
   * Not just cosmetic: a stale index from an older schema version (e.g. a
   * single-field unique index on Subject.code, from before it became
   * unique-per-section) would silently reject an admin reusing a course
   * code across two sections later, through the Admin UI — long after this
   * script has finished. Resetting indexes here means whatever the admin
   * builds by hand next matches the current schema, not a leftover one.
   */
  await Promise.all([
    Subject.collection.dropIndexes().catch(() => {}),
    User.collection.dropIndexes().catch(() => {}),
  ]);
  await Promise.all([Subject.syncIndexes(), User.syncIndexes()]);
  console.log('[seed] Cleared existing data');

  const admin = await User.create({
    name: 'System Admin',
    email: 'admin@sitare.org',
    password: 'admin123',
    role: 'admin',
    department: 'Administration',
  });

  console.log('\n──────────────────── LOGIN CREDENTIALS ────────────────────');
  console.log(` Admin    ${admin.email}             admin123`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(
    '\nEverything else starts empty on purpose — sections, faculty, students,\n' +
      'subjects, the timetable. Log in as admin and add them for real, through:\n' +
      '  Admin -> People       (faculty, students, PDF/CSV roster import)\n' +
      '  Admin -> Academics    (sections, subjects, lecturer assignment)\n' +
      '  Admin -> Manage Timetable  (upload/publish a real timetable)\n'
  );

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('[seed] Failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
