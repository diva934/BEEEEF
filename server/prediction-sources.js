'use strict';

const { fetchLatestNews, scoreEventSignal } = require('./news-sources');

const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.PREDICTION_REQUEST_TIMEOUT_MS) || 15000);
const MAX_FETCH_RETRIES = Math.max(0, Number(process.env.PREDICTION_FETCH_RETRIES) || 1);
const ESPN_CACHE_MS = Math.max(15000, Number(process.env.ESPN_CACHE_MS) || 45000);
const COINGECKO_CACHE_MS = Math.max(15000, Number(process.env.COINGECKO_CACHE_MS) || 45000);
const MAX_ACTIVE_HORIZON_MS = 8 * 60 * 60 * 1000;
const MAX_EVENT_LOOKAHEAD_MS = 12 * 60 * 60 * 1000;

const LEAGUE_SPECS = {
  'fra.1': { key: 'fra.1', sport: 'soccer', league: 'fra.1', label: 'Ligue 1', regionParam: 'fr' },
  'eng.1': { key: 'eng.1', sport: 'soccer', league: 'eng.1', label: 'Premier League', regionParam: 'gb' },
  'esp.1': { key: 'esp.1', sport: 'soccer', league: 'esp.1', label: 'LaLiga', regionParam: 'es' },
  'ita.1': { key: 'ita.1', sport: 'soccer', league: 'ita.1', label: 'Serie A', regionParam: 'it' },
  'ger.1': { key: 'ger.1', sport: 'soccer', league: 'ger.1', label: 'Bundesliga', regionParam: 'de' },
  'bel.1': { key: 'bel.1', sport: 'soccer', league: 'bel.1', label: 'Pro League', regionParam: 'be' },
  'ned.1': { key: 'ned.1', sport: 'soccer', league: 'ned.1', label: 'Eredivisie', regionParam: 'nl' },
  'por.1': { key: 'por.1', sport: 'soccer', league: 'por.1', label: 'Primeira Liga', regionParam: 'pt' },
  'pol.1': { key: 'pol.1', sport: 'soccer', league: 'pol.1', label: 'Ekstraklasa', regionParam: 'pl' },
  'swe.1': { key: 'swe.1', sport: 'soccer', league: 'swe.1', label: 'Allsvenskan', regionParam: 'se' },
  'aut.1': { key: 'aut.1', sport: 'soccer', league: 'aut.1', label: 'Bundesliga Austria', regionParam: 'at' },
  'sui.1': { key: 'sui.1', sport: 'soccer', league: 'sui.1', label: 'Swiss Super League', regionParam: 'ch' },
  'uefa.champions': { key: 'uefa.champions', sport: 'soccer', league: 'uefa.champions', label: 'UEFA Champions League', regionParam: 'gb' },
  'uefa.europa': { key: 'uefa.europa', sport: 'soccer', league: 'uefa.europa', label: 'UEFA Europa League', regionParam: 'gb' },
  'uefa.europa.conf': { key: 'uefa.europa.conf', sport: 'soccer', league: 'uefa.europa.conf', label: 'UEFA Conference League', regionParam: 'gb' },
  'fifa.world': { key: 'fifa.world', sport: 'soccer', league: 'fifa.world', label: 'FIFA', regionParam: 'gb' },
  nfl: { key: 'nfl', sport: 'football', league: 'nfl', label: 'NFL', regionParam: 'us' },
  nba: { key: 'nba', sport: 'basketball', league: 'nba', label: 'NBA', regionParam: 'us' },
  mlb: { key: 'mlb', sport: 'baseball', league: 'mlb', label: 'MLB', regionParam: 'us' },
};

const REGION_CONTEXTS = {
  fr: {
    serverKey: 'EU-Paris',
    locale: 'fr-FR',
    leagueKeys: ['fra.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'politics', 'society'],
    localTerms: ['France', 'Paris', 'Ligue 1', 'PSG', 'Marseille', 'Macron', 'ECB'],
  },
  de: {
    serverKey: 'EU-Frankfurt',
    locale: 'de-DE',
    leagueKeys: ['ger.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'technology', 'politics'],
    localTerms: ['Germany', 'Berlin', 'Bundesliga', 'Bayern', 'Dortmund', 'ECB'],
  },
  gb: {
    serverKey: 'EU-London',
    locale: 'en-GB',
    leagueKeys: ['eng.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'politics', 'technology'],
    localTerms: ['United Kingdom', 'London', 'Premier League', 'Arsenal', 'Liverpool', 'Bank of England'],
  },
  es: {
    serverKey: 'EU-Madrid',
    locale: 'es-ES',
    leagueKeys: ['esp.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'politics', 'society'],
    localTerms: ['Spain', 'Madrid', 'LaLiga', 'Barcelona', 'Real Madrid', 'ECB'],
  },
  it: {
    serverKey: 'EU-Milan',
    locale: 'it-IT',
    leagueKeys: ['ita.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'politics', 'society'],
    localTerms: ['Italy', 'Milan', 'Serie A', 'Inter', 'Juventus', 'ECB'],
  },
  be: {
    serverKey: 'EU-Brussels',
    locale: 'fr-BE',
    leagueKeys: ['bel.1', 'uefa.champions', 'uefa.europa.conf'],
    newsCategories: ['sports', 'politics', 'economy', 'society'],
    localTerms: ['Belgium', 'Brussels', 'Pro League', 'Anderlecht', 'EU'],
  },
  ch: {
    serverKey: 'EU-Zurich',
    locale: 'de-CH',
    leagueKeys: ['sui.1', 'uefa.champions', 'uefa.europa.conf'],
    newsCategories: ['sports', 'economy', 'society', 'technology'],
    localTerms: ['Switzerland', 'Zurich', 'Swiss', 'UEFA', 'SNB'],
  },
  nl: {
    serverKey: 'EU-Amsterdam',
    locale: 'nl-NL',
    leagueKeys: ['ned.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'technology', 'economy', 'society'],
    localTerms: ['Netherlands', 'Amsterdam', 'Eredivisie', 'Ajax', 'PSV', 'ECB'],
  },
  pt: {
    serverKey: 'EU-Lisbon',
    locale: 'pt-PT',
    leagueKeys: ['por.1', 'uefa.champions', 'uefa.europa'],
    newsCategories: ['sports', 'economy', 'society', 'politics'],
    localTerms: ['Portugal', 'Lisbon', 'Primeira Liga', 'Benfica', 'Porto', 'ECB'],
  },
  pl: {
    serverKey: 'EU-Warsaw',
    locale: 'pl-PL',
    leagueKeys: ['pol.1', 'uefa.europa', 'uefa.europa.conf'],
    newsCategories: ['sports', 'politics', 'economy', 'society'],
    localTerms: ['Poland', 'Warsaw', 'Ekstraklasa', 'Legia', 'UEFA'],
  },
  se: {
    serverKey: 'EU-Stockholm',
    locale: 'sv-SE',
    leagueKeys: ['swe.1', 'uefa.europa.conf', 'fifa.world'],
    newsCategories: ['sports', 'technology', 'society', 'economy'],
    localTerms: ['Sweden', 'Stockholm', 'Allsvenskan', 'Malmo', 'UEFA'],
  },
  at: {
    serverKey: 'EU-Vienna',
    locale: 'de-AT',
    leagueKeys: ['aut.1', 'uefa.europa.conf', 'fifa.world'],
    newsCategories: ['sports', 'economy', 'politics', 'society'],
    localTerms: ['Austria', 'Vienna', 'Bundesliga Austria', 'Salzburg', 'UEFA'],
  },
  us: {
    serverKey: 'US-East',
    locale: 'en-US',
    leagueKeys: ['nfl', 'nba', 'mlb'],
    newsCategories: ['sports', 'economy', 'politics', 'technology'],
    localTerms: ['United States', 'NFL', 'NBA', 'MLB', 'Fed', 'Wall Street'],
  },
};

const CRYPTO_MARKET_SPECS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'ripple', symbol: 'XRP', name: 'XRP' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink' },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche' },
  { id: 'tron', symbol: 'TRX', name: 'TRON' },
  { id: 'aptos', symbol: 'APT', name: 'Aptos' },
  { id: 'sui', symbol: 'SUI', name: 'Sui' },
];

let espnCache = {
  generatedAt: 0,
  feeds: {},
  errors: [],
};

let coinGeckoCache = {
  generatedAt: 0,
  assets: [],
  errors: [],
};

function nowMs() {
  return Date.now();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value) {
  try {
    return new URL(String(value || '').trim()).toString();
  } catch (_) {
    return '';
  }
}

function fetchWithRetry(url, options, retries = MAX_FETCH_RETRIES) {
  let attempt = 0;

  const execute = async () => {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt >= retries) throw error;
      attempt += 1;
      await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
      return execute();
    }
  };

  return execute();
}

function formatDateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function estimateEventDurationMs(sport) {
  switch (sport) {
    case 'football':
      return 3.5 * 60 * 60 * 1000;
    case 'basketball':
      return 2.75 * 60 * 60 * 1000;
    case 'baseball':
      return 3.25 * 60 * 60 * 1000;
    case 'soccer':
    default:
      return 2.25 * 60 * 60 * 1000;
  }
}

function normalizeEspnCompetitor(raw) {
  const team = raw?.team || {};
  const logos = Array.isArray(team.logos) ? team.logos : [];
  return {
    id: normalizeText(raw?.id || team.id || team.uid),
    name: normalizeText(team.displayName || team.shortDisplayName || raw?.displayName),
    shortName: normalizeText(team.shortDisplayName || team.displayName || raw?.shortDisplayName),
    abbreviation: normalizeText(team.abbreviation || raw?.abbreviation),
    homeAway: normalizeText(raw?.homeAway).toLowerCase(),
    score: Math.max(0, Number(raw?.score) || 0),
    winner: Boolean(raw?.winner),
    logo: normalizeText(logos[0]?.href || raw?.logo),
  };
}

function pickEspnEventUrl(raw, competition) {
  const linkCandidates = []
    .concat(Array.isArray(raw?.links) ? raw.links : [])
    .concat(Array.isArray(competition?.links) ? competition.links : []);

  const gamecastLink = linkCandidates.find(link =>
    /gamecast|summary|boxscore|recap/i.test(String(link?.rel || '')) ||
    /espn\.com/i.test(String(link?.href || ''))
  );

  return normalizeText(gamecastLink?.href);
}

function normalizeEspnEvent(spec, raw) {
  const competition = Array.isArray(raw?.competitions) ? raw.competitions[0] : {};
  const competitors = Array.isArray(competition?.competitors)
    ? competition.competitors.map(normalizeEspnCompetitor).filter(item => item.name)
    : [];

  if (competitors.length < 2) {
    return null;
  }

  const home = competitors.find(item => item.homeAway === 'home') || competitors[0];
  const away = competitors.find(item => item.homeAway === 'away') || competitors[1];
  const status = competition?.status || raw?.status || {};
  const statusType = status?.type || {};
  const dateString = normalizeText(competition?.date || raw?.date);
  const startTimestamp = Date.parse(dateString);
  const startTime = Number.isFinite(startTimestamp) ? new Date(startTimestamp).toISOString() : null;
  const eventUrl = pickEspnEventUrl(raw, competition);
  const videoUrl = normalizeText(raw?.videos?.[0]?.links?.web?.href || raw?.videos?.[0]?.links?.mobile?.source?.href);
  const state = normalizeText(statusType?.state || (statusType?.completed ? 'post' : 'pre')).toLowerCase() || 'pre';
  const endEstimate = Number.isFinite(startTimestamp)
    ? new Date(startTimestamp + estimateEventDurationMs(spec.sport)).toISOString()
    : null;

  return {
    provider: 'espn',
    providerMode: 'espn_public',
    sourceType: 'sports',
    sport: spec.sport,
    league: spec.league,
    leagueLabel: spec.label,
    eventId: normalizeText(raw?.id),
    shortName: normalizeText(raw?.shortName || raw?.name || `${home.shortName} vs ${away.shortName}`),
    title: normalizeText(raw?.name || `${home.name} vs ${away.name}`),
    state,
    completed: Boolean(statusType?.completed),
    statusDetail: normalizeText(status?.type?.detail || status?.displayClock || ''),
    displayClock: normalizeText(status?.displayClock || ''),
    period: Math.max(0, Number(status?.period) || 0),
    startTime,
    endEstimate,
    sourceUpdatedAt: new Date().toISOString(),
    sourceUrl: eventUrl,
    proofUrl: eventUrl,
    proofVideoUrl: videoUrl,
    home,
    away,
    competitors,
    totalScore: home.score + away.score,
    sourceCountry: normalizeText(spec.regionParam || ''),
  };
}

function buildEspnScoreboardUrl(spec, dateKey) {
  const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${spec.sport}/${spec.league}/scoreboard`);
  url.searchParams.set('lang', 'en');
  url.searchParams.set('region', spec.regionParam || 'us');
  url.searchParams.set('dates', dateKey);
  url.searchParams.set('limit', '60');
  return url.toString();
}

async function fetchEspnLeague(spec, dateKeys) {
  const events = [];
  const errors = [];

  for (const dateKey of dateKeys) {
    const url = buildEspnScoreboardUrl(spec, dateKey);
    try {
      const response = await fetchWithRetry(url, {
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

      const payload = await response.json();
      const rawEvents = Array.isArray(payload?.events) ? payload.events : [];
      rawEvents.forEach(raw => {
        const normalized = normalizeEspnEvent(spec, raw);
        if (normalized) events.push(normalized);
      });
    } catch (error) {
      errors.push({ provider: 'espn', league: spec.key, dateKey, message: error.message });
    }
  }

  const dedupe = new Map();
  events.forEach(event => {
    if (!event?.eventId) return;
    dedupe.set(String(event.eventId), event);
  });

  return {
    leagueKey: spec.key,
    events: [...dedupe.values()],
    errors,
  };
}

function buildDateKeys() {
  const now = new Date();
  const keys = new Set();
  keys.add(formatDateKey(now));
  keys.add(formatDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000)));
  return [...keys];
}

function normalizeCoinGeckoAsset(raw) {
  const id = normalizeText(raw?.id);
  const sourceUrl = id ? `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}` : '';
  const currentPrice = Number(raw?.current_price);
  if (!id || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return null;
  }

  return {
    provider: 'coingecko',
    providerMode: 'coingecko_public',
    sourceType: 'crypto',
    id,
    symbol: normalizeText(raw?.symbol || '').toUpperCase(),
    name: normalizeText(raw?.name || id),
    currentPrice,
    high24h: Number.isFinite(Number(raw?.high_24h)) ? Number(raw.high_24h) : null,
    low24h: Number.isFinite(Number(raw?.low_24h)) ? Number(raw.low_24h) : null,
    priceChange1h: Number.isFinite(Number(raw?.price_change_percentage_1h_in_currency))
      ? Number(raw.price_change_percentage_1h_in_currency)
      : null,
    priceChange24h: Number.isFinite(Number(raw?.price_change_percentage_24h_in_currency))
      ? Number(raw.price_change_percentage_24h_in_currency)
      : null,
    marketCapRank: Number.isFinite(Number(raw?.market_cap_rank)) ? Number(raw.market_cap_rank) : null,
    imageUrl: normalizeUrl(raw?.image),
    sourceUrl,
    proofUrl: sourceUrl,
    apiUrl: `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(id)}`,
    updatedAt: normalizeText(raw?.last_updated) || new Date().toISOString(),
  };
}

async function fetchCoinGeckoMarketUniverse() {
  if (nowMs() - coinGeckoCache.generatedAt < COINGECKO_CACHE_MS && Array.isArray(coinGeckoCache.assets) && coinGeckoCache.assets.length) {
    return coinGeckoCache;
  }

  const ids = CRYPTO_MARKET_SPECS.map(asset => asset.id).join(',');
  const url = new URL('https://api.coingecko.com/api/v3/coins/markets');
  url.searchParams.set('vs_currency', 'usd');
  url.searchParams.set('ids', ids);
  url.searchParams.set('order', 'market_cap_desc');
  url.searchParams.set('per_page', String(CRYPTO_MARKET_SPECS.length));
  url.searchParams.set('page', '1');
  url.searchParams.set('sparkline', 'false');
  url.searchParams.set('price_change_percentage', '1h,24h');

  const errors = [];
  let assets = [];

  try {
    const response = await fetchWithRetry(url.toString(), {
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

    const payload = await response.json();
    assets = (Array.isArray(payload) ? payload : [])
      .map(normalizeCoinGeckoAsset)
      .filter(Boolean)
      .sort((left, right) => {
        const leftRank = Number.isFinite(left.marketCapRank) ? left.marketCapRank : Number.MAX_SAFE_INTEGER;
        const rightRank = Number.isFinite(right.marketCapRank) ? right.marketCapRank : Number.MAX_SAFE_INTEGER;
        return leftRank - rightRank;
      });
  } catch (error) {
    errors.push({
      provider: 'coingecko',
      message: error.message || 'Unknown CoinGecko fetch failure',
    });
  }

  coinGeckoCache = {
    generatedAt: nowMs(),
    assets,
    errors,
  };

  return coinGeckoCache;
}

async function fetchEspnSportsUniverse() {
  if (nowMs() - espnCache.generatedAt < ESPN_CACHE_MS && Object.keys(espnCache.feeds).length) {
    return espnCache;
  }

  const dateKeys = buildDateKeys();
  const uniqueSpecs = [...new Set(Object.values(REGION_CONTEXTS).flatMap(ctx => ctx.leagueKeys))]
    .map(key => LEAGUE_SPECS[key])
    .filter(Boolean);

  const settled = await Promise.allSettled(uniqueSpecs.map(spec => fetchEspnLeague(spec, dateKeys)));
  const feeds = {};
  const errors = [];

  settled.forEach((result, index) => {
    const spec = uniqueSpecs[index];
    if (result.status === 'fulfilled') {
      feeds[spec.key] = result.value.events;
      if (result.value.errors.length) {
        errors.push(...result.value.errors);
      }
      return;
    }
    errors.push({
      provider: 'espn',
      league: spec.key,
      message: result.reason?.message || 'Unknown ESPN fetch failure',
    });
  });

  espnCache = {
    generatedAt: nowMs(),
    feeds,
    errors,
  };

  return espnCache;
}

function isEventActionable(event, now = nowMs()) {
  if (!event || !event.startTime) return false;
  if (event.completed || event.state === 'post') return false;

  const startMs = Date.parse(event.startTime);
  const endMs = Date.parse(event.endEstimate || 0);
  if (!Number.isFinite(startMs)) return false;
  if (Number.isFinite(endMs) && (endMs <= now || endMs - now > MAX_ACTIVE_HORIZON_MS)) return false;
  if (event.state === 'in') return true;

  const lookaheadMs = startMs - now;
  return lookaheadMs >= 0 && lookaheadMs <= MAX_EVENT_LOOKAHEAD_MS;
}

function scoreEventForRegion(event, regionConfig) {
  let score = 0;
  if (!event) return score;
  if (event.state === 'in') score += 8;
  if (event.league && regionConfig.leagueKeys.includes(event.league)) score += 6;
  if (regionConfig.localTerms.some(term => event.title.toLowerCase().includes(term.toLowerCase()))) score += 4;
  if (event.league === regionConfig.leagueKeys[0]) score += 5;
  if (event.sport === 'soccer') score += 2;
  return score;
}

function getRegionSportsContext(region, sportsUniverse) {
  const config = REGION_CONTEXTS[region] || REGION_CONTEXTS.fr;
  const events = [];
  const now = nowMs();

  config.leagueKeys.forEach(leagueKey => {
    const feed = Array.isArray(sportsUniverse?.feeds?.[leagueKey]) ? sportsUniverse.feeds[leagueKey] : [];
    feed.forEach(event => {
      if (!isEventActionable(event, now)) return;
      events.push({
        ...event,
        region,
        serverKey: config.serverKey,
        localRelevanceScore: scoreEventForRegion(event, config),
      });
    });
  });

  const dedupe = new Map();
  events
    .sort((left, right) => {
      if (right.localRelevanceScore !== left.localRelevanceScore) {
        return right.localRelevanceScore - left.localRelevanceScore;
      }
      return Date.parse(left.startTime || 0) - Date.parse(right.startTime || 0);
    })
    .forEach(event => {
      const key = `${event.league}:${event.eventId}`;
      if (!dedupe.has(key)) dedupe.set(key, event);
    });

  return [...dedupe.values()];
}

function getRegionCryptoContext(region, cryptoUniverse) {
  const config = REGION_CONTEXTS[region] || REGION_CONTEXTS.fr;
  const assets = Array.isArray(cryptoUniverse?.assets) ? cryptoUniverse.assets : [];
  return assets.slice(0, CRYPTO_MARKET_SPECS.length).map(asset => ({
    ...asset,
    region,
    serverKey: config.serverKey,
    sourceCountry: region,
  }));
}

function scoreNewsItemForRegion(item, region) {
  const config = REGION_CONTEXTS[region] || REGION_CONTEXTS.fr;
  let score = Number(item?.score || 0);
  const text = `${item?.sourceTitle || ''} ${item?.sourceDescription || ''}`.toLowerCase();

  if (config.newsCategories.includes(String(item?.category || '').toLowerCase())) score += 4;
  if (config.localTerms.some(term => text.includes(term.toLowerCase()))) score += 3;
  if (String(item?.language || '').toLowerCase().includes(config.locale.slice(0, 2).toLowerCase())) score += 2;
  if (item?.sourceCountry && config.localTerms.some(term => String(item.sourceCountry).toLowerCase().includes(term.toLowerCase()))) score += 2;

  return score;
}

async function fetchPredictionInputsByRegion() {
  const [sportsUniverse, cryptoUniverse, latestNews] = await Promise.all([
    fetchEspnSportsUniverse(),
    fetchCoinGeckoMarketUniverse(),
    fetchLatestNews(),
  ]);

  const byRegion = {};

  Object.keys(REGION_CONTEXTS).forEach(region => {
    const sportsEvents = getRegionSportsContext(region, sportsUniverse);
    const cryptoAssets = getRegionCryptoContext(region, cryptoUniverse);
    // Keep only event-driven articles (scoreEventSignal >= 2) so debates focus on
    // real upcoming events (matches, meetings, summits, earnings, verdicts…)
    const eventThreshold = Number(process.env.NEWS_EVENT_SIGNAL_THRESHOLD) || 2;
    const newsItems = (Array.isArray(latestNews?.items) ? latestNews.items : [])
      .filter(item => scoreEventSignal(item) >= eventThreshold)
      .map(item => ({ ...item, regionalScore: scoreNewsItemForRegion(item, region) }))
      .sort((left, right) => right.regionalScore - left.regionalScore)
      .slice(0, 24);

    byRegion[region] = {
      region,
      serverKey: REGION_CONTEXTS[region].serverKey,
      sportsEvents,
      cryptoAssets,
      newsItems,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    providerMode: 'espn_coingecko_strict_events',
    byRegion,
    errors: []
      .concat(Array.isArray(sportsUniverse?.errors) ? sportsUniverse.errors : [])
      .concat(Array.isArray(cryptoUniverse?.errors) ? cryptoUniverse.errors : [])
      .concat(Array.isArray(latestNews?.errors) ? latestNews.errors : []),
  };
}

module.exports = {
  LEAGUE_SPECS,
  REGION_CONTEXTS,
  fetchPredictionInputsByRegion,
  fetchLatestNews,
};
