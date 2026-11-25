// Live circle error feedback from player edge marks and gray labels alone (never looks at the stored solution).
// Returns an array of 'bad' | '' per clue in P.clues (only broken circles are marked; completion is left to the player).
import { NONE, WHITE, BLACK, GRAY } from './logic.js';

export function clueStates(P, marks) {
  const { ed, ed2, nb } = P;
  const e = marks.edges; // 0 empty, 1 segment, 2 cross
  const grays = marks.grays;

  const seg = (x) => x >= 0 && e[x] === 1;
  const blocked = (x) => x < 0 || e[x] === 2;

  const isBadWhite = (i, dirsOn) => {
    if (dirsOn.length === 2 && ((dirsOn[0] ^ dirsOn[1]) & 1) === 1) return true;
    for (const d of dirsOn) if (blocked(ed[i * 4 + (d ^ 2)])) return true;
    const u = ed[i * 4 + 0], r = ed[i * 4 + 1], dn = ed[i * 4 + 2], l = ed[i * 4 + 3];
    const vBlock = blocked(u) || blocked(dn);
    const hBlock = blocked(r) || blocked(l);
    if (vBlock && hBlock) return true;
    if (dirsOn.length === 2) {
      const [d1, d2] = dirsOn;
      if (seg(ed2[i * 4 + d1]) && seg(ed2[i * 4 + d2])) return true;
    }
    return false;
  };

  const isBadBlack = (i, dirsOn) => {
    if (dirsOn.length === 2 && ((dirsOn[0] ^ dirsOn[1]) & 1) === 0) return true;
    const canDir = (d) => {
      const x1 = ed[i * 4 + d], x2 = ed2[i * 4 + d], n1 = nb[i * 4 + d];
      if (blocked(x1) || blocked(x2)) return false;
      if (seg(ed[n1 * 4 + ((d + 1) & 3)]) || seg(ed[n1 * 4 + ((d + 3) & 3)])) return false;
      return true;
    };
    if ((!canDir(0) && !canDir(2)) || (!canDir(1) && !canDir(3))) return true;
    for (const d of dirsOn) if (!canDir(d)) return true;
    return false;
  };

  return P.clues.map((cl) => {
    const i = cl.r * P.cols + cl.c;
    const dirsOn = [];
    for (let d = 0; d < 4; d++) if (seg(ed[i * 4 + d])) dirsOn.push(d);
    if (dirsOn.length > 2) return 'bad';

    const t = P.clue[i];
    if (t === WHITE) return isBadWhite(i, dirsOn) ? 'bad' : '';
    if (t === BLACK) return isBadBlack(i, dirsOn) ? 'bad' : '';
    if (t === GRAY) {
      const gIdx = P.grayAt ? P.grayAt[i] : -1;
      const lbl = (grays && gIdx >= 0) ? grays[gIdx] : 0;
      if (lbl === WHITE) return isBadWhite(i, dirsOn) ? 'bad' : '';
      if (lbl === BLACK) return isBadBlack(i, dirsOn) ? 'bad' : '';
      return (isBadWhite(i, dirsOn) && isBadBlack(i, dirsOn)) ? 'bad' : '';
    }
    return '';
  });
}

/**
 * Return a Set of edge indices belonging to any closed simple loop that closes early
 * (misses at least one circle, or leaves other drawn segments outside the loop).
 */
export function earlyLoopEdges(P, marks) {
  const bad = new Set();
  const e = marks.edges;
  const deg = new Uint8Array(P.N);
  const parent = new Int32Array(P.N);
  for (let i = 0; i < P.N; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };

  let totalOn = 0;
  for (let x = 0; x < P.numEdges; x++) {
    if (e[x] !== 1) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    totalOn++;
    deg[a]++; deg[b]++;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  if (totalOn === 0) return bad;

  const compEdges = new Map();
  const compClosed = new Map();
  for (let x = 0; x < P.numEdges; x++) {
    if (e[x] !== 1) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    const r = find(a);
    let list = compEdges.get(r);
    if (!list) { list = []; compEdges.set(r, list); compClosed.set(r, true); }
    list.push(x);
    if (deg[a] !== 2 || deg[b] !== 2) compClosed.set(r, false);
  }

  const totalClues = P.clueCells.length;
  const compClues = new Map();
  for (const ci of P.clueCells) {
    if (deg[ci] > 0) {
      const r = find(ci);
      compClues.set(r, (compClues.get(r) || 0) + 1);
    }
  }

  for (const [r, edges] of compEdges) {
    if (!compClosed.get(r)) continue;
    const missesClue = (compClues.get(r) || 0) < totalClues;
    const missesFull = P.fullBoard && edges.length < P.N;
    const hasOtherSegments = edges.length < totalOn;
    if (missesClue || missesFull || hasOtherSegments) {
      for (const x of edges) bad.add(x);
    }
  }
  return bad;
}

/**
 * On full-board puzzles, return a Set of non-clue cell indices that have fewer than 2 non-crossed-out exits left
 * (i.e. trapped / unvisitable intersections, which violate the full-board rule).
 */
export function trappedFullCells(P, marks) {
  const bad = new Set();
  if (!P.fullBoard) return bad;
  const e = marks.edges;
  for (let i = 0; i < P.N; i++) {
    if (P.clue[i] !== NONE) continue;
    let avail = 0;
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && e[x] !== 2) avail++;
    }
    if (avail < 2) bad.add(i);
  }
  return bad;
}
