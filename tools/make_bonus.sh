#!/bin/sh
# Fill pools in tools/library/ for the themed Bonus books (All White, All Black, Sparse).
# Safe to re-run: tools/generate.mjs appends and deduplicates by symmetry.
set -e
SEED=${SEED:-500}

echo "=== Generating Bonus: All White pools ==="
node tools/generate.mjs --size 6x6 --count 34 --seed $((SEED + 1)) --style white --prefix white_6x6 --out tools/library/white_6x6.csv --budget 60
node tools/generate.mjs --size 8x8 --count 34 --seed $((SEED + 2)) --style white --prefix white_8x8 --out tools/library/white_8x8.csv --budget 90

echo "=== Generating Bonus: All Black pools ==="
node tools/generate.mjs --size 6x6 --count 34 --seed $((SEED + 3)) --style black --prefix black_6x6 --out tools/library/black_6x6.csv --budget 90
node tools/generate.mjs --size 8x8 --count 34 --seed $((SEED + 4)) --style black --prefix black_8x8 --out tools/library/black_8x8.csv --budget 120

echo "=== Generating Bonus: Sparse pools ==="
node tools/generate.mjs --size 8x8 --count 34 --seed $((SEED + 5)) --style sparse --prefix sparse_8x8 --out tools/library/sparse_8x8.csv --budget 90

echo "=== Generating Bonus: Skyscraper pools ==="
node tools/generate.mjs --size 5x14 --count 10 --seed $((SEED + 11)) --style balanced --prefix sky_5x14 --out tools/library/sky_5x14.csv --budget 45
node tools/generate.mjs --size 6x16 --count 10 --seed $((SEED + 12)) --style balanced --prefix sky_6x16 --out tools/library/sky_6x16.csv --budget 60
node tools/generate.mjs --size 6x20 --count 10 --seed $((SEED + 13)) --style balanced --prefix sky_6x20 --out tools/library/sky_6x20.csv --budget 90
