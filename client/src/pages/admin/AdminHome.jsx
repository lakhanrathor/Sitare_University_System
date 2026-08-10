import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, GraduationCap, CalendarDays, BookOpen, Repeat, Upload, UserPlus,
  AlertTriangle, ArrowRight, CheckCircle2, Activity,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useSocketEvent } from '../../context/SocketContext';
import { Card, PageHeader, Spinner, Button, ErrorNote } from '../../components/ui';

function Stat({ icon: Icon, label, value, sub, to, tone = 'slate' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  const body = (
    <Card className={`p-4 ${to ? 'transition hover:border-slate-300 hover:shadow-md' : ''}`}>
      <div className="flex items-start gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tones[tone]}`}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <p className="nums text-2xl leading-tight font-semibold text-slate-900">{value}</p>
          <p className="text-sm font-medium text-slate-700">{label}</p>
          {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
        </div>
      </div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

/** One thing the admin should deal with, with a link straight to where it lives. */
function TodoRow({ count, label, detail, to, action }) {
  if (!count) return null;
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 sm:px-5"
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">
          <span className="nums">{count}</span> {label}
        </p>
        {detail && <p className="text-xs text-slate-500">{detail}</p>}
      </div>
      <span className="hidden shrink-0 text-xs font-medium text-indigo-600 sm:block">{action}</span>
      <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:text-slate-500" />
    </Link>
  );
}

export default function AdminHome() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.adminOverview());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useSocketEvent('swap:updated', load);
  useSocketEvent('timetable:changed', load);

  if (loading) return <Spinner label="Loading administration overview" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const { people, academics, timetables, activity, todo } = data;
  const todoTotal =
    todo.pendingSwaps + todo.unassignedStudents + todo.subjectsNoFaculty + todo.missingTimetables;

  return (
    <div className="animate-fade-up">
      {/* A console, not a personal feed — the header already says who is signed in. */}
      <PageHeader
        title="Administration"
        subtitle="Set up the academic structure, publish timetables and handle approvals"
        actions={
          <>
            <Link to="/admin/people">
              <Button variant="secondary" size="sm">
                <UserPlus className="h-4 w-4" />
                Add people
              </Button>
            </Link>
            <Link to="/timetable/manage">
              <Button size="sm">
                <Upload className="h-4 w-4" />
                Upload timetable
              </Button>
            </Link>
          </>
        }
      />

      {/* Needs attention */}
      <Card className="mb-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-slate-900">Needs your attention</h2>
          {todoTotal > 0 && (
            <span className="nums rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {todoTotal}
            </span>
          )}
        </div>

        {todoTotal === 0 ? (
          <div className="flex items-center gap-2.5 px-5 py-6 text-sm text-slate-500">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            Nothing outstanding — every semester has a timetable and no approvals are waiting.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            <TodoRow
              count={todo.pendingSwaps}
              label={todo.pendingSwaps === 1 ? 'swap request awaiting approval' : 'swap requests awaiting approval'}
              detail="Nothing moves on the timetable until you decide"
              to="/swaps"
              action="Review"
            />
            <TodoRow
              count={todo.missingTimetables}
              label={todo.missingTimetables === 1 ? 'semester has no timetable' : 'semesters have no timetable'}
              detail={
                timetables.missingTimetables.length
                  ? `Semester ${timetables.missingTimetables.join(', ')}`
                  : undefined
              }
              to="/timetable/manage"
              action="Upload"
            />
            <TodoRow
              count={todo.unassignedStudents}
              label={todo.unassignedStudents === 1 ? 'student has no section' : 'students have no section'}
              detail="They cannot see a timetable until they are assigned"
              to="/admin/people"
              action="Assign"
            />
            <TodoRow
              count={todo.subjectsNoFaculty}
              label={todo.subjectsNoFaculty === 1 ? 'subject has no lecturer' : 'subjects have no lecturer'}
              detail="Attendance cannot be recorded without one"
              to="/admin/academics"
              action="Assign"
            />
          </div>
        )}
      </Card>

      {/* Numbers */}
      <h2 className="mb-3 text-base font-semibold text-slate-900">At a glance</h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={GraduationCap}
          label="Students"
          value={people.students}
          sub={`across ${academics.sections} sections`}
          to="/admin/people"
          tone="indigo"
        />
        <Stat
          icon={Users}
          label="Faculty"
          value={people.faculty}
          sub={`${people.admins} admin ${people.admins === 1 ? 'account' : 'accounts'}`}
          to="/admin/people"
        />
        <Stat
          icon={BookOpen}
          label="Subjects"
          value={academics.subjects}
          sub={`semesters ${academics.semesters.join(', ') || '—'}`}
          to="/admin/academics"
        />
        <Stat
          icon={Activity}
          label="Classes this week"
          value={activity.sessionsThisWeek}
          sub={`${activity.changesThisWeek} schedule changes`}
          tone="emerald"
        />
      </div>

      {/* Live timetables */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">Live timetables</h2>
        <Link
          to="/timetable/manage"
          className="text-xs font-medium text-indigo-600 hover:text-indigo-700"
        >
          Manage all
        </Link>
      </div>

      <Card className="overflow-hidden">
        {timetables.published.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-slate-500">No timetable has been published yet.</p>
            <Link to="/timetable/manage" className="mt-3 inline-block">
              <Button size="sm">
                <Upload className="h-4 w-4" />
                Upload one
              </Button>
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {timetables.published.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                  <CalendarDays className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{t.name}</p>
                  <p className="nums text-xs text-slate-500">
                    Semester {t.semester} · {t.entryCount} periods · live from {t.effectiveFrom}
                  </p>
                </div>
                <Link to={`/timetable?semester=${t.semester}`}>
                  <Button variant="secondary" size="sm">
                    View
                  </Button>
                </Link>
              </li>
            ))}
            {timetables.drafts > 0 && (
              <li className="bg-slate-50 px-4 py-2.5 text-xs text-slate-500 sm:px-5">
                <span className="nums font-medium text-slate-700">{timetables.drafts}</span> draft
                {timetables.drafts === 1 ? '' : 's'} not yet published
              </li>
            )}
          </ul>
        )}
      </Card>

      {/* Shortcuts */}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          { to: '/admin/people', icon: Users, title: 'People', body: 'Add teachers and students, assign sections, reset access' },
          { to: '/admin/academics', icon: BookOpen, title: 'Academics', body: 'Sections, subjects, lecturers and enrolment' },
          { to: '/swaps', icon: Repeat, title: 'Approvals', body: 'Decide on class swaps before they reach the timetable' },
        ].map((c) => (
          <Link key={c.to} to={c.to}>
            <Card className="h-full p-4 transition hover:border-slate-300 hover:shadow-md">
              <c.icon className="h-4.5 w-4.5 text-indigo-600" />
              <p className="mt-2.5 text-sm font-semibold text-slate-900">{c.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{c.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
