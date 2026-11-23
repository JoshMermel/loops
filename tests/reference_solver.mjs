// Slow, obviously-correct Masyu reference solver for tiny boards (<= 5x5),
// used only to cross-check js/logic.js.
// Enumerates every simple cycle on the grid by pure vertex-list DFS, completely independent of logic.js's
// edge numbering, propagation, union-find, or checkSolved().

const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]];

function isTurn(a, b, c, cols) {
  const ar = (a / cols) | 0, ac = a % cols;
  const br = (b / cols) | 0, bc = b % cols;
  const cr = (c / cols) | 0, cc = c % cols;
  return (br - ar) !== (cr - br) || (bc - ac) !== (cc - bc);
}

/**
 * Count all valid Masyu solutions for puzzle `p = { rows, cols, clues: [{r, c, t}] }`.
 * Enumerates every undirected simple cycle on the grid and checks Masyu rules directly on the cycle's vertices.
 */
export function referenceCount(p) {
  const { rows, cols, clues } = p;
  const N = rows * cols;
  const clueType = new Map();
  for (const cl of clues) clueType.set(cl.r * cols + cl.c, cl.t);

  // Build plain adjacency list per vertex
  const adj = Array.from({ length: N }, (_, i) => {
    const r = (i / cols) | 0, c = i % cols;
    const out = [];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) out.push(nr * cols + nc);
    }
    return out;
  });

  // If there are clues, the minimum cell index of any valid cycle must be <= the smallest clue cell index.
  let maxStart = N - 1;
  for (const i of clueType.keys()) if (i < maxStart) maxStart = i;

  const visited = new Uint8Array(N);
  const path = [];
  let directedCount = 0;

  const checkCycle = () => {
    const L = path.length;
    if (L < 4) return false;
    // Must visit every clue cell
    for (const ci of clueType.keys()) if (!visited[ci]) return false;
    // Check white and black rules along the cycle
    for (let k = 0; k < L; k++) {
      const cur = path[k];
      const t = clueType.get(cur);
      if (!t) continue;
      const p2 = path[(k - 2 + L) % L];
      const p1 = path[(k - 1 + L) % L];
      const n1 = path[(k + 1) % L];
      const n2 = path[(k + 2) % L];
      const turnHere = isTurn(p1, cur, n1, cols);
      const turnPrev = isTurn(p2, p1, cur, cols);
      const turnNext = isTurn(cur, n1, n2, cols);
      if (t === 'W') {
        if (turnHere) return false;
        if (!turnPrev && !turnNext) return false;
      } else if (t === 'B') {
        if (!turnHere) return false;
        if (turnPrev || turnNext) return false;
      }
    }
    return true;
  };

  for (let start = 0; start <= maxStart; start++) {
    visited[start] = 1;
    path.push(start);
    const dfs = (cur) => {
      for (const nxt of adj[cur]) {
        if (nxt === start) {
          if (path.length >= 4 && checkCycle()) directedCount++;
        } else if (nxt > start && !visited[nxt]) {
          visited[nxt] = 1;
          path.push(nxt);
          dfs(nxt);
          path.pop();
          visited[nxt] = 0;
        }
      }
    };
    dfs(start);
    path.pop();
    visited[start] = 0;
  }

  // Every undirected cycle is traversed twice (clockwise and counterclockwise)
  return directedCount / 2;
}
