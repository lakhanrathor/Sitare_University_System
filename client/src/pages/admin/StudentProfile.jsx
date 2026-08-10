import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Trash2,
  Download,
  Mail,
  FileText,
  Send,
  Inbox,
  CalendarRange,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { formatPct, styleFor, sectionLabel, formatDate } from '../../lib/format';
import {
  Card,
  PageHeader,
  Spinner,
  EmptyState,
  ErrorNote,
  Button,
} from '../../components/ui';

const readableSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** The days missed: one day, a range, or nothing if the student gave none. */
function leavePeriod(d) {
  if (!d.leaveFrom && !d.leaveTo) return null;
  if (d.leaveFrom && d.leaveTo && d.leaveFrom !== d.leaveTo) {
    return `${formatDate(d.leaveFrom)} – ${formatDate(d.leaveTo, true)}`;
  }
  return formatDate(d.leaveFrom || d.leaveTo, true);
}

export default function StudentProfile() {
  const { studentId } = useParams();
  const { notify } = useToast();

  const [data, setData] = useState(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [profile, documents] = await Promise.all([
        api.studentProfile(studentId),
        api.leaveDocuments(studentId),
      ]);
      setData(profile);
      setDocs(documents);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (doc) => {
    try {
      await api.deleteLeaveDocument(doc.id);
      notify('Record deleted', { variant: 'success' });
      load();
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  const download = async (doc, a) => {
    try {
      await api.downloadAttachment(doc.id, a.id, a.filename);
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  if (loading) return <Spinner label="Loading student" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;

  const { student, overall, subjects } = data;
  const s = styleFor(overall.status);

  return (
    <div className="animate-fade-up">
      <Link
        to="/admin/people"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to people
      </Link>

      <PageHeader
        title={student.name}
        subtitle={`${student.rollNumber || '—'} · ${student.email} · Semester ${
          student.semester ?? '—'
        } · ${sectionLabel(student.section)}`}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Attendance, so the decision and the evidence sit on one screen. */}
        <Card className="p-5">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
            Overall attendance
          </p>
          <p className={`nums mt-1 text-3xl font-semibold ${s.text}`}>
            {formatPct(overall.percentage)}
            {overall.percentage !== null && <span className="text-lg">%</span>}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {overall.present} of {overall.conducted} classes attended · needs{' '}
            {overall.minAttendance}%
          </p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${s.bar}`}
              style={{ width: `${Math.min(overall.percentage ?? 0, 100)}%` }}
            />
          </div>
        </Card>

        <Card className="p-5 lg:col-span-2">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">By subject</p>
          <ul className="mt-2 divide-y divide-slate-100">
            {subjects.map((sub) => {
              const st = styleFor(sub.status);
              return (
                <li key={sub.subjectId} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-slate-800">{sub.code}</span>{' '}
                    <span className="text-slate-500">{sub.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="nums text-xs text-slate-500">
                      {sub.present}/{sub.conducted}
                    </span>
                    <span className={`nums w-14 text-right font-medium ${st.text}`}>
                      {formatPct(sub.percentage)}
                      {sub.percentage !== null && '%'}
                    </span>
                  </span>
                </li>
              );
            })}
            {!subjects.length && <li className="py-2 text-sm text-slate-500">No subjects yet.</li>}
          </ul>
        </Card>
      </div>

      {/* The folder. */}
      <Card className="mt-4">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-900">Leave applications</h2>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              {docs.length}
            </span>
          </div>
        </div>

        {!docs.length ? (
          <EmptyState
            title="Nothing applied for"
            description="Leave this student applies for from their portal appears here, so a shortage can be reviewed without searching a mailbox."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {docs.map((d) => (
              <li key={d.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-slate-900">{d.regarding}</h3>
                      <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                        {d.source === 'email' ? (
                          <>
                            <Mail className="h-3 w-3" /> From their mail
                          </>
                        ) : d.source === 'upload' ? (
                          <>
                            <FileText className="h-3 w-3" /> Filed by the office
                          </>
                        ) : (
                          <>
                            <Send className="h-3 w-3" /> Applied in the portal
                          </>
                        )}
                      </span>
                    </div>

                    {/* The days missed — what the shortage decision turns on. */}
                    {leavePeriod(d) && (
                      <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-700">
                        <CalendarRange className="h-3 w-3" />
                        {leavePeriod(d)}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-slate-500">
                      Applied {formatDate(d.sentAt, true)}
                      {d.fromAddress ? ` · from ${d.fromAddress}` : ''}
                    </p>
                    {d.body && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{d.body}</p>
                    )}

                    {d.attachments.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {d.attachments.map((a) => (
                          <button
                            key={a.id}
                            onClick={() => download(d, a)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
                          >
                            <Download className="h-3 w-3" />
                            <span className="max-w-56 truncate">{a.filename}</span>
                            <span className="text-slate-400">{readableSize(a.size)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <Button variant="ghost" size="sm" onClick={() => remove(d)} title="Delete">
                    <Trash2 className="h-4 w-4 text-slate-400" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
