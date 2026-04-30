const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BALANCE = 2840;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function nowIso() {
  return new Date().toISOString();
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function createError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseStore() {
  return {
    users: [],
    sessions: [],
  };
}

function sanitizeBet(bet) {
  if (!bet || typeof bet !== 'object') return null;

  const amount = roundCurrency(bet.amt);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    id: String(bet.id || crypto.randomUUID()),
    debateId: String(bet.debateId || ''),
    title: String(bet.title || 'Debat'),
    category: String(bet.category || bet.cat || 'general'),
    cat: String(bet.cat || bet.category || 'general'),
    side: bet.side === 'no' ? 'no' : 'yes',
    yesLabel: String(bet.yesLabel || 'OUI'),
    noLabel: String(bet.noLabel || 'NON'),
    kind: bet.kind === 'participant' ? 'participant' : 'market',
    amt: amount,
    status: ['pending', 'won', 'lost', 'refunded'].includes(bet.status) ? bet.status : 'pending',
    payout: roundCurrency(bet.payout || 0),
    ts: bet.ts || nowIso(),
    settledAt: bet.settledAt || null,
  };
}

function sanitizeUser(user) {
  if (!user || typeof user !== 'object') return null;

  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;

  return {
    id: String(user.id || crypto.randomUUID()),
    email,
    username: String(user.username || email.split('@')[0] || 'Utilisateur'),
    passwordHash: String(user.passwordHash || ''),
    passwordSalt: String(user.passwordSalt || ''),
    balance: roundCurrency(Number.isFinite(Number(user.balance)) ? user.balance : DEFAULT_BALANCE),
    region: user.region ? String(user.region) : null,
    langs: Array.isArray(user.langs) ? [...new Set(user.langs.map(String))] : [],
    phone: user.phone ? String(user.phone) : '',
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
    createdAt: user.createdAt || nowIso(),
    updatedAt: user.updatedAt || nowIso(),
    bets: Array.isArray(user.bets) ? user.bets.map(sanitizeBet).filter(Boolean) : [],
  };
}

function sanitizeSession(session) {
  if (!session || typeof session !== 'object') return null;
  if (!session.token || !session.userId) return null;

  return {
    token: String(session.token),
    userId: String(session.userId),
    createdAt: session.createdAt || nowIso(),
    lastSeenAt: session.lastSeenAt || nowIso(),
  };
}

function loadStore() {
  if (!fs.existsSync(DATA_FILE)) {
    return baseStore();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      users: Array.isArray(raw.users) ? raw.users.map(sanitizeUser).filter(Boolean) : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions.map(sanitizeSession).filter(Boolean) : [],
    };
  } catch (error) {
    console.warn('[store] failed to load data file, starting fresh', error);
    return baseStore();
  }
}

let store = loadStore();

function persistStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex'),
  };
}

function verifyPassword(user, password) {
  if (!user.passwordHash || !user.passwordSalt) return false;
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function findUserById(userId) {
  return store.users.find(user => user.id === String(userId)) || null;
}

function findUserByEmail(email) {
  return store.users.find(user => user.email === String(email).trim().toLowerCase()) || null;
}

function getSessionRecord(token) {
  return store.sessions.find(session => session.token === token) || null;
}

function sortBets(bets) {
  return [...bets].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

function toClientBet(bet) {
  return {
    id: bet.id,
    debateId: bet.debateId,
    title: bet.title,
    category: bet.category,
    cat: bet.cat,
    side: bet.side,
    yesLabel: bet.yesLabel,
    noLabel: bet.noLabel,
    kind: bet.kind,
    amt: bet.amt,
    status: bet.status,
    payout: bet.payout,
    ts: bet.ts,
    settledAt: bet.settledAt,
  };
}

function toClientUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    balance: user.balance,
    region: user.region,
    langs: user.langs,
    phone: user.phone,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function buildSessionPayload(user, token = null, extra = {}) {
  return {
    ...(token ? { token } : {}),
    user: toClientUser(user),
    bets: sortBets(user.bets).map(toClientBet),
    ...extra,
  };
}

function touchUser(user) {
  user.updatedAt = nowIso();
}

function validateEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw createError('Email invalide');
  }
  return normalized;
}

function validatePassword(password) {
  const normalized = String(password || '');
  if (normalized.length < 6) {
    throw createError('Mot de passe trop court');
  }
  return normalized;
}

function createSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createOrLoginUser({ email, password, username }) {
  const normalizedEmail = validateEmail(email);
  const normalizedPassword = validatePassword(password);
  let user = findUserByEmail(normalizedEmail);

  if (user) {
    if (!verifyPassword(user, normalizedPassword)) {
      throw createError('Mot de passe incorrect', 401);
    }
  } else {
    const passwordData = hashPassword(normalizedPassword);
    user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      username: String(username || normalizedEmail.split('@')[0] || 'Utilisateur').trim() || 'Utilisateur',
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      balance: DEFAULT_BALANCE,
      region: null,
      langs: [],
      phone: '',
      twoFactorEnabled: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      bets: [],
    };
    store.users.push(user);
  }

  const token = createSessionToken();
  store.sessions = store.sessions.filter(session => session.userId !== user.id);
  store.sessions.push({
    token,
    userId: user.id,
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
  });
  touchUser(user);
  persistStore();
  return buildSessionPayload(user, token);
}

function getUserFromToken(token) {
  if (!token) return null;
  const session = getSessionRecord(token);
  if (!session) return null;

  const user = findUserById(session.userId);
  if (!user) return null;

  session.lastSeenAt = nowIso();
  persistStore();
  return user;
}

function destroySession(token) {
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(session => session.token !== token);
  if (store.sessions.length !== before) {
    persistStore();
  }
}

function updateProfile(userId, updates) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  if (updates.email) {
    const nextEmail = validateEmail(updates.email);
    const owner = findUserByEmail(nextEmail);
    if (owner && owner.id !== user.id) {
      throw createError('Cet email est deja utilise', 409);
    }
    user.email = nextEmail;
  }

  if (typeof updates.username === 'string' && updates.username.trim()) {
    user.username = updates.username.trim();
  }

  if (typeof updates.region === 'string' || updates.region === null) {
    user.region = updates.region ? String(updates.region) : null;
  }

  if (Array.isArray(updates.langs)) {
    user.langs = [...new Set(updates.langs.map(String).filter(Boolean))];
  }

  if (typeof updates.phone === 'string') {
    user.phone = updates.phone.trim();
  }

  if (typeof updates.twoFactorEnabled === 'boolean') {
    user.twoFactorEnabled = updates.twoFactorEnabled;
  }

  touchUser(user);
  persistStore();
  return buildSessionPayload(user);
}

function updatePassword(userId, nextPassword) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  const normalizedPassword = validatePassword(nextPassword);
  const passwordData = hashPassword(normalizedPassword);
  user.passwordHash = passwordData.hash;
  user.passwordSalt = passwordData.salt;
  touchUser(user);
  persistStore();
  return buildSessionPayload(user);
}

function deposit(userId, amount) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  const normalizedAmount = roundCurrency(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount < 10) {
    throw createError('Montant invalide');
  }

  user.balance = roundCurrency(user.balance + normalizedAmount);
  touchUser(user);
  persistStore();
  return buildSessionPayload(user, null, { depositAmount: normalizedAmount });
}

function placeBet(userId, payload) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  const normalizedAmount = roundCurrency(payload.amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw createError('Montant invalide');
  }
  if (normalizedAmount > user.balance) {
    throw createError('Fonds insuffisants', 409);
  }
  if (!payload.debateId) {
    throw createError('Debat manquant');
  }
  if (!['yes', 'no'].includes(payload.side)) {
    throw createError('Camp invalide');
  }

  const bet = {
    id: crypto.randomUUID(),
    debateId: String(payload.debateId),
    title: String(payload.title || 'Debat'),
    category: String(payload.category || payload.cat || 'general'),
    cat: String(payload.category || payload.cat || 'general'),
    side: payload.side,
    yesLabel: String(payload.yesLabel || 'OUI'),
    noLabel: String(payload.noLabel || 'NON'),
    kind: payload.kind === 'participant' ? 'participant' : 'market',
    amt: normalizedAmount,
    status: 'pending',
    payout: 0,
    ts: nowIso(),
    settledAt: null,
  };

  user.balance = roundCurrency(user.balance - normalizedAmount);
  user.bets.push(bet);
  touchUser(user);
  persistStore();
  return buildSessionPayload(user, null, { bet: toClientBet(bet) });
}

function settleDebateBets(userId, { debateId, winnerSide, odds }) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);
  if (!debateId) throw createError('Debat manquant');
  if (!['yes', 'no'].includes(winnerSide)) throw createError('Vainqueur invalide');

  const normalizedOdds = roundCurrency(odds);
  if (!Number.isFinite(normalizedOdds) || normalizedOdds <= 1) {
    throw createError('Cote invalide');
  }

  const settled = [];
  let totalGain = 0;
  let totalLoss = 0;

  user.bets.forEach(bet => {
    if (bet.debateId !== String(debateId) || bet.status !== 'pending') return;

    if (bet.side === winnerSide) {
      bet.status = 'won';
      bet.payout = roundCurrency(bet.amt * normalizedOdds);
      totalGain += bet.payout;
      user.balance = roundCurrency(user.balance + bet.payout);
    } else {
      bet.status = 'lost';
      bet.payout = roundCurrency(-bet.amt);
      totalLoss += bet.amt;
    }

    bet.settledAt = nowIso();
    settled.push(toClientBet(bet));
  });

  touchUser(user);
  persistStore();
  return buildSessionPayload(user, null, {
    settlement: {
      debateId: String(debateId),
      settledCount: settled.length,
      totalGain: roundCurrency(totalGain),
      totalLoss: roundCurrency(totalLoss),
    },
  });
}

function getPendingParticipantBet(user, debateId) {
  for (let index = user.bets.length - 1; index >= 0; index -= 1) {
    const bet = user.bets[index];
    if (bet.debateId === String(debateId) && bet.kind === 'participant' && bet.status === 'pending') {
      return { bet, index };
    }
  }
  return null;
}

function cancelParticipantBet(userId, debateId) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  const match = getPendingParticipantBet(user, debateId);
  if (!match) {
    throw createError('Aucune mise participant a rembourser', 404);
  }

  user.balance = roundCurrency(user.balance + match.bet.amt);
  user.bets.splice(match.index, 1);
  touchUser(user);
  persistStore();
  return buildSessionPayload(user);
}

function forfeitParticipantBet(userId, debateId) {
  const user = findUserById(userId);
  if (!user) throw createError('Utilisateur introuvable', 404);

  const match = getPendingParticipantBet(user, debateId);
  if (!match) {
    throw createError('Aucune mise participant a perdre', 404);
  }

  match.bet.status = 'lost';
  match.bet.payout = roundCurrency(-match.bet.amt);
  match.bet.settledAt = nowIso();
  touchUser(user);
  persistStore();
  return buildSessionPayload(user);
}

module.exports = {
  buildSessionPayload,
  cancelParticipantBet,
  createError,
  createOrLoginUser,
  deposit,
  destroySession,
  forfeitParticipantBet,
  getUserFromToken,
  placeBet,
  settleDebateBets,
  updatePassword,
  updateProfile,
};
