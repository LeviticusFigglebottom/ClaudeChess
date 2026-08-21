import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

/**
 * Node-side driver for the vendored single-threaded Stockfish build.
 *
 * TEST/TOOLING ONLY — never import from app code. It lives inside
 * src/lib/engine so the "UCI never escapes this module" invariant holds for
 * tooling too. Used by the Phase 0.5 G2 gate to cross-check chessops' perft
 * against Stockfish's own `go perft` on identical FENs.
 *
 * The engine runs as a child process in its CLI mode (stdin/stdout UCI) —
 * the emscripten wrapper sniffs its host environment and behaves differently
 * under worker threads, so in-process loading is a trap; a child process is
 * boring and immune.
 */
export class NodeEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private listeners = new Set<(line: string) => void>();
  private buffer = "";

  async init(opts: { chess960: boolean }): Promise<void> {
    const enginePath = path.resolve(
      process.cwd(),
      "public",
      "engine",
      "stockfish-18-lite-single.js"
    );
    this.child = spawn(process.execPath, [enginePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        for (const listener of [...this.listeners]) listener(line);
      }
    });

    const ready = this.waitFor((line) => line === "uciok");
    this.send("uci");
    await ready;
    if (opts.chess960) this.send("setoption name UCI_Chess960 value true");
    const readyOk = this.waitFor((line) => line === "readyok");
    this.send("isready");
    await readyOk;
  }

  /** Runs `go perft` and returns the node count Stockfish reports. */
  async perft(fen: string, depth: number): Promise<number> {
    const result = this.waitFor((line) => line.startsWith("Nodes searched:"));
    this.send(`position fen ${fen}`);
    this.send(`go perft ${depth}`);
    const line = await result;
    return Number(line.split(":")[1]?.trim());
  }

  quit(): void {
    if (!this.child) return;
    this.send("quit");
    this.child.kill();
    this.child = null;
  }

  private send(command: string): void {
    if (!this.child) throw new Error("node engine not initialized");
    this.child.stdin.write(command + "\n");
  }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const listener = (line: string) => {
        if (predicate(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }
}
