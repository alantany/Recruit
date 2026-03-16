import type { Locator, Page } from "playwright";

import type { BrowserCandidateSnapshot, JobDefinition, RecruitAgentConfig } from "../types.js";
import { extractNumber, pickText, randomBetween, sleep, slugify, uniqueStrings } from "../utils.js";

export abstract class BasePage {
  protected readonly page: Page;

  protected readonly config: RecruitAgentConfig;

  constructor(page: Page, config: RecruitAgentConfig) {
    this.page = page;
    this.config = config;
  }

  protected async clickFirst(selector: string): Promise<void> {
    const candidates = this.splitSelectorCandidates(selector);
    let lastError: unknown;

    for (const candidate of candidates) {
      const locator = this.page.locator(candidate).first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) {
        continue;
      }

      try {
        await this.humanUiPause();
        await locator.click();
        return;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`未找到可点击元素: ${selector}`);
  }

  protected async readFirstText(locator: Locator): Promise<string> {
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      return "";
    }

    return pickText(await locator.first().innerText().catch(() => ""));
  }

  protected async readAllText(locator: Locator): Promise<string[]> {
    const count = await locator.count().catch(() => 0);
    const values: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const text = pickText(await locator.nth(index).innerText().catch(() => ""));
      if (text) {
        values.push(text);
      }
    }

    return values;
  }

  protected async waitForReady(): Promise<void> {
    const marker = this.config.selectors.pageReadyMarker;
    if (!marker) {
      return;
    }

    await this.page.locator(marker).first().waitFor({ state: "attached" }).catch(() => undefined);
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
  }

  protected async waitForElements(selector: string, timeoutMs = 12000): Promise<number> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const count = await this.page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return count;
      }

      await this.page.waitForTimeout(1000);
    }

    return this.page.locator(selector).count().catch(() => 0);
  }

  protected splitSelectorCandidates(selector: string): string[] {
    return selector
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  protected async humanUiPause(minMs = 700, maxMs = 1800): Promise<void> {
    await sleep(randomBetween(minMs, maxMs));
  }

  protected async readCandidateCard(card: Locator, pageName: BrowserCandidateSnapshot["sourcePage"]): Promise<BrowserCandidateSnapshot> {
    const cardText = pickText(await card.innerText().catch(() => ""));
    const cardLines = cardText
      .split(/\n+/)
      .map((line) => pickText(line))
      .filter(Boolean);
    const rawName = (await this.readFirstText(card.locator(this.config.selectors.candidateName))) || cardLines[0] || cardText || "unknown";
    const name = this.pickCandidateName(rawName, cardText);
    const meta = await this.readAllText(card.locator(this.config.selectors.candidateMeta));
    const fallbackMeta = meta.length > 0 ? meta : cardLines.slice(1, 6);
    const tags = await this.readAllText(card.locator(this.config.selectors.candidateTags));
    const summary = (await this.readFirstText(card.locator(this.config.selectors.candidateSummary))) || cardLines.slice(0, 12).join(" ");
    const linkLocator = card.locator(this.config.selectors.candidateLink).first();
    const linkCount = await linkLocator.count().catch(() => 0);
    const sourceUrl = linkCount > 0 ? await linkLocator.getAttribute("href").catch(() => null) : null;
    const lines = fallbackMeta.join(" ");
    const stableKey = this.buildCandidateStableKey({
      name,
      sourceUrl,
      lines,
      summary,
    });

    return {
      id: stableKey,
      stableKey,
      name: name || "unknown",
      location: this.pickByHint(lines, ["北京", "上海", "广州", "深圳", "杭州", "苏州", "达州", "成都", "南京", "长春"]),
      age: extractNumber(this.pickByPattern(lines, /(\d+)\s*岁/)),
      experienceYears: extractNumber(this.pickByPattern(lines, /(\d+)\s*年/)),
      education: this.pickEducation(lines),
      school: this.pickSchool(`${summary} ${lines}`),
      currentCompany: this.pickCompany(summary),
      currentTitle: this.pickTitle(summary),
      expectedPosition: this.pickTitle(lines),
      expectedSalaryRaw: this.pickSalary(lines),
      lastActiveAt: this.pickLastActive(lines),
      tags,
      summary,
      sourceUrl: sourceUrl ? new URL(sourceUrl, this.config.browser.baseUrl).toString() : undefined,
      sourcePage: pageName,
    };
  }

  private buildCandidateStableKey(input: {
    name: string;
    sourceUrl: string | null;
    lines: string;
    summary: string;
  }): string {
    if (input.sourceUrl) {
      return slugify(input.sourceUrl);
    }

    return slugify(`${input.name}-${input.lines}-${input.summary}`);
  }

  protected toJobDefinition(input: {
    id: string;
    title: string;
    cityText?: string;
    salaryRange?: string;
    responsibilities: string;
    requirements: string;
    status?: string;
    sourceUrl?: string;
  }): JobDefinition {
    const combined = `${input.title} ${input.responsibilities} ${input.requirements}`;
    const cityNames = uniqueStrings(
      (input.cityText ?? "")
        .split(/[\/,，、\s]+/)
        .map((item) => item.trim()),
    );

    return {
      id: input.id,
      title: input.title,
      cityNames,
      salaryRange: input.salaryRange,
      requiredEducation: this.pickEducation(input.requirements),
      minExperienceYears: extractNumber(this.pickByPattern(input.requirements, /(\d+)\s*年/)),
      responsibilities: input.responsibilities,
      requirements: input.requirements,
      companyName: this.config.job.companyName,
      status: input.status,
      sourceUrl: input.sourceUrl,
      keywords: uniqueStrings(combined.split(/[\s,，、;；]/)),
      syncedAt: new Date().toISOString(),
    };
  }

  protected pickByHint(source: string, hints: string[]): string | undefined {
    return hints.find((hint) => source.includes(hint));
  }

  protected pickByPattern(source: string, pattern: RegExp): string | undefined {
    return source.match(pattern)?.[0];
  }

  protected pickSalary(source: string): string | undefined {
    return source.match(/\d+(?:\.\d+)?-\d+(?:\.\d+)?[万kK]/)?.[0];
  }

  protected pickEducation(source: string): string | undefined {
    return ["博士", "硕士", "本科", "大专", "中专"].find((item) => source.includes(item));
  }

  protected pickSchool(source: string): string | undefined {
    return source.match(/([^\s，、]+大学|[^\s，、]+学院)/)?.[1];
  }

  protected pickCompany(source: string): string | undefined {
    const parts = source.split(/[·|｜]/).map((item) => item.trim()).filter(Boolean);
    return parts[0];
  }

  protected pickTitle(source: string): string | undefined {
    const parts = source.split(/[·|｜]/).map((item) => item.trim()).filter(Boolean);
    return parts[1] || parts[0];
  }

  protected pickLastActive(source: string): string | undefined {
    return source.match(/\d+[小时天分钟前]+/)?.[0];
  }

  protected pickCandidateName(primary: string, fallback: string): string {
    const match = `${primary} ${fallback}`.match(/([\u4e00-\u9fa5A-Za-z]+(?:先生|女士|同学|老师))/);
    if (match?.[1]) {
      return match[1];
    }

    return pickText(primary).split(/\s+/)[0] || "unknown";
  }
}
