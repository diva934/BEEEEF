const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { controversyScoreFromText, fingerprintTitle, hasUsablePreviewImage } = require('./news-filter');

const DATA_FILE = process.env.DEBATES_FILE || path.join(__dirname, 'data', 'debates.json');
const SEED_FILE = path.join(__dirname, 'data', 'debates.seed.json');
const MIN_ACTIVE_DEBATES_FLOOR = Math.max(1, Math.min(10, Number(process.env.DEBATE_MIN_ACTIVE_FLOOR) || 3));
const TARGET_ACTIVE_DEBATES = Math.max(MIN_ACTIVE_DEBATES_FLOOR, Math.min(50, Number(process.env.DEBATE_TARGET_ACTIVE) || 35));
const MIN_DEBATE_CONTROVERSY_SCORE = Math.max(2, Number(process.env.DEBATE_MIN_CONTROVERSY_SCORE) || 3);
const DEBATE_OVERLAP_SIMILARITY = Math.max(0.45, Math.min(0.9, Number(process.env.DEBATE_OVERLAP_SIMILARITY) || 0.62));
const SEEDED_PROGRESS = [0.08, 0.14, 0.19, 0.24, 0.29, 0.12, 0.18, 0.23, 0.31, 0.37, 0.07, 0.16, 0.22, 0.28, 0.34, 0.11, 0.2, 0.26, 0.32, 0.38, 0.09, 0.15, 0.21, 0.27, 0.33, 0.13, 0.17, 0.25, 0.3, 0.36, 0.1, 0.18, 0.24, 0.29, 0.35];
const CATEGORY_PREVIEW_IMAGES = {
  politics: 'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=1200&q=80&auto=format&fit=crop',
  sports: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=1200&q=80&auto=format&fit=crop',
  crypto: 'https://images.unsplash.com/photo-1621504450181-5d356f61d307?w=1200&q=80&auto=format&fit=crop',
  geopolitics: 'https://images.unsplash.com/photo-1576485375217-d6a95e34d043?w=1200&q=80&auto=format&fit=crop',
  economy: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80&auto=format&fit=crop',
  technology: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80&auto=format&fit=crop',
  society: 'https://images.unsplash.com/photo-1573164713988-8665fc963095?w=1200&q=80&auto=format&fit=crop',
  culture: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1200&q=80&auto=format&fit=crop',
  general: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=1200&q=80&auto=format&fit=crop',
};

const CATEGORY_STYLES = {
  politics: ['#ff6432', '#dd3311', '#1a0a00'],
  sports: ['#aa55ff', '#764ba2', '#130d1a'],
  crypto: ['#f7931a', '#ff6432', '#1a1a2e'],
  geopolitics: ['#ff5555', '#cc2020', '#1a0d0d'],
  economy: ['#00d97e', '#00b865', '#0a1a12'],
  technology: ['#3d9eff', '#667eea', '#0d0d1a'],
  society: ['#ffc800', '#ff9900', '#1a1500'],
};

const INITIAL_DEBATE_GROUPS = {
  politics: [
    { title: 'Should political leaders have term limits?', yesPct: 64, pool: 126000, viewers: 3400, trending: true },
    { title: 'Should voting be mandatory?', yesPct: 43, pool: 82000, viewers: 2100 },
    { title: 'Can democracy survive the next decade?', yesPct: 52, pool: 118000, viewers: 2900 },
    { title: 'Should governments regulate social media platforms?', yesPct: 71, pool: 154000, viewers: 4100, trending: true },
    { title: 'Will younger voters reshape politics?', yesPct: 58, pool: 69000, viewers: 1700 },
  ],
  sports: [
    { title: 'Should esports be part of the Olympics?', yesPct: 56, pool: 88000, viewers: 2600 },
    { title: 'Is club football becoming too expensive for fans?', yesPct: 78, pool: 121000, viewers: 3900, trending: true },
    { title: 'Should VAR decisions be fully transparent?', yesPct: 69, pool: 97000, viewers: 3300 },
    { title: "Can women's sports reach the same commercial scale?", yesPct: 62, pool: 73000, viewers: 2200 },
    { title: 'Should athletes be allowed to speak politically?', yesPct: 47, pool: 64000, viewers: 1800 },
  ],
  crypto: [
    { title: 'Is Bitcoin becoming digital gold?', yesPct: 68, pool: 142500, viewers: 4200, trending: true },
    { title: 'Should crypto be regulated like banks?', yesPct: 49, pool: 77400, viewers: 2200 },
    { title: 'Will Ethereum remain the leading smart contract chain?', yesPct: 57, pool: 98000, viewers: 2600 },
    { title: 'Are stablecoins the future of payments?', yesPct: 61, pool: 84000, viewers: 2400 },
    { title: 'Should governments issue digital currencies?', yesPct: 46, pool: 69000, viewers: 1900 },
  ],
  geopolitics: [
    { title: 'Will the US and China avoid a direct conflict?', yesPct: 54, pool: 118200, viewers: 5300, trending: true },
    { title: 'Is a new cold war already underway?', yesPct: 71, pool: 95000, viewers: 3100 },
    { title: 'Can Europe become strategically independent?', yesPct: 39, pool: 87000, viewers: 2700 },
    { title: 'Will Africa become the next major growth power?', yesPct: 58, pool: 76000, viewers: 2100 },
    { title: 'Is NATO still fit for purpose?', yesPct: 55, pool: 82000, viewers: 2500 },
  ],
  economy: [
    { title: 'Is universal basic income realistic?', yesPct: 41, pool: 56700, viewers: 1800 },
    { title: 'Will inflation stay higher for longer?', yesPct: 62, pool: 74000, viewers: 2300 },
    { title: 'Should billionaires pay much higher taxes?', yesPct: 67, pool: 134000, viewers: 3700, trending: true },
    { title: 'Is remote work changing city economies forever?', yesPct: 59, pool: 68000, viewers: 1900 },
    { title: 'Will AI create more jobs than it destroys?', yesPct: 48, pool: 112000, viewers: 3200 },
  ],
  technology: [
    { title: 'Will AI replace most office jobs by 2030?', yesPct: 55, pool: 89300, viewers: 3100, trending: true, ai: true },
    { title: 'Should AI models be strictly regulated?', yesPct: 63, pool: 104000, viewers: 3500, ai: true },
    { title: 'Is privacy still possible online?', yesPct: 36, pool: 79000, viewers: 2600 },
    { title: 'Will robots become normal in homes?', yesPct: 44, pool: 71000, viewers: 2100 },
    { title: 'Should children use AI tools at school?', yesPct: 51, pool: 86000, viewers: 2800, ai: true },
  ],
  society: [
    { title: 'Is the four-day work week the future?', yesPct: 74, pool: 87000, viewers: 3000, trending: true },
    { title: 'Are social networks harming public debate?', yesPct: 69, pool: 93000, viewers: 3400 },
    { title: 'Should phones be banned in schools?', yesPct: 57, pool: 66000, viewers: 2200 },
    { title: 'Is remote work better than office life?', yesPct: 61, pool: 44100, viewers: 1400 },
    { title: 'Will online communities replace local communities?', yesPct: 45, pool: 58000, viewers: 1600 },
  ],
};

const INITIAL_DEBATES = Object.entries(INITIAL_DEBATE_GROUPS).flatMap(([category, items]) =>
  items.map((item, index) => ({
    id: String(Object.values(INITIAL_DEBATE_GROUPS).slice(0, Object.keys(INITIAL_DEBATE_GROUPS).indexOf(category)).reduce((count, group) => count + group.length, 0) + index + 1),
    category,
    trending: Boolean(item.trending),
    ai: Boolean(item.ai),
    gradColors: CATEGORY_STYLES[category],
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: null,
    photo: null,
    ...item,
  }))
);

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

function normalizeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).replace(/\s+/g, ' ').trim();
}

function getPreviewImageUrl(rawDebate = {}) {
  return normalizeText(rawDebate.sourceImageUrl || rawDebate.photo);
}

function getCategoryPreviewImage(category = 'general') {
  return CATEGORY_PREVIEW_IMAGES[category] || CATEGORY_PREVIEW_IMAGES.general;
}

function resolveDebatePreviewImage(rawDebate = {}) {
  const directImageUrl = getPreviewImageUrl(rawDebate);
  if (hasUsablePreviewImage(directImageUrl)) {
    return directImageUrl;
  }
  return getCategoryPreviewImage(rawDebate.category);
}

function isDebateControversial(rawDebate = {}) {
  const title = rawDebate.title || rawDebate.sourceTitle || '';
  const context = [
    rawDebate.description,
    rawDebate.sourceDescription,
    rawDebate.sourceExcerpt,
  ].filter(Boolean).join(' ');
  return controversyScoreFromText(title, context, rawDebate.category) >= MIN_DEBATE_CONTROVERSY_SCORE;
}

function debateTextCandidates(debate = {}) {
  return [
    debate.title,
    debate.sourceTitle,
    debate.description,
    debate.sourceExcerpt,
  ]
    .map(value => normalizeText(value).toLowerCase())
    .filter(Boolean);
}

function tokenSet(value) {
  return new Set(fingerprintTitle(value).split(/\s+/).map(stemToken).filter(Boolean));
}

function stemToken(token) {
  let value = String(token || '').toLowerCase();
  if (!value) return '';
  if (/^bann?/.test(value)) return 'ban';
  if (/^regulat/.test(value)) return 'regulate';
  if (/^govern/.test(value)) return 'government';
  if (/^technolog/.test(value)) return 'technology';
  if (value.endsWith('ies') && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (value.endsWith('ing') && value.length > 5) value = value.slice(0, -3);
  else if (value.endsWith('ed') && value.length > 4) value = value.slice(0, -2);
  else if (value.endsWith('s') && value.length > 4) value = value.slice(0, -1);
  if (value.length >= 3 && value[value.length - 1] === value[value.length - 2]) {
    value = value.slice(0, -1);
  }
  return value;
}

function tokenSimilarity(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) intersection += 1;
  });
  const union = leftTokens.size + rightTokens.size - intersection;
  const jaccard = union ? intersection / union : 0;
  const smallerCoverage = intersection / Math.min(leftTokens.size, rightTokens.size);
  return Math.max(jaccard, intersection >= 3 ? smallerCoverage : 0);
}

function hasTopicOverlap(rawDebate, existingDebate) {
  const incomingCandidates = debateTextCandidates(rawDebate);
  const existingCandidates = debateTextCandidates(existingDebate);

  return incomingCandidates.some(incoming =>
    existingCandidates.some(existing => tokenSimilarity(incoming, existing) >= DEBATE_OVERLAP_SIMILARITY)
  );
}

function validateDebateLaunchRequirements(rawDebate = {}) {
  if (!hasUsablePreviewImage(getPreviewImageUrl(rawDebate))) {
    return {
      ok: false,
      reason: 'missing_preview_image',
    };
  }

  // Image is no longer a hard gate — fallback images are always supplied by the generator.
  // We only require the debate to be genuinely controversial.
  if (!isDebateControversial(rawDebate)) {
    return {
      ok: false,
      reason: 'not_controversial_enough',
    };
  }

  return {
    ok: true,
    reason: null,
  };
}

function getDebateDurationMs(pool) {
  const amount = Number(pool) || 0;
  if (amount > 200000) return 12 * 60 * 60 * 1000;
  if (amount > 100000) return 10 * 60 * 60 * 1000;
  if (amount > 50000) return 8 * 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
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
  const previewImageUrl = resolveDebatePreviewImage(raw);
  const base = {
    id: String(raw.id),
    title: String(raw.title || 'Debat'),
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
    photo: previewImageUrl,
    description: normalizeText(raw.description),
    sourceUrl: normalizeText(raw.sourceUrl),
    sourceTitle: normalizeText(raw.sourceTitle),
    sourceExcerpt: normalizeText(raw.sourceExcerpt || raw.sourceDescription),
    sourceDescription: normalizeText(raw.sourceDescription),
    sourceImageUrl: previewImageUrl,
    previewVideoUrl: normalizeText(raw.previewVideoUrl || raw.sourceVideoUrl || raw.contextVideoUrl),
    sourceVideoUrl: normalizeText(raw.sourceVideoUrl),
    contextVideoUrl: normalizeText(raw.contextVideoUrl),
    sourceFeedLabel: normalizeText(raw.sourceFeedLabel),
    sourceDomain: normalizeText(raw.sourceDomain),
    sourceKey: normalizeText(raw.sourceKey).toLowerCase(),
    newsPublishedAt: raw.newsPublishedAt ? String(raw.newsPublishedAt) : null,
    createdFromNews: Boolean(raw.createdFromNews),
    listed: raw.listed !== false,
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

function buildSeedDebates(sourceDebates = INITIAL_DEBATES) {
  const seedNow = nowMs();
  return sourceDebates.map((debate, index) => {
    const durationMs = getDebateDurationMs(debate.pool);
    const progressMs = Math.round(durationMs * SEEDED_PROGRESS[index % SEEDED_PROGRESS.length]);
    const openedAt = seedNow - progressMs;

    return sanitizeDebate({
      ...debate,
      closed: false,
      closedAt: null,
      winnerSide: null,
      winnerLabel: null,
      verdictReasoning: '',
      verdictScores: null,
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

function loadSeedDebates() {
  if (!fs.existsSync(SEED_FILE)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.length) {
      return null;
    }
    if (parsed.length < INITIAL_DEBATES.length) {
      return null;
    }
    return buildSeedDebates(parsed);
  } catch (error) {
    console.warn('[debates] failed to read seed file', error);
    return null;
  }
}

function resetSeedDebates(existingDebates = []) {
  const seeded = loadSeedDebates() || buildSeedDebates();
  const seedIds = new Set(seeded.map(debate => String(debate.id)));
  // Keep active (non-expired) news debates LISTED so they remain visible
  // after a seed refresh. Expired news debates are kept but set to unlisted.
  const currentNow = nowMs();
  const preservedNewsDebates = existingDebates
    .filter(debate => debate.createdFromNews && !seedIds.has(String(debate.id)))
    .slice(-12)
    .map((debate, index) => {
      const isStillActive = !debate.closed && Number(debate.endsAt) > currentNow;
      return {
        ...debate,
        listed: isStillActive,
        order: seeded.length + index,
        updatedAt: nowIso(),
      };
    });

  return [...seeded, ...preservedNewsDebates];
}

function hasActiveListedDebate(items) {
  const currentNow = nowMs();
  return items.some(debate => isActiveListedDebate(debate, currentNow));
}

function countActiveListedDebates(items) {
  const currentNow = nowMs();
  return items.filter(debate => isActiveListedDebate(debate, currentNow)).length;
}

function isActiveDebate(debate, currentNow = nowMs()) {
  return !debate.closed && Number(debate.endsAt) > currentNow;
}

function isActiveListedDebate(debate, currentNow = nowMs()) {
  return debate.listed !== false && isActiveDebate(debate, currentNow);
}

function ensureActiveDebates(items) {
  const sanitized = items.map((debate, index) => sanitizeDebate(debate, index));
  let nextDebates = sanitized.slice();
  let activeListedCount = countActiveListedDebates(nextDebates);
  if (activeListedCount >= TARGET_ACTIVE_DEBATES) {
    return {
      debates: nextDebates,
      refreshed: false,
    };
  }

  const refreshedAt = nowIso();
  const currentNow = nowMs();
  let changed = false;

  nextDebates = nextDebates.map(debate => {
    if (
      activeListedCount < TARGET_ACTIVE_DEBATES &&
      debate.listed === false &&
      !debate.createdFromNews &&
      isActiveDebate(debate, currentNow)
    ) {
      activeListedCount += 1;
      changed = true;
      return {
        ...debate,
        listed: true,
        updatedAt: refreshedAt,
      };
    }
    return debate;
  });

  if (activeListedCount < TARGET_ACTIVE_DEBATES) {
    const activeListedDebates = nextDebates.filter(debate => isActiveListedDebate(debate, currentNow));
    const activeSeedIds = new Set(
      activeListedDebates
        .filter(debate => !debate.createdFromNews)
        .map(debate => String(debate.id))
    );
    const freshSeeds = (loadSeedDebates() || buildSeedDebates())
      .filter(seed => !activeSeedIds.has(String(seed.id)));
    const originalOrderById = new Map(nextDebates.map(debate => [String(debate.id), Number(debate.order)]));
    const selectedSeeds = new Map();
    const activeContext = activeListedDebates.slice();

    const trySelectSeeds = ({ ignoreOverlap = false } = {}) => {
      for (const seed of freshSeeds) {
        if (activeListedCount >= TARGET_ACTIVE_DEBATES) {
          break;
        }

        const seedId = String(seed.id);
        if (selectedSeeds.has(seedId)) {
          continue;
        }

        if (!ignoreOverlap && activeContext.some(existing => hasTopicOverlap(seed, existing))) {
          continue;
        }

        selectedSeeds.set(seedId, {
          ...seed,
          listed: true,
          order: originalOrderById.has(seedId) ? originalOrderById.get(seedId) : seed.order,
          updatedAt: refreshedAt,
        });
        activeContext.push(seed);
        activeListedCount += 1;
      }
    };

    trySelectSeeds({ ignoreOverlap: false });
    if (activeListedCount < TARGET_ACTIVE_DEBATES) {
      trySelectSeeds({ ignoreOverlap: true });
    }

    if (selectedSeeds.size) {
      changed = true;
      const replacedIds = new Set();
      nextDebates = nextDebates.map(debate => {
        const replacement = selectedSeeds.get(String(debate.id));
        if (!replacement) {
          return debate;
        }
        replacedIds.add(String(debate.id));
        return replacement;
      });

      selectedSeeds.forEach((replacement, seedId) => {
        if (!replacedIds.has(seedId)) {
          nextDebates.push(replacement);
        }
      });
    }
  }

  return {
    debates: nextDebates,
    refreshed: changed,
  };
}

function loadDebates() {
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = resetSeedDebates();
    persistDebates(seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.length) {
      const seeded = resetSeedDebates();
      persistDebates(seeded);
      return seeded;
    }

    const result = ensureActiveDebates(parsed);
    if (result.refreshed) {
      console.warn(`[debates] active debate target refill triggered on load (${countActiveListedDebates(result.debates)}/${TARGET_ACTIVE_DEBATES})`);
      persistDebates(result.debates);
    }
    return result.debates;
  } catch (error) {
    console.warn('[debates] failed to read debate file, reseeding', error);
    const seeded = resetSeedDebates();
    persistDebates(seeded);
    return seeded;
  }
}

let debates = loadDebates();

function reconcileDebates() {
  const currentNow = nowMs();
  let changed = false;
  const closedIds = [];

  debates = debates.map((debate, index) => {
    const safeDebate = sanitizeDebate(debate, index);
    if (!safeDebate.closed && currentNow >= safeDebate.endsAt) {
      const verdict = createVerdict(safeDebate);
      changed = true;
      closedIds.push(safeDebate.id);
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

  const activeBeforeRefill = countActiveListedDebates(debates);
  const refillResult = ensureActiveDebates(debates);
  if (refillResult.refreshed) {
    debates = refillResult.debates;
    changed = true;
    console.warn(`[debates] active debate target refill triggered (${activeBeforeRefill} -> ${countActiveListedDebates(debates)} / ${TARGET_ACTIVE_DEBATES})`);
  }

  if (changed) {
    persistDebates(debates);
  }

  return {
    changed,
    closedIds,
  };
}

function toPublicDebate(debate) {
  return {
    id: debate.id,
    title: debate.title,
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
    description: debate.description,
    sourceUrl: debate.sourceUrl,
    sourceTitle: debate.sourceTitle,
    sourceExcerpt: debate.sourceExcerpt,
    sourceDescription: debate.sourceDescription,
    sourceImageUrl: debate.sourceImageUrl,
    previewVideoUrl: debate.previewVideoUrl,
    sourceVideoUrl: debate.sourceVideoUrl,
    contextVideoUrl: debate.contextVideoUrl,
    sourceFeedLabel: debate.sourceFeedLabel,
    sourceDomain: debate.sourceDomain,
    sourceKey: debate.sourceKey,
    newsPublishedAt: debate.newsPublishedAt,
    createdFromNews: debate.createdFromNews,
    listed: debate.listed,
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
  };
}

function listDebates(options = {}) {
  const { includeUnlisted = false } = options;
  reconcileDebates();
  return debates
    .slice()
    .filter(debate => includeUnlisted || debate.listed !== false)
    .sort((left, right) => left.order - right.order)
    .map(toPublicDebate);
}

function getDebateById(debateId) {
  reconcileDebates();
  const match = debates.find(debate => String(debate.id) === String(debateId));
  return match ? toPublicDebate(match) : null;
}

function countActiveDebates(options = {}) {
  const { includeUnlisted = false } = options;
  reconcileDebates();
  return debates.filter(debate => !debate.closed && (includeUnlisted || debate.listed !== false)).length;
}

function findDebateConflict(rawDebate) {
  const sourceKey = normalizeText(rawDebate.sourceKey).toLowerCase();
  const sourceUrl = normalizeText(rawDebate.sourceUrl).toLowerCase();
  const title = normalizeText(rawDebate.title).toLowerCase();
  const currentNow = nowMs();

  return debates.find(debate => {
    if (sourceKey && debate.sourceKey === sourceKey) {
      return true;
    }
    if (sourceUrl && normalizeText(debate.sourceUrl).toLowerCase() === sourceUrl) {
      return true;
    }
    if (title && String(debate.title || '').trim().toLowerCase() === title) {
      return true;
    }
    if (
      debate.listed !== false &&
      !debate.closed &&
      Number(debate.endsAt) > currentNow &&
      hasTopicOverlap(rawDebate, debate)
    ) {
      return true;
    }
    return false;
  }) || null;
}

function createDebate(rawDebate) {
  const launchValidation = validateDebateLaunchRequirements(rawDebate);
  if (!launchValidation.ok) {
    return null;
  }

  reconcileDebates();
  const duplicate = findDebateConflict(rawDebate);
  if (duplicate) {
    return null;
  }

  const order = debates.reduce((maxOrder, debate) => Math.max(maxOrder, Number(debate.order) || 0), -1) + 1;
  const createdAt = nowIso();
  const nextDebate = sanitizeDebate({
    ...rawDebate,
    id: rawDebate.id || crypto.randomUUID(),
    openedAt: Number(rawDebate.openedAt) > 0 ? Number(rawDebate.openedAt) : nowMs(),
    endsAt: Number(rawDebate.endsAt) > 0 ? Number(rawDebate.endsAt) : null,
    createdAt,
    updatedAt: createdAt,
    listed: rawDebate.listed !== false,
    order,
  }, order);

  debates.push(nextDebate);
  persistDebates(debates);
  return toPublicDebate(nextDebate);
}

function hideSurplusActiveDebates(maxVisibleActive) {
  const limit = Math.max(0, Math.floor(Number(maxVisibleActive) || 0));
  if (!limit) return [];

  reconcileDebates();

  // Sort so that NEWS debates come first (they have priority to stay visible).
  // Within each group, sort by order ascending (older debates first).
  // When slicing off the surplus, synthetic/seed debates are removed first.
  const activeListedDebates = debates
    .filter(debate => !debate.closed && debate.listed !== false)
    .sort((left, right) => {
      const leftIsNews  = left.createdFromNews  ? 1 : 0;
      const rightIsNews = right.createdFromNews ? 1 : 0;
      if (leftIsNews !== rightIsNews) return rightIsNews - leftIsNews; // news first
      return left.order - right.order;
    });

  if (activeListedDebates.length <= limit) {
    return [];
  }

  const hiddenIds = new Set(activeListedDebates.slice(limit).map(debate => String(debate.id)));
  const updatedAt = nowIso();

  debates = debates.map(debate => {
    if (!hiddenIds.has(String(debate.id))) {
      return debate;
    }
    return {
      ...debate,
      listed: false,
      updatedAt,
    };
  });

  persistDebates(debates);
  return [...hiddenIds];
}

function hideSourceBackfillDebates(slotCount) {
  const limit = Math.max(0, Math.floor(Number(slotCount) || 0));
  if (!limit) return [];

  reconcileDebates();

  const activeSyntheticDebates = debates
    .filter(debate => !debate.closed && debate.listed !== false && !debate.createdFromNews)
    .sort((left, right) => left.order - right.order);

  if (!activeSyntheticDebates.length) {
    return [];
  }

  const byCategory = new Map();
  activeSyntheticDebates.forEach(debate => {
    const category = debate.category || 'general';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(debate);
  });

  const hiddenIds = [];
  while (hiddenIds.length < limit) {
    const categories = [...byCategory.entries()]
      .filter(([, items]) => items.length > 3)
      .sort((left, right) => right[1].length - left[1].length);

    if (!categories.length) break;

    for (const [, items] of categories) {
      if (hiddenIds.length >= limit) break;
      const debate = items.pop();
      if (debate) hiddenIds.push(String(debate.id));
    }
  }

  if (!hiddenIds.length) {
    return [];
  }

  const hidden = new Set(hiddenIds);
  const updatedAt = nowIso();
  debates = debates.map(debate => {
    if (!hidden.has(String(debate.id))) {
      return debate;
    }
    return {
      ...debate,
      listed: false,
      updatedAt,
    };
  });

  persistDebates(debates);
  return hiddenIds;
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

module.exports = {
  TARGET_ACTIVE_DEBATES,
  applyBetToDebate,
  buildClientVerdict,
  countActiveDebates,
  createDebate,
  getDebateById,
  hideSourceBackfillDebates,
  hideSurplusActiveDebates,
  listDebates,
  removeBetFromDebate,
  reconcileDebates,
};
