/**
 * Phase 4 gate, machine-verified (spec: "Two browsers, 3+0 bullet game to
 * completion, no desync, clock drift < 200ms at flag"):
 *
 *  - two Playwright contexts, two dev-auth users, matchmaking through the
 *    real /play UI (3+0 preset, Find an opponent);
 *  - a scripted game (Opera Game, truncated) driven by square taps on both
 *    boards, with one A3.5 premove armed and auto-fired mid-game;
 *  - after EVERY ply both pages must converge to the same seq and the same
 *    FEN, and that FEN must equal the facade's replay truth (no desync);
 *  - then White stops moving and the game must end by verified flagfall:
 *    both pages show the same result, and the end event's server-computed
 *    remainingAtFlagMs must be within 200ms of zero (drift gate);
 *  - move propagation time (mover page seq bump → opponent page seq bump)
 *    is measured and reported.
 *
 * Needs: `npm run dev` (or start) on --url with GAMBIT_DEV_AUTH=1 +
 * NEXT_PUBLIC_GAMBIT_DEV_AUTH=1 and DATABASE_URL pointing at the same DB.
 *
 *   npx tsx scripts/gate-phase4.mts [--url http://localhost:3000]
 */
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import postgres from "postgres";
import { parseMultiPgn, replayPgnGame } from "../src/lib/chess/pgn-read";

const urlFlag = process.argv.indexOf("--url");
const base = urlFlag !== -1 ? process.argv[urlFlag + 1]! : "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";

const OPERA_PGN = `[Event "gate"]
[Result "*"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7
8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7
14. Rd1 Qe6 15. Bxd7+ Nxd7 *`;

/** Ply index (1-based) at which Black's reply is armed as a premove. */
const PREMOVE_PLY = 4;
const SCRIPT_PLIES = 30;

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

async function newUserPage(browser: Browser): Promise<{ page: Page; userId: string }> {
  const userId = randomUUID();
  const context = await browser.newContext({ viewport: { width: 1360, height: 940 } });
  await context.addCookies([
    { name: "gambit-dev-user", value: userId, url: base },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (event) => console.log(`  pageerror(${userId.slice(0, 8)}): ${event}`));
  return { page, userId };
}

async function joinQueue(page: Page) {
  await page.goto(`${base}/play`, { waitUntil: "networkidle" });
  const card = page.locator("section, div").filter({ hasText: "Play a human" }).last();
  await page.getByRole("button", { name: "3+0", exact: true }).click();
  await card.getByRole("button", { name: "Find an opponent" }).click();
}

async function seqOf(page: Page): Promise<number> {
  const value = await page.locator('[data-testid="live-board"]').getAttribute("data-seq");
  return Number(value ?? "-1");
}

async function fenOf(page: Page): Promise<string> {
  return (await page.locator('[data-testid="live-board"]').getAttribute("data-fen")) ?? "";
}

async function waitForFen(page: Page, fen: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="live-board"]')?.getAttribute("data-fen") === expected,
    fen,
    { timeout: timeoutMs, polling: 50 }
  );
  return Date.now() - start;
}

async function tapMove(page: Page, uci: string) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const board = page.locator('[data-testid="live-board"]');
  await board.locator(`[data-square="${from}"]`).click();
  await board.locator(`[data-square="${to}"]`).click();
}

async function main() {
  const replay = replayPgnGame(parseMultiPgn(OPERA_PGN)[0]!);
  const script = replay.plies.slice(0, SCRIPT_PLIES);

  // Anti-throttling flags: a real player's tab is focused; headless
  // background-tab timer throttling is a test artifact, not a product state.
  const args = [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
  const launch: { executablePath?: string; args: string[] } = { args };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  let browser: Browser;
  try {
    browser = await chromium.launch(launch);
  } catch {
    browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args });
  }

  const a = await newUserPage(browser);
  const b = await newUserPage(browser);

  // --- matchmaking through the UI ---
  await joinQueue(a.page);
  await a.page.waitForTimeout(700);
  await joinQueue(b.page);
  await Promise.all([
    a.page.waitForURL("**/play/live/**", { timeout: 30_000 }),
    b.page.waitForURL("**/play/live/**", { timeout: 30_000 }),
  ]);
  const gameId = a.page.url().split("/play/live/")[1]!.split(/[?#]/)[0]!;
  record(
    "matchmaking pairs two queued players into the same game",
    b.page.url().includes(gameId),
    `game ${gameId}; A at ${a.page.url()}, B at ${b.page.url()}`
  );
  await Promise.all([
    a.page.locator('[data-testid="live-board"]').waitFor({ timeout: 20_000 }),
    b.page.locator('[data-testid="live-board"]').waitFor({ timeout: 20_000 }),
  ]);

  const colorOfA = (await a.page.evaluate(async (id) => {
    const response = await fetch(`/api/play/${id}`);
    const payload = await response.json();
    return payload.state.yourColor as "white" | "black";
  }, gameId))!;
  const whitePage = colorOfA === "white" ? a.page : b.page;
  const blackPage = colorOfA === "white" ? b.page : a.page;
  console.log(`  A is ${colorOfA}; scripted ${script.length} plies\n`);

  // --- scripted game with per-ply convergence assertions ---
  let desyncs = 0;
  let premoveArmed = false;
  let premoveFired = false;
  const propagationMs: number[] = [];
  for (let index = 0; index < script.length; index++) {
    const ply = script[index]!;
    const mover = ply.color === "w" ? whitePage : blackPage;
    const watcher = ply.color === "w" ? blackPage : whitePage;

    if (index + 2 === PREMOVE_PLY) {
      // Arm Black's reply as a premove BEFORE White moves (A3.5): the next
      // scripted ply is Black's and must then fire on its own.
      const next = script[index + 1]!;
      await tapMove(blackPage, next.uci);
      premoveArmed = await blackPage
        .getByText(/premove /)
        .isVisible()
        .catch(() => false);
    }

    if (index + 1 !== PREMOVE_PLY) {
      await tapMove(mover, ply.uci);
    }
    // For the premove ply itself: no tap — the armed premove must auto-fire.

    // Both pages must reach the replay-truth FEN for this ply.
    try {
      await waitForFen(mover, ply.fenAfter, 15_000);
      const lag = await waitForFen(watcher, ply.fenAfter, 15_000);
      if (index + 1 === PREMOVE_PLY) premoveFired = true;
      propagationMs.push(lag);
    } catch {
      desyncs++;
      console.log(`  DESYNC at ply ${index + 1} (${ply.san}): expected ${ply.fenAfter}`);
      break;
    }
    const seqs = [await seqOf(whitePage), await seqOf(blackPage)];
    if (seqs[0] !== seqs[1]) {
      desyncs++;
      console.log(`  SEQ divergence at ply ${index + 1}: ${seqs[0]} vs ${seqs[1]}`);
      break;
    }
  }
  const sorted = [...propagationMs].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  record(
    "no desync across the scripted game (both boards equal the facade replay after every ply)",
    desyncs === 0,
    `${script.length} plies, 0-lag convergence checks; propagation median ${median}ms, max ${max}ms`
  );
  record(
    "A3.5 premove armed while waiting and auto-fired on turn",
    premoveArmed && premoveFired,
    `armed=${premoveArmed} fired=${premoveFired} at ply ${PREMOVE_PLY} (${script[PREMOVE_PLY - 1]!.san})`
  );

  // --- flag: White (to move at ply 31) stops; the game must end by verified
  //     flagfall with server-side drift < 200ms ---
  console.log("  waiting for White to flag (~3 min)…");
  await Promise.all([
    whitePage.locator('[data-testid="game-result"]').waitFor({ timeout: 240_000 }),
    blackPage.locator('[data-testid="game-result"]').waitFor({ timeout: 240_000 }),
  ]);
  const resultTextWhite = (await whitePage.locator('[data-testid="game-result"]').innerText()).trim();
  const resultTextBlack = (await blackPage.locator('[data-testid="game-result"]').innerText()).trim();

  const sql = postgres(DATABASE_URL, { prepare: false });
  const gameRows = await sql`
    SELECT status, result, termination FROM live_games WHERE id = ${gameId}`;
  const endEvents = await sql`
    SELECT payload FROM live_game_events
    WHERE game_id = ${gameId} AND type = 'end' ORDER BY seq DESC LIMIT 1`;
  await sql.end();
  const game = gameRows[0]!;
  const remainingAtFlagMs = Number(
    (endEvents[0]?.payload as { remainingAtFlagMs?: number })?.remainingAtFlagMs ?? NaN
  );

  record(
    "game ends by server-verified flagfall (0-1, time forfeit)",
    game.status === "finished" && game.result === "0-1" && game.termination === "time forfeit",
    `status=${game.status} result=${game.result} termination=${game.termination}`
  );
  record(
    "both browsers show the same final result",
    resultTextWhite.includes("0-1") &&
      resultTextBlack.includes("0-1") &&
      resultTextWhite === resultTextBlack,
    `white page: "${resultTextWhite}" | black page: "${resultTextBlack}"`
  );
  record(
    "clock drift at flag < 200ms (server-computed remainingAtFlagMs)",
    Number.isFinite(remainingAtFlagMs) && remainingAtFlagMs <= 0 && remainingAtFlagMs > -200,
    `remainingAtFlagMs=${remainingAtFlagMs}`
  );

  await browser.close();
  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} gate checks pass`);
  process.exit(failed.length ? 1 : 0);
}

await main();
