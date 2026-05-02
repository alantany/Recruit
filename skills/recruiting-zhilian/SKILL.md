---
name: recruiting-zhilian
description: 自动化智联招聘候选人搜寻、简历初筛、首轮打招呼、索要简历、跟进回复和状态记录。用户提到智联招聘、打招呼、索要简历、招聘初筛、候选人沟通、招聘 Agent、批量找人时使用。
---

# Recruiting Zhilian

## 目标

把招聘顾问在智联招聘上的重复劳动收敛成固定流程：

1. 打开指定岗位的人才搜索页。
2. 读取候选人卡片与详情。
3. 按岗位规则打分。
4. 对高分候选人发送首轮打招呼话术。
5. 记录候选人状态、跟进时间和异常。

## 强约束

- 只在 `config/recruit-agent.json` 定义的岗位范围内操作。
- 优先使用固定模板，不自由发挥。
- 互动页决策优先使用“完整历史对话 + LLM 结构化输出”，规则仅做兜底。
- 每次批量触达前先检查限额、冷却期和黑名单。
- 页面结构异常、发送按钮缺失、连续错误达到阈值时立即停机。
- 不要一次性大批量发送；遵循随机间隔。
- 24 小时值守时使用专用浏览器窗口，避免人工和 Agent 同时操作同一页面。

## 操作步骤

### 1. 初始化

- 读取 `config/recruit-agent.json`。
- 确认 `dryRun` 是否开启。
- 如启用 LLM 决策，先设置 `OPENAI_API_KEY`（或 `llm.apiKeyEnv` 对应变量）。
- 读取或创建 `data/recruit-agent-state.json`。

### 2. 搜索和抽取

- 进入智联招聘搜索页。
- 从候选人卡片抽取姓名、地点、工作年限、学历、学校、标签、摘要。
- 对每位候选人生成稳定 ID。
- 先落本地状态，再进入后续动作。

### 3. 打分和决策

- 先做硬过滤：排除词、城市、年限、学历、黑名单。
- 再做软评分：核心关键词、加分关键词、岗位相关性。
- `score >= autoContactScoreMin` 才允许自动触达。
- `manualReviewScoreMin <= score < autoContactScoreMin` 标记人工抽查。

### 4. 首轮沟通

- 首条消息只做职位介绍和匹配点说明。
- 先不在首轮直接索要简历。
- 发送后写入动作日志、对话日志、下次跟进时间。

### 5. 跟进

- 先扫描未读回复。
- 首次打招呼固定话术：您好，我们是一家高新信息技术集团，目前岗位地址在：鞍山、苏州、达州、北京、长春，看到您有最近均从事该相关工作，请问是否有意向了解一下我公司。
- 候选人有回复但未发简历：统一话术“请问能否留下您的简历，以方便我们就您的简历匹配度进一步沟通？”
- 候选人明确拒绝：统一话术“好的，如果您这边随时需要了解其他空缺岗位，可以交换微信，随时联系我。”
- 候选人发了简历：统一话术“感谢您对公司的认可，我们已经收到您的简历，后续会有人事专员与您对接，请保持您的手机畅通。”
- 候选人发简历后再发新消息：先回复“请稍等”，然后转人工接管。
- 回复出现“不考虑/不合适/太远”等时标记 `rejected`。
- 超过 `followUpAfterHours` 且仍未完成的会话，发送一次跟进消息。
- 标签切换、会话点击、打招呼按钮点击、发送消息前均加入随机间隔，按人工速度执行。

## 搜索人才（`agent:search`）说明

- 与「推荐人才」不同：`search:run` 以**关键词列表结果**为主，**不在列表层按 `excludeKeywords` 过滤**；适合「搜到即打招呼 + 索要简历」的批量线索收集。
- 首屏候选人行数可能少于 `maxCandidatesPerQuery`，需**滚动加载**后才够条数；详见 `docs/010005-招聘Agent使用手册.md` 中「搜索人才打招呼：常见问题与处理」。
- 触达间隔由 `guardrails.minDelayMs` / `maxDelayMs` 控制。

## 推荐命令

```bash
npm run agent:init
npm run agent:jobs
npm run agent:recommend
npm run agent:search
npm run agent:potential
npm run agent:interaction
npm run agent:workflow
npm run agent:daemon
npm run agent:report
```

## 输出要求

- 所有候选人都要写入状态文件。
- 所有自动动作都要写入动作日志。
- 收到简历后要把线索落到 `data/resumes/*.json`。
- 互动区每条会话的原始消息、决策和回复要落到 `data/interaction-logs/YYYY-MM-DD/*.jsonl`。
- 全局时间线动作（每轮开始/结束/异常/关键动作）要落到 `data/action-logs/YYYY-MM-DD/actions.jsonl`。
- 每次运行结束生成清晰统计：发现数、评分数、自动触达数、人工复核数、跳过数、跟进数。
- 每次功能变更同步更新：
  - `docs/010004-互动区处理规则.md`
  - `docs/010008-招聘Agent需求文档.md`
  - `docs/010002-互动区LLM提示词.md`
  - `docs/010005-招聘Agent使用手册.md`
