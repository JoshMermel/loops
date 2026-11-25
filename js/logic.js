// Masyu: pure logic (no DOM). Used by the browser GUI and by the node tools.
//
// Rules: draw one single closed loop through cell centres orthogonally (no crossings, no branches).
//   * The loop must pass through every circle (white and black).
//   * White circle (W): the loop goes straight through it, and must turn 90° in at least one of the two
//     adjacent cells along the loop.
//   * Black circle (B): the loop turns 90° at it, and must go straight through both adjacent cells along the loop
//     (at least two segments straight in each exit direction).
//
// Coordinates: cell (r, c) has index r*cols + c. Directions: 0=U 1=R 2=D 3=L.
// Edges: edge 2*i is cell i's right edge (i <-> i+1), 2*i+1 is cell i's bottom edge (i <-> i+cols).
// Edge states: 0 unknown, 1 on (loop segment), 2 off (no segment).
// Cell states: 0 unknown, 1 off (not on the loop), 2 loop (on the loop; all circles start as LOOP).

/** Column letters like a spreadsheet: 0 -> A, 25 -> Z, 26 -> AA. */
export function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const DR = [-1, 0, 1, 0];
export const DC = [0, 1, 0, -1];

export const NONE = 0, WHITE = 1, BLACK = 2;
export const UNKNOWN = 0, OFF = 1, LOOP = 2;
export const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;

/**
 * Puzzle = { name, rows, cols, clues: [{ r, c, t: 'W'|'B' }], solution?, rules?, tier?, score? }.
 * compile() attaches the lookup tables every other function uses.
 */
export function compile(p) {
  const { rows, cols } = p;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) {
    throw new Error(`invalid board size ${rows}x${cols}`);
  }
  const N = rows * cols;
  const numEdges = 2 * N;
  const clue = new Uint8Array(N); // 0 none, 1 white, 2 black
  const clueAt = new Int16Array(N).fill(-1);
  const whites = [], blacks = [], clueCells = [];
  if (!Array.isArray(p.clues)) throw new Error('puzzle clues must be an array');
  p.clues.forEach((cl, k) => {
    if (!Number.isInteger(cl.r) || !Number.isInteger(cl.c) || cl.r < 0 || cl.c < 0 || cl.r >= rows || cl.c >= cols) {
      throw new Error(`clue out of bounds at ${cl.r},${cl.c}`);
    }
    const i = cl.r * cols + cl.c;
    if (clueAt[i] >= 0) throw new Error(`two clues on cell ${cl.r},${cl.c}`);
    if (cl.t !== 'W' && cl.t !== 'B') throw new Error(`unknown clue type "${cl.t}" at ${cl.r},${cl.c}`);
    clueAt[i] = k;
    clue[i] = cl.t === 'W' ? WHITE : BLACK;
    clueCells.push(i);
    if (cl.t === 'W') whites.push(i); else blacks.push(i);
  });

  const edgeA = new Int16Array(numEdges).fill(-1);
  const edgeB = new Int16Array(numEdges).fill(-1);
  const nb = new Int16Array(N * 4).fill(-1);
  const ed = new Int16Array(N * 4).fill(-1);
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i % cols;
    for (let d = 0; d < 4; d++) {
      const nr = r + DR[d], nc = c + DC[d];
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const j = nr * cols + nc;
      const x = d === 1 ? 2 * i : d === 2 ? 2 * i + 1 : d === 3 ? 2 * j : 2 * j + 1;
      if (edgeA[x] < 0) { edgeA[x] = Math.min(i, j); edgeB[x] = Math.max(i, j); }
      nb[i * 4 + d] = j;
      ed[i * 4 + d] = x;
    }
  }

  // Two steps away in direction d (for black circles' straight-2 and white circles' turn check)
  const step2 = new Int16Array(N * 4).fill(-1);
  const ed2 = new Int16Array(N * 4).fill(-1);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < 4; d++) {
      const j = nb[i * 4 + d];
      if (j < 0) continue;
      const j2 = nb[j * 4 + d];
      if (j2 >= 0) {
        step2[i * 4 + d] = j2;
        ed2[i * 4 + d] = ed[j * 4 + d];
      }
    }
  }

  return Object.assign(p, {
    N, numEdges, clue, clueAt, clueCells, whites, blacks,
    nb, ed, step2, ed2, edgeA, edgeB,
    _ecOff: null, _ecData: null,
  });
}

export function initialState(P) {
  const cell = new Int8Array(P.N);
  for (const i of P.clueCells) cell[i] = LOOP;
  const e = new Int8Array(P.numEdges);
  // Edges off the board (edgeA < 0) stay 0 and are never referenced via P.ed
  return { cell, e, cycle: false };
}

export function cloneState(st) {
  return { cell: st.cell.slice(), e: st.e.slice(), cycle: st.cycle };
}

/** Endpoints of an edge index, or [-1, -1] if off-board. */
export function edgeCells(P, x) {
  return [P.edgeA[x], P.edgeB[x]];
}

// Reusable scratch buffers for propagate() (never called recursively)
let scratchVis = new Uint8Array(0);
let scratchLoopCells = new Int16Array(0);
let scratchCellQ = new Int16Array(0);
let scratchInCellQ = new Uint8Array(0);
let scratchClueQ = new Int16Array(0);
let scratchInClueQ = new Uint8Array(0);
let scratchQCap = 0;

/** Number of edge assignments or cell=OFF deductions made by the most recent propagate() call. */
export let lastPropChanges = 0;

function ensurePropScratch(N) {
  if (scratchVis.length < N) {
    scratchVis = new Uint8Array(N);
    scratchLoopCells = new Int16Array(N);
    scratchInCellQ = new Uint8Array(N);
    scratchInClueQ = new Uint8Array(N);
  }
  if (scratchQCap <= N) {
    let cap = 64;
    while (cap <= N) cap <<= 1;
    scratchQCap = cap;
    scratchCellQ = new Int16Array(cap);
    scratchClueQ = new Int16Array(cap);
  }
}

/** Lazily build compact CSR table of clues within distance 1 of each edge's endpoints. */
function getEdgeClues(P) {
  if (P._ecData) return P;
  const { numEdges, edgeA, edgeB, nb, clue } = P;
  const off = new Int32Array(numEdges + 1);
  const tmp = [];
  const seen = new Int16Array(10);
  for (let x = 0; x < numEdges; x++) {
    off[x] = tmp.length;
    const a = edgeA[x];
    if (a < 0) continue;
    const b = edgeB[x];
    let nSeen = 0;
    const add = (j) => {
      if (j < 0 || clue[j] === NONE) return;
      for (let k = 0; k < nSeen; k++) if (seen[k] === j) return;
      seen[nSeen++] = j;
      tmp.push(j);
    };
    add(a); add(b);
    const a4 = a * 4, b4 = b * 4;
    add(nb[a4]); add(nb[a4 + 1]); add(nb[a4 + 2]); add(nb[a4 + 3]);
    add(nb[b4]); add(nb[b4 + 1]); add(nb[b4 + 2]); add(nb[b4 + 3]);
  }
  off[numEdges] = tmp.length;
  P._ecOff = off;
  P._ecData = Int16Array.from(tmp);
  return P;
}

/**
 * Sound constraint propagation for the exact solver. Returns false on a contradiction.
 * Does not model a human; human-style rules live in js/rating.js.
 * Optional `seedEdge` / `seedCell` restricts the initial worklist to the local neighborhood
 * of a single newly assigned edge/cell (used by `solve()` after a prior fixed point).
 */
export function propagate(P, st, seedEdge = -1, seedCell = -1) {
  const { N, cols, nb, ed, ed2, edgeA, edgeB, clue, whites, blacks } = P;
  const cell = st.cell, e = st.e;

  ensurePropScratch(N);
  const vis = scratchVis;
  const loopCells = scratchLoopCells;
  const qCell = scratchCellQ, inCellQ = scratchInCellQ;
  const qClue = scratchClueQ, inClueQ = scratchInClueQ;
  const qMask = scratchQCap - 1;
  let cHead = 0, cTail = 0;
  let kHead = 0, kTail = 0;
  let ok = true;
  let needLoopCheck = false;
  let changes = 0;

  if (!P._ecData) getEdgeClues(P);
  const ecOff = P._ecOff, ecData = P._ecData;

  const pushCell = (i) => {
    if (!inCellQ[i]) {
      inCellQ[i] = 1;
      qCell[cTail] = i;
      cTail = (cTail + 1) & qMask;
    }
  };
  const pushClue = (i) => {
    if (!inClueQ[i]) {
      inClueQ[i] = 1;
      qClue[kTail] = i;
      kTail = (kTail + 1) & qMask;
    }
  };
  const wakeEdge = (x) => {
    const a = edgeA[x];
    if (a < 0) return;
    pushCell(a);
    pushCell(edgeB[x]);
    const end = ecOff[x + 1];
    for (let k = ecOff[x]; k < end; k++) pushClue(ecData[k]);
  };

  const setCell = (i, v) => {
    const cur = cell[i];
    if (cur === v) return;
    if (cur !== UNKNOWN) { ok = false; return; }
    cell[i] = v;
    if (v === LOOP) needLoopCheck = true;
    else changes++;
    pushCell(i);
  };
  const setEdge = (x, v) => {
    if (x < 0) { if (v === E_ON) ok = false; return; }
    const cur = e[x];
    if (cur === v) return;
    if (cur !== E_UNKNOWN) { ok = false; return; }
    e[x] = v;
    changes++;
    if (v === E_ON) needLoopCheck = true;
    wakeEdge(x);
  };

  if (seedEdge >= 0) {
    if (e[seedEdge] === E_ON) needLoopCheck = true;
    wakeEdge(seedEdge);
  } else if (seedCell >= 0) {
    if (cell[seedCell] === LOOP) needLoopCheck = true;
    pushCell(seedCell);
  } else {
    needLoopCheck = true;
    for (let i = 0; i < N; i++) pushCell(i);
    for (let wi = 0; wi < whites.length; wi++) pushClue(whites[wi]);
    for (let bi = 0; bi < blacks.length; bi++) pushClue(blacks[bi]);
  }

  while (ok) {
    // Inner local fixed-point worklist (Steps 1-4): only revisits cells/clues whose neighborhood changed.
    while (ok && (cHead !== cTail || kHead !== kTail)) {
      while (ok && cHead !== cTail) {
        const i = qCell[cHead];
        cHead = (cHead + 1) & qMask;
        inCellQ[i] = 0;

        const s = cell[i];
        const i4 = i * 4;
        if (s === OFF) {
          if (clue[i] !== NONE) { ok = false; break; }
          const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
          if (x0 >= 0 && e[x0] !== E_OFF) setEdge(x0, E_OFF);
          if (x1 >= 0 && e[x1] !== E_OFF) setEdge(x1, E_OFF);
          if (x2 >= 0 && e[x2] !== E_OFF) setEdge(x2, E_OFF);
          if (x3 >= 0 && e[x3] !== E_OFF) setEdge(x3, E_OFF);
          continue;
        }
        let on = 0, unk = 0;
        const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
        if (x0 >= 0) { const v = e[x0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x1 >= 0) { const v = e[x1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x2 >= 0) { const v = e[x2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (x3 >= 0) { const v = e[x3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
        if (on > 2) { ok = false; break; }
        if (s === UNKNOWN) {
          if (on >= 1) setCell(i, LOOP);
          else if (unk < 2) setCell(i, OFF);
          continue;
        }
        // s === LOOP
        if (on + unk < 2) { ok = false; break; }
        if (unk > 0) {
          if (on === 2) {
            if (x0 >= 0 && e[x0] === E_UNKNOWN) setEdge(x0, E_OFF);
            if (x1 >= 0 && e[x1] === E_UNKNOWN) setEdge(x1, E_OFF);
            if (x2 >= 0 && e[x2] === E_UNKNOWN) setEdge(x2, E_OFF);
            if (x3 >= 0 && e[x3] === E_UNKNOWN) setEdge(x3, E_OFF);
          } else if (on + unk === 2) {
            if (x0 >= 0 && e[x0] === E_UNKNOWN) setEdge(x0, E_ON);
            if (x1 >= 0 && e[x1] === E_UNKNOWN) setEdge(x1, E_ON);
            if (x2 >= 0 && e[x2] === E_UNKNOWN) setEdge(x2, E_ON);
            if (x3 >= 0 && e[x3] === E_UNKNOWN) setEdge(x3, E_ON);
          }
        }
      }
      if (!ok) break;

      while (ok && kHead !== kTail) {
        const i = qClue[kHead];
        kHead = (kHead + 1) & qMask;
        inClueQ[i] = 0;

        const i4 = i * 4;
        if (clue[i] === WHITE) {
          // 3. White circles: straight through, turn at >= 1 end
          const u = ed[i4], r = ed[i4 + 1], dn = ed[i4 + 2], l = ed[i4 + 3];
          const u2 = ed2[i4], r2 = ed2[i4 + 1], d2 = ed2[i4 + 2], l2 = ed2[i4 + 3];

          let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
          let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
          if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
          if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
          if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
          if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;

          if (!vOk && !hOk) { ok = false; break; }
          if (!vOk) {
            setEdge(r, E_ON); setEdge(l, E_ON);
            if (u >= 0) setEdge(u, E_OFF);
            if (dn >= 0) setEdge(dn, E_OFF);
            if (r2 >= 0 && e[r2] === E_ON && l2 >= 0) setEdge(l2, E_OFF);
            if (l2 >= 0 && e[l2] === E_ON && r2 >= 0) setEdge(r2, E_OFF);
          } else if (!hOk) {
            setEdge(u, E_ON); setEdge(dn, E_ON);
            if (r >= 0) setEdge(r, E_OFF);
            if (l >= 0) setEdge(l, E_OFF);
            if (u2 >= 0 && e[u2] === E_ON && d2 >= 0) setEdge(d2, E_OFF);
            if (d2 >= 0 && e[d2] === E_ON && u2 >= 0) setEdge(u2, E_OFF);
          }
        } else {
          // 4. Black circles: turn 90° and go straight 2 steps in each chosen direction
          const eu = ed[i4], er = ed[i4 + 1], edown = ed[i4 + 2], el = ed[i4 + 3];
          const eu2 = ed2[i4], er2 = ed2[i4 + 1], ed2v = ed2[i4 + 2], el2 = ed2[i4 + 3];

          let can0 = eu >= 0 && eu2 >= 0 && e[eu] !== E_OFF && e[eu2] !== E_OFF;
          if (can0) {
            const n1 = nb[i4];
            if (clue[n1] === BLACK) can0 = false;
            else {
              const p1 = ed[n1 * 4 + 1], p2 = ed[n1 * 4 + 3];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can0 = false;
            }
          }
          let can2 = edown >= 0 && ed2v >= 0 && e[edown] !== E_OFF && e[ed2v] !== E_OFF;
          if (can2) {
            const n1 = nb[i4 + 2];
            if (clue[n1] === BLACK) can2 = false;
            else {
              const p1 = ed[n1 * 4 + 3], p2 = ed[n1 * 4 + 1];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can2 = false;
            }
          }
          if (!can0 && !can2) { ok = false; break; }
          if (!can0) {
            if (eu >= 0) setEdge(eu, E_OFF);
            setEdge(edown, E_ON); setEdge(ed2v, E_ON);
          } else if (!can2) {
            if (edown >= 0) setEdge(edown, E_OFF);
            setEdge(eu, E_ON); setEdge(eu2, E_ON);
          } else if (e[eu] === E_ON) {
            setEdge(edown, E_OFF); setEdge(eu2, E_ON);
          } else if (e[edown] === E_ON) {
            setEdge(eu, E_OFF); setEdge(ed2v, E_ON);
          }
          if (!ok) break;

          let can1 = er >= 0 && er2 >= 0 && e[er] !== E_OFF && e[er2] !== E_OFF;
          if (can1) {
            const n1 = nb[i4 + 1];
            if (clue[n1] === BLACK) can1 = false;
            else {
              const p1 = ed[n1 * 4 + 2], p2 = ed[n1 * 4 + 0];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can1 = false;
            }
          }
          let can3 = el >= 0 && el2 >= 0 && e[el] !== E_OFF && e[el2] !== E_OFF;
          if (can3) {
            const n1 = nb[i4 + 3];
            if (clue[n1] === BLACK) can3 = false;
            else {
              const p1 = ed[n1 * 4 + 0], p2 = ed[n1 * 4 + 2];
              if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can3 = false;
            }
          }
          if (!can1 && !can3) { ok = false; break; }
          if (!can1) {
            if (er >= 0) setEdge(er, E_OFF);
            setEdge(el, E_ON); setEdge(el2, E_ON);
          } else if (!can3) {
            if (el >= 0) setEdge(el, E_OFF);
            setEdge(er, E_ON); setEdge(er2, E_ON);
          } else if (e[er] === E_ON) {
            setEdge(el, E_OFF); setEdge(er2, E_ON);
          } else if (e[el] === E_ON) {
            setEdge(er, E_OFF); setEdge(el2, E_ON);
          }
        }
      }
    }
    if (!ok || !needLoopCheck) break;
    needLoopCheck = false;

    // 5. Single closed loop constraint via direct path/cycle tracing over LOOP cells (degOn <= 2 everywhere).
    // Replaces O(N + 2E) union-find + full unknown-edge scan with one trace over LOOP cells.
    let loopCount = 0;
    for (let i = 0; i < N; i++) {
      if (cell[i] === LOOP) {
        loopCells[loopCount++] = i;
        vis[i] = 0;
      }
    }

    let cycLen = 0, cycCount = 0;
    for (let li = 0; li < loopCount; li++) {
      const u = loopCells[li];
      if (vis[u]) continue;
      const u4 = u * 4;
      let next1 = -1, next2 = -1;
      let x = ed[u4]; if (x >= 0 && e[x] === E_ON) next1 = nb[u4];
      x = ed[u4 + 1]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 1]; else next2 = nb[u4 + 1]; }
      x = ed[u4 + 2]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 2]; else next2 = nb[u4 + 2]; }
      x = ed[u4 + 3]; if (x >= 0 && e[x] === E_ON) { if (next1 < 0) next1 = nb[u4 + 3]; else next2 = nb[u4 + 3]; }

      if (next1 < 0) { vis[u] = 1; continue; } // isolated LOOP cell (degOn === 0)
      if (next2 >= 0) continue; // interior of a path or cycle (wait until second pass for pure cycles)

      // Open path starting at degOn === 1 endpoint `u`: walk to far endpoint `cur`
      vis[u] = 1;
      let prev = u, cur = next1, len = 2;
      for (;;) {
        vis[cur] = 1;
        const c4 = cur * 4;
        let nxt = -1;
        x = ed[c4]; if (x >= 0 && e[x] === E_ON && nb[c4] !== prev) nxt = nb[c4];
        else { x = ed[c4 + 1]; if (x >= 0 && e[x] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
        else { x = ed[c4 + 2]; if (x >= 0 && e[x] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
        else { x = ed[c4 + 3]; if (x >= 0 && e[x] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3]; } } }
        if (nxt < 0) break;
        prev = cur; cur = nxt; len++;
      }
      if (len >= 4 && len < loopCount) {
        const diff = u > cur ? u - cur : cur - u;
        if (diff === 1 || diff === cols) {
          for (let d = 0; d < 4; d++) {
            if (nb[u4 + d] === cur) {
              const ex = ed[u4 + d];
              if (e[ex] === E_UNKNOWN) setEdge(ex, E_OFF);
              break;
            }
          }
        }
      }
    }

    // Any remaining unvisited LOOP cell with degOn === 2 belongs to a closed cycle
    for (let li = 0; li < loopCount && ok; li++) {
      const start = loopCells[li];
      if (vis[start]) continue;
      cycCount++;
      if (cycCount > 1) { ok = false; break; }
      vis[start] = 2;
      const s4 = start * 4;
      let cur = -1;
      let x = ed[s4]; if (x >= 0 && e[x] === E_ON) cur = nb[s4];
      else { x = ed[s4 + 1]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 1];
      else { x = ed[s4 + 2]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 2];
      else { x = ed[s4 + 3]; if (x >= 0 && e[x] === E_ON) cur = nb[s4 + 3]; } } }
      let prev = start, len = 1;
      while (cur >= 0 && cur !== start) {
        vis[cur] = 2;
        len++;
        const c4 = cur * 4;
        let nxt = -1;
        x = ed[c4]; if (x >= 0 && e[x] === E_ON && nb[c4] !== prev) nxt = nb[c4];
        else { x = ed[c4 + 1]; if (x >= 0 && e[x] === E_ON && nb[c4 + 1] !== prev) nxt = nb[c4 + 1];
        else { x = ed[c4 + 2]; if (x >= 0 && e[x] === E_ON && nb[c4 + 2] !== prev) nxt = nb[c4 + 2];
        else { x = ed[c4 + 3]; if (x >= 0 && e[x] === E_ON && nb[c4 + 3] !== prev) nxt = nb[c4 + 3]; } } }
        prev = cur; cur = nxt;
      }
      cycLen = len;
    }
    if (!ok) break;

    if (cycCount === 1) {
      if (cycLen < loopCount) { ok = false; break; }
      for (let i = 0; i < N; i++) {
        if (cell[i] === UNKNOWN) setCell(i, OFF);
      }
      st.cycle = true;
    } else {
      st.cycle = false;
    }
    if (cHead === cTail && kHead === kTail) break;
  }

  // O(touched) cleanup of queued flags on early contradiction exit
  while (cHead !== cTail) { inCellQ[qCell[cHead]] = 0; cHead = (cHead + 1) & qMask; }
  while (kHead !== kTail) { inClueQ[qClue[kHead]] = 0; kHead = (kHead + 1) & qMask; }
  lastPropChanges = changes;
  return ok;
}

/**
 * Count solutions (up to `limit`) by propagation + backtracking search.
 * Returns { count, solutions: [state], exceeded, nodes }.
 * An `exceeded` result means `maxNodes` was hit and `count` is only a lower bound — never proof of uniqueness.
 */
export function solve(P, { limit = 2, state = null, maxNodes = Infinity, rng = null } = {}) {
  const { N, ed, clue } = P;
  const solutions = [];
  let nodes = 0, exceeded = false;

  const dfs = (st, seedEdge, seedCell) => {
    if (solutions.length >= limit || exceeded) return;
    if (++nodes > maxNodes) { exceeded = true; return; }
    if (!propagate(P, st, seedEdge, seedCell)) return;

    const cell = st.cell, e = st.e;
    // Pick a LOOP cell that still has undecided edges:
    // Prefer open ends (on === 1) with fewest choices, then circles with on === 0, then any LOOP cell.
    let bi = -1, bestKey = -1;
    const ties = rng ? [] : null;
    for (let i = 0; i < N; i++) {
      if (cell[i] !== LOOP) continue;
      const i4 = i * 4;
      let on = 0, unk = 0;
      const x0 = ed[i4], x1 = ed[i4 + 1], x2 = ed[i4 + 2], x3 = ed[i4 + 3];
      if (x0 >= 0) { const v = e[x0]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x1 >= 0) { const v = e[x1]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x2 >= 0) { const v = e[x2]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (x3 >= 0) { const v = e[x3]; if (v === E_ON) on++; else if (v === E_UNKNOWN) unk++; }
      if (unk === 0) continue;
      const isClue = clue[i] !== NONE ? 1 : 0;
      const key = on * 100 + isClue * 10 + (4 - unk);
      if (ties) {
        if (key > bestKey) { bestKey = key; ties.length = 0; }
        if (key === bestKey) ties.push(i);
      } else if (key > bestKey) {
        bestKey = key; bi = i;
        if (key === 112) break; // maximum possible priority after propagate() (on=1, isClue=1, unk=2)
      }
    }
    if (ties && ties.length) bi = ties[(rng() * ties.length) | 0];

    if (bi >= 0) {
      let x = -1;
      const b4 = bi * 4;
      if (rng) {
        const open = [];
        for (let d = 0; d < 4; d++) {
          const y = ed[b4 + d];
          if (y >= 0 && e[y] === E_UNKNOWN) open.push(y);
        }
        x = open[(rng() * open.length) | 0];
      } else {
        for (let d = 0; d < 4; d++) {
          const y = ed[b4 + d];
          if (y >= 0 && e[y] === E_UNKNOWN) { x = y; break; }
        }
      }
      const onFirst = rng ? rng() < 0.5 : true;
      const v0 = onFirst ? E_ON : E_OFF;
      const v1 = onFirst ? E_OFF : E_ON;
      const a = cloneState(st);
      a.e[x] = v0;
      dfs(a, x, -1);
      if (solutions.length >= limit || exceeded) return;
      st.e[x] = v1;
      dfs(st, x, -1);
      return;
    }

    // If a cycle is already closed covering all LOOP cells, propagate() finished the board.
    if (st.cycle) {
      solutions.push(st);
      return;
    }

    // Only reachable if there are 0 LOOP cells (e.g., a puzzle with no circles at all):
    // branch on an UNKNOWN cell being LOOP or OFF.
    let ci = -1;
    if (rng) {
      const unknown = [];
      for (let i = 0; i < N; i++) if (cell[i] === UNKNOWN) unknown.push(i);
      if (unknown.length) ci = unknown[(rng() * unknown.length) | 0];
    } else {
      for (let i = 0; i < N; i++) if (cell[i] === UNKNOWN) { ci = i; break; }
    }
    if (ci >= 0) {
      const loopFirst = rng ? rng() < 0.5 : true;
      const v0 = loopFirst ? LOOP : OFF;
      const v1 = loopFirst ? OFF : LOOP;
      const a = cloneState(st);
      a.cell[ci] = v0;
      dfs(a, -1, ci);
      if (solutions.length >= limit || exceeded) return;
      st.cell[ci] = v1;
      dfs(st, -1, ci);
    }
  };

  dfs(state ? cloneState(state) : initialState(P), -1, -1);
  return { count: solutions.length, solutions, exceeded, nodes };
}

/**
 * Encode a solved state as a string of length N:
 * a hex digit of the loop cell's exits (U=1, R=2, D=4, L=8), or '#' if not on the loop.
 */
export function encodeSolution(P, st) {
  let s = '';
  for (let i = 0; i < P.N; i++) {
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_ON) m |= 1 << d;
    }
    s += m ? m.toString(16) : '#';
  }
  return s;
}

/** Decode a solution string back into a complete state { cell, e, cycle }. */
export function decodeSolution(P, str) {
  const st = initialState(P);
  st.cell.fill(OFF);
  st.e.fill(E_OFF);
  if (typeof str !== 'string') return st;
  const lim = Math.min(P.N, str.length);
  for (let i = 0; i < lim; i++) {
    const ch = str[i];
    if (!ch || ch === '#') continue;
    const m = parseInt(ch, 16);
    if (!Number.isFinite(m)) continue;
    st.cell[i] = LOOP;
    for (let d = 0; d < 4; d++) {
      if (m & (1 << d)) {
        const x = P.ed[i * 4 + d];
        if (x >= 0) st.e[x] = E_ON;
      }
    }
  }
  st.cycle = true;
  return st;
}

/**
 * Independent solution checker: returns true iff `edges` (Int8Array/Uint8Array where 1 = E_ON)
 * forms a valid complete Masyu solution for compiled puzzle `P`.
 * Never looks at P.solution; any valid solution counts.
 */
export function isSolved(P, edges) {
  const { N, numEdges, ed, nb, edgeA, edgeB, whites, blacks, clueCells } = P;
  const deg = new Int8Array(N);
  for (let x = 0; x < numEdges; x++) {
    if (edges[x] !== E_ON) continue;
    const a = edgeA[x], b = edgeB[x];
    if (a < 0) return false; // off-board edge marked on
    deg[a]++;
    deg[b]++;
  }

  let loopCells = 0, start = -1;
  for (let i = 0; i < N; i++) {
    if (deg[i] !== 0 && deg[i] !== 2) return false;
    if (deg[i] === 2) { loopCells++; if (start < 0) start = i; }
  }
  if (loopCells < 4) return false;

  // Every circle must be on the loop
  for (const i of clueCells) if (deg[i] !== 2) return false;

  // Must be a single closed cycle visiting every loop cell
  let prev = -1, cur = start, steps = 0;
  do {
    let next = -1;
    for (let d = 0; d < 4; d++) {
      const x = ed[cur * 4 + d];
      if (x >= 0 && edges[x] === E_ON) {
        const j = nb[cur * 4 + d];
        if (j !== prev) { next = j; break; }
      }
    }
    if (next < 0) return false;
    prev = cur; cur = next; steps++;
  } while (cur !== start && steps <= N);
  if (steps !== loopCells) return false;

  // White circles: go straight through and turn at least one adjacent cell along the loop
  for (const i of whites) {
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    const vert = u >= 0 && dn >= 0 && edges[u] === E_ON && edges[dn] === E_ON;
    const horiz = r >= 0 && l >= 0 && edges[r] === E_ON && edges[l] === E_ON;
    if (!vert && !horiz) return false;
    const d1 = vert ? 0 : 1, d2 = d1 ^ 2;
    const ext1 = P.ed2[i * 4 + d1], ext2 = P.ed2[i * 4 + d2];
    const straight1 = ext1 >= 0 && edges[ext1] === E_ON;
    const straight2 = ext2 >= 0 && edges[ext2] === E_ON;
    if (straight1 && straight2) return false;
  }

  // Black circles: turn 90° at the circle and go straight through both adjacent cells
  for (const i of blacks) {
    const dirs = [];
    for (let d = 0; d < 4; d++) {
      const x = ed[i * 4 + d];
      if (x >= 0 && edges[x] === E_ON) dirs.push(d);
    }
    if (dirs.length !== 2) return false;
    if (((dirs[0] ^ dirs[1]) & 1) === 0) return false; // must be perpendicular (turn 90°)
    for (const d of dirs) {
      const ext = P.ed2[i * 4 + d];
      if (ext < 0 || edges[ext] !== E_ON) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------- CSV

export const CSV_HEADER = 'name,rows,cols,clues,solution,rules,tier,score';

/** Serialize clues as `row:col:W|B` joined by `;`. */
export function cluesToString(clues) {
  return (clues || []).map((c) => `${c.r}:${c.c}:${c.t}`).join(';');
}

export function cluesFromString(s) {
  if (!s) return [];
  return s.split(';').map((tok) => {
    const parts = tok.split(':');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || (parts[2] !== 'W' && parts[2] !== 'B')) {
      throw new Error(`bad clue "${tok}"`);
    }
    return { r: +parts[0], c: +parts[1], t: parts[2] };
  });
}

export function toCsvRow(p) {
  return [
    p.name, p.rows, p.cols, cluesToString(p.clues),
    p.solution || '', p.rules || '', p.tier || '', p.score ?? '',
  ].join(',');
}

export function toCsv(puzzles) {
  return [CSV_HEADER, ...puzzles.map(toCsvRow)].join('\n') + '\n';
}

export function parseCsv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('name,')) continue;
    const [name, rows, cols, clues, solution, rules, tier, score] = t.split(',');
    out.push({
      name,
      rows: +rows,
      cols: +cols,
      clues: cluesFromString(clues),
      solution: solution || '',
      rules: rules || '',
      tier: tier || '',
      score: score === undefined || score === '' ? null : +score,
    });
  }
  return out;
}

/**
 * Canonical symmetry key across all 8 dihedral symmetries (rotations & reflections).
 * Used to deduplicate books so a pool never ships the same puzzle in two orientations.
 */
export function symmetryKey(p) {
  const { rows, cols } = p;
  let best = null;
  for (let t = 0; t < 8; t++) {
    const swap = t & 1, flipR = t & 2, flipC = t & 4;
    const R = swap ? cols : rows, C = swap ? rows : cols;
    const items = p.clues.map((cl) => {
      let r = cl.r, c = cl.c;
      if (swap) [r, c] = [c, r];
      if (flipR) r = R - 1 - r;
      if (flipC) c = C - 1 - c;
      return [r * C + c, `${r}:${c}:${cl.t}`];
    }).sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(';');
    const key = `${R}x${C}|${items}`;
    if (best === null || key < best) best = key;
  }
  return best;
}

/** Orientation-specific short stable hash of size + clues, for localStorage save keys. */
export function puzzleHash(p) {
  if (p.hashKey) return p.hashKey;
  const sorted = [...p.clues].sort((a, b) => (a.r * p.cols + a.c) - (b.r * p.cols + b.c));
  const s = `${p.rows}x${p.cols}|${cluesToString(sorted)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
