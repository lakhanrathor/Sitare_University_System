import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { uploadPdf } from '../middleware/upload.js';
import {
  getMeta,
  getWeekGrid,
  listTimetables,
  previewUpload,
  uploadTimetable,
  publishTimetable,
  deleteTimetable,
  downloadTemplate,
  listAttendanceCandidates,
  setAttendanceBy,
  editEntry,
} from '../controllers/timetableController.js';

const router = Router();
router.use(protect);

/* Everyone signed in can read the grid. */
router.get('/meta', getMeta);
router.get('/week', getWeekGrid);

/* Admin-only management. */
router.get('/template', authorize('admin'), downloadTemplate);
router.get('/versions', authorize('admin'), listTimetables);
/* Both accept a PDF upload or pasted text; validation happens in the controller
   because a multipart body cannot be shape-checked before it is parsed. */
router.post('/preview', authorize('admin'), uploadPdf(), previewUpload);
router.post('/', authorize('admin'), uploadPdf(), uploadTimetable);
/* Correcting what a period says — a subject's real name, its lecturer, its kind. */
router.patch('/entries/:entryId', authorize('admin'), editEntry);

/* Handing a period's register to a stand-in — the admin's job, not a teacher's. */
router.get('/entries/:entryId/attendance', authorize('admin'), listAttendanceCandidates);
router.patch('/entries/:entryId/attendance', authorize('admin'), setAttendanceBy);

router.patch('/:timetableId/publish', authorize('admin'), publishTimetable);
router.delete('/:timetableId', authorize('admin'), deleteTimetable);

export default router;
