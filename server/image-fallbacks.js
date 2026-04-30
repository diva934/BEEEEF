'use strict';

const { hasUsablePreviewImage } = require('./news-filter');

const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.IMAGE_SEARCH_TIMEOUT_MS) || 12000);
const IMAGE_CACHE_TTL_MS = Math.max(5 * 60 * 1000, Number(process.env.IMAGE_CACHE_TTL_MS) || 6 * 60 * 60 * 1000);

const imageCache = new Map();

const ENTITY_HINTS = [
  { pattern: /\bbitcoin\b/i, query: 'Bitcoin cryptocurrency' },
  { pattern: /\bethereum\b/i, query: 'Ethereum cryptocurrency' },
  { pattern: /\bopenai\b/i, query: 'OpenAI' },
  { pattern: /\bchatgpt\b/i, query: 'ChatGPT OpenAI' },
  { pattern: /\bnvidia\b/i, query: 'Nvidia' },
  { pattern: /\bapple\b/i, query: 'Apple Inc' },
  { pattern: /\bamazon\b/i, query: 'Amazon company' },
  { pattern: /\bgoogle\b/i, query: 'Google company' },
  { pattern: /\bmicrosoft\b/i, query: 'Microsoft' },
  { pattern: /\btesla\b/i, query: 'Tesla Inc' },
  { pattern: /\bmeta\b/i, query: 'Meta Platforms' },
  { pattern: /\bnetflix\b/i, query: 'Netflix' },
  { pattern: /\bspotify\b/i, query: 'Spotify' },
  { pattern: /\bplaystation\b/i, query: 'PlayStation' },
  { pattern: /\bepic games?\b/i, query: 'Epic Games' },
  { pattern: /\bnfl\b/i, query: 'NFL American football' },
  { pattern: /\bnba\b/i, query: 'NBA basketball' },
  { pattern: /\bmlb\b/i, query: 'MLB baseball' },
  { pattern: /\bpremier league\b/i, query: 'Premier League football' },
  { pattern: /\bligue 1\b/i, query: 'Ligue 1 football' },
  { pattern: /\blaliga\b/i, query: 'La Liga football' },
  { pattern: /\bserie a\b/i, query: 'Serie A football' },
  { pattern: /\bbundesliga\b/i, query: 'Bundesliga football' },
  { pattern: /\buefa\b/i, query: 'UEFA football' },
  { pattern: /\barsenal\b/i, query: 'Arsenal F.C.' },
  { pattern: /\bchelsea\b/i, query: 'Chelsea F.C.' },
  { pattern: /\breal madrid\b/i, query: 'Real Madrid CF' },
  { pattern: /\bbarcelona\b/i, query: 'FC Barcelona' },
  { pattern: /\bpsg\b/i, query: 'Paris Saint-Germain F.C.' },
  { pattern: /\bjuventus\b/i, query: 'Juventus F.C.' },
  { pattern: /\binter\b/i, query: 'Inter Milan' },
  { pattern: /\bbenfica\b/i, query: 'S.L. Benfica' },
  { pattern: /\bporto\b/i, query: 'FC Porto' },
];

const CATEGORY_HINTS = {
  sports: 'sports action stadium',
  economy: 'finance market business',
  politics: 'politics government parliament',
  technology: 'technology innovation',
  society: 'society world news',
  general: 'editorial news',
};

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniquePush(list, value) {
  const safe = normalizeText(value);
  if (!safe) return;
  if (!list.some(item => item.toLowerCase() === safe.toLowerCase())) {
    list.push(safe);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
      'user-agent': 'Mozilla/5.0 (compatible; BEEEF/1.0; +https://beeeef.vercel.app)',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function cacheResult(key, value) {
  imageCache.set(key, {
    expiresAt: Date.now() + IMAGE_CACHE_TTL_MS,
    value,
  });
}

function readCached(key) {
  const cached = imageCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    imageCache.delete(key);
    return null;
  }
  return cached.value;
}

function buildSearchCandidates({ title, category, sport, teams = [] }) {
  const candidates = [];
  const sourceText = normalizeText(title);

  teams.forEach(team => uniquePush(candidates, team));

  ENTITY_HINTS.forEach(entry => {
    if (entry.pattern.test(sourceText)) {
      uniquePush(candidates, entry.query);
    }
  });

  const capitalized = sourceText.match(/\b[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,3}\b/g) || [];
  capitalized.forEach(value => uniquePush(candidates, value));

  if (sourceText) {
    uniquePush(candidates, sourceText);
  }

  if (sport) {
    uniquePush(candidates, `${sourceText} ${sport}`);
  }

  if (category && CATEGORY_HINTS[category]) {
    uniquePush(candidates, `${sourceText} ${CATEGORY_HINTS[category]}`.trim());
  }

  if (!candidates.length && category && CATEGORY_HINTS[category]) {
    uniquePush(candidates, CATEGORY_HINTS[category]);
  }

  return candidates.slice(0, 8);
}

async function fetchWikipediaSummaryImage(term) {
  const normalized = normalizeText(term).replace(/\s+/g, '_');
  if (!normalized) return null;

  try {
    const payload = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(normalized)}`);
    const imageUrl = normalizeText(payload?.originalimage?.source || payload?.thumbnail?.source);
    if (!hasUsablePreviewImage(imageUrl)) return null;
    return {
      url: imageUrl,
      provider: 'wikipedia_summary',
      query: term,
      title: normalizeText(payload?.title || term),
    };
  } catch (_) {
    return null;
  }
}

async function searchWikipediaImage(term) {
  const query = normalizeText(term);
  if (!query) return null;

  try {
    const searchPayload = await fetchJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=${encodeURIComponent(query)}`
    );
    const result = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search[0] : null;
    if (!result?.title) return null;
    return fetchWikipediaSummaryImage(result.title);
  } catch (_) {
    return null;
  }
}

async function searchCommonsImage(term) {
  const query = normalizeText(term);
  if (!query) return null;

  try {
    const payload = await fetchJson(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json&origin=*`
    );
    const pages = payload?.query?.pages ? Object.values(payload.query.pages) : [];
    const best = pages.find(page => hasUsablePreviewImage(page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url));
    const imageInfo = best?.imageinfo?.[0];
    const imageUrl = normalizeText(imageInfo?.thumburl || imageInfo?.url);
    if (!hasUsablePreviewImage(imageUrl)) return null;
    return {
      url: imageUrl,
      provider: 'wikimedia_commons',
      query,
      title: normalizeText(best?.title || query),
    };
  } catch (_) {
    return null;
  }
}

async function resolveThematicImage(params = {}) {
  const sourceImageUrl = normalizeText(params.sourceImageUrl);
  if (hasUsablePreviewImage(sourceImageUrl)) {
    return {
      url: sourceImageUrl,
      mode: 'source',
      provider: 'origin',
      query: null,
    };
  }

  const searchCandidates = buildSearchCandidates(params);
  const cacheKey = JSON.stringify({
    title: normalizeText(params.title),
    category: normalizeText(params.category),
    sport: normalizeText(params.sport),
    teams: Array.isArray(params.teams) ? params.teams.map(normalizeText) : [],
  });
  const cached = readCached(cacheKey);
  if (cached) return cached;

  for (const candidate of searchCandidates) {
    const summaryImage = await fetchWikipediaSummaryImage(candidate);
    if (summaryImage) {
      const result = { url: summaryImage.url, mode: 'keyword_search', provider: summaryImage.provider, query: summaryImage.query };
      cacheResult(cacheKey, result);
      return result;
    }

    const searchedWiki = await searchWikipediaImage(candidate);
    if (searchedWiki) {
      const result = { url: searchedWiki.url, mode: 'keyword_search', provider: searchedWiki.provider, query: searchedWiki.query };
      cacheResult(cacheKey, result);
      return result;
    }

    const commonsImage = await searchCommonsImage(candidate);
    if (commonsImage) {
      const result = { url: commonsImage.url, mode: 'keyword_search', provider: commonsImage.provider, query: commonsImage.query };
      cacheResult(cacheKey, result);
      return result;
    }
  }

  const fallbackUrl = normalizeText(params.fallbackImageUrl);
  const fallback = {
    url: fallbackUrl,
    mode: 'curated_fallback',
    provider: 'fallback',
    query: searchCandidates[0] || null,
  };
  cacheResult(cacheKey, fallback);
  return fallback;
}

module.exports = {
  resolveThematicImage,
};
