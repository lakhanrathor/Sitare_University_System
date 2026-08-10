import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { uploadDocuments } from '../middleware/upload.js';
import {
  listNotes,
  createNote,
  downloadNoteFile,
  deleteNote,
} from '../controllers/noteController.js';

const router = Router();
router.use(protect);

/* Students read what is addressed to them; staff read and filter. */
router.get('/', listNotes);
router.get('/:noteId/attachments/:attachmentId', downloadNoteFile);

/* Publishing is the lecturer's job; an admin can post and tidy up too. */
router.post('/', authorize('faculty', 'admin'), uploadDocuments(), createNote);
router.delete('/:noteId', authorize('faculty', 'admin'), deleteNote);

export default router;
