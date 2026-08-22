/**
 * Phase 2 gate — step 1: import analysed Lichess games for the gate user.
 *
 *   DATABASE_URL=... npx tsx scripts/gate-import.mts [--user <lichess>] [--max 50]
 *
 * Pulls games that Lichess itself has server-analysed (evals=true +
 * analysed=true + clocks=true) so their PGNs carry Lichess's own
 * inaccuracy/mistake/blunder judgments — the agreement baseline the gate
 * compares against (the kickoff replaces chess.com's unfetchable Game
 * Review with this). The stored PGN keeps those annotations; our own
 * analysis then fills `plies` independently.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { ensureUser } from "../src/lib/account/users";
import type { Db } from "../src/lib/account/types";
import { parseMultiPgn, replayPgnGame, variantFromHeader } from "../src/lib/chess/pgn-read";
import { lichessExportPgn } from "../src/lib/import/platforms";
import { storeImportedGame } from "../src/lib/import/store";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 ? args[index + 1] : undefined;
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gambit:gambit@127.0.0.1:5432/gambit";
const max = Number(flag("max") ?? 50);
// Prolific public accounts with heavy analysed-game history; first reachable
// with enough analysed+clocked standard games wins. Overridable via --user.
const candidates = flag("user")
  ? [flag("user") as string]
  : ["german11", "Chess-Network", "EricRosen", "penguingim1"];

const client = postgres(DATABASE_URL, { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;

const GATE_HANDLE = "gate-phase2";

async function main() {
  // Deterministic gate user (idempotent across runs).
  const existing = await db.query.users.findFirst({
    where: (users, { eq }) => eq(users.handle, GATE_HANDLE),
  });
  const user =
    existing ??
    (
      await ensureUser(db, {
        id: randomUUID(),
        isAnonymous: false,
        email: "gate-phase2@example.invalid",
        emailConfirmedAt: new Date().toISOString(),
      }, { desiredHandle: GATE_HANDLE })
    ).user;
  console.log(`gate user: ${user.handle} (${user.id})`);

  for (const candidate of candidates) {
    console.log(`\ntrying lichess user "${candidate}"…`);
    let pgnText: string;
    try {
      pgnText = await lichessExportPgn(candidate, {
        max: Math.ceil(max * 1.6), // headroom for skipped variants/unclocked
        evals: true,
        analysed: true,
        literate: true,
        sort: "dateDesc", // recent games carry %clk (pre-2017 games do not)
        perfType: "blitz,rapid,classical",
      });
    } catch (error) {
      console.log(`  export failed: ${(error as Error).message}`);
      continue;
    }
    const rawGames = parseMultiPgn(pgnText);
    console.log(`  exported ${rawGames.length} analysed games`);
    let imported = 0;
    let skipped = 0;
    for (const raw of rawGames) {
      if (imported >= max) break;
      const site = raw.headers.Site ?? "";
      const externalId = site.match(/lichess\.org\/(\w{8})/)?.[1] ?? site;
      if (variantFromHeader(raw.headers.Variant) !== "standard") {
        skipped++;
        continue;
      }
      const hasClocks = raw.moves.some((move) => move.clockMs !== null);
      const hasEvals = raw.moves.some((move) => move.evalCp !== null || move.evalMate !== null);
      if (!hasClocks || !hasEvals || raw.moves.length < 20) {
        skipped++;
        continue;
      }
      const white = raw.headers.White ?? "?";
      const black = raw.headers.Black ?? "?";
      const userColor =
        white.toLowerCase() === candidate.toLowerCase() ? "white" : "black";
      try {
        const replayed = replayPgnGame(raw);
        const start = pgnText.indexOf(`[Site "https://lichess.org/${externalId}"]`);
        const headerStart = pgnText.lastIndexOf("[Event", start);
        const nextGame = pgnText.indexOf("[Event", start + 10);
        const singlePgn = pgnText
          .slice(headerStart, nextGame === -1 ? undefined : nextGame)
          .trim();
        const stored = await storeImportedGame(db, user.id, replayed, {
          source: "lichess",
          externalId,
          pgn: singlePgn,
          whiteName: white,
          blackName: black,
          userColor,
          timeControl: raw.headers.TimeControl ?? null,
          termination: raw.headers.Termination ?? null,
          playedAt: raw.headers.UTCDate
            ? new Date(`${raw.headers.UTCDate.replaceAll(".", "-")}T${raw.headers.UTCTime ?? "12:00:00"}Z`)
            : null,
          ratedByPlatform: (raw.headers.Event ?? "").toLowerCase().includes("rated"),
        });
        if (!stored.duplicate) imported++;
      } catch (error) {
        console.log(`  skip ${externalId}: ${(error as Error).message}`);
        skipped++;
      }
    }
    console.log(`  imported ${imported}, skipped ${skipped}`);
    if (imported >= Math.min(max, 30)) {
      console.log(`\nDONE: ${imported} analysed games imported for ${GATE_HANDLE} from ${candidate}`);
      await client.end();
      return;
    }
    console.log(`  not enough qualifying games — trying next candidate`);
  }
  console.error("FAILED: no candidate account yielded enough analysed games");
  await client.end();
  process.exit(1);
}

await main();
