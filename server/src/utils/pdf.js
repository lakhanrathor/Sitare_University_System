/**
 * PDF text extraction with layout preserved.
 *
 * A timetable PDF is a picture of a table: meaning lives in *where* the text
 * sits, not the order it appears in the file. So every glyph run is captured
 * with its x/y position and then reassembled into rows and columns. Plain text
 * extraction would collapse the grid into an unusable stream.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** pdfjs ships an ESM build that needs no worker when run with disableWorker. */
async function getPdfjs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

/** A PDF we could not read, phrased for the person who uploaded it. */
export class PdfReadError extends Error {
  constructor(cause) {
    const name = cause?.name || '';
    let hint = 'The file could not be read as a PDF. Re-export it and try again.';
    if (name === 'PasswordException') {
      hint = 'This PDF is password protected. Remove the password and upload it again.';
    } else if (name === 'InvalidPDFException') {
      hint = 'This file is not a valid PDF, or it is damaged. Re-export it and try again.';
    }
    super(hint);
    this.name = 'PdfReadError';
    this.cause = cause;
  }
}

/**
 * Every text run on every page, with page number and position.
 *
 * A malformed, encrypted or unusual PDF must fail as a readable message, never
 * as a crash: pdfjs settles promises of its own after we stop awaiting it, and
 * an escaped rejection would take the whole API process down mid-upload.
 */
export async function extractItems(buffer) {
  const pdfjs = await getPdfjs();

  // Keep the loading task: `destroy()` lives on it, not on the document proxy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    // No worker thread in Node — everything runs inline.
    useWorkerFetch: false,
  });

  // Claim the rejection now, so a late one can never surface as unhandled.
  task.promise.catch(() => {});

  const items = [];
  try {
    const doc = await task.promise;

    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      for (const it of content.items) {
        const text = (it.str || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const [, , , , x, y] = it.transform;
        items.push({
          page: pageNo,
          text,
          x,
          // Flip so y grows downwards, matching how the page reads.
          y: viewport.height - y,
          width: it.width || 0,
          height: it.height || 0,
        });
      }
      page.cleanup();
    }
  } catch (err) {
    throw new PdfReadError(err);
  } finally {
    // Releasing the document must not mask the original failure.
    await task.destroy().catch(() => {});
  }

  return items;
}

/**
 * Group text runs into visual rows.
 * Items whose baselines sit within `tolerance` points belong to the same row.
 */
export function groupIntoRows(items, tolerance = 4) {
  const rows = [];

  for (const it of [...items].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)) {
    const row = rows.find(
      (r) => r.page === it.page && Math.abs(r.y - it.y) <= tolerance
    );
    if (row) {
      row.items.push(it);
      // Keep the row's anchor near the mean so drift does not accumulate.
      row.y = (row.y * (row.items.length - 1) + it.y) / row.items.length;
    } else {
      rows.push({ page: it.page, y: it.y, items: [it] });
    }
  }

  return rows.map((r) => ({
    ...r,
    items: r.items.sort((a, b) => a.x - b.x),
    text: r.items
      .sort((a, b) => a.x - b.x)
      .map((i) => i.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

/**
 * Merge runs that sit side by side into single cells.
 * PDF writers split a cell's text into several runs; anything closer than
 * `gap` points horizontally is really one cell.
 */
export function mergeIntoCells(rowItems, gap = 12) {
  const cells = [];
  for (const it of rowItems) {
    const last = cells[cells.length - 1];
    if (last && it.x - (last.x + last.width) <= gap) {
      last.text = `${last.text} ${it.text}`.trim();
      last.width = it.x + it.width - last.x;
    } else {
      cells.push({ x: it.x, width: it.width, text: it.text });
    }
  }
  return cells;
}

/** Convenience: rows of merged cell strings, page by page. */
export async function extractTable(buffer, { rowTolerance = 4, cellGap = 12 } = {}) {
  const items = await extractItems(buffer);
  const rows = groupIntoRows(items, rowTolerance);
  return rows.map((r) => ({
    page: r.page,
    y: r.y,
    cells: mergeIntoCells(r.items, cellGap),
    text: r.text,
  }));
}
