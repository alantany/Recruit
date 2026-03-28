import path from "node:path";
import readline from "node:readline";

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
import { ensureDir, nowIso } from "./utils.js";

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
    case "search-interaction:loop":
      await runSearchInteractionLoop(config, state);
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
  searchRunOptions?: { loopMode?: boolean },
): Promise<void> {
  const keepOpen =
    searchRunOptions?.loopMode === true ? true : config.browser.keepBrowserOpenAfterRun === true;
  let runner: ZhilianBrowserRunner | undefined;
  await runWithBrowserFn(
    "search:run",
    config,
    state,
    async (browser, summary, notes) => {
      runner = browser;
      const jobs = resolveActiveJobs(state, config);
      const page = await browser.searchPage();
      const topContactCount = Math.max(0, config.search.topContactCount ?? 0);
      let contactedInRun = 0;

      for (const job of jobs) {
        const plans = config.search.manualKeyword
          ? [
              {
                keyword: config.search.manualKeyword,
                excludes: [] as string[],
                priority: 100,
                why: "手动指定搜索关键词",
              },
            ]
          : buildSearchKeywordPlans(job, config.search.maxQueriesPerJob);
        for (const plan of plans) {
          if (topContactCount > 0 && contactedInRun >= topContactCount) {
            notes.push(`已达到本轮触达上限: ${topContactCount}`);
            return;
          }
          // 搜索人才不按 excludeKeywords 过滤列表；关键词搜到的条目均进入打招呼流程
          const effectivePlan = {
            ...plan,
            excludes: [] as string[],
          };
          notes.push(`搜索词: ${job.title} -> ${effectivePlan.keyword}`);
          const remaining = topContactCount > 0 ? topContactCount - contactedInRun : config.search.maxCandidatesPerQuery;
          const queryLimit = Math.min(config.search.maxCandidatesPerQuery, remaining > 0 ? remaining : config.search.maxCandidatesPerQuery);
          const snapshots = await page.runQuery(effectivePlan, queryLimit);
          const filtered = config.search.northeastOnly ? snapshots.filter(isNortheastCandidateSnapshot) : snapshots;
          if (config.search.northeastOnly) {
            notes.push(`东北过滤: 原始${snapshots.length}，保留${filtered.length}`);
          }
          const contacted = await processSnapshots(browser, filtered, job, "search", config, state, summary);
          contactedInRun += contacted;
        }
      }
    },
    { keepBrowserOpen: keepOpen },
  );

  if (keepOpen && runner && searchRunOptions?.loopMode !== true) {
    console.log("[搜索人才] 任务已结束，浏览器保持打开。在终端按 Enter 关闭浏览器并退出。");
    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("", () => {
        rl.close();
        resolve();
      });
    });
    await runner.stop();
  }
}

/**
 * 仅连接「搜索人才」与「互动」两个标签页：同一浏览器内先跑一轮搜索，再跑一轮互动，然后重复。
 * 人数上限分别由 `search.maxCandidatesPerQuery` 与 `interaction.unreadLimit` 控制。
 */
async function runSearchInteractionLoop(config: RecruitAgentConfig, state: RecruitAgentState): Promise<void> {
  const sharedBrowser = new ZhilianBrowserRunner(config);
  const loopRunWithBrowser: RunWithBrowserFn = (command, cfg, st, callback, opts) =>
    runWithBrowser(command, cfg, st, callback, {
      ...opts,
      sharedBrowser,
      keepBrowserOpen: true,
    });

  const maxRounds = config.searchInteractionLoop?.maxRounds ?? 0;
  let round = 0;

  console.log("[搜索↔互动] 往返循环已启动（同一浏览器会话，Ctrl+C 可结束）");
  if (maxRounds > 0) {
    console.log(`[搜索↔互动] maxRounds=${maxRounds}，达到后轮询结束`);
  } else {
    console.log("[搜索↔互动] maxRounds=0（未配置），无限循环直到进程退出");
  }

  try {
    while (true) {
      round += 1;
      console.log(`\n========== [搜索↔互动] 第 ${round} 轮 ==========`);

      await runSearch(config, state, loopRunWithBrowser, { loopMode: true });

      if (!config.automation.autoWorkEnabled) {
        console.log("[搜索↔互动] automation.autoWorkEnabled=false，跳过互动区，直接进入下一轮搜索");
      } else {
        await runInteraction(config, state, loopRunWithBrowser);
      }

      await saveState(config.storage.stateFile, state);

      if (maxRounds > 0 && round >= maxRounds) {
        console.log(`[搜索↔互动] 已完成 ${maxRounds} 轮，结束循环`);
        break;
      }
    }
  } finally {
    await sharedBrowser.stop();
  }
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
  if (!config.automation.autoWorkEnabled) {
    console.log("[互动处理] 已关闭自动干活开关，跳过互动区自动交流与简历下载。");
    return;
  }
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
): Promise<number> {
  let contacted = 0;
  for (const snapshot of snapshots) {
    const candidate = upsertScoredCandidate(snapshot, job, config, state, summary, pageName);
    if (pageName === "search") {
      recordAction(candidate, "search_executed", `搜索页命中候选人: ${candidate.name}`);
    }
    // 搜索人才：关键词列表即触达目标，不因匹配分 / excludeKeywords / denyList / 冷却 / 每日上限 拦截（与「搜到就打、要简历」一致）
    const forceContact = pageName === "search";

    if (!forceContact && isProtectedStatus(candidate.status)) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", `候选人处于推进态(${candidate.status})，本轮不重复触达`);
      continue;
    }

    if (!forceContact && isDeniedCandidateName(candidate.name, config)) {
      setCandidateStatus(candidate, "do_not_contact");
      recordAction(candidate, "skipped", "候选人姓名命中 denyList");
      summary.skipped += 1;
      continue;
    }

    if (!forceContact && candidate.score?.recommendedAction === "manual_review") {
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

    if (!forceContact && candidate.score?.recommendedAction !== "contact") {
      summary.skipped += 1;
      continue;
    }

    if (!forceContact && useHigherThreshold && (candidate.score?.total ?? 0) < config.guardrails.autoContactScoreMin + 5) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", "潜在人才页使用更高阈值，未自动联系");
      continue;
    }

    if (!forceContact && shouldCooldownCandidate(candidate, config)) {
      summary.skipped += 1;
      recordAction(candidate, "skipped", "候选人仍在冷却期");
      continue;
    }

    if (!forceContact) {
      const guardrailResult = canContactNow(state, config);
      if (!guardrailResult.ok) {
        summary.skipped += 1;
        recordAction(candidate, "skipped", guardrailResult.reason);
        break;
      }
    }

    const messagePlan = buildMessagePlan(candidate, job, config);
    const messagesToSend =
      pageName === "search" && config.search.sendResumeRequestAfterOpening
        ? [messagePlan.opening, messagePlan.resumeRequest]
        : [messagePlan.opening];
    if (config.dryRun) {
      recordAction(candidate, "contacted", `dryRun: ${pageName} 未实际发送(${messagesToSend.length}条消息)`);
    } else {
      try {
        const actualSentMessages = await browser.sendMessages(snapshot, messagesToSend);
        const delayMs = await applySendDelay(config);
        recordAction(candidate, "contacted", `已发送首轮消息(${actualSentMessages.length}条)，延迟 ${delayMs}ms`);
        for (const sent of actualSentMessages) {
          appendConversation(candidate, "agent", sent);
        }
      } catch (error) {
        summary.skipped += 1;
        recordAction(
          candidate,
          "error",
          `发送失败，跳过当前候选人: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }

    if (config.dryRun) {
      for (const sent of messagesToSend) {
        appendConversation(candidate, "agent", sent);
      }
    }
    candidate.lastContactedAt = nowIso();
    candidate.followUpDueAt = nextFollowUpAt(config);
    setCandidateStatus(candidate, "contacted");
    markContactCounters(state);
    summary.autoContacted += 1;
    contacted += 1;
  }
  return contacted;
}

function isNortheastCandidateSnapshot(snapshot: BrowserCandidateSnapshot): boolean {
  const northeastHints = [
    "东北",
    "辽宁",
    "吉林",
    "黑龙江",
    "沈阳",
    "大连",
    "长春",
    "吉林市",
    "哈尔滨",
    "齐齐哈尔",
    "鞍山",
    "抚顺",
    "本溪",
    "丹东",
    "锦州",
    "营口",
    "阜新",
    "辽阳",
    "盘锦",
    "铁岭",
    "朝阳",
    "葫芦岛",
    "四平",
    "辽源",
    "通化",
    "白山",
    "松原",
    "白城",
    "延边",
    "牡丹江",
    "佳木斯",
    "鸡西",
    "鹤岗",
    "双鸭山",
    "大庆",
    "伊春",
    "七台河",
    "黑河",
    "绥化",
    "大兴安岭",
  ];
  const text = [snapshot.location, snapshot.summary, snapshot.currentCompany, snapshot.currentTitle, snapshot.tags.join(" ")]
    .filter(Boolean)
    .join(" ");
  return northeastHints.some((hint) => text.includes(hint));
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

function commandLabel(command: string): string {
  const map: Record<string, string> = {
    "jobs:sync": "职位同步",
    "recommend:run": "推荐人才",
    "search:run": "搜索人才",
    "potential:run": "潜在人才",
    "interaction:run": "互动处理",
    "workflow:run": "全流程",
    "search-interaction:loop": "搜索互动循环",
    "daemon:run": "守护进程",
    "report:daily": "日报生成",
  };
  return map[command] ?? command;
}

function printSummary(command: string, summary: AgentRunSummary): void {
  const label = commandLabel(command);
  console.log(`[${label}] 同步职位数=${summary.jobsSynced}`);
  console.log(`[${label}] 发现候选人数=${summary.discovered}`);
  console.log(`[${label}] 完成评分数=${summary.scored}`);
  console.log(`[${label}] 自动触达人数=${summary.autoContacted}`);
  console.log(`[${label}] 进入人工复核数=${summary.manualReview}`);
  console.log(`[${label}] 跳过处理数=${summary.skipped}`);
  console.log(`[${label}] 跟进回复数=${summary.followUps}`);
  console.log(`[${label}] 转人工数=${summary.handovers}`);
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
