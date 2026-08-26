import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { protect } from '../middleware/auth.js';
import {
  login,
  googleLogin,
  me,
  changePassword,
  loginSchema,
  googleLoginSchema,
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

/*
 * A Google credential cannot be brute-forced the way a password can — there
 * is no guessable secret, only a signed token Google issued — so this exists
 * to cap verification cost under abuse, not to catch guessing. Keyed by IP
 * since the email is not known until the token is verified.
 */
const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

router.post('/login', loginLimiter, validate(loginSchema), login);
router.post('/google', googleLoginLimiter, validate(googleLoginSchema), googleLogin);
router.get('/me', protect, me);
router.patch('/password', protect, validate(changePasswordSchema), changePassword);

export default router;
