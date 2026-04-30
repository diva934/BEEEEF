const crypto = require('crypto');
const { hasUsablePreviewImage, isControversialNewsItem } = require('./news-filter');

const MIN_DEBATE_DURATION_MS = 20 * 60 * 1000;
const MAX_DEBATE_DURATION_MS = 5 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = Math.max(
  MIN_DEBATE_DURATION_MS,
  Math.min(MAX_DEBATE_DURATION_MS, Number(process.env.NEWS_DEBATE_DURATION_MS) || 2 * 60 * 60 * 1000)
);

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
    politics: 'political analysis panel discussion',
    geopolitics: 'world news analysis panel documentary discussion',
    economy: 'economy market analysis panel discussion',
    technology: 'technology AI analysis report discussion',
    crypto: 'crypto market analysis panel discussion',
    sports: 'sports analysis debate discussion highlights',
    culture: 'talk show cultural analysis discussion',
    society: 'news analysis panel discussion',
    general: 'news analysis panel discussion',
  };

  const editorialHint = categoryHints[category] || categoryHints.general;
  const channelHint = ['BBC News', 'Reuters', 'DW News', 'France 24', 'Sky News'].join(' OR ');

  return [...terms, editorialHint, channelHint].join(' ').trim();
}

function buildYouTubeSearchUrl(item) {
  const query = buildDebateVideoQuery(item);
  if (!query) return '';
  return `https://www.youtube.com/embed?autoplay=1&mute=1&playsinline=1&controls=0&modestbranding=1&rel=0&listType=search&list=${encodeURIComponent(query)}&index=1`;
}

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

function clampDurationMs(value) {
  return Math.max(MIN_DEBATE_DURATION_MS, Math.min(MAX_DEBATE_DURATION_MS, Number(value) || DEFAULT_DURATION_MS));
}

function resolveDebateDurationMs(pool, explicitDurationMs) {
  const explicit = Number(explicitDurationMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return clampDurationMs(explicit);
  }

  const amount = Number(pool) || 0;
  if (amount >= 160000) return 5 * 60 * 60 * 1000;
  if (amount >= 120000) return 4 * 60 * 60 * 1000;
  if (amount >= 85000) return 3 * 60 * 60 * 1000;
  if (amount >= 50000) return 2 * 60 * 60 * 1000;
  if (amount >= 20000) return 60 * 60 * 1000;
  return MIN_DEBATE_DURATION_MS;
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
  const title = buildQuestion(item);

  // Controversy is still required
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
  const durationMs = resolveDebateDurationMs(pool, options.durationMs);
  const openedAt = Date.now();

  const imageUrl = resolvePreviewImage(item);
  const contextVideoUrl = normalizeWhitespace(options.contextVideoUrl || buildYouTubeSearchUrl(item));

  return {
    title,
    description: buildDescription(item),
    sourceExcerpt: buildSourceExcerpt(item),
    sourceDescription: normalizeWhitespace(item.sourceDescription),
    sourceImageUrl: imageUrl,
    photo: imageUrl,
    previewVideoUrl: contextVideoUrl,
    contextVideoUrl,
    liveVideoId: null,
    liveEmbedUrl: null,
    liveChannel: null,
    createdFromLive: false,
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
    durationMs,
    openedAt,
    endsAt: openedAt + durationMs,
    listed: true,
  };
}

// ─────────────────────────────────────────────────────────────
//  Build a debate from a live YouTube stream
// ─────────────────────────────────────────────────────────────

// Strip common live-stream title prefixes/suffixes so we can build a question.
// e.g. "LIVE | Ukraine War Update | Al Jazeera" -> "Ukraine War Update"
function cleanLiveTitle(rawTitle) {
  return rawTitle
    // Remove emoji (Unicode ranges for misc symbols/pictographs)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Remove common live prefixes
    .replace(/^(LIVE\s*[:|-]?|BREAKING\s*[:|-]?|EN\s+DIRECT\s*[:|-]?|DIRECT\s*[:|-]?\s*)/gi, '')
    // Remove trailing channel name after last pipe
    .replace(/\s*[|]\s*[^|]{1,40}$/, '')
    // Remove hashtags
    .replace(/\s*#\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildQuestionFromLiveTitle(rawTitle) {
  const title = cleanHeadline(cleanLiveTitle(rawTitle));
  if (!title || title.length < 5) return null;

  if (/^(How|Why|What|When|Where|Who)\b/i.test(title)) return null;

  const directQ = title.match(/^(Will|Could|Can|Should|Would)\s+(.+)$/i);
  if (directQ) {
    const rem = cleanSegment(directQ[2], 8);
    if (rem) return `Will ${rem}?`;
  }

  const launchM = title.match(/^(.+?)\s+(launches|unveils|announces|releases|debuts)\s+(.+)$/i);
  if (launchM) {
    const owner = possessive(launchM[1]);
    const obj   = cleanSegment(launchM[3], 6);
    if (owner && obj) return `Will ${owner} ${obj} be a success?`;
  }

  const approvalM = title.match(/^(.+?)\s+(approves|passes|backs|blocks|bans|regulates|cuts|raises)\s+(.+)$/i);
  if (approvalM) {
    const obj = cleanSegment(approvalM[3], 7);
    if (obj) return `Will ${obj} have a lasting impact?`;
  }

  const moveM = title.match(/^(.+?)\s+(rises|jumps|surges|falls|slumps|drops|soars|plunges)\b/i);
  if (moveM) {
    const subj = cleanSegment(moveM[1], 5);
    if (subj) return `Will ${subj} keep moving this way?`;
  }

  if (/\b(bitcoin|ethereum|crypto|etf)\b/i.test(title)) {
    const subj = cleanSegment(title.match(/\b(Bitcoin|Ethereum|crypto ETF|crypto)\b/i)?.[1] || 'crypto', 4);
    if (subj) return `Will ${subj} keep the momentum?`;
  }

  if (/\b(election|poll|campaign|vote)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} come out on top?`;
  }

  if (/\b(war|conflict|attack|crisis|ceasefire|invasion)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} resolve this conflict?`;
    return 'Will this conflict reach a resolution?';
  }

  if (/\b(tariff|inflation|interest rates?|recession|market|earnings|layoffs?)\b/i.test(title)) {
    const subj = extractLeadingEntity(title) || 'markets';
    return `Will ${subj} move the market?`;
  }

  if (/\b(deal|agreement|summit|talks|negotiat)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} reach a deal?`;
  }

  if (/\b(ai|artificial intelligence|chatgpt|openai|gemini)\b/i.test(title)) {
    const subj = extractLeadingEntity(title) || 'AI';
    if (subj) return `Will ${subj} reshape the industry?`;
  }

  const entity = extractLeadingEntity(title);
  if (entity && entity.length > 3) return `Will ${entity} change the course of events?`;

  return null;
}

function buildDebateFromLiveStream(streamItem, options = {}) {
  const title      = buildQuestionFromLiveTitle(streamItem.title);

  if (!isUsableQuestion(title)) return null;

  const seed       = streamItem.videoId;
  const category   = streamItem.category || 'general';
  const gradColors = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
  const yesPct     = seededRange(seed, 42, 58);
  const viewers    = seededRange(`${seed}:viewers`, 650, 2600);
  const pool       = seededRange(`${seed}:pool`, 25, 95) * 1000;
  const durationMs = resolveDebateDurationMs(pool, options.durationMs);
  const openedAt   = Date.now();

  const channelLabel = streamItem.channelTitle || streamItem.channelHandle;
  const thumbnail    = streamItem.thumbnailUrl
    || `https://i.ytimg.com/vi/${streamItem.videoId}/maxresdefault.jpg`;

  return {
    title,
    description     : `Debate from live stream: ${channelLabel} - "${streamItem.title}"`,
    sourceExcerpt   : streamItem.title,
    sourceDescription: streamItem.title,
    sourceImageUrl  : thumbnail,
    previewVideoUrl : streamItem.embedUrl,
    contextVideoUrl : streamItem.embedUrl,
    sourceFeedLabel : channelLabel,
    sourceDomain    : 'youtube.com',
    yesLabel        : 'YES',
    noLabel         : 'NO',
    sourceUrl       : streamItem.sourceUrl,
    sourceTitle     : streamItem.title,
    sourceKey       : `yt-live-${streamItem.videoId}`,
    newsPublishedAt : new Date().toISOString(),
    createdFromNews : true,
    createdFromLive : true,
    category,
    trending        : false,
    ai              : /\b(ai|artificial intelligence|chatgpt|openai|gemini)\b/i.test(streamItem.title),
    yesPct,
    pool,
    viewers,
    gradColors,
    lang            : streamItem.lang || 'en',
    photo           : thumbnail,
    durationMs,
    openedAt,
    endsAt          : openedAt + durationMs,
    listed          : true,
    liveVideoId     : streamItem.videoId,
    liveEmbedUrl    : streamItem.embedUrl,
    liveChannel     : streamItem.channelHandle,
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  MAX_DEBATE_DURATION_MS,
  MIN_DEBATE_DURATION_MS,
  buildDebateFromNews,
  buildDebateFromLiveStream,
  resolveDebateDurationMs,
};
