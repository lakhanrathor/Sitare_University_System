import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Upload, Download, FileText, CheckCircle2, AlertTriangle,
  Trash2, Radio, X, Loader2,
} from 'lucide-react';
import { api, tokenStore } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { todayKey } from '../../lib/timetable';
import {
  Card, PageHeader, Button, Field, Input, Select, ErrorNote, InfoNote, EmptyState, Spinner,
  Textarea,
} from '../../components/ui';

const DAY_LABEL = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_STYLE = {
  published: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  draft: 'bg-amber-50 text-amber-700 border-amber-200',
  archived: 'bg-slate-100 text-slate-500 border-slate-200',
};

export default function ManageTimetable() {
  const { notify } = useToast();
  const fileRef = useRef(null);

  const [versions, setVersions] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [semester, setSemester] = useState(3);
  const [effectiveFrom, setEffectiveFrom] = useState(todayKey());
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, secs] = await Promise.all([api.timetableVersions(), api.adminSections()]);
      setVersions(list);
      setSections(secs);
      const sems = [...new Set(secs.map((s) => s.semester))].sort((a, b) => a - b);
      setSemester((cur) => (sems.includes(Number(cur)) ? cur : (sems[0] ?? 3)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onFile = (e) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setFile(picked);
    setCsv('');
    setPreview(null);
    if (!name) setName(picked.name.replace(/\.pdf$/i, ''));
    runPreview({ file: picked, csv: '' });
  };

  const clearFile = () => {
    setFile(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  /**
   * Reading happens as soon as there is something to read — choosing a file is
   * the whole intent, so making the admin press a separate button first only
   * left Publish mysteriously disabled.
   */
  const runPreview = useCallback(
    async (source, semesterOverride) => {
      const src = source || { file, csv };
      if (!src.file && !src.csv?.trim()) return;
      setChecking(true);
      setError('');
      try {
        // Validation is semester-scoped: section names repeat across years.
        setPreview(
          await api.previewTimetable({
            ...src,
            semester: Number(semesterOverride ?? semester),
          })
        );
      } catch (err) {
        setError(err.message);
        setPreview(null);
      } finally {
        setChecking(false);
      }
    },
    [file, csv, semester]
  );

  const upload = async (publish) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.uploadTimetable({
        name,
        semester: Number(semester),
        effectiveFrom,
        file,
        csv,
        publish,
      });
      notify(res.message, { variant: 'success', title: publish ? 'Published' : 'Saved' });
      setCsv('');
      setName('');
      clearFile();
      await load();
    } catch (err) {
      setError(
        err.details?.length
          ? `${err.message}: ${err.details.slice(0, 3).map((d) => `line ${d.line} ${d.message}`).join('; ')}`
          : err.message
      );
    } finally {
      setBusy(false);
    }
  };

  const publish = async (id) => {
    try {
      const res = await api.publishTimetable(id);
      notify(res.message, { variant: 'success', title: 'Timetable live' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not publish' });
    }
  };

  const remove = async (v) => {
    const live =
      v.status === 'published'
        ? `\n\nThis is the live grid for Semester ${v.semester} — deleting it leaves that semester with no timetable until another is published.`
        : '';
    if (!window.confirm(`Delete "${v.name}"?${live}\n\nThis cannot be undone.`)) return;
    try {
      await api.deleteTimetable(v.id);
      notify('Timetable deleted', { variant: 'success' });
      await load();
    } catch (err) {
      notify(err.message, { variant: 'error', title: 'Could not delete' });
    }
  };

  /** Template download needs the auth header, so fetch then save the blob. */
  const downloadTemplate = async (current) => {
    const qs = current ? `?current=true&semester=${semester}` : '';
    const res = await fetch(`/api/timetable/template${qs}`, {
      headers: { Authorization: `Bearer ${tokenStore.get()}` },
    });
    if (!res.ok) return notify('Could not download the template', { variant: 'error' });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = current ? `timetable-sem${semester}-current.csv` : 'timetable-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const semesterOptions = [...new Set(sections.map((s) => s.semester))].sort((a, b) => a - b);
  const sectionsForSemester = sections.filter((s) => s.semester === Number(semester));
  const hasSource = Boolean(file) || Boolean(csv.trim());
  const canUpload = name.trim() && hasSource && preview?.valid;

  return (
    <div className="animate-fade-up">
      <Link
        to="/timetable"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to timetable
      </Link>

      <PageHeader
        title="Manage timetable"
        subtitle="Upload a weekly grid and publish it to all staff and students"
        actions={
          <>
            {/* These hand back text for the paste box, so say so plainly. */}
            <Button variant="secondary" size="sm" onClick={() => downloadTemplate(false)}>
              <Download className="h-4 w-4" />
              CSV template
            </Button>
            <Button variant="secondary" size="sm" onClick={() => downloadTemplate(true)}>
              <FileText className="h-4 w-4" />
              Export as CSV
            </Button>
          </>
        }
      />

      {/* Upload */}
      <Card className="mb-6 p-5">
        <h2 className="mb-4 text-sm font-semibold text-slate-900">Upload a new timetable</h2>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" className="sm:col-span-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Semester 3 — Odd 2026"
            />
          </Field>
          <Field
            label="Semester"
            hint={
              sectionsForSemester.length
                ? `Sections: ${sectionsForSemester.map((s) => s.name).join(', ')}`
                : 'No sections in this semester yet'
            }
          >
            <Select
              value={semester}
              onChange={(e) => {
                const next = e.target.value;
                setSemester(next);
                setPreview(null);
                // Validation is semester-scoped, so re-read against the new one.
                if (file || csv.trim()) runPreview({ file, csv }, next);
              }}
            >
              {semesterOptions.map((s) => (
                <option key={s} value={s}>
                  Semester {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effective from">
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Timetable PDF"
          className="mt-4"
          hint="The printed grid works — weekday headings across the top, period times down the left. A one-row-per-period PDF works too."
        >
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={onFile}
              className="block flex-1 text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
            />
            {file && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                <FileText className="h-3.5 w-3.5" />
                {file.name}
                <button onClick={clearFile} className="ml-0.5 text-indigo-400 hover:text-indigo-700">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </div>
        </Field>

        <details className="mt-3 rounded-lg border border-slate-200 px-3.5 py-2.5">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Paste rows instead
          </summary>
          <div className="mt-3">
            <Textarea
              rows={5}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFile(null);
                setPreview(null);
              }}
              onBlur={(e) => e.target.value.trim() && runPreview({ csv: e.target.value })}
              placeholder={'day,slot,section,subjectCode,facultyEmail,kind,title\nMonday,4,A,WAD,ankit.mehta@sitare.org,lecture,'}
              className="font-mono text-xs"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Columns: day, slot, section, subjectCode, facultyEmail, kind, title · slot 1-6 · kind
              = lecture | office-hours | event
            </p>
          </div>
        </details>

        {error && (
          <div className="mt-3">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {/* Validation result */}
        {preview && (
          <div className="mt-4 space-y-3">
            <div
              className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 ${
                preview.valid
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-rose-200 bg-rose-50'
              }`}
            >
              {preview.valid ? (
                <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-emerald-600" />
              ) : (
                <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-rose-600" />
              )}
              <div className="text-sm">
                <p
                  className={`font-medium ${preview.valid ? 'text-emerald-800' : 'text-rose-800'}`}
                >
                  {preview.valid
                    ? `${preview.rowCount} periods ready to publish`
                    : preview.errors[0]?.message || 'This file could not be read'}
                </p>
                {preview.source === 'pdf' && (
                  <p className="mt-0.5 text-xs text-slate-600">
                    Read as a{' '}
                    <span className="font-medium">
                      {preview.layout === 'grid' ? 'printed grid' : 'row list'}
                    </span>
                    {preview.periods?.length
                      ? ` with ${preview.periods.length} periods a day`
                      : ''}
                    {preview.hasSections === false
                      ? ' and no section split, so it is stored exactly that way — one grid for the whole semester'
                      : ' split by section, exactly as in the file'}
                    . Check the list below before publishing.
                  </p>
                )}
              </div>
            </div>

            {/* Period times come from the file, so show what they were read as. */}
            {preview.valid && preview.periods?.length > 0 && (
              <div className="rounded-lg border border-slate-200 px-3.5 py-2.5">
                <p className="text-sm font-medium text-slate-700">Period times from this file</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {preview.periods.map((p) => (
                    <span
                      key={p.slot}
                      className="nums rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                    >
                      {p.slot}. {p.label}
                    </span>
                  ))}
                  {preview.lunch && (
                    <span className="nums rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                      {preview.lunch.label} {preview.lunch.start}–{preview.lunch.end}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Anything the file names that does not exist yet. */}
            {preview.valid &&
              (preview.toCreate?.subjects?.length > 0 ||
                preview.toCreate?.faculty?.length > 0) && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3.5 py-2.5">
                  <p className="text-sm font-medium text-indigo-900">
                    Publishing will also create what this file introduces
                  </p>
                  {preview.toCreate.subjects.length > 0 && (
                    <p className="mt-1 text-xs text-indigo-800">
                      <span className="font-medium">
                        {preview.toCreate.subjects.length} subjects:
                      </span>{' '}
                      {preview.toCreate.subjects
                        .map((s) => `${s.code} ${s.name} (Sec ${s.section})`)
                        .join(', ')}
                    </p>
                  )}
                  {preview.toCreate.faculty.length > 0 && (
                    <p className="mt-1 text-xs text-indigo-800">
                      <span className="font-medium">
                        {preview.toCreate.faculty.length} faculty accounts:
                      </span>{' '}
                      {preview.toCreate.faculty.map((f) => `${f.name} (${f.email})`).join(', ')} —
                      each with the temporary password <span className="font-mono">faculty123</span>
                    </p>
                  )}
                </div>
              )}

            {/* What was actually extracted — the human check on PDF inference. */}
            {preview.valid && preview.entries?.length > 0 && (
              <details className="rounded-lg border border-slate-200" open={preview.source === 'pdf'}>
                <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-slate-700">
                  Review the {preview.entries.length} periods that were read
                </summary>
                <div className="max-h-64 overflow-y-auto border-t border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                      <tr>
                        <th className="px-3 py-1.5">Day</th>
                        <th className="px-3 py-1.5">Period</th>
                        <th className="px-3 py-1.5">Section</th>
                        <th className="px-3 py-1.5">Subject</th>
                        <th className="px-3 py-1.5">Lecturer</th>
                        <th className="px-3 py-1.5">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.entries.map((e, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 text-slate-600">{DAY_LABEL[e.dayOfWeek]}</td>
                          <td className="nums px-3 py-1.5 text-slate-600">{e.slot}</td>
                          <td className="px-3 py-1.5 text-slate-600">{e.sectionName}</td>
                          <td className="px-3 py-1.5 font-medium text-slate-900">
                            {e.subjectCode || e.title || '—'}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600">{e.facultyName || '—'}</td>
                          <td className="px-3 py-1.5 text-slate-500">{e.kind}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            {/* Anything worth mentioning stays out of the way — none of it
                stops the upload, so it does not get to shout. */}
            {(preview.notes?.length > 0 || preview.warnings.length > 0) && (
              <details className="rounded-lg border border-slate-200 px-3.5 py-2.5">
                <summary className="cursor-pointer text-sm text-slate-600">
                  {preview.notes.length + preview.warnings.length} minor{' '}
                  {preview.notes.length + preview.warnings.length === 1 ? 'note' : 'notes'} — none
                  of them block publishing
                </summary>
                <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
                  {preview.notes?.map((n, i) => (
                    <li key={`n${i}`}>{n.message}</li>
                  ))}
                  {preview.warnings.map((w, i) => (
                    <li key={`w${i}`}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {checking && (
            <span className="mr-auto inline-flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading the file…
            </span>
          )}
          {!checking && hasSource && !preview && !error && (
            <button
              onClick={() => runPreview()}
              className="mr-auto text-sm font-medium text-indigo-600 hover:text-indigo-700"
            >
              Re-read the file
            </button>
          )}
          <Button variant="secondary" onClick={() => upload(false)} disabled={!canUpload || busy}>
            Save as draft
          </Button>
          <Button onClick={() => upload(true)} loading={busy} disabled={!canUpload}>
            <Upload className="h-4 w-4" />
            Publish now
          </Button>
        </div>

        <div className="mt-4">
          <InfoNote>
            <span className="font-medium text-slate-700">
              Publishing replaces whatever Semester {semester} is running now
            </span>{' '}
            — the previous grid is archived, not deleted, and everyone is notified. One-off changes
            already made (extra classes, shifts, approved swaps) are kept, because they attach to
            specific dates rather than to the grid.
          </InfoNote>
        </div>
      </Card>

      {/* Versions */}
      <h2 className="mb-3 text-base font-semibold text-slate-900">Versions</h2>
      {loading ? (
        <Spinner label="Loading versions" />
      ) : versions.length === 0 ? (
        <Card>
          <EmptyState title="Nothing uploaded yet" description="Upload a CSV to get started." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-slate-900">{v.name}</p>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[v.status]}`}
                    >
                      {v.status}
                    </span>
                  </div>
                  <p className="nums mt-0.5 text-xs text-slate-500">
                    Semester {v.semester} · {v.entryCount} periods · from {v.effectiveFrom}
                    {v.uploadedBy && ` · by ${v.uploadedBy}`}
                  </p>
                  {v.warnings?.length > 0 && (
                    <p className="mt-1 text-[11px] text-amber-700">{v.warnings[0]}</p>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {v.status !== 'published' && (
                    <Button variant="secondary" size="sm" onClick={() => publish(v.id)}>
                      <Radio className="h-3.5 w-3.5" />
                      Publish
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-rose-600 hover:bg-rose-50"
                    onClick={() => remove(v)}
                    title="Delete this version"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
