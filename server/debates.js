'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fingerprintTitle, hasUsablePreviewImage } = require('./news-filter');
const {
  MIN_PREDICTION_DURATION_MS,
  MAX_PREDICTION_DURATION_MS,
  resolvePredictionDurationMs,
  nowIso,
} = require('./prediction-engine');
// Supabase history persistence (lazy — non-fatal if env vars missing)
let _pushHistoryBatch = null;
let _pullHistory = null;
try {
  const sb = require('./supabase');
  _pushHistoryBatch = sb.pushDebateHistoryBatch;
  _pullHistory      = sb.pullDebateHistory;
} catch (_) { /* Supabase not configured — in-memory only */ }

// Per-debate Supabase pull cache — avoids hammering the DB on every request
// while still ensuring every user sees the same full history.
const _historyPullCache = new Map(); // debateId -> { ts: number, rows: array }
const HISTORY_PULL_CACHE_TTL_MS = 60 * 1000;


const DATA_FILE = process.env.DEBATES_FILE || path.join(__dirname, 'data', 'debates.json');
const REGION_IDS = ['fr', 'de', 'gb', 'es', 'it', 'be', 'ch', 'nl', 'pt', 'pl', 'se', 'at'];
const TARGET_ACTIVE_DEBATES_PER_REGION = Math.max(12, Math.min(30, Number(process.env.DEBATE_TARGET_ACTIVE_PER_REGION) || 30));
const TARGET_ACTIVE_DEBATES = TARGET_ACTIVE_DEBATES_PER_REGION * REGION_IDS.length;
const PREPARED_PREDICTIONS_PER_REGION = Math.max(3, Math.min(12, Number(process.env.PREPARED_PREDICTIONS_PER_REGION) || 8));
const DEBATE_OVERLAP_SIMILARITY = Math.max(0.45, Math.min(0.9, Number(process.env.DEBATE_OVERLAP_SIMILARITY) || 0.62));
const EVENT_CREATION_LOOKAHEAD_MS = 12 * 60 * 60 * 1000;
const VALIDATION_WINDOW_MS = clamp(
  Number(process.env.PREDICTION_VALIDATION_WINDOW_MS) || 60000,
  30000,
  120000
);
const DEBATE_SCHEMA_VERSION = 3;
const PROBABILITY_HISTORY_MAX_POINTS = Math.max(200, Math.min(5000, Number(process.env.PROBABILITY_HISTORY_MAX_POINTS) || 2000));
const PROBABILITY_HISTORY_MAX_RETURNED = Math.max(50, Math.min(1000, Number(process.env.PROBABILITY_HISTORY_MAX_RETURNED) || 600));
const HISTORY_RANGE_MS = {
  '1H': 60 * 60 * 1000,
  '6H': 6 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  'MAX': Infinity,
};
const CATEGORY_PREVIEW_IMAGES = {
  sports: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=1200&q=80&auto=format&fit=crop',
  economy: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=1200&q=80&auto=format&fit=crop',
  politics: 'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=1200&q=80&auto=format&fit=crop',
  technology: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80&auto=format&fit=crop',
  society: 'https://images.unsplash.com/photo-1573164713988-8665fc963095?w=1200&q=80&auto=format&fit=crop',
  general: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=1200&q=80&auto=format&fit=crop',
};
const CATEGORY_PREVIEW_PALETTES = {
  sports: ['#2563eb', '#1d4ed8', '#0f172a'],
  economy: ['#16a34a', '#15803d', '#052e16'],
  politics: ['#f97316', '#ea580c', '#431407'],
  technology: ['#8b5cf6', '#6366f1', '#312e81'],
  society: ['#ec4899', '#db2777', '#500724'],
  general: ['#f97316', '#fb923c', '#7c2d12'],
};

let debates = loadDebates();

function nowMs() {
  return Date.now();
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

function normalizeState(value, allowed, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function resolveValidationWindowMs(value) {
  return clamp(
    Math.round(Number(value) || VALIDATION_WINDOW_MS),
    30000,
    120000
  );
}

function isFinalValidationState(state) {
  return ['validated', 'manual_admin', 'cancelled'].includes(normalizeText(state).toLowerCase());
}

function canAutoFallbackVerdict(debate) {
  const validationState = normalizeText(debate?.validationState).toLowerCase();
  const settlementState = normalizeText(debate?.settlementState).toLowerCase();
  return (
    Boolean(debate?.closed) &&
    !debate?.winnerSide &&
    !['validating', 'cancelled'].includes(validationState) &&
    !['locked', 'refund_pending', 'refunded'].includes(settlementState)
  );
}

function normalizeRegionId(value, fallback = 'fr') {
  const region = String(value || fallback).trim().toLowerCase();
  return REGION_IDS.includes(region) ? region : fallback;
}

// ─────────────────────────────────────────────────────────────
//  Synthetic history — deterministic O-U random walk
//  Produces a realistic-looking probability curve for a debate.
//  Seeded from the debate ID so the curve is stable across reads.
// ─────────────────────────────────────────────────────────────
function _hashSeed(str) {
  // djb2 — fast, good enough for visual seeding
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // unsigned 32-bit
  }
  return h;
}

function _makeRand(seed) {
  // Mulberry32 — small, fast, decent quality
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

/**
 * Generate a synthetic probability history using an Ornstein-Uhlenbeck
 * random walk between [fromTs, toTs], seeded deterministically from the
 * debate's id so repeated calls return the same curve.
 *
 * @param {object} debate   — must have id, yesPct, pool, durationMs
 * @param {number} fromTs   — start timestamp (ms)
 * @param {number} toTs     — end timestamp (ms)
 * @param {object} [opts]
 * @param {number} [opts.startYesPct]  — starting probability (default: random near yesPct)
 * @param {number} [opts.endYesPct]    — ending probability (default: debate.yesPct)
 * @param {number} [opts.startPool]    — starting pool volume (default: ~10 % of current)
 * @returns {Array} array of history point objects
 */
function generateSyntheticHistory(debate, fromTs, toTs, opts = {}) {
  const id        = String(debate.id || '');
  const rand      = _makeRand(_hashSeed(id + String(fromTs)));
  const totalMs   = Math.max(0, toTs - fromTs);
  if (totalMs < 90000) return []; // need at least 90 s to place any points

  const currentYesPct = clamp(Number(debate.yesPct) || 50, 5, 95);
  const endYesPct     = clamp(Number(opts.endYesPct   ?? currentYesPct), 5, 95);
  // Start somewhere offset from end — creates visible historical movement
  const startOffset   = (rand() - 0.5) * 28; // ± 14 pp
  const startYesPct   = clamp(Number(opts.startYesPct ?? (endYesPct + startOffset)), 5, 95);
  const endPool       = Math.max(100, Math.round(Number(debate.pool) || 1000));
  const startPool     = Math.max(0, Math.round(Number(opts.startPool ?? endPool * 0.10)));

  // One point every 2–5 minutes (seeded interval so it's deterministic)
  const intervalMs = 120000 + Math.floor(rand() * 180000);
  const steps      = Math.max(3, Math.floor(totalMs / intervalMs));

  const points = [];
  let pct = startYesPct;

  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    const ts       = Math.round(fromTs + progress * totalMs);
    const vol      = Math.round(startPool + progress * (endPool - startPool));

    // Ornstein-Uhlenbeck: dX = θ(μ – X)dt + σ dW
    // μ slides from startYesPct toward endYesPct as the debate progresses
    const mu    = startYesPct + progress * (endYesPct - startYesPct);
    const theta = 0.18;                         // mean-reversion speed
    const sigma = 5.5 + rand() * 3.5;           // volatility: 5.5–9 pp per step
    const drift = theta * (mu - pct);
    const noise = (rand() - 0.5) * 2 * sigma;
    pct = clamp(pct + drift + noise, 5, 95);

    points.push({
      predictionId: id,
      timestamp:    ts,
      yesProbability: roundNumber(i === steps ? endYesPct : pct, 2),
      noProbability:  roundNumber(100 - (i === steps ? endYesPct : pct), 2),
      volume: vol,
    });
  }

  return points;
}

function normalizeHistoryRange(value) {
  const key = String(value || '1H').trim().toUpperCase();
  return HISTORY_RANGE_MS[key] ? key : '1H';
}

function getPreviewImageUrl(rawDebate = {}) {
  return normalizeText(rawDebate.sourceImageUrl || rawDebate.photo);
}

function buildProbabilityHistoryPoint(debate, timestamp = nowMs()) {
  const yesProbability = clamp(Number(debate?.yesPct) || 50, 0, 100);
  const volume = Math.max(0, roundNumber(debate?.pool || 0, 0));
  return {
    predictionId: String(debate?.id || ''),
    timestamp: Math.max(0, Math.round(Number(timestamp) || nowMs())),
    yesProbability: roundNumber(yesProbability, 2),
    noProbability: roundNumber(100 - yesProbability, 2),
    volume,
  };
}

function sanitizeProbabilityHistory(rawHistory, debate) {
  const fallbackTimestamp = Number(debate?.openedAt) > 0
    ? Number(debate.openedAt)
    : (Number(debate?.createdAt) ? Number(debate.createdAt) : nowMs());
  const input = Array.isArray(rawHistory) ? rawHistory : [];

  const normalized = input
    .map(point => {
      const timestamp = Math.max(0, Math.round(Number(point?.timestamp || point?.ts || fallbackTimestamp) || fallbackTimestamp));
      const yesProbability = clamp(Number(point?.yesProbability ?? point?.yesPct ?? point?.value ?? debate?.yesPct ?? 50), 0, 100);
      const volume = Math.max(0, roundNumber(point?.volume ?? point?.pool ?? debate?.pool ?? 0, 0));
      return {
        predictionId: String(point?.predictionId || debate?.id || ''),
        timestamp,
        yesProbability: roundNumber(yesProbability, 2),
        noProbability: roundNumber(100 - yesProbability, 2),
        volume,
      };
    })
    .filter(point => Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);

  const deduped = [];
  normalized.forEach(point => {
    const last = deduped[deduped.length - 1];
    if (last && last.timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
      return;
    }
    deduped.push(point);
  });

  if (!deduped.length) {
    deduped.push(buildProbabilityHistoryPoint(debate, fallbackTimestamp));
  }

  if (deduped.length > PROBABILITY_HISTORY_MAX_POINTS) {
    return deduped.slice(-PROBABILITY_HISTORY_MAX_POINTS);
  }

  return deduped;
}

function appendProbabilityHistoryPoint(history, point, { force = false } = {}) {
  const nextHistory = Array.isArray(history) ? history.slice() : [];
  const last = nextHistory[nextHistory.length - 1];

  if (last) {
    const tooClose = Math.abs(Number(last.timestamp || 0) - Number(point.timestamp || 0)) < 1000;
    const sameShape =
      Math.abs(Number(last.yesProbability || 0) - Number(point.yesProbability || 0)) < 0.01 &&
      Math.abs(Number(last.volume || 0) - Number(point.volume || 0)) < 1;

    if (!force && sameShape) {
      return {
        history: nextHistory,
        point: last,
        changed: false,
      };
    }

    if (tooClose) {
      nextHistory[nextHistory.length - 1] = point;
      return {
        history: nextHistory.slice(-PROBABILITY_HISTORY_MAX_POINTS),
        point,
        changed: true,
      };
    }
  }

  nextHistory.push(point);
  return {
    history: nextHistory.slice(-PROBABILITY_HISTORY_MAX_POINTS),
    point,
    changed: true,
  };
}

function compressProbabilityHistory(points, maxPoints = PROBABILITY_HISTORY_MAX_RETURNED) {
  if (!Array.isArray(points) || points.length <= maxPoints) {
    return Array.isArray(points) ? points.slice() : [];
  }

  const step = Math.ceil(points.length / maxPoints);
  const reduced = [];
  for (let index = 0; index < points.length; index += step) {
    reduced.push(points[index]);
  }
  const last = points[points.length - 1];
  if (!reduced.length || reduced[reduced.length - 1].timestamp !== last.timestamp) {
    reduced.push(last);
  }
  return reduced;
}

function getCategoryPreviewImage(category = 'general') {
  return CATEGORY_PREVIEW_IMAGES[category] || CATEGORY_PREVIEW_IMAGES.general;
}

function imageFingerprint(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.toLowerCase();
  } catch (_) {
    return raw;
  }
}

function stableHashSeed(seed) {
  const digest = crypto.createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 8);
  return parseInt(digest, 16);
}

function shortenPreviewTitle(value, maxLength = 58) {
  const safe = normalizeText(value);
  if (!safe) return 'BEEEF';
  if (safe.length <= maxLength) return safe;
  return `${safe.slice(0, maxLength - 1).trimEnd()}…`;
}

function getPreviewPalette(category = 'general') {
  return CATEGORY_PREVIEW_PALETTES[category] || CATEGORY_PREVIEW_PALETTES.general;
}

function buildGeneratedPreviewImage(rawDebate = {}, variantSeed = '') {
  const palette = getPreviewPalette(rawDebate.category);
  const title = shortenPreviewTitle(rawDebate.title || rawDebate.sourceTitle || 'Prediction');
  const source = shortenPreviewTitle(rawDebate.sourceFeedLabel || rawDebate.sourceDomain || rawDebate.predictionSourceType || 'BEEEF', 28).toUpperCase();
  const region = normalizeRegionId(rawDebate.region || 'fr').toUpperCase();
  const seed = stableHashSeed(`${variantSeed}:${title}:${source}:${region}`);
  const accentOffset = 28 + (seed % 36);
  const opacityA = 0.18 + ((seed % 4) * 0.04);
  const opacityB = 0.12 + (((seed >> 3) % 4) * 0.04);
  const label = rawDebate.createdFromNews ? 'MEDIA PREDICTION' : 'ACTION PREDICTION';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" role="img" aria-label="${title}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${palette[0]}"/>
          <stop offset="55%" stop-color="${palette[1]}"/>
          <stop offset="100%" stop-color="${palette[2]}"/>
        </linearGradient>
        <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="rgba(255,255,255,0.24)"/>
          <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="675" rx="42" fill="url(#g)"/>
      <circle cx="${180 + (seed % 120)}" cy="${150 + (seed % 80)}" r="${180 + (seed % 70)}" fill="rgba(255,255,255,${opacityA.toFixed(2)})"/>
      <circle cx="${980 - (seed % 120)}" cy="${560 - (seed % 90)}" r="${220 + ((seed >> 4) % 80)}" fill="rgba(255,255,255,${opacityB.toFixed(2)})"/>
      <rect x="48" y="48" width="220" height="46" rx="23" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.22)"/>
      <text x="74" y="78" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" letter-spacing="2">${label}</text>
      <text x="68" y="178" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="62" font-weight="800">${title}</text>
      <text x="68" y="238" fill="rgba(255,255,255,0.82)" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="500">${source}</text>
      <rect x="68" y="520" width="260" height="10" rx="5" fill="rgba(255,255,255,0.26)"/>
      <rect x="68" y="520" width="${320 + accentOffset * 3}" height="10" rx="5" fill="#ffffff"/>
      <text x="68" y="596" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700">${region} • ${String(rawDebate.category || 'general').toUpperCase()}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function resolveDebatePreviewImage(rawDebate = {}, options = {}) {
  const directImageUrl = getPreviewImageUrl(rawDebate);
  const candidate = hasUsablePreviewImage(directImageUrl)
    ? directImageUrl
    : getCategoryPreviewImage(rawDebate.category);

  const usedFingerprints = options.usedFingerprints instanceof Set
    ? options.usedFingerprints
    : new Set();
  const fingerprint = imageFingerprint(candidate);
  if (candidate && fingerprint && !usedFingerprints.has(fingerprint)) {
    return candidate;
  }

  return buildGeneratedPreviewImage(
    rawDebate,
    normalizeText(rawDebate.predictionKey || rawDebate.sourceKey || rawDebate.id || rawDebate.title || crypto.randomUUID())
  );
}

function hasDebateSourceContext(rawDebate = {}) {
  return Boolean(
    normalizeText(rawDebate.sourceTitle || rawDebate.title) &&
    (
      normalizeText(rawDebate.sourceUrl) ||
      normalizeText(rawDebate.sourceExcerpt) ||
      normalizeText(rawDebate.sourceDescription) ||
      normalizeText(rawDebate.proofVideoUrl) ||
      normalizeText(rawDebate.contextVideoUrl) ||
      normalizeText(rawDebate.previewVideoUrl) ||
      normalizeText(rawDebate.actionRule?.proofUrl)
    )
  );
}

function dedupeOpenPreviewImages(items = []) {
  const usedFingerprints = new Set();
  let changed = false;

  const nextItems = items.map((debate, index) => {
    if (debate.closed) {
      return debate;
    }

    const uniqueImage = resolveDebatePreviewImage(debate, { usedFingerprints });
    const nextFingerprint = imageFingerprint(uniqueImage);
    if (nextFingerprint) {
      usedFingerprints.add(nextFingerprint);
    }

    if (uniqueImage !== debate.photo || uniqueImage !== debate.sourceImageUrl) {
      changed = true;
      return sanitizeDebate({
        ...debate,
        photo: uniqueImage,
        sourceImageUrl: uniqueImage,
      }, index, { skipImageDedup: true });
    }

    return debate;
  });

  return {
    debates: nextItems,
    changed,
  };
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

function validateDebateEventContext(rawDebate = {}) {
  const now = nowMs();
  const eventTitle = normalizeText(rawDebate.eventTitle || rawDebate.sourceTitle || rawDebate.title);
  const eventStartsAtMs = Date.parse(rawDebate.eventStartsAt || rawDebate.actionRule?.eventStartsAt || 0);
  const eventEndsAtMs = Date.parse(rawDebate.eventEndsAt || rawDebate.actionRule?.eventEndsAt || rawDebate.endsAt || 0);
  const predictionEndsAtMs = Number(rawDebate.endsAt) > 0
    ? Number(rawDebate.endsAt)
    : now + getDebateDurationMs(rawDebate);
  const eventStatus = normalizeText(rawDebate.eventStatus || rawDebate.actionRule?.eventStatus).toLowerCase();
  const verificationUrl = normalizeText(
    rawDebate.sourceUrl ||
    rawDebate.actionRule?.proofUrl ||
    rawDebate.verificationSource?.url
  );

  if (!eventTitle) {
    return { ok: false, reason: 'missing_event_title' };
  }
  if (!verificationUrl) {
    return { ok: false, reason: 'missing_verification_source' };
  }
  if (!Number.isFinite(eventStartsAtMs) || !Number.isFinite(eventEndsAtMs) || eventEndsAtMs <= eventStartsAtMs) {
    return { ok: false, reason: 'missing_event_window' };
  }
  if (eventEndsAtMs <= now) {
    return { ok: false, reason: 'event_already_finished' };
  }

  const isLive = eventStatus === 'live' || eventStatus === 'in' || eventStatus === 'in_progress' || (eventStartsAtMs <= now && eventEndsAtMs > now);
  if (!isLive) {
    const lookaheadMs = eventStartsAtMs - now;
    if (lookaheadMs < 0 || lookaheadMs > EVENT_CREATION_LOOKAHEAD_MS) {
      return { ok: false, reason: 'event_not_imminent' };
    }
  }

  const remainingPredictionMs = predictionEndsAtMs - now;
  if (remainingPredictionMs < MIN_PREDICTION_DURATION_MS || remainingPredictionMs > MAX_PREDICTION_DURATION_MS) {
    return { ok: false, reason: 'prediction_window_out_of_bounds' };
  }
  if (predictionEndsAtMs > eventEndsAtMs + 5 * 60 * 1000) {
    return { ok: false, reason: 'prediction_exceeds_event_window' };
  }

  return { ok: true, reason: null };
}

function isMediaDebate(rawDebate = {}) {
  return Boolean(rawDebate.createdFromNews || normalizeText(rawDebate.predictionSourceType).toLowerCase() === 'news');
}

function findOpenPreviewImageConflict(rawDebate = {}, options = {}) {
  if (!isMediaDebate(rawDebate)) {
    return null;
  }

  const candidateImage = getPreviewImageUrl(rawDebate);
  if (!hasUsablePreviewImage(candidateImage)) {
    return null;
  }

  const candidateFingerprint = imageFingerprint(candidateImage);
  if (!candidateFingerprint) {
    return null;
  }

  const existingDebates = Array.isArray(options.existingDebates) ? options.existingDebates : debates;
  const excludeId = normalizeText(options.excludeId || rawDebate.id);

  return existingDebates.find(debate => {
    if (!debate || debate.closed || !isMediaDebate(debate)) {
      return false;
    }
    if (excludeId && String(debate.id) === excludeId) {
      return false;
    }
    return imageFingerprint(getPreviewImageUrl(debate)) === candidateFingerprint;
  }) || null;
}

function validateDebateLaunchRequirements(rawDebate = {}, options = {}) {
  if (!normalizeText(rawDebate.title)) {
    return { ok: false, reason: 'missing_title' };
  }

  const durationMs = getDebateDurationMs(rawDebate);
  if (!Number.isFinite(durationMs) || durationMs < MIN_PREDICTION_DURATION_MS || durationMs > MAX_PREDICTION_DURATION_MS) {
    return { ok: false, reason: 'invalid_duration' };
  }

  if (!hasDebateSourceContext(rawDebate)) {
    return { ok: false, reason: 'missing_source_context' };
  }

  if (!hasUsablePreviewImage(resolveDebatePreviewImage(rawDebate))) {
    return { ok: false, reason: 'missing_preview_image' };
  }

  const eventValidation = validateDebateEventContext(rawDebate);
  if (!eventValidation.ok) {
    return eventValidation;
  }

  const previewConflict = findOpenPreviewImageConflict(rawDebate, options);
  if (previewConflict) {
    return {
      ok: false,
      reason: 'duplicate_media_image',
      conflictId: previewConflict.id,
      conflictTitle: normalizeText(previewConflict.title || previewConflict.sourceTitle),
    };
  }

  if (
    normalizeText(rawDebate.predictionKey) &&
    rawDebate.actionRule &&
    typeof rawDebate.actionRule === 'object' &&
    (
      normalizeText(rawDebate.actionRule.eventId) ||
      normalizeText(rawDebate.actionRule.topicFingerprint) ||
      normalizeText(rawDebate.actionRule.proofUrl)
    )
  ) {
    return { ok: true, reason: null };
  }

  if (
    normalizeText(rawDebate.sourceKey) &&
    rawDebate.createdFromNews &&
    hasDebateSourceContext(rawDebate)
  ) {
    return { ok: true, reason: null };
  }

  return { ok: false, reason: 'missing_prediction_metadata' };
}

function getDebateDurationMs(rawDebate = {}) {
  return resolvePredictionDurationMs({
    explicitDurationMs: rawDebate.durationMs,
    expectedEndsAt: rawDebate.endsAt,
  });
}

function createFallbackVerdict(debate, winnerSide = 'no', reason = '') {
  const winner = winnerSide === 'yes' ? debate.yesLabel : debate.noLabel;
  return {
    winnerSide,
    winnerLabel: winner,
    winner,
    conviction: winnerSide === 'yes'
      ? { yes: 8, no: 5 }
      : { yes: 5, no: 8 },
    logic: winnerSide === 'yes'
      ? { yes: 8, no: 5 }
      : { yes: 5, no: 8 },
    originality: winnerSide === 'yes'
      ? { yes: 7, no: 5 }
      : { yes: 5, no: 7 },
    reasoning: reason || (winnerSide === 'yes'
      ? `${winner} a ete valide par la source de reference.`
      : `${winner} l'emporte faute de validation source avant l'echeance.`),
  };
}

function sanitizeDebate(raw, index = 0, options = {}) {
  const region = normalizeRegionId(raw.region);
  const durationMs = Number(raw.durationMs) > 0
    ? Math.max(MIN_PREDICTION_DURATION_MS, Math.min(MAX_PREDICTION_DURATION_MS, Number(raw.durationMs)))
    : getDebateDurationMs(raw);
  const openedAt = Number(raw.openedAt) > 0 ? Number(raw.openedAt) : nowMs();
  const endsAt = Number(raw.endsAt) > 0 ? Number(raw.endsAt) : openedAt + durationMs;
  const closed = Boolean(raw.closed) || nowMs() >= endsAt;
  const previewImageUrl = options.skipImageDedup
    ? normalizeText(raw.sourceImageUrl || raw.photo || buildGeneratedPreviewImage(raw))
    : resolveDebatePreviewImage(raw);
  const predictionKey = normalizeText(raw.predictionKey || raw.sourceKey || raw.id).toLowerCase();
  const base = {
    id: String(raw.id),
    region,
    title: String(raw.title || 'Prediction'),
    category: String(raw.category || 'general'),
    trending: Boolean(raw.trending),
    ai: Boolean(raw.ai),
    yesPct: clamp(Math.round(Number(raw.yesPct) || 50), 5, 95),
    pool: roundNumber(raw.pool || 0, 0),
    viewers: Math.max(0, Math.round(Number(raw.viewers) || 0)),
    gradColors: Array.isArray(raw.gradColors) && raw.gradColors.length >= 3
      ? raw.gradColors.slice(0, 3).map(String)
      : ['#f97316', '#fb923c', '#431407'],
    yesLabel: String(raw.yesLabel || 'YES'),
    noLabel: String(raw.noLabel || 'NO'),
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
    proofVideoUrl: normalizeText(raw.proofVideoUrl || raw.contextVideoUrl || raw.previewVideoUrl),
    liveVideoId: raw.liveVideoId ? String(raw.liveVideoId) : null,
    liveEmbedUrl: raw.liveEmbedUrl ? String(raw.liveEmbedUrl) : null,
    liveChannel: raw.liveChannel ? String(raw.liveChannel) : null,
    createdFromLive: Boolean(raw.createdFromLive),
    sourceFeedLabel: normalizeText(raw.sourceFeedLabel),
    sourceDomain: normalizeText(raw.sourceDomain),
    sourceKey: normalizeText(raw.sourceKey).toLowerCase(),
    newsPublishedAt: raw.newsPublishedAt ? String(raw.newsPublishedAt) : null,
    createdFromNews: Boolean(raw.createdFromNews),
    schemaVersion: Number(raw.schemaVersion) || DEBATE_SCHEMA_VERSION,
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
    predictionType: normalizeText(raw.predictionType || 'action_prediction'),
    predictionKey,
    predictionSourceType: normalizeText(raw.predictionSourceType || 'sports'),
    predictionRegionServer: normalizeText(raw.predictionRegionServer),
    eventTitle: normalizeText(raw.eventTitle || raw.sourceTitle || raw.title),
    eventStartsAt: normalizeText(raw.eventStartsAt),
    eventEndsAt: normalizeText(raw.eventEndsAt || (Number.isFinite(endsAt) ? nowIso(endsAt) : '')),
    eventStatus: normalizeText(raw.eventStatus || ((openedAt <= nowMs() && endsAt > nowMs()) ? 'live' : 'scheduled')),
    verificationProvider: normalizeText(raw.verificationProvider || raw.predictionSourceType),
    verificationSource: raw.verificationSource && typeof raw.verificationSource === 'object' ? raw.verificationSource : null,
    resolutionMethod: normalizeText(raw.resolutionMethod || 'api_validation'),
    validationState: normalizeState(
      raw.validationState || (closed ? 'validating' : 'pending'),
      ['pending', 'validating', 'validated', 'manual_admin', 'cancelled', 'expired_unconfirmed'],
      closed ? 'validating' : 'pending'
    ),
    validationEvidence: raw.validationEvidence && typeof raw.validationEvidence === 'object' ? raw.validationEvidence : null,
    validationStartedAt: Number(raw.validationStartedAt) > 0 ? Number(raw.validationStartedAt) : null,
    validationEndsAt: Number(raw.validationEndsAt) > 0 ? Number(raw.validationEndsAt) : null,
    settlementState: normalizeState(
      raw.settlementState || (closed ? 'locked' : 'open'),
      ['open', 'locked', 'ready', 'settled', 'refund_pending', 'refunded'],
      closed ? 'locked' : 'open'
    ),
    settlementSummary: raw.settlementSummary && typeof raw.settlementSummary === 'object' ? raw.settlementSummary : null,
    settlementCompletedAt: Number(raw.settlementCompletedAt) > 0 ? Number(raw.settlementCompletedAt) : null,
    closureReason: normalizeText(raw.closureReason),
    actionRule: raw.actionRule && typeof raw.actionRule === 'object' ? raw.actionRule : null,
    preparedAt: raw.preparedAt ? String(raw.preparedAt) : null,
  };

  base.probabilityHistory = sanitizeProbabilityHistory(raw.probabilityHistory, base);

  if (base.closed && !base.validationStartedAt) {
    base.validationStartedAt = base.closedAt || base.endsAt || nowMs();
  }
  if (base.closed && !base.validationEndsAt && !isFinalValidationState(base.validationState)) {
    base.validationEndsAt = (base.validationStartedAt || nowMs()) + resolveValidationWindowMs(raw.validationWindowMs);
  }
  if (base.validationState === 'validated' && base.settlementState === 'locked') {
    base.settlementState = 'ready';
  }
  if (base.validationState === 'cancelled' && base.settlementState === 'locked') {
    base.settlementState = 'refund_pending';
  }

  if (canAutoFallbackVerdict(base)) {
    const verdict = createFallbackVerdict(base, 'no', 'No validated source confirmed the action before expiry.');
    base.winnerSide = verdict.winnerSide;
    base.winnerLabel = verdict.winnerLabel;
    base.verdictReasoning = verdict.reasoning;
    base.verdictScores = {
      conviction: verdict.conviction,
      logic: verdict.logic,
      originality: verdict.originality,
    };
    base.validationState = base.validationState === 'pending' ? 'expired_unconfirmed' : base.validationState;
    base.closedAt = base.closedAt || base.endsAt;
  }

  return base;
}

function persistDebates(nextDebates) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(nextDebates, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function resetAllPredictions() {
  return [];
}

function countActiveListedDebates(items) {
  const currentNow = nowMs();
  return items.filter(debate => debate.listed !== false && !debate.closed && Number(debate.endsAt) > currentNow).length;
}

function isActiveDebate(debate, currentNow = nowMs()) {
  return !debate.closed && Number(debate.endsAt) > currentNow;
}

function ensureActiveDebatesForRegion(items, region) {
  let nextDebates = items.slice();
  const currentNow = nowMs();
  let activeListedCount = countActiveListedDebates(nextDebates.filter(debate => debate.region === region));
  if (activeListedCount >= TARGET_ACTIVE_DEBATES_PER_REGION) {
    return { debates: nextDebates, refreshed: false };
  }

  const refreshedAt = nowIso();
  let changed = false;

  nextDebates = nextDebates.map(debate => {
    if (
      debate.region === region &&
      debate.listed === false &&
      activeListedCount < TARGET_ACTIVE_DEBATES_PER_REGION &&
      isActiveDebate(debate, currentNow)
    ) {
      activeListedCount += 1;
      changed = true;
      return {
        ...debate,
        listed: true,
        preparedAt: null,
        updatedAt: refreshedAt,
      };
    }
    return debate;
  });

  return {
    debates: nextDebates,
    refreshed: changed,
  };
}

function ensureActiveDebates(items) {
  const sanitized = items.map((debate, index) => sanitizeDebate(debate, index));
  const deduped = dedupeOpenPreviewImages(sanitized);
  let nextDebates = deduped.debates.slice();
  let changed = deduped.changed;

  REGION_IDS.forEach(region => {
    const result = ensureActiveDebatesForRegion(nextDebates, region);
    nextDebates = result.debates;
    changed = changed || result.refreshed;
  });

  return {
    debates: nextDebates,
    refreshed: changed,
  };
}

function hasLegacyDebateSchema(items) {
  if (!Array.isArray(items)) return true;
  if (!items.length) return false;

  return items.some(debate => {
    const region = String(debate?.region || '').trim().toLowerCase();
    const durationMs = Number(debate?.durationMs || 0);
    return (
      !REGION_IDS.includes(region) ||
      !Number.isFinite(durationMs) ||
      durationMs < MIN_PREDICTION_DURATION_MS ||
      durationMs > MAX_PREDICTION_DURATION_MS ||
      Number(debate?.schemaVersion || 0) !== DEBATE_SCHEMA_VERSION ||
      !normalizeText(debate?.predictionKey)
    );
  });
}

function loadDebates() {
  if (!fs.existsSync(DATA_FILE)) {
    const reset = resetAllPredictions();
    persistDebates(reset);
    return reset;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed) || hasLegacyDebateSchema(parsed)) {
      const reset = resetAllPredictions();
      persistDebates(reset);
      return reset;
    }

    const result = ensureActiveDebates(parsed);
    if (result.refreshed) {
      persistDebates(result.debates);
    }
    return result.debates;
  } catch (error) {
    console.warn('[debates] failed to read prediction file, resetting', error);
    const reset = resetAllPredictions();
    persistDebates(reset);
    return reset;
  }
}

function reconcileDebates() {
  const currentNow = nowMs();
  let changed = false;
  const closedIds = [];

  debates = debates.map((debate, index) => {
    const safeDebate = sanitizeDebate(debate, index);

    // ── Purge legacy opinion-poll debates ────────────────────────────────────
    // Old debates created before the ESPN/CoinGecko pipeline have no
    // predictionSourceType and no openedAt. They never expire naturally.
    // Close them immediately so they stop polluting the active list.
    if (
      !safeDebate.closed &&
      !safeDebate.predictionSourceType &&
      !safeDebate.openedAt
    ) {
      changed = true;
      closedIds.push(safeDebate.id);
      console.log('[reconcile] purging legacy debate:', safeDebate.title?.slice(0, 60));
      return sanitizeDebate({
        ...safeDebate,
        closed: true,
        closedAt: currentNow,
        endsAt: currentNow,
        winnerSide: null,
        validationState: 'cancelled',
        settlementState: 'refunded',
        closureReason: 'legacy_purge',
        verdictReasoning: 'Legacy debate replaced by real-event prediction.',
        updatedAt: nowIso(currentNow),
      }, index);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!safeDebate.closed && currentNow >= safeDebate.endsAt) {
      changed = true;
      closedIds.push(safeDebate.id);
      return sanitizeDebate({
        ...safeDebate,
        closed: true,
        closedAt: currentNow,
        winnerSide: safeDebate.winnerSide || null,
        winnerLabel: safeDebate.winnerLabel || null,
        verdictReasoning: normalizeText(
          safeDebate.verdictReasoning ||
          'The event window ended. Waiting for final source validation before settling the market.'
        ),
        verdictScores: safeDebate.verdictScores || null,
        validationState: isFinalValidationState(safeDebate.validationState) ? safeDebate.validationState : 'validating',
        validationStartedAt: safeDebate.validationStartedAt || currentNow,
        validationEndsAt: Math.max(
          Number(safeDebate.validationEndsAt) || 0,
          (safeDebate.validationStartedAt || currentNow) + VALIDATION_WINDOW_MS
        ),
        settlementState: ['settled', 'refunded'].includes(safeDebate.settlementState) ? safeDebate.settlementState : 'locked',
        closureReason: normalizeText(safeDebate.closureReason || 'event_window_elapsed'),
        updatedAt: nowIso(currentNow),
      }, index);
    }
    return safeDebate;
  });

  const refillResult = ensureActiveDebates(debates);
  if (refillResult.refreshed) {
    debates = refillResult.debates;
    changed = true;
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
    region: debate.region,
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
    proofVideoUrl: debate.proofVideoUrl,
    sourceFeedLabel: debate.sourceFeedLabel,
    sourceDomain: debate.sourceDomain,
    sourceKey: debate.sourceKey,
    newsPublishedAt: debate.newsPublishedAt,
    createdFromNews: debate.createdFromNews,
    createdFromLive: debate.createdFromLive,
    liveVideoId: debate.liveVideoId,
    liveEmbedUrl: debate.liveEmbedUrl,
    liveChannel: debate.liveChannel,
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
    predictionType: debate.predictionType,
    predictionKey: debate.predictionKey,
    predictionSourceType: debate.predictionSourceType,
    predictionRegionServer: debate.predictionRegionServer,
    eventTitle: debate.eventTitle,
    eventStartsAt: debate.eventStartsAt,
    eventEndsAt: debate.eventEndsAt,
    eventStatus: debate.eventStatus,
    verificationProvider: debate.verificationProvider,
    verificationSource: debate.verificationSource,
    resolutionMethod: debate.resolutionMethod,
    validationState: debate.validationState,
    validationEvidence: debate.validationEvidence,
    validationStartedAt: debate.validationStartedAt,
    validationEndsAt: debate.validationEndsAt,
    settlementState: debate.settlementState,
    settlementSummary: debate.settlementSummary,
    settlementCompletedAt: debate.settlementCompletedAt,
    closureReason: debate.closureReason,
    actionRule: debate.actionRule,
    preparedAt: debate.preparedAt,
  };
}

function listDebates(options = {}) {
  const {
    includeUnlisted = false,
    region = null,
  } = options;
  reconcileDebates();
  const normalizedRegion = region ? normalizeRegionId(region, null) : null;
  return debates
    .slice()
    .filter(debate => !normalizedRegion || debate.region === normalizedRegion)
    .filter(debate => includeUnlisted || debate.listed !== false)
    .sort((left, right) => left.order - right.order)
    .map(toPublicDebate);
}

function getDebateById(debateId) {
  reconcileDebates();
  const match = debates.find(debate => String(debate.id) === String(debateId));
  return match ? toPublicDebate(match) : null;
}

function getDebateIndexById(debateId) {
  return debates.findIndex(debate => String(debate.id) === String(debateId));
}

function recordProbabilityHistoryAtIndex(index, { force = false, timestamp = nowMs() } = {}) {
  if (index < 0 || index >= debates.length) {
    return null;
  }

  const debate = debates[index];
  const point = buildProbabilityHistoryPoint(debate, timestamp);
  const appended = appendProbabilityHistoryPoint(debate.probabilityHistory, point, { force });

  if (!appended.changed && Array.isArray(debate.probabilityHistory) && debate.probabilityHistory.length) {
    return appended.point;
  }

  debates[index] = {
    ...debate,
    probabilityHistory: appended.history,
  };

  // Persist to Supabase — only real points (at or after debate.openedAt)
  const _openedAt = Number(debate.openedAt) > 0 ? Number(debate.openedAt) - 5000 : 0;
  if (appended.changed && appended.point && typeof _pushHistoryBatch === 'function'
      && Number(appended.point.timestamp) >= _openedAt) {
    _pushHistoryBatch([{
      debate_id:   String(debate.id),
      recorded_at: Number(appended.point.timestamp),
      yes_prob:    Number(appended.point.yesProbability),
      volume:      Number(appended.point.volume || 0),
    }]).catch(function() { /* non-fatal */ });
  }

  return appended.point;
}

function getLatestPredictionHistoryPoint(debateId) {
  reconcileDebates();
  const index = getDebateIndexById(debateId);
  if (index === -1) return null;
  const history = sanitizeProbabilityHistory(debates[index].probabilityHistory, debates[index]);
  return history[history.length - 1] || null;
}

/**
 * Returns true when the real history is too sparse or too flat to render
 * a meaningful curve — meaning we should prepend synthetic pre-history.
 *
 * Criteria (any):
 *  • Fewer than 5 real points, OR
 *  • All real points have the same yesProbability (within ±0.5 pp), OR
 *  • Real history covers less than 45 minutes of wall-clock time
 *    (debate just started — bots have only been running a few minutes,
 *     so the 1H chart would show mostly empty space without synthetic fill)
 */
function _historySparse(history) {
  if (!Array.isArray(history) || history.length < 5) return true;
  const timestamps = history.map(p => Number(p.timestamp));
  const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
  if (spanMs < 45 * 60 * 1000) return true; // less than 45 min of real data
  const min = Math.min(...history.map(p => p.yesProbability));
  const max = Math.max(...history.map(p => p.yesProbability));
  return (max - min) < 0.5;
}

/**
 * Merge synthetic pre-history with real history, removing duplicates,
 * preserving sort order.  Synthetic points that overlap real points in
 * time are discarded so the real data always wins.
 */
function _mergeHistory(synthetic, real) {
  if (!synthetic.length) return real;
  const firstRealTs = real.length ? real[0].timestamp : Infinity;
  // Keep only synthetic points strictly before the first real point
  const pre = synthetic.filter(p => p.timestamp < firstRealTs);
  return [...pre, ...real].sort((a, b) => a.timestamp - b.timestamp);
}

async function getPredictionHistory(debateId, range) {
  if (range === undefined) range = '1H';
  reconcileDebates();
  const index = getDebateIndexById(debateId);
  if (index === -1) return [];

  const debate = debates[index];
  const normalizedRange = normalizeHistoryRange(range);
  let realHistory = sanitizeProbabilityHistory(debate.probabilityHistory, debate);

  // ── Always pull from Supabase and merge (cached 60 s per debate) ───────────
  //
  // KEY INVARIANT: every user must see the same history — the real record of
  // what happened — regardless of when the server restarted or when they
  // opened the page.  The old approach (pull only when _historySparse) broke
  // this: once the server accumulated ≥5 bot points with variance, Supabase
  // was never queried again and pre-restart history was permanently invisible.
  //
  // Fix: unconditionally pull from Supabase on every history request, but
  // cache the raw rows per debate for 60 s so we don't hammer the DB.
  // In-memory live points are always merged on top so they stay current.
  // ───────────────────────────────────────────────────────────────────────────
  if (typeof _pullHistory === 'function') {
    try {
      const now = nowMs();
      const cacheKey = String(debateId);
      const cached = _historyPullCache.get(cacheKey);
      let rows;
      if (cached && (now - cached.ts) < HISTORY_PULL_CACHE_TTL_MS) {
        rows = cached.rows;
      } else {
        const cutoffTs = now - 48 * 60 * 60 * 1000; // 48 h back
        rows = await _pullHistory(cacheKey, cutoffTs);
        _historyPullCache.set(cacheKey, { ts: now, rows: rows });
      }
      if (Array.isArray(rows) && rows.length > 0) {
        const recovered = rows.map(function(r) {
          return {
            timestamp:      Number(r.recorded_at),
            yesProbability: Number(r.yes_prob),
            volume:         Number(r.volume || 0),
          };
        });
        // Supabase fills the past; in-memory (realHistory) has the latest live pts.
        // Deduplicate by timestamp — in-memory wins on conflict.
        const memTs = new Set(realHistory.map(function(p) { return p.timestamp; }));
        const merged = recovered
          .filter(function(p) { return !memTs.has(p.timestamp); })
          .concat(realHistory)
          .sort(function(a, b) { return a.timestamp - b.timestamp; });
        if (merged.length > realHistory.length) {
          // Back-fill in-memory so subsequent calls benefit immediately.
          debates[index] = Object.assign({}, debates[index], {
            probabilityHistory: merged.slice(-PROBABILITY_HISTORY_MAX_POINTS),
          });
          realHistory = sanitizeProbabilityHistory(debates[index].probabilityHistory, debate);
        }
      }
    } catch (_) { /* non-fatal — degrade to in-memory only */ }
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (!realHistory.length) return [];

  // ── Only real data — no synthetic pre-history ───────────────────────────────
  // Filter out any points that pre-date the debate opening (could have been
  // pushed to Supabase from a previous synthetic-history run).
  const debateOpenedAt = Number(debate.openedAt) > 0 ? Number(debate.openedAt) : 0;
  const history = debateOpenedAt > 0
    ? realHistory.filter(function(p) { return p.timestamp >= debateOpenedAt - 5000; }) // 5s grace
    : realHistory;
  // ────────────────────────────────────────────────────────────────────────────

  if (normalizedRange === 'MAX') {
    return compressProbabilityHistory(history).map(function(point) {
      return {
        predictionId: String(debate.id),
        timestamp: point.timestamp,
        yesProbability: point.yesProbability,
        volume: point.volume,
      };
    });
  }

  const cutoff = nowMs() - HISTORY_RANGE_MS[normalizedRange];
  const visible = history.filter(function(point) { return point.timestamp >= cutoff; });
  const anchor = history.slice().reverse().find(function(point) { return point.timestamp < cutoff; }) || null;
  const points = visible.slice();

  if (anchor && (!points.length || points[0].timestamp !== anchor.timestamp)) {
    points.unshift(anchor);
  }

  const compacted = compressProbabilityHistory(points.length ? points : [history[history.length - 1]]);
  return compacted.map(function(point) {
    return {
      predictionId: String(debate.id),
      timestamp: point.timestamp,
      yesProbability: point.yesProbability,
      volume: point.volume,
    };
  });
}

function countActiveDebates(options = {}) {
  const {
    includeUnlisted = false,
    region = null,
  } = options;
  reconcileDebates();
  const normalizedRegion = region ? normalizeRegionId(region, null) : null;
  return debates.filter(debate =>
    (!normalizedRegion || debate.region === normalizedRegion) &&
    !debate.closed &&
    (includeUnlisted || debate.listed !== false)
  ).length;
}

function findDebateConflict(rawDebate) {
  const region = normalizeRegionId(rawDebate.region);
  const predictionKey = normalizeText(rawDebate.predictionKey).toLowerCase();
  const sourceKey = normalizeText(rawDebate.sourceKey).toLowerCase();
  const sourceUrl = normalizeText(rawDebate.sourceUrl).toLowerCase();
  const title = normalizeText(rawDebate.title).toLowerCase();
  const currentNow = nowMs();

  return debates.find(debate => {
    if (debate.region !== region) return false;
    if (predictionKey && debate.predictionKey === predictionKey) {
      return true;
    }
    if (
      predictionKey &&
      sourceKey &&
      debate.listed !== false &&
      !debate.closed &&
      debate.sourceKey === sourceKey &&
      hasTopicOverlap(rawDebate, debate)
    ) {
      return true;
    }
    if (!predictionKey && sourceKey && debate.sourceKey === sourceKey && hasTopicOverlap(rawDebate, debate)) {
      return true;
    }
    if (!predictionKey && sourceUrl && normalizeText(debate.sourceUrl).toLowerCase() === sourceUrl && hasTopicOverlap(rawDebate, debate)) {
      return true;
    }
    if (
      !predictionKey &&
      title &&
      debate.listed !== false &&
      !debate.closed &&
      Number(debate.endsAt) > currentNow &&
      String(debate.title || '').trim().toLowerCase() === title
    ) {
      return true;
    }
    return false;
  }) || null;
}

function createDebate(rawDebate) {
  reconcileDebates();
  const launchValidation = validateDebateLaunchRequirements(rawDebate, { existingDebates: debates });
  if (!launchValidation.ok) {
    console.warn(
      '[debates] launch blocked:',
      launchValidation.reason,
      normalizeText(rawDebate?.title || rawDebate?.sourceTitle),
      launchValidation.conflictTitle ? `conflict=${launchValidation.conflictTitle}` : ''
    );
    return null;
  }

  const duplicate = findDebateConflict(rawDebate);
  if (duplicate) {
    return null;
  }

  const order = debates.reduce((maxOrder, debate) => Math.max(maxOrder, Number(debate.order) || 0), -1) + 1;
  const createdAt = nowIso();
  const nextDebate = sanitizeDebate({
    ...rawDebate,
    id: rawDebate.id || crypto.randomUUID(),
    region: normalizeRegionId(rawDebate.region),
    openedAt: Number(rawDebate.openedAt) > 0 ? Number(rawDebate.openedAt) : nowMs(),
    endsAt: Number(rawDebate.endsAt) > 0 ? Number(rawDebate.endsAt) : null,
    createdAt,
    updatedAt: createdAt,
    listed: rawDebate.listed !== false,
    schemaVersion: DEBATE_SCHEMA_VERSION,
    order,
  }, order);

  debates.push(nextDebate);
  const deduped = dedupeOpenPreviewImages(debates);
  debates = deduped.debates;
  const createdIndex = getDebateIndexById(nextDebate.id);
  if (createdIndex !== -1) {
    recordProbabilityHistoryAtIndex(createdIndex, {
      force: !Array.isArray(debates[createdIndex].probabilityHistory) || !debates[createdIndex].probabilityHistory.length,
      timestamp: Number(debates[createdIndex].openedAt) > 0 ? Number(debates[createdIndex].openedAt) : nowMs(),
    });
  }
  persistDebates(debates);
  const created = debates.find(debate => String(debate.id) === String(nextDebate.id));
  return created ? toPublicDebate(created) : null;
}

function updateDebate(debateId, patch = {}) {
  const id = String(debateId);
  const index = debates.findIndex(debate => String(debate.id) === id);
  if (index === -1) return null;
  const previous = debates[index];

  const next = sanitizeDebate({
    ...previous,
    ...patch,
    id,
    updatedAt: nowIso(),
  }, index);

  debates[index] = next;
  const deduped = dedupeOpenPreviewImages(debates);
  debates = deduped.debates;
  const updatedIndex = getDebateIndexById(id);
  if (updatedIndex !== -1) {
    const updated = debates[updatedIndex];
    const historyMissing = !Array.isArray(updated.probabilityHistory) || !updated.probabilityHistory.length;
    const probabilityChanged =
      Number(previous.yesPct) !== Number(updated.yesPct) ||
      Number(previous.pool) !== Number(updated.pool);
    if (historyMissing || probabilityChanged) {
      recordProbabilityHistoryAtIndex(updatedIndex, {
        force: historyMissing,
      });
    }
  }
  persistDebates(debates);
  const updated = debates.find(debate => String(debate.id) === id);
  return updated ? toPublicDebate(updated) : null;
}

function buildVerdictPayload(debate, resolution = {}) {
  if (!resolution.winnerSide) {
    return {
      winnerSide: null,
      winnerLabel: null,
      verdictReasoning: normalizeText(resolution.verdictReasoning || resolution.reason || debate.verdictReasoning),
      verdictScores: debate.verdictScores || null,
    };
  }

  const verdict = createFallbackVerdict(
    debate,
    resolution.winnerSide === 'yes' ? 'yes' : 'no',
    normalizeText(resolution.verdictReasoning || resolution.reason || debate.verdictReasoning)
  );

  return {
    winnerSide: verdict.winnerSide,
    winnerLabel: verdict.winnerLabel,
    verdictReasoning: verdict.reasoning,
    verdictScores: {
      conviction: verdict.conviction,
      logic: verdict.logic,
      originality: verdict.originality,
    },
  };
}

function beginDebateValidation(debateId, resolution = {}) {
  const id = String(debateId);
  const index = debates.findIndex(debate => String(debate.id) === id);
  if (index === -1) return null;

  const debate = debates[index];
  if (isFinalValidationState(debate.validationState)) {
    return toPublicDebate(debate);
  }

  const currentNow = nowMs();
  const verdict = buildVerdictPayload(debate, resolution);
  const validationWindowMs = resolveValidationWindowMs(resolution.validationWindowMs);

  debates[index] = sanitizeDebate({
    ...debate,
    closed: true,
    closedAt: debate.closedAt || currentNow,
    endsAt: Math.min(Number(debate.endsAt) || currentNow, currentNow),
    winnerSide: verdict.winnerSide,
    winnerLabel: verdict.winnerLabel,
    verdictReasoning: verdict.verdictReasoning,
    verdictScores: verdict.verdictScores,
    validationState: 'validating',
    validationEvidence: resolution.validationEvidence || debate.validationEvidence || null,
    proofVideoUrl: normalizeText(resolution.proofVideoUrl || debate.proofVideoUrl),
    validationStartedAt: debate.validationStartedAt || currentNow,
    validationEndsAt: Math.max(
      Number(debate.validationEndsAt) || 0,
      (debate.validationStartedAt || currentNow) + validationWindowMs
    ),
    settlementState: 'locked',
    settlementSummary: null,
    settlementCompletedAt: null,
    closureReason: normalizeText(resolution.closureReason || debate.closureReason || 'source_triggered'),
    updatedAt: nowIso(currentNow),
  }, index);

  persistDebates(debates);
  return toPublicDebate(debates[index]);
}

function resolveDebate(debateId, resolution = {}) {
  const id = String(debateId);
  const index = debates.findIndex(debate => String(debate.id) === id);
  if (index === -1) return null;

  const debate = debates[index];
  if (isFinalValidationState(debate.validationState) && debate.winnerSide) {
    return toPublicDebate(debate);
  }

  const currentNow = nowMs();
  const verdict = buildVerdictPayload(debate, resolution);

  debates[index] = sanitizeDebate({
    ...debate,
    closed: true,
    closedAt: debate.closedAt || currentNow,
    endsAt: Math.min(Number(debate.endsAt) || currentNow, currentNow),
    winnerSide: verdict.winnerSide,
    winnerLabel: verdict.winnerLabel,
    verdictReasoning: verdict.verdictReasoning,
    verdictScores: verdict.verdictScores,
    validationState: normalizeState(resolution.validationState || 'validated', ['validated', 'manual_admin'], 'validated'),
    validationEvidence: resolution.validationEvidence || debate.validationEvidence || null,
    proofVideoUrl: normalizeText(resolution.proofVideoUrl || debate.proofVideoUrl),
    validationStartedAt: debate.validationStartedAt || currentNow,
    validationEndsAt: debate.validationEndsAt || currentNow,
    settlementState: normalizeState(
      resolution.settlementState || (debate.settlementState === 'settled' ? 'settled' : 'ready'),
      ['open', 'locked', 'ready', 'settled', 'refund_pending', 'refunded'],
      'ready'
    ),
    settlementSummary: resolution.settlementSummary || debate.settlementSummary || null,
    settlementCompletedAt: Number(resolution.settlementCompletedAt) || Number(debate.settlementCompletedAt) || null,
    closureReason: normalizeText(resolution.closureReason || debate.closureReason || 'validated_result'),
    updatedAt: nowIso(currentNow),
  }, index);

  persistDebates(debates);
  return toPublicDebate(debates[index]);
}

function cancelDebate(debateId, resolution = {}) {
  const id = String(debateId);
  const index = debates.findIndex(debate => String(debate.id) === id);
  if (index === -1) return null;

  const debate = debates[index];
  const currentNow = nowMs();

  debates[index] = sanitizeDebate({
    ...debate,
    closed: true,
    closedAt: debate.closedAt || currentNow,
    endsAt: Math.min(Number(debate.endsAt) || currentNow, currentNow),
    winnerSide: null,
    winnerLabel: null,
    verdictReasoning: normalizeText(
      resolution.verdictReasoning ||
      resolution.reason ||
      debate.verdictReasoning ||
      'The market was cancelled because no reliable source could confirm the result.'
    ),
    verdictScores: null,
    validationState: 'cancelled',
    validationEvidence: resolution.validationEvidence || debate.validationEvidence || null,
    proofVideoUrl: normalizeText(resolution.proofVideoUrl || debate.proofVideoUrl),
    validationStartedAt: debate.validationStartedAt || currentNow,
    validationEndsAt: debate.validationEndsAt || currentNow,
    settlementState: normalizeState(
      resolution.settlementState || (debate.settlementState === 'refunded' ? 'refunded' : 'refund_pending'),
      ['open', 'locked', 'ready', 'settled', 'refund_pending', 'refunded'],
      'refund_pending'
    ),
    settlementSummary: resolution.settlementSummary || debate.settlementSummary || null,
    settlementCompletedAt: Number(resolution.settlementCompletedAt) || Number(debate.settlementCompletedAt) || null,
    closureReason: normalizeText(resolution.closureReason || debate.closureReason || 'cancelled_unverifiable'),
    updatedAt: nowIso(currentNow),
  }, index);

  persistDebates(debates);
  return toPublicDebate(debates[index]);
}

function closeDebateLive(debateId, verdict) {
  return resolveDebate(debateId, {
    winnerSide: verdict.winnerSide || 'yes',
    verdictReasoning: verdict.verdict || verdict.reasoning || 'Closed manually by admin.',
    validationState: 'manual_admin',
  });
}

function hideSurplusActiveDebates(maxVisibleActive, options = {}) {
  const limit = Math.max(0, Math.floor(Number(maxVisibleActive) || 0));
  if (!limit) return [];

  reconcileDebates();
  const normalizedRegion = options.region ? normalizeRegionId(options.region, null) : null;

  const activeListedDebates = debates
    .filter(debate =>
      !debate.closed &&
      debate.listed !== false &&
      (!normalizedRegion || debate.region === normalizedRegion)
    )
    .sort((left, right) => {
      const leftPriority = left.createdFromNews ? 1 : 0;
      const rightPriority = right.createdFromNews ? 1 : 0;
      if (leftPriority !== rightPriority) return rightPriority - leftPriority;
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
      preparedAt: updatedAt,
      updatedAt,
    };
  });

  persistDebates(debates);
  return [...hiddenIds];
}

function hideSourceBackfillDebates(slotCount, options = {}) {
  return hideSurplusActiveDebates(
    Math.max(0, TARGET_ACTIVE_DEBATES_PER_REGION - Math.floor(Number(slotCount) || 0)),
    options
  );
}

function hideNonLiveDebates() {
  return 0;
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

  debates[index] = sanitizeDebate({
    ...debate,
    pool: roundNumber(nextPool, 0),
    yesPct: nextYesPct,
    viewers: Math.max(200, Math.round((debate.viewers || 0) + viewerDelta)),
    updatedAt: nowIso(),
  }, index);

  recordProbabilityHistoryAtIndex(index);
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
  if (
    !debate ||
    !debate.closed ||
    !debate.winnerSide ||
    !['validated', 'manual_admin'].includes(normalizeText(debate.validationState).toLowerCase())
  ) return null;

  const fallback = createFallbackVerdict(debate, debate.winnerSide, debate.verdictReasoning);
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
  PREPARED_PREDICTIONS_PER_REGION,
  REGION_IDS,
  TARGET_ACTIVE_DEBATES,
  TARGET_ACTIVE_DEBATES_PER_REGION,
  applyBetToDebate,
  beginDebateValidation,
  buildClientVerdict,
  cancelDebate,
  closeDebateLive,
  countActiveDebates,
  createDebate,
  canAutoFallbackVerdict,
  getDebateById,
  getLatestPredictionHistoryPoint,
  getPredictionHistory,
  hideNonLiveDebates,
  hideSourceBackfillDebates,
  hideSurplusActiveDebates,
  isFinalValidationState,
  listDebates,
  normalizeRegionId,
  reconcileDebates,
  removeBetFromDebate,
  resolveDebate,
  resolveValidationWindowMs,
  updateDebate,
};
