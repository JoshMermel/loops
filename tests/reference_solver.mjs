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
  const { rows, cols, clues = [], slither = [], midloop = [], castle = [], fullBoard = false, givens = [], voids = [] } = p;
  const N = rows * cols;
  const voidSet = new Set([...voids.map((v) => v.r * cols + v.c), ...castle.map((cw) => cw.r * cols + cw.c)]);
  const activeCount = N - voidSet.size;
  const clueType = new Map();
  for (const cl of clues) clueType.set(cl.r * cols + cl.c, cl.t);
  const reqEdges = new Set();
  const banEdges = new Set();
  const edgeKey = (a, b) => (a < b ? a * N + b : b * N + a);
  for (const gv of givens) {
    const a = gv.r * cols + gv.c;
    const b = gv.dir === 'H' ? a + 1 : a + cols;
    if (gv.v === 1) reqEdges.add(edgeKey(a, b));
    else banEdges.add(edgeKey(a, b));
  }
  const midVerts = new Set();
  const midEdges = new Set();
  for (const md of midloop) {
    if (md.dir === 'C') midVerts.add(md.r * cols + md.c);
    else {
      const a = md.r * cols + md.c;
      const b = md.dir === 'H' ? a + 1 : a + cols;
      midEdges.add(edgeKey(a, b));
      reqEdges.add(edgeKey(a, b));
    }
  }

  // Build plain adjacency list per vertex (skipping voids and banned given walls)
  const adj = Array.from({ length: N }, (_, i) => {
    if (voidSet.has(i)) return [];
    const r = (i / cols) | 0, c = i % cols;
    const out = [];
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) {
        const j = nr * cols + nc;
        if (!voidSet.has(j) && !banEdges.has(edgeKey(i, j))) out.push(j);
      }
    }
    return out;
  });

  // If fullBoard, any cycle must start at the first active cell; else min cell index <= smallest clue cell index.
  let firstActive = 0;
  while (firstActive < N && voidSet.has(firstActive)) firstActive++;
  if (firstActive >= N) return 0;
  let maxStart = fullBoard ? firstActive : N - 1;
  if (!fullBoard) for (const i of clueType.keys()) if (i < maxStart) maxStart = i;

  const visited = new Uint8Array(N);
  const path = [];
  let directedCount = 0;

  const checkCycle = () => {
    const L = path.length;
    if (L < 4) return false;
    if (fullBoard && L !== activeCount) return false;
    // Must visit every clue cell and Mid-loop vertex dot
    for (const ci of clueType.keys()) if (!visited[ci]) return false;
    for (const mi of midVerts) if (!visited[mi]) return false;
    // Must include every required given edge (and Mid-loop edge dot)
    let cycEdges = null;
    if (reqEdges.size > 0 || slither.length > 0 || castle.length > 0) {
      cycEdges = new Set();
      for (let k = 0; k < L; k++) cycEdges.add(edgeKey(path[k], path[(k + 1) % L]));
      if (reqEdges.size > 0) {
        for (const rk of reqEdges) if (!cycEdges.has(rk)) return false;
      }
    }
    // Check Mid-loop dots independently by measuring straight runs along the cycle vertex list
    if (midloop.length > 0) {
      const turnIdx = [];
      for (let k = 0; k < L; k++) {
        if (isTurn(path[(k - 1 + L) % L], path[k], path[(k + 1) % L], cols)) turnIdx.push(k);
      }
      const exactVertMids = new Set();
      const exactEdgeMids = new Set();
      for (let ti = 0; ti < turnIdx.length; ti++) {
        const s = turnIdx[ti];
        const eIdx = turnIdx[(ti + 1) % turnIdx.length];
        const runLen = (eIdx - s + L) % L;
        if ((runLen & 1) === 0) {
          exactVertMids.add(path[(s + (runLen >> 1)) % L]);
        } else {
          const half = runLen >> 1;
          exactEdgeMids.add(edgeKey(path[(s + half) % L], path[(s + half + 1) % L]));
        }
      }
      for (const mv of midVerts) if (!exactVertMids.has(mv)) return false;
      for (const me of midEdges) if (!exactEdgeMids.has(me)) return false;
    }
    // Check Castle Wall arrow counts & point-in-polygon W/B parity completely independently (ray-casting!)
    if (castle.length > 0) {
      for (const cw of castle) {
        if (cw.dir) {
          const dr = cw.dir === 'U' ? -1 : cw.dir === 'D' ? 1 : 0;
          const dc = cw.dir === 'R' ? 1 : cw.dir === 'L' ? -1 : 0;
          let cnt = 0;
          let rr = cw.r + dr, cc = cw.c + dc;
          while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
            const nr = rr + dr, nc = cc + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) break;
            if (cycEdges.has(edgeKey(rr * cols + cc, nr * cols + nc))) cnt++;
            rr = nr; cc = nc;
          }
          if (cnt !== cw.n) return false;
        }
        if (cw.wall === 'W' || cw.wall === 'B') {
          // Independent Jordan-curve ray-casting from (cw.r + 0.25, cw.c + 0.25) toward +x:
          // a vertical loop segment (rr, cc)-(rr+1, cc) crosses y = cw.r + 0.25 iff rr === cw.r && cc > cw.c.
          let crossings = 0;
          if (cw.r < rows - 1) {
            for (let cc = cw.c + 1; cc < cols; cc++) {
              if (cycEdges.has(edgeKey(cw.r * cols + cc, (cw.r + 1) * cols + cc))) crossings++;
            }
          }
          const inside = (crossings & 1) === 1;
          if ((cw.wall === 'W') !== inside) return false;
        }
      }
    }

    // Check Slitherlink face numbers independently
    for (const sc of slither) {
      const a = sc.r * cols + sc.c;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      let cnt = 0;
      if (cycEdges.has(edgeKey(a, b))) cnt++;
      if (cycEdges.has(edgeKey(b, d))) cnt++;
      if (cycEdges.has(edgeKey(c, d))) cnt++;
      if (cycEdges.has(edgeKey(a, c))) cnt++;
      if (cnt !== sc.n) return false;
    }
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
      } else if (t === 'G') {
        const okW = !turnHere && (turnPrev || turnNext);
        const okB = turnHere && !turnPrev && !turnNext;
        if (!okW && !okB) return false;
      }
    }
    return true;
  };

  for (let start = firstActive; start <= maxStart; start++) {
    if (voidSet.has(start)) continue;
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
