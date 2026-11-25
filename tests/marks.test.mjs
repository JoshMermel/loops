import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, WHITE, BLACK } from '../js/logic.js';
import {
  FACE_BLANK, FACE_IN, FACE_OUT,
  cycleEdgeMark, toggleEdgeCross, cycleFaceMark, cycleFaceMarkReverse, numFacesOf,
  cycleGrayLabel, cycleGrayLabelReverse, reconcileAutoGray,
  reconcileAutoX, applyAutoX,
  autoShadeCompute, reconcileAutoShade, applyAutoShade, shadeConflicts,
  facesFromSolvedLoop,
} from '../js/marks.js';
import { checkMarksAgainstSolution } from '../js/hintstep.js';
import { makeGrace } from '../js/grace.js';

const blank = (P) => ({
  edges: new Uint8Array(P.numEdges),
  autoE: new Uint8Array(P.numEdges),
  faces: new Uint8Array(numFacesOf(P)),
  autoF: new Uint8Array(numFacesOf(P)),
});
const snap = (m) => ({
  edges: m.edges.slice(),
  autoE: m.autoE.slice(),
  faces: m.faces.slice(),
  autoF: m.autoF.slice(),
});

test('cycleEdgeMark cycles empty -> line -> X -> empty', () => {
  assert.equal(cycleEdgeMark(0), 1);
  assert.equal(cycleEdgeMark(1), 2);
  assert.equal(cycleEdgeMark(2), 0);
});

test('toggleEdgeCross toggles X cleanly from empty, segment, or X', () => {
  assert.equal(toggleEdgeCross(0), 2);
  assert.equal(toggleEdgeCross(1), 2);
  assert.equal(toggleEdgeCross(2), 0);
});

test('makeGrace delays newly bad items until commit and clears immediately', () => {
  const g = makeGrace();
  const r1 = g.update(new Set(['c0']), false);
  assert.equal(r1.show.size, 0);
  assert.equal(r1.waiting.has('c0'), true);
  assert.equal(r1.fresh, true);

  g.commit();
  const r2 = g.update(new Set(['c0']), false);
  assert.equal(r2.show.has('c0'), true);
  assert.equal(r2.waiting.size, 0);

  const r3 = g.update(new Set(), false);
  assert.equal(r3.show.size, 0);
});

// ---- Auto-X tests

test('Auto-X rule 1: cell with 2 segments X-es out its remaining incident edges', () => {
  const P = compile({ name: 'r1', rows: 4, cols: 4, clues: [] });
  const m = blank(P);
  const c = 1 * 4 + 1; // interior cell (1,1)
  m.edges[P.ed[c * 4 + 0]] = 1; // U
  m.edges[P.ed[c * 4 + 1]] = 1; // R
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[c * 4 + 2]], 2); // D auto-X
  assert.equal(m.edges[P.ed[c * 4 + 3]], 2); // L auto-X
  assert.equal(m.autoE[P.ed[c * 4 + 2]], 1);
  assert.equal(m.autoE[P.ed[c * 4 + 3]], 1);

  // Erasing one of the two segments removes both auto-X marks
  m.edges[P.ed[c * 4 + 1]] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[c * 4 + 2]], 0);
  assert.equal(m.edges[P.ed[c * 4 + 3]], 0);
  assert.equal(m.autoE[P.ed[c * 4 + 2]], 0);
});

test('Auto-X rule 2: white circle requires both straight segments through the dot before X-ing straight continuation on the other side', () => {
  const P = compile({ name: 'r2', rows: 5, cols: 5, clues: [{ r: 2, c: 2, t: 'W' }] });
  const m = blank(P);
  const w = 2 * 5 + 2;
  const oppExt = P.ed2[w * 4 + 1]; // (2,3)-(2,4)

  // Step 1: Drawing only left half (2,0)-(2,1)-(2,2) must NOT eagerly auto-X (2,3)-(2,4)
  m.edges[P.ed[w * 4 + 3]] = 1;
  m.edges[P.ed2[w * 4 + 3]] = 1;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[oppExt], 0, 'must wait until right segment through white circle is also drawn');

  // Step 2: Now draw the opposite straight segment through the white circle: (2,2)-(2,3)
  m.edges[P.ed[w * 4 + 1]] = 1;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[oppExt], 2, 'must auto-X straight continuation past right neighbor once both halves are drawn');
  assert.equal(m.autoE[oppExt], 1);

  // Step 3: Erasing either the right half (2,2)-(2,3) or outer left segment (2,0)-(2,1) cleanly removes the auto-X
  m.edges[P.ed[w * 4 + 1]] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[oppExt], 0);
  assert.equal(m.autoE[oppExt], 0);
});

test('Auto-X rule 3: black circle with a segment X-es out the opposite direction', () => {
  const P = compile({ name: 'r3', rows: 5, cols: 5, clues: [{ r: 2, c: 2, t: 'B' }] });
  const m = blank(P);
  const b = 2 * 5 + 2;
  m.edges[P.ed[b * 4 + 1]] = 1; // R
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[b * 4 + 3]], 2, 'opposite (L) must be auto-X');
  assert.equal(m.autoE[P.ed[b * 4 + 3]], 1);
  // U and D remain open
  assert.equal(m.edges[P.ed[b * 4 + 0]], 0);
  assert.equal(m.edges[P.ed[b * 4 + 2]], 0);
});

test('Auto-X rule 4: dead-end cell with 1 way out X-es that exit, cascades, and cleanly unwinds on erase', () => {
  // 4x4 board: corner (0,0) has exits R=(0,0)-(0,1) and D=(0,0)-(1,0).
  // Draw 2 segments into (0,1): (0,1)-(0,2) and (0,1)-(1,1) -> Rule 1 X-es (0,0)-(0,1),
  // which leaves corner (0,0) with only 1 exit (0,0)-(1,0) -> Rule 4 X-es (0,0)-(1,0)!
  const P = compile({ name: 'r4', rows: 4, cols: 4, clues: [] });
  const m = blank(P);
  const c01 = 0 * 4 + 1;
  m.edges[P.ed[c01 * 4 + 1]] = 1; // (0,1)-(0,2)
  m.edges[P.ed[c01 * 4 + 2]] = 1; // (0,1)-(1,1)
  reconcileAutoX(P, m, true);

  const eCornerR = P.ed[0 * 4 + 1]; // (0,0)-(0,1)
  const eCornerD = P.ed[0 * 4 + 2]; // (0,0)-(1,0)
  assert.equal(m.edges[eCornerR], 2);
  assert.equal(m.autoE[eCornerR], 1);
  assert.equal(m.edges[eCornerD], 2, 'corner (0,0) dead-end exit must cascade auto-X');
  assert.equal(m.autoE[eCornerD], 1);

  // Erase (0,1)-(0,2): BOTH auto-X edges (including cascaded dead-end) must vanish cleanly!
  m.edges[P.ed[c01 * 4 + 1]] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eCornerR], 0);
  assert.equal(m.edges[eCornerD], 0);
  assert.equal(m.autoE[eCornerD], 0);
});

test('Auto-X rule 4b: dead-end pocket (E1-F1-F2 returning to E2) auto-Xes F1-F2 and its corridor, and unwinds cleanly', () => {
  // Reproduces BONUS-SPARSE-8X8-01 position: E1, F1, F2 form a 2-exit corridor whose both ends meet at E2 (which has E2-E3 drawn)
  const P = compile({ name: 'pocket', rows: 8, cols: 8, clues: [{ r: 0, c: 0, t: 'B' }] });
  const cell = (r, c) => r * 8 + c;
  const edge = (a, b) => {
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const m = blank(P);
  // Segment E2-E3
  m.edges[edge(cell(1, 4), cell(2, 4))] = 1;
  // Blocking X's around the E1-F1-F2 pocket: D1-E1, F1-G1, F2-G2, F2-F3
  const xD1E1 = edge(cell(0, 3), cell(0, 4));
  const xF1G1 = edge(cell(0, 5), cell(0, 6));
  const xF2G2 = edge(cell(1, 5), cell(1, 6));
  const xF2F3 = edge(cell(1, 5), cell(2, 5));
  m.edges[xD1E1] = 2;
  m.edges[xF1G1] = 2;
  m.edges[xF2G2] = 2;
  m.edges[xF2F3] = 2;
  reconcileAutoX(P, m, true);

  const eE1E2 = edge(cell(0, 4), cell(1, 4));
  const eE1F1 = edge(cell(0, 4), cell(0, 5));
  const eF1F2 = edge(cell(0, 5), cell(1, 5));
  const eE2F2 = edge(cell(1, 4), cell(1, 5));
  for (const x of [eE1E2, eE1F1, eF1F2, eE2F2]) {
    assert.equal(m.edges[x], 2, `expected pocket edge ${x} to be auto-X`);
    assert.equal(m.autoE[x], 1);
  }

  // Opening one wall of the pocket (clearing F1-G1) cleanly unwinds all four auto-X edges
  m.edges[xF1G1] = 0;
  reconcileAutoX(P, m, true);
  for (const x of [eE1E2, eE1F1, eF1F2, eE2F2]) {
    assert.equal(m.edges[x], 0, `expected pocket edge ${x} to unwind`);
    assert.equal(m.autoE[x], 0);
  }
});

test('Auto-X rule 4 never auto-Xes the last exit of a circle cell', () => {
  const P = compile({ name: 'r4c', rows: 4, cols: 4, clues: [{ r: 0, c: 0, t: 'B' }] });
  const m = blank(P);
  m.edges[P.ed[0 * 4 + 1]] = 2; // manually cross out (0,0)-(0,1)
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[0 * 4 + 2]], 0, 'circle cell must not be treated as a dead-end');
});

test('Auto-X switch ON/OFF preserves player manual X marks and stays locked while forced', () => {
  const P = compile({ name: 'sw', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'B' }] });
  const m = blank(P);
  const b = 1 * 4 + 1;
  m.edges[P.ed[b * 4 + 1]] = 1; // segment right from black circle
  const manualX = P.ed[(3 * 4 + 0) * 4 + 1]; // unrelated manual X
  m.edges[manualX] = 2;

  const added = applyAutoX(P, m, true);
  assert.ok(added >= 1);
  assert.equal(m.edges[P.ed[b * 4 + 3]], 2);
  assert.equal(m.autoE[P.ed[b * 4 + 3]], 1);
  assert.equal(m.autoE[manualX], 0, 'manual X must never become auto');

  // Reconcile keeps forced auto-X in place while Auto-X is ON
  m.edges[P.ed[b * 4 + 3]] = 0;
  m.autoE[P.ed[b * 4 + 3]] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[b * 4 + 3]], 2);
  assert.equal(m.autoE[P.ed[b * 4 + 3]], 1);

  // Turning Auto-X OFF removes only auto X's, preserving manual X's
  applyAutoX(P, m, false);
  assert.equal(m.edges[P.ed[b * 4 + 3]], 0);
  assert.equal(m.edges[manualX], 2, 'manual X stays when Auto-X is turned off');
});

test('Removing a manual X (or manual shade) reveals an underlying auto-X (or auto-shade), which stays locked while forced', () => {
  const P = compile({ name: 'reveal', rows: 4, cols: 4, clues: [] });
  const m = blank(P);
  const c = 1 * 4 + 1; // (1,1)
  const eU = P.ed[c * 4 + 0], eR = P.ed[c * 4 + 1], eD = P.ed[c * 4 + 2];

  // 1. Place manual X on eD
  m.edges[eD] = 2; m.autoE[eD] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 2);
  assert.equal(m.autoE[eD], 0);

  // 2. Place two segments on eU and eR (which also gives eD an Auto-X reason)
  m.edges[eU] = 1; m.edges[eR] = 1;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 2);
  assert.equal(m.autoE[eD], 0, 'manual X stays manual while present');

  // 3. Remove manual X on eD -> underlying auto-X should immediately appear in its place!
  m.edges[eD] = 0; m.autoE[eD] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 2, 'underlying auto-X should appear when manual X is removed');
  assert.equal(m.autoE[eD], 1);

  // 4. Auto-X stays locked while the causing segments remain, and unwinds once a causing segment is erased
  m.edges[eU] = 0;
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 0, 'auto-X unwinds when its cause is erased');
  assert.equal(m.autoE[eD], 0);

  // Same behavior for manual face shade revealed as auto-shade
  const m2 = blank(P);
  const eTop = 2 * 0; // (0,0)-(0,1)
  m2.faces[0] = FACE_IN; m2.autoF[0] = 0;
  reconcileAutoShade(P, m2, true);
  m2.edges[eTop] = 1;
  reconcileAutoShade(P, m2, true);
  assert.equal(m2.autoF[0], 0, 'manual shade stays manual');
  m2.faces[0] = FACE_BLANK; m2.autoF[0] = 0;
  reconcileAutoShade(P, m2, true);
  assert.equal(m2.faces[0], FACE_IN, 'underlying auto-shade should appear when manual shade is removed');
  assert.equal(m2.autoF[0], 1);
});

test('checkMarksAgainstSolution does not blame auto-placed X consequences for a player mistake', () => {
  const P = compile({ name: 'b3', rows: 3, cols: 3, clues: [{ r: 0, c: 0, t: 'B' }, { r: 2, c: 2, t: 'B' }] });
  P.solution = '6ac5#53a9';
  const m = blank(P);
  // Put a wrong segment on (0,1)-(1,1) AND (0,1)-(0,2) so (0,1) has 2 segments -> Auto-X crosses (0,0)-(0,1) which IS on the real loop!
  m.edges[P.ed[(0 * 3 + 1) * 4 + 2]] = 1; // wrong segment
  m.edges[P.ed[(0 * 3 + 1) * 4 + 1]] = 1; // right segment
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[P.ed[0 * 3 + 1]], 2); // auto-X on true edge (0,0)-(0,1)
  assert.equal(m.autoE[P.ed[0 * 3 + 1]], 1);
  const chk = checkMarksAgainstSolution(P, m);
  assert.equal(chk.total, 1, 'should report only the 1 player wrong segment, not the auto-X consequence');
});

// ---- Inside / Outside shading & Auto-Shade tests

test('cycleFaceMark and cycleFaceMarkReverse cycle blank / Inside / Outside cleanly', () => {
  assert.equal(cycleFaceMark(FACE_BLANK), FACE_IN);
  assert.equal(cycleFaceMark(FACE_IN), FACE_OUT);
  assert.equal(cycleFaceMark(FACE_OUT), FACE_BLANK);

  assert.equal(cycleFaceMarkReverse(FACE_BLANK), FACE_OUT);
  assert.equal(cycleFaceMarkReverse(FACE_OUT), FACE_IN);
  assert.equal(cycleFaceMarkReverse(FACE_IN), FACE_BLANK);
});

test('Auto-Shade does not infer from border or interior white circles (keeps circle deductions for the player)', () => {
  const P = compile({
    name: 'ws', rows: 5, cols: 5,
    clues: [{ r: 0, c: 2, t: 'W' }, { r: 1, c: 1, t: 'W' }],
  });
  const fc = P.cols - 1;
  const f = (r, c) => r * fc + c;
  const m = blank(P);
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(0, 1)], FACE_BLANK);
  assert.equal(m.faces[f(0, 2)], FACE_BLANK);
  assert.equal(m.faces[f(1, 0)], FACE_BLANK);

  // Even when a player manually shades (0, 1) = IN, Auto-Shade does not jump across interior white circle (1, 1)
  m.faces[f(0, 1)] = FACE_IN;
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(1, 0)], FACE_BLANK);
});

test('Auto-Shade propagates from perimeter lines (IN) and X-es (OUT), across interior edges, and unwinds cleanly', () => {
  const P = compile({ name: 'perim', rows: 4, cols: 4, clues: [] });
  const fc = P.cols - 1; // 3
  const f = (r, c) => r * fc + c;
  const m = blank(P);

  // Draw top border line (0,0)-(0,1) -> face (0,0) = IN
  // Draw interior line (1,0)-(1,1) -> flips across into face (1,0) = OUT
  // Draw interior X (1,1)-(2,1) -> keeps color across into face (1,1) = OUT
  // Draw top border X (0,2)-(0,3) -> face (0,2) = OUT
  const eTop0 = 2 * (0 * 4 + 0);
  const eMid0 = 2 * (1 * 4 + 0);
  const eVert11 = 2 * (1 * 4 + 1) + 1;
  const eTop2 = 2 * (0 * 4 + 2);
  m.edges[eTop0] = 1;
  m.edges[eMid0] = 1;
  m.edges[eVert11] = 2;
  m.edges[eTop2] = 2;
  reconcileAutoShade(P, m, true);

  assert.equal(m.faces[f(0, 0)], FACE_IN);
  assert.equal(m.faces[f(1, 0)], FACE_OUT);
  assert.equal(m.faces[f(1, 1)], FACE_OUT);
  assert.equal(m.faces[f(0, 2)], FACE_OUT);

  // Erase top border line (0,0)-(0,1): entire chain (0,0), (1,0), (1,1) must unwind; (0,2) stays OUT
  m.edges[eTop0] = 0;
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(0, 0)], FACE_BLANK);
  assert.equal(m.faces[f(1, 0)], FACE_BLANK);
  assert.equal(m.faces[f(1, 1)], FACE_BLANK);
  assert.equal(m.faces[f(0, 2)], FACE_OUT);
});

test('Auto-X -> Auto-Shade chaining: dead-end Auto-X on border immediately paints face Outside', () => {
  // 4x4 board: 2 segments into (0,1) -> Auto-X crosses (0,0)-(0,1) AND corner exit (0,0)-(1,0) -> face (0,0) = OUT
  const P = compile({ name: 'chain', rows: 4, cols: 4, clues: [] });
  const m = blank(P);
  const c01 = 1;
  m.edges[P.ed[c01 * 4 + 1]] = 1; // (0,1)-(0,2) -> face (0,1) = IN
  m.edges[P.ed[c01 * 4 + 2]] = 1; // (0,1)-(1,1)
  reconcileAutoX(P, m, true);
  reconcileAutoShade(P, m, true);

  assert.equal(m.faces[0], FACE_OUT, 'corner face (0,0) bordered by Auto-X must become OUT');
  assert.equal(m.faces[1], FACE_IN, 'face (0,1) bordered by top line must become IN');
  assert.equal(m.autoF[0], 1);
  assert.equal(m.autoF[1], 1);
});

test('Auto-Shade propagates from manual faces across lines and X-es, never overwrites manual faces, and flags conflicts', () => {
  const P = compile({ name: 'man', rows: 4, cols: 4, clues: [] });
  const fc = P.cols - 1;
  const f = (r, c) => r * fc + c;
  const m = blank(P);

  // Draw interior vertical line (0,1)-(1,1) between face (0,0) and face (0,1), and X (0,2)-(1,2) between (0,1) and (0,2)
  const e01 = 2 * (0 * 4 + 1) + 1;
  const e02 = 2 * (0 * 4 + 2) + 1;
  m.edges[e01] = 1;
  m.edges[e02] = 2;

  // Player manually shades face (0,0) = IN -> across line (0,1) becomes OUT, across X (0,2) becomes OUT
  m.faces[f(0, 0)] = FACE_IN;
  m.autoF[f(0, 0)] = 0;
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(0, 1)], FACE_OUT);
  assert.equal(m.faces[f(0, 2)], FACE_OUT);
  assert.equal(m.autoF[f(0, 1)], 1);
  assert.equal(m.autoF[f(0, 2)], 1);
  assert.equal(shadeConflicts(P, m).size, 0);

  // Player manually shades (0,1) = IN (contradicts drawn line from (0,0)=IN)
  m.faces[f(0, 1)] = FACE_IN;
  m.autoF[f(0, 1)] = 0;
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(0, 0)], FACE_IN, 'manual face must not be overwritten on conflict');
  assert.equal(m.faces[f(0, 1)], FACE_IN, 'manual face must not be overwritten on conflict');
  const bad = shadeConflicts(P, m);
  assert.equal(bad.has(f(0, 0)), true);
  assert.equal(bad.has(f(0, 1)), true);
  assert.equal(autoShadeCompute(P, m).color[f(0, 1)], 0, 'conflicted face must not propagate corrupt color');

  // Clearing (0,1) restores auto OUT, and toggling Auto-Shade OFF preserves manual face (0,0)
  m.faces[f(0, 1)] = FACE_BLANK;
  m.autoF[f(0, 1)] = 0;
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[f(0, 1)], FACE_OUT);
  applyAutoShade(P, m, false);
  assert.equal(m.faces[f(0, 0)], FACE_IN, 'manual face stays when Auto-Shade is turned OFF');
  assert.equal(m.faces[f(0, 1)], FACE_BLANK, 'auto face clears when Auto-Shade is turned OFF');
  // Manual face conflicting with a border line clears the entire parity-connected component regardless of order
  const P2 = compile({ name: 'conf_order', rows: 4, cols: 4, clues: [] });
  const m2 = blank(P2);
  const f2 = (r, c) => r * 3 + c;
  m2.edges[2 * (0 * 4 + 0)] = 1; // top border -> face (0,0) = IN
  m2.edges[2 * (1 * 4 + 0)] = 2; // X linking face (0,0) <-> (1,0)
  m2.edges[2 * (2 * 4 + 0)] = 2; // X linking face (1,0) <-> (2,0)
  m2.faces[f2(1, 0)] = FACE_OUT; // wrong manual OUT on middle face
  m2.autoF[f2(1, 0)] = 0;
  const comp2 = autoShadeCompute(P2, m2);
  assert.equal(comp2.color[f2(0, 0)], 0);
  assert.equal(comp2.color[f2(1, 0)], 0);
  assert.equal(comp2.color[f2(2, 0)], 0, 'wrong manual shade must not flood past a border conflict');

  // Mirror symmetry: conflict between two manual faces clears the whole component in both directions
  const P3 = compile({ name: 'conf_mirror', rows: 3, cols: 4, clues: [] });
  const m3 = blank(P3);
  m3.edges[2 * (0 * 4 + 1) + 1] = 2; // X between (0,0) and (0,1)
  m3.edges[2 * (0 * 4 + 2) + 1] = 1; // line between (0,1) and (0,2)
  m3.faces[1] = FACE_IN; m3.autoF[1] = 0;
  m3.faces[2] = FACE_IN; m3.autoF[2] = 0;
  const comp3 = autoShadeCompute(P3, m3);
  assert.equal(comp3.color[0], 0);
  assert.equal(comp3.color[1], 0);
  assert.equal(comp3.color[2], 0);
});

test('facesFromSolvedLoop computes exact Inside/Outside shading for all dual squares', () => {
  // 4x4 board with a 2x2 loop in the top-left corner ((0,0)-(0,2)-(2,2)-(2,0)):
  // dual grid is 3x3; the 2x2 top-left faces are Inside, and the right/bottom border faces are Outside.
  const P = compile({ name: 'f4', rows: 4, cols: 4, clues: [] });
  const edges = new Uint8Array(P.numEdges);
  // Top (0,0)-(0,1)-(0,2)
  edges[P.ed[0 * 4 + 1]] = 1;
  edges[P.ed[1 * 4 + 1]] = 1;
  // Right (0,2)-(1,2)-(2,2)
  edges[P.ed[2 * 4 + 2]] = 1;
  edges[P.ed[(1 * 4 + 2) * 4 + 2]] = 1;
  // Bottom (2,2)-(2,1)-(2,0)
  edges[P.ed[(2 * 4 + 1) * 4 + 1]] = 1;
  edges[P.ed[(2 * 4 + 0) * 4 + 1]] = 1;
  // Left (2,0)-(1,0)-(0,0)
  edges[P.ed[(1 * 4 + 0) * 4 + 2]] = 1;
  edges[P.ed[(0 * 4 + 0) * 4 + 2]] = 1;

  const faces = facesFromSolvedLoop(P, edges);
  assert.deepEqual(Array.from(faces), [
    FACE_IN, FACE_IN, FACE_OUT,
    FACE_IN, FACE_IN, FACE_OUT,
    FACE_OUT, FACE_OUT, FACE_OUT,
  ]);
});

test('shadeConflicts with checkBorder=false allows inverted manual color schemes while still catching interior conflicts', () => {
  const P = compile({ name: 'inv', rows: 3, cols: 3, clues: [] });
  const m = blank(P);
  // Top border edge (0,0)-(0,1) is drawn, interior vertical edge (0,1)-(1,1) is drawn
  m.edges[P.ed[0 * 4 + 1]] = 1;
  m.edges[P.ed[1 * 4 + 2]] = 1;
  // Player uses inverted convention: amber (FACE_OUT) for Inside on face (0,0), teal (FACE_IN) for Outside on face (0,1)
  m.faces[0] = FACE_OUT;
  m.faces[1] = FACE_IN;

  // With checkBorder=true (Auto-Shade ON), border contradicts face (0,0) = OUT
  assert.equal(shadeConflicts(P, m, true).has(0), true);
  // With checkBorder=false (Auto-Shade OFF), inverted convention has zero conflicts
  assert.equal(shadeConflicts(P, m, false).size, 0);

  // An actual interior contradiction (both sides of interior drawn line have the same color) is still flagged
  m.faces[1] = FACE_OUT;
  const bad = shadeConflicts(P, m, false);
  assert.equal(bad.has(0), true);
  assert.equal(bad.has(1), true);
});

test('Auto-X + Auto-Shade places X between same-color squares and between Outside-shaded squares and the border, and unwinds cleanly', () => {
  // 4x4 board (3x3 faces):
  // Draw top-border lines (0,0)-(0,1) and (0,1)-(0,2) -> faces (0,0) and (0,1) are both Inside!
  // With useShade=true, interior vertical edge (0,1)-(1,1) separates Inside & Inside -> auto-X!
  // Also manually paint face (2,2) = Outside -> its two outer-border edges (3,2)-(3,3) and (2,3)-(3,3) both separate Outside & exterior -> auto-X!
  // (And since (3,3) becomes a corner with 2 X's, everything stays consistent and unwinds when cleared.)
  const P = compile({ name: 'xs', rows: 4, cols: 4, clues: [] });
  const m = blank(P);
  const eTop0 = P.ed[(0 * 4 + 0) * 4 + 1]; // (0,0)-(0,1)
  const eTop1 = P.ed[(0 * 4 + 1) * 4 + 1]; // (0,1)-(0,2)
  const eMidV = P.ed[(0 * 4 + 1) * 4 + 2]; // (0,1)-(1,1) between face(0,0) and face(0,1)
  m.edges[eTop0] = 1;
  m.edges[eTop1] = 1;
  reconcileAutoX(P, m, true, { useShade: true });
  reconcileAutoShade(P, m, true);
  assert.equal(m.faces[0], FACE_IN);
  assert.equal(m.faces[1], FACE_IN);
  assert.equal(m.edges[eMidV], 2, 'edge between two Inside squares must auto-X');
  assert.equal(m.autoE[eMidV], 1);

  // Paint bottom-right square (2,2) manually Outside -> both its outer-border edges auto-X
  const fBR = 2 * 3 + 2;
  const eBotR = P.ed[(3 * 4 + 2) * 4 + 1]; // (3,2)-(3,3)
  const eRightB = P.ed[(2 * 4 + 3) * 4 + 2]; // (2,3)-(3,3)
  m.faces[fBR] = FACE_OUT;
  m.autoF[fBR] = 0;
  reconcileAutoX(P, m, true, { useShade: true });
  reconcileAutoShade(P, m, true);
  assert.equal(m.edges[eBotR], 2, 'bottom-border edge next to Outside square must auto-X');
  assert.equal(m.autoE[eBotR], 1);
  assert.equal(m.edges[eRightB], 2, 'right-border edge next to Outside square must auto-X');
  assert.equal(m.autoE[eRightB], 1);

  // Turning Auto-Shade OFF (useShade=false) cleanly unwinds shade-derived border auto-X's
  // (while keeping Rule 1 full-cell auto-X on eMidV because (0,1) still has 2 segments!)
  reconcileAutoX(P, m, true, { useShade: false });
  applyAutoShade(P, m, false);
  assert.equal(m.edges[eBotR], 0, 'shade-derived border auto-X must unwind when Auto-Shade turns off');
  assert.equal(m.edges[eRightB], 0);
  assert.equal(m.edges[eMidV], 2, 'Rule 1 full-cell auto-X remains when Auto-Shade turns off');

  // Test pure same-color interior auto-X WITHOUT Rule 1: two manual Inside faces (1,0) and (1,1) separated by (1,1)-(2,1)
  const m2 = blank(P);
  const eIntV = P.ed[(1 * 4 + 1) * 4 + 2]; // (1,1)-(2,1) between face(1,0) and face(1,1)
  m2.faces[1 * 3 + 0] = FACE_IN;
  m2.faces[1 * 3 + 1] = FACE_IN;
  reconcileAutoX(P, m2, true, { useShade: true });
  assert.equal(m2.edges[eIntV], 2, 'pure same-color interior edge must auto-X');
  assert.equal(m2.autoE[eIntV], 1);
  // Clearing one manual face cleanly unwinds the auto-X
  m2.faces[1 * 3 + 1] = FACE_BLANK;
  reconcileAutoX(P, m2, true, { useShade: true });
  assert.equal(m2.edges[eIntV], 0, 'clearing one same-color face must unwind the auto-X');
});

test('gray pearl cycling, auto-labeling (autoG), unwinding, and Auto-X integration', () => {
  assert.equal(cycleGrayLabel(0), WHITE);
  assert.equal(cycleGrayLabel(WHITE), BLACK);
  assert.equal(cycleGrayLabel(BLACK), 0);
  assert.equal(cycleGrayLabelReverse(0), BLACK);
  assert.equal(cycleGrayLabelReverse(BLACK), WHITE);
  assert.equal(cycleGrayLabelReverse(WHITE), 0);

  const P = compile({ name: 'gauto', rows: 5, cols: 5, clues: [{ r: 2, c: 2, t: 'G' }] });
  const m = {
    edges: new Uint8Array(P.numEdges),
    autoE: new Uint8Array(P.numEdges),
    faces: new Uint8Array(numFacesOf(P)),
    autoF: new Uint8Array(numFacesOf(P)),
    grays: new Uint8Array(P.grays.length),
    autoG: new Uint8Array(P.grays.length),
  };
  const mid = 2 * 5 + 2;
  const eU = P.ed[mid * 4 + 0], eR = P.ed[mid * 4 + 1], eD = P.ed[mid * 4 + 2], eL = P.ed[mid * 4 + 3];

  // 1. Drawing 1 segment does NOT auto-label and does NOT trigger Black Rule 3 while unlabeled
  m.edges[eU] = 1;
  reconcileAutoGray(P, m);
  reconcileAutoX(P, m, true);
  assert.equal(m.grays[0], 0);
  assert.equal(m.edges[eD], 0, 'unlabeled gray must not trigger Black Rule 3');

  // 2. Manually labeling Black triggers Black Rule 3 (crosses out opposite edge eD)
  m.grays[0] = BLACK; m.autoG[0] = 0;
  reconcileAutoGray(P, m);
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 2, 'manual Black label on gray triggers Black Rule 3');
  assert.equal(m.autoE[eD], 1);

  // 3. Clearing manual label unwinds Black Rule 3 auto-X
  m.grays[0] = 0;
  reconcileAutoGray(P, m);
  reconcileAutoX(P, m, true);
  assert.equal(m.edges[eD], 0);

  // 4. Drawing a 90° turn (eU + eR) auto-labels Black (autoG=1); erasing eR unwinds it cleanly
  m.edges[eR] = 1;
  reconcileAutoGray(P, m);
  assert.equal(m.grays[0], BLACK);
  assert.equal(m.autoG[0], 1);
  m.edges[eR] = 0;
  reconcileAutoGray(P, m);
  assert.equal(m.grays[0], 0);
  assert.equal(m.autoG[0], 0);

  // 5. Drawing straight through (eU + eD) + straight extension on one side auto-labels White and triggers White Rule 2
  m.edges[eD] = 1;
  m.edges[P.ed2[mid * 4 + 0]] = 1; // (0,2)-(1,2)
  reconcileAutoGray(P, m);
  reconcileAutoX(P, m, true);
  assert.equal(m.grays[0], WHITE);
  assert.equal(m.autoG[0], 1);
  assert.equal(m.edges[P.ed2[mid * 4 + 2]], 2, 'auto-labeled White gray triggers White Rule 2');

  // 6. Manual label is NEVER overwritten by reconcileAutoGray even if drawn edges disagree
  m.grays[0] = BLACK; m.autoG[0] = 0;
  reconcileAutoGray(P, m);
  assert.equal(m.grays[0], BLACK);
  assert.equal(m.autoG[0], 0);

  // 7. Auto-X Rule 4 never auto-Xes the last exit of an unlabeled gray pearl
  const P2 = compile({ name: 'gdead', rows: 4, cols: 4, clues: [{ r: 1, c: 1, t: 'G' }] });
  const m2 = blank(P2);
  const c11 = 1 * 4 + 1;
  m2.edges[P2.ed[c11 * 4 + 0]] = 2;
  m2.edges[P2.ed[c11 * 4 + 1]] = 2;
  m2.edges[P2.ed[c11 * 4 + 2]] = 2;
  reconcileAutoX(P2, m2, true);
  assert.equal(m2.edges[P2.ed[c11 * 4 + 3]], 0, 'must never auto-X last exit of gray pearl');
});
