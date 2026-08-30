import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Save, CheckCheck, Search, PencilLine, Info, CalendarDays, CalendarClock,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { useSubjectRoom, useSocketEvent } from '../../context/SocketContext';
import {
  formatPct,
  styleFor,
  attendanceStatusFromPct,
  formatDate,
  cohortLine,
} from '../../lib/format';
import {
  Card, PageHeader, Spinner, Button, EmptyState, ErrorNote, Field, Select, InfoNote,
} from '../../components/ui';

const OPTIONS = [
  { value: 'present', label: 'P', title: 'Present', on: 'bg-emerald-600 text-white' },
  { value: 'late', label: 'L', title: 'Late (counts as present)', on: 'bg-amber-500 text-white' },
  { value: 'absent', label: 'A', title: 'Absent', on: 'bg-rose-600 text-white' },
];

/** How a class earned its place in the picker. */
const ORIGIN_NOTE = {
  extra: 'extra class',
  'moved-in': 'moved here',
  'swapped-in': 'swapped in',
  recorded: 'off-timetable',
};

const keyOf = (o) => `${o.date}|${o.slot}`;

function StatusToggle({ value, onChange, disabled }) {
  return (
    <div
      role="radiogroup"
      className="inline-flex overflow-hidden rounded-lg border border-slate-300 bg-white"
    >
      {OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`h-8 w-9 text-xs font-semibold transition disabled:opacity-50 ${
              active ? o.on : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function TakeAttendance() {
  const { subjectId } = useParams();
  const { notify } = useToast();
  useSubjectRoom(subjectId);

  const [schedule, setSchedule] = useState(null);
  const [selected, setSelected] = useState(null); // { date, slot }
  const [topic, setTopic] = useState('');
  const [sheet, setSheet] = useState(null);
  const [marks, setMarks] = useState({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /**
   * The class list comes from the timetable, so cancelled classes never appear
   * and a rescheduled one shows up on the date it actually runs.
   */
  const loadSchedule = useCallback(async () => {
    try {
      const data = await api.occurrences(subjectId);
      setSchedule(data);
      setError('');
      setSelected((prev) => {
        if (prev && data.occurrences.some((o) => keyOf(o) === keyOf(prev))) return prev;
        // Land on the oldest class still missing a sheet — the one most likely
        // to be forgotten — otherwise the most recent class that has happened.
        const takeable = data.occurrences.filter((o) => o.takeable);
        const pending = takeable.filter((o) => !o.taken);
        const pick = pending.length ? pending[pending.length - 1] : takeable[0];
        return pick ? { date: pick.date, slot: pick.slot } : null;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [subjectId]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  // A timetable change can add or remove a class from this list.
  useSocketEvent('timetable:changed', loadSchedule);

  const loadSheet = useCallback(async () => {
    if (!selected) return;
    setSheetLoading(true);
    try {
      const data = await api.sheet(subjectId, selected.date, selected.slot);
      setSheet(data);
      setMarks(Object.fromEntries(data.students.map((s) => [s.studentId, s.marked])));
      setTopic(data.existingSession?.topic || '');
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSheetLoading(false);
    }
  }, [subjectId, selected]);

  useEffect(() => {
    loadSheet();
  }, [loadSheet]);

  const setAll = (status) =>
    setMarks(Object.fromEntries(sheet.students.map((s) => [s.studentId, status])));

  const counts = useMemo(() => {
    const v = Object.values(marks);
    return {
      present: v.filter((x) => x === 'present').length,
      late: v.filter((x) => x === 'late').length,
      absent: v.filter((x) => x === 'absent').length,
    };
  }, [marks]);

  const visible = useMemo(() => {
    if (!sheet) return [];
    const q = query.trim().toLowerCase();
    if (!q) return sheet.students;
    return sheet.students.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.rollNumber || '').toLowerCase().includes(q)
    );
  }, [sheet, query]);

  const groups = useMemo(() => {
    const list = schedule?.occurrences || [];
    return {
      pending: list.filter((o) => o.takeable && !o.taken),
      recorded: list.filter((o) => o.takeable && o.taken),
      upcoming: list.filter((o) => !o.takeable),
    };
  }, [schedule]);

  const current = useMemo(
    () => (schedule?.occurrences || []).find((o) => selected && keyOf(o) === keyOf(selected)),
    [schedule, selected]
  );

  /*
   * The subject's other periods on the same day. A lab timetabled across two
   * or three of them is one sitting, so the register is the same for all of
   * it — and ticking the same names again for each is busywork.
   */
  const sameDay = useMemo(() => {
    if (!selected) return [];
    return (schedule?.occurrences || [])
      .filter((o) => o.date === selected.date && o.slot !== selected.slot && o.takeable)
      .sort((a, b) => a.slot - b.slot);
  }, [schedule, selected]);

  /** Which of those the teacher has chosen to cover as well. */
  const [alsoSlots, setAlsoSlots] = useState([]);

  // A different class means a different set of neighbours; never carry them over.
  useEffect(() => {
    setAlsoSlots([]);
  }, [selected?.date, selected?.slot]);

  const toggleAlso = (slot) =>
    setAlsoSlots((prev) => (prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot]));

  const allSelected = sameDay.length > 0 && alsoSlots.length === sameDay.length;

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.mark(subjectId, {
        date: selected.date,
        slot: selected.slot,
        alsoSlots,
        topic: topic.trim(),
        records: sheet.students.map((s) => ({
          studentId: s.studentId,
          status: marks[s.studentId] || 'absent',
        })),
      });
      const covered = res.slots?.length || 1;
      notify(
        `${res.presentCount} present, ${res.absentCount} absent${
          covered > 1 ? `, recorded against ${covered} classes` : ''
        }. This subject now has ${res.conducted} conducted ${
          res.conducted === 1 ? 'class' : 'classes'
        }.`,
        { variant: 'success', title: `Saved for ${formatDate(selected.date)}` }
      );
      await Promise.all([loadSchedule(), loadSheet()]);
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner label="Loading class schedule" />;
  if (error && !schedule) return <ErrorNote>{error}</ErrorNote>;

  const label = (o) =>
    `${formatDate(o.date, true)} · ${o.slotLabel}${
      ORIGIN_NOTE[o.origin] ? ` · ${ORIGIN_NOTE[o.origin]}` : ''
    }`;

  /* No class to record against at all. */
  if (!schedule.occurrences.length) {
    return (
      <div className="animate-fade-up">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to my subjects
        </Link>
        <PageHeader
          title="Take attendance"
          subtitle={`${schedule.subject.name} · ${cohortLine(schedule.subject)}`}
        />
        <Card>
          <EmptyState
            icon={CalendarDays}
            title="No classes scheduled"
            description="This subject has no classes on the published timetable, so there is nothing to record yet."
          />
        </Card>
      </div>
    );
  }

  const noneTakeable = groups.pending.length === 0 && groups.recorded.length === 0;

  return (
    <div className="animate-fade-up">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to my subjects
      </Link>

      <PageHeader
        title="Take attendance"
        subtitle={`${schedule.subject.name} · ${cohortLine(schedule.subject)}`}
        actions={
          <Link to={`/faculty/subject/${subjectId}/report`}>
            <Button variant="secondary" size="sm">
              View report
            </Button>
          </Link>
        }
      />

      {/* Which class */}
      <Card className="mb-4 p-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_1fr]">
          <Field
            label="Class"
            hint={
              groups.pending.length
                ? `${groups.pending.length} ${groups.pending.length === 1 ? 'class needs' : 'classes need'} attendance`
                : 'Every class held so far has been recorded'
            }
          >
            <Select
              value={selected ? keyOf(selected) : ''}
              onChange={(e) => {
                const [date, slot] = e.target.value.split('|');
                setSelected({ date, slot: Number(slot) });
              }}
            >
              {groups.pending.length > 0 && (
                <optgroup label="Needs attendance">
                  {groups.pending.map((o) => (
                    <option key={keyOf(o)} value={keyOf(o)}>
                      {label(o)}
                    </option>
                  ))}
                </optgroup>
              )}
              {groups.recorded.length > 0 && (
                <optgroup label="Already recorded">
                  {groups.recorded.map((o) => (
                    <option key={keyOf(o)} value={keyOf(o)}>
                      {label(o)}
                    </option>
                  ))}
                </optgroup>
              )}
              {groups.upcoming.length > 0 && (
                <optgroup label="Upcoming — not held yet">
                  {groups.upcoming.map((o) => (
                    <option key={keyOf(o)} value={keyOf(o)} disabled>
                      {label(o)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>

          <Field label={<span>Topic covered <span className="font-normal text-slate-400">(optional)</span></span>}>
            <input
              type="text"
              value={topic}
              placeholder="e.g. Virtual memory"
              onChange={(e) => setTopic(e.target.value)}
              className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
          </Field>
        </div>

        {/*
          A block of periods is one sitting. Offered rather than assumed: the
          same subject can legitimately run twice in a day with different
          students in the room, so the teacher says which classes this covers.
        */}
        {sameDay.length > 0 && !noneTakeable && (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-indigo-900">
                {sameDay.length === 1
                  ? 'One more class of this subject today'
                  : `${sameDay.length} more classes of this subject today`}
              </p>
              <button
                onClick={() => setAlsoSlots(allSelected ? [] : sameDay.map((o) => o.slot))}
                className="text-xs font-medium text-indigo-700 underline-offset-2 hover:underline"
              >
                {allSelected ? 'Clear' : `Apply to all ${sameDay.length + 1}`}
              </button>
            </div>
            <p className="mt-0.5 text-xs text-indigo-800/80">
              Take the register once and tick the classes it covers. Each one is still recorded as
              its own class, so the conducted count matches the timetable.
            </p>

            <div className="mt-2.5 flex flex-wrap gap-2">
              {sameDay.map((o) => (
                <label
                  key={keyOf(o)}
                  className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition ${
                    alsoSlots.includes(o.slot)
                      ? 'border-indigo-400 bg-white text-indigo-800'
                      : 'border-indigo-200 bg-white/60 text-slate-600 hover:border-indigo-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={alsoSlots.includes(o.slot)}
                    onChange={() => toggleAlso(o.slot)}
                    className="rounded border-slate-300"
                  />
                  {o.slotLabel}
                  {/* Overwriting a register already taken is a correction, not a slip — but say so. */}
                  {o.taken && <span className="text-amber-700">· already recorded</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4">
          {noneTakeable ? (
            <InfoNote icon={CalendarClock}>
              None of this subject's classes have been held yet. The next one is{' '}
              <span className="font-medium text-slate-700">
                {/* occurrences sort most-recent-first, so the soonest upcoming class is the last one, not the first */}
                {label(groups.upcoming[groups.upcoming.length - 1])}
              </span>{' '}
              — you can record attendance once it has happened.
            </InfoNote>
          ) : (
            <InfoNote>
              {current?.taken ? (
                <>
                  Attendance for this class was already recorded — saving will update it. This
                  subject has{' '}
                  <span className="nums font-medium text-slate-700">
                    {schedule.conducted} conducted
                  </span>{' '}
                  {schedule.conducted === 1 ? 'class' : 'classes'}.
                </>
              ) : (
                <>
                  Saving records class{' '}
                  <span className="nums font-medium text-slate-700">#{schedule.conducted + 1}</span>{' '}
                  for this subject. Percentages are recalculated over{' '}
                  {schedule.conducted + 1} conducted{' '}
                  {schedule.conducted === 0 ? 'class' : 'classes'} — the{' '}
                  {schedule.subject.plannedClasses} planned classes are not used.
                </>
              )}
              {current?.origin === 'moved-in' && current.movedFrom && (
                <>
                  {' '}
                  This class was moved here from {formatDate(current.movedFrom.date)}.
                </>
              )}
              {current?.origin === 'extra' && ' This is an extra class booked into a free period.'}
              {' '}
              Cancelled classes are not listed — there is nothing to record for them.
            </InfoNote>
          )}
        </div>
      </Card>

      {/* Roster */}
      {sheetLoading && !sheet ? (
        <Spinner label="Loading students" />
      ) : !sheet ? null : (
        <>
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
                  <span className="nums">{counts.present + counts.late}</span> present
                </span>
                <span className="rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-700">
                  <span className="nums">{counts.absent}</span> absent
                </span>
                {counts.late > 0 && (
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700">
                    <span className="nums">{counts.late}</span> late
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find student"
                    className="h-8 w-40 rounded-lg border border-slate-300 pr-2.5 pl-8 text-[13px] placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!current?.takeable}
                  onClick={() => setAll('present')}
                >
                  <CheckCheck className="h-4 w-4" />
                  All present
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!current?.takeable}
                  onClick={() => setAll('absent')}
                >
                  All absent
                </Button>
              </div>
            </div>

            {sheet.students.length === 0 ? (
              <EmptyState
                title="No students enrolled"
                description="Enrol students in this subject before taking attendance."
              />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No match"
                description={`Nothing matches "${query}".`}
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {visible.map((s) => {
                  const st = attendanceStatusFromPct(s.percentage, sheet.subject.minAttendance);
                  const style = styleFor(st);
                  return (
                    <li
                      key={s.studentId}
                      className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 sm:px-5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{s.name}</p>
                        <p className="nums text-xs text-slate-500">
                          {s.rollNumber}
                          {sheet.conducted > 0 && (
                            <>
                              {' · '}
                              <span className={style.text}>{formatPct(s.percentage)}% so far</span>
                              <span className="text-slate-400">
                                {' '}
                                ({s.present}/{sheet.conducted})
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                      <StatusToggle
                        value={marks[s.studentId]}
                        disabled={!current?.takeable}
                        onChange={(v) => setMarks((m) => ({ ...m, [s.studentId]: v }))}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {sheet.students.length > 0 && (
            <div className="sticky bottom-4 mt-4">
              <div className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg shadow-slate-900/5 backdrop-blur">
                <p className="min-w-0 truncate text-sm text-slate-600">
                  {current?.taken && (
                    <span className="mr-2 inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                      <PencilLine className="h-3.5 w-3.5" />
                      Editing
                    </span>
                  )}
                  <span className="nums font-medium text-slate-900">{sheet.students.length}</span>{' '}
                  students · {selected && formatDate(selected.date)} · {current?.slotLabel}
                </p>
                <Button onClick={save} loading={saving} disabled={!current?.takeable}>
                  <Save className="h-4 w-4" />
                  {/* Say the count when one register covers a block. */}
                  {alsoSlots.length > 0
                    ? `Save for ${alsoSlots.length + 1} classes`
                    : current?.taken
                      ? 'Update attendance'
                      : 'Save attendance'}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
