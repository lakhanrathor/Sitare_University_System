/**
 * What the two attendance states are, and which of them counts as attended.
 *
 * A list rather than a single value because "present" has had company before —
 * a 'late' state existed at one point and counted toward attendance. Keeping
 * the distinction between "the states that exist" and "the states that count"
 * means restoring something like that is one entry here rather than a hunt
 * through every place a status is compared.
 *
 * Lives in config rather than on a model so that both the database layer and
 * the request validation can read it without either importing the other.
 */
export const ATTENDANCE_STATUS = ['present', 'absent'];
export const PRESENT_STATUSES = ['present'];
