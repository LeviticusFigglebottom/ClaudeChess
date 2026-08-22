/**
 * Local stand-in for explorer.lichess.ovh (gate use only — the live host
 * refuses this container's egress with nginx 401). Serves the SAME response
 * shape with deterministic, realistic-looking frequencies derived from the
 * position itself: legal moves from chessops, weights from a stable hash,
 * totals in the thousands, decreasing by move rank. Clearly synthetic —
 * gate reports label every number that flowed through it.
 *
 *   node scripts/mock-explorer.mjs [port=4310]
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { makeSan } from "chessops/san";
import { makeUci } from "chessops/util";

const port = Number(process.argv[2] ?? 4310);

function movesFor(fen) {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const pos = Chess.fromSetup(setup.unwrap());
  if (pos.isErr) return null;
  const chess = pos.unwrap();
  const out = [];
  for (const [from, dests] of chess.allDests()) {
    for (const to of dests) {
      const move = { from, to };
      const san = makeSan(chess, move);
      out.push({ uci: makeUci(move), san });
    }
  }
  return out;
}

function weight(fen, uci, index) {
  const digest = createHash("sha256").update(`${fen}:${uci}`).digest();
  const base = (digest[0] * 256 + digest[1]) / 65535; // 0..1 stable
  // Concentrated like real opening stats: a few popular moves, a long tail.
  return Math.round(8000 * base ** 2 / (1 + index * 0.6)) + 25;
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const fen = url.searchParams.get("fen");
  const legal = fen ? movesFor(fen) : null;
  if (!legal) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "bad fen" }));
    return;
  }
  const moves = legal
    .map((move, index) => ({ ...move, total: weight(fen, move.uci, index) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 12)
    .map((move) => {
      const digest = createHash("sha256").update(`r:${fen}:${move.uci}`).digest();
      const whiteShare = 0.42 + (digest[2] / 255) * 0.16; // 42–58%
      const drawShare = 0.04 + (digest[3] / 255) * 0.08;
      const white = Math.round(move.total * whiteShare);
      const draws = Math.round(move.total * drawShare);
      return {
        uci: move.uci,
        san: move.san,
        white,
        draws,
        black: Math.max(0, move.total - white - draws),
        averageRating: 1500,
      };
    });
  const totals = moves.reduce(
    (sum, move) => ({
      white: sum.white + move.white,
      draws: sum.draws + move.draws,
      black: sum.black + move.black,
    }),
    { white: 0, draws: 0, black: 0 }
  );
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ...totals, moves, opening: null }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock explorer on http://127.0.0.1:${port} (synthetic data — gates only)`);
});
