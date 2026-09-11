import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { SWAP_OPEN } from '../config/swap.js';
import { sectionLabel } from '../utils/section.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toUTCDate, todayKey, dayOfWeek, weekDates } from '../utils/date.js';
import { idOf, sameId } from '../utils/ids.js';
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
  prisma.timetableEntry.findUnique({
    where: { id },
    include: {
      subject: { select: { id: true, code: true, name: true, facultyId: true, semester: true } },
      section: { select: { id: true, name: true, semester: true } },
      faculty: { select: { id: true, name: true, email: true } },
    },
  });

const facultyOf = (entry) => entry.facultyId || entry.subject?.facultyId || null;

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
  sectionId: entry.sectionId || null,
  wholeYear: !entry.sectionId,
  semester: semesterOf(entry),
});

/** Section is passed too, so a period with no subject still reaches its cohort. */
const audienceFor = (entry) =>
  studentAudience({ subjectId: entry.subjectId, sectionId: entry.sectionId });

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
  if (sameId(fromEntry, toEntry)) {
    throw ApiError.badRequest('Pick two different periods');
  }

  // The requester must own the "from" side.
  const fromFaculty = facultyOf(fromEntry);
  if (req.user.role !== 'admin' && !sameId(fromFaculty, req.user)) {
    throw ApiError.forbidden('You can only offer a class you teach');
  }

  const toFaculty = facultyOf(toEntry);
  if (!toFaculty) throw ApiError.badRequest('The other period has no lecturer assigned');
  if (sameId(toFaculty, fromFaculty)) {
    throw ApiError.badRequest('Both periods are yours — move the class instead of swapping');
  }

  if (fromDate < todayKey() || toDate < todayKey()) {
    throw ApiError.badRequest('Swaps can only be arranged for upcoming classes');
  }
  if (dayOfWeek(fromDate) !== fromEntry.dayOfWeek || dayOfWeek(toDate) !== toEntry.dayOfWeek) {
    throw ApiError.badRequest('The dates do not match when those classes actually run');
  }

  // Reject an impossible swap now rather than making an admin discover it.
  const ignore = [fromEntry.id, toEntry.id];
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
  const clash = await prisma.swapRequest.findFirst({
    where: {
      status: { in: SWAP_OPEN },
      OR: [
        { fromEntryId: fromEntry.id, fromDateKey: fromDate },
        { toEntryId: fromEntry.id, toDateKey: fromDate },
        { fromEntryId: toEntry.id, fromDateKey: toDate },
        { toEntryId: toEntry.id, toDateKey: toDate },
      ],
    },
  });
  if (clash) throw ApiError.conflict('One of those classes is already in a pending swap');

  const swap = await prisma.swapRequest.create({
    data: {
      requestedById: idOf(req.user),
      counterpartyId: idOf(toFaculty),
      fromEntryId: fromEntry.id,
      fromDateKey: fromDate,
      fromSlot: fromEntry.slot,
      toEntryId: toEntry.id,
      toDateKey: toDate,
      toSlot: toEntry.slot,
      reason,
    },
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
    createdBy: idOf(req.user),
    meta: { swapId: swap.id },
  });

  await notify(await adminIds(), {
    type: 'swap:requested',
    title: 'Swap needs approval',
    message: `${req.user.name} → ${toEntry.faculty?.name || 'lecturer'}: ${summary}`,
    link: '/swaps',
    requiresAction: true,
    createdBy: idOf(req.user),
    meta: { swapId: swap.id },
  });

  emitToUsers([idOf(toFaculty), ...(await adminIds())], 'swap:updated', {
    swapId: swap.id,
    status: 'pending',
  });

  res.status(201).json({
    success: true,
    message: 'Swap requested — waiting for admin approval',
    data: { id: swap.id, status: swap.status },
  });
});

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

/** Admins see every request; faculty see the ones they are part of. */
export const listSwaps = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.user.role === 'faculty') {
    where.OR = [{ requestedById: idOf(req.user) }, { counterpartyId: idOf(req.user) }];
  }

  const entrySide = {
    select: {
      id: true,
      title: true,
      subject: { select: { code: true, name: true, semester: true } },
      section: { select: { name: true, semester: true } },
    },
  };

  const swaps = await prisma.swapRequest.findMany({
    where,
    /*
     * status is a native enum, so this orders by the position its labels were
     * declared in rather than alphabetically — which is the same order Mongo
     * happened to produce here, pending before the rest.
     */
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 60,
    include: {
      requestedBy: { select: { id: true, name: true, email: true } },
      counterparty: { select: { id: true, name: true, email: true } },
      decidedBy: { select: { name: true } },
      fromEntry: entrySide,
      toEntry: entrySide,
    },
  });

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
      id: s.id,
      status: s.status,
      reason: s.reason,
      requestedBy: { id: s.requestedBy.id, name: s.requestedBy.name },
      counterparty: { id: s.counterparty.id, name: s.counterparty.name },
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
      canAccept: s.status === 'pending' && sameId(s.counterpartyId, req.user),
      canDecline: SWAP_OPEN.includes(s.status) && sameId(s.counterpartyId, req.user),
      canWithdraw: SWAP_OPEN.includes(s.status) && sameId(s.requestedById, req.user),
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

  const swap = await prisma.swapRequest.findUnique({
    where: { id: req.params.swapId },
    include: { counterparty: { select: { id: true, name: true } } },
  });
  if (!swap) throw ApiError.notFound('Swap request not found');
  /*
   * `counterparty` is included above so the refusal can name them, which makes
   * it an object rather than an id — and notify() takes ids. Pull it out once.
   */
  const counterpartyId = swap.counterpartyId;
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
    loadEntry(swap.fromEntryId),
    loadEntry(swap.toEntryId),
  ]);
  if (!fromEntry || !toEntry) throw ApiError.notFound('One of the classes no longer exists');

  if (!approve) {
    await prisma.swapRequest.update({
      where: { id: swap.id },
      data: {
        status: 'rejected',
        decidedById: idOf(req.user),
        decidedAt: new Date(),
        decisionNote: note,
      },
    });

    await notify([swap.requestedById, counterpartyId], {
      type: 'swap:rejected',
      title: 'Swap rejected',
      message: `${req.user.name} rejected the swap${note ? `: ${note}` : '.'}`,
      link: '/swaps',
      createdBy: idOf(req.user),
    });
    emitToUsers([swap.requestedById, counterpartyId], 'swap:updated', {
      swapId: swap.id,
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
  const ignore = [fromEntry.id, toEntry.id];
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
  const common = {
    swapRequestId: swap.id,
    createdById: idOf(req.user),
    reason: swap.reason,
  };

  /*
   * Both halves in one transaction. A swap is two linked moves and exactly one
   * of them existing is the worst possible state — one class relocated and the
   * other still sitting in the period it just gave away.
   */
  await prisma.$transaction([
    prisma.scheduleChange.create({
      data: {
        ...common,
        kind: 'move',
        timetableId: fromEntry.timetableId,
        date: toUTCDate(swap.fromDateKey),
        dateKey: swap.fromDateKey,
        entryId: fromEntry.id,
        fromSlot: swap.fromSlot,
        toDate: toUTCDate(swap.toDateKey),
        toDateKey: swap.toDateKey,
        toSlot: swap.toSlot,
        // Null on an undivided year — the change belongs to the whole cohort.
        sectionId: fromEntry.sectionId || null,
        subjectId: fromEntry.subjectId || null,
        facultyId: facultyOf(fromEntry),
        kindOfClass: fromEntry.kind,
        title: fromEntry.title,
      },
    }),
    prisma.scheduleChange.create({
      data: {
        ...common,
        kind: 'move',
        timetableId: toEntry.timetableId,
        date: toUTCDate(swap.toDateKey),
        dateKey: swap.toDateKey,
        entryId: toEntry.id,
        fromSlot: swap.toSlot,
        toDate: toUTCDate(swap.fromDateKey),
        toDateKey: swap.fromDateKey,
        toSlot: swap.fromSlot,
        sectionId: toEntry.sectionId || null,
        subjectId: toEntry.subjectId || null,
        facultyId: facultyOf(toEntry),
        kindOfClass: toEntry.kind,
        title: toEntry.title,
      },
    }),
  ]);

  // Attendance follows each class to its new period.
  const attendance = await Promise.all([
    moveAttendanceSession({
      subjectId: fromEntry.subjectId,
      fromDateKey: swap.fromDateKey,
      fromSlot: swap.fromSlot,
      toDateKey: swap.toDateKey,
      toSlot: swap.toSlot,
      facultyId: facultyOf(fromEntry),
    }),
    moveAttendanceSession({
      subjectId: toEntry.subjectId,
      fromDateKey: swap.toDateKey,
      fromSlot: swap.toSlot,
      toDateKey: swap.fromDateKey,
      toSlot: swap.fromSlot,
      facultyId: facultyOf(toEntry),
    }),
  ]);

  await prisma.swapRequest.update({
    where: { id: swap.id },
    data: {
      status: 'approved',
      decidedById: idOf(req.user),
      decidedAt: new Date(),
      decisionNote: note,
    },
  });

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
    createdBy: idOf(req.user),
  });

  emitToUsers([...staff, ...students], 'timetable:changed', { reason: 'swap' });
  emitToUsers([swap.requestedById, counterpartyId], 'swap:updated', {
    swapId: swap.id,
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
  const swap = await prisma.swapRequest.findUnique({ where: { id: req.params.swapId } });
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (!sameId(swap.counterpartyId, req.user)) {
    throw ApiError.forbidden('Only the lecturer being asked can accept this');
  }
  if (swap.status === 'accepted') throw ApiError.badRequest('You have already accepted this');
  if (swap.status !== 'pending') throw ApiError.badRequest(`Already ${swap.status}`);

  await prisma.swapRequest.update({
    where: { id: swap.id },
    data: { status: 'accepted', acceptedAt: new Date() },
  });

  const admins = await adminIds();
  await notify([swap.requestedById], {
    type: 'swap:accepted',
    title: 'Your swap was accepted',
    message: `${req.user.name} agreed to the exchange. It now needs an administrator's approval.`,
    link: '/swaps',
    createdBy: idOf(req.user),
  });
  await notify(admins, {
    type: 'swap:accepted',
    title: 'Swap ready for approval',
    message: `${req.user.name} accepted the exchange. Both lecturers agree — it needs your approval to take effect.`,
    link: '/swaps',
    requiresAction: true,
    createdBy: idOf(req.user),
    meta: { swapId: swap.id },
  });
  emitToUsers([swap.requestedById, ...admins], 'swap:updated', {
    swapId: swap.id,
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
  const swap = await prisma.swapRequest.findUnique({ where: { id: req.params.swapId } });
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (!sameId(swap.counterpartyId, req.user)) {
    throw ApiError.forbidden('Only the other lecturer can decline this');
  }
  // Changing their mind before the admin acts is still their call.
  if (!SWAP_OPEN.includes(swap.status)) throw ApiError.badRequest(`Already ${swap.status}`);

  await prisma.swapRequest.update({
    where: { id: swap.id },
    data: {
      status: 'declined',
      decidedById: idOf(req.user),
      decidedAt: new Date(),
      decisionNote: req.body?.note || '',
    },
  });

  await notify([swap.requestedById, ...(await adminIds())], {
    type: 'swap:declined',
    title: 'Swap declined',
    message: `${req.user.name} declined the swap request.`,
    link: '/swaps',
    createdBy: idOf(req.user),
  });
  emitToUsers([swap.requestedById, ...(await adminIds())], 'swap:updated', {
    swapId: swap.id,
    status: 'declined',
  });

  res.json({ success: true, message: 'Swap declined', data: { status: 'declined' } });
});

export const withdrawSwap = asyncHandler(async (req, res) => {
  const swap = await prisma.swapRequest.findUnique({ where: { id: req.params.swapId } });
  if (!swap) throw ApiError.notFound('Swap request not found');
  if (!sameId(swap.requestedById, req.user)) {
    throw ApiError.forbidden('Only the requester can withdraw this');
  }
  // Withdrawable right up until the admin decides, accepted or not.
  if (!SWAP_OPEN.includes(swap.status)) throw ApiError.badRequest(`Already ${swap.status}`);

  await prisma.swapRequest.update({
    where: { id: swap.id },
    data: { status: 'withdrawn', decidedAt: new Date() },
  });

  await notify([swap.counterpartyId, ...(await adminIds())], {
    type: 'swap:withdrawn',
    title: 'Swap withdrawn',
    message: `${req.user.name} withdrew their swap request.`,
    link: '/swaps',
    createdBy: idOf(req.user),
  });
  emitToUsers([swap.counterpartyId, ...(await adminIds())], 'swap:updated', {
    swapId: swap.id,
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
  const myFaculty = idOf(facultyOf(mine));
  const mySection = mine.sectionId;
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
    .filter((o) => !sameId(o.entryId, mine))
    .filter((o) => o.faculty && o.faculty.id !== myFaculty);

  const slotLabel = await slotNamer(mine.subject?.semester || mine.section?.semester);

  const candidates = others
    .map((o) => {
      const theirSection = o.section?.id || null;
      const theirFaculty = o.faculty.id;
      const ignore = new Set([idOf(mine), o.entryId]);

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
