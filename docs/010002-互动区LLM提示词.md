# 互动区 LLM 提示词（决策版）

## 1. 目标

把“关键词触发”升级为“基于完整对话历史的结构化决策”。

输入：候选人与我方最近 N 轮完整消息 + 岗位上下文 + 当前状态 + 附件简历组件信号。  
输出：固定 JSON（可执行动作 + 回复话术 + 置信度 + 原因）。

## 2. System Prompt（建议直接复用）

```text
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
8) 未收到简历前，除明确拒绝外，统一 action=resume_request。
9) 若为“简历后继续追问”，reply_text 固定为“请稍等”。
10) reply_text 要简短、礼貌、职业，不夸大承诺。
11) 当 action=handover 或 noop 时，reply_text 可以为空字符串。
12) confidence 在 0 到 1 之间。
```

## 3. User Prompt 模板

```text
请基于以下上下文输出 JSON 决策：

候选人: {{candidateName}}
岗位: {{jobTitle}}
公司: {{companyName}}
当前状态: {{currentStatus}}
是否检测到附件简历组件: {{hasResumeAttachmentCard}}

敏感词提示: {{mustHandoverKeywords}}
拒绝意向提示词: {{rejectKeywordsHint}}
积极意向提示词: {{positiveKeywordsHint}}

完整历史对话:
{{conversation_history}}

请输出 JSON。
```

## 4. 输出 JSON 规范

```json
{
  "intent": "positive | negative | resume_sent | question | sensitive | unknown",
  "action": "resume_request | closing | ack_and_handover | handover | noop",
  "reply_text": "string",
  "confidence": 0.0,
  "reason": "string"
}
```

## 5. 标准回复模板（建议）

- `resume_request`：您好，您的背景和岗位要求比较匹配，方便发一份简历给我们进一步评估吗？
- `closing`：感谢您的回复，祝您求职顺利，后续有合适机会我们再联系您。
- `ack_and_handover`：简历已收到，我们会尽快和您联系。

## 6. 执行侧硬约束（非模型）

- 模型只负责“判定”，执行层只允许白名单动作。
- 未收到简历前，命中敏感/未知问题也先走 `resume_request`，不直接 `handover`。
- 对同一会话 + 同一候选人 + 同一条最新候选人消息做去重，避免重复回复。
- `ack_and_handover` 执行后将候选人状态置为 `resume_received -> needs_human_takeover`（按系统状态机落地）。

## 7. 版本记录

- v1（2026-03-02）：首版提示词，支持完整历史对话输入、结构化输出、执行白名单。
- v2（2026-03-15）：按业务规则收敛为“仅收到简历后才转人工；未收到简历统一先索要简历”。
- v3（2026-03-16）：简历后继续追问的话术固定为“请稍等”。
