const crypto = require('crypto');
const { hasUsablePreviewImage, isControversialNewsItem } = require('./news-filter');

const DEFAULT_DURATION_MS = Math.max(900_000, Number(process.env.NEWS_DEBATE_DURATION_MS) || 8 * 60 * 60 * 1000);

const CATEGORY_STYLES = {
  technology: ['#3d9eff', '#667eea', '#0d0d1a'],
  economy: ['#00d97e', '#00b865', '#0a1a12'],
  politics: ['#ff6432', '#dd3311', '#1a0a00'],
  crypto: ['#f7931a', '#ff6432', '#1a1a2e'],
  sports: ['#aa55ff', '#764ba2', '#130d1a'],
  culture: ['#ff7f50', '#ff4f7b', '#1a0d16'],
  society: ['#ffc800', '#ff9900', '#1a1500'],
  general: ['#ff6432', '#ff8c55', '#1a0a00'],
};

// Curated Unsplash fallback images per category (stable IDs, freely accessible)
const CATEGORY_FALLBACK_IMAGES = {
  technology: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80&auto=format&fit=crop',
  economy:    'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&q=80&auto=format&fit=crop',
  politics:   'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=800&q=80&auto=format&fit=crop',
  crypto:     'https://images.unsplash.com/photo-1621504450181-5d356f61d307?w=800&q=80&auto=format&fit=crop',
  sports:     'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=800&q=80&auto=format&fit=crop',
  geopolitics:'https://images.unsplash.com/photo-1576485375217-d6a95e34d043?w=800&q=80&auto=format&fit=crop',
  society:    'https://images.unsplash.com/photo-1573164713988-8665fc963095?w=800&q=80&auto=format&fit=crop',
  culture:    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80&auto=format&fit=crop',
  general:    'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800&q=80&auto=format&fit=crop',
};

function buildDebateVideoQuery(item) {
  const title = cleanHeadline(item.sourceTitle || '');
  const category = String(item.category || 'general').toLowerCase();
  if (!title) return '';

  const stopwords = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'with',
    'as', 'by', 'from', 'into', 'its', 'this', 'that', 'will', 'after',
    'amid', 'over', 'under', 'about', 'what', 'why', 'how',
  ]);

  const terms = title
    .split(/\s+/)
    .map(token => token.replace(/[^A-Za-z0-9&'.-]/g, ''))
    .filter(token => token.length > 2 && !stopwords.has(token.toLowerCase()))
    .slice(0, 6);

  const categoryHints = {
    politics: 'political debate panel live',
    geopolitics: 'world news panel debate live',
    economy: 'economy market debate panel',
    technology: 'technology debate panel AI jobs discussion',
    crypto: 'crypto market debate panel',
    sports: 'sports debate panel live',
    culture: 'talk show panel discussion',
    society: 'news panel discussion live',
    general: 'news debate panel live',
  };

  const editorialHint = categoryHints[category] || categoryHints.general;
  const channelHint = ['BBC News', 'CNN', 'Reuters', 'Sky News'].join(' OR ');

  return [...terms, editorialHint, channelHint].join(' ').trim();
}

/**
 * Build a YouTube embed search URL for a debate topic.
 * Uses YouTube's listType=search embed parameter to surface credible
 * TV/news panel footage without requiring an API key.
 */
function buildYouTubeSearchUrl(item) {
  const query = buildDebateVideoQuery(item);
  if (!query) return '';

  return `https://www.youtube.com/embed?autoplay=1&mute=1&playsinline=1&controls=0&modestbranding=1&rel=0&listType=search&list=${encodeURIComponent(query)}&index=1`;
}

/**
 * Return the best available image URL for a news item.
 * Falls back to a curated category image when the RSS feed provides none.
 */
function resolvePreviewImage(item) {
  if (hasUsablePreviewImage(item.imageUrl)) return item.imageUrl;
  const fallback = CATEGORY_FALLBACK_IMAGES[item.category] || CATEGORY_FALLBACK_IMAGES.general;
  return fallback;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanHeadline(title) {
  return normalizeWhitespace(title)
    .replace(/\s+[|-]\s+.*$/, '')
    .replace(/[.?!]+$/, '')
    .trim();
}

function cleanSegment(value, maxWords = 7) {
  const cleaned = normalizeWhitespace(value)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[,;:]+.*$/, '')
    .trim();

  return cleaned
    .split(/\s+/)
    .slice(0, maxWords)
    .join(' ')
    .trim();
}

function possessive(subject) {
  const value = cleanSegment(subject, 5);
  if (!value) return '';
  return /s$/i.test(value) ? `${value}'` : `${value}'s`;
}

function extractLeadingEntity(title) {
  const directMatch = cleanHeadline(title).match(/^([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,4})/);
  if (directMatch) {
    return cleanSegment(directMatch[1], 5);
  }

  const assetMatch = cleanHeadline(title).match(/\b(Bitcoin|Ethereum|OpenAI|Nvidia|Apple|Microsoft|Google|Tesla|Meta|Amazon|Fed|ECB|PSG|Real Madrid|Arsenal|Liverpool)\b/i);
  return assetMatch ? cleanSegment(assetMatch[1], 5) : '';
}

function hashNumber(seed) {
  const digest = crypto.createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 8);
  return parseInt(digest, 16);
}

function seededRange(seed, min, max) {
  const value = hashNumber(seed);
  return min + (value % (max - min + 1));
}

function buildDescription(item) {
  const sourceName = item.domain ? item.domain.replace(/^www\./, '') : item.sourceFeedLabel || 'news source';
  const headline = cleanHeadline(item.sourceTitle);
  return `Auto-generated from recent coverage on ${sourceName}: ${headline}.`;
}

function buildSourceExcerpt(item) {
  const excerpt = normalizeWhitespace(item.sourceDescription);
  if (!excerpt) return '';
  return excerpt.length > 220 ? `${excerpt.slice(0, 217).trim()}...` : excerpt;
}

function buildQuestion(item) {
  const title = cleanHeadline(item.sourceTitle);

  if (/^(How|Why|What|When|Where|Who)\b/i.test(title)) {
    return null;
  }

  const directQuestionMatch = title.match(/^(Will|Could|Can|Should|Would)\s+(.+)$/i);
  if (directQuestionMatch) {
    const remainder = cleanSegment(directQuestionMatch[2], 8);
    if (remainder) {
      return `Will ${remainder}?`;
    }
  }

  const launchMatch = title.match(/^(.+?)\s+(launches|unveils|announces|releases|debuts|rolls out)\s+(.+)$/i);
  if (launchMatch) {
    const owner = possessive(launchMatch[1]);
    const object = cleanSegment(launchMatch[3], 6);
    if (owner && object) {
      return `Will ${owner} ${object} be a success?`;
    }
  }

  const approvalMatch = title.match(/^(.+?)\s+(approves|passes|backs|blocks|bans|regulates|cuts|raises)\s+(.+)$/i);
  if (approvalMatch) {
    const object = cleanSegment(approvalMatch[3], 7);
    if (object) {
      return `Will ${object} have a lasting impact?`;
    }
  }

  const movementMatch = title.match(/^(.+?)\s+(rises|jumps|surges|falls|slumps|drops|soars|plunges)\b/i);
  if (movementMatch) {
    const subject = cleanSegment(movementMatch[1], 5);
    if (subject) {
      return `Will ${subject} keep moving this way?`;
    }
  }

  if (item.category === 'sports' && /\b(final|playoff|championship|tournament|cup|grand prix|title race)\b/i.test(title)) {
    const subject = extractLeadingEntity(title);
    if (subject) {
      return `Will ${subject} go all the way?`;
    }
  }

  if (/\b(bitcoin|ethereum|crypto|cryptocurrency|etf)\b/i.test(title)) {
    const subject = cleanSegment(title.match(/\b(Bitcoin|Ethereum|crypto ETF|crypto)\b/i)?.[1] || 'crypto', 4);
    if (subject) {
      return `Will ${subject} keep the momentum?`;
    }
  }

  if (/\b(election|poll|campaign|vote)\b/i.test(title)) {
    const subject = extractLeadingEntity(title);
    if (subject) {
      return `Will ${subject} come out on top?`;
    }
  }

  if (/\b(merger|acquisition|earnings|tariff|inflation|interest rates?|layoffs?)\b/i.test(title)) {
    const subject = extractLeadingEntity(title);
    if (subject) {
      return `Will ${subject} move the market?`;
    }
  }

  return null;
}

function isUsableQuestion(question) {
  if (!question) return false;
  if (!question.endsWith('?')) return false;
  if (question.length < 25 || question.length > 100) return false;
  if (/^Will (this|it|the move|the story)\b/i.test(question)) return false;
  return true;
}

function buildDebateFromNews(item, options = {}) {
  const durationMs = Math.max(900_000, Number(options.durationMs) || DEFAULT_DURATION_MS);
  const title = buildQuestion(item);

  // Controversy is still required — an irrelevant headline shouldn't become a debate
  if (!isControversialNewsItem(item)) {
    return null;
  }

  if (!isUsableQuestion(title)) {
    return null;
  }

  const seed = item.sourceKey || item.titleFingerprint || item.sourceTitle;
  const category = item.category || 'general';
  const gradColors = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
  const yesPct = seededRange(seed, 42, 58);
  const viewers = seededRange(`${seed}:viewers`, 650, 2600);
  const pool = seededRange(`${seed}:pool`, 25, 95) * 1000;
  const openedAt = Date.now();

  // Resolve image — use RSS thumbnail when available, else category fallback
  const imageUrl = resolvePreviewImage(item);

  // Build a YouTube search embed URL for contextual video
  const youtubeUrl = buildYouTubeSearchUrl(item);

  return {
    title,
    description: buildDescription(item),
    sourceExcerpt: buildSourceExcerpt(item),
    sourceDescription: normalizeWhitespace(item.sourceDescription),
    sourceImageUrl: imageUrl,
    previewVideoUrl: youtubeUrl,
    contextVideoUrl: youtubeUrl,
    sourceFeedLabel: item.sourceFeedLabel || '',
    sourceDomain: item.domain || '',
    yesLabel: 'YES',
    noLabel: 'NO',
    sourceUrl: item.sourceUrl,
    sourceTitle: item.sourceTitle,
    sourceKey: item.sourceKey,
    newsPublishedAt: item.publishedAt,
    createdFromNews: true,
    category,
    trending: item.score >= 8,
    ai: /\b(ai|artificial intelligence)\b/i.test(item.sourceTitle),
    yesPct,
    pool,
    viewers,
    gradColors,
    lang: 'en',
    photo: imageUrl,
    durationMs,
    openedAt,
    endsAt: openedAt + durationMs,
    listed: true,
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  buildDebateFromNews,
};
