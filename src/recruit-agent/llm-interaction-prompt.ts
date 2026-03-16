export type LlmIntent =
  | "positive"
  | "negative"
  | "resume_sent"
  | "question"
  | "sensitive"
  | "unknown";

export type LlmAction =
  | "resume_request"
  | "closing"
  | "ack_and_handover"
  | "handover"
  | "noop";

export interface InteractionPromptMessage {
  role: "agent" | "candidate";
  text: string;
  at?: string;
}

export interface InteractionPromptContext {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  currentStatus: string;
  hasResumeAttachmentCard: boolean;
  messages: InteractionPromptMessage[];
  rules: {
    mustHandoverKeywords: string[];
    rejectKeywordsHint: string[];
    positiveKeywordsHint: string[];
  };
}

export interface LlmDecisionSchema {
  intent: LlmIntent;
  action: LlmAction;
  reply_text: string;
  confidence: number;
  reason: string;
}

export const INTERACTION_LLM_SYSTEM_PROMPT = `
你是招聘互动决策助手。你的任务不是自由聊天，而是根据完整历史对话给出“下一步动作”。

你必须严格遵守：
1) 仅输出 JSON，不要输出任何解释性文本。
2) JSON 字段必须包含：intent, action, reply_text, confidence, reason。
3) action 只能是：
   - resume_request
   - closing
   - ack_and_handover
   - handover
   - noop
4) 如果检测到候选人发送了附件简历组件（hasResumeAttachmentCard=true），优先 action=ack_and_handover。
5) 如果候选人明确拒绝（不考虑/不合适/太远等），action=closing。
6) 如果候选人有兴趣但尚未发简历，action=resume_request。
7) 只有“已收到简历”相关场景才允许 action=handover（包括候选人发简历后继续追问）。
8) 未收到简历前，不要转人工；除明确拒绝外，统一 action=resume_request。
9) reply_text 要简短、礼貌、职业，不夸大承诺。
10) 当 action=handover 或 noop 时，reply_text 可以为空字符串。
11) confidence 在 0 到 1 之间。
`.trim();

export const INTERACTION_LLM_OUTPUT_EXAMPLE = {
  intent: "resume_sent",
  action: "ack_and_handover",
  reply_text: "简历已收到，我们会尽快和您联系。",
  confidence: 0.94,
  reason: "检测到候选人发送附件简历组件",
} satisfies LlmDecisionSchema;

export function buildInteractionLlmUserPrompt(context: InteractionPromptContext): string {
  const conversationText = context.messages
    .map((item) => {
      const at = item.at ? `(${item.at})` : "";
      return `[${item.role}]${at} ${item.text}`;
    })
    .join("\n");

  return `
请基于以下上下文输出 JSON 决策：

候选人: ${context.candidateName}
岗位: ${context.jobTitle}
公司: ${context.companyName}
当前状态: ${context.currentStatus}
是否检测到附件简历组件: ${context.hasResumeAttachmentCard ? "是" : "否"}

敏感词提示: ${context.rules.mustHandoverKeywords.join("、")}
拒绝意向提示词: ${context.rules.rejectKeywordsHint.join("、")}
积极意向提示词: ${context.rules.positiveKeywordsHint.join("、")}

完整历史对话:
${conversationText || "(空)"}

请输出 JSON。
`.trim();
}
