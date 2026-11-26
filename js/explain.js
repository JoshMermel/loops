// Turns a step of the human-style solver (js/rating.js) into something the Hint button can show:
// a clear English sentence, the cells to look at (by role), and the ghost marks to draw on the board.
import {
  WHITE, BLACK, E_ON, E_OFF,
  colName, edgeCells,
} from './logic.js';
import { ruleLabel, oddOpenEnds, checkerImbalance, chokepointCheck } from './rating.js';
import { replayImagine } from './imagine.js';
import { faceCoords } from './faceparity.js';
import { describeSlitherChainStep, explainSlitherStep } from './variants/slitherlink.js';
import { describeMidloopChainStep, explainMidloopStep, midDotLoc } from './variants/midloop.js';
import { describeCastleChainStep, explainCastleStep } from './variants/castlewall.js';

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

/** Extract deduplicated ghost targets from a firing's `sets` (segments, crosses, and gray-pearl labels). */
export function targetsOf(sets) {
  const segOn = [], segOff = [], grayWhite = [], grayBlack = [];
  const seenOn = new Set(), seenOff = new Set(), seenGW = new Set(), seenGB = new Set();
  for (const [kind, idx, v] of sets) {
    if (kind === 'e') {
      if (v === E_ON && !seenOn.has(idx)) { seenOn.add(idx); segOn.push(idx); }
      else if (v === E_OFF && !seenOff.has(idx)) { seenOff.add(idx); segOff.push(idx); }
    } else if (kind === 'g') {
      if (v === WHITE && !seenGW.has(idx)) { seenGW.add(idx); grayWhite.push(idx); }
      else if (v === BLACK && !seenGB.has(idx)) { seenGB.add(idx); grayBlack.push(idx); }
    }
  }
  return { segOn, segOff, grayWhite, grayBlack };
}

/** Short human description of the ghost marks to place. */
export function describeMarks(P, targets) {
  const parts = [];
  if (targets.grayWhite && targets.grayWhite.length) {
    parts.push(`label ${joinList(targets.grayWhite.map((i) => cellName(P, i)))} white`);
  }
  if (targets.grayBlack && targets.grayBlack.length) {
    parts.push(`label ${joinList(targets.grayBlack.map((i) => cellName(P, i)))} black`);
  }
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
  const slText = describeSlitherChainStep(P, s, { faceName });
  if (slText) return slText;
  const mlText = describeMidloopChainStep(P, s, { cellName, edgeName });
  if (mlText) return mlText;
  const cwText = describeCastleChainStep(P, s, { cellName });
  if (cwText) return cwText;
  const { rule, info, sets } = s;
  const c = info && info.cell !== undefined ? cellName(P, info.cell) : '';
  switch (rule) {
    case 'whiteStraight':
      return `the white circle at ${c} must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'grayMustBeBlack':
      return `the gray circle at ${c} cannot go straight through and must be black`;
    case 'grayMustBeWhite':
      return `the gray circle at ${c} cannot extend two straight segments both ways and must be white`;
    case 'grayWhiteNoTurn':
      return `the gray circle at ${c} cannot make a valid white-circle turn on either axis and must be black`;
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
      if (info.slitherFace !== undefined && info.slitherFace >= 0) {
        return `${edgeName(P, info.edge)} cannot close the loop early before the ${P.slitherNum[info.slitherFace]} square ${faceName(P, info.slitherFace)} is satisfied`;
      }
      if (info.midIdx !== undefined && info.midIdx >= 0 && P.midloop && P.midloop[info.midIdx]) {
        return `${edgeName(P, info.edge)} cannot close the loop early before the Mid-loop dot at ${midDotLoc(P, P.midloop[info.midIdx], { cellName, edgeName })} is satisfied`;
      }
      if (info.castleIdx !== undefined && info.castleIdx >= 0 && P.castle && P.castle[info.castleIdx]) {
        return `${edgeName(P, info.edge)} cannot close the loop early before the Castle Wall clue at ${cellName(P, P.castle[info.castleIdx].cell)} is satisfied`;
      }
      return `${edgeName(P, info.edge)} cannot close the loop early`;
    case 'threeWhites':
      return `the three white circles at ${joinList(info.cells.map((k) => cellName(P, k)))} must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'twoWhitesStraight':
      return `the adjacent white circles at ${cellName(P, info.w1)} and ${cellName(P, info.w2)} must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'closingCell':
      return `visiting ${c} would join ${cellName(P, info.a)} and ${cellName(P, info.b)} and close the loop early`;
    case 'samePathExits':
      return `${c} cannot connect ${cellName(P, info.a)} and ${cellName(P, info.b)} early, so it must use ${edgeName(P, info.edge)}`;
    case 'whiteNoTurnAxis':
      return `the white circle at ${c} cannot turn along its blocked axis and must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
    case 'blackBlockedTarget':
      return `the black circle at ${c} must avoid its blocked side and go two cells ${DIR_WORD[info.dir]}`;
    case 'blackNoEarlyClose':
      return `the black circle at ${c} cannot extend two cells ${DIR_WORD[info.blockedDir]} into ${cellName(P, info.target)} without closing the loop early, so it goes two cells ${DIR_WORD[info.dir]}`;
    case 'blackTwoDiagWhites':
      return `the black circle at ${c} cannot extend between white circles ${cellName(P, info.whites[0])} and ${cellName(P, info.whites[1])}, so it goes two cells ${DIR_WORD[info.dir]}`;
    case 'blackWhiteNoTurn':
      return `the black circle at ${c} cannot extend into white circle ${cellName(P, info.target)} and goes two cells ${DIR_WORD[info.dir]}`;
    case 'blackMustVisitReach':
      return `the must-visit dot ${cellName(P, info.j)} beside black circle ${cellName(P, info.b)} must draw ${edgeName(P, info.edge)}`;
    case 'whiteCornerPinch':
      return `visiting ${c} would pinch white circle ${cellName(P, info.white)} on both axes`;
    case 'whiteDeadEndPinch':
      return `drawing ${edgeName(P, info.edge)} would pinch white circle ${cellName(P, info.white)} on both axes`;
    case 'boxStrand':
      return `drawing ${edgeName(P, info.edge)} would strand ${cellName(P, info.active)} inside the 2×2 box`;
    case 'corridorNoEarlyClose':
      return `the forced corridor between ${cellName(P, info.a)} and ${cellName(P, info.b)} would close the loop early`;
    case 'faceShade':
    case 'faceCircle':
      return `inside/outside shading forces ${describeMarks(P, targetsOf(sets))}`;
    case 'twoEndsJoin':
      return `connecting the two open ends forces ${describeMarks(P, targetsOf(sets))}`;
    case 'checkerPocket':
    case 'checkerParity':
      return `full-board checkerboard parity forces ${describeMarks(P, targetsOf(sets))}`;
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
    case 'grayBroken':
      return { text: `the gray circle at ${cellName(P, broke.cell)} cannot be either white or black`, cells: [broke.cell], area: [] };
    case 'slitherBroken':
      return {
        text: broke.over
          ? `the ${broke.n} square ${faceName(P, broke.face)} ends up with too many segments`
          : `the ${broke.n} square ${faceName(P, broke.face)} cannot reach ${broke.n} segment${broke.n === 1 ? '' : 's'}`,
        cells: [],
        area: [],
        face: broke.face,
      };
    case 'midloop': {
      const m = P.midloop && P.midloop[broke.midIdx];
      const loc = m ? (m.dir === 'C' ? cellName(P, m.cell) : edgeName(P, m.edge)) : cellName(P, broke.cell);
      const cells = m ? (m.dir === 'C' ? [m.cell] : [m.a, m.b]) : [broke.cell];
      return {
        text: `the Mid-loop dot at ${loc} has no valid symmetric straight segment`,
        cells,
        area: [],
      };
    }
    case 'castleBroken': {
      const cw = P.castle && P.castle[broke.castleIdx];
      const cn = cw ? cellName(P, cw.cell) : '';
      return {
        text: broke.over
          ? `the Castle Wall clue at ${cn} ends up with too many segments along its ray`
          : `the Castle Wall clue at ${cn} cannot reach ${cw ? cw.n : ''} segment${cw && cw.n === 1 ? '' : 's'} along its ray`,
        cells: cw ? [cw.cell] : [],
        area: [],
      };
    }
    case 'castleParity': {
      const cw = P.castle && P.castle[broke.castleIdx];
      return {
        text: `a white/black Castle Wall inside-outside constraint is violated`,
        cells: cw ? [cw.cell] : [],
        area: [],
      };
    }
    case 'earlyClose': {
      if (broke.face !== undefined) {
        return { text: `the loop closes early before the ${broke.n} square ${faceName(P, broke.face)} is satisfied`, cells: [], area: [], face: broke.face };
      }
      if (broke.midIdx !== undefined && broke.midIdx >= 0 && P.midloop && P.midloop[broke.midIdx]) {
        const m = P.midloop[broke.midIdx];
        const loc = midDotLoc(P, m, { cellName, edgeName });
        return {
          text: `the loop closes early before the Mid-loop dot at ${loc} is satisfied`,
          cells: m.dir === 'C' ? [m.cell] : [m.a, m.b],
          area: [],
        };
      }
      if (broke.castleIdx !== undefined && broke.castleIdx >= 0 && P.castle && P.castle[broke.castleIdx]) {
        const cw = P.castle[broke.castleIdx];
        return {
          text: `the loop closes early before the Castle Wall clue at ${cellName(P, cw.cell)} is satisfied`,
          cells: [cw.cell],
          area: [],
        };
      }
      return { text: `the loop closes early while ${cellName(P, broke.cell)} is still outside it`, cells: [broke.cell], area: [] };
    }
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
        const chk = checkerImbalance(P, finalState);
        if (chk) {
          return {
            text: `an area is sealed off with mismatched full-board checkerboard counts (light needs ${chk.needLight} ends, dark needs ${chk.needDark})`,
            cells: chk.ends,
            area: chk.cells,
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
 * Returns `{ rule, tier, weight, text, nudge, roles, nudgeRoles, targets, chain, faces }`.
 */
export function explainStep(P, step, st = null) {
  const { rule, tier, weight, sets, info = {} } = step;
  const targets = targetsOf(sets);
  const roles = { clue: [], area: [], focus: [], problem: [], exit: [], path: [] };
  const nudgeRoles = { clue: [], area: [], focus: [], problem: [], exit: [], path: [] };
  const chain = [];
  let faces = null;
  let text = '';
  let nudge = '';

  const uniq = (arr) => [...new Set(arr.filter((v) => v >= 0))];

  switch (rule) {
    case 'grayMustBeBlack': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the gray circle at ${cellName(P, c)} — check whether the loop can go straight through it on either axis.`;
      const why = info.reason === 'corner'
        ? 'is in a corner and cannot go straight through'
        : info.reason === 'inward'
          ? 'cannot continue straight past its existing segment'
          : 'cannot go straight along either axis';
      text = `The gray circle at ${cellName(P, c)} ${why}, so it cannot be white — it must be a black circle.`;
      break;
    }
    case 'grayMustBeWhite': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the gray circle at ${cellName(P, c)} — check whether it has enough room to extend two straight segments along both axes.`;
      const why = info.reason === 'shortLeg'
        ? `its segment going ${DIR_WORD[info.dir]} cannot continue straight two cells`
        : info.axis === 'both'
          ? 'it lacks room for two straight segments on either axis'
          : `it lacks room for two straight segments ${info.axis === 'v' ? 'vertically' : 'horizontally'}`;
      text = `The gray circle at ${cellName(P, c)} cannot be black because ${why} — it must be a white circle.`;
      break;
    }
    case 'grayWhiteNoTurn': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the gray circle at ${cellName(P, c)} — check whether it could satisfy the white-circle turn rule on either axis.`;
      text = `If the gray circle at ${cellName(P, c)} were white, it could not make a required 90° turn on either axis; so it must be a black circle.`;
      break;
    }
    case 'whiteStraight': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the white circle at ${cellName(P, c)} — check which way the loop can pass straight through it.`;
      text = `The white circle at ${cellName(P, c)} cannot go ${info.axis === 'v' ? 'horizontally' : 'vertically'}, so the loop must go straight ${info.axis === 'v' ? 'vertically' : 'horizontally'} through it.`;
      break;
    }
    case 'blackExtend': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the black circle at ${cellName(P, c)} — a segment already leaves it, so check how far straight it must go.`;
      text = `The black circle at ${cellName(P, c)} leaves ${DIR_WORD[info.dir]}, so it must go straight two cells ${DIR_WORD[info.dir]} and cannot exit ${DIR_WORD[info.dir ^ 2]}.`;
      break;
    }
    case 'blackWall': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the black circle at ${cellName(P, c)} — check whether it has room for two straight segments in each direction.`;
      const why = info.nearEdge ? `too close to the ${DIR_WORD[info.blockedDir]} edge` : `blocked ${DIR_WORD[info.blockedDir]}`;
      text = `The black circle at ${cellName(P, c)} is ${why} to go two straight cells ${DIR_WORD[info.blockedDir]}, so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackAdjacent': {
      const c = info.cell, o = info.other;
      roles.clue.push(c, o);
      nudgeRoles.clue.push(c, o);
      nudge = `Look at the touching black circles at ${cellName(P, c)} and ${cellName(P, o)} — can the loop connect them?`;
      text = `The touching black circles at ${cellName(P, c)} and ${cellName(P, o)} cannot connect (each must go straight through its neighbor), so ${cellName(P, c)} goes two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'whiteMustTurn': {
      const c = info.cell;
      roles.clue.push(c);
      roles.focus.push(info.turnEnd);
      roles.path.push(info.straightEnd);
      nudgeRoles.clue.push(c);
      nudge = `Look at the white circle at ${cellName(P, c)} — remember the loop must turn 90° immediately before or after it.`;
      text = `The white circle at ${cellName(P, c)} goes straight through ${cellName(P, info.straightEnd)}, so the loop must turn at ${cellName(P, info.turnEnd)} (cross out ${edgeName(P, info.edge)}).`;
      break;
    }
    case 'deadEnd': {
      const c = info.cell;
      roles.focus.push(c);
      nudgeRoles.focus.push(c);
      nudge = `Look at ${cellName(P, c)} — count how many exits it has left.`;
      text = `${cellName(P, c)} has only one available exit left, so the loop cannot pass through it (cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}).`;
      break;
    }
    case 'forcedExits': {
      const c = info.cell;
      roles.focus.push(c);
      nudgeRoles.focus.push(c);
      for (const x of info.edges || []) {
        const [a, b] = edgeCells(P, x);
        roles.exit.push(a === c ? b : a);
      }
      nudge = `Look at ${cellName(P, c)} — it is on the loop, so count how many available exits it has left.`;
      text = `${cellName(P, c)} is on the loop and has only two exits left, so it must use ${joinList(targets.segOn.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'blackPerp': {
      const c = info.cell;
      roles.clue.push(c);
      roles.problem.push(info.sideCell);
      nudgeRoles.clue.push(c);
      nudge = `Look at the black circle at ${cellName(P, c)} — check the segments around its neighbors to see which way it can extend.`;
      text = `The black circle at ${cellName(P, c)} cannot enter ${cellName(P, info.sideCell)} (which already has a perpendicular segment), so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'whiteBothStraight': {
      const c = info.cell;
      roles.clue.push(c);
      nudgeRoles.clue.push(c);
      nudge = `Look at the white circle at ${cellName(P, c)} — check whether one direction would stop it from turning at either end.`;
      text = `If the white circle at ${cellName(P, c)} went ${info.blockedAxis === 'v' ? 'vertically' : 'horizontally'}, both ends would go straight without turning; so it must go straight ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'noEarlyClose': {
      roles.path.push(info.a, info.b);
      nudgeRoles.path.push(info.a, info.b);
      nudge = `Look at ${cellName(P, info.a)} and ${cellName(P, info.b)} — check if they are both ends of the same open path.`;
      if (info.slitherFace !== undefined && info.slitherFace >= 0) {
        faces = { in: [], out: [], clue: [info.slitherFace], focus: [] };
        text = `${cellName(P, info.a)} and ${cellName(P, info.b)} are the two ends of the same open path, and closing them with ${edgeName(P, info.edge)} would leave the ${P.slitherNum[info.slitherFace]} square ${faceName(P, info.slitherFace)} unsatisfied — so ${edgeName(P, info.edge)} must be off.`;
      } else if (info.midIdx !== undefined && info.midIdx >= 0 && P.midloop && P.midloop[info.midIdx]) {
        const m = P.midloop[info.midIdx];
        const loc = midDotLoc(P, m, { cellName, edgeName });
        if (m.dir === 'C') { roles.clue.push(m.cell); nudgeRoles.clue.push(m.cell); }
        else { roles.clue.push(m.a, m.b); nudgeRoles.clue.push(m.a, m.b); }
        text = `${cellName(P, info.a)} and ${cellName(P, info.b)} are the two ends of the same open path, and closing them with ${edgeName(P, info.edge)} would leave the Mid-loop dot at ${loc} unsatisfied — so ${edgeName(P, info.edge)} must be off.`;
      } else if (info.castleIdx !== undefined && info.castleIdx >= 0 && P.castle && P.castle[info.castleIdx]) {
        const cw = P.castle[info.castleIdx];
        roles.clue.push(cw.cell); nudgeRoles.clue.push(cw.cell);
        text = `${cellName(P, info.a)} and ${cellName(P, info.b)} are the two ends of the same open path, and closing them with ${edgeName(P, info.edge)} would leave the Castle Wall clue at ${cellName(P, cw.cell)} unsatisfied — so ${edgeName(P, info.edge)} must be off.`;
      } else {
        text = `${cellName(P, info.a)} and ${cellName(P, info.b)} are the two ends of the same open path while other loop cells lie outside it, so ${edgeName(P, info.edge)} cannot connect them.`;
      }
      break;
    }
    case 'samePathExits': {
      roles.focus.push(info.cell);
      roles.path.push(info.a, info.b);
      nudgeRoles.focus.push(info.cell);
      nudgeRoles.path.push(info.a, info.b);
      nudge = `Look at ${cellName(P, info.cell)} and the two ends of the same path (${cellName(P, info.a)} and ${cellName(P, info.b)}) — avoid closing the loop early.`;
      text = `${cellName(P, info.cell)} is on the loop with three exits, and two of them (${cellName(P, info.a)} and ${cellName(P, info.b)}) lead to the ends of one path; using both would close the loop early, so it must take ${edgeName(P, info.edge)}.`;
      break;
    }
    case 'closingCell': {
      roles.focus.push(info.cell);
      roles.path.push(info.a, info.b);
      nudgeRoles.focus.push(info.cell);
      nudgeRoles.path.push(info.a, info.b);
      nudge = `Look at ${cellName(P, info.cell)} — check what happens if the loop passes through it between ${cellName(P, info.a)} and ${cellName(P, info.b)}.`;
      text = `${cellName(P, info.cell)} has only two exits left, and both lead to the ends of one path (${cellName(P, info.a)} and ${cellName(P, info.b)}): using it would close the loop early, so cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'threeWhites': {
      roles.clue.push(...info.cells);
      nudgeRoles.clue.push(...info.cells);
      nudge = `Look at the three white circles in a row (${joinList(info.cells.map((i) => cellName(P, i)))}) — can the loop run along the row?`;
      text = `Three white circles in a row (${joinList(info.cells.map((i) => cellName(P, i)))}) cannot go along the row because the middle circle would fail to turn at either end; all three must cross ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'twoWhitesStraight': {
      roles.clue.push(info.w1, info.w2);
      nudgeRoles.clue.push(info.w1, info.w2);
      nudge = `Look at the touching white circles at ${cellName(P, info.w1)} and ${cellName(P, info.w2)} — check if the loop can join them.`;
      text = `The touching white circles at ${cellName(P, info.w1)} and ${cellName(P, info.w2)} cannot join because ${edgeName(P, info.farEdge)} already continues straight past ${cellName(P, info.w1)}; both must go ${info.axis === 'v' ? 'vertically' : 'horizontally'}.`;
      break;
    }
    case 'whiteNoTurnAxis': {
      roles.clue.push(info.cell);
      roles.problem.push(...(info.ends || []));
      nudgeRoles.clue.push(info.cell);
      nudge = `Look at the white circle at ${cellName(P, info.cell)} — check whether one axis can make a required 90° turn at either end.`;
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
      nudgeRoles.clue.push(info.cell, info.target);
      nudge = `Look at the black circle at ${cellName(P, info.cell)} and the circle at ${cellName(P, info.target)} — check whether the black circle can extend toward it.`;
      const why = info.reason === 'whiteWall'
        ? `the white circle at ${cellName(P, info.target)} cannot continue straight through`
        : `the black circle at ${cellName(P, info.target)} already continues straight out the far side`;
      text = `The black circle at ${cellName(P, info.cell)} cannot extend toward ${cellName(P, info.target)} because ${why}; so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackNoEarlyClose': {
      roles.clue.push(info.cell);
      roles.path.push(info.cell, info.target);
      roles.focus.push(info.mid);
      nudgeRoles.clue.push(info.cell);
      nudgeRoles.path.push(info.cell, info.target);
      nudge = `Look at the black circle at ${cellName(P, info.cell)} and the other end of its path at ${cellName(P, info.target)} — avoid closing the loop early.`;
      text = `${cellName(P, info.cell)} and ${cellName(P, info.target)} are the two ends of one open path while other loop cells lie outside it, so the black circle at ${cellName(P, info.cell)} cannot extend two cells ${DIR_WORD[info.blockedDir]} into ${cellName(P, info.target)}; it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackTwoDiagWhites': {
      roles.clue.push(info.cell, ...info.whites);
      nudgeRoles.clue.push(info.cell, ...info.whites);
      nudge = `Look at the black circle at ${cellName(P, info.cell)} and the two diagonal white circles at ${cellName(P, info.whites[0])} and ${cellName(P, info.whites[1])} — can the black circle send a ray between them?`;
      text = `The black circle at ${cellName(P, info.cell)} cannot send a ray ${DIR_WORD[info.blockedDir]} between the two diagonal white circles at ${cellName(P, info.whites[0])} and ${cellName(P, info.whites[1])} (doing so would block whichever side its second leg takes); so it must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackWhiteNoTurn': {
      roles.clue.push(info.cell, info.target);
      roles.problem.push(info.farCell);
      nudgeRoles.clue.push(info.cell, info.target);
      nudge = `Look at the black circle at ${cellName(P, info.cell)} and the white circle at ${cellName(P, info.target)} — check whether the white circle could still turn if the black circle extends into it.`;
      const farNm = cellName(P, info.farCell);
      const why = info.reason === 'white'
        ? `${farNm} is another white circle`
        : info.reason === 'straight'
          ? `${farNm} already continues straight`
          : `${farNm} has both turns blocked`;
      text = `The black circle at ${cellName(P, info.cell)} cannot extend into the white circle at ${cellName(P, info.target)} because ${why}, leaving ${cellName(P, info.target)} unable to turn on either side; so ${cellName(P, info.cell)} must go two cells ${DIR_WORD[info.dir]}.`;
      break;
    }
    case 'blackMustVisitReach': {
      roles.clue.push(info.b);
      roles.focus.push(info.j);
      nudgeRoles.clue.push(info.b);
      nudgeRoles.focus.push(info.j);
      const subj = info.kind === 'midloop' ? `the Mid-loop dot at ${cellName(P, info.j)}` : cellName(P, info.j);
      nudge = `Look at the black circle at ${cellName(P, info.b)} and ${info.kind === 'midloop' ? `the Mid-loop dot at ${cellName(P, info.j)}` : `its must-visit neighbor ${cellName(P, info.j)}`} — check what happens if ${edgeName(P, info.edge)} is crossed out.`;
      text = `Because ${subj} must be visited and is already blocked on one perpendicular side, crossing out ${edgeName(P, info.edge)} would also block the black circle at ${cellName(P, info.b)} from entering through ${edgeName(P, info.eTo)} — stranding ${cellName(P, info.j)}. So draw ${edgeName(P, info.edge)}.`;
      break;
    }
    case 'whiteCornerPinch': {
      roles.focus.push(info.cell);
      roles.clue.push(info.white);
      roles.problem.push(...info.neighbors);
      nudgeRoles.focus.push(info.cell);
      nudgeRoles.clue.push(info.white);
      nudge = `Look at ${cellName(P, info.cell)} beside the white circle at ${cellName(P, info.white)} — check what happens to the white circle if the loop passes through ${cellName(P, info.cell)}.`;
      text = `${cellName(P, info.cell)} has only two exits left, pointing to ${cellName(P, info.neighbors[0])} and ${cellName(P, info.neighbors[1])}, which both already have a segment; passing through ${cellName(P, info.cell)} would fill both neighbors and cut off the white circle at ${cellName(P, info.white)} on both axes, so cross out ${joinList(targets.segOff.map((x) => edgeName(P, x)))}.`;
      break;
    }
    case 'whiteDeadEndPinch': {
      roles.focus.push(...info.active);
      roles.clue.push(info.white);
      roles.problem.push(info.dead);
      nudgeRoles.focus.push(...info.active);
      nudgeRoles.clue.push(info.white);
      nudge = `Look at the 2×2 area around the white circle at ${cellName(P, info.white)} — check what happens if the two nearby open ends connect.`;
      text = `Drawing ${edgeName(P, info.edge)} would fill both ${cellName(P, info.active[0])} and ${cellName(P, info.active[1])}, turning ${cellName(P, info.dead)} into a dead end and cutting off the white circle at ${cellName(P, info.white)} on both axes; so cross out ${edgeName(P, info.edge)}.`;
      break;
    }
    case 'boxStrand': {
      roles.focus.push(info.a, info.b);
      roles.problem.push(info.active, info.stranded);
      nudgeRoles.focus.push(info.a, info.b);
      nudgeRoles.area.push(info.a, info.b, info.active, info.stranded);
      nudge = `Look at the 2×2 box around ${cellName(P, info.a)} and ${cellName(P, info.b)} — check whether closing off one side strands an open end inside.`;
      text = `Drawing ${edgeName(P, info.edge)} would fill both ${cellName(P, info.a)} and ${cellName(P, info.b)}, sealing both escapes of the adjacent pair ${cellName(P, info.active)}–${cellName(P, info.stranded)} and stranding the open end at ${cellName(P, info.active)}; so cross out ${edgeName(P, info.edge)}.`;
      break;
    }
    case 'corridorNoEarlyClose': {
      roles.area.push(...info.cells);
      roles.path.push(info.a, info.b);
      nudgeRoles.area.push(...info.cells);
      nudgeRoles.path.push(info.a, info.b);
      nudge = `Look at the narrow corridor between ${cellName(P, info.a)} and ${cellName(P, info.b)} — check what happens to the loop if it enters.`;
      text = `The forced corridor (${joinList(info.cells.map((k) => cellName(P, k)))}) only connects the two ends of one open path (${cellName(P, info.a)} and ${cellName(P, info.b)}) while other loop cells lie outside it: entering it would close the loop early, so ${describeMarks(P, targets)}.`;
      break;
    }
    case 'faceShade': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      nudgeRoles.focus.push(a, b);
      nudge = `Look at ${edgeName(P, info.edge)} — use Inside/Outside shading to compare the two squares on either side of it.`;
      faces = { in: info.facesIn || [], out: info.facesOut || [], anchored: true };
      const sideName = (par) => (par === 1 ? 'Inside' : 'Outside');
      text = info.val === E_ON
        ? `Inside/outside shading puts opposite sides (${sideName(info.parA)} and ${sideName(info.parB)}) across ${edgeName(P, info.edge)}, so the loop must cross between them (draw ${edgeName(P, info.edge)}).`
        : `Inside/outside shading puts ${sideName(info.parA)} on both sides of ${edgeName(P, info.edge)}, so the loop cannot pass between them (cross out ${edgeName(P, info.edge)}).`;
      break;
    }
    case 'faceCircle':
    case 'faceSlither': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.clue.push(...(info.clues || []));
      nudgeRoles.focus.push(a, b);
      nudgeRoles.clue.push(...(info.clues || []));
      const isSl = rule === 'faceSlither';
      const clueCells = info.clues || [];
      const hasMidClues = P.hasMidloop && clueCells.some((c) => P.midloopAtCell[c] >= 0);
      const hasCircleClues = clueCells.some((c) => P.clue[c] !== 0);
      nudge = isSl
        ? `Look at ${edgeName(P, info.edge)} — use Inside/Outside shading around the numbered squares to compare the two sides.`
        : clueCells.length
          ? (hasMidClues && !hasCircleClues
            ? `Look at ${edgeName(P, info.edge)} and the highlighted Mid-loop ${clueCells.length === 1 ? 'dot' : 'dots'} — use diagonal Inside/Outside shading to compare the squares on either side.`
            : hasMidClues
              ? `Look at ${edgeName(P, info.edge)} and the highlighted clues — use Inside/Outside shading to compare the squares on either side.`
              : `Look at ${edgeName(P, info.edge)} and the highlighted circles — use circle Inside/Outside shading to compare the squares on either side.`)
          : `Look at ${edgeName(P, info.edge)} — use relative Inside/Outside shading to compare the squares on either side.`;
      faces = { in: info.facesIn || [], out: info.facesOut || [], clue: info.slitherFaces || [], focus: [], anchored: !!info.anchored };
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
          case 'midDiag':
            return `flipping diagonally across Mid-loop dot ${cellName(P, s.reason.cell)} makes ${dst} ${col}`;
          case 'castleWall':
            return `the ${s.reason.wall === 'W' ? 'white (inside)' : 'black (outside)'} wall at ${cellName(P, s.reason.cell)} makes ${dst} ${col}`;
          case 'blackDiag':
            return `by the 3-to-1 corner rule at black circle ${cellName(P, s.reason.cell)}, ${dst} is ${col}`;
          case 'blackLeg':
            return `black circle ${cellName(P, s.reason.cell)}'s forced 2-step leg makes ${dst} ${col}`;
          case 'slither0':
            return `the 0 square ${faceName(P, s.reason.face)} keeps ${dst} ${col}`;
          case 'slither33':
            return `the adjacent 3 squares ${faceName(P, s.reason.face)} and ${faceName(P, s.reason.face2)} make ${dst} ${col}`;
          case 'slitherDiag33':
            return `the diagonal 3 squares ${faceName(P, s.reason.face)} and ${faceName(P, s.reason.face2)} make ${dst} ${col}`;
          case 'slitherCount':
            return `the ${s.reason.n} square ${faceName(P, s.reason.face)} makes ${dst} ${col}`;
          case 'slitherMod2':
            return `even/odd parity around the ${s.reason.n} square ${faceName(P, s.reason.face)} makes ${dst} ${col}`;
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
      const heading = isSl || !clueCells.length
        ? 'Inside/outside shading'
        : (hasMidClues && !hasCircleClues ? 'Mid-loop shading' : hasMidClues ? 'Clue shading' : 'Circle shading');
      text = chainDesc
        ? `${heading}: ${chainDesc}. That ${sideStr}.`
        : `${heading} ${sideStr}.`;
      break;
    }
    case 'twoEndsJoin': {
      roles.area.push(...(info.area || []));
      roles.path.push(info.u, info.v, info.uFar, info.vFar);
      nudgeRoles.area.push(...(info.area || []));
      nudgeRoles.path.push(info.u, info.v, info.uFar, info.vFar);
      nudge = `Look at the highlighted area — only two open ends enter it, so check how they must pair up.`;
      text = `The highlighted area has only two open ends (${cellName(P, info.u)} and ${cellName(P, info.v)}), so they must connect inside it; that makes ${cellName(P, info.uFar)} and ${cellName(P, info.vFar)} ends of one path, so ${edgeName(P, info.edge)} cannot close them early.`;
      break;
    }
    case 'chokepoint':
    case 'chokepointArea': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      nudgeRoles.focus.push(a, b);
      nudgeRoles.area.push(...(info.area || []));
      nudge = `Look at ${edgeName(P, info.edge)} and the highlighted area — check how the loop stays connected in and out of it.`;
      if (info.cut !== undefined && info.cut >= 0) roles.problem.push(info.cut);
      text = info.kind === 'disconnected'
        ? `Without ${edgeName(P, info.edge)}, loop cells in the highlighted area would be completely cut off from the rest of the loop, so ${edgeName(P, info.edge)} must be drawn.`
        : `Without ${edgeName(P, info.edge)}, ${cellName(P, info.cut)} would be the only cell connecting the highlighted area to the rest of the loop (a single loop cannot pass through it twice), so ${edgeName(P, info.edge)} must be drawn.`;
      break;
    }
    case 'checkerPocket':
    case 'checkerParity': {
      roles.area.push(...(info.area || []));
      nudgeRoles.area.push(...(info.area || []));
      if (info.mode === 'hyp') {
        const [a, b] = edgeCells(P, info.edge);
        roles.focus.push(a, b);
        nudgeRoles.focus.push(a, b);
        nudge = `Look at ${edgeName(P, info.edge)} and the highlighted area — on a full board, count checkerboard light vs. dark dots inside it.`;
        const hypTxt = info.hyp === E_ON ? `drawing ${edgeName(P, info.edge)}` : `crossing out ${edgeName(P, info.edge)}`;
        const resTxt = info.hyp === E_ON ? `cross out ${edgeName(P, info.edge)}` : `draw ${edgeName(P, info.edge)}`;
        text = `On a full board, ${hypTxt} would seal off the highlighted area with mismatched checkerboard counts (light dots need ${info.needLight} segment ends, dark dots need ${info.needDark}); therefore ${resTxt}.`;
      } else {
        for (const x of [...targets.segOn, ...targets.segOff]) {
          const [a, b] = edgeCells(P, x);
          roles.focus.push(a, b);
        }
        nudge = `Look at the highlighted full-board region — count how many segment ends its checkerboard light vs. dark dots still need.`;
        text = `Checkerboard parity on the highlighted full-board region: light dots need ${info.needLight} more segment ends and dark dots need ${info.needDark} (difference ${Math.abs(info.diff)}), which forces ${describeMarks(P, targets)}.`;
      }
      break;
    }
    case 'parityPocket':
    case 'parityForces': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      roles.path.push(...(info.ends || []));
      nudgeRoles.focus.push(a, b);
      nudgeRoles.area.push(...(info.area || []));
      nudge = `Look at ${edgeName(P, info.edge)} and the highlighted area — count how many open ends would be trapped inside.`;
      const hypTxt = info.hyp === E_ON ? `drawing ${edgeName(P, info.edge)}` : `crossing out ${edgeName(P, info.edge)}`;
      const resTxt = info.hyp === E_ON ? `cross out ${edgeName(P, info.edge)}` : `draw ${edgeName(P, info.edge)}`;
      text = `If you tried ${hypTxt}, the highlighted area would be sealed off with ${plural(info.ends.length, 'open end')} (odd, so they can't all pair up); therefore ${resTxt}.`;
      break;
    }
    case 'crossingParity': {
      const [a, b] = edgeCells(P, info.edge);
      roles.focus.push(a, b);
      roles.area.push(...(info.area || []));
      nudgeRoles.focus.push(a, b);
      nudgeRoles.area.push(...(info.area || []));
      nudge = `Look at the highlighted rectangle and ${edgeName(P, info.edge)} — count how many times the loop crosses its border (it must be even).`;
      const act = info.val === E_ON ? `must be drawn` : `cannot be drawn`;
      text = `The loop must cross the border of the highlighted rectangle an even number of times (${info.on} crossings so far, 1 undecided), so ${edgeName(P, info.edge)} ${act}.`;
      break;
    }
    case 'symmetry': {
      const symName = info.sym === 'flipH' ? 'left-right mirror symmetry'
        : info.sym === 'flipV' ? 'top-bottom mirror symmetry'
          : info.sym === 'rot180' ? '180° rotational symmetry'
            : info.sym === 'transpose' ? 'diagonal symmetry'
              : info.sym === 'antiTranspose' ? 'anti-diagonal symmetry'
                : info.sym === 'rot90' ? '90° rotational symmetry'
                  : 'exact symmetry';
      if (info.kind === 'copy') {
        if (info.src !== undefined) {
          const [a, b] = edgeCells(P, info.src);
          const [c, d] = edgeCells(P, info.dst);
          roles.clue.push(a, b);
          roles.focus.push(c, d);
          nudgeRoles.clue.push(a, b);
          nudgeRoles.focus.push(c, d);
          nudge = `This puzzle has ${symName} — compare ${edgeName(P, info.src)} with its symmetric partner ${edgeName(P, info.dst)}.`;
          text = `Because this puzzle has ${symName} and a unique solution, the loop must share that symmetry: matching ${edgeName(P, info.src)}, ${describeMarks(P, targets)}.`;
        } else {
          roles.clue.push(info.srcCell);
          roles.focus.push(info.dstCell);
          nudgeRoles.clue.push(info.srcCell);
          nudgeRoles.focus.push(info.dstCell);
          nudge = `This puzzle has ${symName} — compare ${cellName(P, info.srcCell)} with its symmetric partner ${cellName(P, info.dstCell)}.`;
          text = `Because this puzzle has ${symName} and a unique solution, matching ${cellName(P, info.srcCell)}, ${describeMarks(P, targets)}.`;
        }
      } else if (info.kind === 'center') {
        roles.focus.push(...(info.cells || []));
        nudgeRoles.focus.push(...(info.cells || []));
        nudge = `This puzzle has 180° rotational symmetry — a single symmetric closed loop can never pass through the exact center.`;
        text = `Because this puzzle has 180° rotational symmetry and a unique solution, the loop must wrap around the center without passing through it, so ${describeMarks(P, targets)}.`;
      } else if (info.kind === 'axisEdge') {
        roles.focus.push(...(info.cells || []));
        nudgeRoles.focus.push(...(info.cells || []));
        nudge = `This puzzle has ${symName} — look along the center mirror line (the loop can cross it, but never travel along it).`;
        text = `Because this puzzle has ${symName} and a unique solution, the loop cannot run along the mirror line without branching, so ${describeMarks(P, targets)}.`;
      } else if (info.kind === 'diagPair') {
        roles.focus.push(info.cell);
        nudgeRoles.focus.push(info.cell);
        nudge = `This puzzle has ${symName} — look at ${cellName(P, info.cell)} on the diagonal axis (its exits must be mirror images).`;
        text = `Because this puzzle has ${symName} and a unique solution, any loop turn at diagonal intersection ${cellName(P, info.cell)} must use a mirror-image pair of exits, so ${describeMarks(P, targets)}.`;
      } else if (info.kind === 'twoCrossings') {
        roles.clue.push(...(info.onCells || []));
        roles.focus.push(...(info.cells || []));
        nudgeRoles.clue.push(...(info.onCells || []));
        nudgeRoles.focus.push(...(info.cells || []));
        nudge = `This puzzle has ${symName} — count how many times the loop crosses the mirror axis (a single symmetric loop must cross it exactly twice).`;
        text = `Because this puzzle has ${symName} and a unique solution, the single loop must cross the mirror axis exactly twice (${info.onCount} crossings already known), so ${describeMarks(P, targets)}.`;
      } else if (info.kind === 'orbitClose') {
        const [a, b] = edgeCells(P, info.edge);
        roles.focus.push(a, b);
        for (const oe of info.orbit || []) {
          const [u, v] = edgeCells(P, oe);
          if (oe !== info.edge) roles.path.push(u, v);
        }
        nudgeRoles.focus.push(a, b);
        if (info.reason === 'branch') {
          roles.problem.push(info.branchCell);
          nudge = `This puzzle has ${symName} — imagine drawing ${edgeName(P, info.edge)} together with its symmetric twin.`;
          text = `Because this puzzle has ${symName} and a unique solution, drawing ${edgeName(P, info.edge)} would also force its symmetric twin, creating a 3-way branch at ${cellName(P, info.branchCell)}; therefore ${describeMarks(P, targets)}.`;
        } else {
          nudge = `This puzzle has ${symName} — imagine drawing ${edgeName(P, info.edge)} together with its symmetric twin${(info.orbit || []).length > 2 ? 's' : ''}.`;
          text = `Because this puzzle has ${symName} and a unique solution, drawing ${edgeName(P, info.edge)} together with its symmetric twin${(info.orbit || []).length > 2 ? 's' : ''} would close a loop early without visiting the rest of the board; therefore ${describeMarks(P, targets)}.`;
        }
      }
      break;
    }
    case 'imagineLocal':
    case 'imagineTrace':
    case 'imagineChain': {
      const isGray = info.grayCell !== undefined && info.grayCell >= 0;
      let hypStr, verdict;
      if (isGray) {
        roles.clue.push(info.grayCell);
        nudgeRoles.clue.push(info.grayCell);
        nudge = `Look at the gray circle at ${cellName(P, info.grayCell)} — try imagining whether it is white or black and follow the forced moves.`;
        hypStr = `the gray circle at ${cellName(P, info.grayCell)} is ${info.hyp === WHITE ? 'white' : 'black'}`;
        verdict = `label ${cellName(P, info.grayCell)} as a ${info.deduce === WHITE ? 'white' : 'black'} circle`;
      } else {
        const [a, b] = edgeCells(P, info.edge);
        roles.focus.push(a, b);
        nudgeRoles.focus.push(a, b);
        nudge = `Look at ${edgeName(P, info.edge)} — try imagining a segment there (or crossing it out) and follow the forced moves.`;
        hypStr = info.hyp === E_ON ? `a segment at ${edgeName(P, info.edge)}` : `no segment at ${edgeName(P, info.edge)}`;
        verdict = info.deduce === E_ON ? `draw ${edgeName(P, info.edge)}` : `cross out ${edgeName(P, info.edge)}`;
      }
      let finalState = null;
      if (st) {
        const rep = replayImagine(P, st, info);
        finalState = rep.state;
        // Collect all newly turned-on edges in the imagined chain for dashed orange visualization
        if (!isGray && info.hyp === E_ON) chain.push(info.edge);
        for (let x = 0; x < P.numEdges; x++) {
          if (rep.state.e[x] === E_ON && st.e[x] !== E_ON && x !== info.edge) chain.push(x);
        }
      }
      const clauses = (info.steps || []).map((s) => describeChainStep(P, s));
      const end = describeContradiction(P, info.broke, finalState);
      roles.problem.push(...end.cells);
      roles.area.push(...end.area);
      if (end.face !== undefined && end.face >= 0) faces = { in: [], out: [], clue: [], focus: [], problem: [end.face] };
      const chainText = clauses.length
        ? `: then ${clauses.join('; then ')}; and finally ${end.text}.`
        : `: immediately ${end.text}.`;
      text = `Imagine ${hypStr}${chainText} So ${verdict}.`;
      break;
    }
    case 'tryEdge': {
      const isGray = info.grayCell !== undefined && info.grayCell >= 0;
      let hypStr, verdict;
      if (isGray) {
        roles.clue.push(info.grayCell);
        nudgeRoles.clue.push(info.grayCell);
        nudge = `Look at the gray circle at ${cellName(P, info.grayCell)} — try imagining whether it is white or black and follow the forced moves.`;
        hypStr = `the gray circle at ${cellName(P, info.grayCell)} is ${info.hyp === WHITE ? 'white' : 'black'}`;
        verdict = `label ${cellName(P, info.grayCell)} as a ${info.hyp === WHITE ? 'black' : 'white'} circle`;
      } else {
        const [a, b] = edgeCells(P, info.edge);
        roles.focus.push(a, b);
        nudgeRoles.focus.push(a, b);
        nudge = `Look at ${edgeName(P, info.edge)} — try imagining a segment there (or crossing it out) and follow the forced moves.`;
        hypStr = info.hyp === E_ON ? `a segment at ${edgeName(P, info.edge)}` : `no segment at ${edgeName(P, info.edge)}`;
        verdict = info.hyp === E_ON ? `cross out ${edgeName(P, info.edge)}` : `draw ${edgeName(P, info.edge)}`;
      }
      const traceClauses = (info.trace || []).slice(0, 4).map((t) => describeChainStep(P, t));
      const detail = traceClauses.length
        ? ` (starting with: ${traceClauses.join('; then ')}; reaching a contradiction after ${plural(info.steps, 'step')})`
        : ` (contradiction after ${plural(info.steps, 'step')})`;
      text = `Imagine ${hypStr} and follow the forced deductions${detail}. So ${verdict}.`;
      break;
    }
    default: {
      const slFaces = { in: [], out: [], clue: [], focus: [] };
      const slExp = explainSlitherStep(P, { rule, info, targets }, { cellName, faceName, describeMarks, roles, nudgeRoles, faces: slFaces });
      if (slExp) {
        nudge = slExp.nudge;
        text = slExp.text;
        if (slFaces.focus.length || slFaces.clue.length) faces = slFaces;
        for (const x of [...targets.segOn, ...targets.segOff]) {
          const [a, b] = edgeCells(P, x);
          if (!nudgeRoles.focus.length && !slFaces.focus.length) nudgeRoles.focus.push(a, b);
        }
        break;
      }
      const mlExp = explainMidloopStep(P, { rule, info, targets }, { cellName, edgeName, describeMarks, roles, nudgeRoles });
      if (mlExp) {
        nudge = mlExp.nudge;
        text = mlExp.text;
        for (const x of [...targets.segOn, ...targets.segOff]) {
          const [a, b] = edgeCells(P, x);
          if (!nudgeRoles.focus.length && !nudgeRoles.clue.length) nudgeRoles.focus.push(a, b);
        }
        break;
      }
      const cwExp = explainCastleStep(P, { rule, info, targets }, { cellName, describeMarks, roles, nudgeRoles });
      if (cwExp) {
        nudge = cwExp.nudge;
        text = cwExp.text;
        for (const x of [...targets.segOn, ...targets.segOff]) {
          const [a, b] = edgeCells(P, x);
          if (!nudgeRoles.focus.length && !nudgeRoles.clue.length) nudgeRoles.focus.push(a, b);
        }
        break;
      }
      for (const x of [...targets.segOn, ...targets.segOff]) {
        const [a, b] = edgeCells(P, x);
        nudgeRoles.focus.push(a, b);
      }
      nudge = `Look at the highlighted area (${ruleLabel(rule)}).`;
      text = `${ruleLabel(rule)}: ${describeMarks(P, targets)}.`;
    }
  }

  for (const k of Object.keys(roles)) {
    roles[k] = uniq(roles[k]);
    nudgeRoles[k] = uniq(nudgeRoles[k]);
  }
  return { rule, tier, weight, text, nudge, roles, nudgeRoles, targets, chain: uniq(chain), faces };
}
