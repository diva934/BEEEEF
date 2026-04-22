'use strict';

/**
 * news-pipeline.js
 * Orchestrates the full news → debate pipeline.
 *
 * Flow:
 *   1. Fetch raw articles from BBC feeds
 *   2. Filter to debate-worthy candidates
 *   3. Exclude articles whose sourceKey is already in use
 *   4. Generate a debate from the best remaining candidate
 *   5. Persist the debate and record the used article
 */

const fs = require('fs');
const path = require('path');
const { fetchAllFeeds } = require('./news-sources');
const { filterCandidates } = require('./news-filter');
const { generateDebate } = require('./news-debate-generator');
const { createDebate, getUsedSourceKeys } = require('./debates');

// ─────────────────────────────────────────────────────────────
//  News-state persistence (tracks used article URLs)
// ─────────────────────────────────────────────────────────────
const NEWS_STATE_FILE = process.env.NEWS_STATE_FILE ||
  path.join(__dirname, 'data', 'news-state.json');

const MAX_STATE_ENTRIES = 500; // cap to avoid unbounded growth

function loadNewsState() {
  try {
    if (!fs.existsSync(NEWS_STATE_FILE)) return { usedUrls: [], lastFetchAt: null, lastErrorAt: null };
    return JSON.parse(fs.readFileSync(NEWS_STATE_FILE, 'utf8'));
  } catch (err) {
    console.warn('[news-pipeline] failed to load news-state.json:', err.message);
    return { usedUrls: [], lastFetchAt: null, lastErrorAt: null };
  }
}

function saveNewsState(state) {
  try {
    fs.mkdirSync(path.dirname(NEWS_STATE_FILE), { recursive: true });
    const tmp = `${NEWS_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, NEWS_STATE_FILE);
  } catch (err) {
    console.warn('[news-pipeline] failed to save news-state.json:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  Pipeline status (in-memory, for /news/status endpoint)
// ─────────────────────────────────────────────────────────────
const pipelineStatus = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  totalCreated: 0,
  lastCreatedTitle: null,
  isRunning: false,
};

// ─────────────────────────────────────────────────────────────
//  Core pipeline
// ─────────────────────────────────────────────────────────────

/**
 * Run the full pipeline once.
 * Returns the created debate object, or null if nothing suitable was found.
 */
async function runPipeline() {
  if (pipelineStatus.isRunning) {
    console.log('[news-pipeline] already running, skipping');
    return null;
  }

  pipelineStatus.isRunning = true;
  pipelineStatus.lastRunAt = new Date().toISOString();

  try {
    const state = loadNewsState();
    const usedUrls = new Set(state.usedUrls || []);

    // Also exclude sourceKeys already present in active debates
    const usedSourceKeys = getUsedSourceKeys();

    // 1. Fetch
    const rawArticles = await fetchAllFeeds();
    state.lastFetchAt = new Date().toISOString();

    // 2. Filter
    const candidates = filterCandidates(rawArticles, usedUrls);

    if (candidates.length === 0) {
      console.log('[news-pipeline] no suitable candidates found');
      pipelineStatus.lastSuccessAt = new Date().toISOString();
      saveNewsState(state);
      return null;
    }

    // 3. Exclude articles whose sourceKey is already in use
    const fresh = candidates.filter(c => !usedSourceKeys.has(c.sourceKey + ':' + c.link));
    if (fresh.length === 0) {
      console.log('[news-pipeline] all candidates already used (by sourceKey+url)');
      pipelineStatus.lastSuccessAt = new Date().toISOString();
      saveNewsState(state);
      return null;
    }

    // 4. Pick the best (newest) candidate
    const best = fresh[0];
    console.log(`[news-pipeline] selected article: "${best.title}" (${best.sourceKey})`);

    // 5. Generate and persist debate
    const debateObj = generateDebate(best);
    const saved = createDebate(debateObj);
    console.log(`[news-pipeline] created debate "${saved.title}" (id: ${saved.id})`);

    // 6. Record used URL
    usedUrls.add(best.link);
    state.usedUrls = [...usedUrls].slice(-MAX_STATE_ENTRIES);
    state.lastFetchAt = new Date().toISOString();
    saveNewsState(state);

    pipelineStatus.lastSuccessAt = new Date().toISOString();
    pipelineStatus.totalCreated += 1;
    pipelineStatus.lastCreatedTitle = saved.title;
    pipelineStatus.lastError = null;

    return saved;
  } catch (err) {
    console.error('[news-pipeline] error:', err.message || err);
    pipelineStatus.lastErrorAt = new Date().toISOString();
    pipelineStatus.lastError = err.message || String(err);
    return null;
  } finally {
    pipelineStatus.isRunning = false;
  }
}

/**
 * Return a snapshot of the pipeline status (for /news/status).
 */
function getStatus() {
  const state = loadNewsState();
  return {
    ...pipelineStatus,
    usedUrlCount: (state.usedUrls || []).length,
    lastFetchAt: state.lastFetchAt,
  };
}

module.exports = { runPipeline, getStatus };
