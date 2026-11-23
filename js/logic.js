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
export const oppositeDir = (d) => d ^ 2;
export const turnDir = (d) => (d + 1) & 3;
export const perpDirs = (d) => [(d + 1) & 3, (d + 3) & 3];

export const NONE = 0, WHITE = 1, BLACK = 2;
export const UNKNOWN = 0, OFF = 1, LOOP = 2;
export const E_UNKNOWN = 0, E_ON = 1, E_OFF = 2;

/**
 * Puzzle = { name, rows, cols, clues: [{ r, c, t: 'W'|'B' }], solution?, rules?, tier?, score? }.
 * compile() attaches the lookup tables every other function uses.
 */
export function compile(p) {
  const { rows, cols } = p;
  const N = rows * cols;
  const numEdges = 2 * N;
  const clue = new Uint8Array(N); // 0 none, 1 white, 2 black
  const clueAt = new Int16Array(N).fill(-1);
  const whites = [], blacks = [], clueCells = [];
  p.clues.forEach((cl, k) => {
    if (cl.r < 0 || cl.c < 0 || cl.r >= rows || cl.c >= cols) throw new Error(`clue out of bounds at ${cl.r},${cl.c}`);
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
    N, K: 4, numEdges, clue, clueAt, clueCells, whites, blacks,
    nb, ed, step2, ed2, edgeA, edgeB,
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

// Reusable union-find scratch buffers for propagate() (never called recursively)
let scratchParent = new Int16Array(0);
let scratchSize = new Int32Array(0);

/**
 * Sound constraint propagation for the exact solver. Returns false on a contradiction.
 * Does not model a human; human-style rules live in js/rating.js.
 */
export function propagate(P, st) {
  const { N, numEdges, nb, ed, ed2, step2, edgeA, edgeB, clue, whites, blacks } = P;
  const cell = st.cell, e = st.e;
  let changed = true;
  let ok = true;

  const setCell = (i, v) => {
    if (cell[i] === v) return;
    if (cell[i] !== UNKNOWN) { ok = false; return; }
    cell[i] = v;
    changed = true;
  };
  const setEdge = (x, v) => {
    if (x < 0) { if (v === E_ON) ok = false; return; }
    if (e[x] === v) return;
    if (e[x] !== E_UNKNOWN) { ok = false; return; }
    e[x] = v;
    changed = true;
  };

  if (scratchParent.length < N) {
    scratchParent = new Int16Array(N);
    scratchSize = new Int32Array(N);
  }
  const parent = scratchParent, size = scratchSize;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };

  while (changed && ok) {
    changed = false;

    // 1. Edge -> cell consistency
    for (let x = 0; x < numEdges && ok; x++) {
      if (e[x] === E_ON) {
        setCell(edgeA[x], LOOP);
        setCell(edgeB[x], LOOP);
      }
    }
    if (!ok) break;

    // 2. Cell degree / OFF / LOOP consistency
    for (let i = 0; i < N && ok; i++) {
      const s = cell[i];
      if (s === OFF) {
        if (clue[i] !== NONE) { ok = false; break; }
        for (let d = 0; d < 4; d++) {
          const x = ed[i * 4 + d];
          if (x >= 0) setEdge(x, E_OFF);
        }
        continue;
      }
      let on = 0, unk = 0;
      for (let d = 0; d < 4; d++) {
        const x = ed[i * 4 + d];
        if (x < 0) continue;
        const v = e[x];
        if (v === E_ON) on++;
        else if (v === E_UNKNOWN) unk++;
      }
      if (on > 2) { ok = false; break; }
      if (s === UNKNOWN) {
        if (on >= 1) setCell(i, LOOP);
        else if (unk < 2) setCell(i, OFF);
        continue;
      }
      // s === LOOP
      if (on + unk < 2) { ok = false; break; }
      if (on === 2 && unk > 0) {
        for (let d = 0; d < 4; d++) {
          const x = ed[i * 4 + d];
          if (x >= 0 && e[x] === E_UNKNOWN) setEdge(x, E_OFF);
        }
      } else if (on + unk === 2 && unk > 0) {
        for (let d = 0; d < 4; d++) {
          const x = ed[i * 4 + d];
          if (x >= 0 && e[x] === E_UNKNOWN) setEdge(x, E_ON);
        }
      }
    }
    if (!ok) break;

    // 3. White circles: straight through, turn at >= 1 end
    for (let wi = 0; wi < whites.length && ok; wi++) {
      const i = whites[wi];
      const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
      const u2 = ed2[i * 4 + 0], r2 = ed2[i * 4 + 1], d2 = ed2[i * 4 + 2], l2 = ed2[i * 4 + 3];

      let vOk = u >= 0 && dn >= 0 && e[u] !== E_OFF && e[dn] !== E_OFF;
      let hOk = r >= 0 && l >= 0 && e[r] !== E_OFF && e[l] !== E_OFF;
      // Cannot go straight along an axis if both ends already continue straight
      if (vOk && u2 >= 0 && e[u2] === E_ON && d2 >= 0 && e[d2] === E_ON) vOk = false;
      if (hOk && r2 >= 0 && e[r2] === E_ON && l2 >= 0 && e[l2] === E_ON) hOk = false;
      // If one perpendicular edge is already ON, the other axis is impossible
      if ((r >= 0 && e[r] === E_ON) || (l >= 0 && e[l] === E_ON)) vOk = false;
      if ((u >= 0 && e[u] === E_ON) || (dn >= 0 && e[dn] === E_ON)) hOk = false;

      if (!vOk && !hOk) { ok = false; break; }
      if (!vOk) {
        setEdge(r, E_ON); setEdge(l, E_ON);
        if (u >= 0) setEdge(u, E_OFF);
        if (dn >= 0) setEdge(dn, E_OFF);
        // Must turn at least one end along horizontal axis
        if (r2 >= 0 && e[r2] === E_ON && l2 >= 0) setEdge(l2, E_OFF);
        if (l2 >= 0 && e[l2] === E_ON && r2 >= 0) setEdge(r2, E_OFF);
      } else if (!hOk) {
        setEdge(u, E_ON); setEdge(dn, E_ON);
        if (r >= 0) setEdge(r, E_OFF);
        if (l >= 0) setEdge(l, E_OFF);
        // Must turn at least one end along vertical axis
        if (u2 >= 0 && e[u2] === E_ON && d2 >= 0) setEdge(d2, E_OFF);
        if (d2 >= 0 && e[d2] === E_ON && u2 >= 0) setEdge(u2, E_OFF);
      }
    }
    if (!ok) break;

    // 4. Black circles: turn 90° and go straight 2 steps in each chosen direction
    for (let bi = 0; bi < blacks.length && ok; bi++) {
      const i = blacks[bi];
      // Check each of the 4 directions for feasibility
      let can0 = true, can1 = true, can2 = true, can3 = true;
      for (let d = 0; d < 4; d++) {
        const x1 = ed[i * 4 + d];
        const x2 = ed2[i * 4 + d];
        const n1 = nb[i * 4 + d];
        let can = x1 >= 0 && x2 >= 0 && e[x1] !== E_OFF && e[x2] !== E_OFF;
        if (can) {
          // n1 cannot be a black circle (loop must go straight through n1)
          if (clue[n1] === BLACK) can = false;
          // n1 cannot have a perpendicular edge ON (would force degree >= 3)
          else {
            const p1 = ed[n1 * 4 + ((d + 1) & 3)], p2 = ed[n1 * 4 + ((d + 3) & 3)];
            if ((p1 >= 0 && e[p1] === E_ON) || (p2 >= 0 && e[p2] === E_ON)) can = false;
          }
        }
        if (d === 0) can0 = can; else if (d === 1) can1 = can; else if (d === 2) can2 = can; else can3 = can;
      }

      // Vertical axis: exactly one of U(0), D(2)
      const eu = ed[i * 4 + 0], edown = ed[i * 4 + 2];
      if (!can0 && !can2) { ok = false; break; }
      if (!can0) {
        if (eu >= 0) setEdge(eu, E_OFF);
        setEdge(edown, E_ON); setEdge(ed2[i * 4 + 2], E_ON);
      } else if (!can2) {
        if (edown >= 0) setEdge(edown, E_OFF);
        setEdge(eu, E_ON); setEdge(ed2[i * 4 + 0], E_ON);
      } else if (e[eu] === E_ON) {
        setEdge(edown, E_OFF); setEdge(ed2[i * 4 + 0], E_ON);
      } else if (e[edown] === E_ON) {
        setEdge(eu, E_OFF); setEdge(ed2[i * 4 + 2], E_ON);
      }
      if (!ok) break;

      // Horizontal axis: exactly one of R(1), L(3)
      const er = ed[i * 4 + 1], el = ed[i * 4 + 3];
      if (!can1 && !can3) { ok = false; break; }
      if (!can1) {
        if (er >= 0) setEdge(er, E_OFF);
        setEdge(el, E_ON); setEdge(ed2[i * 4 + 3], E_ON);
      } else if (!can3) {
        if (el >= 0) setEdge(el, E_OFF);
        setEdge(er, E_ON); setEdge(ed2[i * 4 + 1], E_ON);
      } else if (e[er] === E_ON) {
        setEdge(el, E_OFF); setEdge(ed2[i * 4 + 1], E_ON);
      } else if (e[el] === E_ON) {
        setEdge(er, E_OFF); setEdge(ed2[i * 4 + 3], E_ON);
      }
    }
    if (!ok) break;

    // 5. Single closed loop constraint
    for (let i = 0; i < N; i++) parent[i] = i;
    let cycleRoot = -1, cycleCount = 0;
    for (let x = 0; x < numEdges; x++) {
      if (e[x] !== E_ON) continue;
      const ra = find(edgeA[x]), rb = find(edgeB[x]);
      if (ra === rb) { cycleRoot = ra; cycleCount++; }
      else parent[ra] = rb;
    }
    if (cycleCount > 1) { ok = false; break; }

    let loopCount = 0;
    for (let i = 0; i < N; i++) if (cell[i] === LOOP) loopCount++;

    if (cycleRoot >= 0) {
      cycleRoot = find(cycleRoot);
      for (let i = 0; i < N; i++) {
        if (find(i) === cycleRoot) continue;
        if (cell[i] === LOOP) { ok = false; break; }
        if (cell[i] === UNKNOWN) setCell(i, OFF);
      }
      st.cycle = true;
    } else {
      st.cycle = false;
      size.fill(0, 0, N);
      for (let i = 0; i < N; i++) if (cell[i] === LOOP) size[find(i)]++;
      for (let x = 0; x < numEdges; x++) {
        if (e[x] !== E_UNKNOWN) continue;
        const a = edgeA[x], b = edgeB[x];
        if (a < 0) continue;
        const ra = find(a);
        if (ra === find(b) && size[ra] < loopCount) setEdge(x, E_OFF);
      }
    }
  }
  return ok;
}

/**
 * Count solutions (up to `limit`) by propagation + backtracking search.
 * Returns { count, solutions: [state], exceeded, nodes }.
 * An `exceeded` result means `maxNodes` was hit and `count` is only a lower bound — never proof of uniqueness.
 */
export function solve(P, { limit = 2, state = null, maxNodes = Infinity, rng = null } = {}) {
  const solutions = [];
  let nodes = 0, exceeded = false;

  const dfs = (st) => {
    if (solutions.length >= limit || exceeded) return;
    if (++nodes > maxNodes) { exceeded = true; return; }
    if (!propagate(P, st)) return;

    // Pick a LOOP cell that still has undecided edges:
    // Prefer open ends (on === 1) with fewest choices, then circles with on === 0, then any LOOP cell.
    let bi = -1, bestKey = -1;
    const ties = [];
    for (let i = 0; i < P.N; i++) {
      if (st.cell[i] !== LOOP) continue;
      let on = 0, unk = 0;
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d];
        if (x < 0) continue;
        if (st.e[x] === E_ON) on++;
        else if (st.e[x] === E_UNKNOWN) unk++;
      }
      if (unk === 0) continue;
      // Priority score (higher is picked first):
      // on===1 beats on===0; among same on, circles beat non-circles, fewer unk beats more unk.
      const isClue = P.clue[i] !== NONE ? 1 : 0;
      const key = on * 100 + isClue * 10 + (4 - unk);
      if (rng) {
        if (key > bestKey) { bestKey = key; ties.length = 0; }
        if (key === bestKey) ties.push(i);
      } else if (key > bestKey) {
        bestKey = key; bi = i;
      }
    }
    if (rng && ties.length) bi = ties[(rng() * ties.length) | 0];

    if (bi >= 0) {
      const open = [];
      for (let d = 0; d < 4; d++) {
        const y = P.ed[bi * 4 + d];
        if (y >= 0 && st.e[y] === E_UNKNOWN) open.push(y);
      }
      const x = rng ? open[(rng() * open.length) | 0] : open[0];
      const onFirst = rng ? rng() < 0.5 : true;
      for (const v of onFirst ? [E_ON, E_OFF] : [E_OFF, E_ON]) {
        const a = cloneState(st);
        a.e[x] = v;
        dfs(a);
        if (solutions.length >= limit || exceeded) return;
      }
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
      for (let i = 0; i < P.N; i++) if (st.cell[i] === UNKNOWN) unknown.push(i);
      if (unknown.length) ci = unknown[(rng() * unknown.length) | 0];
    } else {
      for (let i = 0; i < P.N; i++) if (st.cell[i] === UNKNOWN) { ci = i; break; }
    }
    if (ci >= 0) {
      const loopFirst = rng ? rng() < 0.5 : true;
      for (const v of loopFirst ? [LOOP, OFF] : [OFF, LOOP]) {
        const a = cloneState(st);
        a.cell[ci] = v;
        dfs(a);
        if (solutions.length >= limit || exceeded) return;
      }
    }
  };

  dfs(state ? cloneState(state) : initialState(P));
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
  for (let i = 0; i < P.N; i++) {
    const ch = str[i];
    if (ch === '#') continue;
    st.cell[i] = LOOP;
    const m = parseInt(ch, 16);
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

export const checkSolved = isSolved;

// ---------------------------------------------------------------- CSV

export const CSV_HEADER = 'name,rows,cols,clues,solution,rules,tier,score';

/** Serialize clues as `row:col:W|B` joined by `;`. */
export function cluesToString(clues) {
  return (clues || []).map((c) => `${c.r}:${c.c}:${c.t}`).join(';');
}

export function cluesFromString(s) {
  if (!s) return [];
  return s.split(';').map((tok) => {
    const [r, c, t] = tok.split(':');
    if (t !== 'W' && t !== 'B') throw new Error(`bad clue "${tok}"`);
    return { r: +r, c: +c, t };
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
