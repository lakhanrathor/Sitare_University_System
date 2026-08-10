import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { shortDate } from '../../lib/timetable';
import { sectionLabel } from '../../lib/format';
import { Modal, Button, Field, Select, Textarea, ErrorNote, InfoNote } from '../ui';

/**
 * Claim a free period. The booking is visible to every other teacher the moment
 * it is saved, which is what prevents two people planning the same room-hour.
 */
export default function BookSlotModal({ open, onClose, target, onDone }) {
  const { notify } = useToast();
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [kind, setKind] = useState('lecture');
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !target) return;
    setError('');
    setReason('');
    setTitle('');
    setKind('lecture');
    (async () => {
      try {
        const list = await api.bookableSubjects(target.sectionId);
        setSubjects(list);
        setSubjectId(list[0]?.id || '');
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [open, target]);

  if (!target) return null;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.bookExtra({
        date: target.date,
        slot: target.slot,
        sectionId: target.sectionId,
        ...(kind === 'event' ? { title } : { subjectId }),
        kind,
        reason,
      });
      notify(res.message, { variant: 'success', title: 'Period booked' });
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = kind === 'event' ? title.trim().length > 0 : Boolean(subjectId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Book this period"
      subtitle={`${shortDate(target.date)} · ${target.slotLabel} · ${sectionLabel(target.sectionName)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            Book period
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        <Field label="What is this period for?">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="lecture">Extra class</option>
            <option value="office-hours">Office hours</option>
            <option value="event">Other session</option>
          </Select>
        </Field>

        {kind === 'event' ? (
          <Field label="Session title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Guest lecture"
              className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
          </Field>
        ) : (
          <Field
            label="Subject"
            hint={
              subjects.length === 0
                ? 'You do not teach any subject in this section.'
                : undefined
            }
          >
            <Select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              disabled={!subjects.length}
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Reason" hint="Shown to other staff so they know why the period is taken.">
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Makeup class for the lecture missed last week"
          />
        </Field>

        <InfoNote>
          Every other teacher is notified immediately, so this period will show as taken on their
          timetable too. Attendance for it can be taken from the Attendance module once the class
          has happened.
        </InfoNote>
      </div>
    </Modal>
  );
}
