const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const supabaseApi = require('./supabase');
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
} = supabaseApi;
const autoSettleDebates = typeof supabaseApi.autoSettleDebates === 'function'
  ? supabaseApi.autoSettleDebates
  : async () => [];
const {
  applyBetToDebate,
  buildClientVerdict,
  closeDebateLive,
  countActiveDebates,
  getDebateById,
  listDebates,
  removeBetFromDebate,
  reconcileDebates,
} = require('./debates');
const { startBotsForDebate, stopBotsForDebate } = require('./debate-bots');
const { startLiveMonitor } = require('./live-monitor');
const {
  getNewsPipelineStatus,
  runNewsMaintenance,
  startNewsScheduler,
} = require('./news-pipeline');
const stripeLib = require('./stripe');
const { listTokenTransactions } = supabaseApi;
const { resolveNewsLiveStream } = require('./youtube-live');

const PORT = process.env.PORT || 3001;
const DEBATE_CHAT_HISTORY_LIMIT = 120;
const DEBATE_CHAT_MESSAGE_LIMIT = 260;

const debateChatByRoom = new Map();

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
// Stripe webhook MUST receive raw body (before express.json()).
app.post('/payment/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.get('stripe-signature') || '';
    let event;
    try {
      event = stripeLib.constructWebhookEvent(req.body, signature);
    } catch (err) {
      console.warn('[stripe] webhook signature failed:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data && event.data.object ? event.data.object : {};
        console.warn('[stripe] payment failed — payment_intent=', pi.id, 'reason=', pi.last_payment_error && pi.last_payment_error.message);
        res.json({ received: true, type: event.type });
        return;
      }

      const intent = stripeLib.extractCreditIntent(event);
      if (intent) {
        if (!intent.userId) {
          console.warn('[stripe] webhook missing userId in metadata, session=', intent.sessionId);
        } else {
          const result = await supabaseApi.creditBalanceAsAdmin(intent.userId, intent.points, {
            packId: intent.packId,
            sessionId: intent.sessionId,
            amountPaidCents: intent.amountPaidCents,
            email: intent.email,
          });
          if (result.duplicate) {
            console.log('[stripe] idempotent webhook — already processed, session=', intent.sessionId);
          }
        }
      }
      res.json({ received: true, type: event.type });
    } catch (err) {
      console.error('[stripe] webhook processing failed:', err);
      res.status(500).send('Webhook handler failure');
    }
  }
);

app.use(express.json());

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

app.use((req, res, next) => {
  if (
    req.path === '/public/config' ||
    req.path.startsWith('/news') ||
    req.path.startsWith('/debates') ||
    req.path.startsWith('/auth') ||
    req.path.startsWith('/me/')
  ) {
    setNoStoreHeaders(res);
  }
  next();
});

// ─────────────────────────────────────────────────────────────
//  In-memory state (live debate rooms)
// ─────────────────────────────────────────────────────────────
function buildDebatePayload(debateId) {
  reconcileDebates();
  const debate = getDebateById(debateId);
  if (!debate) return null;

  return {
    ...debate,
    id: String(debate.id),
    status: debate.closed ? 'closed' : 'live',
    streamMode: 'broadcast',
    startedAt: debate.openedAt || debate.createdAt || null,
    liveStartedAt: debate.openedAt || debate.createdAt || null,
    currentSpeaker: null,
    turnEndsAt: null,
    turnDurationMs: null,
    participants: [],
    verdict: debate.closed ? buildClientVerdict(debate.id) : null,
  };
}

function listDebatePayloads() {
  return listDebates().map(debate => buildDebatePayload(debate.id));
}

function broadcastDebate(debateId) {
  const payload = buildDebatePayload(debateId);
  if (!payload) return;

  io.to(String(debateId)).emit('debate_state', {
    ...payload,
    serverNow: Date.now(),
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roomHash(roomId) {
  return String(roomId).split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

function calcLiveMetrics(debateId, now = Date.now()) {
  const debate = getDebateById(debateId);
  if (!debate) return null;

  const id = String(debateId);
  const hash = roomHash(id);
  const waveA = Math.sin(now / 5000 + hash * 0.13);
  const waveB = Math.cos(now / 3500 + hash * 0.07);
  const yesPct = clamp(Math.round(Number(debate.yesPct || 50) + waveA * 1.6), 5, 95);
  const pool = Math.max(0, Math.round(Number(debate.pool || 0) + waveB * 180));
  const viewers = Math.max(120, Math.round(Number(debate.viewers || 0) + waveA * 55 + waveB * 25));
  const durationMs = Math.max(1, Number(debate.durationMs || 1));
  const openedAt = Number(debate.openedAt || now);
  const progressPct = debate.closed
    ? 100
    : clamp(((now - openedAt) / durationMs) * 100, 0, 100);

  return {
    debateId: id,
    serverNow: now,
    closed: Boolean(debate.closed),
    winnerSide: debate.winnerSide || null,
    winnerLabel: debate.winnerLabel || null,
    yesPct,
    pool,
    viewers,
    progressPct: Math.round(progressPct * 10) / 10,
    openedAt,
    durationMs,
    endsAt: Number(debate.endsAt || openedAt + durationMs),
  };
}

function ensureDebateChatRoom(roomId) {
  const key = String(roomId);
  if (!debateChatByRoom.has(key)) {
    debateChatByRoom.set(key, []);
  }
  return debateChatByRoom.get(key);
}

function pushDebateChatMessage(roomId, message) {
  const history = ensureDebateChatRoom(roomId);
  history.push(message);
  if (history.length > DEBATE_CHAT_HISTORY_LIMIT) {
    history.splice(0, history.length - DEBATE_CHAT_HISTORY_LIMIT);
  }
}

// ─────────────────────────────────────────────────────────────
//  Server-authoritative turn advancement
// ─────────────────────────────────────────────────────────────
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

function calcDebateOdds(yesPct, winnerSide) {
  const pct = winnerSide === 'no' ? 100 - Number(yesPct || 0) : Number(yesPct || 0);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return 2;
  return Math.round((100 / pct) * 100) / 100;
}

async function buildBootstrapPayload(accessToken, authUser) {
  let payload = await bootstrapState(accessToken, authUser);
  const closedPendingDebates = payload.bets
    .filter(bet => bet.status === 'pending')
    .map(bet => {
      const debate = getDebateById(bet.debateId);
      if (!debate || !debate.closed || !debate.winnerSide) return null;
      return {
        debateId: debate.id,
        winnerSide: debate.winnerSide,
        odds: calcDebateOdds(debate.yesPct, debate.winnerSide),
      };
    })
    .filter(Boolean);

  if (closedPendingDebates.length > 0) {
    const uniqueDebates = [];
    const seen = new Set();
    closedPendingDebates.forEach(debate => {
      const key = `${debate.debateId}:${debate.winnerSide}`;
      if (seen.has(key)) return;
      seen.add(key);
      uniqueDebates.push(debate);
    });

    const autoSettlements = await autoSettleDebates(accessToken, authUser, uniqueDebates);
    payload = await bootstrapState(accessToken, authUser);
    if (autoSettlements.length) {
      payload.autoSettlements = autoSettlements;
    }
  }

  return payload;
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
      newsStatus: 'GET /news/status',
      bootstrap: 'GET /me/bootstrap',
      balance: 'GET /me/balance',
      transactions: 'GET /me/transactions',
      profile: 'PUT /me/profile',
      deposit: 'POST /me/deposit',
      bet: 'POST /me/bets',
      settle: 'POST /me/bets/settle',
      participantCancel: 'POST /me/bets/participant/cancel',
      participantForfeit: 'POST /me/bets/participant/forfeit',
      packs: 'GET /payment/packs',
      checkout: 'POST /payment/checkout',
      webhook: 'POST /payment/stripe/webhook',
    },
    socket_events: [
      'subscribe_stats',
      'debate_state',
      'subscribe_debate',
      'unsubscribe_debate',
      'debate_chat_send',
      'debate_chat_history',
      'debate_chat_message',
      'live_metrics',
    ],
  });
});

app.get('/public/config', withApi(async () => {
  return getPublicConfig();
}));

app.get('/debates', (_req, res) => {
  res.json({
    serverNow: Date.now(),
    debates: listDebatePayloads(),
  });
});

app.get('/debates/:id', (req, res) => {
  const debate = buildDebatePayload(req.params.id);
  if (!debate) {
    res.status(404).json({ error: 'Debate not found' });
    return;
  }

  res.json({
    ...debate,
    serverNow: Date.now(),
  });
});

app.get('/news/status', withApi(async () => {
  return {
    serverNow: Date.now(),
    ...getNewsPipelineStatus(),
  };
}));

// Compatibility endpoints kept so the frontend can hydrate and sign out cleanly.
app.post('/auth/session', withApi(async () => {
  throw createError('Connexion geree cote client via Supabase Auth', 410);
}));

app.get('/auth/session', requireAuth, withApi(async req => {
  return buildBootstrapPayload(req.accessToken, req.authUser);
}));

app.delete('/auth/session', requireAuth, withApi(async () => {
  return { ok: true };
}));

app.get('/me/bootstrap', requireAuth, withApi(async req => {
  return buildBootstrapPayload(req.accessToken, req.authUser);
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
  const debate = getDebateById(req.body?.debateId);
  if (!debate) {
    throw createError('Debat introuvable', 404);
  }
  if (debate.closed) {
    throw createError('Ce debat est deja termine', 409);
  }

  const payload = await placeBet(req.accessToken, req.authUser, req.body || {});
  applyBetToDebate(req.body?.debateId, req.body?.side, req.body?.amount);
  broadcastDebate(req.body?.debateId);
  return {
    ...payload,
    debate: buildDebatePayload(req.body?.debateId),
    serverNow: Date.now(),
  };
}));

app.post('/me/bets/settle', requireAuth, withApi(async req => {
  return settleDebateBets(req.accessToken, req.authUser, req.body || {});
}));

app.post('/me/bets/participant/cancel', requireAuth, withApi(async req => {
  const debateId = String(req.body?.debateId || '');
  const before = await bootstrapState(req.accessToken, req.authUser);
  const participantBet = before.bets.find(bet =>
    String(bet.debateId) === debateId &&
    bet.kind === 'participant' &&
    bet.status === 'pending'
  );

  const payload = await cancelParticipantBet(req.accessToken, req.authUser, debateId);
  if (participantBet) {
    removeBetFromDebate(participantBet.debateId, participantBet.side, participantBet.amt);
  }
  broadcastDebate(debateId);

  return {
    ...payload,
    debate: buildDebatePayload(debateId),
    serverNow: Date.now(),
  };
}));

app.post('/me/bets/participant/forfeit', requireAuth, withApi(async req => {
  const debateId = String(req.body?.debateId || '');
  const payload = await forfeitParticipantBet(req.accessToken, req.authUser, debateId);
  broadcastDebate(debateId);
  return {
    ...payload,
    debate: buildDebatePayload(debateId),
    serverNow: Date.now(),
  };
}));

// ─────────────────────────────────────────────────────────────
//  Token balance + transaction history
// ─────────────────────────────────────────────────────────────

// Quick balance check without full bootstrap
app.get('/me/balance', requireAuth, withApi(async req => {
  const profile = await supabaseApi.bootstrapState(req.accessToken, req.authUser);
  return {
    balance: profile.user.balance,
    userId: req.authUser.id,
    serverNow: Date.now(),
  };
}));

// Transaction history
app.get('/me/transactions', requireAuth, withApi(async req => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const transactions = await listTokenTransactions(req.accessToken, req.authUser.id, { limit });
  return {
    transactions,
    userId: req.authUser.id,
    serverNow: Date.now(),
  };
}));

// ─────────────────────────────────────────────────────────────
//  Stripe — packs + checkout
// ─────────────────────────────────────────────────────────────

// Canonical route
app.get('/payment/packs', (_req, res) => {
  res.json({
    configured: stripeLib.isConfigured(),
    packs: stripeLib.listPacks(),
  });
});

// Alias matching user-spec route names
app.get('/api/tokens/packs', (_req, res) => {
  res.json({
    configured: stripeLib.isConfigured(),
    packs: stripeLib.listPacks(),
  });
});

// ── YouTube Live Stream Search ─────────────────────────────
function buildLiveStreamQuery(debate) {
  const title  = String(debate?.title || debate?.sourceTitle || '').trim();
  const cat    = String(debate?.category || '').trim();
  const source = String(debate?.sourceDomain || debate?.sourceFeedLabel || '').trim();
  const parts  = [title, cat !== 'general' ? cat : '', source].filter(Boolean);
  return parts.join(' ').slice(0, 120);
}

app.get('/api/debates/:id/livestream', async (req, res) => {
  const debate = buildDebatePayload(req.params.id);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });

  const query = buildLiveStreamQuery(debate);

  // 1. Debate already has a live embed attached at creation time
  if (debate.liveVideoId && debate.liveEmbedUrl) {
    return res.json({
      isLive  : true,
      liveUrl : debate.liveEmbedUrl,
      videoId : debate.liveVideoId,
      channel : debate.liveChannel || '',
      query,
    });
  }

  // 2. Resolve from verified live stream pool
  try {
    const liveStream = await resolveNewsLiveStream(debate.category);
    if (liveStream && liveStream.embedUrl) {
      return res.json({
        isLive  : true,
        liveUrl : liveStream.embedUrl,
        videoId : liveStream.videoId,
        channel : liveStream.handle,
        query,
      });
    }
  } catch (e) {
    console.warn('[livestream] resolveNewsLiveStream error:', e.message);
  }

  // No verified live stream for this debate
  return res.json({ isLive: false, liveUrl: null, query });
});

app.post('/payment/checkout', requireAuth, withApi(async req => {
  const packId = String(req.body?.packId || '');
  const successUrl = String(req.body?.successUrl || '') || undefined;
  const cancelUrl = String(req.body?.cancelUrl || '') || undefined;
  const session = await stripeLib.createCheckoutSession({
    packId,
    authUser: req.authUser,
    successUrl,
    cancelUrl,
  });
  return session;
}));

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected`);

  // ── Home / Lobby presence channel ──────────────────────────
  // Any client that wants global live stats joins the 'lobby' room.
  socket.on('subscribe_stats', () => {
    socket.join('lobby');
    socket.emit('global_stats', buildGlobalStats());
  });

  socket.on('subscribe_debate', payload => {
    const debateId = String(payload?.debateId || '').trim();
    if (!debateId) return;

    const debate = buildDebatePayload(debateId);
    if (!debate) {
      socket.emit('debate_error', { debateId, error: 'Debate not found' });
      return;
    }

    socket.join(debateId);
    socket.emit('debate_state', {
      ...debate,
      serverNow: Date.now(),
    });

    const liveMetrics = calcLiveMetrics(debateId);
    if (liveMetrics) {
      socket.emit('live_metrics', liveMetrics);
    }

    socket.emit('debate_chat_history', {
      debateId,
      messages: ensureDebateChatRoom(debateId),
      serverNow: Date.now(),
    });
  });

  socket.on('unsubscribe_debate', payload => {
    const debateId = String(payload?.debateId || '').trim();
    if (!debateId) return;
    socket.leave(debateId);
  });

  socket.on('debate_chat_send', payload => {
    const debateId = String(payload?.debateId || '').trim();
    if (!debateId) return;

    const room = io.sockets.adapter.rooms.get(debateId);
    if (!room || !room.has(socket.id)) return;

    const usernameRaw = String(payload?.user || payload?.username || '').trim();
    const textRaw = String(payload?.text || '').trim();
    if (!textRaw) return;

    const username = usernameRaw || `viewer_${socket.id.slice(0, 6)}`;
    const text = textRaw.slice(0, DEBATE_CHAT_MESSAGE_LIMIT);

    const message = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      debateId,
      user: username,
      text,
      ts: Date.now(),
    };

    pushDebateChatMessage(debateId, message);
    io.to(debateId).emit('debate_chat_message', message);
  });

});

// ─────────────────────────────────────────────────────────────
//  Global live stats broadcast
// ─────────────────────────────────────────────────────────────
function buildGlobalStats() {
  const debates = listDebates();
  const liveDebates = debates.filter(d => !d.closed).length;
  const inRoom = 0;
  // "Viewers" = UI-level count kept on each debate (deterministic from seed)
  let simViewers = 0;
  debates.forEach(d => { if (!d.closed) simViewers += Number(d.viewers || 0); });
  const totalConnected = (io.engine && io.engine.clientsCount) || 0;

  // Total pool of open debates
  let openPool = 0;
  debates.forEach(d => { if (!d.closed) openPool += Number(d.pool || 0); });

  return {
    serverNow: Date.now(),
    liveDebates,
    totalDebates: debates.length,
    inRoom,
    connected: totalConnected,
    simViewers,
    openPool,
  };
}

// Broadcast every 5s to any client that called `subscribe_stats`
setInterval(() => {
  const stats = buildGlobalStats();
  io.to('lobby').emit('global_stats', stats);
}, 5000);

setInterval(() => {
  const now = Date.now();
  const activeDebates = listDebates().filter(debate => !debate.closed);
  activeDebates.forEach(debate => {
    const metrics = calcLiveMetrics(debate.id, now);
    if (!metrics) return;
    io.to(String(debate.id)).emit('live_metrics', metrics);
  });
}, 1800);

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
reconcileDebates();
startNewsScheduler();

// ─────────────────────────────────────────────────────────────
//  Bot spawner — detects new live debates and starts bots
// ─────────────────────────────────────────────────────────────
const _debatesWithBots = new Set();

function spawnBotsForNewLiveDebates() {
  try {
    const liveDebates = listDebates({ includeUnlisted: true })
      .filter(d => d.liveVideoId && !d.closed && !_debatesWithBots.has(String(d.id)));

    liveDebates.forEach(debate => {
      _debatesWithBots.add(String(debate.id));
      startBotsForDebate(debate.id, debate, io, pushDebateChatMessage);
    });
  } catch (e) {
    console.warn('[bots] spawnBotsForNewLiveDebates error:', e.message);
  }
}

// Check for new live debates every 30s
setInterval(spawnBotsForNewLiveDebates, 30000);
// Also run once immediately after startup delay
setTimeout(spawnBotsForNewLiveDebates, 5000);

// ─────────────────────────────────────────────────────────────
//  Live-stream monitor — closes debates when stream ends
// ─────────────────────────────────────────────────────────────
startLiveMonitor(io, {
  listDebates: (opts) => listDebates(opts),
  closeDebate: (debateId, verdict) => {
    const closed = closeDebateLive(debateId, verdict);
    if (closed) broadcastDebate(debateId);
  },
  getChat: (debateId) => debateChatByRoom.get(String(debateId)) || [],
  stopBots: (debateId) => {
    stopBotsForDebate(debateId);
    _debatesWithBots.delete(String(debateId));
  },
  onDebateEnded: (debateId) => {
    broadcastDebate(debateId);
    runNewsMaintenance({ reason: 'live_ended' }).catch(e => {
      console.warn('[news] live_ended run failed:', e.message);
    });
  },
});

setInterval(() => {
  const summary = reconcileDebates();

  if (summary.closedIds.length) {
    summary.closedIds.forEach(debateId => {
      broadcastDebate(debateId);
    });

    // Trigger news maintenance whenever any debate closes
    runNewsMaintenance({ reason: 'debate_closed' }).catch(error => {
      console.warn('[news] debate_closed run failed', error);
    });
  }

  // Emergency refill: if active debates drop very low, force immediate maintenance
  if (countActiveDebates() < 3) {
    console.warn('[debates] emergency refill — fewer than 3 active debates');
    runNewsMaintenance({ reason: 'emergency_refill' }).catch(error => {
      console.warn('[news] emergency_refill run failed', error);
    });
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`\nBEEEF backend running on http://localhost:${PORT}`);
  console.log('REST : GET /public/config | GET /debates | GET /debates/:id | GET /news/status');
  console.log('SYNC : GET /me/bootstrap | PUT /me/profile | POST /me/bets');
  console.log('AUTH : Bearer token Supabase requis sur les routes /me/*');
  console.log('NEWS : BBC + Guardian + NPR + AlJazeera + France24 + LeMonde + GDELT');
  console.log(`STRIPE: ${stripeLib.isConfigured() ? 'configured' : 'NOT configured — set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET'}`);
  console.log('WS   : subscribe_stats | debate_state\n');
});
