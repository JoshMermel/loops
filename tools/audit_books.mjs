#!/usr/bin/env node
// Independently re-verify every shipped puzzle in data/manifest.json before publishing.
//
// Usage:
//   node tools/audit_books.mjs [--book id[,id...]] [--jobs N] [--chunk 25] [--rate] [--all]
//
// Checks per puzzle:
//   - clues in bounds, distinct cells, valid type W|B|G
//   - stored solution is valid (isSolved)
//   - exactly ONE solution proved independently (sound rules, or complete exhaustive search without hitting node cap)
//   - with --rate: stored tier, rules, and score match a fresh rate(P)
// Checks per book / across books:
//   - manifest count equals CSV row count
//   - distinct puzzle names
//   - no duplicates within or across non-hidden books (via symmetryKey)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  parseCsv, compile, solve, decodeSolution, encodeSolution, isSolved, symmetryKey,
} from '../js/logic.js';
import { rate, solvedByRules, FIRST_LOOKAHEAD } from '../js/rating.js';
import { makeRng } from '../js/generator.js';
import { repoRoot, arg } from './_cli.mjs';

const root = repoRoot(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'manifest.json'), 'utf8'));
const loadBook = (entry) => parseCsv(fs.readFileSync(path.join(root, entry.file), 'utf8'));

if (process.argv.includes('--worker')) {
  const entry = manifest.books.find((b) => b.id === arg('worker'));
  const [from, to] = arg('range').split('-').map(Number);
  const withRating = process.argv.includes('--rate');
  const out = { checked: 0, bad: [], exhaustive: 0 };

  loadBook(entry).slice(from, to).forEach((raw, k) => {
    const name = raw.name;
    const fail = (why) => out.bad.push(`${entry.id} #${from + k + 1} ${name}: ${why}`);
    out.checked++;

    const seenV = new Set();
    for (const v of raw.voids || []) {
      if (v.r < 0 || v.c < 0 || v.r >= raw.rows || v.c >= raw.cols) return fail('void outside the board');
      const idx = v.r * raw.cols + v.c;
      if (seenV.has(idx)) return fail('duplicate void');
      seenV.add(idx);
    }
    const seen = new Set();
    for (const c of raw.clues) {
      if (c.r < 0 || c.c < 0 || c.r >= raw.rows || c.c >= raw.cols) return fail('clue outside the board');
      const idx = c.r * raw.cols + c.c;
      if (seenV.has(idx)) return fail('clue on void cell');
      if (seen.has(idx)) return fail('two clues on one cell');
      seen.add(idx);
      if (c.t !== 'W' && c.t !== 'B' && c.t !== 'G') return fail(`bad clue type "${c.t}"`);
    }
    const seenG = new Set();
    const givenWalls = new Set();
    for (const gv of raw.givens || []) {
      if (gv.dir !== 'H' && gv.dir !== 'V') return fail(`bad given dir "${gv.dir}"`);
      if (gv.v !== 0 && gv.v !== 1) return fail(`bad given value "${gv.v}"`);
      if (gv.r < 0 || gv.c < 0 || (gv.dir === 'H' ? (gv.r >= raw.rows || gv.c >= raw.cols - 1) : (gv.r >= raw.rows - 1 || gv.c >= raw.cols))) {
        return fail('given edge outside the board');
      }
      const a = gv.r * raw.cols + gv.c;
      const b = gv.dir === 'H' ? a + 1 : a + raw.cols;
      if (seenV.has(a) || seenV.has(b)) return fail('given edge touches a void cell');
      const ek = `${gv.r}:${gv.c}:${gv.dir}`;
      if (seenG.has(ek)) return fail('duplicate given edge');
      seenG.add(ek);
      if (gv.v === 0) givenWalls.add(ek);
    }
    const seenS = new Set();
    for (const sc of raw.slither || []) {
      if (sc.r < 0 || sc.c < 0 || sc.r >= raw.rows - 1 || sc.c >= raw.cols - 1) return fail('slither clue outside the board');
      if (sc.n !== 0 && sc.n !== 1 && sc.n !== 2 && sc.n !== 3) return fail(`bad slither value "${sc.n}"`);
      const fk = sc.r * (raw.cols - 1) + sc.c;
      if (seenS.has(fk)) return fail('duplicate slither clue on one square');
      seenS.add(fk);
      if (seenV.has(sc.r * raw.cols + sc.c) || seenV.has(sc.r * raw.cols + sc.c + 1)
        || seenV.has((sc.r + 1) * raw.cols + sc.c) || seenV.has((sc.r + 1) * raw.cols + sc.c + 1)) {
        return fail('slither clue touches a void cell');
      }
    }
    const seenM = new Set();
    for (const md of raw.midloop || []) {
      if (md.dir !== 'C' && md.dir !== 'H' && md.dir !== 'V') return fail(`bad midloop dir "${md.dir}"`);
      if (md.r < 0 || md.c < 0 || (md.dir === 'C' ? (md.r >= raw.rows || md.c >= raw.cols)
        : md.dir === 'H' ? (md.r >= raw.rows || md.c >= raw.cols - 1)
        : (md.r >= raw.rows - 1 || md.c >= raw.cols))) {
        return fail('midloop dot outside the board');
      }
      const mk = `${md.r}:${md.c}:${md.dir}`;
      if (seenM.has(mk)) return fail('duplicate midloop dot');
      seenM.add(mk);
      if (md.dir === 'C') {
        const idx = md.r * raw.cols + md.c;
        if (seenV.has(idx)) return fail('midloop dot on void cell');
        if (seen.has(idx)) return fail('midloop dot collides with circle clue');
      } else {
        const a = md.r * raw.cols + md.c;
        const b = md.dir === 'H' ? a + 1 : a + raw.cols;
        if (seenV.has(a) || seenV.has(b)) return fail('midloop edge dot touches a void cell');
        if (givenWalls.has(mk)) return fail('midloop edge dot on a given wall');
      }
    }
    const seenCW = new Set();
    for (const cw of raw.castle || []) {
      if (cw.r < 0 || cw.c < 0 || cw.r >= raw.rows || cw.c >= raw.cols) return fail('castle wall tile outside the board');
      if (cw.wall !== 'W' && cw.wall !== 'B' && cw.wall !== 'G') return fail(`bad castle wall color "${cw.wall}"`);
      if (cw.dir && cw.dir !== 'U' && cw.dir !== 'R' && cw.dir !== 'D' && cw.dir !== 'L') return fail(`bad castle dir "${cw.dir}"`);
      if (cw.dir && (!Number.isInteger(cw.n) || cw.n < 0)) return fail(`bad castle count "${cw.n}"`);
      const idx = cw.r * raw.cols + cw.c;
      if (seenCW.has(idx)) return fail('duplicate castle wall tile on one cell');
      if (seenV.has(idx)) return fail('castle wall tile collides with plain void');
      if (seen.has(idx)) return fail('castle wall tile collides with circle clue');
      seenCW.add(idx);
    }

    let P;
    try { P = compile(raw); } catch (e) { return fail(`does not compile: ${e.message}`); }
    if (!raw.solution || raw.solution.length !== P.N) return fail('missing or wrong-length stored solution');

    const sol = decodeSolution(P, raw.solution);
    if (!isSolved(P, sol.e)) return fail('stored solution is not a valid Masyu solution');

    // Prove uniqueness independently (sound non-lookahead rules first, else complete exhaustive search)
    const byRules = solvedByRules(P, FIRST_LOOKAHEAD);
    if (byRules.solved) {
      if (encodeSolution(P, byRules.state) !== raw.solution) return fail('sound rules solved to a different solution');
    } else {
      out.exhaustive++;
      const r = solve(P, { limit: 2, maxNodes: 2000000 });
      if (r.exceeded) return fail('uniqueness not proved: exhaustive search hit node cap');
      if (r.count !== 1) return fail(`found ${r.count} solutions`);
      if (encodeSolution(P, r.solutions[0]) !== raw.solution) return fail('unique solution differs from stored solution');
    }

    if (withRating) {
      const q = rate(P);
      if (q.tier !== raw.tier || q.score !== raw.score || q.rules !== raw.rules) {
        return fail(`stored ${raw.tier}/${raw.rules}/${raw.score} but rates ${q.tier}/${q.rules}/${q.score}`);
      }
    }

    const proveNonUnique = (altP, baseSeed) => {
      let alt = solve(altP, { limit: 2, maxNodes: 50000 });
      for (let t = 0; t < 5 && alt.count < 2 && alt.exceeded; t++) {
        alt = solve(altP, { limit: 2, maxNodes: 100000, rng: makeRng(baseSeed + t * 997) });
      }
      return alt;
    };

    // Verify full-board necessity: dropping `fullBoard` must leave >= 2 valid solutions
    if (P.fullBoard && !entry.hidden) {
      const noFull = compile({
        name: raw.name,
        rows: raw.rows,
        cols: raw.cols,
        clues: raw.clues,
        ...(raw.slither && raw.slither.length ? { slither: raw.slither } : {}),
        ...(raw.midloop && raw.midloop.length ? { midloop: raw.midloop } : {}),
        ...(raw.castle && raw.castle.length ? { castle: raw.castle } : {}),
        ...(raw.voids && raw.voids.length ? { voids: raw.voids } : {}),
        ...(raw.givens && raw.givens.length ? { givens: raw.givens } : {}),
        fullBoard: false,
      });
      const alt = proveNonUnique(noFull, 12345 + from + k);
      if (alt.exceeded && alt.count < 2) return fail('fullBoard necessity not proved: hit node cap');
      if (alt.count < 2) return fail('fullBoard rule is redundant (uniquely solvable without fullBoard)');
    }

    // Verify mutual necessity across any 2-way or 3-way clue-family hybrid (Masyu / Slitherlink / Mid-loop / Castle Wall):
    // dropping any one active clue family (while keeping all others + fullBoard/voids/givens) must leave >= 2 solutions.
    // When dropping Castle Wall clues, keep their blocked tile cells as plain voids so the board geometry stays intact.
    if (!entry.hidden) {
      const families = [];
      if (P.clueCells.length > 0) families.push({ key: 'clues', label: 'Masyu circles', seed: 23456 });
      if (P.hasSlither) families.push({ key: 'slither', label: 'Slitherlink numbers', seed: 34567 });
      if (P.hasMidloop) families.push({ key: 'midloop', label: 'Mid-loop dots', seed: 45678 });
      if (P.hasCastle) families.push({ key: 'castle', label: 'Castle Wall clues', seed: 56789 });
      if (families.length >= 2) {
        const fullOpts = {
          name: raw.name,
          rows: raw.rows,
          cols: raw.cols,
          clues: raw.clues,
          ...(raw.slither && raw.slither.length ? { slither: raw.slither } : {}),
          ...(raw.midloop && raw.midloop.length ? { midloop: raw.midloop } : {}),
          ...(raw.castle && raw.castle.length ? { castle: raw.castle } : {}),
          ...(P.fullBoard ? { fullBoard: true } : {}),
          ...(raw.voids && raw.voids.length ? { voids: raw.voids } : {}),
          ...(raw.givens && raw.givens.length ? { givens: raw.givens } : {}),
        };
        for (const fam of families) {
          const dropOpts = { ...fullOpts, [fam.key]: [] };
          if (fam.key === 'castle') {
            dropOpts.voids = [...(raw.voids || []), ...raw.castle.map(({ r, c }) => ({ r, c }))];
          }
          const withoutFam = compile(dropOpts);
          const alt = proveNonUnique(withoutFam, fam.seed + from + k);
          if (alt.exceeded && alt.count < 2) return fail(`hybrid ${fam.label} necessity not proved: hit node cap`);
          if (alt.count < 2) return fail(`${fam.label} are redundant on hybrid (uniquely solvable without them)`);
        }
      }
    }
  });

  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

// Main coordinator
const only = arg('book', '') ? arg('book').split(',').filter(Boolean) : null;
const includeHidden = process.argv.includes('--all');
const userChunk = arg('chunk', null);
const chunk = userChunk !== null ? Math.trunc(+userChunk) : 25;
if (!Number.isFinite(chunk) || chunk < 1) {
  console.error(`Invalid --chunk "${userChunk}" (must be a positive integer)`);
  process.exit(1);
}
const rawJobs = arg('jobs', null);
const jobs = rawJobs !== null ? Math.trunc(+rawJobs) : Math.max(2, os.availableParallelism() - 1);
if (!Number.isFinite(jobs) || jobs < 1) {
  console.error(`Invalid --jobs "${rawJobs}" (must be a positive integer)`);
  process.exit(1);
}
const withRating = process.argv.includes('--rate');

if (only) {
  const knownIds = new Set(manifest.books.map((b) => b.id));
  const unknown = only.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    console.error(`Unknown --book id(s): ${unknown.join(', ')}. Known: ${[...knownIds].join(', ')}`);
    process.exit(1);
  }
}

const booksToAudit = manifest.books.filter((b) => (only ? only.includes(b.id) : includeHidden || !b.hidden));
if (!booksToAudit.length) {
  console.error('No books matched audit selection.');
  process.exit(1);
}
const problems = [], tasks = [];
const everywhere = new Map();
let total = 0;

for (const entry of booksToAudit) {
  const filePath = path.join(root, entry.file);
  if (!fs.existsSync(filePath)) { problems.push(`${entry.id}: missing file ${entry.file}`); continue; }
  const ps = loadBook(entry);
  total += ps.length;
  if (ps.length !== entry.count) problems.push(`${entry.id}: manifest count ${entry.count} !== file rows ${ps.length}`);
  const names = new Set(), hashes = new Map();
  for (const p of ps) {
    if (names.has(p.name)) problems.push(`${entry.id}: duplicate puzzle name ${p.name}`);
    names.add(p.name);
    const sk = symmetryKey(p);
    if (hashes.has(sk)) problems.push(`${entry.id}: ${p.name} duplicates ${hashes.get(sk)} (up to symmetry)`);
    else if (!entry.hidden && everywhere.has(sk)) problems.push(`${entry.id}: ${p.name} duplicates ${everywhere.get(sk)} (up to symmetry)`);
    hashes.set(sk, p.name);
    if (!entry.hidden && !everywhere.has(sk)) everywhere.set(sk, `${entry.id}:${p.name}`);
  }
  const bigBook = ps.length > 0 && ps[0].rows * ps[0].cols >= 225;
  const bookChunk = userChunk ? chunk
    : bigBook ? Math.min(chunk, 3)
    : booksToAudit.length === 1 ? Math.min(chunk, Math.max(4, Math.ceil(ps.length / jobs)))
    : chunk;
  for (let from = 0; from < ps.length; from += bookChunk) {
    tasks.push({ id: entry.id, range: `${from}-${Math.min(ps.length, from + bookChunk)}` });
  }
}

console.log(`Auditing ${total} puzzles across ${booksToAudit.length} books (${tasks.length} chunks, ${jobs} workers${withRating ? ', with --rate' : ''})...`);
let checked = 0, exhaustive = 0, running = 0;
const t0 = Date.now();

await new Promise((resolve) => {
  const next = () => {
    if (!tasks.length && !running) return resolve();
    while (running < jobs && tasks.length) {
      const t = tasks.shift();
      running++;
      const args = [fileURLToPath(import.meta.url), '--worker', t.id, '--range', t.range, ...(withRating ? ['--rate'] : [])];
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.on('close', (code) => {
        running--;
        if (code !== 0) {
          problems.push(`worker failed on ${t.id} ${t.range} (exit ${code})`);
        } else {
          try {
            const res = JSON.parse(buf.trim());
            checked += res.checked;
            exhaustive += res.exhaustive;
            problems.push(...res.bad);
          } catch (err) {
            problems.push(`worker output parse failed on ${t.id} ${t.range}: ${err.message}`);
          }
        }
        next();
      });
    }
  };
  next();
});

const sec = ((Date.now() - t0) / 1000).toFixed(2);
if (!problems.length && checked !== total) {
  problems.push(`checked ${checked} puzzles, expected ${total}`);
}
if (problems.length) {
  console.error(`\nAUDIT FAILED (${problems.length} problems in ${sec}s):`);
  for (const p of problems.slice(0, 40)) console.error('  -', p);
  process.exit(1);
}
console.log(`AUDIT PASSED: ${checked} puzzles verified (${exhaustive} via exhaustive search) in ${sec}s.`);
