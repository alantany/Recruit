import { appendActionLog } from "./action-log-store.js";
import { decideDialogueAction, decideDialogueActionByRules, type DialogueDecision } from "./dialogue-policy.js";
import { applySendDelay, canContactNow } from "./guardrails.js";
import { appendInteractionAudit } from "./interaction-audit-store.js";
import { buildClosingMessage, buildMessagePlan, nextFollowUpAt } from "./message-engine.js";
import { saveResumeEvidence } from "./resume-store.js";
import {
  addManualHandover,
  appendConversation,
  hasHandledInteraction,
  listCandidates,
  markHandledInteraction,
  markContactCounters,
  recordAction,
  setCandidateStatus,
} from "./store.js";
import type { AgentRunSummary, CandidateProfile, JobDefinition, RecruitAgentConfig, RecruitAgentState, InteractionThreadSnapshot } from "./types.js";
import { nowIso } from "./utils.js";
import type { ZhilianBrowserRunner } from "./browser/zhilian.js";

type BrowserCallback = (
  browser: ZhilianBrowserRunner,
  summary: AgentRunSummary,
  notes: string[],
) => Promise<void>;

type RunWithBrowserFn = (
  command: string,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  callback: BrowserCallback,
  options?: {
    sharedBrowser?: ZhilianBrowserRunner;
    keepBrowserOpen?: boolean;
  },
) => Promise<void>;

export async function runInteractionCommand(
  runWithBrowser: RunWithBrowserFn,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  resolveJobForCandidate: (candidate: CandidateProfile, state: RecruitAgentState, config: RecruitAgentConfig) => JobDefinition,
): Promise<void> {
  await runWithBrowser("interaction:run", config, state, async (browser, summary, notes) => {
    const page = await browser.interactionPage();
    const fallbackLimit = Math.min(config.interaction.unreadLimit, 20);

    // 单遍处理：阶段一找未读立即处理，阶段二无未读时从顶部顺序处理
    await page.processConversations(
      config.interaction.unreadLimit,
      fallbackLimit,
      async (thread, sendReply, isFallback) => {
        await processThread(thread, sendReply, isFallback, { page, config, state, summary, notes, resolveJobForCandidate });
      },
    );

    // 到期跟进：处理超过跟进时间的候选人（需重新定位会话，与主扫描逻辑隔离）
    await processDueCandidates(page, config, state, summary, resolveJobForCandidate);
  });
}

// 处理单个会话的所有业务逻辑
async function processThread(
  thread: InteractionThreadSnapshot,
  sendReply: (msg: string) => Promise<void>,
  isFallback: boolean,
  ctx: {
    page: Awaited<ReturnType<ZhilianBrowserRunner["interactionPage"]>>;
    config: RecruitAgentConfig;
    state: RecruitAgentState;
    summary: AgentRunSummary;
    notes: string[];
    resolveJobForCandidate: (c: CandidateProfile, s: RecruitAgentState, cfg: RecruitAgentConfig) => JobDefinition;
  },
): Promise<void> {
  const { config, state, summary, notes, resolveJobForCandidate } = ctx;

  const audit = async (params: {
    action: string;
    candidateId?: string;
    candidateStatus?: string;
    intent?: string;
    replyText?: string;
    reason?: string;
  }) => {
    await appendInteractionAudit(config, {
      candidateId: params.candidateId,
      candidateName: thread.candidateName,
      threadKey: thread.threadKey,
      candidateStatus: params.candidateStatus,
      intent: params.intent,
      action: params.action,
      replyText: params.replyText,
      reason: params.reason,
      hasResumeAttachmentCard: thread.hasResumeAttachmentCard,
      latestCandidateReply: thread.latestCandidateReply || thread.latestReply,
      allMessages: thread.allMessages,
    });
    await appendActionLog(config, {
      command: "interaction:run",
      phase: "event",
      message: `互动动作: ${params.action}`,
      candidateId: params.candidateId,
      candidateName: thread.candidateName,
      threadKey: thread.threadKey,
      meta: {
        intent: params.intent ?? null,
        candidateStatus: params.candidateStatus ?? null,
        hasResumeAttachmentCard: thread.hasResumeAttachmentCard,
      },
    });
  };

  // 核心门控：只有最后一条消息是对方发的，才允许触发回复
  // lastSenderIsAgent 由 DOM 类名 --me 直接判断，比话术前缀匹配更可靠
  const lastSenderIsAgent = thread.lastSenderIsAgent ?? false;

  const candidate = resolveCandidateForThread(state, thread.candidateName, thread.latestReply);

  // --- 简历下载独立逻辑（不受回复门控限制，即使我方最后发言也需要下载简历） ---
  if (thread.hasResumeAttachmentCard) {
    const resumeSignature = (thread.latestCandidateReply || thread.latestReply).slice(0, 80) || "attached-resume";
    const resumeKey = `resume_download:${candidate?.id || "unknown"}:${thread.candidateName}:${resumeSignature}`;
    if (!hasHandledInteraction(state, resumeKey)) {
      const parts = [thread.candidateName, thread.jobTitle || "岗位"];
      if (thread.gender && thread.gender !== "未知") parts.push(thread.gender);
      if (thread.age && thread.age !== "未知") parts.push(thread.age);
      const prefix = parts.join("-");
      const savedFilePath = await ctx.page.downloadResume(prefix);
      if (savedFilePath) {
        markHandledInteraction(state, resumeKey);
        if (candidate) {
          candidate.resumeAssetPaths = [...new Set([...(candidate.resumeAssetPaths ?? []), savedFilePath])];
          recordAction(candidate, "resume_downloaded", `自动下载简历成功: ${savedFilePath}`);
        }
        notes.push(`自动下载简历: ${thread.candidateName} -> ${savedFilePath}`);
        const { saveState } = await import("./store.js");
        await saveState(config.storage.stateFile, state);
      }
    }
  }

  // 最后一条是我方消息 → 不触发回复逻辑，直接退出
  if (lastSenderIsAgent) {
    await audit({ action: "skip_agent_last_message", reason: "最后一条是我方消息，不触发回复" });
    return;
  }


  const unknownReplyKey = buildInteractionReplyKey(undefined, thread);
  if (hasHandledInteraction(state, unknownReplyKey)) {
    await audit({ action: "skip_handled_duplicate", reason: "已处理过相同消息" });
    return;
  }

  // 针对未知候选人，也尝试判断意图，避免对拒绝沟通的人索要简历
  const dialogueContext = {
    candidateName: candidate?.name || thread.candidateName,
    currentStatus: candidate?.status || "unknown",
    companyName: ctx.resolveJobForCandidate({ id: "unknown" } as any, state, config).companyName,
    jobTitle: thread.jobTitle || "待定岗位",
    latestReply: thread.latestReply,
    hasResumeAttachmentCard: thread.hasResumeAttachmentCard,
    history: candidate?.conversations ?? [],
  };

  const decision: DialogueDecision = await decideDialogueAction(dialogueContext, config);

  if (!candidate) {
    // 场景：未知候选人且明确拒绝 -> 记录并跳过
    if (decision.intent === "negative") {
      await audit({ action: "unknown_candidate_rejected", intent: "negative", reason: "拒绝沟通" });
      markHandledInteraction(state, unknownReplyKey);
      const { saveState } = await import("./store.js");
      await saveState(config.storage.stateFile, state);
      return;
    }

    // 未建档候选人：已发简历则致谢转人工，否则索要简历
    if (thread.hasResumeAttachmentCard) {
      const ackMsg = config.messages.resumeReceivedAck || "感谢您对公司的认可，我们已经收到您的简历，后续会有人事专员与您对接，请保持您的手机畅通。";
      await doSendReply(sendReply, ackMsg, config);
      await audit({ action: "reply_resume_ack_unknown_candidate", replyText: ackMsg });
      addManualHandover(state, {
        candidateId: `unknown-${thread.candidateName}`,
        candidateName: thread.candidateName,
        reason: "未建档候选人已发简历，转人工跟进",
        latestMessage: thread.latestReply,
        createdAt: nowIso(),
      });
      markHandledInteraction(state, unknownReplyKey);
      const { saveState } = await import("./store.js");
      await saveState(config.storage.stateFile, state);
      summary.handovers += 1;
      notes.push(`简历致谢转人工(未建档): ${thread.candidateName}`);
      return;
    }

    const msg = config.messages.resumeRequest;
    await doSendReply(sendReply, msg, config);
    await audit({ action: "reply_resume_request_unknown_candidate", replyText: msg });
    markHandledInteraction(state, unknownReplyKey);
    const { saveState } = await import("./store.js");
    await saveState(config.storage.stateFile, state);
    summary.followUps += 1;
    notes.push(`索要简历(未建档): ${thread.candidateName}`);
    return;
  }

  const replyKey = buildInteractionReplyKey(candidate.id, thread);
  if (isFallback && hasHandledInteraction(state, replyKey)) {
    await audit({ action: "skip_handled_duplicate_known_candidate", candidateId: candidate.id, candidateStatus: candidate.status, reason: "兜底扫描已处理" });
    return;
  }

  const job = resolveJobForCandidate(candidate, state, config);
  candidate.conversationThreadKey = thread.threadKey;
  candidate.latestReply = thread.latestReply;
  appendConversation(candidate, "candidate", thread.latestReply);
  recordAction(candidate, "replied", "互动页检测到消息");

  // 场景5：已发简历后继续追问 → 回复"请稍等"并转人工
  if (candidate.status === "resume_received" || candidate.status === "needs_human_takeover") {
    setCandidateStatus(candidate, "needs_human_takeover");
    await doSendReplyForCandidate(sendReply, candidate, config.messages.handover, config);
    await audit({ action: "reply_please_wait_and_handover_after_resume", candidateId: candidate.id, candidateStatus: candidate.status, intent: "resume_sent", replyText: config.messages.handover, reason: "已发简历后继续追问" });
    addManualHandover(state, { candidateId: candidate.id, candidateName: candidate.name, reason: "候选人在发简历后继续追问，需要人工接手", latestMessage: thread.latestReply, createdAt: nowIso() });
    recordAction(candidate, "manual_takeover", "已发送转人工提示");
    markHandledInteraction(state, replyKey);
    const { saveState } = await import("./store.js");
    await saveState(config.storage.stateFile, state);
    summary.followUps += 1;
    summary.handovers += 1;
    return;
  }

  candidate.replyIntent = decision.intent;

  // 未收到简历前，无论意图如何都先索要简历
  if (decision.shouldHandover) {
    const messages = buildMessagePlan(candidate, job, config);
    setCandidateStatus(candidate, "resume_requested");
    await doSendReplyForCandidate(sendReply, candidate, messages.resumeRequest, config);
    await audit({ action: "reply_resume_request_instead_of_handover", candidateId: candidate.id, candidateStatus: candidate.status, intent: decision.intent, replyText: messages.resumeRequest, reason: decision.reason });
    markContactCounters(state);
    recordAction(candidate, "followed_up", `意图(${decision.intent})先索要简历`);
    markHandledInteraction(state, replyKey);
    const { saveState } = await import("./store.js");
    await saveState(config.storage.stateFile, state);
    summary.followUps += 1;
    return;
  }

  // 场景4：候选人发了简历 → 致谢并转人工
  if (decision.intent === "resume_sent") {
    const savedPath = await saveResumeEvidence(candidate, thread.latestReply, thread.allMessages, thread.threadKey, config);
    candidate.resumeAssetPaths = [...new Set([...(candidate.resumeAssetPaths ?? []), savedPath])];
    setCandidateStatus(candidate, "resume_received");
    recordAction(candidate, "followed_up", `已保存简历线索: ${savedPath}`);
    const messages = buildMessagePlan(candidate, job, config);
    await doSendReplyForCandidate(sendReply, candidate, messages.resumeReceivedAck, config);
    await audit({ action: "reply_resume_ack_and_mark_handover", candidateId: candidate.id, candidateStatus: candidate.status, intent: decision.intent, replyText: messages.resumeReceivedAck, reason: decision.reason });
    addManualHandover(state, { candidateId: candidate.id, candidateName: candidate.name, reason: "候选人已发送简历，等待人工跟进", latestMessage: thread.latestReply, createdAt: nowIso() });
    markHandledInteraction(state, replyKey);
    const { saveState } = await import("./store.js");
    await saveState(config.storage.stateFile, state);
    summary.handovers += 1;
    return;
  }

  // 场景3：明确拒绝 → 礼貌结束
  if (decision.intent === "negative") {
    if (candidate.status === "not_interested_reasoned") {
      recordAction(candidate, "skipped", "候选人已关闭，无需重复回复");
      markHandledInteraction(state, replyKey);
      const { saveState } = await import("./store.js");
      await saveState(config.storage.stateFile, state);
      return;
    }
    setCandidateStatus(candidate, "not_interested_reasoned");
    candidate.rejectionReason = thread.latestReply;
    if (decision.shouldReply) {
      const closing = buildClosingMessage(candidate, job, config);
      await doSendReplyForCandidate(sendReply, candidate, closing, config);
      await audit({ action: "reply_rejection_closing", candidateId: candidate.id, candidateStatus: candidate.status, intent: decision.intent, replyText: closing, reason: decision.reason });
      markContactCounters(state);
      markHandledInteraction(state, replyKey);
      const { saveState } = await import("./store.js");
      await saveState(config.storage.stateFile, state);
      summary.followUps += 1;
    }
    return;
  }

  // 场景2：有回复但未发简历（positive / unknown / question / sensitive）→ 索要简历
  const messages = buildMessagePlan(candidate, job, config);
  setCandidateStatus(candidate, "resume_requested");
  await doSendReplyForCandidate(sendReply, candidate, messages.resumeRequest, config);
  await audit({ action: "reply_resume_request_default", candidateId: candidate.id, candidateStatus: candidate.status, intent: decision.intent, replyText: messages.resumeRequest, reason: decision.reason });
  markContactCounters(state);
  recordAction(candidate, "followed_up", `未收到简历，索要简历: ${decision.intent}`);
  markHandledInteraction(state, replyKey);
  const { saveState } = await import("./store.js");
  await saveState(config.storage.stateFile, state);
  summary.followUps += 1;
}

// 到期跟进处理（需重新定位会话）
async function processDueCandidates(
  page: Awaited<ReturnType<ZhilianBrowserRunner["interactionPage"]>>,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  summary: AgentRunSummary,
  resolveJobForCandidate: (c: CandidateProfile, s: RecruitAgentState, cfg: RecruitAgentConfig) => JobDefinition,
): Promise<void> {
  const dueCandidates = listCandidates(state).filter((candidate) => {
    return (
      ["contacted", "resume_requested", "awaiting_reply"].includes(candidate.status) &&
      Boolean(candidate.followUpDueAt) &&
      new Date(candidate.followUpDueAt!).getTime() <= Date.now()
    );
  });

  for (const candidate of dueCandidates) {
    if (!candidate.conversationThreadKey) {
      addManualHandover(state, { candidateId: candidate.id, candidateName: candidate.name, reason: "到期跟进但找不到会话映射", latestMessage: candidate.latestReply ?? "", createdAt: nowIso() });
      setCandidateStatus(candidate, "needs_human_takeover");
      summary.handovers += 1;
      continue;
    }

    const guardrailResult = canContactNow(state, config);
    if (!guardrailResult.ok) {
      recordAction(candidate, "skipped", guardrailResult.reason);
      break;
    }

    const job = resolveJobForCandidate(candidate, state, config);
    const messages = buildMessagePlan(candidate, job, config);
    const threadIndex = await page.findThreadIndex(candidate.conversationThreadKey, candidate.name);
    if (typeof threadIndex !== "number") {
      addManualHandover(state, { candidateId: candidate.id, candidateName: candidate.name, reason: "到期跟进时无法重新定位会话", latestMessage: candidate.latestReply ?? "", createdAt: nowIso() });
      setCandidateStatus(candidate, "needs_human_takeover");
      summary.handovers += 1;
      continue;
    }

    await applySendDelay(config);
    await page.replyToThread(threadIndex, messages.followUp);
    appendConversation(candidate, "agent", messages.followUp);
    candidate.lastContactedAt = nowIso();
    candidate.followUpDueAt = nextFollowUpAt(config);
    recordAction(candidate, "followed_up", "互动页到期自动跟进一次");
    summary.followUps += 1;
    markContactCounters(state);
  }
}

// 发送回复：加人类延迟，并更新 candidate 会话记录
async function doSendReplyForCandidate(
  sendReply: (msg: string) => Promise<void>,
  candidate: CandidateProfile,
  message: string,
  config: RecruitAgentConfig,
): Promise<void> {
  if (!config.dryRun) {
    await applySendDelay(config);
    await sendReply(message);
  } else {
    recordAction(candidate, "followed_up", "dryRun: 互动页未实际发送");
  }
  appendConversation(candidate, "agent", message);
  candidate.lastContactedAt = nowIso();
  candidate.followUpDueAt = nextFollowUpAt(config);
}

// 发送回复（无候选人档案时使用）
async function doSendReply(
  sendReply: (msg: string) => Promise<void>,
  message: string,
  config: RecruitAgentConfig,
): Promise<void> {
  if (!config.dryRun) {
    await applySendDelay(config);
    await sendReply(message);
  }
}

function buildInteractionReplyKey(candidateId: string | undefined, thread: InteractionThreadSnapshot): string {
  const base = candidateId ? `candidate:${candidateId}` : `candidate_name:${thread.candidateName}`;
  const content = (thread.latestCandidateReply || thread.latestReply || "").slice(0, 120);
  return `${base}::${content}`;
}

function isLikelyAgentOutboundMessage(reply: string, config: RecruitAgentConfig): boolean {
  const normalized = reply.trim();
  const templates = [
    config.messages.opening,
    config.messages.resumeRequest,
    config.messages.followUp,
    config.messages.rejection,
    config.messages.handover,
    config.messages.resumeReceivedAck,
  ]
    .map((item) => item?.trim())
    .filter(Boolean) as string[];

  return templates.some((template) => template === normalized || normalized.includes(template.slice(0, 14)));
}

function resolveCandidateForThread(
  state: RecruitAgentState,
  candidateName: string,
  latestReply: string,
): CandidateProfile | undefined {
  const sameNameCandidates = listCandidates(state).filter((candidate) => candidate.name === candidateName);
  if (sameNameCandidates.length === 1) {
    return sameNameCandidates[0];
  }

  if (sameNameCandidates.length > 1) {
    const active = sameNameCandidates.filter((candidate) =>
      ["resume_requested", "awaiting_reply", "contacted", "resume_received"].includes(candidate.status),
    );
    if (active.length === 1) {
      return active[0];
    }

    const byReplyHint = sameNameCandidates.find((candidate) => {
      return Boolean(candidate.latestReply) && latestReply.includes(candidate.latestReply!.slice(0, 8));
    });
    if (byReplyHint) {
      return byReplyHint;
    }

    return undefined;
  }

  return listCandidates(state).find((candidate) => candidateName.length > 1 && candidate.name.includes(candidateName));
}
