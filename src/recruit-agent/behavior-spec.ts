import type { CandidateStatus } from "./types.js";

const PROTECTED_STATUSES: CandidateStatus[] = [
  "contacted",
  "resume_requested",
  "awaiting_reply",
  "resume_received",
  "not_interested_reasoned",
  "needs_human_takeover",
];

export function isProtectedStatus(status: CandidateStatus): boolean {
  return PROTECTED_STATUSES.includes(status);
}

export function canTransitionToScored(status: CandidateStatus): boolean {
  return !isProtectedStatus(status);
}
