#!/usr/bin/env bash
# Focused probe order: the informative measurements first. Round-1 showed the
# formula family sweeping same-nominal anchors at the top; the fit needs the
# low/mid mapping and the extended weak end (probe2 params) far more than
# more sweeps.
set -uo pipefail
cd "$(dirname "$0")/.."
run() {
  band=$1; anchor=$2; extra=${3:-}
  echo "=== probe band $band vs SF@$anchor ==="
  npx tsx scripts/arena.mts --bot "$band" --opponent-elo "$anchor" \
    --games "${PROBE_GAMES:-30}" --concurrency "${PROBE_CONCURRENCY:-3}" --seed "$((band + 100))" \
    $extra --out "data/calibration/probe-$band.jsonl"
}
run 1000 1320
run 1200 1320
run 1400 1400
run 300 1320 "--params-file data/calibration/probe2-params.json"
run -100 1320 "--params-file data/calibration/probe2-params.json"
run 1600 1600
run 1800 1800
echo "focused probes complete"
