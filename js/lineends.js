// Find the other end of a plain open path starting from `cell`, for hover rings in js/board.js.
export function otherEnd(P, edges, cell) {
  const next = (i, from) => {
    const out = [];
    for (let d = 0; d < 4; d++) {
      const x = P.ed[i * 4 + d], j = P.nb[i * 4 + d];
      if (x >= 0 && edges[x] === 1 && j !== from) out.push(j);
    }
    return out;
  };
  let from = -1, at = cell;
  for (let steps = 0; steps <= P.N; steps++) {
    const ahead = next(at, from);
    if (ahead.length > 1) return -1;
    if (ahead.length === 0) return at === cell ? -1 : at;
    from = at; at = ahead[0];
  }
  return -1;
}
