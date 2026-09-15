import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  listNotifications,
  markRead,
  markAllRead,
  pushConfig,
  subscribePush,
  subscribeSchema,
  unsubscribePush,
  unsubscribeSchema,
} from '../controllers/notificationController.js';

const router = Router();
router.use(protect);

router.get('/', listNotifications);

/* Browser push. Declared before '/:id/read' so neither path can shadow it. */
router.get('/push/config', pushConfig);
router.post('/push/subscribe', validate(subscribeSchema), subscribePush);
router.post('/push/unsubscribe', validate(unsubscribeSchema), unsubscribePush);

router.patch('/read-all', markAllRead);
router.patch('/:id/read', markRead);

export default router;
