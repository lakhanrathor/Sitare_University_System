import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookOpen, Download, Paperclip, Plus, Trash2, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useSocketEvent } from '../../context/SocketContext';
import { formatDate } from '../../lib/format';
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

const readableSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Who a note reaches, said the way a person would say it. */
const audience = (n) =>
  n.section?.name ? `Sem ${n.semester} · Section ${n.section.name}` : `Sem ${n.semester} · everyone`;

function PublishDialog({ open, onClose, onSaved, sections, subjects }) {
  const { notify } = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [semester, setSemester] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* Only the subjects the lecturer actually teaches can be published against. */
  const semesters = useMemo(
    () => [...new Set(subjects.map((s) => s.semester))].sort((a, b) => a - b),
    [subjects]
  );
  const subjectsHere = useMemo(
    () => subjects.filter((s) => !semester || String(s.semester) === String(semester)),
    [subjects, semester]
  );
  const sectionsHere = useMemo(
    () => sections.filter((s) => !semester || String(s.semester) === String(semester)),
    [sections, semester]
  );

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setSemester(semesters.length === 1 ? String(semesters[0]) : '');
    setSectionId('');
    setSubjectId('');
    setFiles([]);
    setError('');
  }, [open, semesters]);

  // Choosing the subject settles the year, so it should not be asked twice.
  const pickSubject = (id) => {
    setSubjectId(id);
    const hit = subjects.find((s) => s.id === id);
    if (hit) {
      setSemester(String(hit.semester));
      if (hit.section?.id) setSectionId(hit.section.id);
    }
  };

  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      await api.publishNote({ title, description, semester, sectionId, subjectId, files });
      notify('Your class can see them now', { variant: 'success', title: 'Notes published' });
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
      title="Publish notes"
      subtitle="Shared with the class you choose"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={publish}
            loading={busy}
            disabled={title.trim().length < 2 || !semester || !files.length}
          >
            Publish
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Unit 3 — Normalisation"
            autoFocus
          />
        </Field>

        <Field label="Subject" hint="Optional, but it is how students find these among the rest.">
          <Select value={subjectId} onChange={(e) => pickSubject(e.target.value)}>
            <option value="">Not tied to a subject</option>
            {subjectsHere.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
                {s.section?.name ? ` · Sec ${s.section.name}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Semester">
            <Select
              value={semester}
              onChange={(e) => {
                setSemester(e.target.value);
                setSectionId('');
              }}
            >
              <option value="">Choose…</option>
              {semesters.map((s) => (
                <option key={s} value={s}>
                  Semester {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Section" hint="Leave blank for the whole year">
            <Select
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
              disabled={!semester}
            >
              <option value="">Everyone in the semester</option>
              {sectionsHere.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ? `Section ${s.name}` : 'The whole batch'}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Description" hint="Optional">
          <Textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What these cover"
          />
        </Field>

        <Field label="Files" hint="PDF, slides, documents, images or a zip — up to 15 MB each.">
          <input
            type="file"
            multiple
            onChange={(e) => setFiles([...e.target.files])}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
          />
        </Field>

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

        <InfoNote>
          Everyone in the class you choose is notified straight away, and can download these from
          their own Notes page.
        </InfoNote>
      </div>
    </Modal>
  );
}

export default function Notes() {
  const { user } = useAuth();
  const { notify } = useToast();
  const isStaff = user?.role === 'faculty' || user?.role === 'admin';

  const [notes, setNotes] = useState([]);
  const [sections, setSections] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [subjectFilter, setSubjectFilter] = useState('');

  const load = useCallback(async () => {
    try {
      setNotes(
        await api.notes({
          mine: isStaff && mineOnly ? 'true' : '',
          subject: subjectFilter,
        })
      );
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isStaff, mineOnly, subjectFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // A lecturer publishing lands on a student's page without a refresh.
  useSocketEvent('notification:new', (n) => {
    if (String(n.type || '') === 'note:published') load();
  });

  useEffect(() => {
    if (!isStaff) return;
    api.subjects().then(setSubjects).catch(() => setSubjects([]));
    if (user?.role === 'admin') api.adminSections().then(setSections).catch(() => setSections([]));
  }, [isStaff, user?.role]);

  /*
   * A lecturer needs the sections of the years they teach. Their own subjects
   * already carry those, so there is no need for the admin-only section list.
   */
  const sectionsForDialog = useMemo(() => {
    if (sections.length) return sections;
    const found = new Map();
    for (const s of subjects) {
      if (s.section?.id) found.set(s.section.id, { ...s.section, semester: s.semester });
    }
    return [...found.values()];
  }, [sections, subjects]);

  const download = async (n, a) => {
    try {
      await api.downloadNoteFile(n.id, a.id, a.filename);
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  const remove = async (n) => {
    try {
      await api.deleteNote(n.id);
      notify('Notes removed', { variant: 'success' });
      load();
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  if (loading) return <Spinner label="Loading notes" />;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Notes"
        subtitle={
          isStaff
            ? 'Course material you have shared with your classes'
            : 'Material your lecturers have shared with your class'
        }
        actions={
          isStaff ? (
            <Button onClick={() => setPublishing(true)}>
              <Plus className="h-4 w-4" />
              Publish notes
            </Button>
          ) : null
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {isStaff && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            value={subjectFilter}
            onChange={(e) => setSubjectFilter(e.target.value)}
            className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
          >
            <option value="">All subjects</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
                {s.section?.name ? ` · Sec ${s.section.name}` : ''}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
              className="rounded border-slate-300"
            />
            Only mine
          </label>
        </div>
      )}

      <Card>
        {!notes.length ? (
          <EmptyState
            icon={BookOpen}
            title={isStaff ? 'Nothing published yet' : 'No notes yet'}
            description={
              isStaff
                ? 'Publish slides, handouts or readings and your class can download them straight away.'
                : 'When your lecturers share material for your class, it will appear here.'
            }
            action={
              isStaff ? (
                <Button onClick={() => setPublishing(true)}>
                  <Plus className="h-4 w-4" />
                  Publish notes
                </Button>
              ) : null
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {notes.map((n) => (
              <li key={n.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {n.subject && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-slate-600">
                          {n.subject.code}
                        </span>
                      )}
                      <h3 className="text-sm font-medium text-slate-900">{n.title}</h3>
                      {isStaff && (
                        <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
                          <Users className="h-3 w-3" />
                          {audience(n)}
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 text-xs text-slate-500">
                      {n.uploadedBy?.name ? `${n.uploadedBy.name} · ` : ''}
                      {formatDate(String(n.postedOn).slice(0, 10), true)}
                    </p>

                    {n.description && (
                      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                        {n.description}
                      </p>
                    )}

                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {n.attachments.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => download(n, a)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700"
                        >
                          <Download className="h-3 w-3" />
                          <span className="max-w-56 truncate">{a.filename}</span>
                          <span className="text-slate-400">{readableSize(a.size)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {isStaff && (
                    <Button variant="ghost" size="sm" onClick={() => remove(n)} title="Remove">
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        onSaved={load}
        sections={sectionsForDialog}
        subjects={subjects}
      />
    </div>
  );
}
