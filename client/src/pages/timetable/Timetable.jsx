import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CalendarDays, Info, Upload, Repeat } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useSocketEvent } from '../../context/SocketContext';
import {
  addDaysKey,
  startOfWeekKey,
  todayKey,
  weekLabel,
  shortDate,
  isGone,
} from '../../lib/timetable';
import SlotCell from '../../components/timetable/SlotCell';
import BookSlotModal from '../../components/timetable/BookSlotModal';
import ClassActionsModal from '../../components/timetable/ClassActionsModal';
import EditPeriodModal from '../../components/timetable/EditPeriodModal';
import { Card, PageHeader, Spinner, Button, ErrorNote, EmptyState } from '../../components/ui';

export default function Timetable() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [params, setParams] = useSearchParams();

  const [anchor, setAnchor] = useState(() => startOfWeekKey(params.get('date') || todayKey()));
  const [semester, setSemester] = useState(() => params.get('semester') || '');
  const [meta, setMeta] = useState(null);
  const [week, setWeek] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [bookTarget, setBookTarget] = useState(null);
  const [openOccurrence, setOpenOccurrence] = useState(null);
  const [editOccurrence, setEditOccurrence] = useState(null);
  // Only an admin needs these — for correcting a period and for pointing a
  // subject-less period at a register.
  const [assignableSubjects, setAssignableSubjects] = useState([]);
  const [facultyList, setFacultyList] = useState([]);

  const isStaff = user?.role === 'faculty' || user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const data = await api.week(anchor, { semester: semester || undefined });
      setWeek(data);
      // The server picks a default semester when none was asked for; adopt it
      // so the selector shows what is actually on screen.
      if (!semester && data.semester) setSemester(String(data.semester));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [anchor, semester]);

  useEffect(() => {
    api.timetableMeta().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin' || !semester) return;
    api
      .adminSubjects({ semester })
      .then(setAssignableSubjects)
      .catch(() => setAssignableSubjects([]));
  }, [user?.role, semester]);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    api.adminFaculty().then(setFacultyList).catch(() => setFacultyList([]));
  }, [user?.role]);

  const canCorrect = user?.role === 'admin';

  /*
   * Corrections apply to the recurring grid, so there has to be a grid entry
   * behind the cell. A one-off extra class is a dated booking, not a period —
   * it is undone from the actions dialog instead.
   */
  const startCorrecting = (o) => {
    if (!o.entryId) {
      notify('That is a one-off booking, not a timetabled period. Undo it instead.', {
        variant: 'error',
      });
      return;
    }
    // If a mistimed double already opened the actions dialog, replace it.
    setOpenOccurrence(null);
    setEditOccurrence(o);
  };

  useEffect(() => {
    load();
  }, [load]);

  // Any change anyone makes lands on this grid without a refresh.
  useSocketEvent('timetable:changed', load);
  useSocketEvent('notification:new', (n) => {
    if (String(n.type || '').startsWith('timetable:')) load();
  });

  const syncParams = (next) => {
    const p = {};
    if (next.date && next.date !== startOfWeekKey(todayKey())) p.date = next.date;
    if (next.semester) p.semester = next.semester;
    setParams(p, { replace: true });
  };

  const goto = (key) => {
    const start = startOfWeekKey(key);
    setAnchor(start);
    syncParams({ date: start, semester });
  };

  const changeSemester = (value) => {
    setSemester(value);
    syncParams({ date: anchor, semester: value });
  };

  /**
   * Columns: one per (teaching day × section) for staff, one per day for
   * students. Only sections belonging to the semester on screen are shown —
   * "Section A" exists in more than one year.
   */
  /*
   * Columns come from the published timetable itself, not from the section
   * list. The grid is a reproduction of the uploaded sheet: if the file splits
   * a day into two cohorts there are two columns, if it splits none there is
   * one, and a section that exists in the system but appears nowhere on the
   * timetable does not get an empty column of its own.
   */
  const sectionsInView = useMemo(() => {
    if (!week) return [];
    const found = new Map();
    for (const day of week.days) {
      for (const o of day.occurrences) {
        if (o.section) found.set(o.section.id, o.section);
      }
    }
    return [...found.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [week]);

  /* A lone unnamed cohort is not a split — printing "Sec" with nothing after
     it would invent a division the timetable does not have. */
  const splitBySection =
    sectionsInView.length > 1 || (sectionsInView.length === 1 && Boolean(sectionsInView[0].name));

  /* Extra classes still need a cohort to attach to, so fall back to the
     semester's sections when the grid itself has no split. */
  const sectionsForBooking = useMemo(() => {
    if (splitBySection) return sectionsInView;
    const sem = Number(semester || week?.semester);
    return (meta?.sections || []).filter((s) => !sem || s.semester === sem);
  }, [splitBySection, sectionsInView, meta, semester, week]);

  const columns = useMemo(() => {
    if (!week || !meta) return [];
    const days = week.days.filter((d) => d.teaching);
    if (!splitBySection) return days.map((d) => ({ day: d, section: null }));
    return days.flatMap((d) => sectionsInView.map((s) => ({ day: d, section: s })));
  }, [week, meta, sectionsInView, splitBySection]);

  const sectionsPerDay = splitBySection ? sectionsInView.length : 1;

  /* The clock belongs to the timetable on screen, with the built-in grid used
     only before anything has been published. */
  const periods = week?.slots?.length ? week.slots : meta?.slots || [];
  const lunch = week?.lunch || meta?.lunch || null;

  /* With no section split every class in the period belongs in the one column. */
  const cellFor = (day, section, slot) =>
    day.occurrences.filter(
      (o) => o.slot === slot && (!section || !o.section || o.section.id === section.id)
    );

  /** A teacher may act on their own class; an admin on any. */
  const canManage = (o) =>
    user?.role === 'admin' || (o.faculty && o.faculty.id === user?.id);

  if (loading) return <Spinner label="Loading timetable" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  if (!week?.timetable) {
    return (
      <Card>
        <EmptyState
          icon={CalendarDays}
          title="No timetable published yet"
          description={
            user?.role === 'admin'
              ? 'Upload a timetable to make it visible to all staff and students.'
              : 'Your administrator has not published a timetable yet.'
          }
          action={
            user?.role === 'admin' ? (
              <Link to="/timetable/manage">
                <Button size="sm">
                  <Upload className="h-4 w-4" />
                  Upload timetable
                </Button>
              </Link>
            ) : null
          }
        />
      </Card>
    );
  }

  const thisWeek = anchor === startOfWeekKey(todayKey());

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Timetable"
        subtitle={
          user?.role === 'student'
            ? `${week.timetable.name} · Semester ${week.semester}`
            : `${week.timetable.name}${splitBySection ? ' · all sections' : ''}`
        }
        actions={
          <>
            {isStaff && (
              <Link to="/swaps">
                <Button variant="secondary" size="sm">
                  <Repeat className="h-4 w-4" />
                  Swaps
                </Button>
              </Link>
            )}
            {user?.role === 'admin' && (
              <Link to="/timetable/manage">
                <Button size="sm">
                  <Upload className="h-4 w-4" />
                  Manage
                </Button>
              </Link>
            )}
          </>
        }
      />

      {/* Week navigation */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => goto(addDaysKey(anchor, -7))}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous week</span>
          </Button>
          <Button
            variant={thisWeek ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => goto(todayKey())}
          >
            This week
          </Button>
          <Button variant="secondary" size="sm" onClick={() => goto(addDaysKey(anchor, 7))}>
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next week</span>
          </Button>
          <span className="ml-2 text-sm font-medium text-slate-700">{weekLabel(anchor)}</span>

          {/* Staff can move between semesters; students are pinned to theirs. */}
          {isStaff && (meta?.semesters?.length || 0) > 1 && (
            <select
              value={semester}
              onChange={(e) => changeSemester(e.target.value)}
              className="ml-2 h-8 rounded-lg border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              aria-label="Semester"
            >
              {meta.semesters.map((s) => (
                <option key={s.semester} value={s.semester}>
                  Semester {s.semester}
                </option>
              ))}
            </select>
          )}
        </div>

        {isStaff && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <Info className="h-3.5 w-3.5" />
            Click an empty period to book it · click your own class to shift, swap or cancel
            {canCorrect && ' · double-click any class to correct it'}
          </p>
        )}
      </div>

      {/* The grid */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: columns.length * 118 + 88 }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 w-22 border-r border-b border-slate-200 bg-slate-50 p-2 text-left text-[11px] font-semibold text-slate-500">
                  Period
                </th>
                {week.days
                  .filter((d) => d.teaching)
                  .map((d) => (
                    <th
                      key={d.date}
                      colSpan={sectionsPerDay}
                      className={`border-r border-b border-slate-200 p-2 text-center text-[11px] font-semibold ${
                        d.date === todayKey() ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-50 text-slate-600'
                      }`}
                    >
                      {shortDate(d.date)}
                    </th>
                  ))}
              </tr>
              {splitBySection && (
                <tr>
                  <th className="sticky left-0 z-10 border-r border-b border-slate-200 bg-slate-50" />
                  {columns.map((c) => (
                    <th
                      key={`${c.day.date}-${c.section?.id}`}
                      className="border-r border-b border-slate-200 bg-white p-1 text-center text-[10px] font-medium text-slate-500"
                    >
                      {c.section?.name ? `Sec ${c.section.name}` : 'All'}
                    </th>
                  ))}
                </tr>
              )}
            </thead>

            <tbody>
              {/* Periods come from the published timetable, not a fixed clock. */}
              {periods.map((slot, idx) => (
                <Fragment key={slot.slot}>
                  {/* Lunch divider sits where it does on the printed grid. */}
                  {lunch?.afterSlot === slot.slot - 1 && (
                    <tr>
                      <td
                        colSpan={columns.length + 1}
                        className="border-b border-slate-200 bg-slate-100 py-1 text-center text-[10px] font-semibold tracking-wide text-slate-500 uppercase"
                      >
                        {lunch.label || 'Lunch'} · {lunch.start} – {lunch.end}
                      </td>
                    </tr>
                  )}
                  <tr className={idx % 2 ? 'bg-slate-50/40' : ''}>
                    <td className="sticky left-0 z-10 border-r border-b border-slate-200 bg-white p-2 align-top">
                      <p className="text-[11px] font-semibold text-slate-700">{slot.slot}</p>
                      <p className="text-[10px] leading-tight text-slate-400">{slot.label}</p>
                    </td>

                    {columns.map((c) => {
                      const occ = cellFor(c.day, c.section, slot.slot);
                      const free = occ.every(isGone);
                      return (
                        <td
                          key={`${c.day.date}-${c.section?.id ?? 'all'}-${slot.slot}`}
                          className="border-r border-b border-slate-200 p-1 align-top"
                        >
                          <SlotCell
                            occurrences={occ}
                            currentUserId={user?.id}
                            canBook={isStaff && free && c.day.date >= todayKey()}
                            onBook={() =>
                              setBookTarget({
                                date: c.day.date,
                                slot: slot.slot,
                                slotLabel: slot.label,
                                // No split: bookings attach to the semester's cohort.
                                sectionId: c.section?.id || sectionsForBooking[0]?.id,
                                sectionName: c.section?.name || sectionsForBooking[0]?.name,
                              })
                            }
                            onOpen={(o) => setOpenOccurrence(o)}
                            onEdit={canCorrect ? (o) => startCorrecting(o) : undefined}
                          />
                        </td>
                      );
                    })}
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {week.timetable && (
        <p className="mt-3 text-center text-xs text-slate-400">
          Weekends are not teaching days. Changes here apply to a single date — the recurring
          timetable stays as published.
        </p>
      )}

      <BookSlotModal
        open={Boolean(bookTarget)}
        target={bookTarget}
        onClose={() => setBookTarget(null)}
        onDone={load}
      />

      <ClassActionsModal
        open={Boolean(openOccurrence)}
        occurrence={openOccurrence}
        slots={periods}
        canManage={openOccurrence ? canManage(openOccurrence) : false}
        isAdmin={user?.role === 'admin'}
        subjects={assignableSubjects}
        /* Reachable from here too, so a mistimed double-click is not a dead end. */
        onEdit={canCorrect ? startCorrecting : undefined}
        onClose={() => setOpenOccurrence(null)}
        onDone={load}
      />

      <EditPeriodModal
        open={Boolean(editOccurrence)}
        occurrence={editOccurrence}
        subjects={assignableSubjects}
        faculty={facultyList}
        onClose={() => setEditOccurrence(null)}
        onDone={() => {
          load();
          // A rename or a new subject changes the list the editor offers.
          if (semester) api.adminSubjects({ semester }).then(setAssignableSubjects).catch(() => {});
        }}
      />
    </div>
  );
}
