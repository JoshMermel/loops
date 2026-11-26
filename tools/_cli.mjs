// Shared CLI helpers for Masyu tooling scripts in tools/.
import { fileURLToPath } from 'node:url';
import { compile, solve, isSolved, decodeSolution, encodeSolution } from '../js/logic.js';
import { rate, solvedByRules, FIRST_LOOKAHEAD, TIERS } from '../js/rating.js';

/** Absolute path to repository root from any script directly inside `tools/`. */
export const repoRoot = (metaUrl) => fileURLToPath(new URL('..', metaUrl));

/** Read `--name value` from argv; returns `def` when absent or missing a value (next token is another `--flag`). */
export function arg(name, def = null, argv = process.argv) {
  const i = argv.indexOf(`--${name}`);
  if (i <= 0 || i + 1 >= argv.length) return def;
  const val = argv[i + 1];
  if (val.startsWith('--')) return def;
  return val;
}

/** Canonical puzzle ordering: board area -> tier -> solved before Expert+ (unsolved) -> score. */
export const byOrder = (a, b) => (
  (a.rows * a.cols) - (b.rows * b.cols)
  || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
  || (a.rules === 'unsolved' ? 1 : 0) - (b.rules === 'unsolved' ? 1 : 0)
  || (a.score ?? 0) - (b.score ?? 0)
);

/**
 * Independently verify a generated puzzle (compiles cleanly, stored solution is valid,
 * complete exact search confirms uniqueness and matches stored solution) and compute its human rating.
 * Returns the rating object from `rate()`, or `null` if verification fails.
 */
export function verifyPuzzle(p, { maxNodes = 500000 } = {}) {
  const fresh = compile({
    name: p.name,
    rows: p.rows,
    cols: p.cols,
    clues: p.clues,
    ...(p.fullBoard ? { fullBoard: true } : {}),
    ...(p.voids && p.voids.length ? { voids: p.voids } : {}),
    ...(p.givens && p.givens.length ? { givens: p.givens } : {}),
    ...(p.slither && p.slither.length ? { slither: p.slither } : {}),
    ...(p.midloop && p.midloop.length ? { midloop: p.midloop } : {}),
  });
  const dec = decodeSolution(fresh, p.solution);
  if (!isSolved(fresh, dec.e)) return null;
  const byRules = solvedByRules(fresh, FIRST_LOOKAHEAD);
  if (byRules.solved) {
    if (encodeSolution(fresh, byRules.state) !== p.solution) return null;
  } else {
    const exact = solve(fresh, { limit: 2, maxNodes });
    if (exact.exceeded || exact.count !== 1) return null;
    if (encodeSolution(fresh, exact.solutions[0]) !== p.solution) return null;
  }
  return rate(fresh);
}
