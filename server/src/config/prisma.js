/**
 * The PostgreSQL client.
 *
 * One instance for the whole process. `node --watch` restarts the process on
 * every save rather than re-importing this module, so the usual globalThis
 * cache is not what protects us there — what matters is that nothing else in
 * the codebase calls `new PrismaClient()`, because each instance opens its own
 * connection pool and a handful of them will exhaust Postgres's connection
 * limit long before the app is under any real load.
 */
import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

if (!env.databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set — see server/.env.example. Start a database with ' +
      '`docker compose up -d db` at the repo root, or point it at any PostgreSQL 15+.'
  );
}

export const prisma = new PrismaClient({
  datasources: { db: { url: env.databaseUrl } },

  /*
   * The hash is never read unless a query asks for it by name. Only the two
   * login paths do, and they say so explicitly — so no other query can leak it
   * by forgetting to exclude it.
   */
  omit: { user: { password: true } },

  /*
   * Warnings and errors only. Prisma's `query` level logs every statement,
   * which in this app means logging enough of a register to be worth
   * protecting — and morgan already records the request that caused it.
   */
  log: env.isProd ? ['warn', 'error'] : ['warn', 'error'],
});

export async function disconnectPrisma() {
  await prisma.$disconnect();
}
