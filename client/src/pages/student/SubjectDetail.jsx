import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, XCircle, Clock, Ban, Info } from 'lucide-react';
import { api } from '../../lib/api';
import { useSocketEvent } from '../../context/SocketContext';
import {
  formatDate,
  styleFor,
  attendanceStatusFromPct,
  classesNeeded,
  classesCanMiss,
} from '../../lib/format';
import AttendanceRing from '../../components/AttendanceRing';
import { Card, PageHeader, Spinner, Badge, EmptyState, ErrorNote } from '../../components/ui';

const MARK = {
  present: { label: 'Present', icon: CheckCircle2, cls: 'text-emerald-600 bg-emerald-50' },
  late: { label: 'Late', icon: Clock, cls: 'text-amber-600 bg-amber-50' },
  absent: { label: 'Absent', icon: XCircle, cls: 'text-rose-600 bg-rose-50' },
  cancelled: { label: 'Cancelled', icon: Ban, cls: 'text-slate-400 bg-slate-100' },
};

export default function StudentSubjectDetail() {
  const { subjectId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.mySubject(subjectId));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [subjectId]);

  useEffect(() => {
    load();
  }, [load]);

  useSocketEvent('attendance:updated', (payload) => {
    if (payload.subjectId === subjectId) load();
  });

  if (loading) return <Spinner label="Loading subject" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const { subject, conducted, present, absent, percentage, history } = data;
  const status = attendanceStatusFromPct(percentage, subject.minAttendance);
  const style = styleFor(status);
  const need = classesNeeded(present, conducted, subject.minAttendance);
  const canMiss = classesCanMiss(present, conducted, subject.minAttendance);

  return (
    <div className="animate-fade-up">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to my attendance
      </Link>

      <PageHeader
        title={subject.name}
        subtitle={`${subject.code}${subject.faculty ? ` · ${subject.faculty.name}` : ''}`}
      />

      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-col items-center gap-7 p-6 sm:flex-row sm:gap-9 sm:p-7">
          <div className="flex flex-col items-center">
            <AttendanceRing
              percentage={percentage}
              status={status}
              size={148}
              caption={subject.code}
              minAttendance={subject.minAttendance}
            />
            <div className="mt-3">
              <Badge status={status} />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Conducted</dt>
                <dd className="nums mt-0.5 text-xl font-semibold text-slate-900">{conducted}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Attended</dt>
                <dd className="nums mt-0.5 text-xl font-semibold text-emerald-600">{present}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Missed</dt>
                <dd className="nums mt-0.5 text-xl font-semibold text-rose-600">{absent}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Planned</dt>
                <dd className="nums mt-0.5 text-xl font-semibold text-slate-400">
                  {subject.plannedClasses}
                </dd>
              </div>
            </dl>

            {conducted > 0 ? (
              <p className={`mt-5 rounded-lg px-3.5 py-2.5 text-sm ${style.bg} ${style.text}`}>
                {need > 0 ? (
                  <>
                    Attend the next <span className="font-semibold">{need}</span>{' '}
                    {need === 1 ? 'class' : 'classes'} in a row to reach {subject.minAttendance}%.
                  </>
                ) : canMiss === 0 ? (
                  <>
                    You are on track — but missing your next class would drop you below{' '}
                    {subject.minAttendance}%.
                  </>
                ) : (
                  <>
                    You can miss <span className="font-semibold">{canMiss}</span> more{' '}
                    {canMiss === 1 ? 'class' : 'classes'} and stay above {subject.minAttendance}%.
                  </>
                )}
              </p>
            ) : (
              <p className="mt-5 rounded-lg bg-slate-50 px-3.5 py-2.5 text-sm text-slate-500">
                No classes have been conducted in this subject yet.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2.5 border-t border-slate-200 bg-slate-50 px-6 py-3">
          <Info className="mt-px h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs leading-relaxed text-slate-500">
            {conducted > 0 ? (
              <>
                <span className="nums font-medium text-slate-700">
                  {present} ÷ {conducted}
                </span>{' '}
                conducted classes. The {subject.plannedClasses} classes planned for the semester are
                not part of this calculation.
              </>
            ) : (
              <>
                Your percentage will appear once the first class is conducted — you are not shown 0%
                for a subject that has not started.
              </>
            )}
          </p>
        </div>
      </Card>

      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">Class history</h2>
        <span className="text-xs text-slate-500">
          {history.length} {history.length === 1 ? 'record' : 'records'}
        </span>
      </div>

      <Card className="overflow-hidden">
        {history.length === 0 ? (
          <EmptyState
            title="No classes recorded"
            description="Class records appear here as soon as your faculty takes attendance."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {history.map((h) => {
              const m = MARK[h.status] || MARK.absent;
              const Icon = m.icon;
              return (
                <li key={h.sessionId} className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${m.cls}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{formatDate(h.date)}</p>
                    <p className="truncate text-xs text-slate-500">
                      {h.topic || 'No topic recorded'}
                      {h.remark && ` · ${h.remark}`}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${m.cls}`}
                  >
                    {m.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
