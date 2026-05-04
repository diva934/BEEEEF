// server/news-pipeline.js
// Backend prediction orchestrator:
// - fetches local sports/news inputs
// - validates active action predictions from reliable sources
// - keeps ~30 active predictions per server/region
// - keeps a hidden prepared queue so replacements appear instantly

'use strict';

const fs = require('fs');
const path = require('path');

const {
  PREPARED_PREDICTIONS_PER_REGION,
  REGION_IDS,
  TARGET_ACTIVE_DEBATES_PER_REGION,
  beginDebateValidation,
  cancelDebate,
  countActiveDebates,
  createDebate,
  hideSurplusActiveDebates,
  listDebates,
  reconcileDebates,
  resolveDebate,
  updateDebate,
} = require('./debates');
const {
  buildPreparedPredictionPool,
  evaluateCryptoPrediction,
  evaluateNewsPrediction,
  evaluateSportsPrediction,
  resolvePreviewImageAsset,
} = require('./prediction-engine');
const { fingerprintTitle } = require('./news-filter');
const { fetchPredictionInputsByRegion } = require('./prediction-sources');
const {
  refundDebateBetsAsAdmin,
  settleDebateBetsAsAdmin,
} = require('./supabase');

const STATE_FILE = process.env.NEWS_STATE_FILE || path.join(__dirname, 'data', 'news-state.json');
const POLL_INTERVAL_MS = Math.max(5000, Math.min(15000, Number(process.env.PREDICTION_POLL_INTERVAL_MS) || 10000));

let pipelineState = loadState();
let schedulerHandle = null;
let runningPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function baseState() {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastReason: null,
    providerMode: 'espn_coingecko_strict_events',
    lastCreated: [],
    lastResolved: [],
    lastRegionCounts: {},
    lastFetchErrors: [],
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return baseState();
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Object.assign(baseState(), raw, {
      lastCreated: Array.isArray(raw.lastCreated) ? raw.lastCreated.slice(0, 100) : [],
      lastResolved: Array.isArray(raw.lastResolved) ? raw.lastResolved.slice(0, 100) : [],
      lastFetchErrors: Array.isArray(raw.lastFetchErrors) ? raw.lastFetchErrors.slice(0, 30) : [],
      lastRegionCounts: raw.lastRegionCounts && typeof raw.lastRegionCounts === 'object' ? raw.lastRegionCounts : {},
    });
  } catch (error) {
    console.warn('[predictions] failed to load state file, starting fresh:', error.message);
    return baseState();
  }
}

function persistState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pipelineState, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function buildSportsLookup(regionInput) {
  const lookup = new Map();
  const events = Array.isArray(regionInput?.sportsEvents) ? regionInput.sportsEvents : [];
  events.forEach(event => {
    if (!event?.eventId) return;
    lookup.set(String(event.eventId), event);
  });
  return lookup;
}

function buildCryptoLookup(regionInput) {
  const lookup = new Map();
  const assets = Array.isArray(regionInput?.cryptoAssets) ? regionInput.cryptoAssets : [];
  assets.forEach(asset => {
    if (!asset?.id) return;
    lookup.set(String(asset.id).toLowerCase(), asset);
  });
  return lookup;
}

function buildRegionCounts(region) {
  const all = listDebates({ includeUnlisted: true, region });
  return {
    active: all.filter(item => !item.closed && item.listed !== false).length,
    prepared: all.filter(item => !item.closed && item.listed === false).length,
    closed: all.filter(item => item.closed).length,
    total: all.length,
  };
}

function calcDebateOdds(yesPct, winnerSide) {
  const pct = winnerSide === 'no' ? 100 - Number(yesPct || 0) : Number(yesPct || 0);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return 2;
  return Math.round((100 / pct) * 100) / 100;
}

function buildStickyValidationResolution(debate, reason, snapshot) {
  if (!debate?.winnerSide) return null;
  return {
    winnerSide: debate.winnerSide,
    verdictReasoning: reason,
    closureReason: debate.closureReason || 'sticky_validation',
    validationEvidence: {
      checkedAt: nowIso(),
      snapshot,
      reason,
      lockedSnapshot: debate.validationEvidence?.snapshot || null,
    },
    proofVideoUrl: snapshot?.proofVideoUrl || snapshot?.proofUrl || debate.proofVideoUrl || null,
  };
}

function topicOverlap(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return 0;
  const leftTokens = new Set(fingerprintTitle(a).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(fingerprintTitle(b).split(/\s+/).filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) intersection += 1;
  });
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function findBestNewsMatch(debate, newsItems) {
  if (!Array.isArray(newsItems) || !newsItems.length) return null;
  const sourceKey = String(debate.sourceKey || '').toLowerCase();
  const direct = newsItems.find(item => String(item?.sourceKey || '').toLowerCase() === sourceKey);
  if (direct) return direct;

  const ranked = newsItems
    .map(item => ({
      item,
      score: Math.max(
        topicOverlap(debate.title, item?.sourceTitle),
        topicOverlap(debate.sourceTitle, item?.sourceTitle)
      ),
    }))
    .filter(entry => entry.score >= 0.45)
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.item || null;
}

function evaluatePredictionAgainstSource(debate, regionInput) {
  if (!debate || !regionInput) {
    return { resolution: null, snapshotAvailable: false, snapshot: null };
  }

  if (debate.predictionSourceType === 'sports') {
    const sportsLookup = buildSportsLookup(regionInput);
    const snapshot = sportsLookup.get(String(debate.actionRule?.eventId || '')) || null;
    return {
      resolution: evaluateSportsPrediction(debate, snapshot),
      snapshotAvailable: Boolean(snapshot),
      snapshot,
    };
  }

  if (debate.predictionSourceType === 'crypto') {
    const cryptoLookup = buildCryptoLookup(regionInput);
    const snapshot = cryptoLookup.get(String(debate.actionRule?.assetId || '').toLowerCase()) || null;
    return {
      resolution: evaluateCryptoPrediction(debate, snapshot),
      snapshotAvailable: Boolean(snapshot),
      snapshot,
    };
  }

  if (debate.predictionSourceType === 'news') {
    const resolution = evaluateNewsPrediction(debate, regionInput);
    return {
      resolution,
      snapshotAvailable: Array.isArray(regionInput.newsItems) && regionInput.newsItems.length > 0,
      snapshot: resolution?.validationEvidence?.snapshot || null,
    };
  }

  return { resolution: null, snapshotAvailable: false, snapshot: null };
}

async function refreshOpenPredictionMedia(inputs) {
  const openDebates = listDebates({ includeUnlisted: true }).filter(debate => !debate.closed);
  const updated = [];

  for (const debate of openDebates) {
    const regionInput = inputs.byRegion[debate.region];
    if (!regionInput) continue;

    let imageAsset = null;

    if (debate.predictionSourceType === 'sports') {
      const sportsLookup = buildSportsLookup(regionInput);
      const event = sportsLookup.get(String(debate.actionRule?.eventId || ''));
      if (!event) continue;
      imageAsset = await resolvePreviewImageAsset({
        sourceImageUrl: event.home?.logo || event.away?.logo,
        title: event.title || event.shortName || debate.title,
        sport: event.sport,
        category: debate.category,
        teams: [event.home?.name, event.away?.name],
      });
    } else if (debate.predictionSourceType === 'crypto') {
      const cryptoLookup = buildCryptoLookup(regionInput);
      const asset = cryptoLookup.get(String(debate.actionRule?.assetId || '').toLowerCase());
      if (!asset) continue;
      imageAsset = await resolvePreviewImageAsset({
        sourceImageUrl: asset.imageUrl,
        title: `${asset.name} ${asset.symbol}`,
        sport: 'general',
        category: debate.category,
        teams: [asset.name, asset.symbol],
      });
    } else if (debate.predictionSourceType === 'news') {
      const newsItem = findBestNewsMatch(debate, regionInput.newsItems);
      if (!newsItem) continue;
      imageAsset = await resolvePreviewImageAsset({
        sourceImageUrl: newsItem.imageUrl,
        title: newsItem.sourceTitle || debate.sourceTitle || debate.title,
        sport: 'general',
        category: debate.category,
      });
    }

    const nextUrl = String(imageAsset?.url || '').trim();
    const currentUrl = String(debate.sourceImageUrl || debate.photo || '').trim();
    if (!nextUrl || nextUrl === currentUrl) continue;

    const patched = updateDebate(debate.id, {
      sourceImageUrl: nextUrl,
      photo: nextUrl,
    });
    if (patched) {
      updated.push({
        id: patched.id,
        region: patched.region,
        title: patched.title,
        imageUrl: nextUrl,
      });
    }
  }

  return updated;
}

async function createDraftsForRegion(regionInput, region, existingDebates) {
  const nowMs = Date.now();
  const existingKeys = new Set(
    existingDebates
      .map(debate => String(debate.predictionKey || '').toLowerCase())
      .filter(Boolean)
  );

  // For time-bucketed predictions (crypto/stock) that use keys like
  // "region:asset:direction:bucket", also block new debates whose *base key*
  // (everything before the last colon) matches an existing ACTIVE debate.
  // This prevents duplicate debates for the same asset when a fresh bucket
  // is generated before the previous debate has expired.
  const activeBaseKeys = new Set(
    existingDebates
      .filter(d => !d.closed && Number(d.endsAt) > nowMs)
      .map(d => {
        const key = String(d.predictionKey || '').toLowerCase();
        const parts = key.split(':');
        // Only strip the bucket suffix if the key has 4+ segments (region:asset:direction:bucket)
        return parts.length >= 4 ? parts.slice(0, -1).join(':') : key;
      })
      .filter(Boolean)
  );

  const pool = await buildPreparedPredictionPool(regionInput, region, {
    activeTarget: TARGET_ACTIVE_DEBATES_PER_REGION,
    preparedBuffer: PREPARED_PREDICTIONS_PER_REGION,
  });

  return pool.filter(draft => {
    const key = String(draft.predictionKey || '').toLowerCase();
    if (existingKeys.has(key)) return false;
    const parts = key.split(':');
    const baseKey = parts.length >= 4 ? parts.slice(0, -1).join(':') : key;
    if (activeBaseKeys.has(baseKey)) return false;
    return true;
  });
}

async function lockOpenPredictions(inputs) {
  const allOpen = listDebates({ includeUnlisted: true }).filter(debate => !debate.closed);
  const locked = [];

  for (const debate of allOpen) {
    const regionInput = inputs.byRegion[debate.region];
    const evaluation = evaluatePredictionAgainstSource(debate, regionInput);
    const resolution = evaluation.resolution;
    if (!resolution) continue;

    const validating = beginDebateValidation(debate.id, {
      winnerSide: resolution.winnerSide,
      verdictReasoning: resolution.verdictReasoning,
      validationEvidence: resolution.validationEvidence,
      proofVideoUrl: resolution.proofVideoUrl,
      closureReason: resolution.closureReason,
    });

    if (validating) {
      locked.push({
        id: validating.id,
        region: validating.region,
        title: validating.title,
        winnerSide: validating.winnerSide,
        closureReason: validating.closureReason,
        validationEndsAt: validating.validationEndsAt,
      });
    }
  }

  return locked;
}

async function finalizeValidatingPredictions(inputs) {
  const validatingDebates = listDebates({ includeUnlisted: true })
    .filter(debate => debate.closed && debate.validationState === 'validating');
  const finalized = [];
  const cancelled = [];

  for (const debate of validatingDebates) {
    const validationEndsAt = Number(debate.validationEndsAt || 0);
    if (validationEndsAt > Date.now()) continue;

    const regionInput = inputs.byRegion[debate.region];
    const evaluation = evaluatePredictionAgainstSource(debate, regionInput);
    let resolution = evaluation.resolution;

    if (
      !resolution &&
      debate.predictionSourceType !== 'news' &&
      evaluation.snapshotAvailable &&
      debate.winnerSide &&
      ['condition_met', 'condition_impossible', 'event_finished'].includes(String(debate.closureReason || '').toLowerCase())
    ) {
      resolution = buildStickyValidationResolution(
        debate,
        debate.verdictReasoning || 'The source remained reachable during the validation window, confirming the locked result.',
        evaluation.snapshot
      );
    }

    if (resolution?.winnerSide) {
      let resolved = resolveDebate(debate.id, {
        winnerSide: resolution.winnerSide,
        verdictReasoning: resolution.verdictReasoning,
        validationState: 'validated',
        validationEvidence: resolution.validationEvidence,
        proofVideoUrl: resolution.proofVideoUrl,
        closureReason: resolution.closureReason || debate.closureReason,
      });

      let settlementSummary = null;
      try {
        settlementSummary = await settleDebateBetsAsAdmin(
          debate.id,
          resolution.winnerSide,
          calcDebateOdds(resolved?.yesPct ?? debate.yesPct, resolution.winnerSide),
          { reason: 'prediction_validated' }
        );
      } catch (error) {
        console.warn('[predictions] automatic settlement failed:', debate.id, error.message);
      }

      if (resolved && settlementSummary) {
        resolved = updateDebate(debate.id, {
          settlementState: 'settled',
          settlementSummary,
          settlementCompletedAt: Date.now(),
        }) || resolved;
      }

      if (resolved) {
        finalized.push({
          id: resolved.id,
          region: resolved.region,
          title: resolved.title,
          winnerSide: resolved.winnerSide,
          settlementState: resolved.settlementState,
          reason: resolved.verdictReasoning,
        });
      }
      continue;
    }

    let cancelledDebate = cancelDebate(debate.id, {
      verdictReasoning: 'No reliable source could confirm the result during the validation window. All predictions were cancelled and refunded.',
      validationEvidence: {
        checkedAt: nowIso(),
        snapshot: evaluation.snapshot || null,
        reason: 'no_reliable_data_after_validation',
      },
      proofVideoUrl: debate.proofVideoUrl,
      closureReason: 'cancelled_unverifiable',
    });

    let refundSummary = null;
    try {
      refundSummary = await refundDebateBetsAsAdmin(debate.id, { reason: 'prediction_cancelled_unverifiable' });
    } catch (error) {
      console.warn('[predictions] automatic refund failed:', debate.id, error.message);
    }

    if (cancelledDebate && refundSummary) {
      cancelledDebate = updateDebate(debate.id, {
        settlementState: 'refunded',
        settlementSummary: refundSummary,
        settlementCompletedAt: Date.now(),
      }) || cancelledDebate;
    }

    if (cancelledDebate) {
      cancelled.push({
        id: cancelledDebate.id,
        region: cancelledDebate.region,
        title: cancelledDebate.title,
        settlementState: cancelledDebate.settlementState,
        reason: cancelledDebate.verdictReasoning,
      });
    }
  }

  return { finalized, cancelled };
}

async function replenishRegion(region, regionInput) {
  const existingDebates = listDebates({ includeUnlisted: true, region });
  const countsBefore = {
    active: existingDebates.filter(item => !item.closed && item.listed !== false).length,
    prepared: existingDebates.filter(item => !item.closed && item.listed === false).length,
  };
  const drafts = await createDraftsForRegion(regionInput, region, existingDebates);
  const created = [];

  let activeMissing = Math.max(0, TARGET_ACTIVE_DEBATES_PER_REGION - countsBefore.active);
  let preparedMissing = Math.max(0, PREPARED_PREDICTIONS_PER_REGION - countsBefore.prepared);

  for (const draft of drafts) {
    if (!activeMissing && !preparedMissing) break;

    const nextDraft = {
      ...draft,
      listed: activeMissing > 0,
      preparedAt: activeMissing > 0 ? null : nowIso(),
    };

    const createdPrediction = createDebate(nextDraft);
    if (!createdPrediction) continue;

    created.push({
      id: createdPrediction.id,
      region,
      listed: createdPrediction.listed,
      title: createdPrediction.title,
      predictionKey: createdPrediction.predictionKey,
    });

    if (createdPrediction.listed) activeMissing = Math.max(0, activeMissing - 1);
    else preparedMissing = Math.max(0, preparedMissing - 1);
  }

  hideSurplusActiveDebates(TARGET_ACTIVE_DEBATES_PER_REGION, { region });

  return {
    created,
    counts: buildRegionCounts(region),
  };
}

async function runNewsMaintenance(options) {
  const reason = (options && options.reason) || 'manual';
  if (runningPromise) return runningPromise;

  runningPromise = (async function execute() {
    pipelineState.lastRunAt = nowIso();
    pipelineState.lastReason = reason;
    pipelineState.lastError = null;

    const closedSummary = reconcileDebates();
    const inputs = await fetchPredictionInputsByRegion();
    const refreshedImages = await refreshOpenPredictionMedia(inputs);
    const locked = await lockOpenPredictions(inputs);
    const validationResults = await finalizeValidatingPredictions(inputs);
    const resolved = [...locked, ...validationResults.finalized, ...validationResults.cancelled];
    const created = [];
    const regionCounts = {};

    for (const region of REGION_IDS) {
      const regionInput = inputs.byRegion[region];
      if (!regionInput) continue;
      const refill = await replenishRegion(region, regionInput);
      created.push(...refill.created);
      regionCounts[region] = refill.counts;
    }

    pipelineState.lastSuccessAt = nowIso();
    pipelineState.providerMode = inputs.providerMode || 'espn_coingecko_strict_events';
    pipelineState.lastCreated = created.slice(0, 100);
    pipelineState.lastResolved = resolved.slice(0, 100);
    pipelineState.lastRegionCounts = regionCounts;
    pipelineState.lastFetchErrors = Array.isArray(inputs.errors) ? inputs.errors.slice(0, 30) : [];

    persistState();

    return {
      reason,
      providerMode: pipelineState.providerMode,
      closedIds: closedSummary.closedIds,
      refreshedImages,
      locked,
      finalized: validationResults.finalized,
      cancelled: validationResults.cancelled,
      resolved,
      created,
      regionCounts,
      fetchErrors: pipelineState.lastFetchErrors,
      activeDebates: countActiveDebates(),
    };
  })()
    .catch(error => {
      pipelineState.lastError = error.message || 'Unknown prediction pipeline error';
      pipelineState.lastCreated = [];
      persistState();
      throw error;
    })
    .finally(() => {
      runningPromise = null;
    });

  return runningPromise;
}

function startNewsScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);

  schedulerHandle = setInterval(() => {
    runNewsMaintenance({ reason: 'scheduler' }).catch(error => {
      console.warn('[predictions] scheduled run failed:', error.message);
    });
  }, POLL_INTERVAL_MS);

  return schedulerHandle;
}

function getNewsPipelineStatus() {
  return {
    source: 'regional_action_predictions',
    providerMode: pipelineState.providerMode,
    pollIntervalMs: POLL_INTERVAL_MS,
    targetActivePerRegion: TARGET_ACTIVE_DEBATES_PER_REGION,
    preparedPerRegion: PREPARED_PREDICTIONS_PER_REGION,
    lastRunAt: pipelineState.lastRunAt,
    lastSuccessAt: pipelineState.lastSuccessAt,
    lastError: pipelineState.lastError,
    lastReason: pipelineState.lastReason,
    lastCreated: pipelineState.lastCreated,
    lastResolved: pipelineState.lastResolved,
    lastRegionCounts: pipelineState.lastRegionCounts,
    errors: pipelineState.lastFetchErrors,
  };
}

module.exports = {
  getNewsPipelineStatus,
  runNewsMaintenance,
  startNewsScheduler,
};
