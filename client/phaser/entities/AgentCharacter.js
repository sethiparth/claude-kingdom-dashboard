import Phaser from 'phaser';

const DEBUG = import.meta.env.DEV;

/**
 * @class AgentCharacter
 * @extends Phaser.GameObjects.Container
 *
 * Represents an animated agent character in the Kingdom Dashboard with rich visual features:
 * - **Matrix spawn/despawn effects**: Digital rain animation when agents appear/disappear
 * - **Directional walking animations**: 4-direction sprite animation (up, down, left, right)
 * - **Tool-based activity states**: Shows typing (Edit/Write) vs reading (Read/Grep) animations
 * - **Speech bubbles**: Visual indicators for permission requests and waiting states
 * - **Workspace behavior**: Locks in place when reaching assigned building
 * - **Particle effects**: Typing indicators, celebration sparkles, goodbye hearts
 * - **Wandering behavior**: Idle agents wander randomly when not assigned to tasks
 *
 * @example
 * // Create agent in KingdomScene
 * const agent = new AgentCharacter(scene, 100, 100, 'bug-fixer', 'session-abc-123');
 * agent.updateToolState('Edit', { file_path: 'src/main.js' });
 * agent.inSwarm = true; // Assign to swarm
 *
 * @property {string} agentType - Full agent type identifier (e.g., "bug-fixer", "Explore")
 * @property {string} session - Unique session ID for this agent
 * @property {string} state - Current state: 'idle', 'walking', 'typing', 'reading', 'waiting'
 * @property {string} direction - Current facing direction: 'down', 'up', 'left', 'right'
 * @property {number} vx - Horizontal velocity (pixels/frame)
 * @property {number} vy - Vertical velocity (pixels/frame)
 * @property {boolean} inSwarm - Whether agent is assigned to a workspace building
 * @property {boolean} atWorkspace - Whether agent has reached their workspace (locks position)
 */
class AgentCharacter extends Phaser.GameObjects.Container {
  /**
   * Creates a new animated agent character with matrix spawn effect.
   *
   * @param {Phaser.Scene} scene - The Phaser scene this character belongs to
   * @param {Object} agentData - Agent data object containing id, type, session, etc.
   */
  constructor(scene, agentData) {
    super(scene, agentData.x || 0, agentData.y || 0);

    this.scene = scene;
    this.agentType = agentData.type;
    this.agentId = agentData.id; // Unique agent ID for differentiation
    this.session = agentData.session;
    this.cwd = agentData.cwd || null; // Session's working dir — its basename names the island.
    this.taskId = agentData.taskId; // Cluster key: agents sharing a taskId work together
    this.taskDescription = agentData.description;
    // Freshness timestamp from the status feed — King Bob uses this to tell whether his
    // parent session is actively working (recently refreshed) or idle (gone stale).
    this.lastUpdate = agentData.lastUpdate || null;
    // King Bob is the per-session orchestrator: gold-tinted, crowned, and roams the throne plaza
    // under scene control (excluded from clustering, layout physics, and idle wandering).
    this.isKingBob = agentData.type === 'king-bob' ||
      (typeof agentData.id === 'string' && agentData.id.endsWith('_king-bob'));
    this.state = 'idle';
    this.direction = 'down'; // down, up, left, right

    // Physics body for layout manager
    this.vx = 0;
    this.vy = 0;

    // Animation state
    this.walkFrame = 0;
    this.typeFrame = 0;
    this.frameTimer = 0;
    this.currentTool = null;

    // Matrix effect state
    this.matrixEffect = null; // 'spawn' or 'despawn'
    this.matrixTimer = 0;
    this.matrixDuration = 0.5; // seconds
    this.matrixColumns = [];
    this.matrixParticles = []; // Track particles for cleanup

    // Typing indicator state
    this.typingIndicatorActive = false;

    // Speech bubble state
    this.bubbleType = null; // 'permission' or 'waiting'
    this.bubbleTimer = 0;
    this.bubbleSprite = null;

    // Wandering state
    this.wanderTimer = 0;
    this.wanderTarget = null;
    this.isWandering = false;

    // Direction change hysteresis (prevent jittery flipping)
    this.directionChangeTimer = 0;
    this.directionChangeThreshold = 400; // Increased from 200ms - less direction flickering

    // Create visual elements
    this.createCharacter();

    // Add to scene
    scene.add.existing(this);

    // Set depth to ensure characters are visible above the map
    this.setDepth(10);

    if (DEBUG) console.log(`🎭 AgentCharacter container added to scene at (${this.x}, ${this.y})`);
    if (DEBUG) console.log(`   - Container depth: ${this.depth}`);
    if (DEBUG) console.log(`   - Container visible: ${this.visible}`);
    if (DEBUG) console.log(`   - Container active: ${this.active}`);

    // Start spawn effect
    this.startMatrixEffect('spawn');
  }

  /**
   * Creates the visual representation of the character including sprite, shadow, name label, and emoji.
   * Initially hidden (alpha 0) until matrix spawn effect completes.
   *
   * @private
   */
  createCharacter() {
    // Get agent name and emoji from minion map
    const agentName = this.agentType.split(':').pop();
    const emoji = this.getEmojiForAgent(agentName);
    const minionInfo = this.getMinionInfo(agentName, this.agentId);

    // Determine which character sprite sheet to use based on agent ID hash
    // This ensures each agent instance gets a different look even if same type
    const charIndex = this.agentId ? this.hashAgentId(this.agentId) % 6 : 0;
    const spriteKey = `char_${charIndex}`;

    if (DEBUG) console.log(`🎨 Creating sprite for ${agentName}:`, {
      agentId: this.agentId ? this.agentId.substring(0, 20) : 'unknown',
      charIndex,
      spriteKey,
      textureExists: this.scene.textures.exists(spriteKey)
    });

    // Create sprite (16x32 pixels from sprite sheet)
    // Fallback to char_0 if sprite doesn't exist (graceful degradation)
    const finalSpriteKey = this.scene.textures.exists(spriteKey) ? spriteKey : 'char_0';

    // Additional fallback: use placeholder if char_0 doesn't exist
    if (!this.scene.textures.exists(finalSpriteKey)) {
      if (DEBUG) console.warn(`⚠️ Sprite ${finalSpriteKey} not found, creating placeholder`);

      // Create a simple circle placeholder
      const placeholder = this.scene.add.circle(0, 0, 12, 0x8fa88e);
      placeholder.setOrigin(0.5, 1);
      this.sprite = placeholder;
    } else {
      this.sprite = this.scene.add.sprite(0, 0, finalSpriteKey, 1); // Frame 1 is idle
      this.sprite.setScale(1.5); // Larger for better visibility
      this.sprite.setOrigin(0.5, 1); // Bottom-center anchor
    }

    this.add(this.sprite);

    // Store sprite key for animations
    this.spriteKey = finalSpriteKey; // Use sprite key (char_0, char_1, etc.) for animation keys

    // Shadow underneath
    this.shadow = this.scene.add.ellipse(0, 5, 24, 12, 0x000000, 0.2);
    this.add(this.shadow);
    this.sendToBack(this.shadow);

    // Name label - Show "MinionName - Role" (unique names for same types)
    const displayName = minionInfo ? `${minionInfo.name} - ${minionInfo.shortRole}` : agentName;
    this.agentName = minionInfo ? minionInfo.name : agentName; // Store for reference
    this.nameText = this.scene.add.text(0, 20, displayName, {
      fontSize: '12px',
      fontFamily: 'DM Sans, sans-serif',
      color: '#4a4238',
      backgroundColor: 'rgba(245, 241, 232, 0.9)',
      padding: { x: 6, y: 3 },
      align: 'center'
    });
    this.nameText.setOrigin(0.5);
    this.add(this.nameText);
    this.sendToBack(this.nameText); // Send name to background

    // Emoji icon
    this.emojiText = this.scene.add.text(-40, -40, emoji, {
      fontSize: '20px'
    });
    this.add(this.emojiText);

    // Status glow (removed - no circle around avatars)

    // King Bob wears the gold hue + crown so every session's orchestrator reads as royalty.
    if (this.isKingBob) {
      this.applyKingBobStyle();
    }

    // Initially hidden (shown after spawn effect)
    this.sprite.setAlpha(0);
    this.shadow.setAlpha(0);
    this.nameText.setAlpha(0);
    this.emojiText.setAlpha(0);
  }

  /**
   * Applies King Bob's royal appearance: gold sprite tint, crown emoji, and a gold name plate.
   * Idempotent — safe to re-call after the matrix spawn effect clears the sprite tint.
   *
   * @private
   */
  applyKingBobStyle() {
    if (this.sprite && this.sprite.setTint) {
      this.sprite.setTint(0xFFD700);
    }
    if (this.emojiText) {
      this.emojiText.setText('👑');
      this.emojiText.setFontSize(24);
    }
    if (this.nameText) {
      this.nameText.setText('👑 King Bob');
      this.nameText.setColor('#2d1f0f');
      this.nameText.setBackgroundColor('rgba(255, 215, 0, 0.92)');
    }
  }

  /**
   * Returns the emoji icon for a given agent type.
   *
   * @param {string} agentName - The agent type name (e.g., "bug-fixer", "Explore")
   * @returns {string} Emoji character representing the agent (defaults to '🌿' for unknown types)
   * @private
   */
  getEmojiForAgent(agentName) {
    const emojiMap = {
      'Explore': '🔭',
      'bug-fixer': '🛠️',
      'code-review': '🔍',
      'Plan': '📐',
      'researcher': '📚',
      'frontend-design': '🎨',
      'code-reviewer': '📋',
      'planner': '📝',
      'general-purpose': '⚙️',
      'tdd-guide': '🧪',
      'architect': '🏛️'
    };

    return emojiMap[agentName] || '🌿';
  }

  /**
   * Returns minion name and role information for display purposes.
   * Maps agent types to friendly minion names from King Bob's army.
   * For duplicate agent types, uses a pool of alternate names.
   *
   * @param {string} agentName - The agent type name
   * @param {string} agentId - Unique agent ID for differentiation
   * @returns {{name: string, shortRole: string}|undefined} Minion info with name and role, or undefined if not mapped
   * @private
   */
  getMinionInfo(agentName, agentId) {
    // Base minion map for primary assignments
    const minionMap = {
      'Explore': { name: 'Kevin', shortRole: 'Chief Scout' },
      'researcher': { name: 'Stuart', shortRole: 'Intel Officer' },
      'bug-fixer': { name: 'Tom', shortRole: 'Bug Eliminator' },
      'Plan': { name: 'Dave', shortRole: 'Strategic Planner' },
      'architect': { name: 'Jerry', shortRole: 'Architect' },
      'frontend-design:frontend-design': { name: 'Mark', shortRole: 'Frontend Specialist' },
      'security-reviewer': { name: 'Phil', shortRole: 'Security Reviewer' },
      'code-review': { name: 'Carl', shortRole: 'Code Reviewer' },
      'feature-dev:code-reviewer': { name: 'Lance', shortRole: 'Security & Quality' },
      'pr-review-toolkit:code-reviewer': { name: 'Mel', shortRole: 'PR Reviewer' },
      'pr-review-toolkit:silent-failure-hunter': { name: 'Jorge', shortRole: 'Failure Hunter' },
      'feature-dev:code-simplifier': { name: 'Darwin', shortRole: 'Code Simplifier' },
      'feature-dev:code-explorer': { name: 'Tim', shortRole: 'Code Explorer' },
      'general-purpose': { name: 'Norbert', shortRole: 'General Scout' },
      'feature-dev:code-architect': { name: 'Pierre', shortRole: 'Architect' },
      'pr-rebase-maintainer': { name: 'John', shortRole: 'PR Maintainer' },
      'claude-code-guide': { name: 'Mike', shortRole: 'Doc Expert' },
      'hookify:conversation-analyzer': { name: 'Larry', shortRole: 'Analyzer' },
      'tdd-guide': { name: 'Otto', shortRole: 'Test Guide' },
      'refactor-cleaner': { name: 'Ken', shortRole: 'Refactor Cleaner' }
    };

    // Pool of alternate names for duplicate agent types (especially general-purpose)
    const alternateNames = [
      'Bob', 'Steve', 'Paul', 'Jim', 'Norbert', 'Jorge', 'Tim', 'Phil',
      'Chris', 'Lance', 'Dave', 'Carl', 'Mark', 'Stuart', 'Kevin', 'Tom',
      'Mike', 'Larry', 'Ken', 'Otto', 'Jerry', 'Pierre', 'John', 'Darwin',
      'Mel', 'Frank', 'George', 'Henry', 'Jack', 'Leo', 'Max', 'Neil'
    ];

    const baseInfo = minionMap[agentName];
    if (!baseInfo) return undefined;

    // Use agent ID hash to select unique name from pool
    const nameIndex = this.hashAgentId(agentId) % alternateNames.length;
    const uniqueName = alternateNames[nameIndex];

    return {
      name: uniqueName,
      shortRole: baseInfo.shortRole
    };
  }

  /**
   * Hashes an agent ID string to a deterministic integer.
   * Used for consistent sprite and name selection.
   *
   * @param {string} agentId - The agent ID to hash
   * @returns {number} Positive integer hash value
   * @private
   */
  hashAgentId(agentId) {
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      const char = agentId.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // ═══════════════════════════════════════════════════════════════
  // MATRIX EFFECT (Digital Rain Spawn/Despawn)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Initiates a matrix-style digital rain effect for spawning or despawning.
   * Creates staggered columns of particles that reveal/consume the character.
   *
   * @param {'spawn'|'despawn'} type - Type of matrix effect to perform
   */
  startMatrixEffect(type) {
    if (DEBUG) console.log(`🌟 Starting matrix effect: ${type}`);
    this.matrixEffect = type; // 'spawn' or 'despawn'
    this.matrixTimer = 0;

    // Initialize column timers (staggered)
    this.matrixColumns = [];
    const columnCount = 8;
    for (let i = 0; i < columnCount; i++) {
      this.matrixColumns.push({
        offset: Math.random() * 0.2, // Stagger start time
        position: 0
      });
    }

    if (type === 'despawn') {
      // Show sprite fully before despawning
      this.sprite.setAlpha(1);
      this.shadow.setAlpha(1);
      this.nameText.setAlpha(1);
      this.emojiText.setAlpha(1);
      // statusGlow removed - no longer used
    }
  }

  /**
   * Updates the matrix spawn/despawn effect animation.
   * Should be called every frame from the scene's update() loop.
   *
   * @param {number} delta - Time elapsed since last frame (milliseconds)
   * @private
   */
  updateMatrixEffect(delta) {
    if (!this.matrixEffect) return;

    this.matrixTimer += delta / 1000;
    const progress = Math.min(this.matrixTimer / this.matrixDuration, 1);

    if (this.matrixTimer < 0.1) {
    if (DEBUG) console.log(`⏱️ Matrix effect progress: ${(progress * 100).toFixed(1)}%`);
    }

    if (this.matrixEffect === 'spawn') {
      // Fade in as matrix sweeps down
      const alpha = progress;
      this.sprite.setAlpha(alpha);
      this.shadow.setAlpha(alpha * 0.5);
      this.nameText.setAlpha(alpha);
      this.emojiText.setAlpha(alpha);

      // Green tint during spawn
      this.sprite.setTint(
        Phaser.Display.Color.GetColor(
          Math.floor(0 + (255 - 0) * progress),
          Math.floor(255),
          Math.floor(100 + (255 - 100) * progress)
        )
      );
    } else {
      // Fade out as matrix consumes
      const alpha = 1 - progress;
      this.sprite.setAlpha(alpha);
      this.shadow.setAlpha(alpha * 0.5);
      this.nameText.setAlpha(alpha);
      this.emojiText.setAlpha(alpha);

      // Green tint during despawn
      this.sprite.setTint(
        Phaser.Display.Color.GetColor(
          Math.floor(255 * (1 - progress)),
          255,
          Math.floor(255 - 155 * progress)
        )
      );
    }

    // Matrix column effects (visual enhancement)
    this.drawMatrixColumns(progress);

    // Complete effect
    if (progress >= 1) {
      const wasSpawning = this.matrixEffect === 'spawn';
      this.matrixEffect = null;
      this.sprite.clearTint();

      // Restore King Bob's gold hue — clearTint() wiped the royal tint set in createCharacter.
      if (this.isKingBob && this.sprite.setTint) {
        this.sprite.setTint(0xFFD700);
      }

      if (wasSpawning) {
        // Fully visible after spawn
        this.sprite.setAlpha(1);
        this.shadow.setAlpha(1);
        this.nameText.setAlpha(1);
        this.emojiText.setAlpha(1);
    if (DEBUG) console.log('✨ Matrix spawn effect complete, character fully visible');

        // Start idle animation after spawn
        this.playAnimation('idle');
      }
    }
  }

  drawMatrixColumns(progress) {
    // Visual enhancement: draw matrix rain columns around character
    // (This is a simplified version - full pixel-per-pixel rendering would be more complex)

    // Create temporary particles falling around character
    if (Math.random() < 0.3) {
      const x = this.x + Phaser.Math.Between(-30, 30);
      const y = this.y - 50;

      const particle = this.scene.add.text(x, y, String.fromCharCode(0x30A0 + Math.random() * 96), {
        fontSize: '10px',
        color: '#00ff41',
        alpha: 0.7
      });

      // Track particle for cleanup
      this.matrixParticles.push(particle);

      this.scene.tweens.add({
        targets: particle,
        y: this.y + 20,
        alpha: 0,
        duration: 300,
        ease: 'Linear',
        onComplete: () => {
          // Remove from tracking array
          const index = this.matrixParticles.indexOf(particle);
          if (index > -1) {
            this.matrixParticles.splice(index, 1);
          }
          particle.destroy();
        }
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SPEECH BUBBLES (Permission/Waiting)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Shows a speech bubble above the character indicating current status.
   * Automatically disappears after 3 seconds.
   *
   * @param {'permission'|'waiting'} type - Type of bubble: 'permission' shows amber dots, 'waiting' shows green checkmark
   */
  showBubble(type) {
    this.bubbleType = type; // 'permission' or 'waiting'
    this.bubbleTimer = 3.0; // Show for 3 seconds

    if (this.bubbleSprite) {
      this.bubbleSprite.destroy();
    }

    // Create speech bubble above character
    const bubbleY = -60;

    // Bubble background
    const bubble = this.scene.add.graphics();
    bubble.fillStyle(0xffffff, 0.95);
    bubble.fillRoundedRect(-20, bubbleY - 20, 40, 30, 5);
    bubble.lineStyle(2, 0x4a4238, 0.5);
    bubble.strokeRoundedRect(-20, bubbleY - 20, 40, 30, 5);

    // Bubble tail
    bubble.fillStyle(0xffffff, 0.95);
    bubble.fillTriangle(0, bubbleY + 10, -5, bubbleY + 15, 5, bubbleY + 15);

    this.add(bubble);
    this.bubbleSprite = bubble;

    // Bubble icon
    let icon;
    if (type === 'permission') {
      // Amber dots (waiting for permission)
      icon = this.scene.add.text(0, bubbleY - 5, '...', {
        fontSize: '16px',
        color: '#CCA700',
        fontStyle: 'bold'
      });
    } else {
      // Green checkmark (waiting/ready)
      icon = this.scene.add.text(0, bubbleY - 5, '✓', {
        fontSize: '18px',
        color: '#44BB66',
        fontStyle: 'bold'
      });
    }
    icon.setOrigin(0.5);
    this.add(icon);
    this.bubbleIcon = icon;

    // Fade in animation
    bubble.setAlpha(0);
    icon.setAlpha(0);
    this.scene.tweens.add({
      targets: [bubble, icon],
      alpha: 1,
      duration: 200,
      ease: 'Cubic.easeOut'
    });
  }

  hideBubble() {
    if (this.bubbleSprite) {
      this.scene.tweens.add({
        targets: [this.bubbleSprite, this.bubbleIcon],
        alpha: 0,
        duration: 200,
        onComplete: () => {
          if (this.bubbleSprite) this.bubbleSprite.destroy();
          if (this.bubbleIcon) this.bubbleIcon.destroy();
          this.bubbleSprite = null;
          this.bubbleIcon = null;
        }
      });
    }
    this.bubbleType = null;
  }

  updateBubble(delta) {
    if (this.bubbleType) {
      this.bubbleTimer -= delta / 1000;

      // Fade out in last 0.5 seconds
      if (this.bubbleTimer < 0.5 && this.bubbleSprite) {
        const alpha = this.bubbleTimer / 0.5;
        this.bubbleSprite.setAlpha(alpha);
        if (this.bubbleIcon) this.bubbleIcon.setAlpha(alpha);
      }

      if (this.bubbleTimer <= 0) {
        this.hideBubble();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ANIMATION SYSTEM (Walk, Type, Read, Idle)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Plays the specified animation state for the character.
   * Transitions between idle, walk, typing, reading, thinking, and celebration states.
   *
   * @param {string} state - Animation state: 'idle', 'walk', 'typing', 'reading', 'thinking', 'celebrate'
   * @param {string|null} [tool=null] - Current tool being used (e.g., 'Edit', 'Read', 'Grep')
   */
  playAnimation(state, tool = null) {
    // Don't restart animation if we're already in this state
    if (this.state === state && this.currentTool === tool) {
      return;
    }

    this.state = state;
    this.currentTool = tool;

    // Update glow based on state
    this.updateStatusGlow(state);

    switch (state) {
      case 'idle':
        this.startIdleAnimation();
        break;
      case 'walk':
        this.startWalkAnimation();
        break;
      case 'typing':
        this.startTypingAnimation();
        break;
      case 'reading':
        this.startReadingAnimation();
        break;
      case 'thinking':
        this.startThinkingAnimation();
        break;
      case 'celebrate':
        this.celebrate();
        break;
    }
  }

  updateStatusGlow(state) {
    // Status glow removed - no visual effect needed
  }

  startIdleAnimation() {
    // Kill all tweens on sprite before starting new animation
    this.scene.tweens.killTweensOf(this.sprite);

    // For left direction, use right animations and flip sprite
    const animDirection = this.direction === 'left' ? 'right' : this.direction;
    const animKey = `${this.spriteKey}-idle-${animDirection}`;

    if (DEBUG) console.log(`🧍 Starting idle animation: ${animKey} (direction: ${this.direction})`);

    if (this.scene.anims.exists(animKey)) {
      // Only restart if we're not already playing this animation
      const currentAnim = this.sprite?.anims?.currentAnim;
      if (!currentAnim || currentAnim.key !== animKey) {
        this.sprite.play(animKey);
      }
    } else {
      console.warn(`❌ Idle animation not found: ${animKey}`);
    }

    // Reset sprite position/rotation/scale
    this.sprite.y = 0;
    this.sprite.angle = 0;
    this.sprite.setScale(1.5);

    // Gentle breathing (very slow)
    this.scene.tweens.add({
      targets: this.sprite,
      scaleY: 1.52, // Slightly compress
      duration: 3000,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Start wandering if idle for a while
    this.wanderTimer = Phaser.Math.Between(2000, 5000);
  }

  startWalkAnimation() {
    // Stop typing indicator particles
    this.typingIndicatorActive = false;

    // Kill all tweens on sprite before starting new animation
    this.scene.tweens.killTweensOf(this.sprite);

    // For left direction, use right animations and flip sprite
    const animDirection = this.direction === 'left' ? 'right' : this.direction;
    const animKey = `${this.spriteKey}-walk-${animDirection}`;

    if (DEBUG) console.log(`🚶 Starting walk animation: ${animKey} (direction: ${this.direction})`);

    if (this.scene.anims.exists(animKey)) {
      // Only restart if we're not already playing this animation
      const currentAnim = this.sprite?.anims?.currentAnim;
      if (!currentAnim || currentAnim.key !== animKey) {
        this.sprite.play(animKey);
      }
    } else {
      console.warn(`❌ Walk animation not found: ${animKey}`);
    }

    // Reset sprite properties
    this.sprite.angle = 0;
    this.sprite.setScale(1.5);

    // Walking bob (smooth, slow animation)
    this.scene.tweens.add({
      targets: this.sprite,
      y: -2,
      duration: 400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
  }

  startTypingAnimation() {
    // Kill all tweens on sprite before starting new animation
    this.scene.tweens.killTweensOf(this.sprite);

    // For left direction, use right animations and flip sprite
    const animDirection = this.direction === 'left' ? 'right' : this.direction;
    const animKey = `${this.spriteKey}-type-${animDirection}`;

    if (DEBUG) console.log(`⌨️ Starting typing animation: ${animKey} (direction: ${this.direction})`);

    if (this.scene.anims.exists(animKey)) {
      // Only restart if we're not already playing this animation
      const currentAnim = this.sprite?.anims?.currentAnim;
      if (!currentAnim || currentAnim.key !== animKey) {
        this.sprite.play(animKey);
      }
    } else {
      console.warn(`❌ Typing animation not found: ${animKey}`);
    }

    // Reset sprite properties
    this.sprite.angle = 0;
    this.sprite.setScale(1.5);

    // Slight bob while typing (slower than walking)
    this.scene.tweens.add({
      targets: this.sprite,
      y: -1,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    // Show typing indicator
    this.showTypingIndicator();
  }

  startReadingAnimation() {
    // Stop typing indicator particles
    this.typingIndicatorActive = false;

    // Kill all tweens on sprite before starting new animation
    this.scene.tweens.killTweensOf(this.sprite);

    // For left direction, use right animations and flip sprite
    const animDirection = this.direction === 'left' ? 'right' : this.direction;
    const animKey = `${this.spriteKey}-read-${animDirection}`;

    if (DEBUG) console.log(`📖 Starting reading animation: ${animKey} (direction: ${this.direction})`);

    if (this.scene.anims.exists(animKey)) {
      // Only restart if we're not already playing this animation
      const currentAnim = this.sprite?.anims?.currentAnim;
      if (!currentAnim || currentAnim.key !== animKey) {
        this.sprite.play(animKey);
      }
    } else {
      console.warn(`❌ Reading animation not found: ${animKey}`);
    }

    // Reset sprite properties
    this.sprite.y = 0;
    this.sprite.setScale(1.5);

    // Subtle tilt while reading (very slow)
    this.scene.tweens.add({
      targets: this.sprite,
      angle: 2,
      duration: 2500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });
  }

  startThinkingAnimation() {
    // Stop typing indicator particles
    this.typingIndicatorActive = false;

    this.scene.tweens.killTweensOf(this.sprite);

    // Head tilt
    this.scene.tweens.add({
      targets: this.sprite,
      angle: -8,
      duration: 1000,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut'
    });

    this.showThoughtBubble();
  }

  // ═══════════════════════════════════════════════════════════════
  // VISUAL EFFECTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Shows typing indicator particles above the character.
   * Spawns code symbols (< > { } ; = etc.) that float upward and fade out.
   * Particles spawn sequentially with 2-second delay to avoid visual clutter.
   *
   * @private
   */
  showTypingIndicator() {
    if (DEBUG) console.log(`💻 showTypingIndicator() called for ${this.agentType}`);

    // Set flag to allow particle spawning
    this.typingIndicatorActive = true;

    // Spawn one particle at a time - next one only after previous disappears
    const spawnParticle = () => {
      if (this.state !== 'typing' || !this.typingIndicatorActive) {
        return; // Stop spawning if no longer typing or indicator deactivated
      }

      const symbols = ['<', '>', '{', '}', '(', ')', ';', '=', 'code', 'def', 'if'];
      const symbol = Phaser.Utils.Array.GetRandom(symbols);
    if (DEBUG) console.log(`✨ Creating typing particle: ${symbol}`);

      // Use relative positioning within container (not absolute scene coordinates)
      const offsetX = Phaser.Math.Between(-20, 20);
      const offsetY = -20; // Start above the character

      const particle = this.scene.add.text(
        offsetX,
        offsetY,
        symbol,
        {
          fontSize: '14px',
          fontWeight: 'bold',
          color: '#00ff41', // Matrix green for code
          fontFamily: 'monospace',
          stroke: '#000000',
          strokeThickness: 2
        }
      );

      // Add to container so it moves with the character
      this.add(particle);

      this.scene.tweens.add({
        targets: particle,
        y: offsetY - 20, // Float upward just 20 pixels
        alpha: 0,
        duration: 1500, // Quick fade - 1.5 seconds
        ease: 'Linear', // Linear for smooth constant speed
        onComplete: () => {
          this.remove(particle);
          particle.destroy();

          // Add delay before spawning next particle to reduce particle density
          this.scene.time.delayedCall(2000, () => {
            spawnParticle();
          });
        }
      });
    };

    // Start the chain
    spawnParticle();
  }

  showThoughtBubble() {
    if (this.thoughtBubble) return;

    // Thought bubble above head
    const bubbles = [];
    for (let i = 0; i < 3; i++) {
      const size = 6 - i * 2;
      const bubble = this.scene.add.circle(
        this.x,
        this.y - 50 - i * 8,
        size,
        0xf5f1e8,
        0.9
      );
      bubble.setStrokeStyle(1, 0x8fa88e);
      bubbles.push(bubble);
    }

    this.thoughtBubble = bubbles;

    // Animate
    bubbles.forEach((bubble, i) => {
      this.scene.tweens.add({
        targets: bubble,
        alpha: 0.6,
        duration: 1000,
        yoyo: true,
        repeat: 2,
        delay: i * 100,
        onComplete: () => {
          bubble.destroy();
          if (i === bubbles.length - 1) {
            this.thoughtBubble = null;
          }
        }
      });
    });
  }

  celebrate() {
    // Jump up
    this.scene.tweens.add({
      targets: this,
      y: this.y - 40,
      duration: 400,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        // Fade and scale up
        this.scene.tweens.add({
          targets: this,
          scaleX: 1.5,
          scaleY: 1.5,
          alpha: 0,
          duration: 1500,
          ease: 'Cubic.easeOut'
        });
      }
    });

    // Sparkle burst
    this.showCelebrationParticles();
  }

  showCelebrationParticles() {
    const colors = [0xc97d60, 0x8fa88e, 0xf5f1e8, 0x697d59];

    for (let i = 0; i < 12; i++) {
      const angle = (Math.PI * 2 / 12) * i;
      const distance = 60;

      const particle = this.scene.add.circle(
        this.x,
        this.y - 20,
        Phaser.Math.Between(3, 6),
        Phaser.Utils.Array.GetRandom(colors)
      );

      this.scene.tweens.add({
        targets: particle,
        x: this.x + Math.cos(angle) * distance,
        y: this.y - 20 + Math.sin(angle) * distance,
        alpha: 0,
        duration: 1000,
        ease: 'Cubic.easeOut',
        onComplete: () => particle.destroy()
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WANDERING BEHAVIOR
  // ═══════════════════════════════════════════════════════════════

  updateWandering(delta) {
    if (this.state !== 'idle') {
      this.isWandering = false;
      this.wanderTarget = null;
      return;
    }

    if (this.isWandering && this.wanderTarget) {
      // Move toward wander target
      const dx = this.wanderTarget.x - this.x;
      const dy = this.wanderTarget.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 10) {
        // Reached target
        this.isWandering = false;
        this.wanderTarget = null;
        this.wanderTimer = Phaser.Math.Between(3000, 8000);
        this.playAnimation('idle');
      } else {
        // Keep walking - update direction and ensure walk animation plays
        const oldDirection = this.direction;
        this.updateDirection(dx, dy);

        // If direction changed while walking, update the animation immediately
        if (this.state === 'walk' && oldDirection !== this.direction) {
          this.startWalkAnimation();
        }
      }
    } else {
      // Count down to next wander
      this.wanderTimer -= delta;

      if (this.wanderTimer <= 0 && !this.isWandering) {
        this.startWandering();
      }
    }
  }

  startWandering() {
    // Pick random nearby location
    const range = 100;
    this.wanderTarget = {
      x: this.x + Phaser.Math.Between(-range, range),
      y: this.y + Phaser.Math.Between(-range, range)
    };

    // Clamp to scene bounds
    const bounds = this.scene.cameras.main;
    this.wanderTarget.x = Phaser.Math.Clamp(this.wanderTarget.x, 80, bounds.width - 80);
    this.wanderTarget.y = Phaser.Math.Clamp(this.wanderTarget.y, 80, bounds.height - 80);

    this.isWandering = true;
    this.playAnimation('walk');
  }

  // ═══════════════════════════════════════════════════════════════
  // DIRECTION & MOVEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Updates the character's facing direction based on movement delta.
   * Uses hysteresis to prevent rapid direction flipping.
   *
   * @param {number} dx - Horizontal movement delta (positive = right, negative = left)
   * @param {number} dy - Vertical movement delta (positive = down, negative = up)
   * @private
   */
  updateDirection(dx, dy) {
    const oldDirection = this.direction;

    // Determine desired facing direction based on movement
    // Use a small threshold to avoid jittery direction changes
    const threshold = 0.1;

    let desiredDirection = this.direction;

    if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
      if (Math.abs(dx) > Math.abs(dy)) {
        desiredDirection = dx > 0 ? 'right' : 'left';
      } else {
        desiredDirection = dy > 0 ? 'down' : 'up';
      }
    }

    // Always update direction immediately (removed hysteresis - was causing animation lag)
    if (desiredDirection !== this.direction) {
      this.direction = desiredDirection;
    if (DEBUG) console.log(`🔄 Direction changed from ${oldDirection} to ${this.direction}`);
      this.updateAnimationForDirection();
    }

    // For left-facing, flip the right sprite horizontally
    this.sprite.setFlipX(this.direction === 'left');

    // Update emoji position based on direction
    switch (this.direction) {
      case 'down':
        this.emojiText.setPosition(-40, -40);
        break;
      case 'up':
        this.emojiText.setPosition(-40, -50);
        break;
      case 'left':
        this.emojiText.setPosition(-45, -45);
        break;
      case 'right':
        this.emojiText.setPosition(-35, -45);
        break;
    }
  }

  updateAnimationForDirection() {
    // Update the current animation to match new direction
    let animKey;

    // For left direction, use right animations and flip sprite
    const animDirection = this.direction === 'left' ? 'right' : this.direction;

    switch (this.state) {
      case 'idle':
        animKey = `${this.spriteKey}-idle-${animDirection}`;
        break;
      case 'walk':
        animKey = `${this.spriteKey}-walk-${animDirection}`;
        break;
      case 'typing':
        animKey = `${this.spriteKey}-type-${animDirection}`;
        break;
      case 'reading':
        animKey = `${this.spriteKey}-read-${animDirection}`;
        break;
      default:
        animKey = `${this.spriteKey}-idle-${animDirection}`;
    }

    if (DEBUG) console.log(`🎬 Switching to animation: ${animKey} (exists: ${this.scene.anims.exists(animKey)})`);

    if (this.scene.anims.exists(animKey)) {
      const currentAnim = this.sprite?.anims?.currentAnim;
      // Only restart if NOT already playing this animation
      if (!currentAnim || currentAnim.key !== animKey) {
        this.sprite.play(animKey);
      }
    } else {
      console.warn(`❌ Animation not found: ${animKey}`);
    }
  }

  /**
   * Updates agent position based on velocity from LayoutManager.
   * Handles direction detection and animation state transitions.
   * Called by LayoutManager.update() every frame.
   *
   * @param {number} deltaX - Horizontal velocity (pixels/frame)
   * @param {number} deltaY - Vertical velocity (pixels/frame)
   * @public
   */
  updatePosition(deltaX, deltaY) {
    // Check if layout manager has locked us at workspace
    if (this.atWorkspace) {
      // Locked at workspace - don't update position
      // Note: Animation is controlled by tool-specific setAnimation() calls, not here
      return; // Don't update position - we're locked at workspace
    }

    // Not at workspace - apply movement
    this.vx = deltaX;
    this.vy = deltaY;

    this.x += this.vx;
    this.y += this.vy;

    // Update direction and animation based on movement
    const movementThreshold = 0.15;
    const isMoving = Math.abs(this.vx) > movementThreshold || Math.abs(this.vy) > movementThreshold;

    if (isMoving) {
      // Store old direction to detect changes
      const oldDirection = this.direction;

      // Moving - update direction from velocity
      this.updateDirection(this.vx, this.vy);

      // If direction changed while walking, update the animation immediately
      if (this.state === 'walk' && oldDirection !== this.direction) {
        this.startWalkAnimation();
      } else if (this.state !== 'walk') {
        // Just started walking
        this.playAnimation('walk');
      }
    } else {
      // Stopped moving - idle
      if (this.state === 'walk' && !this.isWandering) {
        this.playAnimation('idle');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // UPDATE LOOP
  // ═══════════════════════════════════════════════════════════════

  /**
   * Main update loop called every frame by Phaser.
   * Handles matrix effects, speech bubbles, and wandering behavior.
   *
   * @param {number} time - Current game time (milliseconds)
   * @param {number} delta - Time since last frame (milliseconds)
   * @public
   */
  preUpdate(time, delta) {
    // Note: Container doesn't have preUpdate, so we don't call super

    // Update matrix effect
    if (this.matrixEffect) {
      this.updateMatrixEffect(delta);
    }

    // Update speech bubble
    this.updateBubble(delta);

    // Update wandering (King Bobs are moved by the scene's patrol, so they don't wander)
    if (!this.isKingBob) {
      this.updateWandering(delta);
    }

    // Sprite animations are handled by Phaser's animation system now
  }

  // ═══════════════════════════════════════════════════════════════
  // ANIMATION HELPERS
  // ═══════════════════════════════════════════════════════════════

  setAnimation(animType) {
    // Helper to set animation from outside
    switch (animType) {
      case 'read':
        this.playAnimation('reading');
        break;
      case 'type':
        this.playAnimation('typing');
        break;
      case 'walk':
        this.playAnimation('walk');
        break;
      case 'idle':
        this.playAnimation('idle');
        break;
    }
  }

  /**
   * Refreshes the agent from a fresh status poll. Called by KingdomScene.updateAgents()
   * for every agent that already exists, so it must never throw on partial data.
   *
   * @param {Object} agentData - Latest agent snapshot (type, session, tool, taskId, etc.)
   * @public
   */
  updateState(agentData) {
    if (!agentData) return;

    // Refresh metadata that can change between polls (keep prior value if absent)
    this.agentType = agentData.type || this.agentType;
    this.session = agentData.session || this.session;
    this.cwd = agentData.cwd || this.cwd;
    this.taskId = agentData.taskId || this.taskId;
    this.taskDescription = agentData.description || this.taskDescription;
    this.lastUpdate = agentData.lastUpdate || this.lastUpdate;

    // King Bob's movement (workspace vs. roam) is driven by the scene's updateKingBobs(), not
    // this per-poll refresh. His tool-driven working animation still reaches
    // updateToolAnimation() the same way any agent's does — via KingdomScene.updateAgentTool()
    // on tool change — so no call is needed here.
    if (this.isKingBob) return;

    // Reflect the current tool as an activity animation
    this.updateToolAnimation(agentData.tool);
  }

  /**
   * Maps the agent's current tool name to a visible activity animation.
   * Edit-family tools → typing, read-family → reading, any other active tool → thinking.
   *
   * @param {string|null} tool - Current tool name from the status feed
   * @public
   */
  updateToolAnimation(tool) {
    // Nothing to do if unchanged, and don't stomp the spawn/despawn effect mid-flight.
    if (tool === this.currentTool) return;
    if (this.matrixEffect) return;

    const typingTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    const readingTools = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'];

    if (typingTools.includes(tool)) {
      this.playAnimation('typing', tool);
    } else if (readingTools.includes(tool)) {
      this.playAnimation('reading', tool);
    } else if (tool) {
      // Any other active tool (Bash, Task, MCP calls, …) → "busy" thinking state.
      this.playAnimation('thinking', tool);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════

  /**
   * Plays goodbye sequence when agent is despawning.
   * Shows waving hand emoji followed by floating hearts, then matrix despawn effect.
   *
   * @param {Function} callback - Called after goodbye sequence completes and character is destroyed
   * @public
   */
  startGoodbyeSequence(callback) {
    // Stage 1: Show goodbye emoji (👋) with fade animation
    const goodbyeEmoji = this.scene.add.text(this.x, this.y - 80, '👋', {
      fontSize: '48px'
    });
    goodbyeEmoji.setOrigin(0.5);
    goodbyeEmoji.setDepth(20); // Above everything
    goodbyeEmoji.setAlpha(0); // Start invisible

    // Fade in emoji (500ms)
    this.scene.tweens.add({
      targets: goodbyeEmoji,
      alpha: 1,
      duration: 500,
      ease: 'Quad.easeOut',
      onComplete: () => {
        // Hold for 800ms, then fade out
        this.scene.time.delayedCall(800, () => {
          this.scene.tweens.add({
            targets: goodbyeEmoji,
            alpha: 0,
            duration: 500,
            ease: 'Quad.easeIn',
            onComplete: () => {
              goodbyeEmoji.destroy();
            }
          });
        });
      }
    });

    // Stage 2: Jump animation (starts at same time as emoji, 600ms total)
    const originalY = this.y;
    this.scene.tweens.add({
      targets: this,
      y: originalY - 30, // Jump up 30px
      duration: 300,
      ease: 'Quad.easeOut',
      yoyo: true,
      onComplete: () => {
        // Stage 2.5: Show heart particles floating up (right after jump)
        this.showHeartParticles();

        // Stage 3: Start matrix despawn effect after hearts start
        // Total delay before matrix: 500ms (emoji fade in) + 800ms (hold) + 500ms (fade out) = 1800ms
        // Jump completes at 600ms, so add 1200ms delay
        this.scene.time.delayedCall(1200, () => {
          this.despawn(callback);
        });
      }
    });
  }

  /**
   * Creates heart emoji particles that float outward and upward around the character.
   * Used during goodbye sequence for a celebratory farewell effect.
   *
   * @private
   */
  showHeartParticles() {
    // Create heart particles floating up around the agent
    const heartEmojis = ['❤️', '💕', '💖', '💗', '💓', '💝'];

    // Spawn 8-10 hearts in a circle pattern
    const heartCount = Phaser.Math.Between(8, 10);

    for (let i = 0; i < heartCount; i++) {
      const angle = (Math.PI * 2 / heartCount) * i;
      const radius = Phaser.Math.Between(30, 50);

      // Calculate starting position around agent
      const startX = this.x + Math.cos(angle) * 20; // Start close to agent
      const startY = this.y + Math.sin(angle) * 20;

      // Calculate end position (float outward and upward)
      const endX = this.x + Math.cos(angle) * radius;
      const endY = this.y + Math.sin(angle) * radius - 40; // Float up more

      const heart = this.scene.add.text(
        startX,
        startY,
        Phaser.Utils.Array.GetRandom(heartEmojis),
        {
          fontSize: '24px'
        }
      );
      heart.setOrigin(0.5);
      heart.setDepth(20);
      heart.setAlpha(0);

      // Animate heart: fade in, float up/out, then fade out
      this.scene.tweens.add({
        targets: heart,
        alpha: 1,
        x: endX,
        y: endY,
        scale: 1.2,
        duration: 800,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          // Fade out
          this.scene.tweens.add({
            targets: heart,
            alpha: 0,
            y: endY - 20,
            duration: 400,
            ease: 'Cubic.easeIn',
            onComplete: () => {
              heart.destroy();
            }
          });
        }
      });

      // Add a gentle wobble to hearts
      this.scene.tweens.add({
        targets: heart,
        angle: Phaser.Math.Between(-15, 15),
        duration: 600,
        yoyo: true,
        repeat: 1,
        ease: 'Sine.easeInOut'
      });
    }
  }

  /**
   * Starts the matrix despawn effect and destroys the character after completion.
   *
   * @param {Function} [callback] - Optional callback executed before character destruction
   * @private
   */
  despawn(callback) {
    // Start despawn effect
    this.startMatrixEffect('despawn');

    // Call callback after effect completes
    this.scene.time.delayedCall(this.matrixDuration * 1000 + 100, () => {
      if (callback) callback();
      this.destroy();
    });
  }

  /**
   * Cleans up all resources including particles, effects, speech bubbles, and tweens.
   * Called automatically by Phaser when character is removed from scene.
   *
   * @public
   */
  destroy() {
    // Cleanup matrix particles
    if (this.matrixParticles && this.matrixParticles.length > 0) {
      this.matrixParticles.forEach(particle => {
        if (particle && particle.active) {
          particle.destroy();
        }
      });
      this.matrixParticles = [];
    }

    // Cleanup active effects
    if (this.activeEffects) {
      this.activeEffects.forEach(effect => {
        if (effect.remove) effect.remove();
      });
    }

    // Cleanup thought bubble
    if (this.thoughtBubble) {
      this.thoughtBubble.forEach(b => b.destroy());
    }

    // Cleanup speech bubble
    if (this.bubbleSprite) {
      this.bubbleSprite.destroy();
    }
    if (this.bubbleIcon) {
      this.bubbleIcon.destroy();
    }

    super.destroy();
  }
}

export default AgentCharacter;
