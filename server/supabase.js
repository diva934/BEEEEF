const DEFAULT_BALANCE = 0;

// ── Admin user IDs (UUID Supabase) ────────────────────────
const ADMIN_USER_IDS = new Set([
  '929ce9c7-0d37-4f70-9c59-7ca5c3044d2f', // pierrick — divaaa.agency@gmail.com
]);

function isAdminUser(userId) {
  return ADMIN_USER_IDS.has(String(userId || ''));
}

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

function firstEnv(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function getConfig() {
  const url = firstEnv(
    'SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_URL',
    'VITE_SUPABASE_URL',
    'PUBLIC_SUPABASE_URL'
  ).replace(/\/+$/, '');
  const publishableKey = firstEnv(
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_SUPABASE_ANON_KEY',
    'PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'PUBLIC_SUPABASE_ANON_KEY'
  );

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

function getRuntimeConfigStatus() {
  const errors = [];
  let publicConfig = null;

  try {
    publicConfig = getPublicConfig();
  } catch (error) {
    errors.push(error.message || 'SUPABASE public config missing');
  }

  const serviceRoleConfigured = Boolean(firstEnv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE'
  ));

  if (!serviceRoleConfigured) {
    errors.push('SUPABASE_SERVICE_ROLE_KEY missing');
  }

  return {
    supabasePublicConfigured: Boolean(publicConfig?.supabaseUrl && publicConfig?.supabasePublishableKey),
    supabaseServiceRoleConfigured: serviceRoleConfigured,
    supabaseUrl: publicConfig?.supabaseUrl || '',
    errors,
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
    isAdmin: isAdminUser(profile.id),
    createdAt: profile.created_at || authUser?.created_at || new Date().toISOString(),
    updatedAt: profile.updated_at || authUser?.updated_at || new Date().toISOString(),
  };
}

function normalizeBet(row) {
  const status = ['pending', 'won', 'lost', 'refunded'].includes(row.status)
    ? row.status
    : 'pending';
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
    status,
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

  const serviceKey = firstEnv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE'
  );
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

// ──────────────────────────────────────────────────────────────────
//  Redeem gift card — deducts tokens from user balance
// ──────────────────────────────────────────────────────────────────
async function getProfileBalance(userId) {
  if (!userId) throw createError('userId requis', 400);

  const { url } = getConfig();
  const headers = getServiceHeaders();
  const getRes = await fetch(new URL(`/rest/v1/profiles?id=eq.${userId}&select=id,balance`, url), { headers });
  const current = await getRes.json().catch(() => []);
  const row = Array.isArray(current) ? current[0] : null;
  if (!row) throw createError(`Profil ${userId} introuvable`, 404);

  return {
    id: row.id,
    balance: Number(row.balance || 0),
  };
}

async function redeemGiftCard(userId, pointsCost, meta = {}) {
  const cost = Math.round(Number(pointsCost) || 0);
  if (!userId || cost <= 0) throw createError('userId + pointsCost requis', 400);

  const { url } = getConfig();
  const headers = getServiceHeaders();
  const profile = await getProfileBalance(userId);
  const currentBalance = Number(profile.balance || 0);
  if (currentBalance < cost) throw createError(`Solde insuffisant — il te faut ${cost} pts, tu as ${currentBalance} pts`, 400);

  const newBalance = currentBalance - cost;

  const patchRes = await fetch(new URL(`/rest/v1/profiles?id=eq.${userId}`, url), {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ balance: newBalance }),
  });
  if (!patchRes.ok) {
    const errText = await patchRes.text();
    throw createError(`Erreur déduction Supabase: ${patchRes.status} ${errText}`, 502);
  }

  const txRes = await fetch(new URL('/rest/v1/token_transactions', url), {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      type: 'gift_redemption',
      amount: -cost,
      metadata: {
        brand: meta.brand || null,
        valueEur: meta.valueEur || null,
        email: meta.email || null,
        orderId: meta.orderId || null,
        reason: meta.reason || 'gift_points_reserved',
      },
    }),
  });
  const txRows = await txRes.json().catch(() => []);
  const redemptionId = Array.isArray(txRows) && txRows[0] ? txRows[0].id : `gift_${Date.now()}`;

  console.log(`[gifts] ${userId} redeemed ${cost} pts → ${meta.brand} ${meta.valueEur}€ — balance=${newBalance}`);
  return { userId, reserved: cost, newBalance, redemptionId };
}

// ──────────────────────────────────────────────────────────────────
//  Gift card orders — CRUD helpers (service role)
// ──────────────────────────────────────────────────────────────────

function getServiceHeaders() {
  const serviceKey = firstEnv(
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SERVICE_KEY',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE'
  );
  if (!serviceKey) throw createError('SUPABASE_SERVICE_ROLE_KEY manquante', 500);
  return {
    apikey:        serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer:        'return=representation',
  };
}

function getServiceRestUrl(path, params = {}) {
  const { url } = getConfig();
  const target = new URL(path.startsWith('/') ? path : `/${path}`, url);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    target.searchParams.set(key, String(value));
  });
  return target;
}

async function serviceRoleFetchJson(target, options = {}) {
  const response = await fetch(target, {
    headers: getServiceHeaders(),
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw createError(`Supabase service role error: ${response.status}`, 502, payload);
  }
  return payload;
}

async function listPendingBetsForDebateAsAdmin(debateId) {
  if (!debateId) throw createError('debateId requis', 400);
  const target = getServiceRestUrl('/rest/v1/bets', {
    debate_id: `eq.${debateId}`,
    status: 'eq.pending',
    select: 'id,user_id,debate_id,side,amt,title,category,kind,yes_label,no_label,created_at',
    order: 'created_at.asc',
  });
  const rows = await serviceRoleFetchJson(target);
  return Array.isArray(rows) ? rows : [];
}

async function getProfileBalanceAsAdmin(userId) {
  if (!userId) throw createError('userId requis', 400);
  const target = getServiceRestUrl('/rest/v1/profiles', {
    id: `eq.${userId}`,
    select: 'id,balance',
    limit: 1,
  });
  const rows = await serviceRoleFetchJson(target);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw createError(`Profil ${userId} introuvable`, 404);
  return {
    id: row.id,
    balance: Number(row.balance || 0),
  };
}

async function patchProfileBalanceAsAdmin(userId, nextBalance) {
  const target = getServiceRestUrl('/rest/v1/profiles', {
    id: `eq.${userId}`,
  });
  await serviceRoleFetchJson(target, {
    method: 'PATCH',
    body: JSON.stringify({ balance: roundCurrency(nextBalance) }),
  });
}

async function insertTokenTransactionAsAdmin(row) {
  const target = getServiceRestUrl('/rest/v1/token_transactions');
  await serviceRoleFetchJson(target, {
    method: 'POST',
    headers: { ...getServiceHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

async function patchBetAsAdmin(betId, patch) {
  const target = getServiceRestUrl('/rest/v1/bets', {
    id: `eq.${betId}`,
  });
  return serviceRoleFetchJson(target, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

async function deleteBetAsAdmin(betId) {
  const target = getServiceRestUrl('/rest/v1/bets', {
    id: `eq.${betId}`,
  });
  await serviceRoleFetchJson(target, {
    method: 'DELETE',
    headers: { ...getServiceHeaders(), Prefer: 'return=minimal' },
  });
}

async function settleDebateBetsAsAdmin(debateId, winnerSide, _oddsHint, meta = {}) {
  if (!debateId) throw createError('debateId requis', 400);
  if (!['yes', 'no'].includes(winnerSide)) throw createError('winnerSide invalide', 400);

  const rows = await listPendingBetsForDebateAsAdmin(debateId);
  if (!rows.length) {
    return { debateId: String(debateId), settledCount: 0, totalGain: 0, totalLoss: 0, winners: 0, odds: null };
  }

  // ── Compute real parimutuel odds from actual bets ──────────────────────────
  // Winners split the ENTIRE pool (their stake + all loser stakes).
  // odds = totalPool / winnerSidePool  →  each winner gets back betAmt × odds
  // This guarantees losers' tokens flow exactly to winners, nothing more, nothing less.
  let totalPool = 0;
  let winnerPool = 0;
  for (const bet of rows) {
    const amt = roundCurrency(bet.amt || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    totalPool += amt;
    if (bet.side === winnerSide) winnerPool += amt;
  }

  // If nobody bet on the winning side → refund everyone (edge case)
  if (winnerPool <= 0) {
    console.warn(`[settle] debate ${debateId}: no bets on winning side (${winnerSide}) — refunding all`);
    return refundDebateBetsAsAdmin(debateId, { reason: 'no_winners_on_side' });
  }

  // Parimutuel odds: how much each winner token earns back from the whole pool
  const realOdds = roundCurrency(totalPool / winnerPool);

  const creditByUser = new Map();
  const winTransactions = [];
  let settledCount = 0;
  let totalGain = 0;
  let totalLoss = 0;
  let winners = 0;
  const settledAt = new Date().toISOString();

  for (const bet of rows) {
    const amount = roundCurrency(bet.amt || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const won = bet.side === winnerSide;
    // Winner gets back: betAmount × (totalPool / winnerPool)
    // Loser payout is negative (already paid when placing — just marks the record)
    const payout = won ? roundCurrency(amount * realOdds) : roundCurrency(-amount);

    await patchBetAsAdmin(bet.id, {
      status: won ? 'won' : 'lost',
      payout,
      settled_at: settledAt,
    });

    if (won) {
      winners += 1;
      totalGain += payout;
      creditByUser.set(
        bet.user_id,
        roundCurrency((creditByUser.get(bet.user_id) || 0) + payout)
      );
      winTransactions.push({
        user_id: bet.user_id,
        type: 'win',
        amount: payout,
        debate_id: String(debateId),
        metadata: {
          source: 'prediction_auto_settlement',
          winnerSide,
          odds: realOdds,
          totalPool: roundCurrency(totalPool),
          winnerPool: roundCurrency(winnerPool),
          settledAt,
          reason: meta.reason || 'validated_prediction',
        },
      });
    } else {
      totalLoss += amount;
    }

    settledCount += 1;
  }

  // Credit winners — their balance increases by their proportional share of the pool
  for (const [userId, creditAmount] of creditByUser.entries()) {
    if (!creditAmount) continue;
    const profile = await getProfileBalanceAsAdmin(userId);
    await patchProfileBalanceAsAdmin(userId, profile.balance + creditAmount);
  }

  for (const row of winTransactions) {
    await insertTokenTransactionAsAdmin(row);
  }

  console.log(`[settle] ${debateId} → side=${winnerSide} pool=${roundCurrency(totalPool)} winnerPool=${roundCurrency(winnerPool)} odds=${realOdds} settled=${settledCount} winners=${winners}`);

  return {
    debateId: String(debateId),
    settledCount,
    totalGain: roundCurrency(totalGain),
    totalLoss: roundCurrency(totalLoss),
    winners,
    odds: realOdds,
    totalPool: roundCurrency(totalPool),
    winnerPool: roundCurrency(winnerPool),
  };
}

async function refundDebateBetsAsAdmin(debateId, meta = {}) {
  if (!debateId) throw createError('debateId requis', 400);
  const rows = await listPendingBetsForDebateAsAdmin(debateId);
  if (!rows.length) {
    return { debateId: String(debateId), refundedCount: 0, totalRefunded: 0, users: 0 };
  }

  const refundByUser = new Map();
  const refundTransactions = [];
  let refundedCount = 0;
  let totalRefunded = 0;
  const refundedAt = new Date().toISOString();

  for (const bet of rows) {
    const amount = roundCurrency(bet.amt || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    try {
      await patchBetAsAdmin(bet.id, {
        status: 'refunded',
        payout: amount,
        settled_at: refundedAt,
      });
    } catch (error) {
      await deleteBetAsAdmin(bet.id);
    }

    refundByUser.set(
      bet.user_id,
      roundCurrency((refundByUser.get(bet.user_id) || 0) + amount)
    );
    totalRefunded += amount;
    refundedCount += 1;

    refundTransactions.push({
      user_id: bet.user_id,
      type: 'refund',
      amount,
      debate_id: String(debateId),
      metadata: {
        source: 'prediction_auto_refund',
        refundedAt,
        reason: meta.reason || 'prediction_cancelled',
      },
    });
  }

  for (const [userId, refundAmount] of refundByUser.entries()) {
    if (!refundAmount) continue;
    const profile = await getProfileBalanceAsAdmin(userId);
    await patchProfileBalanceAsAdmin(userId, profile.balance + refundAmount);
  }

  for (const row of refundTransactions) {
    await insertTokenTransactionAsAdmin(row);
  }

  return {
    debateId: String(debateId),
    refundedCount,
    totalRefunded: roundCurrency(totalRefunded),
    users: refundByUser.size,
  };
}

async function checkDuplicateGiftOrder(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const res = await fetch(
    new URL(
      `/rest/v1/gift_card_orders?user_id=eq.${userId}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,status&limit=1`,
      url
    ),
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function createGiftOrder({
  userId,
  email,
  brand,
  valueEur,
  pointsCost,
  idempotencyKey,
  status = 'pending_review',
  provider = 'manual_admin',
  statusHistory,
}) {
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const now = new Date().toISOString();
  const res = await fetch(new URL('/rest/v1/gift_card_orders', url), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id:          userId,
      email,
      gift_card_brand:  brand,
      gift_card_value:  valueEur,
      points_cost:      pointsCost,
      status,
      idempotency_key:  idempotencyKey || null,
      provider,
      status_history:   Array.isArray(statusHistory) ? statusHistory : [{ status, at: now, source: 'user_request' }],
      created_at:       now,
      updated_at:       now,
    }),
  });
  const rows = await res.json().catch(() => []);
  if (!res.ok) {
    const msg = Array.isArray(rows) ? rows[0]?.message : rows?.message;
    throw createError(`Erreur création commande: ${msg || res.status}`, 502);
  }
  return Array.isArray(rows) ? rows[0] : rows;
}

async function getGiftOrderById(orderId) {
  if (!orderId) throw createError('orderId requis', 400);
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const res = await fetch(
    new URL(`/rest/v1/gift_card_orders?id=eq.${orderId}&select=*&limit=1`, url),
    { headers }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw createError(`Erreur lecture commande cadeau: ${res.status} ${text}`, 502);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function listGiftOrders({ limit = 50, status } = {}) {
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('order', 'created_at.desc');
  params.set('limit', String(Math.min(200, Math.max(1, Number(limit) || 50))));
  if (status) params.set('status', `eq.${status}`);

  const res = await fetch(new URL(`/rest/v1/gift_card_orders?${params.toString()}`, url), { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw createError(`Erreur liste commandes cadeau: ${res.status} ${text}`, 502);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function findOpenGiftOrder(userId, brand, valueEur) {
  if (!userId || !brand || !valueEur) return null;
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const res = await fetch(
    new URL(
      `/rest/v1/gift_card_orders?user_id=eq.${userId}&gift_card_brand=eq.${brand}&gift_card_value=eq.${Number(valueEur)}&status=in.(pending_review,points_reserved,gift_ready)&select=id,status,created_at&order=created_at.desc&limit=1`,
      url
    ),
    { headers }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function updateGiftOrder(orderId, updates) {
  const { url } = getConfig();
  const headers = getServiceHeaders();
  const patch = { ...updates, updated_at: new Date().toISOString() };
  const res = await fetch(new URL(`/rest/v1/gift_card_orders?id=eq.${orderId}`, url), {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  const rows = await res.json().catch(() => []);
  if (!res.ok) {
    const msg = Array.isArray(rows) ? rows[0]?.message : rows?.message;
    throw createError(`Erreur mise Ã  jour commande cadeau: ${msg || res.status}`, 502);
  }
  return Array.isArray(rows) ? rows[0] || null : rows;
}

function buildGiftStatusHistoryEntry(status, meta = {}) {
  return {
    status,
    at: new Date().toISOString(),
    ...meta,
  };
}

async function transitionGiftOrder(orderId, {
  status,
  adminId,
  adminNote,
  giftCode,
  errorMessage,
  extra = {},
  historyMeta = {},
} = {}) {
  if (!orderId || !status) throw createError('orderId + status requis', 400);

  const order = await getGiftOrderById(orderId);
  if (!order) throw createError('Commande cadeau introuvable', 404);

  const statusHistory = Array.isArray(order.status_history) ? order.status_history.slice() : [];
  statusHistory.push(buildGiftStatusHistoryEntry(status, {
    adminId: adminId || null,
    note: adminNote || null,
    error: errorMessage || null,
    ...historyMeta,
  }));

  const patch = {
    ...extra,
    status,
    status_history: statusHistory,
  };

  if (adminId) patch.processed_by_admin_id = adminId;
  if (adminNote !== undefined) patch.admin_note = adminNote || null;
  if (giftCode !== undefined) patch.gift_code = giftCode || null;
  if (errorMessage !== undefined) patch.error_message = errorMessage || null;

  const now = new Date().toISOString();
  if (status === 'points_reserved') patch.reserved_at = now;
  if (status === 'gift_ready') patch.ready_at = now;
  if (status === 'gift_sent') patch.sent_at = now;
  if (status === 'points_refunded') patch.refunded_at = now;

  return updateGiftOrder(orderId, patch);
}

async function refundGiftPoints(userId, orderId, pointsCost, meta = {}) {
  const { url } = getConfig();
  const headers = getServiceHeaders();

  // Fetch current balance
  const profile = await getProfileBalance(userId);

  const newBalance = Number(profile.balance || 0) + Number(pointsCost || 0);

  await fetch(new URL(`/rest/v1/profiles?id=eq.${userId}`, url), {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ balance: newBalance }),
  });

  // Log refund transaction
  try {
    await fetch(new URL('/rest/v1/token_transactions', url), {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        type:    'gift_refund',
        amount:  Number(pointsCost || 0),
        metadata: {
          orderId,
          reason: meta.reason || 'gift_unavailable',
          brand: meta.brand || null,
          valueEur: meta.valueEur || null,
        },
      }),
    });
  } catch (_) { /* non-fatal */ }

  console.log(`[gifts] refunded ${pointsCost} pts to ${userId} (order=${orderId}) → balance=${newBalance}`);
  return { userId, refunded: pointsCost, newBalance };
}

// ──────────────────────────────────────────────────────────────────
//  Debate history — persistent storage in Supabase
//  Table: debate_history (debate_id, recorded_at, yes_prob, volume)
// ──────────────────────────────────────────────────────────────────

/**
 * Push one or more history points to Supabase (fire-and-forget friendly).
 * ON CONFLICT DO NOTHING via "resolution=ignore-duplicates" so duplicate
 * (debate_id, recorded_at) rows are silently skipped.
 */
async function pushDebateHistoryBatch(points) {
  if (!Array.isArray(points) || !points.length) return;
  try {
    const target = getServiceRestUrl('/rest/v1/debate_history');
    await serviceRoleFetchJson(target, {
      method: 'POST',
      headers: {
        ...getServiceHeaders(),
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify(points),
    });
  } catch (err) {
    console.warn('[debate-history] push failed (non-fatal):', err.message);
  }
}

/**
 * Fetch stored history points for a debate from Supabase.
 * Returns array sorted asc by recorded_at.
 */
async function pullDebateHistory(debateId, fromTs = 0, limit = 2000) {
  if (!debateId) return [];
  try {
    const target = getServiceRestUrl('/rest/v1/debate_history', {
      debate_id:   `eq.${debateId}`,
      recorded_at: `gte.${Math.max(0, Number(fromTs) || 0)}`,
      select:      'recorded_at,yes_prob,volume',
      order:       'recorded_at.asc',
      limit:       String(Math.min(2000, Math.max(1, Number(limit) || 2000))),
    });
    const rows = await serviceRoleFetchJson(target);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn('[debate-history] pull failed (non-fatal):', err.message);
    return [];
  }
}

module.exports = {
  autoSettleDebates,
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
  listTokenTransactions,
  placeBet,
  pullDebateHistory,
  pushDebateHistoryBatch,
  redeemGiftCard,
  refundDebateBetsAsAdmin,
  refundGiftPoints,
  settleDebateBetsAsAdmin,
  transitionGiftOrder,
  settleDebateBets,
  updateGiftOrder,
  updateProfile,
  verifyAccessToken,
};
