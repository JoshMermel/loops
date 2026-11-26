#!/usr/bin/env node
// Scan shipped books and pools by replaying computeHint() from an empty board, pick one clean example
// per non-bookkeeping rule in js/rating.js, write the hidden `armory` book (`data/armory.csv`),
// register it in `data/manifest.json` with `"hidden": true`, and write `docs/examples/examples.json`.
//
// Usage: node tools/how_to_examples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { compile, parseCsv, toCsv, isSolved, symmetryKey, WHITE, BLACK } from '../js/logic.js';
import { RULES, rate } from '../js/rating.js';
import { computeHint } from '../js/hintstep.js';
import { reconcileAutoGray } from '../js/marks.js';
import { repoRoot } from './_cli.mjs';

const root = repoRoot(import.meta.url);
const manifestPath = path.join(root, 'data', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const targetRules = new Set(RULES.filter((r) => !r.free).map((r) => r.id));
const best = new Map(); // ruleId -> { puzzleObj, cellsStr, edgesStr, hintsCount, text, score, rule, tier, weight, item }

// Collect candidate puzzles: smallest boards first so examples are easy to read!
const candidates = [];
const seen = new Set();
const addFile = (f) => {
  if (!fs.existsSync(f)) return;
  for (const p of parseCsv(fs.readFileSync(f, 'utf8'))) {
    if (p.rows * p.cols > 196) continue; // keep how-to-solve diagrams readable
    const sk = symmetryKey(p);
    if (seen.has(sk)) continue;
    seen.add(sk);
    candidates.push(p);
  }
};

for (const b of manifest.books) {
  if (b.hidden) continue;
  addFile(path.join(root, b.file));
}
const libDir = path.join(root, 'tools', 'library');
if (fs.existsSync(libDir)) {
  for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith('.csv')).sort()) {
    addFile(path.join(libDir, f));
  }
}

candidates.sort((a, b) => (a.rows * a.cols) - (b.rows * b.cols) || (a.score ?? 0) - (b.score ?? 0));

// Prioritize up to 12 smallest puzzles per rule ID (matching p.rules), plus dedicated quotas per
// puzzle family (Slitherlink, Hamilton cycle, Swiss cheese, Gray circles) so newer/smaller families
// are never crowded out by 2,000+ 8x8 classic Masyu boards, plus general smallest boards up to 1200.
const prioritized = [];
const pickedKey = new Set();
const addCand = (p) => {
  const sk = symmetryKey(p);
  if (pickedKey.has(sk)) return false;
  pickedKey.add(sk);
  prioritized.push(p);
  return true;
};
const perRule = new Map();
for (const p of candidates) {
  const n = perRule.get(p.rules) || 0;
  if (targetRules.has(p.rules) && n < 12) {
    perRule.set(p.rules, n + 1);
    addCand(p);
  }
}
const variantCount = (p) => (
  (p.slither && p.slither.length ? 1 : 0)
  + (p.midloop && p.midloop.length ? 1 : 0)
  + (p.fullBoard ? 1 : 0)
  + (p.voids && p.voids.length ? 1 : 0)
  + (p.clues.some((c) => c.t === 'G') ? 1 : 0)
  + (p.givens && p.givens.length ? 1 : 0)
);
const isHybridCand = (p) => (
  (p.slither && p.slither.length ? 1 : 0)
  + (p.midloop && p.midloop.length ? 1 : 0)
  + (p.clues && p.clues.length ? 1 : 0)
  + (p.fullBoard ? 1 : 0)
) >= 2;
const familyQuota = { slither: 200, midloop: 150, full: 120, voids: 80, gray: 120, hybridSlitherMasyu: 60, hybridSlitherFull: 60, hybridFullMasyu: 60, hybridMidloop: 60 };
for (const p of candidates) {
  if (isHybridCand(p)) {
    const hasS = p.slither && p.slither.length > 0;
    const hasM = p.midloop && p.midloop.length > 0;
    const hasC = p.clues && p.clues.length > 0;
    if (hasM && familyQuota.hybridMidloop > 0 && addCand(p)) { familyQuota.hybridMidloop--; continue; }
    if (hasS && hasC && familyQuota.hybridSlitherMasyu > 0 && addCand(p)) { familyQuota.hybridSlitherMasyu--; continue; }
    if (hasS && p.fullBoard && familyQuota.hybridSlitherFull > 0 && addCand(p)) { familyQuota.hybridSlitherFull--; continue; }
    if (hasC && p.fullBoard && familyQuota.hybridFullMasyu > 0 && addCand(p)) { familyQuota.hybridFullMasyu--; continue; }
  }
  if (p.slither && p.slither.length && familyQuota.slither > 0 && addCand(p)) familyQuota.slither--;
  else if (p.midloop && p.midloop.length && familyQuota.midloop > 0 && addCand(p)) familyQuota.midloop--;
  else if (p.fullBoard && familyQuota.full > 0 && addCand(p)) familyQuota.full--;
  else if (p.voids && p.voids.length && familyQuota.voids > 0 && addCand(p)) familyQuota.voids--;
  else if (p.clues.some((c) => c.t === 'G') && familyQuota.gray > 0 && addCand(p)) familyQuota.gray--;
}
for (const p of candidates) {
  if (prioritized.length >= 1400) break;
  addCand(p);
}

// Sort prioritized: plain Masyu boards first, then single-variant boards, then hybrids, smallest-first within each band
// so core Masyu rules never get crowded out by smaller Slitherlink/Hamilton/Gray examples.
prioritized.sort((a, b) => (
  variantCount(a) - variantCount(b)
  || (a.rows * a.cols) - (b.rows * b.cols)
  || (a.score ?? 0) - (b.score ?? 0)
));

const prefer = (prev, cand) => {
  if (!prev) return true;
  // Strongly prefer plain Masyu boards for core rules (and single-variant boards over hybrids),
  // then smaller boards (6x6 / 8x8), and fewer earlier hints so diagrams stay uncluttered.
  const score = (e) => variantCount(e.puzzleObj) * 100000 + e.puzzleObj.rows * e.puzzleObj.cols * 10 + e.hintsCount;
  return score(cand) < score(prev);
};

for (const raw of prioritized) {
  if (best.size === targetRules.size) break;
  const P = compile({ ...raw });
  const marks = {
    edges: new Uint8Array(P.numEdges),
    grays: new Uint8Array(P.grays.length),
    autoG: new Uint8Array(P.grays.length),
  };
  if (P.hasGivens) {
    for (const gv of P.givens) marks.edges[gv.edge] = gv.v ? 1 : 2;
  }
  for (let step = 0; step < 300; step++) {
    if (isSolved(P, marks.edges)) break;
    const h = computeHint(P, marks);
    if (h.kind !== 'step') break;
    const item = h.hints[0];
    if (targetRules.has(h.rule)) {
      const cand = {
        puzzleObj: raw,
        edgesStr: Array.from(marks.edges).join(''),
        graysStr: P.grays.length ? Array.from(marks.grays).join('') : '',
        hintsCount: step,
        rule: h.rule,
        tier: h.tier,
        weight: h.weight,
        text: item.text,
        roles: item.roles,
        targets: item.targets,
        chain: item.chain,
        faces: item.faces || null,
      };
      if (prefer(best.get(h.rule), cand)) best.set(h.rule, cand);
    }
    let changed = false;
    for (const x of item.targets.segOn) if (marks.edges[x] !== 1) { marks.edges[x] = 1; changed = true; }
    for (const x of item.targets.segOff) if (marks.edges[x] !== 2) { marks.edges[x] = 2; changed = true; }
    for (const cell of item.targets.grayWhite || []) {
      const k = P.grayAt[cell];
      if (k >= 0 && marks.grays[k] !== WHITE) { marks.grays[k] = WHITE; marks.autoG[k] = 0; changed = true; }
    }
    for (const cell of item.targets.grayBlack || []) {
      const k = P.grayAt[cell];
      if (k >= 0 && marks.grays[k] !== BLACK) { marks.grays[k] = BLACK; marks.autoG[k] = 0; changed = true; }
    }
    reconcileAutoGray(P, marks);
    if (!changed) break;
  }
}

// Assemble data/armory.csv (deduplicating puzzles shared by multiple rules)
const armoryPuzzles = [];
const puzzleNumByKey = new Map();
const examples = [];

for (const r of RULES) {
  if (r.free) continue;
  const ex = best.get(r.id);
  if (!ex) continue;
  const sk = symmetryKey(ex.puzzleObj);
  let num = puzzleNumByKey.get(sk);
  if (!num) {
    const rated = rate(compile({ ...ex.puzzleObj }));
    const copy = {
      ...ex.puzzleObj,
      name: `ARMORY-${String(armoryPuzzles.length + 1).padStart(2, '0')}`,
      rules: rated.rules,
      tier: rated.tier,
      score: rated.score,
    };
    armoryPuzzles.push(copy);
    num = armoryPuzzles.length;
    puzzleNumByKey.set(sk, num);
  }
  examples.push({
    rule: ex.rule,
    tier: ex.tier,
    weight: ex.weight,
    puzzle: num,
    name: armoryPuzzles[num - 1].name,
    rows: ex.puzzleObj.rows,
    cols: ex.puzzleObj.cols,
    hints: ex.hintsCount,
    edges: ex.edgesStr,
    ...(ex.graysStr ? { grays: ex.graysStr } : {}),
    text: ex.text,
    roles: ex.roles,
    targets: ex.targets,
    chain: ex.chain,
    faces: ex.faces || null,
  });
}

fs.writeFileSync(path.join(root, 'data', 'armory.csv'), toCsv(armoryPuzzles), 'utf8');
fs.mkdirSync(path.join(root, 'docs', 'examples'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'examples', 'examples.json'), JSON.stringify(examples, null, 2) + '\n', 'utf8');

// Register hidden armory book in manifest.json
const at = manifest.books.findIndex((b) => b.id === 'armory');
const entry = {
  id: 'armory',
  name: 'Armory (How-to-solve examples)',
  label: 'Armory',
  group: 'Hidden',
  file: 'data/armory.csv',
  count: armoryPuzzles.length,
  hidden: true,
};
if (at >= 0) manifest.books[at] = entry;
else manifest.books.push(entry);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const missing = [...targetRules].filter((id) => !best.has(id));
console.log(`Found examples for ${examples.length}/${targetRules.size} rules (${armoryPuzzles.length} unique armory puzzles).`);
if (missing.length) console.log('Rules without an example in current corpus:', missing.join(', '));
