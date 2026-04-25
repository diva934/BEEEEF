const DEFAULT_BALANCE = 0;

function createError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) {
    error.details = details;
  }
  return error;
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function getConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const publishableKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || ''
  ).trim();

  if (!url || !publishableKey) {
    throw createError(
      'Variables manquantes: SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY',
      500
    );
  }

  return { url, publishableKey };
}

function getPublicConfig() {
  const { url, publishableKey } = getConfig();
  return {
    supabaseUrl: url,
    supabasePublishableKey: publishableKey,
  };
}

function parseJsonSafely(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function normalizeSupabaseError(status, payload, fallbackMessage) {
  const message =
    payload?.message ||
    payload?.error_description ||
    payload?.error ||
    fallbackMessage;

  if (status === 401 || status === 403) {
    return createError(message || 'Session invalide', status, payload);
  }

  if (status >= 400 && status < 500) {
    return createError(message || 'Requete invalide', status, payload);
  }

  return createError(message || 'Supabase indisponible', 502, payload);
}

async function supabaseFetch(path, { method = 'GET', token = '', body, headers = {}, expectJson = true } = {}) {
  const { url, publishableKey } = getConfig();
  const target = new URL(path.startsWith('/') ? path : `/${path}`, url);
  const requestHeaders = {
    apikey: publishableKey,
    ...headers,
  };

  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  let payloadBody = body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    requestHeaders['Content-Type'] = 'application/json';
    payloadBody = JSON.stringify(body);
  }

  const response = await fetch(target, {
    method,
    headers: requestHeaders,
    body: payloadBody,
  });

  const raw = await response.text();
  const payload = expectJson ? parseJsonSafely(raw) : raw;

  if (!response.ok) {
    throw normalizeSupabaseError(response.status, payload, raw || 'Erreur Supabase');
  }

  return expectJson ? payload : raw;
}

async function verifyAccessToken(token) {
  if (!token) {
    throw createError('Missing token', 401);
  }

  const user = await supabaseFetch('/auth/v1/user', { token });
  if (!user?.id) {
    throw createError('Session invalide', 401);
  }

  return user;
}

function normalizeProfile(profile, authUser) {
  return {
    id: profile.id,
    email: authUser?.email || profile.email || '',
    username:
      profile.username ||
      authUser?.user_metadata?.username ||
      authUser?.email?.split('@')[0] ||
      'Utilisateur',
    balance: roundCurrency(profile.balance || 0),
    region: profile.region || null,
    langs: Array.isArray(profile.langs) ? uniqueStrings(profile.langs) : [],
    phone: profile.phone || '',
    twoFactorEnabled: Boolean(profile.two_factor_enabled),
    createdAt: profile.created_at || authUser?.created_at || new Date().toISOString(),
    updatedAt: profile.updated_at || authUser?.updated_at || new Date().toISOString(),
  };
}

function normalizeBet(row) {
  return {
    id: row.id,
    debateId: row.debate_id,
    title: row.title,
    category: row.category || row.cat || 'general',
    cat: row.cat || row.category || 'general',
    side: row.side,
    yesLabel: row.yes_label || 'OUI',
    noLabel: row.no_label || 'NON',
    kind: row.kind || 'market',
    amt: roundCurrency(row.amt || 0),
    status: row.status || 'pending',
    payout: roundCurrency(row.payout || 0),
    ts: row.created_at,
    settledAt: row.settled_at || null,
  };
}

function buildQuery(path, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, String(value));
  });
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function restList(table, token, params = {}) {
  const path = buildQuery(`/rest/v1/${table}`, params);
  const payload = await supabaseFetch(path, { token });
  return Array.isArray(payload) ? payload : [];
}

async function restInsert(table, token, row, { prefer = 'return=representation' } = {}) {
  const payload = await supabaseFetch(`/rest/v1/${table}`, {
    method: 'POST',
    token,
    headers: {
      Prefer: prefer,
    },
    body: row,
  });

  return Array.isArray(payload) ? payload[0] || null : payload;
}

async function restPatch(table, token, params, patch) {
  const path = buildQuery(`/rest/v1/${table}`, params);
  const payload = await supabaseFetch(path, {
    method: 'PATCH',
    token,
    headers: {
      Prefer: 'return=representation',
    },
    body: patch,
  });

  return Array.isArray(payload) ? payload[0] || null : payload;
}

async function callRpc(name, token, params = {}) {
  return supabaseFetch(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    token,
    body: params,
  });
}

async function fetchProfile(token, userId) {
  const rows = await restList('profiles', token, {
    id: `eq.${userId}`,
    select: '*',
    limit: 1,
  });
  return rows[0] || null;
}

async function createProfile(token, authUser) {
  return restInsert('profiles', token, {
    id: authUser.id,
    email: authUser.email || '',
    username:
      String(authUser?.user_metadata?.username || '').trim() ||
      authUser.email?.split('@')[0] ||
      'Utilisateur',
    balance: DEFAULT_BALANCE,
    region: null,
    langs: [],
    phone: '',
    two_factor_enabled: false,
  });
}

async function ensureProfile(token, authUser) {
  let profile = await fetchProfile(token, authUser.id);

  if (!profile) {
    profile = await createProfile(token, authUser);
    return profile;
  }

  const syncPatch = {};
  if (authUser.email && profile.email !== authUser.email) {
    syncPatch.email = authUser.email;
  }

  const metadataUsername = String(authUser?.user_metadata?.username || '').trim();
  if ((!profile.username || profile.username === 'Utilisateur') && metadataUsername) {
    syncPatch.username = metadataUsername;
  }

  if (Object.keys(syncPatch).length > 0) {
    profile = await restPatch(
      'profiles',
      token,
      { id: `eq.${authUser.id}` },
      syncPatch
    );
  }

  return profile;
}

async function listBets(token, userId) {
  const rows = await restList('bets', token, {
    user_id: `eq.${userId}`,
    select: '*',
    order: 'created_at.desc',
  });

  return rows.map(normalizeBet);
}

async function bootstrapState(token, authUser) {
  const profile = await ensureProfile(token, authUser);
  const bets = await listBets(token, authUser.id);

  return {
    user: normalizeProfile(profile, authUser),
    bets,
  };
}

async function updateProfile(token, authUser, updates) {
  await ensureProfile(token, authUser);

  const patch = {};

  if (typeof updates.username === 'string' && updates.username.trim()) {
    patch.username = updates.username.trim();
  }

  if (typeof updates.region === 'string') {
    patch.region = updates.region.trim() || null;
  } else if (updates.region === null) {
    patch.region = null;
  }

  if (Array.isArray(updates.langs)) {
    patch.langs = uniqueStrings(updates.langs);
  }

  if (typeof updates.phone === 'string') {
    patch.phone = updates.phone.trim();
  }

  if (typeof updates.twoFactorEnabled === 'boolean') {
    patch.two_factor_enabled = updates.twoFactorEnabled;
  }

  if (Object.keys(patch).length > 0) {
    await restPatch('profiles', token, { id: `eq.${authUser.id}` }, patch);
  }

  return bootstrapState(token, authUser);
}

async function depositBalance(token, authUser, amount) {
  const depositAmount = roundCurrency(amount);
  if (!Number.isFinite(depositAmount) || depositAmount < 100) {
    throw createError('Nombre de points invalide');
  }

  await ensureProfile(token, authUser);
  await callRpc('deposit_balance', token, { p_amount: depositAmount });

  return {
    ...(await bootstrapState(token, authUser)),
    depositAmount,
  };
}

async function placeBet(token, authUser, payload) {
  const amount = roundCurrency(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createError('Nombre de points invalide');
  }

  await ensureProfile(token, authUser);
  await callRpc('place_bet', token, {
    p_debate_id: String(payload.debateId || ''),
    p_title: String(payload.title || 'Debat'),
    p_category: String(payload.category || payload.cat || 'general'),
    p_side: payload.side === 'no' ? 'no' : payload.side === 'yes' ? 'yes' : '',
    p_yes_label: String(payload.yesLabel || 'OUI'),
    p_no_label: String(payload.noLabel || 'NON'),
    p_amount: amount,
    p_kind: payload.kind === 'participant' ? 'participant' : 'market',
  });

  return bootstrapState(token, authUser);
}

async function settleDebateBets(token, authUser, payload) {
  await ensureProfile(token, authUser);
  const settlement = await callRpc('settle_debate_bets', token, {
    p_debate_id: String(payload.debateId || ''),
    p_winner_side: payload.winnerSide === 'no' ? 'no' : payload.winnerSide === 'yes' ? 'yes' : '',
    p_odds: roundCurrency(payload.odds),
  });

  return {
    ...(await bootstrapState(token, authUser)),
    settlement,
  };
}

async function autoSettleDebates(token, authUser, debates = []) {
  await ensureProfile(token, authUser);
  const settlements = [];

  for (const debate of debates) {
    if (!debate || !debate.debateId || !debate.winnerSide) continue;

    const payoutOdds = roundCurrency(debate.odds);
    if (!Number.isFinite(payoutOdds) || payoutOdds <= 1) continue;

    const settlement = await callRpc('settle_debate_bets', token, {
      p_debate_id: String(debate.debateId),
      p_winner_side: debate.winnerSide === 'no' ? 'no' : 'yes',
      p_odds: payoutOdds,
    });

    if (settlement?.settledCount) {
      settlements.push(settlement);
    }
  }

  return settlements;
}

async function cancelParticipantBet(token, authUser, debateId) {
  await ensureProfile(token, authUser);
  await callRpc('cancel_participant_bet', token, {
    p_debate_id: String(debateId || ''),
  });
  return bootstrapState(token, authUser);
}

async function forfeitParticipantBet(token, authUser, debateId) {
  await ensureProfile(token, authUser);
  await callRpc('forfeit_participant_bet', token, {
    p_debate_id: String(debateId || ''),
  });
  return bootstrapState(token, authUser);
}

// ──────────────────────────────────────────────────────────────────
//  Admin credit (used by Stripe webhook — no user token needed)
//  Requires SUPABASE_SERVICE_ROLE_KEY in env.
//
//  Idempotent: if meta.sessionId already exists in token_transactions,
//  the credit is skipped and the existing record is returned.
// ──────────────────────────────────────────────────────────────────
async function creditBalanceAsAdmin(userId, points, meta = {}) {
  const amount = Math.max(0, Math.round(Number(points) || 0));
  if (!userId || !amount) {
    throw createError('creditBalanceAsAdmin: userId + points required', 400);
  }

  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!serviceKey) {
    throw createError('SUPABASE_SERVICE_ROLE_KEY manquante — webhook Stripe ne peut créditer', 500);
  }

  const { url } = getConfig();
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // ── Idempotence check ──────────────────────────────────────────
  // If this Stripe session was already processed, skip to avoid double credit.
  if (meta.sessionId) {
    const dupRes = await fetch(
      new URL(`/rest/v1/token_transactions?stripe_session_id=eq.${encodeURIComponent(meta.sessionId)}&select=id&limit=1`, url),
      { headers }
    );
    if (dupRes.ok) {
      const dups = await dupRes.json();
      if (Array.isArray(dups) && dups.length > 0) {
        console.log(`[stripe] IDEMPOTENT skip: session ${meta.sessionId} already credited`);
        return { userId, credited: 0, newBalance: null, duplicate: true };
      }
    }
  }

  // ── Fetch current balance ──────────────────────────────────────
  const getRes = await fetch(
    new URL(`/rest/v1/profiles?id=eq.${userId}&select=id,balance`, url),
    { headers }
  );
  const current = await getRes.json();
  const row = Array.isArray(current) ? current[0] : null;
  if (!row) {
    throw createError(`Profil ${userId} introuvable`, 404);
  }

  const newBalance = Number(row.balance || 0) + amount;

  // ── Patch balance ──────────────────────────────────────────────
  const patchRes = await fetch(
    new URL(`/rest/v1/profiles?id=eq.${userId}`, url),
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ balance: newBalance }),
    }
  );

  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw createError(`Erreur crédit Supabase: ${patchRes.status} ${errText}`, 502);
  }

  // ── Log transaction ────────────────────────────────────────────
  try {
    await fetch(new URL('/rest/v1/token_transactions', url), {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        type: 'purchase',
        amount,
        stripe_session_id: meta.sessionId || null,
        metadata: {
          packId: meta.packId || null,
          amountPaidCents: meta.amountPaidCents || null,
          email: meta.email || null,
        },
      }),
    });
  } catch (logErr) {
    // Non-fatal — balance is already credited, just log the failure
    console.warn('[stripe] transaction log failed (non-fatal):', logErr.message);
  }

  console.log(`[stripe] credited ${amount} pts to ${userId} (pack=${meta.packId || '-'} session=${meta.sessionId || '-'}) → balance=${newBalance}`);
  return { userId, credited: amount, newBalance };
}

// ──────────────────────────────────────────────────────────────────
//  List token transactions for a user (requires user JWT token)
// ──────────────────────────────────────────────────────────────────
async function listTokenTransactions(token, userId, { limit = 50 } = {}) {
  const rows = await restList('token_transactions', token, {
    user_id: `eq.${userId}`,
    select: 'id,type,amount,stripe_session_id,debate_id,metadata,created_at',
    order: 'created_at.desc',
    limit,
  });

  return rows.map(row => ({
    id: row.id,
    type: row.type,
    amount: Number(row.amount || 0),
    stripeSessionId: row.stripe_session_id || null,
    debateId: row.debate_id || null,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  }));
}

module.exports = {
  autoSettleDebates,
  bootstrapState,
  cancelParticipantBet,
  createError,
  creditBalanceAsAdmin,
  depositBalance,
  forfeitParticipantBet,
  getPublicConfig,
  listTokenTransactions,
  placeBet,
  settleDebateBets,
  updateProfile,
  verifyAccessToken,
};
