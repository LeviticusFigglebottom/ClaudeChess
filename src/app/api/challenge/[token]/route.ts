import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { accountsConfigured, handleApi } from "@/lib/account/api";
import { getChallengeByToken, toChallengeView } from "@/lib/account/challenges";
import { AccountError } from "@/lib/account/types";

/**
 * GET /api/challenge/[token] — public view of an open challenge link, for
 * the accept page. No auth required to LOOK (the visitor may be brand new;
 * they get an anonymous session the moment they land anyway).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  return handleApi(async () => {
    if (!accountsConfigured()) {
      throw new AccountError("accounts_disabled", "Accounts are not configured.", 503);
    }
    const { token } = await params;
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) {
      throw new AccountError("challenge_missing", "No such challenge.", 404);
    }
    const challenge = await getChallengeByToken(getDb(), token);
    if (!challenge) throw new AccountError("challenge_missing", "No such challenge.", 404);
    return NextResponse.json({ challenge: await toChallengeView(getDb(), challenge) });
  });
}
