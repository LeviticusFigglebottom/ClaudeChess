import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./test-db";
import type { AuthShape, UserRow } from "./types";
import { ensureUser } from "./users";
import {
  USAGE_CAPS,
  capsForUser,
  checkUsage,
  consumeUsage,
  getUsageSummary,
  monthKey,
} from "./usage";

/**
 * Phase 1.5 gate tests: rate limits enforced against usage_counters (A2.4).
 * Anonymous users get zero on every server-metered resource; caps bind
 * atomically; denials never book usage; months roll over cleanly.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t.close();
});

async function makeAnon(): Promise<UserRow> {
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: true,
    email: null,
    emailConfirmedAt: null,
  };
  return (await ensureUser(t.db, auth)).user;
}

async function makeVerified(tier: "free" | "plus" = "free"): Promise<UserRow> {
  const auth: AuthShape = {
    id: randomUUID(),
    isAnonymous: false,
    email: `${randomUUID()}@example.com`,
    emailConfirmedAt: new Date().toISOString(),
  };
  const { user } = await ensureUser(t.db, auth);
  if (tier === "plus") {
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const updated = await t.db
      .update(users)
      .set({ tier: "plus" })
      .where(eq(users.id, user.id))
      .returning();
    return updated[0]!;
  }
  return user;
}

const AUG = new Date("2026-08-21T12:00:00Z");

describe("caps", () => {
  it("anonymous accounts get zero on every server-metered resource (A2.1)", async () => {
    const anon = await makeAnon();
    expect(capsForUser(anon)).toEqual(USAGE_CAPS.anonymous);
    const denied = await consumeUsage(t.db, anon, { kind: "llmCalls", amount: 1 }, AUG);
    expect(denied.allowed).toBe(false);
    expect(denied.cap).toBe(0);
    const deniedImport = await consumeUsage(t.db, anon, { kind: "importsRun", amount: 1 }, AUG);
    expect(deniedImport.allowed).toBe(false);
  });

  it("an unverified permanent account is still capped at zero", async () => {
    const auth: AuthShape = {
      id: randomUUID(),
      isAnonymous: false,
      email: "unverified@example.com",
      emailConfirmedAt: null,
    };
    const { user } = await ensureUser(t.db, auth);
    expect(capsForUser(user)).toEqual(USAGE_CAPS.anonymous);
  });

  it("tier caps: plus > free", async () => {
    const free = await makeVerified("free");
    const plus = await makeVerified("plus");
    expect(capsForUser(free)).toEqual(USAGE_CAPS.free);
    expect(capsForUser(plus)).toEqual(USAGE_CAPS.plus);
    expect(USAGE_CAPS.plus.llmCalls).toBeGreaterThan(USAGE_CAPS.free.llmCalls);
  });
});

describe("GATE: enforcement", () => {
  it("binds exactly at the cap and books nothing on denial", async () => {
    const user = await makeVerified();
    const cap = USAGE_CAPS.free.importsRun;

    const bulk = await consumeUsage(t.db, user, { kind: "importsRun", amount: cap - 1 }, AUG);
    expect(bulk.allowed).toBe(true);
    const last = await consumeUsage(t.db, user, { kind: "importsRun", amount: 1 }, AUG);
    expect(last.allowed).toBe(true);
    expect(last.used).toBe(cap - 1);

    const over = await consumeUsage(t.db, user, { kind: "importsRun", amount: 1 }, AUG);
    expect(over.allowed).toBe(false);
    expect(over.used).toBe(cap);
    expect(over.remaining).toBe(0);

    // Denial booked nothing: totals unchanged.
    const summary = await getUsageSummary(t.db, user, AUG);
    expect(summary.totals.importsRun).toBe(cap);
  });

  it("kinds are independent: exhausting imports leaves LLM calls intact", async () => {
    const user = await makeVerified();
    await consumeUsage(
      t.db,
      user,
      { kind: "importsRun", amount: USAGE_CAPS.free.importsRun },
      AUG
    );
    const llm = await consumeUsage(
      t.db,
      user,
      { kind: "llmCalls", amount: 1, model: "claude-sonnet-4-6" },
      AUG
    );
    expect(llm.allowed).toBe(true);
  });

  it("the cost ceiling binds independently of the call count (B0.4)", async () => {
    const user = await makeVerified();
    const costCap = USAGE_CAPS.free.llmCostMicros;
    const nearlyAll = await consumeUsage(
      t.db,
      user,
      {
        kind: "llmCalls",
        amount: 1,
        model: "claude-sonnet-4-6",
        inputTokens: 100_000,
        outputTokens: 50_000,
        costMicros: costCap - 100,
      },
      AUG
    );
    expect(nearlyAll.allowed).toBe(true);

    const overCost = await consumeUsage(
      t.db,
      user,
      { kind: "llmCalls", amount: 1, model: "claude-sonnet-4-6", costMicros: 200 },
      AUG
    );
    expect(overCost.allowed).toBe(false);
    expect(overCost.costLimited).toBe(true);

    // Still under the CALL cap — a costless call passes.
    const costless = await consumeUsage(
      t.db,
      user,
      { kind: "llmCalls", amount: 1, model: "claude-sonnet-4-6", costMicros: 0 },
      AUG
    );
    expect(costless.allowed).toBe(true);
  });

  it("caps sum across per-model rows", async () => {
    const user = await makeVerified();
    const cap = USAGE_CAPS.free.llmCalls;
    await consumeUsage(
      t.db,
      user,
      { kind: "llmCalls", amount: cap - 1, model: "claude-sonnet-4-6" },
      AUG
    );
    await consumeUsage(t.db, user, { kind: "llmCalls", amount: 1, model: "claude-haiku-4-5" }, AUG);
    const over = await consumeUsage(
      t.db,
      user,
      { kind: "llmCalls", amount: 1, model: "claude-haiku-4-5" },
      AUG
    );
    expect(over.allowed).toBe(false);

    const summary = await getUsageSummary(t.db, user, AUG);
    expect(summary.totals.llmCalls).toBe(cap);
    expect(summary.byModel.map((row) => row.model).sort()).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
    ]);
  });

  it("months roll over: September starts fresh, August stays booked", async () => {
    const user = await makeVerified();
    await consumeUsage(
      t.db,
      user,
      { kind: "importsRun", amount: USAGE_CAPS.free.importsRun },
      AUG
    );
    const sep = new Date("2026-09-02T09:00:00Z");
    const fresh = await checkUsage(t.db, user, { kind: "importsRun", amount: 1 }, sep);
    expect(fresh.allowed).toBe(true);
    expect(fresh.used).toBe(0);
    const augSummary = await getUsageSummary(t.db, user, AUG);
    expect(augSummary.totals.importsRun).toBe(USAGE_CAPS.free.importsRun);
    expect(monthKey(sep)).toBe("2026-09-01");
  });

  it("checkUsage never books", async () => {
    const user = await makeVerified();
    await checkUsage(t.db, user, { kind: "llmCalls", amount: 5, model: "m" }, AUG);
    const summary = await getUsageSummary(t.db, user, AUG);
    expect(summary.totals.llmCalls).toBe(0);
  });

  it("concurrent consumption near the cap never overshoots (advisory lock)", async () => {
    const user = await makeVerified();
    const cap = USAGE_CAPS.free.importsRun;
    await consumeUsage(t.db, user, { kind: "importsRun", amount: cap - 1 }, AUG);
    const race = await Promise.all([
      consumeUsage(t.db, user, { kind: "importsRun", amount: 1 }, AUG),
      consumeUsage(t.db, user, { kind: "importsRun", amount: 1 }, AUG),
      consumeUsage(t.db, user, { kind: "importsRun", amount: 1 }, AUG),
    ]);
    expect(race.filter((decision) => decision.allowed)).toHaveLength(1);
    const summary = await getUsageSummary(t.db, user, AUG);
    expect(summary.totals.importsRun).toBe(cap);
  });
});
