import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { protect } from '../middleware/auth.js';
import {
  login,
  me,
  changePassword,
  loginSchema,
  changePasswordSchema,
} from '../controllers/authController.js';

const router = Router();

/**
 * Brute-force protection keyed on the account being targeted rather than the
 * network address. A college sits behind a handful of shared IPs, so limiting
 * purely by IP would lock out an entire campus because one person mistyped
 * their password. Successful logins are not counted — only failures.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '')
      .toLowerCase()
      .trim();
    return email ? `email:${email}` : `ip:${req.ip}`;
  },
  message: {
    success: false,
    message: 'Too many failed attempts for this account. Try again in 15 minutes.',
  },
});

router.post('/login', loginLimiter, validate(loginSchema), login);
router.get('/me', protect, me);
router.patch('/password', protect, validate(changePasswordSchema), changePassword);

export default router;
