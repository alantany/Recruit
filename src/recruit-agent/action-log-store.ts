import fs from "node:fs/promises";
import path from "node:path";

import type { RecruitAgentConfig } from "./types.js";
import { ensureDir, nowIso } from "./utils.js";

export interface ActionLogEntry {
  at?: string;
  runId?: string;
  command?: string;
  phase?: "start" | "event" | "finish" | "error";
  message: string;
  candidateId?: string;
  candidateName?: string;
  threadKey?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export async function appendActionLog(config: RecruitAgentConfig, entry: ActionLogEntry): Promise<void> {
  const root = config.storage.actionLogDir ?? "./data/action-logs";
  const at = entry.at ?? nowIso();
  const day = at.slice(0, 10);
  const dir = path.resolve(root, day);
  await ensureDir(dir);
  const filePath = path.join(dir, "actions.jsonl");

  const payload = {
    at,
    runId: entry.runId,
    command: entry.command,
    phase: entry.phase ?? "event",
    message: entry.message,
    candidateId: entry.candidateId,
    candidateName: entry.candidateName,
    threadKey: entry.threadKey,
    meta: entry.meta,
  };
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}
