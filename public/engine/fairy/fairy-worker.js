/**
 * Browser worker bootstrap for the vendored Fairy-Stockfish WASM build
 * (Phase 4.5). The vanilla Stockfish scripts ARE workers; this build is an
 * emscripten factory, so this shim gives it the same contract the engine
 * client expects: raw UCI lines in via postMessage, raw lines out.
 * Commands arriving before the wasm is ready are queued, never dropped.
 */
/* global Stockfish */
let engine = null;
const queue = [];
self.onmessage = (event) => {
  if (engine) engine.postMessage(event.data);
  else queue.push(event.data);
};
importScripts("stockfish.js");
Stockfish().then((sf) => {
  sf.addMessageListener((line) => self.postMessage(line));
  engine = sf;
  for (const command of queue) sf.postMessage(command);
});
