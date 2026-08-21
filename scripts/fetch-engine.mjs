/**
 * Fetches the Stockfish WASM builds into /public/engine (gitignored).
 *
 * Why not an npm dependency: the `stockfish` package tarball is ~250MB
 * because it bundles the full-net builds (113MB each). We only need the
 * lite-NNUE multithreaded build plus a single-threaded fallback (~14.5MB
 * total), so we pull exactly those files from the npm CDN and pin their
 * sha256 hashes.
 *
 * Runs on postinstall (Vercel builds included). No-ops when files already
 * exist with matching hashes. Falls back to `curl` when Node's fetch cannot
 * reach the network directly (e.g. proxied sandboxes where curl honors
 * HTTPS_PROXY but undici does not).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "18.0.8";
const BASE = `https://unpkg.com/stockfish@${VERSION}/bin`;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "engine");

const FILES = [
  {
    name: "stockfish-18-lite.js",
    sha256: "6e64f417a642c2f2a27d33c09f069522366d1bc33ed7ee8712afcc347e109af4",
  },
  {
    name: "stockfish-18-lite.wasm",
    sha256: "d50136919dcd90e75eb8df78b255d47d618962b670028b38961343f6eb409174",
  },
  {
    name: "stockfish-18-lite-single.js",
    sha256: "5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391",
  },
  {
    name: "stockfish-18-lite-single.wasm",
    sha256: "a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1",
  },
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download(url, dest) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return;
  } catch (err) {
    // Proxied environments: curl honors HTTPS_PROXY/CA bundle where undici may not.
    execFileSync("curl", ["-sSL", "--fail", "-o", dest, url], { stdio: "pipe" });
  }
}

mkdirSync(OUT_DIR, { recursive: true });

let fetched = 0;
for (const file of FILES) {
  const dest = join(OUT_DIR, file.name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === file.sha256) continue;

  const url = `${BASE}/${file.name}`;
  process.stdout.write(`engine: fetching ${file.name} ... `);
  await download(url, dest);
  const actual = sha256(readFileSync(dest));
  if (actual !== file.sha256) {
    console.error(`\nengine: hash mismatch for ${file.name}\n  expected ${file.sha256}\n  actual   ${actual}`);
    process.exit(1);
  }
  console.log("ok");
  fetched++;
}

console.log(
  fetched === 0
    ? "engine: all files present, hashes verified"
    : `engine: fetched ${fetched} file(s) into public/engine`
);
