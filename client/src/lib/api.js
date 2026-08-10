const TOKEN_KEY = 'sitare_erp_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A 5xx carrying no JSON body did not come from the API — our error handler
 * always sends a message. It came from the dev proxy because the server was
 * unreachable, which in practice means it was restarting between the request
 * leaving and the reply coming back.
 */
const serverUnreachable = (res, payload) => res.status >= 500 && !payload;

/**
 * @param {object} opts
 * @param {boolean} [opts.repeatable]
 *   Safe to send twice. True for reads; set it on a write only when running it
 *   again cannot double anything up — a parse-and-return preview, a dry run.
 *   A restart mid-flight is then invisible instead of an error the user has to
 *   understand and retry by hand.
 */
async function request(path, { method = 'GET', body, form, signal, repeatable } = {}) {
  const token = tokenStore.get();

  // FormData sets its own multipart boundary — never set Content-Type for it.
  const requestBody = form ?? (body ? JSON.stringify(body) : undefined);
  const canRepeat = repeatable ?? method === 'GET';

  const send = () =>
    fetch(`/api${path}`, {
      method,
      signal,
      headers: {
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    });

  let res = await send();
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  // One quiet retry, long enough for a restarting server to bind its port.
  if (canRepeat && serverUnreachable(res, payload)) {
    await wait(1200);
    res = await send();
    payload = null;
    try {
      payload = await res.json();
    } catch {
      /* still nothing */
    }
  }

  if (!res.ok) {
    // An expired/invalid session should bounce the user to login once.
    if (res.status === 401 && token) {
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }

    const message =
      payload?.message ||
      (res.status >= 500
        ? 'The server did not respond. It may be restarting — wait a moment and try again.'
        : `Request failed (${res.status})`);

    throw new ApiError(message, res.status, payload?.details);
  }

  return payload?.data ?? payload;
}

/**
 * Pull a stored file and hand it to the browser.
 *
 * It cannot be a plain link: the session is a bearer token in localStorage,
 * not a cookie, so the browser would fetch it signed out.
 */
async function downloadBlob(path, filename) {
  const res = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${tokenStore.get()}` },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(payload?.message || 'That file could not be opened', res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a later tick; revoking immediately cancels the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),

  subjects: () => request('/subjects'),
  subjectDetail: (id) => request(`/subjects/${id}`),

  myAttendance: () => request('/attendance/me'),
  mySubject: (id) => request(`/attendance/me/subject/${id}`),

  sessions: (subjectId) => request(`/attendance/subject/${subjectId}/sessions`),
  occurrences: (subjectId) => request(`/attendance/subject/${subjectId}/occurrences`),
  sheet: (subjectId, date, slot = 1) =>
    request(`/attendance/subject/${subjectId}/sheet?date=${date}&slot=${slot}`),
  mark: (subjectId, payload) =>
    request(`/attendance/subject/${subjectId}/mark`, { method: 'POST', body: payload }),
  cancelSession: (sessionId, cancelled) =>
    request(`/attendance/session/${sessionId}/cancel`, { method: 'PATCH', body: { cancelled } }),
  deleteSession: (sessionId) => request(`/attendance/session/${sessionId}`, { method: 'DELETE' }),

  studentAttendance: (studentId) => request(`/attendance/student/${studentId}`),

  /* ---- Timetable ---- */
  timetableMeta: () => request('/timetable/meta'),
  week: (date, { section, semester } = {}) =>
    request(
      `/timetable/week?date=${date}${section ? `&section=${section}` : ''}${
        semester ? `&semester=${semester}` : ''
      }`
    ),
  timetableVersions: () => request('/timetable/versions'),

  /** Accepts a PDF File, or pasted text as a fallback. */
  previewTimetable: ({ file, csv, semester }) => {
    const form = new FormData();
    form.append('semester', String(semester));
    if (file) form.append('file', file);
    if (csv) form.append('csv', csv);
    // Parses and returns; writes nothing, so a restart can be ridden out.
    return request('/timetable/preview', { method: 'POST', form, repeatable: true });
  },
  uploadTimetable: ({ file, csv, name, semester, effectiveFrom, publish }) => {
    const form = new FormData();
    form.append('name', name);
    form.append('semester', String(semester));
    form.append('effectiveFrom', effectiveFrom);
    form.append('publish', String(Boolean(publish)));
    if (file) form.append('file', file);
    if (csv) form.append('csv', csv);
    return request('/timetable', { method: 'POST', form });
  },
  /** Correct what a period says — admin only; changes land everywhere. */
  editEntry: (entryId, payload) =>
    request(`/timetable/entries/${entryId}`, { method: 'PATCH', body: payload }),

  /** Who may mark a period's register — admin only. */
  attendanceCandidates: (entryId, date) =>
    request(`/timetable/entries/${entryId}/attendance?date=${date}`),
  setAttendanceBy: (entryId, payload) =>
    request(`/timetable/entries/${entryId}/attendance`, { method: 'PATCH', body: payload }),

  publishTimetable: (id) => request(`/timetable/${id}/publish`, { method: 'PATCH' }),
  deleteTimetable: (id) => request(`/timetable/${id}`, { method: 'DELETE' }),

  /* ---- Schedule changes ---- */
  freeSlots: (date) => request(`/schedule/free-slots?date=${date}`),
  bookableSubjects: (sectionId) =>
    request(`/schedule/bookable-subjects${sectionId ? `?section=${sectionId}` : ''}`),
  bookExtra: (payload) => request('/schedule/extra', { method: 'POST', body: payload }),
  moveClass: (payload) => request('/schedule/move', { method: 'POST', body: payload }),
  cancelClass: (payload) => request('/schedule/cancel', { method: 'POST', body: payload }),
  undoChange: (id) => request(`/schedule/changes/${id}`, { method: 'DELETE' }),
  scheduleChanges: () => request('/schedule/changes'),

  /* ---- Swaps ---- */
  swaps: (status) => request(`/swaps${status ? `?status=${status}` : ''}`),
  swapCandidates: (entryId, date) =>
    request(`/swaps/candidates?entryId=${entryId}&date=${date}`),
  createSwap: (payload) => request('/swaps', { method: 'POST', body: payload }),
  decideSwap: (id, approve, note = '') =>
    request(`/swaps/${id}/decide`, { method: 'PATCH', body: { approve, note } }),
  acceptSwap: (id) => request(`/swaps/${id}/accept`, { method: 'PATCH', body: {} }),
  declineSwap: (id) => request(`/swaps/${id}/decline`, { method: 'PATCH', body: {} }),
  withdrawSwap: (id) => request(`/swaps/${id}/withdraw`, { method: 'PATCH', body: {} }),

  /* ---- Administration ---- */
  adminOverview: () => request('/admin/overview'),

  adminUsers: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/admin/users${q ? `?${q}` : ''}`);
  },
  adminFaculty: () => request('/admin/faculty'),
  createUser: (payload) => request('/admin/users', { method: 'POST', body: payload }),
  updateUser: (id, payload) => request(`/admin/users/${id}`, { method: 'PATCH', body: payload }),
  setUserStatus: (id, isActive) =>
    request(`/admin/users/${id}/status`, { method: 'PATCH', body: { isActive } }),
  deleteUser: (id) => request(`/admin/users/${id}`, { method: 'DELETE' }),
  importStudents: ({ file, csv, semester, sectionId, dryRun }) => {
    const form = new FormData();
    form.append('semester', String(semester));
    form.append('dryRun', String(Boolean(dryRun)));
    if (sectionId) form.append('sectionId', sectionId);
    if (file) form.append('file', file);
    if (csv) form.append('csv', csv);
    // A dry run only reports what it would do — safe to send again.
    return request('/admin/users/import', { method: 'POST', form, repeatable: Boolean(dryRun) });
  },

  /* ---- Notes: course material shared with a cohort ---- */
  notes: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/notes${q ? `?${q}` : ''}`);
  },
  publishNote: ({ title, description, semester, sectionId, subjectId, files }) => {
    const form = new FormData();
    form.append('title', title);
    form.append('description', description || '');
    form.append('semester', String(semester));
    if (sectionId) form.append('sectionId', sectionId);
    if (subjectId) form.append('subjectId', subjectId);
    for (const f of files || []) form.append('files', f);
    return request('/notes', { method: 'POST', form });
  },
  deleteNote: (id) => request(`/notes/${id}`, { method: 'DELETE' }),
  downloadNoteFile: (noteId, attachmentId, filename) =>
    downloadBlob(`/notes/${noteId}/attachments/${attachmentId}`, filename),

  /* ---- Leave applications ---- */
  /** A student's own. */
  myLeave: () => request('/leave/me'),
  submitLeave: ({ reason, details, leaveFrom, leaveTo, files }) => {
    const form = new FormData();
    form.append('reason', reason);
    form.append('details', details || '');
    if (leaveFrom) form.append('leaveFrom', leaveFrom);
    if (leaveTo) form.append('leaveTo', leaveTo);
    for (const f of files || []) form.append('files', f);
    return request('/leave', { method: 'POST', form });
  },
  deleteLeave: (docId) => request(`/leave/${docId}`, { method: 'DELETE' }),

  /** Administration: one student in full, and what they have applied for. */
  studentProfile: (id) => request(`/admin/students/${id}`),
  leaveDocuments: (studentId) => request(`/admin/students/${studentId}/leave`),

  downloadAttachment: (docId, attachmentId, filename) =>
    downloadBlob(`/leave/${docId}/attachments/${attachmentId}`, filename),

  adminSections: () => request('/admin/sections'),
  createSection: (payload) => request('/admin/sections', { method: 'POST', body: payload }),
  updateSection: (id, payload) =>
    request(`/admin/sections/${id}`, { method: 'PATCH', body: payload }),
  deleteSection: (id) => request(`/admin/sections/${id}`, { method: 'DELETE' }),

  adminSubjects: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    ).toString();
    return request(`/admin/subjects${q ? `?${q}` : ''}`);
  },
  createSubject: (payload) => request('/admin/subjects', { method: 'POST', body: payload }),
  updateSubject: (id, payload) =>
    request(`/admin/subjects/${id}`, { method: 'PATCH', body: payload }),
  deleteSubject: (id) => request(`/admin/subjects/${id}`, { method: 'DELETE' }),
  subjectRoster: (id) => request(`/admin/subjects/${id}/roster`),
  setEnrolment: (id, studentIds, action) =>
    request(`/admin/subjects/${id}/roster`, { method: 'PATCH', body: { studentIds, action } }),

  /* ---- Notifications ---- */
  notifications: (limit = 30) => request(`/notifications?limit=${limit}`),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'PATCH', body: {} }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'PATCH', body: {} }),
};
