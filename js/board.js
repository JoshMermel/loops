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
import { colName, edgeCells, WHITE, BLACK, GRAY } from './logic.js';
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
      let nxt;
      if (dir && ((dir.dr && Math.sign(dr) === dir.dr) || (dir.dc && Math.sign(dc) === dir.dc))) {
        nxt = (cr + dir.dr) * P.cols + (cc + dir.dc);
      } else {
        nxt = Math.abs(dr) >= Math.abs(dc)
          ? (cr + Math.sign(dr)) * P.cols + cc
          : cr * P.cols + (cc + Math.sign(dc));
      }
      fireEdge(cur, nxt);
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
      if (v !== sa && v !== sb && Math.hypot(px - nc, py - nr) <= DRAG_VERTEX_RAD + EPS) {
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
  if (v !== g.curCell && v !== prevBack && Math.hypot(px - nc, py - nr) <= DRAG_VERTEX_RAD + EPS) {
    // Don't let vertex snap bypass 90° turn hysteresis for an immediate neighbor unless very close to that vertex
    walkCells(g.curCell, v);
    return;
  }

  // Tight track fallback for fast corner swipes (strictly away from intersections, ignoring face centers)
  let farEdge = -1, farDist = DRAG_TURN_TOL;
  const fc = Math.floor(px);
  if (fc >= 0 && fc + 1 < P.cols) {
    const t = px - fc, dist = Math.abs(py - nr);
    if (t >= DRAG_TURN_MIN - EPS && t <= 1 - DRAG_TURN_MIN + EPS && dist <= farDist + EPS) {
      farDist = dist;
      farEdge = 2 * (nr * P.cols + fc);
    }
  }
  const fr = Math.floor(py);
  if (fr >= 0 && fr + 1 < P.rows) {
    const t = py - fr, dist = Math.abs(px - nc);
    if (t >= DRAG_TURN_MIN - EPS && t <= 1 - DRAG_TURN_MIN + EPS && dist <= farDist + EPS) {
      farDist = dist;
      farEdge = 2 * (fr * P.cols + nc) + 1;
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
    const fx = x / S - fc;
    const fy = y / S - fr;
    if (fx < FACE_DRAG_INSET || fx > 1 - FACE_DRAG_INSET || fy < FACE_DRAG_INSET || fy > 1 - FACE_DRAG_INSET) continue;
    const f = fr * fcMax + fc;
    if (!g.paintedFaces.has(f)) {
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
 *   - { kind: 'edge', edge, cell } when near a track midpoint
 *   - { kind: 'face', face, cell, edge: -1 } when inside the center of a dual square
 *   - { kind: 'cell', cell, edge: -1 } when near an intersection vertex (or outer margin)
 *   - null outside the board.
 */
export function hitTestCoords(P, gx, gy) {
  if (!P) return null;
  const maxX = (P.cols - 1) * S, maxY = (P.rows - 1) * S;
  const bound = S * 0.52;
  if (gx < -bound || gy < -bound || gx > maxX + bound || gy > maxY + bound) return null;

  const nc = Math.max(0, Math.min(P.cols - 1, Math.round(gx / S)));
  const nr = Math.max(0, Math.min(P.rows - 1, Math.round(gy / S)));
  const cell = nr * P.cols + nc;

  let bestEdge = -1, bestDist = EDGE_TOL * S;

  // Check nearest horizontal track: row nr, between col fc and fc+1
  const fc = Math.floor(gx / S);
  if (fc >= 0 && fc + 1 < P.cols) {
    const t = gx / S - fc;
    const dist = Math.abs(gy - nr * S);
    if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
      bestDist = dist;
      bestEdge = 2 * (nr * P.cols + fc);
    }
  }

  // Check nearest vertical track: col nc, between row fr and fr+1
  const fr = Math.floor(gy / S);
  if (fr >= 0 && fr + 1 < P.rows) {
    const t = gy / S - fr;
    const dist = Math.abs(gx - nc * S);
    if (t > END_DEAD && t < 1 - END_DEAD && dist < bestDist) {
      bestDist = dist;
      bestEdge = 2 * (fr * P.cols + nc) + 1;
    }
  }

  if (bestEdge >= 0) return { kind: 'edge', edge: bestEdge, cell };

  // Check interior of a dual square (disjoint from track bands and intersection circles)
  if (fr >= 0 && fr + 1 < P.rows && fc >= 0 && fc + 1 < P.cols) {
    const fx = gx / S - fc, fy = gy / S - fr;
    if (fx >= EDGE_TOL && fx <= 1 - EDGE_TOL && fy >= EDGE_TOL && fy <= 1 - EDGE_TOL) {
      return { kind: 'face', face: fr * (P.cols - 1) + fc, cell, edge: -1 };
    }
  }

  return { kind: 'cell', cell, edge: -1 };
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
    if (!P) { this.el.innerHTML = ''; return; }
    this.marks = marks; this.info = info; this.hint = hint;

    const wanted = new Set();
    (info.clueState || []).forEach((st, k) => { if (st === 'bad') wanted.add(`c${k}`); });
    if (info.badFaces) for (const f of info.badFaces) wanted.add(`f${f}`);
    if (info.earlyLoops) for (const x of info.earlyLoops) wanted.add(`l${x}`);
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

    let g = `<rect class="board-bg" x="1.5" y="1.5" width="${boardW - 3}" height="${boardH - 3}" rx="8"/>`;

    // Dual-face Inside / Outside shading (under grid lines and hint overlays)
    const fr = P.rows - 1, fc = P.cols - 1;
    if (marks.faces && fr > 0 && fc > 0) {
      for (let f = 0; f < fr * fc; f++) {
        const v = marks.faces[f];
        if (!v) continue;
        const r = (f / fc) | 0, c = f % fc;
        const cls = (v === 1 ? 'face-in' : 'face-out') + (marks.autoF && marks.autoF[f] ? ' auto' : '');
        g += `<rect class="${cls}" x="${vx(c)}" y="${vy(r)}" width="${S}" height="${S}"/>`;
        if (show.has(`f${f}`)) {
          g += `<rect class="face-bad" x="${vx(c) + 2.5}" y="${vy(r) + 2.5}" width="${S - 5}" height="${S - 5}" rx="3"/>`;
        }
      }
    }
    const hoverAutoFace = this.hoverFace >= 0 && marks.faces && marks.faces[this.hoverFace] && marks.autoF && marks.autoF[this.hoverFace];
    if (!this.gesture && this.hoverFace >= 0 && !hoverAutoFace && fr > 0 && fc > 0) {
      const r = (this.hoverFace / fc) | 0, c = this.hoverFace % fc;
      g += `<rect class="face-hover" x="${vx(c) + 3}" y="${vy(r) + 3}" width="${S - 6}" height="${S - 6}" rx="4"/>`;
    }

    // Hint dual-tile tints (centered on intersections, under the lattice tracks)
    if (hint) {
      if (hint.faces && fr > 0 && fc > 0) {
        for (const f of hint.faces.in || []) {
          const r = (f / fc) | 0, c = f % fc;
          g += `<rect class="hint-face-in" x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4"/>`;
        }
        for (const f of hint.faces.out || []) {
          const r = (f / fc) | 0, c = f % fc;
          g += `<rect class="hint-face-out" x="${vx(c) + 2}" y="${vy(r) + 2}" width="${S - 4}" height="${S - 4}" rx="4"/>`;
        }
      }
      const tile = (i, cls, pad = 0) => `<rect class="${cls}" x="${ix(i) - S / 2 + pad}" y="${iy(i) - S / 2 + pad}" width="${S - 2 * pad}" height="${S - 2 * pad}" rx="${pad ? 8 : 0}"/>`;
      for (const i of hint.undecided || []) g += tile(i, 'hint-undecided', 2);
      const roles = hint.roles || {};
      for (const i of roles.area || []) g += tile(i, 'hint-area', 0);
      for (const role of ['clue', 'path', 'problem', 'focus']) {
        for (const i of roles[role] || []) g += tile(i, `hint-${role}`, 3);
      }
    }

    // Lattice tracks (horizontal and vertical lines connecting intersections)
    for (let r = 0; r < P.rows; r++) {
      g += `<line class="grid-line" x1="${vx(0)}" y1="${vy(r)}" x2="${vx(P.cols - 1)}" y2="${vy(r)}"/>`;
    }
    for (let c = 0; c < P.cols; c++) {
      g += `<line class="grid-line" x1="${vx(c)}" y1="${vy(0)}" x2="${vx(c)}" y2="${vy(P.rows - 1)}"/>`;
    }

    // Subtle anchor dots at empty intersections so the lattice vertices read crisply
    for (let i = 0; i < P.N; i++) {
      if (P.clue[i] || deg[i] > 0) continue;
      g += `<circle class="grid-dot" cx="${ix(i)}" cy="${iy(i)}" r="1.4"/>`;
    }

    // Branching error ring (deg > 2)
    for (let i = 0; i < P.N; i++) {
      if (deg[i] > 2) g += `<circle class="over" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
    }

    // White and unlabeled-gray circle interior fills (below loop segments so segments pass cleanly through)
    const rWhite = S * 0.21;
    const rBlack = S * 0.22;
    const rGray = S * 0.215;
    const rGrayInner = S * 0.175;
    const rGrayHalo = S * 0.245;
    const grayLabel = (cell) => {
      const k = P.grayAt ? P.grayAt[cell] : -1;
      if (k < 0) return { lbl: 0, auto: false };
      const lbl = marks.grays ? marks.grays[k] : 0;
      const auto = !!(lbl && marks.autoG && marks.autoG[k]);
      return { lbl, auto };
    };
    for (let k = 0; k < P.clues.length; k++) {
      const cl = P.clues[k];
      const st = info.clueState[k] === 'bad' && show.has(`c${k}`) ? 'bad' : '';
      if (cl.t === 'W') {
        g += `<circle class="pearl-white-fill ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rWhite}"/>`;
      } else if (cl.t === 'G') {
        const { lbl } = grayLabel(cl.r * P.cols + cl.c);
        if (lbl === 0) g += `<circle class="pearl-gray-fill ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGray}"/>`;
        else if (lbl === WHITE) g += `<circle class="pearl-white-fill ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGrayInner}"/>`;
      }
    }

    // Drawn loop segments directly along the lattice tracks (with red highlight + glow on early-closed loops)
    const pc = this.opts.pathColors;
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1 || !show.has(`l${x}`)) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      g += `<line class="seg-bad-halo" stroke-width="${S * 0.30}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 1) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const isBadLoop = show.has(`l${x}`);
      const a = P.edgeA[x];
      const style = !isBadLoop && this.opts.colorLines && pc
        ? ` style="stroke:${pc[colorOf.get(find(a)) % pc.length]}"`
        : '';
      g += `<line class="seg${isBadLoop ? ' bad' : ''}"${style} stroke-width="${S * 0.14}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }

    // Circle outlines (white), solid discs (black), and gray/labeled-gray circles on intersections
    for (let k = 0; k < P.clues.length; k++) {
      const cl = P.clues[k];
      const st = info.clueState[k] === 'bad' && show.has(`c${k}`) ? 'bad' : '';
      if (cl.t === 'W') {
        g += `<circle class="pearl-white-ring ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rWhite}"/>`;
      } else if (cl.t === 'G') {
        const { lbl, auto } = grayLabel(cl.r * P.cols + cl.c);
        const autoCls = auto ? ' auto' : '';
        if (lbl === 0) {
          g += `<circle class="pearl-gray-ring ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGray}"/>`;
        } else if (lbl === WHITE) {
          g += `<circle class="pearl-gray-halo${autoCls} ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGrayHalo}"/>`;
          g += `<circle class="pearl-white-ring pearl-gray-inner ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGrayInner}"/>`;
        } else if (lbl === BLACK) {
          g += `<circle class="pearl-gray-halo${autoCls} ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGrayHalo}"/>`;
          g += `<circle class="pearl-black pearl-gray-inner ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rGrayInner}"/>`;
        }
      } else {
        g += `<circle class="pearl-black ${st}" cx="${vx(cl.c)}" cy="${vy(cl.r)}" r="${rBlack}"/>`;
      }
    }

    // Small crisp ✕ marks on crossed-out lattice tracks (auto-placed ones are fainter)
    for (let x = 0; x < P.numEdges; x++) {
      if (marks.edges[x] !== 2) continue;
      const [x1, y1, x2, y2] = segCoords(x);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = S * 0.085;
      const path = `M${mx - d} ${my - d}L${mx + d} ${my + d}M${mx - d} ${my + d}L${mx + d} ${my - d}`;
      const autoCls = marks.autoE && marks.autoE[x] ? ' auto' : '';
      g += `<path class="edge-x-halo${autoCls}" d="${path}"/><path class="edge-x${autoCls}" d="${path}"/>`;
    }

    // Hint overlays
    if (hint) {
      const roles = hint.roles || {};
      const targets = hint.targets || {};
      for (const i of roles.exit || []) g += `<circle class="hint-exit" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.30}"/>`;
      for (const i of roles.focus || []) g += `<circle class="hint-focus-ring" cx="${ix(i)}" cy="${iy(i)}" r="${S * 0.32}"/>`;
      for (const x of hint.chain || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        g += `<line class="chain-seg" stroke-width="${S * 0.11}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }
      for (const x of targets.segOn || []) {
        const [x1, y1, x2, y2] = segCoords(x);
        const len = Math.hypot(x2 - x1, y2 - y1), k = (S * 0.24) / len;
        g += `<line class="ghost-seg" stroke-width="${S * 0.14}" x1="${x1 + (x2 - x1) * k}" y1="${y1 + (y2 - y1) * k}" x2="${x2 - (x2 - x1) * k}" y2="${y2 - (y2 - y1) * k}"/>`;
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

    // Hover feedback (track midpoint highlight, tappable gray circle ring, or open line-end diamonds)
    if (!this.gesture) {
      const hoverAutoX = this.hoverEdge >= 0 && marks.edges[this.hoverEdge] === 2 && marks.autoE && marks.autoE[this.hoverEdge];
      if (this.hoverEdge >= 0 && !hoverAutoX) {
        const [x1, y1, x2, y2] = segCoords(this.hoverEdge);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        g += `<circle class="edge-hover" cx="${mx}" cy="${my}" r="${S * 0.16}"/>`;
      } else if (this.hoverCell >= 0) {
        if (P.clue[this.hoverCell] === GRAY) {
          const { auto } = grayLabel(this.hoverCell);
          if (!auto) g += `<circle class="pearl-hover" cx="${ix(this.hoverCell)}" cy="${iy(this.hoverCell)}" r="${S * 0.29}"/>`;
        }
        if (deg[this.hoverCell] === 1) {
          const far = otherEnd(P, marks.edges, this.hoverCell);
          if (far >= 0) {
            const strokeStyle = this.opts.colorLines && pc
              ? ` style="stroke:${pc[colorOf.get(find(this.hoverCell)) % pc.length]}"`
              : '';
            for (const i of [this.hoverCell, far]) {
              const x = ix(i), y = iy(i);
              const d = P.clue[i] ? S * 0.28 : S * 0.20;
              const path = `M${x} ${y - d}L${x + d} ${y}L${x} ${y + d}L${x - d} ${y}Z`;
              g += `<path class="line-end-halo" d="${path}"/>`;
              g += `<path class="line-end"${strokeStyle} d="${path}"/>`;
            }
          }
        }
      }
    }

    // Axis labels aligned directly with the grid lines
    const hc = !this.gesture && this.hoverCell >= 0 ? this.hoverCell % P.cols : -1;
    const hr = !this.gesture && this.hoverCell >= 0 ? (this.hoverCell / P.cols) | 0 : -1;
    let labels = '';
    for (let c = 0; c < P.cols; c++) {
      labels += `<text class="axis-label${c === hc ? ' here' : ''}" x="${LABEL + vx(c)}" y="${LABEL - 3}">${colName(c)}</text>`;
    }
    for (let r = 0; r < P.rows; r++) {
      labels += `<text class="axis-label side${r === hr ? ' here' : ''}" x="${LABEL - 4}" y="${LABEL + vy(r)}">${r + 1}</text>`;
    }

    const defs = `<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="8" height="8"/><line class="hatch-line" x1="0" y1="0" x2="0" y2="8" stroke-width="3"/></pattern></defs>`;
    this.el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${defs}${labels}<g transform="translate(${LABEL} ${LABEL})">${g}</g></svg>`;
  }

  // ---- pointer handling

  coordsFromEvent(e) {
    const svg = this.el.querySelector('svg');
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
    if (this.marks) this.render(this.marks, this.info, this.hint);
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
    this.h.onEnd(false);
    if (this.marks) this.render(this.marks, this.info, this.hint);
  }

  cancel() {
    if (!this.gesture) return;
    const id = this.gesture.id;
    this.gesture = null;
    try { this.el.releasePointerCapture(id); } catch { /* ignore */ }
    this.h.onEnd(true);
  }
}
