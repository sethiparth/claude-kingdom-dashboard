/**
 * Tiny seeded value-noise + fBm, used by the v3 tile island generator to carve
 * organic coastlines. No Phaser/DOM dependency — pure math, so it can be unit
 * tested and reused by the (pure) island-grid generator.
 *
 * Value noise (not gradient/Perlin) is enough here: we only need a smooth,
 * seed-stable field in [0,1] to perturb a radial falloff into bays/peninsulas.
 * fbm() sums a few octaves for natural detail without visible grid artefacts.
 */

/** djb2/FNV-ish string hash → unsigned 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

/** Deterministic hash of two integer lattice coords + seed → float in [0,1). */
function latticeHash(ix, iy, seed) {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

/** Smootherstep (Ken Perlin's quintic) for artefact-free interpolation. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * 2D value noise in [0,1] at continuous (x, y) for a given integer seed.
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @returns {number}
 */
export function valueNoise2D(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);

  const v00 = latticeHash(x0, y0, seed);
  const v10 = latticeHash(x0 + 1, y0, seed);
  const v01 = latticeHash(x0, y0 + 1, seed);
  const v11 = latticeHash(x0 + 1, y0 + 1, seed);

  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/**
 * Fractal Brownian motion: sum `octaves` layers of value noise at doubling
 * frequency and halving amplitude, normalised back to [0,1].
 *
 * @param {number} x
 * @param {number} y
 * @param {number} seed
 * @param {{octaves?:number, frequency?:number, persistence?:number, lacunarity?:number}} [opts]
 * @returns {number}
 */
export function fbm(x, y, seed, opts = {}) {
  const octaves = opts.octaves ?? 4;
  const persistence = opts.persistence ?? 0.5;
  const lacunarity = opts.lacunarity ?? 2.0;
  let freq = opts.frequency ?? 1;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** mulberry32 PRNG factory (seed-stable float stream in [0,1)). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
