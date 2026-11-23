// Color palettes for "Color separate lines" setting.
import { PRESETS } from './palette_presets.js';
import { isHex, darkVariant, distance } from './colormath.js';

export { PRESETS };
export const CUSTOM = 'custom';
export const DEFAULT_PRESET = 'default';
export const MIN_CUSTOM = 2;
export const MAX_CUSTOM = 32;

export function sanitizeCustom(v) {
  if (!Array.isArray(v)) return null;
  const colors = v.filter(isHex).map((c) => c.toLowerCase()).slice(0, MAX_CUSTOM);
  return colors.length >= MIN_CUSTOM ? colors : null;
}

export const validId = (id, custom) => (PRESETS.some((p) => p.id === id) || (id === CUSTOM && custom) ? id : DEFAULT_PRESET);

export function lightColors(id, custom) {
  if (id === CUSTOM && custom) return custom;
  return (PRESETS.find((p) => p.id === id) || PRESETS[0]).light;
}

export function resolvePalette(id, custom, theme) {
  if (id === CUSTOM && custom) return theme === 'dark' ? custom.map(darkVariant) : custom;
  const p = PRESETS.find((q) => q.id === id) || PRESETS[0];
  return theme === 'dark' ? p.dark : p.light;
}

export const eyesOf = (id) => (PRESETS.find((p) => p.id === id) || { eyes: ['normal'] }).eyes;

const ALIKE_RANGE = 35;
export function alikeMatrix(colors, eyes) {
  return colors.map((a, i) => colors.map((b, j) => {
    if (i === j) return 1;
    const gap = Math.min(...eyes.map((k) => distance(a, b, k)));
    return Math.max(0, 1 - gap / ALIKE_RANGE) ** 2;
  }));
}
