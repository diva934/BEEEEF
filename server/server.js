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
// Rooms créées dynamiquement pour tout debateId envoyé par le frontend
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

function nextTurnEnd(seconds = 30) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function broadcastDebate(debateId) {
  const debate = debates[debateId];
  if (debate) io.to(debateId).emit('debate_state', debate);
}

// ─────────────────────────────────────────────────────────────
//  REST — GET /debates/:id
// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'BEEEF backend',
    routes: {
      debates:    'GET /debates',
      debate:     'GET /debates/:id',
    },
    socket_events: [
      'join_debate', 'start_debate', 'change_turn',
      'webrtc_offer', 'webrtc_answer', 'webrtc_ice_candidate',
    ],
  });
});

app.get('/debates', (_req, res) => {
  res.json(Object.values(debates));
});

app.get('/debates/:id', (req, res) => {
  const debate = debates[req.params.id];
  if (!debate) return res.status(404).json({ error: 'Debate not found' });
  res.json(debate);
});

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── join_debate ────────────────────────────────────────────
  // payload: { debateId, username }
  socket.on('join_debate', ({ debateId, username }) => {
    const debate = getOrCreateRoom(debateId);

    socket.join(debateId);
    socket.data.debateId  = debateId;
    socket.data.username  = username;

    // Add participant if not already present
    const already = debate.participants.find(p => p.socketId === socket.id);
    if (!already) {
      debate.participants.push({ socketId: socket.id, username });
      console.log(`[join] ${username} → ${debateId} (${debate.participants.length} participants)`);
    }

    touch(debate);
    broadcastDebate(debateId);

    // Send the joining socket the full room member list so it can show others
    socket.emit('room_peers', debate.participants.map(p => p.socketId));
  });

  // ── start_debate ───────────────────────────────────────────
  // payload: { debateId }
  socket.on('start_debate', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate) return;

    debate.status         = 'live';
    debate.currentSpeaker = debate.participants[0]?.socketId ?? null;
    debate.turnEndsAt     = nextTurnEnd(30);

    touch(debate);
    broadcastDebate(debateId);
    console.log(`[start] ${debateId} — speaker: ${debate.currentSpeaker}`);
  });

  // ── change_turn ────────────────────────────────────────────
  // payload: { debateId }
  socket.on('change_turn', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate || debate.participants.length < 2) return;

    const ids     = debate.participants.map(p => p.socketId);
    const current = ids.indexOf(debate.currentSpeaker);
    debate.currentSpeaker = ids[(current + 1) % ids.length];
    debate.turnEndsAt     = nextTurnEnd(30);

    touch(debate);
    broadcastDebate(debateId);
    console.log(`[turn] ${debateId} → ${debate.currentSpeaker}`);
  });

  // ── disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    const { debateId, username } = socket.data;
    if (!debateId) return;

    const debate = debates[String(debateId)];
    if (!debate) return;

    const wasCurrentSpeaker = debate.currentSpeaker === socket.id;
    debate.participants = debate.participants.filter(p => p.socketId !== socket.id);

    // Re-assign speaker if needed
    if (wasCurrentSpeaker && debate.participants.length > 0) {
      debate.currentSpeaker = debate.participants[0].socketId;
      debate.turnEndsAt     = nextTurnEnd(30);
    } else if (debate.participants.length === 0) {
      debate.currentSpeaker = null;
      debate.turnEndsAt     = null;
      debate.status         = 'waiting'; // reset if empty
    }

    touch(debate);
    broadcastDebate(debateId);
    console.log(`[-] ${username ?? socket.id} left ${debateId} (${debate.participants.length} remaining)`);
  });

  // ─────────────────────────────────────────────────────────
  //  WebRTC signaling — pure relay, no media handling
  // ─────────────────────────────────────────────────────────

  // ── webrtc_offer ──────────────────────────────────────────
  // payload: { targetSocketId, offer }
  socket.on('webrtc_offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc_offer', {
      fromSocketId: socket.id,
      offer,
    });
  });

  // ── webrtc_answer ─────────────────────────────────────────
  // payload: { targetSocketId, answer }
  socket.on('webrtc_answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc_answer', {
      fromSocketId: socket.id,
      answer,
    });
  });

  // ── webrtc_ice_candidate ──────────────────────────────────
  // payload: { targetSocketId, candidate }
  socket.on('webrtc_ice_candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc_ice_candidate', {
      fromSocketId: socket.id,
      candidate,
    });
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
