import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGO_URI', 'JWT_SECRET'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const isProd = (process.env.NODE_ENV || 'development') === 'production';

/*
 * Every token in the system is only as strong as this string. A short or
 * guessable secret lets anyone who obtains it forge a valid admin token, so a
 * weak one is refused outright in production rather than merely warned about.
 * Dev keeps a warning instead of a hard stop, so `npm run seed` on a fresh
 * checkout still works before anyone has touched `.env`.
 */
const WEAK_SECRETS = new Set(['secret', 'changeme', 'password', 'replace_with_a_long_random_string']);
const weakSecret =
  process.env.JWT_SECRET.length < 32 || WEAK_SECRETS.has(process.env.JWT_SECRET.toLowerCase());

if (weakSecret) {
  const message =
    '[config] JWT_SECRET is missing, too short, or a known placeholder. ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
  if (isProd) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}

/*
 * Optional, not required: the app must keep booting, and email/password login
 * must keep working, on a checkout where nobody has created a Google OAuth
 * client yet. Its absence only disables the /auth/google route.
 */
const googleClientId = process.env.GOOGLE_CLIENT_ID || null;
if (!googleClientId && !isProd) {
  console.warn('[config] GOOGLE_CLIENT_ID not set — Google sign-in is disabled.');
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  googleClientId,
  isProd,
};
