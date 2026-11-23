#!/usr/bin/env node
// Multi-core pool filler for Masyu using worker_threads.
// Independently verifies every puzzle (valid solution, exact uniqueness, human-rated) before storing.
//
// Usage:
//   node tools/fill_pools.mjs [--workers 9] [--only groupName]
//
// Groups: default | big | bonus-existing | bonus-new | all (default: all)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  compile, solve, isSolved, decodeSolution, encodeSolution,
  toCsvRow, parseCsv, CSV_HEADER, symmetryKey,
} from '../js/logic.js';
import { rate } from '../js/rating.js';
import { generatePuzzle, makeRng } from '../js/generator.js';

if (!isMainThread) {
  const { job, seedStart, targetCount, budgetMs } = workerData;
  const rng = makeRng(seedStart);
  const deadline = Date.now() + budgetMs;
  const out = [];
  let seq = 0;
  while (out.length < targetCount && Date.now() < deadline) {
    const remMs = Math.min(job.perPuzzleMs || 15000, Math.max(500, deadline - Date.now()));
    const p = generatePuzzle({
      rows: job.rows,
      cols: job.cols,
      rng,
      style: job.style || 'balanced',
      layout: job.layout || 'none',
      minFill: job.minFill ?? null,
      maxTier: job.maxTier || 'Hard',
      targetTier: job.tier || null,
      keepFrac: job.keepFrac ?? null,
      budgetMs: remMs,
      name: `${job.pool}_${seedStart}_${++seq}`,
    });
    if (!p) continue;
    // Independent re-verification
    const fresh = compile({ name: p.name, rows: p.rows, cols: p.cols, clues: p.clues });
    const dec = decodeSolution(fresh, p.solution);
    if (!isSolved(fresh, dec.e)) continue;
    const exact = solve(fresh, { limit: 2, maxNodes: 500000 });
    if (exact.exceeded || exact.count !== 1) continue;
    if (encodeSolution(fresh, exact.solutions[0]) !== p.solution) continue;
    const r = rate(fresh);
    if (!r.solved) continue;
    if (job.tier && r.tier !== job.tier) continue;
    p.rules = r.rules;
    p.tier = r.tier;
    p.score = r.score;
    out.push({ key: symmetryKey(p), row: toCsvRow(p), tier: p.tier });
  }
  parentPort.postMessage(out);
  process.exit(0);
}

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
};

const numWorkers = Math.max(1, Math.min(os.cpus().length, +arg('workers', Math.max(1, os.cpus().length - 1))));
const onlyGroup = arg('only', 'all');
const libDir = path.resolve(new URL('..', import.meta.url).pathname, 'tools', 'library');
fs.mkdirSync(libDir, { recursive: true });

// Target pool specifications:
// Each entry defines the total desired count (or tier count) in tools/library/<pool>.csv.
const JOBS = [
  // ---- Grow existing Start here & Default pools
  { group: 'default', pool: 'intro_5x5', cols: 5, rows: 5, tier: 'Beginner', total: 35, budgetSec: 30 },
  { group: 'default', pool: 'intro_6x6', cols: 6, rows: 6, tier: 'Beginner', total: 35, budgetSec: 30 },

  { group: 'default', pool: 'balanced_6x6', cols: 6, rows: 6, tier: 'Beginner', totalTier: 48, budgetSec: 35 },
  { group: 'default', pool: 'balanced_6x6', cols: 6, rows: 6, tier: 'Medium', totalTier: 48, budgetSec: 35 },
  { group: 'default', pool: 'balanced_6x6', cols: 6, rows: 6, tier: 'Hard', totalTier: 48, budgetSec: 45 },

  { group: 'default', pool: 'balanced_8x8', cols: 8, rows: 8, tier: 'Beginner', totalTier: 48, budgetSec: 40 },
  { group: 'default', pool: 'balanced_8x8', cols: 8, rows: 8, tier: 'Medium', totalTier: 48, budgetSec: 45 },
  { group: 'default', pool: 'balanced_8x8', cols: 8, rows: 8, tier: 'Hard', totalTier: 48, budgetSec: 55 },

  { group: 'default', pool: 'balanced_10x10', cols: 10, rows: 10, tier: 'Beginner', totalTier: 36, budgetSec: 55 },
  { group: 'default', pool: 'balanced_10x10', cols: 10, rows: 10, tier: 'Medium', totalTier: 36, budgetSec: 55 },
  { group: 'default', pool: 'balanced_10x10', cols: 10, rows: 10, tier: 'Hard', totalTier: 36, budgetSec: 65 },

  { group: 'default', pool: 'balanced_12x12', cols: 12, rows: 12, tier: 'Beginner', totalTier: 28, budgetSec: 75 },
  { group: 'default', pool: 'balanced_12x12', cols: 12, rows: 12, tier: 'Medium', totalTier: 28, budgetSec: 75 },
  { group: 'default', pool: 'balanced_12x12', cols: 12, rows: 12, tier: 'Hard', totalTier: 28, budgetSec: 90 },

  // ---- Big default sizes: 14x14, 16x16, 18x18, 12x20
  { group: 'big', pool: 'balanced_14x14', cols: 14, rows: 14, tier: 'Beginner', totalTier: 16, budgetSec: 80, perPuzzleMs: 25000 },
  { group: 'big', pool: 'balanced_14x14', cols: 14, rows: 14, tier: 'Medium', totalTier: 16, budgetSec: 80, perPuzzleMs: 25000 },
  { group: 'big', pool: 'balanced_14x14', cols: 14, rows: 14, tier: 'Hard', totalTier: 16, budgetSec: 95, perPuzzleMs: 25000 },

  { group: 'big', pool: 'balanced_16x16', cols: 16, rows: 16, tier: 'Beginner', totalTier: 12, budgetSec: 90, perPuzzleMs: 30000 },
  { group: 'big', pool: 'balanced_16x16', cols: 16, rows: 16, tier: 'Medium', totalTier: 12, budgetSec: 90, perPuzzleMs: 30000 },
  { group: 'big', pool: 'balanced_16x16', cols: 16, rows: 16, tier: 'Hard', totalTier: 14, budgetSec: 110, perPuzzleMs: 30000 },

  { group: 'big', pool: 'balanced_18x18', cols: 18, rows: 18, total: 24, budgetSec: 130, perPuzzleMs: 40000 },
  { group: 'big', pool: 'balanced_12x20', cols: 12, rows: 20, total: 24, budgetSec: 110, perPuzzleMs: 35000 },

  // ---- Grow existing Bonus pools + bigger sizes for All white / All black / Sparse / Skyscraper
  { group: 'bonus-existing', pool: 'white_6x6', cols: 6, rows: 6, style: 'white', total: 66, budgetSec: 35 },
  { group: 'bonus-existing', pool: 'white_8x8', cols: 8, rows: 8, style: 'white', total: 66, budgetSec: 45 },
  { group: 'bonus-existing', pool: 'white_10x10', cols: 10, rows: 10, style: 'white', total: 50, budgetSec: 65 },

  { group: 'bonus-existing', pool: 'black_6x6', cols: 6, rows: 6, style: 'black', total: 66, budgetSec: 45 },
  { group: 'bonus-existing', pool: 'black_8x8', cols: 8, rows: 8, style: 'black', total: 66, budgetSec: 60 },
  { group: 'bonus-existing', pool: 'black_10x10', cols: 10, rows: 10, style: 'black', total: 50, budgetSec: 95 },

  { group: 'bonus-existing', pool: 'sparse_8x8', cols: 8, rows: 8, style: 'sparse', total: 66, budgetSec: 55 },
  { group: 'bonus-existing', pool: 'sparse_10x10', cols: 10, rows: 10, style: 'sparse', total: 50, budgetSec: 85 },

  { group: 'bonus-existing', pool: 'sky_5x14', cols: 5, rows: 14, total: 22, budgetSec: 40 },
  { group: 'bonus-existing', pool: 'sky_6x16', cols: 6, rows: 16, total: 22, budgetSec: 45 },
  { group: 'bonus-existing', pool: 'sky_6x20', cols: 6, rows: 20, total: 22, budgetSec: 55 },

  { group: 'bonus-existing', pool: 'tallsky_6x24', cols: 6, rows: 24, total: 14, budgetSec: 60, perPuzzleMs: 25000 },
  { group: 'bonus-existing', pool: 'tallsky_8x24', cols: 8, rows: 24, total: 14, budgetSec: 80, perPuzzleMs: 30000 },
  { group: 'bonus-existing', pool: 'tallsky_6x30', cols: 6, rows: 30, total: 14, budgetSec: 80, perPuzzleMs: 30000 },

  // ---- Brand-new Bonus corpus themes
  { group: 'bonus-new', pool: 'sym_rot180_8x8', cols: 8, rows: 8, layout: 'rot180', total: 22, budgetSec: 45 },
  { group: 'bonus-new', pool: 'sym_mirror_8x8', cols: 8, rows: 8, layout: 'mirror', total: 22, budgetSec: 45 },
  { group: 'bonus-new', pool: 'sym_transpose_8x8', cols: 8, rows: 8, layout: 'transpose', total: 22, budgetSec: 45 },
  { group: 'bonus-new', pool: 'sym_rot90_8x8', cols: 8, rows: 8, layout: 'rot90', total: 22, budgetSec: 45 },

  { group: 'bonus-new', pool: 'sym_rot180_10x10', cols: 10, rows: 10, layout: 'rot180', total: 16, budgetSec: 60 },
  { group: 'bonus-new', pool: 'sym_mirror_10x10', cols: 10, rows: 10, layout: 'mirror', total: 16, budgetSec: 60 },
  { group: 'bonus-new', pool: 'sym_transpose_10x10', cols: 10, rows: 10, layout: 'transpose', total: 16, budgetSec: 60 },
  { group: 'bonus-new', pool: 'sym_rot90_10x10', cols: 10, rows: 10, layout: 'rot90', total: 16, budgetSec: 60 },

  { group: 'bonus-new', pool: 'yinyang_8x8', cols: 8, rows: 8, layout: 'yinyang', total: 48, budgetSec: 95, perPuzzleMs: 20000 },
  { group: 'bonus-new', pool: 'yinyang_10x10', cols: 10, rows: 10, layout: 'yinyang', total: 32, budgetSec: 120, perPuzzleMs: 30000 },

  { group: 'bonus-new', pool: 'interior_8x8', cols: 8, rows: 8, layout: 'interior', total: 48, budgetSec: 55 },
  { group: 'bonus-new', pool: 'interior_10x10', cols: 10, rows: 10, layout: 'interior', total: 48, budgetSec: 75 },

  { group: 'bonus-new', pool: 'lattice_9x9', cols: 9, rows: 9, layout: 'lattice', total: 48, budgetSec: 65, perPuzzleMs: 20000 },
  { group: 'bonus-new', pool: 'lattice_9x11', cols: 9, rows: 11, layout: 'lattice', total: 24, budgetSec: 90, perPuzzleMs: 25000 },
  { group: 'bonus-new', pool: 'lattice_13x13', cols: 13, rows: 13, layout: 'lattice', total: 18, budgetSec: 110, perPuzzleMs: 35000 },

  { group: 'bonus-new', pool: 'full_6x6', cols: 6, rows: 6, minFill: 1.0, total: 48, budgetSec: 55 },
  { group: 'bonus-new', pool: 'full_8x8', cols: 8, rows: 8, minFill: 1.0, total: 48, budgetSec: 95, perPuzzleMs: 25000 },
  { group: 'bonus-new', pool: 'full_10x10', cols: 10, rows: 10, minFill: 1.0, total: 36, budgetSec: 95, perPuzzleMs: 30000 },
];

const selected = onlyGroup === 'all' ? JOBS : JOBS.filter((j) => j.group === onlyGroup);

async function runJob(job, jobIdx) {
  const outPath = path.join(libDir, `${job.pool}.csv`);
  const seen = new Set();
  const tierHave = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0 };
  let totalHave = 0;
  if (fs.existsSync(outPath)) {
    for (const p of parseCsv(fs.readFileSync(outPath, 'utf8'))) {
      seen.add(symmetryKey(p));
      totalHave++;
      tierHave[p.tier] = (tierHave[p.tier] || 0) + 1;
    }
  } else {
    fs.writeFileSync(outPath, CSV_HEADER + '\n', 'utf8');
  }

  const need = job.totalTier != null
    ? Math.max(0, job.totalTier - (tierHave[job.tier] || 0))
    : Math.max(0, job.total - totalHave);
  if (need === 0) {
    console.log(`[skip] ${job.pool}${job.tier ? ` (${job.tier})` : ''}: already has ${job.totalTier != null ? tierHave[job.tier] : totalHave}`);
    return;
  }

  const wCount = Math.min(numWorkers, need);
  const perWorker = Math.ceil((need * 1.15) / wCount);
  const t0 = Date.now();
  const baseSeed = 10000 + jobIdx * 1000 + totalHave * 7;

  const promises = [];
  for (let w = 0; w < wCount; w++) {
    promises.push(new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: {
          job,
          seedStart: baseSeed + w * 97,
          targetCount: perWorker,
          budgetMs: (job.budgetSec || 60) * 1000,
        },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    }));
  }

  const chunks = await Promise.all(promises);
  let added = 0;
  const rows = [];
  for (const list of chunks) {
    for (const item of list) {
      if (added >= need) break;
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      rows.push(item.row);
      added++;
    }
  }
  if (rows.length) fs.appendFileSync(outPath, rows.join('\n') + '\n', 'utf8');
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[done] ${job.pool}${job.tier ? ` (${job.tier})` : ''}: +${added}/${need} in ${dt}s`);
}

const startAll = Date.now();
for (let i = 0; i < selected.length; i++) {
  await runJob(selected[i], i);
}
console.log(`\nAll selected jobs finished in ${((Date.now() - startAll) / 1000).toFixed(1)}s.`);
