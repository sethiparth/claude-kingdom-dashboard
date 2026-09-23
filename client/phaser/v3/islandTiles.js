/**
 * Pure tile-grid generator for the v3 island renderer. Turns an island's
 * (seed, tile-radius) into a classified biome grid with a guaranteed sand
 * shoreline buffer, plus autotile edge masks, rasterised cobble paths, and a
 * deterministic decor/prop placement plan.
 *
 * NO Phaser/DOM here — this is deterministic math so the renderer (and tests)
 * can consume a plain data structure. See noise.js for the coastline field.
 *
 * Biome hierarchy (low → high), matching the spec's painter order:
 *   Ocean → (sand shoreline) → Sand → (grass/sand transition) → Grass
 * The sand buffer is enforced structurally: a cell is only allowed to be GRASS
 * when every cell within `SAND_BUFFER` tiles is land, so grass can never touch
 * raw ocean — there is always at least one sand ring between them.
 */
import { fbm, hashSeed, mulberry32 } from './noise.js';

export const BIOME = Object.freeze({ WATER: 0, SAND: 1, GRASS: 2 });

// How many tile rings of sand must separate grass from open water.
const SAND_BUFFER = 1;

// Coastline shaping. elevation(cell) = (1 - dist)*ELEV_GAIN + (noise-0.5)*NOISE_AMP,
// where dist is 0 at centre and 1 at the tile radius. Cutoffs are tuned so
// (ignoring noise) land reaches ~0.95 and grass ~0.80 of the radius — the sand
// buffer then trims grass back to ~0.68, comfortably past the 0.58 building
// ring from computeIslandLayout, so cluster houses land on grass with a sand
// rim beyond them. A GRASS_CORE_FRAC disc is force-grassed as a safety net so
// the ring of workspace buildings is never marooned on sand by a noise dip.
const ELEV_GAIN = 1.18;
const NOISE_AMP = 0.30;
const NOISE_FREQ = 2.2;
const LAND_CUT = 0.06;
const GRASS_CUT = 0.24;
const GRASS_CORE_FRAC = 0.62; // land within this radius is always solid grass (see core-solidify pass)

// Coastline lobing: the normalised radius is warped by a sum of two sine lobes in the polar
// ANGLE (random count/phase/amplitude per island), so islands grow bays and peninsulas instead
// of reading as plain circles. Amplitudes are kept modest and the inner core is force-solidified
// below, so lobing only reshapes the OUTER coast — it can never carve water into the building ring.
const LOBE_AMP_A = 0.13; // max depth of the primary lobe (fraction of radius)
const LOBE_AMP_B = 0.08; // max depth of the secondary lobe

const N4 = [
  [0, -1], // N
  [1, 0], // E
  [0, 1], // S
  [-1, 0], // W
];

const N8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/**
 * @typedef {Object} IslandGrid
 * @property {number} size - grid is size×size cells
 * @property {number} radius - tile radius (centre to edge)
 * @property {Uint8Array} biome - size*size BIOME values, row-major
 * @property {Uint8Array} path - size*size 0/1 cobble-path overlay
 * @property {(i:number,j:number)=>number} at - biome lookup (WATER outside grid)
 * @property {(i:number,j:number)=>boolean} isPath
 */

function idx(i, j, size) {
  return j * size + i;
}

/**
 * Generates the classified biome grid for one island.
 *
 * @param {string} seedStr - session id (stable per island)
 * @param {number} tileRadius - centre-to-edge radius in tiles (>=3)
 * @returns {IslandGrid}
 */
export function generateIslandGrid(seedStr, tileRadius) {
  const R = Math.max(3, Math.round(tileRadius));
  const size = R * 2 + 1;
  const seed = hashSeed(seedStr);
  const biome = new Uint8Array(size * size); // defaults to WATER (0)
  const coreR = GRASS_CORE_FRAC * R;

  // Per-island coastline lobe parameters (deterministic from the seed): two sine lobes with
  // random spoke counts (2..3 and 4..6), phases, and amplitudes give each island a distinct
  // non-circular outline (bays + peninsulas) that is stable across polls.
  const shapeRng = mulberry32((seed ^ 0x2f9a41c3) >>> 0);
  const lobeK1 = 2 + Math.floor(shapeRng() * 2);
  const lobePh1 = shapeRng() * Math.PI * 2;
  const lobeAmp1 = LOBE_AMP_A * (0.6 + 0.4 * shapeRng());
  const lobeK2 = 4 + Math.floor(shapeRng() * 3);
  const lobePh2 = shapeRng() * Math.PI * 2;
  const lobeAmp2 = LOBE_AMP_B * (0.5 + 0.5 * shapeRng());

  // 1) Raw elevation classification (angle-warped radial falloff perturbed by fBm).
  const elev = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const nx = (i - R) / R;
      const ny = (j - R) / R;
      const dist = Math.hypot(nx, ny);
      // Warp the effective distance by the angular lobes: a positive lobe pushes the coast
      // inward (a bay), a negative one bulges it outward (a peninsula).
      const ang = Math.atan2(ny, nx);
      const lobe = lobeAmp1 * Math.sin(lobeK1 * ang + lobePh1) + lobeAmp2 * Math.sin(lobeK2 * ang + lobePh2);
      const distW = dist * (1 + lobe);
      const n = fbm(nx, ny, seed, { octaves: 4, frequency: NOISE_FREQ, persistence: 0.5 });
      elev[idx(i, j, size)] = (1 - distW) * ELEV_GAIN + (n - 0.5) * NOISE_AMP;
    }
  }

  const isLandElev = (i, j) => elev[idx(i, j, size)] > LAND_CUT;

  // 2) Keep only the land component connected to the centre (drop stray islets
  //    that the noise flung into the sea), then fill 1-cell water holes so the
  //    landmass reads as solid, not pockmarked.
  const land = new Uint8Array(size * size);
  const cx = R;
  const cy = R;
  if (isLandElev(cx, cy)) {
    const stack = [[cx, cy]];
    land[idx(cx, cy, size)] = 1;
    while (stack.length) {
      const [i, j] = stack.pop();
      for (const [di, dj] of N4) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
        const k = idx(ni, nj, size);
        if (!land[k] && isLandElev(ni, nj)) {
          land[k] = 1;
          stack.push([ni, nj]);
        }
      }
    }
  }
  // Fill enclosed single-cell water holes (all 4 orthogonal neighbours land).
  for (let j = 1; j < size - 1; j++) {
    for (let i = 1; i < size - 1; i++) {
      if (land[idx(i, j, size)]) continue;
      let landN = 0;
      for (const [di, dj] of N4) if (land[idx(i + di, j + dj, size)]) landN++;
      if (landN === 4) land[idx(i, j, size)] = 1;
    }
  }

  // Force-solidify the inner core: every cell within coreR of centre is land regardless of
  // elevation. This guarantees a solid middle so the coastline lobes/noise only sculpt the
  // outer rim — the building ring (CLUSTER_RING_FACTOR) and bridge anchors (BRIDGE_ANCHOR_FRAC,
  // both < GRASS_CORE_FRAC) always sit on solid ground.
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (Math.hypot(i - R, j - R) <= coreR) land[idx(i, j, size)] = 1;
    }
  }

  // 3) Distance-to-water (in tiles) via BFS from every water/off-grid edge, so
  //    we can guarantee the sand buffer: grass only where dist > SAND_BUFFER.
  const distToWater = new Int16Array(size * size).fill(0);
  const queue = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = idx(i, j, size);
      const borderWater = i === 0 || j === 0 || i === size - 1 || j === size - 1;
      if (!land[k] || borderWater) {
        // treat non-land (and the grid frame) as water sources at distance 0
        if (!land[k]) {
          distToWater[k] = 0;
          queue.push([i, j]);
        }
      }
    }
  }
  // Land cells start "unvisited" (large); BFS outward from water.
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = idx(i, j, size);
      if (land[k]) distToWater[k] = 32767;
    }
  }
  // 8-connected BFS: chebyshev distance to water. Using N8 (not N4) is what
  // makes `distToWater > SAND_BUFFER` a true guarantee — a grass cell at
  // chebyshev distance >= 2 has NO water in any of its 8 neighbours.
  let head = 0;
  while (head < queue.length) {
    const [i, j] = queue[head++];
    const dk = distToWater[idx(i, j, size)];
    for (const [di, dj] of N8) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
      const k = idx(ni, nj, size);
      if (land[k] && distToWater[k] > dk + 1) {
        distToWater[k] = dk + 1;
        queue.push([ni, nj]);
      }
    }
  }

  // 4) Final biome: land within the sand buffer of water is SAND; deeper land
  //    is GRASS if its elevation clears the grass cutoff OR it sits inside the
  //    force-grass core (so the building ring is never stranded on sand). The
  //    sand buffer always wins over the core, preserving the shoreline invariant.
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = idx(i, j, size);
      if (!land[k]) {
        biome[k] = BIOME.WATER;
        continue;
      }
      const dc = Math.hypot(i - R, j - R);
      const bufferOk = distToWater[k] > SAND_BUFFER;
      const grassByElev = elev[k] > GRASS_CUT;
      const grassByCore = dc <= coreR;
      if (bufferOk && (grassByElev || grassByCore)) {
        biome[k] = BIOME.GRASS;
      } else {
        biome[k] = BIOME.SAND;
      }
    }
  }

  const at = (i, j) => {
    if (i < 0 || j < 0 || i >= size || j >= size) return BIOME.WATER;
    return biome[idx(i, j, size)];
  };
  const path = new Uint8Array(size * size);
  const isPath = (i, j) => {
    if (i < 0 || j < 0 || i >= size || j >= size) return false;
    return path[idx(i, j, size)] === 1;
  };

  return { size, radius: R, biome, path, at, isPath, _seed: seed };
}

/**
 * 4-bit N/E/S/W autotile mask over cells whose biome is >= `minBiome`
 * (i.e. "this transition tile connects to same-or-higher land on that side").
 * Bit order: N=1, E=2, S=4, W=8.
 *
 * @param {IslandGrid} grid
 * @param {number} i
 * @param {number} j
 * @param {number} minBiome - BIOME threshold that counts as "connected"
 * @returns {number} 0..15
 */
export function edgeMask(grid, i, j, minBiome) {
  let m = 0;
  if (grid.at(i, j - 1) >= minBiome) m |= 1;
  if (grid.at(i + 1, j) >= minBiome) m |= 2;
  if (grid.at(i, j + 1) >= minBiome) m |= 4;
  if (grid.at(i - 1, j) >= minBiome) m |= 8;
  return m;
}

/** True when the cell is land but touches water on any of its 8 neighbours. */
export function isShoreCell(grid, i, j) {
  if (grid.at(i, j) === BIOME.WATER) return false;
  for (const [di, dj] of N8) {
    if (grid.at(i + di, j + dj) === BIOME.WATER) return true;
  }
  return false;
}

/** True when a GRASS cell borders SAND (candidate for a grass/sand transition tile). */
export function isGrassSandEdge(grid, i, j) {
  if (grid.at(i, j) !== BIOME.GRASS) return false;
  for (const [di, dj] of N8) {
    if (grid.at(i + di, j + dj) === BIOME.SAND) return true;
  }
  return false;
}

/**
 * Rasterises a hub→building road (in LOCAL tile coordinates, where the island
 * centre is grid cell (R,R)) onto the path overlay as a THIN, 1-tile-wide cobble
 * ribbon that gently CURVES rather than running dead straight.
 *
 * The street is a quadratic Bézier whose control point is pushed `bend` tiles
 * perpendicular to the straight hub→door line, so a positive/negative bend bows
 * the road to one side or the other (pass a per-street random bend for organic,
 * non-repeating shapes; bend=0 degenerates to a straight line). We sample the
 * curve finely and paint a 4-CONNECTED chain of cells (adding an L-corner cell
 * whenever both axes step at once) so the single-width path still reads as one
 * continuous ribbon under the dual-grid autotiler instead of a dotted diagonal.
 * Only land cells are painted — a path never floats on water.
 *
 * @param {IslandGrid} grid
 * @param {number} i0
 * @param {number} j0
 * @param {number} i1
 * @param {number} j1
 * @param {number} [bend=0] - perpendicular curve depth at the midpoint, in tiles
 */
export function rasterizePath(grid, i0, j0, i1, j1, bend = 0) {
  const { size, path } = grid;

  const paint = (px, py) => {
    const rx = Math.round(px);
    const ry = Math.round(py);
    if (rx < 0 || ry < 0 || rx >= size || ry >= size) return;
    const k = ry * size + rx;
    if (grid.biome[k] !== BIOME.WATER) path[k] = 1; // keep streets on land
  };

  const dx = i1 - i0;
  const dy = j1 - j0;
  const len = Math.hypot(dx, dy) || 1;
  // Control point offset perpendicular to the straight line → a bowed street.
  const cx = (i0 + i1) / 2 - (dy / len) * bend;
  const cy = (j0 + j1) / 2 + (dx / len) * bend;

  // Sample so consecutive points are ~<=0.5 tile apart, painting a 4-connected chain.
  const steps = Math.max(2, Math.ceil(len * 2));
  let prevX = null;
  let prevY = null;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const it = 1 - t;
    const x = it * it * i0 + 2 * it * t * cx + t * t * i1;
    const y = it * it * j0 + 2 * it * t * cy + t * t * j1;
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === prevX && ry === prevY) continue;
    // Both axes stepped → drop an L-corner cell so the ribbon stays 4-connected.
    if (prevX !== null && rx !== prevX && ry !== prevY) paint(prevX, ry);
    paint(rx, ry);
    prevX = rx;
    prevY = ry;
  }
}

/**
 * Picks decor cells: grass tiles that are neither path nor near a building,
 * plus prop cells near buildings/path corners. Returns local (i,j) lists the
 * renderer maps to world positions. Deterministic per island seed.
 *
 * @param {IslandGrid} grid
 * @param {Array<{i:number,j:number}>} buildingCells - local building tile coords
 * @param {number} treeDensity - 0..1 fraction of eligible grass to plant
 * @returns {{ trees: Array<{i,j,r}>, rocks: Array<{i,j,r}>, props: Array<{i,j,r}> }}
 */
export function planDecor(grid, buildingCells, treeDensity = 0.18) {
  const rng = mulberry32(grid._seed ^ 0x51ed270b);
  const { size } = grid;
  const nearBuilding = (i, j) =>
    buildingCells.some((b) => Math.abs(b.i - i) <= 1 && Math.abs(b.j - j) <= 1);

  const trees = [];
  const rocks = [];
  const props = [];

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (grid.at(i, j) !== BIOME.GRASS) continue;
      if (grid.isPath(i, j) || nearBuilding(i, j)) continue;
      const roll = rng();
      if (roll < treeDensity) {
        trees.push({ i, j, r: rng() });
      } else if (roll < treeDensity + 0.05) {
        rocks.push({ i, j, r: rng() });
      }
    }
  }

  // Props (barrels/crates/lamps) hug building fronts and path cells for a
  // "settlement" feel — one prop per building, plus a sprinkling along paths.
  for (const b of buildingCells) {
    props.push({ i: b.i, j: b.j + 1, r: rng(), kind: 'building' });
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      if (!grid.isPath(i, j)) continue;
      if (grid.at(i + 1, j) === BIOME.GRASS && rng() < 0.06) {
        props.push({ i: i + 1, j, r: rng(), kind: 'path' });
      }
    }
  }

  return { trees, rocks, props };
}
