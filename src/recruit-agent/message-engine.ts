import type { CandidateProfile, JobDefinition, RecruitAgentConfig } from "./types.js";
import { nowIso } from "./utils.js";

interface TemplateContext {
  companyName: string;
  jobTitle: string;
  matchedHighlights: string;
  name: string;
}

export interface OutboundMessagePlan {
  opening: string;
  resumeRequest: string;
  followUp: string;
  rejection: string;
  handover: string;
  resumeReceivedAck: string;
}

export function buildMessagePlan(
  candidate: CandidateProfile,
  job: JobDefinition,
  config: RecruitAgentConfig,
): OutboundMessagePlan {
  const matchedHighlights =
    candidate.score?.matchedKeywords.slice(0, 3).join("、") ||
    candidate.tags.slice(0, 3).join("、") ||
    "相关项目经历";

  const context: TemplateContext = {
    companyName: job.companyName || config.job.companyName,
    jobTitle: job.title || config.job.title,
    matchedHighlights,
    name: candidate.name || "你好",
  };

  return {
    opening: renderTemplate(config.messages.opening, context),
    resumeRequest: renderTemplate(config.messages.resumeRequest, context),
    followUp: renderTemplate(config.messages.followUp, context),
    rejection: renderTemplate(config.messages.rejection, context),
    handover: renderTemplate(config.messages.handover, context),
    resumeReceivedAck: renderTemplate(config.messages.resumeReceivedAck, context),
  };
}

export function shouldRequestResume(candidate: CandidateProfile): boolean {
  return candidate.status === "contacted" || candidate.status === "awaiting_reply";
}

export function nextFollowUpAt(config: RecruitAgentConfig, from = new Date()): string {
  const next = new Date(from.getTime() + config.guardrails.followUpAfterHours * 60 * 60 * 1000);
  return next.toISOString();
}

export function inferReplyIntent(reply: string): "positive" | "negative" | "resume_sent" | "unknown" {
  const normalized = reply.toLowerCase();
  if (normalized.includes("简历") || normalized.includes("附件")) {
    return "resume_sent";
  }

  if (
    normalized.includes("可以") ||
    normalized.includes("方便") ||
    normalized.includes("沟通") ||
    normalized.includes("了解")
  ) {
    return "positive";
  }

  if (
    normalized.includes("不考虑") ||
    normalized.includes("不合适") ||
    normalized.includes("暂时不看") ||
    normalized.includes("太远")
  ) {
    return "negative";
  }

  return "unknown";
}

export function buildClosingMessage(
  candidate: CandidateProfile,
  job: JobDefinition,
  config: RecruitAgentConfig,
): string {
  return buildMessagePlan(candidate, job, config).rejection;
}

export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: keyof TemplateContext) => {
    return context[key] ?? "";
  });
}

export function buildSystemNote(message: string): string {
  return `[system ${nowIso()}] ${message}`;
}
