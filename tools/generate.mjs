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
import { toCsvRow, parseCsv, CSV_HEADER, symmetryKey } from '../js/logic.js';
import { generatePuzzle, makeRng } from '../js/generator.js';
import { TIERS } from '../js/rating.js';
import { arg, repoRoot, verifyPuzzle } from './_cli.mjs';

const sizeStr = arg('size', '8x8');
const sizeParts = sizeStr.toLowerCase().split('x');
const [cols, rows] = sizeParts.map(Number);
if (sizeParts.length !== 2 || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 4 || rows < 4) {
  console.error(`Invalid --size "${sizeStr}" (use COLSxROWS integers, each >= 4)`);
  process.exit(1);
}
const count = Math.trunc(+arg('count', 10));
const seed = Math.trunc(+arg('seed', 1));
const budgetSec = +arg('budget', 120);
const perPuzzleMs = +arg('per-puzzle-ms', 15000);
if (!Number.isFinite(count) || count < 1 || !Number.isFinite(seed) || !Number.isFinite(budgetSec) || budgetSec <= 0 || !Number.isFinite(perPuzzleMs) || perPuzzleMs <= 0) {
  console.error('Invalid numeric flag (--count, --seed, --budget, --per-puzzle-ms must be valid positive numbers)');
  process.exit(1);
}
const VALID_STYLES = new Set([
  'balanced', 'white', 'black', 'sparse', 'gray-mixed', 'gray-all',
  'full-masyu', 'full-lines', 'full-walls', 'full-mixed', 'full-swiss',
  'shaped', 'swiss-cheese', 'slither', 'slither-swiss', 'slither-all3', 'slither-all2-full', 'slither-masyu', 'slither-full',
]);
const style = arg('style', 'balanced');
if (!VALID_STYLES.has(style)) {
  console.error(`Invalid --style "${style}" (valid: ${[...VALID_STYLES].join(', ')})`);
  process.exit(1);
}
const layout = arg('layout', 'none');   // none | checkerboard | interior | frame | stripes | rot180 | mirror | transpose | rot90 | yinyang | yinyang-mirror | yinyang-transpose | cookie | cookie-horiz | cookie-diag | cookie-angle | cookie:<deg> | lattice
const minFill = arg('min-fill', null) !== null ? +arg('min-fill') : null;
if (minFill !== null && (!Number.isFinite(minFill) || minFill <= 0 || minFill > 1)) {
  console.error(`Invalid --min-fill "${arg('min-fill')}" (must be in (0, 1])`);
  process.exit(1);
}
const tier = arg('tier', 'any');        // any | Beginner | Medium | Hard | Expert | Expert+
const maxTier = arg('max-tier', 'Expert');
const validTiers = new Set(['any', ...TIERS, 'Expert+']);
if (!validTiers.has(tier)) {
  console.error(`Invalid --tier "${tier}" (valid: ${[...validTiers].join(', ')})`);
  process.exit(1);
}
if (!TIERS.includes(maxTier)) {
  console.error(`Invalid --max-tier "${maxTier}" (valid: ${TIERS.join(', ')})`);
  process.exit(1);
}
const keepFrac = arg('keep', null) !== null ? +arg('keep') : null;
if (keepFrac !== null && (!Number.isFinite(keepFrac) || keepFrac < 0 || keepFrac > 1)) {
  console.error(`Invalid --keep "${arg('keep')}" (must be in [0, 1])`);
  process.exit(1);
}
const prefix = arg('prefix', `${layout !== 'none' ? layout : style}_${cols}x${rows}`);
const defaultOut = path.join(repoRoot(import.meta.url), 'tools', 'library', `${prefix}.csv`);
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
    allowUnsolved: tier === 'Expert+',
    keepFrac,
    budgetMs: remMs,
    name: puzName,
  });
  if (!p) continue;

  // Deduplicate across dihedral symmetries
  const sk = symmetryKey(p);
  if (seen.has(sk)) continue;

  // Independent re-verification before storing (never trust the generator's own claim)
  const r = verifyPuzzle(p);
  if (!r) continue;
  if (tier === 'Expert+') {
    if (r.solved) continue;
  } else {
    if (!r.solved) continue;
    if (tier !== 'any' && r.tier !== tier) continue;
  }
  p.rules = r.rules;
  p.tier = r.tier;
  p.score = r.score;

  seen.add(sk);
  fs.appendFileSync(outPath, toCsvRow(p) + '\n', 'utf8');
  added++;
  seq++;
  tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1;
  const parts = [];
  if (p.clues.length) parts.push(`${p.clues.length} circles`);
  if (p.slither && p.slither.length) parts.push(`${p.slither.length} numbers`);
  if (p.givens && p.givens.length) parts.push(`${p.givens.length} givens`);
  process.stdout.write(`[${added}/${count}] ${p.name} (${parts.join(', ') || '0 clues'}) -> ${p.tier} / ${p.rules} / ${p.score}\n`);
}

console.log(`Done: added ${added} puzzles to ${outPath} (tiers: B=${tierCounts.Beginner} M=${tierCounts.Medium} H=${tierCounts.Hard} E=${tierCounts.Expert})`);
