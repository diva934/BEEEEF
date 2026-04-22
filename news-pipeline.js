const fs = require('fs');
const path = require('path');

const { countActiveDebates, createDebate, hideSurplusActiveDebates, listDebates, reconcileDebates } = require('./debates');
const { buildDebateFromNews, DEFAULT_DURATION_MS } = require('./news-debate-generator');
const { filterNewsItems, fingerprintTitle } = require('./news-filter');
const { fetchLatestNews, RSS_TOPICS, TRUSTED_NEWS_DOMAINS } = require('./news-sources');

const STATE_FILE = process.env.NEWS_STATE_FILE || path.join(__dirname, 'data', 'news-state.json');
const TARGET_ACTIVE_DEBATES = Math.max(3, Math.min(5, Number(process.env.DEBATE_TARGET_ACTIVE) || 4));
const MAX_CREATED_PER_RUN = Math.max(1, Math.min(2, Number(process.env.NEWS_MAX_CREATED_PER_RUN) || 1));
const POLL_INTERVAL_MS = Math.max(60_000, Number(process.env.NEWS_POLL_INTERVAL_MS) || 300_000);
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
    publishedAt: item.publishedAt,
    score: item.score,
  };
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
    const activeDebatesBefore = countActiveDebates();
    const startedAt = nowIso();

    pipelineState.lastRunAt = startedAt;
    pipelineState.lastReason = reason;
    pipelineState.lastError = null;

    const missingSlots = Math.max(0, TARGET_ACTIVE_DEBATES - activeDebatesBefore);
    if (missingSlots <= 0) {
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
        hiddenIds,
        activeDebatesBefore,
        created: [],
      };
    }

    const fetched = await fetchLatestNews();
    const debateContext = buildExistingDebateContext();
    const filtered = filterNewsItems(fetched.items, {
      existingSourceKeys: debateContext.existingSourceKeys,
      existingTitleFingerprints: debateContext.existingTitleFingerprints,
      usedSourceKeys: pipelineState.usedArticles.map(item => item.sourceKey),
      usedTitleFingerprints: pipelineState.usedArticles.map(item => item.titleFingerprint),
    });

    const created = [];
    const createBudget = Math.min(missingSlots, MAX_CREATED_PER_RUN);

    for (const item of filtered) {
      if (created.length >= createBudget) {
        break;
      }

      const draft = buildDebateFromNews(item, { durationMs: DEFAULT_DURATION_MS });
      if (!draft) {
        continue;
      }

      const debate = createDebate(draft);
      if (!debate) {
        continue;
      }

      created.push({
        id: debate.id,
        title: debate.title,
        category: debate.category,
        sourceUrl: debate.sourceUrl,
        sourceTitle: debate.sourceTitle,
        endsAt: debate.endsAt,
      });

      pipelineState.usedArticles.unshift({
        sourceKey: item.sourceKey,
        titleFingerprint: item.titleFingerprint,
        sourceTitle: item.sourceTitle,
        sourceUrl: item.sourceUrl,
        debateId: debate.id,
        createdAt: startedAt,
      });
    }

    pipelineState.lastSuccessAt = startedAt;
    pipelineState.lastFetchCount = fetched.items.length;
    pipelineState.lastCandidateCount = filtered.length;
    pipelineState.lastFetchSample = sanitizeSample(fetched.items, summarizeItem);
    pipelineState.lastCandidateSample = sanitizeSample(filtered, summarizeItem);
    pipelineState.lastCreated = created;
    if (fetched.errors.length) {
      pipelineState.lastError = fetched.errors.map(error => `${error.topicId}: ${error.message}`).join(' | ');
    }

    pruneState();
    persistState();

    return {
      reason,
      closedIds: closedSummary.closedIds,
      hiddenIds,
      activeDebatesBefore,
      fetchedCount: fetched.items.length,
      candidateCount: filtered.length,
      created,
      errors: fetched.errors,
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
    maxCreatedPerRun: MAX_CREATED_PER_RUN,
    pollIntervalMs: POLL_INTERVAL_MS,
    activeDebates: countActiveDebates(),
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
