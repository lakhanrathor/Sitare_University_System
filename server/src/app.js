import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import authRoutes from './routes/authRoutes.js';
import subjectRoutes from './routes/subjectRoutes.js';
import attendanceRoutes from './routes/attendanceRoutes.js';
import timetableRoutes from './routes/timetableRoutes.js';
import scheduleRoutes from './routes/scheduleRoutes.js';
import swapRoutes from './routes/swapRoutes.js';
import notificationRoutes from './routes/notificationRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import leaveRoutes from './routes/leaveRoutes.js';
import noteRoutes from './routes/noteRoutes.js';
import examRoutes from './routes/examRoutes.js';
import { notFound, errorHandler } from './middleware/error.js';

const app = express();

/*
 * Express's default query parser ('extended') turns bracket notation like
 * `?section[$ne]=1` into a nested object — which a filter such as
 * `{ section: req.query.section }` would then hand straight to MongoDB as a
 * query operator. 'simple' parses every query value as a plain string, which
 * is all any route here ever expects, and closes that class of injection
 * without touching a single controller.
 */
app.set('query parser', 'simple');

app.use(helmet());
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
if (!env.isProd) app.use(morgan('dev'));

app.get('/api/health', (_req, res) =>
  res.json({
    success: true,
    service: 'sitare-erp-api',
    modules: ['attendance', 'timetable'],
    uptime: process.uptime(),
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/swaps', swapRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/exams', examRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
