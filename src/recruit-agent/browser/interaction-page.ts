import type { Locator, Page } from "playwright";

import type { RecruitAgentConfig } from "../types.js";
import { pickText } from "../utils.js";
import { BasePage } from "./base-page.js";

export interface InteractionThreadSnapshot {
  threadKey: string;
  threadIndex: number;
  candidateName: string;
  unreadCount: number;
  latestReply: string;
  latestCandidateReply: string;
  hasResumeAttachmentCard: boolean;
  allMessages: string[];
}

export class InteractionPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  async scanUnread(limit: number): Promise<InteractionThreadSnapshot[]> {
    await this.openInteraction();

    const items = await this.listConversationItems();
    const count = Math.min(await items.count().catch(() => 0), limit);
    const threads: InteractionThreadSnapshot[] = [];

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const sessionText = pickText(await item.innerText().catch(() => ""));
      const unreadText = await this.readFirstText(item.locator(this.config.selectors.conversationUnreadBadge));
      const unreadCount = this.pickUnreadCount(unreadText, sessionText);
      if (unreadCount <= 0) {
        continue;
      }

      await this.humanUiPause(600, 1500);
      await item.click();
      await this.page.waitForTimeout(500);
      const candidateName = await this.readConversationCandidateName();
      const allMessages = await this.readConversationMessages();
      const candidateMessages = await this.readCandidateConversationMessages();
      const hasResumeAttachmentCard = await this.hasCandidateResumeAttachmentCard();
      threads.push({
        threadKey: sessionText || `${candidateName}-${index}`,
        threadIndex: index,
        candidateName: candidateName || "unknown",
        unreadCount,
        latestReply: candidateMessages.at(-1) ?? allMessages.at(-1) ?? "",
        latestCandidateReply: candidateMessages.at(-1) ?? "",
        hasResumeAttachmentCard,
        allMessages,
      });
    }

    return threads;
  }

  async scanRecentNoUnread(limit: number): Promise<InteractionThreadSnapshot[]> {
    await this.openInteraction();

    const items = await this.listConversationItems();
    const count = Math.min(await items.count().catch(() => 0), limit);
    const threads: InteractionThreadSnapshot[] = [];

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const sessionText = pickText(await item.innerText().catch(() => ""));
      const unreadText = await this.readFirstText(item.locator(this.config.selectors.conversationUnreadBadge));
      const unreadCount = this.pickUnreadCount(unreadText, sessionText);
      if (unreadCount > 0) {
        continue;
      }

      await this.humanUiPause(600, 1500);
      await item.click();
      await this.page.waitForTimeout(500);
      const candidateName = await this.readConversationCandidateName();
      const allMessages = await this.readConversationMessages();
      const candidateMessages = await this.readCandidateConversationMessages();
      const hasResumeAttachmentCard = await this.hasCandidateResumeAttachmentCard();
      if (allMessages.length === 0) {
        continue;
      }

      threads.push({
        threadKey: sessionText || `${candidateName}-${index}`,
        threadIndex: index,
        candidateName: candidateName || "unknown",
        unreadCount,
        latestReply: candidateMessages.at(-1) ?? allMessages.at(-1) ?? "",
        latestCandidateReply: candidateMessages.at(-1) ?? "",
        hasResumeAttachmentCard,
        allMessages,
      });
    }

    return threads;
  }

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

    // 兼容“在线简历”场景：候选人发送在线简历时通常包含提示文本或在线简历链接。
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
}
