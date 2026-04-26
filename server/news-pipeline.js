// server/news-pipeline.js
// Debate pipeline: creates debates ONLY from verified live YouTube streams.
// RSS/article-based debate creation has been removed entirely.
// Rule: a debate MUST NOT exist without a valid live video stream.

'use strict';

var fs   = require('fs');
var path = require('path');

var debates     = require('./debates');
var generator   = require('./news-debate-generator');
var filter      = require('./news-filter');
var ytLive      = require('./youtube-live');

var countActiveDebates       = debates.countActiveDebates;
var createDebate             = debates.createDebate;
var hideNonLiveDebates       = debates.hideNonLiveDebates;
var hideSurplusActiveDebates = debates.hideSurplusActiveDebates;
var listDebates              = debates.listDebates;
var reconcileDebates         = debates.reconcileDebates;

var buildDebateFromLiveStream = generator.buildDebateFromLiveStream;
var DEFAULT_DURATION_MS       = generator.DEFAULT_DURATION_MS;
var fingerprintTitle          = filter.fingerprintTitle;
var fetchAllLiveStreams        = ytLive.fetchAllLiveStreams;

var STATE_FILE = process.env.NEWS_STATE_FILE || path.join(__dirname, 'data', 'news-state.json');

// Max total visible debates (live only)
var TARGET_ACTIVE_DEBATES = Math.max(3, Math.min(50, Number(process.env.DEBATE_TARGET_ACTIVE) || 12));
// Max debates to create per run
var MAX_CREATED_PER_RUN   = Math.max(1, Math.min(9, Number(process.env.NEWS_MAX_CREATED_PER_RUN) || 3));
// How often to run the pipeline (90s default)
var POLL_INTERVAL_MS      = Math.max(30000, Number(process.env.NEWS_POLL_INTERVAL_MS) || 90000);
// How long to keep used-article fingerprints (days)
var USED_RETENTION_DAYS   = Math.max(3, Number(process.env.NEWS_USED_RETENTION_DAYS) || 14);

var pipelineState   = loadState();
var schedulerHandle = null;
var runningPromise  = null;

function nowIso() { return new Date().toISOString(); }

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

function sanitizeUsed(item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.sourceKey || !item.titleFingerprint) return null;
  return {
    sourceKey:        String(item.sourceKey).toLowerCase(),
    titleFingerprint: String(item.titleFingerprint),
    sourceTitle:      String(item.sourceTitle || ''),
    sourceUrl:        String(item.sourceUrl || ''),
    debateId:         item.debateId ? String(item.debateId) : null,
    createdAt:        item.createdAt || nowIso(),
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return baseState();
  try {
    var raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return Object.assign(baseState(), raw, {
      usedArticles: Array.isArray(raw.usedArticles)
        ? raw.usedArticles.map(sanitizeUsed).filter(Boolean)
        : [],
      lastFetchSample:     Array.isArray(raw.lastFetchSample)     ? raw.lastFetchSample.slice(0, 10)     : [],
      lastCandidateSample: Array.isArray(raw.lastCandidateSample) ? raw.lastCandidateSample.slice(0, 10) : [],
      lastCreated:         Array.isArray(raw.lastCreated)         ? raw.lastCreated.slice(0, 10)         : [],
    });
  } catch (e) {
    console.warn('[news] failed to load state file, starting fresh:', e.message);
    return baseState();
  }
}

function persistState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  var tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pipelineState, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function pruneState() {
  var maxAgeMs = USED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  var cutoff   = Date.now() - maxAgeMs;
  pipelineState.usedArticles = pipelineState.usedArticles
    .filter(function (item) {
      var ts = Date.parse(item.createdAt);
      return Number.isFinite(ts) && ts >= cutoff;
    })
    .slice(0, 300);
}

function buildExistingContext() {
  var existing = listDebates({ includeUnlisted: true });
  var sourceKeys   = [];
  var fingerprints = [];
  existing.forEach(function (d) {
    if (d.sourceKey)  sourceKeys.push(String(d.sourceKey).toLowerCase());
    if (d.sourceUrl)  sourceKeys.push(String(d.sourceUrl).toLowerCase());
    if (d.title)      fingerprints.push(fingerprintTitle(d.title));
    if (d.sourceTitle)fingerprints.push(fingerprintTitle(d.sourceTitle));
  });
  return {
    existingSourceKeys:        sourceKeys,
    existingTitleFingerprints: fingerprints.filter(Boolean),
  };
}

function countActiveLiveDebates() {
  return listDebates()
    .filter(function (d) { return !d.closed && d.liveVideoId; })
    .length;
}

async function runNewsMaintenance(options) {
  var reason = (options && options.reason) || 'manual';

  if (runningPromise) return runningPromise;

  runningPromise = (async function () {
    var startedAt = nowIso();
    pipelineState.lastRunAt  = startedAt;
    pipelineState.lastReason = reason;
    pipelineState.lastError  = null;

    // Step 1: Close expired debates
    var closedSummary = reconcileDebates();

    // Step 2: Hide all debates that have no live stream attached.
    //         This removes old seed debates and RSS debates permanently.
    var hiddenNonLive = hideNonLiveDebates ? hideNonLiveDebates() : 0;
    if (hiddenNonLive > 0) {
      console.log('[news] hid ' + hiddenNonLive + ' non-live debates');
    }

    // Step 3: Hide surplus active debates if over target
    var hiddenSurplus = hideSurplusActiveDebates(TARGET_ACTIVE_DEBATES);

    var activeLiveBefore = countActiveLiveDebates();
    var missingSlots     = Math.max(0, TARGET_ACTIVE_DEBATES - activeLiveBefore);

    if (missingSlots <= 0) {
      pipelineState.lastFetchCount     = 0;
      pipelineState.lastCandidateCount = 0;
      pipelineState.lastFetchSample    = [];
      pipelineState.lastCandidateSample= [];
      pipelineState.lastCreated        = [];
      pruneState();
      persistState();
      return {
        reason,
        closedIds:        closedSummary.closedIds,
        hiddenNonLive,
        hiddenSurplus,
        activeLiveBefore,
        created:          [],
      };
    }

    // Step 4: Fetch verified live streams from YouTube
    var liveStreams = [];
    try {
      liveStreams = await fetchAllLiveStreams();
    } catch (e) {
      console.warn('[news] fetchAllLiveStreams error:', e.message);
    }

    if (!liveStreams.length) {
      console.log('[news] no live streams verified -- skipping debate creation');
      pipelineState.lastFetchCount     = 0;
      pipelineState.lastCandidateCount = 0;
      pipelineState.lastFetchSample    = [];
      pipelineState.lastCandidateSample= [];
      pipelineState.lastCreated        = [];
      pruneState();
      persistState();
      return {
        reason,
        closedIds:        closedSummary.closedIds,
        hiddenNonLive,
        hiddenSurplus,
        activeLiveBefore,
        liveStreamsFound:  0,
        created:          [],
        note:             'no verified live streams available',
      };
    }

    console.log('[news] ' + liveStreams.length + ' verified live streams available');

    // Step 5: Deduplicate against existing debates
    var ctx = buildExistingContext();
    var usedSourceKeys   = new Set(ctx.existingSourceKeys.concat(
      pipelineState.usedArticles.map(function (a) { return a.sourceKey; })
    ));
    var usedFingerprints = new Set(ctx.existingTitleFingerprints.concat(
      pipelineState.usedArticles.map(function (a) { return a.titleFingerprint; })
    ));

    var created    = [];
    var createBudget = Math.min(missingSlots, MAX_CREATED_PER_RUN);

    // Step 6: Create debates from verified live streams
    for (var i = 0; i < liveStreams.length; i++) {
      if (created.length >= createBudget) break;

      var stream    = liveStreams[i];
      var sourceKey = 'yt-live-' + stream.videoId;

      if (usedSourceKeys.has(sourceKey)) {
        console.log('[news] skip duplicate stream: ' + stream.channelHandle);
        continue;
      }

      var fp = fingerprintTitle(stream.title);
      if (fp && usedFingerprints.has(fp)) {
        console.log('[news] skip duplicate title: ' + stream.title);
        continue;
      }

      var draft = buildDebateFromLiveStream(stream, { durationMs: DEFAULT_DURATION_MS });
      if (!draft) {
        console.log('[news] no question generated for: ' + stream.channelHandle + ' -- "' + stream.title + '"');
        continue;
      }

      var debate = createDebate(draft);
      if (!debate) continue;

      console.log('[news] live debate created: "' + debate.title + '" from ' + stream.channelHandle);

      created.push({
        id:             debate.id,
        title:          debate.title,
        category:       debate.category,
        sourceUrl:      debate.sourceUrl,
        sourceTitle:    debate.sourceTitle,
        sourceImageUrl: debate.sourceImageUrl,
        endsAt:         debate.endsAt,
        liveVideoId:    stream.videoId,
        channel:        stream.channelHandle,
      });

      usedSourceKeys.add(sourceKey);
      if (fp) usedFingerprints.add(fp);

      pipelineState.usedArticles.unshift({
        sourceKey:        sourceKey,
        titleFingerprint: fp || '',
        sourceTitle:      stream.title,
        sourceUrl:        stream.sourceUrl,
        debateId:         debate.id,
        createdAt:        startedAt,
      });
    }

    pipelineState.lastSuccessAt      = startedAt;
    pipelineState.lastFetchCount     = liveStreams.length;
    pipelineState.lastCandidateCount = created.length;
    pipelineState.lastFetchSample    = liveStreams.slice(0, 10).map(function (s) {
      return { category: s.category, channel: s.channelHandle, title: s.title };
    });
    pipelineState.lastCandidateSample = pipelineState.lastFetchSample;
    pipelineState.lastCreated        = created;

    pruneState();
    persistState();

    return {
      reason,
      closedIds:       closedSummary.closedIds,
      hiddenNonLive,
      hiddenSurplus,
      activeLiveBefore,
      liveStreamsFound: liveStreams.length,
      created,
    };
  })()
    .catch(function (err) {
      pipelineState.lastError   = err.message || 'Unknown pipeline error';
      pipelineState.lastCreated = [];
      persistState();
      throw err;
    })
    .finally(function () {
      runningPromise = null;
    });

  return runningPromise;
}

function startNewsScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);

  runNewsMaintenance({ reason: 'startup' }).catch(function (e) {
    console.warn('[news] startup run failed:', e.message);
  });

  schedulerHandle = setInterval(function () {
    runNewsMaintenance({ reason: 'interval' }).catch(function (e) {
      console.warn('[news] scheduled run failed:', e.message);
    });
  }, POLL_INTERVAL_MS);

  return schedulerHandle;
}

function getNewsPipelineStatus() {
  pruneState();
  return {
    source:               'youtube-live-only',
    targetActiveDebates:  TARGET_ACTIVE_DEBATES,
    maxCreatedPerRun:     MAX_CREATED_PER_RUN,
    pollIntervalMs:       POLL_INTERVAL_MS,
    activeDebates:        countActiveDebates(),
    activeLiveDebates:    countActiveLiveDebates(),
    totalDebatesStored:   listDebates({ includeUnlisted: true }).length,
    usedSourceCount:      pipelineState.usedArticles.length,
    lastRunAt:            pipelineState.lastRunAt,
    lastSuccessAt:        pipelineState.lastSuccessAt,
    lastError:            pipelineState.lastError,
    lastReason:           pipelineState.lastReason,
    lastFetchCount:       pipelineState.lastFetchCount,
    lastCandidateCount:   pipelineState.lastCandidateCount,
    lastFetchSample:      pipelineState.lastFetchSample,
    lastCandidateSample:  pipelineState.lastCandidateSample,
    lastCreated:          pipelineState.lastCreated,
  };
}

module.exports = {
  getNewsPipelineStatus: getNewsPipelineStatus,
  runNewsMaintenance:    runNewsMaintenance,
  startNewsScheduler:    startNewsScheduler,
};
