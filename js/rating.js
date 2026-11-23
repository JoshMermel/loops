// Human-style Masyu scorer and rule table (pure logic, no DOM).
// The same RULES table drives both puzzle difficulty rating and the Hint button.
//
// Each step applies the cheapest applicable rule and never looks at the stored solution.
// A puzzle's `tier` is the tier of the hardest rule it needed; its `score` is the sum of step costs
// (+100 per undecided cell if the rules get stuck, which makes it Expert, "beyond the hints").
import {
  NONE, WHITE, BLACK, UNKNOWN, OFF, LOOP, E_UNKNOWN, E_ON, E_OFF,
  initialState, cloneState, isSolved,
} from './logic.js';
import { bestImagine, setFullContradiction, easyContradiction, MEDIUM_MAX } from './imagine.js';
import { findFaceParity } from './faceparity.js';

export const TIERS = ['Beginner', 'Medium', 'Hard', 'Expert'];

export const TIER_INFO = {
  Beginner: { name: 'Beginner', blurb: 'straight white circles, black circles turning and going two straight, rows of adjacent white circles, dead ends, forced exits, and not closing the loop early' },
  Medium: { name: 'Medium', blurb: 'blocked turns, inside/outside parity, small pockets and chokepoints, and short 1–2 step imagined chains' },
  Hard: { name: 'Hard', blurb: 'rectangle parity, large-area parity and chokepoints, and 3+ step imagined chains (pure logic, no trial and error)' },
  Expert: { name: 'Expert', blurb: 'full multi-rule trial and error (trying an edge and following all rules to a contradiction), or beyond what Hint can explain' },
};

export const beyondHints = (puzzle) => puzzle.rules === 'unsolved';
export const UNDETERMINED_WEIGHT = 100;

// ------------------------------------------------------------ helpers

export function onCount(P, st, i) {
  let n = 0;
  for (let d = 0; d < 4; d++) { const x = P.ed[i * 4 + d]; if (x >= 0 && st.e[x] === E_ON) n++; }
  return n;
}

export function availCount(P, st, i) {
  let n = 0;
  for (let d = 0; d < 4; d++) {
    const x = P.ed[i * 4 + d];
    if (x < 0 || st.e[x] === E_OFF) continue;
    const j = P.nb[i * 4 + d];
    if (st.cell[j] === OFF) continue;
    if (st.e[x] !== E_ON && onCount(P, st, j) >= 2) continue;
    n++;
  }
  return n;
}

/** Apply [['c'|'e', idx, val], ...]. Returns false on conflict. */
export function applySets(st, sets) {
  for (const [kind, idx, v] of sets) {
    const arr = kind === 'c' ? st.cell : st.e;
    if (arr[idx] === v) continue;
    if (arr[idx] !== 0) return false;
    arr[idx] = v;
  }
  return true;
}

/** Union-find over E_ON edges. Returns { find, size, loopCount, cycleRoot, cycleCount }. */
function onComponents(P, st) {
  const { N, numEdges, edgeA, edgeB } = P;
  const parent = new Int16Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let cycleRoot = -1, cycleCount = 0;
  for (let x = 0; x < numEdges; x++) {
    if (st.e[x] !== E_ON) continue;
    const ra = find(edgeA[x]), rb = find(edgeB[x]);
    if (ra === rb) { cycleRoot = ra; cycleCount++; } else parent[ra] = rb;
  }
  const size = new Int32Array(N);
  let loopCount = 0;
  for (let i = 0; i < N; i++) {
    if (st.cell[i] === LOOP) { size[find(i)]++; loopCount++; }
  }
  return { find, size, loopCount, cycleRoot: cycleRoot >= 0 ? find(cycleRoot) : -1, cycleCount };
}

let scratchOnc = new Int8Array(0);
let scratchSeen = new Uint8Array(0);
let scratchIsLoop = new Uint8Array(0);
let scratchTin = new Int32Array(0);
let scratchLow = new Int32Array(0);
let scratchSubLoop = new Int32Array(0);
let scratchSubSize = new Int32Array(0);
let scratchSeen2 = new Uint8Array(0);
let scratchStack = new Int32Array(0);

function ensureRatingScratch(N) {
  if (scratchOnc.length >= N) return;
  scratchOnc = new Int8Array(N);
  scratchSeen = new Uint8Array(N);
  scratchIsLoop = new Uint8Array(N);
  scratchTin = new Int32Array(N);
  scratchLow = new Int32Array(N);
  scratchSubLoop = new Int32Array(N);
  scratchSubSize = new Int32Array(N);
  scratchSeen2 = new Uint8Array(N);
  scratchStack = new Int32Array(N);
}

/**
 * Connected components of needy cells (cell !== OFF && on < 2) linked by E_UNKNOWN edges.
 * Every future segment adds 1 to the degree of two cells in the same group, so each group must hold
 * an EVEN number of open ends (cells with on === 1).
 */
function openEndGroups(P, st) {
  const { N, ed, nb } = P;
  ensureRatingScratch(N);
  const onc = scratchOnc;
  const seen = scratchSeen;
  const stack = scratchStack;
  onc.fill(0, 0, N);
  seen.fill(0, 0, N);
  for (let x = 0; x < P.numEdges; x++) if (st.e[x] === E_ON) { onc[P.edgeA[x]]++; onc[P.edgeB[x]]++; }
  const groups = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || st.cell[i] === OFF || onc[i] >= 2) continue;
    seen[i] = 1;
    let sp = 0;
    stack[sp++] = i;
    const cells = [], ends = [];
    while (sp > 0) {
      const u = stack[--sp];
      cells.push(u);
      if (onc[u] === 1) ends.push(u);
      for (let d = 0; d < 4; d++) {
        const x = ed[u * 4 + d];
        if (x < 0 || st.e[x] !== E_UNKNOWN) continue;
        const v = nb[u * 4 + d];
        if (seen[v] || st.cell[v] === OFF || onc[v] >= 2) continue;
        seen[v] = 1;
        stack[sp++] = v;
      }
    }
    groups.push({ cells, ends });
  }
  return groups;
}

/** Smallest group with an odd number of open ends, or null if every group is even. */
export function oddOpenEnds(P, st) {
  let best = null;
  for (const g of openEndGroups(P, st)) {
    if ((g.ends.length & 1) === 1) {
      if (!best || g.cells.length < best.cells.length) best = g;
    }
  }
  return best;
}

/**
 * Check connectivity and 2-vertex-connectivity (chokepoints) of LOOP cells in the active graph
 * (edges that are E_ON or E_UNKNOWN, skipping edges incident to OFF cells or full cells except their E_ON edges).
 * Returns null if OK, or { kind: 'disconnected'|'cutVertex', cut?, area: [cells] }.
 */
export function chokepointCheck(P, st, boolOnly = false) {
  const { N, ed, nb } = P;
  ensureRatingScratch(N);
  const onc = scratchOnc;
  const isLoop = scratchIsLoop;
  onc.fill(0, 0, N);
  isLoop.fill(0, 0, N);
  for (let x = 0; x < P.numEdges; x++) if (st.e[x] === E_ON) { onc[P.edgeA[x]]++; onc[P.edgeB[x]]++; }

  let firstLoop = -1, totalLoops = 0;
  for (let i = 0; i < N; i++) if (st.cell[i] === LOOP) { if (firstLoop < 0) firstLoop = i; totalLoops++; isLoop[i] = 1; }
  if (totalLoops < 2) return null;

  const activeEdge = (u, d) => {
    const x = ed[u * 4 + d];
    if (x < 0 || st.e[x] === E_OFF) return false;
    if (st.e[x] === E_ON) return true;
    const v = nb[u * 4 + d];
    return st.cell[u] !== OFF && st.cell[v] !== OFF && onc[u] < 2 && onc[v] < 2;
  };

  // 1. Connectivity of all LOOP cells
  const vis = scratchSeen;
  const stack = scratchStack;
  vis.fill(0, 0, N);
  let sp = 0;
  stack[sp++] = firstLoop;
  vis[firstLoop] = 1;
  let seenLoops = 1;
  let comp0Size = 1;
  while (sp > 0) {
    const u = stack[--sp];
    for (let d = 0; d < 4; d++) {
      if (!activeEdge(u, d)) continue;
      const v = nb[u * 4 + d];
      if (!vis[v]) {
        vis[v] = 1;
        stack[sp++] = v;
        comp0Size++;
        if (isLoop[v]) seenLoops++;
      }
    }
  }
  if (seenLoops < totalLoops) {
    if (boolOnly) return { kind: 'disconnected', area: [] };
    const comp0 = [], other = [];
    for (let i = 0; i < N; i++) {
      if (vis[i]) comp0.push(i);
      else if (st.cell[i] !== OFF) other.push(i);
    }
    return { kind: 'disconnected', area: comp0.length <= other.length ? comp0 : other };
  }

  // 2. Tarjan's articulation points + subtree loop counts on the connected component of firstLoop
  const tin = scratchTin;
  const low = scratchLow;
  const subLoop = scratchSubLoop;
  const subSize = scratchSubSize;
  tin.fill(-1, 0, N);
  let timer = 0;
  let bestCut = null;

  const dfs = (u, p) => {
    tin[u] = low[u] = timer++;
    subLoop[u] = isLoop[u];
    subSize[u] = 1;
    let childWithLoop = 0;
    let smallAreaSize = N;
    for (let d = 0; d < 4; d++) {
      if (!activeEdge(u, d)) continue;
      const v = nb[u * 4 + d];
      if (v === p) continue;
      if (tin[v] >= 0) {
        if (tin[v] < low[u]) low[u] = tin[v];
      } else {
        dfs(v, u);
        if (boolOnly && bestCut) return;
        subLoop[u] += subLoop[v];
        subSize[u] += subSize[v];
        if (low[v] < low[u]) low[u] = low[v];
        if (p < 0) {
          if (subLoop[v] > 0) {
            childWithLoop++;
            if (subSize[v] < smallAreaSize) smallAreaSize = subSize[v];
          }
        } else if (low[v] >= tin[u] && subLoop[v] > 0) {
          const outsideLoops = totalLoops - subLoop[v] - isLoop[u];
          if (outsideLoops > 0) {
            const sideSize = Math.min(subSize[v], comp0Size - 1 - subSize[v]);
            if (!bestCut || sideSize < bestCut.areaSize) {
              bestCut = { kind: 'cutVertex', cut: u, seed: v, areaSize: sideSize };
              if (boolOnly) return;
            }
          }
        }
      }
    }
    if (p < 0 && childWithLoop >= 2) {
      if (!bestCut || smallAreaSize < bestCut.areaSize) {
        bestCut = { kind: 'cutVertex', cut: u, seed: -1, areaSize: smallAreaSize };
      }
    }
  };
  dfs(firstLoop, -1);
  if (!bestCut) return null;
  if (boolOnly) return { kind: 'cutVertex', cut: bestCut.cut, area: [] };

  // Collect the smaller separated area cells (excluding cut)
  const cut = bestCut.cut;
  const seen2 = scratchSeen2;
  seen2.fill(0, 0, N);
  seen2[cut] = 1;
  let smallestArea = null;
  for (let d = 0; d < 4; d++) {
    if (!activeEdge(cut, d)) continue;
    const start = nb[cut * 4 + d];
    if (seen2[start]) continue;
    seen2[start] = 1;
    let qsp = 0;
    stack[qsp++] = start;
    const area = [];
    let hasL = false;
    while (qsp > 0) {
      const u = stack[--qsp];
      area.push(u);
      if (isLoop[u]) hasL = true;
      for (let dd = 0; dd < 4; dd++) {
        if (!activeEdge(u, dd)) continue;
        const v = nb[u * 4 + dd];
        if (!seen2[v]) { seen2[v] = 1; stack[qsp++] = v; }
      }
    }
    if (hasL && (!smallestArea || area.length < smallestArea.length)) smallestArea = area;
  }
  return { kind: 'cutVertex', cut, area: smallestArea || [] };
}

/** Full contradiction check: easy contradictions + odd open-end parity + disconnected/chokepoint loop cells. */
export function contradiction(P, st, skipEasy = false) {
  if (!skipEasy && easyContradiction(P, st)) return true;
  if (oddOpenEnds(P, st)) return true;
  if (chokepointCheck(P, st, true)) return true;
  return false;
}

setFullContradiction(contradiction);

// ------------------------------------------------------------ rule finders

function findEdgesOffCellOff(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== OFF) continue;
    const sets = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { cell: i } });
  }
  return out;
}

function findEdgeEnds(P, st) {
  const out = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_ON) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    const sets = [];
    if (st.cell[a] === UNKNOWN) sets.push(['c', a, LOOP]);
    if (st.cell[b] === UNKNOWN) sets.push(['c', b, LOOP]);
    if (sets.length) out.push({ sets, info: { edge: x } });
  }
  return out;
}

function findFullCell(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (onCount(P, st, i) !== 2) continue;
    const sets = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
    }
    if (sets.length) out.push({ sets, info: { cell: i } });
  }
  return out;
}

function findIsolatedCellOff(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    let hasOpen = false;
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] !== E_OFF) { hasOpen = true; break; }
    }
    if (!hasOpen) out.push({ sets: [['c', i, OFF]], info: { cell: i } });
  }
  return out;
}

function findClosedLoopRestOff(P, st) {
  if (!isSolved(P, st.e)) return [];
  const sets = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] === UNKNOWN) sets.push(['c', i, OFF]);
  }
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) sets.push(['e', x, E_OFF]);
  }
  return sets.length ? [{ sets, info: {} }] : [];
}

function findWhiteStraight(P, st) {
  const out = [];
  for (const i of P.whites) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    let vOk = u >= 0 && dn >= 0 && st.e[u] !== E_OFF && st.e[dn] !== E_OFF;
    let hOk = r >= 0 && l >= 0 && st.e[r] !== E_OFF && st.e[l] !== E_OFF;
    if ((r >= 0 && st.e[r] === E_ON) || (l >= 0 && st.e[l] === E_ON)) vOk = false;
    if ((u >= 0 && st.e[u] === E_ON) || (dn >= 0 && st.e[dn] === E_ON)) hOk = false;
    if (vOk && !hOk) {
      const sets = [];
      if (st.e[u] === E_UNKNOWN) sets.push(['e', u, E_ON]);
      if (st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_ON]);
      if (r >= 0 && st.e[r] === E_UNKNOWN) sets.push(['e', r, E_OFF]);
      if (l >= 0 && st.e[l] === E_UNKNOWN) sets.push(['e', l, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'v' } });
    } else if (hOk && !vOk) {
      const sets = [];
      if (st.e[r] === E_UNKNOWN) sets.push(['e', r, E_ON]);
      if (st.e[l] === E_UNKNOWN) sets.push(['e', l, E_ON]);
      if (u >= 0 && st.e[u] === E_UNKNOWN) sets.push(['e', u, E_OFF]);
      if (dn >= 0 && st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'h' } });
    }
  }
  return out;
}

function findBlackExtend(P, st) {
  const out = [];
  for (const i of P.blacks) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d];
      if (x1 < 0 || st.e[x1] !== E_ON) continue;
      const x2 = P.ed2[i * 4 + d], opp = P.ed[i * 4 + (d ^ 2)];
      const sets = [];
      if (x2 >= 0 && st.e[x2] === E_UNKNOWN) sets.push(['e', x2, E_ON]);
      if (opp >= 0 && st.e[opp] === E_UNKNOWN) sets.push(['e', opp, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, dir: d } });
    }
  }
  return out;
}

function findBlackWall(P, st) {
  const out = [];
  for (const i of P.blacks) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n1 = P.nb[i * 4 + d], n2 = P.step2[i * 4 + d];
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const blocked = x1 < 0 || x2 < 0 || st.e[x1] === E_OFF || st.e[x2] === E_OFF || st.cell[n1] === OFF || st.cell[n2] === OFF;
      if (!blocked) continue;
      const sets = [];
      if (x1 >= 0 && st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, dir: d ^ 2, blockedDir: d, nearEdge: x1 < 0 || x2 < 0 } });
    }
  }
  return out;
}

function findBlackAdjacent(P, st) {
  const out = [];
  for (const i of P.blacks) {
    for (let d = 0; d < 4; d++) {
      const n1 = P.nb[i * 4 + d];
      if (n1 < 0 || P.clue[n1] !== BLACK) continue;
      const x1 = P.ed[i * 4 + d], opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, other: n1, dir: d ^ 2 } });
    }
  }
  return out;
}

function findWhiteMustTurn(P, st) {
  const out = [];
  for (const i of P.whites) {
    for (const [d1, d2] of [[0, 2], [1, 3]]) {
      const e1 = P.ed[i * 4 + d1], e2 = P.ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || st.e[e1] !== E_ON || st.e[e2] !== E_ON) continue;
      const ext1 = P.ed2[i * 4 + d1], ext2 = P.ed2[i * 4 + d2];
      if (ext1 >= 0 && st.e[ext1] === E_ON && ext2 >= 0 && st.e[ext2] === E_UNKNOWN) {
        out.push({ sets: [['e', ext2, E_OFF]], info: { cell: i, straightEnd: P.nb[i * 4 + d1], turnEnd: P.nb[i * 4 + d2], edge: ext2 } });
      }
      if (ext2 >= 0 && st.e[ext2] === E_ON && ext1 >= 0 && st.e[ext1] === E_UNKNOWN) {
        out.push({ sets: [['e', ext1, E_OFF]], info: { cell: i, straightEnd: P.nb[i * 4 + d2], turnEnd: P.nb[i * 4 + d1], edge: ext1 } });
      }
    }
  }
  return out;
}

function findDeadEnd(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    if (availCount(P, st, i) < 2) {
      const edgeSets = [];
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d];
        if (x >= 0 && st.e[x] === E_UNKNOWN) edgeSets.push(['e', x, E_OFF]);
      }
      if (edgeSets.length) out.push({ sets: [['c', i, OFF], ...edgeSets], info: { cell: i } });
    }
  }
  return out;
}

function findForcedExits(P, st) {
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== LOOP) continue;
    let on = 0;
    const open = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x < 0) continue;
      if (st.e[x] === E_ON) on++;
      else if (st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) open.push(x);
    }
    if (open.length > 0 && on + open.length === 2) {
      out.push({ sets: open.map((x) => ['e', x, E_ON]), info: { cell: i, edges: open } });
    }
  }
  return out;
}

function findBlackPerp(P, st) {
  const out = [];
  for (const i of P.blacks) {
    for (let d = 0; d < 4; d++) {
      const n1 = P.nb[i * 4 + d], x1 = P.ed[i * 4 + d];
      if (n1 < 0 || x1 < 0) continue;
      const p1 = P.ed[n1 * 4 + ((d + 1) & 3)], p2 = P.ed[n1 * 4 + ((d + 3) & 3)];
      if (!((p1 >= 0 && st.e[p1] === E_ON) || (p2 >= 0 && st.e[p2] === E_ON))) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, sideCell: n1, dir: d ^ 2 } });
    }
  }
  return out;
}

function findWhiteBothStraight(P, st) {
  const out = [];
  for (const i of P.whites) {
    const u = P.ed[i * 4 + 0], r = P.ed[i * 4 + 1], dn = P.ed[i * 4 + 2], l = P.ed[i * 4 + 3];
    const u2 = P.ed2[i * 4 + 0], r2 = P.ed2[i * 4 + 1], d2 = P.ed2[i * 4 + 2], l2 = P.ed2[i * 4 + 3];
    if (u2 >= 0 && st.e[u2] === E_ON && d2 >= 0 && st.e[d2] === E_ON && r >= 0 && l >= 0) {
      const sets = [];
      if (st.e[r] === E_UNKNOWN) sets.push(['e', r, E_ON]);
      if (st.e[l] === E_UNKNOWN) sets.push(['e', l, E_ON]);
      if (u >= 0 && st.e[u] === E_UNKNOWN) sets.push(['e', u, E_OFF]);
      if (dn >= 0 && st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'h', blockedAxis: 'v' } });
    }
    if (r2 >= 0 && st.e[r2] === E_ON && l2 >= 0 && st.e[l2] === E_ON && u >= 0 && dn >= 0) {
      const sets = [];
      if (st.e[u] === E_UNKNOWN) sets.push(['e', u, E_ON]);
      if (st.e[dn] === E_UNKNOWN) sets.push(['e', dn, E_ON]);
      if (r >= 0 && st.e[r] === E_UNKNOWN) sets.push(['e', r, E_OFF]);
      if (l >= 0 && st.e[l] === E_UNKNOWN) sets.push(['e', l, E_OFF]);
      if (sets.length) out.push({ sets, info: { cell: i, axis: 'v', blockedAxis: 'h' } });
    }
  }
  return out;
}

function findNoEarlyClose(P, st) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    const ra = find(a);
    if (ra === find(b) && size[ra] < loopCount) {
      out.push({ sets: [['e', x, E_OFF]], info: { edge: x, a, b } });
    }
  }
  return out;
}

function findSamePathExits(P, st) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== LOOP || onCount(P, st, i) !== 0) continue;
    const exits = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) exits.push([x, P.nb[i * 4 + d]]);
    }
    if (exits.length !== 3) continue;
    for (const [p, q, r] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
      const ra = find(exits[p][1]), rb = find(exits[q][1]);
      if (ra === rb && size[ra] >= 2 && size[ra] + 1 < loopCount) {
        out.push({ sets: [['e', exits[r][0], E_ON]], info: { cell: i, a: exits[p][1], b: exits[q][1], edge: exits[r][0] } });
        break;
      }
    }
  }
  return out;
}

function findClosingCell(P, st) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (let i = 0; i < P.N; i++) {
    if (st.cell[i] !== UNKNOWN) continue;
    const exits = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d];
      if (x >= 0 && st.e[x] === E_UNKNOWN && st.cell[P.nb[i * 4 + d]] !== OFF) exits.push([x, P.nb[i * 4 + d]]);
    }
    if (exits.length !== 2) continue;
    const ra = find(exits[0][1]), rb = find(exits[1][1]);
    if (ra === rb && size[ra] >= 2 && size[ra] < loopCount) {
      out.push({
        sets: [['c', i, OFF], ['e', exits[0][0], E_OFF], ['e', exits[1][0], E_OFF]],
        info: { cell: i, a: exits[0][1], b: exits[1][1] },
      });
    }
  }
  return out;
}

function findThreeWhites(P, st) {
  const out = [];
  for (const mid of P.whites) {
    for (const [d1, d2, p1, p2] of [[1, 3, 0, 2], [0, 2, 1, 3]]) {
      const a = P.nb[mid * 4 + d1], b = P.nb[mid * 4 + d2];
      if (a < 0 || b < 0 || P.clue[a] !== WHITE || P.clue[b] !== WHITE) continue;
      // All three must cross along (p1, p2)
      const sets = [];
      for (const c of [a, mid, b]) {
        const ep1 = P.ed[c * 4 + p1], ep2 = P.ed[c * 4 + p2];
        const ed1 = P.ed[c * 4 + d1], ed2 = P.ed[c * 4 + d2];
        if (ep1 >= 0 && st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (ep2 >= 0 && st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
        if (ed1 >= 0 && st.e[ed1] === E_UNKNOWN) sets.push(['e', ed1, E_OFF]);
        if (ed2 >= 0 && st.e[ed2] === E_UNKNOWN) sets.push(['e', ed2, E_OFF]);
      }
      if (sets.length) out.push({ sets, info: { cells: [a, mid, b], axis: p1 === 0 ? 'v' : 'h' } });
    }
  }
  return out;
}

function findTwoWhitesStraight(P, st) {
  const out = [];
  for (const w1 of P.whites) {
    for (let d = 0; d < 4; d++) {
      const w2 = P.nb[w1 * 4 + d];
      if (w2 < 0 || P.clue[w2] !== WHITE) continue;
      // If edge continuing straight past w1 (opposite side from w2) is ON, w1 and w2 cannot connect along d
      const far = P.ed2[w1 * 4 + (d ^ 2)];
      if (far < 0 || st.e[far] !== E_ON) continue;
      const p1 = (d + 1) & 3, p2 = (d + 3) & 3;
      const sets = [];
      for (const c of [w1, w2]) {
        const ep1 = P.ed[c * 4 + p1], ep2 = P.ed[c * 4 + p2];
        const ea = P.ed[c * 4 + d], eb = P.ed[c * 4 + (d ^ 2)];
        if (ep1 >= 0 && st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (ep2 >= 0 && st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
        if (ea >= 0 && st.e[ea] === E_UNKNOWN) sets.push(['e', ea, E_OFF]);
        if (eb >= 0 && st.e[eb] === E_UNKNOWN) sets.push(['e', eb, E_OFF]);
      }
      if (sets.length) out.push({ sets, info: { w1, w2, farEdge: far, axis: p1 === 0 || p2 === 0 ? 'v' : 'h' } });
    }
  }
  return out;
}

/** Can cell `n` turn 90° if entered from direction `d` (moving along `d`)? False if forced straight! */
function forcedStraightAt(P, st, i, d) {
  const n = P.nb[i * 4 + d];
  if (n < 0) return false;
  const ext = P.ed[n * 4 + d];
  if (ext >= 0 && st.e[ext] === E_ON) return true;
  if (P.clue[n] === WHITE) return true;
  const p1 = P.ed[n * 4 + ((d + 1) & 3)], p2 = P.ed[n * 4 + ((d + 3) & 3)];
  const can1 = p1 >= 0 && st.e[p1] !== E_OFF && st.cell[P.nb[n * 4 + ((d + 1) & 3)]] !== OFF;
  const can2 = p2 >= 0 && st.e[p2] !== E_OFF && st.cell[P.nb[n * 4 + ((d + 3) & 3)]] !== OFF;
  return !can1 && !can2;
}

function findWhiteNoTurnAxis(P, st) {
  const out = [];
  for (const i of P.whites) {
    for (const [d1, d2, p1, p2] of [[0, 2, 1, 3], [1, 3, 0, 2]]) {
      const e1 = P.ed[i * 4 + d1], e2 = P.ed[i * 4 + d2];
      if (e1 < 0 || e2 < 0 || st.e[e1] === E_OFF || st.e[e2] === E_OFF) continue;
      if (forcedStraightAt(P, st, i, d1) && forcedStraightAt(P, st, i, d2)) {
        const ep1 = P.ed[i * 4 + p1], ep2 = P.ed[i * 4 + p2];
        if (ep1 < 0 || ep2 < 0) continue;
        const sets = [];
        if (st.e[ep1] === E_UNKNOWN) sets.push(['e', ep1, E_ON]);
        if (st.e[ep2] === E_UNKNOWN) sets.push(['e', ep2, E_ON]);
        if (st.e[e1] === E_UNKNOWN) sets.push(['e', e1, E_OFF]);
        if (st.e[e2] === E_UNKNOWN) sets.push(['e', e2, E_OFF]);
        if (sets.length) {
          out.push({ sets, info: { cell: i, ends: [P.nb[i * 4 + d1], P.nb[i * 4 + d2]], axis: p1 === 0 ? 'v' : 'h' } });
        }
      }
    }
  }
  return out;
}

function findBlackBlockedTarget(P, st) {
  const out = [];
  for (const i of P.blacks) {
    for (let d = 0; d < 4; d++) {
      const x1 = P.ed[i * 4 + d], x2 = P.ed2[i * 4 + d], n2 = P.step2[i * 4 + d];
      if (x1 < 0 || x2 < 0 || n2 < 0 || st.e[x1] === E_OFF || st.e[x2] === E_OFF) continue;
      let bad = false, reason = '';
      if (P.clue[n2] === WHITE) {
        const nextE = P.ed[n2 * 4 + d];
        if (nextE < 0 || st.e[nextE] === E_OFF) { bad = true; reason = 'whiteWall'; }
      } else if (P.clue[n2] === BLACK) {
        const nextE = P.ed[n2 * 4 + d];
        if (nextE >= 0 && st.e[nextE] === E_ON) { bad = true; reason = 'blackStraight'; }
      }
      if (!bad) continue;
      const opp1 = P.ed[i * 4 + (d ^ 2)], opp2 = P.ed2[i * 4 + (d ^ 2)];
      if (opp1 < 0 || opp2 < 0) continue;
      const sets = [];
      if (st.e[x1] === E_UNKNOWN) sets.push(['e', x1, E_OFF]);
      if (st.e[opp1] === E_UNKNOWN) sets.push(['e', opp1, E_ON]);
      if (st.e[opp2] === E_UNKNOWN) sets.push(['e', opp2, E_ON]);
      if (sets.length) out.push({ sets, info: { cell: i, target: n2, dir: d ^ 2, reason } });
    }
  }
  return out;
}

function findTwoEndsJoin(P, st) {
  const { find, size, loopCount, cycleRoot } = onComponents(P, st);
  if (cycleRoot >= 0) return [];
  const out = [];
  for (const g of openEndGroups(P, st)) {
    if (g.ends.length !== 2) continue;
    const [u, v] = g.ends;
    const ru = find(u), rv = find(v);
    if (ru === rv) continue; // already same path (contradiction handled elsewhere)
    // Count distinct LOOP cells in path(u) U path(v) U g.cells
    const inArea = new Set(g.cells);
    let covered = size[ru] + size[rv];
    for (const c of g.cells) if (st.cell[c] === LOOP && find(c) !== ru && find(c) !== rv) covered++;
    if (covered >= loopCount) continue; // joining their far ends wouldn't leave any LOOP cell outside
    // Find the far ends of path(u) and path(v)
    const farEnd = (start, root) => {
      for (let i = 0; i < P.N; i++) {
        if (i !== start && st.cell[i] === LOOP && find(i) === root && onCount(P, st, i) === 1) return i;
      }
      return -1;
    };
    const uFar = farEnd(u, ru), vFar = farEnd(v, rv);
    if (uFar < 0 || vFar < 0) continue;
    // If there is an undecided edge directly between uFar and vFar (and outside g), it cannot be ON
    for (let d = 0; d < 4; d++) {
      if (P.nb[uFar * 4 + d] === vFar) {
        const x = P.ed[uFar * 4 + d];
        if (x >= 0 && st.e[x] === E_UNKNOWN && !(inArea.has(uFar) && inArea.has(vFar))) {
          out.push({ sets: [['e', x, E_OFF]], info: { edge: x, u, v, uFar, vFar, area: g.cells } });
        }
      }
    }
  }
  return out;
}

function findChokepoint(smallOnly) {
  return (P, st) => {
    const out = [];
    const onc = new Int8Array(P.N);
    for (let x = 0; x < P.numEdges; x++) if (st.e[x] === E_ON) { onc[P.edgeA[x]]++; onc[P.edgeB[x]]++; }
    const s2 = cloneState(st);
    for (let x = 0; x < P.numEdges; x++) {
      if (st.e[x] !== E_UNKNOWN) continue;
      const a = P.edgeA[x], b = P.edgeB[x];
      if (a < 0) continue;
      // Inactive edges don't participate in chokepointCheck's active graph
      if (st.cell[a] === OFF || st.cell[b] === OFF || onc[a] >= 2 || onc[b] >= 2) continue;
      s2.e[x] = E_OFF;
      const ck = chokepointCheck(P, s2);
      s2.e[x] = E_UNKNOWN;
      if (!ck) continue;
      const small = ck.area.length <= 12;
      if (small !== smallOnly) continue;
      out.push({ sets: [['e', x, E_ON]], info: { edge: x, kind: ck.kind, cut: ck.cut, area: ck.area } });
    }
    out.sort((p, q) => p.info.area.length - q.info.area.length);
    return out;
  };
}

function findParity(smallOnly) {
  return (P, st) => {
    const out = [];
    const s2 = cloneState(st);
    for (let x = 0; x < P.numEdges; x++) {
      if (st.e[x] !== E_UNKNOWN) continue;
      const a = P.edgeA[x], b = P.edgeB[x];
      if (a < 0) continue;
      if (st.cell[a] === OFF || st.cell[b] === OFF) continue;
      for (const tryVal of [E_ON, E_OFF]) {
        s2.e[x] = tryVal;
        const easy = easyContradiction(P, s2);
        const odd = easy ? null : oddOpenEnds(P, s2);
        s2.e[x] = E_UNKNOWN;
        if (!odd) continue;
        const small = odd.ends.length <= 3 && odd.cells.length <= 9;
        if (small !== smallOnly) continue;
        out.push({
          sets: [['e', x, tryVal === E_ON ? E_OFF : E_ON]],
          info: { edge: x, hyp: tryVal, ends: odd.ends, area: odd.cells },
        });
      }
    }
    out.sort((p, q) => p.info.area.length - q.info.area.length);
    return out;
  };
}

let cpVOn = new Int16Array(0);
let cpVUnk = new Int16Array(0);
let cpHOn = new Int16Array(0);
let cpHUnk = new Int16Array(0);

function findCrossingParity(P, st) {
  const { rows, cols, ed } = P;
  const W = cols + 1, H = rows + 1;
  const vSize = rows * W, hSize = cols * H;
  if (cpVOn.length < vSize) { cpVOn = new Int16Array(vSize); cpVUnk = new Int16Array(vSize); }
  if (cpHOn.length < hSize) { cpHOn = new Int16Array(hSize); cpHUnk = new Int16Array(hSize); }

  // Vertical boundary prefix sums: row r (1..rows-1) holds edges between row r-1 and row r
  for (let r = 1; r < rows; r++) {
    const base = r * W;
    let sOn = 0, sUnk = 0;
    cpVOn[base] = 0;
    cpVUnk[base] = 0;
    for (let c = 0; c < cols; c++) {
      const ev = st.e[ed[(r * cols + c) * 4 + 0]];
      if (ev === E_ON) sOn++;
      else if (ev === E_UNKNOWN) sUnk++;
      cpVOn[base + c + 1] = sOn;
      cpVUnk[base + c + 1] = sUnk;
    }
  }
  // Horizontal boundary prefix sums: col c (1..cols-1) holds edges between col c-1 and col c
  for (let c = 1; c < cols; c++) {
    const base = c * H;
    let sOn = 0, sUnk = 0;
    cpHOn[base] = 0;
    cpHUnk[base] = 0;
    for (let r = 0; r < rows; r++) {
      const ev = st.e[ed[(r * cols + c) * 4 + 3]];
      if (ev === E_ON) sOn++;
      else if (ev === E_UNKNOWN) sUnk++;
      cpHOn[base + r + 1] = sOn;
      cpHUnk[base + r + 1] = sUnk;
    }
  }

  const seen = new Set();
  const out = [];
  const checkRect = (r1, r2, c1, c2) => {
    const topUnk = r1 > 0 ? cpVUnk[r1 * W + c2 + 1] - cpVUnk[r1 * W + c1] : 0;
    if (topUnk > 1) return;
    const botUnk = r2 < rows - 1 ? cpVUnk[(r2 + 1) * W + c2 + 1] - cpVUnk[(r2 + 1) * W + c1] : 0;
    if (topUnk + botUnk > 1) return;
    const leftUnk = c1 > 0 ? cpHUnk[c1 * H + r2 + 1] - cpHUnk[c1 * H + r1] : 0;
    if (topUnk + botUnk + leftUnk > 1) return;
    const rightUnk = c2 < cols - 1 ? cpHUnk[(c2 + 1) * H + r2 + 1] - cpHUnk[(c2 + 1) * H + r1] : 0;
    if (topUnk + botUnk + leftUnk + rightUnk !== 1) return;

    let lastX = -1;
    if (topUnk === 1) {
      for (let c = c1; c <= c2; c++) { const x = ed[(r1 * cols + c) * 4 + 0]; if (st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else if (botUnk === 1) {
      for (let c = c1; c <= c2; c++) { const x = ed[(r2 * cols + c) * 4 + 2]; if (st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else if (leftUnk === 1) {
      for (let r = r1; r <= r2; r++) { const x = ed[(r * cols + c1) * 4 + 3]; if (st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    } else {
      for (let r = r1; r <= r2; r++) { const x = ed[(r * cols + c2) * 4 + 1]; if (st.e[x] === E_UNKNOWN) { lastX = x; break; } }
    }
    if (lastX < 0 || seen.has(lastX)) return;
    seen.add(lastX);

    const on = (r1 > 0 ? cpVOn[r1 * W + c2 + 1] - cpVOn[r1 * W + c1] : 0)
      + (r2 < rows - 1 ? cpVOn[(r2 + 1) * W + c2 + 1] - cpVOn[(r2 + 1) * W + c1] : 0)
      + (c1 > 0 ? cpHOn[c1 * H + r2 + 1] - cpHOn[c1 * H + r1] : 0)
      + (c2 < cols - 1 ? cpHOn[(c2 + 1) * H + r2 + 1] - cpHOn[(c2 + 1) * H + r1] : 0);
    const val = (on & 1) ? E_ON : E_OFF;
    const area = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) area.push(r * cols + c);
    out.push({ sets: [['e', lastX, val]], info: { edge: lastX, val, rect: [r1, r2, c1, c2], on, area } });
  };

  // 1. Row cuts and column cuts (cheapest to see)
  for (let r = 0; r < rows - 1; r++) checkRect(0, r, 0, cols - 1);
  for (let c = 0; c < cols - 1; c++) checkRect(0, rows - 1, 0, c);
  // 2. Corner-anchored quadrants
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    checkRect(0, r, 0, c);
    checkRect(0, r, c + 1, cols - 1);
    checkRect(r + 1, rows - 1, 0, c);
    checkRect(r + 1, rows - 1, c + 1, cols - 1);
  }
  // 3. Small rectangles up to 4x4
  for (let r1 = 0; r1 < rows; r1++) {
    for (let c1 = 0; c1 < cols; c1++) {
      for (let h = 1; h <= 4 && r1 + h <= rows; h++) {
        for (let w = 1; w <= 4 && c1 + w <= cols; w++) {
          if (h === 1 && w === 1) continue; // single cell is just forcedExits / deadEnd
          checkRect(r1, r1 + h - 1, c1, c1 + w - 1);
        }
      }
    }
  }
  return out;
}

function findTryEdge(P, st, { upto }) {
  // Prefer edges touching LOOP cells first, then any undecided edge
  const edges = [];
  for (let x = 0; x < P.numEdges; x++) {
    if (st.e[x] !== E_UNKNOWN) continue;
    const a = P.edgeA[x], b = P.edgeB[x];
    if (a < 0) continue;
    if (st.cell[a] === LOOP || st.cell[b] === LOOP) edges.push(x);
  }
  if (!edges.length) {
    for (let x = 0; x < P.numEdges; x++) if (st.e[x] === E_UNKNOWN && P.edgeA[x] >= 0) edges.push(x);
  }
  let best = null;
  for (const x of edges) {
    for (const val of [E_ON, E_OFF]) {
      const s2 = cloneState(st);
      s2.e[x] = val;
      const r = closure(P, s2, upto);
      if (r.contradiction) {
        const cand = {
          sets: [['e', x, val === E_ON ? E_OFF : E_ON]],
          info: { edge: x, hyp: val, steps: r.steps, trace: r.trace },
        };
        if (!best || r.steps < best.info.steps) best = cand;
        if (r.steps <= 2) return [best];
      }
    }
  }
  return best ? [best] : [];
}

// ------------------------------------------------------------ rule table

const extraFaceParity = (P, st, f) => Math.max(0, (f.info.hops || 1) - 3) * 2;
const extraParity = (P, st, f) => Math.max(0, (f.info.ends ? f.info.ends.length : 0) - 3) * 2;
const extraTrial = (P, st, f) => (f.info.steps || 0) * 2;

function imagineFind(P, st) {
  const f = bestImagine(P, st);
  return f ? [imagineFiring(f)] : [];
}

function imagineFiring(f) {
  return {
    sets: [['e', f.edge, f.deduce]],
    info: {
      edge: f.edge,
      hyp: f.hyp,
      deduce: f.deduce,
      cost: f.cost,
      area: f.area,
      steps: f.steps,
      broke: f.broke,
      forbid: f.forbid,
    },
  };
}

function imagineStep(f) {
  const tier = f.cost <= MEDIUM_MAX ? 'Medium' : 'Hard';
  return { rule: tier === 'Medium' ? 'imagine' : 'imagineLong', tier, weight: f.cost, firings: [imagineFiring(f)] };
}

function defRule(r) {
  // Expose both `id`/`name`, `weight`/`cost`, and `find`/`apply` for clean interoperability
  return {
    ...r,
    name: r.id,
    cost: r.weight,
    apply: r.find,
  };
}

export const RULES = [
  // Bookkeeping (cost 1, applied silently before each step, charged once per step where they fire)
  defRule({ id: 'edgesOffCellOff', tier: 'Beginner', weight: 1, free: true, find: findEdgesOffCellOff, label: 'a segment touching an off-loop cell is off' }),
  defRule({ id: 'edgeEnds', tier: 'Beginner', weight: 1, free: true, find: findEdgeEnds, label: 'a segment puts both of its cells on the loop' }),
  defRule({ id: 'fullCell', tier: 'Beginner', weight: 1, free: true, find: findFullCell, label: 'a cell with two segments takes no more' }),
  defRule({ id: 'isolatedCellOff', tier: 'Beginner', weight: 1, free: true, find: findIsolatedCellOff, label: 'a cell with all its edges off is not on the loop' }),
  defRule({ id: 'closedLoopRestOff', tier: 'Beginner', weight: 1, free: true, find: findClosedLoopRestOff, label: 'once the single loop is closed, all remaining cells are off the loop' }),

  // Beginner
  defRule({ id: 'whiteStraight', tier: 'Beginner', weight: 2, find: findWhiteStraight, label: 'a white circle blocked on one axis goes straight along the other' }),
  defRule({ id: 'blackExtend', tier: 'Beginner', weight: 2, find: findBlackExtend, label: 'a black circle continues straight two cells from an existing segment and turns away from the opposite side' }),
  defRule({ id: 'blackWall', tier: 'Beginner', weight: 2, find: findBlackWall, label: 'a black circle blocked within two cells of a wall or cross must extend two cells the opposite way' }),
  defRule({ id: 'blackAdjacent', tier: 'Beginner', weight: 3, find: findBlackAdjacent, label: 'two touching black circles cannot connect, so each extends two cells away from the other' }),
  defRule({ id: 'whiteMustTurn', tier: 'Beginner', weight: 3, find: findWhiteMustTurn, label: 'a white circle that goes straight at one end must turn at the other' }),
  defRule({ id: 'deadEnd', tier: 'Beginner', weight: 4, find: findDeadEnd, label: 'an empty cell with fewer than two exits left cannot be on the loop' }),
  defRule({ id: 'forcedExits', tier: 'Beginner', weight: 4, find: findForcedExits, label: 'a loop cell with only two exits left must use both' }),
  defRule({ id: 'blackPerp', tier: 'Beginner', weight: 5, find: findBlackPerp, label: 'a black circle cannot enter a neighbor that already has a perpendicular segment' }),
  defRule({ id: 'whiteBothStraight', tier: 'Beginner', weight: 5, find: findWhiteBothStraight, label: 'a white circle cannot use an axis where both neighbors already continue straight' }),
  defRule({ id: 'noEarlyClose', tier: 'Beginner', weight: 6, find: findNoEarlyClose, label: 'a segment joining the two ends of one path would close the loop early' }),
  defRule({ id: 'samePathExits', tier: 'Beginner', weight: 7, find: findSamePathExits, label: 'a loop cell with three exits where two meet one path must use the third' }),
  defRule({ id: 'closingCell', tier: 'Beginner', weight: 7, find: findClosingCell, label: 'an empty cell whose only two exits meet one path cannot be on the loop' }),
  defRule({ id: 'threeWhites', tier: 'Beginner', weight: 8, find: findThreeWhites, label: 'three white circles in a row must all cross perpendicular to the row' }),
  defRule({ id: 'twoWhitesStraight', tier: 'Beginner', weight: 9, find: findTwoWhitesStraight, label: 'two touching white circles with a straight segment entering one cannot connect, so both cross perpendicular' }),

  // Medium
  defRule({ id: 'whiteNoTurnAxis', tier: 'Medium', weight: 12, find: findWhiteNoTurnAxis, label: 'a white circle cannot use an axis whose two neighbors are both unable to turn' }),
  defRule({ id: 'blackBlockedTarget', tier: 'Medium', weight: 13, find: findBlackBlockedTarget, label: 'a black circle cannot extend toward a circle two cells away that cannot accept a straight segment' }),
  defRule({ id: 'faceParity', tier: 'Medium', weight: 16, find: findFaceParity, extra: extraFaceParity, label: 'inside/outside square coloring (across lines, crosses, white diagonals, and black 3-to-1 corners) forces an edge' }),
  defRule({ id: 'twoEndsJoin', tier: 'Medium', weight: 20, find: findTwoEndsJoin, label: 'a sealed area with just two open ends must connect them, so their far ends cannot join early' }),
  defRule({ id: 'chokepoint', tier: 'Medium', weight: 22, costly: true, find: findChokepoint(true), label: 'blocking this segment would cut off a small area or leave a single chokepoint cell' }),
  defRule({ id: 'parityPocket', tier: 'Medium', weight: 26, costly: true, find: findParity(true), label: 'the other choice would seal off a small pocket with an odd number of open ends' }),

  // Hard
  defRule({ id: 'crossingParity', tier: 'Hard', weight: 55, find: findCrossingParity, label: 'the loop crosses the border of any rectangle or band an even number of times' }),
  defRule({ id: 'chokepointArea', tier: 'Hard', weight: 60, costly: true, find: findChokepoint(false), label: 'blocking this segment would cut off a large area or leave a single chokepoint cell' }),
  defRule({ id: 'parityForces', tier: 'Hard', weight: 65, costly: true, find: findParity(false), extra: extraParity, label: 'the other choice would seal off an area with an odd number of open ends' }),
  // Expert
  defRule({ id: 'tryEdge', tier: 'Expert', weight: 120, lookahead: true, find: findTryEdge, extra: extraTrial, label: 'trying a segment one way leads to a contradiction' }),

  // Unified imagine rule (priced dynamically per pruned chain, slotted into HUMAN_ORDER by cost)
  defRule({ id: 'imagine', tier: 'Medium', weight: MEDIUM_MAX, virtual: true, costly: true, find: imagineFind, label: 'imagine a segment on or off and follow the easy rules: within a few steps something breaks' }),
  defRule({ id: 'imagineLong', tier: 'Hard', weight: 64, virtual: true, costly: true, find: imagineFind, label: 'imagine a segment on or off and follow the easy rules through a long chain until something breaks' }),
];

export const HUMAN_ORDER = RULES
  .map((r, i) => [r, i])
  .filter(([r]) => !r.free && !r.virtual)
  .sort((a, b) => a[0].weight - b[0].weight || a[1] - b[1])
  .map(([r]) => r);

export const FIRST_LOOKAHEAD = RULES.findIndex((r) => r.lookahead);
export const RULE_IDS = RULES.map((r) => r.id);
export const tierOfRule = (id) => (id === 'unsolved' ? 'Expert' : RULES.find((r) => r.id === id).tier);
export const ruleLabel = (id) => (id === 'unsolved' ? 'none of the current rules finishes it' : RULES.find((r) => r.id === id).label);

// ------------------------------------------------------------ closure / stepping / rating

const IMAGINE_AFTER = 13; // rules priced <= 13 run before searching imagined chains

/** Apply all non-costly rules below `upto` until fixed point or contradiction. Mutates `st`. */
export function closure(P, st, upto = FIRST_LOOKAHEAD) {
  const allowed = Array.isArray(upto) ? new Set(upto) : null;
  let steps = 0;
  const trace = [];
  for (let guard = 0; guard < 5000; guard++) {
    if (contradiction(P, st)) return { contradiction: true, steps, trace };
    let fired = false;
    for (let r = 0; r < (allowed ? RULES.length : upto); r++) {
      const rule = RULES[r];
      if (allowed && !(rule.free || allowed.has(rule.id))) continue;
      if (!allowed && rule.costly) continue;
      const fs = rule.find(P, st, { upto: r, fast: true });
      if (!fs.length) continue;
      for (const f of fs) {
        if (!applySets(st, f.sets)) return { contradiction: true, steps, trace };
        if (!rule.free && trace.length < 16) trace.push({ rule: rule.id, sets: f.sets, info: f.info });
      }
      if (!rule.free) steps++;
      fired = true;
      break;
    }
    if (!fired) return { contradiction: false, steps, trace };
  }
  return { contradiction: false, steps, trace };
}

/**
 * Find the cheapest applicable rule in `st`, returning { rule, tier, weight, firings } or null.
 * Applies silent bookkeeping to `st` first (recording any active bookkeeping rules in `bookkeeping`).
 */
export function nextSteps(P, st, bookkeeping = null, without = null) {
  for (;;) {
    let any = false;
    for (const r of RULES) {
      if (!r.free) continue;
      let changed = false;
      for (const f of r.find(P, st, {})) {
        if (applySets(st, f.sets)) { any = true; changed = true; }
        else return null;
      }
      if (changed && bookkeeping) bookkeeping[r.id] = true;
    }
    if (!any) break;
  }
  const noImagine = !!without && (without.includes('imagine') || without.includes('imagineLong'));
  let found;
  let foundCap = 0;
  const imagined = (costCap = Infinity) => {
    if (noImagine) return null;
    if (found === undefined || (found === null && costCap > foundCap)) {
      found = bestImagine(P, st, { costCap });
      foundCap = costCap;
    }
    return found;
  };

  for (const rule of HUMAN_ORDER) {
    if (without && without.includes(rule.id)) continue;
    // For costly / lookahead rules (weight > 20), run imagine FIRST so a cheaper imagine skips them entirely.
    // For cheap Medium rules (faceParity [16], twoEndsJoin [20]), check the cheap rule first so when it fires
    // we can pass its exact `ruleCost` as `costCap` to bestImagine (skipping expensive area/long-chain search!).
    if (rule.weight > 20) {
      const f = imagined(Infinity);
      if (f && rule.weight > f.cost) return imagineStep(f);
    }
    const firings = rule.find(P, st, { upto: FIRST_LOOKAHEAD });
    if (firings.length) {
      if (rule.weight > IMAGINE_AFTER) {
        const ruleCost = rule.weight + (rule.extra ? rule.extra(P, st, firings[0]) : 0);
        const f = imagined(ruleCost);
        if (f && f.cost < ruleCost) return imagineStep(f);
      }
      return { rule: rule.id, tier: rule.tier, weight: rule.weight, firings };
    }
  }
  const f = imagined(Infinity);
  return f ? imagineStep(f) : null;
}

export function nextStep(P, st, bookkeeping = null, without = null) {
  const r = nextSteps(P, st, bookkeeping, without);
  if (!r) return null;
  const rule = RULES[RULE_IDS.indexOf(r.rule)];
  const f = r.firings[0];
  const extra = rule.extra ? rule.extra(P, st, f) : 0;
  return { rule: r.rule, tier: r.tier, weight: r.weight, extra, sets: f.sets, info: f.info };
}

/** Fully decided? Either a complete valid loop is drawn (all remaining cells off) or every edge is decided. */
export function isComplete(P, st) {
  if (isSolved(P, st.e)) return true;
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] >= 0 && st.e[x] === E_UNKNOWN) return false;
  }
  return true;
}

/**
 * Solve like a human. Never looks at P.solution.
 * Returns { solved, rules, tier, score, steps, counts, state }.
 */
export function rate(P, { without = null } = {}) {
  const st = initialState(P);
  const steps = [];
  const counts = {};

  for (let guard = 0; guard < 3000; guard++) {
    if (isSolved(P, st.e)) break;
    if (contradiction(P, st)) break;
    const bk = {};
    const step = nextStep(P, st, bk, without);
    for (const id of Object.keys(bk)) {
      const rule = RULES.find((q) => q.id === id);
      steps.push({ rule: id, tier: rule.tier, weight: rule.weight, sets: [], info: { bookkeeping: true } });
      counts[id] = (counts[id] || 0) + 1;
    }
    if (!step) break;
    if (!applySets(st, step.sets)) break;
    steps.push(step);
    counts[step.rule] = (counts[step.rule] || 0) + 1;
  }

  // Final tidy bookkeeping (e.g. closedLoopRestOff)
  const finalBk = {};
  nextStep(P, st, finalBk, without);
  for (const id of Object.keys(finalBk)) {
    const rule = RULES.find((q) => q.id === id);
    steps.push({ rule: id, tier: rule.tier, weight: rule.weight, sets: [], info: { bookkeeping: true } });
    counts[id] = (counts[id] || 0) + 1;
  }

  const solved = isSolved(P, st.e);
  let hardest = 'unsolved';
  if (solved) {
    const rank = (s) => {
      const idx = RULE_IDS.indexOf(s.rule);
      const tIdx = TIERS.indexOf(s.tier);
      return tIdx * 100000 + (s.weight + (s.extra || 0)) * 100 + idx;
    };
    const nonFree = steps.filter((s) => !RULES[RULE_IDS.indexOf(s.rule)].free);
    const pool = nonFree.length ? nonFree : steps;
    hardest = pool.length ? pool.reduce((best, s) => (rank(s) > rank(best) ? s : best), pool[0]).rule : 'whiteStraight';
  }

  // Count undecided cells (cells with at least one undecided incident edge, or UNKNOWN cell state)
  let unknown = 0;
  if (!solved) {
    for (let i = 0; i < P.N; i++) {
      let hasUnk = st.cell[i] === UNKNOWN;
      if (!hasUnk) {
        for (let d = 0; d < 4; d++) {
          const x = P.ed[i * 4 + d];
          if (x >= 0 && st.e[x] === E_UNKNOWN) { hasUnk = true; break; }
        }
      }
      if (hasUnk) unknown++;
    }
  }

  const score = steps.reduce((a, s) => a + s.weight + (s.extra || 0), 0) + (solved ? 0 : unknown * UNDETERMINED_WEIGHT);
  return { solved, rules: hardest, tier: tierOfRule(hardest), score, steps, counts, state: st };
}

export function ratePuzzle(P) {
  const r = rate(P);
  P.rules = r.rules; P.tier = r.tier; P.score = r.score;
  return r;
}

export const compareRatings = (a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.score - b.score;

/**
 * Sound rule solvability check (fast, excludes costly/lookahead rules by default).
 * Because every rule below FIRST_LOOKAHEAD is sound, a puzzle they solve is guaranteed to have a unique solution.
 */
export function solvedByRules(P, upto = FIRST_LOOKAHEAD) {
  const st = initialState(P);
  const r = closure(P, st, upto);
  return { solved: !r.contradiction && isSolved(P, st.e), state: st, steps: r.steps };
}
