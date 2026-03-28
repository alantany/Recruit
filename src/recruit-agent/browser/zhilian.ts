import { chromium, type BrowserContext, type Frame, type Locator, type Page } from "playwright";

import type { BrowserCandidateSnapshot, RecruitAgentConfig } from "../types.js";
import { pickText, randomBetween, sleep } from "../utils.js";
import { isChromiumProfileSingletonError, preparePersistentProfileDir } from "./chromium-profile-lock.js";
import { InteractionPage } from "./interaction-page.js";
import { JobCenterPage } from "./job-center.js";
import { PotentialPage } from "./potential-page.js";
import { RecommendPage } from "./recommend-page.js";
import { SearchPage } from "./search-page.js";

export class ZhilianBrowserRunner {
  private readonly config: RecruitAgentConfig;

  private context?: BrowserContext;
  /** 当前任务正在操作的页（与 runQuery 同源），避免用 pages()[0] 误指其它标签页 */
  private workPage?: Page;
  // 登录只需验证一次，后续任务直接复用
  private loginVerified = false;

  constructor(config: RecruitAgentConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.context) {
      return;
    }

    const dir = this.config.browser.userDataDir;
    const launch = () =>
      chromium.launchPersistentContext(dir, {
        headless: this.config.browser.headless,
        slowMo: this.config.browser.slowMoMs,
        viewport: { width: 1440, height: 1024 },
      });

    await preparePersistentProfileDir(dir);
    try {
      this.context = await launch();
    } catch (e) {
      if (!isChromiumProfileSingletonError(e)) {
        throw e;
      }
      console.warn("[浏览器] 首次启动仍报 profile 占用，正在再次结束占用进程并清理锁后重试…");
      await preparePersistentProfileDir(dir);
      await sleep(500);
      this.context = await launch();
    }
    this.context.setDefaultTimeout(this.config.browser.defaultTimeoutMs);
    this.loginVerified = false;
  }

  async stop(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.workPage = undefined;
    this.loginVerified = false;
  }

  async getPage(): Promise<Page> {
    await this.start();
    if (this.workPage && !this.workPage.isClosed()) {
      return this.workPage;
    }
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
    const page = await this.openHome();
    this.workPage = page;
    return new RecommendPage(page, this.config);
  }

  async searchPage(): Promise<SearchPage> {
    const page = await this.openHome();
    this.workPage = page;
    return new SearchPage(page, this.config);
  }

  async potentialPage(): Promise<PotentialPage> {
    const page = await this.openHome();
    this.workPage = page;
    return new PotentialPage(page, this.config);
  }

  async interactionPage(): Promise<InteractionPage> {
    return new InteractionPage(await this.openHome(), this.config);
  }

  async sendMessages(candidate: BrowserCandidateSnapshot, messages: string[]): Promise<string[]> {
    const page = await this.getPage();
    await page.bringToFront().catch(() => undefined);
    const sentFromSearchList = await this.trySendFromSearchList(page, candidate, messages);
    if (sentFromSearchList) {
      return sentFromSearchList;
    }
    const cardCount = await this.countSearchRowCards(page);
    const greetCount = await this.countGreetLikeElements(page);
    throw new Error(
      `搜索列表链路未完成：未能在当前结果页完成打招呼流程 (url=${page.url()} cards=${cardCount} greet=${greetCount})`,
    );
  }

  /**
   * 与 tryClickGreetOnCard 一致：智联上「打招呼」可能是 button / a / span，未必带 role=button。
   */
  private async cardHasVisibleGreetEntry(card: Locator): Promise<boolean> {
    const roleBtn = card.getByRole("button", { name: /打招呼|立即沟通|聊一聊|立即开聊/ }).first();
    if ((await roleBtn.count().catch(() => 0)) > 0 && (await roleBtn.isVisible().catch(() => false))) {
      return true;
    }
    const loose = card
      .locator(
        "button:has-text('打招呼'), a:has-text('打招呼'), [role='button']:has-text('打招呼'), span:has-text('打招呼')",
      )
      .first();
    if ((await loose.count().catch(() => 0)) > 0 && (await loose.isVisible().catch(() => false))) {
      return true;
    }
    const textHit = card.getByText("打招呼", { exact: false }).first();
    if ((await textHit.count().catch(() => 0)) > 0 && (await textHit.isVisible().catch(() => false))) {
      return true;
    }
    return false;
  }

  /**
   * 当前结果页从上到下找第一张仍可见「打招呼」类入口的卡片。
   */
  private async findFirstGreetableCardIndex(cards: Locator, cardCount: number, maxScan: number): Promise<number | null> {
    const n = Math.min(cardCount, maxScan);
    for (let i = 0; i < n; i += 1) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.humanUiPause(80, 150);
      if (await this.cardHasVisibleGreetEntry(card)) {
        console.log(`[搜索列表] 卡片 ${i}: 已检测到可见「打招呼」入口，选为本轮目标`);
        return i;
      }
      console.log(`[搜索列表] 卡片 ${i}: 未检测到可见「打招呼」（可能为继续沟通等）`);
    }
    return null;
  }

  private async trySendFromSearchList(
    page: Page,
    candidate: BrowserCandidateSnapshot,
    messages: string[],
  ): Promise<string[] | undefined> {
    // 搜索列表页：用行级容器，避免 candidateCards 过宽匹配嵌套子节点导致点不到「打招呼」
    const cards =
      page.url().includes("/app/search") || page.url().includes("/search")
        ? page.locator(".search-resume-item-wrap")
        : page.locator(this.config.selectors.candidateCards);
    const cardCount = await cards.count().catch(() => 0);
    if (cardCount <= 0) {
      console.log(`[搜索列表] 当前页未找到候选人行卡片，无法点打招呼 url=${page.url()}`);
      return undefined;
    }

    const tryClickGreetOnCard = async (card: ReturnType<typeof cards.nth>): Promise<boolean> => {
      const roleBtn = card.getByRole("button", { name: /打招呼|立即沟通|聊一聊|立即开聊/ }).first();
      if ((await roleBtn.count().catch(() => 0)) > 0) {
        await roleBtn.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1000);
        return true;
      }
      const textHit = card.getByText("打招呼", { exact: false }).first();
      if ((await textHit.count().catch(() => 0)) > 0) {
        await textHit.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1000);
        return true;
      }
      const candidates = [
        this.config.selectors.candidateCardChatButton,
        "button:has-text('打招呼')",
        "[role='button']:has-text('打招呼')",
        "a:has-text('打招呼')",
        "text=打招呼",
        "span:has-text('打招呼')",
        "div:has-text('打招呼')",
      ];
      for (const selector of candidates) {
        const button = card.locator(selector).first();
        const buttonCount = await button.count().catch(() => 0);
        if (buttonCount <= 0) {
          continue;
        }
        await button.click().catch(() => undefined);
        await this.humanUiPause(500, 1000);
        return true;
      }
      return false;
    };

    // 优先选「还没打过招呼」的卡片；若全是已沟通则退回 listIndex
    const fallbackIdx =
      typeof candidate.listIndex === "number" && candidate.listIndex >= 0 && candidate.listIndex < cardCount
        ? candidate.listIndex
        : 0;
    const greetableIdx = await this.findFirstGreetableCardIndex(cards, cardCount, 25);
    const primaryIndex = greetableIdx !== null ? greetableIdx : fallbackIdx;
    if (greetableIdx !== null) {
      console.log(
        `[搜索列表] 已自动选中第 ${primaryIndex} 张（首个仍可打招呼）；解析顺序原为 listIndex=${fallbackIdx} ${candidate.name ?? ""}`,
      );
      if (primaryIndex !== fallbackIdx) {
        console.log(
          "[搜索列表] 提示：实际点击的卡片与列表解析顺序不一致时，状态里仍按解析到的候选人记录；若要严格一致请改配置或清空状态后重试。",
        );
      }
    } else {
      console.log(
        `[搜索列表] 未扫描到明确「打招呼」按钮，按原顺序试第 ${primaryIndex} 张（${candidate.name ?? "未知姓名"}）`,
      );
    }
    const tryCardFlow = async (index: number): Promise<string[] | undefined> => {
      const targetCard = cards.nth(index);
      await targetCard.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.humanUiPause(400, 800);
      console.log(
        `[搜索列表] 即将点击第 ${index} 张卡片上的「打招呼」类按钮（共 ${cardCount} 张，请留意浏览器视口）`,
      );
      if (!(await tryClickGreetOnCard(targetCard))) {
        console.log(`[搜索列表] 卡片 ${index}: 未在卡片内点到打招呼`);
        return undefined;
      }
      console.log(`[搜索列表] 卡片 ${index}: 已点击打招呼，等待弹窗`);
      await page.waitForTimeout(250);
      // 只等「选择沟通职位」弹层，不要与 AI招呼语/其它文案共用一个正则，否则可能等到别的节点或拖满超时
      await page.locator(".km-modal--open").first().waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
      await page.getByText("选择沟通职位", { exact: false }).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);

      const ctx = page.context();
      const tabCountBefore = ctx.pages().length;
      await this.ensureGreetingJobSelected(page);
      console.log(`[搜索列表] 卡片 ${index}: 职位选择步骤结束`);
      // 智联常见：点确定后首条已自动发出，页面上未必出现可匹配的 IM 输入框；若先判定「已发送/弹窗已关」则勿空等 15s 轮询输入框
      let uiPage = page;
      if ((await this.quickPostJobConfirmGreetStatus(page)) === "likely_done") {
        console.log(`[搜索列表] 卡片 ${index}: 选职后已检测到发送完成或弹窗已关，跳过等待输入框`);
      } else {
        uiPage = await this.waitForChatInputSurfaceAfterConfirm(page, tabCountBefore, index);
      }

      // 诊断：记录当前 URL 和可见元素
      const diagUrl = uiPage.url();
      const diagVisible = await uiPage.evaluate(() => {
        const hints: string[] = [];
        for (const sel of [
          "textarea", "[contenteditable='true']", "[role='dialog']",
          "[class*='im-']", "[class*='chat-']", "[class*='compose']",
          "[class*='editor']", "[class*='input']", "[class*='send']",
          "button", ".ant-modal-content",
        ]) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) {
            hints.push(`${sel}:${els.length}`);
          }
        }
        return hints.join(", ");
      }).catch(() => "");
      console.log(`[搜索列表] 卡片 ${index}: 确认后 URL=${diagUrl} 可见元素=${diagVisible}`);

      // 截图，诊断确认后界面
      await uiPage.screenshot({ path: `data/after_greet_${index}_${Date.now()}.png`, fullPage: false }).catch(() => undefined);

      // 检测「打招呼」是否已自动完成：Zhilian 搜索页点确定后直接发送，无需单独聊天窗口
      const greetDone = await uiPage.evaluate(() => {
        // 若「选择沟通职位」弹窗已关闭，说明已成功发送
        const hasJobSelectModal = !!document.querySelector(".km-modal--open");
        // 检查「继续沟通」或「消息已发送」标志
        const body = document.body?.innerText ?? "";
        const hasSentMark = body.includes("消息已发送") || body.includes("继续沟通");
        return { hasJobSelectModal, hasSentMark };
      }).catch(() => ({ hasJobSelectModal: false, hasSentMark: false }));

      if (!greetDone.hasJobSelectModal && greetDone.hasSentMark) {
        console.log(`[搜索列表] 卡片 ${index}: 招呼已自动发送（检测到「继续沟通/消息已发送」）`);
        const first = messages[0];
        return first !== undefined ? [first] : ["已发送"];
      }
      if (!greetDone.hasJobSelectModal) {
        console.log(`[搜索列表] 卡片 ${index}: 确认弹窗已关闭，视为招呼发送成功`);
        const first = messages[0];
        return first !== undefined ? [first] : ["已发送"];
      }

      const sentByAIGreeting = await this.trySendByAIGreetingDialog(uiPage);
      if (sentByAIGreeting) {
        return ["AI个性化招呼语：使用并发送"];
      }
      const sentComposer = await this.trySendFromChatComposer(uiPage, messages);
      if (sentComposer) {
        console.log(`[搜索列表] 卡片 ${index}: 已通过聊天输入框发送`);
        const first = messages[0];
        return first !== undefined ? [first] : ["已发送"];
      }
      const snippet = await uiPage
        .evaluate(() => (document.body?.innerText ?? "").slice(0, 1200))
        .catch(() => "");
      console.log(`[搜索列表] 卡片 ${index}: 未完成发送；页面正文片段: ${snippet.slice(0, 280).replace(/\s+/g, " ")}`);
      return undefined;
    };

    const primary = await tryCardFlow(primaryIndex);
    if (primary) {
      return primary;
    }

    for (let i = 0; i < Math.min(cardCount, 8); i += 1) {
      if (i === primaryIndex) {
        continue;
      }
      const retry = await tryCardFlow(i);
      if (retry) {
        return retry;
      }
    }

    return undefined;
  }

  private async ensureChatReady(page: Page): Promise<void> {
    const input = page.locator(this.config.selectors.chatInput).first();
    const hasInputDirectly = (await input.count().catch(() => 0)) > 0;
    if (hasInputDirectly) {
      return;
    }

    const openChatCandidates = [
      this.config.selectors.openChatButton,
      "text=打招呼",
      "button:has-text('立即沟通')",
      "button:has-text('打招呼')",
      "button:has-text('立即开聊')",
      "button:has-text('聊一聊')",
      "button:has-text('沟通')",
      "[role='button']:has-text('打招呼')",
      "div:has-text('打招呼')",
      "a:has-text('立即沟通')",
      "a:has-text('打招呼')",
    ];
    for (const selector of openChatCandidates) {
      const button = page.locator(selector).first();
      const count = await button.count().catch(() => 0);
      if (count <= 0) {
        continue;
      }
      await button.click().catch(() => undefined);
      await this.humanUiPause(400, 900);
      const hasInputAfterClick = (await input.count().catch(() => 0)) > 0;
      if (hasInputAfterClick) {
        return;
      }
    }

    throw new Error(`未找到可用的打招呼/沟通入口，当前页面: ${page.url()}`);
  }

  /**
   * 沟通职位 Ant Select 的 portal：须带「职位名称 / 发布地」等搜索框，避免与搜索页筛选项的其它下拉混淆。
   */
  private resolveCommunicationJobDropdown(page: Page): Locator {
    return page.locator(".ant-select-dropdown:visible, .rc-select-dropdown:visible").filter({
      has: page.locator(
        "input[placeholder*='职位名称'], input[placeholder*='发布地'], input.ant-select-selection-search-input, input[type='search']",
      ),
    });
  }

  private async pickVisibleJobDropdown(page: Page): Promise<Locator> {
    const filtered = this.resolveCommunicationJobDropdown(page);
    if ((await filtered.count().catch(() => 0)) > 0) {
      return filtered.first();
    }
    return page.locator(".ant-select-dropdown:visible, .rc-select-dropdown:visible").last();
  }

  /** React 受控 input 时 locator.fill 可能无效，用原生 setter + input 事件触发过滤 */
  private async fillJobDropdownSearchViaEvaluate(page: Page, wanted: string): Promise<boolean> {
    const ok = await page.evaluate((text: string) => {
      const roots = Array.from(document.querySelectorAll(".ant-select-dropdown, .rc-select-dropdown")) as HTMLElement[];
      const visible = roots.filter((el) => {
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      });
      for (const root of visible) {
        const inp =
          (root.querySelector(
            "input[placeholder*='职位名称'], input[placeholder*='发布地'], input.ant-select-selection-search-input",
          ) as HTMLInputElement | null) ||
          (root.querySelector("input[type='search']") as HTMLInputElement | null) ||
          (root.querySelector("input") as HTMLInputElement | null);
        if (!inp) {
          continue;
        }
        inp.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (desc?.set) {
          desc.set.call(inp, text);
        } else {
          inp.value = text;
        }
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }, wanted);
    return ok;
  }

  /** 智联下拉内搜索框可能是只读态，fill 失败时用逐字输入 */
  private async fillOrTypeLocator(page: Page, loc: Locator, text: string): Promise<void> {
    await loc.click({ force: true }).catch(() => undefined);
    try {
      await loc.fill(text);
      return;
    } catch {
      // 非标准 input
    }
    await loc.press("Control+a").catch(() => undefined);
    await loc.press("Meta+a").catch(() => undefined);
    await loc.press("Backspace").catch(() => undefined);
    await loc.pressSequentially(text, { delay: 22 }).catch(async () => {
      await page.keyboard.type(text, { delay: 22 });
    });
  }

  /**
   * 在已展开的职位下拉 portal 内填写「职位名称/发布地」搜索（DOM 在 body 下，不在弹窗根内）。
   */
  private async fillJobDropdownSearch(page: Page, dialog: Locator, wanted: string): Promise<void> {
    const dropdown = await this.pickVisibleJobDropdown(page);
    await dropdown.waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);

    const inPortal = [
      dropdown.locator("input[placeholder*='职位名称 / 发布地']").first(),
      dropdown.locator("input[placeholder*='职位名称']").first(),
      dropdown.locator("input[placeholder*='发布地']").first(),
      dropdown.locator("input.ant-select-selection-search-input").first(),
      dropdown.locator("input[placeholder*='发布']").first(),
      dropdown.locator("input[placeholder*='搜索']").first(),
      dropdown.locator("input[type='search']").first(),
      dropdown.locator("input").first(),
      page.locator(".ant-select-dropdown:visible input.ant-select-selection-search-input").last(),
      dialog.locator("input[placeholder*='职位名称'], input[placeholder*='发布地'], input[placeholder*='职位名称 / 发布地']").first(),
      dialog.locator("input[placeholder*='职位']").first(),
    ];

    for (let i = 0; i < inPortal.length; i += 1) {
      const loc = inPortal[i];
      if (!loc) {
        continue;
      }
      if ((await loc.count().catch(() => 0)) === 0) {
        continue;
      }
      if (!(await loc.isVisible().catch(() => false))) {
        continue;
      }
      await this.fillOrTypeLocator(page, loc, wanted);
      console.log(`[搜索列表] 已在职位下拉搜索框输入关键字（候选 ${i}）`);
      return;
    }

    if (await this.fillJobDropdownSearchViaEvaluate(page, wanted)) {
      console.log("[搜索列表] 已在职位下拉搜索框输入关键字（evaluate 注入）");
      return;
    }

    console.log("[搜索列表] 未定位到职位下拉内搜索框，跳过关键字输入");
  }

  /** 下拉已展开但选项点不中时，用方向键+回车选当前高亮项 */
  private async trySelectJobWithKeyboard(page: Page): Promise<boolean> {
    const dd = await this.pickVisibleJobDropdown(page);
    if ((await dd.count().catch(() => 0)) === 0) {
      return false;
    }
    await page.keyboard.press("ArrowDown");
    await sleep(100);
    await page.keyboard.press("Enter");
    await sleep(350);
    return true;
  }

  /**
   * 在 KM 职位选择器 popover（.jsn-job-selector-popper）内搜索框输入关键字。
   * 与手动在「职位名称/发布地」里输入一致，供 greetingJobTitle 匹配真实在招岗位。
   */
  private async tryFillKmJobSearch(page: Page, wanted: string): Promise<boolean> {
    const text = wanted.trim();
    if (!text) {
      return false;
    }

    const tryLocators: Locator[] = [
      page.locator(".jsn-job-selector-popper:visible input[placeholder*='职位名称']").first(),
      page.locator(".jsn-job-selector-popper:visible input[placeholder*='发布地']").first(),
      page.locator(".jsn-job-selector-popper:visible input[type='search']").first(),
      page.locator(".jsn-job-selector-popper:visible input").first(),
      page.locator(".km-popover:visible .jsn-job-selector-popper input, .km-popover:visible input[placeholder*='职位']").first(),
    ];

    for (let i = 0; i < tryLocators.length; i += 1) {
      const loc = tryLocators[i];
      if (!loc) {
        continue;
      }
      if ((await loc.count().catch(() => 0)) === 0) {
        continue;
      }
      if (!(await loc.isVisible().catch(() => false))) {
        continue;
      }
      await this.fillOrTypeLocator(page, loc, text);
      console.log(
        `[搜索列表] 已在 KM 职位搜索框输入「${text}」（第 ${i + 1} 套定位器命中，共 ${tryLocators.length} 套备选）`,
      );
      return true;
    }

    const ok = await page.evaluate((w: string) => {
      const roots = Array.from(
        document.querySelectorAll(
          ".jsn-job-selector-popper, .km-popover.km-select__dropdown-wrapper, .km-popover.jsn-job-selector-popper",
        ),
      ) as HTMLElement[];
      const visible = roots.filter((el) => {
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      });
      for (const root of visible) {
        const inp =
          (root.querySelector("input[placeholder*='职位名称']") as HTMLInputElement | null) ||
          (root.querySelector("input[placeholder*='发布地']") as HTMLInputElement | null) ||
          (root.querySelector("input[type='search']") as HTMLInputElement | null) ||
          (root.querySelector("input") as HTMLInputElement | null);
        if (!inp) {
          continue;
        }
        inp.focus();
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (desc?.set) {
          desc.set.call(inp, w);
        } else {
          inp.value = w;
        }
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        try {
          inp.dispatchEvent(new InputEvent("input", { bubbles: true, data: w, inputType: "insertText" }));
        } catch {
          // ignore
        }
        return true;
      }
      return false;
    }, text);
    if (ok) {
      console.log(`[搜索列表] 已在 KM 职位搜索框输入「${text}」（evaluate）`);
    }
    return ok;
  }

  /**
   * 选择「沟通职位」弹窗里的职位，然后点「确定」。
   * 弹窗：.km-modal__wrapper.resume-buttons-chat（智联 km 组件库）
   * 触发器：.jsn-job-selector__input（data-popover）
   */
  private async ensureGreetingJobSelected(page: Page): Promise<void> {
    const dialogTitle = page.getByText(/选择沟通职位|请选择要沟通的职位/).first();
    if ((await dialogTitle.count().catch(() => 0)) === 0) {
      console.log("[搜索列表] 未出现「选择沟通职位」弹窗，跳过选职位");
      return;
    }
    console.log("[搜索列表] 检测到「选择沟通职位」，开始选职位");

    const wanted = this.config.search.greetingJobTitle || "";

    // 弹窗是 .km-modal--open（km 组件库），不是 [role='dialog']
    const modal = page.locator(".km-modal--open, .km-modal__wrapper.resume-buttons-chat .km-modal").first();

    // 1. 点击 .jsn-job-selector__input 展开职位下拉
    const trigger = page.locator(".jsn-job-selector__input").first();
    if ((await trigger.count().catch(() => 0)) > 0) {
      const popoverId = await trigger.getAttribute("aria-describedby").catch(() => null);

      // 只 focus，不 click（click 会触发 click-outside 立即关闭），然后 ArrowDown 展开
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".jsn-job-selector__input");
        if (el) el.focus();
      });
      await sleep(120);
      await page.keyboard.press("ArrowDown");
      console.log(`[搜索列表] 已 focus+ArrowDown 展开职位下拉（popoverId=${popoverId ?? "unknown"}）`);

      await sleep(220);
      let filledKmSearch = false;
      if (wanted.trim()) {
        filledKmSearch = await this.tryFillKmJobSearch(page, wanted);
        if (filledKmSearch) {
          await sleep(350);
        }
      }

      // 等职位列表项挂载（接口慢时这里会占时间，不是固定秒数；缩短单次等待、多试一次）
      const firstOpt = page.locator(".jsn-job-selector__option").first();
      let optVisible = await firstOpt.waitFor({ state: "visible", timeout: 1800 }).then(() => true).catch(() => false);

      if (!optVisible) {
        await page.keyboard.press("ArrowDown");
        optVisible = await firstOpt.waitFor({ state: "visible", timeout: 1800 }).then(() => true).catch(() => false);
      }
      console.log(`[搜索列表] 职位 popover 选项可见: ${optVisible}`);

      if (optVisible) {
        if (wanted) {
          const match = page.locator(".jsn-job-selector__option").filter({ hasText: new RegExp(this.escapeRegExp(wanted)) }).first();
          if ((await match.isVisible().catch(() => false))) {
            await match.click();
            console.log(`[搜索列表] 已点选目标职位「${wanted}」`);
          } else {
            const firstText = await firstOpt.innerText().catch(() => "第一项");
            await firstOpt.click();
            console.log(`[搜索列表] 目标「${wanted}」不在列表，已点选第一项:「${firstText.slice(0, 30)}」`);
          }
        } else {
          const firstText = await firstOpt.innerText().catch(() => "第一项");
          await firstOpt.click();
          console.log(`[搜索列表] 已点选职位 popover 第一项:「${firstText.slice(0, 30)}」`);
        }
        await sleep(400);
      } else {
        if (wanted.trim() && !filledKmSearch) {
          filledKmSearch = await this.tryFillKmJobSearch(page, wanted);
          if (filledKmSearch) {
            await sleep(600);
          }
        }
        if (wanted.trim()) {
          const match = page
            .locator(".jsn-job-selector__option")
            .filter({ hasText: new RegExp(this.escapeRegExp(wanted)) })
            .first();
          if (await match.isVisible().catch(() => false)) {
            await match.click();
            console.log(`[搜索列表] 搜索后已点选「${wanted}」`);
            await sleep(400);
          } else {
            const anyOpt = page.locator(".jsn-job-selector__option").first();
            if (await anyOpt.isVisible().catch(() => false)) {
              await anyOpt.click();
              console.log("[搜索列表] 搜索后已点选过滤结果第一项");
              await sleep(400);
            } else {
              await page.keyboard.press("ArrowDown");
              await sleep(200);
              await page.keyboard.press("Enter");
              await sleep(400);
              console.log("[搜索列表] 已用键盘选职位（键盘兜底）");
            }
          }
        } else {
          await page.keyboard.press("ArrowDown");
          await sleep(200);
          await page.keyboard.press("Enter");
          await sleep(400);
          console.log("[搜索列表] 已用键盘选职位（键盘兜底）");
        }
      }
    } else {
      // 触发器找不到：坐标点击「请选择沟通职位」文字
      const bb = await page.getByText("请选择沟通职位", { exact: false }).first().boundingBox().catch(() => null);
      if (bb) {
        await page.mouse.click(bb.x + bb.width * 0.85, bb.y + bb.height / 2);
        console.log("[搜索列表] 已通过坐标点击右侧展开下拉（无 trigger 退化）");
      }
      await sleep(800);
      await page.keyboard.press("ArrowDown");
      await sleep(200);
      await page.keyboard.press("Enter");
      await sleep(400);
    }

    // 4. 点确定（专门针对 .km-modal--open 内的 primary 按钮）
    const kmConfirm = page.locator(".km-modal--open .km-modal__footer .km-button--primary").first();
    const kmConfirmVisible = await kmConfirm.isVisible().catch(() => false);
    if (kmConfirmVisible) {
      await kmConfirm.click();
      await page.locator(".km-modal--open").first().waitFor({ state: "hidden", timeout: 12000 }).catch(() => undefined);
      await sleep(150);
      console.log("[搜索列表] 已点击 KM 确定按钮");
    } else {
      await this.maybeConfirmJobDialog(page, modal);
    }
  }

  /**
   * 选职点「确定」后：若「选择沟通职位」弹窗已关，或正文已出现「消息已发送/继续沟通」，说明无需再等 IM 输入框（智联常自动发首条）。
   */
  private async quickPostJobConfirmGreetStatus(page: Page): Promise<"likely_done" | "keep_waiting"> {
    return page
      .evaluate(() => {
        const hasOpenKm = !!document.querySelector(".km-modal--open");
        const body = document.body?.innerText ?? "";
        const isJobPickModal =
          body.includes("选择沟通职位") || body.includes("请选择沟通职位") || body.includes("沟通职位");
        if (hasOpenKm && isJobPickModal) {
          return "keep_waiting";
        }
        if (body.includes("消息已发送") || body.includes("继续沟通")) {
          return "likely_done";
        }
        if (!hasOpenKm) {
          return "likely_done";
        }
        return "keep_waiting";
      })
      .catch(() => "keep_waiting");
  }

  /**
   * 仍需 IM 输入框时：轮询直至出现（或新标签），上限约 10s；不是固定秒数，找不到才等到上限。
   */
  private async waitForChatInputSurfaceAfterConfirm(page: Page, tabCountBefore: number, cardIndex: number): Promise<Page> {
    const ctx = page.context();
    const started = Date.now();
    const deadline = started + 10000;
    let lastUi = page;
    let lastLogSec = -1;
    while (Date.now() < deadline) {
      if ((await this.quickPostJobConfirmGreetStatus(page)) === "likely_done") {
        console.log(`[搜索列表] 卡片 ${cardIndex}: 轮询中已检测到发送完成（${Date.now() - started}ms）`);
        return page;
      }
      const pagesNow = ctx.pages().filter((p) => !p.isClosed());
      if (pagesNow.length > tabCountBefore) {
        const latest = pagesNow[pagesNow.length - 1];
        if (latest && !latest.isClosed()) {
          await latest.bringToFront().catch(() => undefined);
          await latest.waitForLoadState("domcontentloaded").catch(() => undefined);
          lastUi = latest;
          console.log(`[搜索列表] 卡片 ${cardIndex}: 选职后新开标签 (${pagesNow.length} 个) ${latest.url()}`);
        }
      }
      const onLatest = await this.resolveChatSurfaceAcrossContext(lastUi);
      if (onLatest) {
        console.log(`[搜索列表] 卡片 ${cardIndex}: 已检测到聊天输入框（选职后 ${Date.now() - started}ms）`);
        return lastUi;
      }
      if (lastUi !== page) {
        const onMain = await this.resolveChatSurfaceAcrossContext(page);
        if (onMain) {
          console.log(`[搜索列表] 卡片 ${cardIndex}: 已在主页面检测到聊天输入框（${Date.now() - started}ms）`);
          return page;
        }
      }
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      if (elapsedSec > lastLogSec) {
        lastLogSec = elapsedSec;
        if (elapsedSec >= 1 && elapsedSec % 2 === 0) {
          console.log(`[搜索列表] 卡片 ${cardIndex}: 等待 IM 输入框出现… ${elapsedSec}s`);
        }
      }
      await page.waitForTimeout(100);
    }
    console.log(`[搜索列表] 卡片 ${cardIndex}: ${Math.round((Date.now() - started) / 1000)}s 内未检测到输入框，继续后续步骤`);
    const pagesFinal = ctx.pages().filter((p) => !p.isClosed());
    if (pagesFinal.length > tabCountBefore) {
      const latest = pagesFinal[pagesFinal.length - 1];
      if (latest && !latest.isClosed()) {
        await latest.bringToFront().catch(() => undefined);
        return latest;
      }
    }
    return lastUi;
  }

  
  private async pickJobTitleBySmallestClick(page: Page, jobTitle: string): Promise<boolean> {
    const result = await page.evaluate(
      (args: { title: string }) => {
        const title = args.title;
        let scope: Element = document.body;
        const nodes = document.querySelectorAll("div, section, article, form, main");
        for (let i = 0; i < nodes.length; i += 1) {
          const el = nodes[i];
          if (!el) {
            continue;
          }
          const tx = el.textContent || "";
          if (tx.includes("选择沟通职位") && tx.length < 8000) {
            const m = el.closest("[class*='modal']");
            scope = m || el;
            break;
          }
        }
        const byRole = document.querySelector("[role='dialog']");
        if (byRole && scope === document.body) {
          scope = byRole;
        }

        const searchRoot = document.body;

        const needles = Array.from(
          new Set([title, title.replace(/^AI\s*/, "").trim(), "项目助理", "助理"].filter((s) => s && s.length >= 2)),
        );
        for (let ni = 0; ni < needles.length; ni += 1) {
          const needle = needles[ni];
          if (!needle) {
            continue;
          }
          let best: HTMLElement | null = null;
          let bestArea = Infinity;
          const opts = searchRoot.querySelectorAll("li, div, span, p");
          for (let j = 0; j < opts.length; j += 1) {
            const el = opts[j] as HTMLElement;
            const t = (el.textContent || "").trim();
            if (!t.includes(needle) || t.length > 200) {
              continue;
            }
            if (/选择沟通职位|请选择要沟通的职位/.test(t) && t.length < 48) {
              continue;
            }
            const r0 = el.getBoundingClientRect();
            const w0 = window.innerWidth;
            if (!(r0.left > w0 * 0.12 && r0.right < w0 * 0.92 && r0.top > 60 && r0.bottom < window.innerHeight - 40)) {
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) {
              continue;
            }
            const area = r.width * r.height;
            if (area < bestArea) {
              bestArea = area;
              best = el;
            }
          }
          if (best) {
            best.click();
            return { ok: true as const, reason: "needle-smallest" };
          }
        }

        const lis = searchRoot.querySelectorAll("li");
        for (let k = 0; k < lis.length; k += 1) {
          const el = lis[k] as HTMLElement;
          const r0 = el.getBoundingClientRect();
          const w0 = window.innerWidth;
          if (!(r0.left > w0 * 0.12 && r0.right < w0 * 0.92 && r0.top > 60 && r0.bottom < window.innerHeight - 40)) {
            continue;
          }
          const t = (el.textContent || "").trim();
          if (t.length >= 6 && t.length < 90 && /经理|助理|专员|顾问|工程师|招聘|销售|项目|总监|实习/.test(t)) {
            el.click();
            return { ok: true as const, reason: "first-job-like-li" };
          }
        }

        const divs = searchRoot.querySelectorAll("div, span");
        for (let k = 0; k < divs.length; k += 1) {
          const el = divs[k] as HTMLElement;
          const r0 = el.getBoundingClientRect();
          const w0 = window.innerWidth;
          if (!(r0.left > w0 * 0.12 && r0.right < w0 * 0.92 && r0.top > 60 && r0.bottom < window.innerHeight - 40)) {
            continue;
          }
          const t = (el.textContent || "").trim();
          if (t.length >= 8 && t.length < 100 && /经理|助理|专员|顾问|工程师|招聘|销售|项目|总监|实习/.test(t)) {
            el.click();
            return { ok: true as const, reason: "job-like-div" };
          }
        }

        return {
          ok: false as const,
          liInScope: scope.querySelectorAll("li").length,
          liInBody: document.querySelectorAll("li").length,
          scopeIsBody: scope === document.body,
          scopePreview: (scope.textContent || "").replace(/\s+/g, " ").slice(0, 220),
        };
      },
      { title: jobTitle },
    );
    if (!result.ok) {
      console.log(
        `[搜索列表] pickJobTitleBySmallestClick 未命中: scope内li=${result.liInScope} 全页li=${result.liInBody} scopeIsBody=${result.scopeIsBody} 片段=${result.scopePreview}`,
      );
    } else {
      console.log(`[搜索列表] pickJobTitleBySmallestClick 成功: ${result.reason}`);
    }
    return result.ok;
  }

  /** 若选职后弹窗已自动关闭，则不再点「确定」（避免误点其它层） */
  private async maybeConfirmJobDialog(page: Page, dialog: Locator): Promise<void> {
    await this.humanUiPause(400, 900);
    const still = (await page.getByText(/选择沟通职位|请选择要沟通的职位/).count().catch(() => 0)) > 0;
    if (!still) {
      console.log("[搜索列表] 选职位后弹窗已关闭，跳过确定");
      return;
    }
    await this.clickConfirmJobDialogIfNeeded(page, dialog);
  }

  /** 选完职位后部分版本需再点「确定/下一步」才会进入招呼语层（优先页脚，避免大容器内误点） */
  private async clickConfirmJobDialogIfNeeded(page: Page, dialog: Locator): Promise<void> {
    const footer = dialog
      .locator(".ant-modal-footer, .el-dialog__footer, [class*='dialog-footer'], [class*='modal-footer']")
      .first();
    const scope = (await footer.count().catch(() => 0)) > 0 ? footer : dialog;
    const patterns = [/确定/, /完成/, /下一步/, /选好了/, /继续/, /去沟通/, /开始沟通/, /立即发送/];
    for (const p of patterns) {
      const btn = scope.getByRole("button", { name: p }).first();
      if ((await btn.count().catch(() => 0)) === 0) {
        continue;
      }
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      console.log(`[搜索列表] 点击职位弹窗后续按钮: ${p.source}`);
      await btn.click({ force: true }).catch(() => undefined);
      await this.humanUiPause(600, 1400);
      return;
    }
    const pseudo = scope
      .locator("button, span, a, [role='button'], .ant-btn")
      .filter({ hasText: /^(确定|完成|下一步|选好了|继续)$/ })
      .first();
    if ((await pseudo.count().catch(() => 0)) > 0 && (await pseudo.isVisible().catch(() => false))) {
      console.log("[搜索列表] 点击职位弹窗后续按钮（非标准 role）");
      await pseudo.click({ force: true }).catch(() => undefined);
      await this.humanUiPause(600, 1400);
    }
  }

  private async jobDialogBoundingBox(page: Page, dialog: Locator): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> {
    const fromDialog = await dialog.boundingBox().catch(() => null);
    if (fromDialog && fromDialog.width > 0 && fromDialog.height > 0) {
      return fromDialog;
    }
    return await page.getByText(/选择沟通职位|请选择要沟通的职位/).first().boundingBox().catch(() => null);
  }

  private async trySendByAIGreetingDialog(page: Page): Promise<boolean> {
    await this.humanUiPause(500, 1200);

    const aiHeadingPattern =
      /AI招呼语|个性化招呼语|招呼语上线|智能.*招呼|AI.*个性化|个性化.*招呼|为您生成|推荐招呼语/;
    const hasHeading = (await page.getByText(aiHeadingPattern).count().catch(() => 0)) > 0;

    const tryClickSendInScope = async (scope: Page | Frame | Locator): Promise<boolean> => {
      const byRole = scope.getByRole("button", { name: /使用并发送/ }).first();
      if ((await byRole.count().catch(() => 0)) > 0 && (await byRole.isVisible().catch(() => false))) {
        await byRole.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1200);
        return true;
      }
      const legacy = scope.locator("button:has-text('使用并发送')").first();
      if ((await legacy.count().catch(() => 0)) > 0 && (await legacy.isVisible().catch(() => false))) {
        await legacy.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1200);
        return true;
      }
      const byText = scope.getByText("使用并发送", { exact: true }).first();
      if ((await byText.count().catch(() => 0)) > 0 && (await byText.isVisible().catch(() => false))) {
        await byText.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1200);
        return true;
      }
      const pseudo = scope
        .locator("span, a, div, [role='button'], .ant-btn")
        .filter({ hasText: /^使用并发送$/ })
        .first();
      if ((await pseudo.count().catch(() => 0)) > 0 && (await pseudo.isVisible().catch(() => false))) {
        await pseudo.click({ force: true }).catch(() => undefined);
        await this.humanUiPause(500, 1200);
        return true;
      }
      return false;
    };

    // 1) 含 AI/招呼语标题的弹窗内点击（与需求「上半区」一致时，通常在同一浮层）
    if (hasHeading) {
      console.log("[搜索列表] 检测到 AI/招呼语相关标题，在对应浮层内查找「使用并发送」");
      const modal = page
        .locator("[role='dialog'], .ant-modal-content, .el-dialog, .el-dialog__body")
        .filter({ hasText: aiHeadingPattern })
        .first();
      const scope = (await modal.count().catch(() => 0)) > 0 ? modal : page;
      if (await tryClickSendInScope(scope)) {
        console.log("[搜索列表] 已点击「使用并发送」(含标题匹配)");
        return true;
      }
    } else {
      console.log("[搜索列表] 未匹配到 AI 标题文案，尝试在弹窗内直接找「使用并发送」");
    }

    // 2) 无独立标题时：选完职位后可能直接出现按钮，从顶层 dialog 往下找
    const dialogs = page.locator("[role='dialog'], .ant-modal-content, .el-dialog");
    const dCount = await dialogs.count().catch(() => 0);
    for (let i = dCount - 1; i >= 0; i -= 1) {
      const layer = dialogs.nth(i);
      const visible = await layer.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      if (await tryClickSendInScope(layer)) {
        console.log(`[搜索列表] 已点击「使用并发送」(弹窗层 index=${i})`);
        return true;
      }
    }

    // 3) 当前标签：主文档 + 子 frame（沟通浮层常在 iframe 内）
    const localSurfaces: Array<Page | Frame> = [
      page,
      ...page.frames().filter((f) => f !== page.mainFrame()),
    ];
    for (const s of localSurfaces) {
      if (await tryClickSendInScope(s)) {
        console.log("[搜索列表] 已点击「使用并发送」(当前标签页/iframe 兜底)");
        return true;
      }
    }

    if (await this.tryClickPrimaryGreetButton(page)) {
      console.log("[搜索列表] trySendByAIGreetingDialog: 已通过扩展主按钮匹配发送");
      return true;
    }
    for (const f of page.frames()) {
      if (f === page.mainFrame()) {
        continue;
      }
      if (await this.tryClickPrimaryGreetButton(f)) {
        console.log("[搜索列表] trySendByAIGreetingDialog: 已在 iframe 内点击主行动按钮");
        return true;
      }
    }

    const ctx = this.context;
    if (ctx) {
      for (const p of ctx.pages()) {
        if (p === page || p.isClosed()) {
          continue;
        }
        await p.bringToFront().catch(() => undefined);
        await this.humanUiPause(300, 600);
        const remoteSurfaces: Array<Page | Frame> = [
          p,
          ...p.frames().filter((fr) => fr !== p.mainFrame()),
        ];
        for (const s of remoteSurfaces) {
          if (await tryClickSendInScope(s)) {
            console.log("[搜索列表] 已点击「使用并发送」(其它标签页/iframe)");
            return true;
          }
          if (await this.tryClickPrimaryGreetButton(s)) {
            console.log("[搜索列表] trySendByAIGreetingDialog: 已在其它标签页/iframe 点击主行动按钮");
            return true;
          }
        }
      }
    }

    console.log("[搜索列表] 未找到可点击的「使用并发送」或同类主按钮");
    return false;
  }

  /** 智联可能展示「发送招呼」「一键发送」等，而非严格「使用并发送」 */
  private async tryClickPrimaryGreetButton(surface: Page | Frame): Promise<boolean> {
    const patterns = [/使用并发送/, /发送个性招呼/, /发送招呼/, /一键发送/, /发送消息/, /立即发送/];
    for (const re of patterns) {
      const btn = surface.getByRole("button", { name: re }).first();
      if ((await btn.count().catch(() => 0)) === 0) {
        continue;
      }
      if (!(await btn.isVisible().catch(() => false))) {
        continue;
      }
      await btn.click({ force: true }).catch(() => undefined);
      await this.humanUiPause(500, 1200);
      return true;
    }
    const loose = surface
      .locator("button, [role='button'], .ant-btn, span.ant-btn")
      .filter({ hasText: /使用并发送|发送招呼|一键发送|发送消息|发送个性/ })
      .first();
    if ((await loose.count().catch(() => 0)) > 0 && (await loose.isVisible().catch(() => false))) {
      await loose.click({ force: true }).catch(() => undefined);
      await this.humanUiPause(500, 1200);
      return true;
    }
    return false;
  }

  /** 扩展选择器：IM 区常在 iframe，类名含 im-；部分为 contenteditable */
  private extendedChatInputSelector(): string {
    return [
      this.config.selectors.chatInput,
      ".im-rich-textarea textarea",
      ".im-input textarea",
      "textarea[class*='im-']",
      "textarea[class*='chat']",
      "[contenteditable='true'].im-rich-textarea",
      "[contenteditable='true'][class*='im-']",
      "[contenteditable][class*='im-']",
      "[contenteditable][class*='chat']",
      "[contenteditable][class*='editor']",
      "[contenteditable][class*='compose']",
      ".km-textarea__inner",
      ".im-compose__input",
      ".im-editor__content",
      "div[class*='im-input']",
    ].join(", ");
  }

  /** 跨标签页 + 主文档 + 子 frame 定位输入框 */
  private async resolveChatSurfaceAcrossContext(preferred: Page): Promise<{
    ownerPage: Page;
    surface: Page | Frame;
    input: Locator;
  } | null> {
    const ctx = this.context;
    const pages = ctx && ctx.pages().length > 0 ? ctx.pages().filter((p) => !p.isClosed()) : [preferred];
    const sel = this.extendedChatInputSelector();
    for (const p of pages) {
      await p.bringToFront().catch(() => undefined);
      const mainInp = p.locator(sel).first();
      if ((await mainInp.count().catch(() => 0)) > 0) {
        console.log("[搜索列表] 在主文档找到聊天输入框");
        return { ownerPage: p, surface: p, input: mainInp };
      }
      for (const f of p.frames()) {
        if (f === p.mainFrame()) {
          continue;
        }
        const fi = f.locator(sel).first();
        if ((await fi.count().catch(() => 0)) > 0) {
          console.log(`[搜索列表] 在 iframe 内找到聊天输入框 (${f.url()})`);
          return { ownerPage: p, surface: f, input: fi };
        }
      }
    }
    return null;
  }

  /** 无 AI 浮层时：直接往沟通区输入框发首条（与互动区同源选择器） */
  private async trySendFromChatComposer(page: Page, messages: string[]): Promise<boolean> {
    if (messages.length === 0) {
      return false;
    }
    const firstMessage = messages[0];
    if (!firstMessage) {
      return false;
    }
    const resolved = await this.resolveChatSurfaceAcrossContext(page);
    if (!resolved) {
      console.log("[搜索列表] 未在任意标签页/iframe 找到聊天输入框");
      return false;
    }
    const { ownerPage, surface, input } = resolved;
    const onMainOnly = surface === ownerPage;
    if (onMainOnly) {
      try {
        await this.ensureChatReady(ownerPage);
      } catch {
        console.log("[搜索列表] trySendFromChatComposer: ensureChatReady 未通过，仍尝试填输入框");
      }
    }
    if (!(await input.isVisible().catch(() => false))) {
      await input.waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);
    }
    await input.click({ force: true }).catch(() => undefined);
    const filled = await input.fill(firstMessage).then(
      () => true,
      () => false,
    );
    if (!filled) {
      await ownerPage.keyboard.type(firstMessage, { delay: 15 }).catch(() => undefined);
    }
    await this.humanUiPause(300, 600);
    const sendBtn = surface.locator(this.config.selectors.sendButton).first();
    if ((await sendBtn.count().catch(() => 0)) > 0 && (await sendBtn.isVisible().catch(() => false))) {
      await sendBtn.click({ force: true }).catch(() => undefined);
    } else {
      await input.press("Enter").catch(() => undefined);
    }
    await this.humanUiPause(500, 1200);
    return true;
  }

  private async humanUiPause(minMs = 700, maxMs = 1800): Promise<void> {
    await sleep(randomBetween(minMs, maxMs));
  }

  private async countSearchRowCards(page: Page): Promise<number> {
    if (page.url().includes("/app/search") || page.url().includes("/search")) {
      return await page.locator(".search-resume-item-wrap").count().catch(() => 0);
    }
    return await page.locator(this.config.selectors.candidateCards).count().catch(() => 0);
  }

  /** 统计页面上与「打招呼」相关的可点元素（用于日志诊断，匹配新版 DOM） */
  private async countGreetLikeElements(page: Page): Promise<number> {
    const byText = await page.getByText("打招呼", { exact: true }).count().catch(() => 0);
    if (byText > 0) {
      return byText;
    }
    return await page
      .locator("button, a, [role='button'], [role='link'], span, div")
      .filter({ hasText: /^打招呼$/ })
      .count()
      .catch(() => 0);
  }

  private escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 弹窗内「沟通职位」行需点开才会请求可选职位列表（否则只有标题与确定） */
  private async openCommunicationJobRowToLoadList(dialog: Locator): Promise<void> {
    const line = dialog.locator("span, div, p, label").filter({ hasText: /^沟通职位$/ }).last();
    if ((await line.count().catch(() => 0)) > 0) {
      await line.click({ force: true }).catch(() => undefined);
      await sleep(1500);
      console.log("[搜索列表] 已点击「沟通职位」行以加载职位列表");
    }
    const pickHint = dialog.getByText(/请选择职位/).first();
    if ((await pickHint.count().catch(() => 0)) > 0) {
      await pickHint.click({ force: true }).catch(() => undefined);
      await sleep(1500);
      console.log("[搜索列表] 已点击「请选择职位」以展开职位选项");
    }
    const ph = dialog.locator("input[placeholder*='沟通'], input[placeholder*='职位'], input[placeholder*='选择']").first();
    if ((await ph.count().catch(() => 0)) > 0) {
      await ph.click({ force: true }).catch(() => undefined);
      await sleep(1200);
    }
  }

  /** 多次尝试展开「沟通职位」下拉（智联 DOM 可能非标准 ant） */
  private async ensureJobDropdownVisible(page: Page, dialog: Locator): Promise<void> {
    const hasOptionsOpen = async (): Promise<boolean> => {
      const nOpt = await page.locator("[role='option'], .ant-select-item-option").count().catch(() => 0);
      const nLb = await page.locator("[role='listbox']").count().catch(() => 0);
      return nOpt > 0 || nLb > 0;
    };

    if (await hasOptionsOpen()) {
      return;
    }
    const root = this.visibleDropdownRoot(page);
    if (await root.isVisible().catch(() => false)) {
      return;
    }

    const tryOpen = async (loc: Locator, label: string): Promise<boolean> => {
      if ((await loc.count().catch(() => 0)) === 0) {
        return false;
      }
      await loc.click({ force: true }).catch(() => undefined);
      await this.humanUiPause(400, 800);
      const ok =
        (await hasOptionsOpen()) || (await this.visibleDropdownRoot(page).isVisible().catch(() => false));
      if (ok) {
        console.log(`[搜索列表] 已展开职位下拉: ${label}`);
      }
      return ok;
    };

    const textTriggers = [
      page.getByText("请选择沟通职位", { exact: false }).first(),
      dialog.getByText("请选择沟通职位", { exact: false }).first(),
      page.getByText(/职位名称.*发布地/).first(),
      dialog.locator("span, div").filter({ hasText: /^请选择沟通职位$/ }).first(),
    ];
    for (let i = 0; i < textTriggers.length; i += 1) {
      if (await tryOpen(textTriggers[i]!, `文案触发${i}`)) {
        return;
      }
    }

    const candidates = [
      dialog.locator(".ant-select-selector").first(),
      dialog.locator(".ant-select-selection-search").first(),
      dialog.locator("input[placeholder*='请选择沟通职位']").first(),
      dialog.locator("input[placeholder*='职位名称']").first(),
      dialog.locator("input[placeholder*='发布地']").first(),
      dialog.locator("input[type='text']").first(),
      page.getByRole("combobox").first(),
      dialog.getByRole("combobox").first(),
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      if (await tryOpen(candidates[i]!, `候选${i}`)) {
        return;
      }
    }
    const inputs = dialog.locator("input");
    const n = await inputs.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i += 1) {
      if (await tryOpen(inputs.nth(i), `弹窗内 input[${i}]`)) {
        return;
      }
    }
  }

  /** 智联职位下拉可能为 ant-select / listbox，不一定带 :visible 类名 */
  private visibleDropdownRoot(page: Page): Locator {
    return page
      .locator(
        ".ant-select-dropdown, .rc-select-dropdown, [role='listbox'], [class*='select-dropdown'], [class*='Dropdown-menu'], [class*='dropdown-menu']",
      )
      .first();
  }

  private async pickJobOptionNearDialog(page: Page, _dialog: Locator, jobTitle: string): Promise<boolean> {
    const dd = await this.pickVisibleJobDropdown(page);
    const listbox = page.locator("[role='listbox']").last();
    const scope =
      (await dd.count().catch(() => 0)) > 0
        ? dd
        : (await listbox.count().catch(() => 0)) > 0
          ? listbox
          : page.locator("[role='listbox'], .ant-select-dropdown, .rc-select-dropdown").last();

    const opt = scope
      .locator("[role='option'], .ant-select-item-option, .ant-select-item, li.ant-select-dropdown-menu-item")
      .filter({ hasText: new RegExp(this.escapeRegExp(jobTitle)) })
      .first();
    if ((await opt.count().catch(() => 0)) > 0) {
      await opt.scrollIntoViewIfNeeded().catch(() => undefined);
      await opt.click({ force: true }).catch(() => undefined);
      console.log(`[搜索列表] pickJobOptionNearDialog: 在 listbox 内精确匹配「${jobTitle}」`);
      return true;
    }

    const fallbackScope =
      (await page.locator("[role='option']").count().catch(() => 0)) > 0
        ? page.locator("[role='listbox']").last()
        : scope;
    const firstAny = fallbackScope
      .locator("[role='option'], .ant-select-item-option")
      .first();
    if ((await firstAny.count().catch(() => 0)) > 0) {
      await firstAny.click({ force: true }).catch(() => undefined);
      console.log(`[搜索列表] pickJobOptionNearDialog: 未命中「${jobTitle}」，已选 listbox 内第一项`);
      return true;
    }

    console.log("[搜索列表] pickJobOptionNearDialog: 未找到 [role=option] 职位项");
    return false;
  }

  /** 仅在下拉层内兜底，禁止在全页匹配「顾问」等（会误点筛选区） */
  private async pickFallbackJobOptionNearDialog(page: Page, _dialog: Locator): Promise<boolean> {
    const dd = await this.pickVisibleJobDropdown(page);
    const scope =
      (await dd.count().catch(() => 0)) > 0
        ? dd
        : (await page.locator("[role='listbox']").count().catch(() => 0)) > 0
          ? page.locator("[role='listbox']").last()
          : this.visibleDropdownRoot(page);
    await scope.waitFor({ state: "visible", timeout: 6000 }).catch(() => undefined);
    const items = scope.locator(
      "[role='option'], .ant-select-item-option, .ant-select-item, li.ant-select-dropdown-menu-item",
    );
    const count = await items.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 40); i += 1) {
      const item = items.nth(i);
      const text = pickText(await item.innerText().catch(() => ""));
      if (text.length < 4 || text.length > 120) {
        continue;
      }
      if (!/经理|工程师|顾问|助理|总监|专员|开发|产品|运营|实习|招聘|项目|主管|老师|销售/.test(text)) {
        continue;
      }
      await item.scrollIntoViewIfNeeded().catch(() => undefined);
      await item.click({ force: true }).catch(() => undefined);
      console.log(`[搜索列表] pickFallback: 在下拉层内点击第 ${i} 项: ${text.slice(0, 48)}`);
      return true;
    }
    const firstAny = scope.locator("[role='option'], .ant-select-item-option").first();
    if ((await firstAny.count().catch(() => 0)) > 0) {
      await firstAny.click({ force: true }).catch(() => undefined);
      console.log("[搜索列表] pickFallback: 关键词未命中，已选下拉第一项");
      return true;
    }
    return false;
  }
}
