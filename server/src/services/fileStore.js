import { Readable } from 'stream';
import { prisma } from '../config/prisma.js';
import ApiError from '../utils/ApiError.js';
import { auditLog } from '../utils/audit.js';
import { idOf, isUuid } from '../utils/ids.js';

/**
 * Attachment storage, in the database.
 *
 * Kept there rather than on disk so there is no upload directory to create,
 * secure or back up separately, and nothing to lose when the server moves. At
 * the scale this runs at — a few hundred leave applications a semester — the
 * simplicity is worth more than object storage would be.
 *
 * This was GridFS and is now a `bytea` column in its own table. The three
 * functions keep their exact contracts, including openFile returning a
 * readable stream, so the nine call sites across notes, exams and leave did
 * not change at all. Streaming is not real here and never was: multer already
 * materialises the whole upload in memory on the way in, under a 15 MB cap.
 */

/** Store one uploaded buffer, returning what the parent record should keep. */
export async function putFile({ buffer, filename, contentType }) {
  const type = contentType || 'application/octet-stream';
  const file = await prisma.file.create({
    data: { data: buffer, filename, contentType: type, size: buffer.length },
    select: { id: true },
  });
  auditLog('file_stored', { fileId: file.id, filename, size: buffer.length });
  return { fileId: file.id, filename, contentType: type, size: buffer.length };
}

/** A readable stream for sending a stored file back to the browser. */
export async function openFile(fileId) {
  const id = idOf(fileId);
  /*
   * An id that is not a uuid cannot be a row here, and asking anyway raises
   * P2023 — a 500 that reads as a server fault rather than what it is, a
   * reference to something that is not there.
   */
  if (!isUuid(id)) throw ApiError.notFound('That file is no longer stored');

  const file = await prisma.file.findUnique({ where: { id } });
  if (!file) throw ApiError.notFound('That file is no longer stored');
  auditLog('file_downloaded', { fileId: id });

  return {
    // The same three fields the GridFS document exposed, so callers setting
    // Content-Type and Content-Length are untouched.
    file: { length: file.size, filename: file.filename, contentType: file.contentType },
    /*
     * Wrapped in an array deliberately. Readable.from() treats a Buffer as an
     * iterable of numbers and would emit one integer per byte, which a
     * non-object-mode stream refuses — the download then dies mid-response
     * with the headers already sent. A one-element array makes the whole
     * buffer a single chunk.
     */
    stream: Readable.from([file.data]),
  };
}

/**
 * Remove stored files. Deleting a record must not fail because a file was
 * already gone, so a missing id is not an error.
 */
export async function deleteFiles(fileIds = []) {
  const ids = fileIds.map(idOf).filter(isUuid);
  if (!ids.length) return;
  const { count } = await prisma.file.deleteMany({ where: { id: { in: ids } } });
  ids.forEach((id) => auditLog('file_deleted', { fileId: id }));
  return count;
}
