import { useCallback, useEffect, useState } from 'react';
import { Plus, Paperclip, Download, Trash2, CalendarRange, Mail, FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { formatDate, todayKey } from '../../lib/format';
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
  Textarea,
  InfoNote,
} from '../../components/ui';

const readableSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** How the leave period reads: one day, a range, or nothing given. */
function period(d) {
  if (!d.leaveFrom && !d.leaveTo) return null;
  if (d.leaveFrom && d.leaveTo && d.leaveFrom !== d.leaveTo) {
    return `${formatDate(d.leaveFrom)} – ${formatDate(d.leaveTo, true)}`;
  }
  return formatDate(d.leaveFrom || d.leaveTo, true);
}

function ApplyDialog({ open, onClose, onSaved }) {
  const { notify } = useToast();
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [leaveFrom, setLeaveFrom] = useState('');
  const [leaveTo, setLeaveTo] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    setDetails('');
    setLeaveFrom('');
    setLeaveTo('');
    setFiles([]);
    setError('');
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.submitLeave({ reason, details, leaveFrom, leaveTo, files });
      notify('Sent to the office', { variant: 'success', title: 'Leave applied' });
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
      title="Apply for leave"
      subtitle="Tell the office why you will be away"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={reason.trim().length < 3}>
            Send application
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="Reason" hint="A line is enough — you can explain further below.">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Down with dengue"
            autoFocus
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" hint="Optional">
            <input
              type="date"
              value={leaveFrom}
              onChange={(e) => setLeaveFrom(e.target.value)}
              className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
          </Field>
          <Field label="To" hint="Leave blank for a single day">
            <input
              type="date"
              value={leaveTo}
              min={leaveFrom || undefined}
              onChange={(e) => setLeaveTo(e.target.value)}
              className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Anything else" hint="Optional">
          <Textarea
            rows={3}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Any detail the office should know"
          />
        </Field>

        <Field
          label="Documents"
          hint="Optional — attach a medical certificate or letter only if you have one."
        >
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
          This does not change your attendance. It puts your reason on file so the office can see it
          when they review the semester.
        </InfoNote>
      </div>
    </Modal>
  );
}

export default function StudentLeave() {
  const { notify } = useToast();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocs(await api.myLeave());
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

  const withdraw = async (d) => {
    try {
      await api.deleteLeave(d.id);
      notify('Application withdrawn', { variant: 'success' });
      load();
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  const download = async (d, a) => {
    try {
      await api.downloadAttachment(d.id, a.id, a.filename);
    } catch (err) {
      notify(err.message, { variant: 'error' });
    }
  };

  if (loading) return <Spinner label="Loading your applications" />;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Leave applications"
        subtitle={
          docs.length
            ? `${docs.length} on file with the office`
            : 'Let the office know when you cannot attend'
        }
        actions={
          <Button onClick={() => setApplying(true)}>
            <Plus className="h-4 w-4" />
            Apply for leave
          </Button>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        {!docs.length ? (
          <EmptyState
            icon={CalendarRange}
            title="Nothing applied for yet"
            description="When you have to miss class, apply here. Your reason stays on file, with a document if you have one."
            action={
              <Button onClick={() => setApplying(true)}>
                <Plus className="h-4 w-4" />
                Apply for leave
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {docs.map((d) => {
              const when = period(d);
              return (
                <li key={d.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-slate-900">{d.regarding}</h3>
                        {d.source !== 'student' && (
                          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                            {d.source === 'email' ? (
                              <>
                                <Mail className="h-3 w-3" /> From your mail
                              </>
                            ) : (
                              <>
                                <FileText className="h-3 w-3" /> Added by the office
                              </>
                            )}
                          </span>
                        )}
                      </div>

                      {when && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-indigo-700">
                          <CalendarRange className="h-3 w-3" />
                          {when}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-slate-500">
                        Applied {formatDate(d.sentAt, true)}
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

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => withdraw(d)}
                      title="Withdraw this application"
                    >
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ApplyDialog open={applying} onClose={() => setApplying(false)} onSaved={load} />
    </div>
  );
}
