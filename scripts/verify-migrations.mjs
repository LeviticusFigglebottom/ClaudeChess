/**
 * Gate G5 (Phase 0.5): apply every migration, in journal order, to an EMPTY
 * Postgres and verify the schema behaves. Runs against in-process PGlite
 * (real Postgres compiled to WASM, citext included) so it needs no external
 * database. Exits non-zero on any failure.
 *
 *   npm run db:verify
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

const migrationsDir = path.resolve("src/db/migrations");
const journal = JSON.parse(await readFile(path.join(migrationsDir, "meta/_journal.json"), "utf8"));

const db = await PGlite.create({ extensions: { citext } });

let statements = 0;
for (const entry of journal.entries) {
  const file = `${entry.tag}.sql`;
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    try {
      await db.exec(trimmed);
      statements++;
    } catch (error) {
      console.error(`FAIL in ${file}:\n${trimmed.slice(0, 300)}\n→ ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`applied ${file}`);
}

const expect = async (label, fn) => {
  try {
    await fn();
    console.log(`ok: ${label}`);
  } catch (error) {
    console.error(`FAIL: ${label} → ${error.message}`);
    process.exit(1);
  }
};

const expectRejects = async (label, sql) => {
  let failed = false;
  try {
    await db.exec(sql);
  } catch {
    failed = true;
  }
  if (!failed) {
    console.error(`FAIL: ${label} — statement was accepted but must be rejected`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
};

// All 27 tables present (17 through Phase 1.5; +linked_accounts/tb_cache/
// explorer_cache in Phase 2/3; +live_games/live_game_events/matchmaking_queue
// in Phase 4; +tempo_attempts/llm_cache in Phase 5).
await expect("27 tables exist", async () => {
  const result = await db.query(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public'`
  );
  if (result.rows[0].n !== 27) throw new Error(`expected 27 tables, found ${result.rows[0].n}`); // +explorer_agg (0015) +eval_cache (0017)
});

// Anonymous-first: user row with no email.
await expect("anonymous user (null email) inserts", () =>
  db.exec(
    `insert into users (id, handle, is_anonymous) values ('00000000-0000-0000-0000-000000000001', 'anon-x1y2z3', true)`
  )
);

// citext: handle uniqueness is case-insensitive.
await expectRejects(
  "handle unique is case-insensitive (citext)",
  `insert into users (id, handle, is_anonymous) values ('00000000-0000-0000-0000-000000000002', 'ANON-X1Y2Z3', true)`
);

// handle length check constraint.
await expectRejects(
  "handle shorter than 3 chars rejected",
  `insert into users (id, handle) values ('00000000-0000-0000-0000-000000000003', 'ab')`
);

// games defaults to standard variant; chess960 rows carry start data.
await expect("game rows: variant default + chess960 with startFen", async () => {
  await db.exec(
    `insert into games (id, user_id, source, pgn, white_name, black_name, user_color, result)
     values ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'local', '', 'a', 'b', 'white', '*')`
  );
  const standard = await db.query(
    `select variant from games where id = '00000000-0000-0000-0000-00000000000a'`
  );
  if (standard.rows[0].variant !== "standard") throw new Error("default variant wrong");
  await db.exec(
    `insert into games (id, user_id, variant, start_fen, start_position_id, source, pgn, white_name, black_name, user_color, result)
     values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'chess960',
             'bqnbnrkr/pppppppp/8/8/8/8/PPPPPPPP/BQNBNRKR w HFhf - 0 1', 266, 'local', '', 'a', 'b', 'white', '*')`
  );
});

// ratings key is (userId, variant, timeControl): same TC under two variants coexists…
await expect("ratings: same user+TC under standard and chess960 coexist", async () => {
  await db.exec(
    `insert into ratings (user_id, variant, time_control, rating, rd, volatility)
     values ('00000000-0000-0000-0000-000000000001', 'standard', 'blitz', 1500, 350, 0.06),
            ('00000000-0000-0000-0000-000000000001', 'chess960', 'blitz', 1500, 350, 0.06)`
  );
});
// …but duplicates within one variant are rejected.
await expectRejects(
  "ratings: duplicate (user, variant, TC) rejected",
  `insert into ratings (user_id, variant, time_control, rating, rd, volatility)
   values ('00000000-0000-0000-0000-000000000001', 'standard', 'blitz', 1600, 100, 0.06)`
);

// relationships: self-relationship blocked by check constraint.
await expectRejects(
  "relationships: self-block rejected",
  `insert into relationships (user_id, target_user_id, kind)
   values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'block')`
);

// usage_counters composite PK (userId, month, model) with token/micros fields (B0.4).
await expect("usage_counters per-model key upserts", async () => {
  for (let i = 0; i < 2; i++) {
    await db.exec(
      `insert into usage_counters (user_id, month, model, llm_calls, llm_input_tokens, llm_output_tokens, llm_cost_micros)
       values ('00000000-0000-0000-0000-000000000001', '2026-08-01', 'claude-sonnet-4-6', 1, 1200, 80, 4740)
       on conflict (user_id, month, model) do update
         set llm_calls = usage_counters.llm_calls + 1,
             llm_input_tokens = usage_counters.llm_input_tokens + excluded.llm_input_tokens,
             llm_output_tokens = usage_counters.llm_output_tokens + excluded.llm_output_tokens,
             llm_cost_micros = usage_counters.llm_cost_micros + excluded.llm_cost_micros`
    );
  }
  await db.exec(
    `insert into usage_counters (user_id, month, imports_run) values ('00000000-0000-0000-0000-000000000001', '2026-08-01', 1)
     on conflict (user_id, month, model) do update set imports_run = usage_counters.imports_run + 1`
  );
  const llm = await db.query(
    `select llm_calls, llm_cost_micros from usage_counters where user_id = '00000000-0000-0000-0000-000000000001' and model = 'claude-sonnet-4-6'`
  );
  if (llm.rows[0].llm_calls !== 2 || Number(llm.rows[0].llm_cost_micros) !== 9480) {
    throw new Error("per-model upsert did not accumulate");
  }
  const none = await db.query(
    `select imports_run from usage_counters where user_id = '00000000-0000-0000-0000-000000000001' and model = 'none'`
  );
  if (none.rows[0].imports_run !== 1) throw new Error("non-LLM counter row missing");
});

// A2.4: hard-delete cascade — the FK graph must actually let a user row go.
await expect("user hard-delete cascades; audit_log survives with null user", async () => {
  await db.exec(
    `insert into audit_log (user_id, action) values ('00000000-0000-0000-0000-000000000001', 'account.delete')`
  );
  await db.exec(`delete from users where id = '00000000-0000-0000-0000-000000000001'`);
  const games = await db.query(`select count(*)::int as n from games`);
  if (games.rows[0].n !== 0) throw new Error("games did not cascade");
  const audit = await db.query(`select user_id, action from audit_log`);
  if (audit.rows.length !== 1 || audit.rows[0].user_id !== null) {
    throw new Error("audit_log row should survive with user_id nulled");
  }
});

// A3.4: the openings seed pipeline works against the migrated schema.
await expect("openings seed loads and matches the Ruy Lopez", async () => {
  const entries = JSON.parse(
    await readFile(path.resolve("src/db/seed/openings.json"), "utf8")
  );
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const values = [];
    const params = [];
    for (const [j, e] of batch.entries()) {
      const base = j * 5;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(e.fenKey, e.eco, e.name, e.pgn, e.ply);
    }
    await db.query(
      `insert into openings (fen_key, eco, name, pgn, ply) values ${values.join(",")}
       on conflict (fen_key) do nothing`,
      params
    );
  }
  const count = await db.query(`select count(*)::int as n from openings`);
  if (count.rows[0].n !== entries.length) {
    throw new Error(`expected ${entries.length} openings, table holds ${count.rows[0].n}`);
  }
  const ruy = await db.query(
    `select eco, name from openings where fen_key = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -'`
  );
  if (ruy.rows[0]?.eco !== "C60") throw new Error(`Ruy Lopez lookup failed: ${JSON.stringify(ruy.rows)}`);
});

console.log(`\nG5 PASS: ${journal.entries.length} migrations, ${statements} statements applied to an empty database, constraint probes green, openings seeded.`);
await db.close();
