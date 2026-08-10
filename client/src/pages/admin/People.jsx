import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  UserPlus, Search, Upload, Users, GraduationCap, Shield, Power, PencilLine, KeyRound,
  FileText, Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { sectionLabel, formatPct, styleFor, attendanceStatusFromPct } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import {
  Card, PageHeader, Spinner, Button, Field, Input, Select, Textarea, Modal,
  EmptyState, ErrorNote, InfoNote,
} from '../../components/ui';

const TABS = [
  { key: 'student', label: 'Students', icon: GraduationCap },
  { key: 'faculty', label: 'Faculty', icon: Users },
  { key: 'admin', label: 'Admins', icon: Shield },
];

const BLANK = {
  name: '', email: '', role: 'student', rollNumber: '', employeeId: '',
  batch: '', sectionId: '', department: 'Computer Science', password: '',
};

export default function People() {
  const { user: me } = useAuth();
  const { notify } = useToast();

  const [tab, setTab] = useState('student');
  const [users, setUsers] = useState([]);
  const [sections, setSections] = useState([]);
  const [query, setQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [semesterFilter, setSemesterFilter] = useState('');
  const [sectionFilter, setSectionFilter] = useState('');
  // The end-of-semester view: only students below the requirement.
  const [shortageOnly, setShortageOnly] = useState(false);
  const [threshold, setThreshold] = useState(75);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [form, setForm] = useState(null); // null | {…user} for edit | BLANK for create
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [importOpen, setImportOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const students = tab === 'student';
      const [list, secs] = await Promise.all([
        api.adminUsers({
          role: tab,
          includeInactive: showInactive ? 'true' : '',
          // Filtered on the server: with several hundred students, narrowing
          // here means the attendance aggregate only runs over the year asked
          // for rather than the whole college.
          semester: students ? semesterFilter : '',
          section: students ? sectionFilter : '',
          // Attendance costs an aggregate over every mark, so it is only
          // requested on the tab that shows it.
          withAttendance: students ? 'true' : '',
          below: students && shortageOnly ? String(threshold) : '',
        }),
        api.adminSections(),
      ]);
      setUsers(list);
      setSections(secs);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [tab, showInactive, shortageOnly, threshold, semesterFilter, sectionFilter]);

  useEffect(() => {
    load();
  }, [load]);

  /* Years that actually have a cohort, so the list never offers an empty one. */
  const semesters = useMemo(
    () => [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b),
    [sections]
  );

  const sectionsForFilter = useMemo(
    () =>
      sections
        .filter((s) => !semesterFilter || String(s.semester) === String(semesterFilter))
        .sort((a, b) => a.semester - b.semester || (a.name || '').localeCompare(b.name || '')),
    [sections, semesterFilter]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      [u.name, u.email, u.rollNumber, u.employeeId].some((v) => (v || '').toLowerCase().includes(q))
    );
  }, [users, query]);

  const openCreate = () => {
    setFormError('');
    setForm({ ...BLANK, role: tab });
  };

  const openEdit = (u) => {
    setFormError('');
    setForm({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      rollNumber: u.rollNumber || '',
      employeeId: u.employeeId || '',
      batch: u.batch || '',
      sectionId: u.section?.id || '',
      department: u.department || '',
      password: '',
    });
  };

  const save = async () => {
    setSaving(true);
    setFormError('');
    try {
      const section = sections.find((s) => s.id === form.sectionId);
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        department: form.department || undefined,
        ...(form.role === 'student'
          ? {
              rollNumber: form.rollNumber.trim().toUpperCase(),
              batch: form.batch || undefined,
              sectionId: form.sectionId || undefined,
              semester: section?.semester,
            }
          : { employeeId: form.employeeId.trim() || undefined }),
        ...(form.password ? { password: form.password } : {}),
      };

      const res = form.id
        ? await api.updateUser(form.id, payload)
        : await api.createUser({ ...payload, role: form.role });

      notify(res.message, { variant: 'success', title: form.id ? 'Updated' : 'Added' });
      setForm(null);
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

  const toggleStatus = async (u) => {
    const verb = u.isActive ? 'Deactivate' : 'Reactivate';
    if (!window.confirm(`${verb} ${u.name}?`)) return;
    try {
      const res = await api.setUserStatus(u.id, !u.isActive);
      notify(res.message, { variant: 'success' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not update' });
    }
  };

  const removeUser = async (u) => {
    const extra =
      u.role === 'student'
        ? "\n\nTheir attendance records go with them."
        : u.role === 'faculty'
          ? '\n\nTheir subjects and timetable periods stay, but with no lecturer assigned.'
          : '';
    if (!window.confirm(`Delete ${u.name} permanently?${extra}\n\nThis cannot be undone.`)) return;
    try {
      const res = await api.deleteUser(u.id);
      notify(res.message, { variant: 'success', title: 'Deleted' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not delete' });
    }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="People"
        subtitle="Everyone added or imported here can sign in straight away — students with student123, faculty with faculty123, until they change it"
        actions={
          <>
            {tab === 'student' && (
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4" />
                Import PDF
              </Button>
            )}
            <Button size="sm" onClick={openCreate}>
              <UserPlus className="h-4 w-4" />
              Add {tab === 'admin' ? 'admin' : tab}
            </Button>
          </>
        }
      />

      {/* Tabs + filters */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <t.icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Narrow to a year, then to a cohort within it. */}
          {tab === 'student' && (
            <>
              <select
                value={semesterFilter}
                onChange={(e) => {
                  setSemesterFilter(e.target.value);
                  // A section belongs to one year, so it cannot survive the change.
                  setSectionFilter('');
                }}
                className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              >
                <option value="">All semesters</option>
                {semesters.map((s) => (
                  <option key={s} value={s}>
                    Semester {s}
                  </option>
                ))}
              </select>

              {sectionsForFilter.length > 0 && (
                <select
                  value={sectionFilter}
                  onChange={(e) => setSectionFilter(e.target.value)}
                  className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
                >
                  <option value="">All sections</option>
                  {sectionsForFilter.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name ? `Section ${s.name}` : 'Undivided batch'}
                      {!semesterFilter ? ` · Sem ${s.semester}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}

          {/*
            The end-of-semester question: who is short, and what did they send
            in about it. Everything else on this page is day-to-day admin.
          */}
          {tab === 'student' && (
            <label
              className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition ${
                shortageOnly
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : 'border-slate-200 text-slate-600'
              }`}
            >
              <input
                type="checkbox"
                checked={shortageOnly}
                onChange={(e) => setShortageOnly(e.target.checked)}
                className="rounded border-slate-300"
              />
              Below
              <input
                type="number"
                min={1}
                max={100}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value) || 75)}
                disabled={!shortageOnly}
                className="nums w-11 rounded border border-slate-300 px-1 py-0.5 text-center text-xs disabled:bg-slate-50 disabled:text-slate-400"
              />
              %
            </label>
          )}
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show deactivated
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="h-9 w-48 rounded-lg border border-slate-300 pr-2.5 pl-8 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {loading ? (
        <Spinner label="Loading people" />
      ) : (
        <Card className="overflow-hidden">
          {visible.length === 0 ? (
            <EmptyState
              title={query ? 'No match' : `No ${tab}s yet`}
              description={query ? `Nothing matches "${query}".` : 'Add the first one to get started.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                    <th className="px-4 py-2.5 sm:px-5">{tab === 'student' ? 'Roll no.' : 'ID'}</th>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Email</th>
                    {tab === 'student' && <th className="px-4 py-2.5">Section</th>}
                    {tab === 'student' && <th className="px-4 py-2.5">Attendance</th>}
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5 pr-5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((u) => (
                    <tr key={u.id} className={`transition hover:bg-slate-50 ${u.isActive ? '' : 'opacity-60'}`}>
                      <td className="nums px-4 py-3 font-mono text-xs text-slate-500 sm:px-5">
                        {u.rollNumber || u.employeeId || '—'}
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {tab === 'student' ? (
                          <Link
                            to={`/admin/students/${u.id}`}
                            className="hover:text-indigo-700 hover:underline"
                          >
                            {u.name}
                          </Link>
                        ) : (
                          u.name
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.email}</td>
                      {tab === 'student' && (
                        <td className="px-4 py-3 text-slate-600">
                          {u.section ? (
                            `Sem ${u.semester} · ${sectionLabel(u.section)}`
                          ) : (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                              Unassigned
                            </span>
                          )}
                        </td>
                      )}
                      {tab === 'student' && (
                        <td className="px-4 py-3">
                          {u.attendance?.percentage === null || u.attendance === null ? (
                            <span className="text-xs text-slate-400">No classes yet</span>
                          ) : (
                            <span
                              className={`nums text-sm font-medium ${
                                styleFor(
                                  attendanceStatusFromPct(u.attendance.percentage, threshold)
                                ).text
                              }`}
                            >
                              {formatPct(u.attendance.percentage)}%
                              <span className="ml-1 text-xs font-normal text-slate-400">
                                {u.attendance.present}/{u.attendance.conducted}
                              </span>
                            </span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            u.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {u.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="px-4 py-3 pr-5 text-right">
                        <div className="inline-flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(u)} title="Edit">
                            <PencilLine className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleStatus(u)}
                            disabled={u.id === me?.id}
                            title={
                              u.id === me?.id
                                ? 'You cannot deactivate yourself'
                                : u.isActive
                                  ? 'Suspend access'
                                  : 'Restore access'
                            }
                            className={u.isActive ? 'text-amber-600 hover:bg-amber-50' : ''}
                          >
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeUser(u)}
                            disabled={u.id === me?.id}
                            title={
                              u.id === me?.id ? 'You cannot delete yourself' : 'Delete permanently'
                            }
                            className="text-rose-600 hover:bg-rose-50"
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
      )}

      {/* Create / edit */}
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? `Edit ${form.name}` : `Add ${form?.role === 'admin' ? 'an admin' : `a ${form?.role}`}`}
        subtitle={form?.id ? form.email : 'They can sign in as soon as this is saved'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!form?.name || !form?.email}>
              {form?.id ? 'Save changes' : 'Add'}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {formError && <ErrorNote>{formError}</ErrorNote>}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name">
                <Input value={form.name} onChange={set('name')} placeholder="Dr Anjali Verma" />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={set('email')}
                  placeholder="anjali.verma@sitare.org"
                />
              </Field>
            </div>

            {form.role === 'student' ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Roll number">
                  <Input value={form.rollNumber} onChange={set('rollNumber')} placeholder="SU24017" />
                </Field>
                <Field label="Section">
                  <Select value={form.sectionId} onChange={set('sectionId')}>
                    <option value="">Choose…</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        Semester {s.semester} · {sectionLabel(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Batch">
                  <Input value={form.batch} onChange={set('batch')} placeholder="2024-28" />
                </Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Employee ID">
                  <Input value={form.employeeId} onChange={set('employeeId')} placeholder="FAC107" />
                </Field>
                <Field label="Department">
                  <Input value={form.department} onChange={set('department')} />
                </Field>
              </div>
            )}

            <Field
              label={form.id ? 'Reset password' : 'Password'}
              hint={
                form.id
                  ? 'Leave blank to keep the current password.'
                  : `Leave blank to use the default (${form.role}123). They should change it after signing in.`
              }
            >
              <Input
                type="text"
                value={form.password}
                onChange={set('password')}
                placeholder={form.id ? 'Unchanged' : `${form.role}123`}
              />
            </Field>

            {form.role === 'student' && !form.id && (
              <InfoNote icon={KeyRound}>
                A new student is enrolled automatically in every subject their section already
                runs, so they appear on attendance sheets straight away.
              </InfoNote>
            )}
          </div>
        )}
      </Modal>

      <ImportStudentsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        sections={sections}
        onDone={load}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ImportStudentsModal({ open, onClose, sections, onDone }) {
  const { notify } = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState('');
  const [semester, setSemester] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const semesters = [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b);
  const sectionsHere = sections.filter((s) => s.semester === Number(semester));

  useEffect(() => {
    if (!open) return;
    setCsv('');
    setFile(null);
    setResult(null);
    setError('');
    setSectionId('');
    setSemester(String(semesters[0] ?? ''));
    if (fileRef.current) fileRef.current.value = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Reading happens the moment there is something to read — choosing the file
   * is the whole intent, and a separate "check" button only left Import
   * mysteriously disabled.
   */
  const run = useCallback(
    async (dryRun, override = {}) => {
      const src = { file, csv, sectionId, semester, ...override };
      if (!src.file && !src.csv?.trim()) return;
      setBusy(true);
      setError('');
      try {
        const res = await api.importStudents({
          file: src.file,
          csv: src.csv,
          semester: Number(src.semester),
          sectionId: src.sectionId,
          dryRun,
        });
        if (dryRun || res.errors?.length) setResult(res);
        else {
          notify(res.message, { variant: 'success', title: 'Students imported' });
          onDone?.();
          onClose();
        }
      } catch (err) {
        setError(err.message);
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [file, csv, sectionId, semester, notify, onDone, onClose]
  );

  const hasSource = Boolean(file) || Boolean(csv.trim());

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import students"
      subtitle="Bulk-add a cohort from a PDF"
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {busy && (
            <span className="mr-auto text-sm text-slate-500">Reading the file…</span>
          )}
          <Button onClick={() => run(false)} loading={busy} disabled={!hasSource || !result?.valid}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Semester">
            <Select
              value={semester}
              onChange={(e) => {
                setSemester(e.target.value);
                setSectionId('');
                setResult(null);
              }}
            >
              {semesters.map((s) => (
                <option key={s} value={s}>
                  Semester {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={
              <span>
                Section <span className="font-normal text-slate-400">(optional)</span>
              </span>
            }
            hint={
              sectionId
                ? 'Applied to everyone in the file.'
                : 'Otherwise each row needs its own section column.'
            }
          >
            <Select
              value={sectionId}
              onChange={(e) => {
                const next = e.target.value;
                setSectionId(next);
                setResult(null);
                // Validity depends on the section, so re-read against the new one.
                if (file || csv.trim()) run(true, { sectionId: next });
              }}
            >
              <option value="">Take it from the file</option>
              {sectionsHere.map((s) => (
                <option key={s.id} value={s.id}>
                  {sectionLabel(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Student list PDF"
          hint={
            sectionId
              ? 'Only needs three columns: rollNumber, name, email. Anything else in the file is ignored.'
              : 'Needs columns: rollNumber, name, email and section. Anything else is ignored.'
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                const picked = e.target.files?.[0] || null;
                setFile(picked);
                setCsv('');
                setResult(null);
                if (picked) run(true, { file: picked, csv: '' });
              }}
              className="block flex-1 text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            />
            {file && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                <FileText className="h-3.5 w-3.5" />
                {file.name}
              </span>
            )}
          </div>
        </Field>

        <details className="rounded-lg border border-slate-200 px-3.5 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Paste rows instead
          </summary>
          <Textarea
            rows={5}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setFile(null);
              setResult(null);
            }}
            onBlur={(e) => e.target.value.trim() && run(true, { csv: e.target.value, file: null })}
            placeholder={
              sectionId
                ? 'rollNumber,name,email\nSU24017,Rhea Kapoor,su24017@sitare.org'
                : 'rollNumber,name,email,section\nSU24017,Rhea Kapoor,su24017@sitare.org,A'
            }
            className="mt-3 font-mono text-xs"
          />
        </details>

        {result && (
          <div
            className={`rounded-lg border px-3.5 py-2.5 text-sm ${
              result.valid ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'
            }`}
          >
            <p className={`font-medium ${result.valid ? 'text-emerald-800' : 'text-rose-800'}`}>
              {result.valid
                ? `${result.count} students ready to import`
                : 'No usable rows were found in this file'}
            </p>
            {result.valid && result.readCount > result.count && (
              <p className="mt-0.5 text-xs text-emerald-900/70">
                {result.readCount} rows read · {result.readCount - result.count} skipped
              </p>
            )}
            {/* Show the first few rows back so a PDF misread is caught here. */}
            {result.valid && result.preview?.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-900/80">
                {result.preview.map((r, i) => (
                  <li key={i} className="nums">
                    {r.rollNumber} · {r.name} · {r.email} · Sec {r.section}
                  </li>
                ))}
                {result.count > result.preview.length && (
                  <li className="text-emerald-700">…and {result.count - result.preview.length} more</li>
                )}
              </ul>
            )}
            {!result.valid && (
              <ul className="mt-1.5 space-y-0.5 text-xs text-rose-700">
                {result.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>
                    {e.who ? `${e.who}: ` : e.line ? `Row ${e.line}: ` : ''}
                    {e.message}
                  </li>
                ))}
                {result.errors.length > 8 && <li>…and {result.errors.length - 8} more</li>}
              </ul>
            )}

            {/* Skipped rows do not block the import — they are just reported. */}
            {result.valid && result.skipped?.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-emerald-900/80">
                  {result.skipped.length} row{result.skipped.length === 1 ? '' : 's'} will be
                  skipped — see why
                </summary>
                <ul className="mt-1.5 space-y-0.5 text-xs text-emerald-900/70">
                  {result.skipped.slice(0, 12).map((s, i) => (
                    <li key={i}>
                      {s.who ? `${s.who} — ` : ''}
                      {s.message}
                    </li>
                  ))}
                  {result.skipped.length > 12 && (
                    <li>…and {result.skipped.length - 12} more</li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}

        <InfoNote>
          Everyone imported gets the password <span className="font-medium">student123</span> and is
          enrolled in their section's existing subjects.
        </InfoNote>
      </div>
    </Modal>
  );
}
