import {
  buildInteractionLlmUserPrompt,
  INTERACTION_LLM_OUTPUT_EXAMPLE,
  INTERACTION_LLM_SYSTEM_PROMPT,
  type InteractionPromptMessage,
  type InteractionPromptContext,
  type LlmAction,
  type LlmIntent,
} from "./llm-interaction-prompt.js";
import type { ConversationTurn, DialogueIntent, RecruitAgentConfig } from "./types.js";
import { pickText } from "./utils.js";

export interface DialogueDecision {
  intent: DialogueIntent;
  shouldReply: boolean;
  shouldRequestResume: boolean;
  shouldClose: boolean;
  shouldHandover: boolean;
  reason: string;
}

export interface DialoguePolicyContext {
  candidateName: string;
  currentStatus: string;
  companyName: string;
  jobTitle: string;
  latestReply: string;
  hasResumeAttachmentCard: boolean;
  history: ConversationTurn[];
}

export async function decideDialogueAction(
  context: DialoguePolicyContext,
  config: RecruitAgentConfig,
): Promise<DialogueDecision> {
  if (context.hasResumeAttachmentCard) {
    return {
      intent: "resume_sent",
      shouldReply: false,
      shouldRequestResume: false,
      shouldClose: false,
      shouldHandover: false,
      reason: "检测到简历发送信号（附件或在线简历）",
    };
  }

  // 风控边界优先，命中即转人工，避免 AI 误判导致越权回复。
  const sensitiveHit = containsSensitiveKeyword(context.latestReply, config);
  if (sensitiveHit) {
    return {
      intent: "sensitive",
      shouldReply: false,
      shouldRequestResume: false,
      shouldClose: false,
      shouldHandover: true,
      reason: `命中敏感词: ${sensitiveHit}`,
    };
  }

  if (config.llm.enabled) {
    const llmDecision = await decideByLlm(context, config);
    if (llmDecision) {
      return llmDecision;
    }
  }

  return decideDialogueActionByRules(context.latestReply, config);
}

export function decideDialogueActionByRules(reply: string, config: RecruitAgentConfig): DialogueDecision {
  const normalized = pickText(reply).toLowerCase();

  if (config.interaction.sensitiveKeywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
    return {
      intent: "sensitive",
      shouldReply: false,
      shouldRequestResume: false,
      shouldClose: false,
      shouldHandover: true,
      reason: "命中敏感词，转人工接管",
    };
  }

  if (normalized.includes("简历") || normalized.includes("附件")) {
    return {
      intent: "resume_sent",
      shouldReply: false,
      shouldRequestResume: false,
      shouldClose: false,
      shouldHandover: false,
      reason: "候选人已发送简历",
    };
  }

  if (
    normalized.includes("不考虑") ||
    normalized.includes("不合适") ||
    normalized.includes("太远") ||
    normalized.includes("暂时不看")
  ) {
    return {
      intent: "negative",
      shouldReply: true,
      shouldRequestResume: false,
      shouldClose: true,
      shouldHandover: false,
      reason: "候选人明确拒绝或表达无意向",
    };
  }

  if (
    normalized.includes("可以") ||
    normalized.includes("方便") ||
    normalized.includes("聊聊") ||
    normalized.includes("了解") ||
    normalized.includes("感兴趣")
  ) {
    return {
      intent: "positive",
      shouldReply: true,
      shouldRequestResume: true,
      shouldClose: false,
      shouldHandover: false,
      reason: "候选人有继续沟通意向",
    };
  }

  return {
    intent: "unknown",
    shouldReply: false,
    shouldRequestResume: false,
    shouldClose: false,
    shouldHandover: true,
    reason: "回复无法安全归类，转人工",
  };
}

function containsSensitiveKeyword(reply: string, config: RecruitAgentConfig): string | undefined {
  const normalized = pickText(reply).toLowerCase();
  return config.interaction.sensitiveKeywords.find((keyword) => normalized.includes(keyword.toLowerCase()));
}

async function decideByLlm(
  context: DialoguePolicyContext,
  config: RecruitAgentConfig,
): Promise<DialogueDecision | undefined> {
  const apiKey = process.env[config.llm.apiKeyEnv];
  if (!apiKey) {
    return undefined;
  }

  const promptContext = toPromptContext(context, config);
  const userPrompt = buildInteractionLlmUserPrompt(promptContext);
  const body = {
    model: config.llm.model,
    temperature: config.llm.temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INTERACTION_LLM_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
      { role: "user", content: `输出示例参考: ${JSON.stringify(INTERACTION_LLM_OUTPUT_EXAMPLE)}` },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.llm.timeoutMs);
  try {
    const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = payload.choices?.[0]?.message?.content ?? "";
    const jsonText = extractJson(raw);
    if (!jsonText) {
      return undefined;
    }
    const decision = JSON.parse(jsonText) as {
      intent?: LlmIntent;
      action?: LlmAction;
      reply_text?: string;
      confidence?: number;
      reason?: string;
    };
    return mapLlmActionToDecision(decision);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toPromptContext(context: DialoguePolicyContext, config: RecruitAgentConfig): InteractionPromptContext {
  const turns: InteractionPromptMessage[] = context.history.slice(-Math.max(config.llm.maxContextTurns, 1)).map((turn) => {
    return {
      role: turn.role === "agent" ? "agent" : "candidate",
      text: turn.text,
      at: turn.at,
    };
  });

  if (!turns.length || turns.at(-1)?.role !== "candidate" || turns.at(-1)?.text !== context.latestReply) {
    turns.push({
      role: "candidate",
      text: context.latestReply,
    });
  }

  return {
    candidateName: context.candidateName,
    jobTitle: context.jobTitle,
    companyName: context.companyName,
    currentStatus: context.currentStatus,
    hasResumeAttachmentCard: context.hasResumeAttachmentCard,
    messages: turns,
    rules: {
      mustHandoverKeywords: config.interaction.sensitiveKeywords,
      rejectKeywordsHint: ["不考虑", "不合适", "太远", "暂时不看"],
      positiveKeywordsHint: ["可以", "方便", "聊聊", "了解", "感兴趣"],
    },
  };
}

function mapLlmActionToDecision(decision: {
  intent?: LlmIntent;
  action?: LlmAction;
  reason?: string;
}): DialogueDecision | undefined {
  const reason = decision.reason || "LLM 决策";
  const intent = normalizeIntent(decision.intent);
  switch (decision.action) {
    case "resume_request":
      return {
        intent: intent === "unknown" ? "positive" : intent,
        shouldReply: true,
        shouldRequestResume: true,
        shouldClose: false,
        shouldHandover: false,
        reason,
      };
    case "closing":
      return {
        intent: intent === "unknown" ? "negative" : intent,
        shouldReply: true,
        shouldRequestResume: false,
        shouldClose: true,
        shouldHandover: false,
        reason,
      };
    case "ack_and_handover":
      return {
        intent: "resume_sent",
        shouldReply: false,
        shouldRequestResume: false,
        shouldClose: false,
        shouldHandover: false,
        reason,
      };
    case "handover":
      return {
        intent: intent === "unknown" ? "sensitive" : intent,
        shouldReply: false,
        shouldRequestResume: false,
        shouldClose: false,
        shouldHandover: true,
        reason,
      };
    case "noop":
      return {
        intent,
        shouldReply: false,
        shouldRequestResume: false,
        shouldClose: false,
        shouldHandover: false,
        reason,
      };
    default:
      return undefined;
  }
}

function normalizeIntent(intent?: LlmIntent): DialogueIntent {
  if (!intent) {
    return "unknown";
  }
  return intent;
}

function extractJson(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return undefined;
  }
  return text.slice(first, last + 1);
}
