import Phaser from 'phaser';
import AgentCharacter from '../entities/AgentCharacter.js';
import LayoutManager from '../managers/LayoutManager.js';
import CameraController from '../managers/CameraController.js';
import { computeIslandLayout } from '../managers/IslandLayout.js';

// World depth used for the always-on-top session name plates, kept comfortably above the
// tallest realistic y-sorted depth value (see depthForY()).
const SESSION_LABEL_DEPTH = 100000;

// Open sea padded AROUND the archipelago, as a fraction of the larger world dimension applied
// on every side. The water tile and the camera scroll-bounds both cover this padded rect, so
// the user can keep zooming out past "fit the islands" and watch the ocean grow while the
// islands shrink into it — instead of the zoom hard-stopping at the archipelago edge.
const OCEAN_PAD_FRACTION = 0.9;

const DEBUG = import.meta.env.DEV;

// King Bob counts as WORKING while his session's lastUpdate is fresher than this — i.e. his
// parent agent's tool calls are still landing. Once it goes stale he's IDLE and free to roam.
const KING_BOB_WORKING_MS = 12000;

// Animation states that already represent "doing work" — moveKingBobToWorkspace() won't
// override these with its idle-at-desk default; they're driven by updateToolAnimation()
// instead (see AgentCharacter.updateToolAnimation()).
const KING_BOB_WORKING_ANIM_STATES = new Set(['typing', 'reading', 'thinking']);

/**
 * @class KingdomScene
 * @extends Phaser.Scene
 *
 * Session-island Kingdom Dashboard.
 *
 * Each Claude Code **session** is drawn as its own **island** (labelled "Session 1", "Session 2", …)
 * floating on water and connected to its neighbours by bridges. Within a session, agents working
 * on the same task (same `taskId`) form a **cluster**, and each cluster is a workspace building on
 * that session's island — the building's label shows what the cluster is doing. Every session has
 * its own gold **King Bob** that roams its island.
 *
 * **Depth layers:**
 * - -10: Water background
 * -  -9: Island landmasses (water-shadow + cliff faces + sand/grass) + bridges
 * -  -7: Ground clutter decor (grass tufts, flowers, rocks — not y-sorted)
 * -  -6: Cluster boundary outlines
 * -   ~0+: SHARED y-sorted band for buildings, trees, King Bob's throne marker AND agents/King
 *        Bobs alike (depth = depthForY(y), painter's-algorithm overlap by screen position).
 *        Agents and static scenery live on the SAME scale on purpose: an agent whose feet are
 *        ABOVE a building's centre (smaller y) draws behind it; below the centre (larger y) it
 *        draws in front. That interleaving is the pseudo-3D effect — an agent walks behind the
 *        top half of a house and pops out in front of the bottom half.
 * -  100000: Session labels / tooltips (always on top, including above agents)
 */
class KingdomScene extends Phaser.Scene {
  // The full pool of real house cutouts (5 architectures × front/side/back). Buildings are drawn
  // by picking one of these at random — stable per cluster/session so they never flicker.
  static HOUSE_KEYS = [
    'cottage-front', 'cottage-side', 'cottage-back',
    'manor-front', 'manor-side', 'manor-back',
    'craftsman-front', 'craftsman-side', 'craftsman-back',
    'aframe-front', 'aframe-side', 'aframe-back',
    'amsterdam-front', 'amsterdam-side', 'amsterdam-back'
  ];

  constructor() {
    super({ key: 'KingdomScene' });
    this.agents = new Map();            // agentId -> AgentCharacter
    this.islands = [];                  // last computed island geometry
    this.sessionIndex = new Map();      // sessionId -> stable 1-based number (for "Session N")
    this.sessionLabelObjs = new Map();  // sessionId -> Phaser.Text
    this.clusterBuildingObjs = new Map(); // "sessionId::taskId" -> { container, label }
    this.kingBobThroneObjs = new Map();   // sessionId -> { container } (King Bob's dedicated workspace marker)
    this.islandDecor = new Map();       // sessionId -> { container, trees, radius } (container: rocks/flowers/tufts; trees: standalone y-sorted objects)
    this.waterObjs = [];                // water background + animated shimmer sprites
    this.oceanTile = null;              // repeating wave TileSprite, scrolled each frame in update()
    this.lastWakePos = null;            // last pointer world pos, for drag-wake direction
    this.waterWidth = 0;                // world width the water was last sized to
    this.waterHeight = 0;               // world height the water was last sized to
    this.islandGfx = null;
    this.clusterBoundaryGfx = null;     // animated squiggly boundaries drawn around each cluster
    this.cameraController = null;       // mouse-wheel zoom + click-drag pan
    this.worldWidth = 0;                // latest archipelago extent from computeIslandLayout()
    this.worldHeight = 0;
  }

  preload() {
    for (let i = 0; i < 6; i++) {
      this.load.spritesheet(`char_${i}`, `/sprites/char_${i}.png`, {
        frameWidth: 16,
        frameHeight: 32
      });
    }

    // Workspace buildings — the actual downloaded house renders (cut out + background removed),
    // served from public/buildings. Five architectures × 3 views each = the random-assignment pool.
    // Every agent (and King Bob) is given one of these at random, seeded stably per cluster/session.
    KingdomScene.HOUSE_KEYS.forEach(name => this.load.image(`house-${name}`, `/buildings/${name}.png`));

    // Ocean skin — a seamless water tile the user downloaded; repeated across the whole backdrop.
    this.load.image('ocean-tile', '/textures/ocean.jpeg');

    this.load.on('loaderror', (fileObj) => {
      console.error('❌ Failed to load:', fileObj.key, fileObj.url);
    });
  }

  create() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.cameras.main.setSize(width, height);

    this.createCharacterAnimations();
    this.createWaterBackground();

    // Water drag wake: curved crest waves that peel off along the cursor's direction of travel,
    // as if the pointer is dragging through the sea. Throttled so a fast mouse leaves a trail.
    this.input.on('pointermove', (pointer) => this.spawnHoverWake(pointer));

    // Island landmasses + bridges are redrawn into this single graphics object each layout change.
    this.islandGfx = this.add.graphics();
    this.islandGfx.setDepth(-9);

    // Cluster boundaries are redrawn every frame (they wobble + blink), sitting on the ground
    // above decoration but below buildings and agents.
    this.clusterBoundaryGfx = this.add.graphics();
    this.clusterBoundaryGfx.setDepth(-6);

    this.layoutManager = new LayoutManager(width, height);

    this.cameras.main.scrollX = 0;
    this.cameras.main.scrollY = 0;

    // Game-style camera: mouse-wheel zoom toward cursor + left-click-drag pan. Bounds are set to
    // the padded OCEAN rect (archipelago + open sea, see oceanRect()) below and re-set every
    // rebuildIslands() call. The low absolute floor lets the dynamic "fit the padded sea" zoom
    // become the real limit, so the user can zoom out to reveal the surrounding ocean.
    this.cameraController = new CameraController(this, { minZoom: 0.12, maxZoom: 2.5 });
    this.cameraController.setBounds(0, 0, width, height);

    this.scale.on('resize', this.handleResize, this);

    if (DEBUG) console.log('🏝️ Kingdom Scene initialized - scattered session islands');
  }

  handleResize(gameSize) {
    const width = gameSize.width;
    const height = gameSize.height;

    this.cameras.main.setSize(width, height);

    if (this.layoutManager) {
      this.layoutManager.width = width;
      this.layoutManager.height = height;
    }

    // Recomputing the layout at the new viewport size also resizes the water to the (possibly
    // changed) world extent and re-syncs camera bounds — see rebuildIslands().
    this.rebuildIslands();
  }

  /**
   * Tears down the water background and its animated shimmer sprites/tweens.
   * @private
   */
  destroyWater() {
    this.waterObjs.forEach(obj => {
      if (obj) {
        this.tweens.killTweensOf(obj);
        obj.destroy();
      }
    });
    this.waterObjs = [];
    this.oceanTile = null;
  }

  /**
   * Spawns a curved crest "wake" oriented along the cursor's direction of travel, as if the pointer
   * is dragging through the water — the convex crest bows in the direction of motion, then drifts
   * backward, stretches sideways, and fades, leaving a trailing wake. Only fires on real movement
   * (skips tiny jitter) and is throttled so a fast mouse draws a continuous trail, not a swarm.
   * Sits just above the water, below the islands.
   *
   * @param {Phaser.Input.Pointer} pointer
   * @private
   */
  spawnHoverWake(pointer) {
    if (!this.oceanTile) return; // no sea → nothing to drag
    const x = pointer.worldX, y = pointer.worldY;
    const prev = this.lastWakePos;
    this.lastWakePos = { x, y };
    if (!prev) return;

    const dx = x - prev.x, dy = y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 3) return; // ignore idle jitter — a wake only forms when you actually drag

    const now = this.time.now;
    if (now - (this.lastWakeAt || 0) < 32) return;
    this.lastWakeAt = now;

    const angle = Math.atan2(dy, dx);
    // A ~120°-wide arc opening toward travel = a bow-wave crest. Stroke only (no chord line).
    const crest = this.add.arc(x, y, 11, -60, 60, false, 0xffffff, 0);
    crest.setClosePath(false);
    crest.setStrokeStyle(2, 0xf2fbff, 0.5);
    crest.setRotation(angle);
    crest.setDepth(-9.5);
    crest.setScale(0.35);
    this.tweens.add({
      targets: crest,
      // drift backward along the drag while spreading sideways → a peeling wake
      x: x - Math.cos(angle) * 14,
      y: y - Math.sin(angle) * 14,
      scaleX: 1.5,
      scaleY: 1.05,
      alpha: 0,
      duration: 560,
      ease: 'Quad.easeOut',
      onComplete: () => crest.destroy()
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // BACKGROUND - Water (islands sit on top)
  // ═══════════════════════════════════════════════════════════════

  /**
   * (Re)creates the water backdrop to fill EXACTLY the world rect (0,0,worldWidth,worldHeight),
   * not just the current viewport. Falls back to the current viewport size when no world size
   * is known yet (first paint, before any session has been laid out). Combined with
   * CameraController's zoom-to-fit floor, this means zooming out never reveals grey canvas.
   *
   * @param {number} [worldWidth] - width of the (padded ocean) rect to cover
   * @param {number} [worldHeight] - height of the (padded ocean) rect to cover
   * @param {number} [originX=0] - top-left x of the rect (negative for the padded sea)
   * @param {number} [originY=0] - top-left y of the rect (negative for the padded sea)
   */
  createWaterBackground(worldWidth, worldHeight, originX = 0, originY = 0) {
    const width = worldWidth || this.cameras.main.width;
    const height = worldHeight || this.cameras.main.height;

    // 1. Ocean floor: the downloaded water tile, repeated across the ENTIRE world rect to form a
    //    field of waves. A single TileSprite wraps its texture in one draw call; because the source
    //    art is large (~2816px) we shrink it via tileScale so it repeats many times (~WAVE_TILE_PX
    //    per tile) instead of one giant stretched picture. tilePosition is then drifted every frame
    //    in update() for gentle water motion. Falls back to a gradient sea if the texture is missing.
    if (this.textures.exists('ocean-tile')) {
      const ocean = this.add.tileSprite(originX, originY, width, height, 'ocean-tile');
      ocean.setOrigin(0, 0);
      ocean.setDepth(-10);
      const WAVE_TILE_PX = 200; // on-screen size of one repeat of the wave tile (smaller = more tiles)
      const srcW = ocean.texture.getSourceImage().width || 1;
      ocean.tileScaleX = ocean.tileScaleY = WAVE_TILE_PX / srcW;
      // Multiply tint to darken the (very bright) cyan art into a calmer, deeper sea.
      ocean.setTint(0x8fabbf);
      this.oceanTile = ocean;
      this.waterObjs.push(ocean);
    } else {
      const g = this.add.graphics();
      const deep = Phaser.Display.Color.ValueToColor(0x2f5d78);   // deep water
      const shallow = Phaser.Display.Color.ValueToColor(0x7fb4c4); // sunlit shallows
      const bands = 48;
      for (let i = 0; i < bands; i++) {
        const t = i / (bands - 1);
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(deep, shallow, 1, t);
        g.fillStyle(Phaser.Display.Color.GetColor(c.r, c.g, c.b), 1);
        g.fillRect(originX, originY + Math.floor((1 - t) * height) - 2, width, Math.ceil(height / bands) + 4);
      }
      g.setDepth(-10);
      this.waterObjs.push(g);
    }

    // 2. Static wave crests for texture (soft horizontal dashes).
    const crests = this.add.graphics();
    crests.setDepth(-9.9);
    crests.fillStyle(0xbfe0e8, 0.18);
    for (let i = 0; i < 220; i++) {
      const x = originX + Math.random() * width;
      const y = originY + Math.random() * height;
      const w = 6 + Math.random() * 14;
      crests.fillRoundedRect(x, y, w, 2, 1);
    }
    this.waterObjs.push(crests);

    // 3. Drifting sunlight shimmer — a handful of soft highlights that slide + pulse,
    //    giving the sea gentle motion without per-frame allocation.
    const shimmerCount = Math.min(26, Math.floor((width * height) / 90000));
    for (let i = 0; i < shimmerCount; i++) {
      const x = originX + Math.random() * width;
      const y = originY + Math.random() * height;
      const spark = this.add.ellipse(x, y, 26 + Math.random() * 30, 4 + Math.random() * 4, 0xdff2f6, 0.14);
      spark.setDepth(-9.8);
      this.waterObjs.push(spark);

      this.tweens.add({
        targets: spark,
        x: x + (Math.random() * 60 - 30),
        alpha: { from: 0.05, to: 0.22 },
        scaleX: { from: 0.8, to: 1.2 },
        duration: 2600 + Math.random() * 2600,
        yoyo: true,
        repeat: -1,
        delay: Math.random() * 2000,
        ease: 'Sine.easeInOut'
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ISLAND RENDERING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Recomputes the whole island layout from the current agents and syncs all visuals.
   * Called after any agent add/remove/update so islands grow, shrink, and relabel live.
   *
   * computeIslandLayout() now returns { islands, bridges, worldWidth, worldHeight } — islands
   * are pre-scattered (non-overlapping, random cx/cy) rather than a horizontal chain, and
   * bridges/roads are separate arrays. Missing/empty bridges or roads render nothing (defensive).
   */
  rebuildIslands() {
    const sessions = this.buildSessionModel();
    const { width, height } = this.cameras.main;
    const layout = computeIslandLayout(sessions, width, height) || {};

    const islands = Array.isArray(layout.islands) ? layout.islands : [];
    const bridges = Array.isArray(layout.bridges) ? layout.bridges : [];
    const worldWidth = layout.worldWidth || width;
    const worldHeight = layout.worldHeight || height;

    this.islands = islands;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;

    // Water fills the padded ocean rect (archipelago + open sea); only rebuild it when the world
    // actually resized (rebuildIslands runs on every ~1s poll, so this avoids needless churn).
    this.resizeWaterToWorld(worldWidth, worldHeight);

    this.syncIslandVisuals(islands, bridges);
    this.assignAgentsToIslands(islands);

    // Bounds == the padded ocean rect (see oceanRect) so CameraController's zoom-to-fit floor is
    // "fit the whole sea", letting the user zoom out well past the islands to reveal open ocean.
    if (this.cameraController) {
      const sea = this.oceanRect(worldWidth, worldHeight);
      this.cameraController.setBounds(sea.x, sea.y, sea.w, sea.h);
    }
  }

  /**
   * The padded open-sea rect surrounding the archipelago. The islands occupy (0,0,worldW,worldH);
   * this expands that by OCEAN_PAD_FRACTION of the larger dimension on every side (so the origin
   * goes negative), giving the water + camera bounds room for the user to zoom out into ocean.
   *
   * @param {number} worldWidth
   * @param {number} worldHeight
   * @returns {{x:number,y:number,w:number,h:number}}
   * @private
   */
  oceanRect(worldWidth, worldHeight) {
    const pad = Math.round(Math.max(worldWidth, worldHeight) * OCEAN_PAD_FRACTION);
    return { x: -pad, y: -pad, w: worldWidth + pad * 2, h: worldHeight + pad * 2 };
  }

  /**
   * Recreates the water backdrop only when the world extent actually changed size.
   *
   * @param {number} worldWidth
   * @param {number} worldHeight
   * @private
   */
  resizeWaterToWorld(worldWidth, worldHeight) {
    if (this.waterObjs.length && this.waterWidth === worldWidth && this.waterHeight === worldHeight) {
      return;
    }
    this.destroyWater();
    const sea = this.oceanRect(worldWidth, worldHeight);
    this.createWaterBackground(sea.w, sea.h, sea.x, sea.y);
    this.waterWidth = worldWidth;
    this.waterHeight = worldHeight;
  }

  /**
   * Draws island landmasses + roads, and creates/updates/removes per-cluster workspace
   * buildings and per-session labels. Buildings and labels are kept in Maps (keyed by
   * cluster / session) so they update smoothly instead of flickering on every rebuild.
   *
   * @param {Array<Object>} islands - Geometry from computeIslandLayout()
   * @param {Array<Array<{x:number,y:number}>>} [bridges] - Inter-island connectors
   */
  syncIslandVisuals(islands, bridges = []) {
    const g = this.islandGfx;
    g.clear();

    // Bridges first, so island shores overlap the bridge ends. Defensive: render nothing if
    // the layout has no bridges (e.g. a single island).
    if (Array.isArray(bridges)) {
      bridges.forEach(bridge => {
        if (Array.isArray(bridge) && bridge.length === 2 && bridge[0] && bridge[1]) {
          this.drawBridge(g, bridge[0], bridge[1]);
        }
      });
    }

    // Island landmasses — organic (non-circular) blobs, a different gentle shape per session.
    // All layers share the island's shape factors so the shore/grass rings nest cleanly.
    islands.forEach(island => {
      const factors = this.islandShapeFactors(island.sessionId);
      const layer = (radius) => this.islandOutline(island.cx, island.cy, radius, factors);

      // Soft shadow cast on the water beneath the island, so it reads as floating/raised
      // rather than flush with the sea. Stable per-session offset (no per-frame jitter).
      const shadowRand = this.seededRandom(this.hashString(island.sessionId) ^ 0x1c3b6e91);
      const shadowOffset = 10 + shadowRand() * 6; // ~10-16px
      const shadowPts = this.islandOutline(island.cx, island.cy + shadowOffset, island.radius + 16, factors);
      g.fillStyle(0x05141f, 0.15);
      g.fillPoints(shadowPts, true);

      // Cliff face: a darker earth-tone copy of the outline shifted down, drawn BEHIND the
      // sand/grass layers so only a thin raised "wall" peeks out below the island.
      const cliffRand = this.seededRandom(this.hashString(island.sessionId) ^ 0x7f4a2c15);
      const cliffOffset = 14 + cliffRand() * 8; // 14-22px
      const cliffColor = cliffRand() > 0.5 ? 0x5c5038 : 0x6b5d42;
      const cliffPts = this.islandOutline(island.cx, island.cy + cliffOffset, island.radius + 6, factors);
      g.fillStyle(cliffColor, 1);
      g.fillPoints(cliffPts, true);

      g.fillStyle(0xeaf6f7, 0.6);                     // white foam surf
      g.fillPoints(layer(island.radius + 20), true);
      g.fillStyle(0xd8c8a0, 1);                       // sandy shore
      g.fillPoints(layer(island.radius + 12), true);
      g.fillStyle(0xc9b587, 1);                       // darker sand rim
      g.fillPoints(layer(island.radius + 4), true);
      g.fillStyle(0x7fa07e, 1);                       // grass (darker base)
      g.fillPoints(layer(island.radius), true);
      g.fillStyle(0x8fa88e, 1);                       // mid grass
      g.fillPoints(layer(island.radius * 0.86), true);
      g.fillStyle(0x9fb89e, 0.5);                     // lighter inner clearing
      g.fillPoints(layer(island.radius * 0.62), true);

      // Roads connecting workspace buildings on this island (hub-and-spoke from A's layout).
      // Drawn on the ground, above grass but on the same low depth layer as the landmass —
      // buildings/sprites (y-sorted band, depth >= 1) always draw above them.
      if (Array.isArray(island.roads)) {
        island.roads.forEach(path => this.drawRoad(g, path));
      }
    });

    // Session labels + cluster buildings (managed, not recreated each frame).
    const seenSessions = new Set();
    const seenClusters = new Set();

    islands.forEach(island => {
      seenSessions.add(island.sessionId);

      // Trees, rocks, and wildflowers — stable per island (regenerated only on radius change).
      this.syncIslandDecor(island);

      let label = this.sessionLabelObjs.get(island.sessionId);
      if (!label) {
        label = this.add.text(0, 0, island.label, {
          fontSize: '15px',
          fontFamily: 'DM Sans',
          fontStyle: 'bold',
          color: '#2d1f0f',
          backgroundColor: 'rgba(255, 215, 0, 0.92)',
          padding: { x: 10, y: 4 }
        });
        label.setOrigin(0.5);
        label.setDepth(SESSION_LABEL_DEPTH);
        this.sessionLabelObjs.set(island.sessionId, label);
      }
      label.setText(island.label);
      label.setPosition(island.cx, island.cy - island.radius - 20);

      island.clusters.forEach(cluster => {
        const key = `${island.sessionId}::${cluster.taskId}`;
        seenClusters.add(key);

        let obj = this.clusterBuildingObjs.get(key);
        if (!obj) {
          obj = this.createClusterBuilding(cluster.x, cluster.y, key);
          this.clusterBuildingObjs.set(key, obj);
        }
        obj.container.setPosition(cluster.x, cluster.y);
        // Y-sorted depth so agents/trees can correctly draw in front of or behind the building.
        obj.container.setDepth(this.depthForY(cluster.y));
        // Building label reflects what the cluster is doing.
        obj.label.setText(this.truncate(cluster.description || 'Working…', 26));
      });
    });

    // Remove visuals for sessions/clusters that no longer exist.
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
    for (const [sessionId, decor] of this.islandDecor) {
      if (!seenSessions.has(sessionId)) {
        decor.container.destroy();
        decor.trees.forEach(tree => tree.obj.destroy());
        this.islandDecor.delete(sessionId);
      }
    }
  }

  /**
   * Creates or repositions an island's decoration (grass tufts, trees, rocks, wildflowers).
   * Placement is deterministic (seeded by session id) so foliage never jumps between polls;
   * it is only regenerated when the island's radius changes (cluster count grew/shrank).
   *
   * @param {Object} island - Geometry entry from computeIslandLayout()
   * @private
   */
  syncIslandDecor(island) {
    let decor = this.islandDecor.get(island.sessionId);

    // Regenerate only when missing or the island resized.
    if (!decor || Math.abs(decor.radius - island.radius) > 1) {
      if (decor) {
        decor.container.destroy();
        decor.trees.forEach(tree => tree.obj.destroy());
      }
      const { container, trees } = this.buildIslandDecor(island);
      decor = { container, trees, radius: island.radius };
      this.islandDecor.set(island.sessionId, decor);
    }

    // Ground clutter (tufts/flowers/rocks) is drawn relative to (0,0); just move the
    // container onto the island. This also re-syncs position if the island's chain shifted
    // (e.g. a session added elsewhere) without a radius change/regeneration.
    decor.container.setPosition(island.cx, island.cy);

    // Trees are standalone top-level objects (so they can be y-depth-sorted against
    // buildings/agents); reposition them from their stored island-relative offsets.
    decor.trees.forEach(tree => {
      tree.obj.setPosition(island.cx + tree.relX, island.cy + tree.relY);
    });
  }

  /**
   * Builds a decoration container (relative to island center 0,0) with grass tufts,
   * trees near the shore, scattered rocks, and wildflowers.
   *
   * @param {Object} island
   * @returns {{ container: Phaser.GameObjects.Container, trees: Array<{obj: Phaser.GameObjects.Container, relX: number, relY: number}> }}
   * @private
   */
  buildIslandDecor(island) {
    const container = this.add.container(0, 0);
    container.setDepth(-7); // ground clutter: above grass (-9), below buildings/trees/agents

    const rand = this.seededRandom(this.hashString(island.sessionId));
    const R = island.radius;

    // Scale decoration counts with island size.
    const scale = R / 160;
    const treeCount = Math.round(4 + rand() * 3 * scale);
    const rockCount = Math.round(2 + rand() * 3 * scale);
    const flowerCount = Math.round(10 + rand() * 12 * scale);
    const tuftCount = Math.round(14 + rand() * 14 * scale);

    // Random point inside an annulus [innerFrac, outerFrac] of the island.
    const pointAt = (innerFrac, outerFrac) => {
      const angle = rand() * Math.PI * 2;
      const r = R * (innerFrac + rand() * (outerFrac - innerFrac));
      return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    };

    // Grass tufts scattered across the interior.
    const tuftColors = [0x7fa07e, 0x85a584, 0x9fb89e];
    for (let i = 0; i < tuftCount; i++) {
      const p = pointAt(0.1, 0.82);
      const blade = this.add.ellipse(p.x, p.y, 6 + rand() * 5, 3 + rand() * 3,
        tuftColors[Math.floor(rand() * tuftColors.length)], 0.7);
      container.add(blade);
    }

    // Wildflowers — tiny colored dots with a pale center.
    const petalColors = [0xe8a0b0, 0xf0d060, 0xb0a0e0, 0xe89060, 0xf5f1e8];
    for (let i = 0; i < flowerCount; i++) {
      const p = pointAt(0.12, 0.8);
      const petal = this.add.circle(p.x, p.y, 2.4, petalColors[Math.floor(rand() * petalColors.length)], 0.95);
      container.add(petal);
    }

    // Rocks — grey rounded stones with a highlight.
    for (let i = 0; i < rockCount; i++) {
      const p = pointAt(0.2, 0.78);
      const rock = this.add.ellipse(p.x, p.y, 12 + rand() * 10, 8 + rand() * 6, 0x8b8b86, 1);
      const shine = this.add.ellipse(p.x - 2, p.y - 2, 5, 3, 0xb0b0aa, 0.8);
      container.add(rock);
      container.add(shine);
    }

    // Trees near the shoreline (outer band) so the interior stays clear for buildings/agents.
    // Built as standalone top-level objects (not container children) so each can be
    // depth-sorted by its own world y against buildings and agents (see updateTreeDepthSorting).
    const trees = [];
    for (let i = 0; i < treeCount; i++) {
      const p = pointAt(0.68, 0.9);
      const tree = this.buildTree(island.cx + p.x, island.cy + p.y, 0.85 + rand() * 0.4);
      tree.setDepth(this.depthForY(tree.y));
      trees.push({ obj: tree, relX: p.x, relY: p.y });
    }

    return { container, trees };
  }

  /**
   * Builds one tree as a small container: trunk + layered foliage blobs.
   *
   * @param {number} x - Local x within the island container
   * @param {number} y - Local y
   * @param {number} scale
   * @returns {Phaser.GameObjects.Container}
   * @private
   */
  buildTree(x, y, scale) {
    const t = this.add.container(x, y);

    const shadow = this.add.ellipse(0, 6, 26 * scale, 10 * scale, 0x000000, 0.12);
    t.add(shadow);

    const trunk = this.add.rectangle(0, 0, 6 * scale, 16 * scale, 0x8a5a34);
    trunk.setOrigin(0.5, 1);
    t.add(trunk);

    // Three overlapping foliage blobs for a soft canopy.
    const foliageDark = 0x5f7d54;
    const foliageMid = 0x6f8d5f;
    const foliageLight = 0x8aa878;
    t.add(this.add.circle(-8 * scale, -18 * scale, 12 * scale, foliageDark));
    t.add(this.add.circle(8 * scale, -18 * scale, 12 * scale, foliageMid));
    t.add(this.add.circle(0, -26 * scale, 14 * scale, foliageLight));
    t.add(this.add.circle(-3 * scale, -22 * scale, 6 * scale, 0x9fb88a, 0.7)); // highlight

    return t;
  }

  /**
   * Deterministic PRNG (mulberry32) seeded by an integer — same seed, same sequence,
   * so an island's foliage layout is stable across rebuilds.
   *
   * @param {number} seed
   * @returns {() => number} Function returning floats in [0, 1)
   * @private
   */
  seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Returns a stable array of radius multipliers describing one session-island's organic
   * outline. Built from three low harmonics with seeded phases/amplitudes, so the shape is
   * smooth (gentle curves, not spikes), unique per session, and identical across rebuilds.
   *
   * @param {string} sessionId
   * @param {number} [segments=40]
   * @returns {number[]} Per-segment radius factors (~0.9–1.1)
   * @private
   */
  islandShapeFactors(sessionId, segments = 40) {
    const rand = this.seededRandom(this.hashString(sessionId) ^ 0x9e3779b1);
    const p1 = rand() * Math.PI * 2;
    const p2 = rand() * Math.PI * 2;
    const p3 = rand() * Math.PI * 2;
    const a1 = 0.05 + rand() * 0.04; // primary lobe
    const a2 = 0.03 + rand() * 0.03;
    const a3 = 0.015 + rand() * 0.02;

    const factors = new Array(segments);
    for (let i = 0; i < segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      factors[i] =
        1 +
        a1 * Math.sin(ang + p1) +
        a2 * Math.sin(2 * ang + p2) +
        a3 * Math.sin(3 * ang + p3);
    }
    return factors;
  }

  /**
   * Turns a set of radius factors into world-space outline points at the given radius.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number[]} factors
   * @returns {Array<{x:number,y:number}>}
   * @private
   */
  islandOutline(cx, cy, radius, factors) {
    const n = factors.length;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const r = radius * factors[i];
      pts[i] = { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
    }
    return pts;
  }

  /**
   * Draws one wooden bridge segment between two arbitrary world points (from the layout's
   * `bridges` array — nearest-neighbor connectors between scattered islands, generally at any
   * angle, not just horizontal). Renders as a rotated wooden-plank rectangle with perpendicular
   * plank ticks along its length.
   *
   * @param {Phaser.GameObjects.Graphics} g
   * @param {{x:number,y:number}} p1
   * @param {{x:number,y:number}} p2
   * @private
   */
  drawBridge(g, p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;

    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy; // unit normal (perpendicular to the bridge direction)
    const ny = ux;
    const halfW = 11;

    // A point `along` the bridge axis and `across` (offset along the normal).
    const corner = (along, across) => ({
      x: p1.x + ux * along + nx * across,
      y: p1.y + uy * along + ny * across
    });

    g.fillStyle(0x8a6a44, 1);
    g.fillPoints(
      [corner(0, halfW), corner(len, halfW), corner(len, -halfW), corner(0, -halfW)],
      true
    );
    g.fillStyle(0xa5824f, 1);
    const innerW = halfW - 3;
    g.fillPoints(
      [corner(0, innerW), corner(len, innerW), corner(len, -innerW), corner(0, -innerW)],
      true
    );

    g.lineStyle(2, 0x6b4f30, 0.7);
    for (let d = 6; d < len; d += 11) {
      const a = corner(d, halfW);
      const b = corner(d, -halfW);
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
  }

  /**
   * Draws one road polyline (from an island's `roads` array — hub-and-spoke paths connecting
   * workspace buildings) as a wide muted ground path with a lighter center stripe, on top of
   * the grass but below buildings/sprites (which live in the y-sorted depth band, >= 1).
   *
   * @param {Phaser.GameObjects.Graphics} g
   * @param {Array<{x:number,y:number}>} path
   * @private
   */
  drawRoad(g, path) {
    if (!Array.isArray(path) || path.length < 2) return;

    g.lineStyle(16, 0x9a8868, 0.5);
    for (let i = 0; i < path.length - 1; i++) {
      g.lineBetween(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
    }
    g.lineStyle(5, 0xd8c8a0, 0.55);
    for (let i = 0; i < path.length - 1; i++) {
      g.lineBetween(path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
    }
  }

  /**
   * Creates a workspace building container for a cluster. The label text is set by the caller
   * to the cluster's task description.
   *
   * @param {number} x
   * @param {number} y
   * @param {string} seed - Stable per-cluster string (sessionId::taskId) used to pick its house
   * @returns {{ container: Phaser.GameObjects.Container, label: Phaser.GameObjects.Text }}
   */
  createClusterBuilding(x, y, seed) {
    const container = this.add.container(x, y);

    // Real downloaded house render (background removed). Normalise by height so every house
    // shows at the same on-screen size regardless of its source crop, and small enough to sit
    // comfortably inside the island footprint. The render carries its own grass base + shadow.
    const sprite = this.add.sprite(0, 0, this.houseTextureForSeed(seed));
    const TARGET_H = 56;
    sprite.setScale(TARGET_H / sprite.height);
    container.add(sprite);

    const label = this.add.text(0, -54, '', {
      fontSize: '11px',
      fontFamily: 'DM Sans',
      color: '#2d2420',
      backgroundColor: 'rgba(245, 241, 232, 0.95)',
      padding: { x: 6, y: 3 },
      align: 'center',
      wordWrap: { width: 170 }
    });
    label.setOrigin(0.5);
    container.add(label);

    container.setDepth(-5);
    return { container, label };
  }

  /**
   * Randomly (but stably) picks one of the real downloaded house cutouts for a workspace. Seeding
   * by the cluster/session string means each building gets a fixed house that never flickers between
   * frames, while spreading evenly across all five architectures and their three viewing angles.
   * @param {string} seed - any stable string unique to the cluster/session
   * @returns {string} texture key ("house-…")
   */
  houseTextureForSeed(seed) {
    const keys = KingdomScene.HOUSE_KEYS;
    return `house-${keys[this.hashString(seed || '') % keys.length]}`;
  }

  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  truncate(str, max) {
    if (!str) return '';
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION MODEL (agents -> sessions -> clusters)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Groups the current agents into the session model consumed by computeIslandLayout():
   * one entry per session, each with its task clusters and its King Bob(s).
   *
   * @returns {Array<Object>} Ordered sessions (stable left-to-right by first-seen order)
   */
  buildSessionModel() {
    const sessions = new Map();

    this.agents.forEach(agent => {
      const sessionId = agent.session || 'unknown';
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { sessionId, cwd: null, clusters: new Map(), kingBobs: [] });
      }
      const session = sessions.get(sessionId);
      // Remember the session's working dir (any agent carries it) to name the island.
      if (!session.cwd && agent.cwd) session.cwd = agent.cwd;

      if (agent.isKingBob) {
        session.kingBobs.push(agent);
        return;
      }

      const taskId = agent.taskId || `${sessionId}_default`;
      if (!session.clusters.has(taskId)) {
        session.clusters.set(taskId, { taskId, description: agent.taskDescription || '', agents: [] });
      }
      const cluster = session.clusters.get(taskId);
      cluster.agents.push(agent);
      if (agent.taskDescription) cluster.description = agent.taskDescription;
    });

    const result = [...sessions.values()].map(session => ({
      sessionId: session.sessionId,
      label: this.getSessionLabel(session.sessionId, session.cwd),
      kingBobs: session.kingBobs,
      clusters: [...session.clusters.values()]
    }));

    // Stable left-to-right ordering by the session's assigned number.
    result.sort((a, b) => this.sessionIndex.get(a.sessionId) - this.sessionIndex.get(b.sessionId));
    return result;
  }

  /**
   * Returns a friendly island name for a session. Prefers the basename of the session's working
   * directory (e.g. "claude-kingdom-dashboard") so each island is labelled by its project. Falls
   * back to a stable "Session N" (numbered on first sight) when no cwd is known.
   *
   * @param {string} sessionId
   * @param {string|null} [cwd] - The session's working directory, if reported by the feed.
   */
  getSessionLabel(sessionId, cwd = null) {
    if (!this.sessionIndex.has(sessionId)) {
      this.sessionIndex.set(sessionId, this.sessionIndex.size + 1);
    }
    if (cwd) {
      const name = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
      if (name) return name;
    }
    return `Session ${this.sessionIndex.get(sessionId)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // AGENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  updateAgents(agentsData) {
    if (!Array.isArray(agentsData)) {
      console.error('❌ updateAgents: agentsData is not an array:', agentsData);
      return;
    }

    const currentIds = new Set(agentsData.map(a => a.id));

    // Remove agents that no longer exist.
    this.agents.forEach((character, id) => {
      if (!currentIds.has(id)) {
        character.destroy();
        this.agents.delete(id);
        if (DEBUG) console.log('🗑️ Removed agent:', id);
      }
    });

    // Update or create agents.
    agentsData.forEach(agentData => {
      const existing = this.agents.get(agentData.id);
      if (existing) {
        existing.updateState(agentData);
      } else {
        const character = new AgentCharacter(this, agentData);
        // Placed onto its island on the next rebuild rather than drifting in from (0,0).
        character.justSpawned = true;
        this.agents.set(agentData.id, character);
        if (DEBUG) console.log('✨ Spawned agent:', agentData.id);
      }
    });

    this.rebuildIslands();
  }

  /**
   * Places every agent on its session's island: cluster members ring their building, and each
   * King Bob is anchored to roam its island. Hands the resulting workspace assignments and
   * cluster groups to the LayoutManager.
   *
   * @param {Array<Object>} islands - Geometry from computeIslandLayout()
   */
  assignAgentsToIslands(islands) {
    const assignments = new Map(); // agent -> { x, y, bx, by }
    const swarms = [];             // cluster groups (for same-cluster collision spacing)
    const seenThroneSessions = new Set(); // sessions with a live King Bob this rebuild
    const obstacles = [];          // building footprints workers steer around (see LayoutManager)

    islands.forEach(island => {
      island.clusters.forEach(cluster => {
        swarms.push(cluster.agents);
        const count = cluster.agents.length;

        // Footprint circle to route walkers around this house (radius < the front-of-building
        // rest gap below, so parked workers sit just outside it and feel no avoidance force).
        obstacles.push({ x: cluster.x, y: cluster.y, r: 30 });

        // Park workers in FRONT of (below) the building, never behind it. Buildings are ~56px
        // tall and centred on cluster.y, so their base sits ~28px below centre; resting past
        // that base guarantees agent.y > cluster.y → higher depth → drawn in front (visible)
        // while working, instead of tying at the centre and disappearing behind the house.
        const BUILDING_HALF_H = 28;
        const FRONT_GAP = 12;
        const frontY = cluster.y + BUILDING_HALF_H + FRONT_GAP;

        cluster.agents.forEach((agent, idx) => {
          let offsetX = 0;
          let offsetY = 0;
          if (count > 1) {
            // Fan the cluster across the FRONT (lower) semicircle only — angle 0..π keeps every
            // member's offsetY >= 0, so nobody swings up behind the building. Radius grows with
            // member count so they don't overlap.
            const spacing = 44;
            const ringRadius = Math.max(26, (count * spacing) / (2 * Math.PI));
            const frac = count > 1 ? idx / (count - 1) : 0.5;
            const angle = frac * Math.PI;
            offsetX = Math.cos(angle) * ringRadius;
            offsetY = Math.sin(angle) * ringRadius;
          }

          const workspace = {
            x: cluster.x + offsetX,
            y: frontY + offsetY,
            bx: cluster.x,
            by: cluster.y
          };

          agent.inSwarm = true;
          agent.island = { cx: island.cx, cy: island.cy, radius: island.radius };

          if (agent.justSpawned) {
            agent.x = workspace.x;
            agent.y = workspace.y;
            agent.justSpawned = false;
          }

          assignments.set(agent, workspace);
        });
      });

      // King Bob inspects his session: he walks a circuit that visits each workspace building
      // (standing just beside it) AND several fixed interior points, so he is always moving —
      // even a one-cluster island gives him a proper loop instead of a single parking spot.
      const workspaceStops = island.clusters.map(cluster => {
        const dx = island.cx - cluster.x;
        const dy = island.cy - cluster.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Stand ~44px toward the island center from the building (beside it, not on it).
        return { x: cluster.x + (dx / len) * 44, y: cluster.y + (dy / len) * 44 };
      });

      // Four interior waypoints at fixed angles (deterministic → stable across polls).
      const roamR = island.radius * 0.34;
      const roamStops = [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75].map(a => ({
        x: island.cx + Math.cos(a) * roamR,
        y: island.cy + Math.sin(a) * roamR
      }));

      const patrolPoints = [...workspaceStops, ...roamStops];

      // King Bob's own dedicated workspace ("throne") is computed by IslandLayout as one more
      // placed node — kept clear of every cluster building by the overlap-avoidance radius
      // baked into island.radius there (see computeMinNoOverlapRadius()). We just read it.
      const throne = island.throne;

      // The throne manor is taller (TARGET_H 80) — a wider footprint for workers to route around.
      if (throne) obstacles.push({ x: throne.x, y: throne.y, r: 42 });

      const kingBobs = island.kingBobs;
      kingBobs.forEach((bob, i) => {
        bob.inSwarm = false;
        bob.island = { cx: island.cx, cy: island.cy, radius: island.radius };
        bob.patrolPoints = patrolPoints;

        // Roam-fallback center (used only when patrolPoints is empty — see pickBobPatrolTarget).
        const spreadAngle = kingBobs.length > 1 ? (2 * Math.PI * i) / kingBobs.length : 0;
        const spread = kingBobs.length > 1 ? island.radius * 0.2 : 0;
        bob.anchorX = island.cx + Math.cos(spreadAngle) * spread;
        bob.anchorY = island.cy + Math.sin(spreadAngle) * spread;

        // Park Bob just in FRONT of (below) his throne manor (TARGET_H 80 → ~40px half-height)
        // so he stands before his house rather than tying its centre depth and vanishing behind
        // it — same front-of-building rule as the workers above.
        bob.workspaceX = throne ? throne.x : bob.anchorX;
        bob.workspaceY = throne ? throne.y + 48 : bob.anchorY;

        if (bob.justSpawned) {
          bob.x = bob.workspaceX;
          bob.y = bob.workspaceY;
          bob.justSpawned = false;
        }
      });

      if (throne && kingBobs.length > 0) {
        seenThroneSessions.add(island.sessionId);
        this.syncKingBobThrone(island.sessionId, throne.x, throne.y);
      }
    });

    // Remove throne markers for sessions that no longer have a King Bob.
    for (const [sessionId, obj] of this.kingBobThroneObjs) {
      if (!seenThroneSessions.has(sessionId)) {
        obj.container.destroy();
        this.kingBobThroneObjs.delete(sessionId);
      }
    }

    if (this.layoutManager) {
      this.layoutManager.setSwarms(swarms);
      this.layoutManager.setWorkspaceAssignments(assignments);
      this.layoutManager.setBuildingObstacles(obstacles);
    }
  }

  /**
   * Creates or repositions King Bob's throne — a small gold dais + crown marking his
   * dedicated workspace spot, distinct from the worker clusters' buildings. Purely cosmetic
   * (a visual anchor for the behavior); the actual working-vs-idle decision lives in
   * updateKingBobs().
   *
   * @param {string} sessionId
   * @param {number} x
   * @param {number} y
   * @private
   */
  syncKingBobThrone(sessionId, x, y) {
    let obj = this.kingBobThroneObjs.get(sessionId);
    if (!obj) {
      const container = this.add.container(0, 0);

      // King Bob's royal house — a randomly-picked render from the same pool as the workers (seeded
      // by session so it's stable), but scaled taller than their cluster TARGET_H and topped with a
      // crown, so it clearly reigns regardless of which house he drew. The render carries its own
      // grass base + shadow, so no extra ground shadow is needed.
      const manor = this.add.sprite(0, 0, this.houseTextureForSeed(`king::${sessionId}`));
      const TARGET_H = 80;
      manor.setScale(TARGET_H / manor.height);
      container.add(manor);

      // Floating crown marks it as the throne — the visual anchor for the king's workspace.
      const crown = this.add.text(0, -(TARGET_H / 2) - 16, '👑', { fontSize: '18px' });
      crown.setOrigin(0.5);
      container.add(crown);

      obj = { container };
      this.kingBobThroneObjs.set(sessionId, obj);
    }

    obj.container.setPosition(x, y);
    // Sit just behind King Bob's own y-sorted depth so he visibly stands at/in front of the manor.
    obj.container.setDepth(this.depthForY(y) - 0.5);
  }

  /**
   * Reflects a single agent's current tool as an activity animation.
   *
   * @param {string} agentId
   * @param {string|null} tool
   */
  updateAgentTool(agentId, tool) {
    const agent = this.agents.get(agentId);
    if (agent && agent.updateToolAnimation) {
      agent.updateToolAnimation(tool);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN UPDATE LOOP
  // ═══════════════════════════════════════════════════════════════

  update(time, delta) {
    if (this.cameraController) this.cameraController.update();

    // Water motion: slowly scroll the wave tile diagonally with a gentle cross-swell wobble so the
    // sea drifts and laps instead of sitting frozen. tilePosition is in source-texture pixels.
    if (this.oceanTile) {
      const t = time / 1000;
      this.oceanTile.tilePositionX = t * 9 + Math.sin(t * 0.6) * 6;
      this.oceanTile.tilePositionY = t * 5 + Math.cos(t * 0.4) * 5;
    }

    // Counter-scale sprite/label markers against camera zoom so they hold a near-constant
    // screen size (crisp, legible) while the island landmass/water/roads/building bodies keep
    // scaling with zoom for the "world spreads apart" dolly feel.
    const zoom = this.cameras.main.zoom || 1;
    this.applyCounterScale(1 / Math.pow(zoom, 0.85));

    this.agents.forEach(agent => {
      if (agent.update) agent.update(time, delta);
    });

    this.updateKingBobs(delta);

    if (this.layoutManager) {
      this.layoutManager.update(this.agents, delta);
    }

    // Depth-sort agents/King Bobs by their final y on the SAME scale as buildings/trees/throne
    // (no lift band). Lower-on-screen (larger y) draws in front; an agent above a building's
    // centre-y draws behind it, below draws in front — the pseudo-3D interleave. Depth is based
    // on world y, independent of the counter-scale applied above.
    this.agents.forEach(agent => agent.setDepth(this.depthForY(agent.y)));
    this.updateTreeDepthSorting();

    // Draw last, using this frame's final agent positions.
    this.drawClusterBoundaries(time);
  }

  /**
   * Counter-scales agent sprites (incl. King Bobs), session name plates, and cluster-building
   * labels so they read at a near-constant screen size regardless of camera zoom — only these
   * markers counter-scale; the island landmass, water, roads, and building bodies are left
   * alone so they scale naturally with zoom (the "world spreads apart" 3D-dolly feel).
   *
   * Formula: scale = 1 / zoom^0.85 — a softened inverse (full 1/zoom felt too aggressive:
   * markers barely shrank at all when zoomed in, losing the sense of scale entirely).
   *
   * @param {number} counterScale
   * @private
   */
  applyCounterScale(counterScale) {
    this.agents.forEach(agent => agent.setScale(counterScale));
    this.sessionLabelObjs.forEach(label => label.setScale(counterScale));
    this.clusterBuildingObjs.forEach(obj => obj.label.setScale(counterScale));
  }

  /**
   * Maps a world y-coordinate to a depth value in the positive y-sorted band shared by
   * buildings, trees, and agents, so objects lower on screen draw in front of ones higher up.
   * Kept comfortably above the fixed low-depth world layers (water/islands/boundary).
   *
   * @param {number} y
   * @returns {number}
   * @private
   */
  depthForY(y) {
    return Math.max(1, y);
  }

  /**
   * Re-applies y-based depth to every standalone tree so they interleave correctly with
   * buildings and agents as they walk in front of/behind foliage.
   * @private
   */
  updateTreeDepthSorting() {
    this.islandDecor.forEach(decor => {
      if (!decor.trees) return;
      decor.trees.forEach(tree => tree.obj.setDepth(this.depthForY(tree.obj.y)));
    });
  }

  /**
   * Draws a translucent, organically-wobbling, softly-blinking outline around each cluster,
   * so a group of agents working the same task reads as one unit. King Bobs are never part of
   * a cluster, so they are never enclosed.
   *
   * The blob is a closed ring of points whose radius is modulated by two sine waves (a slow
   * breathing pulse + a faster ripple that rotates over time), giving the "squiggly" look;
   * the alpha oscillates for the blink. Everything is time-driven, so it animates on its own.
   *
   * @param {number} time - Phaser game time (ms)
   * @private
   */
  drawClusterBoundaries(time) {
    const g = this.clusterBoundaryGfx;
    if (!g) return;
    g.clear();

    // Soft pastel per-cluster hues (fill + a brighter stroke).
    const palette = [0x6fb3d0, 0xd08fb0, 0x8fce9f, 0xe0c070, 0xb0a0e0, 0xe89f7a];
    const SEGMENTS = 28;

    this.islands.forEach(island => {
      island.clusters.forEach(cluster => {
        const members = cluster.agents || [];
        if (members.length === 0) return;

        // Center on the cluster's building + members; size to enclose them all with padding.
        let sumX = cluster.x;
        let sumY = cluster.y;
        members.forEach(a => { sumX += a.x; sumY += a.y; });
        const cx = sumX / (members.length + 1);
        const cy = sumY / (members.length + 1);

        let maxR = 0;
        const consider = (x, y) => {
          const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
          if (d > maxR) maxR = d;
        };
        consider(cluster.x, cluster.y);
        members.forEach(a => consider(a.x, a.y));
        const baseR = maxR + 58; // padding so sprites/labels sit comfortably inside

        const seed = this.hashString(cluster.taskId || '') % 1000;
        const color = palette[this.hashString(cluster.taskId || '') % palette.length];

        // Build the gently-wobbling closed ring. Constant alpha (no blink); the edge itself
        // undulates slowly for a "living" outline rather than a flashing one.
        const pts = [];
        for (let i = 0; i < SEGMENTS; i++) {
          const ang = (i / SEGMENTS) * Math.PI * 2;
          const wobble =
            1 +
            0.09 * Math.sin(ang * 3 + time * 0.0011 + seed) +   // slow rotating ripple
            0.045 * Math.sin(ang * 5 - time * 0.0007 + seed);   // finer squiggle
          const r = baseR * wobble;
          pts.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
        }

        g.fillStyle(color, 0.10);
        g.fillPoints(pts, true);
        g.lineStyle(2.5, color, 0.55);
        g.strokePoints(pts, true);
      });
    });
  }

  /**
   * Drives each King Bob's working-vs-idle state machine (scene-owned, not layout physics).
   *
   * WORKING (his session polled recently — `lastUpdate` fresher than KING_BOB_WORKING_MS):
   * he walks to his own dedicated workspace (throne) and settles into the same working
   * animation regular agents use at their desk (see moveKingBobToWorkspace()).
   *
   * IDLE (session has gone stale): he roams/patrols his island, exactly as before
   * (see roamKingBob()).
   */
  updateKingBobs(delta) {
    const step = 0.9 * (delta / 16.67); // ~0.9px per 60fps frame
    const now = Date.now();

    this.agents.forEach(bob => {
      if (!bob.isKingBob || !bob.island) return;

      const age = bob.lastUpdate ? now - new Date(bob.lastUpdate).getTime() : Infinity;
      const isWorking = age < KING_BOB_WORKING_MS;

      if (isWorking && bob.workspaceX != null) {
        this.moveKingBobToWorkspace(bob, step);
      } else {
        this.roamKingBob(bob, delta, step);
      }
    });
  }

  /**
   * WORKING behavior: walk King Bob toward his throne and, once arrived, hold the same
   * working animation (typing/reading/thinking) regular agents play at their workspace —
   * that animation is driven by tool changes via updateAgentTool() -> updateToolAnimation(),
   * so here we only need to avoid stomping it and fall back to a generic "at his desk" look.
   *
   * @param {AgentCharacter} bob
   * @param {number} step - Pixels to move this frame
   * @private
   */
  moveKingBobToWorkspace(bob, step) {
    // Discard any in-progress roam target so a fresh one is picked next time he goes idle.
    bob.patrolTarget = null;

    const dx = bob.workspaceX - bob.x;
    const dy = bob.workspaceY - bob.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    const ARRIVE_RADIUS = 6;
    if (dist < ARRIVE_RADIUS) {
      if (!KING_BOB_WORKING_ANIM_STATES.has(bob.state)) {
        bob.playAnimation('typing'); // idle-at-desk default until a tool-driven animation lands
      }
      return;
    }

    const move = Math.min(dist, step);
    const dir = this.steerAroundBuildings(bob, dx, dy);
    bob.x += dir.x * move;
    bob.y += dir.y * move;
    if (bob.updateDirection) bob.updateDirection(dir.x, dir.y);
    if (bob.state !== 'walk') bob.playAnimation('walk');
  }

  /**
   * Adjusts a desired movement direction so the mover arcs AROUND any building footprint it is
   * currently inside, instead of walking straight through it (where the y-sort hides it behind
   * the house). Mirrors LayoutManager's worker avoidance for King Bob, whose movement is
   * scene-driven rather than force-based. Returns a unit-ish direction vector.
   *
   * @param {{x:number,y:number}} mover
   * @param {number} dx - desired dx toward the target
   * @param {number} dy - desired dy toward the target
   * @returns {{x:number,y:number}} adjusted (normalised) direction
   * @private
   */
  steerAroundBuildings(mover, dx, dy) {
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    let sx = dx / len;
    let sy = dy / len;

    const obstacles = this.layoutManager?.buildingObstacles;
    if (!obstacles || !obstacles.length) return { x: sx, y: sy };

    for (const b of obstacles) {
      const bx = mover.x - b.x;
      const by = mover.y - b.y;
      if (Math.abs(bx) > b.r || Math.abs(by) > b.r) continue;
      const dist = Math.sqrt(bx * bx + by * by) || 0.0001;
      if (dist >= b.r) continue;
      const strength = (b.r - dist) / b.r;

      const ux = dist > 0.001 ? bx / dist : 0;
      const uy = dist > 0.001 ? by / dist : -1;
      // Tangential, oriented toward the goal so he rounds the correct side.
      let tx = -uy;
      let ty = ux;
      if (tx * dx + ty * dy < 0) { tx = -tx; ty = -ty; }
      sx += (tx * 2.2 + ux * 1.0) * strength;
      sy += (ty * 2.2 + uy * 1.0) * strength;
    }

    const outLen = Math.sqrt(sx * sx + sy * sy) || 1;
    return { x: sx / outLen, y: sy / outLen };
  }

  /**
   * IDLE behavior: wander/patrol the island interior — unchanged from King Bob's original
   * always-roaming behavior, now only active while he's idle.
   *
   * @param {AgentCharacter} bob
   * @param {number} delta
   * @param {number} step - Pixels to move this frame
   * @private
   */
  roamKingBob(bob, delta, step) {
    if (!bob.patrolTarget) {
      bob.patrolTarget = this.pickBobPatrolTarget(bob);
      bob.patrolPause = 0;
    }

    const dx = bob.patrolTarget.x - bob.x;
    const dy = bob.patrolTarget.y - bob.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 4) {
      if (bob.state !== 'idle') bob.playAnimation('idle');
      bob.patrolPause -= delta;
      if (bob.patrolPause <= 0) {
        bob.patrolTarget = this.pickBobPatrolTarget(bob);
        bob.patrolPause = Phaser.Math.Between(700, 2200);
      }
      return;
    }

    const move = Math.min(dist, step);
    const dir = this.steerAroundBuildings(bob, dx, dy);
    bob.x += dir.x * move;
    bob.y += dir.y * move;
    if (bob.updateDirection) bob.updateDirection(dir.x, dir.y);
    if (bob.state !== 'walk') bob.playAnimation('walk');
  }

  pickBobPatrolTarget(bob) {
    // Preferred: walk the circuit of this session's workspace buildings, one at a time.
    const points = bob.patrolPoints;
    if (points && points.length > 0) {
      bob.patrolIndex = ((bob.patrolIndex ?? -1) + 1) % points.length;
      return points[bob.patrolIndex];
    }

    // Fallback (session with no clusters): random point within the island interior.
    const roamRadius = bob.island ? bob.island.radius * 0.3 : 45;
    const cx = bob.island ? bob.island.cx : bob.anchorX;
    const cy = bob.island ? bob.island.cy : bob.anchorY;
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * roamRadius;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    };
  }


  // ═══════════════════════════════════════════════════════════════
  // CHARACTER ANIMATIONS
  // ═══════════════════════════════════════════════════════════════

  createCharacterAnimations() {
    const directions = [
      { name: 'down', startFrame: 0 },
      { name: 'up', startFrame: 7 },
      { name: 'right', startFrame: 14 }
    ];

    for (let charIndex = 0; charIndex < 6; charIndex++) {
      const charKey = `char_${charIndex}`;

      directions.forEach(dir => {
        const baseFrame = dir.startFrame;

        this.anims.create({
          key: `${charKey}-walk-${dir.name}`,
          frames: [
            { key: charKey, frame: baseFrame + 1 },
            { key: charKey, frame: baseFrame + 0 },
            { key: charKey, frame: baseFrame + 1 },
            { key: charKey, frame: baseFrame + 2 }
          ],
          frameRate: 4,
          repeat: -1
        });

        this.anims.create({
          key: `${charKey}-type-${dir.name}`,
          frames: [
            { key: charKey, frame: baseFrame + 3 },
            { key: charKey, frame: baseFrame + 4 }
          ],
          frameRate: 2,
          repeat: -1
        });

        this.anims.create({
          key: `${charKey}-read-${dir.name}`,
          frames: [
            { key: charKey, frame: baseFrame + 5 },
            { key: charKey, frame: baseFrame + 6 }
          ],
          frameRate: 2,
          repeat: -1
        });

        this.anims.create({
          key: `${charKey}-idle-${dir.name}`,
          frames: [{ key: charKey, frame: baseFrame + 1 }],
          frameRate: 1
        });
      });
    }

    if (DEBUG) console.log('🎬 Character animations created');
  }
}

export default KingdomScene;
