/**
 * Phase 4.5 live-play evidence: a three-check game between two dev users
 * through the REAL matchmaking + live-game API, ending the moment the third
 * check lands ("variant end"), plus a queue refusal check for crazyhouse.
 *
 * Needs `npm run dev` with dev-auth and DATABASE_URL (same as gate-phase4).
 *
 *   npx tsx scripts/gate-phase45-live.mts [--url http://localhost:3000]
 */
import { randomUUID } from "node:crypto";

const urlFlag = process.argv.indexOf("--url");
const base = urlFlag !== -1 ? process.argv[urlFlag + 1]! : "http://localhost:3000";

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

function client(userId: string) {
  const headers = { Cookie: `gambit-dev-user=${userId}`, "Content-Type": "application/json" };
  return {
    get: async (path: string) => (await fetch(`${base}${path}`, { headers })).json(),
    post: async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return { ok: response.ok, body: await response.json() };
    },
  };
}

// Verified against the facade: 3rd check lands on ply 9 (Qxg6+).
const LINE = ["e2e4", "e7e5", "f1c4", "f8c5", "c4f7", "e8f7", "d1h5", "g7g6", "h5g6"];

async function main() {
  const a = client(randomUUID());
  const b = client(randomUUID());
  const clock = { mode: "fischer", initialMs: 180_000, incrementMs: 2_000 };

  const refused = await a.post("/api/play/queue", {
    action: "join",
    variant: "crazyhouse",
    rated: false,
    clock,
  });
  record(
    "crazyhouse queue join refused (no drop UI — B1.1)",
    !refused.ok,
    JSON.stringify(refused.body).slice(0, 100)
  );

  const joinA = await a.post("/api/play/queue", {
    action: "join",
    variant: "threecheck",
    rated: false,
    clock,
  });
  const joinB = await b.post("/api/play/queue", {
    action: "join",
    variant: "threecheck",
    rated: false,
    clock,
  });
  const gameId: string | null =
    (joinB.body as { gameId?: string }).gameId ?? (joinA.body as { gameId?: string }).gameId ?? null;
  record("three-check matchmaking pairs", gameId !== null, `game ${gameId}`);
  if (!gameId) process.exit(1);

  const stateA = (await a.get(`/api/play/${gameId}`)) as {
    state: { yourColor: "white" | "black"; variant: string };
  };
  const white = stateA.state.yourColor === "white" ? a : b;
  const black = stateA.state.yourColor === "white" ? b : a;
  record(
    "live game created with variant threecheck",
    stateA.state.variant === "threecheck",
    `variant=${stateA.state.variant}`
  );

  let final: {
    status: string;
    result: string | null;
    termination: string | null;
    fen: string;
  } | null = null;
  for (const [index, uci] of LINE.entries()) {
    const mover = index % 2 === 0 ? white : black;
    const response = await mover.post(`/api/play/${gameId}`, { action: "move", uci });
    if (!response.ok) {
      record("scripted moves accepted", false, `ply ${index + 1} (${uci}) refused: ${JSON.stringify(response.body).slice(0, 120)}`);
      process.exit(1);
    }
    final = (response.body as { state: typeof final }).state;
  }
  record(
    "third check ends the game as a variant end",
    final !== null &&
      final.status === "finished" &&
      final.result === "1-0" &&
      final.termination === "variant end",
    `status=${final?.status} result=${final?.result} termination=${final?.termination} fen="${final?.fen}"`
  );

  const failed = results.filter((row) => !row.pass);
  console.log(`\n${results.length - failed.length}/${results.length} live variant checks pass`);
  process.exit(failed.length ? 1 : 0);
}

await main();
