import path from "node:path";

import { appendActionLog } from "./action-log-store.js";
import { canTransitionToScored, isProtectedStatus } from "./behavior-spec.js";
import { ZhilianBrowserRunner } from "./browser/zhilian.js";
import { loadConfig } from "./config.js";
import { runDaemonLoop } from "./daemon-runner.js";
import { applySendDelay, canContactNow, isDeniedCandidateName, shouldCooldownCandidate } from "./guardrails.js";
import { runInteractionCommand } from "./interaction-runner.js";
import { fallbackJob, normalizeJob } from "./jd-engine.js";
import { scoreCandidate } from "./match-engine.js";
import { buildMessagePlan, nextFollowUpAt } from "./message-engine.js";
import { buildSearchKeywordPlans } from "./search-keyword-engine.js";
import {
  appendConversation,
  enqueueManualReview,
  findCandidateByStableKey,
  finishRunHistoryEntry,
  getCandidate,
  listCandidates,
  listJobs,
  listManualHandovers,
  listManualReviewQueue,
  loadState,
  markContactCounters,
  recordAction,
  saveState,
  setCandidateStatus,
  startRunHistoryEntry,
  upsertCandidate,
  upsertJob,
  writeManualHandoverReport,
  writeManualReviewReport,
  writeReport,
} from "./store.js";
import type { AgentRunSummary, BrowserCandidateSnapshot, CandidateProfile, JobDefinition, RecruitAgentConfig, RecruitAgentState } from "./types.js";
import { ensureDir, nowIso, uniqueStrings } from "./utils.js";

interface RunWithBrowserOptions {
  sharedBrowser?: ZhilianBrowserRunner;
  keepBrowserOpen?: boolean;
}

type RunWithBrowserFn = (
  command: string,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  callback: (
    browser: ZhilianBrowserRunner,
    summary: AgentRunSummary,
    notes: string[],
  ) => Promise<void>,
  options?: RunWithBrowserOptions,
) => Promise<void>;

async function main(): Promise<void> {
  const { command, configPath } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const state = await loadState(config.storage.stateFile);

  switch (command) {
    case "init":
      await runInit(config);
      break;
    case "jobs:sync":
      await runJobsSync(config, state);
      break;
    case "recommend:run":
      await runRecommend(config, state);
      break;
    case "search:run":
      await runSearch(config, state);
      break;
    case "potential:run":
      await runPotential(config, state);
      break;
    case "interaction:run":
      await runInteraction(config, state);
      break;
    case "workflow:run":
      await runWorkflow(config, state);
      break;
    case "daemon:run":
      await runDaemon(config, state);
      break;
    case "report:daily":
      await runReport(config, state);
      break;
    default:
      throw new Error(`不支持的命令: ${command}`);
  }
}

async function runInit(config: RecruitAgentConfig): Promise<void> {
  await ensureDir(path.dirname(config.storage.stateFile));
  await ensureDir(config.storage.reportDir);
  await ensureDir(config.storage.resumeDir ?? "./data/resumes");
  await ensureDir(config.storage.interactionLogDir ?? "./data/interaction-logs");
  await ensureDir(config.storage.actionLogDir ?? "./data/action-logs");
  console.log("初始化完成");
  console.log(`状态文件: ${config.storage.stateFile}`);
  console.log(`报表目录: ${config.storage.reportDir}`);
  console.log(`简历线索目录: ${config.storage.resumeDir ?? "./data/resumes"}`);
  console.log(`互动留痕目录: ${config.storage.interactionLogDir ?? "./data/interaction-logs"}`);
  console.log(`动作时间线目录: ${config.storage.actionLogDir ?? "./data/action-logs"}`);
  console.log("请先执行 `npm run playwright:install`，再手动登录智联招聘。");
}

async function runJobsSync(
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  runWithBrowserFn: RunWithBrowserFn = runWithBrowser,
): Promise<void> {
  await runWithBrowserFn("jobs:sync", config, state, async (browser, summary) => {
    const page = await browser.jobCenterPage();
    const jobs = await page.syncJobs(config.jobSync.syncLimit);

    for (const job of jobs) {
      upsertJob(state, normalizeJob(job, config));
      summary.jobsSynced += 1;
    }

    if (jobs.length === 0) {
      upsertJob(state, fallbackJob(config));
      summary.jobsSynced += 1;
    }
  });
}

async function runRecommend(
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  runWithBrowserFn: RunWithBrowserFn = runWithBrowser,
): Promise<void> {
  await runWithBrowserFn("recommend:run", config, state, async (browser, summary, notes) => {
    const jobs = resolveActiveJobs(state, config);
    if (jobs.length > 1) {
      notes.push("推荐人才页面未实现岗位切换，当前只处理第一个激活岗位");
    }
    const job = jobs[0];
    if (!job) {
      return;
    }
    const page = await browser.recommendPage();
    const snapshots = await page.collectCandidates(20);
    await processSnapshots(browser, snapshots, job, "recommend", config, state, summary);
  });
}

async function runSearch(
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  runWithBrowserFn: RunWithBrowserFn = runWithBrowser,
): Promise<void> {
  await runWithBrowserFn("search:run", config, state, async (browser, summary, notes) => {
    const jobs = resolveActiveJobs(state, config);
    const page = await browser.searchPage();

    for (const job of jobs) {
      const plans = buildSearchKeywordPlans(job, config.search.maxQueriesPerJob);
      for (const plan of plans) {
        const effectivePlan = {
          ...plan,
          excludes: uniqueStrings([...plan.excludes, ...config.job.excludeKeywords]),
        };
        notes.push(`搜索词: ${job.title} -> ${effectivePlan.keyword}`);
        const snapshots = await page.runQuery(effectivePlan, config.search.maxCandidatesPerQuery);
        await processSnapshots(browser, snapshots, job, "search", config, state, summary);
      }
    }
  });
}

async function runPotential(
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  runWithBrowserFn: RunWithBrowserFn = runWithBrowser,
): Promise<void> {
  await runWithBrowserFn("potential:run", config, state, async (browser, summary, notes) => {
    const jobs = resolveActiveJobs(state, config);
    if (jobs.length > 1) {
      notes.push("潜在人才页面未实现岗位切换，当前只处理第一个激活岗位");
    }
    const job = jobs[0];
    if (!job) {
      return;
    }
    const page = await browser.potentialPage();
    const snapshots = await page.collectCandidates(10);
    await processSnapshots(browser, snapshots, job, "potential", config, state, summary, true);
  });
}

async function runInteraction(
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  runWithBrowserFn: RunWithBrowserFn = runWithBrowser,
): Promise<void> {
  await runInteractionCommand(runWithBrowserFn, config, state, resolveJobForCandidate);
}

async function runWorkflow(config: RecruitAgentConfig, state: RecruitAgentState): Promise<void> {
  await runJobsSync(config, state);
  await runRecommend(config, state);
  await runSearch(config, state);
  await runPotential(config, state);
  await runInteraction(config, state);
  await runReport(config, state);
}

async function runDaemon(config: RecruitAgentConfig, state: RecruitAgentState): Promise<void> {
  const sharedBrowser = new ZhilianBrowserRunner(config);
  const daemonRunWithBrowser: RunWithBrowserFn = (command, nextConfig, nextState, callback) =>
    runWithBrowser(command, nextConfig, nextState, callback, {
      sharedBrowser,
      keepBrowserOpen: true,
    });

  try {
    await runDaemonLoop(
      [
        {
          id: "interaction",
          intervalMs: config.daemon.interactionIntervalMinutes * 60 * 1000,
          run: () => runInteraction(config, state, daemonRunWithBrowser),
        },
        {
          id: "recommend",
          intervalMs: config.daemon.recommendIntervalMinutes * 60 * 1000,
          run: () => runRecommend(config, state, daemonRunWithBrowser),
        },
        {
          id: "search",
          intervalMs: config.daemon.searchIntervalMinutes * 60 * 1000,
          run: () => runSearch(config, state, daemonRunWithBrowser),
        },
        {
          id: "potential",
          intervalMs: config.daemon.potentialIntervalMinutes * 60 * 1000,
          run: () => runPotential(config, state, daemonRunWithBrowser),
        },
        {
          id: "jobs-sync",
          intervalMs: config.daemon.jobsSyncIntervalMinutes * 60 * 1000,
          run: () => runJobsSync(config, state, daemonRunWithBrowser),
        },
        {
          id: "report",
          intervalMs: config.daemon.reportIntervalMinutes * 60 * 1000,
          run: () => runReport(config, state),
        },
      ],
      config,
    );
  } finally {
    await sharedBrowser.stop();
  }
}

async function runReport(config: RecruitAgentConfig, state: RecruitAgentState): Promise<void> {
  const jobMap = new Map(listJobs(state).map((job) => [job.id, job.title]));
  const rows = listCandidates(state).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    status: candidate.status,
    score: candidate.score?.total ?? 0,
    action: candidate.actions.at(-1)?.type ?? "none",
    page: candidate.sourcePage,
    jobTitle: candidate.jobId ? jobMap.get(candidate.jobId) : undefined,
    updatedAt: candidate.updatedAt,
  }));

  const reportPath = await writeReport(config.storage.reportDir, rows);
  const handoverPath = await writeManualHandoverReport(config.storage.reportDir, listManualHandovers(state));
  const reviewPath = await writeManualReviewReport(config.storage.reportDir, listManualReviewQueue(state));
  console.log(`日报已生成: ${reportPath}`);
  console.log(`人工接管列表已生成: ${handoverPath}`);
  console.log(`人工复核队列已生成: ${reviewPath}`);
}

async function runWithBrowser(
  command: string,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  callback: (
    browser: ZhilianBrowserRunner,
    summary: AgentRunSummary,
    notes: string[],
  ) => Promise<void>,
  options?: RunWithBrowserOptions,
): Promise<void> {
  const browser = options?.sharedBrowser ?? new ZhilianBrowserRunner(config);
  const summary = createSummary();
  const notes: string[] = [];
  const history = startRunHistoryEntry(state, command);

  try {
    await appendActionLog(config, {
      runId: history.id,
      command,
      phase: "start",
      message: `轮次开始: ${command}`,
    });
    await callback(browser, summary, notes);
    state.consecutiveErrors = 0;
    finishRunHistoryEntry(history, summary, notes);
    await saveState(config.storage.stateFile, state);
    await appendActionLog(config, {
      runId: history.id,
      command,
      phase: "finish",
      message: `轮次结束: ${command}`,
      meta: {
        jobsSynced: summary.jobsSynced,
        discovered: summary.discovered,
        scored: summary.scored,
        autoContacted: summary.autoContacted,
        manualReview: summary.manualReview,
        skipped: summary.skipped,
        followUps: summary.followUps,
        handovers: summary.handovers,
        errors: summary.errors,
      },
    });
    printSummary(command, summary);
  } catch (error) {
    state.consecutiveErrors += 1;
    summary.errors += 1;
    notes.push(error instanceof Error ? error.message : String(error));
    finishRunHistoryEntry(history, summary, notes);
    await saveState(config.storage.stateFile, state);
    await appendActionLog(config, {
      runId: history.id,
      command,
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
      meta: {
        errors: summary.errors,
      },
    });
    throw error;
  } finally {
    if (!options?.keepBrowserOpen) {
      await browser.stop();
    }
  }
}

async function processSnapshots(
  browser: ZhilianBrowserRunner,
  snapshots: BrowserCandidateSnapshot[],
  job: JobDefinition,
  pageName: BrowserCandidateSnapshot["sourcePage"],
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  summary: AgentRunSummary,
  useHigherThreshold = false,
): Promise<void> {
  for (const snapshot of snapshots) {
    const candidate = upsertScoredCandidate(snapshot, job, config, state, summary, pageName);
    if (pageName === "search") {
      recordAction(candidate, "search_executed", `搜索页命中候选人: ${candidate.name}`);
    }

    if (isProtectedStatus(candidate.status)) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", `候选人处于推进态(${candidate.status})，本轮不重复触达`);
      continue;
    }

    if (isDeniedCandidateName(candidate.name, config)) {
      setCandidateStatus(candidate, "do_not_contact");
      recordAction(candidate, "skipped", "候选人姓名命中 denyList");
      summary.skipped += 1;
      continue;
    }

    if (candidate.score?.recommendedAction === "manual_review") {
      summary.manualReview += 1;
      enqueueManualReview(state, {
        candidateId: candidate.id,
        candidateName: candidate.name,
        jobId: candidate.jobId,
        score: candidate.score?.total ?? 0,
        reason: "评分处于人工复核区间",
        createdAt: nowIso(),
      });
      continue;
    }

    if (candidate.score?.recommendedAction !== "contact") {
      summary.skipped += 1;
      continue;
    }

    if (useHigherThreshold && (candidate.score?.total ?? 0) < config.guardrails.autoContactScoreMin + 5) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", "潜在人才页使用更高阈值，未自动联系");
      continue;
    }

    if (shouldCooldownCandidate(candidate, config)) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", "候选人仍在冷却期");
      continue;
    }

    const guardrailResult = canContactNow(state, config);
    if (!guardrailResult.ok) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", guardrailResult.reason);
      break;
    }

    const messagePlan = buildMessagePlan(candidate, job, config);
    if (config.dryRun) {
      recordAction(candidate, "contacted", `dryRun: ${pageName} 未实际发送`);
    } else {
      await browser.sendMessages(snapshot, [messagePlan.opening]);
      const delayMs = await applySendDelay(config);
      recordAction(candidate, "contacted", `已发送首轮消息，延迟 ${delayMs}ms`);
    }

    appendConversation(candidate, "agent", messagePlan.opening);
    candidate.lastContactedAt = nowIso();
    candidate.followUpDueAt = nextFollowUpAt(config);
    setCandidateStatus(candidate, "contacted");
    markContactCounters(state);
    summary.autoContacted += 1;
  }
}

function upsertScoredCandidate(
  snapshot: BrowserCandidateSnapshot,
  job: JobDefinition,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  summary: AgentRunSummary,
  pageName: BrowserCandidateSnapshot["sourcePage"],
): CandidateProfile {
  const existingById = getCandidate(state, snapshot.id);
  const existingByStableKey = findCandidateByStableKey(state, snapshot.stableKey);
  const existing = existingById ?? existingByStableKey;
  const candidateId = existing?.id ?? snapshot.id;
  const current = nowIso();
  const candidate: CandidateProfile = {
    id: candidateId,
    stableKey: snapshot.stableKey ?? snapshot.id,
    name: snapshot.name,
    location: snapshot.location,
    age: snapshot.age,
    experienceYears: snapshot.experienceYears,
    education: snapshot.education,
    school: snapshot.school,
    currentCompany: snapshot.currentCompany,
    currentTitle: snapshot.currentTitle,
    expectedPosition: snapshot.expectedPosition,
    expectedSalaryRaw: snapshot.expectedSalaryRaw,
    lastActiveAt: snapshot.lastActiveAt,
    tags: snapshot.tags,
    summary: snapshot.summary,
    sourceUrl: snapshot.sourceUrl,
    sourcePlatform: "zhilian",
    sourcePage: pageName,
    jobId: existing?.jobId ?? job.id,
    status: existing?.status ?? "new",
    score: scoreCandidate(snapshot, job, config),
    latestReply: existing?.latestReply,
    lastContactedAt: existing?.lastContactedAt,
    followUpDueAt: existing?.followUpDueAt,
    replyIntent: existing?.replyIntent,
    rejectionReason: existing?.rejectionReason,
    createdAt: existing?.createdAt ?? current,
    updatedAt: current,
    conversations: existing?.conversations ?? [],
    actions: existing?.actions ?? [],
  };

  const saved = upsertCandidate(state, candidate);
  if (!existing) {
    recordAction(saved, "discovered", `从 ${pageName} 页面发现新候选人`);
    summary.discovered += 1;
  }

  recordAction(saved, "scored", `岗位 ${job.title} 匹配分 ${saved.score?.total ?? 0}`);
  if (canTransitionToScored(saved.status)) {
    setCandidateStatus(saved, saved.score?.recommendedAction === "skip" ? "do_not_contact" : "scored");
  }
  summary.scored += 1;
  return saved;
}

function resolveActiveJobs(state: RecruitAgentState, config: RecruitAgentConfig): JobDefinition[] {
  const jobs = listJobs(state)
    .filter((job) => !/^职位-\d+$/.test(job.title))
    .sort((left, right) => (right.syncedAt ?? "").localeCompare(left.syncedAt ?? ""));
  if (jobs.length === 0) {
    return [fallbackJob(config)];
  }

  const realJobs = jobs.filter((job) => Boolean(job.sourceUrl));
  const preferredJobs = realJobs.length > 0 ? realJobs : jobs;

  if (config.jobSync.activeJobIds.length === 0) {
    return preferredJobs.slice(0, 1);
  }

  const active = preferredJobs.filter((job) => config.jobSync.activeJobIds.includes(job.id));
  return active.length > 0 ? active : preferredJobs.slice(0, 1);
}

function resolveJobForCandidate(candidate: CandidateProfile, state: RecruitAgentState, config: RecruitAgentConfig): JobDefinition {
  return state.jobs[candidate.jobId ?? ""] ?? resolveActiveJobs(state, config)[0] ?? fallbackJob(config);
}

function createSummary(): AgentRunSummary {
  return {
    jobsSynced: 0,
    discovered: 0,
    scored: 0,
    autoContacted: 0,
    manualReview: 0,
    skipped: 0,
    followUps: 0,
    handovers: 0,
    errors: 0,
  };
}

function printSummary(command: string, summary: AgentRunSummary): void {
  console.log(`[${command}] jobsSynced=${summary.jobsSynced}`);
  console.log(`[${command}] discovered=${summary.discovered}`);
  console.log(`[${command}] scored=${summary.scored}`);
  console.log(`[${command}] autoContacted=${summary.autoContacted}`);
  console.log(`[${command}] manualReview=${summary.manualReview}`);
  console.log(`[${command}] skipped=${summary.skipped}`);
  console.log(`[${command}] followUps=${summary.followUps}`);
  console.log(`[${command}] handovers=${summary.handovers}`);
}

function parseArgs(args: string[]): { command: string; configPath: string } {
  const [command = "workflow:run"] = args;
  const configIndex = args.findIndex((arg) => arg === "--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : "config/recruit-agent.json";

  if (!configPath) {
    throw new Error("缺少 --config 参数值");
  }

  return { command, configPath };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
