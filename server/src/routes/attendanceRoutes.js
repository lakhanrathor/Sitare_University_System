import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  getMyAttendance,
  getMySubjectHistory,
  getStudentAttendance,
  listSessions,
  listSubjectOccurrences,
  getAttendanceSheet,
  markAttendance,
  setSessionCancelled,
  deleteSession,
  markAttendanceSchema,
  cancelSessionSchema,
} from '../controllers/attendanceController.js';

const router = Router();

router.use(protect);

/* Student */
router.get('/me', getMyAttendance);
router.get('/me/subject/:subjectId', getMySubjectHistory);

/* Faculty & admin */
router.get('/student/:studentId', authorize('faculty', 'admin'), getStudentAttendance);

router.get('/subject/:subjectId/sessions', authorize('faculty', 'admin'), listSessions);
router.get(
  '/subject/:subjectId/occurrences',
  authorize('faculty', 'admin'),
  listSubjectOccurrences
);
router.get('/subject/:subjectId/sheet', authorize('faculty', 'admin'), getAttendanceSheet);
router.post(
  '/subject/:subjectId/mark',
  authorize('faculty', 'admin'),
  validate(markAttendanceSchema),
  markAttendance
);

router.patch(
  '/session/:sessionId/cancel',
  authorize('faculty', 'admin'),
  validate(cancelSessionSchema),
  setSessionCancelled
);
router.delete('/session/:sessionId', authorize('faculty', 'admin'), deleteSession);

export default router;
