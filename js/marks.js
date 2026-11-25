// Pure edge-mark, gray-label, and dual-face (Inside/Outside) transitions + Auto-X / Auto-Shade bookkeeping (no DOM).
//
// Edge marks:   m.edges[x] = 0 empty, 1 loop segment, 2 cross (X, no segment).
// Auto-X mask:  m.autoE[x] = 1 when edge x's X was placed automatically by Auto-X mode (0 for manual marks).
// Face marks:   m.faces[f] = 0 blank, 1 Inside (IN), 2 Outside (OUT) on the (rows-1) x (cols-1) dual grid.
// Auto-Shade:   m.autoF[f] = 1 when face f's tint was placed automatically by Auto-Shade mode (0 for manual).
// Gray labels:  m.grays[k] = 0 unlabeled, 1 White, 2 Black (indexed by P.grays[k]); m.autoG[k] = 1 if auto-labeled.
import { NONE, WHITE, BLACK } from './logic.js';
import { autoXSlither } from './variants/slitherlink.js';

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
  let anyDegGt0 = false;
  for (let i = 0; i < N; i++) if (deg[i] > 0) { anyDegGt0 = true; break; }
  const cycleViolatesSlither = (cycleEdges) => {
    if (!P.hasSlither) return false;
    const inCyc = new Uint8Array(numEdges);
    for (let k = 0; k < cycleEdges.length; k++) inCyc[cycleEdges[k]] = 1;
    const fe = P.faceEdges, sl = P.slither;
    for (let k = 0; k < sl.length; k++) {
      const sc = sl[k];
      const f4 = sc.f * 4;
      let on = 0;
      const e0 = fe[f4], e1 = fe[f4 + 1], e2 = fe[f4 + 2], e3 = fe[f4 + 3];
      if (e0 >= 0 && inCyc[e0]) on++;
      if (e1 >= 0 && inCyc[e1]) on++;
      if (e2 >= 0 && inCyc[e2]) on++;
      if (e3 >= 0 && inCyc[e3]) on++;
      if (on !== sc.n) return true;
    }
    return false;
  };

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
    // Slitherlink bookkeeping: a 0 face or any face with `n` drawn segments auto-X's its remaining open sides
    if (P.hasSlither && autoXSlither(P, w, add)) {
      changed = true;
      continue;
    }
    // Rule 4: dead-end intersections & pockets (disabled on fullBoard since every intersection must be visited)
    if (!P.fullBoard) {
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
          const impossible = P.clueCells.length > 0 || anyDegGt0 || cycleViolatesSlither(w1.edges);
          if (impossible) {
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
          if (!impossible && P.hasSlither) impossible = cycleViolatesSlither(w1.edges.concat(w2.edges));
          if (impossible) {
            for (const x of w1.edges) if (add(x)) changed = true;
            for (const x of w2.edges) if (add(x)) changed = true;
          }
        }
      }
      if (changed) continue;
    }

    // Rule 5 (when both Auto-X and Auto-Shade are ON): cross out edges separating two identically shaded squares,
    // including outer-border and exterior-cutout edges bordering an Outside-shaded square (exterior is always Outside).
    if (useShade && P.rows > 1 && P.cols > 1) {
      const fr = P.rows - 1, fc = P.cols - 1;
      const sh = autoShadeCompute(P, { edges: w, faces: m.faces, autoF: m.autoF });
      const faceExt = P.hasVoids ? P.faceExterior : null;
      const colAt = (r, c) => {
        if (r < 0 || c < 0 || r >= fr || c >= fc) return FACE_OUT;
        const f = r * fc + c;
        if (faceExt && faceExt[f]) return FACE_OUT;
        return sh.color[f];
      };
      for (let r = 0; r < P.rows; r++) {
        for (let c = 0; c < fc; c++) {
          const x = 2 * (r * P.cols + c);
          if (P.edgeA[x] < 0) continue;
          const cA = colAt(r - 1, c), cB = colAt(r, c);
          if (cA && cA === cB) {
            if (add(x)) changed = true;
          }
        }
      }
      for (let r = 0; r < fr; r++) {
        for (let c = 0; c < P.cols; c++) {
          const x = 2 * (r * P.cols + c) + 1;
          if (P.edgeA[x] < 0) continue;
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

/** All dual face indices belonging to the same interactive unit as `f` (whole interior hole, single face, or [] for exterior cutout). */
export function faceGroupOf(P, f) {
  const F = numFacesOf(P);
  if (f < 0 || f >= F) return [];
  if (P.hasVoids) {
    if (P.faceExterior && P.faceExterior[f]) return [];
    const hid = P.faceHoleId ? P.faceHoleId[f] : -1;
    if (hid >= 0) return P.holeList[hid];
  }
  return [f];
}

/** Set a face (or its entire interior hole unit) to `val` (0/1/2) with `auto` flag (0 manual, 1 auto). */
export function setFaceGroup(P, cur, f, val, auto = 0) {
  const grp = faceGroupOf(P, f);
  for (let i = 0; i < grp.length; i++) {
    const g = grp[i];
    cur.faces[g] = val;
    if (cur.autoF) cur.autoF[g] = val ? auto : 0;
  }
  return grp.length > 0;
}

const flipColor = (v) => (v === FACE_IN ? FACE_OUT : v === FACE_OUT ? FACE_IN : 0);

/**
 * Compute Auto-Shade bookkeeping on the (rows-1) x (cols-1) dual faces from ONLY:
 *   - exterior boundary & exterior cutouts (always OUT) across bordering lines (IN) and X's (OUT)
 *   - player's manual face marks (faces where autoF[f] === 0)
 * Propagated to fixed point via:
 *   1. Across a drawn loop segment (edges[x] === 1): opposite color (IN <-> OUT)
 *   2. Across a crossed-out edge (edges[x] === 2): same color (IN <-> IN, OUT <-> OUT)
 *   3. Across an interior cutout hole: all dual squares of the hole share one parity unit
 *
 * Intentionally does NOT infer from white or black circles (those deductions live in Hint / rating.js).
 * Returns { color: Uint8Array(F) } where color[f] is 0 (none), 1 (IN), 2 (OUT);
 * conflicting deductions (both IN and OUT reached) leave color[f] = 0 so conflicts never corrupt the board.
 */
export function autoShadeCompute(P, m) {
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  const mask = new Uint8Array(F); // bit 0 = IN (1), bit 1 = OUT (2), 3 = conflict
  if (F === 0) return { color: new Uint8Array(0) };

  const faceExt = P.hasVoids ? P.faceExterior : null;
  const faceHoleId = P.hasVoids ? P.faceHoleId : null;
  const holeList = P.hasVoids ? P.holeList : null;

  const faceAt = (r, c) => {
    if (r < 0 || c < 0 || r >= fr || c >= fc) return -1;
    const f = r * fc + c;
    return (faceExt && faceExt[f]) ? -1 : f;
  };
  const queue = [];

  const markOne = (f, col) => {
    if (mask[f] & col) return;
    mask[f] |= col;
    queue.push(f, col);
  };
  const mark = (f, col) => {
    if (f < 0 || (col !== FACE_IN && col !== FACE_OUT)) return;
    if (faceExt && faceExt[f]) return;
    if (faceHoleId && faceHoleId[f] >= 0) {
      const grp = holeList[faceHoleId[f]];
      for (let i = 0; i < grp.length; i++) markOne(grp[i], col);
    } else {
      markOne(f, col);
    }
  };

  // Seed 1: manual face marks (never auto-placed ones)
  if (m.faces) {
    for (let f = 0; f < F; f++) {
      if (faceExt && faceExt[f]) continue;
      if (m.faces[f] && !(m.autoF && m.autoF[f])) mark(f, m.faces[f]);
    }
  }

  // Seed 2: any active edge bordering exterior (outer rectangle edge OR indented exterior cutout)
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const ev = m.edges[x];
    if (ev !== 1 && ev !== 2) continue;
    const cell = x >> 1;
    const r = (cell / P.cols) | 0, c = cell % P.cols;
    let fA, fB;
    if ((x & 1) === 0) {
      fA = faceAt(r - 1, c);
      fB = faceAt(r, c);
    } else {
      fA = faceAt(r, c - 1);
      fB = faceAt(r, c);
    }
    if (fA < 0 && fB >= 0) mark(fB, ev === 1 ? FACE_IN : FACE_OUT);
    else if (fB < 0 && fA >= 0) mark(fA, ev === 1 ? FACE_IN : FACE_OUT);
  }

  // Propagate both color bits independently via BFS across active interior lines (opposite) and X's (same)
  // so any conflicted parity component clears to 0 regardless of seed or face-index order.
  const stepNbr = (nr, nc, x, col) => {
    if (P.edgeA[x] < 0) return;
    const g = faceAt(nr, nc);
    if (g < 0) return;
    const ev = m.edges[x];
    if (ev === 1) mark(g, flipColor(col));
    else if (ev === 2) mark(g, col);
  };
  let head = 0;
  while (head < queue.length) {
    const f = queue[head++];
    const col = queue[head++];
    const r = (f / fc) | 0, c = f % fc;
    const base = r * P.cols + c;
    stepNbr(r - 1, c, 2 * base, col);
    stepNbr(r + 1, c, 2 * (base + P.cols), col);
    stepNbr(r, c - 1, 2 * base + 1, col);
    stepNbr(r, c + 1, 2 * (base + 1) + 1, col);
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
  const faceExt = P.hasVoids ? P.faceExterior : null;

  for (let f = 0; f < F; f++) {
    if (faceExt && faceExt[f]) { cur.faces[f] = 0; cur.autoF[f] = 0; continue; }
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
 * an X edge, or (when `checkBorder` is true) the outer/cutout boundary (used for gentle visual warning).
 * Passing `checkBorder = false` lets manual players invert Inside/Outside colors without false border warnings.
 */
export function shadeConflicts(P, m, checkBorder = true) {
  const bad = new Set();
  const fr = P.rows - 1, fc = P.cols - 1, F = Math.max(0, fr * fc);
  if (!m.faces || F === 0) return bad;
  const faceExt = P.hasVoids ? P.faceExterior : null;
  const faceAt = (r, c) => {
    if (r < 0 || c < 0 || r >= fr || c >= fc) return -1;
    const f = r * fc + c;
    return (faceExt && faceExt[f]) ? -1 : f;
  };
  const valAt = (r, c) => {
    const f = faceAt(r, c);
    return f >= 0 ? m.faces[f] : (checkBorder ? FACE_OUT : FACE_BLANK);
  };
  const addBad = (f) => {
    if (f < 0) return;
    for (const g of faceGroupOf(P, f)) bad.add(g);
  };

  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const ev = m.edges[x];
    if (ev !== 1 && ev !== 2) continue;
    const cell = x >> 1;
    const r = (cell / P.cols) | 0, c = cell % P.cols;
    let a, b, va, vb;
    if ((x & 1) === 0) {
      a = faceAt(r - 1, c); b = faceAt(r, c);
      va = valAt(r - 1, c); vb = valAt(r, c);
    } else {
      a = faceAt(r, c - 1); b = faceAt(r, c);
      va = valAt(r, c - 1); vb = valAt(r, c);
    }
    if (!va || !vb) continue;
    if ((ev === 1 && va === vb) || (ev === 2 && va !== vb)) {
      addBad(a);
      addBad(b);
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
  const faceExt = P.hasVoids ? P.faceExterior : null;
  const faceHoleId = P.hasVoids ? P.faceHoleId : null;
  const holeList = P.hasVoids ? P.holeList : null;
  const faceAt = (r, c) => {
    if (r < 0 || c < 0 || r >= fr || c >= fc) return -1;
    const f = r * fc + c;
    return (faceExt && faceExt[f]) ? -1 : f;
  };
  const q = [];
  const seed = (f, col) => {
    if (f < 0 || out[f]) return;
    if (faceHoleId && faceHoleId[f] >= 0) {
      const grp = holeList[faceHoleId[f]];
      for (let i = 0; i < grp.length; i++) {
        const g = grp[i];
        if (!out[g]) { out[g] = col; q.push(g); }
      }
    } else {
      out[f] = col;
      q.push(f);
    }
  };
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const cell = x >> 1;
    const r = (cell / P.cols) | 0, c = cell % P.cols;
    let fA, fB;
    if ((x & 1) === 0) { fA = faceAt(r - 1, c); fB = faceAt(r, c); }
    else { fA = faceAt(r, c - 1); fB = faceAt(r, c); }
    const col = edges[x] === 1 ? FACE_IN : FACE_OUT;
    if (fA < 0 && fB >= 0) seed(fB, col);
    else if (fB < 0 && fA >= 0) seed(fA, col);
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
      if (P.edgeA[x] < 0) continue;
      const g = faceAt(nr, nc);
      if (g < 0 || out[g]) continue;
      seed(g, edges[x] === 1 ? flipColor(col) : col);
    }
  }
  return out;
}
