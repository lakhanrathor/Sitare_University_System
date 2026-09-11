/**
 * The states a swap request moves through, and which of them are still live.
 *
 * SWAP_OPEN is the set a request can still be acted on from: the counterparty
 * may decline and the requester may withdraw right up until an administrator
 * decides. Keeping it beside the states rather than deriving it means the two
 * stages — the other lecturer agreeing, then the admin approving — cannot
 * drift apart.
 */
export const SWAP_STATUS = [
  'pending',
  'accepted',
  'approved',
  'rejected',
  'withdrawn',
  'declined',
];

export const SWAP_OPEN = ['pending', 'accepted'];
