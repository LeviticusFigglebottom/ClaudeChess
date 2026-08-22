import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import type { Db } from "../src/lib/account/types";
import { fetchAggregatePosition } from "../src/lib/explorer/local";

const client = postgres("postgres://gambit:gambit@127.0.0.1:5432/gambit", { prepare: false });
const db = drizzle(client, { schema }) as unknown as Db;
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const pos = await fetchAggregatePosition(db, START, { speeds: ["blitz", "rapid", "classical"], ratings: ["1400", "1600", "1800"] });
console.log("startpos:", pos ? `${pos.moves.length} moves, ${pos.white + pos.draws + pos.black} games; top: ${pos.moves.slice(0, 3).map(m => `${m.san} (${m.white + m.draws + m.black})`).join(", ")}` : "NULL");
const italian = await fetchAggregatePosition(db, "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3", { speeds: ["blitz"], ratings: ["1600"] });
console.log("italian (blitz 1600 only):", italian ? `${italian.moves.length} moves, opening: ${italian.opening?.name ?? "?"}` : "NULL");
await client.end(); process.exit(0);
