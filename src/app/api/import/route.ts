import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError, isVerified } from "@/lib/account/types";
import { consumeUsage } from "@/lib/account/usage";
import {
  linkAccount,
  listLinkedAccounts,
  runImportChunk,
  setAutoImport,
  unlinkAccount,
  type ImportSource,
} from "@/lib/import/importer";

/**
 * Import (Phase 2, C1) — a user-facing product feature: each user connects
 * their own chess.com / Lichess handle. The A2.4 guard chain from Phase 1.5
 * stays exactly as it was (401 → 403 unverified → 429 capped); the 501 stub
 * tail is now the real chunked import body. One usage unit = one chunk.
 */

function parseSource(value: unknown): ImportSource {
  if (value !== "chesscom" && value !== "lichess") {
    throw new AccountError("bad_source", 'source must be "chesscom" or "lichess".');
  }
  return value;
}

export async function GET() {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    return NextResponse.json({ linked: await listLinkedAccounts(db, user.id) });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    if (!isVerified(user)) {
      throw new AccountError(
        "verified_required",
        "Game import requires a verified account (A2.1).",
        403
      );
    }
    const body = await readJson(request);
    switch (body.action) {
      case "link": {
        const source = parseSource(body.source);
        if (typeof body.username !== "string") {
          throw new AccountError("bad_action", "username required.");
        }
        const linked = await linkAccount(db, user.id, source, body.username);
        return NextResponse.json({ linked });
      }
      case "unlink": {
        await unlinkAccount(db, user.id, parseSource(body.source));
        return NextResponse.json({ ok: true });
      }
      case "auto": {
        await setAutoImport(db, user.id, parseSource(body.source), body.autoImport === true);
        return NextResponse.json({ ok: true });
      }
      case "run": {
        const source = parseSource(body.source);
        const decision = await consumeUsage(db, user, { kind: "importsRun", amount: 1 });
        if (!decision.allowed) {
          return NextResponse.json(
            {
              error: {
                code: "usage_capped",
                message: `Monthly import limit reached (${decision.used}/${decision.cap}).`,
              },
              usage: decision,
            },
            { status: 429 }
          );
        }
        const result = await runImportChunk(db, user, source, { maxGames: 25 });
        return NextResponse.json({ result, usage: decision });
      }
      default:
        throw new AccountError("bad_action", "Unknown action.");
    }
  });
}
