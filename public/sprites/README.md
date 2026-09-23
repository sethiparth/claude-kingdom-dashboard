# Sprite Assets Directory

## Overview
This directory is reserved for sprite assets used in the Kingdom Dashboard.

## Current System
All sprites are currently **procedurally generated** in code using Phaser's Graphics API.

### Location
Generated sprites are created in:
- `client/phaser/scenes/KingdomScene.js`
- Methods: `createPixelSprite()` and `createBuildingSprite()`

## Generated Sprites

### Character Sprites (16x16)
9 agent types with 3 distinct styles:

**Creatures:**
- agent-Explore (sage green)
- agent-code-review (forest green)
- agent-researcher (dark forest)
- agent-code-reviewer (dark forest)

**Humanoids:**
- agent-bug-fixer (terracotta)
- agent-frontend-design (terracotta)
- agent-general-purpose (forest green)

**Birds:**
- agent-Plan (clay)
- agent-planner (sage green)

### Building Sprites (32x32)
4 building types with Pokemon Center aesthetic:

- building-code-lab (terracotta roof)
- building-review-center (forest green roof)
- building-planning-office (clay roof)
- building-research-library (sage green roof)

## Using External Sprites

To use external sprite sheets instead of procedural generation:

### 1. Add Sprite Files
Place sprite sheets in this directory:
```
public/sprites/
├── characters-16x16.png    (Character sprite sheet)
├── buildings-32x32.png     (Building sprite sheet)
└── README.md              (This file)
```

### 2. Update Preload
Modify `client/phaser/scenes/KingdomScene.js`:

```javascript
preload() {
  // Load external sprites
  this.load.spritesheet('characters', 'sprites/characters-16x16.png', {
    frameWidth: 16,
    frameHeight: 16
  });
  
  this.load.spritesheet('buildings', 'sprites/buildings-32x32.png', {
    frameWidth: 32,
    frameHeight: 32
  });
}
```

### 3. Update Sprite Usage
Replace `createPixelSprite()` calls with sprite sheet references:

```javascript
// Instead of generating, use sprite sheet frame
const character = this.add.sprite(x, y, 'characters', frameIndex);
```

## Recommended Sprite Sources

### Free & Open-Source Options:

1. **Kenney Assets** (CC0)
   - https://kenney.nl/assets
   - Tiny Dungeon pack
   - Pixel Platformer pack

2. **OpenGameArt** (Various licenses)
   - https://opengameart.org
   - Filter by: "16x16", "Top-down", "RPG"

3. **itch.io** (Check individual licenses)
   - https://itch.io/game-assets/free
   - Search: "16x16 pixel art"

4. **LPC (Liberated Pixel Cup)**
   - https://lpc.opengameart.org
   - GPL/CC-BY-SA licensed

## Sprite Sheet Requirements

### Character Sprites:
- Size: 16x16 pixels per frame
- Format: PNG with transparency
- Layout: Horizontal or grid layout
- Frames needed: At least 9 (one per agent type)
- Style: Top-down Pokemon/RPG style

### Building Sprites:
- Size: 32x32 pixels per frame
- Format: PNG with transparency
- Layout: Horizontal or grid layout
- Frames needed: At least 4 (one per building)
- Style: Top-down building exterior view

## License
When using external sprites, ensure they are:
- CC0 (Public Domain)
- MIT Licensed
- CC-BY (with proper attribution)
- Compatible with project's MIT license

Always include attribution in `/CREDITS.md` if required.

## Current Status
✅ **Procedural generation working**
❌ External sprite sheets not implemented yet
📋 Directory reserved for future sprite assets

---

For documentation on the current procedural sprite system, see:
- `/SPRITE_SYSTEM.md` - Technical documentation
- `/SPRITE_INTEGRATION_SUMMARY.md` - Implementation details
