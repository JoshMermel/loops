#!/usr/bin/env node
// Assemble a book from pool CSVs in tools/library/ into data/<id>.csv and register it in data/manifest.json.
//
// Usage:
//   node tools/build_book.mjs --id 8x8 --name "8×8" --glob balanced_8x8 [--dir tools/library]
//                             [--limit 45] [--even-tiers] [--tiers 15,15,15] [--only-tier Beginner]
//                             [--group Default] [--sub ""] [--blurb "..."] [--exclude data/intro.csv]
import fs from 'node:fs';
import path from 'node:path';
import { parseCsv, toCsv, symmetryKey } from '../js/logic.js';
import { TIERS } from '../js/rating.js';

const root = new URL('..', import.meta.url).pathname;
const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const id = arg('id');
if (!id) { console.error('Missing --id'); process.exit(1); }
const name = arg('name', id);
const label = arg('label', name);
const prefixes = arg('glob', id).split(',');
const dir = path.resolve(root, arg('dir', 'tools/library'));
const limit = +arg('limit', 0);
const evenTiers = hasFlag('even-tiers');
const tierShares = arg('tiers', '') ? arg('tiers').split(',').map(Number) : null; // B,M,H
const onlyTier = arg('only-tier', null);
const group = arg('group', null);
const sub = arg('sub', null);
const blurb = arg('blurb', null);
const hidden = hasFlag('hidden');
const preserveExisting = hasFlag('preserve-existing');
const balanceGroups = hasFlag('balance-groups');
const excludeFiles = arg('exclude', '') ? arg('exclude').split(',').filter(Boolean) : [];

const excluded = new Set();
for (const ef of excludeFiles) {
  const p = path.resolve(root, ef);
  if (fs.existsSync(p)) {
    for (const q of parseCsv(fs.readFileSync(p, 'utf8'))) excluded.add(symmetryKey(q));
  }
}

const byOrder = (a, b) => (
  (a.rows * a.cols) - (b.rows * b.cols)
  || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
  || (a.score ?? 0) - (b.score ?? 0)
);

const seen = new Set(excluded);
const locked = [];
const existingBookPath = path.join(root, 'data', `${id}.csv`);
if (preserveExisting && fs.existsSync(existingBookPath)) {
  for (const p of parseCsv(fs.readFileSync(existingBookPath, 'utf8'))) {
    if (onlyTier && p.tier !== onlyTier) continue;
    const sk = symmetryKey(p);
    if (seen.has(sk)) continue;
    seen.add(sk);
    locked.push(p);
  }
}

let puzzles = [];
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir)
    .filter((f) => prefixes.some((pre) => f.startsWith(pre)) && f.endsWith('.csv'))
    .sort();
  for (const f of files) {
    const grp = prefixes.find((pre) => f.startsWith(pre)) || f;
    for (const p of parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      if (onlyTier && p.tier !== onlyTier) continue;
      const sk = symmetryKey(p);
      if (seen.has(sk)) continue;
      seen.add(sk);
      p._group = grp;
      puzzles.push(p);
    }
  }
}

puzzles.sort(byOrder);

const pickEvenly = (list, n) => {
  if (n <= 0) return [];
  if (list.length <= n) return list.slice();
  const out = [];
  for (let k = 0; k < n; k++) {
    const idx = Math.floor(((k + 0.5) * list.length) / n);
    out.push(list[idx]);
  }
  return out;
};

/**
 * Apportion `target` evenly across `groups` using largest-remainder + level-fill backfill
 * (same pattern as multiverse-star-battle/tools/build_books.py).
 */
function pickBalancedAcrossGroups(poolList, target, groups) {
  const byG = new Map(groups.map((g) => [g, []]));
  for (const p of poolList) {
    const g = byG.has(p._group) ? p._group : groups[0];
    byG.get(g).push(p);
  }
  const avail = new Map(groups.map((g) => [g, byG.get(g).length]));
  const totalAvail = [...avail.values()].reduce((a, b) => a + b, 0);
  const want = Math.min(target, totalAvail);
  const alloc = new Map(groups.map((g) => [g, 0]));

  // Level-fill: repeatedly bump whichever available group currently has the smallest allocation
  let assigned = 0;
  while (assigned < want) {
    let bestG = null, bestA = Infinity;
    for (const g of groups) {
      if (alloc.get(g) >= avail.get(g)) continue;
      const a = alloc.get(g);
      if (a < bestA) { bestA = a; bestG = g; }
    }
    if (!bestG) break;
    alloc.set(bestG, bestA + 1);
    assigned++;
  }

  const picked = [];
  for (const g of groups) picked.push(...pickEvenly(byG.get(g), alloc.get(g)));
  return { picked, alloc, avail };
}

const pickWithLocked = (lockedList, poolList, target) => {
  if (!target) return [...lockedList, ...poolList];
  if (lockedList.length >= target) return lockedList.slice();
  const need = target - lockedList.length;
  if (balanceGroups && prefixes.length > 1) {
    return [...lockedList, ...pickBalancedAcrossGroups(poolList, need, prefixes).picked];
  }
  return [...lockedList, ...pickEvenly(poolList, need)];
};

const groupReport = [];
if (tierShares) {
  const lByT = { Beginner: [], Medium: [], Hard: [] };
  const byT = { Beginner: [], Medium: [], Hard: [] };
  for (const p of locked) if (lByT[p.tier]) lByT[p.tier].push(p);
  for (const p of puzzles) if (byT[p.tier]) byT[p.tier].push(p);
  const picked = [];
  for (const [tierName, target] of [['Beginner', tierShares[0] || 0], ['Medium', tierShares[1] || 0], ['Hard', tierShares[2] || 0]]) {
    const res = pickWithLocked(lByT[tierName], byT[tierName], target);
    picked.push(...res);
    if (balanceGroups && prefixes.length > 1) {
      const counts = prefixes.map((g) => `${g}=${res.filter((p) => p._group === g).length}`).join(' ');
      groupReport.push(`  ${tierName}: ${counts}`);
    }
  }
  puzzles = picked.sort(byOrder);
} else if (evenTiers && limit > 0) {
  const lByT = { Beginner: [], Medium: [], Hard: [] };
  const byT = { Beginner: [], Medium: [], Hard: [] };
  for (const p of locked) if (lByT[p.tier]) lByT[p.tier].push(p);
  for (const p of puzzles) if (byT[p.tier]) byT[p.tier].push(p);
  const per = Math.floor(limit / 3);
  const rem = limit - per * 3;
  const targets = [per + (rem >= 1 ? 1 : 0), per + (rem >= 2 ? 1 : 0), per];
  const picked = [];
  for (const [tierName, target] of [['Beginner', targets[0]], ['Medium', targets[1]], ['Hard', targets[2]]]) {
    const res = pickWithLocked(lByT[tierName], byT[tierName], target);
    picked.push(...res);
    if (balanceGroups && prefixes.length > 1) {
      const counts = prefixes.map((g) => `${g}=${res.filter((p) => p._group === g).length}`).join(' ');
      groupReport.push(`  ${tierName}: ${counts}`);
    }
  }
  puzzles = picked.sort(byOrder);
} else if (limit > 0) {
  puzzles = pickWithLocked(locked, puzzles, limit).sort(byOrder);
} else {
  puzzles = [...locked, ...puzzles].sort(byOrder);
}

const pad = Math.max(2, String(puzzles.length).length);
const tag = id.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
puzzles.forEach((p, i) => {
  p.name = `${tag}-${String(i + 1).padStart(pad, '0')}`;
});

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', `${id}.csv`), toCsv(puzzles), 'utf8');

const manifestPath = path.join(root, 'data', 'manifest.json');
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : { groups: [], books: [] };
manifest.books = manifest.books || [];
const at = manifest.books.findIndex((b) => b.id === id);
const prev = at >= 0 ? manifest.books[at] : {};
const entry = {
  ...prev,
  id,
  name,
  label,
  file: `data/${id}.csv`,
  count: puzzles.length,
};
if (group !== null) entry.group = group;
if (sub !== null) { if (sub) entry.sub = sub; else delete entry.sub; }
if (blurb !== null) entry.blurb = blurb;
if (hidden) entry.hidden = true;

if (at >= 0) manifest.books[at] = entry;
else manifest.books.push(entry);
if (!manifest.default && !hidden) manifest.default = id;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const tc = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0 };
for (const p of puzzles) tc[p.tier] = (tc[p.tier] || 0) + 1;
console.log(`Built data/${id}.csv: ${puzzles.length} puzzles (B=${tc.Beginner} M=${tc.Medium} H=${tc.Hard})`);
for (const line of groupReport) console.log(line);
