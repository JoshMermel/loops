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
      if (dP > 0 && dB + dM + dH + dE === 0) return { targetTier: 'Expert+', stripMode: 'deep', allowUnsolved: true };
      const r = rng() * tot;
      if (r < dB) return { targetTier: null, stripMode: 'beginner', allowUnsolved: false };
      if (r < dB + dM) return { targetTier: null, stripMode: 'medium', allowUnsolved: false };
      return { targetTier: null, stripMode: 'deep', allowUnsolved: dP > 0 };
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
          maxTier: 'Expert',
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
        Medium: { need: 505, minScore: 235, maxScore: 310 },
        Hard: { need: 505, minScore: 310, maxScore: 520 },
        Expert: { need: 505, minScore: 520 },
        'Expert+': { need: 12 },
      },
      budgetSec: 480, perPuzzleMs: 12000,
    },
    {
      group: 'core', pool: 'balanced_12x12', cols: 12, rows: 12,
      buckets: {
        Beginner: { need: 505, maxScore: 535 },
        Medium: { need: 505, minScore: 535, maxScore: 660 },
        Hard: { need: 505, minScore: 660, maxScore: 1050 },
        Expert: { need: 505, minScore: 1050 },
        'Expert+': { need: 12 },
      },
      budgetSec: 1200, perPuzzleMs: 25000,
    },

    // ---- Giants: 16x16 (200), 12x20 (100), 24x30 Full Page (60)
    {
      group: 'giants', pool: 'balanced_16x16', cols: 16, rows: 16,
      buckets: {
        Beginner: { need: 52, maxScore: 940 },
        Medium: { need: 52, minScore: 940, maxScore: 1100 },
        Hard: { need: 52, minScore: 1100, maxScore: 1650 },
        Expert: { need: 52, minScore: 1650 },
      },
      budgetSec: 600, perPuzzleMs: 30000,
    },
    {
      group: 'giants', pool: 'balanced_12x20', cols: 12, rows: 20,
      buckets: {
        Beginner: { need: 26, maxScore: 900 },
        Medium: { need: 26, minScore: 900, maxScore: 1050 },
        Hard: { need: 26, minScore: 1050, maxScore: 1650 },
        Expert: { need: 26, minScore: 1650 },
      },
      budgetSec: 600, perPuzzleMs: 35000,
    },
    {
      group: 'giants', pool: 'balanced_24x30', cols: 24, rows: 30,
      buckets: {
        Beginner: { need: 16, maxScore: 2580 },
        Medium: { need: 16, minScore: 2520, maxScore: 2750 },
        Hard: { need: 16, minScore: 2750, maxScore: 3300 },
        Expert: { need: 16, minScore: 3300 },
      },
      budgetSec: 900, perPuzzleMs: 45000,
    },

    // ---- Bonus pools (500 at 10/40/40/10 with score bands + oversized bonus tails + Lattice showcase)
    {
      group: 'bonus', pool: 'white_8x8', cols: 8, rows: 8, style: 'white',
      buckets: {
        Beginner: { need: 52, maxScore: 275 },
        Medium: { need: 204, minScore: 265, maxScore: 345 },
        Hard: { need: 204, minScore: 345, maxScore: 650 },
        Expert: { need: 52, minScore: 650 },
      },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'bonus', pool: 'black_10x10', cols: 10, rows: 10, style: 'black',
      buckets: {
        Beginner: { need: 52, maxScore: 350 },
        Medium: { need: 204, minScore: 335, maxScore: 405 },
        Hard: { need: 204, minScore: 390, maxScore: 680 },
        Expert: { need: 52, minScore: 680 },
      },
      budgetSec: 600, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sky_6x20', cols: 6, rows: 20,
      buckets: {
        Beginner: { need: 52, maxScore: 480 },
        Medium: { need: 204, minScore: 430, maxScore: 550 },
        Hard: { need: 204, minScore: 550, maxScore: 900 },
        Expert: { need: 52, minScore: 880 },
      },
      budgetSec: 480, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_rot180_10x10', cols: 10, rows: 10, layout: 'rot180',
      buckets: {
        Beginner: { need: 18, maxScore: 360 },
        Medium: { need: 68, minScore: 340, maxScore: 440 },
        Hard: { need: 68, minScore: 440, maxScore: 760 },
        Expert: { need: 18, minScore: 760 },
      },
      budgetSec: 360, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_mirror_10x10', cols: 10, rows: 10, layout: 'mirror',
      buckets: {
        Beginner: { need: 18, maxScore: 360 },
        Medium: { need: 68, minScore: 340, maxScore: 440 },
        Hard: { need: 68, minScore: 440, maxScore: 760 },
        Expert: { need: 18, minScore: 760 },
      },
      budgetSec: 360, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_transpose_10x10', cols: 10, rows: 10, layout: 'transpose',
      buckets: {
        Beginner: { need: 18, maxScore: 360 },
        Medium: { need: 68, minScore: 340, maxScore: 440 },
        Hard: { need: 68, minScore: 440, maxScore: 760 },
        Expert: { need: 18, minScore: 760 },
      },
      budgetSec: 360, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_10x10', cols: 10, rows: 10, layout: 'yinyang',
      buckets: {
        Beginner: { need: 18, maxScore: 355 },
        Medium: { need: 68, minScore: 340, maxScore: 460 },
        Hard: { need: 68, minScore: 460, maxScore: 780 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 480, perPuzzleMs: 25000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_mirror_10x10', cols: 10, rows: 10, layout: 'yinyang-mirror',
      buckets: {
        Beginner: { need: 18, maxScore: 355 },
        Medium: { need: 68, minScore: 340, maxScore: 460 },
        Hard: { need: 68, minScore: 460, maxScore: 780 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 600, perPuzzleMs: 25000,
    },
    {
      group: 'bonus-yinyang', pool: 'yinyang_transpose_10x10', cols: 10, rows: 10, layout: 'yinyang-transpose',
      buckets: {
        Beginner: { need: 18, maxScore: 355 },
        Medium: { need: 68, minScore: 340, maxScore: 460 },
        Hard: { need: 68, minScore: 460, maxScore: 780 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 720, perPuzzleMs: 25000,
    },
    {
      group: 'bonus', pool: 'full_10x10', cols: 10, rows: 10, minFill: 1.0,
      buckets: {
        Beginner: { need: 52, maxScore: 425 },
        Medium: { need: 204, minScore: 400, maxScore: 485 },
        Hard: { need: 204, minScore: 480, maxScore: 850 },
        Expert: { need: 52, minScore: 820 },
      },
      budgetSec: 720, perPuzzleMs: 25000,
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
        Medium: { need: 68, minScore: 355, maxScore: 470 },
        Hard: { need: 68, minScore: 470, maxScore: 800 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-cookie', pool: 'cookie_horiz_10x10', cols: 10, rows: 10, layout: 'cookie-horiz',
      buckets: {
        Beginner: { need: 18, maxScore: 375 },
        Medium: { need: 68, minScore: 355, maxScore: 470 },
        Hard: { need: 68, minScore: 470, maxScore: 800 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus-cookie', pool: 'cookie_diag_10x10', cols: 10, rows: 10, layout: 'cookie-diag',
      buckets: {
        Beginner: { need: 18, maxScore: 375 },
        Medium: { need: 68, minScore: 355, maxScore: 470 },
        Hard: { need: 68, minScore: 470, maxScore: 800 },
        Expert: { need: 18, minScore: 780 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
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
