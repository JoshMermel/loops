#!/bin/sh
# Fill pools in tools/library/ for the Gentle Intro and Default books (6x6, 8x8, 10x10, 12x12).
# Safe to re-run: tools/generate.mjs appends and deduplicates by symmetry.
set -e
SEED=${SEED:-100}

echo "=== Generating Intro pools (5x5 and 6x6 Beginner) ==="
node tools/generate.mjs --size 5x5 --count 18 --seed $((SEED + 1)) --tier Beginner --prefix intro_5x5 --out tools/library/intro_5x5.csv --budget 45
node tools/generate.mjs --size 6x6 --count 18 --seed $((SEED + 2)) --tier Beginner --prefix intro_6x6 --out tools/library/intro_6x6.csv --budget 45

for SIZE in 6x6 8x8 10x10 12x12; do
  echo "=== Generating Default $SIZE pools (Beginner / Medium / Hard) ==="
  PER=18
  BUD=60
  if [ "$SIZE" = "12x12" ]; then PER=14; BUD=120; fi
  node tools/generate.mjs --size "$SIZE" --count "$PER" --seed $((SEED + 10)) --tier Beginner --prefix "balanced_${SIZE}" --out "tools/library/balanced_${SIZE}.csv" --budget "$BUD"
  node tools/generate.mjs --size "$SIZE" --count "$PER" --seed $((SEED + 20)) --tier Medium   --prefix "balanced_${SIZE}" --out "tools/library/balanced_${SIZE}.csv" --budget "$BUD"
  node tools/generate.mjs --size "$SIZE" --count "$PER" --seed $((SEED + 30)) --tier Hard     --prefix "balanced_${SIZE}" --out "tools/library/balanced_${SIZE}.csv" --budget "$BUD"
done
