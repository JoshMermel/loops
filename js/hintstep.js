// Bridges edge-only player board marks and the human-style solver for Hint and "Correct so far?" (pure, no DOM).
//
// Player marks:
//   marks.edges: Uint8Array(numEdges) — 0 blank, 1 loop segment (ON), 2 crossed out (X / OFF)
//   marks.autoE: optional Uint8Array(numEdges) — 1 where an X was placed automatically by Auto-X
import {
  E_UNKNOWN, E_ON, E_OFF,
  initialState, decodeSolution,
} from './logic.js';
import { nextSteps } from './rating.js';
import { explainStep } from './explain.js';

/** Convert edge-only player board marks into a solver state `st` (circles start as LOOP). */
export function stateFromMarks(P, marks) {
  const st = initialState(P);
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    if (marks.edges[x] === 1) st.e[x] = E_ON;
    else if (marks.edges[x] === 2) st.e[x] = E_OFF;
  }
  return st;
}

/**
 * Compare player marks against the stored solution (for "Correct so far?" and Hint's mistake check).
 * Auto-X marks are excluded so error counts only report the player's own mistakes.
 * Returns { wrongEdges: [edgeIdx], total: number }.
 */
export function checkMarksAgainstSolution(P, marks, solutionStr = P.solution) {
  const wrongEdges = [];
  if (!solutionStr || solutionStr.length !== P.N) return { wrongEdges, total: 0 };
  const sol = decodeSolution(P, solutionStr);
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    if (marks.edges[x] === 1 && sol.e[x] !== E_ON) wrongEdges.push(x);
    else if (marks.edges[x] === 2 && sol.e[x] === E_ON && !(marks.autoE && marks.autoE[x])) wrongEdges.push(x);
  }
  return { wrongEdges, total: wrongEdges.length };
}

/**
 * Compute the next Hint from player `marks`.
 * First reports any wrong marks (if solution is known); otherwise replays the scorer's nextSteps()
 * and explains every firing of the cheapest applicable rule.
 */
export function computeHint(P, marks) {
  const wrong = checkMarksAgainstSolution(P, marks);
  if (wrong.total > 0) return { kind: 'wrong', ...wrong };

  const st = stateFromMarks(P, marks);
  const res = nextSteps(P, st);
  if (!res) {
    const undecided = [];
    for (let i = 0; i < P.N; i++) {
      let hasUnk = false;
      for (let d = 0; d < 4; d++) {
        const x = P.ed[i * 4 + d];
        if (x >= 0 && st.e[x] === E_UNKNOWN) { hasUnk = true; break; }
      }
      if (hasUnk) undecided.push(i);
    }
    return { kind: 'stuck', undecided };
  }

  const hints = res.firings.map((f) => explainStep(P, {
    rule: res.rule,
    tier: res.tier,
    weight: res.weight,
    sets: f.sets,
    info: f.info,
  }, st));

  return { kind: 'step', rule: res.rule, tier: res.tier, weight: res.weight, hints };
}
