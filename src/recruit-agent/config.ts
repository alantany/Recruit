import fs from "node:fs/promises";

import type { RecruitAgentConfig } from "./types.js";
import { resolveFromRoot } from "./utils.js";

export async function loadConfig(configPath: string): Promise<RecruitAgentConfig> {
  const fullPath = resolveFromRoot(configPath);
  const raw = (await fs.readFile(fullPath, "utf8")).replace(/\r\n/g, "\n");
  const parsed = JSON.parse(raw) as RecruitAgentConfig;

  parsed.browser.userDataDir = resolveFromRoot(parsed.browser.userDataDir);
  parsed.storage.stateFile = resolveFromRoot(parsed.storage.stateFile);
  parsed.storage.reportDir = resolveFromRoot(parsed.storage.reportDir);
  parsed.storage.resumeDir = resolveFromRoot(parsed.storage.resumeDir ?? "./data/resumes");
  parsed.storage.interactionLogDir = resolveFromRoot(parsed.storage.interactionLogDir ?? "./data/interaction-logs");
  parsed.storage.actionLogDir = resolveFromRoot(parsed.storage.actionLogDir ?? "./data/action-logs");
  parsed.messages.resumeReceivedAck =
    parsed.messages.resumeReceivedAck ??
    "已收到你的简历，感谢配合。我会尽快和招聘负责人同步并给你反馈。";
  parsed.daemon = {
    enabled: parsed.daemon?.enabled ?? false,
    interactionIntervalMinutes: parsed.daemon?.interactionIntervalMinutes ?? 1,
    recommendIntervalMinutes: parsed.daemon?.recommendIntervalMinutes ?? 30,
    searchIntervalMinutes: parsed.daemon?.searchIntervalMinutes ?? 30,
    potentialIntervalMinutes: parsed.daemon?.potentialIntervalMinutes ?? 45,
    jobsSyncIntervalMinutes: parsed.daemon?.jobsSyncIntervalMinutes ?? 180,
    reportIntervalMinutes: parsed.daemon?.reportIntervalMinutes ?? 120,
  };
  parsed.llm = {
    enabled: parsed.llm?.enabled ?? false,
    provider: parsed.llm?.provider ?? "openai_compatible",
    model: parsed.llm?.model ?? "gpt-4o-mini",
    baseUrl: parsed.llm?.baseUrl ?? "https://api.openai.com/v1",
    apiKeyEnv: parsed.llm?.apiKeyEnv ?? "OPENAI_API_KEY",
    timeoutMs: parsed.llm?.timeoutMs ?? 10000,
    maxContextTurns: parsed.llm?.maxContextTurns ?? 12,
    temperature: parsed.llm?.temperature ?? 0.2,
  };

  return parsed;
}
