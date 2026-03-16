import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { RecruitAgentConfig } from "./types.js";
import { ensureDir, nowIso, pickText, slugify } from "./utils.js";

export interface InteractionAuditEntry {
  at?: string;
  candidateId?: string;
  candidateName: string;
  threadKey: string;
  candidateStatus?: string;
  intent?: string;
  action: string;
  replyText?: string;
  reason?: string;
  hasResumeAttachmentCard: boolean;
  latestCandidateReply: string;
  allMessages: string[];
}

export async function appendInteractionAudit(
  config: RecruitAgentConfig,
  entry: InteractionAuditEntry,
): Promise<void> {
  const root = config.storage.interactionLogDir ?? "./data/interaction-logs";
  const day = (entry.at ?? nowIso()).slice(0, 10);
  const targetDir = path.resolve(root, day);
  await ensureDir(targetDir);

  const safeName = slugify(entry.candidateName || "unknown") || "unknown";
  const threadHash = createHash("sha1").update(entry.threadKey || "thread").digest("hex").slice(0, 12);
  const filePath = path.join(targetDir, `${safeName}-${threadHash}.jsonl`);

  const payload = {
    at: entry.at ?? nowIso(),
    candidateId: entry.candidateId,
    candidateName: entry.candidateName,
    threadKey: entry.threadKey,
    candidateStatus: entry.candidateStatus,
    intent: entry.intent,
    action: entry.action,
    replyText: entry.replyText,
    reason: entry.reason,
    hasResumeAttachmentCard: entry.hasResumeAttachmentCard,
    latestCandidateReply: pickText(entry.latestCandidateReply),
    allMessages: entry.allMessages.map((item) => pickText(item)).filter(Boolean),
  };

  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}
