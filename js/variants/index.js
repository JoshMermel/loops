// Modular constraint-variant registry for the single-loop puzzle engine.
//
// Every loop puzzle is composed from:
//   1. The shared orthogonal single-loop core (vertices, edges, dual faces, voids, givens)
//   2. Any combination of pluggable constraint modules:
//        - masyu       (vertex circles: white / black / gray)
//        - fullboard   (Hamiltonian cycle: every active vertex visited)
//        - slitherlink (face numbers 0..3: exact surrounding loop-edge count)
//        - ...future loop variants (Corral, Balance Loop, Anti-Masyu, etc.)
import { slitherlinkVariant } from './slitherlink.js';

export const FACE_VARIANTS = [slitherlinkVariant];

export function activeVariantIds(P) {
  const out = [];
  if (P && P.clues && P.clues.length > 0) out.push('masyu');
  if (P && P.hasSlither) out.push('slitherlink');
  if (P && P.fullBoard) out.push('fullboard');
  if (P && P.hasVoids) out.push('voids');
  return out;
}

export function isHybridPuzzle(P) {
  let kinds = 0;
  if (P && P.clues && P.clues.length > 0) kinds++;
  if (P && P.hasSlither) kinds++;
  if (P && P.fullBoard) kinds++;
  return kinds >= 2;
}

export { slitherlinkVariant };
