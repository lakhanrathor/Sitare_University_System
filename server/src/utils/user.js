/**
 * What a User record means, as plain functions rather than document methods.
 *
 * A plain function takes whatever shape the caller happens to hold — a row
 * with only its scalar foreign keys, or one with the section relation included
 * — so no caller has to know which kind of read produced it. Anything that
 * only worked on one of those shapes would divide every read in two.
 */
import bcrypt from 'bcryptjs';
import { idOf } from './ids.js';

/**
 * The public shape of a person — never the password hash, never internals.
 *
 * Fields that have no value are left out rather than sent as null, because a
 * row carries every column whether or not it means anything for that role — a
 * lecturer has a `rollNumber` column holding NULL. Sending those would put a
 * key in the response for every account in the system where there was none,
 * which is exactly the kind of contract drift a client reading with `in` or
 * Object.keys would trip over. `section` is the deliberate exception: it is
 * always sent, as null when there isn't one.
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
   * The scalar foreign key is there whether or not the relation was included,
   * so it is both the cheaper and the more reliable answer; the included
   * object is only a fallback for a caller that shaped one by hand.
   */
  if (user?.sectionId !== undefined) return user.sectionId;
  return idOf(user?.section);
}

/*
 * Every password write goes through this one function. The cost of forgetting
 * it once is a plaintext password in the database, so there is nowhere else
 * that decides the cost factor and nothing that hashes inline.
 */
const ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}
