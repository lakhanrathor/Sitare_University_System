/**
 * Identity comparison for database references.
 *
 * A reference in this codebase arrives in four shapes depending on how it was
 * read: a populated document, a raw ObjectId, a `.lean()` plain object, or the
 * string an HTTP request sent. The long-standing way to compare two of them was
 * `String(a) === String(b)`, which works only because every one of those shapes
 * stringifies to the same hex. It has one fatal property: when a field name is
 * wrong or a value is missing, both sides become the string `"undefined"` and
 * the comparison returns **true**. Every such site is an authorization check —
 * "is this note mine", "is this my subject" — so failing that way means
 * silently granting access rather than raising an error anyone would notice.
 *
 * `sameId` fails closed instead: two absent ids are never the same id.
 */

/** The comparable identity of a reference, or null if there isn't one. */
export function idOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  /*
   * Checked before `_id`, and with `typeof`, on purpose: a Mongoose ObjectId
   * also carries an `.id` property, but it holds the raw 12-byte Buffer rather
   * than the hex string, so an untyped check here would read the wrong thing.
   */
  if (typeof value.id === 'string') return value.id;
  if (value._id != null) return String(value._id);
  return String(value);
}

/** True only when both sides name the same, existing record. */
export function sameId(a, b) {
  const x = idOf(a);
  const y = idOf(b);
  return x != null && y != null && x === y;
}
