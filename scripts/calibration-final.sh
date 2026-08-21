#!/usr/bin/env bash
# Final calibration runs (Phase 1 gate): >=200 games per band at the fitted
# params (data/calibration/proposed-params.json), reference movetime 400ms.
#
#   bash scripts/calibration-final.sh 2200 2000      # bands as args
#
# Direct bands (1000-2200) play SF at their UCI_Elo anchor (1320 floor for
# 1000/1200). Ladder bands: 800 plays 150 vs bot-1000 + 50 vs SF@1320;
# 600 plays 200 vs bot-800 (bot-vs-bot games cost ~2x — both sides search).
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
    2200|2000|1800|1600|1400)
      arena --bot "$band" --opponent-elo "$band" --games 200 --seed "$((band + 777))" \
        --out "data/calibration/final-$band.jsonl" ;;
    1200|1000)
      arena --bot "$band" --opponent-elo 1320 --games 200 --seed "$((band + 777))" \
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
      arena --bot 600 --opponent-bot 800 --games 200 --seed 6777 \
        --out data/calibration/final-600.jsonl ;;
    *)
      echo "unknown band $band"; exit 1 ;;
  esac
done
echo "finals complete for: $*"
