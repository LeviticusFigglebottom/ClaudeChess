#!/usr/bin/env bash
# Revised-mechanism probes: 20 games per band at spec-formula (pBlunder,
# temperature) priors under the REVISED policy (band-scaled MultiPV, scaled
# truth depth, widened window, pRandom floor). Reference at 400ms/move.
# Output feeds candidate-availability reporting and the strength map.
set -uo pipefail
cd "$(dirname "$0")/.."
run() {
  band=$1; anchor=$2
  echo "=== revised probe band $band vs SF@$anchor ==="
  npx tsx scripts/arena.mts --bot "$band" --opponent-elo "$anchor" \
    --games "${PROBE_GAMES:-20}" --concurrency "${PROBE_CONCURRENCY:-4}" \
    --seed "$((band + 300))" --ref-movetime 400 \
    --out "data/calibration/rev-$band.jsonl"
}
run 600 1320
run 800 1320
run 1000 1320
run 1200 1320
run 1400 1400
run 1600 1600
run 1800 1800
run 2000 2000
run 2200 2200
echo "revised probes complete"
