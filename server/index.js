const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Load environment variables (if .env file exists)
require('dotenv').config();

const app = express();

// CORS configuration from environment
const corsOptions = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
  ? { origin: process.env.CORS_ORIGIN }
  : {};

app.use(cors(corsOptions));

// Parse JSON bodies
app.use(express.json());

// Path to agent status file (configurable via environment)
const statusFile = process.env.AGENT_STATUS_FILE || path.join(process.env.HOME, '.claude/agent-status.json');

// Initialize file if doesn't exist
if (!fs.existsSync(statusFile)) {
  try {
    // Ensure .claude directory exists
    const claudeDir = path.dirname(statusFile);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(statusFile, JSON.stringify({ agents: [] }, null, 2), { mode: 0o600 });
    console.log(`✅ Created agent status file: ${statusFile}`);
  } catch (err) {
    console.error('Failed to initialize status file:', err);
    process.exit(1);
  }
}

// API endpoint to get agent status
app.get('/api/status', (req, res) => {
  try {
    const data = fs.readFileSync(statusFile, 'utf8');
    const parsed = JSON.parse(data);

    // Validate structure
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.agents)) {
      console.error('Invalid agent status structure');
      return res.status(500).json({ error: 'Invalid status file format', agents: [] });
    }

    res.json(parsed);
  } catch (err) {
    console.error('Error reading agent status:', err);
    res.status(500).json({ error: 'Failed to read agent status', agents: [] });
  }
});

// API endpoint to serve King Bob image
app.get('/api/king-bob-image', (req, res) => {
  try {
    // Sanitize path to prevent path traversal
    const safePath = path.normalize(path.join(process.env.HOME, '.claude/minion-emojis/king-bob.png'));
    const expectedBase = path.join(process.env.HOME, '.claude/minion-emojis');

    // Verify path is within expected directory
    if (!safePath.startsWith(expectedBase)) {
      console.error('Path traversal attempt blocked:', safePath);
      return res.status(403).send('Forbidden');
    }

    if (fs.existsSync(safePath)) {
      res.sendFile(safePath);
    } else {
      res.status(404).send('King Bob image not found');
    }
  } catch (err) {
    console.error('Error serving King Bob image:', err);
    res.status(500).send('Error loading King Bob image');
  }
});

// Serve static files from dist directory (production build)
app.use(express.static(path.join(__dirname, '../dist')));

// Serve static files from public directory (development)
app.use(express.static(path.join(__dirname, '../public')));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  const distIndex = path.join(__dirname, '../dist/index.html');
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
  } else {
    res.status(404).send('Dashboard not built yet. Run: npm run build');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
  👑 Kingdom Dashboard Server Running
  ====================================
  Port: ${PORT}
  Dashboard: http://localhost:${PORT}
  API: http://localhost:${PORT}/api/status

  Status File: ${statusFile}
  Aesthetic: Organic/Nature Office

  Architecture: Simple polling (no Socket.io)
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🍃 Gracefully shutting down Kingdom...');
  process.exit(0);
});
