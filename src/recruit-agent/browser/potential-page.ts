import type { Page } from "playwright";

import type { BrowserCandidateSnapshot, RecruitAgentConfig } from "../types.js";
import { BasePage } from "./base-page.js";

export class PotentialPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  async collectCandidates(limit: number): Promise<BrowserCandidateSnapshot[]> {
    await this.clickFirst(this.config.selectors.navPotential);
    await this.waitForReady();

    const cards = this.page.locator(this.config.selectors.candidateCards);
    const count = Math.min(await this.waitForElements(this.config.selectors.candidateCards), limit);
    const snapshots: BrowserCandidateSnapshot[] = [];

    for (let index = 0; index < count; index += 1) {
      snapshots.push(await this.readCandidateCard(cards.nth(index), "potential"));
    }

    return snapshots;
  }
}
