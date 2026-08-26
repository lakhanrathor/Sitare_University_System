import ApiError from '../utils/ApiError.js';
import { env } from '../config/env.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

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
