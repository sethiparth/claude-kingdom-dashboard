/**
 * Pure geometry for the session-island archipelago.
 *
 * Each Claude Code session becomes an island; the session's task clusters become
 * workspace buildings arranged on a ring inside that island. Instead of a straight
 * horizontal chain, islands are SCATTERED across a 2D world rect at pseudo-random,
 * non-overlapping positions. Placement is deterministic per session: every island's
 * candidate position is drawn from a mulberry32 PRNG seeded by a hash of its
 * `sessionId`, so an island keeps its spot across the 1s poll (no flicker/jumping)
 * as long as the session survives between polls. Overlap is avoided via bounded
 * rejection sampling against already-placed islands (min center distance =
 * r1 + r2 + GAP), falling back to the least-overlapping candidate seen if no
 * perfect spot is found within the attempt budget.
 *
 * The world rect (`worldWidth` x `worldHeight`) grows with the number/size of
 * islands so a busy archipelago doesn't feel cramped; KingdomScene uses it to set
 * camera bounds and size the water fill.
 *
 * Two more derived structures ride along with each island:
 *  - `roads`: hub-and-spoke polylines from the island center to each workspace
 *    building (only when an island has 2+ clusters).
 *  - `bridges` (top-level): nearest-neighbor connectors between islands, with
 *    endpoints pulled in to each island's shoreline (offset by its radius toward
 *    the neighbor) rather than sitting at the centers.
 *
 * Within an island, workspace nodes (each cluster's building + King Bob's `throne`) never
 * overlap: computeIslandRadius() grows the island (past its normal cluster-count sizing, even
 * past MAX_ISLAND_RADIUS if needed) until the ring/above-below-center arrangement has enough
 * room for every node's footprint plus a gap — see computeMinNoOverlapRadius().
 *
 * This module is intentionally free of Phaser/rendering concerns — it only turns the
 * session model into coordinates. KingdomScene consumes the result to draw landmasses,
 * bridges, roads, and buildings, and to place agents.
 */

const MIN_ISLAND_RADIUS = 180;   // smallest island (1 cluster)
const MAX_ISLAND_RADIUS = 340;   // preferred cap — overridden if overlap-avoidance needs more room
const RADIUS_PER_EXTRA_CLUSTER = 38;
const CLUSTER_RING_FACTOR = 0.58; // where cluster buildings sit relative to island radius
// Bridge endpoints are anchored at this fraction of an island's radius (well inside the
// tile shoreline, which sits inside the layout radius). The buried inner span is hidden by
// the land tiles, so the visible plank runs shore-to-shore instead of stopping in open water.
// Kept <= GRASS_CORE_FRAC (islandTiles) so the anchor always lands on the force-solid core.
const BRIDGE_ANCHOR_FRAC = 0.6;
const ISLAND_GAP = 70;            // minimum clear water between two island shorelines
const EDGE_MARGIN = 40;           // extra clearance beyond radius when hugging the world edge
const MAX_PLACEMENT_ATTEMPTS = 300; // bounded rejection-sampling budget per island

// Workspace footprints — approximate half-width of each rendered node (building + its label,
// or King Bob's throne) plus a safety margin. Used only to size the *minimum* island radius
// needed so no two workspace nodes (clusters or the throne) ever overlap; the nodes are still
// laid out on the existing ring/above-below-center pattern, just at a radius big enough to
// keep them apart.
const CLUSTER_FOOTPRINT_RADIUS = 70; // half of a workspace building's rendered footprint (incl. label)
const THRONE_FOOTPRINT_RADIUS = 28;  // half of King Bob's throne marker
const NODE_GAP = 26;                 // minimum clear gap enforced between any two footprints

// Single-cluster islands: the lone building sits this far above center, King Bob's throne
// this far below — symmetric so both have equal room, mirrored via cy -/+ radius * offset.
const SINGLE_CLUSTER_OFFSET = 0.35;
const SINGLE_THRONE_OFFSET = 0.35;

/**
 * @typedef {Object} SessionModel
 * @property {string} sessionId
 * @property {string} label - Display label, e.g. "Session 2"
 * @property {Array<Object>} clusters - Each { taskId, description, agents }
 * @property {Array<Object>} kingBobs - King Bob character(s) for this session
 */

/**
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} IslandLayoutResult
 * @property {Array<Object>} islands - { sessionId, label, kingBobs, cx, cy, radius, clusters, roads, throne }
 * @property {Array<[Point, Point]>} bridges - shoreline-to-shoreline connectors between islands
 * @property {number} worldWidth
 * @property {number} worldHeight
 */

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG
// ---------------------------------------------------------------------------

/**
 * Hashes a string into a 32-bit unsigned int (simple djb2-style mix).
 * Used to derive a stable PRNG seed from a sessionId.
 *
 * @param {string} str
 * @returns {number}
 */
function hashStringToSeed(str) {
  let h = 2166136261; // FNV-ish offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Ensure a non-zero, unsigned 32-bit seed.
  return (h >>> 0) || 1;
}

/**
 * mulberry32: tiny, fast, deterministic PRNG. Returns a function that yields
 * floats in [0, 1) on each call, advancing its own internal state.
 *
 * @param {number} seed - 32-bit unsigned int seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Minimum island radius that guarantees no two workspace nodes (cluster buildings and/or
 * King Bob's throne) overlap, given how they're arranged: a ring of `clusterCount` buildings
 * (>1) with the throne at the exact center, or a single building above center / throne below
 * center (clusterCount === 1). Purely geometric — derived from the footprint constants above,
 * independent of `computeIslandRadius()`'s own cluster-count-based sizing.
 *
 * @param {number} clusterCount
 * @param {boolean} hasThrone - Whether this session has a King Bob to make room for
 * @returns {number}
 */
function computeMinNoOverlapRadius(clusterCount, hasThrone) {
  if (clusterCount <= 1) {
    if (!hasThrone) return 0;
    const requiredSpan = CLUSTER_FOOTPRINT_RADIUS + THRONE_FOOTPRINT_RADIUS + NODE_GAP;
    const offsetSum = SINGLE_CLUSTER_OFFSET + SINGLE_THRONE_OFFSET;
    return requiredSpan / offsetSum;
  }

  // Adjacent ring buildings must clear each other...
  const minChord = 2 * CLUSTER_FOOTPRINT_RADIUS + NODE_GAP;
  const halfAngle = Math.PI / clusterCount;
  const ringRadiusForSpacing = minChord / (2 * Math.sin(halfAngle));

  // ...and every ring building must clear the throne sitting at the center.
  const ringRadiusForThrone = hasThrone
    ? CLUSTER_FOOTPRINT_RADIUS + THRONE_FOOTPRINT_RADIUS + NODE_GAP
    : 0;

  const requiredRingRadius = Math.max(ringRadiusForSpacing, ringRadiusForThrone);
  return requiredRingRadius / CLUSTER_RING_FACTOR;
}

/**
 * Island radius grows with the number of clusters it hosts (soft-capped at
 * MAX_ISLAND_RADIUS), then grows further if needed so its workspace nodes (cluster
 * buildings + King Bob's throne) can be laid out without overlapping — overlap avoidance
 * always wins over the cap.
 *
 * @param {SessionModel} session
 * @returns {number}
 */
function computeIslandRadius(session) {
  const clusterCount = Math.max(1, session.clusters.length);
  const baseRadius = Math.min(
    MIN_ISLAND_RADIUS + (clusterCount - 1) * RADIUS_PER_EXTRA_CLUSTER,
    MAX_ISLAND_RADIUS
  );
  const hasThrone = Array.isArray(session.kingBobs) && session.kingBobs.length > 0;
  const noOverlapRadius = computeMinNoOverlapRadius(clusterCount, hasThrone);

  return Math.max(baseRadius, noOverlapRadius, MIN_ISLAND_RADIUS);
}

/**
 * Sizes the world rect so all islands (given their radii) can be scattered with
 * comfortable breathing room. Starts from the incoming screen size and grows it
 * based on the total "packed" area the islands + gaps would need.
 *
 * @param {number} width
 * @param {number} height
 * @param {Array<number>} radii
 * @returns {{ worldWidth: number, worldHeight: number }}
 */
function computeWorldExtent(width, height, radii) {
  const packedArea = radii.reduce((sum, r) => {
    const footprint = r + ISLAND_GAP / 2;
    return sum + Math.PI * footprint * footprint;
  }, 0);

  // Leave plenty of open water around/between islands: target area is a
  // generous multiple of the raw packed footprint, never smaller than the screen.
  const targetArea = Math.max(width * height, packedArea * 2.4);
  const aspect = width > 0 && height > 0 ? width / height : 1;

  let worldHeight = Math.sqrt(targetArea / aspect);
  let worldWidth = worldHeight * aspect;

  worldWidth = Math.max(worldWidth, width);
  worldHeight = Math.max(worldHeight, height);

  return { worldWidth, worldHeight };
}

// ---------------------------------------------------------------------------
// Scatter placement (deterministic rejection sampling)
// ---------------------------------------------------------------------------

/**
 * Finds a non-overlapping (or least-overlapping, if the budget runs out)
 * position for one island within the world rect, using a PRNG seeded by that
 * island's own sessionId so it lands in the same place on every poll.
 *
 * @param {() => number} rng - Seeded PRNG for this island
 * @param {number} radius
 * @param {number} worldWidth
 * @param {number} worldHeight
 * @param {Array<{ cx: number, cy: number, radius: number }>} placed - Already-placed islands
 * @returns {Point}
 */
function findScatterPosition(rng, radius, worldWidth, worldHeight, placed) {
  const margin = radius + EDGE_MARGIN;
  const minX = Math.min(margin, worldWidth / 2);
  const maxX = Math.max(worldWidth - margin, minX);
  const minY = Math.min(margin, worldHeight / 2);
  const maxY = Math.max(worldHeight - margin, minY);
  const spanX = Math.max(0, maxX - minX);
  const spanY = Math.max(0, maxY - minY);

  let best = null;
  let bestSlack = -Infinity;

  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
    const candidate = {
      x: minX + rng() * spanX,
      y: minY + rng() * spanY
    };

    // "Slack" = smallest (distance - required clearance) across all placed
    // islands. Positive slack everywhere means a fully clear spot.
    let slack = Infinity;
    for (const other of placed) {
      const dx = candidate.x - other.cx;
      const dy = candidate.y - other.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const required = radius + other.radius + ISLAND_GAP;
      slack = Math.min(slack, dist - required);
    }
    if (placed.length === 0) slack = 0;

    if (slack > bestSlack) {
      bestSlack = slack;
      best = candidate;
    }
    if (slack >= 0) {
      // Fully clear of every other island — good enough, stop early.
      return candidate;
    }
  }

  // Budget exhausted: use the least-overlapping candidate we saw.
  return best || { x: minX + spanX / 2, y: minY + spanY / 2 };
}

// ---------------------------------------------------------------------------
// Roads (intra-island) and bridges (inter-island)
// ---------------------------------------------------------------------------

/**
 * Hub-and-spoke road network from the island center to each workspace building.
 * Islands with fewer than 2 clusters have nothing to connect.
 *
 * @param {Point} center
 * @param {Array<{ x: number, y: number }>} clusterPoints
 * @returns {Array<Array<Point>>}
 */
function computeRoads(center, clusterPoints) {
  if (clusterPoints.length < 2) return [];
  return clusterPoints.map(point => [
    { x: center.x, y: center.y },
    { x: point.x, y: point.y }
  ]);
}

/**
 * Builds a nearest-neighbor bridge graph across islands: every island connects
 * to whichever other island is closest, with mirrored pairs (A→B and B→A)
 * de-duplicated. Endpoints are pulled in from each island's center to its
 * shoreline, along the line toward the neighbor.
 *
 * @param {Array<{ cx: number, cy: number, radius: number }>} islands
 * @returns {Array<[Point, Point]>}
 */
function computeBridges(islands) {
  const n = islands.length;
  if (n < 2) return [];

  const seenPairs = new Set();
  const bridges = [];

  for (let i = 0; i < n; i++) {
    let nearestIdx = -1;
    let nearestDist = Infinity;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = islands[j].cx - islands[i].cx;
      const dy = islands[j].cy - islands[i].cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = j;
      }
    }

    if (nearestIdx === -1) continue;

    const pairKey = i < nearestIdx ? `${i}:${nearestIdx}` : `${nearestIdx}:${i}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const a = islands[i];
    const b = islands[nearestIdx];
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const dirX = dx / dist;
    const dirY = dy / dist;

    bridges.push([
      { x: a.cx + dirX * a.radius * BRIDGE_ANCHOR_FRAC, y: a.cy + dirY * a.radius * BRIDGE_ANCHOR_FRAC },
      { x: b.cx - dirX * b.radius * BRIDGE_ANCHOR_FRAC, y: b.cy - dirY * b.radius * BRIDGE_ANCHOR_FRAC }
    ]);
  }

  return bridges;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the scattered island archipelago + cluster-building coordinates +
 * road/bridge polylines for the current sessions.
 *
 * @param {Array<SessionModel>} sessions - Sessions (order only affects placement
 *        sequence for rejection sampling, not each island's own seeded slot)
 * @param {number} width - Screen width (lower bound for the world rect)
 * @param {number} height - Screen height (lower bound for the world rect)
 * @returns {IslandLayoutResult}
 */
export function computeIslandLayout(sessions, width, height) {
  const n = sessions.length;
  if (n === 0) {
    return { islands: [], bridges: [], worldWidth: width, worldHeight: height };
  }

  const radii = sessions.map(computeIslandRadius);
  const { worldWidth, worldHeight } = computeWorldExtent(width, height, radii);

  const placed = [];
  const islands = sessions.map((session, i) => {
    const radius = radii[i];
    const seed = hashStringToSeed(session.sessionId);
    const rng = mulberry32(seed);

    const { x: cx, y: cy } = findScatterPosition(rng, radius, worldWidth, worldHeight, placed);
    placed.push({ cx, cy, radius });

    const clusterCount = session.clusters.length;
    const clusters = session.clusters.map((cluster, ci) => {
      let x = cx;
      let y = cy;

      if (clusterCount > 1) {
        // Spread buildings evenly on a ring inside the island, starting at the top.
        const angle = (2 * Math.PI * ci) / clusterCount - Math.PI / 2;
        const ringRadius = radius * CLUSTER_RING_FACTOR;
        x = cx + Math.cos(angle) * ringRadius;
        y = cy + Math.sin(angle) * ringRadius;
      } else {
        // Single cluster sits above center; King Bob's throne mirrors it below center.
        y = cy - radius * SINGLE_CLUSTER_OFFSET;
      }

      return { ...cluster, x, y };
    });

    const roads = computeRoads({ x: cx, y: cy }, clusters);

    // King Bob's dedicated workspace ("throne") — one more placed node, kept clear of every
    // cluster building by the overlap-avoidance radius baked into `radius` above: dead center
    // when buildings ring around it (clusterCount > 1), or mirrored below center opposite the
    // single building (clusterCount === 1).
    const throne = (session.kingBobs && session.kingBobs.length > 0)
      ? (clusterCount > 1
        ? { x: cx, y: cy }
        : { x: cx, y: cy + radius * SINGLE_THRONE_OFFSET })
      : null;

    return {
      sessionId: session.sessionId,
      label: session.label,
      kingBobs: session.kingBobs,
      cx,
      cy,
      radius,
      clusters,
      roads,
      throne
    };
  });

  const bridges = computeBridges(islands);

  return { islands, bridges, worldWidth, worldHeight };
}
