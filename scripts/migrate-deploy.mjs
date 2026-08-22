/**
 * Migrate-on-deploy (Vercel build step). The remote dev container cannot
 * speak the postgres wire protocol out (HTTPS-only egress), so the build
 * environment — which holds DATABASE_URL and has open egress — is the one
 * sanctioned place migrations run for the hosted deployment.
 *
 * Runs ONLY when Vercel says so (VERCEL=1) and DATABASE_URL is present:
 * local `npm run build` is unaffected. Applies the drizzle journal in order
 * (idempotent — already-applied entries are skipped) and then the openings
 * seed (idempotent upsert). A migration failure fails the build: never ship
 * code whose schema didn't land.
 *
 * Caveat, documented in docs/DEPLOYMENT.md: preview builds sharing the
 * production DATABASE_URL will also apply migrations. With a single
 * deploying branch that is the desired behavior; revisit if preview
 * branches ever carry divergent schema.
 */
import { spawnSync } from "node:child_process";

if (process.env.VERCEL !== "1" || !process.env.DATABASE_URL) {
  console.log("migrate-deploy: not a Vercel build with DATABASE_URL — skipping");
  process.exit(0);
}

const run = (label, cmd, args) => {
  console.log(`migrate-deploy: ${label}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    console.error(`migrate-deploy: ${label} FAILED (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
};

run("drizzle-kit migrate (journal order)", "npx", ["drizzle-kit", "migrate"]);
run("openings seed (idempotent upsert)", "node", ["scripts/seed-openings.mjs"]);
run("explorer aggregate seed (idempotent upsert)", "node", ["scripts/seed-explorer-agg.mjs"]);
run("global eval-cache seed (idempotent upsert)", "node", ["scripts/seed-eval-cache.mjs"]);
console.log("migrate-deploy: done");
