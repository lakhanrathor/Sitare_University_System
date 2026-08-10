import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Repeat,
  CalendarX2,
  Undo2,
  Info,
  ClipboardCheck,
  Pencil,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { shortDate, todayKey } from '../../lib/timetable';
import { sectionLabel } from '../../lib/format';
import { Modal, Button, Field, Select, Textarea, ErrorNote, InfoNote } from '../ui';

/*
 * Admins do not teach, so they have no class to offer in a swap — they approve
 * the ones teachers raise, from Approvals. What they do need is to say who
 * marks a register when its own lecturer will not.
 */
const TEACHER_TABS = [
  { key: 'move', label: 'Shift class', icon: CalendarClock },
  { key: 'swap', label: 'Swap with staff', icon: Repeat },
  { key: 'cancel', label: 'Cancel', icon: CalendarX2 },
];

const ADMIN_TABS = [
  { key: 'move', label: 'Shift class', icon: CalendarClock },
  { key: 'attendance', label: 'Who marks it', icon: ClipboardCheck },
  { key: 'cancel', label: 'Cancel', icon: CalendarX2 },
];

/**
 * Actions available on a scheduled class: shift it to another period, request a
 * swap with another teacher, or cancel it. Everything here is date-specific —
 * the recurring timetable itself is never rewritten.
 */
export default function ClassActionsModal({
  open,
  onClose,
  occurrence,
  slots,
  onDone,
  onEdit,
  canManage,
  isAdmin = false,
  subjects = [],
}) {
  const { notify } = useToast();
  const [tab, setTab] = useState('move');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // move
  const [toDate, setToDate] = useState('');
  const [toSlot, setToSlot] = useState('');
  const [moveReason, setMoveReason] = useState('');

  // swap
  const [candidates, setCandidates] = useState([]);
  const [candidateId, setCandidateId] = useState('');
  const [swapReason, setSwapReason] = useState('');

  const [cancelReason, setCancelReason] = useState('');

  // who marks the register (admin)
  const [marking, setMarking] = useState(null);
  const [markerId, setMarkerId] = useState('');
  const [countsToward, setCountsToward] = useState('');

  useEffect(() => {
    if (!open || !occurrence) return;
    setTab('move');
    setError('');
    setToDate(occurrence.date);
    setToSlot(String(occurrence.slot));
    setMoveReason('');
    setSwapReason('');
    setCancelReason('');
    setCandidateId('');
    setCandidates([]);
    setMarking(null);
    setMarkerId('');
    setCountsToward('');
  }, [open, occurrence]);

  // Who could mark this register, and who is free at that hour.
  useEffect(() => {
    if (tab !== 'attendance' || !occurrence?.entryId) return;
    (async () => {
      try {
        const data = await api.attendanceCandidates(occurrence.entryId, occurrence.date);
        setMarking(data);
        setMarkerId(data.attendanceBy?.id || '');
        setCountsToward(data.subject?.id || data.countsToward || '');
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [tab, occurrence]);

  // Swap candidates are other teachers' periods on the live grid.
  useEffect(() => {
    if (tab !== 'swap' || !occurrence?.entryId) return;
    (async () => {
      try {
        setCandidates(await api.swapCandidates(occurrence.entryId, occurrence.date));
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [tab, occurrence]);

  /** The server resolves which date each candidate actually runs on. */
  const candidateDate = useMemo(
    () => candidates.find((x) => x.entryId === candidateId)?.date || null,
    [candidateId, candidates]
  );
  const feasibleCount = candidates.filter((c) => c.feasible).length;

  if (!occurrence) return null;

  const label = occurrence.subject
    ? `${occurrence.subject.code} — ${occurrence.subject.name}`
    : occurrence.title;

  const run = async (fn, successTitle) => {
    setBusy(true);
    setError('');
    try {
      const res = await fn();
      notify(res.message, { variant: 'success', title: successTitle });
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doMove = () =>
    run(
      () =>
        api.moveClass({
          entryId: occurrence.entryId,
          date: occurrence.date,
          toDate,
          toSlot: Number(toSlot),
          reason: moveReason,
        }),
      'Class rescheduled'
    );

  const doSwap = () =>
    run(
      () =>
        api.createSwap({
          fromEntryId: occurrence.entryId,
          fromDate: occurrence.date,
          toEntryId: candidateId,
          toDate: candidateDate,
          reason: swapReason,
        }),
      'Swap requested'
    );

  const doCancel = () =>
    run(
      () =>
        api.cancelClass({
          entryId: occurrence.entryId,
          date: occurrence.date,
          reason: cancelReason,
        }),
      'Class cancelled'
    );

  const doUndo = () =>
    run(() => api.undoChange(occurrence.changeId), 'Change undone');

  const doSetMarker = () =>
    run(
      () =>
        api.setAttendanceBy(occurrence.entryId, {
          facultyId: markerId || null,
          subjectId: countsToward || null,
          // This one class only — next week's register goes back to its owner.
          date: occurrence.date,
        }),
      'Register updated'
    );

  /* An already-changed occurrence only offers "undo". */
  const isChanged = ['moved-in', 'moved-out', 'cancelled', 'swapped-in', 'extra'].includes(
    occurrence.origin
  );

  if (isChanged) {
    const fromSwap = Boolean(occurrence.swapRequest);
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={label}
        subtitle={`${shortDate(occurrence.date)} · ${sectionLabel(occurrence.section)}`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {canManage && !fromSwap && occurrence.changeId && (
              <Button variant="danger" onClick={doUndo} loading={busy}>
                <Undo2 className="h-4 w-4" />
                Undo this change
              </Button>
            )}
          </>
        }
      >
        <div className="space-y-3">
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="rounded-lg border border-slate-200 p-3.5 text-sm">
            <p className="font-medium text-slate-900">
              {occurrence.origin === 'cancelled' && 'This class is cancelled.'}
              {occurrence.origin === 'moved-out' &&
                `Moved to ${shortDate(occurrence.movedTo.date)}, slot ${occurrence.movedTo.slot}.`}
              {occurrence.origin === 'moved-in' &&
                `Moved here from ${shortDate(occurrence.movedFrom.date)}, slot ${occurrence.movedFrom.slot}.`}
              {occurrence.origin === 'swapped-in' &&
                `Swapped in from ${shortDate(occurrence.movedFrom.date)}, slot ${occurrence.movedFrom.slot}.`}
              {occurrence.origin === 'extra' && 'Extra class booked into a free period.'}
            </p>
            {occurrence.reason && (
              <p className="mt-1 text-slate-500">Reason: {occurrence.reason}</p>
            )}
          </div>
          {fromSwap && (
            <InfoNote>
              This came from an approved swap. To reverse it, raise a new swap request rather than
              undoing one half — otherwise the two classes would fall out of step.
            </InfoNote>
          )}
        </div>
      </Modal>
    );
  }

  if (!canManage) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={label}
        subtitle={`${shortDate(occurrence.date)} · ${sectionLabel(occurrence.section)}`}
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Lecturer</dt>
            <dd className="font-medium text-slate-900">{occurrence.faculty?.name || '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Section</dt>
            <dd className="font-medium text-slate-900">{sectionLabel(occurrence.section)}</dd>
          </div>
        </dl>
        <InfoNote>
          <span className="mt-2 block">
            Only the lecturer who takes this class, or an admin, can reschedule it.
          </span>
        </InfoNote>
      </Modal>
    );
  }

  const past = occurrence.date < todayKey();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={label}
      subtitle={`${shortDate(occurrence.date)} · ${sectionLabel(occurrence.section)} · ${
        slots.find((s) => s.slot === occurrence.slot)?.label
      }`}
      footer={
        <>
          {/*
            The same editor the double-click opens. Kept here because a
            double-click is easy to mistime, and landing in the wrong dialog
            should cost one click rather than a close-and-retry.
          */}
          {onEdit && (
            <Button variant="ghost" onClick={() => onEdit(occurrence)} className="mr-auto">
              <Pencil className="h-4 w-4" />
              Correct this period
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {tab === 'move' && (
            <Button onClick={doMove} loading={busy} disabled={past}>
              Shift class
            </Button>
          )}
          {tab === 'swap' && (
            <Button onClick={doSwap} loading={busy} disabled={!candidateId || past}>
              Request swap
            </Button>
          )}
          {tab === 'attendance' && (
            <Button
              onClick={doSetMarker}
              loading={busy}
              // Nothing to save until the choice actually differs from today's.
              disabled={
                !marking ||
                (markerId === (marking.attendanceBy?.id || '') &&
                  countsToward === (marking.subject?.id || ''))
              }
            >
              {markerId ? 'Hand over register' : 'Return to lecturer'}
            </Button>
          )}
          {tab === 'cancel' && (
            <Button variant="danger" onClick={doCancel} loading={busy} disabled={past}>
              Cancel this class
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {/* Assigning who marks a register is about the recurring period, so it
            stays available even after the date has passed. */}
        {past && tab !== 'attendance' && (
          <ErrorNote>This class has already happened and can no longer be changed.</ErrorNote>
        )}

        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(isAdmin ? ADMIN_TABS : TEACHER_TABS).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'move' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New date">
                <input
                  type="date"
                  value={toDate}
                  min={todayKey()}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                />
              </Field>
              <Field label="New period">
                <Select value={toSlot} onChange={(e) => setToSlot(e.target.value)}>
                  {slots.map((s) => (
                    <option key={s.slot} value={s.slot}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Reason">
              <Textarea
                rows={2}
                value={moveReason}
                onChange={(e) => setMoveReason(e.target.value)}
                placeholder="e.g. Faculty travelling that morning"
              />
            </Field>
            <InfoNote>
              Only this one date moves — the weekly timetable stays as it is. If attendance has
              already been taken for this class, the sheet moves with it, so the conducted-class
              count does not change.
            </InfoNote>
          </>
        )}

        {tab === 'swap' && (
          <>
            <Field
              label="Exchange with"
              hint={
                candidates.length
                  ? `${feasibleCount} of ${candidates.length} classes can be swapped with this one. Each of you keeps your own subject — only the period changes hands.`
                  : 'Your class takes their period and theirs takes yours.'
              }
            >
              <Select value={candidateId} onChange={(e) => setCandidateId(e.target.value)}>
                <option value="">Choose a class…</option>
                {/* Workable swaps first; the rest stay visible but disabled with a reason. */}
                {candidates.map((c) => (
                  <option key={c.entryId} value={c.entryId} disabled={!c.feasible}>
                    {shortDate(c.date)} {c.slotLabel} · {c.subject?.code}
                    {c.section ? ` Sec ${c.section}` : ''} · {c.faculty}
                    {c.feasible ? '' : ` — unavailable (${c.blockedBy})`}
                  </option>
                ))}
              </Select>
            </Field>

            {candidateDate && (
              <div className="rounded-lg border border-violet-200 bg-violet-50 px-3.5 py-2.5 text-xs text-violet-800">
                <p className="font-medium">After approval</p>
                <p className="mt-1">
                  Your {occurrence.subject?.code} moves to {shortDate(candidateDate)} in their
                  period, and their class moves to {shortDate(occurrence.date)} in yours. Both
                  lecturer names and any attendance already taken follow their classes.
                </p>
              </div>
            )}

            <Field label="Reason">
              <Textarea
                rows={2}
                value={swapReason}
                onChange={(e) => setSwapReason(e.target.value)}
                placeholder="e.g. Clashes with a department meeting"
              />
            </Field>

            <InfoNote icon={Info}>
              The other lecturer and the admin are notified straight away. Nothing on the timetable
              changes until an admin approves it — then both teachers' names, and any attendance
              already taken, follow their classes to the new periods.
            </InfoNote>
          </>
        )}

        {tab === 'attendance' && (
          <>
            {!marking ? (
              <p className="py-6 text-center text-sm text-slate-500">Loading lecturers…</p>
            ) : (
              <>
                <dl className="rounded-lg border border-slate-200 px-3.5 py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-slate-500">Register belongs to</dt>
                    <dd className="text-right font-medium text-slate-900">
                      {marking.owner?.name || occurrence.faculty?.name || 'Nobody yet'}
                    </dd>
                  </div>
                  <div className="mt-1.5 flex justify-between gap-3">
                    <dt className="text-slate-500">Counts towards</dt>
                    <dd className="text-right font-medium text-slate-900">
                      {marking.subject ? `${marking.subject.code} — ${marking.subject.name}` : '—'}
                    </dd>
                  </div>
                </dl>

                {/* Without a subject there is no register to hand over at all. */}
                {!marking.subject && (
                  <Field
                    label="Which subject does this count towards?"
                    hint="A period with no subject has no register. Point it at one and its attendance is recorded there."
                  >
                    <Select
                      value={countsToward}
                      onChange={(e) => setCountsToward(e.target.value)}
                    >
                      <option value="">Choose a subject…</option>
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} — {s.name}
                          {s.faculty?.name ? ` · ${s.faculty.name}` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                <Field
                  label={`Marked by · ${shortDate(occurrence.date)} only`}
                  hint="Anyone can be chosen, but lecturers already teaching in this period are flagged."
                >
                  <Select value={markerId} onChange={(e) => setMarkerId(e.target.value)}>
                    <option value="">Its own lecturer</option>
                    {[...marking.candidates]
                      .sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.free ? ' · free this period' : ` · busy with ${c.busyWith}`}
                        </option>
                      ))}
                  </Select>
                </Field>

                <InfoNote icon={Info}>
                  Just this one class, on{' '}
                  <span className="font-medium">{shortDate(occurrence.date)}</span> — the same
                  period next week stays with its own lecturer. The class, and every mark on it,
                  still belongs to{' '}
                  <span className="font-medium">
                    {marking.owner?.name || 'the period’s own lecturer'}
                  </span>{' '}
                  and appears on their dashboard, which is what you want when a senior colleague
                  takes the session and leaves without marking it.
                </InfoNote>
              </>
            )}
          </>
        )}

        {tab === 'cancel' && (
          <>
            <Field label="Reason">
              <Textarea
                rows={2}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="e.g. Faculty on medical leave"
              />
            </Field>
            <InfoNote>
              Students and staff are told immediately. A cancelled class is removed from the
              attendance denominator, so nobody is marked down for a lecture that never happened.
            </InfoNote>
          </>
        )}
      </div>
    </Modal>
  );
}
