import { useCallback, useEffect, useState } from 'react';
import { Plus, BookOpen, Layers, Trash2, PencilLine, Users, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { sectionLabel, sectionShort } from '../../lib/format';
import { useToast } from '../../context/ToastContext';
import {
  Card, PageHeader, Spinner, Button, Field, Input, Select, Modal,
  EmptyState, ErrorNote, InfoNote,
} from '../../components/ui';

export default function Academics() {
  const { notify } = useToast();

  const [sections, setSections] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [faculty, setFaculty] = useState([]);
  const [semester, setSemester] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [sectionForm, setSectionForm] = useState(null);
  const [subjectForm, setSubjectForm] = useState(null);
  const [roster, setRoster] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try {
      const [secs, subs, fac] = await Promise.all([
        api.adminSections(),
        api.adminSubjects(semester ? { semester } : {}),
        api.adminFaculty(),
      ]);
      setSections(secs);
      setSubjects(subs);
      setFaculty(fac);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [semester]);

  useEffect(() => {
    load();
  }, [load]);

  const semesters = [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b);

  /* ---- sections ---- */

  const saveSection = async () => {
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        // Blank is meaningful: the year is not divided into sections.
        name: sectionForm.name.trim().toUpperCase(),
        semester: Number(sectionForm.semester),
        department: sectionForm.department || undefined,
      };
      const res = sectionForm.id
        ? await api.updateSection(sectionForm.id, payload)
        : await api.createSection(payload);
      notify(res.message, {
        variant: 'success',
        title: sectionForm.id ? 'Section updated' : 'Section created',
      });
      setSectionForm(null);
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const removeSection = async (s) => {
    const owns = [
      s.studentCount && `${s.studentCount} students`,
      s.subjectCount && `${s.subjectCount} subjects`,
    ]
      .filter(Boolean)
      .join(' and ');
    const warning = owns
      ? `\n\nThis also deletes its ${owns}, along with their attendance and timetable periods.`
      : '';
    if (
      !window.confirm(
        `Delete Semester ${s.semester} · Section ${s.name}?${warning}\n\nThis cannot be undone.`
      )
    )
      return;
    try {
      const res = await api.deleteSection(s.id);
      notify(res.message, { variant: 'success' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not delete' });
    }
  };

  /* ---- subjects ---- */

  const openSubject = (s) =>
    setSubjectForm(
      s
        ? {
            id: s.id,
            code: s.code,
            name: s.name,
            semester: String(s.semester),
            sectionId: s.section?.id || '',
            facultyId: s.faculty?.id || '',
            credits: String(s.credits),
            plannedClasses: String(s.plannedClasses),
            minAttendance: String(s.minAttendance),
          }
        : {
            code: '', name: '', semester: String(semesters[0] ?? 3), sectionId: '',
            facultyId: '', credits: '3', plannedClasses: '30', minAttendance: '75',
          }
    );

  const saveSubject = async () => {
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        code: subjectForm.code.trim().toUpperCase(),
        name: subjectForm.name.trim(),
        semester: Number(subjectForm.semester),
        sectionId: subjectForm.sectionId,
        facultyId: subjectForm.facultyId,
        credits: Number(subjectForm.credits),
        plannedClasses: Number(subjectForm.plannedClasses),
        minAttendance: Number(subjectForm.minAttendance),
      };
      const res = subjectForm.id
        ? await api.updateSubject(subjectForm.id, payload)
        : await api.createSubject({ ...payload, enrolAllInSection: true });
      notify(res.message, { variant: 'success', title: subjectForm.id ? 'Updated' : 'Created' });
      setSubjectForm(null);
      await load();
    } catch (err) {
      setFormError(
        err.details?.length
          ? err.details.map((d) => `${d.field}: ${d.message}`).join(' · ')
          : err.message
      );
    } finally {
      setSaving(false);
    }
  };

  const removeSubject = async (s) => {
    const history = s.conducted
      ? `\n\nIts ${s.conducted} recorded classes and all their attendance go with it.`
      : '';
    if (
      !window.confirm(
        `Delete ${s.code} (${sectionLabel(s.section)})?${history}\n\nThis cannot be undone.`
      )
    )
      return;
    try {
      const res = await api.deleteSubject(s.id);
      notify(res.message, { variant: 'success', title: 'Deleted' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not delete' });
    }
  };

  const sectionsForSemester = (sem) => sections.filter((s) => s.semester === Number(sem));

  if (loading) return <Spinner label="Loading academic setup" />;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Academics"
        subtitle="Sections, subjects, lecturers and enrolment"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setFormError('');
                setSectionForm({ name: '', semester: String(semesters[0] ?? 3), department: 'Computer Science' });
              }}
            >
              <Plus className="h-4 w-4" />
              Section
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setFormError('');
                openSubject(null);
              }}
              disabled={!sections.length}
            >
              <Plus className="h-4 w-4" />
              Subject
            </Button>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Sections */}
      <div className="mb-3 flex items-center gap-2">
        <Layers className="h-4 w-4 text-slate-400" />
        <h2 className="text-base font-semibold text-slate-900">Sections</h2>
      </div>

      <Card className="mb-6 overflow-hidden">
        {sections.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No sections yet"
            description="A section is a cohort that sits together. Create one before adding subjects or students."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {sections.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-sm font-semibold text-slate-600">
                  {sectionShort(s)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">
                    Semester {s.semester} · {sectionLabel(s)}
                  </p>
                  <p className="nums text-xs text-slate-500">
                    {s.studentCount} students · {s.subjectCount} subjects · {s.department}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFormError('');
                      setSectionForm({
                        id: s.id,
                        name: s.name,
                        semester: String(s.semester),
                        department: s.department || '',
                        studentCount: s.studentCount,
                        subjectCount: s.subjectCount,
                      });
                    }}
                    title="Rename or move this section"
                  >
                    <PencilLine className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-rose-600 hover:bg-rose-50"
                    onClick={() => removeSection(s)}
                    title="Delete section"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Subjects */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-slate-400" />
          <h2 className="text-base font-semibold text-slate-900">Subjects</h2>
        </div>
        {/* Wrapped: Select is w-full by design, so the width is set here. */}
        <div className="w-44">
          <Select value={semester} onChange={(e) => setSemester(e.target.value)} className="h-9">
            <option value="">All semesters</option>
            {semesters.map((s) => (
              <option key={s} value={s}>
                Semester {s}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card className="overflow-hidden">
        {subjects.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No subjects"
            description="Add a subject and assign a lecturer so attendance can be recorded."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5 sm:px-5">Code</th>
                  <th className="px-4 py-2.5">Subject</th>
                  <th className="px-4 py-2.5">Section</th>
                  <th className="px-4 py-2.5">Lecturer</th>
                  <th className="nums px-4 py-2.5 text-right">Students</th>
                  <th className="nums px-4 py-2.5 text-right">Conducted</th>
                  <th className="px-4 py-2.5 pr-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subjects.map((s) => (
                  <tr key={s.id} className={`transition hover:bg-slate-50 ${s.isActive ? '' : 'opacity-60'}`}>
                    <td className="px-4 py-3 sm:px-5">
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">
                        {s.code}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {s.name}
                      {!s.isActive && (
                        <span className="ml-2 text-xs font-normal text-slate-400">retired</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      Sem {s.semester} · {sectionShort(s.section)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {/* facultyLabel folds in anyone covering a period of this
                          subject on the live timetable, not just its own
                          lecturer — e.g. "Mr Ankit Mehta/Dr Anuja Agarwal"
                          when Thursday was handed to someone else. That can
                          show a name here even when the subject's own default
                          lecturer (s.faculty, what Edit actually reads and
                          saves) is unset — flagged rather than shown as plain
                          text, so that gap isn't hidden behind names covering
                          for it. */}
                      {s.facultyLabel ? (
                        s.faculty ? (
                          s.facultyLabel
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 text-amber-700"
                            title="No default lecturer set on the subject itself — these names only come from per-period overrides on the timetable"
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {s.facultyLabel}
                          </span>
                        )
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                          <AlertTriangle className="h-3 w-3" />
                          Unassigned
                        </span>
                      )}
                    </td>
                    <td className="nums px-4 py-3 text-right text-slate-600">{s.enrolledCount}</td>
                    <td className="nums px-4 py-3 text-right text-slate-600">
                      {s.conducted}
                      <span className="text-slate-400"> / {s.plannedClasses}</span>
                    </td>
                    <td className="px-4 py-3 pr-5 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRoster(s)}
                          title="Manage enrolment"
                        >
                          <Users className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openSubject(s)} title="Edit">
                          <PencilLine className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-rose-600 hover:bg-rose-50"
                          onClick={() => removeSubject(s)}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Section modal */}
      <Modal
        open={Boolean(sectionForm)}
        onClose={() => setSectionForm(null)}
        title={sectionForm?.id ? `Edit Section ${sectionForm.name}` : 'New section'}
        subtitle={
          sectionForm?.id
            ? `${sectionForm.studentCount} students · ${sectionForm.subjectCount} subjects`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setSectionForm(null)}>
              Cancel
            </Button>
            <Button onClick={saveSection} loading={saving} disabled={!sectionForm?.semester}>
              {sectionForm?.id ? 'Save changes' : 'Create'}
            </Button>
          </>
        }
      >
        {sectionForm && (
          <div className="space-y-4">
            {formError && <ErrorNote>{formError}</ErrorNote>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label={
                  <span>
                    Section name{' '}
                    <span className="font-normal text-slate-400">(optional)</span>
                  </span>
                }
                hint="Leave blank if the whole year studies together."
              >
                <Input
                  value={sectionForm.name}
                  onChange={(e) => setSectionForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="A, B, C…"
                />
              </Field>
              <Field label="Semester">
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={sectionForm.semester}
                  onChange={(e) => setSectionForm((f) => ({ ...f, semester: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Department">
              <Input
                value={sectionForm.department}
                onChange={(e) => setSectionForm((f) => ({ ...f, department: e.target.value }))}
              />
            </Field>

            {/* Moving a section takes its people and subjects with it. */}
            {sectionForm.id && (sectionForm.studentCount > 0 || sectionForm.subjectCount > 0) && (
              <InfoNote>
                Renaming only changes the label. Changing the semester moves this cohort —
                its {sectionForm.studentCount} students and {sectionForm.subjectCount} subjects
                move with it, so nothing is left stranded in the old year.
              </InfoNote>
            )}
          </div>
        )}
      </Modal>

      {/* Subject modal */}
      <Modal
        open={Boolean(subjectForm)}
        onClose={() => setSubjectForm(null)}
        title={subjectForm?.id ? `Edit ${subjectForm.code}` : 'New subject'}
        subtitle={subjectForm?.id ? undefined : 'Every student in the section is enrolled automatically'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSubjectForm(null)}>
              Cancel
            </Button>
            <Button
              onClick={saveSubject}
              loading={saving}
              disabled={!subjectForm?.code || !subjectForm?.name || !subjectForm?.sectionId || !subjectForm?.facultyId}
            >
              {subjectForm?.id ? 'Save changes' : 'Create'}
            </Button>
          </>
        }
      >
        {subjectForm && (
          <div className="space-y-4">
            {formError && <ErrorNote>{formError}</ErrorNote>}

            <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
              <Field label="Code">
                <Input
                  value={subjectForm.code}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="CN"
                  disabled={Boolean(subjectForm.id)}
                />
              </Field>
              <Field label="Subject name">
                <Input
                  value={subjectForm.name}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Computer Networks"
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Semester">
                <Select
                  value={subjectForm.semester}
                  onChange={(e) =>
                    setSubjectForm((f) => ({ ...f, semester: e.target.value, sectionId: '' }))
                  }
                  disabled={Boolean(subjectForm.id)}
                >
                  {semesters.map((s) => (
                    <option key={s} value={s}>
                      Semester {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Section">
                <Select
                  value={subjectForm.sectionId}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, sectionId: e.target.value }))}
                  disabled={Boolean(subjectForm.id)}
                >
                  <option value="">Choose…</option>
                  {sectionsForSemester(subjectForm.semester).map((s) => (
                    <option key={s.id} value={s.id}>
                      {sectionLabel(s)} ({s.studentCount} students)
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Lecturer" hint="Shown against every period of this subject on the timetable.">
              <Select
                value={subjectForm.facultyId}
                onChange={(e) => setSubjectForm((f) => ({ ...f, facultyId: e.target.value }))}
              >
                <option value="">Choose…</option>
                {faculty.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} — {f.subjectCount} subjects, {f.periodsPerWeek} periods/week
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Credits">
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={subjectForm.credits}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, credits: e.target.value }))}
                />
              </Field>
              <Field label="Planned classes">
                <Input
                  type="number"
                  min="1"
                  value={subjectForm.plannedClasses}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, plannedClasses: e.target.value }))}
                />
              </Field>
              <Field label="Min attendance %">
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={subjectForm.minAttendance}
                  onChange={(e) => setSubjectForm((f) => ({ ...f, minAttendance: e.target.value }))}
                />
              </Field>
            </div>

            <InfoNote>
              Planned classes are shown as context only. Attendance percentages are always
              calculated over the classes actually conducted.
            </InfoNote>
          </div>
        )}
      </Modal>

      <RosterModal subject={roster} onClose={() => setRoster(null)} onDone={load} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function RosterModal({ subject, onClose, onDone }) {
  const { notify } = useToast();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!subject) return;
    setData(await api.subjectRoster(subject.id));
  }, [subject]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const act = async (studentIds, action) => {
    setBusy(true);
    try {
      const res = await api.setEnrolment(subject.id, studentIds, action);
      notify(res.message, { variant: 'success' });
      await load();
      onDone?.();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not update' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(subject)}
      onClose={onClose}
      title={subject ? `${subject.code} — enrolment` : ''}
      subtitle={subject ? sectionLabel(subject.section) : ''}
      width="max-w-2xl"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {!data ? (
        <Spinner label="Loading roster" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-900">
                Enrolled <span className="nums text-slate-400">({data.enrolled.length})</span>
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
              {data.enrolled.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-slate-500">Nobody yet</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.enrolled.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="nums shrink-0 font-mono text-[11px] text-slate-400">
                        {s.rollNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{s.name}</span>
                      <button
                        disabled={busy}
                        onClick={() => act([s.id], 'remove')}
                        className="shrink-0 text-xs font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-slate-900">
                In the section, not enrolled{' '}
                <span className="nums text-slate-400">({data.available.length})</span>
              </p>
              {data.available.length > 0 && (
                <button
                  disabled={busy}
                  onClick={() => act(data.available.map((s) => s.id), 'add')}
                  className="text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
                >
                  Add all
                </button>
              )}
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
              {data.available.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-slate-500">
                  Everyone in the section is enrolled
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.available.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="nums shrink-0 font-mono text-[11px] text-slate-400">
                        {s.rollNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-slate-700">{s.name}</span>
                      <button
                        disabled={busy}
                        onClick={() => act([s.id], 'add')}
                        className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
                      >
                        Add
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
