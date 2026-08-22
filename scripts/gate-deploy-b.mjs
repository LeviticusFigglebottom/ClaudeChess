/**
 * Deployment gate (b): the Supabase Auth round-trip Phase 1.5 could not
 * exercise — against the DEPLOYED app and the LIVE auth service.
 *
 *   anonymous sign-in → prefs write → live game between two anonymous
 *   users (challenge link → move → resign → archive) → email conversion →
 *   confirmation → SAME users.id row with games/ratings/prefs intact.
 *
 * Credentials come from env (BASE_URL, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) — never hardcoded. The confirmation leg
 * prefers the admin generate_link path (real verify endpoint, no SMTP);
 * falls back to admin email-confirm and says which leg ran.
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "https://claude-chess-nine.vercel.app";
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !SERVICE) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(2);
}

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const launchOpts = {
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
};
if (process.env.HTTPS_PROXY) {
  launchOpts.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };
  launchOpts.args = ["--ssl-version-max=tls1.2"];
}

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

const waitForMe = async (page, label) => {
  for (let i = 0; i < 40; i++) {
    const me = await api(page, "/api/account/me");
    if (me.status === 200 && me.body?.user?.id) return me.body;
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: /api/account/me never returned a user`);
};

const admin = async (path, method, body) => {
  const response = await fetch(`${SUPA}/auth/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
    },
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
  // ---- Anonymous user A -------------------------------------------------
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  const consoleErrorsA = [];
  pageA.on("pageerror", (err) => consoleErrorsA.push(String(err)));
  await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  const meA1 = await waitForMe(pageA, "A");
  check(
    "anonymous sign-in provisions a users row (A)",
    meA1.user.isAnonymous === true && !!meA1.user.id,
    `id=${meA1.user.id.slice(0, 8)}… handle=${meA1.user.handle}`
  );

  // Preference marker through the app's own API (same path the UI uses).
  const marker = `gate-b-${Date.now()}`;
  const currentPrefs = (await api(pageA, "/api/account/prefs")).body?.prefs ?? {};
  const prefsPut = await api(pageA, "/api/account/prefs", {
    method: "PUT",
    body: JSON.stringify({ prefs: { ...currentPrefs, gateMarker: marker } }),
  });
  check("prefs write (A)", prefsPut.status === 200, `marker=${marker}`);

  // ---- Anonymous user B -------------------------------------------------
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(BASE, { waitUntil: "domcontentloaded" });
  const meB = await waitForMe(pageB, "B");
  check(
    "anonymous sign-in provisions a users row (B)",
    meB.user.isAnonymous === true && meB.user.id !== meA1.user.id,
    `id=${meB.user.id.slice(0, 8)}…`
  );

  // ---- Live game: A creates an open challenge, B accepts, A moves, B resigns
  const created = await api(pageA, "/api/challenges", {
    method: "POST",
    body: JSON.stringify({
      action: "create",
      variant: "standard",
      timeControl: "180+2",
      rated: false,
      color: "white",
    }),
  });
  const token = created.body?.challenge?.token;
  check("challenge created (A, open link)", created.status === 200 && !!token, `token=${String(token).slice(0, 8)}…`);

  const accepted = await api(pageB, "/api/challenges", {
    method: "POST",
    body: JSON.stringify({ action: "accept", token }),
  });
  const gameId = accepted.body?.play?.gameId;
  check("challenge accepted → live game (B)", accepted.status === 200 && !!gameId, `game=${String(gameId).slice(0, 8)}…`);

  const moved = await api(pageA, `/api/play/${gameId}`, {
    method: "POST",
    body: JSON.stringify({ action: "move", uci: "e2e4" }),
  });
  check("live move applies (A)", moved.status === 200, `status=${moved.status}`);

  const resigned = await api(pageB, `/api/play/${gameId}`, {
    method: "POST",
    body: JSON.stringify({ action: "resign" }),
  });
  const finState = resigned.body?.state;
  check(
    "resignation finishes the game (B)",
    resigned.status === 200 && finState?.status === "finished" && finState?.result === "1-0",
    `result=${finState?.result} termination=${finState?.termination}`
  );

  // Archive-on-finish → history exists for A.
  let gamesA1 = null;
  for (let i = 0; i < 20; i++) {
    gamesA1 = await api(pageA, "/api/games");
    const list = gamesA1.body?.games ?? gamesA1.body ?? [];
    if (Array.isArray(list) && list.length > 0) break;
    await pageA.waitForTimeout(1000);
  }
  const listA1 = gamesA1.body?.games ?? gamesA1.body ?? [];
  check(
    "finished game archived into A's history",
    Array.isArray(listA1) && listA1.length >= 1,
    `games=${Array.isArray(listA1) ? listA1.length : "?"}`
  );

  const snapshotPre = await api(pageA, "/api/account/me");
  const ratingsPre = JSON.stringify(snapshotPre.body?.ratings ?? snapshotPre.body?.user?.ratings ?? null);

  // ---- Conversion via the real UI --------------------------------------
  const email = `gate-b-${Date.now()}@example.com`;
  const password = `Gate-b!${Date.now()}`;
  await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  await pageA.click('button[aria-haspopup="menu"]');
  await pageA.click('text=Create account');
  await pageA.fill('input[type="email"]', email);
  await pageA.fill('input[type="password"]', password);
  await pageA.click('form button[type="submit"]');
  const pendingSeen = await pageA
    .waitForSelector("text=Confirmation email sent", { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("conversion submits; pending-confirmation state shown", pendingSeen, email);

  // ---- Confirmation leg -------------------------------------------------
  // Preferred: mint the confirmation link via the admin API (exactly what
  // the email would carry) and open it in A's browser.
  let confirmationLeg = "none";
  const linkTry = await admin("/admin/generate_link", "POST", {
    type: "email_change_new",
    email: email,
    new_email: email,
  });
  let actionLink = linkTry.body?.action_link ?? linkTry.body?.properties?.action_link;
  if (actionLink) {
    confirmationLeg = "generate_link (verify endpoint)";
    await pageA.goto(actionLink, { waitUntil: "domcontentloaded" });
    await pageA.waitForTimeout(3000);
    await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  } else {
    // Fallback: admin-confirm the email on the same auth user, then let the
    // client pick the change up (server-side getUser() sees fresh state).
    const upd = await admin(`/admin/users/${meA1.user.id}`, "PUT", {
      email,
      email_confirm: true,
    });
    confirmationLeg = `admin email_confirm (status ${upd.status})`;
    await pageA.goto(BASE, { waitUntil: "domcontentloaded" });
  }
  console.log(`confirmation leg: ${confirmationLeg} (generate_link status ${linkTry.status})`);

  // ---- Post-conversion verification ------------------------------------
  let meA2 = null;
  for (let i = 0; i < 30; i++) {
    const me = await api(pageA, "/api/account/me");
    if (me.status === 200 && me.body?.user?.isAnonymous === false) {
      meA2 = me.body;
      break;
    }
    await pageA.waitForTimeout(2000);
    if (i % 5 === 4) await pageA.reload({ waitUntil: "domcontentloaded" });
  }
  check(
    "conversion completes (isAnonymous flips, email attached)",
    !!meA2 && meA2.user.email === email,
    meA2 ? `email=${meA2.user.email}` : "never flipped"
  );
  check(
    "A2.1: SAME users.id row after conversion (links, never copies)",
    !!meA2 && meA2.user.id === meA1.user.id,
    meA2 ? `${meA1.user.id.slice(0, 8)}… === ${meA2.user.id.slice(0, 8)}…` : "n/a"
  );

  const prefsPost = await api(pageA, "/api/account/prefs");
  check(
    "preferences survive conversion",
    prefsPost.body?.prefs?.gateMarker === marker,
    `gateMarker=${prefsPost.body?.prefs?.gateMarker}`
  );

  const gamesA2 = await api(pageA, "/api/games");
  const listA2 = gamesA2.body?.games ?? gamesA2.body ?? [];
  check(
    "game history survives conversion",
    Array.isArray(listA2) && listA2.length === listA1.length,
    `games=${Array.isArray(listA2) ? listA2.length : "?"}`
  );

  const snapshotPost = await api(pageA, "/api/account/me");
  const ratingsPost = JSON.stringify(snapshotPost.body?.ratings ?? snapshotPost.body?.user?.ratings ?? null);
  check("ratings state survives conversion", ratingsPre === ratingsPost, ratingsPost?.slice(0, 80));

  check("no page errors in A's console", consoleErrorsA.length === 0, consoleErrorsA.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\ngate (b): ${failed.length === 0 ? "PASS" : `FAIL (${failed.length}/${results.length} checks failed)`}`);
process.exit(failed.length === 0 ? 0 : 1);
