import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { llmCache } from "@/db/schema";
import type { Db } from "@/lib/account/types";

/**
 * Server-side LLM access (spec §2 stack row: Anthropic API, model pinned by
 * the spec, key never client-side; §10 cross-cutting rules: JSON-only
 * instruction plus defensive fence-stripping, aggressive caching).
 *
 * C0 boundary: every call site feeds the model either natural-language
 * INPUT (§9.5 post-mortem prose) or asks for prose OUTPUT over evidence
 * already proven by code (§9.2 explanations). The model is never asked to
 * decide what happened on the board.
 */

export const LLM_MODEL = process.env.GAMBIT_LLM_MODEL ?? "claude-sonnet-4-6";

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function evidenceHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

export class LlmUnavailableError extends Error {
  constructor() {
    super("LLM is not configured on this deployment (ANTHROPIC_API_KEY).");
  }
}

interface CallOpts {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Raw completion (no cache). Throws LlmUnavailableError without a key. */
async function complete(opts: CallOpts): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmUnavailableError();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: opts.maxTokens ?? 700,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM call failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    content: { type: string; text?: string }[];
  };
  return payload.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** §10: strip markdown fences defensively before JSON.parse. */
export function parseJsonResponse<T>(raw: string): T {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("LLM response contained no JSON object");
  return JSON.parse(stripped.slice(start, end + 1)) as T;
}

/**
 * Cache-first JSON call: `key` must deterministically encode every input
 * that could change the answer ((motifChain, evidenceHash) for
 * explanations; (fen, san, reasoning-hash) for coach verdicts).
 */
export async function cachedJsonCall<T extends Record<string, unknown>>(
  db: Db,
  kind: string,
  key: string,
  opts: CallOpts,
  validate: (value: unknown) => T
): Promise<{ value: T; cached: boolean }> {
  const fullKey = `${kind}:${key}`;
  const hit = (await db.select().from(llmCache).where(eq(llmCache.key, fullKey)))[0];
  if (hit) return { value: validate(hit.payload), cached: true };
  const raw = await complete(opts);
  const value = validate(parseJsonResponse<unknown>(raw));
  await db
    .insert(llmCache)
    .values({ key: fullKey, kind, payload: value, model: LLM_MODEL })
    .onConflictDoNothing();
  return { value, cached: false };
}
