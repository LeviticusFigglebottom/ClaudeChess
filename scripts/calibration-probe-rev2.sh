#!/usr/bin/env bash
# Re-probe after the shallow-pass amendment (12-ply gap, band-scaled shallow
# MultiPV): 20 games per band at formula priors, 400ms reference. These are
# the fit inputs — sweep-1 (rev-*.jsonl) measured the pinned-d6/MPV5 shallow
# and stands as the gap-hypothesis record only.
set -uo pipefail
cd "$(dirname "$0")/.."
run() {
  band=$1; anchor=$2
  echo "=== rev2 probe band $band vs SF@$anchor ==="
  npx tsx scripts/arena.mts --bot "$band" --opponent-elo "$anchor" \
    --games "${PROBE_GAMES:-20}" --concurrency "${PROBE_CONCURRENCY:-4}" \
    --seed "$((band + 600))" --ref-movetime 400 \
    --out "data/calibration/rev2-$band.jsonl"
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
echo "rev2 probes complete"
