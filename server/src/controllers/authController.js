import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { signToken } from '../middleware/auth.js';
import { auditLog } from '../utils/audit.js';
import { env } from '../config/env.js';

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const googleLoginSchema = z.object({
  // The Google ID token (a signed JWT) — never the role, never anything else.
  credential: z.string().min(1, 'Missing Google credential'),
});

// Built once at startup; verifyIdToken re-checks signature/issuer/audience/
// expiry against Google's live public keys on every call, so nothing about
// trust is cached here beyond the client id itself.
const googleClient = env.googleClientId ? new OAuth2Client(env.googleClientId) : null;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email: email.toLowerCase() })
    .select('+password')
    // Section is populated so the client gets its name on the very first load.
    .populate('section', 'name semester');
  if (!user || !(await user.comparePassword(password))) {
    // Same message either way — confirming an email is registered is its own leak.
    auditLog('login_failed', { email: email.toLowerCase() });
    throw ApiError.unauthorized('Incorrect email or password');
  }
  if (!user.isActive) {
    auditLog('login_blocked', { userId: String(user._id), reason: 'disabled' });
    throw ApiError.forbidden('This account has been disabled');
  }

  auditLog('login_success', { userId: String(user._id), role: user.role });
  res.json({
    success: true,
    data: { token: signToken(user), user: user.toSafeJSON() },
  });
});

/**
 * Turn an already-verified Google payload into the ERP user it identifies,
 * or refuse. Split out from `googleLogin` on purpose: everything above this
 * point is cryptographic (signature/issuer/audience/expiry, all inside
 * `verifyIdToken`), everything in here is a business rule, and business
 * rules are what need a test that doesn't depend on a live Google token.
 *
 * Never reads a role, section or active flag from `payload` — there isn't
 * one to read. Only `email` and `email_verified` are trusted from Google;
 * everything else about the account comes from the ERP record.
 */
export async function resolveGoogleUser(payload) {
  if (!payload?.email || !payload.email_verified) {
    auditLog('google_login_failed', { reason: 'email_unverified' });
    throw ApiError.unauthorized('Your Google account email is not verified.');
  }

  const email = payload.email.toLowerCase().trim();
  if (!email.endsWith('@sitare.org')) {
    auditLog('google_login_failed', { reason: 'wrong_domain' });
    throw ApiError.unauthorized('Sign in with your @sitare.org university account.');
  }

  const user = await User.findOne({ email }).populate('section', 'name semester');
  if (!user) {
    // No account is created here — only an admin adds someone to the ERP.
    auditLog('google_login_failed', { reason: 'unregistered', email });
    throw ApiError.forbidden(
      'Your university account is not registered in the ERP. Please contact the administrator.'
    );
  }
  if (!user.isActive) {
    auditLog('google_login_failed', { reason: 'disabled', userId: String(user._id) });
    throw ApiError.forbidden('This account has been disabled');
  }

  /*
   * Recorded once, for this account, the first time it is seen — a link to
   * "who signed in", not a second source of truth. If it is already set to a
   * different value than what Google just presented, the email is still the
   * authority (Google verified it above), so this is logged, not blocked.
   */
  if (!user.googleSub) {
    user.googleSub = payload.sub;
    await user.save();
  } else if (payload.sub && user.googleSub !== payload.sub) {
    auditLog('google_sub_mismatch', { userId: String(user._id) });
  }

  auditLog('google_login_success', { userId: String(user._id), role: user.role });
  return user;
}

/**
 * Sign in with a Google ID token instead of a password.
 *
 * Google only ever establishes identity here; role, section, subjects and
 * active status all come from the ERP record `resolveGoogleUser` looks up,
 * exactly as they would for a password login. Nothing in the request body
 * besides the token itself is read — a client-supplied `role` would not even
 * reach this far, since `credential` is the only field the schema accepts.
 */
export const googleLogin = asyncHandler(async (req, res) => {
  if (!googleClient) {
    throw ApiError.badRequest('Google sign-in is not configured on this server.');
  }

  const { credential } = req.body;

  let payload;
  try {
    // Signature, issuer, audience and expiry are all verified inside this
    // call against Google's own keys — nothing here is decoded and trusted
    // without that check passing first.
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: env.googleClientId });
    payload = ticket.getPayload();
  } catch {
    auditLog('google_login_failed', { reason: 'token_verification_failed' });
    throw ApiError.unauthorized('Could not verify your Google sign-in. Please try again.');
  }

  const user = await resolveGoogleUser(payload);
  res.json({
    success: true,
    data: { token: signToken(user), user: user.toSafeJSON() },
  });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user.toSafeJSON() } });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    auditLog('password_change_failed', { userId: String(req.user._id) });
    throw ApiError.badRequest('Current password is incorrect');
  }
  user.password = newPassword;
  await user.save();

  auditLog('password_changed', { userId: String(req.user._id) });
  res.json({ success: true, message: 'Password updated' });
});
