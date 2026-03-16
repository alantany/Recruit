import type { Page } from "playwright";

import type { BrowserCandidateSnapshot, RecruitAgentConfig, SearchKeywordPlan } from "../types.js";
import { BasePage } from "./base-page.js";

export class SearchPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  async runQuery(plan: SearchKeywordPlan, limit: number): Promise<BrowserCandidateSnapshot[]> {
    await this.clickFirst(this.config.selectors.navSearch);
    await this.waitForReady();

    const input = await this.resolveSearchInput();
    await input.fill(plan.keyword);
    await this.humanUiPause();
    await (await this.resolveSearchButton()).click();
    await this.page.waitForLoadState("networkidle").catch(() => undefined);

    const cards = this.page.locator(this.config.selectors.candidateCards);
    const count = Math.min(await this.waitForElements(this.config.selectors.candidateCards), limit);
    const snapshots: BrowserCandidateSnapshot[] = [];

    for (let index = 0; index < count; index += 1) {
      const snapshot = await this.readCandidateCard(cards.nth(index), "search");
      if (this.isExcludedSnapshot(snapshot, plan.excludes)) {
        continue;
      }
      snapshots.push(snapshot);
    }

    return snapshots;
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

    return this.page.getByPlaceholder("搜公司、职位、专业、学校、行业、技能等");
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

    return this.page.getByRole("button", { name: /搜\s*索/ });
  }

  private isExcludedSnapshot(snapshot: BrowserCandidateSnapshot, excludes: string[]): boolean {
    if (excludes.length === 0) {
      return false;
    }

    const text = [
      snapshot.name,
      snapshot.currentCompany,
      snapshot.currentTitle,
      snapshot.summary,
      snapshot.tags.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return excludes.some((item) => text.includes(item.toLowerCase()));
  }
}
