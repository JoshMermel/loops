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

  // Invalid board dimensions, malformed clues, and corrupt/short solutions are handled cleanly
  for (const bad of [{ rows: NaN, cols: 4 }, { rows: 1, cols: 4 }, { rows: 4, cols: 0 }, { rows: 3.5, cols: 4 }]) {
    assert.throws(() => compile({ name: 'bad', ...bad, clues: [] }), /invalid board size/);
  }
  assert.throws(() => compile({ name: 'badc', rows: 4, cols: 4, clues: [{ r: NaN, c: 1, t: 'W' }] }), /clue out of bounds/);
  assert.throws(() => compile({ name: 'badf', rows: 4, cols: 4, clues: [{ r: 1.5, c: 1, t: 'W' }] }), /clue out of bounds/);
  for (const s of ['foo:2:W', ':2:W', '1.5:2:W', '1:2:W:junk']) {
    assert.throws(() => parseCsv(`bad,4,4,${s},,,,`), /bad clue/);
  }
  const shortDec = decodeSolution(P, '6a');
  assert.equal(shortDec.cell[P.N - 1], 1, 'trailing cells on short solution must stay OFF, not LOOP');
});

test('gray pearls: cross-check fast solver against brute-force reference on 120 random mixed & all-gray 4x4/5x5 boards', () => {
  const rng = mulberry32(777);
  let checkedNonZero = 0;
  for (let k = 0; k < 120; k++) {
    const rows = k < 70 ? 4 : 5;
    const cols = k < 70 ? 4 : 5;
    const allGray = k % 3 === 0;
    const nClues = 2 + ((rng() * 5) | 0);
    const used = new Set();
    const clues = [];
    while (clues.length < nClues) {
      const r = (rng() * rows) | 0;
      const c = (rng() * cols) | 0;
      const id = r * cols + c;
      if (used.has(id)) continue;
      used.add(id);
      const t = allGray ? 'G' : (rng() < 0.55 ? 'G' : rng() < 0.5 ? 'W' : 'B');
      clues.push({ r, c, t });
    }
    const P = compile({ name: `gray_${k}`, rows, cols, clues });
    const ref = referenceCount(P);
    const fast = solve(P, { limit: rows === 4 ? 1000 : 2 });
    assert.equal(fast.exceeded, false);
    if (rows === 4) {
      assert.equal(fast.count, ref, `gray 4x4 mismatch on ${k}: fast=${fast.count} ref=${ref}`);
    } else {
      assert.equal(Math.min(fast.count, 2), Math.min(ref, 2), `gray 5x5 cap-2 mismatch on ${k}`);
    }
    for (const sol of fast.solutions) {
      assert.equal(isSolved(P, sol.e), true);
      const enc = encodeSolution(P, sol);
      const dec = decodeSolution(P, enc);
      assert.equal(isSolved(P, dec.e), true);
      for (const i of P.grays) {
        assert.ok(dec.clue[i] === 1 || dec.clue[i] === 2, 'decoded gray pearl must resolve to WHITE or BLACK');
      }
    }
    if (ref > 0) checkedNonZero++;
  }
  assert.ok(checkedNonZero >= 30, `expected >= 30 solvable random gray boards, got ${checkedNonZero}`);
});

test('fullBoard & given edges/walls: brute-force cross-check, CSV roundtrip, symmetryKey, and puzzleHash', () => {
  // Odd-area fullBoard (3x3) has 0 Hamiltonian cycles immediately
  const P3 = compile({ name: 'odd_fb', rows: 3, cols: 3, clues: [], fullBoard: true });
  assert.equal(solve(P3, { limit: 10 }).count, 0);
  assert.equal(referenceCount(P3), 0);

  // 120 random 4x4 and 4x5 full-board puzzles (with circles, given lines, given walls, and zero-circle givens)
  const rng = mulberry32(20260);
  let checkedNonZero = 0;
  for (let k = 0; k < 120; k++) {
    const rows = 4, cols = k < 80 ? 4 : 5;
    const mode = k % 4; // 0: full+circles, 1: full+lines, 2: full+walls, 3: full+mixed givens
    const clues = [];
    const givens = [];
    if (mode === 0) {
      const used = new Set();
      for (let j = 0; j < 2 + (k % 3); j++) {
        const r = (rng() * rows) | 0, c = (rng() * cols) | 0;
        if (used.has(r * cols + c)) continue;
        used.add(r * cols + c);
        clues.push({ r, c, t: rng() < 0.5 ? 'W' : 'B' });
      }
    } else {
      const usedE = new Set();
      const target = 2 + ((rng() * 5) | 0);
      while (givens.length < target) {
        const dir = rng() < 0.5 ? 'H' : 'V';
        const r = (rng() * (dir === 'H' ? rows : rows - 1)) | 0;
        const c = (rng() * (dir === 'H' ? cols - 1 : cols)) | 0;
        const key = `${r}:${c}:${dir}`;
        if (usedE.has(key)) continue;
        usedE.add(key);
        const v = mode === 1 ? 1 : mode === 2 ? 0 : (rng() < 0.5 ? 1 : 0);
        givens.push({ r, c, dir, v });
      }
    }
    const P = compile({ name: `fb_${k}`, rows, cols, clues, fullBoard: true, givens });
    const ref = referenceCount(P);
    const fast = solve(P, { limit: 500 });
    assert.equal(fast.exceeded, false);
    assert.equal(fast.count, ref, `fullBoard mismatch on ${k} (mode=${mode}): fast=${fast.count} ref=${ref}`);
    for (const sol of fast.solutions) assert.equal(isSolved(P, sol.e), true);
    if (ref > 0) checkedNonZero++;
  }
  assert.ok(checkedNonZero >= 35, `expected >= 35 solvable fullBoard boards, got ${checkedNonZero}`);

  // CSV roundtrip + symmetryKey invariance + puzzleHash distinction
  const pA = compile({
    name: 'rt_fb', rows: 4, cols: 6, fullBoard: true,
    clues: [{ r: 0, c: 1, t: 'W' }],
    givens: [{ r: 1, c: 2, dir: 'H', v: 1 }, { r: 2, c: 0, dir: 'V', v: 0 }],
  });
  const parsed = parseCsv(toCsv([pA]))[0];
  assert.equal(parsed.fullBoard, true);
  assert.deepEqual(parsed.clues, pA.clues);
  assert.deepEqual(parsed.givens, [{ r: 1, c: 2, dir: 'H', v: 1 }, { r: 2, c: 0, dir: 'V', v: 0 }]);
  const pPlain = compile({ name: 'rt_plain', rows: 4, cols: 6, clues: [{ r: 0, c: 1, t: 'W' }] });
  assert.notEqual(symmetryKey(pA), symmetryKey(pPlain));
  assert.notEqual(puzzleHash(pA), puzzleHash(pPlain));
});

test('shaped / cutout boards (voids): brute-force cross-check, dual-face topology, CSV roundtrip, and validation', () => {
  // 1. Dual-face topology on a 6x6 Donut (2x2 center voids -> 1 interior hole of 9 faces, 0 exterior cutout faces)
  const donut = compile({
    name: 'donut6', rows: 6, cols: 6, clues: [],
    voids: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 2 }, { r: 3, c: 3 }],
  });
  assert.equal(donut.hasVoids, true);
  assert.equal(donut.activeCount, 32);
  assert.equal(donut.holeList.length, 1);
  assert.equal(donut.holeList[0].length, 9);
  assert.equal(donut.faceExterior.reduce((a, b) => a + b, 0), 0);

  // 2. Dual-face topology on a 6x6 Cross (2x2 corner cutouts -> 16 exterior cutout faces, 0 interior holes)
  const crossVoids = [];
  for (const r of [0, 1, 4, 5]) for (const c of [0, 1, 4, 5]) crossVoids.push({ r, c });
  const cross = compile({ name: 'cross6', rows: 6, cols: 6, clues: [], voids: crossVoids });
  assert.equal(cross.holeList.length, 0);
  assert.equal(cross.faceExterior.reduce((a, b) => a + b, 0), 16);

  // 3. Validation rejects clue on void, given touching void, duplicate void, out-of-bounds void
  assert.throws(() => compile({ name: 'badv1', rows: 4, cols: 4, voids: [{ r: 1, c: 1 }], clues: [{ r: 1, c: 1, t: 'W' }] }), /void/);
  assert.throws(() => compile({ name: 'badv2', rows: 4, cols: 4, voids: [{ r: 1, c: 1 }], clues: [], givens: [{ r: 1, c: 0, dir: 'H', v: 1 }] }), /void/);
  assert.throws(() => compile({ name: 'badv3', rows: 4, cols: 4, voids: [{ r: 1, c: 1 }, { r: 1, c: 1 }], clues: [] }), /duplicate void/);
  assert.throws(() => compile({ name: 'badv4', rows: 4, cols: 4, voids: [{ r: 4, c: 0 }], clues: [] }), /void out of bounds/);

  // 4. 120 random 4x4 and 5x5 shaped boards (exterior cutouts + interior holes, standard + fullBoard)
  const rng = mulberry32(202611);
  let checkedNonZero = 0;
  for (let k = 0; k < 120; k++) {
    const rows = k < 60 ? 4 : 5, cols = k < 60 ? 4 : 5;
    const voidCount = 1 + (k % 4);
    const used = new Set();
    const voids = [];
    for (let j = 0; j < voidCount; j++) {
      const r = (rng() * rows) | 0, c = (rng() * cols) | 0;
      if (used.has(r * cols + c)) continue;
      used.add(r * cols + c);
      voids.push({ r, c });
    }
    const clues = [];
    const nClues = k % 5 === 0 ? 0 : 1 + (k % 4);
    for (let j = 0; j < nClues; j++) {
      const r = (rng() * rows) | 0, c = (rng() * cols) | 0;
      if (used.has(r * cols + c)) continue;
      used.add(r * cols + c);
      const t = rng() < 0.45 ? 'W' : rng() < 0.85 ? 'B' : 'G';
      clues.push({ r, c, t });
    }
    const fullBoard = k % 4 === 3;
    const P = compile({ name: `sh_${k}`, rows, cols, voids, clues, fullBoard });
    const ref = referenceCount(P);
    const lim = rows === 4 ? 500 : 10;
    const fast = solve(P, { limit: lim });
    assert.equal(fast.exceeded, false);
    assert.equal(fast.count, Math.min(ref, lim), `shaped mismatch on ${k}: fast=${fast.count} ref=${ref}`);
    for (const sol of fast.solutions) assert.equal(isSolved(P, sol.e), true);
    if (ref > 0) checkedNonZero++;
  }
  assert.ok(checkedNonZero >= 35, `expected >= 35 solvable shaped boards, got ${checkedNonZero}`);

  // 5. CSV roundtrip + dihedral symmetryKey + puzzleHash
  const pA = compile({
    name: 'rt_sh', rows: 5, cols: 6,
    voids: [{ r: 0, c: 0 }, { r: 2, c: 3 }],
    clues: [{ r: 1, c: 2, t: 'W' }],
  });
  const parsed = parseCsv(toCsv([pA]))[0];
  assert.deepEqual(parsed.voids, [{ r: 0, c: 0 }, { r: 2, c: 3 }]);
  assert.deepEqual(parsed.clues, pA.clues);
  const pFlip = compile({
    name: 'rt_sh_flip', rows: 5, cols: 6,
    voids: [{ r: 0, c: 5 }, { r: 2, c: 2 }],
    clues: [{ r: 1, c: 3, t: 'W' }],
  });
  assert.equal(symmetryKey(pA), symmetryKey(pFlip));
  assert.notEqual(puzzleHash(pA), puzzleHash(pFlip));
});

test('slitherlink & hybrids (slither+masyu, slither+fullBoard): brute-force cross-check, CSV roundtrip, symmetryKey, and puzzleHash', () => {
  const rng = mulberry32(2026);
  let checkedPure = 0, checkedHybrid = 0, checkedFull = 0;

  for (let k = 0; k < 150; k++) {
    const rows = k < 100 ? 4 : 5;
    const cols = k < 100 ? 4 : 5;
    const fr = rows - 1, fc = cols - 1;
    const mode = k % 3; // 0 = pure slitherlink, 1 = slither+masyu, 2 = slither+fullBoard
    const nSl = mode === 0 ? 2 + ((rng() * 5) | 0) : 1 + ((rng() * 3) | 0);
    const usedF = new Set();
    const slither = [];
    while (slither.length < nSl) {
      const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
      const f = r * fc + c;
      if (usedF.has(f)) continue;
      usedF.add(f);
      slither.push({ r, c, n: (rng() * 4) | 0 });
    }
    const clues = [];
    if (mode === 1) {
      const usedC = new Set();
      const nCl = 1 + ((rng() * 3) | 0);
      while (clues.length < nCl) {
        const r = (rng() * rows) | 0, c = (rng() * cols) | 0;
        const i = r * cols + c;
        if (usedC.has(i)) continue;
        usedC.add(i);
        clues.push({ r, c, t: rng() < 0.5 ? 'W' : 'B' });
      }
    }
    const fullBoard = mode === 2;
    const P = compile({ name: `sl_${k}`, rows, cols, clues, slither, fullBoard });
    const ref = referenceCount(P);
    const lim = rows === 4 ? 500 : 10;
    const fast = solve(P, { limit: lim });
    assert.equal(fast.exceeded, false);
    assert.equal(fast.count, Math.min(ref, lim), `slitherlink mismatch on ${k} (mode=${mode}): fast=${fast.count} ref=${ref}`);
    for (const sol of fast.solutions) {
      assert.equal(isSolved(P, sol.e), true);
      const dec = decodeSolution(P, encodeSolution(P, sol));
      assert.equal(isSolved(P, dec.e), true);
    }
    if (ref > 0) {
      if (mode === 0) checkedPure++;
      else if (mode === 1) checkedHybrid++;
      else checkedFull++;
    }
  }
  assert.ok(checkedPure >= 15, `expected >= 15 solvable pure slitherlink boards, got ${checkedPure}`);
  assert.ok(checkedHybrid >= 10, `expected >= 10 solvable slither+masyu boards, got ${checkedHybrid}`);
  assert.ok(checkedFull >= 5, `expected >= 5 solvable slither+fullBoard boards, got ${checkedFull}`);

  // CSV roundtrip + dihedral symmetryKey + puzzleHash + validation
  const pA = compile({
    name: 'rt_sl', rows: 4, cols: 5,
    clues: [{ r: 1, c: 2, t: 'W' }],
    slither: [{ r: 0, c: 0, n: 3 }, { r: 2, c: 3, n: 1 }],
  });
  const parsed = parseCsv(toCsv([pA]))[0];
  assert.deepEqual(parsed.clues, pA.clues);
  assert.deepEqual(parsed.slither, [{ r: 0, c: 0, n: 3 }, { r: 2, c: 3, n: 1 }]);
  const pFlip = compile({
    name: 'rt_sl_flip', rows: 4, cols: 5,
    clues: [{ r: 1, c: 2, t: 'W' }],
    slither: [{ r: 0, c: 3, n: 3 }, { r: 2, c: 0, n: 1 }],
  });
  assert.equal(symmetryKey(pA), symmetryKey(pFlip));
  assert.notEqual(puzzleHash(pA), puzzleHash(pFlip));
  assert.throws(() => compile({ name: 'bad_s', rows: 4, cols: 4, clues: [], slither: [{ r: 3, c: 0, n: 2 }] }), /out of bounds/);
  assert.throws(() => compile({ name: 'bad_n', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 0, n: 4 }] }), /bad slitherlink/);
});
