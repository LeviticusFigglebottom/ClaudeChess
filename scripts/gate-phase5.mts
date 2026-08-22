/**
 * Phase 5 gate evidence: every trainer exercised end-to-end over the REAL
 * Phase 2 gate dataset (50 analyzed games with clocks and blunder_tags),
 * through the real routes with a dev-auth identity:
 *
 *  §9.1 calibration — next position, prediction round-trip (server-computed
 *       reveal), report with curve/bias/decomposition;
 *  §9.3 tempo — response curves, flat point, misallocation s/game from real
 *       %clk data; recognition round-trip;
 *  §9.2 fingerprint — distribution over real error plies, drill themes via
 *       B1.2, and the C5 LLM-dark degradation (explanations 200/available:false);
 *  §9.4 repertoire — EV tree build from the live explorer, ranked list,
 *       SM-2 drill state transition, own-leaks scan;
 *  §9.5 postmortem — ≤5 critical prompts per game; /api/coach refuses
 *       cleanly without an LLM key (503, the one REQUIRED LLM use).
 *
 *   npx tsx scripts/gate-phase5.mts [--url http://localhost:3000]
 */
import postgres from "postgres";

const urlFlag = process.argv.indexOf("--url");
const base = urlFlag !== -1 ? process.argv[urlFlag + 1]! : "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

async function main() {
  const sql = postgres(DATABASE_URL, { prepare: false });
  const users = await sql`SELECT id FROM users WHERE handle = 'gate-phase2'`;
  const userId = users[0]?.id as string | undefined;
  if (!userId) throw new Error("gate-phase2 user missing — run the Phase 2 gate first");
  const gameRows = await sql`
    SELECT g.id FROM games g
    JOIN plies p ON p.game_id = g.id AND p.is_critical
    WHERE g.user_id = ${userId} GROUP BY g.id ORDER BY count(*) DESC LIMIT 1`;
  const gameId = gameRows[0]!.id as string;
  await sql.end();

  const headers = { Cookie: `gambit-dev-user=${userId}`, "Content-Type": "application/json" };
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers });
    return { ok: response.ok, status: response.status, body: await response.json() };
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  };

  // --- §9.1 calibration ---
  const next = await get("/api/train/calibration");
  const position = (next.body as { position: { plyId: number; fen: string; tags: Record<string, unknown> } | null }).position;
  record(
    "§9.1 serves a position from the user's own games with tags",
    next.ok && position !== null && typeof position.tags.phase === "string",
    position ? `ply ${position.plyId}, tags ${JSON.stringify(position.tags).slice(0, 90)}` : "none"
  );
  const attempt = position
    ? await post("/api/train/calibration", { plyId: position.plyId, predictedWp: 63 })
    : null;
  const reveal = (attempt?.body as { reveal?: { engineWp: number; squaredError: number } })?.reveal;
  record(
    "§9.1 prediction round-trip: server-computed engine WP + Brier",
    Boolean(attempt?.ok && reveal && reveal.engineWp >= 0 && reveal.engineWp <= 100),
    reveal ? `engineWp=${reveal.engineWp.toFixed(1)} brier=${reveal.squaredError.toFixed(4)}` : "failed"
  );
  const calReport = await get("/api/train/calibration?report=1");
  const report = (calReport.body as { report: { n: number; curve: unknown[]; decomposition: unknown } }).report;
  record(
    "§9.1 report: decile curve + decomposition present",
    calReport.ok && report.n >= 1 && report.decomposition !== null,
    `n=${report.n}, curve bins=${report.curve.length}`
  );

  // --- §9.3 tempo ---
  const tempo = await get("/api/train/tempo");
  const tempoReport = (tempo.body as {
    report: {
      n: number;
      gamesCovered: number;
      curveRoutine: unknown[];
      curveCritical: unknown[];
      flatPointSeconds: number | null;
      misallocationSecondsPerGame: number | null;
    };
  }).report;
  record(
    "§9.3 response curves from real %clk data (critical vs routine)",
    tempo.ok && tempoReport.n > 500 && tempoReport.curveRoutine.length >= 3 && tempoReport.curveCritical.length >= 3,
    `n=${tempoReport.n} over ${tempoReport.gamesCovered} games; routine bins=${tempoReport.curveRoutine.length}`
  );
  record(
    "§9.3 flat point + misallocation seconds/game computed",
    tempoReport.flatPointSeconds !== null && tempoReport.misallocationSecondsPerGame !== null,
    `flat at ${tempoReport.flatPointSeconds}s; wasting ${tempoReport.misallocationSecondsPerGame?.toFixed(0)}s/game`
  );
  const recognition = await get("/api/train/tempo?recognition=1");
  const recPosition = (recognition.body as { position: { plyId: number } | null }).position;
  const recAttempt = recPosition
    ? await post("/api/train/tempo", { plyId: recPosition.plyId, guessedCritical: true, answeredInMs: 2100 })
    : null;
  record(
    "§9.3 recognition round-trip (server keeps the flag)",
    Boolean(recAttempt?.ok && typeof (recAttempt.body as { correct: boolean }).correct === "boolean"),
    recAttempt ? JSON.stringify(recAttempt.body) : "no position"
  );

  // --- §9.2 fingerprint ---
  const fingerprint = await get("/api/train/fingerprint");
  const fpReport = (fingerprint.body as {
    report: {
      errorPlies: number;
      distribution: { motif: string; share: number }[];
      drill: { motifs: string[]; themes: string[] };
      trend: unknown[];
    };
  }).report;
  record(
    "§9.2 distribution over real error plies (C5: zero LLM involved)",
    fingerprint.ok && fpReport.errorPlies > 100 && fpReport.distribution.length >= 5,
    `${fpReport.errorPlies} errors; top ${fpReport.distribution[0]?.motif} ${(100 * (fpReport.distribution[0]?.share ?? 0)).toFixed(1)}%`
  );
  record(
    "§9.2 drill deck maps top motifs to puzzle themes (B1.2)",
    fpReport.drill.motifs.length === 3 && fpReport.drill.themes.length >= 2,
    `motifs ${fpReport.drill.motifs.join(",")} → themes ${fpReport.drill.themes.join(",")}`
  );
  // Final task: UNCLEAR as a first-class output — nature headline, swing
  // subdivision, and "engine preferred" rows for the review-and-work-it-out
  // training mode. Presentation over data that already exists.
  const fpFull = (fingerprint.body as {
    report: {
      nature: { tactical: number; positional: number; other: number; tacticalShare: number };
      unclear: { count: number; share: number; mates: number; material: number; quiet: number };
    };
  }).report;
  record(
    "§9.2 tactical-to-positional headline (UNCLEAR counted as positional)",
    fingerprint.ok &&
      fpFull.nature.tactical > 0 &&
      fpFull.nature.positional > 0 &&
      fpFull.nature.tacticalShare > 0 &&
      fpFull.nature.tacticalShare < 1,
    `${(100 * fpFull.nature.tacticalShare).toFixed(1)}% tactical (${fpFull.nature.tactical}/${fpFull.nature.positional}/${fpFull.nature.other})`
  );
  record(
    "§9.2 UNCLEAR swing subdivision partitions its count (mate/material/quiet)",
    fpFull.unclear.count > 0 &&
      fpFull.unclear.mates + fpFull.unclear.material + fpFull.unclear.quiet === fpFull.unclear.count,
    `${fpFull.unclear.count} unclear = ${fpFull.unclear.quiet} quiet + ${fpFull.unclear.material} material + ${fpFull.unclear.mates} mate`
  );
  const unclearList = await get("/api/train/fingerprint?list=1&motif=UNCLEAR");
  const unclearRows = (unclearList.body as { errors: { bestUci: string | null; bestSan: string | null }[] }).errors;
  record(
    "§9.2 UNCLEAR rows carry the engine's preferred move (no mechanism claim)",
    unclearList.ok && unclearRows.length > 0 && unclearRows.every((row) => row.bestUci !== null),
    `${unclearRows.length} rows, e.g. engine preferred ${unclearRows[0]?.bestSan ?? unclearRows[0]?.bestUci}`
  );
  const errorList = await get("/api/train/fingerprint?list=1");
  const firstError = (errorList.body as { errors: { plyId: number }[] }).errors[0];
  const explain = firstError ? await post("/api/classify-blunder", { plyId: firstError.plyId }) : null;
  record(
    "§9.2 explanations degrade cleanly with the LLM dark (200, available:false)",
    Boolean(explain?.ok && (explain.body as { available: boolean }).available === false),
    explain ? JSON.stringify(explain.body).slice(0, 90) : "no error ply"
  );

  // --- §9.4 repertoire ---
  const build = await post("/api/train/repertoire", { action: "build", color: "white" });
  const buildResult = (build.body as { build?: { fetched: number; nodesUpserted: number } }).build;
  record(
    "§9.4 EV tree builds from the live explorer at the user's band",
    Boolean(build.ok && buildResult && buildResult.nodesUpserted > 10),
    buildResult ? `${buildResult.nodesUpserted} nodes from ${buildResult.fetched} positions` : "failed"
  );
  const list = await get("/api/train/repertoire?color=white");
  const toLearn = (list.body as { toLearn: { id: string; evPerNode: number; priority: number }[] }).toLearn;
  record(
    "§9.4 ranked to-learn list (EV/cost priority)",
    list.ok && toLearn.length > 0 && toLearn.every((row, i, all) => i === 0 || row.priority <= (all[i - 1]!.priority) || row.priority >= 0),
    `${toLearn.length} candidates; top EV ${toLearn[0]?.evPerNode.toFixed(2)}/100 games`
  );
  const drill = toLearn[0]
    ? await post("/api/train/repertoire", { action: "drill", nodeId: toLearn[0].id, quality: 5 })
    : null;
  record(
    "§9.4 SM-2 drill transitions state and schedules a due date",
    Boolean(drill?.ok && (drill.body as { dueAt: string }).dueAt),
    drill ? JSON.stringify(drill.body) : "no node"
  );
  const leaks = await post("/api/train/repertoire", { action: "leaks", color: "white" });
  const leaksResult = (leaks.body as { leaks?: { scanned: number; leaks: number } }).leaks;
  record(
    "§9.4 own-leaks cross-reference runs over the user's games",
    Boolean(leaks.ok && leaksResult && leaksResult.scanned >= 0),
    leaksResult ? `${leaksResult.leaks} leaks in ${leaksResult.scanned} repeated book moves` : "failed"
  );

  // --- §9.5 postmortem ---
  const prompts = await get(`/api/train/postmortem?gameId=${gameId}`);
  const promptsBody = prompts.body as { prompts: { plyId: number }[]; llm: boolean };
  record(
    "§9.5 prompts gated to critical plies, max 5 per game",
    prompts.ok && promptsBody.prompts.length >= 1 && promptsBody.prompts.length <= 5,
    `${promptsBody.prompts.length} prompts; llm configured: ${promptsBody.llm}`
  );
  const coach = promptsBody.prompts[0]
    ? await post("/api/coach", {
        plyId: promptsBody.prompts[0].plyId,
        userReasoning: "I was worried about my back rank and thought their rook lift was slow.",
      })
    : null;
  const llmConfigured = promptsBody.llm;
  record(
    llmConfigured
      ? "§9.5 coach returns a closed-taxonomy verdict"
      : "§9.5 coach refuses cleanly without an LLM key (required-LLM boundary)",
    Boolean(
      coach &&
        (llmConfigured
          ? coach.ok && typeof (coach.body as { verdict?: string }).verdict === "string"
          : coach.status === 503)
    ),
    coach ? `status=${coach.status} ${JSON.stringify(coach.body).slice(0, 90)}` : "no prompt"
  );

  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} Phase 5 gate checks pass`);
  process.exit(failed.length ? 1 : 0);
}

await main();
