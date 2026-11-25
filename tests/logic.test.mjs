import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, propagate, initialState, isSolved, encodeSolution, decodeSolution,
  toCsv, parseCsv, cluesToString, cluesFromString, symmetryKey, puzzleHash, colName,
  E_ON, E_OFF,
} from '../js/logic.js';
import { referenceCount } from './reference_solver.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('colName formats spreadsheet-style column names', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(27), 'AB');
});

test('basic Masyu rules: 3x3 black opposite corners force full border loop', () => {
  // On 3x3, black circles at (0,0) and (2,2) force the unique 8-cell border loop (1 black corner alone has 2 solutions!)
  const P1 = compile({ name: 'b3_one', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }] });
  assert.equal(solve(P1, { limit: 5 }).count, 2);
  assert.equal(referenceCount(P1), 2);

  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  const r = solve(P, { limit: 5 });
  assert.equal(r.exceeded, false);
  assert.equal(r.count, 1);
  assert.equal(referenceCount(P), 1);
  assert.equal(isSolved(P, r.solutions[0].e), true);
  // Center cell (1,1) is not on the loop
  const solStr = encodeSolution(P, r.solutions[0]);
  assert.equal(solStr[4], '#');
  assert.equal(solStr, '6ac5#53a9');
  // Decode roundtrip
  const dec = decodeSolution(P, solStr);
  assert.equal(isSolved(P, dec.e), true);
  assert.equal(encodeSolution(P, dec), solStr);
});

test('basic Masyu rules: black circle in 2x2 has 0 solutions', () => {
  const P = compile({ name: 'b2', rows: 2, cols: 2, clues: [{ r: 0, c: 0, t: 'B' }] });
  assert.equal(solve(P, { limit: 5 }).count, 0);
  assert.equal(referenceCount(P), 0);
});

test('basic Masyu rules: white circle in 2x2 has 0 solutions (cannot go straight)', () => {
  const P = compile({ name: 'w2', rows: 2, cols: 2, clues: [{ r: 0, c: 0, t: 'W' }] });
  assert.equal(solve(P, { limit: 5 }).count, 0);
  assert.equal(referenceCount(P), 0);
});

test('basic Masyu rules: white circle in middle of 3x3 edge has multiple valid solutions', () => {
  // White at (0,1) must go horizontally (0,0)-(0,1)-(0,2) and turns at both (0,0) and (0,2).
  // Wait: it can go down to row 1 (a 2x3 rectangle) OR down to row 2 (3x3 border), OR detour through (1,1)!
  const P = compile({ name: 'w3', rows: 3, cols: 3, clues: [{ r: 0, c: 1, t: 'W' }] });
  const r = solve(P, { limit: 20 });
  assert.equal(r.count, referenceCount(P));
  assert.ok(r.count > 1);
  for (const s of r.solutions) assert.equal(isSolved(P, s.e), true);
});

test('basic Masyu rules: two adjacent black circles cannot connect', () => {
  const P = compile({ name: 'bb4', rows: 4, cols: 4, clues: [{ r: 0, c: 0, t: 'B' }, { r: 0, c: 1, t: 'B' }] });
  const r = solve(P, { limit: 20 });
  assert.equal(r.count, referenceCount(P));
  for (const s of r.solutions) {
    assert.equal(isSolved(P, s.e), true);
    assert.notEqual(s.e[P.ed[0 * 4 + 1]], E_ON); // edge between (0,0) and (0,1) must be OFF
  }
});

test('zero-clue boards match reference simple-cycle count', () => {
  for (const [rows, cols] of [[2, 2], [2, 3], [3, 3], [3, 4], [4, 4]]) {
    const P = compile({ name: `empty_${rows}x${cols}`, rows, cols, clues: [] });
    const r = solve(P, { limit: 1000 });
    assert.equal(r.exceeded, false);
    assert.equal(r.count, referenceCount(P), `mismatch on empty ${rows}x${cols}`);
  }
});

test('cross-check fast solver against brute-force reference on 120 random small boards', () => {
  const rng = mulberry32(42);
  const sizes = [[3, 3], [3, 4], [4, 4], [4, 5]];
  for (let trial = 0; trial < 120; trial++) {
    const [rows, cols] = sizes[trial % sizes.length];
    const N = rows * cols;
    const count = 1 + ((rng() * Math.min(7, N - 1)) | 0);
    const chosen = new Set();
    const clues = [];
    while (clues.length < count) {
      const i = (rng() * N) | 0;
      if (chosen.has(i)) continue;
      chosen.add(i);
      clues.push({ r: (i / cols) | 0, c: i % cols, t: rng() < 0.5 ? 'W' : 'B' });
    }
    const P = compile({ name: `rnd_${trial}`, rows, cols, clues });
    const ref = referenceCount(P);
    const fast = solve(P, { limit: 50 });
    assert.equal(fast.exceeded, false);
    if (ref < 50) {
      assert.equal(fast.count, ref, `trial ${trial} (${rows}x${cols}, ${cluesToString(clues)}): fast=${fast.count} ref=${ref}`);
    } else {
      assert.equal(fast.count, 50, `trial ${trial}: expected cap 50, got ${fast.count}`);
    }
    for (const sol of fast.solutions) {
      assert.equal(isSolved(P, sol.e), true, `trial ${trial}: solution failed isSolved`);
    }
  }
});

test('cross-check on random 5x5 boards (exact count cap 2)', () => {
  const rng = mulberry32(12345);
  for (let trial = 0; trial < 20; trial++) {
    const rows = 5, cols = 5, N = 25;
    const count = 4 + ((rng() * 6) | 0);
    const chosen = new Set();
    const clues = [];
    while (clues.length < count) {
      const i = (rng() * N) | 0;
      if (chosen.has(i)) continue;
      chosen.add(i);
      clues.push({ r: (i / cols) | 0, c: i % cols, t: rng() < 0.5 ? 'W' : 'B' });
    }
    const P = compile({ name: `r5_${trial}`, rows, cols, clues });
    const ref = referenceCount(P);
    const fast = solve(P, { limit: 2 });
    assert.equal(fast.exceeded, false);
    assert.equal(fast.count, Math.min(2, ref), `5x5 trial ${trial}: fast=${fast.count} ref=${ref}`);
    for (const sol of fast.solutions) assert.equal(isSolved(P, sol.e), true);
  }
});

test('solve() reports exceeded when node cap is hit', () => {
  const P = compile({ name: 'big_empty', rows: 6, cols: 6, clues: [{ r: 2, c: 2, t: 'W' }] });
  const r = solve(P, { limit: 2, maxNodes: 3 });
  assert.equal(r.exceeded, true);
});

test('isSolved rejects invalid loops (broken white turn, broken black straight, two cycles, missing circle)', () => {
  // 4x4 outer border loop: straight along top row (0,0)-(0,1)-(0,2)-(0,3), so (0,1) has straight neighbors?
  // Wait: at (0,1), (0,0) turns! At (0,2), (0,3) turns!
  // Let's use a 5x5 outer border loop: along top row (0,0)-(0,1)-(0,2)-(0,3)-(0,4), cell (0,2) goes straight AND both neighbors (0,1) and (0,3) go straight!
  const P = compile({ name: 'w_bad', rows: 5, cols: 5, clues: [{ r: 0, c: 2, t: 'W' }] });
  const edges = new Int8Array(P.numEdges);
  for (let c = 0; c < 4; c++) { edges[2 * (0 * 5 + c)] = E_ON; edges[2 * (4 * 5 + c)] = E_ON; }
  for (let r = 0; r < 4; r++) { edges[2 * (r * 5 + 0) + 1] = E_ON; edges[2 * (r * 5 + 4) + 1] = E_ON; }
  assert.equal(isSolved(P, edges), false, 'white circle without turn at either end must fail');

  // If the white circle is at (0,1), neighbor (0,0) turns -> valid!
  const P2 = compile({ name: 'w_ok', rows: 5, cols: 5, clues: [{ r: 0, c: 1, t: 'W' }] });
  assert.equal(isSolved(P2, edges), true);

  // If we add a white circle at (2,2) not visited -> invalid!
  const P3 = compile({ name: 'w_miss', rows: 5, cols: 5, clues: [{ r: 0, c: 1, t: 'W' }, { r: 2, c: 2, t: 'W' }] });
  assert.equal(isSolved(P3, edges), false);

  // Add a second disconnected 2x2 cycle around (2,2)-(2,3)-(3,3)-(3,2) -> invalid (two cycles)!
  const edges2 = edges.slice();
  edges2[2 * (2 * 5 + 2)] = E_ON;
  edges2[2 * (3 * 5 + 2)] = E_ON;
  edges2[2 * (2 * 5 + 2) + 1] = E_ON;
  edges2[2 * (2 * 5 + 3) + 1] = E_ON;
  assert.equal(isSolved(P2, edges2), false, 'two disjoint loops must fail');

  // Black circle at (0,0) on 2x3 rectangle (length 1 along side 0..1) -> fails straight-2!
  const P4 = compile({ name: 'b_short', rows: 2, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }] });
  const rect = new Int8Array(P4.numEdges);
  rect[2 * 0] = E_ON; rect[2 * 1] = E_ON;
  rect[2 * 3] = E_ON; rect[2 * 4] = E_ON;
  rect[2 * 0 + 1] = E_ON; rect[2 * 2 + 1] = E_ON;
  assert.equal(isSolved(P4, rect), false, 'black circle with 1-step leg must fail');
});

test('CSV roundtrip, symmetryKey, and puzzleHash', () => {
  const p = {
    name: 'test_1',
    rows: 4,
    cols: 5,
    clues: [{ r: 0, c: 1, t: 'W' }, { r: 3, c: 4, t: 'B' }],
    solution: '6a5c#'.repeat(4),
    rules: 'blackEdge',
    tier: 'Beginner',
    score: 12,
  };
  const csv = toCsv([p]);
  assert.ok(csv.startsWith('name,rows,cols,clues,solution,rules,tier,score\n'));
  const parsed = parseCsv('# comment\n\n' + csv);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], p);

  // Rotated / mirrored copies share symmetryKey but have distinct puzzleHash
  const pMirror = {
    rows: 4, cols: 5,
    clues: [{ r: 0, c: 3, t: 'W' }, { r: 3, c: 0, t: 'B' }],
  };
  const pTranspose = {
    rows: 5, cols: 4,
    clues: [{ r: 1, c: 0, t: 'W' }, { r: 4, c: 3, t: 'B' }],
  };
  assert.equal(symmetryKey(p), symmetryKey(pMirror));
  assert.equal(symmetryKey(p), symmetryKey(pTranspose));
  assert.notEqual(puzzleHash(p), puzzleHash(pMirror));
  // Clue order does not change puzzleHash
  const pReordered = { rows: 4, cols: 5, clues: [p.clues[1], p.clues[0]] };
  assert.equal(puzzleHash(p), puzzleHash(pReordered));
});

test('incremental propagate(P, st, seedEdge) matches full propagate() and compile() resets cached CSR tables', () => {
  const P = compile({
    name: 'inc', rows: 6, cols: 6,
    clues: [
      { r: 0, c: 2, t: 'W' }, { r: 1, c: 1, t: 'B' }, { r: 2, c: 4, t: 'W' },
      { r: 3, c: 2, t: 'W' }, { r: 4, c: 4, t: 'B' }, { r: 5, c: 1, t: 'W' },
    ],
  });
  const base = initialState(P);
  assert.equal(propagate(P, base), true);

  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0 || base.e[x] !== 0) continue;
    for (const val of [E_ON, E_OFF]) {
      const sFull = { cell: base.cell.slice(), e: base.e.slice(), cycle: base.cycle };
      const sInc = { cell: base.cell.slice(), e: base.e.slice(), cycle: base.cycle };
      sFull.e[x] = val;
      sInc.e[x] = val;
      const okFull = propagate(P, sFull);
      const okInc = propagate(P, sInc, x, -1);
      assert.equal(okInc, okFull, `contradiction mismatch on edge ${x}=${val}`);
      if (okFull) {
        assert.deepEqual(sInc.e, sFull.e, `edge state mismatch on edge ${x}=${val}`);
        assert.deepEqual(sInc.cell, sFull.cell, `cell state mismatch on edge ${x}=${val}`);
      }
    }
  }

  // Re-compiling a mutated puzzle object must invalidate cached _ecOff/_ecData
  const raw = { name: 'recompile', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }] };
  compile(raw);
  const st1 = initialState(raw);
  propagate(raw, st1);
  assert.ok(raw._ecOff !== null);
  raw.clues = [{ r: 1, c: 1, t: 'B' }];
  compile(raw);
  assert.equal(raw._ecOff, null, 'compile() must reset cached CSR edge-clue table');

  // Invalid board dimensions must throw cleanly
  for (const bad of [{ rows: NaN, cols: 4 }, { rows: 1, cols: 4 }, { rows: 4, cols: 0 }, { rows: 3.5, cols: 4 }]) {
    assert.throws(() => compile({ name: 'bad', ...bad, clues: [] }), /invalid board size/);
  }
});
