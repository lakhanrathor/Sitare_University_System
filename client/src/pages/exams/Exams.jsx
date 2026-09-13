import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Download,
  PencilLine,
  Paperclip,
  Plus,
  Trash2,
  MapPin,
  AlarmClock,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useSocketEvent } from '../../context/SocketContext';
import { formatDate, todayKey, sectionLabel } from '../../lib/format';
import {
  Card,
  PageHeader,
  Spinner,
  EmptyState,
  ErrorNote,
  Button,
  Modal,
  Field,
  Input,
  Select,
  Textarea,
  InfoNote,
} from '../../components/ui';

const EXAM_TYPES = [
  { value: 'mid-term', label: 'Mid-term' },
  { value: 'end-term', label: 'End-term' },
  { value: 'practical', label: 'Practical' },
  { value: 're-exam', label: 'Re-exam' },
  { value: 'other', label: 'Other' },
];

const readableSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Whole days from today, so "in 3 days" never drifts with the clock. */
const daysUntil = (dateKey) =>
  Math.round((new Date(`${dateKey}T00:00:00`) - new Date(`${todayKey()}T00:00:00`)) / 86400000);

function countdown(dateKey) {
  const n = daysUntil(dateKey);
  if (n < 0) return null;
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/* ------------------------------------------------------------------ */
/* Publishing                                                          */
/* ------------------------------------------------------------------ */

const blankPaper = () => ({ subjectId: '', label: '', dateKey: '', startTime: '', endTime: '', room: '' });

/*
 * One dialog for both publishing and correcting.
 *
 * Kept as one component rather than two, because the paper rows are the whole
 * form and a second copy of them would drift — a field added to publishing and
 * forgotten here is exactly the bug an admin would hit while fixing a typo.
 * `exam` being set is the only difference: the fields that decide who was
 * notified (semester, section, the attached file) are then fixed, since the
 * cohort has already been told.
 */
function PublishDialog({ open, onClose, onSaved, sections, subjects, exam = null }) {
  const editing = Boolean(exam);
  const { notify } = useToast();
  const [title, setTitle] = useState('');
  const [examType, setExamType] = useState('end-term');
  const [semester, setSemester] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [papers, setPapers] = useState([]);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const semesters = useMemo(
    () => [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b),
    [sections]
  );
  const sectionsHere = sections.filter(
    (s) => !semester || String(s.semester) === String(semester)
  );
  const subjectsHere = subjects.filter(
    (s) => !semester || String(s.semester) === String(semester)
  );

  useEffect(() => {
    if (!open) return;
    setError('');
    setFiles([]);
    if (exam) {
      setTitle(exam.title);
      setExamType(exam.examType);
      setSemester(exam.semester == null ? '' : String(exam.semester));
      setSectionId(exam.section?.id || '');
      setInstructions(exam.instructions || '');
      // Back to form shape: the list carries a subject object, the rows an id.
      setPapers(
        exam.papers.map((p) => ({
          subjectId: p.subject?.id || '',
          label: p.label || '',
          dateKey: p.dateKey,
          startTime: p.startTime || '',
          endTime: p.endTime || '',
          room: p.room || '',
        }))
      );
      return;
    }
    setTitle('');
    setExamType('end-term');
    setSemester('');
    setSectionId('');
    setInstructions('');
    setPapers([]);
  }, [open, exam]);

  const setPaper = (i, patch) =>
    setPapers((rows) => rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      // Rows the admin started but left blank are dropped, not rejected.
      const rows = papers.filter((p) => p.dateKey && (p.subjectId || p.label.trim()));
      if (editing) {
        await api.updateExam(exam.id, { title, examType, instructions, papers: rows });
        notify('The corrected dates are live', {
          variant: 'success',
          title: 'Exam timetable updated',
        });
      } else {
        await api.publishExam({
          title,
          examType,
          semester,
          sectionId,
          instructions,
          papers: rows,
          files,
        });
        notify('Students and their teachers have been told', {
          variant: 'success',
          title: 'Exam timetable published',
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Correct this exam timetable' : 'Publish an exam timetable'}
      subtitle={
        editing
          ? 'Everyone it was sent to is told again only if a paper actually moves'
          : semester
            ? 'Everyone in the year, and the staff who teach them, are notified'
            : 'Every year, and the staff who teach them, are notified'
      }
      width="max-w-3xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={publish}
            loading={busy}
            disabled={title.trim().length < 3}
          >
            {editing ? 'Save changes' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. End-term Examinations, Fall 2026"
              autoFocus
            />
          </Field>
          <Field label="Kind">
            <Select value={examType} onChange={(e) => setExamType(e.target.value)}>
              {EXAM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Semester"
            hint={
              editing
                ? 'Fixed — this audience has already been notified'
                : 'One sheet for the whole college? Leave it on all semesters.'
            }
          >
            <Select
              value={semester}
              disabled={editing}
              onChange={(e) => {
                setSemester(e.target.value);
                setSectionId('');
              }}
            >
              <option value="">All semesters</option>
              {semesters.map((s) => (
                <option key={s} value={s}>
                  Semester {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Section"
            hint={
              editing
                ? 'Fixed — withdraw and publish again to address a different cohort'
                : semester
                  ? 'Leave blank when the whole year sits the same papers'
                  : 'Only for a single year — every year is being addressed'
            }
          >
            <Select
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
              disabled={!semester || editing}
            >
              <option value="">
                {semester ? 'Everyone in the semester' : 'Everyone in the college'}
              </option>
              {sectionsHere.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ? `Section ${s.name}` : 'The whole batch'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {editing ? (
          <InfoNote>
            The attached sheet stays as it is. If the file itself is wrong, withdraw this
            timetable and publish the corrected one.
          </InfoNote>
        ) : (
          <Field
            label="Timetable file"
            hint="The signed sheet students will want — PDF, image or document."
          >
            <input
              type="file"
              multiple
              onChange={(e) => setFiles([...e.target.files])}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            />
          </Field>
        )}
        {files.length > 0 && (
          <ul className="space-y-1 text-xs text-slate-600">
            {files.map((f) => (
              <li key={f.name} className="flex items-center gap-1.5">
                <Paperclip className="h-3 w-3 text-slate-400" />
                {f.name} <span className="text-slate-400">{readableSize(f.size)}</span>
              </li>
            ))}
          </ul>
        )}

        {/*
          Typed in, never read out of the PDF. A wrong exam date is worse than
          no date, and reading a printed grid is guesswork — but once the dates
          are here the portal can answer "when is my next paper".
        */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Papers</span>
            <Button variant="secondary" size="sm" onClick={() => setPapers((r) => [...r, blankPaper()])}>
              <Plus className="h-3.5 w-3.5" />
              Add a paper
            </Button>
          </div>
          <p className="mb-2 text-xs text-slate-500">
            Optional. Add them and students see their dates and a countdown, not just a file.
          </p>

          {papers.map((p, i) => (
            <div key={i} className="mb-2 grid gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 sm:grid-cols-12">
              <div className="sm:col-span-4">
                <Select
                  value={p.subjectId}
                  onChange={(e) => setPaper(i, { subjectId: e.target.value })}
                >
                  <option value="">Not a listed subject…</option>
                  {subjectsHere.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                      {/* Codes repeat across years, so say which one this is. */}
                      {semester ? '' : ` · Sem ${s.semester}`}
                      {s.section?.name ? ` · Sec ${s.section.name}` : ''}
                    </option>
                  ))}
                </Select>
                {!p.subjectId && (
                  <Input
                    className="mt-1.5"
                    value={p.label}
                    onChange={(e) => setPaper(i, { label: e.target.value })}
                    placeholder="Paper name"
                  />
                )}
              </div>
              <input
                type="date"
                value={p.dateKey}
                onChange={(e) => setPaper(i, { dateKey: e.target.value })}
                className="h-10 rounded-xl border border-slate-200 bg-white px-2 text-sm transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none sm:col-span-3"
              />
              <input
                type="time"
                value={p.startTime}
                onChange={(e) => setPaper(i, { startTime: e.target.value })}
                className="h-10 rounded-xl border border-slate-200 bg-white px-2 text-sm transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none sm:col-span-2"
              />
              <input
                type="time"
                value={p.endTime}
                onChange={(e) => setPaper(i, { endTime: e.target.value })}
                className="h-10 rounded-xl border border-slate-200 bg-white px-2 text-sm transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none sm:col-span-2"
              />
              <button
                onClick={() => setPapers((r) => r.filter((_, n) => n !== i))}
                className="grid h-10 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-rose-600 sm:col-span-1"
                title="Remove this paper"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <Input
                className="sm:col-span-12"
                value={p.room}
                onChange={(e) => setPaper(i, { room: e.target.value })}
                placeholder="Room or hall (optional)"
              />
            </div>
          ))}
        </div>

        <Field label="Instructions" hint="Optional — reporting time, what to bring">
          <Textarea
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>

        <InfoNote>
          {editing
            ? 'Correcting a paper here updates the date and the countdown students already see. Their copy of the attached sheet is unchanged.'
            : 'Attach the sheet, list the papers, or both. The file is what students download; the papers are what the portal can remind them about.'}
        </InfoNote>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/* The calendar-leaf tile wants the month on its own, which formatDate — which
   always leads with the weekday — cannot give it. */
function monthShort(dateKey) {
  if (!dateKey) return '';
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' });
}

export default function Exams() {
  const { user } = useAuth();
  const { notify } = useToast();
  const isAdmin = user?.role === 'admin';
  const isStaff = isAdmin || user?.role === 'faculty';

  const [exams, setExams] = useState([]);
  const [sections, setSections] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  /* The schedule being corrected, or null while publishing a new one. */
  const [editing, setEditing] = useState(null);
  const [semesterFilter, setSemesterFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setExams(await api.exams({ semester: isStaff ? semesterFilter : '' }));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isStaff, semesterFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useSocketEvent('exam:published', load);

  useEffect(() => {
    if (!isAdmin) return;
    api.adminSections().then(setSections).catch(() => setSections([]));
    api.adminSubjects().then(setSubjects).catch(() => setSubjects([]));
  }, [isAdmin]);

  const semesters = useMemo(
    () => [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b),
    [sections]
  );

  /* The one thing a student actually wants: the next paper they sit. */
  const nextPaper = useMemo(() => {
    const today = todayKey();
    const upcoming = exams
      .flatMap((e) => e.papers.map((p) => ({ ...p, exam: e })))
      .filter((p) => p.dateKey >= today)
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (a.startTime || '').localeCompare(b.startTime || ''));
    return upcoming[0] || null;
  }, [exams]);

  const download = async (e, a) => {
    try {
      await api.downloadExamFile(e.id, a.id, a.filename);
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  const remove = async (e) => {
    try {
      await api.deleteExam(e.id);
      notify('Removed', { variant: 'success' });
      load();
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  if (loading) return <Spinner label="Loading exam timetables" />;

  return (
    <div className="animate-fade-up">
      <PageHeader
        icon={CalendarClock}
        tone="accent"
        title="Exams"
        subtitle={
          isStaff
            ? 'Exam timetables published to each year'
            : 'Your exam timetable and paper dates'
        }
        actions={
          isAdmin ? (
            <Button onClick={() => setPublishing(true)}>
              <Plus className="h-4 w-4" />
              Publish a timetable
            </Button>
          ) : null
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* A student's next paper, before anything else on the page. */}
      {!isStaff && nextPaper && (
        <div className="elev-2 relative mb-5 overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 to-indigo-800 p-5 text-white sm:p-6">
          <div
            className="pointer-events-none absolute -top-16 -right-10 h-44 w-44 rounded-full bg-accent-400/25 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative flex items-center gap-4">
            {/* The date as a tear-off calendar leaf — the number is the thing
                being looked for, so it gets read before any of the prose. */}
            <div className="grid h-16 w-16 shrink-0 place-content-center rounded-2xl bg-white/15 text-center backdrop-blur">
              <span className="block text-[11px] font-semibold tracking-wider text-indigo-100 uppercase">
                {monthShort(nextPaper.dateKey)}
              </span>
              <span className="nums block text-2xl leading-none font-bold">
                {nextPaper.dateKey.slice(8, 10)}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-wider text-indigo-200 uppercase">
                Your next paper
              </p>
              <p className="mt-0.5 truncate text-lg font-bold">
                {nextPaper.subject
                  ? `${nextPaper.subject.code} — ${nextPaper.subject.name}`
                  : nextPaper.label}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-indigo-100/90">
                <span>{formatDate(nextPaper.dateKey, true)}</span>
                {countdown(nextPaper.dateKey) && (
                  <span className="rounded-full bg-accent-500 px-2 py-0.5 text-xs font-bold text-white">
                    {countdown(nextPaper.dateKey)}
                  </span>
                )}
                {nextPaper.startTime && (
                  <span>
                    {nextPaper.startTime}
                    {nextPaper.endTime ? `–${nextPaper.endTime}` : ''}
                  </span>
                )}
                {nextPaper.room && <span>· {nextPaper.room}</span>}
              </p>
            </div>
          </div>
        </div>
      )}

      {isStaff && semesters.length > 0 && (
        <div className="mb-4">
          <select
            value={semesterFilter}
            onChange={(e) => setSemesterFilter(e.target.value)}
            className="h-9 rounded-xl border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 elev-1 transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 focus:outline-none"
          >
            <option value="">All semesters</option>
            {semesters.map((s) => (
              <option key={s} value={s}>
                Semester {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {!exams.length ? (
        <Card>
          <EmptyState
            icon={CalendarClock}
            title={isAdmin ? 'Nothing published yet' : 'No exam timetable yet'}
            description={
              isAdmin
                ? 'Upload the exam sheet for a year and everyone in it, plus their teachers, are told at once.'
                : 'When the office publishes your exam timetable it will appear here.'
            }
            action={
              isAdmin ? (
                <Button onClick={() => setPublishing(true)}>
                  <Plus className="h-4 w-4" />
                  Publish a timetable
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {exams.map((e) => (
            <Card key={e.id} className="p-5 transition hover:-translate-y-0.5 hover:elev-2">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-3.5">
                  <span className="hidden h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-accent-50 to-accent-100 text-accent-600 sm:grid">
                    <CalendarClock className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-accent-50 px-1.5 py-0.5 text-[11px] font-bold text-accent-700 capitalize">
                      {e.examType.replace('-', ' ')}
                    </span>
                    <h2 className="text-[15px] font-bold text-slate-900">{e.title}</h2>
                    {isStaff && (
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
                        {e.semester == null
                          ? 'All semesters'
                          : `Sem ${e.semester} · ${sectionLabel(e.section)}`}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {e.startsOn
                      ? `${formatDate(e.startsOn)} – ${formatDate(e.endsOn, true)}`
                      : 'Dates on the attached sheet'}
                    {e.publishedBy?.name ? ` · published by ${e.publishedBy.name}` : ''}
                  </p>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(e)}
                      title="Correct the papers"
                    >
                      <PencilLine className="h-4 w-4 text-slate-400" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(e)} title="Remove">
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </Button>
                  </div>
                )}
              </div>

              {e.instructions && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                  {e.instructions}
                </p>
              )}

              {e.papers.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200/70 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
                        <th className="py-2 pr-3">Paper</th>
                        <th className="py-2 pr-3">Date</th>
                        <th className="py-2 pr-3">Time</th>
                        <th className="py-2">Room</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {e.papers.map((p) => {
                        const soon = countdown(p.dateKey);
                        const past = p.dateKey < todayKey();
                        return (
                          <tr key={p.id} className={past ? 'text-slate-400' : ''}>
                            <td className="py-2 pr-3 font-medium">
                              {p.subject ? `${p.subject.code} — ${p.subject.name}` : p.label}
                            </td>
                            <td className="nums py-2 pr-3">
                              {formatDate(p.dateKey)}
                              {soon && (
                                <span className="ml-1.5 text-[11px] font-medium text-indigo-700">
                                  {soon}
                                </span>
                              )}
                            </td>
                            <td className="nums py-2 pr-3 text-slate-600">
                              {p.startTime ? (
                                <span className="inline-flex items-center gap-1">
                                  <AlarmClock className="h-3 w-3 text-slate-400" />
                                  {p.startTime}
                                  {p.endTime ? `–${p.endTime}` : ''}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="py-2 text-slate-600">
                              {p.room ? (
                                <span className="inline-flex items-center gap-1">
                                  <MapPin className="h-3 w-3 text-slate-400" />
                                  {p.room}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {e.attachments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {e.attachments.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => download(e, a)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
                    >
                      <Download className="h-3 w-3" />
                      <span className="max-w-56 truncate">{a.filename}</span>
                      <span className="text-slate-400">{readableSize(a.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <PublishDialog
        open={publishing || Boolean(editing)}
        exam={editing}
        onClose={() => {
          setPublishing(false);
          setEditing(null);
        }}
        onSaved={load}
        sections={sections}
        subjects={subjects}
      />
    </div>
  );
}
