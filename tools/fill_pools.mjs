#!/usr/bin/env node
// Multi-core pool filler for Masyu using worker_threads.
// Supports both single-tier jobs and streaming multi-bucket jobs with score bands & Expert+.
// Independently verifies every puzzle (valid solution, exact uniqueness, human-rated) before storing.
//
// Usage:
//   node tools/fill_pools.mjs [--workers 9] [--only groupName]
//
// Groups: core | giants | bonus | bonus-cookie | bonus-gray | full-board | swiss | slither | slither-classic | midloop | midloop-classic | midloop-bonus | slither-hybrid-grow | gray-hybrid-token | castle-hybrids | castle-classic | castle-bonus | corral-intro | corral-hybrids | corral-classic | variants-token | intro-extra | bonus-patterns | bonus-finales | all (default: all)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { toCsvRow, parseCsv, CSV_HEADER, symmetryKey } from '../js/logic.js';
import { generatePuzzle, makeRng } from '../js/generator.js';
import { repoRoot, arg, verifyPuzzle } from './_cli.mjs';

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
      const activeTiers = [];
      if (dB > 0) activeTiers.push('Beginner');
      if (dM > 0) activeTiers.push('Medium');
      if (dH > 0) activeTiers.push('Hard');
      if (dE > 0) activeTiers.push('Expert');
      if (dP > 0) activeTiers.push('Expert+');
      if (activeTiers.length === 1) {
        const only = activeTiers[0];
        if (only === 'Expert+') return { targetTier: 'Expert+', maxTier: 'Expert', stripMode: 'deep', allowUnsolved: true };
        return {
          targetTier: only,
          maxTier: only,
          stripMode: only === 'Beginner' ? 'beginner' : only === 'Medium' ? 'medium' : 'deep',
          allowUnsolved: false,
        };
      }
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
        // Skip independent re-verification when the puzzle already falls outside needed buckets
        const preB = bucketOf(p, job.buckets);
        if (!preB || (deficits[preB] || 0) <= 0) continue;
        // Independent re-verification
        const r = verifyPuzzle(p);
        if (!r) continue;
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
      const r = verifyPuzzle(p);
      if (!r) continue;
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
  const rawWorkers = Number(arg('workers', Math.max(1, os.cpus().length - 1)));
  if (!Number.isFinite(rawWorkers) || rawWorkers < 1) {
    console.error(`Invalid --workers value: ${arg('workers')}`);
    process.exit(1);
  }
  const numWorkers = Math.max(1, Math.min(os.cpus().length, Math.trunc(rawWorkers)));
  const onlyGroup = arg('only', 'all');
  const libDir = path.resolve(repoRoot(import.meta.url), 'tools', 'library');
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
        Expert: { need: 505, minScore: 420, maxScore: 900 },
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
        Expert: { need: 505, minScore: 820, maxScore: 1700 },
        'Expert+': { need: 12 },
      },
      budgetSec: 600, perPuzzleMs: 25000,
    },

    // ---- Giants: 16x16, 12x20, and 16x24 (500 per tier across all 4 tiers + 10 Expert+, matching 8x8 & 12x12)
    {
      group: 'giants', pool: 'balanced_16x16', cols: 16, rows: 16,
      buckets: {
        Beginner: { need: 505, maxScore: 950 },
        Medium: { need: 505, minScore: 870, maxScore: 1050 },
        Hard: { need: 505, minScore: 990, maxScore: 1450 },
        Expert: { need: 505, minScore: 1350, maxScore: 3000 },
        'Expert+': { need: 12 },
      },
      budgetSec: 900, perPuzzleMs: 30000,
    },
    {
      group: 'giants', pool: 'balanced_12x20', cols: 12, rows: 20,
      buckets: {
        Beginner: { need: 505, maxScore: 890 },
        Medium: { need: 505, minScore: 815, maxScore: 980 },
        Hard: { need: 505, minScore: 940, maxScore: 1350 },
        Expert: { need: 505, minScore: 1240, maxScore: 2800 },
        'Expert+': { need: 12 },
      },
      budgetSec: 900, perPuzzleMs: 35000,
    },
    {
      group: 'giants', pool: 'balanced_16x24', cols: 16, rows: 24,
      buckets: {
        Beginner: { need: 505, maxScore: 1420 },
        Medium: { need: 505, minScore: 1310, maxScore: 1550 },
        Hard: { need: 505, minScore: 1480, maxScore: 2150 },
        Expert: { need: 505, minScore: 2050, maxScore: 3900 },
        'Expert+': { need: 12 },
      },
      budgetSec: 900, perPuzzleMs: 30000,
    },

    // ---- Bonus pools (500 at 10/40/40/10 with score bands + oversized bonus tails + Lattice showcase)
    {
      group: 'bonus', pool: 'white_8x8', cols: 8, rows: 8, style: 'white',
      buckets: {
        Beginner: { need: 52, maxScore: 265 },
        Medium: { need: 204, minScore: 240, maxScore: 305 },
        Hard: { need: 204, minScore: 300, maxScore: 485 },
        Expert: { need: 52, minScore: 470, maxScore: 950 },
      },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'bonus', pool: 'black_10x10', cols: 10, rows: 10, style: 'black',
      buckets: {
        Beginner: { need: 52, maxScore: 345 },
        Medium: { need: 204, minScore: 315, maxScore: 380 },
        Hard: { need: 204, minScore: 365, maxScore: 510 },
        Expert: { need: 52, minScore: 500, maxScore: 1100 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sky_6x20', cols: 6, rows: 20,
      buckets: {
        Beginner: { need: 52, maxScore: 455 },
        Medium: { need: 204, minScore: 415, maxScore: 505 },
        Hard: { need: 204, minScore: 480, maxScore: 730 },
        Expert: { need: 52, minScore: 700, maxScore: 1300 },
      },
      budgetSec: 300, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_rot180_10x10', cols: 10, rows: 10, layout: 'rot180',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_mirror_10x10', cols: 10, rows: 10, layout: 'mirror',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    {
      group: 'bonus', pool: 'sym_transpose_10x10', cols: 10, rows: 10, layout: 'transpose',
      buckets: {
        Beginner: { need: 18, maxScore: 365 },
        Medium: { need: 68, minScore: 315, maxScore: 420 },
        Hard: { need: 68, minScore: 375, maxScore: 600 },
        Expert: { need: 18, minScore: 570, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },

    // ---- Bonus: Gray pearls (mixed white/black/gray & all-gray 8x8 + Expert+ + Mega finales)
    {
      group: 'bonus-gray', pool: 'gray_8x8', cols: 8, rows: 8, style: 'gray-mixed',
      buckets: {
        Beginner: { need: 52, maxScore: 265 },
        Medium: { need: 204, minScore: 235, maxScore: 315 },
        Hard: { need: 204, minScore: 300, maxScore: 540 },
        Expert: { need: 52, minScore: 520, maxScore: 1500 },
        'Expert+': { need: 12 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },
    { group: 'bonus-gray', pool: 'gray_12x20', cols: 12, rows: 20, style: 'gray-mixed', total: 12, budgetSec: 120, perPuzzleMs: 25000 },
    {
      group: 'bonus-gray', pool: 'allgray_8x8', cols: 8, rows: 8, style: 'gray-all',
      buckets: {
        Beginner: { need: 52, maxScore: 270 },
        Medium: { need: 204, minScore: 245, maxScore: 325 },
        Hard: { need: 204, minScore: 310, maxScore: 520 },
        Expert: { need: 52, minScore: 500, maxScore: 1600 },
        'Expert+': { need: 12 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },
    { group: 'bonus-gray', pool: 'allgray_10x12', cols: 10, rows: 12, style: 'gray-all', total: 12, budgetSec: 120, perPuzzleMs: 25000 },

    // ---- Full board (top-level section: 8x8 true full-board Masyu + no-circle given lines, walls, and mixed)
    {
      group: 'full-board', pool: 'full_masyu_8x8', cols: 8, rows: 8, style: 'full-masyu',
      buckets: {
        Beginner: { need: 52, maxScore: 245 },
        Medium: { need: 204, minScore: 210, maxScore: 295 },
        Hard: { need: 204, minScore: 265, maxScore: 520 },
        Expert: { need: 52, minScore: 470, maxScore: 1300 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },
    {
      group: 'full-board', pool: 'full_lines_8x8', cols: 8, rows: 8, style: 'full-lines',
      buckets: {
        Beginner: { need: 52, maxScore: 245 },
        Medium: { need: 204, minScore: 215, maxScore: 295 },
        Hard: { need: 204, minScore: 255, maxScore: 480 },
        Expert: { need: 52, minScore: 430, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },
    {
      group: 'full-board', pool: 'full_walls_8x8', cols: 8, rows: 8, style: 'full-walls',
      buckets: {
        Beginner: { need: 52, maxScore: 255 },
        Medium: { need: 204, minScore: 220, maxScore: 300 },
        Hard: { need: 204, minScore: 265, maxScore: 480 },
        Expert: { need: 52, minScore: 430, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },
    {
      group: 'full-board', pool: 'full_mixed_8x8', cols: 8, rows: 8, style: 'full-mixed',
      buckets: {
        Beginner: { need: 52, maxScore: 255 },
        Medium: { need: 204, minScore: 220, maxScore: 300 },
        Hard: { need: 204, minScore: 265, maxScore: 500 },
        Expert: { need: 52, minScore: 450, maxScore: 1200 },
      },
      budgetSec: 240, perPuzzleMs: 12000,
    },

    // ---- Swiss cheese (top-level section: 10x10, 12x12, 16x16, 12x20 — 500 core + 10 Expert+ each)
    {
      group: 'swiss', pool: 'shaped_swiss_10x10', cols: 10, rows: 10, style: 'swiss-cheese',
      buckets: {
        Beginner: { need: 52, maxScore: 350 },
        Medium: { need: 204, minScore: 300, maxScore: 410 },
        Hard: { need: 204, minScore: 355, maxScore: 620 },
        Expert: { need: 52, minScore: 520, maxScore: 1300 },
        'Expert+': { need: 10 },
      },
      budgetSec: 180, perPuzzleMs: 12000,
    },
    {
      group: 'swiss', pool: 'swiss_12x12', cols: 12, rows: 12, style: 'swiss-cheese',
      buckets: {
        Beginner: { need: 52, maxScore: 485 },
        Medium: { need: 204, minScore: 440, maxScore: 560 },
        Hard: { need: 204, minScore: 490, maxScore: 820 },
        Expert: { need: 52, minScore: 600, maxScore: 1700 },
        'Expert+': { need: 10 },
      },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'swiss', pool: 'swiss_16x16', cols: 16, rows: 16, style: 'swiss-cheese',
      buckets: {
        Beginner: { need: 52, maxScore: 870 },
        Medium: { need: 204, minScore: 780, maxScore: 960 },
        Hard: { need: 204, minScore: 890, maxScore: 1350 },
        Expert: { need: 52, minScore: 1100, maxScore: 2900 },
        'Expert+': { need: 10 },
      },
      budgetSec: 360, perPuzzleMs: 25000,
    },
    {
      group: 'swiss', pool: 'swiss_12x20', cols: 12, rows: 20, style: 'swiss-cheese',
      buckets: {
        Beginner: { need: 52, maxScore: 810 },
        Medium: { need: 204, minScore: 725, maxScore: 900 },
        Hard: { need: 204, minScore: 800, maxScore: 1250 },
        Expert: { need: 52, minScore: 1020, maxScore: 2700 },
        'Expert+': { need: 10 },
      },
      budgetSec: 360, perPuzzleMs: 25000,
    },

    // ---- Bonus: Black & White Cookie (arbitrary-angle W/B half-splits through board center)
    {
      group: 'bonus-cookie', pool: 'cookie_angle_10x10', cols: 10, rows: 10, layout: 'cookie-angle',
      buckets: {
        Beginner: { need: 52, maxScore: 375 },
        Medium: { need: 204, minScore: 345, maxScore: 430 },
        Hard: { need: 204, minScore: 415, maxScore: 625 },
        Expert: { need: 52, minScore: 600, maxScore: 1200 },
        'Expert+': { need: 12 },
      },
      budgetSec: 240, perPuzzleMs: 20000,
    },
    { group: 'bonus-cookie', pool: 'cookie_angle_12x20', cols: 12, rows: 20, layout: 'cookie-angle', total: 12, budgetSec: 120, perPuzzleMs: 30000 },

    // ---- Bonus: Geometric Patterns & Wallpapers (all-square 9x9 / 10x10 / 13x13 masks for `bonus-patterns`)
    { group: 'bonus-patterns', pool: 'lattice_9x9', cols: 9, rows: 9, layout: 'lattice', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'lattice_13x13', cols: 13, rows: 13, layout: 'lattice', total: 14, budgetSec: 180, perPuzzleMs: 35000 },
    { group: 'bonus-patterns', pool: 'pat_blocks2x2_9x9', cols: 9, rows: 9, layout: 'blocks2x2', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_quilt2x2_10x10', cols: 10, rows: 10, layout: 'quilt2x2', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_circle_10x10', cols: 10, rows: 10, layout: 'circle-ring', total: 22, budgetSec: 90, perPuzzleMs: 15000 },
    { group: 'bonus-patterns', pool: 'pat_honeycomb_10x10', cols: 10, rows: 10, layout: 'honeycomb', total: 25, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-patterns', pool: 'pat_pillars_9x9', cols: 9, rows: 9, layout: 'pillars', total: 30, budgetSec: 30, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_hourglass_10x10', cols: 10, rows: 10, layout: 'hourglass', total: 22, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-patterns', pool: 'pat_brackets_10x10', cols: 10, rows: 10, layout: 'brackets', total: 22, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-patterns', pool: 'pat_xbracket_9x9', cols: 9, rows: 9, layout: 'x-bracket', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_spiral_10x10', cols: 10, rows: 10, layout: 'spiral', total: 18, budgetSec: 90, perPuzzleMs: 15000 },
    { group: 'bonus-patterns', pool: 'pat_stairs_9x9', cols: 9, rows: 9, layout: 'stairs', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_smallx_9x9', cols: 9, rows: 9, layout: 'small-x', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_bricks_10x10', cols: 10, rows: 10, layout: 'bricks', total: 25, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_dominoes_10x10', cols: 10, rows: 10, layout: 'dominoes', total: 25, budgetSec: 30, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_ltiles_10x10', cols: 10, rows: 10, layout: 'ltiles', total: 25, budgetSec: 30, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_mirrorltiles_10x10', cols: 10, rows: 10, layout: 'mirror-ltiles', total: 25, budgetSec: 30, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_herringbone_10x10', cols: 10, rows: 10, layout: 'herringbone', total: 22, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_slashes_10x10', cols: 10, rows: 10, layout: 'slashes', total: 22, budgetSec: 45, perPuzzleMs: 12000 },
    { group: 'bonus-patterns', pool: 'pat_zigzags_10x10', cols: 10, rows: 10, layout: 'zigzags', total: 22, budgetSec: 60, perPuzzleMs: 15000 },

    // ---- Bonus Finales: 10 Expert+ (normal size) + 10 Mega (2x-3x area) per 500-puzzle Bonus book
    // Expert+ (beyond hints) appended into normal-size bonus pools
    { group: 'bonus-finales', pool: 'white_8x8', cols: 8, rows: 8, style: 'white', tier: 'Expert+', totalTier: 12, budgetSec: 90, perPuzzleMs: 15000 },
    { group: 'bonus-finales', pool: 'black_10x10', cols: 10, rows: 10, style: 'black', tier: 'Expert+', totalTier: 12, budgetSec: 120, perPuzzleMs: 20000 },
    { group: 'bonus-finales', pool: 'sky_6x20', cols: 6, rows: 20, tier: 'Expert+', totalTier: 12, budgetSec: 120, perPuzzleMs: 20000 },
    { group: 'bonus-finales', pool: 'sym_rot180_10x10', cols: 10, rows: 10, layout: 'rot180', tier: 'Expert+', totalTier: 5, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-finales', pool: 'sym_mirror_10x10', cols: 10, rows: 10, layout: 'mirror', tier: 'Expert+', totalTier: 5, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-finales', pool: 'sym_transpose_10x10', cols: 10, rows: 10, layout: 'transpose', tier: 'Expert+', totalTier: 5, budgetSec: 60, perPuzzleMs: 15000 },

    // Mega-sized themed boards (2x-3x normal area)
    { group: 'bonus-finales', pool: 'white_12x20', cols: 12, rows: 20, style: 'white', total: 12, budgetSec: 180, perPuzzleMs: 30000 },
    { group: 'bonus-finales', pool: 'black_12x20', cols: 12, rows: 20, style: 'black', total: 12, budgetSec: 120, perPuzzleMs: 25000 },
    { group: 'bonus-finales', pool: 'tallsky_6x40', cols: 6, rows: 40, total: 12, budgetSec: 60, perPuzzleMs: 15000 },
    { group: 'bonus-finales', pool: 'sym_rot180_14x14', cols: 14, rows: 14, layout: 'rot180', total: 5, budgetSec: 60, perPuzzleMs: 20000 },
    { group: 'bonus-finales', pool: 'sym_mirror_14x14', cols: 14, rows: 14, layout: 'mirror', total: 5, budgetSec: 60, perPuzzleMs: 20000 },
    { group: 'bonus-finales', pool: 'sym_transpose_14x14', cols: 14, rows: 14, layout: 'transpose', total: 5, budgetSec: 90, perPuzzleMs: 20000 },

    // ---- Slitherlink Classic (per-size/per-difficulty 500-puzzle books, like Masyu) & Hybrids
    {
      group: 'slither-classic', pool: 'slither_8x8', cols: 8, rows: 8, style: 'slither',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 360, perPuzzleMs: 12000,
    },
    {
      group: 'slither-classic', pool: 'slither_11x11', cols: 11, rows: 11, style: 'slither',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 600, perPuzzleMs: 18000,
    },
    {
      group: 'slither-classic', pool: 'slither_13x13', cols: 13, rows: 13, style: 'slither',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 900, perPuzzleMs: 22000,
    },
    {
      group: 'slither-classic', pool: 'slither_11x17', cols: 11, rows: 17, style: 'slither',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1200, perPuzzleMs: 25000,
    },
    {
      group: 'slither', pool: 'hybrid_slither_masyu_8x8', cols: 8, rows: 8, style: 'slither-masyu',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 15000,
    },
    {
      group: 'slither', pool: 'hybrid_slither_full_8x8', cols: 8, rows: 8, style: 'slither-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 15000,
    },

    // ---- Variant pools for Hamilton cycle, Slitherlink, and Hybrids (full-size 500-puzzle books)
    {
      group: 'variants-token', pool: 'full_swiss_10x10', cols: 10, rows: 10, style: 'full-swiss',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 12000,
    },
    {
      group: 'variants-token', pool: 'full_sym_rot180_8x8', cols: 8, rows: 8, style: 'full-mixed', layout: 'rot180',
      buckets: { Beginner: { need: 26 }, Medium: { need: 102 }, Hard: { need: 102 }, Expert: { need: 26 } },
      budgetSec: 180, perPuzzleMs: 10000,
    },
    {
      group: 'variants-token', pool: 'full_sym_mirror_8x8', cols: 8, rows: 8, style: 'full-mixed', layout: 'mirror',
      buckets: { Beginner: { need: 26 }, Medium: { need: 102 }, Hard: { need: 102 }, Expert: { need: 26 } },
      budgetSec: 180, perPuzzleMs: 10000,
    },
    {
      group: 'variants-token', pool: 'slither_swiss_10x10', cols: 10, rows: 10, style: 'slither-swiss',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 15000,
    },
    {
      group: 'variants-token', pool: 'slither_sky_6x18', cols: 6, rows: 18, style: 'slither',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 18000,
    },
    {
      group: 'variants-token', pool: 'slither_sym_rot180_9x9', cols: 9, rows: 9, style: 'slither', layout: 'rot180',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'variants-token', pool: 'slither_sym_mirror_9x9', cols: 9, rows: 9, style: 'slither', layout: 'mirror',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'variants-token', pool: 'slither_sym_transpose_9x9', cols: 9, rows: 9, style: 'slither', layout: 'transpose',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'variants-token', pool: 'slither_all3_8x8', cols: 8, rows: 8, style: 'slither-all3',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 12000,
    },
    {
      group: 'variants-token', pool: 'hybrid_slither2_full_6x7', cols: 6, rows: 7, style: 'slither-all2-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 300, perPuzzleMs: 15000,
    },

    // ---- Start here: Beginner intro pools for Slitherlink and Hamilton cycle
    { group: 'intro-extra', pool: 'intro_slither_5x5', cols: 5, rows: 5, style: 'slither', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 6000 },
    { group: 'intro-extra', pool: 'intro_slither_6x6', cols: 6, rows: 6, style: 'slither', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 8000 },
    { group: 'intro-extra', pool: 'intro_ham_lines_4x6', cols: 4, rows: 6, style: 'full-lines', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 6000 },
    { group: 'intro-extra', pool: 'intro_ham_walls_4x6', cols: 4, rows: 6, style: 'full-walls', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 6000 },
    { group: 'intro-extra', pool: 'intro_ham_mixed_4x6', cols: 4, rows: 6, style: 'full-mixed', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 6000 },
    { group: 'intro-extra', pool: 'intro_ham_lines_6x6', cols: 6, rows: 6, style: 'full-lines', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 8000 },
    { group: 'intro-extra', pool: 'intro_ham_walls_6x6', cols: 6, rows: 6, style: 'full-walls', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 8000 },
    { group: 'intro-extra', pool: 'intro_ham_mixed_6x6', cols: 6, rows: 6, style: 'full-mixed', tier: 'Beginner', total: 9, budgetSec: 30, perPuzzleMs: 8000 },

    // ---- Mid-loop Intro (100) & Hybrids (500 each at 50 B / 200 M / 200 H / 50 E)
    { group: 'midloop', pool: 'intro_midloop_6x6', cols: 6, rows: 6, style: 'midloop', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 6000 },
    { group: 'midloop', pool: 'intro_midloop_7x7', cols: 7, rows: 7, style: 'midloop', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 8000 },
    {
      group: 'midloop', pool: 'hybrid_midloop_masyu_8x8', cols: 8, rows: 8, style: 'midloop-masyu',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'midloop', pool: 'hybrid_midloop_slither_8x8', cols: 8, rows: 8, style: 'midloop-slither',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'midloop', pool: 'hybrid_midloop_full_8x8', cols: 8, rows: 8, style: 'midloop-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },

    // ---- Mid-loop Classic (per-size/per-difficulty 500-puzzle books, like Masyu, Slitherlink & Castle Wall)
    {
      group: 'midloop-classic', pool: 'midloop_7x7', cols: 7, rows: 7, style: 'midloop',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 420, perPuzzleMs: 12000,
    },
    {
      group: 'midloop-classic', pool: 'midloop_10x10', cols: 10, rows: 10, style: 'midloop',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 720, perPuzzleMs: 18000,
    },
    {
      group: 'midloop-classic', pool: 'midloop_12x12', cols: 12, rows: 12, style: 'midloop',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1200, perPuzzleMs: 22000,
    },
    {
      group: 'midloop-classic', pool: 'midloop_10x16', cols: 10, rows: 16, style: 'midloop',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1500, perPuzzleMs: 25000,
    },

    // ---- Mid-loop Bonus pools (500-puzzle books at 50 B / 200 M / 200 H / 50 E)
    {
      group: 'midloop-bonus', pool: 'midloop_even_7x7', cols: 7, rows: 7, style: 'midloop-even',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 12000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_odd_9x9', cols: 9, rows: 9, style: 'midloop-odd',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_swiss_10x10', cols: 10, rows: 10, style: 'midloop-swiss',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_sky_6x18', cols: 6, rows: 18, style: 'midloop',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 480, perPuzzleMs: 18000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_sym_rot180_9x9', cols: 9, rows: 9, style: 'midloop', layout: 'rot180',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_sym_mirror_9x9', cols: 9, rows: 9, style: 'midloop', layout: 'mirror',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },
    {
      group: 'midloop-bonus', pool: 'midloop_sym_transpose_9x9', cols: 9, rows: 9, style: 'midloop', layout: 'transpose',
      buckets: { Beginner: { need: 18 }, Medium: { need: 68 }, Hard: { need: 68 }, Expert: { need: 18 } },
      budgetSec: 240, perPuzzleMs: 15000,
    },

    // ---- Slitherlink Hybrid gimmick pools (grown to 500-puzzle books at 50 B / 200 M / 200 H / 50 E)
    {
      group: 'slither-hybrid-grow', pool: 'hybrid_slither_gray_8x8', cols: 8, rows: 8, style: 'slither-gray',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'slither-hybrid-grow', pool: 'hybrid_slither3_full_8x8', cols: 8, rows: 8, style: 'slither-all3-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'slither-hybrid-grow', pool: 'hybrid_midloop_slither2_8x8', cols: 8, rows: 8, style: 'midloop-slither2',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },

    // ---- Gray dots + each pure family token pools (24-puzzle tasting books at 4 B / 8 M / 8 H / 4 E)
    {
      group: 'gray-hybrid-token', pool: 'hybrid_gray_full_8x8', cols: 8, rows: 8, style: 'full-gray',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'gray-hybrid-token', pool: 'hybrid_midloop_gray_8x8', cols: 8, rows: 8, style: 'midloop-gray',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'gray-hybrid-token', pool: 'hybrid_castle_gray_8x8', cols: 8, rows: 8, style: 'castle-gray',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },

    // ---- Castle Wall Intro (100) + Hybrids (500 each at 50 B / 200 M / 200 H / 50 E)
    {
      group: 'castle-hybrids', pool: 'intro_castle_6x6', cols: 6, rows: 6, style: 'castle',
      buckets: { Beginner: { need: 55 } },
      budgetSec: 90, perPuzzleMs: 10000,
    },
    {
      group: 'castle-hybrids', pool: 'intro_castle_7x7', cols: 7, rows: 7, style: 'castle',
      buckets: { Beginner: { need: 55 } },
      budgetSec: 90, perPuzzleMs: 10000,
    },
    {
      group: 'castle-hybrids', pool: 'hybrid_castle_masyu_8x8', cols: 8, rows: 8, style: 'castle-masyu',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'castle-hybrids', pool: 'hybrid_castle_slither_8x8', cols: 8, rows: 8, style: 'castle-slither',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'castle-hybrids', pool: 'hybrid_castle_midloop_8x8', cols: 8, rows: 8, style: 'castle-midloop',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },
    {
      group: 'castle-hybrids', pool: 'hybrid_castle_full_8x8', cols: 8, rows: 8, style: 'castle-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 360, perPuzzleMs: 15000,
    },

    // ---- Castle Wall Classic (per-size/per-difficulty 500-puzzle books, like Masyu & Slitherlink)
    {
      group: 'castle-classic', pool: 'castle_7x7', cols: 7, rows: 7, style: 'castle',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 420, perPuzzleMs: 12000,
    },
    {
      group: 'castle-classic', pool: 'castle_10x10', cols: 10, rows: 10, style: 'castle',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 720, perPuzzleMs: 18000,
    },
    {
      group: 'castle-classic', pool: 'castle_12x12', cols: 12, rows: 12, style: 'castle',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1200, perPuzzleMs: 25000,
    },
    {
      group: 'castle-classic', pool: 'castle_10x16', cols: 10, rows: 16, style: 'castle',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1500, perPuzzleMs: 30000,
    },

    // ---- Castle Wall Bonus gimmick token pools (24-puzzle tasting books at 4 B / 8 M / 8 H / 4 E)
    {
      group: 'castle-bonus', pool: 'castle_allgray_8x8', cols: 8, rows: 8, style: 'castle-allgray',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_allwhite_8x8', cols: 8, rows: 8, style: 'castle-allwhite',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_allblack_8x8', cols: 8, rows: 8, style: 'castle-allblack',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_sky_6x18', cols: 6, rows: 18, style: 'castle',
      buckets: { Beginner: { need: 5 }, Medium: { need: 10 }, Hard: { need: 10 }, Expert: { need: 5 } },
      budgetSec: 120, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_sym_rot180_9x9', cols: 9, rows: 9, style: 'castle', layout: 'rot180',
      buckets: { Beginner: { need: 2 }, Medium: { need: 4 }, Hard: { need: 4 }, Expert: { need: 2 } },
      budgetSec: 90, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_sym_mirror_9x9', cols: 9, rows: 9, style: 'castle', layout: 'mirror',
      buckets: { Beginner: { need: 2 }, Medium: { need: 4 }, Hard: { need: 4 }, Expert: { need: 2 } },
      budgetSec: 90, perPuzzleMs: 15000,
    },
    {
      group: 'castle-bonus', pool: 'castle_sym_transpose_9x9', cols: 9, rows: 9, style: 'castle', layout: 'transpose',
      buckets: { Beginner: { need: 2 }, Medium: { need: 4 }, Hard: { need: 4 }, Expert: { need: 2 } },
      budgetSec: 90, perPuzzleMs: 15000,
    },

    // ---- Corral (Bag / Cave) intro + full Classic (4 sizes x 4 tiers x 500) + full Hybrids (5 x 500)
    { group: 'corral-intro', pool: 'intro_corral_5x5', cols: 5, rows: 5, style: 'corral', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 6000 },
    { group: 'corral-intro', pool: 'intro_corral_6x6', cols: 6, rows: 6, style: 'corral', tier: 'Beginner', total: 55, budgetSec: 40, perPuzzleMs: 8000 },
    {
      group: 'corral-hybrids', pool: 'hybrid_corral_masyu_8x8', cols: 8, rows: 8, style: 'corral-masyu',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'corral-hybrids', pool: 'hybrid_corral_slither_8x8', cols: 8, rows: 8, style: 'corral-slither',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'corral-hybrids', pool: 'hybrid_corral_midloop_8x8', cols: 8, rows: 8, style: 'corral-midloop',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'corral-hybrids', pool: 'hybrid_corral_castle_8x8', cols: 8, rows: 8, style: 'corral-castle',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 480, perPuzzleMs: 18000,
    },
    {
      group: 'corral-hybrids', pool: 'hybrid_corral_full_8x8', cols: 8, rows: 8, style: 'corral-full',
      buckets: { Beginner: { need: 52 }, Medium: { need: 204 }, Hard: { need: 204 }, Expert: { need: 52 } },
      budgetSec: 420, perPuzzleMs: 15000,
    },
    {
      group: 'corral-classic', pool: 'corral_8x8', cols: 8, rows: 8, style: 'corral',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 420, perPuzzleMs: 12000,
    },
    {
      group: 'corral-classic', pool: 'corral_11x11', cols: 11, rows: 11, style: 'corral',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 900, perPuzzleMs: 20000,
    },
    {
      group: 'corral-classic', pool: 'corral_13x13', cols: 13, rows: 13, style: 'corral',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1500, perPuzzleMs: 25000,
    },
    {
      group: 'corral-classic', pool: 'corral_11x17', cols: 11, rows: 17, style: 'corral',
      buckets: { Beginner: { need: 505 }, Medium: { need: 505 }, Hard: { need: 505 }, Expert: { need: 505 } },
      budgetSec: 1800, perPuzzleMs: 30000,
    },
  ];

  const knownGroups = new Set(JOBS.map((j) => j.group));
  const groups = onlyGroup === 'all' ? null : new Set(onlyGroup.split(',').filter(Boolean));
  if (groups) {
    const unknown = [...groups].filter((g) => !knownGroups.has(g));
    if (unknown.length) {
      console.error(`Unknown --only group(s): ${unknown.join(', ')}. Known: ${[...knownGroups].join(', ')}`);
      process.exit(1);
    }
  }
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

    try {
      await Promise.all(donePromises);
    } finally {
      for (const w of workers) {
        try { w.postMessage({ stop: true }); } catch { /* ignore */ }
      }
      flush();
    }
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
        let settled = false;
        worker.on('message', (msg) => { settled = true; resolve(msg); });
        worker.on('error', (err) => { settled = true; reject(err); });
        worker.on('exit', (code) => {
          if (!settled) reject(new Error(`worker exited without result (code ${code})`));
        });
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
