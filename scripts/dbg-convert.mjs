import { chromium } from "playwright";
const BASE = "https://claude-chess-nine.vercel.app";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" },
  args: ["--ssl-version-max=tls1.2"],
});
const page = await (await browser.newContext()).newPage();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 30; i++) {
  const me = await page.evaluate(() => fetch("/api/account/me").then(r => r.status));
  if (me === 200) break;
  await page.waitForTimeout(1000);
}
await page.click('button[aria-haspopup="menu"]');
await page.click('text=Create account');
await page.fill('input[type="email"]', `dbg-${Date.now()}@example.com`);
await page.fill('input[type="password"]', `Dbg!${Date.now()}pass`);
await page.click('form button[type="submit"]');
await page.waitForTimeout(6000);
const dialog = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "(dialog gone)");
console.log("dialog after submit:", dialog.replace(/\n+/g, " | ").slice(0, 400));
await browser.close();
