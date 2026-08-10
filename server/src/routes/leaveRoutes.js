import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { uploadDocuments } from '../middleware/upload.js';
import {
  listMyLeave,
  submitLeave,
  downloadAttachment,
  deleteLeave,
} from '../controllers/leaveController.js';

const router = Router();
router.use(protect);

/* A student's own applications. */
router.get('/me', authorize('student'), listMyLeave);
router.post('/', authorize('student'), uploadDocuments(), submitLeave);

/*
 * Shared by the student who wrote it and the administration that reads it —
 * the controller checks ownership, since a student must never reach another
 * student's application.
 */
router.get('/:docId/attachments/:attachmentId', downloadAttachment);
router.delete('/:docId', deleteLeave);

export default router;
