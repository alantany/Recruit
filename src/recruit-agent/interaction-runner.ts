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
import type { AgentRunSummary, CandidateProfile, JobDefinition, RecruitAgentConfig, RecruitAgentState } from "./types.js";
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

interface InteractionThreadLike {
  threadKey: string;
  threadIndex: number;
  candidateName: string;
  latestReply: string;
  latestCandidateReply: string;
  hasResumeAttachmentCard: boolean;
  allMessages: string[];
}

export async function runInteractionCommand(
  runWithBrowser: RunWithBrowserFn,
  config: RecruitAgentConfig,
  state: RecruitAgentState,
  resolveJobForCandidate: (candidate: CandidateProfile, state: RecruitAgentState, config: RecruitAgentConfig) => JobDefinition,
): Promise<void> {
  await runWithBrowser("interaction:run", config, state, async (browser, summary, notes) => {
    const page = await browser.interactionPage();
    let threads = await page.scanUnread(config.interaction.unreadLimit);
    let fallbackMode = false;
    if (threads.length === 0) {
      // 无未读时，兜底扫描最近会话，避免漏掉未回复消息。
      threads = await page.scanRecentNoUnread(config.interaction.unreadLimit);
      fallbackMode = true;
      if (threads.length > 0) {
        notes.push(`未读为0，进入兜底会话扫描: ${threads.length} 条`);
      }
    }

    for (const thread of threads) {
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

      const fallbackDecision = fallbackMode ? decideDialogueActionByRules(thread.latestReply, config) : undefined;
      if (fallbackMode && isLikelyAgentOutboundMessage(thread.latestReply, config)) {
        await audit({ action: "skip_agent_outbound_message", reason: "兜底扫描跳过我方消息" });
        continue;
      }
      const unknownReplyKey = buildInteractionReplyKey(undefined, thread);
      if (hasHandledInteraction(state, unknownReplyKey)) {
        await audit({ action: "skip_handled_duplicate", reason: "已处理过相同消息" });
        continue;
      }
      const candidate = resolveCandidateForThread(state, thread.candidateName, thread.latestReply);
      if (!candidate) {
        const unknownAction = fallbackMode
          ? pickFallbackUnknownAction(fallbackDecision?.intent, thread.hasResumeAttachmentCard)
          : "none";
        if (unknownAction === "rejection") {
          if (!config.dryRun) {
            await sendThreadReplyWithHumanDelay(page, thread.threadIndex, config.messages.rejection, config);
          }
          await audit({
            action: "reply_rejection_unknown_candidate",
            intent: fallbackDecision?.intent,
            replyText: config.messages.rejection,
          });
          markHandledInteraction(state, unknownReplyKey);
          summary.followUps += 1;
          notes.push(`兜底回复(未建档候选人): ${thread.candidateName}`);
          continue;
        }
        if (unknownAction === "resume_request") {
          const message = config.messages.resumeRequest;
          if (!config.dryRun) {
            await sendThreadReplyWithHumanDelay(page, thread.threadIndex, message, config);
          }
          await audit({
            action: "reply_resume_request_unknown_candidate",
            intent: fallbackDecision?.intent,
            replyText: message,
          });
          markHandledInteraction(state, unknownReplyKey);
          summary.followUps += 1;
          notes.push(`兜底索要简历(未建档候选人): ${thread.candidateName}`);
          continue;
        }
        if (unknownAction === "handover") {
          const message = config.messages.resumeReceivedAck || "已收到你的简历，感谢配合。我会尽快和招聘负责人同步并给你反馈。";
          if (!config.dryRun) {
            await sendThreadReplyWithHumanDelay(page, thread.threadIndex, message, config);
          }
          await audit({
            action: "reply_resume_ack_and_handover_unknown_candidate",
            intent: fallbackDecision?.intent,
            replyText: message,
          });
          markHandledInteraction(state, unknownReplyKey);
          addManualHandover(state, {
            candidateId: `unknown-${thread.threadKey}`,
            candidateName: thread.candidateName,
            reason: "候选人发送简历后继续追问或需人工接管",
            latestMessage: thread.latestReply,
            createdAt: nowIso(),
          });
          summary.handovers += 1;
          notes.push(`兜底转人工(未建档候选人): ${thread.candidateName}`);
          continue;
        }

        // 未建档候选人默认先索要简历，只有“已收到简历”相关场景才转人工。
        const message = config.messages.resumeRequest;
        if (!config.dryRun) {
          await sendThreadReplyWithHumanDelay(page, thread.threadIndex, message, config);
        }
        await audit({
          action: "reply_resume_request_unknown_candidate_default",
          intent: fallbackDecision?.intent,
          replyText: message,
        });
        markHandledInteraction(state, unknownReplyKey);
        summary.followUps += 1;
        notes.push(`兜底索要简历(未建档候选人-默认): ${thread.candidateName}`);
        continue;
      }

      const replyKey = buildInteractionReplyKey(candidate.id, thread);
      if (fallbackMode && hasHandledInteraction(state, replyKey)) {
        await audit({
          action: "skip_handled_duplicate_known_candidate",
          candidateId: candidate.id,
          candidateStatus: candidate.status,
          reason: "兜底扫描已处理",
        });
        continue;
      }

      const job = resolveJobForCandidate(candidate, state, config);
      candidate.conversationThreadKey = thread.threadKey;
      candidate.latestReply = thread.latestReply;
      appendConversation(candidate, "candidate", thread.latestReply);
      recordAction(candidate, "replied", "互动页检测到未读消息");

      if (candidate.status === "resume_received" || candidate.status === "needs_human_takeover") {
        setCandidateStatus(candidate, "needs_human_takeover");
        await sendInteractionReply(page, candidate, thread.threadIndex, config.messages.handover, config);
        await audit({
          action: "reply_please_wait_and_handover_after_resume",
          candidateId: candidate.id,
          candidateStatus: candidate.status,
          intent: "resume_sent",
          replyText: config.messages.handover,
          reason: "已发简历后继续追问",
        });
        addManualHandover(state, {
          candidateId: candidate.id,
          candidateName: candidate.name,
          reason: "候选人在发简历后继续追问，需要人工接手",
          latestMessage: thread.latestReply,
          createdAt: nowIso(),
        });
        recordAction(candidate, "manual_takeover", "已发送转人工提示");
        markHandledInteraction(state, replyKey);
        summary.followUps += 1;
        summary.handovers += 1;
        continue;
      }

      const decision: DialogueDecision = await decideDialogueAction(
        {
          candidateName: candidate.name,
          currentStatus: candidate.status,
          companyName: job.companyName,
          jobTitle: job.title,
          latestReply: thread.latestReply,
          hasResumeAttachmentCard: thread.hasResumeAttachmentCard,
          history: candidate.conversations ?? [],
        },
        config,
      );
      candidate.replyIntent = decision.intent;

      if (decision.shouldHandover) {
        // 按业务硬规则：未收到简历前，不转人工，统一先索要简历。
        const messages = buildMessagePlan(candidate, job, config);
        setCandidateStatus(candidate, "resume_requested");
        await sendInteractionReply(page, candidate, thread.threadIndex, messages.resumeRequest, config);
        await audit({
          action: "reply_resume_request_instead_of_handover",
          candidateId: candidate.id,
          candidateStatus: candidate.status,
          intent: decision.intent,
          replyText: messages.resumeRequest,
          reason: decision.reason,
        });
        markContactCounters(state);
        recordAction(candidate, "followed_up", `意图(${decision.intent})先索要简历: ${decision.reason}`);
        markHandledInteraction(state, replyKey);
        summary.followUps += 1;
        continue;
      }

      if (decision.intent === "resume_sent") {
        const savedPath = await saveResumeEvidence(
          candidate,
          thread.latestReply,
          thread.allMessages,
          thread.threadKey,
          config,
        );
        candidate.resumeAssetPaths = [...new Set([...(candidate.resumeAssetPaths ?? []), savedPath])];
        setCandidateStatus(candidate, "resume_received");
        recordAction(candidate, "followed_up", `已保存简历线索: ${savedPath}`);

        const messages = buildMessagePlan(candidate, job, config);
        await sendInteractionReply(page, candidate, thread.threadIndex, messages.resumeReceivedAck, config);
        await audit({
          action: "reply_resume_ack_and_mark_handover",
          candidateId: candidate.id,
          candidateStatus: candidate.status,
          intent: decision.intent,
          replyText: messages.resumeReceivedAck,
          reason: decision.reason,
        });
        addManualHandover(state, {
          candidateId: candidate.id,
          candidateName: candidate.name,
          reason: "候选人已发送简历，等待人工跟进",
          latestMessage: thread.latestReply,
          createdAt: nowIso(),
        });
        markHandledInteraction(state, replyKey);
        summary.handovers += 1;
        continue;
      }

      if (decision.intent === "negative") {
        if (candidate.status === "not_interested_reasoned") {
          recordAction(candidate, "skipped", "候选人已关闭，无需重复回复");
          markHandledInteraction(state, replyKey);
          continue;
        }
        setCandidateStatus(candidate, "not_interested_reasoned");
        candidate.rejectionReason = thread.latestReply;
        if (decision.shouldReply) {
          const closing = buildClosingMessage(candidate, job, config);
          await sendInteractionReply(page, candidate, thread.threadIndex, closing, config);
          await audit({
            action: "reply_rejection_closing",
            candidateId: candidate.id,
            candidateStatus: candidate.status,
            intent: decision.intent,
            replyText: closing,
            reason: decision.reason,
          });
          markContactCounters(state);
          markHandledInteraction(state, replyKey);
          summary.followUps += 1;
        }
        continue;
      }

      if (decision.intent === "positive") {
        if (candidate.status === "contacted" || candidate.status === "awaiting_reply") {
          setCandidateStatus(candidate, "resume_requested");
        } else {
          setCandidateStatus(candidate, "awaiting_reply");
        }

        if (decision.shouldRequestResume) {
          const messages = buildMessagePlan(candidate, job, config);
          await sendInteractionReply(page, candidate, thread.threadIndex, messages.resumeRequest, config);
          await audit({
            action: "reply_resume_request_positive",
            candidateId: candidate.id,
            candidateStatus: candidate.status,
            intent: decision.intent,
            replyText: messages.resumeRequest,
            reason: decision.reason,
          });
          markContactCounters(state);
          markHandledInteraction(state, replyKey);
          summary.followUps += 1;
        }
      }

      // unknown/question/sensitive 等非拒绝场景：只要未收到简历，一律先索要简历。
      const messages = buildMessagePlan(candidate, job, config);
      setCandidateStatus(candidate, "resume_requested");
      await sendInteractionReply(page, candidate, thread.threadIndex, messages.resumeRequest, config);
      await audit({
        action: "reply_resume_request_default",
        candidateId: candidate.id,
        candidateStatus: candidate.status,
        intent: decision.intent,
        replyText: messages.resumeRequest,
        reason: decision.reason,
      });
      markContactCounters(state);
      recordAction(candidate, "followed_up", `未收到简历，默认索要简历: ${decision.intent}`);
      markHandledInteraction(state, replyKey);
      summary.followUps += 1;
    }

    const dueCandidates = listCandidates(state).filter((candidate) => {
      return (
        ["contacted", "resume_requested", "awaiting_reply"].includes(candidate.status) &&
        Boolean(candidate.followUpDueAt) &&
        new Date(candidate.followUpDueAt!).getTime() <= Date.now()
      );
    });

    for (const candidate of dueCandidates) {
      if (!candidate.conversationThreadKey) {
        addManualHandover(state, {
          candidateId: candidate.id,
          candidateName: candidate.name,
          reason: "到期跟进但找不到会话映射",
          latestMessage: candidate.latestReply ?? "",
          createdAt: nowIso(),
        });
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
        addManualHandover(state, {
          candidateId: candidate.id,
          candidateName: candidate.name,
          reason: "到期跟进时无法重新定位会话",
          latestMessage: candidate.latestReply ?? "",
          createdAt: nowIso(),
        });
        setCandidateStatus(candidate, "needs_human_takeover");
        summary.handovers += 1;
        continue;
      }
      await sendInteractionReply(page, candidate, threadIndex, messages.followUp, config);
      recordAction(candidate, "followed_up", "互动页到期自动跟进一次");
      summary.followUps += 1;
      markContactCounters(state);
    }
  });
}

function pickFallbackUnknownAction(
  intent: string | undefined,
  hasResumeAttachmentCard = false,
): "none" | "rejection" | "resume_request" | "handover" {
  if (hasResumeAttachmentCard) {
    return "handover";
  }
  if (intent === "negative") {
    return "rejection";
  }
  if (intent === "positive") {
    return "resume_request";
  }
  if (intent === "sensitive") {
    return "resume_request";
  }

  return "resume_request";
}

function buildInteractionReplyKey(candidateId: string | undefined, thread: InteractionThreadLike): string {
  const base = candidateId ? `candidate:${candidateId}` : `thread:${thread.threadKey}`;
  return `${base}::${thread.latestReply.slice(0, 120)}`;
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

async function sendInteractionReply(
  page: Awaited<ReturnType<ZhilianBrowserRunner["interactionPage"]>>,
  candidate: CandidateProfile,
  threadIndex: number,
  message: string,
  config: RecruitAgentConfig,
): Promise<void> {
  if (config.dryRun) {
    recordAction(candidate, "followed_up", "dryRun: 互动页未实际发送");
  } else {
    await sendThreadReplyWithHumanDelay(page, threadIndex, message, config);
  }

  appendConversation(candidate, "agent", message);
  candidate.lastContactedAt = nowIso();
  candidate.followUpDueAt = nextFollowUpAt(config);
}

async function sendThreadReplyWithHumanDelay(
  page: Awaited<ReturnType<ZhilianBrowserRunner["interactionPage"]>>,
  threadIndex: number,
  message: string,
  config: RecruitAgentConfig,
): Promise<void> {
  // 和推荐/搜索一致，发送前引入随机停顿，降低机械化操作节奏。
  await applySendDelay(config);
  await page.replyToThread(threadIndex, message);
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
