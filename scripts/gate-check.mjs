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
import { appendFileSync } from "node:fs";
import { chromium } from "playwright";

const urlFlagIndex = process.argv.indexOf("--url");
const baseUrl =
  urlFlagIndex !== -1 ? process.argv[urlFlagIndex + 1] : "http://localhost:3000";
const target = new URL("/engine-check", baseUrl).toString();

const launchOpts = {};
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
// Egress-proxied environments (CI, remote dev containers): Chromium does not
// read HTTPS_PROXY on its own, so pass it through for non-localhost targets.
// The proxy's CA must already be in the browser trust store — never disable
// TLS verification here.
const targetHost = new URL(baseUrl).hostname;
if (process.env.HTTPS_PROXY && targetHost !== "localhost" && targetHost !== "127.0.0.1") {
  launchOpts.proxy = {
    server: process.env.HTTPS_PROXY,
    bypass: process.env.NO_PROXY ?? "localhost,127.0.0.1",
  };
  // TLS-intercepting proxies that cope with OpenSSL's TLS 1.3 can still
  // reset BoringSSL's 1.3 ClientHello; 1.2 to the proxy keeps certificate
  // verification fully on (the CA bundle must be in the browser trust store).
  launchOpts.args = [...(launchOpts.args ?? []), "--ssl-version-max=tls1.2"];
}

let browser;
try {
  browser = await chromium.launch(launchOpts);
} catch (error) {
  console.error(`Could not launch Chromium (${error.message}); retrying with CHROMIUM_PATH=/opt/pw-browsers/chromium`);
  browser = await chromium.launch({ ...launchOpts, executablePath: "/opt/pw-browsers/chromium" });
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

// B0.10: record depth-20 timing on every run so performance drift is a
// visible series, not an anecdote. The in-page check fails above 2500ms.
const depth20 = results.find((result) => result.id === "depth20");
const depth20Ms = Number(depth20?.detail.match(/in (\d+)ms/)?.[1] ?? NaN);
appendFileSync(
  new URL("../docs/gate-history.jsonl", import.meta.url),
  JSON.stringify({
    at: new Date().toISOString(),
    url: target,
    isolated,
    depth20Ms,
    detail: depth20?.detail ?? null,
    pass: allPass,
  }) + "\n"
);
console.log(`\ndepth-20 recorded: ${depth20Ms}ms → docs/gate-history.jsonl`);

console.log(`Phase 0 gate: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
