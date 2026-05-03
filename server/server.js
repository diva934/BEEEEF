const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const supabaseApi = require('./supabase');
const {
  bootstrapState,
  buildGiftStatusHistoryEntry,
  cancelParticipantBet,
  checkDuplicateGiftOrder,
  createGiftOrder,
  createError,
  creditBalanceAsAdmin,
  depositBalance,
  findOpenGiftOrder,
  forfeitParticipantBet,
  getGiftOrderById,
  getProfileBalance,
  getPublicConfig,
  getRuntimeConfigStatus,
  isAdminUser,
  listGiftOrders,
  placeBet,
  redeemGiftCard,
  refundDebateBetsAsAdmin,
  refundGiftPoints,
  settleDebateBets,
  settleDebateBetsAsAdmin,
  transitionGiftOrder,
  updateGiftOrder,
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
  getLatestPredictionHistoryPoint,
  getPredictionHistory,
  listDebates,
  removeBetFromDebate,
  reconcileDebates,
  resolveDebate,
} = require('./debates');
const { startBotsForDebate, stopBotsForDebate } = require('./debate-bots');
const {
  getNewsPipelineStatus,
  runNewsMaintenance,
  startNewsScheduler,
} = require('./news-pipeline');
const { startAutoValidator } = require('./auto-validator');
const stripeLib = require('./stripe');
const { listTokenTransactions } = supabaseApi;

const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const ALLOW_VERCEL_PREVIEWS = String(process.env.ALLOW_VERCEL_PREVIEWS || '').toLowerCase() === 'true';
const RENDER_EXTERNAL_URL = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const DEBATE_CHAT_HISTORY_LIMIT = 120;
const DEBATE_CHAT_MESSAGE_LIMIT = 260;

const debateChatByRoom = new Map();
const debateLifecycleFingerprints = new Map();

// Allowed origins: local dev + Vercel frontend + optional custom domains.
const DEFAULT_ALLOWED_ORIGINS = IS_PRODUCTION
  ? ['https://beeeef.vercel.app']
  : [
      'http://localhost:5501',
      'http://127.0.0.1:5501',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://beeeef.vercel.app',
    ];

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(hostname || '').toLowerCase());
}

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    const normalizedOrigin = `${url.protocol}//${url.host}`;
    if (ALLOWED_ORIGINS.includes(normalizedOrigin)) return true;
    if (!IS_PRODUCTION && isLoopbackHost(url.hostname)) return true;
    if (ALLOW_VERCEL_PREVIEWS && url.hostname.endsWith('.vercel.app')) return true;
  } catch (_) {
    return false;
  }

  return false;
}

function corsOriginDelegate(origin, callback) {
  callback(null, isAllowedOrigin(origin));
}

// ─────────────────────────────────────────────────────────────
//  Express + HTTP + Socket.IO
// ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOriginDelegate,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  allowRequest: (req, callback) => {
    callback(null, isAllowedOrigin(req.headers.origin));
  },
  transports: ['websocket', 'polling'],
});

app.use(cors({
  origin: corsOriginDelegate,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next();
});
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
    req.path.startsWith('/api/news') ||
    req.path.startsWith('/api/predictions') ||
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
    status: debate.validationState === 'cancelled'
      ? 'cancelled'
      : debate.closed
        ? (debate.validationState === 'validating' ? 'validating' : 'closed')
        : 'active',
    bettingClosed: Boolean(debate.closed),
    resultPendingValidation: debate.validationState === 'validating',
    streamMode: 'context',
    startedAt: debate.openedAt || debate.createdAt || null,
    liveStartedAt: null,
    currentSpeaker: null,
    turnEndsAt: null,
    turnDurationMs: null,
    participants: [],
    verdict: debate.closed ? buildClientVerdict(debate.id) : null,
  };
}

function listDebatePayloads(region = null) {
  return listDebates({ region }).map(debate => buildDebatePayload(debate.id));
}

function broadcastDebate(debateId) {
  const payload = buildDebatePayload(debateId);
  if (!payload) return;

  io.to(String(debateId)).emit('debate_state', {
    ...payload,
    serverNow: Date.now(),
  });
}

function emitPredictionUpdate(debateId, point = null) {
  const latestPoint = point || getLatestPredictionHistoryPoint(debateId);
  if (!latestPoint) return;

  const yesProbability = Number(latestPoint.yesProbability || 0);
  io.to(String(debateId)).emit('prediction:update', {
    predictionId: String(debateId),
    yesProbability,
    noProbability: Math.round((100 - yesProbability) * 100) / 100,
    volume: Number(latestPoint.volume || 0),
    timestamp: Number(latestPoint.timestamp || Date.now()),
  });
}

function getDebateLifecycleFingerprint(debate) {
  return [
    debate?.closed ? '1' : '0',
    String(debate?.validationState || ''),
    String(debate?.winnerSide || ''),
    String(debate?.settlementState || ''),
    String(debate?.updatedAt || ''),
  ].join('|');
}

function collectDebateLifecycleTransitions() {
  const transitions = [];
  const activeIds = new Set();
  const debates = listDebates({ includeUnlisted: true });

  debates.forEach(debate => {
    const id = String(debate.id);
    const fingerprint = getDebateLifecycleFingerprint(debate);
    const previous = debateLifecycleFingerprints.get(id);
    activeIds.add(id);
    if (previous !== fingerprint) {
      transitions.push({
        debate,
        becameClosed: previous ? previous.startsWith('0|') && fingerprint.startsWith('1|') : false,
      });
      debateLifecycleFingerprints.set(id, fingerprint);
    }
  });

  [...debateLifecycleFingerprints.keys()].forEach(id => {
    if (!activeIds.has(id)) debateLifecycleFingerprints.delete(id);
  });

  return transitions;
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
  const yesPct = clamp(Math.round(Number(debate.yesPct || 50)), 5, 95);
  const pool = Math.max(0, Math.round(Number(debate.pool || 0)));
  const viewers = Math.max(0, Math.round(Number(debate.viewers || 0)));
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

async function requireAdmin(req, res, next) {
  try {
    const accessToken = getAccessToken(req);
    const authUser = await verifyAccessToken(accessToken);
    if (!isAdminUser(authUser.id)) {
      return apiError(res, createError('Accès refusé — droits admin requis', 403));
    }
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
      if (
        !debate ||
        !debate.closed ||
        !debate.winnerSide ||
        !['validated', 'manual_admin'].includes(String(debate.validationState || '').toLowerCase())
      ) return null;
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

const getPublicConfigHandler = withApi(async () => getPublicConfig());
const getNewsStatusHandler = withApi(async () => ({
  serverNow: Date.now(),
  ...getNewsPipelineStatus(),
}));
const getBalanceHandler = withApi(async req => {
  const profile = await supabaseApi.bootstrapState(req.accessToken, req.authUser);
  return {
    balance: profile.user.balance,
    userId: req.authUser.id,
    serverNow: Date.now(),
  };
});

function sendDebatesPayload(req, res) {
  res.json({
    serverNow: Date.now(),
    debates: listDebatePayloads(req.query.region ? String(req.query.region) : null),
  });
}

function sendDebatePayload(req, res) {
  const debate = buildDebatePayload(req.params.id);
  if (!debate) {
    res.status(404).json({ error: 'Debate not found' });
    return;
  }

  res.json({
    ...debate,
    serverNow: Date.now(),
  });
}

app.get('/public/config', getPublicConfigHandler);
app.get('/api/public/config', getPublicConfigHandler);

app.get('/debates', sendDebatesPayload);
app.get('/api/predictions', sendDebatesPayload);

app.get('/debates/:id', sendDebatePayload);
app.get('/api/predictions/:id', sendDebatePayload);
app.get('/debates/:id/history', async (req, res) => {
  const debate = getDebateById(req.params.id);
  if (!debate) {
    res.status(404).json({ error: 'Debate not found' });
    return;
  }
  try {
    res.json(await getPredictionHistory(req.params.id, req.query.range));
  } catch (err) {
    res.status(500).json({ error: 'history_error' });
  }
});
app.get('/api/predictions/:id/history', async (req, res) => {
  const debate = getDebateById(req.params.id);
  if (!debate) {
    res.status(404).json({ error: 'Prediction not found' });
    return;
  }
  try {
    res.json(await getPredictionHistory(req.params.id, req.query.range));
  } catch (err) {
    res.status(500).json({ error: 'history_error' });
  }
});

app.get('/news/status', getNewsStatusHandler);
app.get('/api/news/status', getNewsStatusHandler);

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
  const updatedDebate = applyBetToDebate(req.body?.debateId, req.body?.side, req.body?.amount);
  broadcastDebate(req.body?.debateId);
  if (updatedDebate) {
    emitPredictionUpdate(req.body?.debateId);
  }
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
    const updatedDebate = removeBetFromDebate(participantBet.debateId, participantBet.side, participantBet.amt);
    if (updatedDebate) {
      emitPredictionUpdate(debateId);
    }
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
app.get('/me/balance', requireAuth, getBalanceHandler);
app.get('/api/me/balance', requireAuth, getBalanceHandler);

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

// ─────────────────────────────────────────────────────────────
//  ADMIN ROUTES — requireAdmin middleware protects all of these
// ─────────────────────────────────────────────────────────────

// GET /api/admin/stats — global platform stats
app.get('/api/admin/stats', requireAdmin, withApi(async () => {
  const all = listDebates({ includeUnlisted: true });
  const live = all.filter(d => !d.closed);
  const totalPool = all.reduce((s, d) => s + Number(d.pool || 0), 0);
  return {
    totalDebates: all.length,
    liveDebates: live.length,
    closedDebates: all.length - live.length,
    totalPool,
    serverNow: Date.now(),
  };
}));

// GET /api/admin/debates — full debate list with internal fields
app.get('/api/admin/debates', requireAdmin, withApi(async () => {
  const all = listDebates({ includeUnlisted: true });
  return { debates: all, serverNow: Date.now() };
}));

// POST /api/admin/debates/:id/close — force-close any debate
app.post('/api/admin/debates/:id/close', requireAdmin, withApi(async req => {
  const { id } = req.params;
  const winnerSide = req.body?.winnerSide === 'no' ? 'no' : 'yes';
  const verdict = req.body?.verdict || 'Clôturé par l\'administrateur.';
  const closed = closeDebateLive(id, { winnerSide, verdict });
  if (!closed) throw createError('Débat introuvable ou déjà clôturé', 404);
  broadcastDebate(id);
  return { ok: true, debateId: id, winnerSide };
}));

// POST /api/admin/credit — credit tokens to any user
app.post('/api/admin/credit', requireAdmin, withApi(async req => {
  const { userId, points, note } = req.body || {};
  if (!userId || !points) throw createError('userId + points requis', 400);
  const result = await creditBalanceAsAdmin(userId, Number(points), {
    sessionId: `admin_manual_${Date.now()}`,
    packId: 'admin_credit',
    email: note || 'admin credit',
  });
  return { ok: true, ...result };
}));

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
function buildContextMediaQuery(debate) {
  const title = String(debate?.title || debate?.sourceTitle || '').trim();
  const cat = String(debate?.category || '').trim();
  const source = String(debate?.sourceDomain || debate?.sourceFeedLabel || '').trim();
  const parts = [title, cat !== 'general' ? cat : '', 'news analysis context video', source].filter(Boolean);
  return parts.join(' ').slice(0, 120);
}

function sendContextMediaPayload(req, res) {
  const debate = buildDebatePayload(req.params.id);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });

  return res.json({
    isLive: false,
    contextUrl: debate.contextVideoUrl || debate.previewVideoUrl || null,
    previewUrl: debate.previewVideoUrl || null,
    sourceUrl: debate.sourceUrl || null,
    sourceLabel: debate.sourceFeedLabel || debate.sourceDomain || '',
    query: buildContextMediaQuery(debate),
  });
}

app.get('/api/debates/:id/context-media', sendContextMediaPayload);
app.get('/api/debates/:id/livestream', sendContextMediaPayload);

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
//  Gift cards — points redemption
//  Price table is ONLY on the server — never trust the frontend
// ─────────────────────────────────────────────────────────────

// 500 pts = 2.99€  /  reference scale
const GIFT_CARD_PRICES = {
  5:  3000,
  10: 7000,
  15: 11000,
  20: 16000,
  25: 21000,
  50: 45000,
};

const ALLOWED_BRANDS = new Set([
  'apple', 'amazon', 'spotify', 'epic', 'netflix', 'playstation', 'xbox',
]);

const BRAND_NAMES = {
  apple: 'Apple', amazon: 'Amazon', spotify: 'Spotify',
  epic: 'Epic Games', netflix: 'Netflix', playstation: 'PlayStation', xbox: 'Xbox',
};

const GIFT_OPEN_STATUSES = new Set(['pending_review', 'points_reserved', 'gift_ready']);

async function sendResendEmail({ to, subject, html, throwOnMissingKey = true }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (throwOnMissingKey) throw createError('RESEND_API_KEY manquante', 500);
    console.warn('[gifts] RESEND_API_KEY manquante — email non envoyé');
    return false;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BEEEF Rewards <rewards@beeeef.vercel.app>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw createError(`Email Resend refusé: ${response.status} ${text}`, 502);
  }

  return true;
}

async function notifyAdminGiftReview(order) {
  const adminEmail = String(process.env.GIFT_ORDERS_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim();
  if (!adminEmail) {
    console.warn(`[gifts] notification admin ignorée — GIFT_ORDERS_ADMIN_EMAIL manquant (order=${order?.id || 'n/a'})`);
    return false;
  }

  const brandName = BRAND_NAMES[order.gift_card_brand] || order.gift_card_brand;
  return sendResendEmail({
    to: adminEmail,
    throwOnMissingKey: false,
    subject: `Nouvelle demande carte cadeau ${brandName} ${order.gift_card_value}€`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#fff">
      <div style="font-size:28px;font-weight:900;color:#ff4a0e;margin-bottom:24px">BEEEF</div>
      <h2 style="margin:0 0 16px;color:#111">Commande cadeau à traiter</h2>
      <p style="color:#444;line-height:1.6">Une nouvelle demande a été créée et les points sont réservés.</p>
      <div style="background:#fff7f4;border:2px solid #ff4a0e;border-radius:12px;padding:18px 20px;margin:24px 0">
        <div style="font-size:15px;font-weight:800;color:#111">${brandName} — ${order.gift_card_value}€</div>
        <div style="font-size:13px;color:#666;margin-top:8px">Utilisateur : ${order.email}<br>Points réservés : ${Number(order.points_cost || 0).toLocaleString('fr-FR')} pts<br>Commande : ${order.id}</div>
      </div>
      <p style="color:#444;line-height:1.6">Ouvre le panneau admin BEEEF pour saisir le code et l’envoyer.</p>
    </div>`,
  });
}

async function sendGiftCodeEmail(toEmail, { brand, valueEur, orderId, giftCode, adminNote }) {
  const brandName = BRAND_NAMES[brand] || brand;
  const safeCode = String(giftCode || '').replace(/[<>&]/g, '');
  const safeNote = String(adminNote || '').replace(/[<>&]/g, '');

  return sendResendEmail({
    to: toEmail,
    subject: `Votre carte cadeau ${brandName} ${valueEur}€ — BEEEF`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#fff">
      <div style="font-size:28px;font-weight:900;color:#ff4a0e;margin-bottom:24px">BEEEF</div>
      <h2 style="margin:0 0 16px;color:#111">Votre carte cadeau est prête</h2>
      <p style="color:#444;line-height:1.6">Bonjour,<br><br>Voici votre code cadeau ${brandName} ${valueEur}€.</p>
      <div style="background:#fff7f4;border:2px solid #ff4a0e;border-radius:12px;padding:20px;margin:24px 0;text-align:center">
        <div style="font-size:14px;color:#ff4a0e;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Code cadeau</div>
        <div style="font-size:30px;font-weight:900;color:#111;letter-spacing:0.08em">${safeCode}</div>
      </div>
      ${safeNote ? `<p style="color:#444;line-height:1.6"><strong>Message :</strong> ${safeNote}</p>` : ''}
      <p style="color:#999;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:16px">Référence commande : ${orderId}<br>L'équipe BEEEF</p>
    </div>`,
  });
}

// ── Confirmation email via Resend (fallback when Tremendous sends the card itself)
async function sendGiftConfirmationEmail(toEmail, { brand, valueEur, orderId }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[gifts] RESEND_API_KEY manquante — email de confirmation non envoyé'); return; }
  const brandName = BRAND_NAMES[brand] || brand;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'BEEEF Rewards <rewards@beeeef.vercel.app>',
        to: [toEmail],
        subject: `Votre carte cadeau ${brandName} ${valueEur}€ est en route — BEEEF`,
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px;background:#fff">
          <div style="font-size:28px;font-weight:900;color:#ff4a0e;margin-bottom:24px">BEEEF</div>
          <h2 style="margin:0 0 16px;color:#111">Carte cadeau confirmée 🎉</h2>
          <p style="color:#444;line-height:1.6">Bonjour,<br><br>Vos points ont été débités et votre carte cadeau est en cours d'envoi.</p>
          <div style="background:#fff7f4;border:2px solid #ff4a0e;border-radius:12px;padding:20px;margin:24px 0;text-align:center">
            <div style="font-size:14px;color:#ff4a0e;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Carte cadeau</div>
            <div style="font-size:32px;font-weight:900;color:#111">${brandName} — ${valueEur}€</div>
          </div>
          <p style="color:#444;line-height:1.6">Vous allez recevoir un <strong>email séparé de Tremendous</strong> avec le lien pour récupérer votre carte cadeau.</p>
          <p style="color:#999;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:16px">Référence commande : ${orderId}<br>L'équipe BEEEF — beeeef.vercel.app</p>
        </div>`,
      }),
    });
  } catch (e) {
    console.warn('[gifts] échec email de confirmation:', e.message);
  }
}

// ── In-flight guard: block concurrent identical requests (30-second window)
app.get('/api/admin/gift-orders', requireAdmin, withApi(async req => {
  const status = String(req.query.status || '').trim() || undefined;
  const orders = await listGiftOrders({ limit: Number(req.query.limit) || 80, status });
  const counts = orders.reduce((acc, order) => {
    const key = String(order.status || 'pending_review');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return { orders, counts, serverNow: Date.now() };
}));

app.post('/api/admin/gift-orders/:id/ready', requireAdmin, withApi(async req => {
  const orderId = String(req.params.id || '').trim();
  const giftCode = String(req.body?.giftCode || '').trim();
  const adminNote = String(req.body?.adminNote || '').trim();
  if (!giftCode) throw createError('Code cadeau requis', 400);

  const order = await getGiftOrderById(orderId);
  if (!order) throw createError('Commande cadeau introuvable', 404);
  if (['gift_sent', 'points_refunded'].includes(order.status)) {
    throw createError('Cette commande est déjà finalisée', 400);
  }

  const updated = await transitionGiftOrder(orderId, {
    status: 'gift_ready',
    giftCode,
    adminNote,
    adminId: req.authUser.id,
    historyMeta: { source: 'admin' },
  });

  return { ok: true, order: updated };
}));

app.post('/api/admin/gift-orders/:id/send', requireAdmin, withApi(async req => {
  const orderId = String(req.params.id || '').trim();
  const adminNote = String(req.body?.adminNote || '').trim();
  const providedCode = String(req.body?.giftCode || '').trim();

  let order = await getGiftOrderById(orderId);
  if (!order) throw createError('Commande cadeau introuvable', 404);
  if (order.status === 'points_refunded') throw createError('Commande déjà remboursée', 400);
  if (order.status === 'gift_sent') throw createError('Code déjà envoyé', 400);

  const finalCode = providedCode || String(order.gift_code || '').trim();
  if (!finalCode) throw createError('Code cadeau requis avant envoi', 400);

  if (order.status !== 'gift_ready') {
    order = await transitionGiftOrder(orderId, {
      status: 'gift_ready',
      giftCode: finalCode,
      adminNote,
      adminId: req.authUser.id,
      historyMeta: { source: 'admin_auto_prepare' },
    });
  }

  await sendGiftCodeEmail(order.email, {
    brand: order.gift_card_brand,
    valueEur: order.gift_card_value,
    orderId,
    giftCode: finalCode,
    adminNote,
  });

  const updated = await transitionGiftOrder(orderId, {
    status: 'gift_sent',
    giftCode: finalCode,
    adminNote,
    adminId: req.authUser.id,
    historyMeta: { source: 'admin_email' },
  });

  return { ok: true, order: updated };
}));

app.post('/api/admin/gift-orders/:id/fail', requireAdmin, withApi(async req => {
  const orderId = String(req.params.id || '').trim();
  const adminNote = String(req.body?.adminNote || '').trim();
  const order = await getGiftOrderById(orderId);
  if (!order) throw createError('Commande cadeau introuvable', 404);
  if (['gift_sent', 'points_refunded'].includes(order.status)) {
    throw createError('Cette commande ne peut plus être marquée en échec', 400);
  }

  const updated = await transitionGiftOrder(orderId, {
    status: 'failed',
    adminNote,
    adminId: req.authUser.id,
    errorMessage: adminNote || 'Commande marquée en échec',
    historyMeta: { source: 'admin' },
  });

  return { ok: true, order: updated };
}));

app.post('/api/admin/gift-orders/:id/refund', requireAdmin, withApi(async req => {
  const orderId = String(req.params.id || '').trim();
  const adminNote = String(req.body?.adminNote || '').trim();
  const order = await getGiftOrderById(orderId);
  if (!order) throw createError('Commande cadeau introuvable', 404);
  if (order.status === 'points_refunded') throw createError('Points déjà remboursés', 400);
  if (order.status === 'gift_sent') throw createError('Carte déjà envoyée — remboursement manuel requis hors MVP', 400);

  if (order.status !== 'failed') {
    await transitionGiftOrder(orderId, {
      status: 'failed',
      adminNote,
      adminId: req.authUser.id,
      errorMessage: adminNote || 'Carte indisponible',
      historyMeta: { source: 'admin_before_refund' },
    });
  }

  const refund = await refundGiftPoints(order.user_id, orderId, Number(order.points_cost || 0), {
    reason: 'gift_unavailable',
    brand: order.gift_card_brand,
    valueEur: order.gift_card_value,
  });

  const updated = await transitionGiftOrder(orderId, {
    status: 'points_refunded',
    adminNote,
    adminId: req.authUser.id,
    historyMeta: { source: 'admin_refund', refundedPoints: Number(order.points_cost || 0) },
  });

  return { ok: true, order: updated, refund };
}));

const _pendingRedeems = new Set();

app.post('/api/gifts/redeem', requireAuth, withApi(async req => {
  const userId    = req.authUser.id;
  const userEmail = req.authUser.email;
  if (!userEmail) throw createError('Email utilisateur introuvable', 400);

  // ── 1. Validate input (brand + value only — price comes from server table)
  const rawBrand = String(req.body?.giftCardBrand || '').toLowerCase().trim();
  const rawValue = Number(req.body?.giftCardValue);
  if (!ALLOWED_BRANDS.has(rawBrand)) throw createError('Marque inconnue', 400);
  const pointsCost = GIFT_CARD_PRICES[rawValue];
  if (!pointsCost) throw createError('Valeur de carte cadeau non disponible', 400);

  // ── 2. Idempotency key — 30-second window prevents double-clicks
  const windowSlot     = Math.floor(Date.now() / 30000);
  const idempotencyKey = `redeem_${userId}_${rawBrand}_${rawValue}_${windowSlot}`;

  // In-memory guard (same process)
  if (_pendingRedeems.has(idempotencyKey)) {
    throw createError('Échange en cours, veuillez patienter', 429);
  }

  // DB-level duplicate check
  const existing = await checkDuplicateGiftOrder(userId, idempotencyKey);
  if (existing && ['pending_review', 'points_reserved', 'gift_ready', 'gift_sent'].includes(existing.status)) {
    throw createError('Échange déjà en cours ou traité, veuillez patienter', 429);
  }

  const balance = await getProfileBalance(userId);
  if (Number(balance.balance || 0) < pointsCost) {
    throw createError(`Solde insuffisant â€” il te faut ${pointsCost} pts, tu as ${balance.balance} pts`, 400);
  }

  const openOrder = await findOpenGiftOrder(userId, rawBrand, rawValue);
  if (openOrder && GIFT_OPEN_STATUSES.has(openOrder.status)) {
    throw createError('Une demande similaire est dÃ©jÃ  en cours de traitement', 409);
  }

  _pendingRedeems.add(idempotencyKey);
  let order = null;

  try {
    // ── 3. Deduct points (existing helper — checks balance, writes token_transaction)
    order = await createGiftOrder({
      userId,
      email: userEmail,
      brand: rawBrand,
      valueEur: rawValue,
      pointsCost,
      idempotencyKey,
      status: 'pending_review',
      provider: 'manual_admin',
      statusHistory: [buildGiftStatusHistoryEntry('pending_review', {
        source: 'user_request',
        email: userEmail,
      })],
    });

    // ── 4. Create order row (status: points_deducted)
    const reserveResult = await redeemGiftCard(userId, pointsCost, {
      brand: rawBrand,
      valueEur: rawValue,
      email: userEmail,
      orderId: order.id,
      reason: 'gift_points_reserved',
    });
    await transitionGiftOrder(order.id, {
      status: 'points_reserved',
      historyMeta: { source: 'system', pointsCost },
    });

    // ── 5. Call Tremendous to deliver the gift card
    await notifyAdminGiftReview({
      ...order,
      points_cost: pointsCost,
    });

    // ── 6. Mark order sent
    console.log(`[gifts] manual order queued ${order.id} â€” ${userId} â€” ${rawBrand} ${rawValue}â‚¬ (${pointsCost}pts)`);

    // ── 7. Send our own confirmation email (Tremendous also sends one)
    return {
      ok: true,
      status: 'points_reserved',
      newBalance: reserveResult.newBalance,
      brand: rawBrand,
      valueEur: rawValue,
      orderId: order.id,
    };

    console.log(`[gifts] ✅ ${userId} — ${rawBrand} ${rawValue}€ (${pointsCost}pts) order=${tr.orderId}`);
  } catch (err) {
    // ── Auto-refund if points were already deducted but provider failed
    if (order?.id) {
      const isProviderError = err.message?.startsWith('Tremendous');
      if (isProviderError) {
        try {
          await refundGiftPoints(userId, order.id, pointsCost);
          console.warn(`[gifts] ⚠️ provider failed — refunded ${pointsCost}pts to ${userId}`);
        } catch (refundErr) {
          console.error('[gifts] refund failed:', refundErr.message);
          await updateGiftOrder(order.id, { status: 'failed', error_message: err.message });
        }
        throw createError(
          'Le fournisseur de cartes cadeaux est temporairement indisponible. Vos points ont été remboursés.',
          503
        );
      }
      // Non-provider error (e.g. DB issue after order created)
      await transitionGiftOrder(order.id, {
        status: 'failed',
        errorMessage: err.message?.slice(0, 500),
        historyMeta: { source: 'system' },
      });
    }
    throw err;
  } finally {
    _pendingRedeems.delete(idempotencyKey);
  }
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
    emitPredictionUpdate(debateId);

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
(async () => {
  reconcileDebates();
  try {
    await runNewsMaintenance({ reason: 'startup_bootstrap' });
  } catch (error) {
    console.warn('[predictions] startup bootstrap failed:', error.message);
  }
  startNewsScheduler();

  // Start real-event auto-validator (crypto + sports predictions)
  startAutoValidator({
    listDebates,
    resolveDebate,
    settleDebateBetsAsAdmin,
    refundDebateBetsAsAdmin,
    io,
  });
})();

// ─────────────────────────────────────────────────────────────
//  Bot spawner — detects new live debates and starts bots
// ─────────────────────────────────────────────────────────────
const _debatesWithBots = new Set();

function spawnBotsForNewContextDebates() {
  try {
    // All open debates get market bots — no source filter.
    const contextDebates = listDebates({ includeUnlisted: true })
      .filter(d => !d.closed && !_debatesWithBots.has(String(d.id)));

    contextDebates.forEach(debate => {
      _debatesWithBots.add(String(debate.id));
      startBotsForDebate(debate.id, debate, io, pushDebateChatMessage, (debateId, side, amount) => {
        try {
          const updated = applyBetToDebate(debateId, side, amount);
          if (updated) {
            emitPredictionUpdate(debateId);
          }
        } catch (e) {
          console.warn('[bots] onBotBet error:', e.message);
        }
      });
    });
  } catch (e) {
    console.warn('[bots] spawnBotsForNewContextDebates error:', e.message);
  }
}

// Check for new context/media debates every 30s
setInterval(spawnBotsForNewContextDebates, 30000);
// Also run once immediately after startup delay
setTimeout(spawnBotsForNewContextDebates, 5000);

// ─────────────────────────────────────────────────────────────
//  Supabase history flush every 5 min
//  Runs from server.js (Supabase already works here for auth/bets).
// ─────────────────────────────────────────────────────────────
async function flushHistoryToSupabase() {
  try {
    var pushFn = supabaseApi && supabaseApi.pushDebateHistoryBatch;
    if (typeof pushFn !== 'function') {
      console.warn('[history-flush] pushDebateHistoryBatch not available');
      return;
    }
    var allDebates = listDebates({ includeUnlisted: true });
    // Push the full in-memory history (not just recent points).
    // pushDebateHistoryBatch uses ON CONFLICT DO NOTHING so duplicates are free.
    // This guarantees every point survives even if the per-point push failed.
    var points = [];
    for (var i = 0; i < allDebates.length; i++) {
      var d = allDebates[i];
      if (!d || !d.id || !Array.isArray(d.probabilityHistory)) continue;
      var openedAt = Number(d.openedAt) > 0 ? Number(d.openedAt) - 5000 : 0; // 5s grace
      for (var j = 0; j < d.probabilityHistory.length; j++) {
        var p = d.probabilityHistory[j];
        if (!p || !p.timestamp || !Number.isFinite(p.yesProbability)) continue;
        if (openedAt > 0 && Number(p.timestamp) < openedAt) continue; // skip pre-debate synthetic
        points.push({
          debate_id:   String(d.id),
          recorded_at: Number(p.timestamp),
          yes_prob:    Number(p.yesProbability),
          volume:      Number(p.volume || 0),
        });
      }
    }
    if (!points.length) {
      console.log('[history-flush] nothing to push');
      return;
    }
    // Split into chunks of 500 to stay within PostgREST limits
    var CHUNK = 500;
    var pushed = 0;
    for (var k = 0; k < points.length; k += CHUNK) {
      await pushFn(points.slice(k, k + CHUNK));
      pushed += Math.min(CHUNK, points.length - k);
    }
    console.log('[history-flush] pushed ' + pushed + ' points to Supabase');
  } catch (err) {
    console.error('[history-flush] error:', err.message);
  }
}
setInterval(flushHistoryToSupabase, 5 * 60 * 1000);
setTimeout(flushHistoryToSupabase, 30 * 1000); // first flush 30s after startup

// ─────────────────────────────────────────────────────────────
//  Live-stream monitor — closes debates when stream ends
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  const summary = reconcileDebates();
  const transitions = collectDebateLifecycleTransitions();
  const shouldRefill = summary.closedIds.length > 0 || transitions.some(entry => entry.becameClosed);

  if (summary.closedIds.length) {
    summary.closedIds.forEach(debateId => {
      stopBotsForDebate(debateId);
      _debatesWithBots.delete(String(debateId));

      // ── Auto-settle: distribute points to winners ──────────────
      const closedDebate = getDebateById(String(debateId));
      if (closedDebate && typeof settleDebateBetsAsAdmin === 'function') {
        // Real-event debates (crypto, sports) are validated by auto-validator.js
        // which queries the actual data source before settling.
        const isRealEvent = closedDebate.predictionSourceType === 'crypto' ||
          closedDebate.predictionSourceType === 'sports';

        if (!isRealEvent) {
          // Fallback: crowd-vote settlement for non-sourced debates (news / live streams)
          const winnerSide = closedDebate.winnerSide ||
            (Number(closedDebate.yesPct) >= 50 ? 'yes' : 'no');
          const winnerPct = winnerSide === 'yes'
            ? Number(closedDebate.yesPct)
            : 100 - Number(closedDebate.yesPct);
          const odds = (winnerPct > 0 && winnerPct < 100)
            ? Math.round((100 / winnerPct) * 100) / 100
            : 2.0;

          settleDebateBetsAsAdmin(String(debateId), winnerSide, odds, {
            reason: 'auto_timer_expiry',
            closedAt: closedDebate.closedAt,
          }).then(result => {
            if (result && result.settledCount > 0) {
              console.log(`[settle] debate ${debateId} → side=${winnerSide} odds=${odds} bets=${result.settledCount} winners=${result.winners}`);
            }
            io.to(String(debateId)).emit('prediction:settled', {
              debateId: String(debateId),
              winnerSide,
              winnerLabel: closedDebate.winnerLabel ||
                (winnerSide === 'yes' ? closedDebate.yesLabel : closedDebate.noLabel),
              odds,
              settledCount: result?.settledCount || 0,
              winners: result?.winners || 0,
              totalGain: result?.totalGain || 0,
            });
          }).catch(err => {
            console.warn(`[settle] auto-settle failed for debate ${debateId}:`, err.message);
          });
        }
        // If isRealEvent → auto-validator.js will handle it within 30s
      }
    });
  }

  transitions.forEach(({ debate, becameClosed }) => {
    if (becameClosed) {
      stopBotsForDebate(debate.id);
      _debatesWithBots.delete(String(debate.id));
    }
    broadcastDebate(debate.id);
  });

  if (shouldRefill) {
    runNewsMaintenance({ reason: 'debate_closed' }).catch(error => {
      console.warn('[news] debate_closed run failed', error);
    });
  }

  // Emergency refill: if active debates drop very low, force immediate maintenance
  if (countActiveDebates() < 30) {
    console.warn('[predictions] emergency refill — fewer than 30 active predictions globally');
    runNewsMaintenance({ reason: 'emergency_refill' }).catch(error => {
      console.warn('[predictions] emergency_refill run failed', error);
    });
  }
}, 5000);

// ─────────────────────────────────────────────────────────────
//  Health check — required by Render (and any load-balancer)
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const runtimeConfig = getRuntimeConfigStatus();
  const healthy = runtimeConfig.supabasePublicConfigured && runtimeConfig.supabaseServiceRoleConfigured;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
    debates: countActiveDebates(),
    socketPath: '/socket.io',
    render: {
      detected: String(process.env.RENDER || '').toLowerCase() === 'true',
      service: process.env.RENDER_SERVICE_NAME || null,
      url: RENDER_EXTERNAL_URL || null,
    },
    config: {
      supabasePublicConfigured: runtimeConfig.supabasePublicConfigured,
      supabaseServiceRoleConfigured: runtimeConfig.supabaseServiceRoleConfigured,
      stripeConfigured: stripeLib.isConfigured(),
      resendConfigured: Boolean(String(process.env.RESEND_API_KEY || '').trim()),
      tremendousConfigured: Boolean(String(process.env.TREMENDOUS_API_KEY || '').trim()),
    },
    cors: {
      allowedOrigins: ALLOWED_ORIGINS,
      allowVercelPreviews: ALLOW_VERCEL_PREVIEWS,
    },
    errors: runtimeConfig.errors,
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBEEEF backend running on port ${PORT}`);
  console.log(`ENV  : ${IS_PRODUCTION ? 'production' : 'development'}${RENDER_EXTERNAL_URL ? ` | ${RENDER_EXTERNAL_URL}` : ''}`);
  console.log(`CORS : ${ALLOWED_ORIGINS.join(', ')}${ALLOW_VERCEL_PREVIEWS ? ' | vercel previews enabled' : ''}`);
  console.log('REST : GET /health | GET /public/config | GET /debates | GET /debates/:id');
  console.log('ALIAS: GET /api/public/config | GET /api/predictions | GET /api/predictions/:id | GET /api/predictions/:id/history | GET /api/news/status | GET /api/me/balance');
  console.log('SYNC : GET /me/bootstrap | PUT /me/profile | POST /me/bets');
  console.log('AUTH : Bearer token Supabase requis sur les routes /me/*');
  console.log('NEWS : BBC + Guardian + NPR + AlJazeera + France24 + LeMonde + GDELT');
  console.log(`STRIPE: ${stripeLib.isConfigured() ? 'configured ✓' : 'NOT configured - set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET'}`);
  console.log('WS   : subscribe_stats | debate_state | prediction:update\n');
});
