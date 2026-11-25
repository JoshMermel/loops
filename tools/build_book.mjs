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
import { repoRoot, arg, byOrder } from './_cli.mjs';

const root = repoRoot(import.meta.url);
const hasFlag = (name) => process.argv.includes(`--${name}`);

const id = arg('id');
if (!id) { console.error('Missing --id'); process.exit(1); }
const name = arg('name', id);
const label = arg('label', name);
const prefixes = arg('glob', id).split(',');
const dir = path.resolve(root, arg('dir', 'tools/library'));
const limit = +arg('limit', 0);
const evenTiers = hasFlag('even-tiers');
const tierShares = arg('tiers', '') ? arg('tiers').split(',').map(Number) : null; // B,M,H,E
const onlyTier = arg('only-tier', null);
const minScore = arg('min-score', null) !== null ? +arg('min-score') : null;
const maxScore = arg('max-score', null) !== null ? +arg('max-score') : null;
const expertPlus = +arg('expert-plus', 0);
const bonusPrefixes = arg('bonus-glob', '') ? arg('bonus-glob').split(',').filter(Boolean) : [];
const bonusCount = +arg('bonus-count', 0);
const parseBands = (s) => {
  if (!s) return null;
  const parts = s.split(',');
  const out = {};
  ['Beginner', 'Medium', 'Hard', 'Expert'].forEach((t, i) => {
    const seg = parts[i];
    if (!seg) return;
    const [lo, hi] = seg.split(':');
    out[t] = { min: lo !== '' && lo !== undefined ? +lo : null, max: hi !== '' && hi !== undefined ? +hi : null };
  });
  return out;
};
const tierBands = parseBands(arg('tier-bands', ''));
const group = arg('group', null);
const sub = arg('sub', null);
const blurb = arg('blurb', null);
const hidden = hasFlag('hidden');
const preserveExisting = hasFlag('preserve-existing');
const balanceGroups = hasFlag('balance-groups');
const interleaveGroups = hasFlag('interleave-groups');
const maxRun = Math.max(1, +arg('max-run', 3));
const excludeFiles = arg('exclude', '') ? arg('exclude').split(',').filter(Boolean) : [];

const matchesBand = (p) => {
  if (p.rules === 'unsolved') return expertPlus > 0;
  if (onlyTier && p.tier !== onlyTier) return false;
  const sc = p.score ?? 0;
  if (minScore !== null && sc < minScore) return false;
  if (maxScore !== null && sc > maxScore) return false;
  if (tierBands && tierBands[p.tier]) {
    const b = tierBands[p.tier];
    if (b.min !== null && sc < b.min) return false;
    if (b.max !== null && sc > b.max) return false;
  }
  return true;
};

const excluded = new Set();
for (const ef of excludeFiles) {
  const p = path.resolve(root, ef);
  if (fs.existsSync(p)) {
    for (const q of parseCsv(fs.readFileSync(p, 'utf8'))) excluded.add(symmetryKey(q));
  }
}

const seen = new Set(excluded);
const locked = [];
const lockedExpertPlus = [];
const lockedBySk = new Map();
const existingBookPath = path.join(root, 'data', `${id}.csv`);
if (preserveExisting && fs.existsSync(existingBookPath)) {
  for (const p of parseCsv(fs.readFileSync(existingBookPath, 'utf8'))) {
    if (!matchesBand(p)) continue;
    const sk = symmetryKey(p);
    if (seen.has(sk)) continue;
    seen.add(sk);
    lockedBySk.set(sk, p);
    if (p.rules === 'unsolved') lockedExpertPlus.push(p);
    else locked.push(p);
  }
}

let puzzles = [];
const expertPlusPool = [];
if (fs.existsSync(dir)) {
  const files = fs.readdirSync(dir)
    .filter((f) => prefixes.some((pre) => f.startsWith(pre)) && f.endsWith('.csv'))
    .sort();
  for (const f of files) {
    const grp = prefixes.find((pre) => f.startsWith(pre)) || f;
    for (const p of parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      if (!matchesBand(p)) continue;
      const sk = symmetryKey(p);
      if (lockedBySk.has(sk)) {
        const lp = lockedBySk.get(sk);
        if (!lp._group) lp._group = grp;
        continue;
      }
      if (seen.has(sk)) continue;
      seen.add(sk);
      p._group = grp;
      if (p.rules === 'unsolved') expertPlusPool.push(p);
      else puzzles.push(p);
    }
  }
}

puzzles.sort(byOrder);
expertPlusPool.sort(byOrder);

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

function makeSeededRng(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Organically interleave per-group sorted lists within one slice (e.g. one tier):
 * - Every group stays strictly sorted easiest -> hardest by `byOrder`.
 * - Keeps groups closely aligned in relative difficulty quantile so all subtypes appear right away.
 * - Allows natural doubles and occasional triples while capping consecutive runs at `limitRun`.
 */
function interleaveByGroup(list, groups, { limitRun = 3, seed = 'interleave', carry = null } = {}) {
  if (!list.length || groups.length < 2) return list.slice().sort(byOrder);
  const queues = new Map(groups.map((g) => [g, []]));
  for (const p of list) {
    const g = queues.has(p._group) ? p._group : groups[0];
    queues.get(g).push(p);
  }
  for (const q of queues.values()) q.sort(byOrder);
  const totals = new Map(groups.map((g) => [g, Math.max(1, queues.get(g).length)]));
  const used = new Map(groups.map((g) => [g, 0]));
  const rng = makeSeededRng(seed);

  let prevG = carry ? carry.prevG : null;
  let runLen = carry ? carry.runLen : 0;
  const out = [];

  while (out.length < list.length) {
    const active = groups.filter((g) => queues.get(g).length > 0);
    if (!active.length) break;
    const ratios = new Map(active.map((g) => [g, used.get(g) / totals.get(g)]));
    const minRatio = Math.min(...ratios.values());
    const maxRatio = Math.max(...ratios.values());

    // Keep all groups synchronized in difficulty quantile (within ~12% or 2 puzzles of the lagging group)
    let eligible = active.filter((g) => ratios.get(g) <= minRatio + Math.max(0.12, 2 / totals.get(g)));
    if (!eligible.length) eligible = active;

    // Enforce hard maxRun whenever another eligible group exists
    if (prevG !== null && runLen >= limitRun) {
      const alt = eligible.filter((g) => g !== prevG);
      if (alt.length) eligible = alt;
      else {
        const anyAlt = active.filter((g) => g !== prevG);
        if (anyAlt.length) eligible = anyAlt;
      }
    }

    const totalRem = eligible.reduce((sum, g) => sum + queues.get(g).length, 0);
    const weights = eligible.map((g) => {
      let w = (queues.get(g).length / totalRem) * (1 + Math.max(0, maxRatio - ratios.get(g)) * 6);
      if (g === prevG) {
        if (runLen === 1) w *= 0.55;
        else if (runLen >= 2) w *= 0.18;
      }
      return w;
    });
    const wSum = weights.reduce((a, b) => a + b, 0);
    let r = rng() * wSum;
    let pick = eligible[eligible.length - 1];
    for (let i = 0; i < eligible.length; i++) {
      r -= weights[i];
      if (r <= 0) { pick = eligible[i]; break; }
    }

    out.push(queues.get(pick).shift());
    used.set(pick, used.get(pick) + 1);
    if (pick === prevG) runLen++;
    else { prevG = pick; runLen = 1; }
  }

  if (carry) { carry.prevG = prevG; carry.runLen = runLen; }
  return out;
}

const interleavePerTier = (res) => {
  const byT = { Beginner: [], Medium: [], Hard: [], Expert: [] };
  for (const p of res) if (byT[p.tier]) byT[p.tier].push(p);
  const out = [];
  for (const tierName of ['Beginner', 'Medium', 'Hard', 'Expert']) {
    if (!byT[tierName].length) continue;
    out.push(...interleaveByGroup(byT[tierName], prefixes, { limitRun: maxRun, seed: `${id}:${tierName}`, carry: runCarry }));
  }
  return out;
};

const groupReport = [];
const runCarry = { prevG: null, runLen: 0 };
if (tierShares) {
  const lByT = { Beginner: [], Medium: [], Hard: [], Expert: [] };
  const byT = { Beginner: [], Medium: [], Hard: [], Expert: [] };
  for (const p of locked) if (lByT[p.tier]) lByT[p.tier].push(p);
  for (const p of puzzles) if (byT[p.tier]) byT[p.tier].push(p);
  const picked = [];
  const specs = [
    ['Beginner', tierShares[0] || 0],
    ['Medium', tierShares[1] || 0],
    ['Hard', tierShares[2] || 0],
    ['Expert', tierShares[3] || 0],
  ];
  for (const [tierName, target] of specs) {
    if (target <= 0) continue;
    const res = pickWithLocked(lByT[tierName], byT[tierName], target);
    const ordered = (interleaveGroups && prefixes.length > 1)
      ? interleaveByGroup(res, prefixes, { limitRun: maxRun, seed: `${id}:${tierName}`, carry: runCarry })
      : res.sort(byOrder);
    picked.push(...ordered);
    if (balanceGroups && prefixes.length > 1) {
      const counts = prefixes.map((g) => `${g}=${res.filter((p) => p._group === g).length}`).join(' ');
      groupReport.push(`  ${tierName}: ${counts}`);
    }
  }
  puzzles = interleaveGroups ? picked : picked.sort(byOrder);
} else if (evenTiers && limit > 0) {
  const lByT = { Beginner: [], Medium: [], Hard: [], Expert: [] };
  const byT = { Beginner: [], Medium: [], Hard: [], Expert: [] };
  for (const p of locked) if (lByT[p.tier]) lByT[p.tier].push(p);
  for (const p of puzzles) if (byT[p.tier]) byT[p.tier].push(p);
  const activeTiers = byT.Expert.length + lByT.Expert.length > 0 ? ['Beginner', 'Medium', 'Hard', 'Expert'] : ['Beginner', 'Medium', 'Hard'];
  const per = Math.floor(limit / activeTiers.length);
  const rem = limit - per * activeTiers.length;
  const picked = [];
  activeTiers.forEach((tierName, idx) => {
    const target = per + (idx < rem ? 1 : 0);
    const res = pickWithLocked(lByT[tierName], byT[tierName], target);
    const ordered = (interleaveGroups && prefixes.length > 1)
      ? interleaveByGroup(res, prefixes, { limitRun: maxRun, seed: `${id}:${tierName}`, carry: runCarry })
      : res.sort(byOrder);
    picked.push(...ordered);
    if (balanceGroups && prefixes.length > 1) {
      const counts = prefixes.map((g) => `${g}=${res.filter((p) => p._group === g).length}`).join(' ');
      groupReport.push(`  ${tierName}: ${counts}`);
    }
  });
  puzzles = interleaveGroups ? picked : picked.sort(byOrder);
} else if (limit > 0) {
  const res = pickWithLocked(locked, puzzles, limit);
  puzzles = (interleaveGroups && prefixes.length > 1)
    ? interleavePerTier(res)
    : res.sort(byOrder);
} else {
  const res = [...locked, ...puzzles];
  puzzles = (interleaveGroups && prefixes.length > 1)
    ? interleavePerTier(res)
    : res.sort(byOrder);
}

if (expertPlus > 0) {
  const rawPlus = pickWithLocked(lockedExpertPlus, expertPlusPool, expertPlus);
  const pickedPlus = (interleaveGroups && prefixes.length > 1)
    ? interleaveByGroup(rawPlus, prefixes, { limitRun: maxRun, seed: `${id}:expertPlus`, carry: runCarry })
    : rawPlus.sort(byOrder);
  puzzles = [...puzzles, ...pickedPlus];
  if (!interleaveGroups) puzzles.sort(byOrder);
}

let bonusPickedCount = 0;
if (bonusPrefixes.length && bonusCount > 0 && fs.existsSync(dir)) {
  const bonusPool = [];
  const bonusFiles = fs.readdirSync(dir)
    .filter((f) => bonusPrefixes.some((pre) => f.startsWith(pre)) && f.endsWith('.csv'))
    .sort();
  for (const f of bonusFiles) {
    const grp = bonusPrefixes.find((pre) => f.startsWith(pre)) || f;
    for (const p of parseCsv(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      if (p.rules === 'unsolved') continue;
      const sk = symmetryKey(p);
      if (seen.has(sk)) continue;
      seen.add(sk);
      p._group = grp;
      bonusPool.push(p);
    }
  }
  bonusPool.sort(byOrder);
  const rawBonus = (balanceGroups && bonusPrefixes.length > 1)
    ? pickBalancedAcrossGroups(bonusPool, bonusCount, bonusPrefixes).picked
    : pickEvenly(bonusPool, bonusCount);
  const pickedBonus = (interleaveGroups && bonusPrefixes.length > 1)
    ? interleaveByGroup(rawBonus, bonusPrefixes, { limitRun: maxRun, seed: `${id}:bonus`, carry: runCarry })
      .sort((a, b) => (a.rows * a.cols) - (b.rows * b.cols))
    : rawBonus.sort(byOrder);
  bonusPickedCount = pickedBonus.length;
  puzzles = [...puzzles, ...pickedBonus];
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

const tc = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0, Plus: 0 };
for (const p of puzzles) {
  if (p.rules === 'unsolved') tc.Plus++;
  else tc[p.tier] = (tc[p.tier] || 0) + 1;
}
const plusTag = tc.Plus ? ` E+=${tc.Plus}` : '';
const bonusTag = bonusPickedCount ? ` +${bonusPickedCount} bonus` : '';
console.log(`Built data/${id}.csv: ${puzzles.length} puzzles (B=${tc.Beginner} M=${tc.Medium} H=${tc.Hard} E=${tc.Expert}${plusTag}${bonusTag})`);
for (const line of groupReport) console.log(line);
