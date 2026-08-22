/**
 * Reproduction harness for the reported imported-game analysis freeze/slowness
 * on the DEPLOYED app: creates a verified user (anonymous → converted →
 * admin-confirmed), links a public Lichess handle, imports one chunk, then
 * drives /api/analyze exactly like review-client.tsx does — logging per-call
 * wall time, HTTP status, progress payload, and any error body — until the
 * game finishes analyzing, a call fails, or the time cap elapses.
 *
 *   BASE_URL=… NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node scripts/repro-analyze-prod.mjs [--handle lichessUser] [--cap-min 6]
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "https://claude-chess-nine.vercel.app";
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !SERVICE) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(2);
}
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : fallback;
};
const HANDLE = flag("--handle", "thibault");
const CAP_MS = Number(flag("--cap-min", "6")) * 60_000;

const launchOpts = { executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" };
if (process.env.HTTPS_PROXY) {
  launchOpts.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };
  launchOpts.args = ["--ssl-version-max=tls1.2"];
}

const api = (page, path, init) =>
  page.evaluate(
    async ({ path, init }) => {
      const t0 = performance.now();
      const response = await fetch(path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      return {
        status: response.status,
        ms: Math.round(performance.now() - t0),
        body,
        raw: body === null ? text.slice(0, 200) : null,
      };
    },
    { path, init }
  );

const admin = async (path, method, body) => {
  const response = await fetch(`${SUPA}/auth/v1${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {}
  return { status: response.status, body: json };
};

const browser = await chromium.launch(launchOpts);
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  let me = null;
  for (let i = 0; i < 40 && !me; i++) {
    const r = await api(page, "/api/account/me");
    if (r.status === 200 && r.body?.user?.id) me = r.body;
    else await page.waitForTimeout(1000);
  }
  if (!me) throw new Error("no anonymous session");
  console.log(`anonymous user ${me.user.id.slice(0, 8)}…`);

  // Convert via the real UI, then admin-confirm (free tier has no SMTP headroom).
  const email = `repro-analyze-${Date.now()}@example.com`;
  const password = `Repro!${Date.now()}`;
  await page.click('button[aria-haspopup="menu"]');
  await page.click("text=Create account");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(4000);
  await admin(`/admin/users/${me.user.id}`, "PUT", { email, email_confirm: true });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  let verified = false;
  for (let i = 0; i < 30 && !verified; i++) {
    const r = await api(page, "/api/account/me");
    if (r.status === 200 && r.body?.user?.isAnonymous === false) verified = true;
    else {
      await page.waitForTimeout(2000);
      if (i % 5 === 4) await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
  console.log(`verified: ${verified}`);
  if (!verified) throw new Error("conversion did not verify");

  // Link + import one chunk.
  const linked = await api(page, "/api/import", {
    method: "POST",
    body: JSON.stringify({ action: "link", source: "lichess", username: HANDLE }),
  });
  console.log(`link lichess/${HANDLE}: ${linked.status}`);
  const t0 = Date.now();
  const run = await api(page, "/api/import", {
    method: "POST",
    body: JSON.stringify({ action: "run", source: "lichess" }),
  });
  console.log(
    `import run: ${run.status} in ${run.ms}ms — ${JSON.stringify(run.body?.result ?? run.body?.error ?? run.raw)}`
  );
  const games = await api(page, "/api/games");
  const list = games.body?.games ?? [];
  const target = list.find((g) => g.source === "lichess") ?? list[0];
  if (!target) throw new Error("no imported game to analyze");
  console.log(`target game ${target.id} (${target.variant}, plies≈${target.plyCount ?? "?"})`);

  // Drive /api/analyze exactly like the client loop, logging every call.
  console.log(`\ncall  status   ms  analyzed  progress            done  note`);
  let call = 0;
  let done = false;
  const started = Date.now();
  while (!done && Date.now() - started < CAP_MS) {
    call++;
    const r = await api(page, "/api/analyze", {
      method: "POST",
      body: JSON.stringify({ gameId: target.id }),
    });
    const p = r.body?.progress;
    const note =
      r.body?.error?.message ?? (r.raw ? `non-JSON: ${r.raw.replaceAll("\n", " ")}` : "");
    console.log(
      `${String(call).padStart(4)}  ${String(r.status).padStart(6)}  ${String(r.ms).padStart(6)}  ${String(
        r.body?.analyzedPlies ?? "-"
      ).padStart(8)}  ${p ? `${p.analyzed}/${p.total}`.padStart(18) : "-".padStart(18)}  ${
        r.body?.done ?? "-"
      }  ${note}`
    );
    if (r.status !== 200) {
      console.log(`\nVERDICT: chunk call failed with HTTP ${r.status} after ${call} calls — ${note}`);
      process.exit(0);
    }
    done = r.body?.done === true;
  }
  const total = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    done
      ? `\nVERDICT: analysis completed in ${total}s over ${call} chunk calls`
      : `\nVERDICT: NOT done after ${total}s / ${call} calls — matches the freeze/too-slow report`
  );
} finally {
  await browser.close();
  process.exit(0);
}
