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
  // 登录只需验证一次，后续任务直接复用
  private loginVerified = false;

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
    this.loginVerified = false;
  }

  async stop(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.loginVerified = false;
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
    // 登录态只在首次启动后验证一次，避免每个任务都重复检查导致超时
    if (!this.loginVerified) {
      await this.waitForLogin(page);
      this.loginVerified = true;
    }
    return page;
  }

  // 检测登录态：如果未登录则等待最多 5 分钟，每隔 5 秒检测一次
  private async waitForLogin(page: Page): Promise<void> {
    const loginIndicators = ["a:has-text('互动')", "text=互动", "[href*='interaction']", ".nav-item:has-text('互动')"];
    const loggedInCheck = async () => {
      for (const sel of loginIndicators) {
        try {
          const count = await page.locator(sel).count();
          if (count > 0) return true;
        } catch {
          // ignore
        }
      }
      // 也检测 URL 是否已经在 rd6.zhaopin.com 且不是登录页
      const url = page.url();
      if (url.includes("rd6.zhaopin.com") && !url.includes("login") && !url.includes("passport")) {
        // 再看是否有明显的登录后元素
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (bodyText.includes("互动") || bodyText.includes("职位中心") || bodyText.includes("推荐人才")) {
          return true;
        }
      }
      return false;
    };

    if (await loggedInCheck()) return;

    console.log("[等待登录] 未检测到登录态，请在浏览器中完成登录...");
    const maxWaitMs = 5 * 60 * 1000; // 最多等 5 分钟
    const intervalMs = 5000;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await sleep(intervalMs);
      if (await loggedInCheck()) {
        console.log("[等待登录] 登录成功，继续执行...");
        return;
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[等待登录] 已等待 ${elapsed}s，请尽快完成登录...`);
    }
    throw new Error("等待登录超时（5分钟），请重新运行并登录");
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
