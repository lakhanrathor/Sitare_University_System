import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, BarChart3, Users, CalendarDays } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useSocketEvent } from '../../context/SocketContext';
import { Card, PageHeader, Spinner, EmptyState, ErrorNote, Button } from '../../components/ui';
import { firstName, formatDate } from '../../lib/format';

function SubjectCard({ s }) {
  const progress = s.plannedClasses ? Math.min((s.conducted / s.plannedClasses) * 100, 100) : 0;
  const standIn = s.standingIn;
  const coTeach = s.coTeaching;
  // A stand-in holds one register, not the subject — the report is not
  // theirs. A co-teacher (a standing per-period split, not a one-off
  // hand-over) genuinely shares the subject, so they see the report too.
  const canSeeReport = (!standIn || standIn.ownSubject) || Boolean(coTeach);

  return (
    <Card className="flex flex-col p-5 transition hover:border-slate-300 hover:shadow-md hover:shadow-slate-900/[0.05]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-slate-600">
              {s.code}
            </span>
            {/* The cohort, said plainly: two offerings of one subject are
                otherwise indistinguishable on this list. */}
            <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
              Sem {s.semester}
              {s.section?.name ? ` · Sec ${s.section.name}` : ''}
            </span>
          </div>
          <h3 className="mt-2 truncate text-sm font-semibold text-slate-900">{s.name}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {s.section?.name ? '' : 'All students · '}
            {s.credits} credits
          </p>
          {/*
            Standing in: the marks land on the other lecturer's record, and it
            covers only the dates listed — saying which matters, because it is
            not the subject and not next week.
          */}
          {standIn && !standIn.ownSubject && (
            <div className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-1.5 py-1 text-[11px] text-amber-800">
              <p className="font-medium">
                Standing in for {standIn.forName || 'its lecturer'}
              </p>
              <p className="mt-0.5">
                {standIn.classes.length === 1
                  ? formatDate(standIn.classes[0].date)
                  : `${standIn.classes.length} classes`}{' '}
                only
              </p>
            </div>
          )}

          {/*
            A standing per-period split, not a one-off hand-over — shown from
            whichever side this person sits on: the owner sees who else has a
            day of it, a partner sees whose subject it otherwise is.
          */}
          {coTeach?.role === 'partner' && (
            <div className="mt-1.5 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-1 text-[11px] text-indigo-800">
              <p className="font-medium">Co-teaching with {coTeach.mainTeacher || 'its lecturer'}</p>
              <p className="mt-0.5">
                {coTeach.days.join(', ')} {coTeach.days.length === 1 ? 'is' : 'are'} yours
              </p>
            </div>
          )}
          {coTeach?.role === 'owner' && (
            <div className="mt-1.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] text-slate-600">
              {coTeach.partners.map((p, i) => (
                <p key={i} className={i > 0 ? 'mt-0.5' : ''}>
                  <span className="font-medium">{p.name}</span> covers {p.days.join(', ')}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-slate-400" />
          <span className="nums font-medium">{s.enrolledCount}</span> students
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
          <span className="nums font-medium">{s.conducted}</span> conducted
        </span>
      </div>

      {/* Semester progress — planning context only, never the attendance denominator. */}
      <div className="mt-3.5">
        <div className="mb-1.5 flex items-baseline justify-between text-[11px] text-slate-500">
          <span>Semester progress</span>
          <span className="nums">
            {s.conducted} / {s.plannedClasses} planned
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width] duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <Link to={`/faculty/subject/${s.id}/take`} className="flex-1">
          <Button size="sm" className="w-full">
            <ClipboardCheck className="h-4 w-4" />
            Take attendance
          </Button>
        </Link>
        {canSeeReport && (
          <Link to={`/faculty/subject/${s.id}/report`}>
            <Button size="sm" variant="secondary">
              <BarChart3 className="h-4 w-4" />
              Report
            </Button>
          </Link>
        )}
      </div>
    </Card>
  );
}

export default function FacultyDashboard() {
  const { user } = useAuth();
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setSubjects(await api.subjects());
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

  useSocketEvent('subject:attendance-updated', load);

  if (loading) return <Spinner label="Loading your subjects" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const totalConducted = subjects.reduce((n, s) => n + s.conducted, 0);

  return (
    <div className="animate-fade-up">
      <PageHeader
        title={user?.role === 'admin' ? 'All subjects' : `Hello, ${firstName(user?.name)}`}
        subtitle={
          subjects.length
            ? `${subjects.length} subjects · ${totalConducted} classes conducted so far`
            : 'No subjects assigned yet'
        }
      />

      {subjects.length === 0 ? (
        <Card>
          <EmptyState
            title="No subjects assigned"
            description="Subjects assigned to you will appear here."
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((s) => (
            <SubjectCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
