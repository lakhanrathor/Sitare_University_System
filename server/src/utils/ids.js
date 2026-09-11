/**
 * Identity comparison for database references.
 *
 * A reference arrives in three shapes depending on how it was read: the scalar
 * foreign key on a row (`subject.facultyId`), an included relation
 * (`subject.faculty`), or the string an HTTP request sent. Comparing two of
 * them used to be written `String(a) === String(b)`, which works only because
 * all three stringify the same way. It has one fatal property: when a field
 * name is wrong or a value is missing, both sides become the string
 * `"undefined"` and the comparison returns **true**. Every such site is an
 * authorization check — "is this note mine", "is this my subject" — so failing
 * that way means silently granting access rather than raising an error anyone
 * would notice.
 *
 * `sameId` fails closed instead: two absent ids are never the same id.
 */

/** The comparable identity of a reference, or null if there isn't one. */
export function idOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.id === 'string') return value.id;
  return String(value);
}

/** True only when both sides name the same, existing record. */
export function sameId(a, b) {
  const x = idOf(a);
  const y = idOf(b);
  return x != null && y != null && x === y;
}

/*
 * Whether a string is shaped like a uuid.
 *
 * Every primary key is a native `uuid` column, and handing one of those
 * anything else raises P2023 — a 500 that reads as a server fault rather than
 * what it is, a reference to something that cannot exist. Checking the shape
 * first turns a bad id in a URL into the 401 or 404 it should have been.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}
