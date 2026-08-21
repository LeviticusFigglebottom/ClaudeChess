#!/usr/bin/env bash
# Calibration probe round: 30 games per direct-anchor band at spec-formula
# params, vs reference Stockfish at the nearest legal UCI_Elo (min 1320).
# Output feeds the inverse-curve fit that sets the final per-band params.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/calibration

run() {
  band=$1; anchor=$2
  echo "=== probe band $band vs SF@$anchor ==="
  npx tsx scripts/arena.mts --bot "$band" --opponent-elo "$anchor" \
    --games "${PROBE_GAMES:-30}" --concurrency "${PROBE_CONCURRENCY:-3}" --seed "$band" \
    --out "data/calibration/probe-$band.jsonl"
}

run 2200 2200
run 2000 2000
run 1800 1800
run 1600 1600
run 1400 1400
run 1200 1320
run 1000 1320
echo "probe round complete"
