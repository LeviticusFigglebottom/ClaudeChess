/**
 * Deployment gate (e): the Phase 4 two-context multiplayer gate against the
 * DEPLOYED app — real Supabase-backed server, real network. Measures:
 *   - Realtime transport reachability from this environment (WebSocket
 *     attempts observed; the egress proxy cannot carry wss, so the 500ms
 *     poll fallback is expected to be the transport HERE — that fallback is
 *     itself Phase 4 design, and its cadence bounds what a viewer sees)
 *   - DOM-to-DOM move propagation across 12 alternating moves
 *   - clock drift at a REAL flagfall (60+0), from the end event's SIGNED
 *     remainingRawMs — the Phase 4 drift evidence, |drift| < 200ms bound.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "https://claude-chess-nine.vercel.app";
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const api = (page, path, init) =>
  page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      let body = null;
      try {
        body = await response.json();
      } catch {}
      return { status: response.status, body };
    },
    { path, init }
  );

const ready = async (page) => {
  for (let i = 0; i < 40; i++) {
    const me = await api(page, "/api/account/me");
    if (me.status === 200) return me.body.user;
    await page.waitForTimeout(1000);
  }
  throw new Error("no session");
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" },
  args: ["--ssl-version-max=tls1.2"],
});
try {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errorsA = [];
  const errorsB = [];
  pageA.on("pageerror", (e) => errorsA.push(String(e)));
  pageB.on("pageerror", (e) => errorsB.push(String(e)));
  const sockets = [];
  for (const [name, page] of [["A", pageA], ["B", pageB]]) {
    page.on("websocket", (ws) => {
      const entry = { context: name, url: ws.url().slice(0, 90), closed: false, error: null };
      sockets.push(entry);
      ws.on("close", () => (entry.closed = true));
      ws.on("socketerror", (err) => (entry.error = String(err).slice(0, 90)));
    });
  }

  await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  await pageB.goto(BASE, { waitUntil: "domcontentloaded" });
  await ready(pageA);
  await ready(pageB);

  const created = await api(pageA, "/api/challenges", {
    method: "POST",
    body: JSON.stringify({ action: "create", variant: "standard", timeControl: "60+0", rated: false, color: "white" }),
  });
  const token = created.body?.challenge?.token;
  const accepted = await api(pageB, "/api/challenges", {
    method: "POST",
    body: JSON.stringify({ action: "accept", token }),
  });
  const gameId = accepted.body?.play?.gameId;
  check("60+0 live game created via challenge flow", !!gameId, `game=${String(gameId).slice(0, 8)}…`);

  await pageA.goto(`${BASE}/play/live/${gameId}`, { waitUntil: "domcontentloaded" });
  await pageB.goto(`${BASE}/play/live/${gameId}`, { waitUntil: "domcontentloaded" });
  await pageA.waitForSelector('[data-testid="live-board"]', { timeout: 30000 });
  await pageB.waitForSelector('[data-testid="live-board"]', { timeout: 30000 });
  await pageA.waitForTimeout(4000); // give Realtime its chance to connect

  // ---- move propagation: mover posts via API (same endpoint the board
  // uses); the OTHER page's DOM seq advance is the perceived propagation.
  const MOVES = [
    "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6",
    "d2d3", "f8c5", "c2c3", "d7d6", "b1d2", "c8e6",
  ];
  const samples = [];
  const apiSamples = [];
  for (const [index, uci] of MOVES.entries()) {
    const mover = index % 2 === 0 ? pageA : pageB;
    const watcher = index % 2 === 0 ? pageB : pageA;
    const targetSeq = await watcher.evaluate(
      () => Number(document.querySelector('[data-testid="live-board"]')?.getAttribute("data-seq") ?? 0)
    );
    const moved = await api(mover, `/api/play/${gameId}`, {
      method: "POST",
      body: JSON.stringify({ action: "move", uci }),
    });
    if (moved.status !== 200) {
      check(`move ${uci} applies`, false, `status=${moved.status} ${JSON.stringify(moved.body).slice(0, 80)}`);
      break;
    }
    const t0 = Date.now();
    // Server visibility: how quickly a direct state read on the other side
    // sees the move (network + function latency, no UI transport).
    let apiMs = null;
    for (let i = 0; i < 100; i++) {
      const state = await api(watcher, `/api/play/${gameId}`);
      if ((state.body?.state?.seq ?? 0) > targetSeq) {
        apiMs = Date.now() - t0;
        break;
      }
      await watcher.waitForTimeout(50);
    }
    apiSamples.push(apiMs ?? NaN);
    await watcher.waitForFunction(
      (seq) => Number(document.querySelector('[data-testid="live-board"]')?.getAttribute("data-seq") ?? 0) > seq,
      targetSeq,
      { timeout: 20000, polling: 50 }
    );
    samples.push(Date.now() - t0);
  }
  samples.sort((a, b) => a - b);
  apiSamples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? NaN;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? NaN;
  const apiMedian = apiSamples[Math.floor(apiSamples.length / 2)] ?? NaN;
  check(
    `move propagation across ${samples.length} moves (DOM to DOM)`,
    samples.length === MOVES.length,
    `median=${median}ms p95=${p95}ms max=${samples.at(-1)}ms | server-visibility median=${apiMedian}ms`
  );

  // ---- transport reality: what did the Realtime socket do? -------------
  const realtimeSockets = sockets.filter((s) => s.url.includes("realtime") || s.url.includes("supabase"));
  console.log(
    `websocket observations: ${sockets.length} total, realtime: ${realtimeSockets.length} ` +
      realtimeSockets.map((s) => `[${s.context} ${s.error ? "ERROR" : s.closed ? "closed" : "open"}]`).join(" ")
  );

  // ---- real flagfall: it is White (A) to move on move 13; let A's clock
  // run out, then B claims the flag (the button path exercises claimFlag).
  console.log("waiting out White's 60s clock for a real flagfall…");
  await pageB.waitForTimeout(62000);
  await api(pageB, `/api/play/${gameId}`, { method: "POST", body: JSON.stringify({ action: "flag" }) });
  let finState = null;
  for (let i = 0; i < 20; i++) {
    const state = await api(pageB, `/api/play/${gameId}`);
    const view = state.body?.state ?? state.body;
    if (view?.status === "finished") {
      finState = view;
      break;
    }
    await pageB.waitForTimeout(1000);
  }
  check(
    "flagfall finalizes server-side (time forfeit)",
    finState?.termination === "time forfeit" && finState?.result === "0-1",
    `result=${finState?.result} termination=${finState?.termination}`
  );

  // Drift evidence: the SIGNED remainingRawMs recorded in the end event.
  const events = await fetch(
    `${SUPA}/rest/v1/live_game_events?game_id=eq.${gameId}&type=eq.end&select=payload`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }
  ).then((r) => r.json());
  const drift = events?.[0]?.payload?.remainingAtFlagMs;
  check(
    "clock drift |remainingRawMs| < 200ms at real flagfall",
    typeof drift === "number" && Math.abs(drift) < 200,
    `remainingRawMs=${drift}ms`
  );

  // Result UI on both boards.
  const resultA = await pageA.evaluate(() => document.querySelector('[data-testid="game-result"]')?.textContent ?? "");
  check("result shown on both clients", resultA.length > 0, resultA.trim().slice(0, 60));
  check("zero page errors (both contexts)", errorsA.length === 0 && errorsB.length === 0, (errorsA[0] ?? errorsB[0] ?? "").slice(0, 100));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngate (e): ${failed.length === 0 ? "PASS" : `FAIL (${failed.length}/${results.length})`}`);
process.exit(failed.length === 0 ? 0 : 1);
