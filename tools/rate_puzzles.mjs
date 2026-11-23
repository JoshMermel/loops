#!/usr/bin/env node
// Rate every puzzle in one or more CSV files and print tier, score, and rule usage.
// Usage: node tools/rate_puzzles.mjs data/8x8.csv [--steps]
import fs from 'node:fs';
import { compile, parseCsv } from '../js/logic.js';
import { rate } from '../js/rating.js';
import { explainStep } from '../js/explain.js';

const showSteps = process.argv.includes('--steps');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('Usage: node tools/rate_puzzles.mjs <file.csv> [--steps]'); process.exit(1); }

const tierCounts = { Beginner: 0, Medium: 0, Hard: 0, Expert: 0 };
const ruleTotals = {};

for (const f of files) {
  const ps = parseCsv(fs.readFileSync(f, 'utf8'));
  for (const p of ps) {
    const P = compile(p);
    const r = rate(P);
    tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
    for (const [k, v] of Object.entries(r.counts)) ruleTotals[k] = (ruleTotals[k] || 0) + v;
    console.log(`${p.name.padEnd(18)} ${p.cols}x${p.rows}  ${r.tier.padEnd(8)} score=${String(r.score).padStart(4)}  hardest=${r.rules}`);
    if (showSteps) {
      for (const s of r.steps) {
        if (s.info && s.info.bookkeeping) continue;
        const exp = explainStep(P, s);
        console.log(`    [${s.tier}/${s.rule} +${s.weight + (s.extra || 0)}] ${exp.text}`);
      }
    }
  }
}

console.log('\nTiers:', tierCounts);
console.log('Rule uses:', Object.entries(ruleTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', '));
