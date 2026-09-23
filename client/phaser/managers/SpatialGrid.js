/**
 * Spatial Grid for efficient collision detection
 * Divides space into cells to reduce O(N²) checks to O(N×k) where k is avg agents per cell
 */
class SpatialGrid {
  constructor(width, height, cellSize = 150) {
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.grid = new Map();
  }

  clear() {
    this.grid.clear();
  }

  getCellKey(x, y) {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(y / this.cellSize);
    return `${col},${row}`;
  }

  insert(agent) {
    const key = this.getCellKey(agent.x, agent.y);
    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    this.grid.get(key).push(agent);
  }

  getNearbyAgents(agent) {
    // Get agents in same cell and adjacent cells (3x3 grid around agent)
    const col = Math.floor(agent.x / this.cellSize);
    const row = Math.floor(agent.y / this.cellSize);
    const nearby = [];

    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        const key = `${c},${r}`;
        if (this.grid.has(key)) {
          nearby.push(...this.grid.get(key));
        }
      }
    }

    return nearby;
  }
}

export default SpatialGrid;
