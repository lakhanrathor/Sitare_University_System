import mongoose from 'mongoose';
import { Readable } from 'stream';
import ApiError from '../utils/ApiError.js';

/**
 * Attachment storage, on GridFS.
 *
 * Kept in Mongo rather than on disk so there is no upload directory to create,
 * secure or back up separately, and nothing to lose when the server moves. At
 * the scale this runs at — a few hundred leave applications a semester — the
 * simplicity is worth more than object storage would be.
 */
const BUCKET = 'attachments';

const bucket = () => {
  const db = mongoose.connection?.db;
  if (!db) throw new Error('Database connection is not ready');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
};

/** Store one uploaded buffer, returning what the parent document should keep. */
export function putFile({ buffer, filename, contentType, meta = {} }) {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, {
      contentType: contentType || 'application/octet-stream',
      metadata: meta,
    });
    Readable.from(buffer)
      .pipe(upload)
      .on('error', reject)
      .on('finish', () =>
        resolve({
          fileId: upload.id,
          filename,
          contentType: contentType || 'application/octet-stream',
          size: buffer.length,
        })
      );
  });
}

/** A readable stream for sending a stored file back to the browser. */
export async function openFile(fileId) {
  const id = new mongoose.Types.ObjectId(String(fileId));
  const [file] = await bucket().find({ _id: id }).limit(1).toArray();
  if (!file) throw ApiError.notFound('That file is no longer stored');
  return { file, stream: bucket().openDownloadStream(id) };
}

/**
 * Remove stored files. Deleting a document must not fail because a file was
 * already gone, so a missing id is not an error.
 */
export async function deleteFiles(fileIds = []) {
  for (const id of fileIds) {
    try {
      await bucket().delete(new mongoose.Types.ObjectId(String(id)));
    } catch {
      /* already removed */
    }
  }
}
