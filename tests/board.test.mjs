import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../js/logic.js';
import { hitTestCoords, advanceDrag, CELL_SIZE } from '../js/board.js';
import { clueStates, earlyLoopEdges } from '../js/clues.js';
import { otherEnd } from '../js/lineends.js';
import { makeColorKeeper, assignPathColors } from '../js/pathcolors.js';

const S = CELL_SIZE;

test('hitTestCoords distinguishes lattice tracks from intersection centers and handles bounds', () => {
  const P = compile({ name: 't', rows: 4, cols: 4, clues: [] });

  // Directly on intersection (1, 1) -> cell 5 (not an edge)
  const hNode = hitTestCoords(P, 1 * S, 1 * S);
  assert.deepEqual(hNode, { kind: 'cell', cell: 5, edge: -1 });

  // Midpoint of horizontal track (1, 1)-(1, 2) -> edge 2*5 = 10
  const hHoriz = hitTestCoords(P, 1.5 * S, 1.05 * S);
  assert.equal(hHoriz.kind, 'edge');
  assert.equal(hHoriz.edge, 10);

  // Midpoint of vertical track (1, 1)-(2, 1) -> edge 2*5 + 1 = 11
  const hVert = hitTestCoords(P, 0.96 * S, 1.5 * S);
  assert.equal(hVert.kind, 'edge');
  assert.equal(hVert.edge, 11);

  // Outer perimeter track (0, 0)-(0, 1) IS a playable edge -> edge 0
  const hPerim = hitTestCoords(P, 0.5 * S, 0.04 * S);
  assert.equal(hPerim.kind, 'edge');
  assert.equal(hPerim.edge, 0);

  // Center of an empty dual square (1.5, 1.5) hits dual face (1, 1) -> index 1*(4-1)+1 = 4
  const hSquareMid = hitTestCoords(P, 1.5 * S, 1.5 * S);
  assert.equal(hSquareMid.kind, 'face');
  assert.equal(hSquareMid.face, 4);
  assert.equal(hSquareMid.edge, -1);

  // Close to an intersection crossroad (1.08, 1.08) stays a neutral vertex pivot, never hits a face or stray edge
  const hNearVertex = hitTestCoords(P, 1.08 * S, 1.08 * S);
  assert.equal(hNearVertex.kind, 'cell');
  assert.equal(hNearVertex.cell, 5);

  // Off-center along a track (1.18, 1.02) now cleanly hits the track thanks to the tighter vertex dead zone
  const hNearStart = hitTestCoords(P, 1.18 * S, 1.02 * S);
  assert.equal(hNearStart.kind, 'edge');
  assert.equal(hNearStart.edge, 10);

  // Outer-left/top dual square (0.5, 0.5) -> face 0; bottom-right dual square (2.5, 2.5) -> face 8
  assert.equal(hitTestCoords(P, 0.5 * S, 0.5 * S).face, 0);
  assert.equal(hitTestCoords(P, 2.5 * S, 2.5 * S).face, 8);

  // Outside board -> null
  assert.equal(hitTestCoords(P, -0.6 * S, 0), null);
  assert.equal(hitTestCoords(P, 3.6 * S, 0), null);
});

test('clueStates marks broken (bad) circles and leaves valid/satisfied circles unmarked', () => {
  const P = compile({
    name: 'cs', rows: 4, cols: 4,
    clues: [{ r: 1, c: 1, t: 'W' }, { r: 0, c: 3, t: 'B' }],
  });
  const m = { edges: new Uint8Array(P.numEdges) };
  assert.deepEqual(clueStates(P, m), ['', '']);

  // White circle (1,1) going straight horizontally (1,0)-(1,1)-(1,2) and turning down at (1,2)-(2,2) -> unmarked ('')
  m.edges[P.ed[(1 * 4 + 1) * 4 + 3]] = 1;
  m.edges[P.ed[(1 * 4 + 1) * 4 + 1]] = 1;
  m.edges[P.ed[(1 * 4 + 2) * 4 + 2]] = 1;
  assert.equal(clueStates(P, m)[0], '');

  // If white circle instead turns at (1,1) -> bad
  const mBadW = { edges: new Uint8Array(P.numEdges) };
  mBadW.edges[P.ed[(1 * 4 + 1) * 4 + 0]] = 1;
  mBadW.edges[P.ed[(1 * 4 + 1) * 4 + 1]] = 1;
  assert.equal(clueStates(P, mBadW)[0], 'bad');

  // Black circle at (0,3) extending 2 left and 2 down -> unmarked ('')
  m.edges[P.ed[3 * 4 + 3]] = 1;
  m.edges[P.ed2[3 * 4 + 3]] = 1;
  m.edges[P.ed[3 * 4 + 2]] = 1;
  m.edges[P.ed2[3 * 4 + 2]] = 1;
  assert.equal(clueStates(P, m)[1], '');

  // Cross out straight continuation of black circle's leg -> bad
  m.edges[P.ed2[3 * 4 + 2]] = 2;
  assert.equal(clueStates(P, m)[1], 'bad');
});

test('earlyLoopEdges flags closed loops that miss clues or leave other segments, and ignores open paths or full single loops', () => {
  const P = compile({
    name: 'el', rows: 4, cols: 4,
    clues: [{ r: 0, c: 0, t: 'B' }, { r: 3, c: 3, t: 'B' }],
  });
  const edge = (r1, c1, r2, c2) => {
    const a = r1 * 4 + c1, b = r2 * 4 + c2;
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const m = { edges: new Uint8Array(P.numEdges) };

  // Open 3-edge path around (0,0)-(0,1)-(1,1)-(1,0): not closed -> no early loop
  const sq = [edge(0, 0, 0, 1), edge(0, 1, 1, 1), edge(1, 1, 1, 0), edge(1, 0, 0, 0)];
  m.edges[sq[0]] = 1; m.edges[sq[1]] = 1; m.edges[sq[2]] = 1;
  assert.equal(earlyLoopEdges(P, m).size, 0);

  // Close the 2x2 box while clue (3,3) is unvisited -> all 4 edges flagged
  m.edges[sq[3]] = 1;
  const bad1 = earlyLoopEdges(P, m);
  assert.equal(bad1.size, 4);
  for (const x of sq) assert.equal(bad1.has(x), true);

  // Add an open segment elsewhere -> only the closed box is flagged, not the open segment
  const stray = edge(3, 2, 3, 3);
  m.edges[stray] = 1;
  const bad2 = earlyLoopEdges(P, m);
  assert.equal(bad2.size, 4);
  assert.equal(bad2.has(stray), false);

  // Full outer border loop visiting BOTH clues with no other segments -> NOT flagged
  const full = { edges: new Uint8Array(P.numEdges) };
  for (let c = 0; c < 3; c++) { full.edges[edge(0, c, 0, c + 1)] = 1; full.edges[edge(3, c, 3, c + 1)] = 1; }
  for (let r = 0; r < 3; r++) { full.edges[edge(r, 0, r + 1, 0)] = 1; full.edges[edge(r, 3, r + 1, 3)] = 1; }
  assert.equal(earlyLoopEdges(P, full).size, 0);

  // Adding a stray segment inside that full loop makes it an early/extra loop -> full loop edges flagged
  full.edges[edge(1, 1, 1, 2)] = 1;
  assert.equal(earlyLoopEdges(P, full).size, 12);
});

test('advanceDrag includes the starting segment when dragging from A4-A5 to A5-A6 (upper or lower half) or around corners', () => {
  const P = compile({ name: 'drag', rows: 8, cols: 8, clues: [] });
  const cell = (r, c) => r * 8 + c;
  const edgeBetween = (a, b) => {
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };
  const runDrag = (coords) => {
    const startHit = hitTestCoords(P, coords[0][0] * S, coords[0][1] * S);
    const g = { startHit, curCell: startHit.cell, dragged: false, firstStep: true, lastEdge: -1 };
    const steps = [];
    for (let i = 1; i < coords.length; i++) {
      const h = hitTestCoords(P, coords[i][0] * S, coords[i][1] * S);
      advanceDrag(P, g, h, (a, b, first) => steps.push({ e: edgeBetween(a, b), first }));
    }
    return { g, steps };
  };

  const eA4A5 = edgeBetween(cell(3, 0), cell(4, 0));
  const eA5A6 = edgeBetween(cell(4, 0), cell(5, 0));
  const eA5B5 = edgeBetween(cell(4, 0), cell(4, 1));

  // Click lower half of A4-A5 (y=3.6), drag to A5-A6 (y=4.4) -> BOTH A4-A5 and A5-A6 applied
  const r1 = runDrag([[0, 3.6], [0, 4.0], [0, 4.4]]);
  assert.deepEqual(r1.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Click upper half of A4-A5 (y=3.4), drag to A5-A6 (y=4.4) -> BOTH A4-A5 and A5-A6 applied
  const r2 = runDrag([[0, 3.4], [0, 4.0], [0, 4.4]]);
  assert.deepEqual(r2.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Fast swipe from lower half of A4-A5 (y=3.6) straight to A6 (y=5.0) -> BOTH A4-A5 and A5-A6 applied
  const r3 = runDrag([[0, 3.6], [0, 5.0]]);
  assert.deepEqual(r3.steps, [{ e: eA4A5, first: true }, { e: eA5A6, first: false }]);

  // Corner drag: A4-A5 -> A5-B5 -> BOTH applied
  const r4 = runDrag([[0, 3.6], [0.4, 4.0]]);
  assert.deepEqual(r4.steps, [{ e: eA4A5, first: true }, { e: eA5B5, first: false }]);

  // Jittering across the midpoint of A4-A5 (3.48 -> 3.52) stays a tap (not a drag)
  const r5 = runDrag([[0, 3.48], [0, 3.52]]);
  assert.equal(r5.g.dragged, false);
  assert.equal(r5.steps.length, 0);

  // Jittering across the center of a dual square (1.48, 1.5 -> 1.52, 1.5) stays a tap (not a drag)
  const r6 = runDrag([[1.48, 1.5], [1.52, 1.5]]);
  assert.equal(r6.g.dragged, false);
  assert.equal(r6.steps.length, 0);
});

test('otherEnd finds far endpoint of an open path and ignores closed loops or branches', () => {
  const P = compile({ name: 'oe', rows: 3, cols: 3, clues: [] });
  const edges = new Uint8Array(P.numEdges);
  // Path: 0 - 1 - 4 - 5
  edges[P.ed[0 * 4 + 1]] = 1;
  edges[P.ed[1 * 4 + 2]] = 1;
  edges[P.ed[4 * 4 + 1]] = 1;
  assert.equal(otherEnd(P, edges, 0), 5);
  assert.equal(otherEnd(P, edges, 5), 0);
  assert.equal(otherEnd(P, edges, 1), -1); // middle of path

  // Branch at 4 -> returns -1
  edges[P.ed[4 * 4 + 2]] = 1;
  assert.equal(otherEnd(P, edges, 0), -1);
});

test('pathcolors keeps colors stable when extending or joining lines', () => {
  const keeper = makeColorKeeper(16);
  const on = new Uint8Array(16);
  on[0] = 1; // path A
  on[6] = 1; // path B
  const roots1 = (x) => (x < 4 ? 0 : 6);
  const c1 = assignPathColors(keeper, on, roots1, 8, null);
  const colA = c1.get(0), colB = c1.get(6);
  assert.notEqual(colA, colB);

  // Extending path A keeps both colors unchanged
  on[2] = 1;
  const c2 = assignPathColors(keeper, on, roots1, 8, null);
  assert.equal(c2.get(0), colA);
  assert.equal(c2.get(6), colB);
});
