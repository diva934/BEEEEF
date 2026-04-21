const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const {
  bootstrapState,
  cancelParticipantBet,
  createError,
  depositBalance,
  forfeitParticipantBet,
  getPublicConfig,
  placeBet,
  settleDebateBets,
  updateProfile,
  verifyAccessToken,
} = require('./supabase');

const PORT = process.env.PORT || 3001;

// Allowed origins: local dev + Vercel frontend + optional custom domains.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5501',
  'http://localhost:3000',
  'https://beeeef.vercel.app',
];

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  try {
    const url = new URL(origin);
    if (url.hostname.endsWith('.vercel.app')) return true;
  } catch (_) {
    return false;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
//  Express + HTTP + Socket.IO
// ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  In-memory state (live debate rooms)
// ─────────────────────────────────────────────────────────────
const debates = {};

function getOrCreateRoom(debateId) {
  const id = String(debateId);
  if (!debates[id]) {
    debates[id] = {
      id,
      status: 'waiting',
      participants: [],
      currentSpeaker: null,
      turnEndsAt: null,
      startedAt: null,
      turnDurationMs: 120000,
      _turnTimeout: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    console.log(`[room] created: ${id}`);
  }
  return debates[id];
}

function serializeDebate(debate) {
  if (!debate) return null;
  const { _turnTimeout, ...state } = debate;
  return state;
}

function touch(debate) {
  debate.updatedAt = new Date().toISOString();
  return debate;
}

function broadcastDebate(debateId) {
  const debate = debates[debateId];
  if (!debate) return;

  io.to(debateId).emit('debate_state', {
    ...serializeDebate(debate),
    serverNow: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────
//  Server-authoritative turn advancement
// ─────────────────────────────────────────────────────────────
function scheduleNextTurn(debateId) {
  const debate = debates[debateId];
  if (!debate) return;

  if (debate._turnTimeout) {
    clearTimeout(debate._turnTimeout);
    debate._turnTimeout = null;
  }

  if (debate.status !== 'live' || debate.participants.length < 2) return;

  debate._turnTimeout = setTimeout(() => {
    const activeDebate = debates[debateId];
    if (!activeDebate || activeDebate.status !== 'live' || activeDebate.participants.length < 2) return;

    const ids = activeDebate.participants.map(participant => participant.socketId);
    const current = ids.indexOf(activeDebate.currentSpeaker);
    activeDebate.currentSpeaker = ids[(current + 1) % ids.length];
    activeDebate.turnEndsAt = Date.now() + activeDebate.turnDurationMs;

    touch(activeDebate);
    broadcastDebate(debateId);
    console.log(`[auto-turn] ${debateId} -> ${activeDebate.currentSpeaker}`);

    scheduleNextTurn(debateId);
  }, debate.turnDurationMs);
}

// ─────────────────────────────────────────────────────────────
//  REST helpers
// ─────────────────────────────────────────────────────────────
function apiError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'Server error',
    ...(error.details ? { details: error.details } : {}),
  });
}

function withApi(handler) {
  return async (req, res) => {
    try {
      const payload = await handler(req, res);
      if (!res.headersSent) {
        res.json(payload);
      }
    } catch (error) {
      apiError(res, error);
    }
  };
}

function getAccessToken(req) {
  const authHeader = req.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return authHeader.slice(7).trim();
}

async function requireAuth(req, res, next) {
  try {
    const accessToken = getAccessToken(req);
    const authUser = await verifyAccessToken(accessToken);
    req.accessToken = accessToken;
    req.authUser = authUser;
    next();
  } catch (error) {
    apiError(res, error);
  }
}

// ─────────────────────────────────────────────────────────────
//  REST
// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'BEEEF backend',
    auth: 'Supabase Auth',
    routes: {
      publicConfig: 'GET /public/config',
      debates: 'GET /debates',
      debate: 'GET /debates/:id',
      bootstrap: 'GET /me/bootstrap',
      profile: 'PUT /me/profile',
      deposit: 'POST /me/deposit',
      bet: 'POST /me/bets',
      settle: 'POST /me/bets/settle',
      participantCancel: 'POST /me/bets/participant/cancel',
      participantForfeit: 'POST /me/bets/participant/forfeit',
    },
    socket_events: [
      'join_debate',
      'start_debate',
      'change_turn',
      'webrtc_offer',
      'webrtc_answer',
      'webrtc_ice_candidate',
    ],
  });
});

app.get('/public/config', withApi(async () => {
  return getPublicConfig();
}));

app.get('/debates', (_req, res) => {
  res.json(Object.values(debates).map(serializeDebate));
});

app.get('/debates/:id', (req, res) => {
  const debate = debates[req.params.id];
  if (!debate) {
    res.status(404).json({ error: 'Debate not found' });
    return;
  }

  res.json({
    ...serializeDebate(debate),
    serverNow: Date.now(),
  });
});

// Compatibility endpoints kept so the frontend can hydrate and sign out cleanly.
app.post('/auth/session', withApi(async () => {
  throw createError('Connexion geree cote client via Supabase Auth', 410);
}));

app.get('/auth/session', requireAuth, withApi(async req => {
  return bootstrapState(req.accessToken, req.authUser);
}));

app.delete('/auth/session', requireAuth, withApi(async () => {
  return { ok: true };
}));

app.get('/me/bootstrap', requireAuth, withApi(async req => {
  return bootstrapState(req.accessToken, req.authUser);
}));

app.put('/me/profile', requireAuth, withApi(async req => {
  return updateProfile(req.accessToken, req.authUser, req.body || {});
}));

app.put('/me/password', requireAuth, withApi(async () => {
  throw createError('Change le mot de passe via Supabase Auth cote client', 410);
}));

app.post('/me/deposit', requireAuth, withApi(async req => {
  return depositBalance(req.accessToken, req.authUser, req.body?.amount);
}));

app.post('/me/bets', requireAuth, withApi(async req => {
  return placeBet(req.accessToken, req.authUser, req.body || {});
}));

app.post('/me/bets/settle', requireAuth, withApi(async req => {
  return settleDebateBets(req.accessToken, req.authUser, req.body || {});
}));

app.post('/me/bets/participant/cancel', requireAuth, withApi(async req => {
  return cancelParticipantBet(req.accessToken, req.authUser, req.body?.debateId);
}));

app.post('/me/bets/participant/forfeit', requireAuth, withApi(async req => {
  return forfeitParticipantBet(req.accessToken, req.authUser, req.body?.debateId);
}));

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  socket.on('join_debate', ({ debateId, username }) => {
    const debate = getOrCreateRoom(debateId);

    socket.join(debateId);
    socket.data.debateId = debateId;
    socket.data.username = username;

    const alreadyJoined = debate.participants.find(participant => participant.socketId === socket.id);
    if (!alreadyJoined) {
      debate.participants.push({ socketId: socket.id, username });
      console.log(`[join] ${username} -> ${debateId} (${debate.participants.length} participants)`);
    }

    touch(debate);
    broadcastDebate(debateId);
    socket.emit('room_peers', debate.participants.map(participant => participant.socketId));
  });

  socket.on('start_debate', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate) return;

    if (debate.status === 'live') {
      socket.emit('debate_state', {
        ...serializeDebate(debate),
        serverNow: Date.now(),
      });
      console.log(`[resync] ${debateId} -> ${socket.id}`);
      return;
    }

    debate.status = 'live';
    debate.startedAt = Date.now();
    debate.currentSpeaker = debate.participants[0]?.socketId ?? null;
    debate.turnEndsAt = Date.now() + debate.turnDurationMs;

    touch(debate);
    broadcastDebate(debateId);
    scheduleNextTurn(debateId);
    console.log(`[start] ${debateId} -> ${debate.currentSpeaker}`);
  });

  socket.on('change_turn', ({ debateId }) => {
    const debate = debates[String(debateId)];
    if (!debate || debate.participants.length < 2) return;

    const ids = debate.participants.map(participant => participant.socketId);
    const current = ids.indexOf(debate.currentSpeaker);
    debate.currentSpeaker = ids[(current + 1) % ids.length];
    debate.turnEndsAt = Date.now() + debate.turnDurationMs;

    touch(debate);
    broadcastDebate(debateId);
    scheduleNextTurn(debateId);
    console.log(`[manual-turn] ${debateId} -> ${debate.currentSpeaker}`);
  });

  socket.on('disconnect', () => {
    const { debateId, username } = socket.data;
    if (!debateId) return;

    const debate = debates[String(debateId)];
    if (!debate) return;

    const wasCurrentSpeaker = debate.currentSpeaker === socket.id;
    debate.participants = debate.participants.filter(participant => participant.socketId !== socket.id);

    if (debate.participants.length === 0) {
      if (debate._turnTimeout) {
        clearTimeout(debate._turnTimeout);
        debate._turnTimeout = null;
      }
      debate.currentSpeaker = null;
      debate.turnEndsAt = null;
      debate.startedAt = null;
      debate.status = 'waiting';
    } else if (wasCurrentSpeaker) {
      debate.currentSpeaker = debate.participants[0].socketId;
      debate.turnEndsAt = Date.now() + debate.turnDurationMs;
      scheduleNextTurn(debateId);
    }

    touch(debate);
    broadcastDebate(debateId);
    console.log(`[-] ${username ?? socket.id} left ${debateId} (${debate.participants.length} remaining)`);
  });

  // WebRTC signaling relay only.
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
  console.log('REST : GET /public/config | GET /debates | GET /debates/:id');
  console.log('SYNC : GET /me/bootstrap | PUT /me/profile | POST /me/bets');
  console.log('AUTH : Bearer token Supabase requis sur les routes /me/*');
  console.log('WS   : join_debate | start_debate | change_turn | webrtc_*\n');
});
