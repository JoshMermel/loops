import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, solve, isSolved, decodeSolution, encodeSolution } from '../js/logic.js';
import { rate, detectSymmetries } from '../js/rating.js';
import { randomLoop, allowedClues, tightLoop, generatePuzzle, makeRng, maskPoints, quadrantStats } from '../js/generator.js';

test('tightLoop returns cur.P.clue and cur.P.clueAt matching cur.clues even when final annealing steps reject', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const res = tightLoop(8, 8, makeRng(seed), { style: 'black', maxSteps: 40 });
    const fresh = compile({ name: 'check', rows: 8, cols: 8, clues: res.clues });
    assert.deepEqual(res.P.clue, fresh.clue, `seed ${seed}: cur.P.clue diverged from cur.clues`);
    assert.deepEqual(res.P.clueAt, fresh.clueAt, `seed ${seed}: cur.P.clueAt diverged from cur.clues`);
  }
});

test('randomLoop always produces a single valid closed loop across sizes', () => {
  const rng = makeRng(101);
  for (const [rows, cols] of [[4, 4], [6, 6], [8, 8], [10, 10], [12, 12]]) {
    for (let k = 0; k < 5; k++) {
      const { edges, loopCells } = randomLoop(rows, cols, rng);
      const empty = compile({ name: 'loop', rows, cols, clues: [] });
      assert.equal(isSolved(empty, edges), true, `randomLoop ${rows}x${cols} #${k} is not a valid single loop`);
      assert.ok(loopCells >= 4);
      const { whites, blacks } = allowedClues(rows, cols, edges);
      const P = compile({ name: 'all', rows, cols, clues: whites.concat(blacks) });
      assert.equal(isSolved(P, edges), true, `allowedClues inconsistent with loop on ${rows}x${cols}`);
    }
  }
});

test('generatePuzzle produces verified unique rated 6x6 and 8x8 puzzles', () => {
  const p6 = generatePuzzle({ rows: 6, cols: 6, seed: 7, budgetMs: 8000 });
  assert.ok(p6, 'failed to generate 6x6 puzzle');
  const exact6 = solve(compile({ name: p6.name, rows: p6.rows, cols: p6.cols, clues: p6.clues }), { limit: 2, maxNodes: 500000 });
  assert.equal(exact6.exceeded, false);
  assert.equal(exact6.count, 1);
  assert.equal(encodeSolution(p6, exact6.solutions[0]), p6.solution);
  assert.equal(isSolved(p6, decodeSolution(p6, p6.solution).e), true);
  const r6 = rate(p6);
  assert.equal(r6.solved, true);
  assert.equal(r6.tier, p6.tier);
  assert.equal(r6.score, p6.score);

  const p8 = generatePuzzle({ rows: 8, cols: 8, seed: 19, budgetMs: 10000 });
  assert.ok(p8, 'failed to generate 8x8 puzzle');
  const exact8 = solve(compile({ name: p8.name, rows: p8.rows, cols: p8.cols, clues: p8.clues }), { limit: 2, maxNodes: 500000 });
  assert.equal(exact8.exceeded, false);
  assert.equal(exact8.count, 1);
  assert.equal(encodeSolution(p8, exact8.solutions[0]), p8.solution);

  // Every generated puzzle's solution loop must touch all 4 outer borders (no dead empty rows/cols)
  for (const p of [p6, p8]) {
    let minR = p.rows, maxR = -1, minC = p.cols, maxC = -1, used = 0;
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      if (p.solution[r * p.cols + c] !== '#') {
        used++;
        if (r < minR) minR = r; if (r > maxR) maxR = r;
        if (c < minC) minC = c; if (c > maxC) maxC = c;
      }
    }
    assert.equal(minR, 0);
    assert.equal(maxR, p.rows - 1);
    assert.equal(minC, 0);
    assert.equal(maxC, p.cols - 1);
    assert.ok(used >= Math.floor(p.rows * p.cols * 0.55));
  }
});

test('generatePuzzle respects targetTier Beginner and style white/black', () => {
  const pb = generatePuzzle({ rows: 6, cols: 6, seed: 33, targetTier: 'Beginner', budgetMs: 8000 });
  assert.ok(pb, 'failed to generate 6x6 Beginner puzzle');
  assert.equal(pb.tier, 'Beginner');

  const pw = generatePuzzle({ rows: 6, cols: 6, seed: 44, style: 'white', budgetMs: 8000 });
  assert.ok(pw, 'failed to generate 6x6 all-white puzzle');
  assert.ok(pw.clues.every((c) => c.t === 'W'));

  const pk = generatePuzzle({ rows: 6, cols: 6, seed: 55, style: 'black', budgetMs: 8000 });
  assert.ok(pk, 'failed to generate 6x6 all-black puzzle');
  assert.ok(pk.clues.every((c) => c.t === 'B'));

  const pgm = generatePuzzle({ rows: 6, cols: 6, seed: 66, style: 'gray-mixed', budgetMs: 8000 });
  assert.ok(pgm, 'failed to generate 6x6 gray-mixed puzzle');
  assert.ok(pgm.clues.some((c) => c.t === 'G'));
  assert.ok(pgm.clues.some((c) => c.t === 'W'));
  assert.ok(pgm.clues.some((c) => c.t === 'B'));
  assert.equal(rate(pgm).solved, true);

  const pga = generatePuzzle({ rows: 6, cols: 6, seed: 77, style: 'gray-all', budgetMs: 10000 });
  assert.ok(pga, 'failed to generate 6x6 gray-all puzzle');
  assert.ok(pga.clues.every((c) => c.t === 'G'));
  assert.equal(rate(pga).solved, true);

  for (const style of ['full-masyu', 'full-lines', 'full-walls', 'full-mixed']) {
    const pf = generatePuzzle({ rows: 6, cols: 6, seed: 88, style, budgetMs: 8000 });
    assert.ok(pf, `failed to generate 6x6 ${style} puzzle`);
    assert.equal(pf.fullBoard, true);
    assert.equal(pf.solution.includes('#'), false);
    assert.equal(rate(pf).solved, true);
    if (style === 'full-masyu') {
      assert.ok(pf.clues.length >= 2);
      // Must genuinely require fullBoard (non-unique as plain Masyu)
      const plain = solve(compile({ name: 'plain', rows: 6, cols: 6, clues: pf.clues }), { limit: 2, maxNodes: 20000 });
      assert.notEqual(plain.count, 1, 'full-masyu puzzle must require fullBoard');
    } else {
      assert.equal(pf.clues.length, 0);
      assert.ok(pf.givens.length >= 2);
      if (style === 'full-lines') assert.ok(pf.givens.every((g) => g.v === 1));
      if (style === 'full-walls') assert.ok(pf.givens.every((g) => g.v === 0));
      if (style === 'full-mixed') {
        assert.ok(pf.givens.some((g) => g.v === 1));
        assert.ok(pf.givens.some((g) => g.v === 0));
      }
    }
  }
});

test('generatePuzzle supports themed layouts (checkerboard, interior, rot180, yinyang, full-fill)', () => {
  const pc = generatePuzzle({ rows: 8, cols: 8, seed: 101, layout: 'checkerboard', budgetMs: 8000 });
  assert.ok(pc, 'failed to generate checkerboard puzzle');
  assert.ok(pc.clues.every((c) => ((c.r + c.c) & 1) === 0));

  const pi = generatePuzzle({ rows: 8, cols: 8, seed: 102, layout: 'interior', budgetMs: 8000 });
  assert.ok(pi, 'failed to generate interior-only puzzle');
  assert.ok(pi.clues.every((c) => c.r > 0 && c.r < 7 && c.c > 0 && c.c < 7));

  const pr = generatePuzzle({ rows: 8, cols: 8, seed: 103, layout: 'rot180', budgetMs: 8000 });
  assert.ok(pr, 'failed to generate rot180 exact symmetry puzzle');
  const mapR = new Map(pr.clues.map((c) => [c.r * 8 + c.c, c.t]));
  assert.ok(pr.clues.every((c) => mapR.get((7 - c.r) * 8 + (7 - c.c)) === c.t));

  const pt = generatePuzzle({ rows: 8, cols: 8, seed: 106, layout: 'transpose', budgetMs: 8000 });
  assert.ok(pt, 'failed to generate diagonal-mirror transpose exact symmetry puzzle');
  const mapT = new Map(pt.clues.map((c) => [c.r * 8 + c.c, c.t]));
  assert.ok(pt.clues.every((c) => mapT.get(c.c * 8 + c.r) === c.t));

  const py = generatePuzzle({ rows: 8, cols: 8, seed: 104, layout: 'yinyang', budgetMs: 10000 });
  assert.ok(py, 'failed to generate yinyang opposite-symmetry puzzle');
  const mapY = new Map(py.clues.map((c) => [c.r * 8 + c.c, c.t]));
  assert.ok(py.clues.every((c) => {
    const ot = mapY.get((7 - c.r) * 8 + (7 - c.c));
    return ot && ot !== c.t;
  }));

  const pym = generatePuzzle({ rows: 8, cols: 8, seed: 108, layout: 'yinyang-mirror', budgetMs: 10000 });
  assert.ok(pym, 'failed to generate yinyang-mirror opposite-symmetry puzzle');
  const mapYM = new Map(pym.clues.map((c) => [c.r * 8 + c.c, c.t]));
  assert.ok(pym.clues.every((c) => {
    const ot = mapYM.get(c.r * 8 + (7 - c.c));
    return ot && ot !== c.t;
  }));

  const pyt = generatePuzzle({ rows: 8, cols: 8, seed: 109, layout: 'yinyang-transpose', budgetMs: 10000 });
  assert.ok(pyt, 'failed to generate yinyang-transpose opposite-symmetry puzzle');
  const mapYT = new Map(pyt.clues.map((c) => [c.r * 8 + c.c, c.t]));
  assert.ok(pyt.clues.every((c) => {
    if (c.r === c.c) return false;
    const ot = mapYT.get(c.c * 8 + c.r);
    return ot && ot !== c.t;
  }));

  const pf = generatePuzzle({ rows: 6, cols: 6, seed: 105, minFill: 1.0, budgetMs: 8000 });
  assert.ok(pf, 'failed to generate 100% full-board puzzle');
  assert.equal(pf.solution.includes('#'), false);

  const pl = generatePuzzle({ rows: 9, cols: 9, seed: 107, layout: 'lattice', budgetMs: 10000 });
  assert.ok(pl, 'failed to generate 9x9 full even-row/even-col lattice puzzle');
  assert.equal(pl.clues.length, 16);
  assert.ok(pl.clues.every((c) => c.r % 2 === 1 && c.c % 2 === 1));

  const pcv = generatePuzzle({ rows: 8, cols: 8, seed: 110, layout: 'cookie', budgetMs: 8000 });
  assert.ok(pcv, 'failed to generate cookie half-split puzzle');
  assert.ok(pcv.clues.every((c) => (c.t === 'W' ? c.c < 4 : c.c >= 4)));

  const pch = generatePuzzle({ rows: 8, cols: 8, seed: 111, layout: 'cookie-horiz', budgetMs: 8000 });
  assert.ok(pch, 'failed to generate cookie-horiz half-split puzzle');
  assert.ok(pch.clues.every((c) => (c.t === 'W' ? c.r < 4 : c.r >= 4)));

  const pcd = generatePuzzle({ rows: 8, cols: 8, seed: 112, layout: 'cookie-diag', budgetMs: 8000 });
  assert.ok(pcd, 'failed to generate cookie-diag half-split puzzle');
  assert.ok(pcd.clues.every((c) => (c.t === 'W' ? c.r + c.c < 7 : c.r + c.c > 7)));

  const pcdRect = generatePuzzle({ rows: 10, cols: 6, seed: 114, layout: 'cookie-diag', budgetMs: 8000 });
  assert.ok(pcdRect, 'failed to generate rectangular cookie-diag half-split puzzle');
  assert.ok(pcdRect.clues.every((c) => {
    const lhs = c.r * 5 + c.c * 9;
    return c.t === 'W' ? lhs < 45 : lhs > 45;
  }));

  // Explicit arbitrary-angle cookie split (e.g. 30° and 115°)
  for (const deg of [30, 115]) {
    const pca = generatePuzzle({ rows: 8, cols: 8, seed: 115 + deg, layout: `cookie:${deg}`, budgetMs: 8000 });
    assert.ok(pca, `failed to generate cookie:${deg} puzzle`);
    const theta = (deg * Math.PI) / 180;
    const nx = Math.cos(theta), ny = Math.sin(theta);
    assert.ok(pca.clues.every((c) => {
      const d = (c.c - 3.5) * nx + (c.r - 3.5) * ny;
      return c.t === 'W' ? d < -1e-6 : d > 1e-6;
    }), `cookie:${deg} clues violated half-plane split`);
  }

  // Random arbitrary-angle cookie split must be strictly linearly separable through board center
  const isCenterSeparable = (rows, cols, clues) => {
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
    const pts = clues.map((c) => ({ x: c.c - cx, y: c.r - cy, s: c.t === 'B' ? 1 : -1 }));
    // Test mid-angles between all zero-crossing normal angles (atan2(y, x) ± π/2)
    const angs = [];
    for (const p of pts) {
      if (p.x === 0 && p.y === 0) return false;
      const a = Math.atan2(p.y, p.x);
      angs.push((a + Math.PI * 2.5) % (Math.PI * 2), (a + Math.PI * 3.5) % (Math.PI * 2));
    }
    angs.sort((a, b) => a - b);
    for (let i = 0; i < angs.length; i++) {
      const a0 = angs[i], a1 = i + 1 < angs.length ? angs[i + 1] : angs[0] + Math.PI * 2;
      if (a1 - a0 < 1e-9) continue;
      const mid = (a0 + a1) / 2;
      const nx = Math.cos(mid), ny = Math.sin(mid);
      if (pts.every((p) => (p.x * nx + p.y * ny) * p.s > 1e-6)) return true;
    }
    return false;
  };
  const pcr = generatePuzzle({ rows: 8, cols: 10, seed: 118, layout: 'cookie-angle', budgetMs: 8000 });
  assert.ok(pcr, 'failed to generate cookie-angle puzzle');
  assert.ok(pcr.clues.filter((c) => c.t === 'W').length >= 2);
  assert.ok(pcr.clues.filter((c) => c.t === 'B').length >= 2);
  assert.equal(isCenterSeparable(8, 10, pcr.clues), true, 'cookie-angle clues must be linearly separable through center');

  const pp = generatePuzzle({ rows: 9, cols: 9, seed: 113, layout: 'pillars', budgetMs: 8000 });
  assert.ok(pp, 'failed to generate pillars geometric pattern puzzle');
  const expectedPts = maskPoints('pillars', 9, 9);
  assert.equal(pp.clues.length, expectedPts.length);
  const ptSet = new Set(expectedPts.map(([r, c]) => r * 9 + c));
  assert.ok(pp.clues.every((c) => ptSet.has(c.r * 9 + c.c)));
});

test('generatePuzzle enforces balanced four-quadrant loop and clue coverage on large boards', () => {
  const p12 = generatePuzzle({ rows: 12, cols: 12, seed: 202, budgetMs: 12000 });
  assert.ok(p12, 'failed to generate 12x12 puzzle');
  const sol = decodeSolution(p12, p12.solution);
  const qs = quadrantStats(p12.rows, p12.cols, sol.e, p12.clues);
  assert.ok(qs.minFill >= 0.45, `expected minQuadFill >= 0.45, got ${qs.minFill} (${qs.fills})`);
  assert.ok(qs.minClues >= 2, `expected minQuadClues >= 2, got ${qs.minClues} (${qs.clues})`);

  // Direct quadrantStats check on an odd rectangular 5x7 board with a loop only in the top-left quadrant
  const P = compile({ name: 'q_lopsided', rows: 5, cols: 7, clues: [{ r: 0, c: 0, t: 'W' }, { r: 1, c: 1, t: 'B' }] });
  const edges = new Uint8Array(P.numEdges);
  // 2x2 loop in top-left: (0,0)-(0,1)-(1,1)-(1,0)-(0,0)
  edges[P.ed[0 * 4 + 1]] = 1;
  edges[P.ed[1 * 4 + 2]] = 1;
  edges[P.ed[(1 * 7 + 1) * 4 + 3]] = 1;
  edges[P.ed[(1 * 7 + 0) * 4 + 0]] = 1;
  const ql = quadrantStats(5, 7, edges, P.clues);
  assert.equal(ql.clues[0], 2);
  assert.equal(ql.minClues, 0);
  assert.ok(ql.fills[0] > 0);
  assert.equal(ql.minFill, 0);
});

test('generatePuzzle supports slither, slither-masyu (mutual necessity), and slither-full (full-board necessity)', () => {
  const pSl = generatePuzzle({ rows: 6, cols: 6, seed: 301, style: 'slither', budgetMs: 8000 });
  assert.ok(pSl, 'failed to generate 6x6 pure Slitherlink puzzle');
  assert.equal(pSl.clues.length, 0);
  assert.ok(pSl.slither.length >= 4);
  assert.equal(solve(pSl, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(pSl).solved, true);

  const pHyb = generatePuzzle({ rows: 6, cols: 6, seed: 302, style: 'slither-masyu', budgetMs: 8000 });
  assert.ok(pHyb, 'failed to generate 6x6 Slitherlink+Masyu hybrid puzzle');
  assert.ok(pHyb.clues.length >= 3 && pHyb.slither.length >= 4);
  assert.equal(solve(pHyb, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.ok(solve(compile({ name: 'ns', rows: 6, cols: 6, clues: [], slither: pHyb.slither }), { limit: 2, maxNodes: 50000 }).count >= 2, 'hybrid must require Masyu circles');
  assert.ok(solve(compile({ name: 'nm', rows: 6, cols: 6, clues: pHyb.clues, slither: [] }), { limit: 2, maxNodes: 50000 }).count >= 2, 'hybrid must require Slitherlink numbers');
  assert.equal(rate(pHyb).solved, true);

  const pFull = generatePuzzle({ rows: 6, cols: 6, seed: 303, style: 'slither-full', budgetMs: 8000 });
  assert.ok(pFull, 'failed to generate 6x6 Slitherlink+Full puzzle');
  assert.equal(pFull.fullBoard, true);
  assert.equal(pFull.clues.length, 0);
  assert.ok(pFull.slither.length >= 4);
  assert.equal(pFull.solution.includes('#'), false);
  assert.equal(solve(pFull, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.ok(solve(compile({ name: 'nf', rows: 6, cols: 6, clues: [], slither: pFull.slither, fullBoard: false }), { limit: 2, maxNodes: 50000 }).count >= 2, 'slither-full must require fullBoard');
  assert.equal(rate(pFull).solved, true);

  // Target Medium tier on Slitherlink exercises Pass 2 + binary-search rollback
  const pMed = generatePuzzle({ rows: 6, cols: 6, seed: 304, style: 'slither', targetTier: 'Medium', budgetMs: 8000 });
  assert.ok(pMed, 'failed to generate Medium 6x6 Slitherlink puzzle');
  assert.equal(pMed.tier, 'Medium');
  const rMed = rate(compile(pMed));
  assert.equal(rMed.score, pMed.score);
  assert.equal(rMed.tier, pMed.tier);
  assert.equal(rMed.rules, pMed.rules);
});

test('generatePuzzle matches independent rate(compile(p)) across gray, swiss-cheese, full-board, and slither styles', () => {
  const cases = [
    { rows: 6, cols: 6, style: 'gray-mixed', seed: 401, budgetMs: 8000 },
    { rows: 6, cols: 6, style: 'gray-all', seed: 402, budgetMs: 8000 },
    { rows: 8, cols: 8, style: 'swiss-cheese', seed: 403, budgetMs: 8000 },
    { rows: 6, cols: 6, style: 'full-mixed', seed: 404, budgetMs: 8000 },
    { rows: 6, cols: 6, style: 'slither', seed: 405, budgetMs: 8000 },
    { rows: 6, cols: 6, style: 'slither-masyu', seed: 406, budgetMs: 8000 },
  ];
  for (const cfg of cases) {
    const p = generatePuzzle(cfg);
    assert.ok(p, `failed to generate ${cfg.style}`);
    if (cfg.style === 'swiss-cheese') assert.ok(p.voids && p.voids.length >= 1, 'swiss-cheese must have voids');
    const r = rate(compile(p));
    assert.equal(r.score, p.score, `${cfg.style} cached score mismatch (${p.score} vs ${r.score})`);
    assert.equal(r.tier, p.tier, `${cfg.style} cached tier mismatch`);
    assert.equal(r.rules, p.rules, `${cfg.style} cached rules mismatch`);
  }
});

test('generatePuzzle supports Hamilton swiss-cheese/symmetry and Slitherlink swiss-cheese/symmetry/all-3s/all-2s-full', () => {
  const pFullSwiss = generatePuzzle({ rows: 8, cols: 8, style: 'full-swiss', seed: 501, budgetMs: 8000 });
  assert.ok(pFullSwiss, 'failed to generate 8x8 full-swiss puzzle');
  assert.equal(pFullSwiss.fullBoard, true);
  assert.ok(pFullSwiss.voids && pFullSwiss.voids.length >= 2);
  assert.ok(pFullSwiss.givens.length >= 2);
  assert.equal(solve(pFullSwiss, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pFullSwiss)).score, pFullSwiss.score);

  for (const layout of ['rot180', 'mirror']) {
    const pFullSym = generatePuzzle({ rows: 6, cols: 6, style: 'full-mixed', layout, seed: 502, budgetMs: 8000 });
    assert.ok(pFullSym, `failed to generate 6x6 full-mixed ${layout} puzzle`);
    assert.equal(pFullSym.fullBoard, true);
    assert.ok(detectSymmetries(pFullSym).length > 0, `full-mixed ${layout} must have detected symmetry`);
    assert.equal(solve(pFullSym, { limit: 2, maxNodes: 50000 }).count, 1);
    assert.equal(rate(compile(pFullSym)).score, pFullSym.score);
  }

  const pSlSwiss = generatePuzzle({ rows: 8, cols: 8, style: 'slither-swiss', seed: 503, budgetMs: 8000 });
  assert.ok(pSlSwiss, 'failed to generate 8x8 slither-swiss puzzle');
  assert.ok(pSlSwiss.voids && pSlSwiss.voids.length >= 1);
  assert.ok(pSlSwiss.slither.length >= 4);
  assert.equal(solve(pSlSwiss, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pSlSwiss)).score, pSlSwiss.score);

  for (const layout of ['rot180', 'mirror', 'transpose']) {
    const pSlSym = generatePuzzle({ rows: 7, cols: 7, style: 'slither', layout, seed: 504, budgetMs: 8000 });
    assert.ok(pSlSym, `failed to generate 7x7 slither ${layout} puzzle`);
    assert.ok(detectSymmetries(pSlSym).length > 0, `slither ${layout} must have detected symmetry`);
    assert.equal(solve(pSlSym, { limit: 2, maxNodes: 50000 }).count, 1);
    assert.equal(rate(compile(pSlSym)).score, pSlSym.score);
  }

  const pAll3 = generatePuzzle({ rows: 8, cols: 8, style: 'slither-all3', seed: 505, budgetMs: 8000 });
  assert.ok(pAll3, 'failed to generate 8x8 slither-all3 puzzle');
  assert.equal(Boolean(pAll3.fullBoard), false);
  assert.ok(pAll3.slither.length >= 4 && pAll3.slither.every((s) => s.n === 3));
  assert.equal(solve(pAll3, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.equal(rate(compile(pAll3)).score, pAll3.score);

  const pAll2 = generatePuzzle({ rows: 6, cols: 6, style: 'slither-all2-full', seed: 506, budgetMs: 8000 });
  assert.ok(pAll2, 'failed to generate 6x6 slither-all2-full puzzle');
  assert.equal(pAll2.fullBoard, true);
  assert.ok(pAll2.slither.length >= 4 && pAll2.slither.every((s) => s.n === 2));
  assert.equal(solve(pAll2, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.ok(solve(compile({ name: 'nf2', rows: 6, cols: 6, clues: [], slither: pAll2.slither, fullBoard: false }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.equal(rate(compile(pAll2)).score, pAll2.score);
});

test('generatePuzzle supports full-gray, midloop-gray, and castle-gray all-gray hybrids with necessity checks', () => {
  const pfg = generatePuzzle({ rows: 6, cols: 6, style: 'full-gray', seed: 601, budgetMs: 8000 });
  assert.ok(pfg, 'failed to generate 6x6 full-gray puzzle');
  assert.equal(pfg.fullBoard, true);
  assert.ok(pfg.clues.length >= 4 && pfg.clues.every((c) => c.t === 'G'));
  assert.equal(solve(pfg, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.ok(solve(compile({ name: 'fg_nf', rows: 6, cols: 6, clues: pfg.clues, fullBoard: false }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.equal(rate(compile(pfg)).score, pfg.score);

  const pmg = generatePuzzle({ rows: 7, cols: 7, style: 'midloop-gray', seed: 602, budgetMs: 8000 });
  assert.ok(pmg, 'failed to generate 7x7 midloop-gray puzzle');
  assert.ok(pmg.clues.length >= 3 && pmg.clues.every((c) => c.t === 'G'));
  assert.ok(pmg.midloop.length >= 4);
  assert.equal(solve(pmg, { limit: 2, maxNodes: 50000 }).count, 1);
  assert.ok(solve(compile({ name: 'mg_a', rows: 7, cols: 7, clues: [], midloop: pmg.midloop }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'mg_b', rows: 7, cols: 7, clues: pmg.clues }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.equal(rate(compile(pmg)).score, pmg.score);

  const pcg = generatePuzzle({ rows: 7, cols: 7, style: 'castle-gray', seed: 603, budgetMs: 8000 });
  assert.ok(pcg, 'failed to generate 7x7 castle-gray puzzle');
  assert.ok(pcg.clues.length >= 3 && pcg.clues.every((c) => c.t === 'G'));
  assert.ok(pcg.castle.length >= 3);
  assert.equal(solve(pcg, { limit: 2, maxNodes: 50000 }).count, 1);
  const plainVoids = pcg.castle.map(({ r, c }) => ({ r, c }));
  assert.ok(solve(compile({ name: 'cg_a', rows: 7, cols: 7, clues: [], castle: pcg.castle }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.ok(solve(compile({ name: 'cg_b', rows: 7, cols: 7, clues: pcg.clues, voids: plainVoids }), { limit: 2, maxNodes: 50000 }).count >= 2);
  assert.equal(rate(compile(pcg)).score, pcg.score);
});
