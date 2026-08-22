// Synthetic UCI engine for the §3.3 watchdog tests — mode: slowstop.
// wedge: starts a search, never answers, IGNORES stop (the 2.5h failure mode).
// slowstop: answers only when told to stop (soft breach path).
// fast: answers immediately (healthy path).
const MODE = "slowstop";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    handle(line);
  }
});
function out(s) { process.stdout.write(s + "\n"); }
let searching = false;
function handle(line) {
  if (line === "uci") { out("id name MockUCI-" + MODE); out("uciok"); return; }
  if (line === "isready") { out("readyok"); return; }
  if (line.startsWith("go")) {
    searching = true;
    out("info depth 8 multipv 1 score cp 30 nodes 1000 nps 1000 time 10 pv e2e4 e7e5");
    if (MODE === "fast") { out("info depth 18 multipv 1 score cp 25 nodes 9000 nps 9000 time 20 pv e2e4 e7e5"); out("bestmove e2e4"); searching = false; }
    return;
  }
  if (line === "stop") {
    if (MODE === "slowstop" && searching) { out("bestmove e2e4"); searching = false; }
    // wedge: ignore stop entirely.
    return;
  }
  if (line === "quit") process.exit(0);
}
