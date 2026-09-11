/**
 * The kinds of exam a schedule can be published for.
 *
 * Read by the request schema and enforced again by a CHECK constraint on the
 * column, so a value that never passed validation cannot arrive by any other
 * route either.
 */
export const EXAM_TYPES = ['mid-term', 'end-term', 'practical', 're-exam', 'other'];
