/**
 * Seeded, stateless noise.
 *
 * Everything here is a pure function of an explicit seed so that the overlay, the
 * control panel preview, and any refreshed browser source all compute byte-identical
 * values. Nothing may read the clock or Math.random().
 */

/** FNV-1a over a string -> uint32. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small fast PRNG. Deterministic for a given seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A band-limited wave set whose sum is guaranteed to stay within [-1, 1]
 * (weights are normalised). Sum-of-sines rather than gradient noise because it is
 * cheap, smooth to arbitrary resolution, and trivially reproducible.
 */
export function makeWaves(rng, count = 4, minFreq = 0.8, maxFreq = 5.5) {
  const waves = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const w = 1 / (i + 1); // 1/f falloff: big slow swells, small fast wobble
    total += w;
    waves.push({
      w,
      f: minFreq + rng() * (maxFreq - minFreq) * ((i + 1) / count),
      phase: rng() * Math.PI * 2,
    });
  }
  for (const wv of waves) wv.w /= total;
  return waves;
}

/** Evaluate a wave set at x. Result is in [-1, 1]. */
export function waveAt(waves, x) {
  let sum = 0;
  for (const { w, f, phase } of waves) sum += w * Math.sin(x * f * Math.PI * 2 + phase);
  return sum;
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Hermite smoothstep between edges. */
export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export const lerp = (a, b, k) => a + (b - a) * k;

/** Ease used for every grafted transition, so re-targets all feel like one gesture. */
export const easeInOutCubic = (k) =>
  k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
