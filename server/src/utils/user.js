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

/**
 * The public shape of a person — never the password hash, never internals.
 *
 * Fields that have no value are left out rather than sent as null. That is not
 * cosmetic: a Mongoose document simply has no `rollNumber` property for a
 * lecturer, so JSON.stringify dropped the key, while a database row has the
 * column with NULL in it. Emitting it would silently change the response body
 * for every account in the system — a key appearing where there was none is
 * exactly the kind of contract drift a client can be reading with `in` or
 * Object.keys. `section` is the deliberate exception: it has always been sent,
 * as null when there isn't one.
 */
export function safeUser(user) {
  if (!user) return null;
  const { name, email, role, rollNumber, employeeId, batch, semester, department, section } = user;
  const out = {
    id: idOf(user),
    name,
    email,
    role,
    // Always the same shape, whether `section` was populated or left as an id.
    section: section ? { id: idOf(section), name: section.name ?? null } : null,
  };
  const optional = { rollNumber, employeeId, batch, semester, department };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
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
  /*
   * A Prisma row carries the foreign key as a scalar whether or not the
   * relation was included, so it is both the cheaper and the more reliable
   * answer; a Mongoose document only has the populated object or a raw id.
   */
  if (user?.sectionId !== undefined) return user.sectionId;
  return idOf(user?.section);
}

/*
 * Hashing was a Mongoose pre-save hook, which meant every write path got it
 * for free and no write path could see it. Prisma has no hook, so it is a
 * call — and the cost of forgetting one is storing a plaintext password, so
 * there is exactly one function and every password write goes through it.
 */
const ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}
