/**
 * Phase 1 secondary gates, headless (run against a running server):
 *
 *   node scripts/e2e-phase1.mjs [--url http://localhost:3000]
 *
 * 1. Chess960 end-to-end vs a bot from SP3 (bqnnrkrb — king f1 with rooks on
 *    BOTH adjacent squares, the A1.2 drag-ambiguity case): 1.Nb3, bot reply,
 *    castle by tap-king-then-tap-rook, O-O appears in the move list.
 * 2. Shape-only accessibility mode: classification badges on the analysis
 *    board render the same set of glyph labels with color information
 *    removed — nothing lost.
 */
import { chromium } from "playwright";

const urlFlag = process.argv.indexOf("--url");
const base = urlFlag !== -1 ? process.argv[urlFlag + 1] : "http://localhost:3000";

const launch = {};
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
let browser;
try {
  browser = await chromium.launch(launch);
} catch {
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

// --- Gate: 960 e2e with adjacent-K/R castling ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (event) => errors.push(String(event)));
  await page.goto(`${base}/play`, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Chess960" }).click();
  await page.getByLabel("Chess960 start position number").fill("3");
  await page.getByRole("button", { name: "600", exact: true }).click();
  await page.getByRole("button", { name: "White", exact: true }).click();
  await page.getByRole("button", { name: "∞" }).click();
  await page.getByRole("button", { name: "Start game" }).click();

  // 1.Nb3 via keyboard SAN entry (works while the board is also tappable).
  await page.getByLabel("Keyboard move entry").fill("Nb3");
  await page.getByRole("button", { name: "Play", exact: true }).click();

  // Wait for the bot's reply (move list shows Black's move for move 1).
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll("table tr");
      return rows.length >= 1 && rows[0].querySelectorAll("td")[2]?.textContent?.trim();
    },
    null,
    { timeout: 120_000 }
  );

  // Castle: tap the king (f1), then the adjacent rook (g1).
  await page.locator('[data-square="f1"]').click();
  await page.waitForTimeout(250);
  await page.locator('[data-square="g1"]').click();
  await page.waitForTimeout(500);

  const text = (await page.evaluate(() => document.body.innerText)).replace(/\n/g, " ");
  const castled = /O-O(?!-O)/.test(text);
  record(
    "960 e2e: SP3 (king f1, rooks e1+g1 adjacent) castles via tap-king-tap-rook",
    castled && errors.length === 0,
    castled ? `move list shows O-O; page errors: ${errors.length}` : `no O-O found; errors: ${errors.join("; ") || "none"}`
  );
  await page.screenshot({ path: "data/calibration/e2e-960-castle.png" });
  await page.close();
}

// --- Gate: shape-only classification parity ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/play`, { waitUntil: "networkidle" });
  await page.getByText("or open the free analysis board").click();

  // Book moves produce immediate BOOK badges.
  for (const san of ["e4", "e5", "Nf3"]) {
    await page.getByLabel("Keyboard move entry").fill(san);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(
    () => document.querySelectorAll('[role="img"][aria-label]').length >= 3,
    null,
    { timeout: 60_000 }
  );

  const before = await page.evaluate(() =>
    [...document.querySelectorAll('table [role="img"]')].map((el) => ({
      label: el.getAttribute("aria-label"),
      glyph: el.textContent,
    }))
  );

  await page.getByText("Board, sound & accessibility settings").click();
  await page.getByText("Shape-only classification icons").click();
  await page.waitForTimeout(300);

  const after = await page.evaluate(() =>
    [...document.querySelectorAll('table [role="img"]')].map((el) => ({
      label: el.getAttribute("aria-label"),
      glyph: el.textContent,
    }))
  );

  const parity =
    before.length >= 3 &&
    before.length === after.length &&
    before.every((b, i) => b.glyph === after[i].glyph && b.label === after[i].label);
  record(
    "shape-only mode: identical glyphs and labels with color removed",
    parity,
    `badges before=${before.length} after=${after.length}; glyphs ${after.map((a) => a.glyph).join(" ")}`
  );
  await page.close();
}

await browser.close();
const allPass = results.every((result) => result.pass);
console.log(`\nPhase 1 secondary gates: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
