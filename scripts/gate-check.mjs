/**
 * Phase 0 gate check (spec §8), headless: drives /engine-check in Chromium
 * and reports each row. Run against a local prod server or a deployed
 * preview:
 *
 *   npm run build && npm run start &
 *   npm run gate                                  # default http://localhost:3000
 *   npm run gate -- --url https://<preview>.vercel.app
 *
 * Exits 0 only when every check passes. Set CHROMIUM_PATH to point at a
 * specific Chromium binary if Playwright's own resolution fails.
 */
import { chromium } from "playwright";

const urlFlagIndex = process.argv.indexOf("--url");
const baseUrl =
  urlFlagIndex !== -1 ? process.argv[urlFlagIndex + 1] : "http://localhost:3000";
const target = new URL("/engine-check", baseUrl).toString();

const launchOpts = {};
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;

let browser;
try {
  browser = await chromium.launch(launchOpts);
} catch (error) {
  console.error(`Could not launch Chromium (${error.message}); retrying with CHROMIUM_PATH=/opt/pw-browsers/chromium`);
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
}

const page = await browser.newPage();
console.log(`gate: loading ${target}`);
await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-gate-done="true"]', { timeout: 120_000 });

const results = JSON.parse(await page.locator("[data-gate-results]").innerText());
const isolated = await page.evaluate(() => crossOriginIsolated);
await browser.close();

console.log(`\ncrossOriginIsolated (page main thread): ${isolated}\n`);
for (const result of results) {
  console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.label}\n      ${result.detail}`);
}

const allPass = results.every((result) => result.pass);
console.log(`\nPhase 0 gate: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
