/**
 * Manifest for the v3 island renderer's terrain + decor.
 *
 * Terrain is a procedurally generated DUAL-GRID marching-squares tileset
 * (see scripts/generate-tiles.mjs). Each of the sand / grass / path layers is a
 * binary field sampled at tile CORNERS; the renderer selects a tile purely by
 * the 4-bit corner mask (bit0=TL, bit1=TR, bit2=BL, bit3=BR). Because bilinear
 * interpolation is linear along a shared edge, neighbouring tiles always agree
 * on their common boundary → seamless coastlines and grass/sand edges BY
 * CONSTRUCTION. No rotation or role-guessing: mask N always maps to tile N.
 *
 * Houses are NOT declared here — the v3 scene inherits the base scene's house
 * rendering (real downloaded cutouts under public/buildings). Decor
 * (trees/rocks/props) uses the generated sprites under public/gen/decor so the
 * whole scene reads as one art style. Texture keys equal the PNG basename.
 */

const PUBLIC = '/';

// ── generated terrain ────────────────────────────────────────────────────────
export const WATER_KEY = 'gen_water';

/** key for a given layer + corner-mask (0 = fully absent, never placed). */
const terrainKey = (layer, mask) => `gen_${layer}_${String(mask).padStart(2, '0')}`;
export const SAND_TILES = Array.from({ length: 16 }, (_, m) => (m ? terrainKey('sand', m) : null));
export const GRASS_TILES = Array.from({ length: 16 }, (_, m) => (m ? terrainKey('grass', m) : null));
export const PATH_TILES = Array.from({ length: 16 }, (_, m) => (m ? terrainKey('path', m) : null));

// ── generated decor ──────────────────────────────────────────────────────────
export const TREE_KEYS = ['gen_tree_oak', 'gen_tree_pine'];
export const ROCK_KEYS = ['gen_rock', 'gen_bush'];
export const BUILDING_PROP_KEYS = ['gen_barrel', 'gen_crate', 'gen_well', 'gen_stall'];
export const PATH_PROP_KEYS = ['gen_lamp', 'gen_bush', 'gen_barrel'];

const DECOR_NAMES = ['tree_oak', 'tree_pine', 'rock', 'bush', 'barrel', 'crate', 'lamp', 'well', 'stall'];

// Houses are NOT part of this manifest: the v3 scene inherits the base scene's
// house rendering, which loads the real downloaded cutouts from public/buildings.

/**
 * Every generated PNG to preload, keyed by texture key.
 * @returns {Array<{key:string, url:string}>}
 */
export function genLoadList() {
  const list = [{ key: WATER_KEY, url: `${PUBLIC}gen/terrain/water.png` }];
  for (let m = 1; m < 16; m++) {
    const nn = String(m).padStart(2, '0');
    for (const layer of ['sand', 'grass', 'path']) {
      list.push({ key: `gen_${layer}_${nn}`, url: `${PUBLIC}gen/terrain/${layer}_${nn}.png` });
    }
  }
  for (const name of DECOR_NAMES) {
    list.push({ key: `gen_${name}`, url: `${PUBLIC}gen/decor/${name}.png` });
  }
  return list;
}

/**
 * Deterministically picks one key from a pool via an integer hash so a given
 * tile/building always draws the same variant (no flicker across rebuilds).
 * @param {string[]} pool
 * @param {number} h
 * @returns {string|null}
 */
export function pick(pool, h) {
  if (!pool || pool.length === 0) return null;
  const i = ((h % pool.length) + pool.length) % pool.length;
  return pool[i];
}
