import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, parseCsv, solve, initialState, isSolved, decodeSolution, encodeSolution, E_ON, E_OFF, OFF, LOOP,
} from '../js/logic.js';
import { RULES, rate, solvedByRules, nextSteps, applySets, TIERS } from '../js/rating.js';
import { findFaceShade, findFaceCircle } from '../js/faceparity.js';

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
  // 5x5 board with two black circles in the center (2,2) and (2,3)
  const P = compile({
    name: 'bb_mid', rows: 5, cols: 5,
    clues: [{ r: 2, c: 2, t: 'B' }, { r: 2, c: 3, t: 'B' }],
  });
  const st = initialState(P);
  // First step should be blackWall (since (2,3) is 1 cell from right edge c=4!) -> let's use 5x6 so neither is near edge
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

test('new Medium circle patterns fire cleanly (blackTwoDiagWhites, blackWhiteNoTurn, whiteCornerPinch)', () => {
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
});
