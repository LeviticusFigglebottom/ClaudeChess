/**
 * Node CLI shell for the vendored Fairy-Stockfish WASM build: stdin lines →
 * engine, engine output → stdout. Reads the wasm via fs (the emscripten
 * loader's fetch path breaks on file paths under modern Node).
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const Stockfish = require("./stockfish.js");

async function main() {
  const engine = await Stockfish({
    wasmBinary: fs.readFileSync(path.join(__dirname, "stockfish.wasm")),
    locateFile: (file) => path.join(__dirname, file),
  });
  engine.addMessageListener((line) => process.stdout.write(`${line}\n`));
  const iface = readline.createInterface({ input: process.stdin });
  for await (const command of iface) {
    if (command === "quit") break;
    engine.postMessage(command);
  }
  engine.postMessage("quit");
}

main();
