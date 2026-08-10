import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CalendarDays, CheckCircle2, XCircle, Target, Info } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useSocketEvent } from '../../context/SocketContext';
import { useToast } from '../../context/ToastContext';
import { formatPct, styleFor, classesNeeded, classesCanMiss } from '../../lib/format';
import AttendanceRing from '../../components/AttendanceRing';
import { Card, PageHeader, Spinner, Badge, EmptyState, ErrorNote } from '../../components/ui';

function StatTile({ icon: Icon, label, value, hint, tone = 'slate' }) {
  const tones = {
    slate: 'text-slate-600 bg-slate-100',
    emerald: 'text-emerald-600 bg-emerald-50',
    rose: 'text-rose-600 bg-rose-50',
    indigo: 'text-indigo-600 bg-indigo-50',
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tones[tone]}`}>
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="nums text-lg leading-tight font-semibold text-slate-900">{value}</p>
        <p className="truncate text-xs text-slate-500">{hint || label}</p>
      </div>
    </div>
  );
}

function SubjectRow({ s }) {
  const style = styleFor(s.status);
  const hasClasses = s.conducted > 0;
  const pctWidth = s.percentage === null ? 0 : Math.min(s.percentage, 100);

  return (
    <Link
      to={`/subject/${s.subjectId}`}
      className="group flex items-center gap-4 px-4 py-4 transition hover:bg-slate-50 sm:px-5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-slate-600">
            {s.code}
          </span>
          <span className="truncate text-sm font-medium text-slate-900">{s.name}</span>
        </div>

        <p className="mt-1 text-xs text-slate-500">
          {hasClasses ? (
            <>
              <span className="nums font-medium text-slate-700">
                {s.present} of {s.conducted}
              </span>{' '}
              classes attended
              <span className="text-slate-400"> · {s.plannedClasses} planned this semester</span>
            </>
          ) : (
            <>No classes conducted yet · {s.plannedClasses} planned this semester</>
          )}
        </p>

        <div className="mt-2.5 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-[width] duration-700 ease-out ${style.bar}`}
            style={{ width: `${pctWidth}%` }}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
        <div className="text-right">
          <p className={`nums text-xl leading-none font-semibold ${style.text}`}>
            {formatPct(s.percentage)}
            {s.percentage !== null && <span className="text-sm">%</span>}
          </p>
          <div className="mt-1.5 hidden sm:block">
            <Badge status={s.status} />
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-slate-300 transition group-hover:text-slate-500" />
      </div>
    </Link>
  );
}

export default function StudentDashboard() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.myAttendance());
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

  // Realtime: faculty saves attendance -> these numbers update without a reload.
  useSocketEvent('attendance:updated', (payload) => {
    load();
    notify(`${payload.subjectCode} attendance was just updated.`, {
      variant: 'info',
      title: 'Attendance updated',
    });
  });

  if (loading) return <Spinner label="Loading your attendance" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const { overall, subjects } = data;
  const started = overall.conducted > 0;
  const need = classesNeeded(overall.present, overall.conducted, overall.minAttendance);
  const canMiss = classesCanMiss(overall.present, overall.conducted, overall.minAttendance);

  return (
    <div className="animate-fade-up">
      <PageHeader
        title={`Hello, ${user?.name?.split(' ')[0]}`}
        subtitle={[
          user?.rollNumber,
          user?.semester && `Semester ${user.semester}`,
          // Only worth stating when the year is actually divided.
          user?.section?.name && `Section ${user.section.name}`,
          user?.department,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      {/* Overall */}
      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-col items-center gap-7 p-6 sm:p-7 md:flex-row md:items-center md:gap-9">
          <div className="flex flex-col items-center">
            <AttendanceRing
              percentage={overall.percentage}
              status={overall.status}
              caption="Overall"
              minAttendance={overall.minAttendance}
            />
            <div className="mt-3">
              <Badge status={overall.status} />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900">Overall attendance</h2>
            <p className="mt-1 text-sm text-slate-500">
              {started ? (
                <>
                  You attended{' '}
                  <span className="nums font-semibold text-slate-900">{overall.present}</span> of the{' '}
                  <span className="nums font-semibold text-slate-900">{overall.conducted}</span>{' '}
                  classes conducted so far across {overall.subjectCount} subjects.
                </>
              ) : (
                <>No classes have been conducted yet this semester.</>
              )}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <StatTile
                icon={CalendarDays}
                label="Conducted"
                value={overall.conducted}
                hint="Classes conducted"
                tone="indigo"
              />
              <StatTile
                icon={CheckCircle2}
                label="Attended"
                value={overall.present}
                hint="Classes attended"
                tone="emerald"
              />
              <StatTile
                icon={XCircle}
                label="Missed"
                value={overall.absent}
                hint="Classes missed"
                tone="rose"
              />
              <StatTile
                icon={Target}
                label="Requirement"
                value={`${overall.minAttendance}%`}
                hint="Minimum required"
              />
            </div>

            {started && (
              <p className="mt-3.5 text-sm text-slate-600">
                {need > 0 ? (
                  <>
                    Attend the next{' '}
                    <span className="font-semibold text-slate-900">{need}</span>{' '}
                    {need === 1 ? 'class' : 'classes'} in a row to reach {overall.minAttendance}%.
                  </>
                ) : canMiss === 0 ? (
                  // Common early in the semester: on track, but with so few classes
                  // conducted that one absence already breaks the requirement.
                  <>
                    You are on track — but missing your next class would drop you below{' '}
                    {overall.minAttendance}%.
                  </>
                ) : (
                  <>
                    You can miss{' '}
                    <span className="font-semibold text-slate-900">{canMiss}</span>{' '}
                    more {canMiss === 1 ? 'class' : 'classes'} and stay above{' '}
                    {overall.minAttendance}%.
                  </>
                )}
              </p>
            )}
          </div>
        </div>

        {/* The rule, stated plainly where students will see it. */}
        <div className="flex items-start gap-2.5 border-t border-slate-200 bg-slate-50 px-6 py-3">
          <Info className="mt-px h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs leading-relaxed text-slate-500">
            Attendance is calculated on classes{' '}
            <span className="font-medium text-slate-700">actually conducted</span>, not on the{' '}
            {overall.totalPlanned} classes planned for the semester. Cancelled classes are excluded.
          </p>
        </div>
      </Card>

      {/* Subject-wise */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">Subject-wise attendance</h2>
        <span className="text-xs text-slate-500">{subjects.length} subjects</span>
      </div>

      <Card className="overflow-hidden">
        {subjects.length === 0 ? (
          <EmptyState
            title="No subjects yet"
            description="You are not enrolled in any subject for this semester."
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {subjects.map((s) => (
              <SubjectRow key={s.subjectId} s={s} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
