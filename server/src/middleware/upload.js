import multer from 'multer';
import ApiError from '../utils/ApiError.js';

/**
 * PDF uploads are held in memory and parsed straight away — nothing is written
 * to disk, so there is no upload directory to secure or clean up.
 */
const storage = multer.memoryStorage();

const pdfOnly = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /pdf/i.test(file.mimetype) || file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : ApiError.badRequest('Only PDF files can be uploaded'), ok);
  },
});

/** Accepts an optional `file` field; requests without one pass straight through. */
export const uploadPdf = (fieldName = 'file') => (req, res, next) =>
  pdfOnly.single(fieldName)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.badRequest('That PDF is larger than 15 MB'));
    }
    next(err instanceof ApiError ? err : ApiError.badRequest(err.message));
  });

/*
 * Leave applications do not arrive as tidy PDFs. A student photographs a
 * medical certificate, or screenshots the mail — so images are accepted
 * alongside documents. Executables and archives are not: these files are
 * handed back to staff to open, and the list is an allow-list for that reason.
 */
const DOCUMENT_TYPES =
  /^(application\/pdf|image\/(jpeg|png|gif|webp|heic|heif)|text\/(plain|csv|markdown)|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|zip|x-zip-compressed)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))$/i;
const DOCUMENT_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|heic|heif|txt|md|csv|docx?|xlsx?|pptx?|zip|eml|msg)$/i;

const documents = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ok = DOCUMENT_TYPES.test(file.mimetype) || DOCUMENT_EXTENSIONS.test(file.originalname);
    cb(
      ok
        ? null
        : ApiError.badRequest(
            `${file.originalname} is not a document or an image. Attach a PDF, a photo, or a Word file.`
          ),
      ok
    );
  },
});

/** Several attachments on one record — a mail can carry more than one file. */
export const uploadDocuments = (fieldName = 'files', max = 10) => (req, res, next) =>
  documents.array(fieldName, max)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.badRequest('Each file must be 15 MB or smaller'));
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return next(ApiError.badRequest(`Attach at most ${max} files at a time`));
    }
    next(err instanceof ApiError ? err : ApiError.badRequest(err.message));
  });
