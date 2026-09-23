import Phaser from 'phaser';
import KingdomSceneV3 from './phaser/scenes/KingdomSceneV3.js';

const DEBUG = import.meta.env.DEV;

// Polling configuration
const API_BASE = 'http://localhost:3001';
const POLL_INTERVAL = 1000; // 1 second

// Agent state tracking
let previousAgents = new Map(); // id -> agent data
let pollingEnabled = true;

// Polling function to fetch agent status
async function pollAgentStatus() {
  if (!pollingEnabled) return;

  try {
    const response = await fetch(`${API_BASE}/api/status`);
    const data = await response.json();

    // Filter out stale agents (older than 24 hours to show all recent activity)
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const fetchedAgents = data.agents.filter(agent => {
      const lastUpdate = new Date(agent.lastUpdate).getTime();
      const age = now - lastUpdate;
      return age < TWENTY_FOUR_HOURS; // Show agents from last 24 hours
    });

    // Process agent changes
    const currentAgents = new Map(fetchedAgents.map(a => [a.id, a]));

    // Detect new agents
    currentAgents.forEach((agent, id) => {
      if (!previousAgents.has(id)) {
        handleAgentStart(agent);
      } else {
        // Check if tool changed
        const prevAgent = previousAgents.get(id);
        if (prevAgent.tool !== agent.tool) {
          handleAgentToolChange(agent);
        }
      }
    });

    // Detect removed agents
    previousAgents.forEach((agent, id) => {
      if (!currentAgents.has(id)) {
        handleAgentComplete(agent);
      }
    });

    // Update state
    previousAgents = currentAgents;

    // Pass data to Phaser scene
    const scene = game.scene.getScene('KingdomScene');
    if (scene) {
      if (DEBUG) console.log('📊 Polling data:', Array.from(currentAgents.values()));
      scene.updateAgents(Array.from(currentAgents.values()));

      // Sync active agent count with actual data (don't redeclare as const)
      const regularAgentsCount = Array.from(currentAgents.values()).filter(a => a.type !== 'king-bob').length;
      activeAgents = regularAgentsCount;
      updateStats();
    }
  } catch (error) {
    console.error('Error polling agent status:', error);
  }
}

// Start polling
setInterval(pollAgentStatus, POLL_INTERVAL);

// Phaser game configuration
const config = {
  type: Phaser.AUTO,
  parent: 'game-container',
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#e8dcc4',
  render: {
    antialias: true,
    roundPixels: false
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false
    }
  },
  // preventDefaultWheel stops the browser from page-zooming on a trackpad pinch (which
  // arrives as a ctrlKey wheel event) — without it the pinch would zoom the DOM/HUD as
  // well as the camera. The camera-zoom handler lives in CameraController.handleWheel.
  input: { mouse: { preventDefaultWheel: true } },
  scene: [KingdomSceneV3]
};

// Create game instance
const game = new Phaser.Game(config);

// Handle window resize
window.addEventListener('resize', () => {
  game.scale.resize(window.innerWidth, window.innerHeight);
});

// Hide loading screen once game is ready
game.events.once('ready', () => {
  setTimeout(() => {
    document.getElementById('loading').classList.add('hidden');
    // Start initial poll
    pollAgentStatus();
  }, 1000);
});

// UI state management - Global view (no session filtering)
let activeAgents = 0;
let completedTasks = 0;

// Agent event handlers
function handleAgentStart(agent) {
  if (DEBUG) console.log('🚀 Agent started:', agent);
  activeAgents++;
  updateStats();
  addActivity('🌿', `${agent.type} started: ${agent.description}`, agent.startedAt);
}

function handleAgentComplete(agent) {
  if (DEBUG) console.log('✨ Agent completed:', agent);
  activeAgents--;
  completedTasks++;
  updateStats();
  const duration = ((new Date() - new Date(agent.startedAt)) / 1000).toFixed(1);
  addActivity('✨', `${agent.type} completed (${duration}s)`, new Date().toISOString());
}

function handleAgentToolChange(agent) {
  // Update activity with current tool
  const scene = game.scene.getScene('KingdomScene');
  if (scene) {
    scene.updateAgentTool(agent.id, agent.tool);
  }
}

function updateStats() {
  document.getElementById('agent-count').textContent = activeAgents;
  document.getElementById('completed-count').textContent = completedTasks;
}

// Removed session filtering - now showing global view of all agents

function addActivity(emoji, message, timestamp) {
  const activityList = document.getElementById('activity-list');
  const item = document.createElement('div');
  item.className = 'activity-item';

  const time = new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Create elements safely without innerHTML
  const emojiSpan = document.createElement('span');
  emojiSpan.className = 'emoji';
  emojiSpan.textContent = emoji;

  const messageSpan = document.createElement('span');
  messageSpan.textContent = message;

  const timestampSpan = document.createElement('span');
  timestampSpan.className = 'timestamp';
  timestampSpan.textContent = time;

  item.appendChild(emojiSpan);
  item.appendChild(messageSpan);
  item.appendChild(timestampSpan);

  activityList.insertBefore(item, activityList.firstChild);

  // Keep only last 10 items
  while (activityList.children.length > 10) {
    activityList.removeChild(activityList.lastChild);
  }
}


// Session selector removed - now showing global view of all agents

// Popup Management
function showPopup(popupId) {
  // Hide all popups first
  document.querySelectorAll('.popup').forEach(p => p.classList.remove('visible'));
  // Show requested popup
  document.getElementById(popupId).classList.add('visible');
}

function hidePopup(popupId) {
  document.getElementById(popupId).classList.remove('visible');
}

// Manual refresh: re-read agent-status.json immediately and update the UI.
// A quick spin gives visual feedback that the poll ran.
document.getElementById('refresh-button').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.style.transition = 'transform 0.5s ease';
  btn.style.transform = 'rotate(360deg)';
  setTimeout(() => {
    btn.style.transition = 'none';
    btn.style.transform = 'rotate(0deg)';
  }, 520);
  pollAgentStatus();
});

// Icon button handlers
document.getElementById('stats-button').addEventListener('click', () => {
  const popup = document.getElementById('stats-popup');
  if (popup.classList.contains('visible')) {
    hidePopup('stats-popup');
  } else {
    showPopup('stats-popup');
  }
});

// Sessions button removed - now showing global view

document.getElementById('activity-button').addEventListener('click', () => {
  const popup = document.getElementById('activity-popup');
  if (popup.classList.contains('visible')) {
    hidePopup('activity-popup');
  } else {
    showPopup('activity-popup');
  }
});

// Close button handlers
document.querySelectorAll('.close-button').forEach(button => {
  button.addEventListener('click', (e) => {
    const popupId = e.target.getAttribute('data-popup');
    if (popupId) {
      hidePopup(popupId);
    }
  });
});

// Session selector removed - now showing global view

// Stop polling on page unload
window.addEventListener('beforeunload', () => {
  pollingEnabled = false;
});
