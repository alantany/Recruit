import fs from "node:fs/promises";
import path from "node:path";

import type {
  CandidateAction,
  CandidateProfile,
  CandidateStatus,
  ConversationTurn,
  JobDefinition,
  ManualHandover,
  ManualReviewItem,
  RecruitAgentState,
  ReportRow,
  RunHistoryEntry,
} from "./types.js";
import { ensureDir, fileExists, formatDateKey, formatHourKey, nowIso, resolveFromRoot } from "./utils.js";

function createEmptyState(): RecruitAgentState {
  const current = nowIso();

  return {
    createdAt: current,
    updatedAt: current,
    jobs: {},
    candidates: {},
    handledInteractionKeys: [],
    manualHandovers: [],
    manualReviewQueue: [],
    runHistory: [],
    dailyCounters: {},
    hourlyCounters: {},
    consecutiveErrors: 0,
  };
}

export async function loadState(stateFile: string): Promise<RecruitAgentState> {
  if (!(await fileExists(stateFile))) {
    const state = createEmptyState();
    await saveState(stateFile, state);
    return state;
  }

  const raw = (await fs.readFile(stateFile, "utf8")).replace(/\r\n/g, "\n");
  let parsed: Partial<RecruitAgentState>;
  try {
    parsed = raw.trim() ? (JSON.parse(raw) as Partial<RecruitAgentState>) : {};
  } catch {
    console.warn("[store] 状态文件解析失败，已重置为初始状态:", stateFile);
    parsed = {};
  }

  return {
    createdAt: parsed.createdAt ?? nowIso(),
    updatedAt: parsed.updatedAt ?? nowIso(),
    jobs: parsed.jobs ?? {},
    candidates: parsed.candidates ?? {},
    handledInteractionKeys: parsed.handledInteractionKeys ?? [],
    manualHandovers: parsed.manualHandovers ?? [],
    manualReviewQueue: parsed.manualReviewQueue ?? [],
    runHistory: parsed.runHistory ?? [],
    dailyCounters: parsed.dailyCounters ?? {},
    hourlyCounters: parsed.hourlyCounters ?? {},
    consecutiveErrors: parsed.consecutiveErrors ?? 0,
  };
}

export async function saveState(stateFile: string, state: RecruitAgentState): Promise<void> {
  await ensureDir(path.dirname(stateFile));
  state.updatedAt = nowIso();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function getCandidate(state: RecruitAgentState, id: string): CandidateProfile | undefined {
  return state.candidates[id];
}

export function listJobs(state: RecruitAgentState): JobDefinition[] {
  return Object.values(state.jobs).sort((left, right) => right.syncedAt.localeCompare(left.syncedAt));
}

export function upsertJob(state: RecruitAgentState, job: JobDefinition): JobDefinition {
  state.jobs[job.id] = {
    ...state.jobs[job.id],
    ...job,
    syncedAt: nowIso(),
  };
  return state.jobs[job.id]!;
}

export function upsertCandidate(
  state: RecruitAgentState,
  candidate: CandidateProfile,
): CandidateProfile {
  const existing = state.candidates[candidate.id];
  const merged: CandidateProfile = existing
    ? {
        ...existing,
        ...candidate,
        conversations: candidate.conversations.length > 0 ? candidate.conversations : existing.conversations,
        actions: candidate.actions.length > 0 ? candidate.actions : existing.actions,
        createdAt: existing.createdAt,
        updatedAt: nowIso(),
      }
    : {
        ...candidate,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      };

  state.candidates[candidate.id] = merged;
  return merged;
}

export function recordAction(
  candidate: CandidateProfile,
  type: CandidateAction["type"],
  note?: string,
  meta?: CandidateAction["meta"],
): CandidateProfile {
  candidate.actions.push({
    type,
    at: nowIso(),
    note,
    meta,
  });
  candidate.updatedAt = nowIso();
  return candidate;
}

export function appendConversation(
  candidate: CandidateProfile,
  role: ConversationTurn["role"],
  text: string,
): CandidateProfile {
  candidate.conversations.push({
    role,
    text,
    at: nowIso(),
  });
  candidate.updatedAt = nowIso();
  return candidate;
}

export function setCandidateStatus(candidate: CandidateProfile, status: CandidateStatus): CandidateProfile {
  candidate.status = status;
  candidate.updatedAt = nowIso();
  return candidate;
}

export function markContactCounters(state: RecruitAgentState, at = new Date()): void {
  const dayKey = formatDateKey(at);
  const hourKey = formatHourKey(at);
  state.dailyCounters[dayKey] = (state.dailyCounters[dayKey] ?? 0) + 1;
  state.hourlyCounters[hourKey] = (state.hourlyCounters[hourKey] ?? 0) + 1;
}

export function getDailyContactCount(state: RecruitAgentState, at = new Date()): number {
  return state.dailyCounters[formatDateKey(at)] ?? 0;
}

export function getHourlyContactCount(state: RecruitAgentState, at = new Date()): number {
  return state.hourlyCounters[formatHourKey(at)] ?? 0;
}

export function listCandidates(state: RecruitAgentState): CandidateProfile[] {
  return Object.values(state.candidates).sort((left, right) => {
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function findCandidateByStableKey(
  state: RecruitAgentState,
  stableKey: string | undefined,
): CandidateProfile | undefined {
  if (!stableKey) {
    return undefined;
  }

  return Object.values(state.candidates).find((candidate) => candidate.stableKey === stableKey);
}

export function hasHandledInteraction(state: RecruitAgentState, key: string): boolean {
  return state.handledInteractionKeys.includes(key);
}

export function markHandledInteraction(state: RecruitAgentState, key: string): void {
  if (state.handledInteractionKeys.includes(key)) {
    return;
  }

  state.handledInteractionKeys.push(key);
  if (state.handledInteractionKeys.length > 2000) {
    state.handledInteractionKeys = state.handledInteractionKeys.slice(-2000);
  }
}

export function addManualHandover(state: RecruitAgentState, handover: ManualHandover): void {
  const existing = state.manualHandovers.find((item) => item.candidateId === handover.candidateId);
  if (existing) {
    existing.reason = handover.reason;
    existing.latestMessage = handover.latestMessage;
    existing.createdAt = handover.createdAt;
    return;
  }

  state.manualHandovers.push(handover);
}

export function listManualHandovers(state: RecruitAgentState): ManualHandover[] {
  return [...state.manualHandovers].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function enqueueManualReview(state: RecruitAgentState, item: ManualReviewItem): void {
  const exists = state.manualReviewQueue.some(
    (existing) => existing.candidateId === item.candidateId && existing.jobId === item.jobId,
  );
  if (exists) {
    return;
  }

  state.manualReviewQueue.push(item);
}

export function listManualReviewQueue(state: RecruitAgentState): ManualReviewItem[] {
  return [...state.manualReviewQueue].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function startRunHistoryEntry(state: RecruitAgentState, command: string): RunHistoryEntry {
  const entry: RunHistoryEntry = {
    id: `${command}-${Date.now()}`,
    command,
    startedAt: nowIso(),
    summary: {
      jobsSynced: 0,
      discovered: 0,
      scored: 0,
      autoContacted: 0,
      manualReview: 0,
      skipped: 0,
      followUps: 0,
      handovers: 0,
      errors: 0,
    },
    notes: [],
  };

  state.runHistory.push(entry);
  return entry;
}

export function finishRunHistoryEntry(
  entry: RunHistoryEntry,
  summary: RunHistoryEntry["summary"],
  notes: string[] = [],
): void {
  entry.finishedAt = nowIso();
  entry.summary = summary;
  entry.notes = notes;
}

export async function writeReport(reportDir: string, rows: ReportRow[]): Promise<string> {
  await ensureDir(reportDir);
  const reportPath = resolveFromRoot(reportDir, `report-${Date.now()}.md`);
  const lines = [
    "# 招聘 Agent 日报",
    "",
    "| 候选人 | 状态 | 分数 | 页面 | 岗位 | 动作 | 更新时间 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.name} | ${row.status} | ${row.score} | ${row.page ?? "-"} | ${row.jobTitle ?? "-"} | ${row.action} | ${row.updatedAt} |`,
    ),
    "",
  ];
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  return reportPath;
}

export async function writeManualHandoverReport(reportDir: string, rows: ManualHandover[]): Promise<string> {
  await ensureDir(reportDir);
  const reportPath = resolveFromRoot(reportDir, `manual-handover-${Date.now()}.md`);
  const lines = [
    "# 人工接管列表",
    "",
    "| 候选人 | 原因 | 最新消息 | 时间 |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.candidateName} | ${row.reason} | ${row.latestMessage} | ${row.createdAt} |`),
    "",
  ];
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  return reportPath;
}

export async function writeManualReviewReport(reportDir: string, rows: ManualReviewItem[]): Promise<string> {
  await ensureDir(reportDir);
  const reportPath = resolveFromRoot(reportDir, `manual-review-${Date.now()}.md`);
  const lines = [
    "# 人工复核队列",
    "",
    "| 候选人 | 岗位ID | 分数 | 原因 | 时间 |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.candidateName} | ${row.jobId ?? "-"} | ${row.score} | ${row.reason} | ${row.createdAt} |`),
    "",
  ];
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
  return reportPath;
}
