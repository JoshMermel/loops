// Turns a step of the human-style solver (js/rating.js) into something the Hint button can show:
// a clear English sentence, the cells to look at (by role), and the ghost marks to draw on the board.
import {
  E_ON, E_OFF,
  colName, edgeCells,
} from './logic.js';
import { ruleLabel, oddOpenEnds, chokepointCheck } from './rating.js';
import { replayImagine } from './imagine.js';
import { faceCoords } from './faceparity.js';

export const cellName = (P, i) => `${colName(i % P.cols)}${((i / P.cols) | 0) + 1}`;
export const edgeName = (P, x) => {
  const [a, b] = edgeCells(P, x);
  return `${cellName(P, a)}–${cellName(P, b)}`;
};
export const faceName = (P, f) => {
  const fc = faceCoords(P, f);
  if (!fc) return 'outside the board';
  return `${colName(fc.c)}${fc.r + 1}–${colName(fc.c + 1)}${fc.r + 2}`;
};
const DIR_WORD = ['up', 'right', 'down', 'left'];
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const joinList = (items) => {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
};

/** Roles a highlighted cell can have (the board gives each its own color/outline). */
export const ROLES = {
  clue: 'the circle',
  area: 'the area involved',
  focus: 'the cell being decided',
  problem: 'where a contradiction occurs',
  exit: 'the remaining ways out',
  path: 'the ends of a path',
};

/** Extract deduplicated ghost edge targets from a firing's `sets` (edge-only interaction: draw segments or cross out edges). */
export function targetsOf(sets) {
  const segOn = [], segOff = [];
  const seenOn = new Set(), seenOff = new Set();
  for (const [kind, idx, v] of sets) {
    if (kind === 'e') {
      if (v === E_ON && !seenOn.has(idx)) { seenOn.add(idx); segOn.push(idx); }
      else if (v === E_OFF && !seenOff.has(idx)) { seenOff.add(idx); segOff.push(idx); }
    }
  }
  return { segOn, segOff };
}

/** Short human description of the ghost marks to place. */
export function describeMarks(P, targets) {
  const parts = [];
  if (targets.segOn.length) {
    parts.push(targets.segOn.length <= 3
      ? `draw ${joinList(targets.segOn.map((x) => edgeName(P, x)))}`
      : `draw ${plural(targets.segOn.length, 'segment')}`);
  }
  if (targets.segOff.length) {
    parts.push(targets.segOff.length <= 3
      ? `cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}`
      : `cross out ${plural(targets.segOff.length, 'edge')}`);
  }
  return parts.join('; ');
}

/** One short clause describing a single derived step inside an imagined chain. */
function describeChainStep(P, s) {
  const { rule, info, sets } = s;
  const c = info && info.cell !== undefined ? cellName(P, info.cell) : '';
  switch (rule) {
    case 'whiteStraight':
      return `the white circle at ${c} must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'blackExtend':
      return `the black circle at ${c} must go two cells ${DIR_WORD[info.dir]}`;
    case 'blackWall':
      return `the black circle at ${c} is blocked ${DIR_WORD[info.blockedDir]} and goes two cells ${DIR_WORD[info.dir]}`;
    case 'blackAdjacent':
      return `the black circle at ${c} goes two cells ${DIR_WORD[info.dir]} away from ${cellName(P, info.other)}`;
    case 'blackPerp':
      return `the black circle at ${c} cannot enter ${cellName(P, info.sideCell)} and goes two cells ${DIR_WORD[info.dir]}`;
    case 'whiteMustTurn':
      return `the white circle at ${c} must turn at its other end`;
    case 'whiteBothStraight':
      return `the white circle at ${c} must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'deadEnd':
      return `${c} becomes a dead end`;
    case 'forcedExits': {
      const segs = sets.filter(([k, , v]) => k === 'e' && v === E_ON).map(([, x]) => edgeName(P, x));
      return segs.length ? `${c} must use ${joinList(segs)}` : `${c} is forced to extend`;
    }
    case 'noEarlyClose':
      return `${edgeName(P, info.edge)} cannot close the loop early`;
    case 'threeWhites':
      return `the three white circles at ${joinList(info.cells.map((k) => cellName(P, k)))} must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'twoWhitesStraight':
      return `the adjacent white circles at ${cellName(P, info.w1)} and ${cellName(P, info.w2)} must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'closingCell':
      return `${edgeName(P, info.edge)} would leave ${c} with only one way out`;
    case 'samePathExits':
      return `the loop must extend out of ${cellName(P, info.ends[0])} and ${cellName(P, info.ends[1])} without closing early`;
    case 'whiteNoTurnAxis':
      return `the white circle at ${c} cannot turn along its blocked axis and must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'blackBlockedTarget':
      return `the black circle at ${c} must avoid its blocked side and go two cells ${DIR_WORD[info.dir]}`;
    case 'blackTwoDiagWhites':
      return `the black circle at ${c} cannot extend between white circles ${cellName(P, info.whites[0])} and ${cellName(P, info.whites[1])}, so it goes two cells ${DIR_WORD[info.dir]}`;
    case 'blackWhiteNoTurn':
      return `the black circle at ${c} cannot extend into white circle ${cellName(P, info.target)} and goes two cells ${DIR_WORD[info.dir]}`;
    case 'whiteCornerPinch':
      return `visiting ${c} would pinch white circle ${cellName(P, info.white)} on both axes`;
    case 'faceShade':
    case 'faceCircle':
      return `inside/outside shading forces ${describeMarks(P, targetsOf(sets))}`;
    case 'twoEndsJoin':
      return `connecting the two open ends forces ${describeMarks(P, targetsOf(sets))}`;
    case 'crossingParity':
      return `loop crossing parity forces ${describeMarks(P, targetsOf(sets))}`;
    default:
      return `forced deductions require ${describeMarks(P, targetsOf(sets))}`;
  }
}

/** Describe what broke at the end of an imagined chain. */
function describeContradiction(P, broke, finalState) {
  if (!broke) return { text: 'a contradiction is reached', cells: [], area: [] };
  switch (broke.kind) {
    case 'threeLines':
      return { text: `${cellName(P, broke.cell)} ends up with three segments`, cells: [broke.cell], area: [] };
    case 'stranded':
      return {
        text: `${cellName(P, broke.cell)} is left with ${broke.ways === 0 ? 'no way out' : 'only one way out'}`,
        cells: [broke.cell],
        area: [],
      };
    case 'whiteBroken':
      return { text: `the white circle at ${cellName(P, broke.cell)} cannot be satisfied`, cells: [broke.cell], area: [] };
    case 'blackBroken':
      return { text: `the black circle at ${cellName(P, broke.cell)} has no room for two straight segments`, cells: [broke.cell], area: [] };
    case 'blackStraight':
      return { text: `the black circle at ${cellName(P, broke.cell)} would go straight instead of turning`, cells: [broke.cell], area: [] };
    case 'earlyClose':
      return { text: `the loop closes early while ${cellName(P, broke.cell)} is still outside it`, cells: [broke.cell], area: [] };
    case 'twoLoops':
      return { text: 'two separate closed loops form', cells: [], area: [] };
    case 'offLine':
    case 'clueOff':
      return { text: `${cellName(P, broke.cell)} conflicts with an off-loop cell`, cells: [broke.cell], area: [] };
    case 'area': {
      if (finalState) {
        const odd = oddOpenEnds(P, finalState);
        if (odd) {
          return {
            text: `an area is sealed off with ${plural(odd.ends.length, 'open end')} (${joinList(odd.ends.slice(0, 4).map((i) => cellName(P, i)))}), which cannot be paired up`,
            cells: odd.ends,
            area: odd.cells,
          };
        }
        const ck = chokepointCheck(P, finalState);
        if (ck) {
          return ck.kind === 'disconnected'
            ? { text: 'some loop cells become cut off from the rest of the loop', cells: [], area: ck.area }
            : { text: `${cellName(P, ck.cut)} becomes a single chokepoint separating loop cells`, cells: [ck.cut], area: ck.area };
        }
      }
      return { text: 'the loop topology becomes impossible (odd open ends or disconnected circles)', cells: [], area: [] };
    }
    default:
      return { text: 'a contradiction is reached', cells: [], area: [] };
  }
}

/**
 * Explain one solver step `{ rule, tier, weight, sets, info }` from position `st`.
 * Returns `{ rule, tier, weight, text, roles, targets, chain }`.
 */
export function explainStep(P, step, st = null) {
  const { rule, tier, weight, sets, info = {} } = step;
  const targets = targetsOf(sets);
  const roles = { clue: [], area: [], focus: [], problem: [], exit: [], path: [] };
  const chain = [];
  let faces = null;
  let text = '';

  const uniq = (arr) => [...new Set(arr.filter((v) => v >= 0))];

  switch (rule) {
    case 'whiteStraight': {
      const c = info.cell;
      roles.clue.push(c);
      text = `The white circle at ${cellName(P, c)} cannot go ${info.axis === 'v' ? 'horizontally' : 'vertically'}, so the loop must go straight ${info.axis === 'v' ? 'vertically' : 'horizontally'} through it.`;
      break;
    }
    case 'blackExtend': {
      const c = info.cell;
      roles.clue.push(c);
      text = `The black circle at ${cellName(P, c)} leaves ${DIR_WORD[info.dir]}, so it must go straight two cells ${DIR_WORD[info.dir]} and cannot exit ${DIR_WORD[info.dir ^ 2]}.`;
      break;
    }
    case 'blackWall': {
      const c = info.cell;
      roles.clue.push(c);
      const why = info.nearEdge ? `too close to the ${DIR_WORD[info.blockedDir]} edge` : `blocked ${DIR_WORD[info.blockedDir]}`;
      text = `The black circle at ${cellName(P, c)} is ${why} to go two straight cells ${DIR_WORD[info.blockedDir]}, so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackAdjacent': {
      const c = info.cell, o = info.other;
      roles.clue.push(c, o);
      text = `The touching black circles at ${cellName(P, c)} and ${cellName(P, o)} cannot connect (each must go straight through its neighbor), so ${cellName(P, c)} goes two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'whiteMustTurn': {
      const c = info.cell;
      roles.clue.push(c);
      roles.focus.push(info.turnEnd);
      roles.path.push(info.straightEnd);
      text = `The white circle at ${cellName(P, c)} goes straight through ${cellName(P, info.straightEnd)}, so the loop must turn at ${cellName(P, info.turnEnd)} (cross out ${edgeName(P, info.edge)}).`;
      break;
    }
    case 'deadEnd': {
      const c = info.cell;
      roles.focus.push(c);
      text = `${cellName(P, c)} has only one available exit left, so the loop cannot pass through it (cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}).`;
      break;
    }
    case 'forcedExits': {
      const c = info.cell;
      roles.focus.push(c);
      for (const x of info.edges || []) {
        const [a, b] = edgeCells(P, x);
        roles.exit.push(a === c ? b : a);
      }
      text = `${cellName(P, c)} is on the loop and has only two exits left, so it must use ${joinList(targets.segOn.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'blackPerp': {
      const c = info.cell;
      roles.clue.push(c);
      roles.problem.push(info.sideCell);
      text = `The black circle at ${cellName(P, c)} cannot enter ${cellName(P, info.sideCell)} (which already has a perpendicular segment), so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'whiteBothStraight': {
      const c = info.cell;
      roles.clue.push(c);
      text = `If the white circle at ${cellName(P, c)} went ${info.blockedAxis === 'v' ? 'vertically' : 'horizontally'}, both ends would go straight without turning; so it must go straight ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'noEarlyClose': {
      roles.path.push(info.a, info.b);
      text = `${cellName(P, info.a)} and ${cellName(P, info.b)} are the two ends of the same open path while other loop cells lie outside it, so ${edgeName(P, info.edge)} cannot connect them.`;
      break;
    }
    case 'samePathExits': {
      roles.focus.push(info.cell);
      roles.path.push(info.a, info.b);
      text = `${cellName(P, info.cell)} is on the loop with three exits, and two of them (${cellName(P, info.a)} and ${cellName(P, info.b)}) lead to the ends of one path; using both would close the loop early, so it must take ${edgeName(P, info.edge)}.`;
      break;
    }
    case 'closingCell': {
      roles.focus.push(info.cell);
      roles.path.push(info.a, info.b);
      text = `${cellName(P, info.cell)} has only two exits left, and both lead to the ends of one path (${cellName(P, info.a)} and ${cellName(P, info.b)}): using it would close the loop early, so cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'threeWhites': {
      roles.clue.push(...info.cells);
      text = `Three white circles in a row (${joinList(info.cells.map((i) => cellName(P, i)))}) cannot go along the row because the middle circle would fail to turn at either end; all three must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'twoWhitesStraight': {
      roles.clue.push(info.w1, info.w2);
      text = `The touching white circles at ${cellName(P, info.w1)} and ${cellName(P, info.w2)} cannot join because ${edgeName(P, info.farEdge)} already continues straight past ${cellName(P, info.w1)}; both must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'whiteNoTurnAxis': {
      roles.clue.push(info.cell);
      roles.problem.push(...(info.ends || []));
      const reasonText = (cell, r) => {
        const nm = cellName(P, cell);
        if (r === 'white') return `${nm} is a white circle`;
        if (r === 'straight') return `${nm} already goes straight`;
        return `${nm} has both turns blocked`;
      };
      const blocked = info.blockedAxis === 'v' ? 'vertically' : info.blockedAxis === 'h' ? 'horizontally' : (info.axis === 'v' ? 'horizontally' : 'vertically');
      const why = info.ends && info.reasons && info.ends.length === 2
        ? ` (${reasonText(info.ends[0], info.reasons[0])} and ${reasonText(info.ends[1], info.reasons[1])})`
        : '';
      text = `The white circle at ${cellName(P, info.cell)} must turn at one of its two ends, so it cannot go ${blocked}${why}; it must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'blackBlockedTarget': {
      roles.clue.push(info.cell, info.target);
      const why = info.reason === 'whiteWall'
        ? `the white circle at ${cellName(P, info.target)} cannot continue straight through`
        : `the black circle at ${cellName(P, info.target)} already continues straight out the far side`;
      text = `The black circle at ${cellName(P, info.cell)} cannot extend toward ${cellName(P, info.target)} because ${why}; so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackTwoDiagWhites': {
      roles.clue.push(info.cell, ...info.whites);
      text = `The black circle at ${cellName(P, info.cell)} cannot send a ray ${DIR_WORD[info.blockedDir]} between the two diagonal white circles at ${cellName(P, info.whites[0])} and ${cellName(P, info.whites[1])} (doing so would block whichever side its second leg takes); so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackWhiteNoTurn': {
      roles.clue.push(info.cell, info.target);
      roles.problem.push(info.farCell);
      const farNm = cellName(P, info.farCell);
      const why = info.reason === 'white'
        ? `${farNm} is another white circle`
        : info.reason === 'straight'
          ? `${farNm} already continues straight`
          : `${farNm} has both turns blocked`;
      text = `The black circle at ${cellName(P, info.cell)} cannot extend into the white circle at ${cellName(P, info.target)} because ${why}, leaving ${cellName(P, info.target)} unable to turn on either side; so ${cellName(P, info.cell)} must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'whiteCornerPinch': {
      roles.focus.push(info.cell);
      roles.clue.push(info.white);
      roles.problem.push(...info.neighbors);
      text = `${cellName(P, info.cell)} has only two exits left, pointing to ${cellName(P, info.neighbors[0])} and ${cellName(P, info.neighbors[1])}, which both already have a segment; passing through ${cellName(P, info.cell)} would fill both neighbors and cut off the white circle at ${cellName(P, info.white)} on both axes, so cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'faceShade': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      faces = { in: info.facesIn || [], out: info.facesOut || [], anchored: true };
      const sideName = (par) => (par === 1 ? 'Inside' : 'Outside');
      text = info.val === E_ON
        ? `Inside/outside shading puts opposite sides (${sideName(info.parA)} and ${sideName(info.parB)}) across ${edgeName(P, info.edge)}, so the loop must cross between them (draw ${edgeName(P, info.edge)}).`
        : `Inside/outside shading puts ${sideName(info.parA)} on both sides of ${edgeName(P, info.edge)}, so the loop cannot pass between them (cross out ${edgeName(P, info.edge)}).`;
      break;
    }
    case 'faceCircle': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.clue.push(...(info.clues || []));
      faces = { in: info.facesIn || [], out: info.facesOut || [], anchored: !!info.anchored };
      const label = (par) => (info.anchored ? (par === 1 ? 'Inside' : 'Outside') : (par === 1 ? 'Side A' : 'Side B'));
      const describeLink = (s, destPar) => {
        const dst = faceName(P, s.to);
        const col = label(destPar);
        switch (s.reason.kind) {
          case 'edgeOn':
            return `crossing line ${edgeName(P, s.reason.edge)} makes ${dst} ${col}`;
          case 'edgeOff':
            return `crossing ✕ at ${edgeName(P, s.reason.edge)} keeps ${dst} ${col}`;
          case 'whiteDiag':
            return `flipping diagonally across white circle ${cellName(P, s.reason.cell)} makes ${dst} ${col}`;
          case 'blackDiag':
            return `by the 3-to-1 corner rule at black circle ${cellName(P, s.reason.cell)}, ${dst} is ${col}`;
          case 'blackLeg':
            return `black circle ${cellName(P, s.reason.cell)}'s forced 2-step leg makes ${dst} ${col}`;
          default:
            return `${dst} is ${col}`;
        }
      };
      const clauses = [];
      for (const ch of info.chains || []) {
        if (!ch.length) continue;
        let curP = ch[0].from === info.EXT ? 0 : (ch[0].from === info.fA ? info.parA : info.parB);
        for (const s of ch) {
          curP ^= s.xor;
          if (clauses.length < 4) clauses.push(describeLink(s, curP));
        }
      }
      const extraSteps = (info.hops || 0) - clauses.length;
      const chainDesc = clauses.length
        ? (extraSteps > 0 ? `${clauses.join('; ')} (+${plural(extraSteps, 'more step')})` : clauses.join('; '))
        : '';
      const sideStr = info.val === E_ON
        ? `puts opposite sides (${label(info.parA)} and ${label(info.parB)}) across ${edgeName(P, info.edge)}, so draw ${edgeName(P, info.edge)}`
        : `puts ${label(info.parA)} on both sides of ${edgeName(P, info.edge)}, so cross out ${edgeName(P, info.edge)}`;
      text = chainDesc
        ? `Circle shading: ${chainDesc}. That ${sideStr}.`
        : `Circle shading ${sideStr}.`;
      break;
    }
    case 'twoEndsJoin': {
      roles.area.push(...(info.area || []));
      roles.path.push(info.u, info.v, info.uFar, info.vFar);
      text = `The highlighted area has only two open ends (${cellName(P, info.u)} and ${cellName(P, info.v)}), so they must connect inside it; that makes ${cellName(P, info.uFar)} and ${cellName(P, info.vFar)} ends of one path, so ${edgeName(P, info.edge)} cannot close them early.`;
      break;
    }
    case 'chokepoint':
    case 'chokepointArea': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      if (info.cut !== undefined && info.cut >= 0) roles.problem.push(info.cut);
      text = info.kind === 'disconnected'
        ? `Without ${edgeName(P, info.edge)}, loop cells in the highlighted area would be completely cut off from the rest of the loop, so ${edgeName(P, info.edge)} must be drawn.`
        : `Without ${edgeName(P, info.edge)}, ${cellName(P, info.cut)} would be the only cell connecting the highlighted area to the rest of the loop (a single loop cannot pass through it twice), so ${edgeName(P, info.edge)} must be drawn.`;
      break;
    }
    case 'parityPocket':
    case 'parityForces': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      roles.path.push(...(info.ends || []));
      const hypTxt = info.hyp === E_ON ? `drawing ${edgeName(P, info.edge)}` : `crossing out ${edgeName(P, info.edge)}`;
      const resTxt = info.hyp === E_ON ? `cross out ${edgeName(P, info.edge)}` : `draw ${edgeName(P, info.edge)}`;
      text = `If you tried ${hypTxt}, the highlighted area would be sealed off with ${plural(info.ends.length, 'open end')} (odd, so they can't all pair up); therefore ${resTxt}.`;
      break;
    }
    case 'crossingParity': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      const act = info.val === E_ON ? `must be drawn` : `cannot be drawn`;
      text = `The loop must cross the border of the highlighted rectangle an even number of times (${info.on} crossings so far, 1 undecided), so ${edgeName(P, info.edge)} ${act}.`;
      break;
    }
    case 'imagineLocal':
    case 'imagineTrace':
    case 'imagineChain': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      const hypStr = info.hyp === E_ON ? `a segment at ${edgeName(P, info.edge)}` : `no segment at ${edgeName(P, info.edge)}`;
      const verdict = info.deduce === E_ON ? `draw ${edgeName(P, info.edge)}` : `cross out ${edgeName(P, info.edge)}`;
      let finalState = null;
      if (st) {
        const rep = replayImagine(P, st, info);
        finalState = rep.state;
        // Collect all newly turned-on edges in the imagined chain for dashed orange visualization
        if (info.hyp === E_ON) chain.push(info.edge);
        for (let x = 0; x < P.numEdges; x++) {
          if (rep.state.e[x] === E_ON && st.e[x] !== E_ON && x !== info.edge) chain.push(x);
        }
      }
      const clauses = (info.steps || []).map((s) => describeChainStep(P, s));
      const end = describeContradiction(P, info.broke, finalState);
      roles.problem.push(...end.cells);
      roles.area.push(...end.area);
      const chainText = clauses.length
        ? `: then ${clauses.join('; then ')}; and finally ${end.text}.`
        : `: immediately ${end.text}.`;
      text = `Imagine ${hypStr}${chainText} So ${verdict}.`;
      break;
    }
    case 'tryEdge': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      const hypStr = info.hyp === E_ON ? `a segment at ${edgeName(P, info.edge)}` : `no segment at ${edgeName(P, info.edge)}`;
      const verdict = info.hyp === E_ON ? `cross out ${edgeName(P, info.edge)}` : `draw ${edgeName(P, info.edge)}`;
      const traceClauses = (info.trace || []).slice(0, 4).map((t) => describeChainStep(P, t));
      const detail = traceClauses.length
        ? ` (starting with: ${traceClauses.join('; then ')}; reaching a contradiction after ${plural(info.steps, 'step')})`
        : ` (contradiction after ${plural(info.steps, 'step')})`;
      text = `Imagine ${hypStr} and follow the forced deductions${detail}. So ${verdict}.`;
      break;
    }
    default: {
      text = `${ruleLabel(rule)}: ${describeMarks(P, targets)}.`;
    }
  }

  for (const k of Object.keys(roles)) roles[k] = uniq(roles[k]);
  return { rule, tier, weight, text, roles, targets, chain: uniq(chain), faces };
}
