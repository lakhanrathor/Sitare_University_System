import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, Trash2, Ban, RotateCcw, Info, Download } from 'lucide-react';
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
import { Card, PageHeader, Spinner, Button, Badge, EmptyState, ErrorNote } from '../../components/ui';

export default function SubjectReport() {
  const { subjectId } = useParams();
  const { notify } = useToast();
  useSubjectRoom(subjectId);

  const [detail, setDetail] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([api.subjectDetail(subjectId), api.sessions(subjectId)]);
      setDetail(d);
      setSessions(s);
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

  useSocketEvent('subject:attendance-updated', load);

  const toggleCancel = async (session) => {
    setBusyId(session.id);
    try {
      const res = await api.cancelSession(session.id, session.status !== 'cancelled');
      notify(
        `Subject now has ${res.conducted} conducted ${res.conducted === 1 ? 'class' : 'classes'}.`,
        { variant: 'success', title: res.status === 'cancelled' ? 'Class cancelled' : 'Class restored' }
      );
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Action failed' });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (session) => {
    if (!window.confirm(`Delete the class record for ${formatDate(session.date)}? This cannot be undone.`))
      return;
    setBusyId(session.id);
    try {
      const res = await api.deleteSession(session.id);
      notify(`Subject now has ${res.conducted} conducted classes.`, {
        variant: 'success',
        title: 'Class record deleted',
      });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Delete failed' });
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = () => {
    const rows = [
      ['Roll Number', 'Name', 'Present', 'Absent', 'Conducted', 'Percentage'],
      ...detail.students.map((s) => [
        s.rollNumber,
        s.name,
        s.present,
        s.absent,
        detail.conducted,
        s.percentage === null ? 'N/A' : s.percentage,
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail.subject.code}-attendance.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <Spinner label="Loading report" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const { subject, conducted, students } = detail;
  const min = subject.minAttendance;
  const atRisk = students.filter(
    (s) => s.percentage !== null && s.percentage < min
  ).length;
  const classAvg = conducted
    ? Math.round(
        (students.reduce((n, s) => n + s.present, 0) / (students.length * conducted)) * 10000
      ) / 100
    : null;

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
        title={subject.name}
        subtitle={cohortLine(subject)}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!students.length}>
              <Download className="h-4 w-4" />
              CSV
            </Button>
            <Link to={`/faculty/subject/${subjectId}/take`}>
              <Button size="sm">
                <ClipboardCheck className="h-4 w-4" />
                Take attendance
              </Button>
            </Link>
          </>
        }
      />

      {/* Summary */}
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {[
          { label: 'Classes conducted', value: conducted, sub: `of ${subject.plannedClasses} planned` },
          { label: 'Students enrolled', value: students.length, sub: 'in this subject' },
          {
            label: 'Class average',
            value: classAvg === null ? '—' : `${formatPct(classAvg)}%`,
            sub: 'across conducted classes',
          },
          {
            label: 'Below requirement',
            value: atRisk,
            sub: `under ${min}%`,
            tone: atRisk > 0 ? 'text-rose-600' : 'text-slate-900',
          },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <p className="text-xs text-slate-500">{s.label}</p>
            <p className={`nums mt-1 text-2xl font-semibold ${s.tone || 'text-slate-900'}`}>
              {s.value}
            </p>
            <p className="mt-0.5 text-xs text-slate-400">{s.sub}</p>
          </Card>
        ))}
      </div>

      {conducted === 0 && (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <Info className="mt-px h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs leading-relaxed text-slate-500">
            No classes conducted yet, so no student has a percentage. Percentages appear from the
            first recorded class — nobody is shown 0% against the {subject.plannedClasses} planned
            classes.
          </p>
        </div>
      )}

      {/* Student table */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">Student attendance</h2>
        <span className="nums text-xs text-slate-500">out of {conducted} conducted</span>
      </div>

      <Card className="mb-8 overflow-hidden">
        {students.length === 0 ? (
          <EmptyState title="No students enrolled" description="Enrol students to see the report." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5 sm:px-5">Roll no.</th>
                  <th className="px-4 py-2.5">Student</th>
                  <th className="nums px-4 py-2.5 text-right">Present</th>
                  <th className="nums px-4 py-2.5 text-right">Absent</th>
                  <th className="nums px-4 py-2.5 text-right">Attendance</th>
                  <th className="px-4 py-2.5 pr-5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((s) => {
                  const st = attendanceStatusFromPct(s.percentage, min);
                  const style = styleFor(st);
                  return (
                    <tr key={s.studentId} className="transition hover:bg-slate-50">
                      <td className="nums px-4 py-3 font-mono text-xs text-slate-500 sm:px-5">
                        {s.rollNumber}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">{s.name}</td>
                      <td className="nums px-4 py-3 text-right text-emerald-600">{s.present}</td>
                      <td className="nums px-4 py-3 text-right text-rose-600">{s.absent}</td>
                      <td className={`nums px-4 py-3 text-right font-semibold ${style.text}`}>
                        {formatPct(s.percentage)}
                        {s.percentage !== null && '%'}
                      </td>
                      <td className="px-4 py-3 pr-5">
                        <Badge status={st} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Class log */}
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-slate-900">Class log</h2>
        <span className="text-xs text-slate-500">
          {sessions.conducted} conducted · {sessions.plannedClasses} planned
        </span>
      </div>

      <Card className="overflow-hidden">
        {sessions.sessions.length === 0 ? (
          <EmptyState
            title="No classes recorded"
            description="Take attendance to record the first class of this subject."
            action={
              <Link to={`/faculty/subject/${subjectId}/take`}>
                <Button size="sm">
                  <ClipboardCheck className="h-4 w-4" />
                  Take attendance
                </Button>
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {sessions.sessions.map((s) => {
              const cancelled = s.status === 'cancelled';
              return (
                <li
                  key={s.id}
                  className={`flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5 ${
                    cancelled ? 'bg-slate-50/60' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-medium ${
                        cancelled ? 'text-slate-400 line-through' : 'text-slate-900'
                      }`}
                    >
                      {formatDate(s.date, true)}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {s.topic || 'No topic recorded'}
                    </p>
                  </div>

                  {cancelled ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                      Not counted
                    </span>
                  ) : (
                    <span className="nums rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                      {s.presentCount}/{s.totalMarked} present
                    </span>
                  )}

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busyId === s.id}
                      onClick={() => toggleCancel(s)}
                      title={cancelled ? 'Restore this class' : 'Mark class as cancelled'}
                    >
                      {cancelled ? (
                        <>
                          <RotateCcw className="h-3.5 w-3.5" />
                          Restore
                        </>
                      ) : (
                        <>
                          <Ban className="h-3.5 w-3.5" />
                          Cancel
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(s)}
                      className="text-rose-600 hover:bg-rose-50"
                      title="Delete this class record"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
