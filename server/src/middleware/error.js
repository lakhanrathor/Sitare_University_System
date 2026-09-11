import ApiError from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

/*
 * Keyed by Prisma's error code rather than matched with a chain of ifs, so
 * adding one is a line rather than a branch. `meta.target` carries the column
 * list for a unique violation, which is what names the field back to the user.
 */
const PRISMA_ERRORS = {
  // Unique constraint: two rows claiming the same email, code, or roll number.
  P2002: (err) =>
    ApiError.conflict(`Duplicate value for: ${[err.meta?.target].flat().filter(Boolean).join(', ')}`),
  // Foreign key constraint: something still points at this row, or the row it
  // points at does not exist.
  P2003: () => ApiError.conflict('That record is still referenced by something else'),
  // An update or delete whose target was not there.
  P2025: (err) => ApiError.notFound(err.meta?.cause || 'Record not found'),
  // A uuid column handed something that is not a uuid.
  P2023: () => ApiError.badRequest('Invalid identifier'),
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  let error = err;

  if (err?.name === 'CastError') {
    error = ApiError.badRequest(`Invalid identifier: ${err.value}`);
  } else if (err?.code === 11000) {
    const field = Object.keys(err.keyValue || {}).join(', ');
    error = ApiError.conflict(`Duplicate value for: ${field}`);
  } else if (err?.name === 'ValidationError') {
    error = ApiError.badRequest(
      'Validation failed',
      Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }))
    );
  } else if (err?.code && Object.hasOwn(PRISMA_ERRORS, err.code)) {
    /*
     * A constraint the database refused, translated into the answer the caller
     * should get. Without these a duplicate email is a 500 rather than a 409,
     * and a malformed id in a URL is a 500 rather than a 400 — both worse
     * answers, and the second an invitation to probe: a 500 says "you broke
     * something", a 400 says "that is not an id".
     */
    error = PRISMA_ERRORS[err.code](err);
  } else if (err?.name === 'PrismaClientValidationError') {
    // A query this code built wrong — an unknown field, a missing argument.
    // Never the caller's fault, so it stays a 500 and keeps its stack.
    error = new ApiError(500, env.isProd ? 'Something went wrong. Please try again.' : err.message);
  } else if (err?.name === 'ZodError' && Array.isArray(err.issues)) {
    /*
     * A schema parsed inside a handler rather than by the validate()
     * middleware — which is how multipart routes have to do it, since a form
     * body cannot be shape-checked before multer has read it. Left alone this
     * surfaces as a 500 with a JSON blob for a message, so the user is told
     * the server broke when in fact they mistyped a date.
     */
    error = ApiError.badRequest(
      err.issues[0]?.message || 'Validation failed',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
    );
  } else if (!(err instanceof ApiError)) {
    /*
     * An error nobody threw on purpose — a driver error, a bug, a native
     * exception — can carry a connection string, a file path, or other
     * internals in `message`. Those are safe to log, never safe to hand back
     * to the browser once this is actually deployed.
     */
    const statusCode = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    const message =
      statusCode >= 500 && env.isProd
        ? 'Something went wrong. Please try again.'
        : err.message || 'Something went wrong';
    error = new ApiError(statusCode, message);
  }

  if (error.statusCode >= 500) console.error('[error]', err);

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(env.isProd ? {} : { stack: err.stack }),
  });
}
