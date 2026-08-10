import mongoose from 'mongoose';

export const SWAP_STATUS = [
  /** Waiting on the other lecturer. */
  'pending',
  /** They agreed; now waiting on an administrator. */
  'accepted',
  'approved',
  'rejected',
  'withdrawn',
  'declined',
];

/** The two states where a swap is still live and could still be applied. */
export const SWAP_OPEN = ['pending', 'accepted'];

/**
 * A request from one faculty member to exchange the time of their class with
 * another faculty member's class. Each side keeps its own subject and teacher —
 * only the period changes hands, which is what makes the two teachers' names
 * appear in each other's old cells once approved.
 *
 * Two stages, in this order: the lecturer being asked agrees first, and only
 * then does an administrator have something to approve. Nobody should be
 * timetabled into a swap they never consented to, and an admin has no way of
 * knowing whether the two have spoken — so the consent is recorded rather than
 * assumed. Nothing on the live grid moves until the admin approves.
 */
const swapRequestSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Faculty who owns the class being swapped into. */
    counterparty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // The requester's class
    fromEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableEntry', required: true },
    fromDateKey: { type: String, required: true },
    fromSlot: { type: Number, required: true },

    // The counterparty's class
    toEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableEntry', required: true },
    toDateKey: { type: String, required: true },
    toSlot: { type: Number, required: true },

    reason: { type: String, trim: true, default: '', maxlength: 300 },

    status: { type: String, enum: SWAP_STATUS, default: 'pending', index: true },

    /** When the other lecturer agreed — the first of the two stages. */
    acceptedAt: { type: Date, default: null },

    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

export default mongoose.model('SwapRequest', swapRequestSchema);
