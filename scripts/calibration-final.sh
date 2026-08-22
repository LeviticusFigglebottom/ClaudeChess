#!/usr/bin/env bash
# Final calibration runs (Phase 1 gate, signed-off sizing = ladder Plan B):
# games per band at the fitted params (data/calibration/proposed-params.json),
# reference movetime 400ms.
#
#   bash scripts/calibration-final.sh 2200 2000      # bands as args
#
# Direct bands play SF at their UCI_Elo anchor. 1000/1200/1400 all anchor on
# SF@1320 — the 1320 floor for the first two, and for 1400 because the ruler
# audit measured the 1400 label ~160 Elo weak (data/calibration/ruler-checks
# .txt). Ladder: 800 plays 150 vs bot-1000 + 50 vs SF@1320; 600 plays 150 vs
# bot-800 (bot-vs-bot costs ~2x — both sides search). Sizing (option A,
# signed off 2026-08-22): the gate minimum of 150 games per measured band —
# Plan B's 250-game links were premised on a 6-way session fan-out that the
# spawn-service outage killed. Every run resumes from its shard's line count,
# so the 20-game validation probes are literally the first 20 finals games.
set -uo pipefail
cd "$(dirname "$0")/.."
CONC="${FINAL_CONCURRENCY:-4}"
PARAMS="data/calibration/proposed-params.json"

arena() {
  npx tsx scripts/arena.mts --params-file "$PARAMS" --ref-movetime 400 \
    --concurrency "$CONC" "$@"
}

for band in "$@"; do
  echo "=== final band $band ==="
  case "$band" in
    2200|2000|1800)
      arena --bot "$band" --opponent-elo "$band" --games 150 --seed "$((band + 777))" \
        --out "data/calibration/final-$band.jsonl" ;;
    1600)
      arena --bot 1600 --opponent-elo 1600 --games 150 --seed 2377 \
        --out data/calibration/final-1600.jsonl ;;
    1400|1200|1000)
      arena --bot "$band" --opponent-elo 1320 --games 150 --seed "$((band + 777))" \
        --out "data/calibration/final-$band.jsonl" ;;
    800)
      # Two legs in SEPARATE files: appending both to one file would make the
      # arena's line-count resume silently shift the ladder/direct mix after
      # an interruption. calibrate-fit --finalize reads final-800*.jsonl.
      arena --bot 800 --opponent-bot 1000 --games 150 --seed 8777 \
        --out data/calibration/final-800-ladder.jsonl
      arena --bot 800 --opponent-elo 1320 --games 50 --seed 8778 \
        --out data/calibration/final-800-direct.jsonl ;;
    600)
      arena --bot 600 --opponent-bot 800 --games 150 --seed 6777 \
        --out data/calibration/final-600.jsonl ;;
    *)
      echo "unknown band $band"; exit 1 ;;
  esac
done
echo "finals complete for: $*"
