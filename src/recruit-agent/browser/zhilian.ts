import { chromium, type BrowserContext, type Page } from "playwright";

import type { BrowserCandidateSnapshot, RecruitAgentConfig } from "../types.js";
import { randomBetween, sleep } from "../utils.js";
import { InteractionPage } from "./interaction-page.js";
import { JobCenterPage } from "./job-center.js";
import { PotentialPage } from "./potential-page.js";
import { RecommendPage } from "./recommend-page.js";
import { SearchPage } from "./search-page.js";

export class ZhilianBrowserRunner {
  private readonly config: RecruitAgentConfig;

  private context?: BrowserContext;

  constructor(config: RecruitAgentConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.context) {
      return;
    }

    this.context = await chromium.launchPersistentContext(this.config.browser.userDataDir, {
      headless: this.config.browser.headless,
      slowMo: this.config.browser.slowMoMs,
      viewport: { width: 1440, height: 1024 },
    });
    this.context.setDefaultTimeout(this.config.browser.defaultTimeoutMs);
  }

  async stop(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
  }

  async getPage(): Promise<Page> {
    await this.start();
    const current = this.context!.pages()[0];
    if (current) {
      return current;
    }

    return this.context!.newPage();
  }

  async openHome(): Promise<Page> {
    const page = await this.getPage();
    await page.goto(this.config.browser.baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    return page;
  }

  async jobCenterPage(): Promise<JobCenterPage> {
    return new JobCenterPage(await this.openHome(), this.config);
  }

  async recommendPage(): Promise<RecommendPage> {
    return new RecommendPage(await this.openHome(), this.config);
  }

  async searchPage(): Promise<SearchPage> {
    return new SearchPage(await this.openHome(), this.config);
  }

  async potentialPage(): Promise<PotentialPage> {
    return new PotentialPage(await this.openHome(), this.config);
  }

  async interactionPage(): Promise<InteractionPage> {
    return new InteractionPage(await this.openHome(), this.config);
  }

  async sendMessages(candidate: BrowserCandidateSnapshot, messages: string[]): Promise<void> {
    const page = await this.getPage();
    if (candidate.sourceUrl) {
      await page.goto(candidate.sourceUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(this.config.browser.baseUrl, { waitUntil: "domcontentloaded" });
    }

    await page.waitForLoadState("networkidle").catch(() => undefined);
    await this.humanUiPause();
    await page.locator(this.config.selectors.openChatButton).first().click();
    const input = page.locator(this.config.selectors.chatInput).first();
    const sendButton = page.locator(this.config.selectors.sendButton).first();

    for (const message of messages) {
      await input.fill(message);
      await this.humanUiPause(500, 1300);
      await sendButton.click();
      await page.waitForTimeout(800);
    }
  }

  private async humanUiPause(minMs = 700, maxMs = 1800): Promise<void> {
    await sleep(randomBetween(minMs, maxMs));
  }
}
