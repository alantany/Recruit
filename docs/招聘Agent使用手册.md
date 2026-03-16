## 智联招聘 Agent 使用手册

### 1. 项目目标

这个项目不是直接替代招聘顾问全部工作，而是优先替代下面这些高重复动作：

- 搜索候选人列表
- 抽取候选人基本信息
- 按岗位规则做初筛打分
- 发送首轮招呼
- 索要简历
- 记录候选人状态和跟进时间

第一版的目标是稳定替代 60% 到 80% 的重复劳动。

### 2. 目录说明

- `config/recruit-agent.json`
  运行配置、岗位要求、风控参数、页面选择器和话术模板
- `src/recruit-agent`
  核心代码
- `skills/recruiting-zhilian/SKILL.md`
  OpenClaw 可读的招聘技能说明
- `data/recruit-agent-state.json`
  候选人状态库，首次运行会自动生成
- `data/reports`
  每次导出的日报目录
- `data/interaction-logs`
  互动区逐会话审计日志（JSONL），记录原始消息、决策动作、发送话术
- `data/action-logs`
  全局时间线动作日志（JSONL），按时间顺序记录每轮开始/结束/异常与关键动作事件
- `docs/互动区LLM提示词.md`
  互动页大模型决策提示词与 JSON 输出协议
- `docs/互动区处理规则.md`
  互动区唯一执行标准（动作规则、状态流转、转人工边界）
- `docs/招聘Agent需求文档.md`
  产品/开发统一需求基线（持续更新）

### 3. 安装依赖

```bash
npm install
npm run playwright:install
```

Windows 一键部署（推荐）：

```bat
deploy-windows.bat
```

说明：

- 脚本会自动检查并尝试安装 Node.js（通过 `winget`）。
- 脚本会自动检查并尝试安装 Git 客户端（通过 `winget`）。
- 本项目是独立 Node.js Agent，不需要额外安装 OpenClaw 运行时。

### 4. 首次启动

1. 修改 `config/recruit-agent.json`
2. 先保持 `"dryRun": true`
3. 执行初始化：

```bash
npm run agent:init
```

4. 手动打开浏览器并登录智联招聘账号
5. 确认你能在浏览器中正常看到目标岗位的人才列表页

说明：

- 当前实现使用 Playwright 持久化浏览器目录 `data/browser-profile`
- 登录一次后，后续会尽量复用登录态
- 建议使用“专用浏览器窗口”给 Agent 跑，不要和人工同时操作同一窗口
- 浏览器窗口可以最小化，但不建议在运行时手动切页、滚动、点击该专用窗口

### 5. 日常运行流程

#### 同步职位中心

```bash
npm run agent:jobs
```

逻辑：

- 从智联 `职位中心` 读取已发布岗位
- 抽取岗位名称、城市、职责、要求等结构化 JD
- 将岗位写入本地状态库，作为后续任务源

#### 处理推荐人才

```bash
npm run agent:recommend
```

逻辑：

- 进入 `推荐人才`
- 读取候选人卡片
- 按当前 JD 评分
- 对高分候选人自动打招呼
- 当前版本为了避免错岗位归属，推荐页默认只处理首个激活岗位

#### 处理搜索人才

```bash
npm run agent:search
```

逻辑：

- 根据 JD 自动生成搜索关键词
- 在 `搜索人才` 页面逐组执行搜索
- 对搜索结果评分并自动打招呼

#### 处理潜在人才

```bash
npm run agent:potential
```

逻辑：

- 进入 `潜在人才`
- 以较高阈值筛选候选人
- 避免把低价值线索浪费在触达额度上
- 当前版本为了避免错岗位归属，潜在页默认只处理首个激活岗位

#### 处理互动页

```bash
npm run agent:interaction
```

逻辑：

- 扫描 `互动` 中的未读消息（未读为 0 时再扫最近会话）
- 场景 1 首次打招呼：固定使用配置里的 `messages.opening`
- 场景 2 有回复但未发简历：默认统一使用 `messages.resumeRequest`
- 场景 3 明确拒绝：使用 `messages.rejection`
- 场景 4 已发简历：使用 `messages.resumeReceivedAck`，并进入人工跟进链路（支持附件简历组件与在线简历链接两种信号）
- 场景 5 已发简历后再有新消息：先回 `messages.handover`（“请稍等”），再转人工
- `contacted / resume_requested / awaiting_reply` 且到达 `followUpDueAt` 的候选人会触发一次自动跟进；找不到会话映射则转人工

#### 一次跑完整工作流

```bash
npm run agent:workflow
```

执行顺序：

- 同步岗位
- 推荐人才
- 搜索人才
- 潜在人才
- 互动
- 导出日报

#### 常驻 24 小时机器人（推荐）

```bash
npm run agent:daemon
```

逻辑：

- 互动页按 `daemon.interactionIntervalMinutes` 轮询（默认 1 分钟）
- 推荐/搜索/潜在/职位同步/报表按各自间隔错峰执行
- 子任务失败不会导致守护进程退出，下一轮自动继续

#### 导出日报和人工接管列表

```bash
npm run agent:report
```

输出会额外生成：

- `manual-review-*.md`：人工复核队列
- `data/resumes/*.json`：候选人发简历后的本地归档（消息片段/链接线索）
- `data/interaction-logs/YYYY-MM-DD/*.jsonl`：每条会话的互动留痕审计
- `data/action-logs/YYYY-MM-DD/actions.jsonl`：按时间顺序记录动作时间线（轮次开始/结束/异常/关键事件）

### 6. 核心配置项

#### `job`

用于定义默认岗位模板与打招呼话术上下文：

- `title`
- `cityNames`
- `requiredEducation`
- `minExperienceYears`
- `mustHaveKeywords`
- `niceToHaveKeywords`
- `excludeKeywords`

#### `guardrails`

用于控制风控：

- `dailyContactLimit`
- `hourlyContactLimit`
- `maxConsecutiveErrors`
- `cooldownHours`
- `minDelayMs`
- `maxDelayMs`
- `manualReviewScoreMin`
- `autoContactScoreMin`
- `followUpAfterHours`

说明：

- `minDelayMs / maxDelayMs` 会用于推荐/搜索触达以及互动区发送，发送前按随机间隔停顿，模拟人工节奏。
- 页面 UI 操作（如标签切换、会话点击、打开打招呼窗口）也会加入短随机间隔，避免机械化连续点击。

建议第一阶段：

- `dryRun = true`
- `dailyContactLimit <= 20`
- `hourlyContactLimit <= 8`

#### `selectors`

这一段是最容易随智联页面变化而失效的部分。  
如果采集不到列表或发不出消息，优先检查这里。

#### `jobSync`

- `syncLimit`
- `activeJobIds`

如果 `activeJobIds` 为空，系统默认只处理最近同步到的第一个岗位。

#### `search`

- `maxQueriesPerJob`
- `maxCandidatesPerQuery`

#### `interaction`

- `unreadLimit`
- `sensitiveKeywords`

#### `daemon`

- `enabled`
- `interactionIntervalMinutes`（建议 1）
- `recommendIntervalMinutes`
- `searchIntervalMinutes`
- `potentialIntervalMinutes`
- `jobsSyncIntervalMinutes`
- `reportIntervalMinutes`

#### `llm`

- `enabled`：是否开启互动页 LLM 决策主链
- `provider`：当前为 `openai_compatible`
- `model`：模型名称（如 `gpt-4o-mini`）
- `baseUrl`：兼容 OpenAI 的接口地址
- `apiKeyEnv`：读取 API Key 的环境变量名（默认 `OPENAI_API_KEY`）
- `timeoutMs`：单次决策超时
- `maxContextTurns`：喂给模型的最大历史轮次
- `temperature`：生成温度，建议低值（0~0.3）

示例：

```bash
export OPENAI_API_KEY=你的密钥
npm run agent:interaction
```

### 7. 候选人状态

- `new`：刚发现
- `scored`：已打分
- `contacted`：已发送首轮消息
- `resume_requested`：已索要简历
- `awaiting_reply`：等待回复
- `resume_received`：已收到简历
- `rejected`：对方拒绝或不合适
- `do_not_contact`：不应触达
- `not_interested_reasoned`：明确记录了拒绝原因
- `needs_human_takeover`：命中敏感问题，等待人工接管

状态保护规则：

- `contacted / resume_requested / awaiting_reply / resume_received / not_interested_reasoned / needs_human_takeover` 不会被普通重扫回退为 `scored`

### 8. 推荐上线顺序

#### 第一步

先运行：

```bash
npm run agent:jobs
npm run agent:recommend
npm run agent:search
```

目标：

- 看同步出的岗位是否正确
- 看推荐和搜索结果里的人是否真值得联系
- 看分数排序是否符合你的经验判断

#### 第二步

仍保持 `dryRun = true`，运行：

```bash
npm run agent:workflow
```

目标：

- 看系统“本来会联系谁”
- 看互动页会如何处理未读消息
- 检查动作日志、人工接管列表和候选人状态是否正确

#### 第三步

把 `dryRun` 改成 `false`，每天只跑 10 到 20 个候选人。

### 9. 风控建议

- 不要一开始就全量放开。
- 不要把发送间隔设得太短。
- 不要让 Agent 自由生成大段话术。
- 不要跨多个岗位同时放量。
- 页面结构变化后，先回到 `jobs + recommend + search` 验证模式。
- 24 小时值守时，优先让 Agent 占用一个专用浏览器窗口，不要和人工共用同一页面。

### 10. 常见问题

#### 抓不到职位卡片或候选人卡片

优先检查：

- 是否已经登录
- 当前页面是否真的是目标页面
- `selectors.navJobCenter` / `selectors.navRecommend` / `selectors.navSearch` 是否需要调整
- `selectors.candidateCards` 是否需要调整

#### 能抓数据但发不出消息

优先检查：

- `selectors.openChatButton`
- `selectors.chatInput`
- `selectors.sendButton`

#### 互动页没有自动回消息

优先检查：

- `selectors.navInteraction`
- `selectors.conversationListItems`
- `selectors.conversationUnreadBadge`
- 是否命中敏感词后被转入人工接管

#### 明明匹配却没有自动联系

优先检查：

- `autoContactScoreMin`
- 是否命中冷却期
- 是否达到小时或每日上限
- 是否命中黑名单或排除词
- 是否已进入推进态（推进态默认不重复触达）

#### LLM 决策接入后如何排查

优先检查：

- `docs/互动区LLM提示词.md` 的 System Prompt 与 JSON 字段是否一致
- 传给模型的是否是“完整历史对话”，而不是最后一条消息
- 执行层是否只接受白名单动作（`resume_request / closing / ack_and_handover / handover / noop`）
- 是否有去重键，避免同一条候选人消息重复回复

### 11. 下一步建议

当这版稳定后，再做这三件事：

1. 加入岗位配置管理界面
2. 加入更细的回复意图识别与接管策略
3. 接入真实 LLM 做更细的搜索词和匹配理由生成

### 12. 文档同步规则（长期执行）

每次开发变更后，至少同步这 4 份文档：

1. `docs/招聘Agent需求文档.md`
2. `docs/互动区LLM提示词.md`
3. `docs/招聘Agent使用手册.md`
4. `skills/recruiting-zhilian/SKILL.md`

建议顺序：先需求 -> 再代码 -> 再手册/技能说明。
