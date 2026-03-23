import type { Page, Locator, Download } from "playwright";

import type { RecruitAgentConfig, InteractionThreadSnapshot } from "../types.js";
import { pickText } from "../utils.js";
import { BasePage } from "./base-page.js";

export type ThreadProcessor = (
  thread: InteractionThreadSnapshot,
  sendReply: (message: string) => Promise<void>,
  isFallback: boolean,
) => Promise<void>;

/**
 * 从侧边栏文字构建稳定的 threadKey：剔除时间、已读等动态部分
 * 例：「聂红艳 招聘顾问 对方向您发送了在线简历 21:08 不合适」
 * → 「聂红艳 招聘顾问 对方向您发送了在线简历 不合适」
 */
function buildStableThreadKey(sessionText: string, candidateName: string): string {
  if (!sessionText) return candidateName || "unknown";
  return sessionText
    // 去掉时间戳 HH:MM
    .replace(/\b\d{1,2}:\d{2}\b/g, "")
    // 去掉"X小时前/X分钟前"
    .replace(/\d+\s*(小时|分钟)前/g, "")
    // 去掉"今天/昨天"
    .replace(/今天|昨天/g, "")
    // 去掉[已读]
    .replace(/\[已读\]/g, "")
    // 去掉前导数字（未读气泡数）如「1 聂红艳」
    .replace(/^\d+\s+/, "")
    // 折叠多余空格
    .replace(/\s+/g, " ")
    .trim() || candidateName;
}

export class InteractionPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  /**
   * 单遍处理互动区：
   * 阶段一：逐项检查未读角标，发现未读立即点进去处理，处理完再找下一个未读。
   * 阶段二：若阶段一未发现任何未读，从列表顶部开始，最多处理 fallbackLimit 个会话，
   *         每个会话处理完毕再进入下一个（跳过我方最后发言的会话）。
   */
  async processConversations(
    unreadLimit: number,
    fallbackLimit: number,
    onThread: ThreadProcessor,
  ): Promise<void> {
    await this.openInteraction();

    const items = await this.listConversationItems();
    const totalCount = await items.count().catch(() => 0);

    // 阶段一：有未读优先处理
    let foundAnyUnread = false;
    const unreadScanCount = Math.min(totalCount, unreadLimit);

    for (let index = 0; index < unreadScanCount; index += 1) {
      const item = items.nth(index);
      const sessionText = pickText(await item.innerText().catch(() => ""));
      const isMarkedRejected = sessionText.includes("不合适") || sessionText.includes("不感兴趣");
      const hasPotentialResume = sessionText.includes("简历") || sessionText.includes("文件");
      // 已标记不合适且没有简历关键字 -> 直接跳过
      if (isMarkedRejected && !hasPotentialResume) {
        continue;
      }
      const unreadText = await this.readFirstText(item.locator(this.config.selectors.conversationUnreadBadge));
      const unreadCount = this.pickUnreadCount(unreadText, sessionText);
      if (isMarkedRejected || unreadCount <= 0) {
        // 已标记不合适但有简历 -> 进入会话但仅用于下载（isFallback防止回复）
        if (isMarkedRejected && hasPotentialResume) {
          await this.humanUiPause(600, 1500);
          await item.click();
          await this.page.waitForTimeout(500);
          const snapshot = await this.readCurrentThreadSnapshot(index, sessionText, 0);
          await onThread(snapshot, (msg) => this.replyCurrentThread(msg), true);
        }
        continue;
      }

      foundAnyUnread = true;
      await this.humanUiPause(600, 1500);
      await item.click();
      await this.page.waitForTimeout(500);

      const snapshot = await this.readCurrentThreadSnapshot(index, sessionText, unreadCount);
      await onThread(snapshot, (msg) => this.replyCurrentThread(msg), false);
    }

    // foundAnyUnread 处理完后继续进行兜底扫描 (确保已读的简历也能被扫描下载)

    // 阶段二：无未读，从顶部开始兜底，跳过我方最后发言的会话
    const agentPrefixes = [
      this.config.messages.opening,
      this.config.messages.resumeRequest,
      this.config.messages.rejection,
      this.config.messages.handover,
      this.config.messages.resumeReceivedAck,
      this.config.messages.followUp,
    ]
      .filter(Boolean)
      .map((m) => m!.slice(0, 12));

    const fallbackScanCount = Math.min(totalCount, fallbackLimit);

    for (let index = 0; index < fallbackScanCount; index += 1) {
      const item = items.nth(index);
      const sessionText = pickText(await item.innerText().catch(() => ""));
      if (sessionText.includes("不合适") || sessionText.includes("不感兴趣")) {
        continue;
      }

      const hasPotentialResume = sessionText.includes("简历") || sessionText.includes("文件");

      // 列表预览包含我方话术前缀，直接跳过，不点进去 (除非预览中有简历字样，可能需要下载)
      if (!hasPotentialResume && agentPrefixes.some((prefix) => sessionText.includes(prefix))) {
        continue;
      }

      await this.humanUiPause(600, 1500);
      await item.click();
      await this.page.waitForTimeout(500);

      const snapshot = await this.readCurrentThreadSnapshot(index, sessionText, 0);
      if (snapshot.allMessages.length === 0) {
        continue;
      }

      await onThread(snapshot, (msg) => this.replyCurrentThread(msg), true);
    }
  }

  /**
   * 在当前已打开的会话页面直接发送消息，无需重新导航。
   */
  async replyCurrentThread(message: string): Promise<void> {
    await (await this.chatInput()).fill(message);
    await this.humanUiPause(500, 1200);
    await (await this.sendButton()).click();
  }

  /**
   * 尝试下载当前会话中的最新简历附件
   */
  async downloadResume(filenamePrefix?: string): Promise<string | undefined> {
    // 候选的选择器：聊天气泡、简历卡片、或包含“简历”关键字的可点击项
    const selectors = [
      ".im-message__bubble:not(.im-message__bubble--me)",
      ".msg-resume-card",
      ".resume-attachment",
      "div:has-text('查看附件简历')"
    ];

    let resumeCard: Locator | undefined;
    for (const sel of selectors) {
      const loc = this.page.locator(sel).filter({ hasText: /查看附件简历|附件简历/ }).last();
      if (await loc.count() > 0) {
        resumeCard = loc;
        break;
      }
    }

    if (!resumeCard || await resumeCard.count() === 0) {
      return undefined;
    }

    let previewPage: Page | undefined;
    try {
      console.log(`[InteractionPage] 发现简历附件 [${await resumeCard.innerText()}]，准备下载...`);
      await resumeCard.scrollIntoViewIfNeeded();
      await this.humanUiPause(800, 1500);

      const clickTarget = resumeCard.locator("text='查看附件简历'").first();
      const actualClickTarget = await clickTarget.count() > 0 ? clickTarget : resumeCard;
      console.log(`[InteractionPage] 正在点击下载源: ${await actualClickTarget.getAttribute("class") || "unknown"}`);

      const [download, newPage] = await Promise.all([
        this.page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
        this.page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
        actualClickTarget.click({ force: true, delay: 100 }),
      ]);

      if (download) {
        return await this.handleDownloadObject(download, filenamePrefix);
      }

      previewPage = newPage || undefined;
      if (!previewPage) {
        const allPages = this.page.context().pages();
        if (allPages.length > 1) {
          previewPage = allPages[allPages.length - 1];
        }
      }

      if (previewPage) {
        const previewUrl = previewPage.url();
        console.log(`[InteractionPage] 处理简历预览页: ${previewUrl}`);

        if (previewUrl.includes("download") || previewUrl.includes("attachment")) {
          const path = await this.downloadViaHttpRequest(previewPage, filenamePrefix);
          if (path) return path;
        }

        await previewPage.waitForLoadState("load", { timeout: 10000 }).catch(() => {});
        await this.page.waitForTimeout(1000);
        
        const downloadBtn = previewPage.locator("button:has-text('下载'), a:has-text('下载'), .download-btn, [class*='download']").first();
        if (await downloadBtn.count() > 0) {
          console.log(`[InteractionPage] 在预览页点击下载按钮...`);
          const [previewDownload] = await Promise.all([
            previewPage.waitForEvent("download", { timeout: 15000 }).catch(() => null),
            downloadBtn.click({ force: true }),
          ]);
          if (previewDownload) {
            return await this.handleDownloadObject(previewDownload, filenamePrefix);
          }
        }
        
        console.log(`[InteractionPage] 预览页未找到下载按钮，尝试截图记录...`);
        const snapshotDir = "./data/snapshots";
        const fs = await import("node:fs/promises");
        await fs.mkdir(snapshotDir, { recursive: true });
        const shotPath = `${snapshotDir}/resume-preview-fail-${Date.now()}.png`;
        await previewPage.screenshot({ path: shotPath }).catch(() => {});
      }
      return undefined;
    } catch (e) {
      console.error(`[InteractionPage] 下载过程中出现错误:`, e);
      return undefined;
    } finally {
      if (previewPage && !previewPage.isClosed()) {
        await previewPage.close().catch(() => {});
      }
    }
  }

  // 读取候选人详情页眉信息
  private async readCandidateProfileHeader(): Promise<{ candidateName: string, gender?: string, age?: string, jobTitle?: string }> {
    const lines = await this.readBodyLines();
    const jobIndex = lines.findIndex((line) => line.includes("沟通职位"));
    
    let candidateName = "unknown";
    let gender: string | undefined;
    let age: string | undefined;
    let jobTitle: string | undefined;

    if (jobIndex !== -1 && lines[jobIndex]) {
      // 职位名称通常在 "沟通职位" 文字所在的行中，或者在其后
      const jobLine = lines[jobIndex]!;
      const jobMatch = jobLine.match(/沟通职位：(.+)/);
      jobTitle = jobMatch?.[1] ? jobMatch[1].trim() : lines[jobIndex + 1];

      // 姓名、性别、年龄通常在 "沟通职位" 之前的行
      for (let index = jobIndex - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || /回复|沟通中|已约面|不合适|收藏|浏览过职位|在线|活跃|设置备注|已选：|取消|确定|\d+分钟前|\d+小时前/.test(line)) {
          continue;
        }
        
        // 解析 "姓名 性别 年龄" 这种格式, 例如 "朱洪章 男 36岁"
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          candidateName = parts[0] || "unknown";
          gender = parts[1];
          age = parts[2];
        } else if (parts.length === 1) {
          candidateName = parts[0] || "unknown";
        }
        break;
      }
    } else {
      candidateName = await this.readFirstText(this.page.locator(this.config.selectors.conversationCandidateName)) || "unknown";
    }

    return { candidateName, gender, age, jobTitle };
  }

  /**
   * 通过索引重新定位并回复（用于到期跟进等需要重新找会话的场景）。
   */
  async replyToThread(threadIndex: number, message: string): Promise<void> {
    await this.openInteraction();

    const items = await this.listConversationItems();
    const count = await items.count().catch(() => 0);
    if (threadIndex >= count) {
      throw new Error(`未找到互动会话索引: ${threadIndex}`);
    }

    const item = items.nth(threadIndex);
    await this.humanUiPause(600, 1500);
    await item.click();
    await this.page.waitForTimeout(500);
    await (await this.chatInput()).fill(message);
    await this.humanUiPause(500, 1200);
    await (await this.sendButton()).click();
  }

  async findThreadIndex(threadKey: string | undefined, candidateName: string): Promise<number | undefined> {
    await this.openInteraction();

    const items = await this.listConversationItems();
    const count = await items.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const text = pickText(await item.innerText().catch(() => ""));
      if (!text) {
        continue;
      }

      if (threadKey && text.includes(threadKey)) {
        return index;
      }

      if (candidateName && text.includes(candidateName)) {
        return index;
      }
    }

    return undefined;
  }

  // 读取当前已打开会话的快照数据
  private async readCurrentThreadSnapshot(
    index: number,
    sessionText: string,
    unreadCount: number,
  ): Promise<InteractionThreadSnapshot> {
    // 等待消息气泡加载
    await this.page.locator(".im-message__bubble").first().waitFor({ timeout: 3000 }).catch(() => undefined);
    
    const { candidateName, gender, age, jobTitle } = await this.readCandidateProfileHeader();
    const allMessages = await this.readConversationMessages();
    const candidateMessages = await this.readCandidateConversationMessages();
    const hasResumeAttachmentCard = await this.hasCandidateResumeAttachmentCard();
    
    // 通过 DOM 直接判断最后一条气泡是否是我方发出的
    const lastBubble = this.page.locator(".im-message__bubble").last();
    const lastBubbleClass = await lastBubble.getAttribute("class").catch(() => "") ?? "";
    const lastSenderIsAgent = lastBubbleClass.includes("--me");
    
    const latestCandidateReply = candidateMessages.at(-1) ?? "";

    return {
      // 剔除时间戳等不稳定部分，确保 threadKey 跨次扫描保持一致
      threadKey: buildStableThreadKey(sessionText, candidateName),
      threadIndex: index,
      candidateName: candidateName || "unknown",
      gender,
      age,
      jobTitle,
      unreadCount,
      // 只取候选人的最后一条话，避免把我方消息当成输入
      latestReply: latestCandidateReply,
      latestCandidateReply,
      lastSenderIsAgent,
      hasResumeAttachmentCard,
      allMessages,
    };
  }

  private async openInteraction(): Promise<void> {
    const configuredNav = this.page.locator(this.config.selectors.navInteraction);
    const configuredCount = await configuredNav.count().catch(() => 0);
    if (configuredCount > 0) {
      await this.humanUiPause(700, 1800);
      await configuredNav.first().click();
    } else {
      await this.humanUiPause(700, 1800);
      await this.page.getByRole("link", { name: /互动/ }).click();
    }
    await this.waitForReady();
    await this.waitForElements(this.config.selectors.conversationListItems).catch(() => undefined);
  }

  private async listConversationItems(): Promise<Locator> {
    const configured = this.page.locator(this.config.selectors.conversationListItems);
    const configuredCount = await configured.count().catch(() => 0);
    if (configuredCount > 0) {
      return configured;
    }

    return this.page.locator("div, li, a").filter({ hasText: /(?:\d{2}-\d{2}|昨天|今天|\d+小时前有回复|\d+分钟前有回复)/ });
  }

  private async chatInput(): Promise<Locator> {
    const configured = this.page.locator(this.config.selectors.chatInput);
    const configuredCount = await configured.count().catch(() => 0);
    if (configuredCount > 0) {
      return configured.first();
    }

    return this.page.getByPlaceholder("从这里开启对话...").first();
  }

  private async sendButton(): Promise<Locator> {
    const configured = this.page.locator(this.config.selectors.sendButton);
    const configuredCount = await configured.count().catch(() => 0);
    if (configuredCount > 0) {
      return configured.first();
    }

    return this.page.getByRole("button", { name: "发送" }).first();
  }

  private async readConversationCandidateName(): Promise<string> {
    const configured = await this.readFirstText(this.page.locator(this.config.selectors.conversationCandidateName));
    if (configured) {
      return configured;
    }

    const lines = await this.readBodyLines();
    const jobIndex = lines.findIndex((line) => line.includes("沟通职位"));
    if (jobIndex > 0) {
      for (let index = jobIndex - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || /回复|沟通中|已约面|不合适|收藏|浏览过职位|在线|活跃|设置备注|已选：|取消|确定|\d+分钟前|\d+小时前/.test(line)) {
          continue;
        }
        return line;
      }
    }

    return "unknown";
  }

  private async readConversationMessages(): Promise<string[]> {
    const configured = (await this.readAllText(this.page.locator(this.config.selectors.conversationText)))
      .map((line) => this.sanitizeConversationText(line))
      .filter(Boolean);
    if (configured.length > 0) {
      return this.dedupeAdjacentMessages(configured);
    }

    const lines = await this.readBodyLines();
    const startIndex = lines.findIndex((line) => line.includes("当前沟通"));
    const endIndex = lines.findIndex((line) => line.includes("从这里开启对话"));
    if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
      return [];
    }

    return this.dedupeAdjacentMessages(
      lines
      .slice(startIndex + 1, endIndex)
      .map((line) => this.sanitizeConversationText(line))
      .filter(Boolean)
      .filter((line) => !/^\d{4}年\d+月\d+日/.test(line))
      .filter((line) => !/^(昨天|今天|凌晨|上午|下午|晚上)/.test(line))
      .filter((line) => !["已读", "要电话", "换微信", "要附件简历", "约面试", "不合适"].includes(line)),
    );
  }

  private async readCandidateConversationMessages(): Promise<string[]> {
    const candidateBubbles = this.page.locator(".im-message__bubble:not(.im-message__bubble--me)");
    const candidateOnly = await this.readAllText(candidateBubbles);
    return this.dedupeAdjacentMessages(
      candidateOnly
        .map((line) => this.sanitizeConversationText(line))
        .filter(Boolean)
        .filter((line) => !["已读", "查看附件简历"].includes(line)),
    );
  }

  private async hasCandidateResumeAttachmentCard(): Promise<boolean> {
    const candidateBubbles = this.page.locator(".im-message__bubble:not(.im-message__bubble--me)");
    const attachmentCard = candidateBubbles.filter({ hasText: /查看附件简历|附件简历/ });
    const attachmentCount = await attachmentCard.count().catch(() => 0);
    if (attachmentCount > 0) {
      return true;
    }

    const onlineResumeText = candidateBubbles.filter({ hasText: /在线简历|已发送在线简历|发送在线简历|发送了在线简历/ });
    const onlineTextCount = await onlineResumeText.count().catch(() => 0);
    if (onlineTextCount > 0) {
      return true;
    }

    const onlineResumeLink = candidateBubbles.locator("a").filter({ hasText: /在线简历/ });
    const onlineLinkCount = await onlineResumeLink.count().catch(() => 0);
    if (onlineLinkCount > 0) {
      return true;
    }

    return false;
  }

  private pickUnreadCount(unreadText: string, sessionText: string): number {
    const direct = Number(unreadText.replace(/[^\d]/g, "")) || 0;
    if (direct > 0) {
      return direct;
    }

    const fromPrefix = sessionText.match(/^(\d+)\s+/)?.[1];
    return Number(fromPrefix) || 0;
  }

  private sanitizeConversationText(input: string): string {
    return pickText(input)
      .replace(/已读$/, "")
      .replace(/^当前沟通.+?职位/, "")
      .replace(/^以下是90天内的聊天消息$/, "")
      .replace(/^查看附件简历$/, "")
      .trim();
  }

  private dedupeAdjacentMessages(messages: string[]): string[] {
    const deduped: string[] = [];
    for (const message of messages) {
      if (!message) {
        continue;
      }

      if (deduped.at(-1) === message) {
        continue;
      }
      deduped.push(message);
    }

    return deduped;
  }

  private async readBodyLines(): Promise<string[]> {
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    return bodyText
      .split(/\n+/)
      .map((line) => pickText(line))
      .filter(Boolean);
  }

  /**
   * 处理 Playwright 的 Download 对象
   */
  private async handleDownloadObject(download: Download, filenamePrefix?: string): Promise<string> {
    const resumeDir = this.config.storage.resumeDir ?? "./data/resumes";
    const fs = await import("node:fs/promises");
    await fs.mkdir(resumeDir, { recursive: true });
    
    const suggestedName = download.suggestedFilename();
    const extension = suggestedName.includes(".") ? suggestedName.split(".").pop() : "pdf";
    const safePrefix = filenamePrefix ? filenamePrefix.replace(/[/\\:*?"<>|]/g, "_") : undefined;
    const filename = safePrefix ? `${safePrefix}.${extension}` : `${Date.now()}-${suggestedName}`;
    const savePath = `${resumeDir}/${filename}`;
    
    await download.saveAs(savePath);
    console.log(`[InteractionPage] 简历已保存: ${savePath}`);
    return savePath;
  }

  /**
   * 尝试通过模拟出的 Page URL 采用 HTTP 请求直接下载内容 (通常更快)
   */
  private async downloadViaHttpRequest(page: Page, filenamePrefix?: string): Promise<string | undefined> {
    try {
      const url = page.url();
      const response = await this.page.context().request.get(url);
      if (response.ok()) {
        const buffer = await response.body();
        const resumeDir = this.config.storage.resumeDir ?? "./data/resumes";
        const fs = await import("node:fs/promises");
        await fs.mkdir(resumeDir, { recursive: true });

        const safePrefix = filenamePrefix ? filenamePrefix.replace(/[/\\:*?"<>|]/g, "_") : undefined;
        const contentDisposition = response.headers()["content-disposition"];
        let filename = safePrefix ? `${safePrefix}.pdf` : `resume-${Date.now()}.pdf`;
        
        if (!safePrefix && contentDisposition && contentDisposition.includes("filename=")) {
          const parts = contentDisposition.split("filename=");
          if (parts[1]) {
            filename = decodeURIComponent(parts[1].replace(/"/g, "")) || filename;
          }
        }
        
        const savePath = `${resumeDir}/${filename}`;
        await fs.writeFile(savePath, buffer);
        console.log(`[InteractionPage] 已通过 HTTP 请求快捷保存: ${savePath}`);
        return savePath;
      }
    } catch (e) {
      console.error(`[InteractionPage] HTTP 下载尝试失败: ${e}`);
    }
    return undefined;
  }
}
