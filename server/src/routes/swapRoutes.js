import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createSwap,
  listSwaps,
  decideSwap,
  acceptSwap,
  declineSwap,
  withdrawSwap,
  listSwapCandidates,
  createSwapSchema,
  decideSwapSchema,
} from '../controllers/swapController.js';

const router = Router();
router.use(protect, authorize('faculty', 'admin'));

router.get('/', listSwaps);
router.get('/candidates', listSwapCandidates);
router.post('/', validate(createSwapSchema), createSwap);

/* Only an admin can apply a swap to the live timetable. */
router.patch('/:swapId/decide', authorize('admin'), validate(decideSwapSchema), decideSwap);

/* Stage one: the lecturer being asked agrees, or refuses. */
router.patch('/:swapId/accept', acceptSwap);
router.patch('/:swapId/decline', declineSwap);
router.patch('/:swapId/withdraw', withdrawSwap);

export default router;
