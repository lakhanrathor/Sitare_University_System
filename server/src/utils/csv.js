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

/** Parses to objects keyed by a normalised header row. */
export function parseCSVToObjects(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, ''));
  const records = rows.slice(1).map((cells, idx) => {
    const obj = { __line: idx + 2 }; // 1-based, and the header occupies line 1
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? '').trim();
    });
    return obj;
  });

  return { headers, records };
}

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
