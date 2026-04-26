const fs = require('fs');
const path = require('path');

const { countActiveDebates, createDebate, hideSourceBackfillDebates, hideSurplusActiveDebates, listDebates, reconcileDebates } = require('./debates');
const { buildDebateFromNews, buildDebateFromLiveStream, DEFAULT_DURATION_MS } = require('./news-debate-generator');
const { filterNewsItems, fingerprintTitle } = require('./news-filter');
const { fetchLatestNews, RSS_TOPICS, TRUSTED_NEWS_DOMAINS } = require('./news-sources');
const { fetchAllLiveStreams, getLiveEmbedForCategory } = require('./youtube-live');

const STATE_FILE = process.env.NEWS_STATE_FILE || path.join(__dirname, 'data', 'news-state.json');
// Total visible debates (seed + news combined).
const TARGET_ACTIVE_DEBATES = Math.max(3, Math.min(50, Number(process.env.DEBATE_TARGET_ACTIVE) || 35));
// How many of those should be news-sourced debates (the rest can be seeds).
// The pipeline always tries to reach this number, creating new debates each cycle
// even if total active already meets TARGET_ACTIVE_DEBATES.
const TARGET_SOURCE_DEBATES = Math.max(3, Math.min(TARGET_ACTIVE_DEBATES, Number(process.env.NEWS_TARGET_SOURCE_DEBATES) || 5));
const MAX_CREATED_PER_RUN = Math.max(1, Math.min(8, Number(process.env.NEWS_MAX_CREATED_PER_RUN) || 5));
// Poll more frequently (90 s default) to replace debates quickly as they expire
const POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.NEWS_POLL_INTERVAL_MS) || 90_000);
const USED_RETENTION_DAYS = Math.max(3, Number(process.env.NEWS_USED_RETENTION_DAYS) || 14);

let pipelineState = loadState();
let schedulerHandle = null;
let runningPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function baseState() {
  return {
    usedArticles: [],
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastReason: null,
    lastFetchCount: 0,
    lastCandidateCount: 0,
    lastFetchSample: [],
    lastCandidateSample: [],
    lastCreated: [],
  };
}

function sanitizeUsedArticle(item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.sourceKey || !item.titleFingerprint) return null;
  return {
    sourceKey: String(item.sourceKey).toLowerCase(),
    titleFingerprint: String(item.titleFingerprint),
    sourceTitle: String(item.sourceTitle || ''),
    sourceUrl: String(item.sourceUrl || ''),
    debateId: item.debateId ? String(item.debateId) : null,
    createdAt: item.createdAt || nowIso(),
  };
}

function sanitizeSample(items, mapper) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).map(mapper);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return baseState();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      ...baseState(),
      ...raw,
      usedArticles: Array.isArray(raw.usedArticles) ? raw.usedArticles.map(sanitizeUsedArticle).filter(Boolean) : [],
      lastFetchSample: Array.isArray(raw.lastFetchSample) ? raw.lastFetchSample.slice(0, 10) : [],
      lastCandidateSample: Array.isArray(raw.lastCandidateSample) ? raw.lastCandidateSample.slice(0, 10) : [],
      lastCreated: Array.isArray(raw.lastCreated) ? raw.lastCreated.slice(0, 10) : [],
    };
  } catch (error) {
    console.warn('[news] failed to load state file, starting fresh', error);
    return baseState();
  }
}

function persistState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tempFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(pipelineState, null, 2));
  fs.renameSync(tempFile, STATE_FILE);
}

function pruneState() {
  const maxAgeMs = USED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  pipelineState.usedArticles = pipelineState.usedArticles
    .filter(item => {
      const timestamp = Date.parse(item.createdAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .slice(0, 300);
}

function summarizeItem(item) {
  return {
    category: item.category,
    domain: item.domain,
    sourceTitle: item.sourceTitle,
    sourceUrl: item.sourceUrl,
    sourceImageUrl: item.imageUrl,
    sourceExcerpt: item.sourceDescription,
    publishedAt: item.publishedAt,
    score: item.score,
  };
}

function countActiveSourceDebates() {
  return listDebates()
    .filter(debate => !debate.closed && debate.createdFromNews && debate.sourceUrl)
    .length;
}

function buildExistingDebateContext() {
  const debates = listDebates({ includeUnlisted: true });
  const existingSourceKeys = [];
  const existingTitleFingerprints = [];

  debates.forEach(debate => {
    if (debate.sourceKey) existingSourceKeys.push(String(debate.sourceKey).toLowerCase());
    if (debate.sourceUrl) existingSourceKeys.push(String(debate.sourceUrl).toLowerCase());
    if (debate.title) existingTitleFingerprints.push(fingerprintTitle(debate.title));
    if (debate.sourceTitle) existingTitleFingerprints.push(fingerprintTitle(debate.sourceTitle));
  });

  return {
    existingSourceKeys,
    existingTitleFingerprints: existingTitleFingerprints.filter(Boolean),
  };
}

async function runNewsMaintenance(options = {}) {
  const reason = options.reason || 'manual';

  if (runningPromise) {
    return runningPromise;
  }

  runningPromise = (async () => {
    const closedSummary = reconcileDebates();
    const hiddenIds = hideSurplusActiveDebates(TARGET_ACTIVE_DEBATES);
    const activeDebatesBeforeBackfill = countActiveDebates();
    const sourceDebatesBefore = countActiveSourceDebates();
    const sourceSlotsNeeded = Math.max(0, TARGET_SOURCE_DEBATES - sourceDebatesBefore);
    // Allow hiding synthetic debates as long as we stay above 1 (emergency floor).
    // The old value of 30 assumed the floor was ~30; now the floor is 3.
    const SYNTHETIC_HIDE_FLOOR = Math.max(1, TARGET_ACTIVE_DEBATES - TARGET_SOURCE_DEBATES);
    const safeBackfillSlots = Math.max(0, activeDebatesBeforeBackfill - SYNTHETIC_HIDE_FLOOR);
    const backfillHiddenIds = sourceSlotsNeeded > 0
      ? hideSourceBackfillDebates(Math.min(sourceSlotsNeeded, MAX_CREATED_PER_RUN, safeBackfillSlots))
      : [];
    const activeDebatesBefore = countActiveDebates();
    const startedAt = nowIso();

    pipelineState.lastRunAt = startedAt;
    pipelineState.lastReason = reason;
    pipelineState.lastError = null;

    // Always try to create news debates when below the source-debate target,
    // even if total active count already meets TARGET_ACTIVE_DEBATES.
    // This ensures news debates gradually replace seed debates.
    const missingSlots = Math.max(
      // Slots needed to reach total target
      TARGET_ACTIVE_DEBATES - activeDebatesBefore,
      // Slots needed to reach news-source target
      TARGET_SOURCE_DEBATES - sourceDebatesBefore
    );

    if (missingSlots <= 0) {
      // Both targets met — nothing to do this cycle
      pipelineState.lastFetchCount = 0;
      pipelineState.lastCandidateCount = 0;
      pipelineState.lastFetchSample = [];
      pipelineState.lastCandidateSample = [];
      pipelineState.lastCreated = [];
      pruneState();
      persistState();
      return {
        reason,
        closedIds: closedSummary.closedIds,
        hiddenIds: [...hiddenIds, ...backfillHiddenIds],
        activeDebatesBefore,
        sourceDebatesBefore,
        created: [],
      };
    }

    const created = [];
    const createBudget = Math.min(missingSlots, MAX_CREATED_PER_RUN);
    const debateContext = buildExistingDebateContext();

    // ── Phase 1: Live-stream debates (primary source) ─────────────────────
    // Fetch all currently-live YouTube news channels and generate debates
    // directly from their live streams. These debates always have a matching video.
    let liveStreams = [];
    try {
      liveStreams = await fetchAllLiveStreams();
    } catch (e) {
      console.warn('[news] fetchAllLiveStreams failed:', e.message);
    }

    // Deduplicate against already-existing debates
    const usedSourceKeys = new Set([
      ...debateContext.existingSourceKeys,
      ...pipelineState.usedArticles.map(a => a.sourceKey),
    ]);
    const usedFingerprints = new Set([
      ...debateContext.existingTitleFingerprints,
      ...pipelineState.usedArticles.map(a => a.titleFingerprint),
    ]);

    for (const stream of liveStreams) {
      if (created.length >= createBudget) break;

      const sourceKey = `yt-live-${stream.videoId}`;
      if (usedSourceKeys.has(sourceKey)) continue;

      const fp = fingerprintTitle(stream.title);
      if (fp && usedFingerprints.has(fp)) continue;

      const draft = buildDebateFromLiveStream(stream, { durationMs: DEFAULT_DURATION_MS });
      if (!draft) {
        console.log(`[news] live stream skipped (no question): ${stream.channelHandle} — "${stream.title}"`);
        continue;
      }

      const debate = createDebate(draft);
      if (!debate) continue;

      console.log(`[news] live debate created: "${debate.title}" from @${stream.channelHandle}`);

      created.push({
        id: debate.id, title: debate.title, category: debate.category,
        sourceUrl: debate.sourceUrl, sourceTitle: debate.sourceTitle,
        sourceImageUrl: debate.sourceImageUrl, sourceExcerpt: debate.sourceExcerpt,
        endsAt: debate.endsAt, liveVideoId: stream.videoId,
      });

      usedSourceKeys.add(sourceKey);
      if (fp) usedFingerprints.add(fp);

      pipelineState.usedArticles.unshift({
        sourceKey, titleFingerprint: fp || '',
        sourceTitle: stream.title, sourceUrl: stream.sourceUrl,
        debateId: debate.id, createdAt: startedAt,
      });
    }

    // ── Phase 2: RSS fallback (only if live streams didn't fill the budget) ──
    // Kept as safety net so debates always exist even if YouTube is unreachable.
    if (created.length < createBudget) {
      const fetched  = await fetchLatestNews();
      const filtered = filterNewsItems(fetched.items, {
        existingSourceKeys       : [...usedSourceKeys],
        existingTitleFingerprints: [...usedFingerprints],
        usedSourceKeys           : pipelineState.usedArticles.map(a => a.sourceKey),
        usedTitleFingerprints    : pipelineState.usedArticles.map(a => a.titleFingerprint),
      });

      if (fetched.errors.length) {
        pipelineState.lastError = fetched.errors.map(e => `${e.topicId}: ${e.message}`).join(' | ');
      }

      for (const item of filtered) {
        if (created.length >= createBudget) break;

        // Attach a verified live embed (by category) to every RSS debate
        const liveEmbed = getLiveEmbedForCategory(item.category);
        const draft = buildDebateFromNews(item, { durationMs: DEFAULT_DURATION_MS, liveEmbed });
        if (!draft) continue;

        // Note: RSS debates have no guaranteed live stream — they're a fallback only
        const debate = createDebate(draft);
        if (!debate) continue;

        created.push({
          id: debate.id, title: debate.title, category: debate.category,
          sourceUrl: debate.sourceUrl, sourceTitle: debate.sourceTitle,
          sourceImageUrl: debate.sourceImageUrl, sourceExcerpt: debate.sourceExcerpt,
          endsAt: debate.endsAt,
        });

        pipelineState.usedArticles.unshift({
          sourceKey: item.sourceKey, titleFingerprint: item.titleFingerprint,
          sourceTitle: item.sourceTitle, sourceUrl: item.sourceUrl,
          debateId: debate.id, createdAt: startedAt,
        });
      }
    }

    pipelineState.lastSuccessAt      = startedAt;
    pipelineState.lastFetchCount      = liveStreams.length;
    pipelineState.lastCandidateCount  = created.length;
    pipelineState.lastFetchSample     = liveStreams.slice(0, 10).map(s => ({
      category: s.category, domain: 'youtube.com', sourceTitle: s.title,
      sourceUrl: s.sourceUrl, score: 10,
    }));
    pipelineState.lastCandidateSample = pipelineState.lastFetchSample;
    pipelineState.lastCreated         = created;

    pruneState();
    persistState();

    return {
      reason,
      closedIds: closedSummary.closedIds,
      hiddenIds: [...hiddenIds, ...backfillHiddenIds],
      activeDebatesBefore,
      sourceDebatesBefore,
      fetchedCount   : liveStreams.length,
      candidateCount : created.length,
      created,
      errors         : [],
    };
  })()
    .catch(error => {
      pipelineState.lastError = error.message || 'Unknown pipeline error';
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
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
  }

  runNewsMaintenance({ reason: 'startup' }).catch(error => {
    console.warn('[news] startup run failed', error);
  });

  schedulerHandle = setInterval(() => {
    runNewsMaintenance({ reason: 'interval' }).catch(error => {
      console.warn('[news] scheduled run failed', error);
    });
  }, POLL_INTERVAL_MS);

  return schedulerHandle;
}

function getNewsPipelineStatus() {
  pruneState();
  return {
    source: 'bbc-rss',
    endpoint: 'https://feeds.bbci.co.uk/news/10628494',
    topics: RSS_TOPICS.map(topic => ({ id: topic.id, category: topic.category, label: topic.label, feedUrl: topic.feedUrl })),
    trustedDomains: [...TRUSTED_NEWS_DOMAINS].sort(),
    targetActiveDebates: TARGET_ACTIVE_DEBATES,
    targetSourceDebates: TARGET_SOURCE_DEBATES,
    maxCreatedPerRun: MAX_CREATED_PER_RUN,
    pollIntervalMs: POLL_INTERVAL_MS,
    activeDebates: countActiveDebates(),
    activeSourceDebates: countActiveSourceDebates(),
    totalDebatesStored: listDebates({ includeUnlisted: true }).length,
    usedSourceCount: pipelineState.usedArticles.length,
    lastRunAt: pipelineState.lastRunAt,
    lastSuccessAt: pipelineState.lastSuccessAt,
    lastError: pipelineState.lastError,
    lastReason: pipelineState.lastReason,
    lastFetchCount: pipelineState.lastFetchCount,
    lastCandidateCount: pipelineState.lastCandidateCount,
    lastFetchSample: pipelineState.lastFetchSample,
    lastCandidateSample: pipelineState.lastCandidateSample,
    lastCreated: pipelineState.lastCreated,
  };
}

module.exports = {
  getNewsPipelineStatus,
  runNewsMaintenance,
  startNewsScheduler,
};
