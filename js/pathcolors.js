// Stable colors for separate paths of the loop ("Color separate lines").
export const makeColorKeeper = (numEdges) => ({
  birth: new Int32Array(numEdges), pid: new Int32Array(numEdges), colorOfPid: new Map(), born: 0, nextPid: 1,
});

const USE = 0.5;
const REACH = 5;
const kingDistance = (r1, c1, r2, c2) => Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));

export function assignPathColors(keeper, on, rootOf, palette, near) {
  const { birth, pid, colorOfPid } = keeper;
  const n = birth.length;
  for (let x = 0; x < n; x++) {
    if (on[x]) { if (!birth[x]) birth[x] = ++keeper.born; }
    else { birth[x] = 0; pid[x] = 0; }
  }
  const oldest = new Map();
  for (let x = 0; x < n; x++) {
    if (!on[x]) continue;
    const r = rootOf(x);
    if (!oldest.has(r) || birth[x] < birth[oldest.get(r)]) oldest.set(r, x);
  }
  const identity = new Map();
  const claimed = new Set();
  const fresh = [];
  for (const [r, x] of [...oldest.entries()].sort((p, q) => birth[p[1]] - birth[q[1]])) {
    const p = pid[x];
    if (p && colorOfPid.has(p) && !claimed.has(p)) { identity.set(r, p); claimed.add(p); } else fresh.push(r);
  }
  for (const p of [...colorOfPid.keys()]) if (!claimed.has(p)) colorOfPid.delete(p);
  const uses = new Array(palette).fill(0);
  for (const p of claimed) uses[colorOfPid.get(p)]++;
  const placed = new Map();
  if (near) for (const [r, p] of identity) placed.set(r, colorOfPid.get(p));
  const where = near && lineCells(on, rootOf, near);
  for (const r of fresh) {
    let c = 0;
    if (near) {
      const pen = penalties(r, placed, where, palette, near);
      for (let k = 1; k < palette; k++) if (USE * uses[k] + pen[k] < USE * uses[c] + pen[c] - 1e-9) c = k;
    } else {
      for (let k = 1; k < palette; k++) if (uses[k] < uses[c]) c = k;
    }
    const p = keeper.nextPid++;
    colorOfPid.set(p, c); uses[c]++; identity.set(r, p); placed.set(r, c);
  }
  const colorOf = new Map();
  for (const [r, p] of identity) colorOf.set(r, colorOfPid.get(p));
  for (let x = 0; x < n; x++) if (on[x]) pid[x] = identity.get(rootOf(x));
  return colorOf;
}

function lineCells(on, rootOf, near) {
  const { cols } = near, out = new Map();
  for (let x = 0; x < on.length; x++) {
    if (!on[x]) continue;
    const a = x >> 1, b = (x & 1) ? a + cols : a + 1;
    const r = rootOf(x);
    if (!out.has(r)) out.set(r, []);
    out.get(r).push((a / cols) | 0, a % cols, (b / cols) | 0, b % cols);
  }
  return out;
}

function penalties(r, placed, where, palette, near) {
  const pen = new Array(palette).fill(0), mine = where.get(r);
  for (const [o, color] of placed) {
    if (o === r) continue;
    const theirs = where.get(o);
    let d = Infinity;
    for (let i = 0; i < mine.length && d > 1; i += 2) {
      for (let j = 0; j < theirs.length; j += 2) {
        const e = kingDistance(mine[i], mine[i + 1], theirs[j], theirs[j + 1]);
        if (e < d) { d = e; if (d <= 1) break; }
      }
    }
    if (d > REACH) continue;
    const w = 1 / (d * d);
    for (let k = 0; k < palette; k++) pen[k] += w * near.alike(k, color);
  }
  return pen;
}
