'use strict';

const crypto = require('crypto');
const { fingerprintTitle, hasUsablePreviewImage } = require('./news-filter');
const { resolveThematicImage } = require('./image-fallbacks');
const { REGION_CONTEXTS } = require('./prediction-sources');

const MIN_PREDICTION_DURATION_MS = 25 * 60 * 1000;
const MAX_PREDICTION_DURATION_MS = 8 * 60 * 60 * 1000;
const MAX_CREATION_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000; // match prediction-sources 7-day window
const DEFAULT_PREDICTION_DURATION_MS = Math.max(
  MIN_PREDICTION_DURATION_MS,
  Math.min(MAX_PREDICTION_DURATION_MS, Number(process.env.PREDICTION_DEFAULT_DURATION_MS) || 2 * 60 * 60 * 1000)
);

const SPORT_FALLBACK_IMAGES = {
  soccer: 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=1200&q=80&auto=format&fit=crop',
  football: 'https://images.unsplash.com/photo-1508098682722-e99c643e7485?w=1200&q=80&auto=format&fit=crop',
  basketball: 'https://images.unsplash.com/photo-1546519638-68e109498ffc?w=1200&q=80&auto=format&fit=crop',
  baseball: 'https://images.unsplash.com/photo-1508344928928-7165b67de128?w=1200&q=80&auto=format&fit=crop',
  general: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=1200&q=80&auto=format&fit=crop',
};

const CATEGORY_STYLES = {
  sports: ['#2563eb', '#1d4ed8', '#0f172a'],
  economy: ['#10b981', '#059669', '#052e16'],
  politics: ['#f97316', '#ea580c', '#431407'],
  technology: ['#8b5cf6', '#6366f1', '#1e1b4b'],
  society: ['#ec4899', '#db2777', '#3b0764'],
  general: ['#f97316', '#fb923c', '#431407'],
};

const NEWS_ACTION_RULES = [
  {
    key: 'approval',
    when: /\b(approve|approval|vote|voting|pass|passes|sign|signing|deal|agreement)\b/i,
    question: subject => `Will ${subject} secure approval today?`,
    positiveTerms: ['approved', 'passes', 'passed', 'signed', 'agreement reached', 'deal reached', 'vote passes'],
    negativeTerms: ['rejected', 'blocked', 'fails', 'failed', 'delayed', 'postponed'],
  },
  {
    key: 'announcement',
    when: /\b(announce|announcement|launch|launches|unveil|unveils|reveal|reveals|earnings)\b/i,
    question: subject => `Will ${subject} confirm the move today?`,
    positiveTerms: ['announces', 'announced', 'launches', 'launched', 'unveils', 'unveiled', 'reports earnings', 'beats expectations'],
    negativeTerms: ['delays', 'delayed', 'postpones', 'postponed', 'misses expectations', 'scraps'],
  },
  {
    key: 'rates',
    when: /\b(rate|rates|cut|cuts|raise|raises|meeting|decision)\b/i,
    question: subject => `Will ${subject} make the decision today?`,
    positiveTerms: ['cuts rates', 'raises rates', 'announces decision', 'confirms move', 'approves cut', 'rate decision'],
    negativeTerms: ['holds rates', 'delays decision', 'rules out', 'no decision'],
  },
];

function nowMs() {
  return Date.now();
}

function nowIso(input = nowMs()) {
  return new Date(input).toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundNumber(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || 0);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatUsd(value) {
  const amount = Number(value) || 0;
  const digits = Math.abs(amount) >= 1000 ? 0 : Math.abs(amount) >= 10 ? 2 : 4;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(amount);
}

function formatUtcDeadline(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' UTC';
}

function isResolvableEventWindow({ startMs, endMs, status = '', now = nowMs() }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs <= now) {
    return false;
  }

  const normalizedStatus = normalizeText(status).toLowerCase();
  if (normalizedStatus === 'in' || normalizedStatus === 'live' || normalizedStatus === 'in_progress') {
    return endMs - now >= MIN_PREDICTION_DURATION_MS && endMs - now <= MAX_PREDICTION_DURATION_MS;
  }

  const lookaheadMs = startMs - now;
  if (lookaheadMs < 0 || lookaheadMs > MAX_CREATION_LOOKAHEAD_MS) {
    return false;
  }

  return endMs - now >= MIN_PREDICTION_DURATION_MS && endMs - now <= MAX_PREDICTION_DURATION_MS;
}

function hashSeed(seed) {
  const hash = crypto.createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 8);
  return parseInt(hash, 16);
}

function seededRange(seed, min, max) {
  const numeric = hashSeed(seed);
  return min + (numeric % (max - min + 1));
}

function resolvePredictionDurationMs(options = {}) {
  const explicit = Number(options.explicitDurationMs || options.durationMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return clamp(explicit, MIN_PREDICTION_DURATION_MS, MAX_PREDICTION_DURATION_MS);
  }

  const now = nowMs();
  const expectedEndsAt = Date.parse(options.expectedEndsAt || 0);
  if (Number.isFinite(expectedEndsAt) && expectedEndsAt > now) {
    return clamp(expectedEndsAt - now, MIN_PREDICTION_DURATION_MS, MAX_PREDICTION_DURATION_MS);
  }

  return DEFAULT_PREDICTION_DURATION_MS;
}

function resolvePreviewImage({ sourceImageUrl, sport, category }) {
  if (hasUsablePreviewImage(sourceImageUrl)) {
    return sourceImageUrl;
  }

  return SPORT_FALLBACK_IMAGES[sport] || SPORT_FALLBACK_IMAGES[category] || SPORT_FALLBACK_IMAGES.general;
}

async function resolvePreviewImageAsset({ sourceImageUrl, title, sport, category, teams = [] }) {
  const fallbackImageUrl = resolvePreviewImage({ sourceImageUrl, sport, category });
  return resolveThematicImage({
    sourceImageUrl,
    title,
    sport,
    category,
    teams,
    fallbackImageUrl,
  });
}

function toSearchEmbed(query) {
  const safe = normalizeText(query).slice(0, 140);
  if (!safe) return '';
  return `https://www.youtube.com/embed?autoplay=1&mute=1&playsinline=1&controls=0&modestbranding=1&rel=0&listType=search&list=${encodeURIComponent(safe)}`;
}

function buildSportsContextVideoUrl(event) {
  const query = [
    event.home?.name,
    'vs',
    event.away?.name,
    event.leagueLabel || event.league,
    event.state === 'in' ? 'live analysis highlights' : 'match preview analysis',
  ].filter(Boolean).join(' ');
  return event.proofVideoUrl || toSearchEmbed(query);
}

function buildNewsContextVideoUrl(item) {
  const query = [
    item.sourceTitle,
    item.category !== 'general' ? item.category : '',
    'news analysis explained',
  ].filter(Boolean).join(' ');
  return toSearchEmbed(query);
}

function buildBasePrediction(seed, region, category, title, description, options = {}) {
  const yesPct = seededRange(`${seed}:yesPct`, 42, 58);
  const pool = seededRange(`${seed}:pool`, 45, 180) * 1000;
  const viewers = seededRange(`${seed}:viewers`, 550, 4800);
  const durationMs = resolvePredictionDurationMs({
    explicitDurationMs: options.durationMs,
    expectedEndsAt: options.endsAt,
  });
  const openedAt = nowMs();
  const endsAt = Number.isFinite(Number(options.endsAt))
    ? Math.min(Number(options.endsAt), openedAt + MAX_PREDICTION_DURATION_MS)
    : openedAt + durationMs;

  return {
    region,
    category,
    title,
    description,
    yesLabel: 'YES',
    noLabel: 'NO',
    yesPct,
    pool,
    viewers,
    gradColors: CATEGORY_STYLES[category] || CATEGORY_STYLES.general,
    lang: 'en',
    durationMs: clamp(endsAt - openedAt, MIN_PREDICTION_DURATION_MS, MAX_PREDICTION_DURATION_MS),
    openedAt,
    endsAt,
    listed: options.listed !== false,
    predictionType: options.predictionType || 'action_prediction',
    predictionKey: options.predictionKey || `${region}:${seed}`,
    predictionSourceType: options.predictionSourceType || 'sports',
    predictionRegionServer: REGION_CONTEXTS[region]?.serverKey || region,
    eventTitle: normalizeText(options.eventTitle || title),
    eventStartsAt: normalizeText(options.eventStartsAt),
    eventEndsAt: normalizeText(options.eventEndsAt || (Number.isFinite(Number(endsAt)) ? nowIso(endsAt) : '')),
    eventStatus: normalizeText(options.eventStatus || 'scheduled'),
    verificationProvider: normalizeText(options.verificationProvider || options.predictionSourceType || 'source'),
    verificationSource: options.verificationSource && typeof options.verificationSource === 'object'
      ? options.verificationSource
      : null,
    resolutionMethod: normalizeText(options.resolutionMethod || 'api_validation'),
    validationState: 'pending',
    validationEvidence: null,
    proofVideoUrl: normalizeText(options.proofVideoUrl),
    createdFromNews: Boolean(options.createdFromNews),
    createdFromLive: false,
  };
}

async function buildSportsPredictionDrafts(event, region, options = {}) {
  if (!event?.eventId || !event?.home?.name || !event?.away?.name) return [];
  const startMs = parseTimestamp(event.startTime);
  const endMs = parseTimestamp(event.endEstimate);
  if (!isResolvableEventWindow({ startMs, endMs, status: event.state })) return [];

  const category = 'sports';
  const imageAsset = await resolvePreviewImageAsset({
    sourceImageUrl: event.home?.logo || event.away?.logo,
    title: event.title || event.shortName,
    sport: event.sport,
    category,
    teams: [event.home?.name, event.away?.name],
  });
  const previewImageUrl = imageAsset.url;
  const contextVideoUrl = buildSportsContextVideoUrl(event);
  const drafts = [];
  const home = event.home;
  const away = event.away;
  const totalScore = Number(event.totalScore || (home.score + away.score) || 0);
  const baseMeta = {
    photo: previewImageUrl,
    sourceImageUrl: previewImageUrl,
    previewVideoUrl: contextVideoUrl,
    contextVideoUrl,
    sourceUrl: event.sourceUrl,
    sourceTitle: event.title || event.shortName,
    sourceExcerpt: `${event.leagueLabel} • ${home.shortName || home.name} vs ${away.shortName || away.name}`,
    sourceDescription: `${event.leagueLabel} • ${normalizeText(event.statusDetail || (event.state === 'in' ? 'Match in progress' : 'Upcoming fixture'))}`,
    sourceFeedLabel: event.leagueLabel,
    sourceDomain: 'espn.com',
    sourceKey: `espn:${event.league}:${event.eventId}`,
    createdFromNews: false,
    trending: event.state === 'in',
    ai: false,
    proofVideoUrl: contextVideoUrl,
    predictionSourceType: 'sports',
  };

  function pushDraft(marketKey, title, description, actionRule, endsAt, listed = true) {
    const seed = `${region}:${event.eventId}:${marketKey}`;
    drafts.push({
      ...buildBasePrediction(seed, region, category, title, description, {
        listed,
        endsAt,
        predictionKey: seed,
        predictionType: 'sports_action',
        predictionSourceType: 'sports',
        proofVideoUrl: contextVideoUrl,
        eventTitle: event.title || event.shortName,
        eventStartsAt: event.startTime,
        eventEndsAt: nowIso(endsAt),
        eventStatus: event.state === 'in' ? 'live' : 'scheduled',
        verificationProvider: 'espn',
        verificationSource: {
          provider: 'espn',
          type: 'sports_api',
          label: event.leagueLabel,
          url: event.proofUrl || event.sourceUrl,
          eventId: event.eventId,
        },
        resolutionMethod: 'official_scoreboard_api',
      }),
      ...baseMeta,
      actionRule,
    });
  }

  const expectedEndsAtMs = Date.parse(event.endEstimate || 0);
  const safeEndsAt = Number.isFinite(expectedEndsAtMs) ? expectedEndsAtMs : nowMs() + DEFAULT_PREDICTION_DURATION_MS;
  const threshold = event.sport === 'soccer'
    ? Math.max(2, totalScore + (event.state === 'in' ? 1 : 2))
    : totalScore + (event.sport === 'football' ? 10 : event.sport === 'basketball' ? 18 : 2);

  pushDraft(
    'home_win',
    `Will ${home.shortName || home.name} win against ${away.shortName || away.name}?`,
    `${event.leagueLabel} • outcome market backed by the official scoreboard feed.`,
    {
      kind: 'sports',
      provider: event.provider,
      providerMode: event.providerMode,
      market: 'winner_home',
      sport: event.sport,
      league: event.league,
      eventId: event.eventId,
      homeTeamId: home.id,
      awayTeamId: away.id,
      homeName: home.name,
      awayName: away.name,
      proofUrl: event.proofUrl || event.sourceUrl,
      proofVideoUrl: contextVideoUrl,
    },
    safeEndsAt,
  );

  pushDraft(
    `total_over_${threshold}`,
    event.sport === 'soccer'
      ? `Will ${home.shortName || home.name} vs ${away.shortName || away.name} reach ${threshold} total goals?`
      : `Will ${home.shortName || home.name} vs ${away.shortName || away.name} reach ${threshold} total points?`,
    `${event.leagueLabel} • resolved directly from the official live score.`,
    {
      kind: 'sports',
      provider: event.provider,
      providerMode: event.providerMode,
      market: 'total_over',
      sport: event.sport,
      league: event.league,
      eventId: event.eventId,
      threshold,
      proofUrl: event.proofUrl || event.sourceUrl,
      proofVideoUrl: contextVideoUrl,
    },
    safeEndsAt,
  );

  pushDraft(
    'both_score',
    event.sport === 'soccer'
      ? `Will both teams score in ${home.shortName || home.name} vs ${away.shortName || away.name}?`
      : `Will both sides score again in ${home.shortName || home.name} vs ${away.shortName || away.name}?`,
    `${event.leagueLabel} • validated against the same official event feed.`,
    {
      kind: 'sports',
      provider: event.provider,
      providerMode: event.providerMode,
      market: 'both_teams_score',
      sport: event.sport,
      league: event.league,
      eventId: event.eventId,
      proofUrl: event.proofUrl || event.sourceUrl,
      proofVideoUrl: contextVideoUrl,
    },
    safeEndsAt,
  );

  if (event.state === 'in') {
    const moreScoreEndsAt = Math.min(safeEndsAt, nowMs() + Math.max(MIN_PREDICTION_DURATION_MS, 90 * 60 * 1000));
    pushDraft(
      `any_more_score_${totalScore}`,
      event.sport === 'soccer'
        ? `Will there be another goal in ${home.shortName || home.name} vs ${away.shortName || away.name}?`
        : `Will there be more scoring in ${home.shortName || home.name} vs ${away.shortName || away.name}?`,
      `${event.leagueLabel} • settles as soon as the next scoring action is confirmed.`,
      {
        kind: 'sports',
        provider: event.provider,
        providerMode: event.providerMode,
        market: 'any_more_score',
        sport: event.sport,
        league: event.league,
        eventId: event.eventId,
        initialTotal: totalScore,
        proofUrl: event.proofUrl || event.sourceUrl,
        proofVideoUrl: contextVideoUrl,
      },
      moreScoreEndsAt,
    );

    if (home.score !== away.score) {
      const leaderSide = home.score > away.score ? 'home' : 'away';
      const trailingSide = leaderSide === 'home' ? 'away' : 'home';
      const leaderTeam = leaderSide === 'home' ? home : away;
      const trailingTeam = trailingSide === 'home' ? home : away;
      const scorelineKey = `${home.score}_${away.score}`;

      pushDraft(
        `leader_hold_${leaderSide}_${scorelineKey}`,
        `Will ${leaderTeam.shortName || leaderTeam.name} hold the lead?`,
        `${event.leagueLabel} • settles the instant the scoreboard no longer shows that lead.`,
        {
          kind: 'sports',
          provider: event.provider,
          providerMode: event.providerMode,
          market: 'leader_holds',
          sport: event.sport,
          league: event.league,
          eventId: event.eventId,
          leaderSide,
          proofUrl: event.proofUrl || event.sourceUrl,
          proofVideoUrl: contextVideoUrl,
        },
        safeEndsAt,
      );

      pushDraft(
        `trailing_equalizes_${trailingSide}_${scorelineKey}`,
        `Will ${trailingTeam.shortName || trailingTeam.name} erase the deficit?`,
        `${event.leagueLabel} • a YES settles as soon as the trailing side draws level or goes ahead.`,
        {
          kind: 'sports',
          provider: event.provider,
          providerMode: event.providerMode,
          market: 'trailing_team_equalizes',
          sport: event.sport,
          league: event.league,
          eventId: event.eventId,
          trailingSide,
          proofUrl: event.proofUrl || event.sourceUrl,
          proofVideoUrl: contextVideoUrl,
        },
        safeEndsAt,
      );
    }
  }

  return drafts.slice(0, Math.max(1, Number(options.maxMarkets) || 5));
}

function roundPriceTarget(value) {
  const amount = Number(value) || 0;
  if (amount >= 50000) return Math.round(amount / 500) * 500;
  if (amount >= 10000) return Math.round(amount / 100) * 100;
  if (amount >= 1000) return Math.round(amount / 25) * 25;
  if (amount >= 100) return Math.round(amount);
  if (amount >= 10) return roundNumber(amount, 1);
  return roundNumber(amount, 2);
}

async function buildCryptoPredictionDrafts(asset, region, options = {}) {
  const currentPrice = Number(asset?.currentPrice);
  if (!asset?.id || !asset?.symbol || !Number.isFinite(currentPrice) || currentPrice <= 0) return [];

  const now = nowMs();
  const absoluteMove = Math.max(
    0.6,
    Math.abs(Number(asset?.priceChange1h || 0)),
    Math.abs(Number(asset?.priceChange24h || 0)) / 8
  );
  const durationMs = clamp(
    Math.round((90 + absoluteMove * 18) * 60 * 1000),
    90 * 60 * 1000,
    4 * 60 * 60 * 1000
  );
  const endsAt = now + durationMs;
  if (!isResolvableEventWindow({ startMs: now, endMs: endsAt, status: 'live', now })) return [];

  const imageAsset = await resolvePreviewImageAsset({
    sourceImageUrl: asset.imageUrl,
    title: `${asset.name} ${asset.symbol}`,
    sport: 'general',
    category: 'crypto',
    teams: [asset.name, asset.symbol],
  });
  const previewImageUrl = imageAsset.url;
  const symbol = String(asset.symbol).toUpperCase();
  const deadlineLabel = formatUtcDeadline(endsAt);
  const upMovePct = clamp(absoluteMove * 0.8 + 0.8, 0.8, 4.5);
  const downMovePct = clamp(absoluteMove * 0.7 + 0.7, 0.7, 4.0);
  const aboveTarget = Math.max(currentPrice + (currentPrice * 0.003), roundPriceTarget(currentPrice * (1 + upMovePct / 100)));
  const belowTarget = Math.min(currentPrice - (currentPrice * 0.003), roundPriceTarget(currentPrice * (1 - downMovePct / 100)));
  const excerptRange = [
    Number.isFinite(Number(asset.high24h)) ? `24h high ${formatUsd(asset.high24h)}` : '',
    Number.isFinite(Number(asset.low24h)) ? `24h low ${formatUsd(asset.low24h)}` : '',
  ].filter(Boolean).join(' • ');

  const baseMeta = {
    photo: previewImageUrl,
    sourceImageUrl: previewImageUrl,
    previewVideoUrl: '',
    contextVideoUrl: '',
    sourceVideoUrl: '',
    proofVideoUrl: '',
    sourceUrl: asset.sourceUrl,
    sourceTitle: `${asset.name} spot market (USD)`,
    sourceExcerpt: `${symbol} now ${formatUsd(currentPrice)}${excerptRange ? ` • ${excerptRange}` : ''}`,
    sourceDescription: `Live CoinGecko spot market for ${asset.name}. Current price ${formatUsd(currentPrice)}.`,
    sourceFeedLabel: 'CoinGecko',
    sourceDomain: 'coingecko.com',
    sourceKey: `coingecko:${asset.id}`,
    createdFromNews: false,
    trending: Math.abs(Number(asset?.priceChange1h || 0)) >= 1,
    ai: false,
    predictionSourceType: 'crypto',
  };

  const drafts = [];
  const markets = [
    {
      key: 'price_above',
      title: `Will ${symbol} trade above ${formatUsd(aboveTarget)} before ${deadlineLabel}?`,
      description: `${asset.name} spot price measured against the live CoinGecko USD feed.`,
      actionRule: {
        kind: 'crypto',
        provider: 'coingecko',
        providerMode: asset.providerMode || 'coingecko_public',
        market: 'price_above',
        assetId: asset.id,
        assetSymbol: symbol,
        quoteCurrency: 'usd',
        targetPrice: roundNumber(aboveTarget, 4),
        observedPrice: roundNumber(currentPrice, 4),
        proofUrl: asset.proofUrl || asset.sourceUrl,
        apiUrl: asset.apiUrl,
      },
    },
    {
      key: 'price_below',
      title: `Will ${symbol} trade below ${formatUsd(belowTarget)} before ${deadlineLabel}?`,
      description: `${asset.name} downside trigger resolved directly from the live CoinGecko USD feed.`,
      actionRule: {
        kind: 'crypto',
        provider: 'coingecko',
        providerMode: asset.providerMode || 'coingecko_public',
        market: 'price_below',
        assetId: asset.id,
        assetSymbol: symbol,
        quoteCurrency: 'usd',
        targetPrice: roundNumber(belowTarget, 4),
        observedPrice: roundNumber(currentPrice, 4),
        proofUrl: asset.proofUrl || asset.sourceUrl,
        apiUrl: asset.apiUrl,
      },
    },
  ];

  // Use a duration-aligned time bucket so each "round" of the debate gets a fresh
  // seed — title and endsAt are always generated together from the same `now`, so
  // they stay in sync.  Old debates expire naturally and the next bucket creates a
  // clean replacement.
  const durationBucket = Math.floor(now / durationMs);
  markets.forEach((market, index) => {
    const seed = `${region}:${asset.id}:${market.key}:${durationBucket}`;
    drafts.push({
      ...buildBasePrediction(seed, region, 'crypto', market.title, market.description, {
        predictionKey: seed,
        predictionType: 'crypto_price_action',
        predictionSourceType: 'crypto',
        durationMs,
        endsAt,
        eventTitle: `${asset.name} live USD market`,
        eventStartsAt: nowIso(now),
        eventEndsAt: nowIso(endsAt),
        eventStatus: 'live',
        verificationProvider: 'coingecko',
        verificationSource: {
          provider: 'coingecko',
          type: 'crypto_market_api',
          label: 'CoinGecko spot market',
          url: asset.proofUrl || asset.sourceUrl,
          assetId: asset.id,
        },
        resolutionMethod: 'crypto_price_api',
      }),
      ...baseMeta,
      order: index,
      actionRule: market.actionRule,
    });
  });

  return drafts;
}


// ─────────────────────────────────────────────────────────────────────────────
//  Stock market predictions — Yahoo Finance (CAC40, S&P500, DAX…)
// ─────────────────────────────────────────────────────────────────────────────
async function buildStockPredictionDrafts(asset, region, options = {}) {
  const currentPrice = Number(asset?.currentPrice);
  if (!asset?.symbol || !Number.isFinite(currentPrice) || currentPrice <= 0) return [];

  const now = nowMs();
  const durationMs = 6 * 60 * 60 * 1000; // 6h intraday window
  const endsAt = now + durationMs;

  const prevClose = Number(asset.previousClose) || currentPrice;
  const dailyChangePct = prevClose > 0 ? Math.abs((currentPrice - prevClose) / prevClose * 100) : 1;
  const moveTarget = Math.max(0.4, Math.min(2.5, dailyChangePct * 0.6 + 0.4));

  function fmtPrice(p) {
    if (p >= 10000) return p.toFixed(0);
    if (p >= 1000)  return p.toFixed(1);
    if (p >= 100)   return p.toFixed(2);
    return p.toFixed(3);
  }

  const aboveTarget = parseFloat((currentPrice * (1 + moveTarget / 100)).toFixed(currentPrice >= 1000 ? 0 : 2));
  const belowTarget = parseFloat((currentPrice * (1 - moveTarget / 100)).toFixed(currentPrice >= 1000 ? 0 : 2));
  const deadlineLabel = formatUtcDeadline(endsAt);
  const currency = asset.currency || 'USD';
  const changePct = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100).toFixed(2) : '0.00';
  const changeSign = currentPrice >= prevClose ? '+' : '';

  const imageAsset = await resolvePreviewImageAsset({
    sourceImageUrl: '',
    title: asset.name + ' stock market',
    sport: 'general',
    category: 'economy',
    teams: [asset.name],
  });

  const baseMeta = {
    photo: imageAsset.url,
    sourceImageUrl: imageAsset.url,
    previewVideoUrl: '',
    contextVideoUrl: '',
    sourceVideoUrl: '',
    proofVideoUrl: '',
    sourceUrl: asset.sourceUrl,
    sourceTitle: asset.name + ' (' + (asset.exchangeName || asset.symbol) + ')',
    sourceExcerpt: asset.name + ' at ' + fmtPrice(currentPrice) + ' ' + currency + ' (' + changeSign + changePct + '% today)',
    sourceDescription: asset.name + ' live data from Yahoo Finance. Current: ' + fmtPrice(currentPrice) + ' ' + currency + ', prev close: ' + fmtPrice(prevClose) + ' ' + currency + '.',
    sourceFeedLabel: 'Yahoo Finance',
    sourceDomain: 'finance.yahoo.com',
    sourceKey: 'yahoo:' + asset.symbol,
    createdFromNews: false,
    trending: Math.abs(Number(changePct)) >= 1.0,
    ai: false,
    predictionSourceType: 'stock',
  };

  const markets = [
    {
      key: 'price_above',
      title: 'Will ' + asset.name + ' exceed ' + fmtPrice(aboveTarget) + ' ' + currency + ' before ' + deadlineLabel + '?',
      description: asset.name + ' currently at ' + fmtPrice(currentPrice) + ' ' + currency + '. Resolved via Yahoo Finance live data.',
      actionRule: {
        kind: 'stock', provider: 'yahoo_finance', providerMode: 'yahoo_public',
        market: 'price_above', symbol: asset.symbol, assetName: asset.name, currency,
        targetPrice: aboveTarget, observedPrice: currentPrice,
        endsAt: new Date(endsAt).toISOString(), apiUrl: asset.apiUrl, proofUrl: asset.sourceUrl,
      },
    },
    {
      key: 'price_below',
      title: 'Will ' + asset.name + ' fall below ' + fmtPrice(belowTarget) + ' ' + currency + ' before ' + deadlineLabel + '?',
      description: asset.name + ' currently at ' + fmtPrice(currentPrice) + ' ' + currency + '. Resolved via Yahoo Finance live data.',
      actionRule: {
        kind: 'stock', provider: 'yahoo_finance', providerMode: 'yahoo_public',
        market: 'price_below', symbol: asset.symbol, assetName: asset.name, currency,
        targetPrice: belowTarget, observedPrice: currentPrice,
        endsAt: new Date(endsAt).toISOString(), apiUrl: asset.apiUrl, proofUrl: asset.sourceUrl,
      },
    },
  ];

  const hourBucket = Math.floor(now / (60 * 60 * 1000));
  const drafts = [];
  markets.forEach((market, index) => {
    const seed = region + ':' + asset.symbol + ':' + market.key + ':' + hourBucket;
    drafts.push({
      ...buildBasePrediction(seed, region, 'stock', market.title, market.description, {
        predictionKey: seed, predictionType: 'stock_price_action', predictionSourceType: 'stock',
        durationMs, endsAt,
        eventTitle: asset.name + ' market',
        eventStartsAt: nowIso(now), eventEndsAt: nowIso(endsAt), eventStatus: 'live',
        verificationProvider: 'yahoo_finance',
        verificationSource: { provider: 'yahoo_finance', type: 'stock_market_api', label: 'Yahoo Finance', url: asset.sourceUrl, symbol: asset.symbol },
        resolutionMethod: 'stock_price_api',
      }),
      ...baseMeta,
      order: index,
      actionRule: market.actionRule,
    });
  });
  return drafts;
}

function extractSubject(text) {
  const cleaned = normalizeText(text).replace(/\s+[|:-]\s+.*$/, '');
  const directMatch = cleaned.match(/^([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,4})/);
  if (directMatch) return normalizeText(directMatch[1]);

  const tokens = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return normalizeText(tokens.join(' '));
}

function chooseNewsRule(title) {
  return NEWS_ACTION_RULES.find(rule => rule.when.test(title)) || null;
}

function getStructuredNewsEventWindow(item) {
  const startValue = item?.eventStartsAt || item?.scheduledAt || item?.eventStartTime || item?.eventTime || null;
  const endValue = item?.eventEndsAt || item?.deadlineAt || item?.eventEndTime || null;
  const startMs = parseTimestamp(startValue);
  const endMs = parseTimestamp(endValue);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (!isResolvableEventWindow({ startMs, endMs, status: item?.eventStatus || 'scheduled' })) return null;
  return {
    startMs,
    endMs,
    eventStartsAt: nowIso(startMs),
    eventEndsAt: nowIso(endMs),
    eventStatus: normalizeText(item?.eventStatus || 'scheduled').toLowerCase(),
  };
}

async function buildNewsPredictionDraft(item, region) {
  const title = normalizeText(item?.sourceTitle);
  const rule = chooseNewsRule(title);
  if (!rule) return null;

  const subject = extractSubject(title);
  if (!subject || subject.length < 4) return null;
  const eventWindow = getStructuredNewsEventWindow(item);
  if (!eventWindow) return null;

  const imageAsset = await resolvePreviewImageAsset({
    sourceImageUrl: item?.imageUrl,
    title,
    sport: 'general',
    category: item?.category || 'general',
  });
  const previewImageUrl = imageAsset.url;
  const contextVideoUrl = buildNewsContextVideoUrl(item);
  const category = ['economy', 'politics', 'technology', 'society', 'sports'].includes(item?.category)
    ? item.category
    : 'general';
  const seed = `${region}:${item.sourceKey}:${rule.key}`;
  const durationMs = clamp(eventWindow.endMs - nowMs(), MIN_PREDICTION_DURATION_MS, MAX_PREDICTION_DURATION_MS);

  return {
    ...buildBasePrediction(seed, region, category, rule.question(subject), title, {
      predictionKey: seed,
      predictionType: 'news_action',
      predictionSourceType: 'news',
      proofVideoUrl: contextVideoUrl,
      durationMs,
      endsAt: eventWindow.endMs,
      eventTitle: title,
      eventStartsAt: eventWindow.eventStartsAt,
      eventEndsAt: eventWindow.eventEndsAt,
      eventStatus: eventWindow.eventStatus || 'scheduled',
      verificationProvider: item?.sourceFeedLabel || item?.domain || 'trusted_news',
      verificationSource: {
        provider: 'trusted_news',
        type: 'news_event_source',
        label: item?.sourceFeedLabel || item?.domain || 'Trusted news',
        url: item?.sourceUrl,
        sourceKey: item?.sourceKey,
      },
      resolutionMethod: 'official_news_followup',
    }),
    photo: previewImageUrl,
    sourceImageUrl: previewImageUrl,
    previewVideoUrl: contextVideoUrl,
    contextVideoUrl,
    sourceUrl: item.sourceUrl,
    sourceTitle: title,
    sourceExcerpt: normalizeText(item.sourceDescription).slice(0, 220),
    sourceDescription: normalizeText(item.sourceDescription),
    sourceFeedLabel: item.sourceFeedLabel || item.domain || 'Trusted media',
    sourceDomain: item.domain || '',
    sourceKey: item.sourceKey,
    newsPublishedAt: item.publishedAt || null,
    createdFromNews: true,
    trending: Number(item.regionalScore || item.score || 0) >= 10,
    ai: /\b(ai|artificial intelligence)\b/i.test(title),
    actionRule: {
      kind: 'news',
      ruleKey: rule.key,
      topicFingerprint: fingerprintTitle(title),
      subject,
      positiveTerms: rule.positiveTerms,
      negativeTerms: rule.negativeTerms,
      proofUrl: item.sourceUrl,
      proofVideoUrl: contextVideoUrl,
      publishedAt: item.publishedAt || null,
      eventStartsAt: eventWindow.eventStartsAt,
      eventEndsAt: eventWindow.eventEndsAt,
      eventStatus: eventWindow.eventStatus || 'scheduled',
    },
  };
}

async function buildPreparedPredictionPool(regionInput, region, options = {}) {
  const activeTarget = Math.max(1, Number(options.activeTarget) || 30);
  const preparedBuffer = Math.max(2, Number(options.preparedBuffer) || 8);
  const maxSportsEvents = Math.max(6, Number(options.maxSportsEvents) || 12);
  const maxNewsItems = Math.max(8, Number(options.maxNewsItems) || 18);

  const drafts = [];
  const sportsEvents = Array.isArray(regionInput?.sportsEvents) ? regionInput.sportsEvents.slice(0, maxSportsEvents) : [];
  const sportsDraftSets = await Promise.all(sportsEvents.map(event => buildSportsPredictionDrafts(event, region)));
  sportsDraftSets.forEach(group => {
    drafts.push(...group);
  });

  const cryptoAssets = Array.isArray(regionInput?.cryptoAssets) ? regionInput.cryptoAssets.slice(0, 12) : [];
  const cryptoDraftSets = await Promise.all(cryptoAssets.map(asset => buildCryptoPredictionDrafts(asset, region)));
  cryptoDraftSets.forEach(group => {
    drafts.push(...group);
  });

  const stockAssets = Array.isArray(regionInput?.stockAssets) ? regionInput.stockAssets.slice(0, 4) : [];
  const stockDraftSets = await Promise.all(stockAssets.map(asset => buildStockPredictionDrafts(asset, region)));
  stockDraftSets.forEach(group => { drafts.push(...group); });

  const newsItems = Array.isArray(regionInput?.newsItems) ? regionInput.newsItems.slice(0, maxNewsItems) : [];
  const newsDrafts = await Promise.all(newsItems.map(item => buildNewsPredictionDraft(item, region)));
  newsDrafts.forEach(draft => {
    if (draft) drafts.push(draft);
  });

  const dedupe = new Map();
  drafts.forEach((draft, index) => {
    const key = normalizeText(draft.predictionKey).toLowerCase();
    if (!key || dedupe.has(key)) return;
    dedupe.set(key, {
      ...draft,
      order: index,
    });
  });

  const pool = [...dedupe.values()];
  const visibleCount = Math.min(activeTarget, pool.length);
  return pool.map((draft, index) => ({
    ...draft,
    listed: index < visibleCount,
    order: index,
    preparedAt: index >= visibleCount ? nowIso() : null,
  })).slice(0, activeTarget + preparedBuffer);
}

function buildValidationResolution(winnerSide, debate, reason, snapshot, state = 'validated', closureReason = 'source_update') {
  const winnerLabel = winnerSide === 'yes' ? debate.yesLabel : debate.noLabel;
  return {
    winnerSide,
    winnerLabel,
    validationState: state,
    closureReason,
    validationEvidence: {
      checkedAt: nowIso(),
      snapshot,
      reason,
    },
    verdictReasoning: reason,
    proofVideoUrl: snapshot?.proofVideoUrl || debate.proofVideoUrl || debate.contextVideoUrl || debate.previewVideoUrl || null,
  };
}

function evaluateSportsPrediction(debate, eventSnapshot) {
  if (!eventSnapshot || !debate?.actionRule) return null;

  const homeScore = Number(eventSnapshot.home?.score || 0);
  const awayScore = Number(eventSnapshot.away?.score || 0);
  const totalScore = homeScore + awayScore;
  const rule = debate.actionRule;
  const snapshot = {
    provider: eventSnapshot.provider,
    league: eventSnapshot.leagueLabel,
    eventId: eventSnapshot.eventId,
    homeScore,
    awayScore,
    state: eventSnapshot.state,
    detail: eventSnapshot.statusDetail,
    proofUrl: eventSnapshot.proofUrl || eventSnapshot.sourceUrl,
    proofVideoUrl: eventSnapshot.proofVideoUrl || debate.proofVideoUrl,
  };

  switch (rule.market) {
    case 'winner_home':
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        const winnerSide = homeScore > awayScore ? 'yes' : 'no';
        return buildValidationResolution(
          winnerSide,
          debate,
          winnerSide === 'yes'
            ? `${rule.homeName} won according to the official ${eventSnapshot.leagueLabel} feed.`
            : `${rule.homeName} did not win according to the official ${eventSnapshot.leagueLabel} feed.`,
          snapshot,
          'validated',
          'event_finished'
        );
      }
      return null;

    case 'total_over':
      if (totalScore >= Number(rule.threshold || 0)) {
        return buildValidationResolution('yes', debate, `The official feed reached ${totalScore}, above the ${rule.threshold} line.`, snapshot, 'validated', 'condition_met');
      }
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        return buildValidationResolution('no', debate, `The event finished at ${totalScore}, below the ${rule.threshold} line.`, snapshot, 'validated', 'event_finished');
      }
      return null;

    case 'both_teams_score':
      if (homeScore > 0 && awayScore > 0) {
        return buildValidationResolution('yes', debate, 'Both sides are on the scoreboard in the official event feed.', snapshot, 'validated', 'condition_met');
      }
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        return buildValidationResolution('no', debate, 'One side finished scoreless in the official event feed.', snapshot, 'validated', 'event_finished');
      }
      return null;

    case 'any_more_score':
      if (totalScore > Number(rule.initialTotal || 0)) {
        return buildValidationResolution('yes', debate, 'A new scoring action has been confirmed by the official scoreboard.', snapshot, 'validated', 'condition_met');
      }
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        return buildValidationResolution('no', debate, 'No new score was recorded before the event ended.', snapshot, 'validated', 'event_finished');
      }
      return null;

    case 'leader_holds': {
      const leaderStillAhead = rule.leaderSide === 'home' ? homeScore > awayScore : awayScore > homeScore;
      if (!leaderStillAhead) {
        return buildValidationResolution('no', debate, 'The original lead disappeared on the official scoreboard.', snapshot, 'validated', 'condition_impossible');
      }
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        return buildValidationResolution('yes', debate, 'The leader still had the advantage at the final whistle.', snapshot, 'validated', 'event_finished');
      }
      return null;
    }

    case 'trailing_team_equalizes': {
      const erasedDeficit = rule.trailingSide === 'home' ? homeScore >= awayScore : awayScore >= homeScore;
      if (erasedDeficit) {
        return buildValidationResolution('yes', debate, 'The trailing side erased the deficit on the official scoreboard.', snapshot, 'validated', 'condition_met');
      }
      if (eventSnapshot.completed || eventSnapshot.state === 'post') {
        return buildValidationResolution('no', debate, 'The deficit remained until the event ended.', snapshot, 'validated', 'event_finished');
      }
      return null;
    }

    default:
      return null;
  }
}

function evaluateCryptoPrediction(debate, assetSnapshot) {
  if (!debate?.actionRule || !assetSnapshot?.id) return null;
  const rule = debate.actionRule;
  if (String(rule.assetId || '').toLowerCase() !== String(assetSnapshot.id || '').toLowerCase()) return null;

  const currentPrice = Number(assetSnapshot.currentPrice);
  const targetPrice = Number(rule.targetPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(targetPrice)) return null;
  const lockedSnapshotPrice = Number(debate.validationEvidence?.snapshot?.currentPrice);
  const lockedHitAbove = Number.isFinite(lockedSnapshotPrice) && lockedSnapshotPrice >= targetPrice;
  const lockedHitBelow = Number.isFinite(lockedSnapshotPrice) && lockedSnapshotPrice <= targetPrice;

  const snapshot = {
    provider: assetSnapshot.provider || 'coingecko',
    assetId: assetSnapshot.id,
    assetSymbol: assetSnapshot.symbol,
    currentPrice,
    targetPrice,
    updatedAt: assetSnapshot.updatedAt,
    proofUrl: assetSnapshot.proofUrl || assetSnapshot.sourceUrl,
    apiUrl: assetSnapshot.apiUrl,
  };

  if (rule.market === 'price_above') {
    if (currentPrice >= targetPrice) {
      return buildValidationResolution(
        'yes',
        debate,
        `${assetSnapshot.symbol} reached ${formatUsd(currentPrice)}, above the ${formatUsd(targetPrice)} trigger on CoinGecko.`,
        snapshot,
        'validated',
        'condition_met'
      );
    }
    if (debate?.validationState === 'validating' && debate?.winnerSide === 'yes' && lockedHitAbove) {
      return buildValidationResolution(
        'yes',
        debate,
        `${assetSnapshot.symbol} already crossed ${formatUsd(targetPrice)} during the lock window and the CoinGecko feed remains reachable.`,
        {
          ...snapshot,
          lockedSnapshotPrice,
          lockedCheckedAt: debate.validationEvidence?.checkedAt || null,
        },
        'validated',
        'condition_met'
      );
    }
    if (Date.now() >= Number(debate.endsAt || 0)) {
      return buildValidationResolution(
        'no',
        debate,
        `${assetSnapshot.symbol} finished below ${formatUsd(targetPrice)} at expiry according to CoinGecko.`,
        snapshot,
        'validated',
        'condition_impossible'
      );
    }
    return null;
  }

  if (rule.market === 'price_below') {
    if (currentPrice <= targetPrice) {
      return buildValidationResolution(
        'yes',
        debate,
        `${assetSnapshot.symbol} traded down to ${formatUsd(currentPrice)}, below the ${formatUsd(targetPrice)} trigger on CoinGecko.`,
        snapshot,
        'validated',
        'condition_met'
      );
    }
    if (debate?.validationState === 'validating' && debate?.winnerSide === 'yes' && lockedHitBelow) {
      return buildValidationResolution(
        'yes',
        debate,
        `${assetSnapshot.symbol} already traded below ${formatUsd(targetPrice)} during the lock window and the CoinGecko feed remains reachable.`,
        {
          ...snapshot,
          lockedSnapshotPrice,
          lockedCheckedAt: debate.validationEvidence?.checkedAt || null,
        },
        'validated',
        'condition_met'
      );
    }
    if (Date.now() >= Number(debate.endsAt || 0)) {
      return buildValidationResolution(
        'no',
        debate,
        `${assetSnapshot.symbol} stayed above ${formatUsd(targetPrice)} until expiry according to CoinGecko.`,
        snapshot,
        'validated',
        'condition_impossible'
      );
    }
    return null;
  }

  return null;
}

function tokenOverlap(left, right) {
  const leftTokens = new Set(normalizeText(left).split(/\s+/).filter(token => token.length > 2));
  const rightTokens = new Set(normalizeText(right).split(/\s+/).filter(token => token.length > 2));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let matches = 0;
  leftTokens.forEach(token => {
    if (rightTokens.has(token)) matches += 1;
  });
  return matches / Math.min(leftTokens.size, rightTokens.size);
}

function evaluateNewsPrediction(debate, regionInput) {
  if (!debate?.actionRule) return null;
  const items = Array.isArray(regionInput?.newsItems) ? regionInput.newsItems : [];
  const rule = debate.actionRule;
  const debateFingerprint = normalizeText(rule.topicFingerprint || fingerprintTitle(debate.sourceTitle || debate.title));
  const createdAtMs = Date.parse(debate.createdAt || debate.openedAt || 0);

  const followUp = items.find(item => {
    const itemFingerprint = fingerprintTitle(item.sourceTitle || '');
    const sameTopic = tokenOverlap(debateFingerprint, itemFingerprint) >= 0.5;
    const publishedAtMs = Date.parse(item.publishedAt || 0);
    return sameTopic && (!Number.isFinite(createdAtMs) || !Number.isFinite(publishedAtMs) || publishedAtMs >= createdAtMs - 60 * 60 * 1000);
  });

  if (!followUp) return null;

  const combinedText = `${followUp.sourceTitle || ''} ${followUp.sourceDescription || ''}`.toLowerCase();
  const snapshot = {
    provider: 'trusted_news',
    sourceTitle: followUp.sourceTitle,
    sourceUrl: followUp.sourceUrl,
    proofUrl: followUp.sourceUrl,
    proofVideoUrl: debate.proofVideoUrl || debate.contextVideoUrl,
  };

  if ((rule.positiveTerms || []).some(term => combinedText.includes(String(term).toLowerCase()))) {
    return buildValidationResolution('yes', debate, `Trusted follow-up coverage confirmed the action: ${followUp.sourceTitle}`, snapshot, 'validated', 'condition_met');
  }

  if ((rule.negativeTerms || []).some(term => combinedText.includes(String(term).toLowerCase()))) {
    return buildValidationResolution('no', debate, `Trusted follow-up coverage ruled against the action: ${followUp.sourceTitle}`, snapshot, 'validated', 'condition_impossible');
  }

  return null;
}

module.exports = {
  DEFAULT_PREDICTION_DURATION_MS,
  MAX_PREDICTION_DURATION_MS,
  MIN_PREDICTION_DURATION_MS,
  buildPreparedPredictionPool,
  evaluateCryptoPrediction,
  evaluateNewsPrediction,
  evaluateSportsPrediction,
  nowIso,
  resolvePreviewImageAsset,
  resolvePredictionDurationMs,
};
