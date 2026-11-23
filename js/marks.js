// Pure edge-mark and dual-face (Inside/Outside) transitions + Auto-X / Auto-Shade bookkeeping (no DOM).
//
// Edge marks:   m.edges[x] = 0 empty, 1 loop segment, 2 cross (X, no segment).
// Auto-X mask:  m.autoE[x] = 1 when edge x's X was placed automatically by Auto-X mode (0 for manual marks).
// Face marks:   m.faces[f] = 0 blank, 1 Inside (IN), 2 Outside (OUT) on the (rows-1) x (cols-1) dual grid.
// Auto-Shade:   m.autoF[f] = 1 when face f's tint was placed automatically by Auto-Shade mode (0 for manual).
import { NONE } from './logic.js';

export const FACE_BLANK = 0, FACE_IN = 1, FACE_OUT = 2;

/** Left-tap on a grid segment cycles: empty (0) -> line (1) -> X (2) -> empty (0). */
export function cycleEdgeMark(cur) {
  return cur === 0 ? 1 : cur === 1 ? 2 : 0;
}

/** Right-click on a grid segment toggles X directly: empty/line -> X (2), X -> empty (0). */
export function toggleEdgeCross(cur) {
  return cur === 2 ? 0 : 2;
}

/** Left-tap on a dual square cycles: blank (0) -> Inside (1) -> Outside (2) -> blank (0). */
export function cycleFaceMark(cur) {
  return cur === 0 ? FACE_IN : cur === FACE_IN ? FACE_OUT : FACE_BLANK;
}

/** Right-click on a dual square cycles in reverse: blank (0) -> Outside (2) -> Inside (1) -> blank (0). */
export function cycleFaceMarkReverse(cur) {
  return cur === 0 ? FACE_OUT : cur === FACE_OUT ? FACE_IN : FACE_BLANK;
}

// ------------------------------------------------------------ Auto-X mode

/**
 * Compute the fixed point of obvious Auto-X edges from ONLY the player's own edge marks in `m`
 * (ignoring any existing auto-placed X's so removing a causing segment or cross cleanly unwinds cascades).
 */
export function autoXReasons(P, m) {
  const { N, numEdges, ed, ed2, clue, whites, blacks } = P;
  const autoE = m.autoE;
  const w = new Uint8Array(numEdges);
  for (let x = 0; x < numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    w[x] = (m.edges[x] === 2 && autoE && autoE[x]) ? 0 : m.edges[x];
  }

  const reasons = new Map();
  const add = (x, r) => {
    if (x < 0 || w[x] === 1) return false;
    let s = reasons.get(x);
    if (!s) reasons.set(x, (s = new Set()));
    s.add(r);
    if (w[x] === 0) { w[x] = 2; return true; }
    return false;
  };

  const deg = new Uint8Array(N);
  for (let x = 0; x < numEdges; x++) {
    if (w[x] === 1) { deg[P.edgeA[x]]++; deg[P.edgeB[x]]++; }
  }

  // Rule 1: cell with 2 segments -> X out the other incident edges
  for (let i = 0; i < N; i++) {
    if (deg[i] !== 2) continue;
    for (let d = 0; d < 4; d++) {
      const x = ed[i * 4 + d];
      if (x >= 0 && w[x] !== 1) add(x, `full:${i}`);
    }
  }

  // Rule 2: white circle going straight 2 steps on one side -> X out straight past the other side
  for (const i of whites) {
    for (let d = 0; d < 4; d++) {
      const e1 = ed[i * 4 + d], ext1 = ed2[i * 4 + d];
      if (e1 >= 0 && ext1 >= 0 && w[e1] === 1 && w[ext1] === 1) {
        const oppExt = ed2[i * 4 + (d ^ 2)];
        if (oppExt >= 0 && w[oppExt] !== 1) add(oppExt, `white:${i}:${d}`);
      }
    }
  }

  // Rule 3: black circle going in direction d -> X out the opposite direction
  for (const i of blacks) {
    for (let d = 0; d < 4; d++) {
      const e1 = ed[i * 4 + d];
      if (e1 >= 0 && w[e1] === 1) {
        const opp = ed[i * 4 + (d ^ 2)];
        if (opp >= 0 && w[opp] !== 1) add(opp, `black:${i}:${d}`);
      }
    }
  }

  // Rule 4: dead-end intersections (1 exit) and dead-end pockets (2-exit corridor returning to same node)
  let hasAnyClueOrSeg = P.clueCells.length > 0;
  if (!hasAnyClueOrSeg) for (let i = 0; i < N; i++) if (deg[i] > 0) { hasAnyClueOrSeg = true; break; }

  const availEdges = (i) => {
    const out = [];
    for (let d = 0; d < 4; d++) {
      const x = ed[i * 4 + d];
      if (x >= 0 && w[x] === 0) out.push(x);
    }
    return out;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < N; i++) {
      if (clue[i] !== NONE || deg[i] !== 0) continue;
      let avail = 0, lastX = -1;
      for (let d = 0; d < 4; d++) {
        const x = ed[i * 4 + d];
        if (x < 0 || w[x] === 2) continue;
        avail++;
        lastX = x;
      }
      if (avail === 1 && lastX >= 0) {
        if (add(lastX, `dead:${i}`)) changed = true;
      }
    }
    if (changed) continue;

    const isCorridorNode = new Uint8Array(N);
    const nodeExits = new Array(N);
    for (let i = 0; i < N; i++) {
      if (clue[i] !== NONE || deg[i] !== 0) continue;
      const ex = availEdges(i);
      if (ex.length === 2) { isCorridorNode[i] = 1; nodeExits[i] = ex; }
    }
    const visitedEdge = new Uint8Array(numEdges);
    for (let startNode = 0; startNode < N; startNode++) {
      if (!isCorridorNode[startNode]) continue;
      const [eA, eB] = nodeExits[startNode];
      if (visitedEdge[eA]) continue;

      const walk = (firstEdge) => {
        const edges = [];
        let cur = startNode, edge = firstEdge;
        while (true) {
          visitedEdge[edge] = 1;
          edges.push(edge);
          const nxt = P.edgeA[edge] === cur ? P.edgeB[edge] : P.edgeA[edge];
          if (nxt === startNode) return { term: startNode, edges, closed: true };
          if (!isCorridorNode[nxt]) return { term: nxt, edges, closed: false };
          const [x0, x1] = nodeExits[nxt];
          edge = x0 === edge ? x1 : x0;
          cur = nxt;
        }
      };

      const w1 = walk(eA);
      if (w1.closed) {
        if (hasAnyClueOrSeg) {
          const tag = `pocket:${Math.min(...w1.edges)}`;
          for (const x of w1.edges) if (add(x, tag)) changed = true;
        }
        continue;
      }
      const w2 = walk(eB);
      if (w1.term === w2.term) {
        const t = w1.term;
        let impossible = deg[t] >= 1;
        if (!impossible) for (const ci of P.clueCells) if (ci !== t) { impossible = true; break; }
        if (!impossible) for (let i = 0; i < N; i++) if (i !== t && deg[i] > 0) { impossible = true; break; }
        if (impossible) {
          const allEdges = w1.edges.concat(w2.edges);
          const tag = `pocket:${t}:${Math.min(...allEdges)}`;
          for (const x of allEdges) if (add(x, tag)) changed = true;
        }
      }
    }
  }

  return reasons;
}

export function reconcileAutoX(P, prev, cur, enabled = true) {
  if (!cur.autoE) cur.autoE = new Uint8Array(P.numEdges);
  const before = prev ? autoXReasons(P, prev) : new Map();
  const now = autoXReasons(P, cur);

  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const reasons = now.get(x);
    if (cur.edges[x] === 2 && cur.autoE[x]) {
      if (!reasons) { cur.edges[x] = 0; cur.autoE[x] = 0; }
    } else if (cur.edges[x] === 0 && reasons && enabled) {
      const old = before.get(x);
      const wasManual = prev && (prev.edges[x] === 1 || (prev.edges[x] === 2 && !(prev.autoE && prev.autoE[x])));
      if (wasManual) {
        cur.edges[x] = 2; cur.autoE[x] = 1;
      } else {
        for (const r of reasons) {
          if (!old || !old.has(r)) { cur.edges[x] = 2; cur.autoE[x] = 1; break; }
        }
      }
    }
  }
}

export function applyAutoX(P, m, on) {
  if (!m.autoE) m.autoE = new Uint8Array(P.numEdges);
  const was = Uint8Array.from(m.edges);
  if (on) {
    reconcileAutoX(P, null, m, true);
  } else {
    for (let x = 0; x < P.numEdges; x++) {
      if (m.edges[x] === 2 && m.autoE[x]) { m.edges[x] = 0; m.autoE[x] = 0; }
    }
  }
  let changed = 0;
  for (let x = 0; x < P.numEdges; x++) if (m.edges[x] !== was[x]) changed++;
  return changed;
}

// ------------------------------------------------------------ Auto-Shade (Inside / Outside dual faces)

/** Number of dual faces for puzzle P: (rows - 1) * (cols - 1). */
export const numFacesOf = (P) => Math.max(0, (P.rows - 1) * (P.cols - 1));

const flipColor = (v) => (v === FACE_IN ? FACE_OUT : v === FACE_OUT ? FACE_IN : 0);

/**
 * Compute Auto-Shade bookkeeping on the (rows-1) x (cols-1) dual faces from ONLY:
 *   - exterior boundary (always OUT) across outer-perimeter lines (IN) and outer-perimeter X's (OUT)
 *   - player's manual face marks (faces where autoF[f] === 0)
 * Propagated to fixed point via:
 *   1. Across a drawn loop segment (edges[x] === 1): opposite color (IN <-> OUT)
 *   2. Across a crossed-out edge (edges[x] === 2): same color (IN <-> IN, OUT <-> OUT)
 *
 * Intentionally does NOT infer from white or black circles (those deductions live in Hint / rating.js).
 * Returns { color: Uint8Array(F), reasons: Array<Set<string>> } where color[f] is 0 (none), 1 (IN), 2 (OUT);
 * conflicting deductions (both IN and OUT reached) leave color[f] = 0 so conflicts never corrupt the board.
 */
export function autoShadeCompute(P, m) {
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  const mask = new Uint8Array(F); // bit 0 = IN (1), bit 1 = OUT (2), 3 = conflict
  const reasons = Array.from({ length: F }, () => new Set());
  if (F === 0) return { color: new Uint8Array(0), reasons };

  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : -1);
  const queue = [];

  const mark = (f, col, reason) => {
    if (f < 0 || (col !== FACE_IN && col !== FACE_OUT)) return;
    reasons[f].add(`${col}:${reason}`);
    const prev = mask[f];
    const next = prev | col;
    if (next !== prev) {
      mask[f] = next;
      if (next === FACE_IN || next === FACE_OUT) queue.push(f);
    }
  };

  // Seed 1: manual face marks (never auto-placed ones)
  if (m.faces) {
    for (let f = 0; f < F; f++) {
      if (m.faces[f] && !(m.autoF && m.autoF[f])) mark(f, m.faces[f], `man:${f}`);
    }
  }

  // Seed 2: outer perimeter edges (adjacent to virtual exterior OUT)
  for (let c = 0; c < fc; c++) {
    const eTop = 2 * c;
    if (m.edges[eTop] === 1) mark(faceAt(0, c), FACE_IN, `eb:${eTop}`);
    else if (m.edges[eTop] === 2) mark(faceAt(0, c), FACE_OUT, `eb:${eTop}`);
    const eBot = 2 * ((P.rows - 1) * P.cols + c);
    if (m.edges[eBot] === 1) mark(faceAt(fr - 1, c), FACE_IN, `eb:${eBot}`);
    else if (m.edges[eBot] === 2) mark(faceAt(fr - 1, c), FACE_OUT, `eb:${eBot}`);
  }
  for (let r = 0; r < fr; r++) {
    const eLeft = 2 * (r * P.cols) + 1;
    if (m.edges[eLeft] === 1) mark(faceAt(r, 0), FACE_IN, `eb:${eLeft}`);
    else if (m.edges[eLeft] === 2) mark(faceAt(r, 0), FACE_OUT, `eb:${eLeft}`);
    const eRight = 2 * (r * P.cols + P.cols - 1) + 1;
    if (m.edges[eRight] === 1) mark(faceAt(r, fc - 1), FACE_IN, `eb:${eRight}`);
    else if (m.edges[eRight] === 2) mark(faceAt(r, fc - 1), FACE_OUT, `eb:${eRight}`);
  }

  // Propagate via BFS across interior lines (opposite) and interior X's (same) only
  let head = 0;
  while (head < queue.length) {
    const f = queue[head++];
    const col = mask[f];
    if (col !== FACE_IN && col !== FACE_OUT) continue; // skip conflicted face
    const r = (f / fc) | 0, c = f % fc;

    const nbrs = [
      [r - 1, c, 2 * (r * P.cols + c)],             // top
      [r + 1, c, 2 * ((r + 1) * P.cols + c)],       // bottom
      [r, c - 1, 2 * (r * P.cols + c) + 1],         // left
      [r, c + 1, 2 * (r * P.cols + c + 1) + 1],     // right
    ];
    for (const [nr, nc, x] of nbrs) {
      const g = faceAt(nr, nc);
      if (g < 0) continue;
      const ev = m.edges[x];
      if (ev === 1) mark(g, flipColor(col), `e:${x}:${f}`);
      else if (ev === 2) mark(g, col, `e:${x}:${f}`);
    }
  }

  const color = new Uint8Array(F);
  for (let f = 0; f < F; f++) {
    if (mask[f] === FACE_IN || mask[f] === FACE_OUT) color[f] = mask[f];
  }
  return { color, reasons };
}

/**
 * Reconcile automatic Inside/Outside face shading in `cur` against `prev` (null = fresh board or switch turned on).
 * Manual face marks (`autoF[f] === 0`) are never overwritten.
 */
export function reconcileAutoShade(P, prev, cur, enabled = true) {
  const F = numFacesOf(P);
  if (!cur.faces) cur.faces = new Uint8Array(F);
  if (!cur.autoF) cur.autoF = new Uint8Array(F);
  const before = prev ? autoShadeCompute(P, prev) : null;
  const now = autoShadeCompute(P, cur);

  for (let f = 0; f < F; f++) {
    const col = now.color[f];
    if (cur.faces[f] !== 0 && cur.autoF[f]) {
      if (!col || !enabled) { cur.faces[f] = 0; cur.autoF[f] = 0; }
      else cur.faces[f] = col;
    } else if (cur.faces[f] === 0 && col && enabled) {
      const wasManual = prev && prev.faces && prev.faces[f] !== 0 && !(prev.autoF && prev.autoF[f]);
      if (!before || wasManual) {
        cur.faces[f] = col; cur.autoF[f] = 1;
      } else {
        const oldR = before.reasons[f];
        if (before.color[f] !== col) {
          cur.faces[f] = col; cur.autoF[f] = 1;
        } else {
          for (const r of now.reasons[f]) {
            if (!oldR.has(r)) { cur.faces[f] = col; cur.autoF[f] = 1; break; }
          }
        }
      }
    }
  }
}

/** Flip Auto-Shade on or off for mark state `m`. Returns how many faces changed. */
export function applyAutoShade(P, m, on) {
  const F = numFacesOf(P);
  if (!m.faces) m.faces = new Uint8Array(F);
  if (!m.autoF) m.autoF = new Uint8Array(F);
  const was = Uint8Array.from(m.faces);
  if (on) {
    reconcileAutoShade(P, null, m, true);
  } else {
    for (let f = 0; f < F; f++) {
      if (m.faces[f] !== 0 && m.autoF[f]) { m.faces[f] = 0; m.autoF[f] = 0; }
    }
  }
  let changed = 0;
  for (let f = 0; f < F; f++) if (m.faces[f] !== was[f]) changed++;
  return changed;
}

/**
 * Return a Set of dual face indices whose current shading directly contradicts a drawn line,
 * an X edge, or (when `checkBorder` is true) the outer boundary (used for gentle visual warning).
 * Passing `checkBorder = false` lets manual players invert Inside/Outside colors without false border warnings.
 */
export function shadeConflicts(P, m, checkBorder = true) {
  const bad = new Set();
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  if (!m.faces || F === 0) return bad;
  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : -1);
  const valAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? m.faces[r * fc + c] : (checkBorder ? FACE_OUT : FACE_BLANK));

  // Check every horizontal edge (r, c)-(r, c+1) separating face (r-1, c) and face (r, c)
  for (let r = 0; r < P.rows; r++) {
    for (let c = 0; c < fc; c++) {
      const ev = m.edges[2 * (r * P.cols + c)];
      if (ev === 0) continue;
      const a = faceAt(r - 1, c), b = faceAt(r, c);
      const va = valAt(r - 1, c), vb = valAt(r, c);
      if (!va || !vb) continue;
      if ((ev === 1 && va === vb) || (ev === 2 && va !== vb)) {
        if (a >= 0) bad.add(a);
        if (b >= 0) bad.add(b);
      }
    }
  }
  // Check every vertical edge (r, c)-(r+1, c) separating face (r, c-1) and face (r, c)
  for (let r = 0; r < fr; r++) {
    for (let c = 0; c < P.cols; c++) {
      const ev = m.edges[2 * (r * P.cols + c) + 1];
      if (ev === 0) continue;
      const a = faceAt(r, c - 1), b = faceAt(r, c);
      const va = valAt(r, c - 1), vb = valAt(r, c);
      if (!va || !vb) continue;
      if ((ev === 1 && va === vb) || (ev === 2 && va !== vb)) {
        if (a >= 0) bad.add(a);
        if (b >= 0) bad.add(b);
      }
    }
  }
  return bad;
}

/**
 * Compute exact Inside (1) / Outside (2) shading for every dual square from a closed loop `edges`.
 * Uses BFS from the exterior (always Outside), flipping color whenever crossing a loop segment.
 */
export function facesFromSolvedLoop(P, edges) {
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  const out = new Uint8Array(F);
  if (F === 0) return out;
  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : -1);
  const q = [];
  const seed = (f, col) => {
    if (f < 0 || out[f]) return;
    out[f] = col;
    q.push(f);
  };
  for (let c = 0; c < fc; c++) {
    seed(faceAt(0, c), edges[2 * c] === 1 ? FACE_IN : FACE_OUT);
    seed(faceAt(fr - 1, c), edges[2 * ((P.rows - 1) * P.cols + c)] === 1 ? FACE_IN : FACE_OUT);
  }
  for (let r = 0; r < fr; r++) {
    seed(faceAt(r, 0), edges[2 * (r * P.cols) + 1] === 1 ? FACE_IN : FACE_OUT);
    seed(faceAt(r, fc - 1), edges[2 * (r * P.cols + P.cols - 1) + 1] === 1 ? FACE_IN : FACE_OUT);
  }
  let head = 0;
  while (head < q.length) {
    const f = q[head++];
    const col = out[f];
    const r = (f / fc) | 0, c = f % fc;
    const nbrs = [
      [r - 1, c, 2 * (r * P.cols + c)],
      [r + 1, c, 2 * ((r + 1) * P.cols + c)],
      [r, c - 1, 2 * (r * P.cols + c) + 1],
      [r, c + 1, 2 * (r * P.cols + c + 1) + 1],
    ];
    for (const [nr, nc, x] of nbrs) {
      const g = faceAt(nr, nc);
      if (g < 0 || out[g]) continue;
      seed(g, edges[x] === 1 ? flipColor(col) : col);
    }
  }
  return out;
}
