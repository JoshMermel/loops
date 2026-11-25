#!/usr/bin/env node
// Scan shipped books and pools by replaying computeHint() from an empty board, pick one clean example
// per non-bookkeeping rule in js/rating.js, write the hidden `armory` book (`data/armory.csv`),
// register it in `data/manifest.json` with `"hidden": true`, and write `docs/examples/examples.json`.
//
// Usage: node tools/how_to_examples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { compile, parseCsv, toCsv, isSolved, symmetryKey } from '../js/logic.js';
import { RULES } from '../js/rating.js';
import { computeHint } from '../js/hintstep.js';
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

// Prioritize up to 12 smallest puzzles per rule ID (matching p.rules), plus up to 600 smallest boards overall,
// so rare rules are found immediately without replaying all 15,000+ large boards single-threaded.
const prioritized = [];
const pickedKey = new Set();
const perRule = new Map();
for (const p of candidates) {
  const n = perRule.get(p.rules) || 0;
  if (targetRules.has(p.rules) && n < 12) {
    perRule.set(p.rules, n + 1);
    const sk = symmetryKey(p);
    pickedKey.add(sk);
    prioritized.push(p);
  }
}
for (const p of candidates) {
  if (prioritized.length >= 900) break;
  const sk = symmetryKey(p);
  if (pickedKey.has(sk)) continue;
  pickedKey.add(sk);
  prioritized.push(p);
}

const prefer = (prev, cand) => {
  if (!prev) return true;
  // Prefer smaller board (prefer 6x6 or 8x8), and fewer earlier hints so the board isn't cluttered
  const score = (e) => e.puzzleObj.rows * e.puzzleObj.cols * 10 + e.hintsCount;
  return score(cand) < score(prev);
};

for (const raw of prioritized) {
  if (best.size === targetRules.size) break;
  const P = compile({ ...raw });
  const marks = { edges: new Uint8Array(P.numEdges) };
  for (let step = 0; step < 300; step++) {
    if (isSolved(P, marks.edges)) break;
    const h = computeHint(P, marks);
    if (h.kind !== 'step') break;
    const item = h.hints[0];
    if (targetRules.has(h.rule)) {
      const cand = {
        puzzleObj: raw,
        edgesStr: Array.from(marks.edges).join(''),
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
    const copy = { ...ex.puzzleObj, name: `ARMORY-${String(armoryPuzzles.length + 1).padStart(2, '0')}` };
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
