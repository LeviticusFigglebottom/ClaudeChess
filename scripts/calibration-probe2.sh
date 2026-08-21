#!/usr/bin/env bash
# Weak-end bracketing probes: the spec-formula family measured far above
# nominal at every band in round 1, so round 2 maps the EXTENDED family
# (temperatures beyond the formula clamp) against the UCI_Elo floor.
set -uo pipefail
cd "$(dirname "$0")/.."
for band in 300 -100 -500; do
  echo "=== probe2 formula-equivalent $band vs SF@1320 ==="
  npx tsx scripts/arena.mts --bot "$band" --opponent-elo 1320 \
    --games "${PROBE_GAMES:-30}" --concurrency "${PROBE_CONCURRENCY:-3}" --seed "$((band + 5000))" \
    --params-file data/calibration/probe2-params.json \
    --out "data/calibration/probe2-$band.jsonl"
done
echo "probe2 complete"
