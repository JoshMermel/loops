import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, isSolved, encodeSolution, decodeSolution,
  toCsvRow, parseCsv, symmetryKey, puzzleHash, initialState, E_ON, E_OFF,
} from '../js/logic.js';
import { rate, nextSteps, detectSymmetries } from '../js/rating.js';
import { explainStep } from '../js/explain.js';
import { computeHint, checkMarksAgainstSolution } from '../js/hintstep.js';
import { autoXForced } from '../js/marks.js';
import { midloopStates, earlyLoopEdges } from '../js/clues.js';
import { rotatePuzzleCW } from '../js/rotate.js';
import { boardSvg } from '../js/print.js';
import { makeRng, randomLoop, generatePuzzle } from '../js/generator.js';
import { referenceCount } from './reference_solver.mjs';

/** Extract all exact geometric Mid-loop dots from a solved loop `edges`. */
function dotsFromLoop(P, edges) {
  const { rows, cols, ed, nb } = P;
  const out = [];
  // Horizontal straight runs
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols - 1) {
      const x = ed[(r * cols + c) * 4 + 1];
      if (x < 0 || edges[x] !== E_ON) { c++; continue; }
      const start = c;
      while (c < cols - 1) {
        const y = ed[(r * cols + c) * 4 + 1];
        if (y < 0 || edges[y] !== E_ON) break;
        c++;
      }
      const len = c - start;
      if ((len & 1) === 0) out.push({ r, c: start + (len >> 1), dir: 'C' });
      else out.push({ r, c: start + (len >> 1), dir: 'H' });
    }
  }
  // Vertical straight runs
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows - 1) {
      const x = ed[(r * cols + c) * 4 + 2];
      if (x < 0 || edges[x] !== E_ON) { r++; continue; }
      const start = r;
      while (r < rows - 1) {
        const y = ed[(r * cols + c) * 4 + 2];
        if (y < 0 || edges[y] !== E_ON) break;
        r++;
      }
      const len = r - start;
      if ((len & 1) === 0) out.push({ r: start + (len >> 1), c, dir: 'C' });
      else out.push({ r: start + (len >> 1), c, dir: 'V' });
    }
  }
  return out;
}

test('Mid-loop exact solver matches independent brute-force reference across 120 random pure & hybrid boards', () => {
  const rng = makeRng(2026);
  let checked = 0, uniqueFound = 0;
  for (const [rows, cols] of [[4, 4], [4, 5], [5, 5]]) {
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    for (let t = 0; t < 40; t++) {
      const { edges } = randomLoop(rows, cols, rng);
      const allDots = dotsFromLoop(empty, edges);
      // Sample a random subset of dots (including occasional non-loop dots to test 0-solution pruning)
      const midloop = [];
      for (const d of allDots) if (rng() < 0.55) midloop.push(d);
      if (t % 7 === 0 && midloop.length === 0 && allDots.length > 0) midloop.push(allDots[0]);
      if (t % 11 === 0) {
        // Inject a random dot (might yield 0 solutions!)
        const rr = (rng() * (rows - 1)) | 0, cc = (rng() * (cols - 1)) | 0;
        const dir = rng() < 0.5 ? 'H' : 'V';
        if (!midloop.some((m) => m.r === rr && m.c === cc && m.dir === dir)) midloop.push({ r: rr, c: cc, dir });
      }
      const clues = [];
      if (t % 4 === 1) {
        // Mix in a Masyu white or black circle on a non-dot cell
        const dotCells = new Set(midloop.filter((m) => m.dir === 'C').map((m) => m.r * cols + m.c));
        for (let i = 0; i < rows * cols; i++) {
          if (dotCells.has(i)) continue;
          const r = (i / cols) | 0, c = i % cols;
          const u = empty.ed[i * 4], rt = empty.ed[i * 4 + 1], dn = empty.ed[i * 4 + 2], l = empty.ed[i * 4 + 3];
          const v = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
          const h = rt >= 0 && l >= 0 && edges[rt] === E_ON && edges[l] === E_ON;
          if ((v || h) && rng() < 0.2) {
            const d1 = v ? 0 : 1, d2 = d1 ^ 2;
            const e1 = empty.ed2[i * 4 + d1], e2 = empty.ed2[i * 4 + d2];
            if (!(e1 >= 0 && edges[e1] === E_ON && e2 >= 0 && edges[e2] === E_ON)) {
              clues.push({ r, c, t: 'W' });
              break;
            }
          }
        }
      }
      const slither = [];
      if (t % 4 === 2) {
        const fr = rows - 1, fc = cols - 1;
        const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
        const f4 = (r * fc + c) * 4;
        let cnt = 0;
        for (let d = 0; d < 4; d++) if (edges[empty.faceEdges[f4 + d]] === E_ON) cnt++;
        slither.push({ r, c, n: cnt });
      }
      const fullBoard = t % 5 === 0 && ((rows * cols) & 1) === 0;
      const raw = { name: `m_${rows}x${cols}_${t}`, rows, cols, clues, slither, midloop, fullBoard };
      const P = compile({ ...raw, midloop: midloop.map((m) => ({ ...m })) });
      const fast = solve(P, { limit: 200 });
      const ref = referenceCount(raw);
      assert.equal(fast.count, Math.min(200, ref), `mismatch on ${raw.name}: fast=${fast.count}, ref=${ref}`);
      for (const sol of fast.solutions) assert.equal(isSolved(P, sol.e), true);
      if (fast.count === 1) uniqueFound++;
      checked++;
    }
  }
  assert.equal(checked, 120);
  assert.ok(uniqueFound >= 10, `expected >=10 unique boards in cross-check, got ${uniqueFound}`);
});

test('Mid-loop CSV round-trip, symmetryKey dihedral invariance, puzzleHash, rotation, and print SVG', () => {
  const rawMid = [{ r: 1, c: 2, dir: 'C' }, { r: 0, c: 2, dir: 'H' }, { r: 2, c: 0, dir: 'V' }];
  const raw = {
    name: 'mid_rt',
    rows: 5,
    cols: 6,
    clues: [{ r: 0, c: 0, t: 'B' }],
    slither: [{ r: 2, c: 3, n: 2 }],
    midloop: rawMid.map((m) => ({ ...m })),
  };
  const P = compile(raw);
  const csv = `name,rows,cols,clues,solution,rules,tier,score\n${toCsvRow(P)}\n`;
  const parsed = parseCsv(csv)[0];
  assert.deepEqual(parsed.midloop, rawMid);
  assert.equal(puzzleHash(parsed), puzzleHash(P));

  // Rotate 4 times CW and verify symmetryKey stays identical and dots return to original positions
  let cur = P;
  const k0 = symmetryKey(P);
  for (let step = 0; step < 4; step++) {
    cur = rotatePuzzleCW(cur);
    assert.equal(symmetryKey(cur), k0, `symmetryKey changed after ${step + 1} rotations`);
  }
  assert.deepEqual(cur.midloop, P.midloop);

  // Print SVG renders Mid-loop bullseye dots
  const svg = boardSvg(P);
  assert.ok(svg.includes('class="midloop-dot"'));
  assert.ok(svg.includes('class="midloop-core"'));
});

test('Mid-loop human rules are 100% sound on unique boards and hints solve end-to-end', () => {
  const rng = makeRng(777);
  const empty = compile({ name: 'e6', rows: 6, cols: 6, clues: [] });
  let tested = 0, replayed = 0;
  const firedRules = new Set();

  for (let t = 0; t < 160 && tested < 30; t++) {
    const { edges } = randomLoop(6, 6, rng, { targetFill: 0.45 + 0.15 * rng() });
    const midloop = dotsFromLoop(empty, edges);
    if (midloop.length < 4) continue;
    const P = compile({ name: `ml6_${t}`, rows: 6, cols: 6, clues: [], midloop });
    const ex = solve(P, { limit: 2, maxNodes: 20000 });
    if (ex.exceeded || ex.count !== 1) continue;
    const sol = ex.solutions[0];
    P.solution = encodeSolution(P, sol);

    // Check every rule deduction agrees with unique solution `sol`
    const st = initialState(P);
    let steps = 0;
    while (!isSolved(P, st.e) && steps++ < 400) {
      const next = nextSteps(P, st);
      if (!next) break;
      firedRules.add(next.rule);
      for (const f of next.firings) {
        for (const [kind, idx, val] of f.sets) {
          if (kind === 'e') {
            assert.equal(val, sol.e[idx], `unsound edge deduction by ${next.rule} on ${P.name}`);
            st.e[idx] = val;
          } else if (kind === 'c') {
            assert.equal(val, sol.cell[idx], `unsound cell deduction by ${next.rule} on ${P.name}`);
            st.cell[idx] = val;
          }
        }
      }
    }

    const r = rate(P);
    if (r.solved && (r.tier === 'Beginner' || r.tier === 'Medium') && tested < 6) {
      // End-to-end hint replay from empty board
      const marks = { edges: new Uint8Array(P.numEdges), grays: new Uint8Array(0), autoG: new Uint8Array(0) };
      let hSteps = 0;
      while (!isSolved(P, marks.edges) && hSteps++ < 400) {
        const h = computeHint(P, marks);
        assert.equal(h.kind, 'step', `Hint got ${h.kind} on ${P.name}`);
        assert.ok(h.hints[0].text.length > 5);
        assert.ok(h.hints[0].nudge.length > 5);
        const tg = h.hints[0].targets;
        for (const x of tg.segOn) marks.edges[x] = 1;
        for (const x of tg.segOff) marks.edges[x] = 2;
      }
      assert.equal(isSolved(P, marks.edges), true);
      assert.equal(checkMarksAgainstSolution(P, marks).total, 0);
      replayed++;
    }
    tested++;
  }
  assert.ok(tested >= 15, `expected >=15 unique 6x6 Mid-loop boards, got ${tested}`);
  assert.ok(replayed >= 1, `expected >=1 end-to-end Mid-loop hint replay, got ${replayed}`);
  assert.ok(firedRules.has('midEdgeDot'), 'midEdgeDot should fire');
  assert.ok(firedRules.has('midSymCap') || firedRules.has('midSymExtend'), 'Mid-loop symmetry rules should fire');
});

test('Mid-loop live error states, early loop detection, Auto-X, and symmetry detection', () => {
  // 4x4 simple outer rectangle loop: vertex dot at (0,1)? No, 4x4 outer has sides of length 3 (edge dots at (0,1)H, (1,3)V, (3,1)H, (1,0)V)
  const P = compile({
    name: 'mid_ui',
    rows: 4,
    cols: 4,
    clues: [],
    midloop: [
      { r: 0, c: 1, dir: 'H' },
      { r: 3, c: 1, dir: 'H' },
      { r: 1, c: 0, dir: 'V' },
      { r: 1, c: 3, dir: 'V' },
    ],
  });
  // Exact 180° + mirror + transpose symmetry detected
  const syms = detectSymmetries(P);
  assert.ok(syms.length >= 2, `expected symmetries on symmetric Mid-loop board, got ${syms.length}`);

  // Crossing out an edge dot immediately flags it bad
  const mBad = { edges: new Uint8Array(P.numEdges) };
  mBad.edges[P.midloop[0].edge] = E_OFF;
  assert.equal(midloopStates(P, mBad)[0], 'bad');

  // Closing a tiny 1x1 square on top-left misses the Mid-loop dots -> flagged as early loop
  const mSmall = { edges: new Uint8Array(P.numEdges) };
  mSmall.edges[P.ed[0 * 4 + 1]] = 1;
  mSmall.edges[P.ed[1 * 4 + 2]] = 1;
  mSmall.edges[P.ed[5 * 4 + 3]] = 1;
  mSmall.edges[P.ed[4 * 4 + 0]] = 1;
  assert.ok(earlyLoopEdges(P, mSmall).size === 4);

  // Auto-X on a vertex dot: drawing 1 vertical segment auto-X's both horizontal edges
  const Pv = compile({ name: 'mid_ax', rows: 4, cols: 4, clues: [], midloop: [{ r: 1, c: 1, dir: 'C' }] });
  const mAx = { edges: new Uint8Array(Pv.numEdges), autoE: new Uint8Array(Pv.numEdges) };
  mAx.edges[Pv.ed[(1 * 4 + 1) * 4 + 0]] = 1; // up from (1,1)
  const forced = autoXForced(Pv, mAx);
  assert.equal(forced[Pv.ed[(1 * 4 + 1) * 4 + 1]], 1, 'right of vertex dot should auto-X');
  assert.equal(forced[Pv.ed[(1 * 4 + 1) * 4 + 3]], 1, 'left of vertex dot should auto-X');
  // Only up drawn (lenNeg=1, lenPos=0): conservative Option 1 should NOT cap past (2,1) yet
  assert.equal(forced[Pv.ed[(2 * 4 + 1) * 4 + 2]], 0, 'unequal branches should not auto-X cap');

  // Once both branches are drawn to length 1 and top hits border (0,1), bottom tip (2,1)->(3,1) auto-X's!
  mAx.edges[Pv.ed[(1 * 4 + 1) * 4 + 2]] = 1; // down from (1,1) to (2,1)
  const forcedEq = autoXForced(Pv, mAx);
  assert.equal(forcedEq[Pv.ed[(2 * 4 + 1) * 4 + 2]], 1, 'equal-length branch capped by border should auto-X far tip');

  // Edge dot touching border (k=0): does NOT cap before edge is drawn; DOES cap once edge is drawn
  const Pe = compile({ name: 'mid_ax_e', rows: 4, cols: 5, clues: [], midloop: [{ r: 1, c: 0, dir: 'H' }] });
  const mPe = { edges: new Uint8Array(Pe.numEdges), autoE: new Uint8Array(Pe.numEdges) };
  assert.equal(autoXForced(Pe, mPe)[Pe.ed[(1 * 5 + 1) * 4 + 1]], 0, 'untouched border edge dot should not auto-X');
  mPe.edges[Pe.midloop[0].edge] = 1;
  assert.equal(autoXForced(Pe, mPe)[Pe.ed[(1 * 5 + 1) * 4 + 1]], 1, 'drawn border edge dot should auto-X right continuation');

  // Edge dot 1 cell from border: conservative Option 1 waits until BOTH branches are drawn to length 1
  const Pe1 = compile({ name: 'mid_ax_e1', rows: 4, cols: 6, clues: [], midloop: [{ r: 1, c: 1, dir: 'H' }] });
  const mPe1 = { edges: new Uint8Array(Pe1.numEdges), autoE: new Uint8Array(Pe1.numEdges) };
  mPe1.edges[Pe1.midloop[0].edge] = 1;          // (1,1)-(1,2)
  mPe1.edges[Pe1.ed[(1 * 6 + 2) * 4 + 1]] = 1;  // (1,2)-(1,3): right branch len=1, left branch len=0
  assert.equal(autoXForced(Pe1, mPe1)[Pe1.ed[(1 * 6 + 3) * 4 + 1]], 0, 'Option 1: do not cap before left branch also reaches len 1');
  mPe1.edges[Pe1.ed[(1 * 6 + 1) * 4 + 3]] = 1;  // (1,0)-(1,1): now left branch len=1 (hits border)
  assert.equal(autoXForced(Pe1, mPe1)[Pe1.ed[(1 * 6 + 3) * 4 + 1]], 1, 'Option 1: cap right tip once both branches have len 1');

  // Manual X or 90° turn on one tip caps the equal-length opposite tip too
  const Pe2 = compile({ name: 'mid_ax_e2', rows: 4, cols: 6, clues: [], midloop: [{ r: 1, c: 2, dir: 'H' }] });
  const mPe2 = { edges: new Uint8Array(Pe2.numEdges), autoE: new Uint8Array(Pe2.numEdges) };
  mPe2.edges[Pe2.midloop[0].edge] = 1;          // (1,2)-(1,3)
  mPe2.edges[Pe2.ed[(1 * 6 + 2) * 4 + 0]] = 1;  // 90° turn up at (1,2) -> left branch capped at len=0
  assert.equal(autoXForced(Pe2, mPe2)[Pe2.ed[(1 * 6 + 3) * 4 + 1]], 1, '90° turn on one tip caps equal-length opposite tip');
});

test('generatePuzzle supports midloop, midloop-masyu, midloop-slither, and midloop-full with necessity checks', () => {
  const pm = generatePuzzle({ rows: 6, cols: 6, style: 'midloop', seed: 601, budgetMs: 8000 });
  assert.ok(pm, 'failed to generate pure midloop');
  assert.ok(pm.midloop.length >= 4 && pm.clues.length === 0);
  assert.equal(solve(pm, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pm)).score, pm.score);

  const pmm = generatePuzzle({ rows: 6, cols: 6, style: 'midloop-masyu', seed: 602, budgetMs: 8000 });
  assert.ok(pmm, 'failed to generate midloop-masyu');
  assert.ok(pmm.midloop.length >= 4 && pmm.clues.length >= 3);
  assert.equal(solve(pmm, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pmm)).score, pmm.score);
  assert.ok(solve(compile({ name: 'a', rows: 6, cols: 6, clues: [], midloop: pmm.midloop }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'b', rows: 6, cols: 6, clues: pmm.clues }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pms = generatePuzzle({ rows: 6, cols: 6, style: 'midloop-slither', seed: 603, budgetMs: 8000 });
  assert.ok(pms, 'failed to generate midloop-slither');
  assert.ok(pms.midloop.length >= 4 && pms.slither.length >= 4);
  assert.equal(solve(pms, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pms)).score, pms.score);
  assert.ok(solve(compile({ name: 'c', rows: 6, cols: 6, clues: [], midloop: pms.midloop }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'd', rows: 6, cols: 6, clues: [], slither: pms.slither }), { limit: 2, maxNodes: 50000 }).count >= 2);

  const pmf = generatePuzzle({ rows: 6, cols: 6, style: 'midloop-full', seed: 604, budgetMs: 8000 });
  assert.ok(pmf, 'failed to generate midloop-full');
  assert.equal(pmf.fullBoard, true);
  assert.ok(pmf.midloop.length >= 4);
  assert.equal(solve(pmf, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pmf)).score, pmf.score);
  assert.ok(solve(compile({ name: 'e', rows: 6, cols: 6, clues: [], midloop: pmf.midloop, fullBoard: false }), { limit: 2, maxNodes: 50000 }).count >= 2);

  // Symmetric & Beginner Mid-loop generation
  const pSym = generatePuzzle({ rows: 7, cols: 7, style: 'midloop', layout: 'rot180', seed: 605, budgetMs: 8000 });
  assert.ok(pSym, 'failed to generate rot180 midloop');
  assert.ok(detectSymmetries(pSym).some((s) => s.id === 'rot180'), 'rot180 midloop should preserve 180° symmetry');
  const pBeg = generatePuzzle({ rows: 8, cols: 8, style: 'midloop', targetTier: 'Beginner', seed: 606, budgetMs: 8000 });
  assert.ok(pBeg && pBeg.tier === 'Beginner', 'failed to generate Beginner 8x8 midloop');

  // Pure Mid-loop gimmicks: all-even, all-odd, swiss, long runs, interior-only, hollow frame
  const pEven = generatePuzzle({ rows: 7, cols: 7, style: 'midloop-even', seed: 607, budgetMs: 8000 });
  assert.ok(pEven && pEven.midloop.every((m) => m.dir === 'C'), 'midloop-even must only place intersection dots');
  const pOdd = generatePuzzle({ rows: 8, cols: 8, style: 'midloop-odd', seed: 608, budgetMs: 8000 });
  assert.ok(pOdd && pOdd.midloop.every((m) => m.dir !== 'C'), 'midloop-odd must only place edge dots');
  const pSwiss = generatePuzzle({ rows: 10, cols: 10, style: 'midloop-swiss', seed: 609, budgetMs: 8000 });
  assert.ok(pSwiss && pSwiss.voids.length > 0 && pSwiss.midloop.length >= 4, 'midloop-swiss must place voids & dots');
  const pLong = generatePuzzle({ rows: 8, cols: 8, style: 'midloop-long', seed: 610, budgetMs: 8000 });
  assert.ok(pLong && pLong.midloop.length >= 4, 'midloop-long should generate cleanly');
  const pInt = generatePuzzle({ rows: 8, cols: 8, style: 'midloop', layout: 'interior', seed: 611, budgetMs: 8000 });
  assert.ok(pInt && pInt.midloop.every((m) => m.r > 0 && m.c > 0 && m.r < 7 && m.c < 7), 'interior midloop must avoid border');
  const pFrm = generatePuzzle({ rows: 8, cols: 8, style: 'midloop', layout: 'frame', seed: 612, budgetMs: 8000 });
  assert.ok(pFrm && pFrm.midloop.every((m) => {
    const rr = m.dir === 'V' ? m.r + 0.5 : m.r;
    const cc = m.dir === 'H' ? m.c + 0.5 : m.c;
    return rr < 2 || rr > 5 || cc < 2 || cc > 5;
  }), 'frame midloop must leave 4x4 center blank');
});

test('Mid-loop validation, 1-step rectangular rotation, answer-key print SVG, and noEarlyClose explanation', () => {
  // Validation errors
  assert.throws(() => compile({ name: 'b1', rows: 4, cols: 4, clues: [], midloop: [{ r: 0, c: 0, dir: 'X' }] }));
  assert.throws(() => compile({ name: 'b2', rows: 4, cols: 4, clues: [], midloop: [{ r: 0, c: 3, dir: 'H' }] }));
  assert.throws(() => compile({ name: 'b3', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }], midloop: [{ r: 1, c: 1, dir: 'C' }] }));
  assert.throws(() => compile({ name: 'b4', rows: 4, cols: 4, clues: [], voids: [{ r: 1, c: 1 }], midloop: [{ r: 1, c: 0, dir: 'H' }] }));
  assert.throws(() => compile({ name: 'b5', rows: 4, cols: 4, clues: [], givens: [{ r: 0, c: 1, dir: 'H', v: 0 }], midloop: [{ r: 0, c: 1, dir: 'H' }] }));
  assert.throws(() => compile({ name: 'b6', rows: 4, cols: 4, clues: [], midloop: [{ r: 1, c: 1, dir: 'C' }, { r: 1, c: 1, dir: 'C' }] }));

  // 1-step CW rotation on rectangular 5x6 -> 6x5 checks exact coordinates
  const rect = compile({
    name: 'rect', rows: 5, cols: 6, clues: [],
    midloop: [{ r: 1, c: 2, dir: 'C' }, { r: 0, c: 2, dir: 'H' }, { r: 2, c: 0, dir: 'V' }],
  });
  const r1 = rotatePuzzleCW(rect);
  assert.equal(r1.rows, 6);
  assert.equal(r1.cols, 5);
  assert.deepEqual(
    r1.midloop.map(({ r, c, dir }) => ({ r, c, dir })),
    [{ r: 2, c: 3, dir: 'C' }, { r: 2, c: 4, dir: 'V' }, { r: 0, c: 1, dir: 'H' }],
  );

  // Answer-key print SVG includes solution loop and widened Mid-loop bullseye
  const sq = compile({
    name: 'sq4', rows: 4, cols: 4, clues: [],
    midloop: [{ r: 0, c: 1, dir: 'H' }, { r: 3, c: 1, dir: 'H' }, { r: 1, c: 0, dir: 'V' }, { r: 1, c: 3, dir: 'V' }],
  });
  const sol = solve(sq, { limit: 1 }).solutions[0];
  const keySvg = boardSvg(sq, sol);
  assert.ok(keySvg.includes('class="loop"'));
  assert.ok(keySvg.includes('class="midloop-halo"'));
  assert.ok(keySvg.includes('r="0.20"'));

  // noEarlyClose explanation with midIdx mentions the Mid-loop dot and highlights it
  const st = initialState(sq);
  st.e[sq.ed[0 * 4 + 1]] = E_ON;
  st.e[sq.ed[1 * 4 + 2]] = E_ON;
  st.e[sq.ed[4 * 4 + 0]] = E_ON;
  const closeEdge = sq.ed[4 * 4 + 1];
  const exp = explainStep(sq, { rule: 'noEarlyClose', tier: 'Beginner', weight: 3, sets: [['e', closeEdge, E_OFF]], info: { edge: closeEdge, a: 4, b: 5, midIdx: 0 } }, st);
  assert.match(exp.text, /Mid-loop dot/);
  assert.ok(exp.roles.clue.includes(sq.midloop[0].a));
});
