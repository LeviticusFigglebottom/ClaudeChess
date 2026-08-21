/**
 * Prints the gate-G2 evidence table: perft(4) node counts for SP518 plus the
 * five pinned random Scharnagl positions, from BOTH implementations —
 * chessops (rules facade) and Stockfish 18 (`go perft`, UCI_Chess960) — on
 * identical FENs, for the start position and a castle-ready reduction
 * (back ranks stripped to king + rooks so castling is inside the tree).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { perft } from "chessops/debug";

const SPS = [518, 266, 642, 144, 636, 773];

// --- Scharnagl (mirror of src/lib/chess/chess960.ts, kept dependency-free) ---
const LIGHT = [1, 3, 5, 7];
const DARK = [0, 2, 4, 6];
const PAIRS = [[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]];
function backRank(n) {
  const rank = Array(8).fill(null);
  rank[LIGHT[n % 4]] = "b";
  let m = Math.floor(n / 4);
  rank[DARK[m % 4]] = "b";
  m = Math.floor(m / 4);
  const free1 = rank.flatMap((p, i) => (p === null ? [i] : []));
  rank[free1[m % 6]] = "q";
  m = Math.floor(m / 6);
  const free2 = rank.flatMap((p, i) => (p === null ? [i] : []));
  rank[free2[PAIRS[m][0]]] = "n";
  rank[free2[PAIRS[m][1]]] = "n";
  const rest = rank.flatMap((p, i) => (p === null ? [i] : []));
  rank[rest[0]] = "r";
  rank[rest[1]] = "k";
  rank[rest[2]] = "r";
  return rank.join("");
}
function castlingField(rankStr) {
  const rooks = [...rankStr].flatMap((p, i) => (p === "r" ? [i] : []));
  const f = "abcdefgh";
  return f[rooks[1]].toUpperCase() + f[rooks[0]].toUpperCase() + f[rooks[1]] + f[rooks[0]];
}
function startFen(sp) {
  const rank = backRank(sp);
  return `${rank}/pppppppp/8/8/8/8/PPPPPPPP/${rank.toUpperCase()} w ${castlingField(rank)} - 0 1`;
}
function castleReadyFen(sp) {
  const rank = backRank(sp);
  let fenRank = "";
  let run = 0;
  for (const p of rank) {
    if (p === "r" || p === "k") {
      if (run) fenRank += run;
      fenRank += p;
      run = 0;
    } else run++;
  }
  if (run) fenRank += run;
  return `${fenRank}/pppppppp/8/8/8/8/PPPPPPPP/${fenRank.toUpperCase()} w ${castlingField(rank)} - 0 1`;
}

// --- Stockfish child process ---
const enginePath = path.resolve("public/engine/stockfish-18-lite-single.js");
const child = spawn(process.execPath, [enginePath]);
child.stdout.setEncoding("utf8");
let buffer = "";
const listeners = new Set();
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    for (const l of [...listeners]) l(line);
  }
});
const send = (cmd) => child.stdin.write(cmd + "\n");
const waitFor = (pred) =>
  new Promise((resolve) => {
    const l = (line) => {
      if (pred(line)) {
        listeners.delete(l);
        resolve(line);
      }
    };
    listeners.add(l);
  });

const uciok = waitFor((l) => l === "uciok");
send("uci");
await uciok;
send("setoption name UCI_Chess960 value true");

async function sfPerft(fen, depth) {
  const result = waitFor((l) => l.startsWith("Nodes searched:"));
  send(`position fen ${fen}`);
  send(`go perft ${depth}`);
  return Number((await result).split(":")[1].trim());
}

function opsPerft(fen, depth) {
  const setup = parseFen(fen).unwrap();
  const pos = Chess.fromSetup(setup).unwrap();
  return perft(pos, depth);
}

console.log("SP    | kind         | chessops perft(4) | stockfish perft(4) | agree");
console.log("------|--------------|-------------------|--------------------|------");
for (const sp of SPS) {
  for (const [kind, fen] of [
    ["start", startFen(sp)],
    ["castle-ready", castleReadyFen(sp)],
  ]) {
    const ops = opsPerft(fen, 4);
    const sf = await sfPerft(fen, 4);
    console.log(
      `${String(sp).padEnd(5)} | ${kind.padEnd(12)} | ${String(ops).padStart(17)} | ${String(sf).padStart(18)} | ${ops === sf ? "yes" : "NO"}`
    );
  }
}
send("quit");
child.kill();
process.exit(0);
