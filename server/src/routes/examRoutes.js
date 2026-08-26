import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { uploadDocuments } from '../middleware/upload.js';
import {
  listExams,
  publishExam,
  downloadExamFile,
  deleteExam,
} from '../controllers/examController.js';

const router = Router();
router.use(protect);

/* Students see their own year's; staff see all of them. */
router.get('/', listExams);
router.get('/:examId/attachments/:attachmentId', downloadExamFile);

/* Publishing is the administration's — teachers are told, not consulted. */
router.post('/', authorize('admin'), uploadDocuments(), publishExam);
router.delete('/:examId', authorize('admin'), deleteExam);

export default router;
