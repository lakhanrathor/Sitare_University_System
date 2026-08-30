import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadPdfOrCsv } from '../middleware/upload.js';
import { auditLog } from '../utils/audit.js';
import { listLeaveDocuments } from '../controllers/leaveController.js';
import {
  getOverview,
  listUsers,
  getStudentProfile,
  listFacultyWithLoad,
  createUser,
  updateUser,
  setUserStatus,
  deleteUser,
  importStudents,
  listSections,
  createSection,
  updateSection,
  deleteSection,
  listSubjectsAdmin,
  createSubject,
  updateSubject,
  deleteSubject,
  getSubjectRosterAdmin,
  setEnrolment,
  createUserSchema,
  updateUserSchema,
  sectionSchema,
  updateSectionSchema,
  subjectSchema,
} from '../controllers/adminController.js';

const router = Router();

/* Everything here is administration — no other role may enter. */
router.use(protect, authorize('admin'));

/*
 * A single chokepoint for "what did an admin change" — every write in this
 * router passes through here, so no individual handler needs its own audit
 * call. Reads are noise for this purpose and are left out.
 */
router.use((req, _res, next) => {
  if (req.method !== 'GET') {
    auditLog('admin_action', { userId: String(req.user._id), method: req.method, path: req.path });
  }
  next();
});

router.get('/overview', getOverview);

/* People */
router.get('/users', listUsers);
router.get('/faculty', listFacultyWithLoad);
router.post('/users', validate(createUserSchema), createUser);
/* Accepts a PDF or CSV roster, or pasted rows; validated inside the controller. */
router.post('/users/import', uploadPdfOrCsv(), importStudents);
router.patch('/users/:userId', validate(updateUserSchema), updateUser);
router.patch('/users/:userId/status', setUserStatus);
router.delete('/users/:userId', deleteUser);

/* One student in full — attendance and what they have sent in. */
router.get('/students/:studentId', getStudentProfile);

/*
 * What one student has applied for. Reading only: students raise their own
 * applications from their portal (see leaveRoutes), and the administration's
 * job here is to read them when deciding on a shortage.
 */
router.get('/students/:studentId/leave', listLeaveDocuments);

/* Sections */
router.get('/sections', listSections);
router.post('/sections', validate(sectionSchema), createSection);
router.patch('/sections/:sectionId', validate(updateSectionSchema), updateSection);
router.delete('/sections/:sectionId', deleteSection);

/* Subjects & enrolment */
router.get('/subjects', listSubjectsAdmin);
router.post('/subjects', validate(subjectSchema), createSubject);
router.patch('/subjects/:subjectId', updateSubject);
router.delete('/subjects/:subjectId', deleteSubject);
router.get('/subjects/:subjectId/roster', getSubjectRosterAdmin);
router.patch('/subjects/:subjectId/roster', setEnrolment);

export default router;
