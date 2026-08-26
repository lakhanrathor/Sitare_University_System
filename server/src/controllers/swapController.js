import { z } from 'zod';
import SwapRequest, { SWAP_OPEN } from '../models/SwapRequest.js';
import ScheduleChange from '../models/ScheduleChange.js';
import TimetableEntry from '../models/TimetableEntry.js';
import { sectionLabel } from '../models/Section.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toUTCDate, todayKey, dayOfWeek, weekDates } from '../utils/date.js';
import { dayName } from '../config/slots.js';
import {
  moveAttendanceSession,
  findConflicts,
  resolveOccurrences,
  slotsForSemester,
  labelOf,
} from '../services/timetableService.js';
import {
  notify,
  adminIds,
  facultyAndAdminIds,
  studentAudience,
} from '../services/notificationService.js';
import { emitToUsers } from '../sockets/index.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const createSwapSchema = z.object({
  fromEntryId: z.string().min(1),
  fromDate: dateKey,
  toEntryId: z.string().min(1),
  toDate: dateKey,
  reason: z.string().max(300).optional().default(''),
});

export const decideSwapSchema = z.object({
  approve: z.boolean(),
  note: z.string().max(300).optional().default(''),
});

/**
 * Period labels differ per semester, so each handler loads the grid it is
 * working in and formats against that. No module-level cache: it would be
 * shared between requests and go stale the moment a timetable is republished.
 */
async function slotNamer(semester) {
  const slots = await slotsForSemester(semester);
  return (n) => labelOf(slots, n);
}

const loadEntry = (id) =>
  TimetableEntry.findById(id)
    .populate('subject', 'code name faculty semester')
    .populate('section', 'name semester')
    .populate('faculty', 'name email');

const facultyOf = (entry) => entry.faculty?._id || entry.subject?.faculty || null;

/** Which year a period belongs to — what separates a combined class from a clash. */
const semesterOf = (entry) => entry.section?.semester ?? entry.subject?.semester ?? null;

/**
 * How to ask findConflicts about a period's cohort.
 *
 * A period on an undivided semester has no section at all — that year never
 * split — so reaching for `section._id` throws and the whole action dies with
 * "Cannot read properties of null". Such a period belongs to the entire year.
 */
const cohortOf = (entry) => ({
  sectionId: entry.section?._id || null,
  wholeYear: !entry.section,
  semester: semesterOf(entry),
});

/** Section is passed too, so a period with no subject still reaches its cohort. */
const audienceFor = (entry) =>
  studentAudience({ subjectId: entry.subject?._id, sectionId: entry.section?._id });

const describe = (entry, date, slot, slotLabel) =>
  `${entry.subject ? `${entry.subject.code} ${entry.subject.name}` : entry.title} (${sectionLabel(
    entry.section
  )}) — ${slotLabel(slot)} on ${date}`;

/* ------------------------------------------------------------------ */
/* Raise a request                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ask another lecturer to exchange periods. Nothing on the live grid changes
 * here: the request sits pending until an admin approves it. Both the
 * counterparty and the admins are told immediately.
 */
export const createSwap = asyncHandler(async (req, res) => {
  const { fromEntryId, fromDate, toEntryId, toDate, reason } = req.body;

  const [fromEntry, toEntry] = await Promise.all([loadEntry(fromEntryId), loadEntry(toEntryId)]);
  if (!fromEntry || !toEntry) throw ApiError.notFound('One of those periods is not on the timetable');
  if (String(fromEntry._id) === String(toEntry._id)) {
    throw ApiError.badRequest('Pick two different periods');
  }

  // The requester must own the "from" side.
  const fromFaculty = facultyOf(fromEntry);
  if (req.user.role !== 'admin' && String(fromFaculty) !== String(req.user._id)) {
    throw ApiError.forbidden('You can only offer a class you teach');
  }

  const toFaculty = facultyOf(toEntry);
  if (!toFaculty) throw ApiError.badRequest('The other period has no lecturer assigned');
  if (String(toFaculty) === String(fromFaculty)) {
    throw ApiError.badRequest('Both periods are yours — move the class instead of swapping');
  }

  if (fromDate < todayKey() || toDate < todayKey()) {
    throw ApiError.badRequest('Swaps can only be arranged for upcoming classes');
  }
  if (dayOfWeek(fromDate) !== fromEntry.dayOfWeek || dayOfWeek(toDate) !== toEntry.dayOfWeek) {
    throw ApiError.badRequest('The dates do not match when those classes actually run');
  }

  // Reject an impossible swap now rather than making an admin discover it.
  const ignore = [fromEntry._id, toEntry._id];
  const [forFrom, forTo] = await Promise.all([
    findConflicts({
      dateKey: toDate,
      slot: toEntry.slot,
      ...cohortOf(fromEntry),
      facultyId: fromFaculty,
      ignoreEntryIds: ignore,
    }),
    findConflicts({
      dateKey: fromDate,
      slot: fromEntry.slot,
      ...cohortOf(toEntry),
      facultyId: toFaculty,
      ignoreEntryIds: ignore,
    }),
  ]);
  /*
   * A cohort clash blocks, and so does a lecturer already committed to a
   * different year. Two sections of the same year is a combined class.
   */
  const blocker = forFrom.section || forTo.section;
  if (blocker) {
    throw ApiError.conflict(
      `That swap cannot work — ${blocker.subject?.code || blocker.title} (Section ${
        blocker.section?.name
      }) already occupies one of those periods. Pick a different class.`
    );
  }
  const otherYear = forFrom.faculty || forTo.faculty;
  if (otherYear) {
    throw ApiError.conflict(
      `That swap cannot work — it would put a lecturer with semester ${otherYear.semester} at the same time. Pick a different class.`
    );
  }

  // A class already promised to another exchange, agreed or not yet.
  const clash = await SwapRequest.findOne({
    status: { $in: SWAP_OPEN },
    $or: [
      { fromEntry: fromEntry._id, fromDateKey: fromDate },
      { toEntry: fromEntry._id, toDateKey: fromDate },
      { fromEntry: toEntry._id, fromDateKey: toDate },
      { toEntry: toEntry._id, toDateKey: toDate },
    ],
  });
  if (clash) throw ApiError.conflict('One of those classes is already in a pending swap');

  const swap = await SwapRequest.create({
    requestedBy: req.user._id,
    counterparty: toFaculty,
    fromEntry: fromEntry._id,
    fromDateKey: fromDate,
    fromSlot: fromEntry.slot,
    toEntry: toEntry._id,
    toDateKey: toDate,
    toSlot: toEntry.slot,
    reason,
  });

  const slotLabel = await slotNamer(fromEntry.subject?.semester || fromEntry.section?.semester);
  const summary = `${describe(fromEntry, fromDate, fromEntry.slot, slotLabel)}  ⇄  ${describe(
    toEntry,
    toDate,
    toEntry.slot,
    slotLabel
  )}`;

  await notify([toFaculty], {
    type: 'swap:requested',
    title: 'Swap requested with you',
    message: `${req.user.name} would like to exchange periods: ${summary}`,
    link: '/swaps',
    requiresAction: true,
    createdBy: req.user._id,
    meta: { swapId: String(swap._id) },
  });

  await notify(await adminIds(), {
    type: 'swap:requested',
    title: 'Swap needs approval',
    message: `${req.user.name} → ${toEntry.faculty?.name || 'lecturer'}: ${summary}`,
    link: '/swaps',
    requiresAction: true,
    createdBy: req.user._id,
    meta: { swapId: String(swap._id) },
  });

  emitToUsers([String(toFaculty), ...(await adminIds())], 'swap:updated', {
    swapId: String(swap._id),
    status: 'pending',
  });

  res.status(201).json({
    success: true,
    message: 'Swap requested — waiting for admin approval',
    data: { id: String(swap._id), status: swap.status },
  });
});

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

/** Admins see every request; faculty see the ones they are part of. */
export const listSwaps = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.user.role === 'faculty') {
    filter.$or = [{ requestedBy: req.user._id }, { counterparty: req.user._id }];
  }

  const swaps = await SwapRequest.find(filter)
    .sort({ status: 1, createdAt: -1 })
    .limit(60)
    .populate('requestedBy', 'name email')
    .populate('counterparty', 'name email')
    .populate('decidedBy', 'name')
    .populate({
      path: 'fromEntry',
      populate: [
        { path: 'subject', select: 'code name semester' },
        { path: 'section', select: 'name semester' },
      ],
    })
    .populate({
      path: 'toEntry',
      populate: [
        { path: 'subject', select: 'code name semester' },
        { path: 'section', select: 'name semester' },
      ],
    })
    .lean();

  // Requests can span semesters, so each side is labelled against its own grid.
  const namerCache = new Map();
  const namerFor = async (sem) => {
    const key = String(sem ?? '');
    if (!namerCache.has(key)) namerCache.set(key, await slotNamer(sem));
    return namerCache.get(key);
  };

  const side = async (entry, date, slot) => {
    const label = await namerFor(entry?.subject?.semester || entry?.section?.semester);
    return {
      subject: entry?.subject ? { code: entry.subject.code, name: entry.subject.name } : null,
      title: entry?.title || '',
      section: entry?.section?.name || null,
      date,
      day: dayName(dayOfWeek(date)),
      slot,
      slotLabel: label(slot),
    };
  };

  const data = await Promise.all(
    swaps.map(async (s) => ({
      id: String(s._id),
      status: s.status,
      reason: s.reason,
      requestedBy: { id: String(s.requestedBy._id), name: s.requestedBy.name },
      counterparty: { id: String(s.counterparty._id), name: s.counterparty.name },
      from: await side(s.fromEntry, s.fromDateKey, s.fromSlot),
      to: await side(s.toEntry, s.toDateKey, s.toSlot),
      decidedBy: s.decidedBy?.name || null,
      decidedAt: s.decidedAt,
      decisionNote: s.decisionNote,
      createdAt: s.createdAt,
      acceptedAt: s.acceptedAt,

      /*
       * Two stages, so who can do what depends on which one it is in. An admin
       * may reject at any point but can only approve once the other lecturer
       * has agreed — see decideSwap.
       */
      canAccept:
        s.status === 'pending' && String(s.counterparty._id) === String(req.user._id),
      canDecline:
        SWAP_OPEN.includes(s.status) && String(s.counterparty._id) === String(req.user._id),
      canWithdraw:
        SWAP_OPEN.includes(s.status) && String(s.requestedBy._id) === String(req.user._id),
      canApprove: req.user.role === 'admin' && s.status === 'accepted',
      canReject: req.user.role === 'admin' && SWAP_OPEN.includes(s.status),
      /** Kept for older callers: an admin acting on a live request. */
      canDecide: req.user.role === 'admin' && SWAP_OPEN.includes(s.status),
    }))
  );

  res.json({ success: true, data });
});

/* ------------------------------------------------------------------ */
/* Decide                                                              */
/* ------------------------------------------------------------------ */

/**
 * Admin decision. Approving writes the exchange to the grid as two linked
 * `move` changes — each class keeps its own subject and lecturer but takes the
 * other's period, so both teachers' names follow their classes. Attendance
 * sheets already taken move with them.
 */
export const decideSwap = asyncHandler(async (req, res) => {
  const { approve, note } = req.body;

  const swap = await SwapRequest.findById(req.params.swapId).populate('counterparty', 'name');
  if (!swap) throw ApiError.notFound('Swap request not found');
  /*
   * `counterparty` is populated above so the refusal can name them, which
   * makes it a document rather than an id — and notify() casts what it is
   * given straight into a Notification. Pull the id out once, here.
   */
  const counterpartyId = swap.counterparty?._id || swap.counterparty;
  if (!SWAP_OPEN.includes(swap.status)) {
    throw ApiError.badRequest(`This request was already ${swap.status}`);
  }

  /*
   * Approval is the second stage. Rejecting is always available — an admin can
   * kill a request the other lecturer has not even looked at — but applying
   * one they never agreed to would timetable them into somebody else's period
   * without their say.
   */
  if (approve && swap.status !== 'accepted') {
    throw ApiError.badRequest(
      `${swap.counterparty?.name || 'The other lecturer'} has not accepted this yet. It can only be approved once they do.`
    );
  }

  const [fromEntry, toEntry] = await Promise.all([
    loadEntry(swap.fromEntry),
    loadEntry(swap.toEntry),
  ]);
  if (!fromEntry || !toEntry) throw ApiError.notFound('One of the classes no longer exists');

  if (!approve) {
    swap.status = 'rejected';
    swap.decidedBy = req.user._id;
    swap.decidedAt = new Date();
    swap.decisionNote = note;
    await swap.save();

    await notify([swap.requestedBy, counterpartyId], {
      type: 'swap:rejected',
      title: 'Swap rejected',
      message: `${req.user.name} rejected the swap${note ? `: ${note}` : '.'}`,
      link: '/swaps',
      createdBy: req.user._id,
    });
    emitToUsers([swap.requestedBy, counterpartyId], 'swap:updated', {
      swapId: String(swap._id),
      status: 'rejected',
    });

    return res.json({ success: true, message: 'Swap rejected', data: { status: 'rejected' } });
  }

  /*
   * Re-check both destinations at decision time. A request can sit pending for
   * days, during which someone may have booked an extra class into one of the
   * periods — approving blindly would put two classes in one room.
   * Each side ignores both entries involved, since they are trading places.
   */
  const ignore = [fromEntry._id, toEntry._id];
  const [forFrom, forTo] = await Promise.all([
    findConflicts({
      dateKey: swap.toDateKey,
      slot: swap.toSlot,
      ...cohortOf(fromEntry),
      facultyId: facultyOf(fromEntry),
      ignoreEntryIds: ignore,
    }),
    findConflicts({
      dateKey: swap.fromDateKey,
      slot: swap.fromSlot,
      ...cohortOf(toEntry),
      facultyId: facultyOf(toEntry),
      ignoreEntryIds: ignore,
    }),
  ]);

  /*
   * A cohort clash blocks, and so does a lecturer already committed to another
   * year. Two sections of the same year is a combined class, not a clash.
   */
  const blocker = forFrom.section || forTo.section;
  if (blocker) {
    throw ApiError.conflict(
      `Cannot apply this swap — ${blocker.subject?.code || blocker.title} (Section ${
        blocker.section?.name
      }) now occupies one of those periods. Ask for a fresh request.`
    );
  }
  const otherYear = forFrom.faculty || forTo.faculty;
  if (otherYear) {
    throw ApiError.conflict(
      `Cannot apply this swap — a lecturer would be left with semester ${otherYear.semester} at the same time. Ask for a fresh request.`
    );
  }

  // Each class moves into the other's period.
  const common = { swapRequest: swap._id, createdBy: req.user._id, reason: swap.reason };

  await ScheduleChange.create([
    {
      ...common,
      kind: 'move',
      timetable: fromEntry.timetable,
      date: toUTCDate(swap.fromDateKey),
      dateKey: swap.fromDateKey,
      entry: fromEntry._id,
      fromSlot: swap.fromSlot,
      toDate: toUTCDate(swap.toDateKey),
      toDateKey: swap.toDateKey,
      toSlot: swap.toSlot,
      // Null on an undivided year — the change belongs to the whole cohort.
      section: fromEntry.section?._id || null,
      subject: fromEntry.subject?._id || null,
      faculty: facultyOf(fromEntry),
      kindOfClass: fromEntry.kind,
      title: fromEntry.title,
    },
    {
      ...common,
      kind: 'move',
      timetable: toEntry.timetable,
      date: toUTCDate(swap.toDateKey),
      dateKey: swap.toDateKey,
      entry: toEntry._id,
      fromSlot: swap.toSlot,
      toDate: toUTCDate(swap.fromDateKey),
      toDateKey: swap.fromDateKey,
      toSlot: swap.fromSlot,
      section: toEntry.section?._id || null,
      subject: toEntry.subject?._id || null,
      faculty: facultyOf(toEntry),
      kindOfClass: toEntry.kind,
      title: toEntry.title,
    },
  ]);

  // Attendance follows each class to its new period.
  const attendance = await Promise.all([
    moveAttendanceSession({
      subjectId: fromEntry.subject?._id,
      fromDateKey: swap.fromDateKey,
      fromSlot: swap.fromSlot,
      toDateKey: swap.toDateKey,
      toSlot: swap.toSlot,
      facultyId: facultyOf(fromEntry),
    }),
    moveAttendanceSession({
      subjectId: toEntry.subject?._id,
      fromDateKey: swap.toDateKey,
      fromSlot: swap.toSlot,
      toDateKey: swap.fromDateKey,
      toSlot: swap.fromSlot,
      facultyId: facultyOf(toEntry),
    }),
  ]);

  swap.status = 'approved';
  swap.decidedBy = req.user._id;
  swap.decidedAt = new Date();
  swap.decisionNote = note;
  await swap.save();

  const slotLabel = await slotNamer(fromEntry.subject?.semester || fromEntry.section?.semester);
  const summary = `${describe(fromEntry, swap.fromDateKey, swap.fromSlot, slotLabel)}  ⇄  ${describe(
    toEntry,
    swap.toDateKey,
    swap.toSlot,
    slotLabel
  )}`;

  const students = [...(await audienceFor(fromEntry)), ...(await audienceFor(toEntry))];
  const staff = await facultyAndAdminIds();

  await notify([...staff, ...students], {
    type: 'swap:approved',
    title: 'Swap approved',
    message: `Periods exchanged — ${summary}`,
    link: `/timetable?date=${swap.fromDateKey}`,
    createdBy: req.user._id,
  });

  emitToUsers([...staff, ...students], 'timetable:changed', { reason: 'swap' });
  emitToUsers([swap.requestedBy, counterpartyId], 'swap:updated', {
    swapId: String(swap._id),
    status: 'approved',
  });

  res.json({
    success: true,
    message: 'Swap approved and applied to the timetable',
    data: {
      status: 'approved',
      attendanceMoved: attendance.filter((a) => a?.moved).length,
    },
  });
});

/**
 * The first stage: the lecturer being asked agrees.
 *
 * Only now does the request reach an administrator. Approving before this
 * would timetable somebody into an exchange they never agreed to, and the
 * admin has no way of knowing whether the two have spoken.
 */
export const acceptSwap = asyncHandler(async (req, res) => {
  const swap = await SwapRequest.findById(req.params.swapId);
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (String(swap.counterparty) !== String(req.user._id)) {
    throw ApiError.forbidden('Only the lecturer being asked can accept this');
  }
  if (swap.status === 'accepted') throw ApiError.badRequest('You have already accepted this');
  if (swap.status !== 'pending') throw ApiError.badRequest(`Already ${swap.status}`);

  swap.status = 'accepted';
  swap.acceptedAt = new Date();
  await swap.save();

  const admins = await adminIds();
  await notify([swap.requestedBy], {
    type: 'swap:accepted',
    title: 'Your swap was accepted',
    message: `${req.user.name} agreed to the exchange. It now needs an administrator's approval.`,
    link: '/swaps',
    createdBy: req.user._id,
  });
  await notify(admins, {
    type: 'swap:accepted',
    title: 'Swap ready for approval',
    message: `${req.user.name} accepted the exchange. Both lecturers agree — it needs your approval to take effect.`,
    link: '/swaps',
    requiresAction: true,
    createdBy: req.user._id,
    meta: { swapId: String(swap._id) },
  });
  emitToUsers([swap.requestedBy, ...admins], 'swap:updated', {
    swapId: String(swap._id),
    status: 'accepted',
  });

  res.json({
    success: true,
    message: 'Accepted — sent to the administrator for approval',
    data: { status: 'accepted' },
  });
});

/** The counterparty can decline, before or after agreeing. */
export const declineSwap = asyncHandler(async (req, res) => {
  const swap = await SwapRequest.findById(req.params.swapId);
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (String(swap.counterparty) !== String(req.user._id)) {
    throw ApiError.forbidden('Only the other lecturer can decline this');
  }
  // Changing their mind before the admin acts is still their call.
  if (!SWAP_OPEN.includes(swap.status)) throw ApiError.badRequest(`Already ${swap.status}`);

  swap.status = 'declined';
  swap.decidedBy = req.user._id;
  swap.decidedAt = new Date();
  swap.decisionNote = req.body?.note || '';
  await swap.save();

  await notify([swap.requestedBy, ...(await adminIds())], {
    type: 'swap:declined',
    title: 'Swap declined',
    message: `${req.user.name} declined the swap request.`,
    link: '/swaps',
    createdBy: req.user._id,
  });
  emitToUsers([swap.requestedBy, ...(await adminIds())], 'swap:updated', {
    swapId: String(swap._id),
    status: 'declined',
  });

  res.json({ success: true, message: 'Swap declined', data: { status: 'declined' } });
});

export const withdrawSwap = asyncHandler(async (req, res) => {
  const swap = await SwapRequest.findById(req.params.swapId);
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (String(swap.requestedBy) !== String(req.user._id)) {
    throw ApiError.forbidden('Only the requester can withdraw this');
  }
  // Withdrawable right up until the admin decides, accepted or not.
  if (!SWAP_OPEN.includes(swap.status)) throw ApiError.badRequest(`Already ${swap.status}`);

  swap.status = 'withdrawn';
  swap.decidedAt = new Date();
  await swap.save();

  await notify([swap.counterparty, ...(await adminIds())], {
    type: 'swap:withdrawn',
    title: 'Swap withdrawn',
    message: `${req.user.name} withdrew their swap request.`,
    link: '/swaps',
    createdBy: req.user._id,
  });
  emitToUsers([swap.counterparty, ...(await adminIds())], 'swap:updated', {
    swapId: String(swap._id),
    status: 'withdrawn',
  });

  res.json({ success: true, message: 'Swap withdrawn', data: { status: 'withdrawn' } });
});

/**
 * Classes a requester can offer to swap against.
 *
 * Each candidate is checked for feasibility up front — a swap that would put a
 * cohort or a lecturer in two rooms at once can never be approved, so telling
 * the teacher now beats letting them wait on an admin who has to reject it.
 */
export const listSwapCandidates = asyncHandler(async (req, res) => {
  const { entryId, date } = req.query;
  if (!entryId || !date) throw ApiError.badRequest('entryId and date are required');

  const mine = await loadEntry(entryId);
  if (!mine) throw ApiError.notFound('Period not found');

  /*
   * A period can have neither: an undivided semester leaves `section` null,
   * and a plain event like "Session with Dean" has no lecturer. Reading
   * through either would throw before the caller ever sees a useful answer.
   */
  const myFaculty = facultyOf(mine) ? String(facultyOf(mine)) : null;
  const mySection = mine.section ? String(mine.section._id) : null;
  const mySemester = semesterOf(mine);

  if (!myFaculty) {
    return res.json({
      success: true,
      data: {
        candidates: [],
        note: 'This period has no lecturer assigned, so there is nobody to swap with.',
      },
    });
  }

  /*
   * Candidates are read off what is actually happening this week — not the
   * recurring grid — so a class a swap or a shift already relocated is
   * offered (and shown) at its real date, not the slot it moved away from.
   */
  const dates = [...new Set([date, ...weekDates(date)])];
  const { byDate } = await resolveOccurrences(dates);

  const liveOn = (d) =>
    (byDate[d] || []).filter((o) => !['moved-out', 'cancelled'].includes(o.origin));
  const liveAt = (d, slot) => liveOn(d).filter((o) => o.slot === slot);

  const others = dates
    .flatMap(liveOn)
    .filter((o) => o.kind === 'lecture')
    .filter((o) => o.date >= todayKey())
    .filter((o) => o.entryId !== String(mine._id))
    .filter((o) => o.faculty && o.faculty.id !== myFaculty);

  const slotLabel = await slotNamer(mine.subject?.semester || mine.section?.semester);

  const candidates = others
    .map((o) => {
      const theirSection = o.section?.id || null;
      const theirFaculty = o.faculty.id;
      const ignore = new Set([String(mine._id), o.entryId]);

      /*
       * A cohort being busy rules a swap out, and so does a lecturer already
       * committed to a different year. Two sections of this same year do not:
       * that is a combined class, and both registers can still be taken.
       * Candidates all come from one timetable, so they share `mySemester`.
       */
      const otherYear = (x) => x.semester != null && Number(x.semester) !== Number(mySemester);

      /*
       * An undivided semester has no section id: that cohort *is* the year, so
       * anything of the same year in the period sits in front of them. A
       * divided cohort clashes with its own section, or with a whole-year
       * period that swallows it.
       */
      const hits = (x, sectionId) =>
        sectionId
          ? x.section?.id === sectionId || (!x.section && !otherYear(x))
          : !otherYear(x);

      const cohortName = (x) => (x.section?.name ? `Section ${x.section.name}` : 'That year');

      const clashes = [];
      // My class taking their period.
      for (const x of liveAt(o.date, o.slot)) {
        if (x.entryId && ignore.has(x.entryId)) continue;
        if (hits(x, mySection)) clashes.push(`${cohortName(x)} is busy then`);
        else if (myFaculty && x.faculty?.id === myFaculty && otherYear(x))
          clashes.push(`You already teach semester ${x.semester} then`);
      }
      // Their class taking my period.
      for (const x of liveAt(date, mine.slot)) {
        if (x.entryId && ignore.has(x.entryId)) continue;
        if (hits(x, theirSection)) clashes.push(`${cohortName(x)} is busy in your period`);
        else if (theirFaculty && x.faculty?.id === theirFaculty && otherYear(x))
          clashes.push(`${o.faculty.name || 'They'} teach semester ${x.semester} in your period`);
      }

      return {
        entryId: o.entryId,
        dayOfWeek: dayOfWeek(o.date),
        day: dayName(dayOfWeek(o.date)),
        date: o.date,
        slot: o.slot,
        slotLabel: slotLabel(o.slot),
        section: o.section?.name,
        subject: o.subject ? { code: o.subject.code, name: o.subject.name } : null,
        title: o.title,
        faculty: o.faculty.name || null,
        feasible: clashes.length === 0,
        blockedBy: clashes[0] || null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.feasible) - Number(a.feasible) || a.date.localeCompare(b.date) || a.slot - b.slot
    );

  res.json({ success: true, data: candidates });
});
