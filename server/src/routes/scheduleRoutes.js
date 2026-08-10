import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  listFreeSlots,
  listBookableSubjects,
  bookExtraClass,
  moveClass,
  cancelClass,
  undoChange,
  listChanges,
  extraClassSchema,
  moveClassSchema,
  cancelClassSchema,
} from '../controllers/scheduleController.js';

const router = Router();
router.use(protect);

router.get('/free-slots', listFreeSlots);
router.get('/changes', listChanges);

const staff = authorize('faculty', 'admin');

router.get('/bookable-subjects', staff, listBookableSubjects);
router.post('/extra', staff, validate(extraClassSchema), bookExtraClass);
router.post('/move', staff, validate(moveClassSchema), moveClass);
router.post('/cancel', staff, validate(cancelClassSchema), cancelClass);
router.delete('/changes/:changeId', staff, undoChange);

export default router;
