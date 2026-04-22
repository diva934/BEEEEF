const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DEBATES_FILE || path.join(__dirname, 'data', 'debates.json');
const SEEDED_PROGRESS = [0.18, 0.42, 0.27, 0.61, 0.34, 0.22, 0.49, 0.13];

const INITIAL_DEBATES = [
  {
    id: '1',
    title: "Bitcoin est-il l'avenir de la monnaie ?",
    category: 'crypto',
    trending: true,
    ai: false,
    yesPct: 68,
    pool: 142500,
    viewers: 4200,
    gradColors: ['#f7931a', '#ff6432', '#1a1a2e'],
    yesLabel: 'OUI',
    noLabel: 'NON',
    lang: 'fr',
    photo: null,
  },
  {
    id: '2',
    title: 'Will AI replace most jobs by 2030?',
    category: 'technology',
    trending: true,
    ai: false,
    yesPct: 55,
    pool: 89300,
    viewers: 3100,
    gradColors: ['#3d9eff', '#667eea', '#0d0d1a'],
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: 'en',
    photo: null,
  },
  {
    id: '3',
    title: 'Le revenu universel de base devrait-il etre mis en place ?',
    category: 'economy',
    trending: false,
    ai: false,
    yesPct: 41,
    pool: 56700,
    viewers: 1800,
    gradColors: ['#00d97e', '#00b865', '#0a1a12'],
    yesLabel: 'OUI',
    noLabel: 'NON',
    lang: 'fr',
    photo: null,
  },
  {
    id: '4',
    title: 'Is Messi the GOAT?',
    category: 'sports',
    trending: true,
    ai: false,
    yesPct: 72,
    pool: 203000,
    viewers: 7600,
    gradColors: ['#aa55ff', '#764ba2', '#130d1a'],
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: 'en',
    photo: 'img-sports.jpg',
  },
  {
    id: '5',
    title: 'Will there be a US-China war in 10 years?',
    category: 'geopolitics',
    trending: false,
    ai: false,
    yesPct: 33,
    pool: 118200,
    viewers: 5300,
    gradColors: ['#ff5555', '#cc2020', '#1a0d0d'],
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: 'en',
    photo: 'img-geopolitics.jpg',
  },
  {
    id: '6',
    title: 'Soll Krypto wie Banken reguliert werden?',
    category: 'crypto',
    trending: false,
    ai: false,
    yesPct: 49,
    pool: 77400,
    viewers: 2200,
    gradColors: ['#f7931a', '#cc6600', '#1a1200'],
    yesLabel: 'JA',
    noLabel: 'NEIN',
    lang: 'de',
    photo: null,
  },
  {
    id: '7',
    title: 'Le teletravail est-il meilleur que le bureau ?',
    category: 'society',
    trending: false,
    ai: false,
    yesPct: 61,
    pool: 44100,
    viewers: 1400,
    gradColors: ['#ffc800', '#ff9900', '#1a1500'],
    yesLabel: 'TELETRAVAIL',
    noLabel: 'BUREAU',
    lang: 'fr',
    photo: null,
  },
  {
    id: '8',
    title: 'Will Trump win again?',
    category: 'politics',
    trending: true,
    ai: false,
    yesPct: 44,
    pool: 312000,
    viewers: 9800,
    gradColors: ['#ff6432', '#dd3311', '#1a0a00'],
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: 'en',
    photo: 'img-politics-trump.jpg',
  },
];

function nowMs() {
  return Date.now();
}

function nowIso(input = nowMs()) {
  return new Date(input).toISOString();
}

function roundNumber(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDebateDurationMs(pool) {
  const amount = Number(pool) || 0;
  if (amount > 200000) return 5_400_000;
  if (amount > 100000) return 3_600_000;
  if (amount > 50000) return 2_700_000;
  return 1_800_000;
}

function createVerdict(debate) {
  const winnerSide = Number(debate.yesPct) >= 50 ? 'yes' : 'no';
  const winner = winnerSide === 'yes' ? debate.yesLabel : debate.noLabel;
  const loser = winnerSide === 'yes' ? debate.noLabel : debate.yesLabel;
  const winningPct = winnerSide === 'yes' ? Number(debate.yesPct) : 100 - Number(debate.yesPct);
  const losingPct = 100 - winningPct;
  const gap = Math.abs(winningPct - losingPct);
  const convictionWinner = clamp(Math.round(7 + gap / 18), 7, 10);
  const convictionLoser = clamp(convictionWinner - 2, 4, 8);
  const logicWinner = clamp(Math.round(6 + gap / 22), 6, 10);
  const logicLoser = clamp(logicWinner - 1, 4, 8);
  const originalityWinner = clamp(Math.round(6 + gap / 28), 6, 9);
  const originalityLoser = clamp(originalityWinner - 1, 4, 8);

  return {
    winnerSide,
    winnerLabel: winner,
    winner,
    conviction: winnerSide === 'yes'
      ? { yes: convictionWinner, no: convictionLoser }
      : { yes: convictionLoser, no: convictionWinner },
    logic: winnerSide === 'yes'
      ? { yes: logicWinner, no: logicLoser }
      : { yes: logicLoser, no: logicWinner },
    originality: winnerSide === 'yes'
      ? { yes: originalityWinner, no: originalityLoser }
      : { yes: originalityLoser, no: originalityWinner },
    reasoning: `${winner} garde l'avantage avec une dynamique de pari plus solide. ${loser} est reste en retrait, ce qui donne un verdict plus net a la cloture du debat.`,
  };
}

function sanitizeDebate(raw, index = 0) {
  const durationMs = Number(raw.durationMs) > 0 ? Number(raw.durationMs) : getDebateDurationMs(raw.pool);
  const openedAt = Number(raw.openedAt) > 0 ? Number(raw.openedAt) : nowMs();
  const endsAt = Number(raw.endsAt) > 0 ? Number(raw.endsAt) : openedAt + durationMs;
  const closed = Boolean(raw.closed) || nowMs() >= endsAt;
  const base = {
    id: String(raw.id),
    title: String(raw.title || 'Debat'),
    description: raw.description ? String(raw.description) : '',
    category: String(raw.category || 'general'),
    trending: Boolean(raw.trending),
    ai: Boolean(raw.ai),
    yesPct: clamp(Math.round(Number(raw.yesPct) || 50), 5, 95),
    pool: roundNumber(raw.pool || 0, 0),
    viewers: Math.max(0, Math.round(Number(raw.viewers) || 0)),
    gradColors: Array.isArray(raw.gradColors) && raw.gradColors.length >= 3
      ? raw.gradColors.slice(0, 3).map(String)
      : ['#ff6432', '#ff8c55', '#1a0a00'],
    yesLabel: String(raw.yesLabel || 'OUI'),
    noLabel: String(raw.noLabel || 'NON'),
    lang: raw.lang ? String(raw.lang) : null,
    photo: raw.photo ? String(raw.photo) : null,
    durationMs,
    openedAt,
    endsAt,
    closed,
    closedAt: raw.closedAt ? Number(raw.closedAt) : null,
    winnerSide: raw.winnerSide === 'no' ? 'no' : raw.winnerSide === 'yes' ? 'yes' : null,
    winnerLabel: raw.winnerLabel ? String(raw.winnerLabel) : null,
    verdictReasoning: raw.verdictReasoning ? String(raw.verdictReasoning) : '',
    verdictScores: raw.verdictScores && typeof raw.verdictScores === 'object' ? raw.verdictScores : null,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    // News metadata fields (optional — only present on news-generated debates)
    sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : null,
    sourceTitle: raw.sourceTitle ? String(raw.sourceTitle) : null,
    sourceKey: raw.sourceKey ? String(raw.sourceKey) : null,
    newsPublishedAt: raw.newsPublishedAt ? Number(raw.newsPublishedAt) : null,
    createdFromNews: Boolean(raw.createdFromNews),
    listed: raw.listed !== undefined ? Boolean(raw.listed) : true,
  };

  if (base.closed && !base.winnerSide) {
    const verdict = createVerdict(base);
    base.winnerSide = verdict.winnerSide;
    base.winnerLabel = verdict.winnerLabel;
    base.verdictReasoning = verdict.reasoning;
    base.verdictScores = {
      conviction: verdict.conviction,
      logic: verdict.logic,
      originality: verdict.originality,
    };
    base.closedAt = base.closedAt || base.endsAt;
  }

  return base;
}

function buildSeedDebates() {
  const seedNow = nowMs();
  return INITIAL_DEBATES.map((debate, index) => {
    const durationMs = getDebateDurationMs(debate.pool);
    const progressMs = Math.round(durationMs * SEEDED_PROGRESS[index % SEEDED_PROGRESS.length]);
    const openedAt = seedNow - progressMs;

    return sanitizeDebate({
      ...debate,
      durationMs,
      openedAt,
      endsAt: openedAt + durationMs,
      createdAt: nowIso(seedNow),
      updatedAt: nowIso(seedNow),
      order: index,
    }, index);
  });
}

function persistDebates(debates) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(debates, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function loadDebates() {
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = buildSeedDebates();
    persistDebates(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.length) {
      const seeded = buildSeedDebates();
      persistDebates(seeded);
      return seeded;
    }

    return parsed.map((debate, index) => sanitizeDebate(debate, index));
  } catch (error) {
    console.warn('[debates] failed to read debate file, reseeding', error);
    const seeded = buildSeedDebates();
    persistDebates(seeded);
    return seeded;
  }
}

let debates = loadDebates();

function reconcileDebates() {
  const currentNow = nowMs();
  let changed = false;

  debates = debates.map((debate, index) => {
    const safeDebate = sanitizeDebate(debate, index);
    if (!safeDebate.closed && currentNow >= safeDebate.endsAt) {
      const verdict = createVerdict(safeDebate);
      changed = true;
      return {
        ...safeDebate,
        closed: true,
        closedAt: currentNow,
        winnerSide: verdict.winnerSide,
        winnerLabel: verdict.winnerLabel,
        verdictReasoning: verdict.reasoning,
        verdictScores: {
          conviction: verdict.conviction,
          logic: verdict.logic,
          originality: verdict.originality,
        },
        updatedAt: nowIso(currentNow),
      };
    }
    return safeDebate;
  });

  if (changed) {
    persistDebates(debates);
  }
}

function toPublicDebate(debate) {
  return {
    id: debate.id,
    title: debate.title,
    description: debate.description || '',
    category: debate.category,
    trending: debate.trending,
    ai: debate.ai,
    yesPct: debate.yesPct,
    pool: debate.pool,
    viewers: debate.viewers,
    gradColors: debate.gradColors,
    yesLabel: debate.yesLabel,
    noLabel: debate.noLabel,
    lang: debate.lang,
    photo: debate.photo,
    durationMs: debate.durationMs,
    openedAt: debate.openedAt,
    endsAt: debate.endsAt,
    closed: debate.closed,
    closedAt: debate.closedAt,
    winnerSide: debate.winnerSide,
    winnerLabel: debate.winnerLabel,
    verdictReasoning: debate.verdictReasoning,
    verdictScores: debate.verdictScores,
    createdAt: debate.createdAt,
    updatedAt: debate.updatedAt,
    // News metadata
    sourceUrl: debate.sourceUrl || null,
    sourceTitle: debate.sourceTitle || null,
    sourceKey: debate.sourceKey || null,
    newsPublishedAt: debate.newsPublishedAt || null,
    createdFromNews: debate.createdFromNews || false,
    listed: debate.listed !== undefined ? debate.listed : true,
  };
}

function listDebates() {
  reconcileDebates();
  return debates
    .slice()
    .sort((left, right) => left.order - right.order)
    .map(toPublicDebate);
}

function getDebateById(debateId) {
  reconcileDebates();
  const match = debates.find(debate => String(debate.id) === String(debateId));
  return match ? toPublicDebate(match) : null;
}

function updateDebatePool(debateId, side, amountDelta, { viewerDelta = 0 } = {}) {
  const normalizedAmount = roundNumber(amountDelta, 2);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount === 0) return null;
  reconcileDebates();
  const index = debates.findIndex(debate => String(debate.id) === String(debateId));
  if (index === -1) return null;

  const debate = debates[index];
  if (debate.closed) return toPublicDebate(debate);

  const totalPool = roundNumber(debate.pool || 0, 2);
  const yesPool = totalPool * (Number(debate.yesPct) / 100);
  const noPool = totalPool - yesPool;
  const nextYesPool = side === 'yes' ? Math.max(0, yesPool + normalizedAmount) : yesPool;
  const nextNoPool = side === 'no' ? Math.max(0, noPool + normalizedAmount) : noPool;
  const nextPool = nextYesPool + nextNoPool;
  const nextYesPct = nextPool > 0
    ? clamp(Math.round((nextYesPool / nextPool) * 100), 5, 95)
    : debate.yesPct;

  debates[index] = {
    ...debate,
    pool: roundNumber(nextPool, 0),
    yesPct: nextYesPct,
    viewers: Math.max(200, Math.round((debate.viewers || 0) + viewerDelta)),
    updatedAt: nowIso(),
  };

  persistDebates(debates);
  return toPublicDebate(debates[index]);
}

function applyBetToDebate(debateId, side, amount) {
  return updateDebatePool(debateId, side, amount, { viewerDelta: 6 });
}

function removeBetFromDebate(debateId, side, amount) {
  return updateDebatePool(debateId, side, -Math.abs(roundNumber(amount, 2)));
}

function buildClientVerdict(debateId) {
  const debate = getDebateById(debateId);
  if (!debate || !debate.closed || !debate.winnerSide) return null;

  const fallback = createVerdict(debate);
  return {
    winner: debate.winnerLabel || fallback.winner,
    winnerSide: debate.winnerSide,
    conviction: debate.verdictScores?.conviction || fallback.conviction,
    logic: debate.verdictScores?.logic || fallback.logic,
    originality: debate.verdictScores?.originality || fallback.originality,
    reasoning: debate.verdictReasoning || fallback.reasoning,
  };
}

// ─────────────────────────────────────────────────────────────
//  News pipeline helpers
// ─────────────────────────────────────────────────────────────

const MAX_ACTIVE_DEBATES = 5;

/**
 * Count debates that are currently open (not closed).
 */
function countActiveDebates() {
  reconcileDebates();
  return debates.filter(d => !d.closed).length;
}

/**
 * Create and persist a new debate from a plain object.
 * Assigns a stable numeric-style order so it sorts after existing debates.
 * @param {object} debateObj - raw debate data (from news-debate-generator)
 * @returns {object} the sanitized public debate
 */
function createDebate(debateObj) {
  reconcileDebates();
  const maxOrder = debates.reduce((max, d) => Math.max(max, d.order || 0), 0);
  const withOrder = { ...debateObj, order: maxOrder + 1 };
  const sanitized = sanitizeDebate(withOrder, debates.length);
  debates.push(sanitized);
  persistDebates(debates);
  console.log(`[debates] created debate id=${sanitized.id} title="${sanitized.title}"`);
  return toPublicDebate(sanitized);
}

/**
 * If there are more than MAX_ACTIVE_DEBATES open debates, hide the oldest
 * (by openedAt) by setting listed=false on the surplus ones.
 */
function hideSurplusActiveDebates() {
  reconcileDebates();
  const active = debates
    .filter(d => !d.closed && d.listed !== false)
    .sort((a, b) => a.openedAt - b.openedAt);

  if (active.length <= MAX_ACTIVE_DEBATES) return;

  const surplus = active.slice(0, active.length - MAX_ACTIVE_DEBATES);
  let changed = false;
  surplus.forEach(d => {
    const idx = debates.findIndex(x => x.id === d.id);
    if (idx !== -1) {
      debates[idx] = { ...debates[idx], listed: false, updatedAt: nowIso() };
      changed = true;
      console.log(`[debates] hid surplus debate id=${d.id} title="${d.title}"`);
    }
  });

  if (changed) persistDebates(debates);
}

/**
 * Return a Set of "sourceKey:url" strings for all debates that were
 * created from news, so the pipeline can avoid duplicates.
 */
function getUsedSourceKeys() {
  const keys = new Set();
  debates.forEach(d => {
    if (d.sourceKey && d.sourceUrl) {
      keys.add(`${d.sourceKey}:${d.sourceUrl}`);
    }
  });
  return keys;
}

module.exports = {
  applyBetToDebate,
  buildClientVerdict,
  countActiveDebates,
  createDebate,
  getDebateById,
  getUsedSourceKeys,
  hideSurplusActiveDebates,
  listDebates,
  removeBetFromDebate,
  reconcileDebates,
};
