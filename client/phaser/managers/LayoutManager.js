import SpatialGrid from './SpatialGrid.js';
import { LAYOUT_CONFIG } from '../config/constants.js';

const DEBUG = import.meta.env.DEV;

// Same-island collision spacing. Kept small so a cluster stays tight on a modest island;
// different clusters on the same island keep a little more room.
const SAME_CLUSTER_DIST = 42;
const DIFF_CLUSTER_DIST = 70;
// Keep agents just inside the island's grassy edge.
const ISLAND_EDGE_INSET = 24;

// Building avoidance — steer workers AROUND cluster buildings/thrones rather than walking through
// them (where the shared y-sort depth would hide the agent behind the house). Each obstacle is a
// soft circle; inside it we apply a strong TANGENTIAL push (oriented toward the agent's goal) so
// it arcs around the side, plus a lighter radial push outward. The tangential term dominates so a
// head-on approach becomes a detour instead of a stall. Resting front-of-building workspaces sit
// just outside these circles, so a parked worker feels no force (no re-introduced jitter).
const BUILDING_AVOID_TANGENT = 16;
const BUILDING_AVOID_RADIAL = 8;

/**
 * @class LayoutManager
 *
 * Force-directed movement for workers on the session-island map.
 *
 * Responsibilities:
 * - Walk each worker to its assigned workspace (a point beside its cluster building) and
 *   lock it there with hysteresis so it doesn't jitter.
 * - Keep same-island workers from overlapping (agent-agent repulsion, scoped to one session).
 * - Keep every worker inside its own island's shoreline.
 *
 * What it deliberately does NOT do (changed from the old castle/grid model):
 * - No building repulsion. A solo worker's workspace sits at its building, so repelling it
 *   from that same building caused a pull/push feedback loop — the "vibration" bug.
 * - No global center gravity. Workers are bound to their island, not the screen center.
 * - No A* / road waypoints. Islands are small and open; direct attraction is enough.
 *
 * King Bobs are skipped entirely here — KingdomScene.updateKingBobs drives their island roam.
 * They remain in the spatial grid so workers still avoid them.
 *
 * @property {number} width - World width in pixels
 * @property {number} height - World height in pixels
 * @property {Array<Array<Agent>>} swarms - Cluster groups (agents sharing a taskId)
 * @property {Map<Agent, {x:number,y:number,bx:number,by:number}>} workspaceAssignments
 * @property {SpatialGrid} spatialGrid - O(n) collision detection grid
 */
class LayoutManager {
  /**
   * @param {number} width - World width in pixels
   * @param {number} height - World height in pixels
   */
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.repulsionForce = LAYOUT_CONFIG.REPULSION_FORCE;
    this.swarmAttractionForce = LAYOUT_CONFIG.SWARM_ATTRACTION_FORCE;
    this.buildingAttractionForce = LAYOUT_CONFIG.BUILDING_ATTRACTION_FORCE;
    this.damping = LAYOUT_CONFIG.DAMPING;
    this.swarms = [];
    this.workspaceAssignments = new Map();
    this.buildingObstacles = []; // [{x, y, r}] cluster buildings + thrones to steer around
    this.spatialGrid = new SpatialGrid(width, height, LAYOUT_CONFIG.SPATIAL_GRID_CELL_SIZE);
  }

  /**
   * Registers a new agent with the layout system.
   *
   * @param {Agent} agent - The agent to add to the layout
   */
  addAgent(agent) {
    agent.vx = 0;
    agent.vy = 0;
    agent.inSwarm = false;
  }

  /**
   * Cleanup hook for a removed agent.
   *
   * @param {Agent} agent - The agent to remove
   */
  removeAgent(agent) {
    this.workspaceAssignments.delete(agent);
  }

  /**
   * Stores the current cluster groups (used only for same-cluster collision spacing).
   * The scene owns workspace placement now, so this no longer assigns positions itself.
   *
   * @param {Array<Array<Agent>>} swarms - Cluster groups (each shares a taskId)
   */
  setSwarms(swarms) {
    this.swarms = swarms;
  }

  /**
   * Receives the scene's per-agent workspace assignments (points beside cluster buildings).
   *
   * @param {Map<Agent, {x:number,y:number,bx:number,by:number}>} assignments
   */
  setWorkspaceAssignments(assignments) {
    this.workspaceAssignments = assignments;
  }

  /**
   * Receives the scene's building footprints (cluster buildings + King Bob thrones) that workers
   * should steer around instead of walking through.
   *
   * @param {Array<{x:number,y:number,r:number}>} obstacles
   */
  setBuildingObstacles(obstacles) {
    this.buildingObstacles = Array.isArray(obstacles) ? obstacles : [];
  }

  /**
   * Main update loop — applies forces to every worker and integrates its position.
   *
   * Force order per worker:
   * 1. Workspace lock check (hysteresis): locked workers are frozen and skipped.
   * 2. Same-island agent repulsion (spatial-grid neighbours only).
   * 3. Workspace attraction (pull toward assigned point beside the building).
   * 4. Island boundary (keep inside the shoreline).
   * Then: damping, velocity cap, integrate, hard screen clamp.
   *
   * @param {Map<string, Agent>} agentsMap - Map of agent IDs to agent instances
   * @param {number} delta - Time since last frame (ms)
   */
  update(agentsMap, delta) {
    const agents = Array.from(agentsMap.values());
    if (agents.length === 0) return;

    // Build spatial grid (King Bobs included, so workers avoid them).
    this.spatialGrid.clear();
    agents.forEach(agent => this.spatialGrid.insert(agent));

    agents.forEach(agent => {
      // King Bobs roam under scene control — no physics here.
      if (agent.isKingBob) return;

      const workspace = this.workspaceAssignments.get(agent);

      // 1. Workspace lock with hysteresis: lock at WORKSPACE_REACH, unlock past UNLOCK_RANGE.
      if (workspace) {
        const dx = agent.x - workspace.x;
        const dy = agent.y - workspace.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (!agent.atWorkspace && distance < LAYOUT_CONFIG.WORKSPACE_REACH) {
          agent.atWorkspace = true;
          agent.vx = 0;
          agent.vy = 0;
          // Settle the walk animation into idle once parked.
          if (agent.state === 'walk' && agent.playAnimation) agent.playAnimation('idle');
        } else if (agent.atWorkspace && distance > LAYOUT_CONFIG.WORKSPACE_UNLOCK_RANGE) {
          agent.atWorkspace = false;
        }

        if (agent.atWorkspace) {
          agent.vx = 0;
          agent.vy = 0;
          return; // Frozen at workspace; skip all forces.
        }
      } else {
        agent.atWorkspace = false;
      }

      let ax = 0;
      let ay = 0;

      // 2. Repulsion from OTHER agents on the same island only.
      const nearbyAgents = this.spatialGrid.getNearbyAgents(agent);
      nearbyAgents.forEach(other => {
        if (agent === other || other.isKingBob) return;
        // Only crowd against workers of the same session (same island).
        if (agent.session !== other.session) return;

        const dx = agent.x - other.x;
        const dy = agent.y - other.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= 0) return;

        const sameCluster = this.areInSameSwarm(agent, other);
        const minDist = sameCluster ? SAME_CLUSTER_DIST : DIFF_CLUSTER_DIST;

        if (dist < minDist) {
          const force = ((minDist - dist) / dist) * this.repulsionForce;
          ax += dx * force;
          ay += dy * force;
        }
      });

      // 3. Attraction to assigned workspace beside the building.
      if (workspace) {
        ax += (workspace.x - agent.x) * this.buildingAttractionForce;
        ay += (workspace.y - agent.y) * this.buildingAttractionForce;
      } else if (agent.island) {
        // Unassigned worker: drift gently toward its island center.
        ax += (agent.island.cx - agent.x) * 0.02;
        ay += (agent.island.cy - agent.y) * 0.02;
      }

      // 3b. Building avoidance — arc AROUND any cluster building/throne the agent is walking
      //     into, so it never tunnels through a house (where the y-sort would hide it). The
      //     tangential push is oriented toward the agent's goal so it detours to the correct
      //     side; the resting front-of-building workspaces lie outside these circles, so a
      //     settled worker feels nothing here.
      if (this.buildingObstacles.length) {
        const goalX = workspace ? workspace.x : (agent.island ? agent.island.cx : agent.x);
        const goalY = workspace ? workspace.y : (agent.island ? agent.island.cy : agent.y);
        for (const b of this.buildingObstacles) {
          const dxb = agent.x - b.x;
          const dyb = agent.y - b.y;
          if (Math.abs(dxb) > b.r || Math.abs(dyb) > b.r) continue; // cheap reject
          const dist = Math.sqrt(dxb * dxb + dyb * dyb) || 0.0001;
          if (dist >= b.r) continue;
          const strength = (b.r - dist) / b.r; // 0 at edge → 1 at centre

          // Radial unit (out of the building); fall back to straight-up if dead-centre.
          const ux = dist > 0.001 ? dxb / dist : 0;
          const uy = dist > 0.001 ? dyb / dist : -1;
          ax += ux * BUILDING_AVOID_RADIAL * strength;
          ay += uy * BUILDING_AVOID_RADIAL * strength;

          // Tangential (perpendicular) — pick the direction that heads toward the goal so the
          // agent flows around the correct side instead of stalling head-on.
          let tx = -uy;
          let ty = ux;
          if (tx * (goalX - agent.x) + ty * (goalY - agent.y) < 0) { tx = -tx; ty = -ty; }
          ax += tx * BUILDING_AVOID_TANGENT * strength;
          ay += ty * BUILDING_AVOID_TANGENT * strength;
        }
      }

      // 4. Island boundary — push back if straying past the shoreline.
      if (agent.island) {
        const dx = agent.x - agent.island.cx;
        const dy = agent.y - agent.island.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxR = agent.island.radius - ISLAND_EDGE_INSET;
        if (dist > maxR && dist > 0) {
          const force = ((dist - maxR) / dist) * LAYOUT_CONFIG.BOUNDARY_FORCE * 4;
          ax -= dx * force;
          ay -= dy * force;
        }
      }

      // Integrate velocity with damping and a speed cap.
      agent.vx = (agent.vx + ax) * this.damping;
      agent.vy = (agent.vy + ay) * this.damping;

      const velMag = Math.sqrt(agent.vx * agent.vx + agent.vy * agent.vy);
      if (velMag > LAYOUT_CONFIG.MAX_VELOCITY) {
        agent.vx = (agent.vx / velMag) * LAYOUT_CONFIG.MAX_VELOCITY;
        agent.vy = (agent.vy / velMag) * LAYOUT_CONFIG.MAX_VELOCITY;
      }

      if (agent.updatePosition) {
        agent.updatePosition(agent.vx, agent.vy);
      } else {
        agent.x += agent.vx;
        agent.y += agent.vy;
      }

      // Hard screen clamp (belt-and-braces; island boundary is the real constraint).
      agent.x = Math.max(LAYOUT_CONFIG.HARD_BOUNDARY_MARGIN, Math.min(this.width - LAYOUT_CONFIG.HARD_BOUNDARY_MARGIN, agent.x));
      agent.y = Math.max(LAYOUT_CONFIG.HARD_BOUNDARY_MARGIN, Math.min(this.height - LAYOUT_CONFIG.HARD_BOUNDARY_MARGIN, agent.y));
    });
  }

  /**
   * Checks whether two agents belong to the same cluster (same taskId).
   *
   * @param {Agent} agent1
   * @param {Agent} agent2
   * @returns {boolean}
   * @private
   */
  areInSameSwarm(agent1, agent2) {
    return !!agent1.taskId && !!agent2.taskId && agent1.taskId === agent2.taskId;
  }

  /**
   * Whether an agent is currently locked at its workspace.
   *
   * @param {Agent} agent
   * @returns {boolean}
   */
  isAgentAtWorkspace(agent) {
    return agent.atWorkspace === true;
  }
}

export default LayoutManager;
