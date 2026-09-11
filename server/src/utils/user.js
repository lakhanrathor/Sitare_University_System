/**
 * What a User record means, as plain functions rather than document methods.
 *
 * These were `userSchema.methods.*`. A method only exists on a hydrated
 * Mongoose document, which silently divides every read into two kinds: a
 * `.lean()` row has the same data but cannot answer `user.sectionId()`, and a
 * populated `req.user.section` and a bare ObjectId behave differently again.
 * A free function takes whatever shape the caller happens to hold, so the
 * caller never has to know which kind of read produced it.
 */
import bcrypt from 'bcryptjs';
import { idOf } from './ids.js';

/** The public shape of a person — never the password hash, never internals. */
export function safeUser(user) {
  if (!user) return null;
  const { name, email, role, rollNumber, employeeId, batch, semester, department, section } = user;
  return {
    id: idOf(user),
    name,
    email,
    role,
    rollNumber,
    employeeId,
    batch,
    semester,
    department,
    // Always the same shape, whether `section` was populated or left as an id.
    section: section ? { id: idOf(section), name: section.name ?? null } : null,
  };
}

/**
 * True if `plain` is this account's password.
 *
 * `password` is `select: false`, so a user read the ordinary way carries no
 * hash at all. Comparing against `undefined` would make bcrypt throw rather
 * than return false, and the thrown error reads as a server fault instead of
 * a bad password — so say plainly that the caller forgot `.select('+password')`.
 */
export function checkPassword(user, plain) {
  if (!user?.password) {
    throw new Error('checkPassword: the user was read without its password — use .select("+password")');
  }
  return bcrypt.compare(plain, user.password);
}

/** The section id, however the field was read. */
export function sectionIdOf(user) {
  return idOf(user?.section);
}
