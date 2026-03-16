import fs from "node:fs/promises";
import path from "node:path";

import type { CandidateProfile, RecruitAgentConfig } from "./types.js";
import { ensureDir, nowIso, slugify, truncate } from "./utils.js";

interface SavedResumeEvidence {
  candidateId: string;
  candidateName: string;
  savedAt: string;
  latestReply: string;
  messageHistory: string[];
  threadKey?: string;
  links: string[];
}

export async function saveResumeEvidence(
  candidate: CandidateProfile,
  latestReply: string,
  allMessages: string[],
  threadKey: string | undefined,
  config: RecruitAgentConfig,
): Promise<string> {
  const resumeDir = config.storage.resumeDir ?? "./data/resumes";
  await ensureDir(resumeDir);

  const links = extractLinks([latestReply, ...allMessages].join(" "));
  const payload: SavedResumeEvidence = {
    candidateId: candidate.id,
    candidateName: candidate.name,
    savedAt: nowIso(),
    latestReply: truncate(latestReply, 800),
    messageHistory: allMessages.slice(-20).map((item) => truncate(item, 800)),
    threadKey,
    links,
  };

  const filename = `${Date.now()}-${slugify(`${candidate.name}-${candidate.id}`)}.json`;
  const fullPath = path.join(resumeDir, filename);
  await fs.writeFile(fullPath, JSON.stringify(payload, null, 2), "utf8");
  return fullPath;
}

function extractLinks(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches)];
}
