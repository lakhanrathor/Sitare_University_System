import ApiError from '../utils/ApiError.js';

/** Validates req[source] against a zod schema and replaces it with parsed data. */
export const validate =
  (schema, source = 'body') =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      return next(ApiError.badRequest('Validation failed', details));
    }
    if (source === 'body') req.body = result.data;
    else req.validated = result.data;
    next();
  };
