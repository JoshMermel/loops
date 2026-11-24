#!/usr/bin/env node
// Multi-core pool filler for Masyu using worker_threads.
// Supports both single-tier jobs and streaming multi-bucket jobs with score bands & Expert+.
// Independently verifies every puzzle (valid solution, exact uniqueness, human-rated) before storing.
//
// Usage:
//   node tools/fill_pools.mjs [--workers 9] [--only groupName]
//
// Groups: core | giants | bonus-existing | bonus-sym | bonus-new | all (default: all)
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

function bucketOf(p, buckets) {
  if (p.rules === 'unsolved') return buckets['Expert+'] ? 'Expert+' : null;
  const spec = buckets[p.tier];
  if (!spec) return null;
  if (spec.minScore != null && p.score < spec.minScore) return null;
  if (spec.maxScore != null && p.score > spec.maxScore) return null;
  return p.tier;
}

if (!isMainThread) {
  const { job, seedStart, targetCount, budgetMs, initialDeficits } = workerData;
  const rng = makeRng(seedStart);
  const deadline = Date.now() + budgetMs;

  if (job.buckets) {
    // Streaming multi-bucket worker: adapts stripMode dynamically to remaining deficits
    let deficits = { ...initialDeficits };
    let stopped = false;
    parentPort.on('message', (msg) => {
      if (msg.stop) stopped = true;
      if (msg.deficits) deficits = msg.deficits;
    });

    let seq = 0;
    const totalDef = () => Object.values(deficits).reduce((a, b) => a + Math.max(0, b), 0);

    const pickMode = () => {
      const dB = Math.max(0, deficits.Beginner || 0);
      const dM = Math.max(0, deficits.Medium || 0);
      const dH = Math.max(0, deficits.Hard || 0);
      const dE = Math.max(0, deficits.Expert || 0);
      const dP = Math.max(0, deficits['Expert+'] || 0);
      const tot = dB + dM + dH + dE + dP;
      if (tot === 0) return null;
      const maxTier = (dP > 0 || dE > 0) ? 'Expert' : dH > 0 ? 'Hard' : dM > 0 ? 'Medium' : 'Beginner';
      if (dP > 0 && dB + dM + dH + dE === 0) return { targetTier: 'Expert+', maxTier: 'Expert', stripMode: 'deep', allowUnsolved: true };
      const r = rng() * tot;
      if (r < dB) return { targetTier: null, maxTier: 'Beginner', stripMode: 'beginner', allowUnsolved: false };
      if (r < dB + dM) return { targetTier: null, maxTier: dH + dE + dP === 0 ? 'Medium' : maxTier, stripMode: 'medium', allowUnsolved: false };
      return { targetTier: null, maxTier, stripMode: 'deep', allowUnsolved: dP > 0 };
    };

    const run = async () => {
      while (!stopped && totalDef() > 0 && Date.now() < deadline) {
        // Yield briefly to process incoming deficit/stop messages from main thread
        await new Promise((r) => setImmediate(r));
        if (stopped || totalDef() === 0) break;
        const mode = pickMode();
        if (!mode) break;
        const remMs = Math.min(job.perPuzzleMs || 15000, Math.max(500, deadline - Date.now()));
        const p = generatePuzzle({
          rows: job.rows,
          cols: job.cols,
          rng,
          style: job.style || 'balanced',
          layout: job.layout || 'none',
          minFill: job.minFill ?? null,
          maxTier: mode.maxTier || 'Expert',
          targetTier: mode.targetTier,
          stripMode: mode.stripMode,
          allowUnsolved: mode.allowUnsolved,
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
        p.rules = r.rules;
        p.tier = r.tier;
        p.score = r.score;
        const b = bucketOf(p, job.buckets);
        if (!b || (deficits[b] || 0) <= 0) continue;
        parentPort.postMessage({ type: 'puzzle', key: symmetryKey(p), row: toCsvRow(p), bucket: b });
      }
      parentPort.postMessage({ type: 'done' });
      process.exit(0);
    };
    run();
  } else {
    // Classic single-job worker
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
        maxTier: job.maxTier || 'Expert',
        targetTier: job.tier || null,
        allowUnsolved: job.tier === 'Expert+',
        keepFrac: job.keepFrac ?? null,
        budgetMs: remMs,
        name: `${job.pool}_${seedStart}_${++seq}`,
      });
      if (!p) continue;
      const fresh = compile({ name: p.name, rows: p.rows, cols: p.cols, clues: p.clues });
      const dec = decodeSolution(fresh, p.solution);
      if (!isSolved(fresh, dec.e)) continue;
      const exact = solve(fresh, { limit: 2, maxNodes: 500000 });
      if (exact.exceeded || exact.count !== 1) continue;
      if (encodeSolution(fresh, exact.solutions[0]) !== p.solution) continue;
      const r = rate(fresh);
      if (job.tier === 'Expert+') {
        if (r.solved) continue;
      } else {
        if (!r.solved) continue;
        if (job.tier && r.tier !== job.tier) continue;
      }
      p.rules = r.rules;
      p.tier = r.tier;
      p.score = r.score;
      out.push({ key: symmetryKey(p), row: toCsvRow(p), tier: p.tier });
    }
    parentPort.postMessage(out);
    process.exit(0);
  }
} else {
  const arg = (name, def = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
  };

  const numWorkers = Math.max(1, Math.min(os.cpus().length, +arg('workers', Math.max(1, os.cpus().length - 1))));
  const onlyGroup = arg('only', 'all');
  const libDir = path.resolve(new URL('..', import.meta.url).pathname, 'tools', 'library');
  fs.mkdirSync(libDir, { recursive: true });

  const JOBS = [
    // ---- Start here: Gentle intro (50 each of 5x5 and 6x6 Beginner)
    { group: 'core', pool: 'intro_5x5', cols: 5, rows: 5, tier: 'Beginner', total: 55, budgetSec: 40 },
    { group: 'core', pool: 'intro_6x6', cols: 6, rows: 6, tier: 'Beginner', total: 55, budgetSec: 40 },

    // ---- Core Basic: 8x8 and 12x12 (500 per tier with score bands + 10 Expert+)
    {
      group: 'core', pool: 'balanced_8x8', cols: 8, rows: 8,
      buckets: {
        Beginner: { need: 505, maxScore: 235 },
        Medium: { need: 505, minScore: 215, maxScore: 270 },
        Hard: { need: 505, minScore: 265, maxScore: 420 },
        Expert: { need: 505, minScore: 420 },
        'Expert+': { need: 12 },
      },
      budgetSec: 360, perPuzzleMs: 12000,
    },
    {
      group: 'core', pool: 'balanced_12x12', cols: 12, rows: 12,
      buckets: {
        Beginner: { need: 505, maxScore: 535 },
        Medium: { need: 505, minScore: 495, maxScore: 585 },
        Hard: { need: 505, minScore: 575, maxScore: 820 },
        Expert: { need: 505, minScore: 820 },
        'Expert+': { need: 12 },
      },
      budgetSec: 600, perPuzzleMs: 25000,
    },

    // ---- Giants: 16x16 (200: 60 M / 70 H / 70 E) and 12x20 (100: 30 M / 35 H / 35 E) — no Beginner on Giants
    {
      group: 'giants', pool: 'balanced_16x16', cols: 16, rows: 16,
      buckets: {
        Medium: { need: 62, maxScore: 1020 },
        Hard: { need: 72, minScore: 990, maxScore: 1380 },
        Expert: { need: 72, minScore: 1350 },
      },
      budgetSec: 300, perPuzzleMs: 30000,
    },
    {
      group: 'giants', pool: 'balanced_12x20', cols: 12, rows: 20,
      buckets: {
        Medium: { need: 32, maxScore: 970 },
        Hard: { need: 36, minScore: 950, maxScore: 1260 },
        Expert: { need: 36, minScore: 1240 },
      },
      budgetSec: 300, perPuzzleMs: 35000,
    },
    {
      group: 'giants-24x30', pool: 'balanced_24x30', cols: 24, rows: 30,
      buckets: {
        Medium: { need: 22, maxScore: 2700 },
        Hard: { need: 22, minScore: 2650, maxScore: 3300 },
        Expert: { need: 22, minScore: 3250 },
      },
      budgetSec: 600, perPuzzleMs: 45000,
    },

    // ---- Bonus pools (500 at 10/40/40/10 with score bands + oversized bonus tails + Lattice showcase)
    {
      group: 'bonus', pool: 'white_8x8', cols: 8, rows: 8, style: 'white',
      buckets: {
        Beginner: { need: 52, maxScore: 265 },
        Medium: { need: 204, minScore: 240, maxScore: 305 },
        Hard: { need: 204, minScore: 300, maxScore: 485 },
        Expert: { need: 52, minScore: 470 },
      },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'bonus', pool: 'black_10x10', cols: 10, rows: 10, style: 'black',
      buckets: {
        Beginner: { need: 52, maxScore: 345 },
        Medium: { need: 204, minScore: 315, maxScore: 380 },
        Hard: { need: 204, minScore: 365, maxScore: 510 },
        Expert: { need: 52, minScore: 500 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sky_6x20', cols: 6, rows: 20,
      buckets: {
        Beginner: { need: 52, maxScore: 455 },
        Medium: { need: 204, minScore: 415, maxScore: 505 },
        Hard: { need: 204, minScore: 480, maxScore: 730 },
        Expert: { need: 52, minScore: 700 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_rot180_10x10', cols: 10, rows: 10, layout: 'rot180',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_mirror_10x10', cols: 10, rows: 10, layout: 'mirror',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_transpose_10x10', cols: 10, rows: 10, layout: 'transpose',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_10x10', cols: 10, rows: 10, layout: 'yinyang',
      buckets: {
        Beginner: { need: 18, maxScore: 350 },
        Medium: { need: 68, minScore: 325, maxScore: 410 },
        Hard: { need: 68, minScore: 390, maxScore: 610 },
        Expert: { need: 18, minScore: 575 },
      },
      budgetSec: 240, perPuzzleMs: 25000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_mirror_10x10', cols: 10, rows: 10, layout: 'yinyang-mirror',
      buckets: {
        Beginner: { need: 18, maxScore: 350 },
        Medium: { need: 68, minScore: 325, maxScore: 410 },
        Hard: { need: 68, minScore: 390, maxScore: 610 },
        Expert: { need: 18, minScore: 575 },
      },
      budgetSec: 240, perPuzzleMs: 25000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_transpose_10x10', cols: 10, rows: 10, layout: 'yinyang-transpose',
      buckets: {
        Beginner: { need: 18, maxScore: 350 },
        Medium: { need: 68, minScore: 325, maxScore: 410 },
        Hard: { need: 68, minScore: 390, maxScore: 610 },
        Expert: { need: 18, minScore: 575 },
      },
      budgetSec: 240, perPuzzleMs: 25000,
    },
    {
      group: 'bonus', pool: 'full_10x10', cols: 10, rows: 10, minFill: 1.0,
      buckets: {
        Beginner: { need: 52, maxScore: 420 },
        Medium: { need: 204, minScore: 390, maxScore: 465 },
        Hard: { need: 204, minScore: 450, maxScore: 640 },
        Expert: { need: 52, minScore: 610 },
      },
      budgetSec: 360, perPuzzleMs: 25000,
    },

    // ---- Oversized bonus tails (10 per bonus book) + Lattice showcase
    { group: 'bonus-oversized', pool: 'white_12x12', cols: 12, rows: 12, style: 'white', total: 12, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'black_12x12', cols: 12, rows: 12, style: 'black', total: 12, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'tallsky_6x30', cols: 6, rows: 30, total: 14, budgetSec: 90, perPuzzleMs: 30000 },
    { group: 'bonus-oversized', pool: 'sym_rot180_12x12', cols: 12, rows: 12, layout: 'rot180', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'sym_mirror_12x12', cols: 12, rows: 12, layout: 'mirror', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'sym_transpose_12x12', cols: 12, rows: 12, layout: 'transpose', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-yinyang', pool: 'yinyang_12x12', cols: 12, rows: 12, layout: 'yinyang', total: 5, budgetSec: 120, perPuzzleMs: 30000 },
    { group: 'bonus-yinyang', pool: 'yinyang_mirror_12x12', cols: 12, rows: 12, layout: 'yinyang-mirror', total: 5, budgetSec: 180, perPuzzleMs: 30000 },
    { group: 'bonus-yinyang', pool: 'yinyang_transpose_12x12', cols: 12, rows: 12, layout: 'yinyang-transpose', total: 5, budgetSec: 240, perPuzzleMs: 35000 },
    // ---- Bonus: Black & White Cookie (left/right, top/bottom, and diagonal W/B half-splits)
    {
      group: 'bonus-cookie', pool: 'cookie_vert_10x10', cols: 10, rows: 10, layout: 'cookie',
      buckets: {
        Beginner: { need: 18, maxScore: 375 },
        Medium: { need: 68, minScore: 345, maxScore: 430 },
        Hard: { need: 68, minScore: 415, maxScore: 625 },
        Expert: { need: 18, minScore: 600 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-cookie', pool: 'cookie_horiz_10x10', cols: 10, rows: 10, layout: 'cookie-horiz',
      buckets: {
        Beginner: { need: 18, maxScore: 375 },
        Medium: { need: 68, minScore: 345, maxScore: 430 },
        Hard: { need: 68, minScore: 415, maxScore: 625 },
        Expert: { need: 18, minScore: 600 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-cookie', pool: 'cookie_diag_10x10', cols: 10, rows: 10, layout: 'cookie-diag',
      buckets: {
        Beginner: { need: 18, maxScore: 375 },
        Medium: { need: 68, minScore: 345, maxScore: 430 },
        Hard: { need: 68, minScore: 415, maxScore: 625 },
        Expert: { need: 18, minScore: 600 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    { group: 'bonus-cookie', pool: 'cookie_vert_12x12', cols: 12, rows: 12, layout: 'cookie', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-cookie', pool: 'cookie_horiz_12x12', cols: 12, rows: 12, layout: 'cookie-horiz', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-cookie', pool: 'cookie_diag_12x12', cols: 12, rows: 12, layout: 'cookie-diag', total: 5, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'full_10x12', cols: 10, rows: 12, minFill: 1.0, total: 12, budgetSec: 90, perPuzzleMs: 25000 },
    { group: 'bonus-oversized', pool: 'lattice_13x13', cols: 13, rows: 13, layout: 'lattice', total: 14, budgetSec: 180, perPuzzleMs: 35000 },
  ];

  const groups = onlyGroup === 'all' ? null : new Set(onlyGroup.split(','));
  const selected = groups ? JOBS.filter((j) => groups.has(j.group)) : JOBS;

  async function runBucketedJob(job, jobIdx) {
    const outPath = path.join(libDir, `${job.pool}.csv`);
    const seen = new Set();
    const have = {};
    for (const k of Object.keys(job.buckets)) have[k] = 0;
    let totalHave = 0;
    if (fs.existsSync(outPath)) {
      for (const p of parseCsv(fs.readFileSync(outPath, 'utf8'))) {
        seen.add(symmetryKey(p));
        totalHave++;
        const b = bucketOf(p, job.buckets);
        if (b) have[b]++;
      }
    } else {
      fs.writeFileSync(outPath, CSV_HEADER + '\n', 'utf8');
    }

    const deficits = {};
    let totalNeed = 0;
    for (const [k, spec] of Object.entries(job.buckets)) {
      deficits[k] = Math.max(0, spec.need - have[k]);
      totalNeed += deficits[k];
    }
    const fmtCounts = () => Object.entries(job.buckets).map(([k, s]) => `${k}=${have[k]}/${s.need}`).join(' ');
    if (totalNeed === 0) {
      console.log(`[skip] ${job.pool}: ${fmtCounts()}`);
      return;
    }

    const wCount = Math.min(numWorkers, Math.max(1, totalNeed));
    const t0 = Date.now();
    const baseSeed = 50000 + jobIdx * 10000 + totalHave * 13;
    console.log(`[start] ${job.pool}: need ${totalNeed} (${fmtCounts()}) across ${wCount} workers...`);

    const pendingRows = [];
    const flush = () => {
      if (!pendingRows.length) return;
      fs.appendFileSync(outPath, pendingRows.join('\n') + '\n', 'utf8');
      pendingRows.length = 0;
    };

    const workers = [];
    let added = 0;
    let lastLog = Date.now();

    const broadcast = (msg) => {
      for (const w of workers) {
        try { w.postMessage(msg); } catch { /* exited */ }
      }
    };

    const donePromises = [];
    for (let i = 0; i < wCount; i++) {
      donePromises.push(new Promise((resolve, reject) => {
        const w = new Worker(new URL(import.meta.url), {
          workerData: {
            job,
            seedStart: baseSeed + i * 131,
            budgetMs: (job.budgetSec || 300) * 1000,
            initialDeficits: { ...deficits },
          },
        });
        workers.push(w);
        w.on('message', (msg) => {
          if (msg.type === 'done') return resolve();
          if (msg.type !== 'puzzle') return;
          if (seen.has(msg.key)) return;
          if ((deficits[msg.bucket] || 0) <= 0) return;
          seen.add(msg.key);
          have[msg.bucket]++;
          deficits[msg.bucket]--;
          totalNeed--;
          added++;
          pendingRows.push(msg.row);
          if (pendingRows.length >= 15) flush();

          const bucketFilled = deficits[msg.bucket] === 0;
          if (totalNeed <= 0) {
            flush();
            broadcast({ stop: true });
          } else if (bucketFilled || added % 25 === 0) {
            broadcast({ deficits: { ...deficits } });
          }
          if (Date.now() - lastLog >= 15000 || bucketFilled) {
            lastLog = Date.now();
            const dt = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`  [${job.pool} ${dt}s] +${added} | ${fmtCounts()}`);
          }
        });
        w.on('error', reject);
        w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exit ${code}`)); else resolve(); });
      }));
    }

    await Promise.all(donePromises);
    flush();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[done] ${job.pool}: +${added} in ${dt}s | ${fmtCounts()}`);
  }

  async function runJob(job, jobIdx) {
    if (job.buckets) return runBucketedJob(job, jobIdx);
    const outPath = path.join(libDir, `${job.pool}.csv`);
    const seen = new Set();
    const tierHave = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0, 'Expert+': 0 };
    let totalHave = 0;
    if (fs.existsSync(outPath)) {
      for (const p of parseCsv(fs.readFileSync(outPath, 'utf8'))) {
        seen.add(symmetryKey(p));
        totalHave++;
        const k = p.rules === 'unsolved' ? 'Expert+' : p.tier;
        tierHave[k] = (tierHave[k] || 0) + 1;
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
}
