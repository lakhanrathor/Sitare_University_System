import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { verifyToken } from '../middleware/auth.js';
import User from '../models/User.js';

let io = null;

export const rooms = {
  user: (id) => `user:${id}`,
  subject: (id) => `subject:${id}`,
  role: (role) => `role:${role}`,
};

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.clientOrigin, credentials: true },
  });

  // Every socket must present the same JWT the REST API uses.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication token missing'));
      const payload = verifyToken(token);
      const user = await User.findById(payload.sub).select('name role isActive');
      if (!user || !user.isActive) return next(new Error('Account not found or disabled'));
      socket.user = { id: String(user._id), role: user.role, name: user.name };
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.user;
    socket.join(rooms.user(id));
    socket.join(rooms.role(role));

    // Faculty/admin watching a specific subject sheet get live per-subject events.
    socket.on('subject:join', (subjectId) => {
      if (subjectId) socket.join(rooms.subject(subjectId));
    });
    socket.on('subject:leave', (subjectId) => {
      if (subjectId) socket.leave(rooms.subject(subjectId));
    });

    socket.on('disconnect', () => {});
  });

  console.log('[socket] Realtime gateway ready');
  return io;
}

export function getIO() {
  return io;
}

/** Push an event to a set of user ids (students affected by a change). */
export function emitToUsers(userIds, event, payload) {
  if (!io) return;
  const unique = [...new Set(userIds.map(String))];
  unique.forEach((uid) => io.to(rooms.user(uid)).emit(event, payload));
}

export function emitToSubject(subjectId, event, payload) {
  if (!io) return;
  io.to(rooms.subject(String(subjectId))).emit(event, payload);
}
