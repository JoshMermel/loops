// SVG Masyu board renderer and pointer gestures (intersection-grid layout).
//
// Coordinates: intersection (r, c) sits at (PAD + c*S, PAD + r*S). Grid tracks connect adjacent
// intersections; circles sit on intersections; drawn segments and small ✕ marks sit directly on tracks;
// dual squares sit between tracks and can be shaded Inside / Outside as a solving aid.
//
// Gestures (purely geometric):
//   * tap a grid track                -> handlers.onEdgeTap(edgeIdx)                   (cycle empty -> line -> ✕ -> empty)
//   * drag across intersections       -> handlers.onStep(fromNode, toNode, isFirst)    (draw/erase loop segments)
//   * right-click a grid track        -> handlers.onEdgeRight(edgeIdx)                 (toggle ✕ directly)
//   * right-drag across intersections -> handlers.onCrossStep(fromNode, toNode, first) (swipe-place/erase ✕)
//   * tap a square center             -> handlers.onFaceTap(faceIdx)                   (cycle blank -> Inside -> Outside -> blank)
//   * right-click a square center     -> handlers.onFaceRight(faceIdx)                 (cycle blank -> Outside -> Inside -> blank)
//   * tap a gray circle               -> handlers.onCellTap(cellIdx)                   (cycle gray -> white -> black -> gray)
//   * right-click a gray circle       -> handlers.onCellRight(cellIdx)                 (cycle gray -> black -> white -> gray)
//   * tap any other intersection      -> no-op (prevents accidental marks)
// handlers.onStart() / handlers.onEnd(cancelled) bracket every gesture (1 undo step per gesture).
import { colName, edgeCells, WHITE, BLACK, GRAY, E_ON, E_OFF } from './logic.js';
import { makeColorKeeper, assignPathColors } from './pathcolors.js';
import { makeGrace } from './grace.js';
import { otherEnd } from './lineends.js';

export const CELL_SIZE = 44;
const S = CELL_SIZE;
const PAD = 24;        // breathing room around outer intersections for circles, rings, and highlights
export const LABEL = 16;
const EDGE_TOL = 0.26; // perpendicular hit tolerance around a grid track for taps/hover (fraction of S)
const END_DEAD = 0.13; // neutral vertex pivot for taps/hover (leaves 74% of each segment clickable)
const DRAG_STRAIGHT_MIN = 0.30; // travel past intersection to continue straight during a drag
const DRAG_FIRST_MIN = 0.34;    // travel out of a vertex to commit the first segment of a drag
const DRAG_TURN_MIN = 0.40;     // deeper travel required to commit a 90° turn (prevents accidental turns across white dots)
const DRAG_STRAIGHT_TOL = 0.22; // perpendicular drag tolerance when continuing straight
const DRAG_FIRST_TOL = 0.20;    // perpendicular drag tolerance on the first segment
const DRAG_TURN_TOL = 0.18;     // tighter perpendicular drag tolerance for a 90° turn
const DRAG_BACKTRACK_T = 0.25;  // pull back within 25% of the previous vertex to undo the last dragged segment (>= DRAG_VERTEX_RAD)
const DRAG_BACKTRACK_TOL = 0.28;
const DRAG_VERTEX_RAD = 0.24;   // vertex snap radius for fast multi-cell swipes
const DRAG_SLOP_PX = 6; // ignore sub-6px pointer jitter before starting a drag
const BAD_DELAY_MS = 300;
const EPS = 1e-6;

const cellDist = (P, a, b) => (
  Math.abs(((a / P.cols) | 0) - ((b / P.cols) | 0))
  + Math.abs((a % P.cols) - (b % P.cols))
);

/**
 * Trace the exact orthogonal outline of a union of grid tiles as one SVG path (`fill-rule="evenodd"`).
 * `hasTile(r, c)` returns truthy for tiles in `0 <= r < rows, 0 <= c < cols`.
 * Tile `(r, c)` occupies `[ox + c*cw, ox + (c+1)*cw] × [oy + r*ch, oy + (r+1)*ch]`.
 * Handles arbitrary cutouts, interior holes, and diagonal corner touches without self-intersection.
 */
export function tilesOutlinePath(rows, cols, hasTile, ox, oy, cw, ch, radius = 0) {
  const V = cols + 1;
  const out = new Map();
  const addSeg = (vr, vc, dir) => {
    const k = vr * V + vc;
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push({ dir, used: false });
  };
  const DR_S = [-1, 0, 1, 0], DC_S = [0, 1, 0, -1];
  const inside = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols && !!hasTile(r, c);

  // Keep the 1-region on the RIGHT of each directed boundary edge (CW outer contours, CCW holes)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside(r, c)) continue;
      if (!inside(r - 1, c)) addSeg(r, c, 1);           // top: E
      if (!inside(r, c + 1)) addSeg(r, c + 1, 2);       // right: S
      if (!inside(r + 1, c)) addSeg(r + 1, c + 1, 3);   // bottom: W
      if (!inside(r, c - 1)) addSeg(r + 1, c, 0);       // left: N
    }
  }

  const fmt = (n) => (Math.round(n * 100) / 100);
  const parts = [];

  for (const [startK, list] of out) {
    for (const seg of list) {
      if (seg.used) continue;
      const pts = [];
      let vr = (startK / V) | 0, vc = startK % V;
      let cur = seg;
      while (cur && !cur.used) {
        cur.used = true;
        pts.push([vr, vc, cur.dir]);
        const dir = cur.dir;
        vr += DR_S[dir];
        vc += DC_S[dir];
        const nxtList = out.get(vr * V + vc);
        if (!nxtList) break;
        // Prefer tight right turn at diagonal touches so corner-touching tiles stay non-crossing
        const pref = [(dir + 1) & 3, dir, (dir + 3) & 3];
        let picked = null;
        for (const pd of pref) {
          picked = nxtList.find((s) => !s.used && s.dir === pd);
          if (picked) break;
        }
        cur = picked;
      }
      if (pts.length < 4) continue;

      // Collapse collinear edges into corner vertices
      const corners = [];
      for (let i = 0; i < pts.length; i++) {
        const prev = pts[(i - 1 + pts.length) % pts.length];
        if (prev[2] !== pts[i][2]) {
          corners.push([ox + pts[i][1] * cw, oy + pts[i][0] * ch]);
        }
      }
      const m = corners.length;
      if (m < 4) continue;

      if (radius <= 0) {
        let d = `M${fmt(corners[0][0])} ${fmt(corners[0][1])}`;
        for (let i = 1; i < m; i++) d += `L${fmt(corners[i][0])} ${fmt(corners[i][1])}`;
        parts.push(d + 'Z');
      } else {
        let d = '';
        for (let i = 0; i < m; i++) {
          const p0 = corners[(i - 1 + m) % m];
          const p1 = corners[i];
          const p2 = corners[(i + 1) % m];
          const dx1 = p1[0] - p0[0], dy1 = p1[1] - p0[1];
          const dx2 = p2[0] - p1[0], dy2 = p2[1] - p1[1];
          const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2);
          const r = Math.min(radius, l1 * 0.45, l2 * 0.45);
          const ax = p1[0] - (dx1 / l1) * r, ay = p1[1] - (dy1 / l1) * r;
          const bx = p1[0] + (dx2 / l2) * r, by = p1[1] + (dy2 / l2) * r;
          d += (i === 0 ? `M${fmt(ax)} ${fmt(ay)}` : `L${fmt(ax)} ${fmt(ay)}`);
          d += `Q${fmt(p1[0])} ${fmt(p1[1])} ${fmt(bx)} ${fmt(by)}`;
        }
        parts.push(d + 'Z');
      }
    }
  }
  return parts.join('');
}

/**
 * Return a `Uint8Array(P.N)` marking every interior plain void (plain Swiss-cheese void not
 * 4-connected to the outer grid border). Matches the exact interior holes of `tilesOutlinePath(!isPlainVoid)`.
 */
export function interiorPlainVoids(P) {
  const { rows, cols, N, isVoid } = P;
  const out = new Uint8Array(N);
  if (!P.voids || !P.voids.length) return out;
  const isPlain = new Uint8Array(N);
  for (let u = 0; u < N; u++) {
    if (isVoid[u] && !(P.hasCastle && P.castleAtCell[u] >= 0)) isPlain[u] = 1;
  }
  const ext = new Uint8Array(N);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  const push = (u) => {
    if (!isPlain[u] || ext[u]) return;
    ext[u] = 1;
    q[qt++] = u;
  };
  for (let c = 0; c < cols; c++) { push(c); push((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { push(r * cols); push(r * cols + cols - 1); }
  while (qh < qt) {
    const u = q[qh++];
    const r = (u / cols) | 0, c = u - r * cols;
    if (r > 0) push(u - cols);
    if (r + 1 < rows) push(u + cols);
    if (c > 0) push(u - 1);
    if (c + 1 < cols) push(u + 1);
  }
  for (let u = 0; u < N; u++) if (isPlain[u] && !ext[u]) out[u] = 1;
  return out;
}

/** Return cached SVG paths for a shaped puzzle's board silhouette, void cutouts, and unified interior holes. */
function getShapePaths(P) {
  if (!P.hasVoids) return null;
  if (P._shapePaths) return P._shapePaths;
  const { rows, cols, isVoid, holeList } = P;
  const fr = rows - 1, fc = cols - 1;
  const ox = PAD - S / 2;
  const oy = PAD - S / 2;
  const hasPlainVoids = Boolean(P.voids && P.voids.length > 0);
  const isPlainVoid = (u) => isVoid[u] && !(P.hasCastle && P.castleAtCell[u] >= 0);
  const boardPath = hasPlainVoids
    ? tilesOutlinePath(rows, cols, (r, c) => !isPlainVoid(r * cols + c), ox, oy, S, S, 8)
    : '';
  // Interior plain-void cutouts (exact 4-connected interior holes matching boardPath) for crisp inner framing
  const interiorVoid = hasPlainVoids ? interiorPlainVoids(P) : null;
  // Exact un-shifted inner cutout path (matches the hole in boardPath) for subtle hatch overlay
  const voidHatchPath = interiorVoid
    ? tilesOutlinePath(rows, cols, (r, c) => interiorVoid[r * cols + c], ox, oy, S, S, 6)
    : '';
  const holePaths = (holeList || []).map((grp) => {
    const inH = new Uint8Array(fr * fc);
    for (const f of grp) inH[f] = 1;
    return tilesOutlinePath(fr, fc, (r, c) => inH[r * fc + c], PAD, PAD, S, S, 0);
  });
  const holeInsetPaths = (holeList || []).map((grp) => {
    const inH = new Uint8Array(fr * fc);
    for (const f of grp) inH[f] = 1;
    return tilesOutlinePath(fr, fc, (r, c) => inH[r * fc + c], PAD, PAD, S, S, 4);
  });
  P._shapePaths = { boardPath, voidHatchPath, holePaths, holeInsetPaths };
  return P._shapePaths;
}

/**
 * Pure drag-gesture progression helper using raw lattice coordinates (gx, gy).
 * Features:
 *   1. Tighter mid-drag edge targets than tap targets, ignoring dual square centers mid-drag.
 *   2. Straight-line hysteresis (deeper travel + narrower band required for 90° turns than continuing straight).
 *   3. Drag-to-backtrack: pulling back along the most recently drawn segment undoes it cleanly.
 *   4. Edge-to-edge swipes: pressing on A4-A5 and dragging to A5-A6 (or around a corner) applies both segments.
 */
export function advanceDrag(P, g, gx, gy, step, undoStep = null, beginDrag = null) {
  if (!P || !g) return;
  if (!g.trail) g.trail = [];
  if (g.startHit && g.startHit.kind === 'face') return;

  const px = gx / S, py = gy / S;
  const maxX = P.cols - 1, maxY = P.rows - 1;
  if (px < -0.52 || py < -0.52 || px > maxX + 0.52 || py > maxY + 0.52) return;

  const edgeBetween = (a, b) => {
    for (let d = 0; d < 4; d++) if (P.nb[a * 4 + d] === b) return P.ed[a * 4 + d];
    return -1;
  };

  const fireEdge = (a, b, edgeIdx = edgeBetween(a, b)) => {
    if (edgeIdx < 0) return;
    g.dragged = true;
    step(a, b, g.firstStep);
    g.firstStep = false;
    g.lastEdge = edgeIdx;
    g.curCell = b;
    g.trail.push({ a, b, edge: edgeIdx });
  };

  const lastDir = () => {
    if (!g.trail.length) return null;
    const { a, b } = g.trail[g.trail.length - 1];
    return { dr: ((b / P.cols) | 0) - ((a / P.cols) | 0), dc: (b % P.cols) - (a % P.cols) };
  };

  const pickNeighborFrom = (from, dirHint, skipCell = -1) => {
    const cr = (from / P.cols) | 0, cc = from % P.cols;
    const rx = px - cc, ry = py - cr;
    let best = null, bestScore = -Infinity;
    for (let d = 0; d < 4; d++) {
      const nxt = P.nb[from * 4 + d];
      if (nxt < 0 || nxt === skipCell) continue;
      const dr = ((nxt / P.cols) | 0) - cr;
      const dc = (nxt % P.cols) - cc;
      if (dirHint && dr === -dirHint.dr && dc === -dirHint.dc) continue; // reverse is handled by backtrack
      const along = rx * dc + ry * dr;
      const perp = Math.abs(rx * (-dr) + ry * dc);
      const isStraight = !!(dirHint && dr === dirHint.dr && dc === dirHint.dc);
      const isTurn = !!(dirHint && !isStraight);
      const minT = isStraight ? DRAG_STRAIGHT_MIN : isTurn ? DRAG_TURN_MIN : DRAG_FIRST_MIN;
      const maxPerp = isStraight ? DRAG_STRAIGHT_TOL : isTurn ? DRAG_TURN_TOL : DRAG_FIRST_TOL;
      const ratio = isStraight ? 1.0 : isTurn ? 1.4 : 1.2;
      if (along >= minT - EPS && perp <= maxPerp + EPS && along > perp * ratio - EPS) {
        const score = along - perp;
        if (score > bestScore) {
          bestScore = score;
          best = { nxt, edge: P.ed[from * 4 + d] };
        }
      }
    }
    return best;
  };

  const walkCells = (from, to) => {
    let cur = from, safety = 0;
    while (cur !== to && safety++ < 20) {
      const cr = (cur / P.cols) | 0, cc = cur % P.cols;
      const tr = (to / P.cols) | 0, tc = to % P.cols;
      const dr = tr - cr, dc = tc - cc;
      const dir = lastDir();
      const cands = [];
      if (dir && ((dir.dr && Math.sign(dr) === dir.dr) || (dir.dc && Math.sign(dc) === dir.dc))) {
        cands.push((cr + dir.dr) * P.cols + (cc + dir.dc));
      }
      if (Math.abs(dr) >= Math.abs(dc)) {
        if (dr !== 0) cands.push((cr + Math.sign(dr)) * P.cols + cc);
        if (dc !== 0) cands.push(cr * P.cols + (cc + Math.sign(dc)));
      } else {
        if (dc !== 0) cands.push(cr * P.cols + (cc + Math.sign(dc)));
        if (dr !== 0) cands.push((cr + Math.sign(dr)) * P.cols + cc);
      }
      let nxt = -1, ex = -1;
      for (const c of cands) {
        const e = edgeBetween(cur, c);
        if (e >= 0) { nxt = c; ex = e; break; }
      }
      if (nxt < 0) break;
      fireEdge(cur, nxt, ex);
      cur = nxt;
    }
  };

  // 1. Backtrack: pulling back along the most recently drawn segment undoes it
  let backSafety = 0;
  while (g.trail.length > 0 && backSafety++ < 20) {
    const top = g.trail[g.trail.length - 1];
    const ar = (top.a / P.cols) | 0, ac = top.a % P.cols;
    const br = (top.b / P.cols) | 0, bc = top.b % P.cols;
    const ux = bc - ac, uy = br - ar;
    const t = (px - ac) * ux + (py - ar) * uy;
    const perp = Math.abs((px - ac) * (-uy) + (py - ar) * ux);
    if (t <= DRAG_BACKTRACK_T + EPS && perp <= DRAG_BACKTRACK_TOL + EPS) {
      g.trail.pop();
      g.curCell = top.a;
      g.lastEdge = g.trail.length ? g.trail[g.trail.length - 1].edge : -1;
      if (!g.trail.length) g.firstStep = true;
      undoStep?.(top.a, top.b, top.edge);
    } else {
      break;
    }
  }

  // 2. Starting a drag directly on a grid track: commit the starting track once the pointer advances past either endpoint
  if (!g.dragged && g.startHit && g.startHit.kind === 'edge') {
    const [sa, sb] = edgeCells(P, g.startHit.edge);
    const dirAB = { dr: ((sb / P.cols) | 0) - ((sa / P.cols) | 0), dc: (sb % P.cols) - (sa % P.cols) };
    const dirBA = { dr: -dirAB.dr, dc: -dirAB.dc };
    const hitB = pickNeighborFrom(sb, dirAB, sa);
    const hitA = pickNeighborFrom(sa, dirBA, sb);
    if (hitB) {
      beginDrag?.();
      fireEdge(sa, sb, g.startHit.edge);
      fireEdge(sb, hitB.nxt, hitB.edge);
    } else if (hitA) {
      beginDrag?.();
      fireEdge(sb, sa, g.startHit.edge);
      fireEdge(sa, hitA.nxt, hitA.edge);
    } else {
      // Check fast swipe straight to a vertex beyond sa or sb
      const nc = Math.max(0, Math.min(P.cols - 1, Math.round(px)));
      const nr = Math.max(0, Math.min(P.rows - 1, Math.round(py)));
      const v = nr * P.cols + nc;
      if ((!P.hasVoids || !P.isVoid[v]) && v !== sa && v !== sb && Math.hypot(px - nc, py - nr) <= DRAG_VERTEX_RAD + EPS) {
        beginDrag?.();
        if (cellDist(P, sa, v) < cellDist(P, sb, v)) {
          fireEdge(sb, sa, g.startHit.edge);
          walkCells(sa, v);
        } else {
          fireEdge(sa, sb, g.startHit.edge);
          walkCells(sb, v);
        }
      }
      return;
    }
  }

  // 3. Step along immediate neighbors using direction-aware hysteresis
  let safety = 0;
  while (safety++ < 20) {
    const pick = pickNeighborFrom(g.curCell, lastDir());
    if (!pick) break;
    fireEdge(g.curCell, pick.nxt, pick.edge);
  }

  // 4. Fast-swipe fallback: only snap if pointer landed squarely on a distant vertex or tight non-adjacent track
  const nc = Math.max(0, Math.min(P.cols - 1, Math.round(px)));
  const nr = Math.max(0, Math.min(P.rows - 1, Math.round(py)));
  const v = nr * P.cols + nc;
  const prevBack = g.trail.length ? g.trail[g.trail.length - 1].a : -1;
  if ((!P.hasVoids || !P.isVoid[v]) && v !== g.curCell && v !== prevBack && Math.hypot(px - nc, py - nr) <= DRAG_VERTEX_RAD + EPS) {
    // Don't let vertex snap bypass 90° turn hysteresis for an immediate neighbor unless very close to that vertex
    walkCells(g.curCell, v);
    return;
  }

  // Tight track fallback for fast corner swipes (strictly away from intersections, ignoring face centers)
  let farEdge = -1, farDist = DRAG_TURN_TOL;
  const fc = Math.floor(px);
  if (fc >= 0 && fc + 1 < P.cols) {
    const t = px - fc, dist = Math.abs(py - nr);
    const cand = 2 * (nr * P.cols + fc);
    if (P.edgeA[cand] >= 0 && t >= DRAG_TURN_MIN - EPS && t <= 1 - DRAG_TURN_MIN + EPS && dist <= farDist + EPS) {
      farDist = dist;
      farEdge = cand;
    }
  }
  const fr = Math.floor(py);
  if (fr >= 0 && fr + 1 < P.rows) {
    const t = py - fr, dist = Math.abs(px - nc);
    const cand = 2 * (fr * P.cols + nc) + 1;
    if (P.edgeA[cand] >= 0 && t >= DRAG_TURN_MIN - EPS && t <= 1 - DRAG_TURN_MIN + EPS && dist <= farDist + EPS) {
      farDist = dist;
      farEdge = cand;
    }
  }
  if (farEdge >= 0 && farEdge !== g.lastEdge) {
    const [a, b] = edgeCells(P, farEdge);
    if (a !== g.curCell && b !== g.curCell) {
      const near = cellDist(P, g.curCell, a) <= cellDist(P, g.curCell, b) ? a : b;
      const far = near === a ? b : a;
      walkCells(g.curCell, near);
      fireEdge(near, far, farEdge);
    }
  }
}

const FACE_DRAG_INSET = 0.08; // 8% inset from grid lines so diagonal drags across corners don't graze off-diagonal squares

/**
 * Pure face-painting drag stepper for dual squares.
 * Interpolates from (g.lastGx, g.lastGy) to (gx, gy) so fast swipes never skip intermediate squares,
 * and invokes `onFace(faceIdx)` at most once per square per drag.
 */
export function advanceFaceDrag(P, g, gx, gy, onFace) {
  if (!P || !g || g.startHit.kind !== 'face') return;
  const frMax = P.rows - 1, fcMax = P.cols - 1;
  if (frMax <= 0 || fcMax <= 0) return;

  const prevX = g.lastGx ?? gx;
  const prevY = g.lastGy ?? gy;
  const dist = Math.hypot(gx - prevX, gy - prevY);
  const steps = Math.max(1, Math.ceil(dist / (S * 0.25)));

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = prevX + (gx - prevX) * t;
    const y = prevY + (gy - prevY) * t;
    const fc = Math.floor(x / S);
    const fr = Math.floor(y / S);
    if (fc < 0 || fc >= fcMax || fr < 0 || fr >= frMax) continue;
    const rawF = fr * fcMax + fc;
    if (P.hasVoids && P.faceExterior[rawF]) continue;
    const isHole = P.hasVoids && P.faceHoleId[rawF] >= 0;
    if (!isHole) {
      const fx = x / S - fc;
      const fy = y / S - fr;
      if (fx < FACE_DRAG_INSET || fx > 1 - FACE_DRAG_INSET || fy < FACE_DRAG_INSET || fy > 1 - FACE_DRAG_INSET) continue;
    }
    const f = P.hasVoids ? P.faceRep[rawF] : rawF;
    if (f >= 0 && !g.paintedFaces.has(f)) {
      g.paintedFaces.add(f);
      g.dragged = true;
      onFace(f);
    }
  }
  g.lastGx = gx;
  g.lastGy = gy;
}

/**
 * Pure hit-testing in lattice coordinates where intersection (r, c) is at (c*S, r*S).
 * Returns:
 *   - { kind: 'edge', edge, cell } when near an active track midpoint
 *   - { kind: 'face', face, cell, edge: -1 } when inside a dual square or anywhere inside an interior cutout hole
 *   - { kind: 'cell', cell, edge: -1 } when near an active intersection vertex (or outer margin)
 *   - null outside the board or inside an exterior cutout.
 */
export function hitTestCoords(P, gx, gy) {
  if (!P) return null;
  const maxX = (P.cols - 1) * S, maxY = (P.rows - 1) * S;
  const bound = S * 0.52;
  if (gx < -bound || gy < -bound || gx > maxX + bound || gy > maxY + bound) return null;

  const nc = Math.max(0, Math.min(P.cols - 1, Math.round(gx / S)));
  const nr = Math.max(0, Math.min(P.rows - 1, Math.round(gy / S)));
  const cell = nr * P.cols + nc;
  const cellIsVoid = P.hasVoids && P.isVoid[cell];

  let bestEdge = -1, bestDist = EDGE_TOL * S;

  // Check nearest active horizontal track: row nr, between col fc and fc+1
  const fc = Math.floor(gx / S);
  if (fc >= 0 && fc + 1 < P.cols) {
    const cand = 2 * (nr * P.cols + fc);
    if (P.edgeA[cand] >= 0) {
      const t = gx / S - fc;
      const dist = Math.abs(gy - nr * S);
      if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
        bestDist = dist;
        bestEdge = cand;
      }
    }
  }

  // Check nearest active vertical track: col nc, between row fr and fr+1
  const fr = Math.floor(gy / S);
  if (fr >= 0 && fr + 1 < P.rows) {
    const cand = 2 * (fr * P.cols + nc) + 1;
    if (P.edgeA[cand] >= 0) {
      const t = gy / S - fr;
      const dist = Math.abs(gx - nc * S);
      if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
        bestDist = dist;
        bestEdge = cand;
      }
    }
  }

  if (bestEdge >= 0) return { kind: 'edge', edge: bestEdge, cell: cellIsVoid ? P.edgeA[bestEdge] : cell };

  const fCols = P.cols - 1;
  // Inside a dual square: either a normal square center or anywhere in an interior cutout hole (one big click target)
  if (fr >= 0 && fr + 1 < P.rows && fc >= 0 && fc + 1 < P.cols) {
    const rawF = fr * fCols + fc;
    if (!P.hasVoids || !P.faceExterior[rawF]) {
      const isHole = P.hasVoids && P.faceHoleId[rawF] >= 0;
      if (isHole) {
        // Keep a small active-vertex pivot around rim intersections so drags & gray-pearl taps still work on the rim
        if (cellIsVoid || Math.hypot(gx - nc * S, gy - nr * S) >= EDGE_TOL * S) {
          return { kind: 'face', face: P.faceRep[rawF], cell: -1, edge: -1 };
        }
      } else {
        const fx = gx / S - fc, fy = gy / S - fr;
        if (fx >= EDGE_TOL && fx <= 1 - EDGE_TOL && fy >= EDGE_TOL && fy <= 1 - EDGE_TOL) {
          return { kind: 'face', face: rawF, cell, edge: -1 };
        }
      }
    }
  }

  if (cellIsVoid) {
    // Directly on top of a void intersection: if it belongs to an interior hole, hit that hole; else exterior cutout -> null
    for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      const r2 = nr + dr, c2 = nc + dc;
      if (r2 < 0 || c2 < 0 || r2 >= P.rows - 1 || c2 >= fCols) continue;
      const f = r2 * fCols + c2;
      if (P.faceHoleId[f] >= 0) return { kind: 'face', face: P.faceRep[f], cell: -1, edge: -1 };
    }
    return null;
  }

  return { kind: 'cell', cell, edge: -1 };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class Board {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.P = null;
    this.gesture = null;
    this.hoverCell = -1;
    this.hoverEdge = -1;
    this.hoverFace = -1;
    this._svg = null;
    this._faceHoverG = null;
    this._topHoverG = null;
    this._colLabels = null;
    this._rowLabels = null;
    this._lines = null;
    this._hc = -1;
    this._hr = -1;
    this.opts = { colorLines: false, pathColors: null, pathAlike: null };
    this.grace = makeGrace();
    this._badTimer = 0;
    this._graceNow = true;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => { if (this.gesture && e.pointerId === this.gesture.id) this.cancel(); });
    el.addEventListener('lostpointercapture', (e) => { if (this.gesture && e.pointerId === this.gesture.id) this.cancel(); });
    el.addEventListener('pointerleave', () => { if (!this.gesture) this.setHover(-1, -1, -1); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setPuzzle(P) {
    this.P = P;
    this.gesture = null;
    this.hoverCell = -1;
    this.hoverEdge = -1;
    this.hoverFace = -1;
    this._svg = null;
    this._faceHoverG = null;
    this._topHoverG = null;
    this._colLabels = null;
    this._rowLabels = null;
    this._lines = null;
    this._hc = -1;
    this._hr = -1;
    this.colors = null;
    this.grace.reset();
    clearTimeout(this._badTimer);
    this._graceNow = true;
  }

  setOptions(opts) {
    if (opts.pathColors && this.opts.pathColors && opts.pathColors.length !== this.opts.pathColors.length) {
      this.colors = null;
    }
    Object.assign(this.opts, opts);
    if (this.marks) this.render(this.marks, this.info, this.hint);
  }

  size() {
    if (!this.P) return { W: 0, H: 0 };
    return {
      W: (this.P.cols - 1) * S + 2 * PAD + LABEL,
      H: (this.P.rows - 1) * S + 2 * PAD + LABEL,
    };
  }

  analyseLines(marks) {
    const P = this.P;
    const deg = new Uint8Array(P.N);
    const onOnly = new Uint8Array(P.numEdges);
    const parent = new Int32Array(P.N);
    for (let i = 0; i < P.N; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1) continue;
      const a = P.edgeA[x], b = P.edgeB[x];
      if (a < 0) continue;
      onOnly[x] = 1;
      deg[a]++; deg[b]++;
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    if (!this.colors || this.colors.birth.length !== P.numEdges) this.colors = makeColorKeeper(P.numEdges);
    const alike = this.opts.pathAlike;
    const near = alike ? { cols: P.cols, alike: (i, j) => alike[i][j] } : null;
    const colorOf = assignPathColors(this.colors, onOnly, (x) => find(P.edgeA[x]), (this.opts.pathColors || [0]).length, near);
    return { deg, colorOf, find };
  }

  render(marks, info, hint = null) {
    const P = this.P;
    if (!P) { this.el.innerHTML = ''; this._svg = null; return; }
    this.marks = marks; this.info = info; this.hint = hint;
    this._renderSeq = (this._renderSeq || 0) + 1;

    const wanted = new Set();
    (info.clueState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`c${k}`); });
    (info.slitherState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`s${k}`); });
    (info.midloopState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`m${k}`); });
    (info.castleState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`w${k}`); });
    if (info.badFaces) for (const f of info.badFaces) wanted.add(`f${f}`);
    if (info.earlyLoops) for (const x of info.earlyLoops) wanted.add(`l${x}`);
    if (info.trappedCells) for (const i of info.trappedCells) wanted.add(`t${i}`);
    const { show, waiting, fresh } = this.grace.update(wanted, this._graceNow);
    this._graceNow = false;
    if (!waiting.size) clearTimeout(this._badTimer);
    else if (fresh) {
      clearTimeout(this._badTimer);
      this._badTimer = setTimeout(() => {
        this.grace.commit();
        if (this.marks) this.render(this.marks, this.info, this.hint);
      }, BAD_DELAY_MS);
    }

    const { W, H } = this.size();
    const vx = (c) => PAD + c * S;
    const vy = (r) => PAD + r * S;
    const ix = (i) => PAD + (i % P.cols) * S;
    const iy = (i) => PAD + ((i / P.cols) | 0) * S;
    const segCoords = (x) => {
      const [a, b] = edgeCells(P, x);
      return [ix(a), iy(a), ix(b), iy(b)];
    };

    const { deg, colorOf, find } = this.analyseLines(marks);
    const boardW = (P.cols - 1) * S + 2 * PAD;
    const boardH = (P.rows - 1) * S + 2 * PAD;

    const shape = getShapePaths(P);
    let g = (shape && shape.boardPath)
      ? `<path class="board-bg" fill-rule="evenodd" d="${shape.boardPath}"/>`
      : `<rect class="board-bg" x="1.5" y="1.5" width="${boardW - 3}" height="${boardH - 3}" rx="8"/>`;

    // Dual-face Inside / Outside shading (under grid lines and hint overlays; interior holes render as one unified polygon)
    const fr = P.rows - 1, fc = P.cols - 1;
    const faceExt = P.hasVoids ? P.faceExterior : null;
    const faceExtShade = P.faceExtShade || null;
    const faceHoleId = P.hasVoids ? P.faceHoleId : null;
    if (marks.faces && fr > 0 && fc > 0) {
      const doneHoles = faceHoleId ? new Set() : null;
      for (let f = 0; f < fr * fc; f++) {
        if (faceExt && faceExt[f] && !(faceExtShade && faceExtShade[f])) continue;
        const v = marks.faces[f];
        if (!v) continue;
        const hid = faceHoleId ? faceHoleId[f] : -1;
        if (hid >= 0) {
          if (doneHoles.has(hid)) continue;
          doneHoles.add(hid);
          const cls = (v === 1 ? 'face-in' : 'face-out') + (marks.autoF && marks.autoF[f] ? ' auto' : '');
          g += `<path class="${cls}" fill-rule="evenodd" d="${shape.holePaths[hid]}"/>`;
          if (show.has(`f${f}`)) {
            g += `<path class="face-bad" fill-rule="evenodd" d="${shape.holeInsetPaths[hid]}"/>`;
          }
          continue;
        }
        const r = (f / fc) | 0, c = f % fc;
        const cls = (v === 1 ? 'face-in' : 'face-out') + (marks.autoF && marks.autoF[f] ? ' auto' : '');
        g += `<rect class="${cls}" x="${vx(c)}" y="${vy(r)}" width="${S}" height="${S}"/>`;
        if (show.has(`f${f}`)) {
          g += `<rect class="face-bad" x="${vx(c) + 2.5}" y="${vy(r) + 2.5}" width="${S - 5}" height="${S - 5}" rx="3"/>`;
        }
      }
    }
    g += '<g data-layer="face-hover"></g>';

    // Hint dual-tile tints (centered on intersections, under the lattice tracks)
    if (hint) {
      if (hint.faces && fr > 0 && fc > 0) {
        const emitHintFaces = (list, cls) => {
          const seenH = faceHoleId ? new Set() : null;
          for (const f of list || []) {
            if (faceExt && faceExt[f]) continue;
            const hid = faceHoleId ? faceHoleId[f] : -1;
            if (hid >= 0) {
              if (seenH.has(hid)) continue;
              seenH.add(hid);
              g += `<path class="${cls}" fill-rule="evenodd" d="${shape.holeInsetPaths[hid]}"/>`;
            } else {
              const r = (f / fc) | 0, c = f % fc;
              g += `<rect class="${cls}" x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4"/>`;
            }
          }
        };
        emitHintFaces(hint.faces.in, 'hint-face-in');
        emitHintFaces(hint.faces.out, 'hint-face-out');
        emitHintFaces(hint.faces.clue, 'hint-clue');
        emitHintFaces(hint.faces.focus, 'hint-focus');
        emitHintFaces(hint.faces.problem, 'hint-problem');
      }
      const tile = (i, cls, pad = 0) => `<rect class="${cls}" x="${ix(i) - S / 2 + pad}" y="${iy(i) - S / 2 + pad}" width="${S - 2 * pad}" height="${S - 2 * pad}" rx="${pad ? 8 : 0}"/>`;
      for (const i of hint.undecided || []) if (!P.hasVoids || !P.isVoid[i]) g += tile(i, 'hint-undecided', 2);
      const roles = hint.roles || {};
      for (const i of roles.area || []) if (!P.hasVoids || !P.isVoid[i]) g += tile(i, 'hint-area', 0);
      for (const role of ['clue', 'path', 'problem', 'focus']) {
        for (const i of roles[role] || []) if (!P.hasVoids || !P.isVoid[i]) g += tile(i, `hint-${role}`, 3);
      }
    }

    // Solid cutout fill + crisp frame & subtle hatch on top of shading so shading wraps around holes without tinting inside them
    if (shape && shape.voidHatchPath) {
      g += `<path class="void-cutout" d="${shape.voidHatchPath}"/>`;
      g += `<path class="void-cutout-frame" d="${shape.voidHatchPath}"/>`;
    }

    // Lattice tracks (only active edges so cutouts/walls have no stray tracks; batched into one <path>)
    if (P.hasVoids) {
      let dGrid = '';
      for (let x = 0; x < P.numEdges; x++) {
        if (P.edgeA[x] < 0) continue;
        const [x1, y1, x2, y2] = segCoords(x);
        dGrid += `M${x1} ${y1}L${x2} ${y2}`;
      }
      if (dGrid) g += `<path class="grid-line" d="${dGrid}"/>`;
    } else {
      for (let r = 0; r < P.rows; r++) {
        g += `<line class="grid-line" x1="${vx(0)}" y1="${vy(r)}" x2="${vx(P.cols - 1)}" y2="${vy(r)}"/>`;
      }
      for (let c = 0; c < P.cols; c++) {
        g += `<line class="grid-line" x1="${vx(c)}" y1="${vy(0)}" x2="${vx(c)}" y2="${vy(P.rows - 1)}"/>`;
      }
    }

    // Subtle anchor dots at empty active intersections (bolder on full-board puzzles to show unvisited dots)
    const dotR = P.fullBoard ? 2.6 : 1.4;
    const dotCls = P.fullBoard ? 'grid-dot full-board' : 'grid-dot';
    for (let i = 0; i < P.N; i++) {
      if ((P.hasVoids && P.isVoid[i]) || P.clue[i] || deg[i] > 0) continue;
      if (P.hasMidloop && P.midloopAtCell[i] >= 0) continue;
      g += `<circle class="${dotCls}" cx="${ix(i)}" cy="${iy(i)}" r="${dotR}"/>`;
    }

    // Slitherlink face numbers (0..3) centered inside dual squares, above shading & grid lines
    if (P.hasSlither) {
      const sStates = info.slitherState || [];
      for (let k = 0; k < P.slither.length; k++) {
        const sc = P.slither[k];
        const st = sStates[k] === 'bad' && show.has(`s${k}`) ? ' bad' : '';
        g += `<text class="slither-num${st}" x="${vx(sc.c) + S / 2}" y="${vy(sc.r) + S / 2}">${sc.n}</text>`;
      }
    }

    // Branching error ring (deg > 2) & full-board trapped-intersection error ring
    for (let i = 0; i < P.N; i++) {
      if (deg[i] > 2) g += `<circle class="over" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
      else if (show.has(`t${i}`)) g += `<circle class="trapped-cell" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.21}"/>`;
    }

    // Drawn loop segments directly along the lattice tracks (behind all pearls so circles read crisply)
    const pc = this.opts.pathColors;
    const givenE = P.hasGivens ? P.givenE : null;
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1 || !show.has(`l${x}`)) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      g += `<line class="seg-bad-halo" stroke-width="${S * 0.30}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const isBadLoop = show.has(`l${x}`);
      const isGiven = givenE && givenE[x] === E_ON;
      if (isGiven) {
        g += `<line class="seg-given${isBadLoop ? ' bad' : ''}" stroke-width="${S * 0.165}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      } else {
        const a = P.edgeA[x];
        const style = !isBadLoop && this.opts.colorLines && pc
          ? ` style="stroke:${pc[colorOf.get(find(a)) % pc.length]}"`
          : '';
        g += `<line class="seg${isBadLoop ? ' bad' : ''}"${style} stroke-width="${S * 0.14}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
    }

    // Hint chain & ghost segments (drawn below pearls and Mid-loop dots so clues stay crisp)
    if (hint) {
      const targets = hint.targets || {};
      for (const x of hint.chain || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        g += `<line class="chain-seg" stroke-width="${S * 0.11}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
      for (const x of targets.segOn || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const inset = (P.hasMidloop && P.midloopAtEdge[x] >= 0) ? S * 0.12 : S * 0.24;
        const k = inset / len;
        g += `<line class="ghost-seg" stroke-width="${S * 0.14}" x1="${x1 + (x2 - x1) * k}" y1="${y1 + (y2 - y1) * k}" x2="${x2 - (x2 - x1) * k}" y2="${y2 - (y2 - y1) * k}"/>`;
      }
    }

    // Circles (white, black, unlabeled gray, and 0° 2×2 checkerboard labeled gray) on top of loop segments
    const rWhite = S * 0.21;
    const rBlack = S * 0.22;
    const rGray = S * 0.215;
    const rChecker = S * 0.22;
    const grayLabel = (cell) => {
      const k = P.grayAt ? P.grayAt[cell] : -1;
      if (k < 0) return { lbl: 0, auto: false };
      const lbl = marks.grays ? marks.grays[k] : 0;
      const auto = !!(lbl && marks.autoG && marks.autoG[k]);
      return { lbl, auto };
    };
    const checkerQuads = (cx, cy, r) => (
      `M${cx} ${cy}V${cy - r}A${r} ${r} 0 0 1 ${cx + r} ${cy}ZM${cx} ${cy}V${cy + r}A${r} ${r} 0 0 1 ${cx - r} ${cy}Z`
    );
    for (let k = 0; k < P.clues.length; k++) {
      const cl = P.clues[k];
      const cx = vx(cl.c), cy = vy(cl.r);
      const st = info.clueState[k] === 'bad' && show.has(`c${k}`) ? 'bad' : '';
      if (cl.t === 'W') {
        g += `<circle class="pearl-white-fill ${st}" cx="${cx}" cy="${cy}" r="${rWhite}"/>`;
        g += `<circle class="pearl-white-ring ${st}" cx="${cx}" cy="${cy}" r="${rWhite}"/>`;
      } else if (cl.t === 'G') {
        const { lbl } = grayLabel(cl.r * P.cols + cl.c);
        if (lbl === 0) {
          g += `<circle class="pearl-gray-fill ${st}" cx="${cx}" cy="${cy}" r="${rGray}"/>`;
          g += `<circle class="pearl-gray-ring ${st}" cx="${cx}" cy="${cy}" r="${rGray}"/>`;
        } else if (lbl === WHITE) {
          g += `<circle class="pearl-white-fill ${st}" cx="${cx}" cy="${cy}" r="${rChecker}"/>`;
          g += `<path class="pearl-gray-quad-w" d="${checkerQuads(cx, cy, rChecker)}"/>`;
          g += `<circle class="pearl-white-ring ${st}" cx="${cx}" cy="${cy}" r="${rChecker}"/>`;
        } else if (lbl === BLACK) {
          g += `<circle class="pearl-black-fill ${st}" cx="${cx}" cy="${cy}" r="${rChecker}"/>`;
          g += `<path class="pearl-gray-quad-b" d="${checkerQuads(cx, cy, rChecker)}"/>`;
          g += `<circle class="pearl-black-ring ${st}" cx="${cx}" cy="${cy}" r="${rChecker}"/>`;
        }
      } else {
        g += `<circle class="pearl-black ${st}" cx="${cx}" cy="${cy}" r="${rBlack}"/>`;
      }
    }

    // Mid-loop midpoint dots (distinct teal accent so they coexist cleanly with Masyu pearls)
    if (P.hasMidloop) {
      const mStates = info.midloopState || [];
      const rMid = S * 0.165;
      for (let k = 0; k < P.midloop.length; k++) {
        const md = P.midloop[k];
        const mx = md.dir === 'H' ? vx(md.c) + S / 2 : vx(md.c);
        const my = md.dir === 'V' ? vy(md.r) + S / 2 : vy(md.r);
        const st = mStates[k] === 'bad' && show.has(`m${k}`) ? ' bad' : '';
        g += `<circle class="midloop-dot${st}" cx="${mx}" cy="${my}" r="${rMid}"/>`;
      }
    }

    // Castle Wall blocked clue tiles (White=Inside, Black=Outside, Gray=Either, with directional segment count)
    if (P.hasCastle) {
      const cwStates = info.castleState || [];
      const tileSz = S - 4;
      const half = tileSz / 2;
      for (let k = 0; k < P.castle.length; k++) {
        const cw = P.castle[k];
        const cx = vx(cw.c), cy = vy(cw.r);
        const st = cwStates[k] === 'bad' && show.has(`w${k}`) ? ' bad' : '';
        g += `<rect class="castle-tile-${cw.wall}${st}" x="${cx - half}" y="${cy - half}" width="${tileSz}" height="${tileSz}" rx="5"/>`;
        if (cw.dir) {
          const tc = `castle-text-${cw.wall}${st}`;
          const fs = cw.n >= 10 ? S * 0.30 : S * 0.40;
          if (cw.dir === 'R') {
            g += `<text class="${tc}" x="${cx}" y="${cy}" font-size="${fs}">${cw.n}→</text>`;
          } else if (cw.dir === 'L') {
            g += `<text class="${tc}" x="${cx}" y="${cy}" font-size="${fs}">←${cw.n}</text>`;
          } else if (cw.dir === 'U') {
            g += `<text class="${tc}" x="${cx}" y="${cy - S * 0.17}" font-size="${S * 0.32}">↑</text>`;
            g += `<text class="${tc}" x="${cx}" y="${cy + S * 0.16}" font-size="${fs * 0.94}">${cw.n}</text>`;
          } else {
            g += `<text class="${tc}" x="${cx}" y="${cy - S * 0.15}" font-size="${fs * 0.94}">${cw.n}</text>`;
            g += `<text class="${tc}" x="${cx}" y="${cy + S * 0.18}" font-size="${S * 0.32}">↓</text>`;
          }
        }
      }
    }

    // Small crisp ✕ marks on crossed-out lattice tracks (batched by style into <= 6 <path> nodes)
    let dGiven = '', dManual = '', dAuto = '';
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 2) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const isGivenWall = givenE && givenE[x] === E_OFF;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = isGivenWall ? S * 0.105 : S * 0.085;
      const seg = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
      if (isGivenWall) dGiven += seg;
      else if (marks.autoE && marks.autoE[x]) dAuto += seg;
      else dManual += seg;
    }
    if (dAuto) g += `<path class="edge-x-halo auto" d="${dAuto}"/><path class="edge-x auto" d="${dAuto}"/>`;
    if (dManual) g += `<path class="edge-x-halo" d="${dManual}"/><path class="edge-x" d="${dManual}"/>`;
    if (dGiven) g += `<path class="wall-given-halo" d="${dGiven}"/><path class="wall-given" d="${dGiven}"/>`;

    // Hint overlays (rings, Castle Wall tile frames, ghost X, gray label ghosts, wrong marks)
    if (hint) {
      const roles = hint.roles || {};
      const targets = hint.targets || {};
      if (P.hasCastle) {
        const half = (S - 4) / 2 + 1.5;
        const sz = half * 2;
        const emitCwFrame = (list, cls) => {
          for (const i of list || []) {
            if (P.castleAtCell[i] < 0) continue;
            g += `<rect class="${cls}" x="${ix(i) - half}" y="${iy(i) - half}" width="${sz}" height="${sz}" rx="6.5"/>`;
          }
        };
        emitCwFrame(roles.clue, 'hint-castle-clue');
        emitCwFrame(roles.focus, 'hint-castle-focus');
        emitCwFrame(roles.problem, 'hint-castle-problem');
      }
      for (const i of roles.exit || []) g += `<circle class="hint-exit" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
      for (const i of roles.focus || []) {
        if (P.hasCastle && P.castleAtCell[i] >= 0) continue;
        g += `<circle class="hint-focus-ring" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.32}"/>`;
      }
      for (const x of targets.segOff || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.11;
        const path = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
        g += `<path class="ghost-x-halo" d="${path}"/><path class="ghost-x" d="${path}"/>`;
      }
      for (const i of targets.grayWhite || []) {
        g += `<circle class="ghost-gray-white" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.165}"/>`;
      }
      for (const i of targets.grayBlack || []) {
        g += `<circle class="ghost-gray-black" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.165}"/>`;
      }
      for (const x of hint.wrongEdges || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        g += `<line class="wrong-seg" stroke-width="${S * 0.2}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
      for (const i of hint.wrongClues || []) {
        g += `<circle class="wrong-clue" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
      }
    }

    // Hover feedback layer populated incrementally by renderHover()
    g += '<g data-layer="top-hover"></g>';

    // Axis labels aligned directly with the grid lines ('.here' toggled by renderHover())
    let colLabels = '<g data-layer="col-labels">';
    for (let c = 0; c < P.cols; c++) {
      colLabels += `<text class="axis-label" x="${LABEL + vx(c)}" y="${LABEL - 3}">${colName(c)}</text>`;
    }
    colLabels += '</g>';
    let rowLabels = '<g data-layer="row-labels">';
    for (let r = 0; r < P.rows; r++) {
      rowLabels += `<text class="axis-label side" x="${LABEL - 4}" y="${LABEL + vy(r)}">${r + 1}</text>`;
    }
    rowLabels += '</g>';

    const defs = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="8" height="8"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="8" stroke-width="3"/></pattern><pattern id="void-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="void-hatch-line" x1="0" y1="0" x2="0" y2="10" stroke-width="1.2"/></pattern></defs>`;
    this.el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${defs}${colLabels}${rowLabels}<g transform="translate(${LABEL} ${LABEL})">${g}</g></svg>`;
    this._lines = { deg, colorOf, find };
    this._svg = this.el.firstElementChild || null;
    if (this._svg && typeof this._svg.querySelector === 'function') {
      this._faceHoverG = this._svg.querySelector('[data-layer="face-hover"]');
      this._topHoverG = this._svg.querySelector('[data-layer="top-hover"]');
      this._colLabels = this._svg.querySelector('[data-layer="col-labels"]')?.children || null;
      this._rowLabels = this._svg.querySelector('[data-layer="row-labels"]')?.children || null;
    } else {
      this._faceHoverG = null;
      this._topHoverG = null;
      this._colLabels = null;
      this._rowLabels = null;
    }
    this._hc = -1;
    this._hr = -1;
    this.renderHover();
  }

  renderHover() {
    if (!this._svg || !this.P || !this.marks || typeof document === 'undefined') return;
    const P = this.P, marks = this.marks;

    // Update axis highlight classes in O(1)
    const hc = !this.gesture && this.hoverCell >= 0 ? this.hoverCell % P.cols : -1;
    const hr = !this.gesture && this.hoverCell >= 0 ? (this.hoverCell / P.cols) | 0 : -1;
    if (this._colLabels) {
      if (this._hc !== hc) {
        if (this._hc >= 0 && this._colLabels[this._hc]) this._colLabels[this._hc].classList.remove('here');
        if (hc >= 0 && this._colLabels[hc]) this._colLabels[hc].classList.add('here');
        this._hc = hc;
      }
    }
    if (this._rowLabels) {
      if (this._hr !== hr) {
        if (this._hr >= 0 && this._rowLabels[this._hr]) this._rowLabels[this._hr].classList.remove('here');
        if (hr >= 0 && this._rowLabels[hr]) this._rowLabels[hr].classList.add('here');
        this._hr = hr;
      }
    }

    const vx = (c) => PAD + c * S;
    const vy = (r) => PAD + r * S;
    const ix = (i) => PAD + (i % P.cols) * S;
    const iy = (i) => PAD + ((i / P.cols) | 0) * S;

    // Face hover layer (below void cutouts, grid lines, and hints)
    if (this._faceHoverG) {
      const fr = P.rows - 1, fc = P.cols - 1;
      const hoverAutoFace = this.hoverFace >= 0 && marks.faces && marks.faces[this.hoverFace] && marks.autoF && marks.autoF[this.hoverFace];
      if (!this.gesture && this.hoverFace >= 0 && !hoverAutoFace && fr > 0 && fc > 0) {
        const faceHoleId = P.hasVoids ? P.faceHoleId : null;
        const hid = faceHoleId ? faceHoleId[this.hoverFace] : -1;
        if (hid >= 0) {
          const shape = getShapePaths(P);
          this._faceHoverG.replaceChildren(svgEl('path', { class: 'face-hover', 'fill-rule': 'evenodd', d: shape.holeInsetPaths[hid] }));
        } else {
          const r = (this.hoverFace / fc) | 0, c = this.hoverFace % fc;
          this._faceHoverG.replaceChildren(svgEl('rect', { class: 'face-hover', x: vx(c) + 3, y: vy(r) + 3, width: S - 6, height: S - 6, rx: 4 }));
        }
      } else {
        this._faceHoverG.replaceChildren();
      }
    }

    // Top hover layer (track midpoint highlight, tappable gray circle ring, or open line-end diamonds)
    if (this._topHoverG) {
      const nodes = [];
      if (!this.gesture) {
        const givenE = P.hasGivens ? P.givenE : null;
        const hoverAutoX = this.hoverEdge >= 0 && marks.edges[this.hoverEdge] === 2 && marks.autoE && marks.autoE[this.hoverEdge];
        const hoverGiven = this.hoverEdge >= 0 && givenE && givenE[this.hoverEdge] !== 0;
        if (this.hoverEdge >= 0 && !hoverAutoX && !hoverGiven) {
          const [a, b] = edgeCells(P, this.hoverEdge);
          const mx = (ix(a) + ix(b)) / 2, my = (iy(a) + iy(b)) / 2;
          const hr = (P.hasMidloop && P.midloopAtEdge[this.hoverEdge] >= 0) ? S * 0.24 : S * 0.16;
          nodes.push(svgEl('circle', { class: 'edge-hover', cx: mx, cy: my, r: hr }));
        } else if (this.hoverCell >= 0) {
          if (P.clue[this.hoverCell] === GRAY) {
            const k = P.grayAt ? P.grayAt[this.hoverCell] : -1;
            const lbl = k >= 0 && marks.grays ? marks.grays[k] : 0;
            const auto = !!(lbl && marks.autoG && marks.autoG[k]);
            if (!auto) nodes.push(svgEl('circle', { class: 'pearl-hover', cx: ix(this.hoverCell), cy: iy(this.hoverCell), r: S * 0.29 }));
          }
          if (this._lines && this._lines.deg[this.hoverCell] === 1) {
            const far = otherEnd(P, marks.edges, this.hoverCell);
            if (far >= 0) {
              const pc = this.opts.pathColors;
              const stroke = this.opts.colorLines && pc
                ? pc[this._lines.colorOf.get(this._lines.find(this.hoverCell)) % pc.length]
                : null;
              for (const i of [this.hoverCell, far]) {
                const x = ix(i), y = iy(i);
                const hasDot = Boolean(P.clue[i] || (P.hasMidloop && P.midloopAtCell[i] >= 0));
                const d = hasDot ? S * 0.28 : S * 0.20;
                const path = `M${x} ${y - d}L${x + d} ${y}L${x} ${y + d}L${x - d} ${y}Z`;
                nodes.push(svgEl('path', { class: 'line-end-halo', d: path }));
                const attrs = { class: 'line-end', d: path };
                if (stroke) attrs.style = `stroke:${stroke}`;
                nodes.push(svgEl('path', attrs));
              }
            }
          }
        }
      }
      this._topHoverG.replaceChildren(...nodes);
    }
  }

  // ---- pointer handling

  coordsFromEvent(e) {
    const svg = this._svg || this.el.querySelector('svg');
    if (!svg || !this.P) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const { W, H } = this.size();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const sy = ((e.clientY - rect.top) / rect.height) * H;
    return { gx: sx - LABEL - PAD, gy: sy - LABEL - PAD };
  }

  setHover(cell, edge, face = -1) {
    if (this.hoverCell === cell && this.hoverEdge === edge && this.hoverFace === face) return;
    this.hoverCell = cell;
    this.hoverEdge = edge;
    this.hoverFace = face;
    this.renderHover();
  }

  down(e) {
    if (!this.P || this.gesture || (e.button !== 0 && e.button !== 2)) return;
    const c = this.coordsFromEvent(e);
    const hit = c ? hitTestCoords(this.P, c.gx, c.gy) : null;
    if (!hit) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.h.onStart();
    this.gesture = {
      id: e.pointerId,
      right: e.button === 2,
      startHit: hit,
      startX: e.clientX,
      startY: e.clientY,
      lastGx: c.gx,
      lastGy: c.gy,
      paintedFaces: hit.kind === 'face' ? new Set([hit.face]) : null,
      curCell: hit.cell,
      dragged: false,
      firstStep: true,
      lastEdge: -1,
      trail: [],
    };
    // Apply edge and square clicks immediately on pointerdown for instant feedback
    // (if an edge press transitions into a drag, onBeginDrag restores pre-click state before stepping;
    //  if a square press transitions into a drag, it keeps painting the color just applied on pointerdown)
    if (hit.kind === 'edge') {
      if (e.button === 2) this.h.onEdgeRight(hit.edge);
      else this.h.onEdgeTap(hit.edge);
    } else if (hit.kind === 'face') {
      if (e.button === 2) this.h.onFaceRight?.(hit.face);
      else this.h.onFaceTap?.(hit.face);
    } else {
      this.renderHover();
    }
  }

  move(e) {
    if (!this.P) return;
    const c = this.coordsFromEvent(e);
    if (!this.gesture) {
      if (e.pointerType === 'touch') return;
      const hit = c ? hitTestCoords(this.P, c.gx, c.gy) : null;
      if (!hit) this.setHover(-1, -1, -1);
      else if (hit.kind === 'face') this.setHover(-1, -1, hit.face);
      else this.setHover(hit.cell, hit.kind === 'edge' ? hit.edge : -1, -1);
      return;
    }
    if (e.pointerId !== this.gesture.id || !c) return;
    if (!this.gesture.dragged && Math.hypot(e.clientX - this.gesture.startX, e.clientY - this.gesture.startY) < DRAG_SLOP_PX) {
      return;
    }
    if (this.gesture.startHit.kind === 'face') {
      advanceFaceDrag(this.P, this.gesture, c.gx, c.gy, (f) => this.h.onFaceDrag?.(f));
      return;
    }
    const step = this.gesture.right
      ? (a, b, first) => this.h.onCrossStep(a, b, first)
      : (a, b, first) => this.h.onStep(a, b, first);
    const undoStep = this.h.onUndoStep ? () => this.h.onUndoStep() : null;
    const beginDrag = this.h.onBeginDrag ? () => this.h.onBeginDrag() : null;
    advanceDrag(this.P, this.gesture, c.gx, c.gy, step, undoStep, beginDrag);
  }

  up(e) {
    if (!this.gesture || e.pointerId !== this.gesture.id) return;
    const g = this.gesture;
    this.gesture = null;
    try { this.el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!g.dragged && g.startHit.kind === 'cell' && this.P && this.P.clue[g.startHit.cell] === GRAY) {
      if (g.right) this.h.onCellRight?.(g.startHit.cell);
      else this.h.onCellTap?.(g.startHit.cell);
    }
    if (e.pointerType === 'touch') {
      this.hoverCell = -1; this.hoverEdge = -1; this.hoverFace = -1;
    } else {
      const c = this.coordsFromEvent(e);
      const hit = c ? hitTestCoords(this.P, c.gx, c.gy) : null;
      if (!hit) { this.hoverCell = -1; this.hoverEdge = -1; this.hoverFace = -1; }
      else if (hit.kind === 'face') { this.hoverCell = -1; this.hoverEdge = -1; this.hoverFace = hit.face; }
      else { this.hoverCell = hit.cell; this.hoverEdge = hit.kind === 'edge' ? hit.edge : -1; this.hoverFace = -1; }
    }
    const prevRender = this._renderSeq || 0;
    this.h.onEnd(false);
    if (this.marks && (this._renderSeq || 0) === prevRender) this.renderHover();
  }

  cancel() {
    if (!this.gesture) return;
    const id = this.gesture.id;
    this.gesture = null;
    try { this.el.releasePointerCapture(id); } catch { /* ignore */ }
    const prevRender = this._renderSeq || 0;
    this.h.onEnd(true);
    if (this.marks && (this._renderSeq || 0) === prevRender) this.renderHover();
  }
}
