export type CandidateStatus =
  | "new"
  | "scored"
  | "contacted"
  | "resume_requested"
  | "awaiting_reply"
  | "resume_received"
  | "rejected"
  | "do_not_contact"
  | "not_interested_reasoned"
  | "needs_human_takeover";

export type ActionType =
  | "job_synced"
  | "discovered"
  | "scored"
  | "contacted"
  | "resume_requested"
  | "followed_up"
  | "replied"
  | "search_executed"
  | "manual_takeover"
  | "resume_downloaded"
  | "skipped"
  | "error";

export type PageName =
  | "job_center"
  | "recommend"
  | "search"
  | "potential"
  | "interaction";

export type DialogueIntent =
  | "positive"
  | "negative"
  | "resume_sent"
  | "question"
  | "sensitive"
  | "unknown";

export interface RecruitingJobConfig {
  id: string;
  companyName: string;
  title: string;
  cityNames: string[];
  salaryRange: string;
  requiredEducation?: string;
  minExperienceYears?: number;
  mustHaveKeywords: string[];
  niceToHaveKeywords: string[];
  /** 用于匹配打分等；「搜索人才」链路不按此项过滤候选人 */
  excludeKeywords: string[];
  openingSummary: string;
}

export interface GuardrailConfig {
  dailyContactLimit: number;
  hourlyContactLimit: number;
  maxConsecutiveErrors: number;
  cooldownHours: number;
  minDelayMs: number;
  maxDelayMs: number;
  manualReviewScoreMin: number;
  autoContactScoreMin: number;
  followUpAfterHours: number;
}

export interface BrowserConfig {
  baseUrl: string;
  headless: boolean;
  slowMoMs: number;
  userDataDir: string;
  defaultTimeoutMs: number;
  /** 为 true 时：search:run 结束后不自动关浏览器，并等待按 Enter 再退出进程 */
  keepBrowserOpenAfterRun?: boolean;
}

export interface StorageConfig {
  stateFile: string;
  reportDir: string;
  resumeDir?: string;
  interactionLogDir?: string;
  actionLogDir?: string;
}

export interface SelectorConfig {
  navJobCenter: string;
  navRecommend: string;
  navSearch: string;
  navPotential: string;
  navInteraction: string;
  pageReadyMarker: string;
  jobCards: string;
  jobTitle: string;
  jobMeta: string;
  jobStatus: string;
  jobLink: string;
  jobDetailPanel: string;
  jobResponsibilities: string;
  jobRequirements: string;
  searchInput: string;
  searchButton: string;
  searchKeywordChips: string;
  candidateCards: string;
  candidateName: string;
  candidateMeta: string;
  candidateTags: string;
  candidateSummary: string;
  candidateLink: string;
  candidateCardChatButton: string;
  nextPageButton: string;
  openChatButton: string;
  chatInput: string;
  sendButton: string;
  conversationListItems: string;
  conversationUnreadBadge: string;
  conversationItems: string;
  conversationText: string;
  unreadConversationItems: string;
  conversationCandidateName: string;
  detailPanel: string;
}

export interface MessageTemplateConfig {
  opening: string;
  resumeRequest: string;
  followUp: string;
  rejection: string;
  handover: string;
  resumeReceivedAck: string;
}

export interface JobSyncConfig {
  syncLimit: number;
  activeJobIds: string[];
}

export interface SearchConfig {
  maxQueriesPerJob: number;
  /** 每个搜索关键词下，从上到下最多解析、尝试触达的候选人数（与列表「未聊过」筛选配合） */
  maxCandidatesPerQuery: number;
  manualKeyword?: string;
  northeastOnly?: boolean;
  /** 本轮 search:run 累计最多成功触达几人；0 表示不按此项截断，每条搜索最多处理 maxCandidatesPerQuery 人 */
  topContactCount?: number;
  forceContactTopN?: boolean;
  sendResumeRequestAfterOpening?: boolean;
  greetingJobTitle?: string;
  /** 搜索前尽量勾选「未聊过」，避免列表全是已沟通、无「打招呼」按钮 */
  ensureNeverChattedFilter?: boolean;
  /** 等待候选人列表行出现的超时（毫秒） */
  searchResultsWaitMs?: number;
}

export interface InteractionConfig {
  unreadLimit: number;
  sensitiveKeywords: string[];
}

export interface DaemonConfig {
  enabled: boolean;
  interactionIntervalMinutes: number;
  recommendIntervalMinutes: number;
  searchIntervalMinutes: number;
  potentialIntervalMinutes: number;
  jobsSyncIntervalMinutes: number;
  reportIntervalMinutes: number;
}

export interface LlmConfig {
  enabled: boolean;
  provider: "openai_compatible";
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs: number;
  maxContextTurns: number;
  temperature: number;
}

export interface DenyListConfig {
  candidateNames: string[];
  companies: string[];
  schools: string[];
}

export interface AutomationConfig {
  autoWorkEnabled: boolean;
}

/** `search-interaction:loop` 命令：仅「搜索人才 ↔ 互动」往返，不含职位同步/推荐/潜在/日报 */
export interface SearchInteractionLoopConfig {
  /** 往返一轮 = 先搜索再互动；0 或未配置表示无限循环直到进程退出 */
  maxRounds?: number;
}

export interface RecruitAgentConfig {
  platform: "zhilian";
  dryRun: boolean;
  automation: AutomationConfig;
  browser: BrowserConfig;
  storage: StorageConfig;
  job: RecruitingJobConfig;
  jobSync: JobSyncConfig;
  search: SearchConfig;
  interaction: InteractionConfig;
  /** 搜索↔互动循环（见 `search-interaction:loop`） */
  searchInteractionLoop?: SearchInteractionLoopConfig;
  daemon: DaemonConfig;
  llm: LlmConfig;
  guardrails: GuardrailConfig;
  messages: MessageTemplateConfig;
  selectors: SelectorConfig;
  denyList: DenyListConfig;
}

export interface MatchScore {
  total: number;
  hardPass: boolean;
  positives: string[];
  negatives: string[];
  matchedKeywords: string[];
  recommendedAction: "contact" | "manual_review" | "skip";
}

export interface CandidateAction {
  type: ActionType;
  at: string;
  note?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface ConversationTurn {
  role: "agent" | "candidate" | "system";
  text: string;
  at: string;
}

export interface SearchKeywordPlan {
  keyword: string;
  excludes: string[];
  priority: number;
  why: string;
}

export interface JobDefinition {
  id: string;
  title: string;
  cityNames: string[];
  salaryRange?: string;
  requiredEducation?: string;
  minExperienceYears?: number;
  responsibilities: string;
  requirements: string;
  companyName: string;
  status?: string;
  sourceUrl?: string;
  keywords: string[];
  syncedAt: string;
}

export interface CandidateProfile {
  id: string;
  stableKey?: string;
  name: string;
  location?: string;
  age?: number;
  experienceYears?: number;
  education?: string;
  school?: string;
  currentCompany?: string;
  currentTitle?: string;
  expectedPosition?: string;
  expectedSalaryRaw?: string;
  lastActiveAt?: string;
  tags: string[];
  summary: string;
  sourceUrl?: string;
  sourcePlatform: "zhilian";
  sourcePage?: PageName;
  jobId?: string;
  conversationThreadKey?: string;
  status: CandidateStatus;
  score?: MatchScore;
  latestReply?: string;
  lastContactedAt?: string;
  followUpDueAt?: string;
  replyIntent?: DialogueIntent;
  rejectionReason?: string;
  resumeAssetPaths?: string[];
  createdAt: string;
  updatedAt: string;
  conversations: ConversationTurn[];
  actions: CandidateAction[];
}

export interface InteractionThreadSnapshot {
  threadKey: string;
  threadIndex: number;
  candidateName: string;
  gender?: string;
  age?: string;
  jobTitle?: string;
  unreadCount: number;
  latestReply: string;
  latestCandidateReply: string;
  /** 最后一条气泡是否是我方发出的（通过 DOM 类名 --me 判断） */
  lastSenderIsAgent?: boolean;
  hasResumeAttachmentCard: boolean;
  allMessages: string[];
}

export interface ManualHandover {
  candidateId: string;
  candidateName: string;
  reason: string;
  latestMessage: string;
  createdAt: string;
}

export interface ManualReviewItem {
  candidateId: string;
  candidateName: string;
  jobId?: string;
  score: number;
  reason: string;
  createdAt: string;
}

export interface RunHistoryEntry {
  id: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  summary: AgentRunSummary;
  notes: string[];
}

export interface RecruitAgentState {
  createdAt: string;
  updatedAt: string;
  jobs: Record<string, JobDefinition>;
  candidates: Record<string, CandidateProfile>;
  handledInteractionKeys: string[];
  manualHandovers: ManualHandover[];
  manualReviewQueue: ManualReviewItem[];
  runHistory: RunHistoryEntry[];
  dailyCounters: Record<string, number>;
  hourlyCounters: Record<string, number>;
  consecutiveErrors: number;
}

export interface BrowserCandidateSnapshot {
  id: string;
  stableKey?: string;
  listIndex?: number;
  name: string;
  location?: string;
  age?: number;
  experienceYears?: number;
  education?: string;
  school?: string;
  currentCompany?: string;
  currentTitle?: string;
  expectedPosition?: string;
  expectedSalaryRaw?: string;
  lastActiveAt?: string;
  tags: string[];
  summary: string;
  sourceUrl?: string;
  sourcePage?: PageName;
}

export interface AgentRunSummary {
  jobsSynced: number;
  discovered: number;
  scored: number;
  autoContacted: number;
  manualReview: number;
  skipped: number;
  followUps: number;
  handovers: number;
  errors: number;
}

export interface ReportRow {
  id: string;
  name: string;
  status: CandidateStatus;
  score: number;
  action: string;
  page?: PageName;
  jobTitle?: string;
  updatedAt: string;
}
