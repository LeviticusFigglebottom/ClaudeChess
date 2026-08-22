/**
 * Measurement harness for CLIENT-SIDE batch analysis (the §3.3 revision):
 * drives the real review page in a real browser (dev-auth), clicks Analyze,
 * and timestamps the progressive-depth milestones by polling the review
 * payload:
 *
 *   t_first_useful  every ply classified (pass 1, depth 12 — provisional)
 *   t_review        every ply at review depth 18 (pass 2)
 *   t_done          client flow finished (verify + finalize; UI idle)
 *
 *   BASE_URL=http://localhost:3000 node scripts/measure-client-analysis.mjs \
 *     [--handle lichessUser] [--target-plies 80] [--cap-min 20]
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : fallback;
};
const HANDLE = flag("--handle", "Chess-Network");
const TARGET = Number(flag("--target-plies", "80"));
const CAP_MS = Number(flag("--cap-min", "20")) * 60_000;

const launchOpts = { executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" };
if (process.env.HTTPS_PROXY && !BASE.includes("localhost")) {
  launchOpts.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };
  launchOpts.args = ["--ssl-version-max=tls1.2"];
}

const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext();
  if (BASE.includes("localhost")) {
    await ctx.addCookies([
      { name: "gambit-dev-user", value: randomUUID(), url: BASE },
    ]);
  }
  const page = await ctx.newPage();
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" || text.startsWith("[batch]")) console.log(`[page] ${text.slice(0, 220)}`);
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });

  const api = (path, init) =>
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

  const caps = await page.evaluate(() => ({
    isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
    cores: navigator.hardwareConcurrency ?? 0,
  }));
  console.log(`capability: crossOriginIsolated=${caps.isolated} cores=${caps.cores}`);

  // Deployed runs: create a verified user (anonymous → converted →
  // admin-confirmed) exactly like repro-analyze-prod.mjs.
  if (!BASE.includes("localhost")) {
    const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPA || !SERVICE) throw new Error("prod run needs Supabase admin env");
    let me = null;
    for (let i = 0; i < 40 && !me; i++) {
      const r = await api("/api/account/me");
      if (r.status === 200 && r.body?.user?.id) me = r.body;
      else await page.waitForTimeout(1000);
    }
    if (!me) throw new Error("no anonymous session");
    const email = `measure-client-${Date.now()}@example.com`;
    await page.click('button[aria-haspopup="menu"]');
    await page.click("text=Create account");
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', `Measure!${Date.now()}`);
    await page.click('form button[type="submit"]');
    await page.waitForTimeout(4000);
    await fetch(`${SUPA}/auth/v1/admin/users/${me.user.id}`, {
      method: "PUT",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, email_confirm: true }),
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    let verified = false;
    for (let i = 0; i < 30 && !verified; i++) {
      const r = await api("/api/account/me");
      if (r.status === 200 && r.body?.user?.isAnonymous === false) verified = true;
      else {
        await page.waitForTimeout(2000);
        if (i % 5 === 4) await page.reload({ waitUntil: "domcontentloaded" });
      }
    }
    console.log(`prod user verified: ${verified} (${me.user.id.slice(0, 8)}…)`);
    if (!verified) throw new Error("conversion did not verify");
  }

  // Import until a game near the target ply count exists (2 chunks max).
  await api("/api/import", {
    method: "POST",
    body: JSON.stringify({ action: "link", source: "lichess", username: HANDLE }),
  });
  let target = null;
  for (let chunk = 0; chunk < 2 && !target; chunk++) {
    const run = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({ action: "run", source: "lichess" }),
    });
    console.log(
      `import chunk ${chunk + 1}: ${run.status} imported=${run.body?.result?.imported ?? "?"}`
    );
    const games = await api("/api/games?limit=100");
    const list = (games.body?.games ?? []).filter((g) => g.variant === "standard" && g.plyCount >= TARGET * 0.8);
    list.sort((a, b) => Math.abs(a.plyCount - TARGET) - Math.abs(b.plyCount - TARGET));
    target = list[0] ?? null;
  }
  if (!target) throw new Error("no suitable game imported");
  console.log(`target game ${target.id} — ${target.plyCount} plies (${target.timeControl ?? "?"})`);

  // Open the review page and click Analyze.
  await page.goto(`${BASE}/analysis/${target.id}`, { waitUntil: "domcontentloaded" });
  const button = page.getByRole("button", { name: /Analyze game|Finish analysis/ });
  await button.waitFor({ timeout: 20_000 });
  const t0 = Date.now();
  await button.click();
  console.log("analyze clicked");

  // Poll the payload for milestone transitions.
  let tFirstUseful = null;
  let tReview = null;
  let tDone = null;
  const seconds = (t) => ((t - t0) / 1000).toFixed(1);
  while (Date.now() - t0 < CAP_MS) {
    await page.waitForTimeout(2000);
    const state = await api(`/api/games/${target.id}`);
    const plies = state.body?.plies ?? [];
    if (plies.length === 0) continue;
    const classified = plies.every((p) => p.classification !== null);
    const atReview = plies.every((p) => p.degraded || (p.analyzedAtDepth ?? 0) >= 18);
    if (classified && tFirstUseful === null) {
      tFirstUseful = Date.now();
      console.log(`t_first_useful (pass 1 complete, provisional review): ${seconds(tFirstUseful)}s`);
    }
    if (atReview && tReview === null) {
      tReview = Date.now();
      console.log(`t_review (pass 2 complete, depth 18 everywhere): ${seconds(tReview)}s`);
    }
    const busy = await page
      .getByRole("button", { name: "Analyzing…" })
      .isVisible()
      .catch(() => false);
    if (atReview && !busy && tDone === null) {
      tDone = Date.now();
      const accuracy = state.body?.accuracy;
      console.log(
        `t_done (verify + finalize, UI idle): ${seconds(tDone)}s — accuracy ${accuracy?.white?.toFixed?.(1) ?? "?"}/${accuracy?.black?.toFixed?.(1) ?? "?"}`
      );
      break;
    }
  }
  const depths = await api(`/api/games/${target.id}`);
  const dist = {};
  for (const p of depths.body?.plies ?? []) {
    const key = p.degraded ? "degraded" : String(p.analyzedAtDepth);
    dist[key] = (dist[key] ?? 0) + 1;
  }
  console.log(`final analyzedAtDepth distribution: ${JSON.stringify(dist)}`);
  console.log(
    tDone
      ? `RESULT: ${target.plyCount}-ply game — first useful ${seconds(tFirstUseful)}s · full depth ${seconds(tReview)}s · done ${seconds(tDone)}s`
      : `RESULT: NOT done inside the cap (first useful ${tFirstUseful ? seconds(tFirstUseful) : "—"}s, review ${tReview ? seconds(tReview) : "—"}s)`
  );
} finally {
  await browser.close();
  process.exit(0);
}
