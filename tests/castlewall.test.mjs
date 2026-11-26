import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, propagate, isSolved, encodeSolution, decodeSolution,
  toCsvRow, parseCsv, symmetryKey, puzzleHash, initialState, E_ON, E_OFF,
} from '../js/logic.js';
import { Board, interiorPlainVoids } from '../js/board.js';
import { rate, nextSteps, detectSymmetries } from '../js/rating.js';
import { explainStep } from '../js/explain.js';
import { computeHint, checkMarksAgainstSolution } from '../js/hintstep.js';
import {
  autoXForced, autoShadeCompute, reconcileAutoShade, applyAutoShade,
  facesFromSolvedLoop, shadeConflicts, FACE_BLANK, FACE_IN, FACE_OUT,
} from '../js/marks.js';
import { castleStates, earlyLoopEdges } from '../js/clues.js';
import { findCastleRayBound, castleContradiction } from '../js/variants/castlewall.js';
import { rotatePuzzleCW } from '../js/rotate.js';
import { boardSvg } from '../js/print.js';
import { makeRng, randomLoop, generatePuzzle } from '../js/generator.js';
import { referenceCount } from './reference_solver.mjs';

/** Compute inside/outside parity of each dual face for a closed loop `edges` via BFS from exterior. */
function faceInsideMap(rows, cols, edges, ed) {
  const fr = rows - 1, fc = cols - 1;
  const inside = new Int8Array(fr * fc).fill(-1);
  const q = [];
  const push = (r, c, par) => {
    const f = r * fc + c;
    if (inside[f] >= 0) return;
    inside[f] = par;
    q.push(f);
  };
  for (let c = 0; c < fc; c++) {
    push(0, c, edges[ed[c * 4 + 1]] === E_ON ? 1 : 0);
    push(fr - 1, c, edges[ed[((rows - 1) * cols + c) * 4 + 1]] === E_ON ? 1 : 0);
  }
  for (let r = 0; r < fr; r++) {
    push(r, 0, edges[ed[(r * cols) * 4 + 2]] === E_ON ? 1 : 0);
    push(r, fc - 1, edges[ed[(r * cols + cols - 1) * 4 + 2]] === E_ON ? 1 : 0);
  }
  for (let head = 0; head < q.length; head++) {
    const f = q[head];
    const r = (f / fc) | 0, c = f % fc, par = inside[f];
    if (r > 0) push(r - 1, c, par ^ (edges[ed[(r * cols + c) * 4 + 1]] === E_ON ? 1 : 0));
    if (r + 1 < fr) push(r + 1, c, par ^ (edges[ed[((r + 1) * cols + c) * 4 + 1]] === E_ON ? 1 : 0));
    if (c > 0) push(r, c - 1, par ^ (edges[ed[(r * cols + c) * 4 + 2]] === E_ON ? 1 : 0));
    if (c + 1 < fc) push(r, c + 1, par ^ (edges[ed[(r * cols + c + 1) * 4 + 2]] === E_ON ? 1 : 0));
  }
  return inside;
}

/** Count parallel segments along a Castle Wall ray from (r, c) in direction `dir` on `edges`. */
function rayCount(rows, cols, ed, edges, r, c, dir) {
  const dr = dir === 'U' ? -1 : dir === 'D' ? 1 : 0;
  const dc = dir === 'L' ? -1 : dir === 'R' ? 1 : 0;
  const d = dir === 'U' ? 0 : dir === 'R' ? 1 : dir === 'D' ? 2 : 3;
  let n = 0;
  for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < rows && cc >= 0 && cc < cols; rr += dr, cc += dc) {
    const x = ed[(rr * cols + cc) * 4 + d];
    if (x >= 0 && edges[x] === E_ON) n++;
  }
  return n;
}

test('Castle Wall exact solver matches independent brute-force reference across 120 random pure & hybrid boards', () => {
  const rng = makeRng(2027);
  const dirs = ['U', 'R', 'D', 'L'];
  let checked = 0, uniqueFound = 0;

  for (const [rows, cols] of [[4, 4], [4, 5], [5, 5]]) {
    const empty = compile({ name: 'ec', rows, cols, clues: [] });
    for (let t = 0; t < 40; t++) {
      const { edges } = randomLoop(rows, cols, rng, { targetFill: 0.50 });
      const used = new Uint8Array(rows * cols);
      for (let x = 0; x < empty.numEdges; x++) {
        if (edges[x] === E_ON) { used[empty.edgeA[x]] = 1; used[empty.edgeB[x]] = 1; }
      }
      const inside = faceInsideMap(rows, cols, edges, empty.ed);
      const fr = rows - 1, fc = cols - 1;
      const unused = [];
      for (let i = 0; i < rows * cols; i++) if (!used[i]) unused.push(i);

      const castle = [];
      for (const cell of unused) {
        if (rng() > 0.55) continue;
        const r = (cell / cols) | 0, c = cell % cols;
        const isBorder = r === 0 || r === rows - 1 || c === 0 || c === cols - 1;
        const isIn = !isBorder && inside[(r - 1) * fc + (c - 1)] === 1;
        const wall = rng() < 0.25 ? 'G' : (isIn ? 'W' : 'B');
        let dir = '', n = -1;
        if (wall === 'G' || rng() < 0.75) {
          const validDirs = dirs.filter((d) => (
            (d === 'U' && r >= 2) || (d === 'D' && r <= rows - 3)
            || (d === 'L' && c >= 2) || (d === 'R' && c <= cols - 3)
          ));
          if (validDirs.length) {
            dir = validDirs[(rng() * validDirs.length) | 0];
            n = rayCount(rows, cols, empty.ed, edges, r, c, dir);
          }
        }
        if (wall === 'G' && !dir) continue;
        castle.push({ r, c, wall, dir, n });
      }
      if (t % 9 === 0 && castle.length > 0 && castle[0].dir) {
        // Occasionally perturb a count to test 0-solution pruning
        castle[0].n = castle[0].n + 1;
      }

      const clues = [];
      if (t % 4 === 1) {
        for (let i = 0; i < rows * cols; i++) {
          if (!used[i]) continue;
          const u = empty.ed[i * 4], rt = empty.ed[i * 4 + 1], dn = empty.ed[i * 4 + 2], l = empty.ed[i * 4 + 3];
          const v = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
          const h = rt >= 0 && l >= 0 && edges[rt] === E_ON && edges[l] === E_ON;
          if ((v || h) && rng() < 0.25) {
            const d1 = v ? 0 : 1, d2 = d1 ^ 2;
            const e1 = empty.ed2[i * 4 + d1], e2 = empty.ed2[i * 4 + d2];
            if (!(e1 >= 0 && edges[e1] === E_ON && e2 >= 0 && edges[e2] === E_ON)) {
              clues.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
              break;
            }
          }
        }
      }

      const slither = [];
      if (t % 4 === 2) {
        const blocked = new Set(castle.map((cw) => cw.r * cols + cw.c));
        for (let rr = 0; rr < fr; rr++) {
          let added = false;
          for (let cc = 0; cc < fc; cc++) {
            const corners = [rr * cols + cc, rr * cols + cc + 1, (rr + 1) * cols + cc, (rr + 1) * cols + cc + 1];
            if (corners.some((k) => blocked.has(k))) continue;
            const f4 = (rr * fc + cc) * 4;
            let cnt = 0;
            for (let d = 0; d < 4; d++) if (edges[empty.faceEdges[f4 + d]] === E_ON) cnt++;
            slither.push({ r: rr, c: cc, n: cnt });
            added = true;
            break;
          }
          if (added) break;
        }
      }

      const midloop = [];
      if (t % 4 === 3) {
        const blocked = new Set(castle.map((cw) => cw.r * cols + cw.c));
        for (let r = 0; r < rows && !midloop.length; r++) {
          for (let c = 0; c < cols - 1; c++) {
            const a = r * cols + c, b = a + 1;
            if (blocked.has(a) || blocked.has(b)) continue;
            const x = empty.ed[a * 4 + 1];
            if (x < 0 || edges[x] !== E_ON) continue;
            const prevE = empty.ed[a * 4 + 3], nextE = empty.ed[b * 4 + 1];
            if ((prevE < 0 || edges[prevE] !== E_ON) && (nextE < 0 || edges[nextE] !== E_ON)) {
              midloop.push({ r, c, dir: 'H' });
              break;
            }
          }
        }
      }

      const fullBoard = t % 7 === 0 && castle.length === unused.length && ((rows * cols - castle.length) & 1) === 0;
      const raw = { name: `cw_${rows}x${cols}_${t}`, rows, cols, clues, slither, midloop, castle, fullBoard };
      const P = compile({ ...raw, castle: castle.map((cw) => ({ ...cw })) });
      const fast = solve(P, { limit: 200 });
      const ref = referenceCount(raw);
      assert.equal(fast.count, Math.min(200, ref), `mismatch on ${raw.name}: fast=${fast.count}, ref=${ref}`);
      for (const sol of fast.solutions) assert.equal(isSolved(P, sol.e), true);
      if (fast.count === 1) uniqueFound++;
      checked++;
    }
  }
  assert.equal(checked, 120);
  assert.ok(uniqueFound >= 8, `expected >=8 unique boards in cross-check, got ${uniqueFound}`);
});

test('Castle Wall CSV round-trip, symmetryKey dihedral invariance, puzzleHash, rotation, and print SVG', () => {
  const rawCastle = [
    { r: 0, c: 0, wall: 'B', dir: 'R', n: 2 },
    { r: 2, c: 2, wall: 'W', dir: '', n: -1 },
    { r: 1, c: 4, wall: 'G', dir: 'D', n: 1 },
  ];
  const raw = {
    name: 'cw_rt',
    rows: 5,
    cols: 6,
    clues: [{ r: 4, c: 5, t: 'B' }],
    castle: rawCastle.map((cw) => ({ ...cw })),
  };
  const P = compile(raw);
  const csv = `name,rows,cols,clues,solution,rules,tier,score\n${toCsvRow(P)}\n`;
  assert.ok(csv.includes('0:0:CBR2'), 'numbered black castle token serialized');
  assert.ok(csv.includes('2:2:CW'), 'unnumbered white castle token serialized');
  assert.ok(csv.includes('1:4:CGD1'), 'numbered gray castle token serialized');
  assert.ok(!csv.includes(':X'), 'Castle Wall tiles must not duplicate plain void :X tokens');

  const parsed = parseCsv(csv)[0];
  assert.deepEqual(parsed.castle, rawCastle);
  assert.equal(parsed.voids?.length ?? 0, 0);
  assert.equal(puzzleHash(parsed), puzzleHash(P));

  // Rotate 4 times CW on rectangular 5x6 board: symmetryKey stays constant and tiles return identically
  let cur = P;
  const k0 = symmetryKey(P);
  for (let step = 0; step < 4; step++) {
    cur = rotatePuzzleCW(cur);
    assert.equal(symmetryKey(cur), k0, `symmetryKey changed after ${step + 1} rotations`);
  }
  assert.deepEqual(
    cur.castle.map(({ r, c, wall, dir, n }) => ({ r, c, wall, dir, n })),
    rawCastle,
  );

  // Print SVG renders crisp Castle Wall tiles (and NOT plain Swiss cheese void fills)
  const svg = boardSvg(P);
  assert.ok(svg.includes('class="castle-print"'));
  assert.ok(svg.includes('fill="#fff"') && svg.includes('fill="#c8c8c8"'));
  assert.ok(!svg.includes('class="void-hole-print"'), 'Castle Wall tiles should not also render plain void-hole-print');
});

test('Castle Wall human rules (including castleRayDiff and castleRayBound) are 100% sound and hints solve end-to-end', () => {
  // Targeted check for castleRayDiff (collinear same-direction arrows with >=2 open edges ahead of c2)
  const pDiff = compile({
    name: 'cw_diff',
    rows: 5,
    cols: 7,
    clues: [],
    castle: [
      { r: 2, c: 0, wall: 'G', dir: 'R', n: 1 },
      { r: 2, c: 3, wall: 'G', dir: 'R', n: 1 },
    ],
  });
  const stDiff = initialState(pDiff);
  // Gap between (1,0) and (1,3) is edge (1,1)-(1,2), diff = 1 - 1 = 0 -> must be E_OFF
  let sawDiff = false;
  for (let iter = 0; iter < 10; iter++) {
    const nxt = nextSteps(pDiff, stDiff);
    if (!nxt) break;
    if (nxt.rule === 'castleRayDiff') {
      sawDiff = true;
      const ex = explainStep(pDiff, { rule: nxt.rule, sets: nxt.firings[0].sets, info: nxt.firings[0].info });
      assert.ok(ex.text.includes('zero segments in the gap'), `unexpected castleRayDiff text: ${ex.text}`);
      break;
    }
    for (const [kind, idx, val] of nxt.firings[0].sets) {
      if (kind === 'e') stDiff.e[idx] = val;
      else if (kind === 'c') stDiff.cell[idx] = val;
    }
  }
  assert.ok(sawDiff, 'castleRayDiff should fire on collinear equal-count arrows');

  // Soundness fuzz + end-to-end hint solve across generated 6x6 and 7x7 Castle Wall puzzles
  const firedRules = new Set();
  let replayed = 0;
  for (let i = 0; i < 10; i++) {
    const p = generatePuzzle({ rows: i < 5 ? 6 : 7, cols: i < 5 ? 6 : 7, style: 'castle', seed: 900 + i * 137, budgetMs: 6000 });
    assert.ok(p, `failed to generate castle puzzle ${i}`);
    const P = compile(p);
    const sol = decodeSolution(P, p.solution);
    assert.equal(isSolved(P, sol.e), true);

    // Every rated step must agree 100% with the unique solution
    const r = rate(P);
    for (const s of r.steps) {
      firedRules.add(s.rule);
      for (const [kind, idx, val] of s.sets) {
        if (kind === 'e') assert.equal(val, sol.e[idx], `unsound edge deduction by ${s.rule}`);
      }
    }

    if (r.solved && (r.tier === 'Beginner' || r.tier === 'Medium') && replayed < 3) {
      const marks = { edges: new Uint8Array(P.numEdges), grays: new Uint8Array(0), autoG: new Uint8Array(0) };
      let hSteps = 0;
      while (!isSolved(P, marks.edges) && hSteps++ < 400) {
        const h = computeHint(P, marks);
        assert.equal(h.kind, 'step', `Hint got ${h.kind} on ${P.name}`);
        assert.ok(h.hints[0].text.length > 5);
        assert.ok(h.hints[0].nudge.length > 5);
        for (const x of h.hints[0].targets.segOn) marks.edges[x] = 1;
        for (const x of h.hints[0].targets.segOff) marks.edges[x] = 2;
      }
      assert.equal(isSolved(P, marks.edges), true);
      assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
      replayed++;
    }
  }
  assert.ok(replayed >= 1, 'expected at least one end-to-end Castle Wall hint replay');
  assert.ok(firedRules.has('castleCount'), 'castleCount should fire');
  assert.ok(firedRules.has('castleWallEdge'), 'castleWallEdge should fire');
});

test('Castle Wall live error states, early loop detection, Auto-X, Auto-Shade, and symmetry detection', () => {
  // Symmetric 5x5 board with a centered White tile (inside) and opposite Black corner arrows
  const P = compile({
    name: 'cw_ui',
    rows: 5,
    cols: 5,
    clues: [],
    castle: [
      { r: 0, c: 0, wall: 'B', dir: 'R', n: 0 },
      { r: 2, c: 2, wall: 'W', dir: '', n: -1 },
      { r: 4, c: 4, wall: 'B', dir: 'L', n: 0 },
    ],
  });
  const syms = detectSymmetries(P);
  assert.ok(syms.some((s) => s.id === 'rot180'), '180° symmetry with opposite arrows should be detected');

  // Auto-X on 0-arrow crosses out all parallel edges along top row
  const mEmpty = { edges: new Uint8Array(P.numEdges), autoE: new Uint8Array(P.numEdges) };
  const forced = autoXForced(P, mEmpty);
  for (const x of P.castle[0].edges) {
    assert.equal(forced[x], 1, '0-arrow ray edge should auto-X');
  }

  // Auto-Shade seeds White tile's hole as Inside and Black tile's hole as Outside
  const pShade = compile({
    name: 'cw_shade',
    rows: 5,
    cols: 5,
    clues: [],
    castle: [
      { r: 1, c: 1, wall: 'W', dir: '', n: -1 },
      { r: 3, c: 3, wall: 'B', dir: '', n: -1 },
    ],
  });
  const mShade = {
    edges: new Uint8Array(pShade.numEdges),
    autoE: new Uint8Array(pShade.numEdges),
    faces: new Uint8Array((5 - 1) * (5 - 1)),
    autoF: new Uint8Array((5 - 1) * (5 - 1)),
  };
  const shaded = autoShadeCompute(pShade, mShade);
  assert.equal(shaded.color[pShade.castle[0].face], FACE_IN, 'White Castle Wall tile should auto-shade Inside');
  assert.equal(shaded.color[pShade.castle[1].face], FACE_OUT, 'Black Castle Wall tile should auto-shade Outside');

  // Live error state flags a 0-arrow immediately when a segment is drawn on its ray
  const mBad = { edges: new Uint8Array(P.numEdges) };
  mBad.edges[P.castle[0].edges[0]] = 1;
  assert.equal(castleStates(P, mBad)[0], 'bad', 'exceeded arrow count should flag bad');

  // Closing a small loop around (0,1)-(1,2) that leaves the White tile at (2,2) outside is flagged as early loop
  const mLoop = { edges: new Uint8Array(P.numEdges) };
  mLoop.edges[P.ed[(0 * 5 + 1) * 4 + 1]] = 1; // (0,1)-(0,2)
  mLoop.edges[P.ed[(0 * 5 + 2) * 4 + 2]] = 1; // (0,2)-(1,2)
  mLoop.edges[P.ed[(1 * 5 + 2) * 4 + 3]] = 1; // (1,2)-(1,1)
  mLoop.edges[P.ed[(1 * 5 + 1) * 4 + 0]] = 1; // (1,1)-(0,1)
  assert.equal(earlyLoopEdges(P, mLoop).size, 4, 'loop leaving White wall outside should flag early loop');
});

test('generatePuzzle supports castle, castle-masyu, castle-slither, castle-midloop, and castle-full with necessity checks', () => {
  const pc = generatePuzzle({ rows: 6, cols: 6, style: 'castle', seed: 701, budgetMs: 8000 });
  assert.ok(pc, 'failed to generate pure castle');
  assert.ok(pc.castle.length >= 3 && pc.clues.length === 0);
  assert.equal(solve(pc, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pc)).score, pc.score);

  const pcm = generatePuzzle({ rows: 7, cols: 7, style: 'castle-masyu', seed: 702, budgetMs: 8000 });
  assert.ok(pcm, 'failed to generate castle-masyu');
  assert.ok(pcm.castle.length >= 3 && pcm.clues.length >= 3);
  assert.equal(solve(pcm, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pcm)).score, pcm.score);
  const plainVoidsM = pcm.castle.map(({ r, c }) => ({ r, c }));
  assert.ok(solve(compile({ name: 'a', rows: 7, cols: 7, clues: [], castle: pcm.castle }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'b', rows: 7, cols: 7, clues: pcm.clues, voids: plainVoidsM }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pcs = generatePuzzle({ rows: 7, cols: 7, style: 'castle-slither', seed: 703, budgetMs: 8000 });
  assert.ok(pcs, 'failed to generate castle-slither');
  assert.ok(pcs.castle.length >= 3 && pcs.slither.length >= 3);
  assert.equal(solve(pcs, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pcs)).score, pcs.score);
  const plainVoidsS = pcs.castle.map(({ r, c }) => ({ r, c }));
  assert.ok(solve(compile({ name: 'c', rows: 7, cols: 7, clues: [], castle: pcs.castle }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'd', rows: 7, cols: 7, clues: [], slither: pcs.slither, voids: plainVoidsS }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pcml = generatePuzzle({ rows: 7, cols: 7, style: 'castle-midloop', seed: 704, budgetMs: 8000 });
  assert.ok(pcml, 'failed to generate castle-midloop');
  assert.ok(pcml.castle.length >= 3 && pcml.midloop.length >= 3);
  assert.equal(solve(pcml, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pcml)).score, pcml.score);
  const plainVoidsMl = pcml.castle.map(({ r, c }) => ({ r, c }));
  assert.ok(solve(compile({ name: 'e', rows: 7, cols: 7, clues: [], castle: pcml.castle }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'f', rows: 7, cols: 7, clues: [], midloop: pcml.midloop, voids: plainVoidsMl }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pcf = generatePuzzle({ rows: 7, cols: 7, style: 'castle-full', seed: 705, budgetMs: 8000 });
  assert.ok(pcf, 'failed to generate castle-full');
  assert.equal(pcf.fullBoard, true);
  assert.ok(pcf.castle.length >= 3);
  assert.equal(solve(pcf, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pcf)).score, pcf.score);
  assert.ok(solve(compile({ name: 'g', rows: 7, cols: 7, clues: [], castle: pcf.castle, fullBoard: false }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pBeg = generatePuzzle({ rows: 7, cols: 7, style: 'castle', targetTier: 'Beginner', seed: 706, budgetMs: 8000 });
  assert.ok(pBeg && pBeg.tier === 'Beginner', 'failed to generate Beginner 7x7 castle');

  // Verify castle-full ALSO requires Castle Wall clues (plain voids + fullBoard is non-unique)
  const plainVoidsF = pcf.castle.map(({ r, c }) => ({ r, c }));
  assert.ok(
    solve(compile({ name: 'h', rows: 7, cols: 7, clues: [], voids: plainVoidsF, fullBoard: true }), { limit: 2, maxNodes: 50000 }).count >= 2,
    'castle-full Castle Wall clues must not be redundant given plain voids + fullBoard',
  );
});

test('Castle Wall regression coverage: Auto-X closed corridor, castleRayBound modes, noEarlyClose exact tile, impossible boards, 1-step rotation, answer-key print, per-component parity errors', () => {
  // 1. Auto-X MUST NOT cross out valid solution edges on a closed corridor in pure Castle Wall
  const p3 = compile({ name: 'cw_3x3', rows: 3, cols: 3, clues: [], castle: [{ r: 1, c: 1, wall: 'W', dir: '', n: -1 }] });
  assert.equal(solve(p3, { limit: 2 }).count, 1);
  const m3 = { edges: new Uint8Array(p3.numEdges), autoE: new Uint8Array(p3.numEdges) };
  const fx3 = autoXForced(p3, m3);
  for (let x = 0; x < p3.numEdges; x++) {
    if (p3.edgeA[x] >= 0) assert.equal(fx3[x], 0, 'Auto-X must not cross out valid closed-corridor solution edge');
  }

  // 2. castleRayBound targeted modes:
  //    (a) max1 with rem === maxTotal -> turnNeed sets perpendicular otherPerp OFF
  const pTurnNeed = compile({
    name: 'cw_turn_need',
    rows: 4,
    cols: 5,
    clues: [],
    castle: [{ r: 1, c: 0, wall: 'B', dir: 'R', n: 2 }],
  });
  const stTN = initialState(pTurnNeed);
  // Ray from (1,0) R has 3 edges: (1,1)-(1,2), (1,2)-(1,3), (1,3)-(1,4).
  // Put perpendicular ON at (1,2) going UP ((0,2)-(1,2)), leaving (1,2)-(2,2) UNKNOWN -> {(1,1)-(1,2), (1,2)-(1,3)} is max1 (cap 1),
  // plus single edge (1,3)-(1,4) (cap 1) -> maxTotal = 2 === rem! So (1,3)-(1,4) is ON and (1,2)-(2,2) is OFF!
  stTN.e[pTurnNeed.ed[(1 * 5 + 2) * 4 + 0]] = E_ON;
  const rbTN = findCastleRayBound(pTurnNeed, stTN);
  assert.equal(rbTN.length, 1);
  assert.equal(rbTN[0].info.reason, 'turnNeed');
  const perpDown = pTurnNeed.ed[(1 * 5 + 2) * 4 + 2];
  assert.ok(rbTN[0].sets.some(([k, idx, v]) => k === 'e' && idx === perpDown && v === E_OFF), 'turnNeed must cross out straight perpendicular of max1 pair');

  //    (b) runRequired on 2-run + max1 with rem = 2 (maxTotal = 3, 3 - 2 < 2 -> 2-run must be ON)
  const pRunReq = compile({
    name: 'cw_run_req',
    rows: 4,
    cols: 7,
    clues: [],
    castle: [{ r: 1, c: 0, wall: 'B', dir: 'R', n: 2 }],
  });
  const stRR = initialState(pRunReq);
  stRR.e[pRunReq.ed[(1 * 7 + 3) * 4 + 1]] = E_OFF;
  stRR.e[pRunReq.ed[(1 * 7 + 5) * 4 + 0]] = E_OFF;
  stRR.e[pRunReq.ed[(1 * 7 + 5) * 4 + 2]] = E_OFF;
  stRR.e[pRunReq.ed[(1 * 7 + 2) * 4 + 0]] = E_ON;
  const rbRR = findCastleRayBound(pRunReq, stRR);
  assert.equal(rbRR.length, 1);
  assert.equal(rbRR[0].info.reason, 'runRequired');
  assert.equal(rbRR[0].sets.length, 2);
  assert.ok(rbRR[0].sets.every(([, , v]) => v === E_ON), 'runRequired draws the 2-run ON');

  //    (c) rayParity on TWO 2-runs (0|2 each) + ONE max1 (0|1) with rem = 2:
  //        maxTotal = 5, neither 2-run is individually too long or required -> only rayParity forces max1 to 0!
  const pPar2 = compile({
    name: 'cw_ray_parity_even',
    rows: 4,
    cols: 10,
    clues: [],
    castle: [{ r: 1, c: 0, wall: 'B', dir: 'R', n: 2 }],
  });
  const stPar2 = initialState(pPar2);
  // Ray edges: (1,1)-(1,2)-(1,3) [max1 at (1,2)], gap (1,3)-(1,4) OFF,
  //            (1,4)-(1,5)-(1,6) [2-run at (1,5)], gap (1,6)-(1,7) OFF,
  //            (1,7)-(1,8)-(1,9) [2-run at (1,8)].
  stPar2.e[pPar2.ed[(1 * 10 + 3) * 4 + 1]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 6) * 4 + 1]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 5) * 4 + 0]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 5) * 4 + 2]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 8) * 4 + 0]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 8) * 4 + 2]] = E_OFF;
  stPar2.e[pPar2.ed[(1 * 10 + 2) * 4 + 0]] = E_ON;
  const rbPar2 = findCastleRayBound(pPar2, stPar2);
  assert.equal(rbPar2.length, 1);
  assert.equal(rbPar2[0].info.reason, 'rayParity');
  assert.equal(rbPar2[0].sets.length, 2);
  assert.ok(rbPar2[0].sets.every(([, , v]) => v === E_OFF), 'even parity with two 2-runs + max1 forces max1 ray edges OFF');

  // 3. noEarlyClose reports exact failing castleIdx (satisfied Black at index 0, unsatisfied White at index 1)
  const pNec = compile({
    name: 'cw_nec',
    rows: 5,
    cols: 5,
    clues: [],
    castle: [
      { r: 0, c: 0, wall: 'B', dir: '', n: -1 },
      { r: 2, c: 2, wall: 'W', dir: '', n: -1 },
    ],
  });
  const stNec = initialState(pNec);
  // Draw 3 sides of a 1x1 square (0,2)-(0,3)-(1,3)-(1,2) leaving (0,2)-(1,2) unknown; closing it leaves White at (2,2) outside
  stNec.e[pNec.ed[(0 * 5 + 2) * 4 + 1]] = E_ON;
  stNec.e[pNec.ed[(0 * 5 + 3) * 4 + 2]] = E_ON;
  stNec.e[pNec.ed[(1 * 5 + 3) * 4 + 3]] = E_ON;
  stNec.cell[0 * 5 + 2] = 2; stNec.cell[0 * 5 + 3] = 2; stNec.cell[1 * 5 + 3] = 2; stNec.cell[1 * 5 + 2] = 2;
  let sawNec = false;
  for (let iter = 0; iter < 15; iter++) {
    const nxt = nextSteps(pNec, stNec);
    if (!nxt) break;
    if (nxt.rule === 'noEarlyClose') {
      const f = nxt.firings.find((x) => x.info && x.info.castleIdx !== undefined);
      if (f) {
        assert.equal(f.info.castleIdx, 1, 'noEarlyClose must blame exact unsatisfied White tile (idx 1), not satisfied Black tile (idx 0)');
        sawNec = true;
        break;
      }
    }
    for (const [k, idx, v] of nxt.firings[0].sets) {
      if (k === 'e') stNec.e[idx] = v;
      else if (k === 'c') stNec.cell[idx] = v;
    }
  }
  assert.ok(sawNec, 'noEarlyClose should fire with exact castleIdx');

  // 4. Impossible boards & compiler validation
  const pBorderW = compile({ name: 'bad_bw', rows: 4, cols: 4, clues: [], castle: [{ r: 0, c: 1, wall: 'W', dir: '', n: -1 }] });
  assert.equal(pBorderW.castleImpossible, true);
  assert.equal(solve(pBorderW, { limit: 2 }).count, 0);
  assert.equal(referenceCount({ rows: 4, cols: 4, clues: [], castle: [{ r: 0, c: 1, wall: 'W', dir: '', n: -1 }] }), 0);

  const pAdjWB = compile({
    name: 'bad_wb', rows: 5, cols: 5, clues: [],
    castle: [{ r: 2, c: 2, wall: 'W', dir: '', n: -1 }, { r: 2, c: 3, wall: 'B', dir: '', n: -1 }],
  });
  assert.equal(pAdjWB.castleImpossible, true);
  assert.equal(solve(pAdjWB, { limit: 2 }).count, 0);

  assert.throws(() => compile({ name: 'bad_dup', rows: 4, cols: 4, clues: [], castle: [{ r: 1, c: 1, wall: 'W', dir: '', n: -1 }, { r: 1, c: 1, wall: 'B', dir: '', n: -1 }] }));
  assert.throws(() => compile({ name: 'bad_col', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }], castle: [{ r: 1, c: 1, wall: 'B', dir: '', n: -1 }] }));
  assert.throws(() => compile({ name: 'bad_dir', rows: 4, cols: 4, clues: [], castle: [{ r: 1, c: 1, wall: 'G', dir: 'Z', n: 1 }] }));

  // 5. 1-step rectangular rotation exact mapping + answer-key print SVG
  const pRect = compile({
    name: 'cw_rect',
    rows: 5,
    cols: 6,
    clues: [],
    castle: [
      { r: 0, c: 1, wall: 'B', dir: 'R', n: 1 },
      { r: 1, c: 4, wall: 'G', dir: 'D', n: 0 },
      { r: 3, c: 2, wall: 'W', dir: 'U', n: 1 },
      { r: 2, c: 4, wall: 'G', dir: 'L', n: 0 },
    ],
  });
  const rot1 = rotatePuzzleCW(pRect);
  assert.equal(rot1.rows, 6);
  assert.equal(rot1.cols, 5);
  const rotRaw = rot1.castle.map(({ r, c, wall, dir, n }) => ({ r, c, wall, dir, n }));
  assert.deepEqual(rotRaw, [
    { r: 1, c: 4, wall: 'B', dir: 'D', n: 1 },
    { r: 4, c: 3, wall: 'G', dir: 'L', n: 0 },
    { r: 2, c: 1, wall: 'W', dir: 'R', n: 1 },
    { r: 4, c: 2, wall: 'G', dir: 'U', n: 0 },
  ]);
  const sol3 = solve(p3, { limit: 1 }).solutions[0];
  const svgAns = boardSvg(pRect, null);
  assert.ok(svgAns.includes('→') && svgAns.includes('↓') && svgAns.includes('↑') && svgAns.includes('←'), 'print SVG renders all 4 arrow glyphs');
  assert.ok(svgAns.includes('fill="#111"'), 'print SVG renders black tile fill');
  assert.ok(!svgAns.includes('class="shape-outline"'), 'pure Castle Wall print SVG should not draw Swiss-cheese shape-outline');
  const svgWithSol = boardSvg(p3, sol3);
  assert.ok(svgWithSol.includes('class="loop"'), 'answer-key print SVG renders solution loop');

  // 6. Per-component parity isolation in castleStates + direct manual shadeConflicts on W/B tiles
  const pIso = compile({
    name: 'cw_iso',
    rows: 6,
    cols: 6,
    clues: [],
    castle: [
      { r: 1, c: 1, wall: 'W', dir: '', n: -1 },
      { r: 4, c: 4, wall: 'B', dir: '', n: -1 },
    ],
  });
  const mIso = { edges: new Uint8Array(pIso.numEdges), faces: new Uint8Array(25) };
  // Create a direct White-to-border contradiction at (1,1): cross out top edge (0,1)-(0,2)
  mIso.edges[pIso.ed[(0 * 6 + 1) * 4 + 1]] = 2; // E_OFF -> connects White hole (1,1) to EXT (Outside)!
  // Also create an unrelated parity conflict around interior vertex (3,2) in a separate component
  mIso.edges[pIso.ed[(3 * 6 + 2) * 4 + 0]] = 1;
  mIso.edges[pIso.ed[(3 * 6 + 2) * 4 + 1]] = 2;
  mIso.edges[pIso.ed[(3 * 6 + 2) * 4 + 2]] = 2;
  mIso.edges[pIso.ed[(3 * 6 + 2) * 4 + 3]] = 2;
  assert.equal(castleStates(pIso, mIso)[0], 'bad', 'White wall parity error must still report bad despite unrelated conflict in another component');

  // Direct manual shade contradicting White tile (shaded Outside) triggers shadeConflicts when checkBorder=true
  mIso.faces[pIso.castle[0].face] = FACE_OUT;
  assert.ok(shadeConflicts(pIso, mIso, true).has(pIso.castle[0].face), 'manual Outside shade on White wall should flag shade conflict');

  // 7. Round 2 regressions:
  //    (a) Unanchored edge-edge parity conflict MUST NOT trigger false-blame castleParity!
  const stUnanch = initialState(pIso);
  stUnanch.e[pIso.ed[(3 * 6 + 2) * 4 + 0]] = E_ON;
  stUnanch.e[pIso.ed[(3 * 6 + 2) * 4 + 1]] = E_OFF;
  stUnanch.e[pIso.ed[(3 * 6 + 2) * 4 + 2]] = E_OFF;
  stUnanch.e[pIso.ed[(3 * 6 + 2) * 4 + 3]] = E_OFF;
  assert.equal(castleContradiction(pIso, stUnanch), null, 'unanchored edge-edge parity conflict must not falsely blame Castle Wall');

  //    (b) castleContradiction catches 2nd exact1 turn pair on n=1 ray (minTotal=2 > rem=1)
  const pMinOv = compile({ name: 'cw_min_ov', rows: 4, cols: 7, clues: [], castle: [{ r: 1, c: 0, wall: 'B', dir: 'R', n: 1 }] });
  const stMO = initialState(pMinOv);
  // Two disjoint exact1 turn pairs at (1,2) and (1,5) with gap (1,3)-(1,4) OFF
  stMO.e[pMinOv.ed[(1 * 7 + 3) * 4 + 1]] = E_OFF;
  stMO.e[pMinOv.ed[(1 * 7 + 2) * 4 + 0]] = E_ON; stMO.e[pMinOv.ed[(1 * 7 + 2) * 4 + 2]] = E_OFF;
  stMO.e[pMinOv.ed[(1 * 7 + 5) * 4 + 0]] = E_ON; stMO.e[pMinOv.ed[(1 * 7 + 5) * 4 + 2]] = E_OFF;
  const cMO = castleContradiction(pMinOv, stMO);
  assert.ok(cMO && cMO.kind === 'castleBroken' && cMO.over === true, 'castleContradiction must catch exact1 minTotal > rem');

  //    (c) castleContradiction catches over-filled collinear ray-diff gap (3-> vs 2-> with 2 gap edges ON)
  const pDiffOv = compile({
    name: 'cw_diff_ov', rows: 4, cols: 8, clues: [],
    castle: [{ r: 1, c: 0, wall: 'G', dir: 'R', n: 3 }, { r: 1, c: 4, wall: 'G', dir: 'R', n: 2 }],
  });
  const stDO = initialState(pDiffOv);
  stDO.e[pDiffOv.ed[(1 * 8 + 1) * 4 + 1]] = E_ON;
  stDO.e[pDiffOv.ed[(1 * 8 + 2) * 4 + 1]] = E_ON;
  const cDO = castleContradiction(pDiffOv, stDO);
  assert.ok(cDO && cDO.kind === 'castleBroken' && cDO.castleIdx === 0 && cDO.over === true, 'castleContradiction must catch ray-diff gap > diff');

  // 8. Round 3 regressions:
  //    (a) oddCount === 0 parity contradiction (rem=3 with three even length-2 coupled runs -> impossible!)
  const pOdd0 = compile({ name: 'cw_odd0', rows: 5, cols: 10, clues: [], castle: [{ r: 2, c: 0, wall: 'G', dir: 'R', n: 3 }] });
  const stOdd0 = initialState(pOdd0);
  // 3 disjoint length-2 runs: (2,1)-(2,2)-(2,3), (2,4)-(2,5)-(2,6), (2,7)-(2,8)-(2,9)
  stOdd0.e[pOdd0.ed[(2 * 10 + 3) * 4 + 1]] = E_OFF;
  stOdd0.e[pOdd0.ed[(2 * 10 + 6) * 4 + 1]] = E_OFF;
  for (const col of [2, 5, 8]) {
    stOdd0.e[pOdd0.ed[(2 * 10 + col) * 4 + 0]] = E_OFF;
    stOdd0.e[pOdd0.ed[(2 * 10 + col) * 4 + 2]] = E_OFF;
  }
  assert.ok(castleContradiction(pOdd0, stOdd0)?.kind === 'castleBroken', 'oddCount=0 odd rem must trigger castleContradiction');
  assert.equal(propagate(pOdd0, initialState(pOdd0), -1, -1), true);
  assert.equal(propagate(pOdd0, stOdd0), false, 'oddCount=0 odd rem must fail propagate()');

  //    (b) cwDirty double-buffer: propagate() reaches fixed point in 1 call when rayBound re-dirties itself
  const pDb = compile({ name: 'cw_db', rows: 5, cols: 12, clues: [], castle: [{ r: 2, c: 0, wall: 'G', dir: 'R', n: 4 }] });
  const stDb = initialState(pDb);
  for (const col of [2, 3]) {
    stDb.e[pDb.ed[(2 * 12 + col) * 4 + 0]] = E_OFF;
    stDb.e[pDb.ed[(2 * 12 + col) * 4 + 2]] = E_OFF;
  }
  stDb.e[pDb.ed[(2 * 12 + 4) * 4 + 0]] = E_OFF;
  for (const col of [6, 8, 10]) stDb.e[pDb.ed[(2 * 12 + col) * 4 + 0]] = E_ON;
  stDb.e[pDb.ed[(2 * 12 + 10) * 4 + 2]] = E_OFF;
  const hypE = pDb.ed[(2 * 12 + 4) * 4 + 2];
  stDb.e[hypE] = E_OFF;
  assert.equal(propagate(pDb, stDb, hypE), false, 'double-buffered cwDirty must catch self-re-dirtied rayBound contradiction in one propagate() call');

  //    (c) interiorPlainVoids handles border Castle Wall adjacent to interior plain Swiss-cheese void
  const pMixV = compile({
    name: 'cw_mixv', rows: 5, cols: 5, clues: [],
    voids: [{ r: 1, c: 2 }],
    castle: [{ r: 0, c: 2, wall: 'B', dir: 'D', n: 0 }],
  });
  const iv = interiorPlainVoids(pMixV);
  assert.equal(iv[1 * 5 + 2], 1, 'interior plain void next to border Castle Wall must be marked interior');
  assert.equal(iv[0 * 5 + 2], 0, 'Castle Wall tile must never be marked as a plain interior void');
});

test('Castle Wall border tiles auto-shade Outside cleanly, render on Board, unwind when toggled off, and skip plain cutouts', () => {
  // Pure Castle Wall with a left-edge Black tile (1,0), an interior Black tile (1,2), and an interior White tile (3,2)
  const P = compile({
    name: 'cw_edge_shade',
    rows: 5,
    cols: 5,
    clues: [],
    castle: [
      { r: 1, c: 0, wall: 'B', dir: 'D', n: 0 },
      { r: 1, c: 2, wall: 'B', dir: 'D', n: 0 },
      { r: 3, c: 2, wall: 'W', dir: '', n: -1 },
    ],
  });
  const fc = P.cols - 1;
  const f = (r, c) => r * fc + c;
  const m = {
    edges: new Uint8Array(P.numEdges),
    autoE: new Uint8Array(P.numEdges),
    faces: new Uint8Array((P.rows - 1) * fc),
    autoF: new Uint8Array((P.rows - 1) * fc),
  };

  reconcileAutoShade(P, m, true);
  // Both faces touching the left-edge Black tile (1,0) must auto-shade Outside
  assert.equal(m.faces[f(0, 0)], FACE_OUT, 'top face adjacent to left-edge Black tile must auto-shade Outside');
  assert.equal(m.faces[f(1, 0)], FACE_OUT, 'bottom face adjacent to left-edge Black tile must auto-shade Outside');
  assert.equal(m.autoF[f(0, 0)], 1);
  assert.equal(m.autoF[f(1, 0)], 1);
  // Interior Black & White tiles continue to auto-shade Outside / Inside as before
  assert.equal(m.faces[f(0, 1)], FACE_OUT);
  assert.equal(m.faces[f(2, 1)], FACE_IN);

  // Board.render actually emits <rect class="face-out auto" ...> for the edge tile's adjacent faces
  const el = { innerHTML: '', addEventListener() {} };
  const b = new Board(el, {});
  b.setPuzzle(P);
  b.render(m, { clueState: [], slitherState: [], midloopState: [], castleState: [] });
  assert.ok(el.innerHTML.includes('<rect class="face-out auto" x="24" y="24" width="44" height="44"/>'), 'Board must render face (0,0) auto-shade for edge Castle Wall tile');
  assert.ok(el.innerHTML.includes('<rect class="face-out auto" x="24" y="68" width="44" height="44"/>'), 'Board must render face (1,0) auto-shade for edge Castle Wall tile');

  // Toggling Auto-Shade OFF clears both edge and interior auto-shaded faces back to blank
  applyAutoShade(P, m, false);
  assert.equal(m.faces[f(0, 0)], FACE_BLANK);
  assert.equal(m.faces[f(1, 0)], FACE_BLANK);
  assert.equal(m.faces[f(0, 1)], FACE_BLANK);
  assert.equal(m.faces[f(2, 1)], FACE_BLANK);

  // facesFromSolvedLoop also paints border Castle Wall adjacent faces Outside (and rotates cleanly)
  const solvedFaces = facesFromSolvedLoop(P, new Uint8Array(P.numEdges));
  assert.equal(solvedFaces[f(0, 0)], FACE_OUT);
  assert.equal(solvedFaces[f(1, 0)], FACE_OUT);
  const rotP = rotatePuzzleCW(P);
  // (1,0) in 5x5 rotates 90° CW to (0,3); its adjacent dual faces are (0,2) and (0,3)
  assert.equal(rotP.faceExtShade[0 * 4 + 2], 1);
  assert.equal(rotP.faceExtShade[0 * 4 + 3], 1);

  // Mixed plain exterior void at (0,0) + border Castle Wall at (0,2):
  // face (0,0) touches plain void -> stays blank; faces (0,1) and (0,2) lie inside board -> auto-shade Outside
  const pMixed = compile({
    name: 'cw_edge_mixed_void',
    rows: 4,
    cols: 4,
    clues: [],
    voids: [{ r: 0, c: 0 }],
    castle: [{ r: 0, c: 2, wall: 'B', dir: 'D', n: 0 }],
  });
  const mm = {
    edges: new Uint8Array(pMixed.numEdges),
    autoE: new Uint8Array(pMixed.numEdges),
    faces: new Uint8Array(9),
    autoF: new Uint8Array(9),
  };
  reconcileAutoShade(pMixed, mm, true);
  assert.equal(mm.faces[0 * 3 + 0], FACE_BLANK, 'plain exterior cutout face must remain unshaded');
  assert.equal(mm.faces[0 * 3 + 1], FACE_OUT, 'on-board face next to border Castle Wall must auto-shade Outside');
  assert.equal(mm.faces[0 * 3 + 2], FACE_OUT, 'on-board face next to border Castle Wall must auto-shade Outside');
});
