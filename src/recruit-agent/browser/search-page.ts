import type { Locator, Page } from "playwright";

import type { BrowserCandidateSnapshot, RecruitAgentConfig, SearchKeywordPlan } from "../types.js";
import { BasePage } from "./base-page.js";

export class SearchPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  async runQuery(plan: SearchKeywordPlan, limit: number): Promise<BrowserCandidateSnapshot[]> {
    console.log("[搜索列表] 进入「搜索人才」…");
    await this.clickFirst(this.config.selectors.navSearch);
    await this.waitForReady();

    if (this.config.search.ensureNeverChattedFilter !== false) {
      await this.ensureNeverChattedFilter();
    }

    console.log(`[搜索列表] 填写关键词并搜索: ${plan.keyword}`);
    const input = await this.resolveSearchInput();
    await this.fillSearchKeyword(input, plan.keyword);
    await this.humanUiPause();
    await (await this.resolveSearchButton()).click();
    console.log("[搜索列表] 已点击「搜索」，等待网络与列表渲染…");
    await this.page.waitForLoadState("networkidle").catch(() => undefined);

    // 与 zhilian.trySendFromSearchList 一致：搜索列表用行容器，避免 candidateCards 多选择器匹配到子节点导致 listIndex 错位
    const rowSelector =
      this.page.url().includes("/app/search") || this.page.url().includes("/search")
        ? ".search-resume-item-wrap"
        : this.config.selectors.candidateCards;
    const cards = this.page.locator(rowSelector);
    const waitMs = this.config.search.searchResultsWaitMs ?? 20000;
    let rowTotal = await this.waitForSearchRows(rowSelector, waitMs);
    if (rowTotal < limit) {
      rowTotal = await this.expandSearchRowsToLimit(rowSelector, limit);
    }
    const snapshots: BrowserCandidateSnapshot[] = [];

    // 搜索人才：关键词搜到什么就处理什么，不因 job.excludeKeywords 等跳过列表项。
    for (let index = 0; index < rowTotal && snapshots.length < limit; index += 1) {
      const snapshot = await this.readCandidateCard(cards.nth(index), "search");
      snapshot.listIndex = index;
      snapshots.push(snapshot);
    }

    console.log(`[搜索列表] 解析候选人快照 ${snapshots.length} 条（目标 ${limit} 条，列表共 ${rowTotal} 行）`);
    return snapshots;
  }

  /**
   * 勾选「未聊过」，保证列表里多为可点「打招呼」的候选人（智联为 KM 勾选，非代码时则为浏览器记忆上次状态）。
   */
  private async ensureNeverChattedFilter(): Promise<void> {
    const p = this.page;
    if (!p.url().includes("/app/search") && !p.url().includes("/search")) {
      return;
    }

    const tryCheck = async (): Promise<boolean> => {
      const byRole = p.getByRole("checkbox", { name: /未聊过/ }).first();
      if ((await byRole.count().catch(() => 0)) > 0) {
        const checked = await byRole.isChecked().catch(() => false);
        if (!checked) {
          await byRole.click({ force: true }).catch(() => undefined);
          await p.waitForTimeout(500);
          console.log("[搜索列表] 已勾选「未聊过」（checkbox）");
          return true;
        }
        console.log("[搜索列表] 「未聊过」已勾选（checkbox）");
        return true;
      }
      const lab = p.locator("label:has-text('未聊过'), .km-checkbox:has-text('未聊过'), span:has-text('未聊过')").first();
      if ((await lab.count().catch(() => 0)) > 0 && (await lab.isVisible().catch(() => false))) {
        await lab.click({ force: true }).catch(() => undefined);
        await p.waitForTimeout(500);
        console.log("[搜索列表] 已点击「未聊过」标签/勾选区");
        return true;
      }
      // 智联等站也可能用自定义筛选项（非标准 checkbox）；只检测不点击，避免已勾选时被误点取消
      const byExact = p.getByText("未聊过", { exact: true }).first();
      if ((await byExact.count().catch(() => 0)) > 0 && (await byExact.isVisible().catch(() => false))) {
        console.log("[搜索列表] 已检测到「未聊过」筛选项（自定义控件，请保持页面勾选状态）");
        return true;
      }
      return false;
    };

    if (await tryCheck()) {
      await p.waitForLoadState("networkidle").catch(() => undefined);
    } else {
      console.log("[搜索列表] 未找到「未聊过」勾选控件（若列表无打招呼，请手动筛未聊过）");
    }
  }

  /** 带进度日志，避免长时间无输出像卡死 */
  private async waitForSearchRows(selector: string, timeoutMs: number): Promise<number> {
    console.log(`[搜索列表] 等待列表行出现（${selector}，最多 ${Math.round(timeoutMs / 1000)}s）…`);
    const startedAt = Date.now();
    let lastLogSec = -1;
    while (Date.now() - startedAt < timeoutMs) {
      const n = await this.page.locator(selector).count().catch(() => 0);
      if (n > 0) {
        console.log(`[搜索列表] 已出现 ${n} 条列表行`);
        return n;
      }
      await this.page.waitForTimeout(600);
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed >= lastLogSec + 2) {
        console.log(`[搜索列表] 仍在等待列表… ${elapsed}s`);
        lastLogSec = elapsed;
      }
    }
    const final = await this.page.locator(selector).count().catch(() => 0);
    console.log(`[搜索列表] 等待结束，${selector} 数量=${final}（若为 0 请检查选择器或页面是否异常）`);
    return final;
  }

  /**
   * 智联等站搜索列表常懒加载：首屏只有约 6～10 条 DOM，需向下滚动才会挂载更多 `.search-resume-item-wrap`。
   */
  private async expandSearchRowsToLimit(selector: string, limit: number): Promise<number> {
    let lastCount = -1;
    let stableRounds = 0;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const n = await this.page.locator(selector).count().catch(() => 0);
      if (n >= limit) {
        console.log(`[搜索列表] 滚动加载后共 ${n} 条列表行（目标 ${limit}）`);
        return n;
      }
      if (n === lastCount) {
        stableRounds += 1;
        if (stableRounds >= 4) {
          console.log(`[搜索列表] 列表行数停留在 ${n} 条（已达当前可加载上限或结果仅这么多）`);
          return n;
        }
      } else {
        stableRounds = 0;
      }
      lastCount = n;
      if (n > 0) {
        await this.page.locator(selector).nth(n - 1).scrollIntoViewIfNeeded().catch(() => undefined);
      }
      await this.page.evaluate(() => window.scrollBy(0, Math.min(1000, window.innerHeight || 800)));
      await this.page.waitForTimeout(650);
      await this.page.waitForLoadState("networkidle").catch(() => undefined);
      if (attempt % 5 === 0 && n > 0) {
        console.log(`[搜索列表] 滚动加载中… 当前 ${n} 条，目标至少 ${limit} 条`);
      }
    }
    const finalN = await this.page.locator(selector).count().catch(() => 0);
    console.log(`[搜索列表] 滚动结束，共 ${finalN} 条列表行`);
    return finalN;
  }

  /** 新版搜索框可能是 div[placeholder]（非 input），fill 会失败，需 click + 逐字输入 */
  private async fillSearchKeyword(locator: Locator, text: string): Promise<void> {
    await locator.click({ force: true }).catch(() => undefined);
    try {
      await locator.fill(text);
      return;
    } catch {
      // 非原生可编辑控件时走键盘
    }
    await locator.press("Control+a").catch(() => undefined);
    await locator.press("Meta+a").catch(() => undefined);
    await locator.press("Backspace").catch(() => undefined);
    await locator.pressSequentially(text, { delay: 25 }).catch(async () => {
      await this.page.keyboard.type(text, { delay: 25 });
    });
  }

  private async resolveSearchInput() {
    const candidates = this.splitSelectorCandidates(this.config.selectors.searchInput);
    for (const candidate of candidates) {
      const locator = this.page.locator(candidate).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        return locator;
      }
    }

    const byClass = this.page.locator(".keyword-input-tag-item-input__input").first();
    const classCount = await byClass.count().catch(() => 0);
    if (classCount > 0) {
      return byClass;
    }

    return this.page.getByPlaceholder("搜公司、职位、专业、学校、行业、技能等").first();
  }

  private async resolveSearchButton() {
    const candidates = this.splitSelectorCandidates(this.config.selectors.searchButton);
    for (const candidate of candidates) {
      const locator = this.page.locator(candidate).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        return locator;
      }
    }

    return this.page.getByRole("button", { name: /搜\s*索/ }).first();
  }
}
