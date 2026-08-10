import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { listSubjects, getSubjectDetail } from '../controllers/subjectController.js';

const router = Router();

router.use(protect);

// Role-aware: students get their enrolled subjects, faculty get theirs, admin all.
router.get('/', listSubjects);
router.get('/:subjectId', authorize('faculty', 'admin'), getSubjectDetail);

export default router;
