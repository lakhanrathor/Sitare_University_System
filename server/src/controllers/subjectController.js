import Subject from '../models/Subject.js';
import Section from '../models/Section.js';
import Enrollment from '../models/Enrollment.js';
import AttendanceDelegation from '../models/AttendanceDelegation.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getConductedCounts, getSubjectRoster } from '../services/attendanceService.js';

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

  throw ApiError.forbidden('You are not assigned to this subject');
}

/**
 * Access to one dated register.
 *
 * A stand-in is trusted with the single class they were asked to mark, not
 * with the subject. Anything wider — the report, other dates — stays with the
 * lecturer it belongs to.
 */
export async function assertRegisterAccess(user, subjectId, dateKey, slot) {
  const subject = await Subject.findById(subjectId);
  if (!subject) throw ApiError.notFound('Subject not found');
  if (user.role === 'admin') return subject;
  if (user.role === 'faculty' && String(subject.faculty) === String(user._id)) return subject;

  if (user.role === 'faculty') {
    const hit = await AttendanceDelegation.exists({
      subject: subject._id,
      dateKey,
      slot: Number(slot),
      faculty: user._id,
    });
    if (hit) return subject;
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
  const myDelegations = role === 'faculty' ? await delegationsFor(_id) : [];
  const delegatedBySubject = new Map();
  for (const d of myDelegations) {
    const k = String(d.subject);
    if (!delegatedBySubject.has(k)) delegatedBySubject.set(k, []);
    delegatedBySubject.get(k).push(d);
  }

  if (role === 'faculty') {
    subjects = await Subject.find({
      isActive: true,
      $or: [{ faculty: _id }, { _id: { $in: [...delegatedBySubject.keys()] } }],
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

  const data = subjects
    .map((s) => ({
      id: String(s._id),
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
      standingIn: delegatedBySubject.has(String(s._id))
        ? {
            forName: s.faculty?.name || null,
            classes: delegatedBySubject
              .get(String(s._id))
              .map((d) => ({ date: d.dateKey, slot: d.slot }))
              .sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot),
            ownSubject: String(s.faculty?._id) === String(_id),
          }
        : null,
      conducted: conductedMap[String(s._id)] || 0,
      enrolledCount: enrolledMap[String(s._id)] || 0,
    }))
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
