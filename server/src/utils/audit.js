/**
 * One place for security-relevant events — failed logins, authorization
 * refusals, admin writes, file operations — so they land in a single
 * greppable shape instead of scattered ad hoc console lines.
 *
 * Never pass a password, token, or raw request body here: only ids, roles
 * and outcomes. `details` is logged as-is, so that discipline lives with each
 * call site, not in this function.
 */
export function auditLog(event, details = {}) {
  console.log(JSON.stringify({ audit: true, event, at: new Date().toISOString(), ...details }));
}
