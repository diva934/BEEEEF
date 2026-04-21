const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const PORT = process.env.PORT || 3001;

// Allowed origins: local dev + Vercel frontend + any custom domain
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'http://localhost:5501',
      'http://localhost:3000',
      'https://beeeef.vercel.app',
    ];

// ─────────────────────────────────────────────────────────────
//  Express + HTTP + Socket.IO
// ─────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin:      ALLOWED_ORIGINS,
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  // Allow long-polling fallback for environments that block WS
  transports: ['websocket', 'polling'],
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  In-memory state
// ─────────────────────────────────────────────────────────────
const debates = {};

function getOrCreateRoom(debateId) {
  const id = String(debateId);
  if (!debates[id]) {
    debates[id] = {
      id,
      status:         'waiting',
      participants:   [],
      currentSpeaker: null,
      turnEndsAt:     null,
      startedAt:      null,
      turnDurationMs: 120000,   // 2 min per turn — server-authoritative
      _turnTimeout:   null,     // internal, never serialized to clients
      createdAt:      new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
    };
    console.log(`[room] créé dynamiquement: ${id}`);
  }
  return debates[id];
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function touch(debate) {
  debate.updatedAt = new Date().toISOString();
  return debate;
}

// Broadcast state to all sockets in the room.
// Strips internal fields and injects serverNow (Unix ms).
function broadcastDebate(debateId) {
  const debate = debates[debateId];
  if (!debate) return;

  // Build clean payload — no internal fields
  const { _turnTimeout, ...state } = debate;
  io.to(debateId).emit('debate_state', {
    ...state,
    serverNow: Date.now(),   // clients use this to compute remaining time
  });
}

// ─────────────────────────────────────────────────────────────
//  Server-authoritative turn advancement
// ─────────────────────────────────────────────────────────────
function scheduleNextTurn(debateId) {
  const debate = debates[debateId];
  if (!debate) return;

  // Clear any existing timer
  if (debate._turnTimeout) {
    clearTimeout(debate._turnTimeout);
    debate._turnTimeout = null;
  }

  if (debate.status !== 'live' || debate.participants.length < 2) return;

  const delay = debate.turnDurationMs;

  debate._turnTimeout = setTimeout(() => {
    const d = debates[debateId];
    if (!d || d.status !== 'live' || d.participants.length < 2) return;

    const ids     = d.participants.map(p => p.socketId);
    const current = ids.indexOf(d.currentSpeaker);
    d.currentSpeaker = ids[(current + 1) % ids.length];
    d.turnEndsAt     = Date.now() + d.turnDurationMs;

    touch(d);
    broadcastDebate(debateId);
    console.log(`[auto-turn] ${debateId} → ${d.currentSpeaker}`);

    // Schedule the following turn
    scheduleNextTurn(debateId);
  }, delay);
}

// ─────────────────────────────────────────────────────────────
//  REST
// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'BEEEF backend',
    routes:        { debates: 'GET /debates', debate: 'GET /debates/:id' },
    socket_events: [
      'join_debate', 'start_debate', 'change_turn',
      'webrtc_offer', 'webrtc_answer', 'webrtc_ice_candidate',
    ],
  });
});

app.get('/debates', (_req, res) => {
  res.json(Object.values(debates).map(({ _turnTimeout, ...d }) => d));
});

app.get('/debates/:id', (req, res) => {
  const debate = debates[req.params.id];
  if (!debate) return res.status(404).json({ error: 'Debate not found' });
  const { _turnTimeout, ...d } = debate;
  res.json({ ...d, serverNow: Date.now() });
});

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── join_debate ────────────────────────────────────────────
  socket.on('join_debate', ({ debateId, username }) => {
    const debate = getOrCreateRoom(debateId);

    socket.join(debateId);
    socket.data.debateId = debateId;
    socket.data.username = username;

    const already = debate.participants.find(p => p.socketId === socket.id);
    if (!already) {
      debate.participants.push({ socketId: socket.id, username });
      console.log(`[join] ${username} → ${debateId} (${debate.participants.length} participants)`);
    }

    touch(debate);
    broadcastDebate(debateId);

    // Send the joining socket the full peer list (for peer detection)
    socket.emit('room_peers', debate.participants.map(p => p.socketId));
  });

  // ── start_debate ───────────────────────────────────────────
  // Idempotent: only starts if status is 'waiting'
  socket.on('start_debate', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate) return;
    if (debate.status === 'live') return; // already running — ignore

    debate.status         = 'live';
    debate.startedAt      = Date.now();
    debate.currentSpeaker = debate.participants[0]?.socketId ?? null;
    debate.turnEndsAt     = Date.now() + debate.turnDurationMs;

    touch(debate);
    broadcastDebate(debateId);
    scheduleNextTurn(debateId);
    console.log(`[start] ${debateId} — speaker: ${debate.currentSpeaker}`);
  });

  // ── change_turn ────────────────────────────────────────────
  // Manual request from client (e.g. early handoff)
  socket.on('change_turn', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate || debate.participants.length < 2) return;

    const ids     = debate.participants.map(p => p.socketId);
    const current = ids.indexOf(debate.currentSpeaker);
    debate.currentSpeaker = ids[(current + 1) % ids.length];
    debate.turnEndsAt     = Date.now() + debate.turnDurationMs;

    touch(debate);
    broadcastDebate(debateId);
    scheduleNextTurn(debateId); // reset the auto-advance timer
    console.log(`[manual-turn] ${debateId} → ${debate.currentSpeaker}`);
  });

  // ── disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { debateId, username } = socket.data;
    if (!debateId) return;

    const debate = debates[String(debateId)];
    if (!debate) return;

    const wasCurrentSpeaker = debate.currentSpeaker === socket.id;
    debate.participants = debate.participants.filter(p => p.socketId !== socket.id);

    if (debate.participants.length === 0) {
      // Room empty — stop everything, reset
      if (debate._turnTimeout) { clearTimeout(debate._turnTimeout); debate._turnTimeout = null; }
      debate.currentSpeaker = null;
      debate.turnEndsAt     = null;
      debate.startedAt      = null;
      debate.status         = 'waiting';
    } else if (wasCurrentSpeaker) {
      // Hand off to next participant, reset turn timer
      debate.currentSpeaker = debate.participants[0].socketId;
      debate.turnEndsAt     = Date.now() + debate.turnDurationMs;
      scheduleNextTurn(debateId);
    }

    touch(debate);
    broadcastDebate(debateId);
    console.log(`[-] ${username ?? socket.id} left ${debateId} (${debate.participants.length} remaining)`);
  });

  // ─────────────────────────────────────────────────────────
  //  WebRTC signaling — pure relay, no media handling
  // ─────────────────────────────────────────────────────────

  socket.on('webrtc_offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc_offer', { fromSocketId: socket.id, offer });
  });

  socket.on('webrtc_answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc_answer', { fromSocketId: socket.id, answer });
  });

  socket.on('webrtc_ice_candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc_ice_candidate', { fromSocketId: socket.id, candidate });
  });
});

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\nBEEEF backend running on http://localhost:${PORT}`);
  console.log(`REST : GET /debates  |  GET /debates/:id`);
  console.log(`WS   : join_debate · start_debate · change_turn · webrtc_*\n`);
});
