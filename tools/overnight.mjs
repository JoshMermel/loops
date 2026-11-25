#!/usr/bin/env node
// Resumable long-run generator for filling pools in tools/library/overnight/.
// Runs in chunks with a stop time and prints a live summary after each chunk.
//
// Usage:
//   node tools/overnight.mjs --sizes 8x8,12x12,16x16 --minutes 60 --chunk 10 --seed 100
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseCsv } from '../js/logic.js';
import { arg } from './_cli.mjs';

const sizes = arg('sizes', '8x8,12x12,16x16').split(',');
const minutes = +arg('minutes', 60);
const chunk = +arg('chunk', 10);
const style = arg('style', 'balanced');
const baseSeed = +arg('seed', 1000);
const dir = arg('dir', path.join('tools', 'library', 'overnight'));
const stateFile = path.join(dir, 'state.json');

fs.mkdirSync(dir, { recursive: true });
let state = { round: 0 };
if (fs.existsSync(stateFile)) {
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* ignore */ }
}

const stopAt = Date.now() + minutes * 60 * 1000;
const genScript = fileURLToPath(new URL('./generate.mjs', import.meta.url));

console.log(`Overnight runner: sizes=${sizes.join(',')} style=${style} minutes=${minutes} dir=${dir}`);

const tiers = ['Beginner', 'Medium', 'Hard', 'Expert'];

while (Date.now() < stopAt) {
  state.round++;
  for (const size of sizes) {
    if (Date.now() >= stopAt) break;
    const tier = tiers[(state.round - 1) % tiers.length];
    const outPath = path.join(dir, `${style}_${size}.csv`);
    const remSec = Math.max(10, Math.floor((stopAt - Date.now()) / 1000));
    const seed = baseSeed + state.round * 97 + sizes.indexOf(size) * 13;
    console.log(`\n--- Round ${state.round}: ${size} (${tier}, seed ${seed}) ---`);
    try {
      execFileSync(process.execPath, [
        genScript,
        '--size', size,
        '--count', String(chunk),
        '--seed', String(seed),
        '--style', style,
        '--tier', tier,
        '--budget', String(Math.min(180, remSec)),
        '--prefix', `${style}_${size}`,
        '--out', outPath,
      ], { stdio: 'inherit' });
    } catch (err) {
      console.error(`Chunk failed for ${size}: ${err.message}`);
    }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }

  // Summary
  console.log('\n=== Overnight Pool Summary ===');
  for (const size of sizes) {
    const outPath = path.join(dir, `${style}_${size}.csv`);
    if (!fs.existsSync(outPath)) continue;
    const ps = parseCsv(fs.readFileSync(outPath, 'utf8'));
    const c = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0 };
    for (const p of ps) c[p.tier] = (c[p.tier] || 0) + 1;
    console.log(`  ${size}: ${ps.length} total (B=${c.Beginner} M=${c.Medium} H=${c.Hard} E=${c.Expert})`);
  }
}
