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
import { WHITE, BLACK, E_UNKNOWN, E_ON, E_OFF } from './logic.js';
import { applySlitherParity } from './variants/slitherlink.js';

/** Convert dual face index (0..F-1) to { r, c } or null for EXT. */
export function faceCoords(P, f) {
  const fr = P.rows - 1, fc = P.cols - 1, F = fr * fc;
  if (f < 0 || f >= F) return null;
  return { r: (f / fc) | 0, c: f % fc };
}

let fpParent = new Int32Array(0);
let fpDiff = new Uint8Array(0);
let fpStack = new Int32Array(0);
let bfsPrev = new Int32Array(0);
let bfsDist = new Int32Array(0);
let bfsQueue = new Int32Array(0);

/**
 * Build the Inside/Outside parity union-find (and optionally proof graph) for state `st`.
 * When `useCircles` is false, only links adjacent faces across known E_ON / E_OFF edges (matching Auto-Shade).
 * When `useCircles` is true, also applies white-circle diagonal flips and black-circle 3-to-1 / forced-leg rules.
 * Returns { EXT, F, find, compress, diff, relate, adj, conflict, edgeFaceA, edgeFaceB }.
 */
/**
 * Build the signed union-find over dual faces (and optional proof graph when `buildGraph: true`).
 * Note: when `buildGraph: false`, the returned closures reference module-level scratch buffers
 * (`fpParent`/`fpDiff`) that are reused by the next fast-mode call — do not retain across calls.
 */
export function buildFaceParity(P, st, { buildGraph = true, useCircles = true, useSlither = false } = {}) {
  const { rows, cols } = P;
  const fr = rows - 1, fc = cols - 1;
  if (fr <= 0 || fc <= 0) {
    return { EXT: 0, F: 0, find: () => [0, 0], relate: () => -1, adj: [], conflict: false };
  }
  const F = fr * fc;
  const EXT = F;
  const V = F + 1;

  const parent = buildGraph ? new Int32Array(V) : (fpParent.length >= V ? fpParent : (fpParent = new Int32Array(V)));
  const diff = buildGraph ? new Uint8Array(V) : (fpDiff.length >= V ? fpDiff : (fpDiff = new Uint8Array(V)));
  if (fpStack.length < V) fpStack = new Int32Array(V);
  for (let i = 0; i < V; i++) { parent[i] = i; diff[i] = 0; }

  // Iterative path-compressing find: compresses u -> root and sets diff[u] = parity(u, root)
  const compress = (u) => {
    let cur = u, sp = 0;
    while (parent[cur] !== cur) {
      fpStack[sp++] = cur;
      cur = parent[cur];
    }
    const root = cur;
    let par = 0;
    for (let i = sp - 1; i >= 0; i--) {
      const node = fpStack[i];
      par ^= diff[node];
      parent[node] = root;
      diff[node] = par;
    }
    return root;
  };

  const find = (u) => {
    const r = compress(u);
    return [r, diff[u]];
  };

  const relate = (u, v) => {
    const ru = compress(u);
    const rv = compress(v);
    if (ru !== rv) return -1;
    return diff[u] ^ diff[v];
  };

  const adj = buildGraph ? Array.from({ length: V }, () => []) : null;
  const edgeSeen = buildGraph ? new Set() : null;
  let conflict = false;

  const link = (u, v, xor, reason) => {
    if (conflict) return false;
    if (u === v) {
      if (xor === 1) conflict = true;
      return false;
    }
    const ru = compress(u);
    const pu = diff[u];
    const rv = compress(v);
    const pv = diff[v];
    if (ru === rv) {
      if ((pu ^ pv) !== xor) { conflict = true; return false; }
      if (buildGraph && (reason.kind === 'edgeOn' || reason.kind === 'edgeOff' || reason.kind === 'whiteDiag')) {
        const key = u < v ? u * V + v : v * V + u;
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          adj[u].push({ to: v, xor, reason });
          adj[v].push({ to: u, xor, reason });
        }
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
    if (buildGraph) {
      const key = u < v ? u * V + v : v * V + u;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        adj[u].push({ to: v, xor, reason });
        adj[v].push({ to: u, xor, reason });
      }
    }
    return true;
  };

  const faceExt = P.hasVoids ? P.faceExterior : null;
  const faceRep = P.hasVoids ? P.faceRep : null;
  const canonFace = (f) => {
    if (f < 0 || f >= F) return EXT;
    if (faceExt) {
      if (faceExt[f]) return EXT;
      return faceRep[f];
    }
    return f;
  };

  const edgeFaceA = (x) => {
    const cell = x >> 1;
    const r = (cell / cols) | 0, c = cell % cols;
    if ((x & 1) === 0) return canonFace(r > 0 && c < fc ? (r - 1) * fc + c : EXT);
    return canonFace(r < fr && c > 0 ? r * fc + (c - 1) : EXT);
  };
  const edgeFaceB = (x) => {
    const cell = x >> 1;
    const r = (cell / cols) | 0, c = cell % cols;
    return canonFace(r < fr && c < fc ? r * fc + c : EXT);
  };

  // 1. Known loop segments (E_ON -> opposite) and crosses (E_OFF -> same)
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    const ev = st.e[x];
    if (ev !== E_ON && ev !== E_OFF) continue;
    const a = edgeFaceA(x), b = edgeFaceB(x);
    link(a, b, ev === E_ON ? 1 : 0, buildGraph ? { kind: ev === E_ON ? 'edgeOn' : 'edgeOff', edge: x } : null);
  }

  const clue = st.clue || P.clue;
  const whites = useCircles ? (st.hasGray ? P.clueCells.filter((i) => clue[i] === WHITE) : P.whites) : [];
  const blacks = useCircles ? (st.hasGray ? P.clueCells.filter((i) => clue[i] === BLACK) : P.blacks) : [];
  const runSlither = Boolean(useSlither && P.hasSlither);

  if (whites.length > 0) {
    // 2. White circles: both diagonal corner pairs have opposite parity
    for (let wi = 0; wi < whites.length; wi++) {
      const cell = whites[wi];
      const wr = (cell / cols) | 0, wc = cell % cols;
      const nw = canonFace(wr > 0 && wc > 0 ? (wr - 1) * fc + (wc - 1) : EXT);
      const ne = canonFace(wr > 0 && wc < fc ? (wr - 1) * fc + wc : EXT);
      const sw = canonFace(wr < fr && wc > 0 ? wr * fc + (wc - 1) : EXT);
      const se = canonFace(wr < fr && wc < fc ? wr * fc + wc : EXT);
      const reason = buildGraph ? { kind: 'whiteDiag', cell } : null;
      link(nw, se, 1, reason);
      link(ne, sw, 1, reason);
    }
  }

  if (blacks.length > 0 || runSlither) {
    // 3. Black circles + Slitherlink face parity: iterate to fixed point so clues cross-pollinate on hybrids
    const forceBlackLeg = (bi, d) => {
      let changed = false;
      const e1 = P.ed[bi * 4 + d], e2 = P.ed2[bi * 4 + d], n1 = P.nb[bi * 4 + d];
      if (e1 < 0 || e2 < 0 || n1 < 0) { conflict = true; return false; }
      const reason = buildGraph ? { kind: 'blackLeg', cell: bi, dir: d } : null;
      if (link(edgeFaceA(e1), edgeFaceB(e1), 1, reason)) changed = true;
      if (link(edgeFaceA(e2), edgeFaceB(e2), 1, reason)) changed = true;
      const opp = P.ed[bi * 4 + (d ^ 2)];
      if (opp >= 0 && link(edgeFaceA(opp), edgeFaceB(opp), 0, reason)) changed = true;
      const ep1 = P.ed[n1 * 4 + ((d + 1) & 3)];
      if (ep1 >= 0 && link(edgeFaceA(ep1), edgeFaceB(ep1), 0, reason)) changed = true;
      const ep2 = P.ed[n1 * 4 + ((d + 3) & 3)];
      if (ep2 >= 0 && link(edgeFaceA(ep2), edgeFaceB(ep2), 0, reason)) changed = true;
      return changed;
    };

    const slitherCtx = runSlither ? {
      EXT,
      canonFace,
      relate,
      link: (u, v, xor, reason) => link(u, v, xor, buildGraph ? reason : null),
      hasConflict: () => conflict,
      markConflict: () => { conflict = true; },
    } : null;

    let progress = true;
    while (progress && !conflict) {
      progress = false;
      if (runSlither && applySlitherParity(P, st, slitherCtx)) progress = true;
      if (conflict) break;
      for (let k = 0; k < blacks.length; k++) {
        const bi = blacks[k];
        const br = (bi / cols) | 0, bc = bi % cols;
        const nw = canonFace(br > 0 && bc > 0 ? (br - 1) * fc + (bc - 1) : EXT);
        const ne = canonFace(br > 0 && bc < fc ? (br - 1) * fc + bc : EXT);
        const sw = canonFace(br < fr && bc > 0 ? br * fc + (bc - 1) : EXT);
        const se = canonFace(br < fr && bc < fc ? br * fc + bc : EXT);

        // 3a. 3-to-1 diagonal law: relate(nw, se) ^ relate(ne, sw) === 1
        const d1 = relate(nw, se);
        const d2 = relate(ne, sw);
        if (d1 !== -1 && d2 === -1) {
          if (link(ne, sw, d1 ^ 1, buildGraph ? { kind: 'blackDiag', cell: bi, sameKnown: d1 === 0, from: [nw, se] } : null)) progress = true;
        } else if (d2 !== -1 && d1 === -1) {
          if (link(nw, se, d2 ^ 1, buildGraph ? { kind: 'blackDiag', cell: bi, sameKnown: d2 === 0, from: [ne, sw] } : null)) progress = true;
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
          const rel1 = relate(edgeFaceA(e1), edgeFaceB(e1));
          if (rel1 === 1) {
            if (forceBlackLeg(bi, d)) progress = true;
          } else if (rel1 === 0) {
            if (forceBlackLeg(bi, d ^ 2)) progress = true;
          } else if (relate(edgeFaceA(e2), edgeFaceB(e2)) === 0) {
            if (forceBlackLeg(bi, d ^ 2)) progress = true;
          }
        }
        if (conflict) break;
      }
    }
  }

  return { EXT, F, find, compress, diff, relate, adj, conflict, edgeFaceA, edgeFaceB };
}

/** Build a single BFS shortest-path tree from `src`. */
function bfsTree(adj, src) {
  const V = adj.length;
  const prev = new Int32Array(V).fill(-1);
  const prevStep = new Array(V);
  prev[src] = src;
  const q = new Int32Array(V);
  let head = 0, tail = 0;
  q[tail++] = src;
  while (head < tail) {
    const u = q[head++];
    const list = adj[u];
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const v = step.to;
      if (prev[v] !== -1) continue;
      prev[v] = u;
      prevStep[v] = { from: u, to: v, xor: step.xor, reason: step.reason };
      q[tail++] = v;
    }
  }
  return { prev, prevStep };
}

function extractPath(tree, src, dst) {
  if (src === dst) return [];
  if (tree.prev[dst] === -1) return null;
  const path = [];
  for (let cur = dst; cur !== src; cur = tree.prev[cur]) path.push(tree.prevStep[cur]);
  path.reverse();
  return path;
}

/** Shortest path in `adj` from `src` to `dst` with optional `maxDepth` cutoff. */
function shortestPath(adj, src, dst, maxDepth = Infinity) {
  if (src === dst) return [];
  if (maxDepth < 1) return null;
  const V = adj.length;
  if (bfsPrev.length < V) {
    bfsPrev = new Int32Array(V);
    bfsDist = new Int32Array(V);
    bfsQueue = new Int32Array(V);
  }
  bfsPrev.fill(-1, 0, V);
  const prevStep = new Array(V);
  bfsPrev[src] = src;
  bfsDist[src] = 0;
  let head = 0, tail = 0;
  bfsQueue[tail++] = src;
  while (head < tail) {
    const u = bfsQueue[head++];
    if (u === dst) break;
    const du = bfsDist[u];
    if (du >= maxDepth) continue;
    const list = adj[u];
    for (let i = 0; i < list.length; i++) {
      const step = list[i];
      const v = step.to;
      if (bfsPrev[v] !== -1) continue;
      bfsPrev[v] = u;
      bfsDist[v] = du + 1;
      prevStep[v] = { from: u, to: v, xor: step.xor, reason: step.reason };
      if (v === dst) { head = tail; break; }
      bfsQueue[tail++] = v;
    }
  }
  if (bfsPrev[dst] === -1) return null;
  const path = [];
  for (let cur = dst; cur !== src; cur = bfsPrev[cur]) path.push(prevStep[cur]);
  path.reverse();
  return path;
}

/**
 * Shared finder for Inside/Outside dual-face parity.
 * - `useCircles: false, anchoredOnly: true` -> `findFaceShade` (exact match to Auto-Shade: border-anchored lines & X's only)
 * - `useCircles: true, anchoredOnly: false` -> `findFaceCircle` (full white-diagonal, black 3-to-1, and relative Side A/B parity)
 */
function findFaceParityCore(P, st, opts, { useCircles, useSlither = false, anchoredOnly }) {
  const fast = !!(opts && opts.fast);
  const fp = buildFaceParity(P, st, { buildGraph: !fast, useCircles, useSlither });
  if (fp.conflict || fp.F === 0) return [];
  const { EXT, compress, diff, relate, adj, edgeFaceA, edgeFaceB } = fp;

  if (fast) {
    const out = [];
    for (let x = 0; x < P.numEdges; x++) {
      if (P.edgeA[x] < 0 || st.e[x] !== E_UNKNOWN) continue;
      const fA = edgeFaceA(x), fB = edgeFaceB(x);
      const rel = relate(fA, fB);
      if (rel === -1) continue;
      if (anchoredOnly && compress(fA) !== EXT) continue;
      out.push({ sets: [['e', x, rel === 1 ? E_ON : E_OFF]], info: { edge: x, val: rel === 1 ? E_ON : E_OFF } });
    }
    return out;
  }

  // First collect forced edges so we skip BFS completely when nothing is forced
  const hits = [];
  let anyAnchored = false;
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0 || st.e[x] !== E_UNKNOWN) continue;
    const fA = edgeFaceA(x), fB = edgeFaceB(x);
    const rel = relate(fA, fB);
    if (rel === -1) continue;
    const rootA = compress(fA);
    const parA = diff[fA];
    const anchored = rootA === EXT;
    if (anchoredOnly && !anchored) continue;
    if (anchored) anyAnchored = true;
    hits.push({ x, fA, fB, rel, anchored, parA });
  }
  if (!hits.length) return [];

  // One single BFS from EXT serves ALL anchored edges
  const extTree = anyAnchored ? bfsTree(adj, EXT) : null;
  const out = [];

  for (let hi = 0; hi < hits.length; hi++) {
    const { x, fA, fB, rel, anchored, parA } = hits[hi];
    const val = rel === 1 ? E_ON : E_OFF;

    let chains;
    const facesIn = [];
    const facesOut = [];
    const seenFace = new Set();
    const recordFace = (f, par) => {
      if (f === EXT || seenFace.has(f)) return;
      seenFace.add(f);
      const hid = P.hasVoids && P.faceHoleId ? P.faceHoleId[f] : -1;
      if (hid >= 0) {
        for (const hf of P.holeList[hid]) {
          seenFace.add(hf);
          if (par === 1) facesIn.push(hf);
          else facesOut.push(hf);
        }
        return;
      }
      if (par === 1) facesIn.push(f);
      else facesOut.push(f);
    };

    if (anchored) {
      const pA = extractPath(extTree, EXT, fA) || [];
      const pB = extractPath(extTree, EXT, fB) || [];
      const [near, far, pNear, pFar, parNear] = pA.length <= pB.length
        ? [fA, fB, pA, pB, parA]
        : [fB, fA, pB, pA, parA ^ rel];
      const direct = pFar.length > 1 ? shortestPath(adj, near, far, pFar.length - 1) : null;
      chains = direct ? [pNear, direct] : [pA, pB];
      let curP = 0;
      for (const s of pNear) { curP ^= s.xor; recordFace(s.to, curP); }
      if (direct) {
        curP = parNear;
        recordFace(near, parNear);
        for (const s of direct) { curP ^= s.xor; recordFace(s.to, curP); }
      } else {
        curP = 0;
        for (const s of pFar) { curP ^= s.xor; recordFace(s.to, curP); }
      }
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
        shadeOnly: !useCircles,
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

/** Basic Auto-Shade parity: edges flanked by two border-anchored squares already shaded via lines & X's. */
export function findFaceShade(P, st, opts = null) {
  return findFaceParityCore(P, st, opts, { useCircles: false, anchoredOnly: true });
}

/** Advanced circle/relative Inside/Outside parity: includes white diagonals, black 3-to-1 corners, and unanchored chains. */
export function findFaceCircle(P, st, opts = null) {
  return findFaceParityCore(P, st, opts, { useCircles: true, useSlither: false, anchoredOnly: false });
}

/** Slitherlink (and hybrid Slitherlink+Masyu) Inside/Outside parity across numbered faces and circles. */
export function findFaceSlither(P, st, opts = null) {
  if (!P.hasSlither) return [];
  return findFaceParityCore(P, st, opts, { useCircles: true, useSlither: true, anchoredOnly: false });
}
