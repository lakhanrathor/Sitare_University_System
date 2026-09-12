/**
 * Minimal RFC-4180 CSV reader — enough for timetable uploads without pulling
 * in a dependency. Handles quoted fields, embedded commas/newlines and "".
 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * What a column is called, versus what it means.
 *
 * Real spreadsheets do not use the header names a developer picked. The same
 * column arrives as "Roll No.", "Roll Number", "Enrollment No", or "Student
 * Name" instead of "name" — and refusing those means an administrator has to
 * hand-edit a file the office already maintains, which is exactly the work
 * this import exists to remove.
 *
 * Matching is scored rather than a substring test, because a substring test
 * gets this wrong in ways that are worse than not matching at all: "Father
 * Name" contains "name", and "Enrollment No" contains "roll". An exact hit
 * beats a prefix or suffix, which beats a bare mention, and the longest alias
 * wins a tie — so "Student Name" is preferred over "Father Name" for `name`
 * when a file carries both, and every column is claimed by at most one field.
 */
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

function scoreAlias(header, alias) {
  if (header === alias) return 4;
  if (header.startsWith(alias) || header.endsWith(alias)) return 2;
  if (header.includes(alias)) return 1;
  return 0;
}

/**
 * Map each canonical field onto the column that best represents it.
 * `schema` is { canonicalKey: [alias, ...] }, aliases already normalised.
 */
export function resolveHeaders(headers, schema) {
  const resolved = {};
  const taken = new Set();

  /*
   * Strongest matches first, across every field at once. Resolving field by
   * field would let a weak match on an early field claim a column that is a
   * much better fit for a later one.
   */
  const candidates = [];
  Object.entries(schema).forEach(([field, aliases]) => {
    headers.forEach((header, index) => {
      let best = 0;
      let length = 0;
      aliases.forEach((alias) => {
        const score = scoreAlias(header, alias);
        if (score > best || (score === best && score > 0 && alias.length > length)) {
          best = score;
          length = alias.length;
        }
      });
      if (best > 0) candidates.push({ field, index, score: best, length });
    });
  });

  candidates
    .sort((a, b) => b.score - a.score || b.length - a.length || a.index - b.index)
    .forEach(({ field, index }) => {
      if (resolved[field] !== undefined || taken.has(index)) return;
      resolved[field] = index;
      taken.add(index);
    });

  return resolved;
}

/**
 * Parses to objects keyed by a normalised header row.
 *
 * With a `schema`, columns are additionally exposed under their canonical
 * names, so a caller reads `r.rollnumber` whether the file said "Roll No." or
 * "Enrollment Number". The raw normalised keys are kept alongside, so a column
 * the schema does not know about is still readable.
 */
export function parseCSVToObjects(text, schema = null) {
  const rows = parseCSV(text);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map(norm);
  const resolved = schema ? resolveHeaders(headers, schema) : {};

  const records = rows.slice(1).map((cells, idx) => {
    const obj = { __line: idx + 2 }; // 1-based, and the header occupies line 1
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim();
    });
    Object.entries(resolved).forEach(([field, i]) => {
      obj[field] = (cells[i] ?? '').trim();
    });
    return obj;
  });

  return { headers, records, resolved };
}

/**
 * The columns a student roster can arrive with. Keys are what the importer
 * reads; the lists are what an office spreadsheet actually calls them.
 */
export const STUDENT_COLUMNS = {
  rollnumber: [
    'rollnumber', 'rollno', 'roll', 'rollnum', 'enrollmentnumber', 'enrollmentno',
    'enrolmentnumber', 'enrolmentno', 'registrationnumber', 'registrationno', 'regno',
    'studentid', 'universityroll',
  ],
  name: ['name', 'studentname', 'fullname', 'nameofstudent', 'studentfullname'],
  email: ['email', 'emailid', 'emailaddress', 'mailid', 'officialemail', 'collegeemail'],
  section: ['section', 'sectionname', 'sec', 'division', 'div'],
  batch: ['batch', 'batchyear', 'admissionyear', 'yearofadmission'],
};

/** The same, for a timetable uploaded as a list of periods. */
export const TIMETABLE_COLUMNS = {
  day: ['day', 'weekday', 'dayofweek', 'days'],
  slot: ['slot', 'period', 'periodno', 'slotno', 'periodnumber'],
  section: ['section', 'sectionname', 'sec', 'division', 'div'],
  subjectcode: ['subjectcode', 'code', 'subject', 'coursecode', 'subjectname', 'course'],
  facultyemail: ['facultyemail', 'email', 'teacheremail', 'lectureremail', 'facultymail'],
  kind: ['kind', 'type', 'periodtype', 'classtype'],
  title: ['title', 'note', 'label', 'remark', 'remarks'],
};

export function toCSV(rows) {
  return rows
    .map((r) =>
      r
        .map((c) => {
          const v = c === null || c === undefined ? '' : String(c);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(',')
    )
    .join('\n');
}
