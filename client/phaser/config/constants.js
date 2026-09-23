/**
 * Layout tuning constants.
 *
 * The only consumer is LayoutManager (the flocking/attraction model that drives agent
 * movement). Every key below is read there; nothing else in the app imports this file.
 */
export const LAYOUT_CONFIG = {
  // Workspace lock hysteresis: lock when within REACH, unlock past UNLOCK_RANGE (prevents jitter).
  WORKSPACE_REACH: 35,
  WORKSPACE_UNLOCK_RANGE: 80,

  // Force parameters.
  REPULSION_FORCE: 2.0,            // Full repulsion for agents at workspace (walkers have none).
  SWARM_ATTRACTION_FORCE: 0.08,    // Pull toward swarm center.
  BUILDING_ATTRACTION_FORCE: 0.08, // Pull toward the assigned building.
  DAMPING: 0.92,                   // Velocity friction — higher = less jitter.

  // Velocity limit.
  MAX_VELOCITY: 2.5,

  // Boundary constraints.
  BOUNDARY_FORCE: 0.12,            // Force pushing agents away from soft edges.
  HARD_BOUNDARY_MARGIN: 80,        // Hard clamp distance from edges.

  // Spatial grid partitioning.
  SPATIAL_GRID_CELL_SIZE: 150
};
