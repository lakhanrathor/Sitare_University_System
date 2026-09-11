import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditLog } from '../utils/audit.js';
import { idOf, isUuid } from '../utils/ids.js';

export function signToken(user) {
  return jwt.sign({ sub: idOf(user), role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

/** Requires a valid Bearer token; attaches the live user document to req.user. */
export const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    auditLog('auth_failed', { reason: 'missing_token', path: req.originalUrl });
    throw ApiError.unauthorized('Authentication token missing');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    auditLog('auth_failed', { reason: 'invalid_token', path: req.originalUrl });
    throw ApiError.unauthorized('Session expired or invalid. Please sign in again.');
  }

  /*
   * A token issued before this module moved to Postgres carries an ObjectId,
   * which is not a uuid and would make the query raise rather than miss. It is
   * an expired session, so say so.
   */
  if (!isUuid(payload.sub)) {
    auditLog('auth_failed', { reason: 'stale_token_id', path: req.originalUrl });
    throw ApiError.unauthorized('Session expired or invalid. Please sign in again.');
  }

  // Section is included because nearly every timetable view needs its name.
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { section: { select: { id: true, name: true, semester: true } } },
  });
  if (!user || !user.isActive) {
    auditLog('auth_failed', { reason: 'disabled_or_missing_account', userId: payload.sub });
    throw ApiError.unauthorized('Account not found or disabled');
  }

  req.user = user;
  next();
});

/** Restricts a route to one or more roles. Use after `protect`. */
export const authorize =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      auditLog('authorization_denied', {
        userId: idOf(req.user),
        role: req.user.role,
        required: roles,
        path: req.originalUrl,
      });
      return next(ApiError.forbidden(`This action requires: ${roles.join(' or ')}`));
    }
    next();
  };
