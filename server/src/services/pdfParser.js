/**
 * Turns an uploaded PDF into the rows the validation pipeline expects.
 *
 * Two timetable layouts are recognised:
 *
 *   grid  the printed wall timetable — weekdays across the top, period times
 *         down the left, optionally split into sections. This is what
 *         institutes actually hand out, and it is reconstructed from glyph
 *         positions because a PDF stores ink, not tables.
 *   list  one row per period with day/slot/section columns.
 *
 * The period times, the subjects and the lecturers all come out of the file —
 * nothing is assumed to match a preset. Extraction is inference, so nothing
 * here writes to the database: the admin reviews what was read first.
 */
import { extractItems, groupIntoRows, mergeIntoCells } from '../utils/pdf.js';
import { DAYS, parseDay } from '../config/slots.js';

const DAY_NAMES = DAYS.map((d) => d.name.toLowerCase());

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ------------------------------------------------------------------ */
/* Period times                                                        */
/* ------------------------------------------------------------------ */

const PERIOD_RE = /(\d{1,2})[:.](\d{2})\s*[-–—to]+\s*(\d{1,2})[:.](\d{2})/i;

/** A college day runs 8am-8pm, so 1:00 means 13:00 while 9:00 means 09:00. */
function to24(h, m) {
  let hour = Number(h);
  if (hour >= 1 && hour <= 7) hour += 12;
  return hour * 60 + Number(m);
}

const hhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** '9:00-10:00' -> { start, end } in minutes, or null. */
function readPeriodLabel(text) {
  const m = String(text).match(PERIOD_RE);
  if (!m) return null;
  const start = to24(m[1], m[2]);
  const end = to24(m[3], m[4]);
  return { start, end: end > start ? end : start + 60 };
}

const isBreakRow = (text) => /\b(lunch|break|recess|interval)\b/i.test(text);

/* ------------------------------------------------------------------ */
/* Cell text -> meaning                                                */
/* ------------------------------------------------------------------ */

const OFFICE_HOURS_RE = /\(?\s*(?:office\s*(?:hours?|hr?s?)|ofc\s*hrs?)\s*\)?/i;
const QUALIFIER_RE = /\((tutorial|practical|lab|lecture)\)|\b(tutorial|practical|lab)\b/i;

/**
 * Match free text from a cell against known subject names.
 * Handles the abbreviation problem directly: a grid says "ADSA" while the
 * legend underneath spells out "Advanced Data Structures and Algorithms".
 */
function matchSubject(text, candidates) {
  const t = norm(text);
  if (!t) return null;

  for (const c of candidates) {
    if (norm(c.name) === t) return c;
    if (c.code && norm(c.code) === t) return c;
  }

  /*
   * Initials, because a grid abbreviates what the legend spells out:
   *   "adsa" <- "advanced data structures and algorithms"
   *   "oop"  <- "object oriented programming in java"   (a leading run only)
   * Filler words are dropped, and a prefix counts so trailing qualifiers
   * like "in Java" do not break the match.
   */
  const compact = t.replace(/\s/g, '');
  if (compact.length >= 2) {
    for (const c of candidates) {
      const initials = norm(c.name)
        .split(' ')
        .filter((w) => !['and', 'for', 'of', 'in', 'the', 'to', 'a'].includes(w))
        .map((w) => w[0])
        .join('');
      if (initials && (initials === compact || initials.startsWith(compact))) return c;
    }
  }

  let best = null;
  for (const c of candidates) {
    const n = norm(c.name);
    if (!n) continue;
    if (t.includes(n) || n.includes(t)) {
      const score = Math.min(n.length, t.length) / Math.max(n.length, t.length);
      if (score > 0.55 && (!best || score > best.score)) best = { ...c, score };
    }
  }
  return best;
}

function matchFaculty(text, candidates) {
  const t = norm(text).replace(/\b(dr|mr|mrs|ms|prof|sir|ma am|maam)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const c of candidates) {
    const n = norm(c.name).replace(/\b(dr|mr|mrs|ms|prof)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (n === t || n.includes(t) || t.includes(n)) return c;
  }
  return null;
}

/**
 * Read one grid cell.
 * A cell can name two subjects at once ("ADSA & OOP Office hr") — a shared
 * office hour. That is kept as a single period so it does not read as the
 * cohort being in two rooms at the same time.
 */
function readCell(raw, catalogue) {
  let text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text || isBreakRow(text)) return null;

  const isOfficeHours = OFFICE_HOURS_RE.test(text);

  // A cell that is nothing but "Office hr" is a wrapped fragment that lost its
  // subject, not a class of its own. Drop it rather than invent a period.
  if (isOfficeHours && !text.replace(OFFICE_HOURS_RE, ' ').replace(/[()\s]/g, '')) return null;
  const qualifier = text.match(QUALIFIER_RE)?.[0]?.replace(/[()]/g, '') || '';

  let body = text.replace(OFFICE_HOURS_RE, ' ').replace(/\s+/g, ' ').trim();

  // A parenthesised note is a lecturer, or a qualifier we have already noted.
  let facultyHint = null;
  body = body
    .replace(/\(([^)]*)\)/g, (_full, inner) => {
      const hit = matchFaculty(inner, catalogue.facultyNames);
      if (hit) facultyHint = hit;
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();

  // Strip a trailing qualifier word so "OOP Practical" still matches "OOP".
  const bodyNoQualifier = body.replace(/\b(tutorial|practical|lab)\b/gi, ' ').replace(/[-–&]\s*$/, '').trim();

  const parts = bodyNoQualifier
    .split(/\s*&\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const matched = [];
  for (const part of parts) {
    const hit = matchSubject(part, catalogue.subjectNames);
    if (hit && !matched.some((m) => m.name === hit.name)) matched.push(hit);
  }
  // The whole cell may itself be one subject whose name contains "&".
  if (!matched.length) {
    const whole = matchSubject(bodyNoQualifier, catalogue.subjectNames);
    if (whole) matched.push(whole);
  }

  const primary = matched[0] || null;

  return {
    subject: primary,
    // Everything the cell said, kept so nothing is silently dropped.
    title: primary ? (matched.length > 1 || qualifier ? text : '') : text,
    kind: isOfficeHours ? 'office-hours' : primary ? 'lecture' : 'event',
    facultyHint,
    sharedWith: matched.slice(1).map((m) => m.name),
    raw: text,
  };
}

/* ------------------------------------------------------------------ */
/* Grid layout                                                         */
/* ------------------------------------------------------------------ */

/** "Dr", "Mr.", "Ms" — how a lecturer's name opens, and a wrapped line does not. */
const FACULTY_TITLE_RE = /^\s*(dr|mr|mrs|ms|miss|prof|professor|shri|smt)\b\.?\s+\S/i;

/**
 * The subject/faculty key printed under many timetables.
 *
 * Entries are found through the faculty column, because a table row holds
 * exactly one lecturer however many lines the subject beside it wraps onto.
 * A line opening with a title ("Dr", "Mr.") starts a new lecturer; anything
 * else continues the one above.
 *
 * Assignment of subject-column lines is done by *print order*, not by
 * vertical distance. A distance comparison looks right until a subject wraps
 * onto more lines than its own lecturer's name does — which is the ordinary
 * case, not an edge case, since a two-line subject sits beside a one-line
 * name far more often than not. When that happens the subject's earlier
 * wrapped lines sit physically nearer the *previous* lecturer's line than
 * their own, and a distance-based match glues them onto the wrong entry —
 * "Advanced Data" ends up on the entry above it, "Probability for Computer
 * Science" only two words of its own name. Print order has no such failure
 * mode: every subject line appears, in the file, before the row where its
 * own lecturer's name is finally printed, so buffering left-column lines
 * until a lecturer line arrives — new or continuing — always attaches them
 * to the right entry, whether the subject wraps zero lines or several.
 */
/*
 * A row's subject/faculty split only has a lower bound (x >= split means
 * "faculty side"), not an upper one — so an unrelated table sitting further
 * right on the same page (a "Classroom Allocation" block, say) that happens
 * to share a row's y-coordinate gets read as more of that row's faculty
 * text. Genuine same-entry text never has a gap this wide: items this close
 * together are already merged into one by the glyph extraction upstream, so
 * two *separate* items on one side of a row are either adjacent words of the
 * same phrase (a small gap) or content from an entirely different table (a
 * large one). Stopping at the first oversized gap keeps the first, drops
 * the second, without needing to know anything about that other table.
 */
const MAX_LEGEND_WORD_GAP = 40;

function contiguousText(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const kept = [];
  let previousEnd = null;
  for (const it of sorted) {
    if (previousEnd !== null && it.x - previousEnd > MAX_LEGEND_WORD_GAP) break;
    kept.push(it.text);
    previousEnd = it.x + (it.width || 0);
  }
  return kept.join(' ').trim();
}

function readLegend(rows, startIndex, headerCells) {
  const split = (headerCells.subject + headerCells.faculty) / 2;

  const lines = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    const row = rows[i];
    const left = row.items.filter((it) => it.x < split);
    const right = row.items.filter((it) => it.x >= split);
    const leftText = contiguousText(left);
    const rightText = contiguousText(right);
    if (!leftText && !rightText) continue;
    lines.push({
      y: row.y,
      leftText,
      rightText,
      height: Math.max(0, ...row.items.map((it) => it.height || 0)),
    });
  }
  if (!lines.length) return [];

  const heights = lines.map((l) => l.height).filter(Boolean).sort((a, b) => a - b);
  const lineHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 9;

  // No lecturer column to anchor on: fall back to one entry per printed line.
  if (!lines.some((l) => l.rightText)) {
    return lines
      .filter((l) => l.leftText)
      .map((l) => ({ subject: l.leftText.replace(/\s+/g, ' ').trim(), faculty: '' }));
  }

  const entries = [];
  let current = null;
  let pendingSubject = []; // left-column lines seen since the last lecturer line
  let previousY = null;
  let previousFaculty = '';

  for (const l of lines) {
    if (!l.rightText) {
      if (l.leftText) pendingSubject.push(l.leftText);
      continue;
    }

    /*
     * A subject taught by two people wraps mid-list — "Mr Ankit Mehta/" then
     * "Dr Anuja Agarwal" — so a dangling separator outranks the title rule.
     * Without this the second lecturer starts a phantom entry and takes half
     * the subject's name with them.
     */
    const continuesList = /[/,&+-]\s*$/.test(previousFaculty);
    const startsEntry =
      previousY === null ||
      (!continuesList &&
        (FACULTY_TITLE_RE.test(l.rightText) || l.y - previousY > lineHeight * 1.6));

    // Whatever was buffered, plus this row's own left text, was printed
    // before this lecturer line and belongs to whichever entry it opens.
    const subjectHere = [...pendingSubject, ...(l.leftText ? [l.leftText] : [])];
    pendingSubject = [];

    if (startsEntry) {
      if (current) entries.push(current);
      current = { subject: subjectHere, faculty: [l.rightText] };
    } else {
      current.subject.push(...subjectHere);
      current.faculty.push(l.rightText);
    }
    previousY = l.y;
    previousFaculty = l.rightText;
  }
  if (current) {
    // Trailing left-only lines with no lecturer line left to close them —
    // rare, but still this entry's rather than nobody's.
    current.subject.push(...pendingSubject);
    entries.push(current);
  }

  return entries
    .map((e) => ({
      subject: e.subject.join(' ').replace(/\s+/g, ' ').trim(),
      // "Ms Preeti Shukla/Ms Riya Bangera" — the first name owns the subject.
      faculty: e.faculty.join(' ').replace(/\s+/g, ' ').trim(),
    }))
    .filter((e) => e.subject);
}

function findLegendRow(rows, from) {
  for (let i = from; i < rows.length; i += 1) {
    const cells = mergeIntoCells(rows[i].items);
    const subj = cells.find((c) => /^subjects?$/i.test(c.text.trim()));
    const fac = cells.find((c) => /^(faculty|lecturer|teacher)s?$/i.test(c.text.trim()));
    if (subj && fac) {
      return { index: i, subject: subj.x, faculty: fac.x };
    }
  }
  return null;
}

function findColumns(rows) {
  let dayRow = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i += 1) {
    const hits = rows[i].items.filter((it) => DAY_NAMES.includes(norm(it.text))).length;
    if (hits >= 3) {
      dayRow = i;
      break;
    }
  }
  if (dayRow === -1) return null;

  const days = rows[dayRow].items
    .filter((it) => DAY_NAMES.includes(norm(it.text)))
    .map((it) => ({ day: parseDay(it.text), center: it.x + it.width / 2, left: it.x }))
    .sort((a, b) => a.center - b.center);

  // Sections, when the grid splits each day.
  let sectionRow = -1;
  for (let i = dayRow + 1; i < Math.min(rows.length, dayRow + 4); i += 1) {
    const hits = rows[i].items.filter((it) => /^sec(tion)?\b/i.test(it.text)).length;
    if (hits >= 2) {
      sectionRow = i;
      break;
    }
  }

  let columns;
  if (sectionRow >= 0) {
    columns = rows[sectionRow].items
      .filter((it) => /^sec(tion)?\b/i.test(it.text))
      .map((it) => {
        const center = it.x + it.width / 2;
        const day = days.reduce((a, b) =>
          Math.abs(b.center - center) < Math.abs(a.center - center) ? b : a
        );
        return {
          day: day.day,
          section: (it.text.match(/sec(?:tion)?\s*([A-Za-z0-9]+)/i)?.[1] || '').toUpperCase(),
          center,
        };
      })
      .sort((a, b) => a.center - b.center);
  } else {
    columns = days.map((d) => ({ day: d.day, section: null, center: d.center }));
  }

  if (!columns.length) return null;

  const bounds = [];
  for (let i = 0; i < columns.length - 1; i += 1) {
    bounds.push((columns[i].center + columns[i + 1].center) / 2);
  }

  return {
    headerRowIndex: sectionRow >= 0 ? sectionRow : dayRow,
    columns,
    bounds,
    hasSections: sectionRow >= 0,
  };
}

const columnFor = (x, bounds) => {
  let i = 0;
  while (i < bounds.length && x >= bounds[i]) i += 1;
  return i;
};

/**
 * Read the body of the grid by binning every text run into a (period, column)
 * cell using its position.
 *
 * Rows of text cannot define the periods: a table cell is vertically centred,
 * so a three-line entry starts *above* the row holding its own period label
 * and a one-line entry sits below it. Anchoring on text rows therefore drags
 * the first line of a tall cell into the period above and orphans the rest —
 * which is how "Creative Problem Solving" comes back as "Solving" in one
 * period and "Creative Problem" in another.
 *
 * Instead the period labels define horizontal bands, the column headers define
 * vertical ones, and each run simply falls into the box it is drawn in.
 */
/**
 * How far past the last real period a band can run before it is almost
 * certainly no longer the grid at all.
 *
 * A period label only marks where a band STARTS; nothing marks where the
 * last one ends. Every earlier band already ends at the midpoint to the next
 * label, so the same spacing is the one honest estimate for the last band
 * too - one more period's worth of height, not the rest of the page. Without
 * this the last period has no upper bound whatsoever, and anything printed
 * below the grid - a legend with no header row, a room-allocation note - gets
 * read as if it were that period's own class.
 */
function estimateGridEnd(anchors) {
  if (anchors.length < 2) return null;
  const gaps = [];
  for (let i = 0; i < anchors.length - 1; i += 1) gaps.push(anchors[i + 1].y - anchors[i].y);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  return anchors[anchors.length - 1].y + medianGap;
}

/**
 * Every period label in the file, independent of where the grid is judged to
 * end - the label pattern itself (HH:MM-HH:MM in the time gutter) is what
 * makes a row an anchor, so this needs no boundary to already be correct.
 * Used before the boundary exists, to work one out.
 */
function findAnchors(rows, header) {
  const { columns, headerRowIndex } = header;
  const pitch = columns.length > 1 ? columns[1].center - columns[0].center : columns[0].center * 2;
  const gutterEdge = columns[0].center - pitch / 2;
  const startY = rows[headerRowIndex].y;

  const anchors = [];
  for (const row of rows) {
    if (row.y <= startY) continue;
    const timeItem = row.items.find(
      (it) => it.x + it.width / 2 < gutterEdge && readPeriodLabel(it.text)
    );
    if (!timeItem) continue;
    anchors.push({ y: timeItem.y, isBreak: isBreakRow(row.text) });
  }
  anchors.sort((a, b) => a.y - b.y);
  return anchors;
}

/**
 * A subject/faculty legend with no printed "Subject" / "Faculty" heading at
 * all - the institute simply lists the pairs straight after the grid.
 *
 * Nothing marks where such a table begins except that it is the first real
 * content once the grid itself has ended, so that boundary is estimated
 * first (see estimateGridEnd). The two columns are then found the same way a
 * person would read them: each row's own first gap between one run of text
 * and the next is its subject/faculty boundary, and the typical value of
 * that gap across every row is trusted as the column split - capped well
 * short of a page width, so an unrelated table printed further along the
 * same row (a room-allocation note, say) cannot be mistaken for a second
 * legend column and does not shift the split at all.
 */
function findHeaderlessLegend(rows, estimatedEndY) {
  if (estimatedEndY == null) return null;

  const startIndex = rows.findIndex((r) => r.y >= estimatedEndY && r.items.length > 0);
  if (startIndex === -1) return null;

  const midpoints = [];
  for (let i = startIndex; i < rows.length; i += 1) {
    const sorted = [...rows[i].items].sort((a, b) => a.x - b.x);
    if (sorted.length < 2) continue;
    const gap = sorted[1].x - (sorted[0].x + sorted[0].width);
    if (gap > 3 && gap < 150) {
      midpoints.push((sorted[0].x + sorted[0].width + sorted[1].x) / 2);
    }
  }
  if (!midpoints.length) return null;

  midpoints.sort((a, b) => a - b);
  const split = midpoints[Math.floor(midpoints.length / 2)];

  const legend = readLegend(rows, startIndex, { subject: split - 1, faculty: split + 1 });
  return legend.length ? { legend, startIndex } : null;
}

function parseGrid(rows, header, catalogue, legendIndex) {
  const { columns, bounds, headerRowIndex } = header;

  /*
   * Where the period-label gutter ends. This is NOT the first column
   * boundary — that sits between Monday and Tuesday, and using it would
   * discard the whole of Monday. Mirror the column pitch to the left of the
   * first column instead.
   */
  const pitch =
    columns.length > 1 ? columns[1].center - columns[0].center : columns[0].center * 2;
  const gutterEdge = columns[0].center - pitch / 2;

  const startY = rows[headerRowIndex].y;
  const endY = legendIndex !== undefined && legendIndex !== null ? rows[legendIndex].y : Infinity;

  /*
   * Anchors: every period label, plus the break row, in vertical order.
   *
   * The label's own y is what counts, not its row's. A row anchor is the mean
   * of everything sharing that line across the whole page, so it drifts by a
   * few points — enough to push a band edge past a neighbouring cell and steal
   * its first line.
   */
  const anchors = [];
  for (const row of rows) {
    if (row.y <= startY || row.y >= endY) continue;
    const timeItem = row.items.find(
      (it) => it.x + it.width / 2 < gutterEdge && readPeriodLabel(it.text)
    );
    if (!timeItem) continue;
    const times = readPeriodLabel(timeItem.text);
    anchors.push({
      y: timeItem.y,
      times,
      label: timeItem.text.replace(/\s+/g, ' ').trim(),
      isBreak: isBreakRow(row.text),
    });
  }
  anchors.sort((a, b) => a.y - b.y);

  if (!anchors.length) return { records: [], periods: [], lunch: null };

  /*
   * The last period has no next label to bound it, so without a legend to
   * mark where the grid actually stops it would otherwise run to the bottom
   * of the page. One more period's worth of height, estimated from every
   * real gap already seen, is a far safer edge than none at all.
   */
  const cappedEndY = Math.min(endY, estimateGridEnd(anchors) ?? Infinity);

  // A band runs to the midpoint between its anchor and the next.
  const bandEdges = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    bandEdges.push((anchors[i].y + anchors[i + 1].y) / 2);
  }
  const bandFor = (y) => {
    let i = 0;
    while (i < bandEdges.length && y >= bandEdges[i]) i += 1;
    return i;
  };

  const periods = [];
  let lunch = null;
  const bandToPeriod = new Map();

  anchors.forEach((a, i) => {
    if (a.isBreak) {
      if (!lunch) lunch = { ...a.times, afterSlot: periods.length };
      return;
    }
    const p = {
      slot: periods.length + 1,
      label: a.label,
      start: a.times.start,
      end: a.times.end,
      cells: columns.map(() => []),
    };
    periods.push(p);
    bandToPeriod.set(i, p);
  });

  /*
   * Columns are found by the run's midpoint rather than its left edge: cells
   * mix alignments, and a midpoint stays inside its own column either way.
   */
  const columnRuns = columns.map(() => []);
  for (const row of rows) {
    if (row.y <= startY || row.y >= cappedEndY) continue;
    for (const it of row.items) {
      // The time gutter holds labels, never classes.
      if (it.x + it.width / 2 < gutterEdge) continue;
      if (isBreakRow(it.text)) continue;
      const idx = columnFor(it.x + it.width / 2, bounds);
      if (idx >= 0 && idx < columns.length) columnRuns[idx].push(it);
    }
  }

  const median = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const gridLineHeight = median(columnRuns.flat().map((it) => it.height).filter(Boolean)) || 9;

  /*
   * 1.4 line-heights tells a wrapped line from the next cell down. Measured
   * across real institute timetables the two are well separated: lines inside
   * a cell sit 1.15-1.3 line-heights apart, while the padding between cells
   * pushes the next one to 1.55-1.9. The ratio holds across font sizes, which
   * an absolute gap would not.
   */
  const CELL_GAP_RATIO = 1.4;

  /*
   * Assemble each column a cell at a time rather than a run at a time.
   *
   * A cell is set vertically centred, so a three-line entry reaches above and
   * below its own period label — judging each line separately drops the top
   * line into the period above ("Artificial Intelligence (Practical)" arriving
   * as "Intelligence (Practical)"). Lines are therefore grouped into the cell
   * they were printed in, and the cell as a whole goes to the period its
   * centre falls in.
   */
  for (const [idx, runs] of columnRuns.entries()) {
    runs.sort((a, b) => a.y - b.y || a.x - b.x);

    // Each column sets its own type, so measure the line height where it is used.
    const lineHeight = median(runs.map((it) => it.height).filter(Boolean)) || gridLineHeight;
    const sameLine = Math.max(2.5, lineHeight * 0.4);
    const sameCell = lineHeight * CELL_GAP_RATIO;

    const lines = [];
    for (const run of runs) {
      const last = lines[lines.length - 1];
      if (last && run.y - last.y <= sameLine) last.items.push(run);
      else lines.push({ y: run.y, items: [run] });
    }

    const cells = [];
    for (const ln of lines) {
      const last = cells[cells.length - 1];
      if (last && ln.y - last.bottom <= sameCell) {
        last.lines.push(ln);
        last.bottom = ln.y;
      } else {
        cells.push({ lines: [ln], top: ln.y, bottom: ln.y });
      }
    }

    for (const cell of cells) {
      const period = bandToPeriod.get(bandFor((cell.top + cell.bottom) / 2));
      if (!period) continue;
      // Read the cell the way a person does: down the lines, left to right.
      const text = cell.lines
        .map((ln) =>
          ln.items
            .sort((a, b) => a.x - b.x)
            .map((i) => i.text)
            .join(' ')
        )
        .join(' ');
      period.cells[idx].push(text);
    }
  }

  const records = [];
  let line = 1;
  for (const p of periods) {
    for (const [idx, parts] of p.cells.entries()) {
      const raw = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      const col = columns[idx];
      const parsed = readCell(raw, catalogue);
      if (!parsed) continue;

      records.push({
        __line: (line += 1),
        day: String(col.day),
        slot: String(p.slot),
        section: col.section || '',
        subjectcode: parsed.subject?.code || '',
        subjectname: parsed.subject?.name || '',
        facultyemail: parsed.facultyHint?.email || '',
        facultyname: parsed.facultyHint?.name || parsed.subject?.facultyName || '',
        kind: parsed.kind,
        title: parsed.title,
        __raw: parsed.raw,
        __sharedWith: parsed.sharedWith,
      });
    }
  }

  return {
    records,
    periods: periods.map(({ slot, label, start, end }) => ({
      slot,
      label,
      start: hhmm(start),
      end: hhmm(end),
    })),
    lunch: lunch
      ? { label: 'LUNCH', start: hhmm(lunch.start), end: hhmm(lunch.end), afterSlot: lunch.afterSlot }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* List layout                                                         */
/* ------------------------------------------------------------------ */

const HEADER_ALIASES = {
  day: ['day', 'weekday'],
  slot: ['slot', 'period'],
  section: ['section', 'sec'],
  subjectcode: ['subjectcode', 'subject', 'code'],
  facultyemail: ['facultyemail', 'faculty', 'email', 'lecturer'],
  kind: ['kind', 'type'],
  title: ['title', 'note'],
};

function parseList(rows) {
  let headerIdx = -1;
  let map = null;

  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const cells = mergeIntoCells(rows[i].items).map((c) => norm(c.text).replace(/\s/g, ''));
    const found = {};
    cells.forEach((c, idx) => {
      for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        if (aliases.includes(c) && found[key] === undefined) found[key] = idx;
      }
    });
    if (found.day !== undefined && found.slot !== undefined && found.subjectcode !== undefined) {
      headerIdx = i;
      map = found;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const cells = mergeIntoCells(rows[i].items).map((c) => c.text.trim());
    const get = (k) => (map[k] !== undefined ? cells[map[k]] || '' : '');
    if (!get('day')) continue;
    records.push({
      __line: i + 1,
      day: get('day'),
      slot: get('slot'),
      section: get('section'),
      subjectcode: get('subjectcode'),
      subjectname: '',
      facultyemail: get('facultyemail'),
      facultyname: '',
      kind: get('kind') || 'lecture',
      title: get('title'),
    });
  }
  return records.length ? records : null;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function parseTimetablePDF(buffer, catalogue = {}) {
  const items = await extractItems(buffer);
  if (!items.length) {
    throw new Error(
      'No text could be read from that PDF. If it is a scan or a photo the text is not selectable — export the timetable from the original document instead.'
    );
  }

  const rows = groupIntoRows(items);

  const list = parseList(rows);
  if (list) {
    return { layout: 'list', records: list, periods: null, lunch: null, legend: [], hasSections: true };
  }

  const header = findColumns(rows);
  if (!header) {
    throw new Error(
      'The timetable grid could not be recognised. It needs a row of weekday headings (Monday, Tuesday …) and a column of period times such as 9:00-10:00.'
    );
  }

  // The legend, if present, both ends the grid and names the lecturers.
  let legendAt = findLegendRow(rows, header.headerRowIndex + 1);
  let legend = legendAt ? readLegend(rows, legendAt.index + 1, legendAt) : [];

  /*
   * Some institutes print the same subject/faculty table with no "Subject" /
   * "Faculty" heading at all - just the pairs, straight after the grid. A
   * table needs no label to be read, only its own two columns, so the same
   * legend is looked for in that shape before giving up on it. Without this,
   * every one of those subjects stays unknown, and every cell naming one
   * comes back as a bare event instead of the lecture it actually is.
   */
  if (!legendAt) {
    const anchors = findAnchors(rows, header);
    const fallback = findHeaderlessLegend(rows, estimateGridEnd(anchors));
    if (fallback) {
      legendAt = { index: fallback.startIndex };
      legend = fallback.legend;
    }
  }

  // Subjects printed in the legend are known even if they are not yet in the
  // database — that is how a first upload can name its own subjects.
  const known = [...(catalogue.subjectNames || [])];
  for (const l of legend) {
    if (!known.some((k) => norm(k.name) === norm(l.subject))) {
      known.push({ name: l.subject, code: null, facultyName: l.faculty });
    } else {
      const hit = known.find((k) => norm(k.name) === norm(l.subject));
      if (hit && !hit.facultyName) hit.facultyName = l.faculty;
    }
  }

  const { records, periods, lunch } = parseGrid(
    rows,
    header,
    { ...catalogue, subjectNames: known },
    legendAt?.index
  );

  return {
    layout: 'grid',
    columns: header.columns.map((c) => ({ day: c.day, section: c.section })),
    hasSections: header.hasSections,
    periods,
    lunch,
    legend,
    records,
  };
}

/**
 * What a roster column heading means.
 *
 * Real rosters do not label columns "rollNumber" — they say "SRMU Roll No.",
 * "SITARE Email", "Students Name". Matching on a keyword rather than an exact
 * string is what lets an ordinary institute file load without being rewritten
 * first. Order matters: "email" and "roll" are checked before the looser
 * "name" so a heading like "Name of Student" cannot swallow another column.
 */
function rosterFieldFor(heading) {
  const h = norm(heading);
  if (!h) return null;
  if (h.includes('email') || /\bmail\b/.test(h)) return 'email';
  if (h.includes('roll') || h.includes('registration') || h.includes('enrol')) return 'rollnumber';
  if (h.includes('section') || /\bsec\b/.test(h)) return 'section';
  if (h.includes('batch') || /\byear\b/.test(h)) return 'batch';
  if (h.includes('name')) return 'name';
  return null; // an ID, a serial number, a phone — read past it
}

/**
 * True when a row is the column headings repeated at the top of a later page.
 * Compared by meaning rather than exact text, so "SITARE Email" on page 1 and
 * "Email ID" on page 2 are both recognised.
 */
function isRepeatedHeader(row) {
  const filled = ['name', 'email', 'rollnumber', 'section', 'batch'].filter((f) => row[f]);
  if (!filled.length) return false;
  // Each value must name the very column it sits in — "Students Name" under
  // the name column. A real student's data never describes its own heading.
  return filled.every((f) => rosterFieldFor(row[f]) === f);
}

/**
 * Student roster PDF.
 *
 * Columns are located by the x-position of their heading and every run is
 * binned into the column it is drawn under, exactly as the timetable grid is
 * read. Reading by cell index instead would let an unrelated column — an ERP
 * ID sitting between the name and the roll number — shift everything after it.
 */
export async function parseStudentsPDF(buffer) {
  const items = await extractItems(buffer);
  if (!items.length) throw new Error('No text could be read from that PDF.');

  const rows = groupIntoRows(items);

  let headerIdx = -1;
  let columns = null;
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const cells = mergeIntoCells(rows[i].items);
    const mapped = cells.map((c) => ({
      field: rosterFieldFor(c.text),
      centre: c.x + c.width / 2,
      text: c.text,
    }));
    const fields = new Set(mapped.map((m) => m.field).filter(Boolean));
    // A header is anything that names who the row is about plus how to reach
    // or identify them.
    if (fields.has('name') && (fields.has('email') || fields.has('rollnumber'))) {
      headerIdx = i;
      columns = mapped;
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error(
      'Could not find a header row. The PDF needs a row of column headings — something naming the student, plus their email or roll number.'
    );
  }

  // Every heading defines a band, including ones we do not use, so their
  // contents cannot drift into a neighbour.
  columns.sort((a, b) => a.centre - b.centre);
  const bounds = [];
  for (let i = 0; i < columns.length - 1; i += 1) {
    bounds.push((columns[i].centre + columns[i + 1].centre) / 2);
  }
  const columnFor = (x) => {
    let i = 0;
    while (i < bounds.length && x >= bounds[i]) i += 1;
    return i;
  };

  const records = [];
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const cells = columns.map(() => []);
    for (const it of rows[i].items) {
      const idx = columnFor(it.x + it.width / 2);
      if (idx >= 0 && idx < cells.length) cells[idx].push(it.text);
    }

    const value = (field) => {
      const idx = columns.findIndex((c) => c.field === field);
      return idx === -1 ? '' : cells[idx].join(' ').replace(/\s+/g, ' ').trim();
    };

    const row = {
      name: value('name'),
      email: value('email'),
      rollnumber: value('rollnumber'),
      section: value('section'),
      batch: value('batch'),
    };
    if (!row.name && !row.email && !row.rollnumber) continue;

    /*
     * A roster longer than one page repeats its headings at the top of each
     * page. Those are not students, and reporting them as unreadable rows
     * makes a clean import look like it half-failed.
     */
    if (isRepeatedHeader(row)) continue;

    /*
     * A tall cell can wrap onto its own line, which arrives here as a row
     * carrying only part of a student. Anything with no email and no roll
     * number belongs to the entry above it.
     */
    const previous = records[records.length - 1];
    if (previous && !row.email && !row.rollnumber) {
      previous.name = `${previous.name} ${row.name}`.trim();
      continue;
    }

    records.push({ __line: i + 1, ...row });
  }

  if (!records.length) throw new Error('No student rows were found under the header.');
  return records;
}
