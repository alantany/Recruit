import { chromium } from 'playwright';
import path from 'path';

async function main() {
  const userDataDir = path.resolve(process.cwd(), './data/browser-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 150,
    viewport: { width: 1440, height: 1024 },
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  // 先访问主页，让 session cookie 生效
  await page.goto('https://rd6.zhaopin.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // 再跳到互动页
  await page.goto('https://rd6.zhaopin.com/app/im', { waitUntil: 'domcontentloaded' });
  console.log('浏览器已打开，请查看互动页。');
  await new Promise(() => {});
}

main().catch(console.error);
