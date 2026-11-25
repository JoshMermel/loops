import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CUSTOM, DEFAULT_PRESET, MIN_CUSTOM, MAX_CUSTOM,
  sanitizeCustom, validId, lightColors, resolvePalette, eyesOf, alikeMatrix,
} from '../js/palettes.js';
import {
  isHex, hexToRgb, rgbToHex, labOf, distance, lchToHex, darkVariant,
} from '../js/colormath.js';

test('colormath hex/RGB/Lab/LCH conversions and darkVariant preserve valid hex colors', () => {
  assert.equal(isHex('#1976d2'), true);
  assert.equal(isHex('#ABCDEF'), true);
  assert.equal(isHex('#123'), false);
  assert.equal(isHex('1976d2'), false);
  assert.deepEqual(hexToRgb('#1976d2'), [25, 118, 210]);
  assert.equal(rgbToHex([25, 118, 210]), '#1976d2');

  assert.equal(distance('#1976d2', '#1976d2'), 0);
  assert.ok(distance('#1976d2', '#d32f2f') > 40);
  // Deuteranopia collapses red-green separation relative to normal vision
  assert.ok(distance('#c62828', '#2e7d32', 'deutan') < distance('#c62828', '#2e7d32'));

  const dv = darkVariant('#1976d2');
  assert.equal(isHex(dv), true);
  assert.ok(labOf(dv)[0] >= 57, `darkVariant should lift lightness, got L=${labOf(dv)[0]}`);

  const clamped = lchToHex(70, 200, 0.5);
  assert.equal(isHex(clamped), true);
});

test('palettes sanitizeCustom, validId, resolvePalette, and alikeMatrix work across presets and custom', () => {
  assert.equal(sanitizeCustom(null), null);
  assert.equal(sanitizeCustom(['#112233']), null); // fewer than MIN_CUSTOM
  assert.deepEqual(sanitizeCustom(['#AABBCC', 'bad', '#112233']), ['#aabbcc', '#112233']);
  assert.equal(sanitizeCustom(Array(MAX_CUSTOM + 5).fill('#112233')).length, MAX_CUSTOM);
  assert.equal(MIN_CUSTOM, 2);

  assert.equal(validId('nonexistent', null), DEFAULT_PRESET);
  assert.equal(validId(CUSTOM, null), DEFAULT_PRESET);
  assert.equal(validId(CUSTOM, ['#112233', '#445566']), CUSTOM);
  assert.equal(validId(PRESETS[0].id, null), PRESETS[0].id);

  const custom = ['#1976d2', '#c62828'];
  assert.deepEqual(lightColors(CUSTOM, custom), custom);
  assert.deepEqual(resolvePalette(CUSTOM, custom, 'light'), custom);
  const darkCustom = resolvePalette(CUSTOM, custom, 'dark');
  assert.equal(darkCustom.length, 2);
  assert.ok(darkCustom.every(isHex));

  const m = alikeMatrix(['#1976d2', '#1976d2', '#d32f2f'], eyesOf(DEFAULT_PRESET));
  assert.equal(m[0][0], 1);
  assert.equal(m[0][1], 1);
  assert.equal(m[0][2], 0);
});
