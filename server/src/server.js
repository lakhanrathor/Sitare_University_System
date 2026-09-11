import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { initSocket } from './sockets/index.js';

const server = http.createServer(app);

async function start() {
  /*
   * Connected here rather than left to connect lazily, so a wrong DATABASE_URL
   * fails at boot with one clear message instead of on whichever request
   * happens to touch the database first.
   */
  await prisma.$connect();
  console.log('[db] PostgreSQL connected');
  initSocket(server);

  server.listen(env.port, '0.0.0.0', () => {
    console.log(`[api] Sitare ERP API listening on http://localhost:${env.port}`);
    console.log(`[api] Allowing client origin ${env.clientOrigin}`);
  });
}

start();

/*
 * A stray rejection from a third-party library — a PDF reader settling a
 * promise after we stopped awaiting it, a driver retry — must not take the
 * institute offline. It is logged loudly and the server keeps serving; every
 * request already has its own error boundary in the Express handler.
 */
process.on('unhandledRejection', (err) => {
  console.error('[error] Unhandled rejection (server kept running):', err);
});

/*
 * An uncaught exception is different: state after one is not trustworthy, so
 * stop taking new connections and let the supervisor restart us.
 */
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  server.close(() => process.exit(1));
});

process.on('SIGINT', () => {
  console.log('\n[api] Shutting down');
  server.close(() => process.exit(0));
});
