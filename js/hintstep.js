// Bridges edge-only player board marks and the human-style solver for Hint and "Correct so far?" (pure, no DOM).
//
// Player marks:
//   marks.edges: Uint8Array(numEdges) — 0 blank, 1 loop segment (ON), 2 crossed out (X / OFF)
//   marks.autoE: optional Uint8Array(numEdges) — 1 where an X was placed automatically by Auto-X
import {
  WHITE, BLACK, E_UNKNOWN, E_ON, E_OFF,
  initialState, cloneState, propagate, decodeSolution, isSolved,
} from './logic.js';
import { nextSteps, contradiction } from './rating.js';
import { buildFaceParity } from './faceparity.js';
import { explainStep } from './explain.js';

/** Convert player board marks (edges + optional gray pearl labels) into a solver state `st`. */
export function stateFromMarks(P, marks) {
  const st = initialState(P);
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    if (marks.edges[x] === 1) st.e[x] = E_ON;
    else if (marks.edges[x] === 2) st.e[x] = E_OFF;
  }
  if (st.hasGray && marks.grays) {
    for (let k = 0; k < P.grays.length; k++) {
      const lbl = marks.grays[k];
      if (lbl === WHITE || lbl === BLACK) st.clue[P.grays[k]] = lbl;
    }
  }
  return st;
}

function validSolutionState(P, solutionStr = P.solution) {
  if (!solutionStr || solutionStr.length !== P.N) return null;
  const sol = decodeSolution(P, solutionStr);
  return isSolved(P, sol.e) ? sol : null;
}

/**
 * Compare player marks (drawn segments, manual X's, and manual gray pearl labels) against the stored solution.
 * Auto-placed marks (`autoE`, `autoG`) are excluded so error counts only report the player's own mistakes.
 * Returns { wrongEdges: [edgeIdx], wrongClues: [cellIdx], total: number }.
 */
export function checkMarksAgainstSolution(P, marks, solutionStr = P.solution) {
  const wrongEdges = [];
  const wrongClues = [];
  const sol = validSolutionState(P, solutionStr);
  if (!sol) return { wrongEdges, wrongClues, total: 0 };
  for (let x = 0; x < P.numEdges; x++) {
    if (P.edgeA[x] < 0) continue;
    if (marks.edges[x] === 1 && sol.e[x] !== E_ON) wrongEdges.push(x);
    else if (marks.edges[x] === 2 && sol.e[x] === E_ON && !(marks.autoE && marks.autoE[x])) wrongEdges.push(x);
  }
  if (P.grays && P.grays.length && marks.grays) {
    for (let k = 0; k < P.grays.length; k++) {
      const lbl = marks.grays[k];
      if ((lbl === WHITE || lbl === BLACK) && !(marks.autoG && marks.autoG[k])) {
        const i = P.grays[k];
        if (sol.clue[i] !== lbl) wrongClues.push(i);
      }
    }
  }
  return { wrongEdges, wrongClues, total: wrongEdges.length + wrongClues.length };
}

/**
 * Compute the next Hint from player `marks`.
 * First reports any wrong marks (if a valid solution is known); otherwise checks for local/topological/parity
 * contradictions and replays the scorer's nextSteps() explaining every firing of the cheapest rule.
 */
export function computeHint(P, marks) {
  const sol = validSolutionState(P);
  if (sol) {
    const wrongEdges = [];
    const wrongClues = [];
    const wrongAuto = [];
    for (let x = 0; x < P.numEdges; x++) {
      if (P.edgeA[x] < 0) continue;
      if (marks.edges[x] === 1 && sol.e[x] !== E_ON) wrongEdges.push(x);
      else if (marks.edges[x] === 2 && sol.e[x] === E_ON) {
        if (marks.autoE && marks.autoE[x]) wrongAuto.push(x);
        else wrongEdges.push(x);
      }
    }
    if (P.grays && P.grays.length && marks.grays) {
      for (let k = 0; k < P.grays.length; k++) {
        const lbl = marks.grays[k];
        if ((lbl === WHITE || lbl === BLACK) && !(marks.autoG && marks.autoG[k])) {
          const i = P.grays[k];
          if (sol.clue[i] !== lbl) wrongClues.push(i);
        }
      }
    }
    const total = wrongEdges.length + wrongClues.length;
    if (total > 0) return { kind: 'wrong', wrongEdges, wrongClues, total };
    if (wrongAuto.length > 0) return { kind: 'wrong', wrongEdges: wrongAuto, wrongClues: [], total: wrongAuto.length, fromShade: true };
  }

  const st = stateFromMarks(P, marks);
  if (!sol) {
    const chk = cloneState(st);
    if (!propagate(P, chk) || contradiction(P, chk) || buildFaceParity(P, chk, { buildGraph: false, useCircles: true }).conflict) {
      return { kind: 'wrong', wrongEdges: [], wrongClues: [], total: 0, contradiction: true };
    }
  }
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

/**
 * Pure two-press progressive hint state transition.
 *   - First press on a board state -> stage 1 (where to look, no ghost marks / chains / face spoiler)
 *   - Second press while stage 1 is visible -> stage 2 (full deduction + ghost marks)
 *   - Further presses when multiple firings exist -> next firing at stage 1
 *   - Re-pressing after dismissing the toast re-shows the same stage without skipping ahead.
 *   - Mistakes (`wrong`) and `stuck` always display immediately at stage 2.
 */
export function advanceHint(current, computeFn, { full = false } = {}) {
  if (!current) {
    const res = computeFn();
    if (res.kind !== 'step') return { ...res, index: 0, stage: 2, visible: true };
    return { ...res, index: 0, stage: full ? 2 : 1, visible: true };
  }
  if (current.kind !== 'step') return { ...current, visible: true };
  if (!current.visible) {
    return { ...current, stage: full ? 2 : current.stage, visible: true };
  }
  if (current.stage < 2) {
    return { ...current, stage: 2, visible: true };
  }
  if (current.hints.length > 1) {
    return {
      ...current,
      index: (current.index + 1) % current.hints.length,
      stage: full ? 2 : 1,
      visible: true,
    };
  }
  return { ...current, stage: 2, visible: true };
}
