import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, parseCsv, solve, initialState, isSolved, decodeSolution, encodeSolution,
  E_ON, E_OFF, OFF, LOOP, WHITE, BLACK,
} from '../js/logic.js';
import { RULES, rate, solvedByRules, nextSteps, applySets, TIERS, detectSymmetries, findSymmetry } from '../js/rating.js';
import { explainStep } from '../js/explain.js';
import { findFaceShade, findFaceCircle, findFaceSlither, buildFaceParity } from '../js/faceparity.js';
import { classifyImagine } from '../js/imagine.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('RULES table structure matches expected schema', () => {
  assert.ok(RULES.length >= 20);
  for (const r of RULES) {
    assert.equal(r.name, r.id);
    assert.equal(r.cost, r.weight);
    assert.ok(TIERS.includes(r.tier), `bad tier for ${r.id}`);
    assert.ok(Number.isInteger(r.cost) && r.cost >= 1, `bad cost for ${r.id}`);
    assert.equal(typeof r.apply, 'function');
    assert.equal(typeof r.find, 'function');
  }
});

test('Beginner puzzle: 3x3 opposite black corners solves cleanly at Beginner', () => {
  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  const r = rate(P);
  assert.equal(r.solved, true);
  assert.equal(r.tier, 'Beginner');
  assert.ok(r.score > 0);
  assert.equal(isSolved(P, r.state.e), true);
  assert.equal(solvedByRules(P).solved, true);
});

test('threeWhites fires on three consecutive white circles', () => {
  // 4x5 board with 3 horizontal white circles in row 1 cols 1,2,3
  const P = compile({
    name: 'w3row', rows: 4, cols: 5,
    clues: [{ r: 1, c: 1, t: 'W' }, { r: 1, c: 2, t: 'W' }, { r: 1, c: 3, t: 'W' }],
  });
  const st = initialState(P);
  const step = nextSteps(P, st);
  assert.equal(step.rule, 'threeWhites');
  assert.equal(step.tier, 'Beginner');
  // Every firing edge for the three whites must be vertical ON, horizontal OFF
  const s2 = initialState(P);
  applySets(s2, step.firings[0].sets);
  for (const c of [1, 2, 3]) {
    const i = 1 * 5 + c;
    assert.equal(s2.e[P.ed[i * 4 + 0]], E_ON);
    assert.equal(s2.e[P.ed[i * 4 + 2]], E_ON);
    assert.equal(s2.e[P.ed[i * 4 + 1]], E_OFF);
    assert.equal(s2.e[P.ed[i * 4 + 3]], E_OFF);
  }
});

test('blackAdjacent fires on two touching black circles', () => {
  // 5x6 board so neither center black circle is within 1 cell of a border (avoids blackWall firing first)
  const P2 = compile({
    name: 'bb_mid6', rows: 5, cols: 6,
    clues: [{ r: 2, c: 2, t: 'B' }, { r: 2, c: 3, t: 'B' }],
  });
  const st2 = initialState(P2);
  const step = nextSteps(P2, st2);
  assert.equal(step.rule, 'blackAdjacent');
  assert.equal(step.tier, 'Beginner');
});

test('whiteMustTurn fires when one end of a white circle continues straight', () => {
  const P = compile({
    name: 'w_turn', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'W' }],
  });
  const st = initialState(P);
  // Draw horizontal through (2,2) and extend straight left to (2,0)
  st.e[P.ed[(2 * 5 + 2) * 4 + 3]] = E_ON;
  st.e[P.ed[(2 * 5 + 2) * 4 + 1]] = E_ON;
  st.e[P.ed[(2 * 5 + 1) * 4 + 3]] = E_ON;
  const step = nextSteps(P, st);
  assert.equal(step.rule, 'whiteMustTurn');
  assert.deepEqual(step.firings[0].sets, [['e', P.ed[(2 * 5 + 3) * 4 + 1], E_OFF]]);
});

test('soundness fuzz: every rule deduction matches the unique exact solution on random unique boards', () => {
  const rng = mulberry32(777);
  let checkedUnique = 0;
  let solvedCount = 0;
  const rulesSeen = new Set();

  // Sample random valid loops on 4x4, 5x5, 6x6 and place valid circles on them
  for (let attempt = 0; attempt < 900 && checkedUnique < 45; attempt++) {
    const rows = 4 + (attempt % 3); // 4, 5, 6
    const cols = 4 + ((attempt / 3 | 0) % 3);
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 2000, rng });
    if (solRes.count === 0) continue;
    const loopSt = solRes.solutions[0];
    // Find all cells that can legally hold a W or B circle on this loop
    const candidates = [];
    for (let i = 0; i < empty.N; i++) {
      const dirs = [];
      for (let d = 0; d < 4; d++) {
        const x = empty.ed[i * 4 + d];
        if (x >= 0 && loopSt.e[x] === E_ON) dirs.push(d);
      }
      if (dirs.length !== 2) continue;
      const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
      const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
      const s0 = ext0 >= 0 && loopSt.e[ext0] === E_ON;
      const s1 = ext1 >= 0 && loopSt.e[ext1] === E_ON;
      if (straight && !(s0 && s1)) candidates.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
      else if (!straight && s0 && s1) candidates.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
    }
    if (candidates.length < 3) continue;
    // Shuffle and take a random subset (65%..100%)
    for (let k = candidates.length - 1; k > 0; k--) {
      const j = (rng() * (k + 1)) | 0;
      [candidates[k], candidates[j]] = [candidates[j], candidates[k]];
    }
    const take = Math.max(2, Math.floor(candidates.length * (0.65 + 0.35 * rng())));
    const clues = candidates.slice(0, take);
    const P = compile({ name: `fuzz_${attempt}`, rows, cols, clues });
    const exact = solve(P, { limit: 2, maxNodes: 30000 });
    if (exact.exceeded || exact.count !== 1) continue;
    checkedUnique++;
    const truth = exact.solutions[0];

    // Step through the human rater and verify EVERY single deduction agrees with `truth`!
    const r = rate(P);
    for (const s of r.steps) {
      rulesSeen.add(s.rule);
      for (const [kind, idx, val] of s.sets) {
        if (kind === 'e') {
          assert.equal(val, truth.e[idx], `UNSOUND edge deduction by ${s.rule} on ${P.name} edge ${idx}: deduced ${val}, truth ${truth.e[idx]}`);
        } else {
          assert.equal(val, truth.cell[idx], `UNSOUND cell deduction by ${s.rule} on ${P.name} cell ${idx}: deduced ${val}, truth ${truth.cell[idx]}`);
        }
      }
    }
    if (r.solved) {
      solvedCount++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, truth));
    }
  }

  assert.ok(checkedUnique >= 30, `expected >= 30 unique random boards, got ${checkedUnique}`);
  assert.ok(solvedCount >= checkedUnique * 0.85, `expected rules to solve most small unique boards, solved ${solvedCount}/${checkedUnique}`);
  assert.ok(rulesSeen.size >= 8, `expected diverse rules to fire, saw: ${[...rulesSeen].join(', ')}`);
});

test('stuck puzzle scores Expert with UNDETERMINED penalty', () => {
  // Ambiguous board (multiple solutions): human rules cannot solve it, must return Expert + penalty
  const P = compile({ name: 'ambig', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }] });
  const r = rate(P);
  assert.equal(r.solved, false);
  assert.equal(r.rules, 'unsolved');
  assert.equal(r.tier, 'Expert');
  assert.ok(r.score >= 100);
});

test('faceShade only uses border-anchored lines/X while faceCircle adds white diagonals and black 3-to-1 corners', () => {
  // 5x5 board: border white at (0,2) forces faces (0,1) & (0,2) = IN; interior white at (1,1) flips (0,1)=IN -> (1,0)=OUT;
  // that puts OUT on both sides of left border edge (1,0)-(2,0) -> MUST be E_OFF!
  const P1 = compile({
    name: 'fp_w', rows: 5, cols: 5,
    clues: [{ r: 0, c: 2, t: 'W' }, { r: 1, c: 1, t: 'W' }],
  });
  const st1 = initialState(P1);
  // With no edges marked yet, faceShade (plain line/X shading) must find nothing
  assert.equal(findFaceShade(P1, st1).length, 0);
  const f1 = findFaceCircle(P1, st1);
  const eLeft12 = P1.ed[(1 * 5 + 0) * 4 + 2]; // (1,0)-(2,0)
  const hit1 = f1.find((x) => x.info.edge === eLeft12);
  assert.ok(hit1, 'expected white-circle diagonal parity to deduce left border edge (1,0)-(2,0)');
  assert.deepEqual(hit1.sets, [['e', eLeft12, E_OFF]]);
  assert.equal(hit1.info.anchored, true);

  // Plain border shading test: top border (0,1)-(0,2) ON -> face(0,1)=IN; top border (0,2)-(0,3) OFF -> face(0,2)=OUT;
  // so vertical edge (0,2)-(1,2) separates IN and OUT -> faceShade must force it E_ON!
  const Pshade = compile({ name: 'fp_shade', rows: 5, cols: 5, clues: [] });
  const stShade = initialState(Pshade);
  stShade.e[Pshade.ed[(0 * 5 + 1) * 4 + 1]] = E_ON;
  stShade.e[Pshade.ed[(0 * 5 + 2) * 4 + 1]] = E_OFF;
  const fShade = findFaceShade(Pshade, stShade);
  const eMid = Pshade.ed[(0 * 5 + 2) * 4 + 2]; // (0,2)-(1,2)
  const hitShade = fShade.find((x) => x.info.edge === eMid);
  assert.ok(hitShade, 'expected faceShade to force vertical edge between IN and OUT border squares');
  assert.deepEqual(hitShade.sets, [['e', eMid, E_ON]]);

  // Black-circle 3-to-1 law: 5x5 board with black circle at (2,2), surrounding faces NW=(1,1), NE=(1,2), SW=(2,1), SE=(2,2).
  // Suppose border lines/X's make NW=IN, SE=IN, NE=OUT -> 3-to-1 law forces SW=IN, so edge (2,1)-(2,2) between NW(IN) and SW(IN) MUST be E_OFF!
  const P2 = compile({
    name: 'fp_b', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'B' }],
  });
  const st2 = initialState(P2);
  // Anchor NW=(1,1)=IN, NE=(1,2)=OUT, SE=(2,2)=IN using known edges from border:
  // Top border (0,1)-(0,2) ON -> (0,1)=IN; (1,1)-(1,2) OFF -> (1,1)=IN (NW)
  // Top border (0,2)-(0,3) OFF -> (0,2)=OUT; (1,2)-(1,3) OFF -> (1,2)=OUT (NE)
  // Right border (2,4)-(3,4) ON -> (2,3)=IN; (2,3)-(3,3) OFF -> (2,2)=IN (SE)
  st2.e[P2.ed[(0 * 5 + 1) * 4 + 1]] = E_ON;
  st2.e[P2.ed[(1 * 5 + 1) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(0 * 5 + 2) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(1 * 5 + 2) * 4 + 1]] = E_OFF;
  st2.e[P2.ed[(2 * 5 + 4) * 4 + 2]] = E_ON;
  st2.e[P2.ed[(2 * 5 + 3) * 4 + 2]] = E_OFF;
  const f2 = findFaceCircle(P2, st2);
  const eLeftB = P2.ed[(2 * 5 + 2) * 4 + 3]; // (2,1)-(2,2)
  const hit2 = f2.find((x) => x.info.edge === eLeftB);
  assert.ok(hit2, 'expected black-circle 3-to-1 rule to force SW=IN and cross out (2,1)-(2,2)');
  assert.deepEqual(hit2.sets, [['e', eLeftB, E_OFF]]);

  // Unanchored relative coloring: 5x5 with two interior whites at (1,1) and (2,2) (no border edges marked).
  // (1,1) ties NW(0,0)!=SE(1,1) and NE(0,1)!=SW(1,0); (2,2) ties NW(1,1)!=SE(2,2) and NE(1,2)!=SW(2,1).
  // Plus a drawn segment (1,2)-(2,2) or X between (1,1) and (2,1) relates faces without touching the border!
  const P3 = compile({
    name: 'fp_rel', rows: 5, cols: 5,
    clues: [{ r: 1, c: 1, t: 'W' }, { r: 2, c: 2, t: 'W' }],
  });
  const st3 = initialState(P3);
  // Draw interior segment (1,1)-(1,2) -> face(0,1) != face(1,1); draw (1,2)-(2,2) -> face(1,1) != face(1,2).
  // White at (1,1) gives face(0,1) != face(1,0), so face(1,0) == face(1,1), forcing interior edge (1,1)-(2,1) OFF!
  st3.e[P3.ed[(1 * 5 + 1) * 4 + 1]] = E_ON;
  const f3 = findFaceCircle(P3, st3);
  const eDown11 = P3.ed[(1 * 5 + 1) * 4 + 2]; // (1,1)-(2,1)
  const hit3 = f3.find((x) => x.info.edge === eDown11);
  assert.ok(hit3, 'expected unanchored relative coloring to deduce interior edge (1,1)-(2,1)');
  assert.equal(hit3.info.anchored, false);
  assert.deepEqual(hit3.sets, [['e', eDown11, E_OFF]]);
});

test('armory soundness sweep verifies 20+ human rules against unique solutions and checks no duplicate sets', () => {
  const armory = parseCsv(fs.readFileSync(path.join(root, 'data', 'armory.csv'), 'utf8'));
  const rulesSeen = new Set();
  for (const raw of armory) {
    const P = compile({ ...raw });
    const sol = decodeSolution(P, P.solution);
    const r = rate(P);
    assert.equal(r.solved, true, `armory puzzle ${raw.name} should solve`);
    for (const s of r.steps) {
      if (!s.info?.bookkeeping) rulesSeen.add(s.rule);
      const seenEdges = new Set();
      for (const [k, idx, v] of s.sets) {
        if (k === 'e') {
          assert.equal(seenEdges.has(idx), false, `duplicate edge ${idx} emitted by ${s.rule} on ${raw.name}`);
          seenEdges.add(idx);
          assert.equal(sol.e[idx], v, `unsound edge deduction by ${s.rule} on ${raw.name}`);
        } else if (k === 'c') {
          assert.equal(sol.cell[idx], v, `unsound cell deduction by ${s.rule} on ${raw.name}`);
        }
      }
    }
  }
  assert.ok(rulesSeen.size >= 22, `expected >= 22 distinct non-free rules across armory, saw ${rulesSeen.size}`);
});

test('difficulty tier assignments match the calibrated rule ladder', () => {
  const tier = (id) => RULES.find((r) => r.id === id)?.tier;
  assert.equal(tier('threeWhites'), 'Beginner');
  assert.equal(tier('whiteBothStraight'), 'Medium');
  assert.equal(tier('closingCell'), 'Medium');
  assert.equal(tier('samePathExits'), 'Medium');
  assert.equal(tier('twoWhitesStraight'), 'Medium');
  assert.equal(tier('whiteNoTurnAxis'), 'Medium');
  assert.equal(tier('blackNoEarlyClose'), 'Medium');
  assert.equal(tier('blackTwoDiagWhites'), 'Medium');
  assert.equal(tier('blackWhiteNoTurn'), 'Medium');
  assert.equal(tier('whiteCornerPinch'), 'Medium');
  assert.equal(tier('whiteDeadEndPinch'), 'Medium');
  assert.equal(tier('faceShade'), 'Medium');
  assert.equal(tier('boxStrand'), 'Medium');
  assert.equal(tier('imagineLocal'), 'Medium');
  assert.equal(tier('corridorNoEarlyClose'), 'Hard');
  assert.equal(tier('faceCircle'), 'Hard');
  assert.equal(tier('twoEndsJoin'), 'Hard');
  assert.equal(tier('chokepoint'), 'Hard');
  assert.equal(tier('parityPocket'), 'Hard');
  assert.equal(tier('imagineTrace'), 'Hard');
  assert.equal(tier('imagineChain'), 'Expert');
  assert.equal(tier('tryEdge'), 'Expert');
});

test('named Medium/Hard pattern rules fire cleanly and respect negative/boundary guards', () => {
  // 1. blackTwoDiagWhites: 6x6 with Black at (2,2) and NW/NE Whites at (1,1) & (1,3) -> cannot go Up, forces Down 2 cells
  const P2 = compile({
    name: 'b2dw', rows: 6, cols: 6,
    clues: [{ r: 2, c: 2, t: 'B' }, { r: 1, c: 1, t: 'W' }, { r: 1, c: 3, t: 'W' }],
  });
  const s2 = nextSteps(P2, initialState(P2));
  assert.equal(s2.rule, 'blackTwoDiagWhites');
  assert.ok(s2.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P2.ed[(2 * 6 + 2) * 4 + 0] && v === E_OFF));
  assert.ok(s2.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P2.ed[(2 * 6 + 2) * 4 + 2] && v === E_ON));
  assert.ok(s2.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P2.ed2[(2 * 6 + 2) * 4 + 2] && v === E_ON));

  // 2. blackWhiteNoTurn: 7x7 with W(2,1), W(2,2), B(2,4) -> B cannot go Left into W(2,2) because W(2,1) can't turn -> goes Right 2 cells
  const P3 = compile({
    name: 'bwnt', rows: 7, cols: 7,
    clues: [{ r: 2, c: 1, t: 'W' }, { r: 2, c: 2, t: 'W' }, { r: 2, c: 4, t: 'B' }],
  });
  const s3 = nextSteps(P3, initialState(P3));
  assert.equal(s3.rule, 'blackWhiteNoTurn');
  assert.ok(s3.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P3.ed[(2 * 7 + 4) * 4 + 3] && v === E_OFF));
  assert.ok(s3.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P3.ed[(2 * 7 + 4) * 4 + 1] && v === E_ON));

  // 3. whiteCornerPinch: 6x6 with White at (3,1); corner (2,2) has only exits to (2,1) and (3,2), which both have 1 segment
  const P4 = compile({ name: 'wcp', rows: 6, cols: 6, clues: [{ r: 3, c: 1, t: 'W' }] });
  const st4 = initialState(P4);
  // Corner k=(2,2): block Up (1,2)-(2,2) and Right (2,2)-(2,3); active segments at u=(2,1) going Up and v=(3,2) going Right
  st4.e[P4.ed[(2 * 6 + 2) * 4 + 0]] = E_OFF;
  st4.e[P4.ed[(2 * 6 + 2) * 4 + 1]] = E_OFF;
  st4.e[P4.ed[(2 * 6 + 1) * 4 + 0]] = E_ON;
  st4.e[P4.ed[(3 * 6 + 2) * 4 + 1]] = E_ON;
  const s4 = nextSteps(P4, st4);
  assert.equal(s4.rule, 'whiteCornerPinch');
  assert.ok(s4.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P4.ed[(2 * 6 + 2) * 4 + 3] && v === E_OFF));
  assert.ok(s4.firings[0].sets.some(([k, x, v]) => k === 'e' && x === P4.ed[(2 * 6 + 2) * 4 + 2] && v === E_OFF));

  // 4. blackNoEarlyClose: 7x7 with Black at (2,2), path going out to col 5 and back to (4,2), extra interior clue at (5,1)
  const P5 = compile({ name: 'bnec', rows: 7, cols: 7, clues: [{ r: 2, c: 2, t: 'B' }, { r: 5, c: 1, t: 'W' }] });
  const st5 = initialState(P5);
  const eBetween = (P, r1, c1, r2, c2) => {
    const a = r1 * P.cols + c1, b = r2 * P.cols + c2;
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  for (const [r1, c1, r2, c2] of [
    [2, 2, 2, 3], [2, 3, 2, 4], [2, 4, 2, 5], [2, 5, 3, 5], [3, 5, 4, 5], [4, 5, 4, 4], [4, 4, 4, 3], [4, 3, 4, 2],
  ]) {
    st5.e[eBetween(P5, r1, c1, r2, c2)] = E_ON;
  }
  st5.e[eBetween(P5, 2, 2, 2, 1)] = E_OFF;
  st5.cell[3 * 7 + 3] = OFF;
  st5.cell[3 * 7 + 4] = OFF;
  const s5 = nextSteps(P5, st5);
  assert.equal(s5.rule, 'blackNoEarlyClose');
  assert.ok(s5.firings[0].sets.some(([k, x, v]) => k === 'e' && x === eBetween(P5, 2, 2, 3, 2) && v === E_OFF));
  assert.ok(s5.firings[0].sets.some(([k, x, v]) => k === 'e' && x === eBetween(P5, 2, 2, 1, 2) && v === E_ON));

  // 5. whiteDeadEndPinch: 6x6 with White at (3,2); u=(2,2) has only exits to (3,2) & (2,3); v=(3,3) & k=(2,3) each have 1 segment
  const P6 = compile({ name: 'wdep', rows: 6, cols: 6, clues: [{ r: 3, c: 2, t: 'W' }] });
  const st6 = initialState(P6);
  st6.e[eBetween(P6, 2, 2, 1, 2)] = E_OFF;
  st6.e[eBetween(P6, 2, 2, 2, 1)] = E_OFF;
  st6.e[eBetween(P6, 2, 3, 2, 4)] = E_ON;
  st6.e[eBetween(P6, 3, 3, 4, 3)] = E_ON;
  const s6 = nextSteps(P6, st6);
  assert.equal(s6.rule, 'whiteDeadEndPinch');
  assert.deepEqual(s6.firings[0].sets, [['e', eBetween(P6, 2, 3, 3, 3), E_OFF]]);

  // 6. boxStrand: 6x6 with a=(2,2), b=(2,3) each having 1 segment; c=(3,2) has on=0,avail=2; d=(3,3) has on=1,avail=2
  const P7 = compile({ name: 'bstr', rows: 6, cols: 6, clues: [] });
  const st7 = initialState(P7);
  st7.e[eBetween(P7, 2, 2, 2, 1)] = E_ON;
  st7.e[eBetween(P7, 2, 3, 2, 4)] = E_ON;
  st7.e[eBetween(P7, 3, 2, 3, 1)] = E_OFF;
  st7.e[eBetween(P7, 3, 2, 4, 2)] = E_OFF;
  st7.e[eBetween(P7, 3, 3, 3, 4)] = E_ON;
  st7.e[eBetween(P7, 3, 3, 4, 3)] = E_OFF;
  const s7 = nextSteps(P7, st7);
  assert.equal(s7.rule, 'boxStrand');
  assert.deepEqual(s7.firings[0].sets, [['e', eBetween(P7, 2, 2, 2, 3), E_OFF]]);

  // 7. corridorNoEarlyClose: 6x6 with open path (2,2)-(1,2)-(1,3)-(2,3), 2-cell forced corridor (3,2)-(3,3), extra clue at (4,4)
  const P8 = compile({ name: 'cnec', rows: 6, cols: 6, clues: [{ r: 4, c: 4, t: 'W' }] });
  const st8 = initialState(P8);
  for (const [r1, c1, r2, c2] of [[2, 2, 1, 2], [1, 2, 1, 3], [1, 3, 2, 3]]) st8.e[eBetween(P8, r1, c1, r2, c2)] = E_ON;
  st8.e[eBetween(P8, 2, 2, 2, 3)] = E_OFF;
  st8.e[eBetween(P8, 3, 2, 3, 1)] = E_OFF;
  st8.e[eBetween(P8, 3, 2, 4, 2)] = E_OFF;
  st8.e[eBetween(P8, 3, 3, 3, 4)] = E_OFF;
  st8.e[eBetween(P8, 3, 3, 4, 3)] = E_OFF;
  const s8 = nextSteps(P8, st8);
  assert.equal(s8.rule, 'corridorNoEarlyClose');
  assert.ok(s8.firings[0].sets.some(([k, x, v]) => k === 'e' && x === eBetween(P8, 3, 2, 3, 3) && v === E_OFF));

  // Negative/boundary guards:
  // 8. blackNoEarlyClose must NOT fire when closing the final loop (no extra loop cells outside)
  const P5final = compile({ name: 'bnec_final', rows: 7, cols: 7, clues: [{ r: 2, c: 2, t: 'B' }] });
  const st5f = initialState(P5final);
  for (const [r1, c1, r2, c2] of [
    [2, 2, 2, 3], [2, 3, 2, 4], [2, 4, 2, 5], [2, 5, 3, 5], [3, 5, 4, 5], [4, 5, 4, 4], [4, 4, 4, 3], [4, 3, 4, 2],
  ]) st5f.e[eBetween(P5final, r1, c1, r2, c2)] = E_ON;
  st5f.e[eBetween(P5final, 2, 2, 2, 1)] = E_OFF;
  st5f.cell[3 * 7 + 3] = OFF;
  st5f.cell[3 * 7 + 4] = OFF;
  const rBnecFinal = RULES.find((r) => r.id === 'blackNoEarlyClose').find(P5final, st5f);
  assert.equal(rBnecFinal.length, 0, 'blackNoEarlyClose must not fire on final loop close');

  // 9. corridorNoEarlyClose must NOT fire when closing final loop
  const P8final = compile({ name: 'cnec_final', rows: 6, cols: 6, clues: [] });
  const st8f = initialState(P8final);
  for (const [r1, c1, r2, c2] of [[2, 2, 1, 2], [1, 2, 1, 3], [1, 3, 2, 3]]) st8f.e[eBetween(P8final, r1, c1, r2, c2)] = E_ON;
  for (const [r1, c1, r2, c2] of [[2, 2, 2, 3], [3, 2, 3, 1], [3, 2, 4, 2], [3, 3, 3, 4], [3, 3, 4, 3]]) {
    st8f.e[eBetween(P8final, r1, c1, r2, c2)] = E_OFF;
  }
  assert.equal(RULES.find((r) => r.id === 'corridorNoEarlyClose').find(P8final, st8f).length, 0);

  // 10. boxStrand must NOT fire when both c and d have on===1, or when c has 3 unknown exits, or when c is OFF
  const boxRule = RULES.find((r) => r.id === 'boxStrand');
  const st7both = { cell: st7.cell.slice(), e: st7.e.slice(), cycle: false };
  st7both.e[eBetween(P7, 3, 2, 3, 1)] = E_ON; // now both c and d have on===1
  assert.equal(boxRule.find(P7, st7both).length, 0);
  const st7three = { cell: st7.cell.slice(), e: st7.e.slice(), cycle: false };
  st7three.e[eBetween(P7, 3, 2, 3, 1)] = 0; // c now has 3 unknown exits
  assert.equal(boxRule.find(P7, st7three).length, 0);
  const st7off = { cell: st7.cell.slice(), e: st7.e.slice(), cycle: false };
  st7off.cell[3 * 6 + 2] = OFF; // standalone OFF cell guard
  assert.equal(boxRule.find(P7, st7off).length, 0);

  // 11. whiteDeadEndPinch deduplicates when two white circles flank the same edge vk
  const P6dup = compile({ name: 'wdep_dup', rows: 6, cols: 6, clues: [{ r: 3, c: 2, t: 'W' }, { r: 3, c: 4, t: 'W' }] });
  const st6d = initialState(P6dup);
  st6d.e[eBetween(P6dup, 2, 2, 1, 2)] = E_OFF;
  st6d.e[eBetween(P6dup, 2, 2, 2, 1)] = E_OFF;
  st6d.e[eBetween(P6dup, 2, 4, 1, 4)] = E_OFF;
  st6d.e[eBetween(P6dup, 2, 4, 2, 5)] = E_OFF;
  st6d.e[eBetween(P6dup, 2, 3, 1, 3)] = E_ON;
  st6d.e[eBetween(P6dup, 3, 3, 4, 3)] = E_ON;
  const wdepHits = RULES.find((r) => r.id === 'whiteDeadEndPinch').find(P6dup, st6d);
  assert.equal(wdepHits.length, 1, 'duplicate vk firing should be deduplicated');

  // 12. blackWhiteNoTurn fires on 'straight' and 'blocked' reasons as well as 'white'
  const P3s = compile({ name: 'bwnt_str', rows: 7, cols: 7, clues: [{ r: 2, c: 2, t: 'W' }, { r: 2, c: 4, t: 'B' }] });
  const st3s = initialState(P3s);
  st3s.e[eBetween(P3s, 2, 1, 2, 0)] = E_ON; // far cell (2,1) already continues straight left
  const s3s = RULES.find((r) => r.id === 'blackWhiteNoTurn').find(P3s, st3s);
  assert.equal(s3s.length, 1);
  assert.equal(s3s[0].info.reason, 'straight');
  const st3b = initialState(P3s);
  st3b.e[eBetween(P3s, 2, 1, 1, 1)] = E_OFF;
  st3b.e[eBetween(P3s, 2, 1, 3, 1)] = E_OFF; // far cell (2,1) has both turns blocked
  const s3b = RULES.find((r) => r.id === 'blackWhiteNoTurn').find(P3s, st3b);
  assert.equal(s3b.length, 1);
  assert.equal(s3b[0].info.reason, 'blocked');

  // 13. parityPocket and chokepoint bail with [] on already-contradictory states (never emit bogus/opposing edges)
  const Pbad = compile({ name: 'bad_topo', rows: 6, cols: 6, clues: [{ r: 2, c: 4, t: 'W' }, { r: 4, c: 4, t: 'W' }] });
  const stBad = initialState(Pbad);
  stBad.e[eBetween(Pbad, 1, 1, 2, 1)] = E_ON;
  stBad.e[eBetween(Pbad, 0, 1, 0, 2)] = E_OFF;
  stBad.e[eBetween(Pbad, 1, 1, 1, 2)] = E_OFF;
  stBad.e[eBetween(Pbad, 1, 0, 2, 0)] = E_OFF;
  assert.equal(RULES.find((r) => r.id === 'parityPocket').find(Pbad, stBad, {}).length, 0);
  assert.equal(RULES.find((r) => r.id === 'chokepoint').find(Pbad, stBad, {}).length, 0);

  // 14. nextSteps(..., without) filtering one imagine tier still finds costlier allowed imagine tiers
  const exp12 = parseCsv(fs.readFileSync(path.join(root, 'data', '12x12-expert.csv'), 'utf8'));
  const p11 = compile({ ...exp12.find((p) => p.name === '12X12-EXPERT-011') });
  const st11 = initialState(p11);
  let sawFiltered = false;
  for (let k = 0; k < 100; k++) {
    const base = nextSteps(p11, { cell: st11.cell.slice(), e: st11.e.slice(), cycle: st11.cycle });
    if (!base) break;
    if (base.rule === 'imagineLocal') {
      const alt = nextSteps(p11, { cell: st11.cell.slice(), e: st11.e.slice(), cycle: st11.cycle }, null, ['imagineLocal', 'tryEdge']);
      if (alt && (alt.rule === 'imagineTrace' || alt.rule === 'imagineChain')) { sawFiltered = true; break; }
    }
    for (const f of base.firings) applySets(st11, f.sets);
  }
  assert.equal(sawFiltered, true, 'excluding imagineLocal must still allow imagineTrace/imagineChain');
});

test('gray pearl human rules fire cleanly and are 100% sound on random unique mixed & all-gray boards', () => {
  // 1. grayMustBeBlack on a corner
  const Pg1 = compile({ name: 'gmbb', rows: 4, cols: 4, clues: [{ r: 0, c: 0, t: 'G' }] });
  const s1 = nextSteps(Pg1, initialState(Pg1));
  assert.equal(s1.rule, 'grayMustBeBlack');
  assert.deepEqual(s1.firings[0].sets, [['g', 0, BLACK]]);

  // 2. grayMustBeWhite when an interior gray has both vertical 2-step extensions blocked by walls (3x5 board, gray at (1,2))
  const Pg2 = compile({ name: 'gmbw', rows: 3, cols: 5, clues: [{ r: 1, c: 2, t: 'G' }] });
  const s2 = nextSteps(Pg2, initialState(Pg2));
  assert.equal(s2.rule, 'grayMustBeWhite');
  assert.deepEqual(s2.firings[0].sets, [['g', 1 * 5 + 2, WHITE]]);

  // 3. grayFromShape resolves a gray pearl with 2 drawn segments (bookkeeping) and unlocks blackExtend
  const Pg3 = compile({ name: 'gfs', rows: 5, cols: 5, clues: [{ r: 2, c: 2, t: 'G' }] });
  const st3 = initialState(Pg3);
  st3.e[Pg3.ed[(2 * 5 + 2) * 4 + 0]] = E_ON;
  st3.e[Pg3.ed[(2 * 5 + 2) * 4 + 1]] = E_ON;
  const f3 = RULES.find((r) => r.id === 'grayFromShape').find(Pg3, st3);
  assert.equal(f3.length, 1);
  assert.deepEqual(f3[0].sets, [['g', 2 * 5 + 2, BLACK]]);
  const s3 = nextSteps(Pg3, st3);
  assert.equal(s3.rule, 'blackExtend');

  // 4. grayWhiteNoTurn: gray on top border (0,2) flanked by (0,1) and (0,3) whose turns down are crossed out -> must be Black
  const Pg4 = compile({ name: 'gwnt', rows: 5, cols: 5, clues: [{ r: 0, c: 2, t: 'G' }] });
  const st4 = initialState(Pg4);
  st4.e[Pg4.ed[(0 * 5 + 1) * 4 + 2]] = E_OFF; // (0,1)-(1,1) OFF
  st4.e[Pg4.ed[(0 * 5 + 3) * 4 + 2]] = E_OFF; // (0,3)-(1,3) OFF
  const f4 = RULES.find((r) => r.id === 'grayWhiteNoTurn').find(Pg4, st4);
  assert.equal(f4.length, 1);
  assert.deepEqual(f4[0].sets, [['g', 2, BLACK]]);

  // 5. Soundness fuzz on 30+ unique random mixed-gray and all-gray 4x4 / 5x5 boards
  const rng = mulberry32(9090);
  let checked = 0;
  let solvedCount = 0;
  const grayRulesSeen = new Set();
  for (let attempt = 0; attempt < 900 && checked < 35; attempt++) {
    const rows = 4 + (attempt % 2);
    const cols = 4 + ((attempt >> 1) % 2);
    const allGray = attempt % 3 === 0;
    const empty = compile({ name: 'e', rows, cols, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 2000, rng });
    if (solRes.count === 0) continue;
    const loopSt = solRes.solutions[0];
    const clues = [];
    for (let i = 0; i < empty.N; i++) {
      const dirs = [];
      for (let d = 0; d < 4; d++) {
        const x = empty.ed[i * 4 + d];
        if (x >= 0 && loopSt.e[x] === E_ON) dirs.push(d);
      }
      if (dirs.length !== 2) continue;
      const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
      const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
      const s0 = ext0 >= 0 && loopSt.e[ext0] === E_ON;
      const s1 = ext1 >= 0 && loopSt.e[ext1] === E_ON;
      if (straight && !(s0 && s1)) clues.push({ r: (i / cols) | 0, c: i % cols, t: (allGray || rng() < 0.55) ? 'G' : 'W' });
      else if (!straight && s0 && s1) clues.push({ r: (i / cols) | 0, c: i % cols, t: (allGray || rng() < 0.55) ? 'G' : 'B' });
    }
    if (!clues.some((c) => c.t === 'G')) continue;
    const P = compile({ name: `gfuzz_${attempt}`, rows, cols, clues });
    const exact = solve(P, { limit: 2, maxNodes: 30000 });
    if (exact.exceeded || exact.count !== 1) continue;
    checked++;
    const truth = exact.solutions[0];
    const r = rate(P);
    for (const s of r.steps) {
      if (s.rule.startsWith('gray') || s.info?.grayCell >= 0) grayRulesSeen.add(s.rule);
      for (const [k, idx, val] of s.sets) {
        if (k === 'e') assert.equal(val, truth.e[idx], `UNSOUND edge by ${s.rule} on ${P.name}`);
        else if (k === 'c') assert.equal(val, truth.cell[idx], `UNSOUND cell by ${s.rule} on ${P.name}`);
        else if (k === 'g') assert.equal(val, truth.clue[idx], `UNSOUND gray label by ${s.rule} on ${P.name} cell ${idx}`);
      }
    }
    if (r.solved) {
      solvedCount++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, truth));
    }
  }
  assert.ok(checked >= 25, `expected >= 25 unique gray boards, got ${checked}`);
  assert.ok(solvedCount >= checked * 0.8, `expected rules to solve most gray boards, solved ${solvedCount}/${checked}`);
  assert.ok(grayRulesSeen.size >= 2, `expected gray rules to fire, saw ${[...grayRulesSeen].join(', ')}`);
});

test('fullBoard rules (checkerPocket, checkerParity, givens) fire cleanly and are 100% sound on random unique boards', () => {
  // 1. Direct checkerPocket firing: 4x4 full board with a 3-cell pocket (0,0)-(0,1)-(0,2)
  // Wait: let's construct a clean 4x4 full-board where (0,0)-(0,1)-(0,2) has 2 light (0,0),(0,2) and 1 dark (0,1):
  // If right edge (0,2)-(0,3) is E_OFF and (0,0)-(1,0) is E_ON, (0,1)-(1,1) is unknown (dark), (0,2)-(1,2) is unknown (light):
  // Let's test on a clean 4x6 full board with top-left 1x3 rect (0,0)..(0,2) where (0,2)-(0,3) is E_OFF:
  // Inside rect: (0,0)=L need 2, (0,1)=D need 2, (0,2)=L need 2 -> needLight=4, needDark=2, diff=+2.
  // Exits downward: (0,0)-(1,0) (L), (0,1)-(1,1) (D), (0,2)-(1,2) (L) -> kL=2, kD=1!
  // Since diff === kL === 2, BOTH light exits (0,0)-(1,0) & (0,2)-(1,2) MUST be ON and dark exit (0,1)-(1,1) MUST be OFF!
  const Pc = compile({
    name: 'cp_test', rows: 4, cols: 6, fullBoard: true, clues: [],
    givens: [{ r: 0, c: 2, dir: 'H', v: 0 }],
  });
  const stc = initialState(Pc);
  const cpHits = RULES.find((r) => r.id === 'checkerPocket').find(Pc, stc);
  assert.ok(cpHits.length >= 1, 'expected checkerPocket to fire on 1x3 corner pocket');
  const hit = cpHits.find((f) => f.sets.some(([k, x, v]) => k === 'e' && x === Pc.ed[(0 * 6 + 1) * 4 + 2] && v === E_OFF));
  assert.ok(hit, 'expected checkerPocket to force dark exit (0,1)-(1,1) OFF');

  // 1b. Direct checkerParity firing on a larger (> 6 cell) 1x7 row band (0,0)..(0,6) on a 4x8 full board
  // where (0,6)-(0,7) is E_OFF: 4 Light + 3 Dark -> needLight=8, needDark=6, diff=+2; wait: downward exits have 4 L & 3 D,
  // so block 2 Light exits (0,2)-(1,2) and (0,4)-(1,4) -> remaining kL=2, kD=3 -> diff===kL===2 forces ALL 2 light exits ON and ALL 3 dark exits OFF!
  const Pcp = compile({
    name: 'cp_large', rows: 4, cols: 8, fullBoard: true, clues: [],
    givens: [
      { r: 0, c: 6, dir: 'H', v: 0 },
      { r: 0, c: 2, dir: 'V', v: 0 },
      { r: 0, c: 4, dir: 'V', v: 0 },
    ],
  });
  const cpLarge = RULES.find((r) => r.id === 'checkerParity').find(Pcp, initialState(Pcp));
  assert.ok(cpLarge.length >= 1, 'expected checkerParity to fire on 1x7 band');
  assert.ok(cpLarge.some((f) => f.info.area.length === 7 && f.sets.length === 5));

  // 2. Soundness fuzz across 35+ unique random 4x6 and 6x6 full-board puzzles (circles, lines, walls, mixed givens)
  const rng = mulberry32(8080);
  let checked = 0;
  let solvedCount = 0;
  const rulesSeen = new Set();
  for (let attempt = 0; attempt < 600 && checked < 35; attempt++) {
    const rows = attempt % 2 === 0 ? 4 : 6, cols = 6;
    const empty = compile({ name: 'ef', rows, cols, clues: [], fullBoard: true });
    const solRes = solve(empty, { limit: 1, maxNodes: 4000, rng });
    if (solRes.count === 0) continue;
    const truth = solRes.solutions[0];
    const mode = attempt % 4;
    const clues = [];
    const givens = [];
    if (mode === 0) {
      for (let i = 0; i < empty.N; i++) {
        const dirs = [];
        for (let d = 0; d < 4; d++) { const x = empty.ed[i * 4 + d]; if (x >= 0 && truth.e[x] === E_ON) dirs.push(d); }
        const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
        const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
        const s0 = ext0 >= 0 && truth.e[ext0] === E_ON, s1 = ext1 >= 0 && truth.e[ext1] === E_ON;
        if (straight && !(s0 && s1) && rng() < 0.35) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
        else if (!straight && s0 && s1 && rng() < 0.35) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
      }
    } else {
      for (let x = 0; x < empty.numEdges; x++) {
        if (empty.edgeA[x] < 0) continue;
        const isOn = truth.e[x] === E_ON;
        if (mode === 1 && !isOn) continue;
        if (mode === 2 && isOn) continue;
        if (rng() < 0.28) {
          const i = x >> 1;
          givens.push({ r: (i / cols) | 0, c: i % cols, dir: (x & 1) ? 'V' : 'H', v: isOn ? 1 : 0 });
        }
      }
    }
    const P = compile({ name: `fbf_${attempt}`, rows, cols, clues, fullBoard: true, givens });
    const exact = solve(P, { limit: 2, maxNodes: 30000 });
    if (exact.exceeded || exact.count !== 1) continue;
    checked++;
    const exactSol = exact.solutions[0];
    const r = rate(P);
    for (const s of r.steps) {
      if (!s.info?.bookkeeping) rulesSeen.add(s.rule);
      for (const [k, idx, val] of s.sets) {
        if (k === 'e') assert.equal(val, exactSol.e[idx], `UNSOUND edge by ${s.rule} on ${P.name}`);
        else if (k === 'c') assert.equal(val, exactSol.cell[idx], `UNSOUND cell by ${s.rule} on ${P.name}`);
      }
    }
    if (r.solved) {
      solvedCount++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, exactSol));
    }
  }
  assert.ok(checked >= 25, `expected >= 25 unique fullBoard boards, got ${checked}`);
  assert.ok(solvedCount >= checked * 0.85, `expected rules to solve most fullBoard boards, got ${solvedCount}/${checked}`);
  assert.ok(rulesSeen.size >= 3, `expected >= 3 rules on fullBoard fuzz, saw ${[...rulesSeen].join(', ')}`);
});

test('shaped / cutout boards: faceParity across holes & cutouts and soundness fuzz on random unique shaped boards', () => {
  // 1. faceShade bridges directly across an interior donut hole to force an edge on the far side!
  const donut = compile({
    name: 'fp_donut', rows: 6, cols: 6, clues: [],
    voids: [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 2 }, { r: 3, c: 3 }],
  });
  const st = initialState(donut);
  // Top border (0,2)-(0,3) ON -> face(0,2)=IN; inner top rim (1,2)-(1,3) OFF -> whole donut hole = IN.
  // Bottom border (5,2)-(5,3) OFF -> face(4,2)=OUT. So inner bottom rim (4,2)-(4,3) separates IN (hole) from OUT -> forced ON!
  st.e[2 * (0 * 6 + 2)] = E_ON;
  st.e[2 * (1 * 6 + 2)] = E_OFF;
  st.e[2 * (5 * 6 + 2)] = E_OFF;
  const fs = findFaceShade(donut, st);
  const eBotRim = 2 * (4 * 6 + 2);
  const hit = fs.find((x) => x.info.edge === eBotRim);
  assert.ok(hit, 'faceShade must propagate parity across the donut hole to force far rim edge');
  assert.deepEqual(hit.sets, [['e', eBotRim, E_ON]]);
  assert.ok(hit.info.facesIn.length >= 9, 'faceShade hint overlay should include all 9 squares of the donut hole');

  // 2. Soundness fuzz on random unique shaped boards (interior holes + exterior cutouts)
  const rng = mulberry32(202612);
  let checked = 0, solvedCount = 0;
  const rulesSeen = new Set();
  for (let attempt = 0; attempt < 900 && checked < 35; attempt++) {
    const rows = 6, cols = 6;
    const voids = attempt % 2 === 0
      // Donut / interior holes
      ? [{ r: 2, c: 2 }, { r: 2, c: 3 }, { r: 3, c: 2 }, { r: 3, c: 3 }]
      // Cut-off corners + interior hole
      : [{ r: 0, c: 0 }, { r: 0, c: 5 }, { r: 5, c: 0 }, { r: 5, c: 5 }, { r: 2, c: 2 }];
    const empty = compile({ name: 'sh_e', rows, cols, voids, clues: [] });
    const solRes = solve(empty, { limit: 1, maxNodes: 8000, rng });
    if (!solRes.count) continue;
    const truth = solRes.solutions[0];
    const clues = [];
    for (let i = 0; i < empty.N; i++) {
      if (empty.isVoid[i]) continue;
      const dirs = [];
      for (let d = 0; d < 4; d++) { const x = empty.ed[i * 4 + d]; if (x >= 0 && truth.e[x] === E_ON) dirs.push(d); }
      if (dirs.length !== 2) continue;
      const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
      const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
      const s0 = ext0 >= 0 && truth.e[ext0] === E_ON, s1 = ext1 >= 0 && truth.e[ext1] === E_ON;
      if (straight && !(s0 && s1) && rng() < 0.85) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
      else if (!straight && s0 && s1 && rng() < 0.85) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
    }
    const P = compile({ name: `shf_${attempt}`, rows, cols, voids, clues });
    const exact = solve(P, { limit: 2, maxNodes: 25000 });
    if (exact.exceeded || exact.count !== 1) continue;
    checked++;
    const exactSol = exact.solutions[0];
    const r = rate(P);
    for (const s of r.steps) {
      if (!s.info?.bookkeeping) rulesSeen.add(s.rule);
      for (const [k, idx, val] of s.sets) {
        if (k === 'e') assert.equal(val, exactSol.e[idx], `UNSOUND edge by ${s.rule} on ${P.name}`);
        else if (k === 'c') assert.equal(val, exactSol.cell[idx], `UNSOUND cell by ${s.rule} on ${P.name}`);
      }
    }
    if (r.solved) {
      solvedCount++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, exactSol));
    }
  }
  assert.ok(checked >= 25, `expected >= 25 unique shaped boards, got ${checked}`);
  assert.ok(solvedCount >= checked * 0.85, `expected rules to solve most shaped boards, got ${solvedCount}/${checked}`);
  assert.ok(rulesSeen.size >= 5, `expected >= 5 rules on shaped fuzz, saw ${[...rulesSeen].join(', ')}`);
});

test('symmetry uniqueness inference: copy, center, axisEdge, diagPair, twoCrossings, orbitClose, and safety', () => {
  // 1. Direct copy on flipH 4x4
  const pMirror = compile({
    name: 'sym_m', rows: 4, cols: 4,
    clues: [{ r: 0, c: 0, t: 'B' }, { r: 0, c: 3, t: 'B' }],
  });
  assert.ok(detectSymmetries(pMirror).some((s) => s.id === 'flipH'));
  const st1 = initialState(pMirror);
  st1.e[pMirror.ed[0 * 4 + 1]] = E_ON; // (0,0)-(0,1)
  const f1 = findSymmetry(pMirror, st1);
  assert.ok(f1.some((x) => x.info.kind === 'copy' && x.info.dst === pMirror.ed[3 * 4 + 3] && x.sets[0][2] === E_ON));

  // 2. rot180 oddxodd center avoidance (5x5 center (2,2) cannot be on the loop)
  const pRot = compile({
    name: 'sym_r', rows: 5, cols: 5,
    clues: [{ r: 0, c: 1, t: 'W' }, { r: 4, c: 3, t: 'W' }],
  });
  const fRot = findSymmetry(pRot, initialState(pRot));
  assert.ok(fRot.some((x) => x.info.kind === 'center' && x.sets.length === 4 && x.sets.every((s) => s[2] === E_OFF)));

  // 3. Odd-width flipH axisEdge (5x5 center column c=2 vertical edges cannot be ON)
  const pOddH = compile({
    name: 'sym_oh', rows: 5, cols: 5,
    clues: [{ r: 0, c: 1, t: 'W' }, { r: 0, c: 3, t: 'W' }],
  });
  const fOddH = findSymmetry(pOddH, initialState(pOddH));
  assert.ok(fOddH.some((x) => x.info.kind === 'axisEdge' && x.sets.length === 4));

  // 4. Diagonal transpose: diagPair + twoCrossings + orbitClose:earlyLoop
  const pDiag = compile({
    name: 'sym_d', rows: 6, cols: 6,
    clues: [{ r: 0, c: 0, t: 'B' }, { r: 5, c: 5, t: 'B' }, { r: 1, c: 4, t: 'W' }, { r: 4, c: 1, t: 'W' }],
  });
  // Two diagonal corners (0,0) and (5,5) are already LOOP -> twoCrossings forces all other 4 diagonal vertices OFF!
  const fDiag = findSymmetry(pDiag, initialState(pDiag));
  assert.ok(fDiag.some((x) => x.info.kind === 'twoCrossings' && x.info.onCount === 2 && x.sets.length >= 4));

  // Diagonal orbitClose:earlyLoop — draw (0,0)-(0,1)-(0,2) and its transpose (0,0)-(1,0)-(2,0);
  // adding (0,2)-(1,2) + its transpose (2,0)-(2,1) and then (1,2)-(2,2) + (2,1)-(2,2) closes a 3x3 box early!
  const pDiag2 = compile({
    name: 'sym_d2', rows: 6, cols: 6,
    clues: [{ r: 0, c: 0, t: 'B' }, { r: 4, c: 5, t: 'W' }, { r: 5, c: 4, t: 'W' }],
  });
  const stD = initialState(pDiag2);
  // Symmetric L-paths from (0,0): (0,0)-(0,1)-(0,2)-(1,2) and (0,0)-(1,0)-(2,0)-(2,1)
  const onD = [
    pDiag2.ed[(0 * 6 + 0) * 4 + 1], pDiag2.ed[(0 * 6 + 1) * 4 + 1], pDiag2.ed[(0 * 6 + 2) * 4 + 2],
    pDiag2.ed[(0 * 6 + 0) * 4 + 2], pDiag2.ed[(1 * 6 + 0) * 4 + 2], pDiag2.ed[(2 * 6 + 0) * 4 + 1],
  ];
  for (const x of onD) stD.e[x] = E_ON;
  // Leave other diagonal cells (2..5) open so twoCrossings does not fire first; (1,2)-(2,2) + (2,1)-(2,2) closes early!
  const fEarly = findSymmetry(pDiag2, stD);
  const hitEarly = fEarly.find((x) => x.info.kind === 'orbitClose' && x.info.reason === 'earlyLoop');
  assert.ok(hitEarly, 'expected symmetry orbitClose:earlyLoop to reject early closing across diagonal');
  assert.ok(hitEarly.sets.every((s) => s[2] === E_OFF));
  const expEarly = explainStep(pDiag2, { rule: 'symmetry', sets: hitEarly.sets, info: hitEarly.info });
  assert.ok(expEarly.text.includes('close a loop early'));

  // 5. Safety: solvedByRules MUST skip uniqueness-assuming symmetry rules
  const pAmbig = compile({ name: 'ambig_sym', rows: 4, cols: 4, clues: [] });
  assert.equal(findSymmetry(pAmbig, initialState(pAmbig), { noUniqueness: true }).length, 0);
  assert.equal(solvedByRules(pAmbig).solved, false);

  // 6. Soundness check on a sample of real bonus-symmetry puzzles where symmetry fires
  const symBook = parseCsv(fs.readFileSync(path.join(root, 'data', 'bonus-symmetry.csv'), 'utf8'));
  let symFired = 0;
  for (const raw of symBook.slice(440, 480)) {
    const P = compile({ ...raw });
    const sol = decodeSolution(P, raw.solution);
    const r = rate(P);
    for (const s of r.steps) {
      if (s.rule !== 'symmetry') continue;
      symFired++;
      for (const [k, idx, val] of s.sets) {
        if (k === 'e') assert.equal(val, sol.e[idx], `unsound symmetry edge on ${raw.name}`);
        else if (k === 'c') assert.equal(val, sol.cell[idx], `unsound symmetry cell on ${raw.name}`);
      }
      const exp = explainStep(P, s);
      assert.ok(exp.nudge && exp.text, `symmetry explanation missing on ${raw.name}`);
    }
  }
  assert.ok(symFired >= 5, `expected symmetry to fire on real bonus-symmetry puzzles, got ${symFired}`);
});

test('Slitherlink rules & faceSlither fire cleanly and are 100% sound on pure, +Masyu, and +Full-board puzzles', () => {
  // 1. Direct unit checks for named Slitherlink rules
  const P0 = compile({ name: 's0', rows: 4, cols: 4, clues: [], slither: [{ r: 1, c: 1, n: 0 }] });
  assert.equal(nextSteps(P0, initialState(P0)).rule, 'slitherZero');

  // Corner 3 forces both outer corner edges ON
  const Pc3 = compile({ name: 'sc3', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 0, n: 3 }] });
  const rC3 = RULES.find((r) => r.id === 'slitherCorner').find(Pc3, initialState(Pc3));
  assert.equal(rC3.length, 1);
  assert.equal(rC3[0].sets.length, 2);
  assert.ok(rC3[0].sets.every((s) => s[2] === E_ON));

  // Corner 1 forces both outer corner edges OFF
  const Pc1 = compile({ name: 'sc1', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 0, n: 1 }] });
  const rC1 = RULES.find((r) => r.id === 'slitherCorner').find(Pc1, initialState(Pc1));
  assert.equal(rC1.length, 1);
  assert.ok(rC1[0].sets.every((s) => s[2] === E_OFF));

  // Corner 2 (Medium slitherCorner2) forces outer extension edges along board border ON
  const Pc2 = compile({ name: 'sc2', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 0, n: 2 }] });
  assert.equal(RULES.find((r) => r.id === 'slitherCorner').find(Pc2, initialState(Pc2)).length, 0);
  const rC2 = RULES.find((r) => r.id === 'slitherCorner2').find(Pc2, initialState(Pc2));
  assert.equal(rC2.length, 1);
  assert.equal(rC2[0].sets.length, 2);
  assert.ok(rC2[0].sets.every((s) => s[2] === E_ON));

  // Adjacent 3-3 negative guard: when ONLY two adjacent 3s exist, OR when surrounded ONLY by adjacent 1s
  // (which a 1x2 rectangle loop satisfies!), do NOT fire and do NOT report a face-parity conflict!
  const PadjOnly = compile({ name: 'sa_only', rows: 4, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 3 }, { r: 1, c: 2, n: 3 }] });
  assert.equal(RULES.find((r) => r.id === 'slitherAdjacent3').find(PadjOnly, initialState(PadjOnly)).length, 0);
  const PadjOnes = compile({
    name: 'sa_ones', rows: 4, cols: 5, clues: [],
    slither: [
      { r: 1, c: 1, n: 3 }, { r: 1, c: 2, n: 3 },
      { r: 0, c: 1, n: 1 }, { r: 0, c: 2, n: 1 },
      { r: 1, c: 0, n: 1 }, { r: 1, c: 3, n: 1 },
      { r: 2, c: 1, n: 1 }, { r: 2, c: 2, n: 1 },
    ],
  });
  assert.equal(solve(PadjOnes, { limit: 2 }).count, 1, '1x2 box must be the unique solution');
  assert.equal(RULES.find((r) => r.id === 'slitherAdjacent3').find(PadjOnes, initialState(PadjOnes)).length, 0);
  assert.equal(buildFaceParity(PadjOnes, initialState(PadjOnes), { useCircles: true, useSlither: true }).conflict, false);
  assert.equal(rate(PadjOnes).solved, true, 'rate() must solve adjacent 3-3 surrounded by 1s cleanly');
  // With a third clue outside, adjacent 3-3 fires cleanly!
  const Padj = compile({ name: 'sa', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 3 }, { r: 1, c: 2, n: 3 }, { r: 3, c: 3, n: 1 }] });
  const rAdj = RULES.find((r) => r.id === 'slitherAdjacent3').find(Padj, initialState(Padj));
  assert.equal(rAdj.length, 1);
  assert.equal(rAdj[0].sets.length, 5);

  // Direct slitherLineIn (3 with 0 X, 2 with 1 X, 1 with 2 X), slither1LineIn, and faceSlither checks
  const P3in = compile({ name: 's3in', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 3 }] });
  const st3in = initialState(P3in);
  st3in.e[P3in.ed[(1 * 5 + 1) * 4 + 0]] = E_ON; // line enters NW corner (1,1) from north
  const r3in = RULES.find((r) => r.id === 'slitherLineIn').find(P3in, st3in);
  assert.equal(r3in.length, 1);
  assert.equal(r3in[0].sets.length, 3);

  // Generalized slitherLineIn on a 2 with 1 X: incoming line at NW corner forces the other open opposite side ON and blocks W exit
  const P2in = compile({ name: 's2in', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 2 }] });
  const st2in = initialState(P2in);
  const f2in = 1 * 4 + 1;
  st2in.e[P2in.faceEdges[f2in * 4 + 1]] = E_OFF; // east side of 2 is X
  st2in.e[P2in.ed[(1 * 5 + 1) * 4 + 0]] = E_ON;  // line enters NW corner (1,1) from north
  const r2in = RULES.find((r) => r.id === 'slitherLineIn').find(P2in, st2in);
  assert.equal(r2in.length, 1);
  assert.equal(r2in[0].sets.length, 2); // south side ON + west outside exit OFF
  assert.ok(r2in[0].sets.some(([k, x, v]) => k === 'e' && x === P2in.faceEdges[f2in * 4 + 2] && v === E_ON));
  assert.ok(r2in[0].sets.some(([k, x, v]) => k === 'e' && x === P2in.ed[(1 * 5 + 1) * 4 + 3] && v === E_OFF));

  // Generalized slitherLineIn on a 1 with 2 X's: incoming line at NW corner must enter the 1, blocking west outside exit
  const P1x = compile({ name: 's1x', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 1 }] });
  const st1x = initialState(P1x);
  st1x.e[P1x.faceEdges[f2in * 4 + 1]] = E_OFF;
  st1x.e[P1x.faceEdges[f2in * 4 + 2]] = E_OFF;
  st1x.e[P1x.ed[(1 * 5 + 1) * 4 + 0]] = E_ON;
  const r1x = RULES.find((r) => r.id === 'slitherLineIn').find(P1x, st1x);
  assert.equal(r1x.length, 1);
  assert.deepEqual(r1x[0].sets, [['e', P1x.ed[(1 * 5 + 1) * 4 + 3], E_OFF]]);

  const P1in = compile({ name: 's1in', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 1 }] });
  const st1in = initialState(P1in);
  st1in.e[P1in.ed[(1 * 5 + 1) * 4 + 0]] = E_ON;
  st1in.e[P1in.ed[(1 * 5 + 1) * 4 + 3]] = E_OFF;
  const r1in = RULES.find((r) => r.id === 'slither1LineIn').find(P1in, st1in);
  assert.equal(r1in.length, 1);
  assert.equal(r1in[0].sets.length, 2);

  // faceSlither parity: 0 at (0,0) makes (0,1) Outside (same as top border) -> 2 at (0,1) has 2 SAME neighbors -> forces bottom & right ON
  const Pfs = compile({ name: 'sfs', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 0, n: 0 }, { r: 0, c: 1, n: 2 }, { r: 2, c: 2, n: 2 }] });
  const rfs = findFaceSlither(Pfs, initialState(Pfs));
  assert.ok(rfs.length >= 2, 'findFaceSlither must deduce forced edges from 0-2 border parity');

  // Regression: classifyImagine with a 'g' (gray cell) step must treat idx as a cell, not an edge index
  const Pgray = compile({ name: 'gcls', rows: 5, cols: 5, clues: [{ r: 4, c: 4, t: 'G' }] });
  const clsG = classifyImagine(
    Pgray, initialState(Pgray), -1,
    [{ rule: 'grayMustBeBlack', sets: [['g', 24, BLACK]], info: { cell: 24 } }],
    { kind: 'blackBroken', cell: 24 }, false, 24,
  );
  assert.equal(clsG.rule, 'imagineLocal');
  assert.equal(clsG.maxDist, 0);

  // Diagonal 3-3 and diagonal 3-2-3
  const Pdiag3 = compile({ name: 'sd3', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 3 }, { r: 2, c: 2, n: 3 }] });
  assert.equal(RULES.find((r) => r.id === 'slitherDiag3').find(Pdiag3, initialState(Pdiag3)).length, 1);
  const Pdiag32 = compile({ name: 'sd32', rows: 6, cols: 6, clues: [], slither: [{ r: 1, c: 1, n: 3 }, { r: 2, c: 2, n: 2 }, { r: 3, c: 3, n: 3 }] });
  assert.equal(RULES.find((r) => r.id === 'slitherDiag32').find(Pdiag32, initialState(Pdiag32)).length, 1);

  // 2. Soundness fuzz across pure Slitherlink, Slitherlink+Masyu, and Slitherlink+Full-board
  const rng = mulberry32(20261125);
  let checkedPure = 0, checkedHybrid = 0, checkedFull = 0, solvedTotal = 0;
  const slitherRulesSeen = new Set();

  const faceCounts = (P, truth) => {
    const out = [];
    const fr = P.rows - 1, fc = P.cols - 1;
    for (let r = 0; r < fr; r++) {
      for (let c = 0; c < fc; c++) {
        const f4 = (r * fc + c) * 4;
        let cnt = 0;
        for (let d = 0; d < 4; d++) {
          const x = P.faceEdges[f4 + d];
          if (x >= 0 && truth.e[x] === E_ON) cnt++;
        }
        if (cnt <= 3) out.push({ r, c, n: cnt });
      }
    }
    return out;
  };

  for (let attempt = 0; attempt < 900 && (checkedPure < 25 || checkedHybrid < 20 || checkedFull < 15); attempt++) {
    const mode = attempt % 3; // 0: pure, 1: slither+masyu, 2: slither+full
    if (mode === 0 && checkedPure >= 25) continue;
    if (mode === 1 && checkedHybrid >= 20) continue;
    if (mode === 2 && checkedFull >= 15) continue;
    const rows = mode === 2 ? 4 : (4 + (attempt % 2));
    const cols = mode === 2 ? 6 : (4 + ((attempt >> 1) % 2));
    const empty = compile({ name: 'se', rows, cols, clues: [], fullBoard: mode === 2 });
    const solRes = solve(empty, { limit: 1, maxNodes: 4000, rng });
    if (!solRes.count) continue;
    const truth = solRes.solutions[0];

    const allFaces = faceCounts(empty, truth);
    const slither = allFaces.filter(() => rng() < (mode === 0 ? 0.65 : mode === 1 ? 0.35 : 0.45));
    if (!slither.length) continue;

    const clues = [];
    if (mode === 1) {
      for (let i = 0; i < empty.N; i++) {
        const dirs = [];
        for (let d = 0; d < 4; d++) { const x = empty.ed[i * 4 + d]; if (x >= 0 && truth.e[x] === E_ON) dirs.push(d); }
        if (dirs.length !== 2) continue;
        const straight = ((dirs[0] ^ dirs[1]) & 1) === 0;
        const ext0 = empty.ed2[i * 4 + dirs[0]], ext1 = empty.ed2[i * 4 + dirs[1]];
        const s0 = ext0 >= 0 && truth.e[ext0] === E_ON, s1 = ext1 >= 0 && truth.e[ext1] === E_ON;
        if (straight && !(s0 && s1) && rng() < 0.3) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'W' });
        else if (!straight && s0 && s1 && rng() < 0.3) clues.push({ r: (i / cols) | 0, c: i % cols, t: 'B' });
      }
      if (!clues.length) continue;
    }

    const P = compile({ name: `slf_${mode}_${attempt}`, rows, cols, clues, slither, fullBoard: mode === 2 });
    const exact = solve(P, { limit: 2, maxNodes: 30000 });
    if (exact.exceeded || exact.count !== 1) continue;
    if (mode === 0) checkedPure++;
    else if (mode === 1) checkedHybrid++;
    else checkedFull++;

    const exactSol = exact.solutions[0];
    const r = rate(P);
    for (const s of r.steps) {
      if (s.rule.startsWith('slither') || s.rule === 'faceSlither') slitherRulesSeen.add(s.rule);
      for (const [k, idx, val] of s.sets) {
        if (k === 'e') assert.equal(val, exactSol.e[idx], `UNSOUND edge by ${s.rule} on ${P.name}`);
        else if (k === 'c') assert.equal(val, exactSol.cell[idx], `UNSOUND cell by ${s.rule} on ${P.name}`);
      }
    }
    if (r.solved) {
      solvedTotal++;
      assert.equal(encodeSolution(P, r.state), encodeSolution(P, exactSol));
    }
  }
  const totalChecked = checkedPure + checkedHybrid + checkedFull;
  assert.ok(checkedPure >= 20, `expected >= 20 unique pure Slitherlink boards, got ${checkedPure}`);
  assert.ok(checkedHybrid >= 15, `expected >= 15 unique Slitherlink+Masyu boards, got ${checkedHybrid}`);
  assert.ok(checkedFull >= 10, `expected >= 10 unique Slitherlink+Full boards, got ${checkedFull}`);
  assert.ok(solvedTotal >= totalChecked * 0.9, `expected rules to solve >= 90% of Slitherlink boards, got ${solvedTotal}/${totalChecked}`);
  assert.ok(slitherRulesSeen.size >= 4, `expected >= 4 Slitherlink rules to fire, saw ${[...slitherRulesSeen].join(', ')}`);
});

test('findSlitherCorner2 handles blocked contDir via OFF cell symmetrically', () => {
  // Put a 2 at interior face (1,1) and block corner (1,1),
  // then at adjacent corner (1,2) block contDir (R -> (1,3)) via st.cell[(1,3)] = OFF while keeping edge (1,2)-(1,3) E_UNKNOWN!
  const P = compile({ name: 'sc2_off', rows: 5, cols: 5, clues: [], slither: [{ r: 1, c: 1, n: 2 }] });
  const st = initialState(P);
  // Block top-left corner (1,1) of face (1,1): U -> (0,1) and L -> (1,0)
  st.e[P.ed[(1 * 5 + 1) * 4 + 0]] = E_OFF;
  st.e[P.ed[(1 * 5 + 1) * 4 + 3]] = E_OFF;
  // At adjacent corner (1,2): contDir = R -> (1,3), perpOutDir = U -> (0,2).
  // Mark (1,3) OFF while leaving edge (1,2)-(1,3) E_UNKNOWN -> must force perpOutDir edge (1,2)-(0,2) ON!
  st.cell[1 * 5 + 3] = OFF;
  const cornerRule = RULES.find((r) => r.id === 'slitherCorner2');
  const fs = cornerRule.find(P, st);
  const perpEdge = P.ed[(1 * 5 + 2) * 4 + 0];
  assert.ok(fs.some((f) => f.sets.some(([k, x, v]) => k === 'e' && x === perpEdge && v === E_ON)),
    'expected blocked-via-OFF contDir to force perpendicular exit ON');
});

test('cross-family hybrid rules (slitherStraightCorner, slitherMustVisitCorner, blackMustVisitReach) fire cleanly', () => {
  // 1. slitherStraightCorner: white circle on TL corner (1,1) of 3 square (1,1) forces S & E sides ON
  const Psc3 = compile({ name: 'hsc3', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'W' }], slither: [{ r: 1, c: 1, n: 3 }] });
  const rSC = RULES.find((r) => r.id === 'slitherStraightCorner');
  const f3 = rSC.find(Psc3, initialState(Psc3));
  const f4 = (1 * 3 + 1) * 4;
  assert.ok(f3.some((f) => f.sets.some(([k, x, v]) => k === 'e' && x === Psc3.faceEdges[f4 + 1] && v === E_ON)
    && f.sets.some(([k, x, v]) => k === 'e' && x === Psc3.faceEdges[f4 + 2] && v === E_ON)),
    'white circle on corner of 3 square must force both opposite sides ON');

  // 1b. slitherStraightCorner with Mid-loop vertex dot on corner of 1 square forces both opposite sides OFF
  const Psc1 = compile({ name: 'hsc1', rows: 4, cols: 4, clues: [], midloop: [{ r: 1, c: 1, dir: 'C' }], slither: [{ r: 1, c: 1, n: 1 }] });
  const f1 = rSC.find(Psc1, initialState(Psc1));
  assert.ok(f1.some((f) => f.sets.some(([k, x, v]) => k === 'e' && x === Psc1.faceEdges[f4 + 1] && v === E_OFF)
    && f.sets.some(([k, x, v]) => k === 'e' && x === Psc1.faceEdges[f4 + 2] && v === E_OFF)),
    'Mid-loop vertex dot on corner of 1 square must force both opposite sides OFF');

  // 2. slitherMustVisitCorner: Hamilton cycle corner (0,1) on top border of 1 square (0,1) has only 1 outside exit (L -> (0,0)),
  // forcing L ON and both opposite sides (E and S of square (0,1)) OFF
  const Pmv = compile({ name: 'hmv', rows: 4, cols: 4, clues: [], slither: [{ r: 0, c: 1, n: 1 }], fullBoard: true });
  const rMV = RULES.find((r) => r.id === 'slitherMustVisitCorner');
  const fmv = rMV.find(Pmv, initialState(Pmv));
  const mvF4 = (0 * 3 + 1) * 4;
  const outL = Pmv.ed[(0 * 4 + 1) * 4 + 3];
  assert.ok(fmv.some((f) => f.sets.some(([k, x, v]) => k === 'e' && x === outL && v === E_ON)
    && f.sets.some(([k, x, v]) => k === 'e' && x === Pmv.faceEdges[mvF4 + 1] && v === E_OFF)
    && f.sets.some(([k, x, v]) => k === 'e' && x === Pmv.faceEdges[mvF4 + 2] && v === E_OFF)),
    'must-visit border corner of 1 square must force its single outside exit ON and opposite sides OFF');

  // 3. blackMustVisitReach: Black circle at (0,1) next to Hamilton cycle dot (0,2) on top border -> forces (0,2)-(0,3) ON
  const Pbm = compile({ name: 'hbm', rows: 4, cols: 4, clues: [{ r: 0, c: 1, t: 'B' }], fullBoard: true });
  const rBM = RULES.find((r) => r.id === 'blackMustVisitReach');
  const fbm = rBM.find(Pbm, initialState(Pbm));
  const farE = Pbm.ed[(0 * 4 + 2) * 4 + 1];
  assert.ok(fbm.some((f) => f.sets.some(([k, x, v]) => k === 'e' && x === farE && v === E_ON)),
    'must-visit border dot next to black circle must force far straight edge ON');
});
