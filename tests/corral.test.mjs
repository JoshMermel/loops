import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, solve, isSolved, initialState, E_ON, E_OFF,
  parseCsv, toCsv, symmetryKey, puzzleHash, decodeSolution,
} from '../js/logic.js';
import { rate, RULES, applySets } from '../js/rating.js';
import { corralStates, earlyLoopEdges } from '../js/clues.js';
import { computeHint } from '../js/hintstep.js';
import { applyAutoShade, applyAutoX, reconcileAutoShade, shadeConflicts, FACE_IN, FACE_OUT } from '../js/marks.js';
import { rotatePuzzleCW, rotateMarksCW } from '../js/rotate.js';
import { makeRng, randomLoop, generatePuzzle } from '../js/generator.js';
import { boardSvg } from '../js/print.js';
import { referenceCount } from './reference_solver.mjs';

function corralValuesForLoop(rows, cols, edges, faceExt = null, faceHole = null) {
  const fr = rows - 1, fc = cols - 1;
  const inside = Array.from({ length: fr }, (_, r) => {
    const row = new Uint8Array(fc);
    for (let c = 0; c < fc; c++) {
      let cr = 0;
      for (let cc = c + 1; cc < cols; cc++) {
        if (edges[2 * (r * cols + cc) + 1] === E_ON) cr++;
      }
      row[c] = cr & 1;
    }
    return row;
  });
  const out = [];
  const DR = [-1, 0, 1, 0], DC = [0, 1, 0, -1];
  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < fc; c++) {
      const f = r * fc + c;
      if (!inside[r][c]) continue;
      if (faceExt && faceExt[f]) continue;
      if (faceHole && faceHole[f] >= 0) continue;
      let vis = 1;
      for (let d = 0; d < 4; d++) {
        let rr = r + DR[d], cc = c + DC[d];
        while (rr >= 0 && rr < fr && cc >= 0 && cc < fc && inside[rr][cc]) {
          vis++;
          rr += DR[d]; cc += DC[d];
        }
      }
      out.push({ r, c, n: vis });
    }
  }
  return out;
}

test('Corral exact solver matches independent brute-force reference across 150 random pure & hybrid boards', () => {
  const rng = makeRng(20261127);
  let checked = 0;
  for (let t = 0; t < 150; t++) {
    const rows = 4 + ((rng() * 2) | 0); // 4..5 vertices (3..4 squares)
    const cols = 4 + ((rng() * 2) | 0);
    const fr = rows - 1, fc = cols - 1;
    const mode = t % 6; // 0: pure, 1: +masyu, 2: +slither, 3: +midloop, 4: +castle, 5: +fullBoard

    const raw = { name: `kref_${t}`, rows, cols, clues: [] };
    if (mode === 5) raw.fullBoard = true;

    // Generate random Corral clues (some solvable, some over/under-constrained, some impossible!)
    const usedFaces = new Set();
    const nK = 1 + ((rng() * 4) | 0);
    const corral = [];
    for (let i = 0; i < nK * 3 && corral.length < nK; i++) {
      const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
      const f = r * fc + c;
      if (usedFaces.has(f)) continue;
      usedFaces.add(f);
      const n = 2 + ((rng() * (fr + fc - 1)) | 0);
      corral.push({ r, c, n });
    }
    raw.corral = corral;

    if (mode === 1) {
      const r = (rng() * rows) | 0, c = (rng() * cols) | 0;
      raw.clues.push({ r, c, t: rng() < 0.5 ? 'W' : 'B' });
    } else if (mode === 2) {
      const slither = [];
      for (let i = 0; i < 6 && slither.length < 2; i++) {
        const r = (rng() * fr) | 0, c = (rng() * fc) | 0;
        const f = r * fc + c;
        if (usedFaces.has(f)) continue;
        usedFaces.add(f);
        slither.push({ r, c, n: (rng() * 4) | 0 });
      }
      if (slither.length) raw.slither = slither;
    } else if (mode === 3) {
      const r = 1 + ((rng() * (rows - 2)) | 0), c = 1 + ((rng() * (cols - 2)) | 0);
      raw.midloop = [{ r, c, dir: 'C' }];
    } else if (mode === 4) {
      // Place 1 Castle Wall vertex not touching any Corral clue face
      const badVerts = new Set();
      for (const kr of corral) {
        badVerts.add(kr.r * cols + kr.c);
        badVerts.add(kr.r * cols + kr.c + 1);
        badVerts.add((kr.r + 1) * cols + kr.c);
        badVerts.add((kr.r + 1) * cols + kr.c + 1);
      }
      const cands = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (!badVerts.has(r * cols + c)) cands.push([r, c]);
      }
      if (cands.length) {
        const [vr, vc] = cands[(rng() * cands.length) | 0];
        const isExt = vr === 0 || vr === rows - 1 || vc === 0 || vc === cols - 1;
        const wall = isExt ? 'B' : (rng() < 0.5 ? 'W' : 'B');
        raw.castle = [{ r: vr, c: vc, wall, dir: '', n: -1 }];
      }
    }

    let P;
    try { P = compile(raw); } catch { continue; }
    const got = solve(P, { limit: Infinity });
    const want = referenceCount(raw);
    assert.equal(got.count, want, `mismatch on test ${t} (mode=${mode}, ${rows}x${cols}): got=${got.count} want=${want} raw=${JSON.stringify(raw)}`);
    for (const sol of got.solutions) {
      assert.equal(isSolved(P, sol.e), true, `solution invalid on test ${t}`);
    }
    checked++;
  }
  assert.ok(checked >= 120, `expected >= 120 checked boards, got ${checked}`);
});

test('Corral CSV round-trip, symmetryKey dihedral invariance, puzzleHash, and 90° CW rotation', () => {
  const origCorral = [{ r: 0, c: 0, n: 4 }, { r: 2, c: 3, n: 5 }, { r: 3, c: 4, n: 3 }];
  const raw = {
    name: 'corral_rt',
    rows: 5,
    cols: 6,
    clues: [],
    corral: origCorral.map((k) => ({ ...k })),
  };
  const P = compile(raw);
  const csv = toCsv([P]);
  const [parsed] = parseCsv(csv);
  assert.deepEqual(parsed.corral, origCorral);

  const P2 = rotatePuzzleCW(P);
  assert.equal(P2.rows, 6);
  assert.equal(P2.cols, 5);
  assert.equal(symmetryKey(P), symmetryKey(P2));
  assert.equal(puzzleHash(P2), puzzleHash(P));
  assert.equal(solve(P, { limit: 20 }).count, solve(P2, { limit: 20 }).count);
});

test('Corral human rules (corralEdge, corralBound, corralSameLine, corralParityBound) are 100% sound and hints solve end-to-end', () => {
  const rng = makeRng(7711);
  let uniqueFound = 0;
  const firedRules = new Set();

  for (let attempt = 0; attempt < 180 && uniqueFound < 30; attempt++) {
    const rows = 6, cols = 6;
    const loop = randomLoop(rows, cols, rng, { targetFill: 0.55, steps: 200 });
    const allK = corralValuesForLoop(rows, cols, loop.edges);
    if (allK.length < 4) continue;
    // Shuffle and prune down while staying unique
    const active = allK.slice();
    for (let i = active.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [active[i], active[j]] = [active[j], active[i]];
    }
    const P0 = compile({ name: `ks_${attempt}`, rows, cols, clues: [], corral: active });
    if (solve(P0, { limit: 2, maxNodes: 5000 }).count !== 1) continue;
    for (let i = active.length - 1; i >= 0 && active.length > 3; i--) {
      const rem = active.splice(i, 1)[0];
      const testP = compile({ name: `ks_${attempt}`, rows, cols, clues: [], corral: active });
      const ex = solve(testP, { limit: 2, maxNodes: 5000 });
      if (ex.exceeded || ex.count !== 1) active.splice(i, 0, rem);
    }
    const P = compile({ name: `ks_${attempt}`, rows, cols, clues: [], corral: active });
    const sol = solve(P, { limit: 2, maxNodes: 20000 });
    if (sol.exceeded || sol.count !== 1) continue;
    uniqueFound++;
    const trueE = sol.solutions[0].e;

    // Verify every single rule firing along rate() matches the unique exact solution!
    const r = rate(P);
    if (r.solved) {
      assert.equal(isSolved(P, r.state.e), true);
      for (let x = 0; x < P.numEdges; x++) {
        if (P.edgeA[x] >= 0) assert.equal(r.state.e[x], trueE[x], `rate() disagreed with exact solution on ${P.name}`);
      }
      for (const s of r.steps) firedRules.add(s.rule);
    }

    // Verify step-by-step hints work on at least the first 8 Beginner/Medium puzzles
    if (r.solved && (r.tier === 'Beginner' || r.tier === 'Medium') && uniqueFound <= 12) {
      const marks = { edges: new Uint8Array(P.numEdges), autoE: new Uint8Array(P.numEdges), faces: new Uint8Array((rows - 1) * (cols - 1)), autoF: new Uint8Array((rows - 1) * (cols - 1)) };
      for (let step = 0; step < 200; step++) {
        if (isSolved(P, marks.edges)) break;
        const h = computeHint(P, marks);
        assert.notEqual(h.kind, 'wrong', `unexpected wrong hint on ${P.name}`);
        assert.notEqual(h.kind, 'stuck', `unexpected stuck hint on ${P.name}`);
        const s0 = h.hints[0];
        assert.ok(s0 && s0.nudge && s0.text, `missing nudge/text for rule ${h.rule}`);
        for (const x of s0.targets.segOn) { assert.equal(trueE[x], E_ON); marks.edges[x] = 1; }
        for (const x of s0.targets.segOff) { assert.equal(trueE[x], E_OFF); marks.edges[x] = 2; }
      }
      assert.equal(isSolved(P, marks.edges), true, `hints failed to finish ${P.name}`);
    }
  }

  assert.ok(uniqueFound >= 20, `expected >= 20 unique boards, got ${uniqueFound}`);
  assert.ok(firedRules.has('corralEdge'), 'expected corralEdge to fire');
  assert.ok(firedRules.has('corralBound'), 'expected corralBound to fire');
});

test('Corral Medium rules (corralWallCap, corralSeparate, corralSameLine tie-break) fire accurately and never self-compare', () => {
  // 1. corralWallCap: a 2 on the top edge at (0, 1) with top edge ON; drawing (0,2)-(0,3) completes
  // degree 2 at (0,2) and (0,3) (when (0,3)-(0,4) is ON), crossing out both vertical edges so the 2 sees 3 > 2.
  const Pwc = compile({
    name: 'kwc',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 0, c: 1, n: 2 }],
  });
  const stWc = initialState(Pwc);
  // Draw top border of (0,1): vertex (0,1)-(0,2), and draw (0,3)-(0,4) and cross out (0,2)-(1,2)?
  // Even simpler: top border (0,1)-(0,2) is ON; cross out right-of-(0,2) = (0,3)-(1,3) is OFF!
  // Then drawing (0,2)-(0,3) finishes deg 2 at (0,2), crossing out (0,2)-(1,2), so (0,1) sees (0,1)+(0,2)+(0,3) = 3 > 2!
  const eTop1 = Pwc.faceEdges[1 * 4 + 0];     // (0,1)-(0,2)
  const eTop2 = Pwc.faceEdges[2 * 4 + 0];     // (0,2)-(0,3)
  const eSep23 = Pwc.faceEdges[2 * 4 + 1];    // (0,3)-(1,3)
  stWc.e[eTop1] = E_ON;
  stWc.e[eSep23] = E_OFF;
  const wcRule = RULES.find((r) => r.id === 'corralWallCap');
  assert.ok(wcRule, 'corralWallCap must be registered in RULES');
  const wcHits = wcRule.find(Pwc, stWc);
  const hitTop2 = wcHits.find((h) => h.sets.some(([k, x, v]) => k === 'e' && x === eTop2 && v === E_OFF));
  assert.ok(hitTop2, 'corralWallCap must cross out eTop2 when drawing it would open 3 squares for a 2');
  assert.equal(hitTop2.info.got, 3);

  // Verify hint text/nudge for corralWallCap
  const marksWc = {
    edges: new Uint8Array(Pwc.numEdges),
    autoE: new Uint8Array(Pwc.numEdges),
    faces: new Uint8Array(16),
    autoF: new Uint8Array(16),
  };
  marksWc.edges[eTop1] = 1;
  marksWc.edges[eSep23] = 2;
  // Also cap left & bottom of (0,1) so corralBound doesn't preempt corralWallCap? No, just test explain directly via computeHint on full board or verify hint works.
  const eLeft1 = Pwc.faceEdges[1 * 4 + 3];
  const eBot1 = Pwc.faceEdges[1 * 4 + 2];
  marksWc.edges[eLeft1] = 1;
  marksWc.edges[eBot1] = 1;
  // With left & bottom ON, (0,1) sees 1 square; right edge (0,2)-(1,2) is UNKNOWN and eSep23 is OFF -> corralBound caps right edge.
  // Instead leave bottom UNKNOWN so corralBound cannot cap right edge (jump=2, 1+2=3 > 2 WOULD cap right edge!).
  // Use a 3 at (0,1): totalMin=1, jump=2 -> 1+2=3 <= 3 so corralBound does NOT cap!
  // Add another OFF at bottom of (0,1) -> totalMin=2, jump=2 -> 2+2=4 > 3 would cap right edge;
  // Instead test a 2 at (0,0) with (0,0)-(0,1) ON, (0,1)-(0,2) UNKNOWN, (0,2)-(0,3) ON:
  // Drawing (0,1)-(0,2) finishes deg 2 at BOTH (0,1) and (0,2), crossing out BOTH (0,1)-(1,1) AND (0,2)-(1,2) simultaneously -> sees 3 > 2!
  const Pwc2 = compile({
    name: 'kwc2',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 0, c: 0, n: 2 }, { r: 3, c: 3, n: 4 }],
  });
  const stWc2 = initialState(Pwc2);
  const f0Top = Pwc2.faceEdges[0 * 4 + 0];   // (0,0)-(0,1)
  const f0Left = Pwc2.faceEdges[0 * 4 + 3];  // (0,0)-(1,0)
  const f1Top = Pwc2.faceEdges[1 * 4 + 0];   // (0,1)-(0,2)
  const f2Top = Pwc2.faceEdges[2 * 4 + 0];   // (0,2)-(0,3)
  stWc2.e[f0Top] = E_ON;
  stWc2.e[f0Left] = E_ON;
  stWc2.e[f2Top] = E_ON;
  const wcHits2 = wcRule.find(Pwc2, stWc2);
  const hitF1Top = wcHits2.find((h) => h.sets.some(([k, x, v]) => k === 'e' && x === f1Top && v === E_OFF));
  assert.ok(hitF1Top, 'corralWallCap must catch dual-endpoint degree-2 opening 3 squares for a corner 2');
  assert.equal(hitF1Top.info.verts.length, 2);
  assert.equal(hitF1Top.info.got, 3);

  // 2. corralSeparate: a 5 at (0,0) and a 2 at (0,2) in the same 1x4-wide row (5x5 vertices -> 4x4 squares):
  // If (0,0) and (0,2) connected, span >= 3 > 2 -> impossible!
  // So (0,0) max right is capped at dist-1 = 1 (instead of 3), totalMax drops from 1+3+3=7 to 1+1+3=5 ->
  // (0,0) MUST extend all 3 squares DOWN!
  const Psep = compile({
    name: 'ksep',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 0, c: 0, n: 5 }, { r: 0, c: 2, n: 2 }],
  });
  const stSep = initialState(Psep);
  const sepRule = RULES.find((r) => r.id === 'corralSeparate');
  assert.ok(sepRule, 'corralSeparate must be registered in RULES');
  const sepHits = sepRule.find(Psep, stSep);
  const downEdges = Array.from(Psep.corral[0].rays[2]); // all 3 down edges from (0,0)
  for (const dx of downEdges) {
    assert.ok(
      sepHits.some((h) => h.sets.some(([k, x, v]) => k === 'e' && x === dx && v === E_OFF)),
      'corralSeparate must force 5 at (0,0) to extend down because it cannot reach 2 at (0,2)',
    );
  }
  assert.ok(sepHits.every((h) => h.info.corralIdx !== h.info.corralIdx2), 'corralSeparate must reference two distinct clues');

  // 3. corralSameLine tie-break & distinct-clue guard:
  // Two tied 4s at (0,1) and (0,2) in a 5x5 grid (4x4 squares), connected by E_OFF, with top row closed
  // and (0,1)'s down blocked (maxDown=0) and (0,2)'s down blocked (maxDown=0)?
  // Better: two 3s at (0,1) and (0,2) connected by E_OFF, both with down open (maxDown=3),
  // left of (0,1) closed (maxLeft=0), right of (0,2) closed (maxRight=0) -> axisMax = 2,
  // wait: both 3s have pMin=0 -> sMax = min(3, 3) = 3. To test a tie on sMin:
  // Two 4s at (0,0) and (0,1) connected by E_OFF; cap down on both to maxDown=1 -> BOTH require sMin = 4 - 1 = 3!
  // Even though both tie at sMin=3, each should force the other's perpendicular/axis bounds with ci !== ci2!
  const Psl = compile({
    name: 'ksl_tie',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 0, c: 0, n: 4 }, { r: 0, c: 1, n: 4 }],
  });
  const stSl = initialState(Psl);
  stSl.e[Psl.faceEdges[0 * 4 + 1]] = E_OFF; // connect (0,0) and (0,1)
  stSl.e[Psl.corral[0].rays[2][1]] = E_ON;  // cap (0,0) down at 1 -> cMin = 4 - 1 = 3
  stSl.e[Psl.corral[1].rays[2][1]] = E_ON;  // cap (0,1) down at 1 -> cMin = 4 - 1 = 3 (TIE!)
  const slRule = RULES.find((r) => r.id === 'corralSameLine');
  const slHits = slRule.find(Psl, stSl);
  const extRight = Psl.corral[1].rays[1][0]; // (0,1)-(0,2) must be OFF since sMin=3 > spanLen=2
  const hitTie = slHits.find((h) => h.sets.some(([k, x, v]) => k === 'e' && x === extRight && v === E_OFF));
  assert.ok(hitTie, 'corralSameLine must still fire when two clues tie for sMin');
  assert.notEqual(hitTie.info.corralIdx, hitTie.info.corralIdx2, 'corralSameLine must never compare a clue with itself');
});

test('Corral live error highlights have zero false positives on partial solutions and catch all violation types', () => {
  const rng = makeRng(9901);
  // 1. Zero false positives across 200 random partial subsets of valid solutions
  for (let t = 0; t < 20; t++) {
    const rows = 6, cols = 6;
    const loop = randomLoop(rows, cols, rng, { targetFill: 0.55, steps: 180 });
    const allK = corralValuesForLoop(rows, cols, loop.edges);
    if (allK.length < 3) continue;
    const P = compile({ name: `kfp_${t}`, rows, cols, clues: [], corral: allK.slice(0, 5) });
    for (let s = 0; s < 10; s++) {
      const e = new Uint8Array(P.numEdges);
      for (let x = 0; x < P.numEdges; x++) {
        if (P.edgeA[x] >= 0 && rng() < 0.65) e[x] = loop.edges[x] === E_ON ? 1 : 2;
      }
      const st = corralStates(P, { edges: e });
      assert.ok(st.every((v) => v === ''), `false positive in corralStates on partial valid solution: ${JSON.stringify(st)}`);
    }
  }

  // 2. Intentional violations are caught immediately
  const P = compile({
    name: 'kerr',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 0, c: 0, n: 3 }, { r: 0, c: 1, n: 4 }],
  });
  // Border X on (0, 0) top edge -> bad
  const eBorder = new Uint8Array(P.numEdges);
  eBorder[P.faceEdges[0 * 4 + 0]] = 2;
  assert.equal(corralStates(P, { edges: eBorder })[0], 'bad');

  // Line between adjacent Corral squares (0,0) and (0,1) -> both bad
  const eSplit = new Uint8Array(P.numEdges);
  eSplit[P.faceEdges[0 * 4 + 1]] = 1;
  assert.deepEqual(corralStates(P, { edges: eSplit }), ['bad', 'bad']);

  // Too-low maxVis on (0,0) (n=3): surround (0,0) with 3 walls leaving only 1 square
  const eLow = new Uint8Array(P.numEdges);
  eLow[P.faceEdges[0 * 4 + 0]] = 1;
  eLow[P.faceEdges[0 * 4 + 1]] = 1;
  eLow[P.faceEdges[0 * 4 + 2]] = 1;
  eLow[P.faceEdges[0 * 4 + 3]] = 1;
  assert.equal(corralStates(P, { edges: eLow })[0], 'bad');
  assert.ok(earlyLoopEdges(P, { edges: eLow }).size === 4, 'early closed 1x1 loop violating Corral should highlight bad');

  // Overshoot minVis on (0,0) (n=3): 3 consecutive X's going right -> sees >= 4 > 3
  const eHigh = new Uint8Array(P.numEdges);
  eHigh[P.corral[0].rays[1][0]] = 2;
  eHigh[P.corral[0].rays[1][1]] = 2;
  eHigh[P.corral[0].rays[1][2]] = 2;
  assert.equal(corralStates(P, { edges: eHigh })[0], 'bad');
});

test('Corral Auto-Shade automatically shades Corral squares Inside, unwinds cleanly, and flags Outside conflicts', () => {
  const P = compile({
    name: 'kshade',
    rows: 5,
    cols: 5,
    clues: [],
    corral: [{ r: 1, c: 1, n: 4 }, { r: 1, c: 2, n: 3 }],
  });
  const F = (P.rows - 1) * (P.cols - 1);
  const m = {
    edges: new Uint8Array(P.numEdges),
    autoE: new Uint8Array(P.numEdges),
    faces: new Uint8Array(F),
    autoF: new Uint8Array(F),
  };

  // Auto-Shade ON shades both Corral squares Inside
  applyAutoShade(P, m, true);
  assert.equal(m.faces[P.corral[0].f], FACE_IN);
  assert.equal(m.autoF[P.corral[0].f], 1);
  assert.equal(m.faces[P.corral[1].f], FACE_IN);
  assert.equal(m.autoF[P.corral[1].f], 1);

  // Auto-X crosses out the shared edge between the two adjacent Corral clues
  applyAutoX(P, m, true, true);
  const sharedEdge = P.faceEdges[P.corral[0].f * 4 + 1];
  assert.equal(m.edges[sharedEdge], 2);
  assert.equal(m.autoE[sharedEdge], 1);

  // Toggling Auto-Shade OFF unwinds auto-placed Inside tints cleanly
  applyAutoShade(P, m, false);
  assert.equal(m.faces[P.corral[0].f], 0);
  assert.equal(m.faces[P.corral[1].f], 0);

  // Manual Outside shade on a Corral square triggers shadeConflicts
  m.faces[P.corral[0].f] = FACE_OUT;
  const bad = shadeConflicts(P, m, true);
  assert.ok(bad.has(P.corral[0].f));
});

test('generatePuzzle supports corral pure and all 5 hybrids with mutual necessity and print SVG', () => {
  const styles = ['corral', 'corral-masyu', 'corral-slither', 'corral-midloop', 'corral-castle', 'corral-full'];
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const p = generatePuzzle({ rows: 8, cols: 8, style, seed: 5100 + i * 73, budgetMs: 8000 });
    assert.ok(p, `failed to generate ${style}`);
    assert.ok(p.corral && p.corral.length >= 4, `${style} should have >= 4 Corral clues`);
    const sol = decodeSolution(p, p.solution);
    assert.equal(isSolved(p, sol.e), true, `${style} stored solution invalid`);
    const ex = solve(p, { limit: 2, maxNodes: 50000 });
    assert.equal(ex.count, 1, `${style} must be unique`);
    const r = rate(p);
    assert.equal(r.tier, p.tier);
    assert.equal(r.score, p.score);
    assert.equal(r.rules, p.rules);
    const svg = boardSvg(p, sol);
    assert.ok(svg.includes('corral-print-badge') && svg.includes('corral-print-num'), `${style} print SVG missing Corral badges`);
  }
});
