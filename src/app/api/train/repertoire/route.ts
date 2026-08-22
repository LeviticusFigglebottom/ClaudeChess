import { NextResponse } from "next/server";
import { handleApi, readJson, requireUser } from "@/lib/account/api";
import { AccountError } from "@/lib/account/types";
import {
  buildRepertoireTree,
  computeLeaks,
  dueDrills,
  recordDrill,
  toLearnList,
} from "@/lib/train";

/**
 * §9.4 — GET the ranked to-learn list + due drills; POST
 * {action: build | leaks | drill}. Standard-only by construction (A1.2).
 */
export async function GET(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const url = new URL(request.url);
    const color = url.searchParams.get("color") === "black" ? "black" : "white";
    const [toLearn, due] = await Promise.all([
      toLearnList(db, user.id, color),
      dueDrills(db, user.id, color),
    ]);
    return NextResponse.json({ toLearn, due });
  });
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const { db, user } = await requireUser();
    const body = await readJson(request);
    const color = body.color === "black" ? "black" : "white";
    switch (body.action) {
      case "build":
        return NextResponse.json({ build: await buildRepertoireTree(db, user.id, color) });
      case "leaks":
        return NextResponse.json({ leaks: await computeLeaks(db, user.id, color) });
      case "drill": {
        const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
        const quality = Number(body.quality);
        if (!nodeId) throw new AccountError("bad_node", "nodeId required.");
        return NextResponse.json(await recordDrill(db, user.id, nodeId, quality));
      }
      default:
        throw new AccountError("bad_action", "Unknown action.");
    }
  });
}
