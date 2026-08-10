import { useEffect, useMemo, useState } from 'react';
import { Info, Wand2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../context/ToastContext';
import { shortDate } from '../../lib/timetable';
import { sectionLabel } from '../../lib/format';
import { Modal, Button, Field, Input, Select, ErrorNote, InfoNote } from '../ui';

const NEW = '__new__';

/**
 * Correct what a period says.
 *
 * Reading a printed timetable is inference, so cells come back wrong: words out
 * of order, two cells merged, a lecturer missed so the period reads as a bare
 * event. This edits the cell in place instead of making the admin re-upload and
 * hope for a better parse.
 *
 * Corrections are deliberately not local. A subject has one name, so renaming
 * it here renames it on every grid, register and report at once — and naming
 * the lecturer assigns them the subject, which is what actually clears an
 * "unassigned" class rather than papering over one cell.
 */
export default function EditPeriodModal({ open, onClose, occurrence, subjects, faculty, onDone }) {
  const { notify } = useToast();

  const [subjectChoice, setSubjectChoice] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [facultyId, setFacultyId] = useState('');
  const [scope, setScope] = useState('subject');
  const [kind, setKind] = useState('lecture');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const current = useMemo(
    () => subjects.find((s) => s.id === occurrence?.subject?.id) || null,
    [subjects, occurrence]
  );

  /*
   * Only this cohort's subjects. Every subject belongs to a section, and
   * pointing Section B's period at Section A's subject would put one cohort on
   * the other's register. A period with no section is the whole year together,
   * so nothing is filtered out there.
   */
  const choices = useMemo(() => {
    const sectionId = occurrence?.section?.id;
    const list = sectionId ? subjects.filter((s) => s.section?.id === sectionId) : subjects;
    // Keep the one already on the cell even if it sits outside the filter.
    if (occurrence?.subject && !list.some((s) => s.id === occurrence.subject.id)) {
      const hit = subjects.find((s) => s.id === occurrence.subject.id);
      if (hit) return [hit, ...list];
    }
    return list;
  }, [subjects, occurrence]);

  /* Two subjects can share a name across cohorts, so say which is which. */
  const label = (s) =>
    `${s.code} — ${s.name}${s.section?.name ? ` · Sec ${s.section.name}` : ''}`;

  useEffect(() => {
    if (!open || !occurrence) return;
    setError('');
    setSubjectChoice(occurrence.subject?.id || '');
    setName(occurrence.subject?.name || '');
    setCode(occurrence.subject?.code || '');
    setFacultyId(occurrence.faculty?.id || '');
    setScope('subject');
    setKind(occurrence.kind || 'lecture');
    setTitle(occurrence.title || '');
  }, [open, occurrence]);

  // Picking a different subject adopts its name; "new" clears the fields.
  const pickSubject = (value) => {
    setSubjectChoice(value);
    if (value === NEW) {
      setName('');
      setCode('');
      return;
    }
    const hit = choices.find((s) => s.id === value);
    setName(hit?.name || '');
    setCode(hit?.code || '');
  };

  if (!occurrence) return null;

  const renaming =
    subjectChoice && subjectChoice !== NEW && current && name.trim() && name.trim() !== current.name;
  const creating = subjectChoice === NEW || (!occurrence.subject && name.trim());

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = { kind, title };
      const wasId = occurrence.subject?.id || '';

      if (subjectChoice === NEW) {
        // A subject the semester does not have yet: create it and enrol the cohort.
        payload.subjectName = name.trim();
        if (code.trim()) payload.subjectCode = code.trim();
      } else if (subjectChoice === '') {
        // Deliberately no subject — back to being a plain event.
        if (wasId) payload.subjectId = null;
      } else if (subjectChoice !== wasId) {
        /*
         * Pointing the period at a subject that already exists. This must send
         * the id, never the name: sending a name asks the server to create a
         * subject, which then collides with the very one being pointed at.
         */
        payload.subjectId = subjectChoice;
        const picked = choices.find((s) => s.id === subjectChoice);
        if (name.trim() && name.trim() !== picked?.name) payload.subjectName = name.trim();
        if (code.trim() && code.trim() !== picked?.code) payload.subjectCode = code.trim();
      } else {
        // Same subject: send the name so a typo actually gets corrected.
        if (name.trim()) payload.subjectName = name.trim();
        if (code.trim()) payload.subjectCode = code.trim();
      }

      if (facultyId !== (occurrence.faculty?.id || '')) {
        payload.facultyId = facultyId || null;
        payload.applyFacultyTo = scope;
      } else if (subjectChoice === NEW && facultyId) {
        payload.facultyId = facultyId;
        payload.applyFacultyTo = scope;
      }

      const res = await api.editEntry(occurrence.entryId, payload);
      notify(res.message, { variant: 'success', title: 'Timetable corrected' });
      onDone?.();
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
      title="Correct this period"
      subtitle={`${shortDate(occurrence.date)} · ${sectionLabel(occurrence.section)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* A period pointed at a subject has to name it; an event need not. */}
          <Button onClick={save} loading={busy} disabled={subjectChoice !== '' && !name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}

        {/* What the file actually said, so a scrambled cell can be recognised. */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs">
          <p className="font-medium text-slate-600">Currently on the grid</p>
          <p className="mt-1 text-slate-800">
            {occurrence.subject
              ? `${occurrence.subject.code} — ${occurrence.subject.name}`
              : occurrence.title || '(nothing named)'}
            {occurrence.faculty ? ` · ${occurrence.faculty.name}` : ' · no lecturer'}
          </p>
        </div>

        <Field label="Subject">
          <Select value={subjectChoice} onChange={(e) => pickSubject(e.target.value)}>
            <option value="">No subject (an event)</option>
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {label(s)}
              </option>
            ))}
            <option value={NEW}>+ A subject not on the list…</option>
          </Select>
        </Field>

        {(subjectChoice || subjectChoice === NEW) && (
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <Field
              label="Subject name"
              hint={
                renaming
                  ? 'Renames it everywhere — every grid, register and report.'
                  : 'Fix a typo here and it is fixed everywhere.'
              }
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Creative Problem Solving"
              />
            </Field>
            <Field label="Code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="CPS"
              />
            </Field>
          </div>
        )}

        <Field label="Lecturer">
          <Select value={facultyId} onChange={(e) => setFacultyId(e.target.value)}>
            <option value="">Not assigned</option>
            {faculty.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>

        {/*
          Only worth asking once a lecturer is named, and only when the subject
          already has one — otherwise assigning the subject is plainly right.
        */}
        {facultyId && current?.faculty && current.faculty.id !== facultyId && (
          <Field label="Apply the lecturer to">
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="subject">
                The whole subject — {current.code} becomes theirs everywhere
              </option>
              <option value="entry">This one period only</option>
            </Select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="lecture">Lecture</option>
              <option value="office-hours">Office hours</option>
              <option value="event">Event</option>
            </Select>
          </Field>
          <Field label="Note" hint="Shown as a label, e.g. Tutorial">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </div>

        <InfoNote icon={creating ? Wand2 : Info}>
          {creating ? (
            <>
              This period has no subject yet. Naming it creates the subject, enrols the cohort and
              gives it a register — turning a bare event into a class that attendance can be taken
              for.
            </>
          ) : (
            <>
              This edits the recurring timetable, not one date. A subject has a single name and a
              single lecturer, so what you change here is what every teacher and student sees.
            </>
          )}
        </InfoNote>
      </div>
    </Modal>
  );
}
