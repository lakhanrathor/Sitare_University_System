import Subject from '../models/Subject.js';
import Section from '../models/Section.js';
import Enrollment from '../models/Enrollment.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';
import TimetableEntry from '../models/TimetableEntry.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getConductedCounts, getSubjectRoster } from '../services/attendanceService.js';
import { todayKey, dayOfWeek } from '../utils/date.js';
import { getPublishedTimetables } from '../services/timetableService.js';
import { dayName } from '../config/slots.js';

/**
 * Does this faculty member own a per-period override on this subject's live
 * timetable? A subject split by day — "Thursdays belong to Anuja" — is a
 * standing hand-over the timetable itself names, not a one-off stand-in, so
 * it earns the same kind of ongoing access the subject's own lecturer has —
 * just never wider than the periods actually assigned to them.
 */
async function hasFacultyOverride(subjectId, userId) {
  return TimetableEntry.exists({ subject: subjectId, faculty: userId });
}

/** Faculty may only touch their own subjects; admin may touch any. */
export async function assertSubjectAccess(user, subjectId) {
  /*
   * Deliberately NOT populated: callers pass subject.section straight into
   * timetable and enrolment queries, and a populated document will not cast
   * to an ObjectId. Use sectionRef() when the name is what you need.
   */
  const subject = await Subject.findById(subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');
  if (user.role === 'admin') return subject;
  if (user.role === 'faculty' && String(subject.faculty) === String(user._id)) return subject;

  if (user.role === 'faculty' && (await hasFacultyOverride(subject._id, user._id))) return subject;

  throw ApiError.forbidden('You are not assigned to this subject');
}

/**
 * Access to one dated register.
 *
 * A one-off stand-in (AttendanceDelegation) is trusted with the single class
 * they were asked to mark. A recurring per-period override on the timetable
 * is trusted with every class that actually falls on the day and slot it
 * names — ongoing, not one date, because the timetable itself says that
 * period is theirs now. Either way, anything wider than the period(s) it
 * actually covers stays with the subject's own lecturer.
 */
export async function assertRegisterAccess(user, subjectId, dateKey, slot) {
  const subject = await Subject.findById(subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');
  if (user.role === 'admin') return subject;
  if (user.role === 'faculty' && String(subject.faculty) === String(user._id)) return subject;

  if (user.role === 'faculty') {
    const delegated = await AttendanceDelegation.exists({
      subject: subject._id,
      dateKey,
      slot: Number(slot),
      faculty: user._id,
    });
    if (delegated) return subject;

    const overridden = await TimetableEntry.exists({
      subject: subject._id,
      faculty: user._id,
      dayOfWeek: dayOfWeek(dateKey),
      slot: Number(slot),
    });
    if (overridden) return subject;
  }

  throw ApiError.forbidden('You have not been asked to mark this class');
}

/** Every class this lecturer has been asked to mark for somebody else. */
export function delegationsFor(userId) {
  return AttendanceDelegation.find({ faculty: userId }).lean();
}

/**
 * The cohort a subject belongs to, shaped for a response. Every screen that
 * opens a subject shows this, because two offerings of one subject differ by
 * nothing else.
 */
export async function sectionRef(subject) {
  if (!subject?.section) return null;
  const s = await Section.findById(subject.section).select('name').lean();
  return s ? { id: String(s._id), name: s.name } : null;
}

/** Subjects visible to the caller, each with its conducted-class count. */
export const listSubjects = asyncHandler(async (req, res) => {
  const { role, _id } = req.user;
  let subjects;

  /*
   * Classes this lecturer is standing in on. Keyed by subject so the card can
   * say which dates, rather than implying they have taken over the subject.
   */
  const today = todayKey();
  const myDelegations = role === 'faculty' ? await delegationsFor(_id) : [];
  const delegatedBySubject = new Map();
  for (const d of myDelegations) {
    if (d.dateKey < today) continue; // stand-in's job is done once the covered day has passed
    const k = String(d.subject);
    if (!delegatedBySubject.has(k)) delegatedBySubject.set(k, []);
    delegatedBySubject.get(k).push(d);
  }

  /*
   * A subject split by day via a standing per-period override — "Thursdays
   * belong to Anuja" — earns a permanent place on this dashboard, keyed by
   * subject the same way a delegation is, but never expiring the way a
   * one-off hand-over does.
   */
  const myOverrides =
    role === 'faculty'
      ? await TimetableEntry.find({ faculty: _id }).select('subject').lean()
      : [];
  const overriddenSubjectIds = [...new Set(myOverrides.map((o) => String(o.subject)).filter(Boolean))];

  if (role === 'faculty') {
    subjects = await Subject.find({
      isActive: true,
      $or: [
        { faculty: _id },
        { _id: { $in: [...delegatedBySubject.keys()] } },
        { _id: { $in: overriddenSubjectIds } },
      ],
    })
      .populate('faculty', 'name email')
      .populate('section', 'name')
      .lean();
  } else if (role === 'admin') {
    subjects = await Subject.find({ isActive: true })
      .populate('faculty', 'name email')
      .populate('section', 'name')
      .lean();
  } else {
    const enrollments = await Enrollment.find({ student: _id, isActive: true })
      .populate({
        path: 'subject',
        populate: [
          { path: 'faculty', select: 'name email' },
          { path: 'section', select: 'name' },
        ],
      })
      .lean();
    subjects = enrollments.map((e) => e.subject).filter(Boolean);
  }

  const ids = subjects.map((s) => s._id);
  const [conductedMap, enrolledRows] = await Promise.all([
    getConductedCounts(ids),
    Enrollment.aggregate([
      { $match: { subject: { $in: ids }, isActive: true } },
      { $group: { _id: '$subject', n: { $sum: 1 } } },
    ]),
  ]);
  const enrolledMap = Object.fromEntries(enrolledRows.map((r) => [String(r._id), r.n]));

  /*
   * Every lecturer covering a day of these subjects, on either side of a
   * split — the owner sees who has which day, and whoever covers a day sees
   * whose subject it otherwise is. Scoped to the live timetable only: a
   * draft that never went out is not something anyone is actually teaching.
   */
  let dayCoverageBySubject = new Map();
  if (role === 'faculty' && ids.length) {
    const published = await getPublishedTimetables();
    const publishedIds = published.map((t) => t._id);
    const rows = publishedIds.length
      ? await TimetableEntry.find({
          subject: { $in: ids },
          timetable: { $in: publishedIds },
          faculty: { $ne: null },
        })
          .select('subject faculty dayOfWeek')
          .populate('faculty', 'name')
          .lean()
      : [];
    for (const r of rows) {
      if (!r.faculty) continue;
      const sid = String(r.subject);
      if (!dayCoverageBySubject.has(sid)) dayCoverageBySubject.set(sid, new Map());
      const byFaculty = dayCoverageBySubject.get(sid);
      const fid = String(r.faculty._id);
      if (!byFaculty.has(fid)) byFaculty.set(fid, { name: r.faculty.name, days: new Set() });
      byFaculty.get(fid).days.add(r.dayOfWeek);
    }
  }

  const data = subjects
    .map((s) => {
      const sid = String(s._id);
      const iOwnDefault = String(s.faculty?._id) === String(_id);
      const byFaculty = dayCoverageBySubject.get(sid);

      /*
       * Someone else's days, from this person's own seat: the subject's own
       * lecturer sees who covers which day of theirs; whoever covers a day
       * sees whose subject it otherwise is and which days are actually theirs.
       */
      let coTeaching = null;
      if (role === 'faculty' && byFaculty) {
        if (iOwnDefault) {
          const partners = [...byFaculty.entries()]
            .filter(([fid]) => fid !== String(_id))
            .map(([, v]) => ({ name: v.name, days: [...v.days].sort().map(dayName) }))
            .filter((p) => p.days.length);
          if (partners.length) coTeaching = { role: 'owner', partners };
        } else if (byFaculty.has(String(_id))) {
          const mine = byFaculty.get(String(_id));
          coTeaching = {
            role: 'partner',
            mainTeacher: s.faculty?.name || null,
            days: [...mine.days].sort().map(dayName),
          };
        }
      }

      return {
        id: sid,
        code: s.code,
        name: s.name,
        department: s.department,
        semester: s.semester,
        credits: s.credits,
        plannedClasses: s.plannedClasses,
        minAttendance: s.minAttendance,
        // Two offerings of one subject differ only by cohort, so the caller
        // needs the section to tell them apart.
        section: s.section ? { id: String(s.section._id), name: s.section.name } : null,
        faculty: s.faculty ? { id: String(s.faculty._id), name: s.faculty.name } : null,
        /*
         * Set only when the caller is standing in rather than teaching this.
         * The dates are listed because the hand-over covers those classes and
         * nothing else — not the subject, and not next week.
         */
        standingIn: delegatedBySubject.has(sid)
          ? {
              forName: s.faculty?.name || null,
              classes: delegatedBySubject
                .get(sid)
                .map((d) => ({ date: d.dateKey, slot: d.slot }))
                .sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot),
              ownSubject: iOwnDefault,
            }
          : null,
        coTeaching,
        conducted: conductedMap[sid] || 0,
        enrolledCount: enrolledMap[sid] || 0,
      };
    })
    .sort(
      (a, b) =>
        a.semester - b.semester ||
        a.code.localeCompare(b.code) ||
        (a.section?.name || '').localeCompare(b.section?.name || '')
    );

  res.json({ success: true, data });
});

/** Subject detail + roster with each student's running percentage. */
export const getSubjectDetail = asyncHandler(async (req, res) => {
  const subject = await assertSubjectAccess(req.user, req.params.subjectId);
  const [roster, section] = await Promise.all([
    getSubjectRoster(subject._id),
    sectionRef(subject),
  ]);

  res.json({
    success: true,
    data: {
      subject: {
        id: String(subject._id),
        code: subject.code,
        name: subject.name,
        semester: subject.semester,
        plannedClasses: subject.plannedClasses,
        minAttendance: subject.minAttendance,
        section,
      },
      ...roster,
    },
  });
});
