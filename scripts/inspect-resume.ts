
import { chromium } from "playwright";
import path from "node:path";
import { loadConfig } from "../src/recruit-agent/config.js";
import { ensureDir } from "../src/recruit-agent/utils.js";

async function inspectResume() {
  const config = await loadConfig("config/recruit-agent.json");
  const userDataDir = path.resolve(config.browser.userDataDir);
  await ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 150,
    viewport: { width: 1440, height: 1024 },
  });

  const page = context.pages()[0] || await context.newPage();
  console.log("Navigating to interaction page directly...");
  await page.goto("https://rd6.zhaopin.com/interaction", { waitUntil: "domcontentloaded" });

  // Handle possible login redirect
  if (page.url().includes("passport.zhaopin.com")) {
      console.log("Redirected to login page. Please log in in the browser.");
      await page.waitForURL(/rd6.zhaopin.com\/interaction/, { timeout: 300000 }); // Wait 5 mins
      console.log("Logged in successfully (URL detected).");
  }

  await page.waitForTimeout(5000);
  console.log("Taking current view screenshot...");
  await page.screenshot({ path: "data/interaction_view.png" });

  const sessions = page.locator(".im-three-list__panel--item, .session-item, .im-session-item");
  const count = await sessions.count();
  console.log(`Found ${count} session items.`);

  if (count > 0) {
      for (let i = 0; i < Math.min(count, 10); i++) {
          const s = sessions.nth(i);
          await s.click();
          await page.waitForTimeout(2000);
          console.log(`Inspecting session ${i}...`);
          
          const resumeCard = page.locator(".im-message__bubble:has-text('查看附件简历'), .im-message__bubble:has-text('附件简历'), button:has-text('查看附件简历')").last();
          if (await resumeCard.count() > 0) {
              console.log(`Found resume card in session ${i}!`);
              await resumeCard.scrollIntoViewIfNeeded();
              await page.screenshot({ path: "data/resume_found.png" });
              const html = await resumeCard.innerHTML();
              console.log("Resume card inner HTML:", html);
              
              // Now let's see how it opens
              console.log("Clicking resume card to see interaction...");
              const [newTab] = await Promise.all([
                  context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
                  resumeCard.click()
              ]);

              if (newTab) {
                  console.log("New tab opened for resume preview.");
                  await newTab.waitForLoadState("networkidle");
                  await newTab.screenshot({ path: "data/resume_preview_new_tab.png" });
                  
                  // Look for download buttons in the new tab
                  const dl = newTab.locator("button:has-text('下载'), a:has-text('下载'), [class*='download']");
                  const dlCount = await dl.count();
                  console.log(`Found ${dlCount} download indicators in preview tab.`);
                  if (dlCount > 0) {
                      for (let j = 0; j < dlCount; j++) {
                          console.log(`Download button ${j} HTML:`, await dl.nth(j).innerHTML());
                      }
                  }
                  await newTab.close();
              } else {
                  console.log("No new tab. Checking for dialog/popup on current page...");
                  await page.screenshot({ path: "data/after_click_on_same_page.png" });
                  const popup = page.locator(".im-dialog, .resume-preview, .modal-content");
                  if (await popup.count() > 0) {
                      console.log("Found popup/dialog!");
                      const dl = popup.locator("button:has-text('下载'), a:has-text('下载'), [class*='download']");
                      console.log(`Found ${await dl.count()} download indicators in popup.`);
                  }
              }
              break;
          }
      }
  }

  await new Promise(r => setTimeout(r, 10000)); // Keep it for me to check
  await context.close();
}

inspectResume().catch(console.error);
