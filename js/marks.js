// Pure edge-mark, gray-label, and dual-face (Inside/Outside) transitions + Auto-X / Auto-Shade bookkeeping (no DOM).
//
// Edge marks:   m.edges[x] = 0 empty, 1 loop segment, 2 cross (X, no segment).
// Auto-X mask:  m.autoE[x] = 1 when edge x's X was placed automatically by Auto-X mode (0 for manual marks).
// Face marks:   m.faces[f] = 0 blank, 1 Inside (IN), 2 Outside (OUT) on the (rows-1) x (cols-1) dual grid.
// Auto-Shade:   m.autoF[f] = 1 when face f's tint was placed automatically by Auto-Shade mode (0 for manual).
// Gray labels:  m.grays[k] = 0 unlabeled, 1 White, 2 Black (indexed by P.grays[k]); m.autoG[k] = 1 if auto-labeled.
import { NONE, WHITE, BLACK } from './logic.js';

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

/** Left-tap on a gray pearl cycles: unlabeled (0) -> White (1) -> Black (2) -> unlabeled (0). */
export function cycleGrayLabel(cur) {
  return cur === 0 ? WHITE : cur === WHITE ? BLACK : 0;
}

/** Right-click on a gray pearl cycles in reverse: unlabeled (0) -> Black (2) -> White (1) -> unlabeled (0). */
export function cycleGrayLabelReverse(cur) {
  return cur === 0 ? BLACK : cur === BLACK ? WHITE : 0;
}

/**
 * Auto-label unlabeled gray pearls that already have 2 drawn loop segments (straight -> White, turn -> Black).
 * Never overwrites a manual label (`autoG[k] === 0`); cleanly unwinds when one of the 2 segments is erased.
 */
export function reconcileAutoGray(P, cur) {
  const n = P.grays ? P.grays.length : 0;
  if (!n) return;
  if (!cur.grays || cur.grays.length !== n) cur.grays = new Uint8Array(n);
  if (!cur.autoG || cur.autoG.length !== n) cur.autoG = new Uint8Array(n);
  const { ed } = P;
  for (let k = 0; k < n; k++) {
    const i = P.grays[k];
    let d0 = -1, d1 = -1, cnt = 0;
    for (let d = 0; d < 4; d++) {
      const x = ed[i * 4 + d];
      if (x >= 0 && cur.edges[x] === 1) {
        if (cnt === 0) d0 = d;
        else if (cnt === 1) d1 = d;
        cnt++;
      }
    }
    const forced = cnt === 2 ? (((d0 ^ d1) & 1) === 0 ? WHITE : BLACK) : 0;
    if (cur.grays[k] !== 0 && cur.autoG[k]) {
      if (!forced) { cur.grays[k] = 0; cur.autoG[k] = 0; }
      else cur.grays[k] = forced;
    } else if (cur.grays[k] === 0 && forced) {
      cur.grays[k] = forced; cur.autoG[k] = 1;
    }
  }
}

// ------------------------------------------------------------ Auto-X mode

/**
 * Compute the fixed point of obvious Auto-X edges from ONLY the player's own manual marks in `m`
 * (ignoring any existing auto-placed X's or auto-shades so removing a causing mark cleanly unwinds cascades).
 * When `useShade` is true (both Auto-X and Auto-Shade enabled), also crosses out edges separating
 * two identically shaded squares (including outer-border edges adjacent to an Outside-shaded square).
 * Returns a Uint8Array(numEdges) where 1 indicates the edge is forced to X.
 */
export function autoXForced(P, m, { useShade = false } = {}) {
  const { N, numEdges, ed, ed2, clue, whites, blacks } = P;
  const autoE = m.autoE;
  const w = new Uint8Array(numEdges);
  for (let x = 0; x < numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    w[x] = (m.edges[x] === 2 && autoE && autoE[x]) ? 0 : m.edges[x];
  }

  const forced = new Uint8Array(numEdges);
  const add = (x) => {
    if (x < 0 || w[x] === 1) return false;
    forced[x] = 1;
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
      if (x >= 0 && w[x] !== 1) add(x);
    }
  }

  // Effective white & black circles (includes labeled gray pearls when present)
  let effWhites = whites, effBlacks = blacks;
  if (P.grays && P.grays.length && m.grays) {
    let extraW = false, extraB = false;
    for (let k = 0; k < P.grays.length; k++) {
      if (m.grays[k] === WHITE) extraW = true;
      else if (m.grays[k] === BLACK) extraB = true;
    }
    if (extraW) {
      effWhites = whites.slice();
      for (let k = 0; k < P.grays.length; k++) if (m.grays[k] === WHITE) effWhites.push(P.grays[k]);
    }
    if (extraB) {
      effBlacks = blacks.slice();
      for (let k = 0; k < P.grays.length; k++) if (m.grays[k] === BLACK) effBlacks.push(P.grays[k]);
    }
  }

  // Rule 2: white circle with both straight segments drawn and continuing straight on one side -> X out straight past the other side
  for (const i of effWhites) {
    for (let d = 0; d < 4; d++) {
      const e1 = ed[i * 4 + d], e2 = ed[i * 4 + (d ^ 2)], ext1 = ed2[i * 4 + d];
      if (e1 >= 0 && e2 >= 0 && ext1 >= 0 && w[e1] === 1 && w[e2] === 1 && w[ext1] === 1) {
        const oppExt = ed2[i * 4 + (d ^ 2)];
        if (oppExt >= 0 && w[oppExt] !== 1) add(oppExt);
      }
    }
  }

  // Rule 3: black circle going in direction d -> X out the opposite direction
  for (const i of effBlacks) {
    for (let d = 0; d < 4; d++) {
      const e1 = ed[i * 4 + d];
      if (e1 >= 0 && w[e1] === 1) {
        const opp = ed[i * 4 + (d ^ 2)];
        if (opp >= 0 && w[opp] !== 1) add(opp);
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
        if (add(lastX)) changed = true;
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
          for (const x of w1.edges) if (add(x)) changed = true;
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
          for (const x of w1.edges) if (add(x)) changed = true;
          for (const x of w2.edges) if (add(x)) changed = true;
        }
      }
    }
    if (changed) continue;

    // Rule 5 (when both Auto-X and Auto-Shade are ON): cross out edges separating two identically shaded squares,
    // including outer-border edges bordering an Outside-shaded square (exterior is always Outside).
    if (useShade && P.rows > 1 && P.cols > 1) {
      const fr = P.rows - 1, fc = P.cols - 1;
      const sh = autoShadeCompute(P, { edges: w, faces: m.faces, autoF: m.autoF });
      const colAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? sh.color[r * fc + c] : FACE_OUT);
      for (let r = 0; r < P.rows; r++) {
        for (let c = 0; c < fc; c++) {
          const x = 2 * (r * P.cols + c);
          const cA = colAt(r - 1, c), cB = colAt(r, c);
          if (cA && cA === cB) {
            if (add(x)) changed = true;
          }
        }
      }
      for (let r = 0; r < fr; r++) {
        for (let c = 0; c < P.cols; c++) {
          const x = 2 * (r * P.cols + c) + 1;
          const cA = colAt(r, c - 1), cB = colAt(r, c);
          if (cA && cA === cB) {
            if (add(x)) changed = true;
          }
        }
      }
    }
  }

  return forced;
}

export function reconcileAutoX(P, cur, enabled = true, opts = undefined) {
  if (!cur.autoE) cur.autoE = new Uint8Array(P.numEdges);
  const now = enabled ? autoXForced(P, cur, opts) : null;

  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const forced = !!now && !!now[x];
    if (cur.edges[x] === 2 && cur.autoE[x]) {
      if (!forced) { cur.edges[x] = 0; cur.autoE[x] = 0; }
    } else if (cur.edges[x] === 0 && forced) {
      cur.edges[x] = 2; cur.autoE[x] = 1;
    }
  }
}

export function applyAutoX(P, m, on, opts = undefined) {
  if (!m.autoE) m.autoE = new Uint8Array(P.numEdges);
  const was = Uint8Array.from(m.edges);
  if (on) {
    reconcileAutoX(P, m, true, opts);
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
 * Returns { color: Uint8Array(F) } where color[f] is 0 (none), 1 (IN), 2 (OUT);
 * conflicting deductions (both IN and OUT reached) leave color[f] = 0 so conflicts never corrupt the board.
 */
export function autoShadeCompute(P, m) {
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  const mask = new Uint8Array(F); // bit 0 = IN (1), bit 1 = OUT (2), 3 = conflict
  if (F === 0) return { color: new Uint8Array(0) };

  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : -1);
  const queue = [];

  const mark = (f, col) => {
    if (f < 0 || (col !== FACE_IN && col !== FACE_OUT)) return;
    if (mask[f] & col) return;
    mask[f] |= col;
    queue.push(f, col);
  };

  // Seed 1: manual face marks (never auto-placed ones)
  if (m.faces) {
    for (let f = 0; f < F; f++) {
      if (m.faces[f] && !(m.autoF && m.autoF[f])) mark(f, m.faces[f]);
    }
  }

  // Seed 2: outer perimeter edges (adjacent to virtual exterior OUT)
  for (let c = 0; c < fc; c++) {
    const eTop = 2 * c;
    if (m.edges[eTop] === 1) mark(faceAt(0, c), FACE_IN);
    else if (m.edges[eTop] === 2) mark(faceAt(0, c), FACE_OUT);
    const eBot = 2 * ((P.rows - 1) * P.cols + c);
    if (m.edges[eBot] === 1) mark(faceAt(fr - 1, c), FACE_IN);
    else if (m.edges[eBot] === 2) mark(faceAt(fr - 1, c), FACE_OUT);
  }
  for (let r = 0; r < fr; r++) {
    const eLeft = 2 * (r * P.cols) + 1;
    if (m.edges[eLeft] === 1) mark(faceAt(r, 0), FACE_IN);
    else if (m.edges[eLeft] === 2) mark(faceAt(r, 0), FACE_OUT);
    const eRight = 2 * (r * P.cols + P.cols - 1) + 1;
    if (m.edges[eRight] === 1) mark(faceAt(r, fc - 1), FACE_IN);
    else if (m.edges[eRight] === 2) mark(faceAt(r, fc - 1), FACE_OUT);
  }

  // Propagate both color bits independently via BFS across interior lines (opposite) and interior X's (same)
  // so any conflicted parity component clears to 0 regardless of seed or face-index order.
  let head = 0;
  while (head < queue.length) {
    const f = queue[head++];
    const col = queue[head++];
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
      if (ev === 1) mark(g, flipColor(col));
      else if (ev === 2) mark(g, col);
    }
  }

  const color = new Uint8Array(F);
  for (let f = 0; f < F; f++) {
    if (mask[f] === FACE_IN || mask[f] === FACE_OUT) color[f] = mask[f];
  }
  return { color };
}

/**
 * Reconcile automatic Inside/Outside face shading in `cur` from current manual marks and edges.
 * Manual face marks (`autoF[f] === 0`) are never overwritten.
 */
export function reconcileAutoShade(P, cur, enabled = true) {
  const F = numFacesOf(P);
  if (!cur.faces) cur.faces = new Uint8Array(F);
  if (!cur.autoF) cur.autoF = new Uint8Array(F);
  const now = enabled ? autoShadeCompute(P, cur) : null;

  for (let f = 0; f < F; f++) {
    const col = now ? now.color[f] : 0;
    if (cur.faces[f] !== 0 && cur.autoF[f]) {
      if (!col) { cur.faces[f] = 0; cur.autoF[f] = 0; }
      else cur.faces[f] = col;
    } else if (cur.faces[f] === 0 && col) {
      cur.faces[f] = col; cur.autoF[f] = 1;
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
    reconcileAutoShade(P, m, true);
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
