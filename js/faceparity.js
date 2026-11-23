// Inside / Outside dual-face parity inference for Masyu (pure logic, no DOM).
//
// Models the (rows-1) x (cols-1) dual squares plus one virtual exterior node EXT (= rows-1 * cols-1, always OUT).
// Maintains a 2-coloring parity union-find + proof graph from:
//   1. Known loop segments (E_ON): adjacent faces have OPPOSITE parity (xor = 1)
//   2. Known crosses (E_OFF): adjacent faces have SAME parity (xor = 0)
//   3. White circles: diagonally opposite corners (NW <-> SE, NE <-> SW) have OPPOSITE parity (xor = 1)
//   4. Black circles:
//      - 3-to-1 corner law: relate(NW, SE) ^ relate(NE, SW) === 1 (covers corner black circles,
//        3-of-4 completion, same-diagonal -> opposite-diagonal, and opposite-diagonal -> same-diagonal)
//      - Forced 2-step straight legs: when a black circle's exit is proven ON (opposite flanking faces)
//        or blocked/OFF (same flanking faces or wall), the forced 2-step leg links the step-2 flanking
//        faces and blocks the midpoint perpendiculars.
//
// Any undecided edge whose two flanking faces are in the same parity component is immediately forced:
//   - same parity     -> E_OFF (cross)
//   - opposite parity -> E_ON (loop segment)
import { E_UNKNOWN, E_ON, E_OFF } from './logic.js';

/** Convert dual face index (0..F-1) to { r, c } or null for EXT. */
export function faceCoords(P, f) {
  const fr = P.rows - 1, fc = P.cols - 1, F = fr * fc;
  if (f < 0 || f >= F) return null;
  return { r: (f / fc) | 0, c: f % fc };
}

/** Return the two dual face indices [fA, fB] flanking grid edge `x` (using EXT = (rows-1)*(cols-1) outside the board). */
export function edgeDualFaces(P, x) {
  const { rows, cols } = P;
  const fr = rows - 1, fc = cols - 1, EXT = fr * fc;
  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : EXT);
  const cell = x >> 1;
  const r = (cell / cols) | 0, c = cell % cols;
  if ((x & 1) === 0) {
    // Horizontal edge (r, c)-(r, c+1) separates face (r-1, c) and face (r, c)
    return [faceAt(r - 1, c), faceAt(r, c)];
  }
  // Vertical edge (r, c)-(r+1, c) separates face (r, c-1) and face (r, c)
  return [faceAt(r, c - 1), faceAt(r, c)];
}

/**
 * Build the complete Inside/Outside parity union-find and proof graph for state `st`.
 * Returns { EXT, F, find, relate, adj, conflict }.
 */
export function buildFaceParity(P, st) {
  const { rows, cols } = P;
  const fr = rows - 1, fc = cols - 1;
  if (fr <= 0 || fc <= 0) {
    return { EXT: 0, F: 0, find: () => [0, 0], relate: () => -1, adj: [], conflict: false };
  }
  const F = fr * fc;
  const EXT = F;
  const V = F + 1;
  const faceAt = (r, c) => (r >= 0 && c >= 0 && r < fr && c < fc ? r * fc + c : EXT);

  const parent = new Int32Array(V);
  const diff = new Uint8Array(V); // parity relative to parent (0 same, 1 opposite)
  for (let i = 0; i < V; i++) parent[i] = i;

  const find = (u) => {
    if (parent[u] === u) return [u, 0];
    const [r, p] = find(parent[u]);
    parent[u] = r;
    diff[u] ^= p;
    return [r, diff[u]];
  };

  const relate = (u, v) => {
    const [ru, pu] = find(u);
    const [rv, pv] = find(v);
    if (ru !== rv) return -1;
    return pu ^ pv;
  };

  const adj = Array.from({ length: V }, () => []);
  const edgeSeen = new Set();
  let conflict = false;

  const link = (u, v, xor, reason) => {
    if (conflict) return false;
    if (u === v) {
      if (xor === 1) conflict = true;
      return false;
    }
    const [ru, pu] = find(u);
    const [rv, pv] = find(v);
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    if (ru === rv) {
      if ((pu ^ pv) !== xor) { conflict = true; return false; }
      // Still allow recording direct (board-visible) links for shorter proof paths
      if (!edgeSeen.has(key) && (reason.kind === 'edgeOn' || reason.kind === 'edgeOff' || reason.kind === 'whiteDiag')) {
        edgeSeen.add(key);
        adj[u].push({ to: v, xor, reason });
        adj[v].push({ to: u, xor, reason });
      }
      return false;
    }
    // Prefer keeping EXT as root when merging
    if (rv === EXT) {
      parent[ru] = rv;
      diff[ru] = pu ^ pv ^ xor;
    } else {
      parent[rv] = ru;
      diff[rv] = pu ^ pv ^ xor;
    }
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      adj[u].push({ to: v, xor, reason });
      adj[v].push({ to: u, xor, reason });
    }
    return true;
  };

  // 1. Known loop segments (E_ON -> opposite) and crosses (E_OFF -> same)
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const ev = st.e[x];
    if (ev !== E_ON && ev !== E_OFF) continue;
    const [a, b] = edgeDualFaces(P, x);
    link(a, b, ev === E_ON ? 1 : 0, { kind: ev === E_ON ? 'edgeOn' : 'edgeOff', edge: x });
  }

  // 2. White circles: both diagonal corner pairs have opposite parity
  for (const wi of P.whites) {
    const wr = (wi / cols) | 0, wc = wi % cols;
    const nw = faceAt(wr - 1, wc - 1);
    const ne = faceAt(wr - 1, wc);
    const sw = faceAt(wr, wc - 1);
    const se = faceAt(wr, wc);
    link(nw, se, 1, { kind: 'whiteDiag', cell: wi });
    link(ne, sw, 1, { kind: 'whiteDiag', cell: wi });
  }

  // 3. Black circles: iterate 3-to-1 diagonal law and forced 2-step straight legs to fixed point
  const forceBlackLeg = (bi, d) => {
    let changed = false;
    const e1 = P.ed[bi * 4 + d], e2 = P.ed2[bi * 4 + d], n1 = P.nb[bi * 4 + d];
    if (e1 < 0 || e2 < 0 || n1 < 0) { conflict = true; return false; }
    const reason = { kind: 'blackLeg', cell: bi, dir: d };
    const [a1, b1] = edgeDualFaces(P, e1);
    if (link(a1, b1, 1, reason)) changed = true;
    const [a2, b2] = edgeDualFaces(P, e2);
    if (link(a2, b2, 1, reason)) changed = true;
    // Opposite exit at bi is OFF
    const opp = P.ed[bi * 4 + (d ^ 2)];
    if (opp >= 0) {
      const [ao, bo] = edgeDualFaces(P, opp);
      if (link(ao, bo, 0, reason)) changed = true;
    }
    // Perpendicular exits at n1 are OFF (black leg must go straight through n1)
    for (const pd of [(d + 1) & 3, (d + 3) & 3]) {
      const ep = P.ed[n1 * 4 + pd];
      if (ep >= 0) {
        const [ap, bp] = edgeDualFaces(P, ep);
        if (link(ap, bp, 0, reason)) changed = true;
      }
    }
    return changed;
  };

  let progress = true;
  while (progress && !conflict) {
    progress = false;
    for (const bi of P.blacks) {
      const br = (bi / cols) | 0, bc = bi % cols;
      const nw = faceAt(br - 1, bc - 1);
      const ne = faceAt(br - 1, bc);
      const sw = faceAt(br, bc - 1);
      const se = faceAt(br, bc);

      // 3a. 3-to-1 diagonal law: relate(nw, se) ^ relate(ne, sw) === 1
      const d1 = relate(nw, se);
      const d2 = relate(ne, sw);
      if (d1 !== -1 && d2 === -1) {
        if (link(ne, sw, d1 ^ 1, { kind: 'blackDiag', cell: bi, sameKnown: d1 === 0, from: [nw, se] })) progress = true;
      } else if (d2 !== -1 && d1 === -1) {
        if (link(nw, se, d2 ^ 1, { kind: 'blackDiag', cell: bi, sameKnown: d2 === 0, from: [ne, sw] })) progress = true;
      } else if (d1 !== -1 && d2 !== -1 && (d1 ^ d2) !== 1) {
        conflict = true;
        break;
      }

      // 3b. Forced 2-step straight legs from proven ON or OFF exits around bi
      for (let d = 0; d < 4; d++) {
        const e1 = P.ed[bi * 4 + d], e2 = P.ed2[bi * 4 + d];
        if (e1 < 0 || e2 < 0) {
          if (forceBlackLeg(bi, d ^ 2)) progress = true;
          continue;
        }
        const [a1, b1] = edgeDualFaces(P, e1);
        const rel1 = relate(a1, b1);
        if (rel1 === 1) {
          if (forceBlackLeg(bi, d)) progress = true;
        } else if (rel1 === 0) {
          if (forceBlackLeg(bi, d ^ 2)) progress = true;
        } else {
          const [a2, b2] = edgeDualFaces(P, e2);
          if (relate(a2, b2) === 0) {
            if (forceBlackLeg(bi, d ^ 2)) progress = true;
          }
        }
      }
      if (conflict) break;
    }
  }

  return { EXT, F, find, relate, adj, conflict };
}

/** Shortest path in `adj` from `src` to `dst`, returning array of { from, to, xor, reason } or null. */
function shortestPath(adj, src, dst) {
  if (src === dst) return [];
  const V = adj.length;
  const prev = new Int32Array(V).fill(-1);
  const prevStep = new Array(V);
  prev[src] = src;
  const q = [src];
  let head = 0;
  while (head < q.length) {
    const u = q[head++];
    if (u === dst) break;
    for (const step of adj[u]) {
      const v = step.to;
      if (prev[v] !== -1) continue;
      prev[v] = u;
      prevStep[v] = { from: u, to: v, xor: step.xor, reason: step.reason };
      q.push(v);
    }
  }
  if (prev[dst] === -1) return null;
  const path = [];
  for (let cur = dst; cur !== src; cur = prev[cur]) path.push(prevStep[cur]);
  path.reverse();
  return path;
}

/**
 * Find all undecided edges forced by Inside/Outside dual-face parity.
 * Returns firings sorted by shortest proof chain (and anchored to EXT first on ties).
 */
export function findFaceParity(P, st) {
  const fp = buildFaceParity(P, st);
  if (fp.conflict || fp.F === 0) return [];
  const { EXT, find, relate, adj } = fp;
  const out = [];

  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0 || st.e[x] !== E_UNKNOWN) continue;
    const [fA, fB] = edgeDualFaces(P, x);
    const rel = relate(fA, fB);
    if (rel === -1) continue;
    const val = rel === 1 ? E_ON : E_OFF;

    const [rootA, parA] = find(fA);
    const anchored = rootA === EXT;

    // Build concise proof steps & involved faces with their 2-coloring for board visualization
    let chains;
    const facesIn = [];
    const facesOut = [];
    const seenFace = new Set();
    const recordFace = (f, par) => {
      if (f === EXT || seenFace.has(f)) return;
      seenFace.add(f);
      if (par === 1) facesIn.push(f);
      else facesOut.push(f);
    };

    if (anchored) {
      const pA = shortestPath(adj, EXT, fA) || [];
      const pB = shortestPath(adj, EXT, fB) || [];
      const direct = shortestPath(adj, fA, fB) || [];
      // If a direct link between fA and fB is much shorter than going through EXT twice, we still show EXT colors
      chains = (pA.length + pB.length <= direct.length + 2) ? [pA, pB] : [pA, direct];
      let curP = 0;
      for (const s of pA) { curP ^= s.xor; recordFace(s.to, curP); }
      curP = 0;
      for (const s of pB) { curP ^= s.xor; recordFace(s.to, curP); }
      recordFace(fA, parA);
      recordFace(fB, parA ^ rel);
    } else {
      const direct = shortestPath(adj, fA, fB) || [];
      chains = [direct];
      let curP = 1; // assign fA -> group A (shown in teal), flip along chain
      recordFace(fA, curP);
      for (const s of direct) { curP ^= s.xor; recordFace(s.to, curP); }
    }

    const hops = chains.reduce((acc, c) => acc + c.length, 0);
    // Collect clue cells cited in the proof chains (for highlighting & explanation)
    const clues = [];
    const seenClue = new Set();
    for (const ch of chains) {
      for (const s of ch) {
        if (s.reason.cell !== undefined && !seenClue.has(s.reason.cell)) {
          seenClue.add(s.reason.cell);
          clues.push(s.reason.cell);
        }
      }
    }

    out.push({
      sets: [['e', x, val]],
      info: {
        edge: x,
        val,
        fA,
        fB,
        EXT,
        anchored,
        parA: anchored ? parA : 1,
        parB: anchored ? (parA ^ rel) : (1 ^ rel),
        chains,
        hops,
        clues,
        facesIn,
        facesOut,
      },
    });
  }

  out.sort((a, b) => (
    a.info.hops - b.info.hops
    || (b.info.anchored ? 1 : 0) - (a.info.anchored ? 1 : 0)
    || a.info.edge - b.info.edge
  ));
  return out;
}
