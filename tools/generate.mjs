#!/usr/bin/env node
// CLI puzzle generator: fills pool CSV files in tools/library/ (git-ignored).
// Every puzzle is independently re-checked (valid solution, unique by complete search, rated) before storing.
//
// Usage:
//   node tools/generate.mjs --size 8x8 --count 10 --seed 1 --budget 60 --style balanced --tier any --out tools/library/8x8.csv
//
// Note: --size is COLSxROWS (e.g. 6x10 = 6 cols, 10 rows).
import fs from 'node:fs';
import path from 'node:path';
import {
  compile, solve, isSolved, decodeSolution, encodeSolution,
  toCsvRow, parseCsv, CSV_HEADER, symmetryKey,
} from '../js/logic.js';
import { rate } from '../js/rating.js';
import { generatePuzzle, makeRng } from '../js/generator.js';

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const sizeStr = arg('size', '8x8');
const [cols, rows] = sizeStr.toLowerCase().split('x').map(Number);
if (!cols || !rows || cols < 4 || rows < 4) {
  console.error(`Invalid --size "${sizeStr}" (use COLSxROWS, each >= 4)`);
  process.exit(1);
}
const count = +arg('count', 10);
const seed = +arg('seed', 1);
const budgetSec = +arg('budget', 120);
const perPuzzleMs = +arg('per-puzzle-ms', 15000);
const style = arg('style', 'balanced'); // balanced | white | black | sparse
const layout = arg('layout', 'none');   // none | checkerboard | interior | frame | stripes | rot180 | mirror | transpose | rot90 | yinyang | lattice
const minFill = arg('min-fill', null) !== null ? +arg('min-fill') : null;
const tier = arg('tier', 'any');        // any | Beginner | Medium | Hard
const maxTier = arg('max-tier', 'Hard');
const keepFrac = arg('keep', null) !== null ? +arg('keep') : null;
const prefix = arg('prefix', `${layout !== 'none' ? layout : style}_${cols}x${rows}`);
const defaultOut = path.join('tools', 'library', `${prefix}.csv`);
const outPath = arg('out', defaultOut);

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const seen = new Set();
let existingCount = 0;
if (fs.existsSync(outPath)) {
  const existing = parseCsv(fs.readFileSync(outPath, 'utf8'));
  existingCount = existing.length;
  for (const p of existing) seen.add(symmetryKey(p));
} else {
  fs.writeFileSync(outPath, CSV_HEADER + '\n', 'utf8');
}

const rng = makeRng(seed);
const deadline = Date.now() + budgetSec * 1000;
let added = 0;
let seq = existingCount;
const tierCounts = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0 };

while (added < count && Date.now() < deadline) {
  const remMs = Math.min(perPuzzleMs, Math.max(500, deadline - Date.now()));
  const puzName = `${prefix}_${seed}_${seq + 1}`;
  const p = generatePuzzle({
    rows,
    cols,
    rng,
    style,
    layout,
    minFill,
    maxTier,
    targetTier: tier === 'any' ? null : tier,
    keepFrac,
    budgetMs: remMs,
    name: puzName,
  });
  if (!p) continue;

  // Deduplicate across dihedral symmetries
  const sk = symmetryKey(p);
  if (seen.has(sk)) continue;

  // Independent re-verification before storing (never trust the generator's own claim)
  const fresh = compile({ name: p.name, rows: p.rows, cols: p.cols, clues: p.clues });
  const dec = decodeSolution(fresh, p.solution);
  if (!isSolved(fresh, dec.e)) continue;
  const exact = solve(fresh, { limit: 2, maxNodes: 500000 });
  if (exact.exceeded || exact.count !== 1) continue;
  if (encodeSolution(fresh, exact.solutions[0]) !== p.solution) continue;
  const r = rate(fresh);
  if (!r.solved) continue;
  p.rules = r.rules;
  p.tier = r.tier;
  p.score = r.score;

  seen.add(sk);
  fs.appendFileSync(outPath, toCsvRow(p) + '\n', 'utf8');
  added++;
  seq++;
  tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1;
  process.stdout.write(`[${added}/${count}] ${p.name} (${p.clues.length} clues) -> ${p.tier} / ${p.rules} / ${p.score}\n`);
}

console.log(`Done: added ${added} puzzles to ${outPath} (tiers: B=${tierCounts.Beginner} M=${tierCounts.Medium} H=${tierCounts.Hard})`);
