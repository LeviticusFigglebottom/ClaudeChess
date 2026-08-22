/**
 * Deployment gate (d) — DEFERRED LLM key, degraded-mode verification:
 * the two metered LLM routes must answer their guard chain and a clean 503
 * (llm_unavailable) at the LLM boundary; trainer UI renders without errors.
 *
 * The LLM boundary is only reachable through a real critical ply, so a
 * minimal fixture game/ply/tag is inserted for a dedicated verified test
 * user via the service key (reported as fixture data, not organic).
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "https://claude-chess-nine.vercel.app";
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = "gate-d@example.com";
const PASSWORD = "Gate-d-pass-2026!";

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const rest = async (path, method, body, extra = {}) => {
  const response = await fetch(`${SUPA}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {}
  return { status: response.status, body: json };
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

// ---- 1. unauthenticated → 401 ------------------------------------------
{
  const response = await fetch(`${BASE}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plyId: 1, userReasoning: "x" }),
  });
  check("coach unauthenticated → 401", response.status === 401, `status=${response.status}`);
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" },
  args: ["--ssl-version-max=tls1.2"],
});
try {
  // ---- 2. anonymous (unverified) → 403 ---------------------------------
  const anonPage = await (await browser.newContext()).newPage();
  await anonPage.goto(BASE, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30; i++) {
    const me = await api(anonPage, "/api/account/me");
    if (me.status === 200) break;
    await anonPage.waitForTimeout(1000);
  }
  const anonCoach = await api(anonPage, "/api/coach", {
    method: "POST",
    body: JSON.stringify({ plyId: 1, userReasoning: "x" }),
  });
  check(
    "coach anonymous → 403 verified_required",
    anonCoach.status === 403 && anonCoach.body?.error?.code === "verified_required",
    `status=${anonCoach.status} code=${anonCoach.body?.error?.code}`
  );

  // ---- 3. verified user signs in through the real UI -------------------
  const page = await (await browser.newContext()).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30; i++) {
    const me = await api(page, "/api/account/me");
    if (me.status === 200) break;
    await page.waitForTimeout(1000);
  }
  await page.click('button[aria-haspopup="menu"]');
  await page.click("text=Sign in to existing account");
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  let me = null;
  for (let i = 0; i < 30; i++) {
    const r = await api(page, "/api/account/me");
    if (r.status === 200 && r.body?.user?.isAnonymous === false) {
      me = r.body;
      break;
    }
    await page.waitForTimeout(1000);
  }
  check("verified sign-in through UI", !!me && me.user.email === EMAIL, me?.user?.id?.slice(0, 8));
  const uid = me.user.id;

  // Labs override via the same prefs path the settings UI writes.
  const prefs = (await api(page, "/api/account/prefs")).body?.prefs ?? {};
  const put = await api(page, "/api/account/prefs", {
    method: "PUT",
    body: JSON.stringify({ prefs: { ...prefs, labs: { ...(prefs.labs ?? {}), FF_POSTMORTEM: true } } }),
  });
  check("labs override saved (FF_POSTMORTEM)", put.status === 200);

  // ---- 4. fixture game + critical ply + tag (service key, reported) ----
  await rest(`/games?user_id=eq.${uid}`, "DELETE"); // idempotent re-runs (cascades to plies)
  const game = await rest("/games", "POST", {
    user_id: uid,
    variant: "standard",
    source: "local",
    pgn: "1. e4 e5 2. Qh5 Nc6 3. Qxf7# 1-0",
    white_name: "gate-d",
    black_name: "fixture",
    user_color: "white",
    result: "1-0",
  });
  const gameId = game.body?.[0]?.id;
  check("fixture game inserted", game.status === 201 && !!gameId, `status=${game.status}`);
  const ply = await rest("/plies", "POST", {
    game_id: gameId,
    ply: 3,
    move_number: 2,
    color: "white",
    san: "Qh5",
    uci: "d1h5",
    fen_before: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    fen_after: "rnbqkbnr/pppp1ppp/8/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 2",
    classification: "BLUNDER",
    wp_before: 55,
    wp_after: 30,
    wp_loss: 25,
    is_critical: true,
    pv1: ["g8f6"],
    eval_before_cp: 30,
    eval_after_cp: -120,
    analyzed_at_depth: 18,
  });
  const plyId = ply.body?.[0]?.id;
  check("fixture critical ply inserted", ply.status === 201 && !!plyId, `plyId=${plyId} status=${ply.status}`);
  const tag = await rest("/blunder_tags", "POST", {
    ply_id: plyId,
    motif: "PREMATURE_ATTACK",
    rank: 1,
    confidence: 0.6,
    evidence: {},
    model: "gambit-detectors-v1",
  });
  check("fixture blunder tag inserted", tag.status === 201, `status=${tag.status}`);

  // ---- 5. LLM boundary: coach + classify-blunder → 503 -----------------
  const coach = await api(page, "/api/coach", {
    method: "POST",
    body: JSON.stringify({ plyId, userReasoning: "I thought the queen sortie won a pawn by force." }),
  });
  check(
    "coach verified, real critical ply → 503 llm_unavailable",
    coach.status === 503 && coach.body?.error?.code === "llm_unavailable",
    `status=${coach.status} code=${coach.body?.error?.code}`
  );
  // classify-blunder's core (motif detection) is deterministic and works
  // keyless by design — the route answers 200 with the prose marked
  // unavailable, consuming no usage. Only the coach, whose entire function
  // is the LLM verdict, 503s.
  const classify = await api(page, "/api/classify-blunder", {
    method: "POST",
    body: JSON.stringify({ plyId }),
  });
  check(
    "classify-blunder verified → 200 {available:false, explanation:null} (prose-only degradation)",
    classify.status === 200 && classify.body?.available === false && classify.body?.explanation === null,
    `status=${classify.status} available=${classify.body?.available}`
  );

  // ---- 6. trainer UI renders cleanly with the flag on ------------------
  await page.goto(`${BASE}/train`, { waitUntil: "networkidle" });
  const hubText = await page.evaluate(() => document.body.innerText);
  await page.goto(`${BASE}/train/postmortem`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const pmText = await page.evaluate(() => document.body.innerText);
  check(
    "trainer hub renders (flag on, no broken UI)",
    hubText.toLowerCase().includes("train") && !hubText.toLowerCase().includes("something went wrong"),
    hubText.replace(/\n+/g, " | ").slice(0, 100)
  );
  check(
    "postmortem shows its real state, not an error page",
    pmText.includes("Interrogative post-mortem") && !pmText.toLowerCase().includes("something went wrong"),
    pmText.replace(/\n+/g, " | ").slice(0, 120)
  );
  check("zero page errors across trainer UI", pageErrors.length === 0, pageErrors[0]?.slice(0, 120));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngate (d) degraded-mode verification: ${failed.length === 0 ? "PASS (deferred — no key provisioned)" : `FAIL (${failed.length}/${results.length})`}`);
process.exit(failed.length === 0 ? 0 : 1);
