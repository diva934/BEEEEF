'use strict';

/**
 * news-debate-generator.js
 * Transforms a news article into a debate object.
 */

// ─────────────────────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────────────────────
const DEFAULT_DURATION_MS = Number(process.env.NEWS_DEBATE_DURATION_MS) || 2_700_000; // 45 min

// Gradient palettes keyed by category
const CATEGORY_GRADIENTS = {
  tech:     ['#3d9eff', '#667eea', '#0d0d1a'],
  business: ['#00d97e', '#00b865', '#0a1a12'],
  politics: ['#ff6432', '#dd3311', '#1a0a00'],
  world:    ['#ff5555', '#cc2020', '#1a0d0d'],
  sport:    ['#aa55ff', '#764ba2', '#130d1a'],
  default:  ['#ffc800', '#ff9900', '#1a1500'],
};

// ─────────────────────────────────────────────────────────────
//  Question templates per category
// ─────────────────────────────────────────────────────────────
// Each template is a function(title) → string question.
// We keep them short, binary, and opinionated.
const QUESTION_TEMPLATES = {
  tech: [
    (t) => `Is this a turning point for tech? "${trimTitle(t)}"`,
    (t) => `Should we be worried about: "${trimTitle(t)}"?`,
    (t) => `Does this change everything? "${trimTitle(t)}"`,
    (t) => `Is this good for consumers? "${trimTitle(t)}"`,
  ],
  business: [
    (t) => `Is this good for the economy? "${trimTitle(t)}"`,
    (t) => `Should investors be concerned? "${trimTitle(t)}"`,
    (t) => `Will this hurt ordinary workers? "${trimTitle(t)}"`,
    (t) => `Is this a sign of economic trouble? "${trimTitle(t)}"`,
  ],
  politics: [
    (t) => `Is this the right decision? "${trimTitle(t)}"`,
    (t) => `Will this backfire politically? "${trimTitle(t)}"`,
    (t) => `Is this good for democracy? "${trimTitle(t)}"`,
    (t) => `Should the public be alarmed? "${trimTitle(t)}"`,
  ],
  world: [
    (t) => `Is the world getting more dangerous? "${trimTitle(t)}"`,
    (t) => `Should Western nations intervene? "${trimTitle(t)}"`,
    (t) => `Is this a global crisis? "${trimTitle(t)}"`,
    (t) => `Will this escalate further? "${trimTitle(t)}"`,
  ],
  sport: [
    (t) => `Is this a historic moment in sport? "${trimTitle(t)}"`,
    (t) => `Was the right call made? "${trimTitle(t)}"`,
    (t) => `Will this change the season? "${trimTitle(t)}"`,
    (t) => `Is this fair to the fans? "${trimTitle(t)}"`,
  ],
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function trimTitle(title) {
  // Keep the question short — truncate at 60 chars
  if (title.length <= 60) return title;
  return title.slice(0, 57).trimEnd() + '…';
}

function pickTemplate(category) {
  const templates = QUESTION_TEMPLATES[category] || QUESTION_TEMPLATES.tech;
  return templates[Math.floor(Math.random() * templates.length)];
}

function buildDescription(article) {
  // Use the RSS description if available, otherwise fall back to title
  const raw = (article.description || article.title || '').replace(/<[^>]+>/g, '').trim();
  if (!raw) return '';
  return raw.length > 200 ? raw.slice(0, 197).trimEnd() + '…' : raw;
}

function pickGradient(category) {
  return CATEGORY_GRADIENTS[category] || CATEGORY_GRADIENTS.default;
}

function generateId() {
  // Simple timestamp + random suffix — avoids collisions without uuid dep
  return `news-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Transform a news article into a debate object ready to be saved.
 * @param {object} article - filtered article from news-filter
 * @returns {object} debate object (not yet persisted)
 */
function generateDebate(article) {
  const template = pickTemplate(article.category);
  const title = template(article.title);
  const nowMs = Date.now();

  return {
    id: generateId(),
    title,
    description: buildDescription(article),
    category: article.category,
    trending: false,
    ai: false,
    yesPct: 50,
    pool: 0,
    viewers: 0,
    gradColors: pickGradient(article.category),
    yesLabel: 'YES',
    noLabel: 'NO',
    lang: 'en',
    photo: null,
    durationMs: DEFAULT_DURATION_MS,
    openedAt: nowMs,
    endsAt: nowMs + DEFAULT_DURATION_MS,
    closed: false,
    closedAt: null,
    winnerSide: null,
    winnerLabel: null,
    verdictReasoning: '',
    verdictScores: null,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    // News metadata
    sourceUrl: article.link,
    sourceTitle: article.title,
    sourceKey: article.sourceKey,
    newsPublishedAt: article.pubDate,
    createdFromNews: true,
    listed: true,
  };
}

module.exports = { generateDebate };
