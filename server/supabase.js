const DEFAULT_BALANCE = 2840;

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
  if (!Number.isFinite(depositAmount) || depositAmount < 10) {
    throw createError('Montant invalide');
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
    throw createError('Montant invalide');
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

module.exports = {
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
};
