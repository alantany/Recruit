import type { Page } from "playwright";

import type { JobDefinition, RecruitAgentConfig } from "../types.js";
import { slugify } from "../utils.js";
import { BasePage } from "./base-page.js";

export class JobCenterPage extends BasePage {
  constructor(page: Page, config: RecruitAgentConfig) {
    super(page, config);
  }

  async syncJobs(limit: number): Promise<JobDefinition[]> {
    await this.clickFirst(this.config.selectors.navJobCenter);
    await this.waitForReady();
    await this.waitForElements(this.config.selectors.jobCards).catch(() => undefined);

    const cards = this.page.locator(this.config.selectors.jobCards);
    const count = Math.min(await cards.count().catch(() => 0), limit);
    const jobs: JobDefinition[] = [];

    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const cardText = await card.innerText().catch(() => "");
      const title =
        (await this.readFirstText(card.locator(this.config.selectors.jobTitle))) ||
        cardText
          .split(/\n+/)
          .map((line) => line.trim())
          .find(Boolean);
      const meta = (await this.readAllText(card.locator(this.config.selectors.jobMeta))).join(" ");
      const status = await this.readFirstText(card.locator(this.config.selectors.jobStatus));
      const link = card.locator(this.config.selectors.jobLink).first();
      const href = (await link.count().catch(() => 0)) > 0 ? await link.getAttribute("href").catch(() => null) : null;

      if (href) {
        await this.humanUiPause();
        await link.click().catch(() => undefined);
        await this.page.waitForTimeout(400);
      }

      const responsibilities = await this.readFirstText(this.page.locator(this.config.selectors.jobResponsibilities));
      const requirements = await this.readFirstText(this.page.locator(this.config.selectors.jobRequirements));
      const sourceUrl = href ? new URL(href, this.config.browser.baseUrl).toString() : this.page.url();

      jobs.push(
        this.toJobDefinition({
          id: slugify(`${title}-${sourceUrl || index}`),
          title: title || `职位-${index + 1}`,
          cityText: meta,
          salaryRange: this.pickSalary(meta),
          responsibilities,
          requirements,
          status,
          sourceUrl,
        }),
      );
    }

    return jobs;
  }
}
