'use strict';

/**
 * news-filter.js
 * Filters raw RSS articles down to debate-worthy candidates.
 */

// ─────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────
const MAX_AGE_MS = 36 * 60 * 60 * 1000; // 36 hours

// Titles starting with these words are too vague / not debate-worthy
const VAGUE_PREFIXES = [
  /^how\b/i,
  /^why\b/i,
  /^what\b/i,
  /^who\b/i,
  /^where\b/i,
  /^when\b/i,
  /^live\b/i,
  /^watch\b/i,
  /^in pictures?\b/i,
  /^in full\b/i,
  /^read more\b/i,
  /^explainer\b/i,
  /^analysis\b/i,
  /^profile\b/i,
  /^obituary\b/i,
  /^quiz\b/i,
];

// Titles containing these phrases are not debate-worthy
const VAGUE_PHRASES = [
  /live updates?/i,
  /live blog/i,
  /as it happened/i,
  /in pictures/i,
  /in numbers/i,
  /at a glance/i,
  /fact.?check/i,
  /round.?up/i,
];

// Categories we accept
const ALLOWED_CATEGORIES = new Set(['tech', 'business', 'politics', 'world', 'sport']);

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function isVagueTitle(title) {
  for (const re of VAGUE_PREFIXES) {
    if (re.test(title)) return true;
  }
  for (const re of VAGUE_PHRASES) {
    if (re.test(title)) return true;
  }
  return false;
}

function isTooOld(pubDate) {
  return Date.now() - pubDate > MAX_AGE_MS;
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Filter raw articles to debate-worthy candidates.
 * @param {Array} articles - raw articles from news-sources
 * @param {Set<string>} usedUrls - set of already-used article URLs
 * @returns {Array} filtered candidates, sorted newest-first
 */
function filterCandidates(articles, usedUrls = new Set()) {
  const seenUrls = new Set();
  const candidates = [];

  for (const article of articles) {
    // Must have a title and link
    if (!article.title || !article.link) continue;

    // Category must be in allowed set
    if (!ALLOWED_CATEGORIES.has(article.category)) continue;

    // Skip vague titles
    if (isVagueTitle(article.title)) continue;

    // Skip too-old articles
    if (isTooOld(article.pubDate)) continue;

    // Deduplicate by URL within this batch
    if (seenUrls.has(article.link)) continue;
    seenUrls.add(article.link);

    // Skip already-used articles
    if (usedUrls.has(article.link)) continue;

    // Title must be at least 20 chars (avoid stub headlines)
    if (article.title.length < 20) continue;

    candidates.push(article);
  }

  // Sort newest first
  candidates.sort((a, b) => b.pubDate - a.pubDate);

  console.log(`[news-filter] ${candidates.length} candidates after filtering (from ${articles.length} raw)`);
  return candidates;
}

module.exports = { filterCandidates };
