import Phaser from 'phaser';
import KingdomScene from './KingdomScene.js';
import {
  generateIslandGrid,
  BIOME,
  rasterizePath,
  planDecor,
} from '../v3/islandTiles.js';
import { mulberry32 } from '../v3/noise.js';
import {
  pick,
  genLoadList,
  SAND_TILES,
  GRASS_TILES,
  PATH_TILES,
  TREE_KEYS,
  ROCK_KEYS,
  BUILDING_PROP_KEYS,
  PATH_PROP_KEYS,
} from '../v3/tileManifest.js';

/**
 * @class KingdomSceneV3
 * @extends KingdomScene
 *
 * V3 of the Kingdom dashboard: identical behaviour to KingdomScene (same agent
 * physics, King Bob patrol, camera, session model, labels) but the ENTIRE
 * visual ground layer is redrawn from the sliced tile atlas instead of flat
 * vector polygons.
 *
 * What changed vs the base scene (visuals only — every data seam is inherited):
 *  - Islands are real tile grids: organic radial-noise coastline, biome
 *    hierarchy Ocean → Sand → Grass with a guaranteed sand shoreline buffer,
 *    autotiled shore/transition rings, cobblestone path networks linking the
 *    workspace houses to the island hub, and scattered tree/rock/prop decor.
 *  - Workspace houses + King Bob's throne are INHERITED from the base scene:
 *    the real downloaded building cutouts under public/buildings (same art as
 *    the main app), so v3 no longer overrides house rendering.
 *  - The ocean uses the atlas water tile as its repeating skin.
 *
 * Registered under the SAME scene key ('KingdomScene') so main.js's
 * game.scene.getScene('KingdomScene') and scene.updateAgents() work unchanged.
 */

const TILE = 26; // on-screen px per ground tile

class KingdomSceneV3 extends KingdomScene {
  constructor() {
    super();
    // Reuse the same scene key so the existing main.js polling wiring resolves us.
    this.islandTiles = new Map(); // sessionId -> { container, trees, radius }
  }

  // ── Preload: char sheets (inherited need) + every atlas tile PNG ──────────
  preload() {
    for (let i = 0; i < 6; i++) {
      this.load.spritesheet(`char_${i}`, `/sprites/char_${i}.png`, {
        frameWidth: 16,
        frameHeight: 32,
      });
    }

    // Ocean skin = the generated static water tile (matches the island coast art).
    this.load.image('ocean-tile', '/gen/terrain/water.png');

    // Generated dual-grid terrain tiles + coherent decor sprites.
    genLoadList().forEach(({ key, url }) => this.load.image(key, url));

    // Houses: reuse the MAIN APP's real building cutouts (public/buildings),
    // under the same 'house-<name>' keys the inherited base renderer expects.
    KingdomScene.HOUSE_KEYS.forEach((name) =>
      this.load.image(`house-${name}`, `/buildings/${name}.png`)
    );

    this.load.on('loaderror', (fileObj) => {
      console.error('❌ V3 failed to load:', fileObj.key, fileObj.url);
    });
  }

  // ── Ocean: a STATIC field of the atlas water tile, sized to match ground ──
  /**
   * Overrides the base animated sea. The water is the same r0c0 atlas tile used
   * everywhere else, repeated so each wave cell is exactly TILE px — identical
   * in size to every land tile. No drift, no shimmer, no crests: `this.oceanTile`
   * is deliberately left null so the base update()'s scroll and animateWaterDrag
   * both no-op. The result is a flat, uniform, motionless sea.
   */
  createWaterBackground(worldWidth, worldHeight, originX = 0, originY = 0) {
    const width = worldWidth || this.cameras.main.width;
    const height = worldHeight || this.cameras.main.height;

    if (this.textures.exists('ocean-tile')) {
      const ocean = this.add.tileSprite(originX, originY, width, height, 'ocean-tile');
      ocean.setOrigin(0, 0);
      ocean.setDepth(-10);
      // Scale each 64px source repeat to exactly (TILE+1)² — byte-identical in
      // size to every ground tile, so the sea reads as the same square.
      const src = ocean.texture.getSourceImage();
      ocean.tileScaleX = (TILE + 1) / (src.width || 1);
      ocean.tileScaleY = (TILE + 1) / (src.height || 1);
      this.waterObjs.push(ocean); // NOT assigned to this.oceanTile → stays static
    } else {
      const g = this.add.graphics();
      g.fillStyle(0x4a86a8, 1);
      g.fillRect(originX, originY, width, height);
      g.setDepth(-10);
      this.waterObjs.push(g);
    }
  }

  // ── Island visuals: tile grids + paths + managed houses/labels/throne ─────
  /**
   * Overrides the base vector-blob renderer. Bridges + a soft cast shadow still
   * use islandGfx; the landmass itself is a per-session tile container.
   */
  syncIslandVisuals(islands, bridges = []) {
    const g = this.islandGfx;
    g.clear();

    // Bridges first (wooden planks from the base class), then a soft shadow so
    // each island reads as a raised landmass floating on the sea.
    if (Array.isArray(bridges)) {
      bridges.forEach((bridge) => {
        if (Array.isArray(bridge) && bridge.length === 2 && bridge[0] && bridge[1]) {
          this.drawBridge(g, bridge[0], bridge[1]);
        }
      });
    }
    islands.forEach((island) => {
      const factors = this.islandShapeFactors(island.sessionId);
      const shadowPts = this.islandOutline(island.cx, island.cy + 12, island.radius + 10, factors);
      g.fillStyle(0x05141f, 0.16);
      g.fillPoints(shadowPts, true);
    });

    const seenSessions = new Set();
    const seenClusters = new Set();

    islands.forEach((island) => {
      seenSessions.add(island.sessionId);
      this.syncIslandTiles(island);

      // Session name plate (unchanged from base).
      let label = this.sessionLabelObjs.get(island.sessionId);
      if (!label) {
        label = this.add.text(0, 0, island.label, {
          fontSize: '15px',
          fontFamily: 'DM Sans',
          fontStyle: 'bold',
          color: '#2d1f0f',
          backgroundColor: 'rgba(255, 215, 0, 0.92)',
          padding: { x: 10, y: 4 },
        });
        label.setOrigin(0.5);
        label.setDepth(100000);
        this.sessionLabelObjs.set(island.sessionId, label);
      }
      label.setText(island.label);
      label.setPosition(island.cx, island.cy - island.radius - 20);

      // Workspace houses (atlas cutouts via overridden createClusterBuilding).
      island.clusters.forEach((cluster) => {
        const key = `${island.sessionId}::${cluster.taskId}`;
        seenClusters.add(key);
        let obj = this.clusterBuildingObjs.get(key);
        if (!obj) {
          obj = this.createClusterBuilding(cluster.x, cluster.y, key);
          this.clusterBuildingObjs.set(key, obj);
        }
        obj.container.setPosition(cluster.x, cluster.y);
        obj.container.setDepth(this.depthForY(cluster.y));
        obj.label.setText(this.truncate(cluster.description || 'Working…', 26));
      });
    });

    // Teardown for vanished sessions/clusters.
    for (const [sessionId, label] of this.sessionLabelObjs) {
      if (!seenSessions.has(sessionId)) {
        label.destroy();
        this.sessionLabelObjs.delete(sessionId);
      }
    }
    for (const [key, obj] of this.clusterBuildingObjs) {
      if (!seenClusters.has(key)) {
        obj.container.destroy();
        this.clusterBuildingObjs.delete(key);
      }
    }
    for (const [sessionId, decor] of this.islandTiles) {
      if (!seenSessions.has(sessionId)) {
        decor.container.destroy();
        if (decor.waterContainer) decor.waterContainer.destroy();
        decor.trees.forEach((t) => t.obj.destroy());
        this.islandTiles.delete(sessionId);
      }
    }
  }

  /**
   * Builds/repositions one island's tile terrain. Regenerated only when the
   * island's radius changes (cluster count grew/shrank); otherwise just moved,
   * so tiles never flicker on the 1 s poll.
   * @param {Object} island
   * @private
   */
  syncIslandTiles(island) {
    let entry = this.islandTiles.get(island.sessionId);
    if (!entry || Math.abs(entry.radius - island.radius) > 1) {
      if (entry) {
        entry.container.destroy();
        if (entry.waterContainer) entry.waterContainer.destroy();
        entry.trees.forEach((t) => t.obj.destroy());
      }
      entry = this.buildIslandTiles(island);
      this.islandTiles.set(island.sessionId, entry);
    }
    entry.container.setPosition(island.cx, island.cy);
    if (entry.waterContainer) entry.waterContainer.setPosition(island.cx, island.cy);
    entry.trees.forEach((tree) => {
      tree.obj.setPosition(island.cx + tree.relX, island.cy + tree.relY);
    });
  }

  /**
   * Generates the biome grid, rasterises the path network, and lays down all
   * ground tiles into a single container (positioned later at the island
   * centre). Trees are returned as standalone objects so they depth-sort
   * against agents/houses. Deterministic per session id + radius.
   *
   * @param {Object} island
   * @returns {{ container: Phaser.GameObjects.Container, trees: Array, radius: number }}
   * @private
   */
  buildIslandTiles(island) {
    const R = Math.max(3, Math.round(island.radius / TILE));
    const grid = generateIslandGrid(island.sessionId, R);
    const { size } = grid;

    // Local tile coords: island centre is grid cell (R, R). World<->grid helpers.
    const worldToCell = (wx, wy) => ({
      i: Math.round((wx - island.cx) / TILE) + R,
      j: Math.round((wy - island.cy) / TILE) + R,
    });

    // Building + throne cells. Force a grass pad under each (only where it can
    // stay clear of water, preserving the "grass never touches water" invariant)
    // so every house stands on grass.
    const buildingCells = island.clusters.map((c) => worldToCell(c.x, c.y));
    if (island.throne) buildingCells.push(worldToCell(island.throne.x, island.throne.y));
    const noWaterAround = (i, j) => {
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++)
          if (grid.at(i + di, j + dj) === BIOME.WATER) return false;
      return true;
    };
    for (const b of buildingCells) {
      if (b.i >= 0 && b.j >= 0 && b.i < size && b.j < size && noWaterAround(b.i, b.j)) {
        grid.biome[b.j * size + b.i] = BIOME.GRASS;
      }
    }

    // Cobble road network — ONLY on islands with 2+ workspace buildings. On a
    // quiet single-house (or throne-only) island the hub-and-spoke model would
    // leave a bare grey cobble slab at the island centre with nothing on it (the
    // "concrete" blob), so we skip roads entirely there. The throne sits ON the
    // hub, so it gets no spoke; each cluster house is linked to the hub with a
    // short SOUTH door stub so its entrance opens onto the road.
    if (island.clusters.length >= 2) {
      const clusterCells = island.clusters.map((c) => worldToCell(c.x, c.y));
      // Deterministic per-island RNG so each spoke bows a stable, non-repeating amount.
      const roadRng = mulberry32((grid._seed ^ 0x9e3779b9) >>> 0);
      for (const b of clusterCells) {
        const len = Math.hypot(b.i - R, b.j - R) || 1;
        // Bow up to ~35% of the spoke length to either side (capped so long spokes
        // on big islands don't wander off the landmass).
        const bend = (roadRng() * 2 - 1) * Math.min(len * 0.35, 5);
        rasterizePath(grid, R, R, b.i, b.j, bend);
        // 1-wide south door stub so the entrance opens onto the street.
        const si = b.i;
        const sj = b.j + 1;
        if (si >= 0 && sj >= 0 && si < size && sj < size && grid.biome[sj * size + si] !== BIOME.WATER) {
          grid.path[sj * size + si] = 1;
        }
      }
    }

    const container = this.add.container(0, 0);
    container.setDepth(-9);

    // ── DUAL-GRID marching-squares autotiling ──────────────────────────────
    // A display tile sits on the grid VERTICES, not the cells: display tile
    // (a,b) is centred on the corner shared by cells (a-1,b-1),(a,b-1),(a-1,b),
    // (a,b) and samples those four as its TL,TR,BL,BR corners. The tile art is
    // chosen purely by the 4-bit corner mask (bit0=TL,1=TR,2=BL,3=BR). Because
    // any two adjacent display tiles share the two cells along their common
    // edge, their boundary contours are identical → seamless BY CONSTRUCTION.
    // Each layer is an independent binary field, painted bottom-up so a higher
    // layer's transparent gaps reveal the layer beneath (water ▸ sand ▸ grass ▸
    // path). Every tile is exactly (TILE+1)² px so nothing seams sub-pixel.
    const placeVertexTile = (texKey, a, b) => {
      if (!texKey) return;
      const img = this.add.image((a - R - 0.5) * TILE, (b - R - 0.5) * TILE, texKey);
      img.setDisplaySize(TILE + 1, TILE + 1);
      container.add(img);
    };

    const isLand = (i, j) => (grid.at(i, j) !== BIOME.WATER ? 1 : 0);
    const isGrass = (i, j) => (grid.at(i, j) === BIOME.GRASS ? 1 : 0);
    const isPathCell = (i, j) => (grid.isPath(i, j) ? 1 : 0);

    // Paint one layer's full dual-grid pass. Vertices span [0..size] with a small
    // margin so coast tiles at the landmass rim are emitted (off-grid = water).
    const paintLayer = (pred, tiles) => {
      const M = 2;
      for (let b = -M; b <= size + M; b++) {
        for (let a = -M; a <= size + M; a++) {
          const mask =
            pred(a - 1, b - 1) |
            (pred(a, b - 1) << 1) |
            (pred(a - 1, b) << 2) |
            (pred(a, b) << 3);
          if (mask) placeVertexTile(tiles[mask], a, b);
        }
      }
    };

    // Sand covers ALL land (grass sits on top of sand), so the sand layer's only
    // boundary is the coastline — that is where its foam/wet-sand edge renders.
    paintLayer(isLand, SAND_TILES);
    paintLayer(isGrass, GRASS_TILES);
    paintLayer(isPathCell, PATH_TILES);

    // Decor plan (grass tiles clear of path/buildings; props near houses/paths).
    const decor = planDecor(grid, buildingCells, 0.16);

    // Flat decor: rocks + settlement props are OVERLAY objects (smaller than a
    // ground tile) that sit on top of the biome cell, not autotiled fills.
    const placeDecor = (texKey, i, j, frac) => {
      if (!texKey) return;
      const img = this.add.image((i - R) * TILE, (j - R) * TILE, texKey);
      img.setDisplaySize(TILE * frac, TILE * frac);
      container.add(img);
    };
    for (const rk of decor.rocks) {
      placeDecor(pick(ROCK_KEYS, Math.floor(rk.r * 1e6)), rk.i, rk.j, 0.7);
    }
    for (const p of decor.props) {
      const pool = p.kind === 'building' ? BUILDING_PROP_KEYS : PATH_PROP_KEYS;
      placeDecor(pick(pool, Math.floor(p.r * 1e6)), p.i, p.j, 0.55);
    }

    // Trees are standalone y-sorted objects (walk in front of / behind them).
    const trees = [];
    for (const t of decor.trees) {
      const relX = (t.i - R) * TILE;
      const relY = (t.j - R) * TILE;
      const key = pick(TREE_KEYS, Math.floor(t.r * 1e6));
      if (!key) continue;
      const obj = this.add.image(island.cx + relX, island.cy + relY, key);
      const h = 40 + t.r * 16;
      obj.setDisplaySize(h * 1.05, h);
      obj.setOrigin(0.5, 0.82); // anchor near the trunk base for depth sorting
      obj.setDepth(this.depthForY(island.cy + relY));
      trees.push({ obj, relX, relY });
    }

    // waterContainer is retained (null) for API parity with syncIslandTiles /
    // teardown, which null-guard it; the global static ocean covers the sea now.
    return { container, waterContainer: null, trees, radius: island.radius };
  }

  // Keep trees interleaving with agents/houses (base loops over islandDecor,
  // which v3 doesn't populate — sort our own island-tile trees instead).
  updateTreeDepthSorting() {
    this.islandTiles.forEach((entry) => {
      entry.trees.forEach((tree) => tree.obj.setDepth(this.depthForY(tree.obj.y)));
    });
  }

  // Houses (workspace buildings + King Bob's throne) are intentionally NOT
  // overridden here: v3 inherits base createClusterBuilding / syncKingBobThrone,
  // which draw the real downloaded /buildings cutouts (main-app art).
}

export default KingdomSceneV3;
