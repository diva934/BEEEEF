const { URL } = require('url');

const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.NEWS_REQUEST_TIMEOUT_MS) || 20_000);
const MAX_FETCH_RETRIES  = Math.max(0, Number(process.env.NEWS_FETCH_RETRIES) || 2);

/**
 * Fetch with automatic retry on network failure.
 * Retries with exponential backoff: 1.5 s, 3 s, …
 */
async function fetchWithRetry(url, options, retries = MAX_FETCH_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── Event-focused RSS feeds ────────────────────────────────────────────────
// Priority: feeds that publish SCHEDULED / UPCOMING events with specific dates
// (elections, summits, matches, hearings, earnings, launches, votes, etc.)
const RSS_TOPICS = [
  // ── Politics & geopolitics (high event density) ─────────────────────────
  { id: 'politico-eu',     category: 'politics',    label: 'Politico EU',         feedUrl: 'https://www.politico.eu/feed/' },
  { id: 'politico-us',     category: 'politics',    label: 'Politico US',         feedUrl: 'https://rss.politico.com/politics-news.xml' },
  { id: 'bbc-politics',    category: 'politics',    label: 'BBC Politics',        feedUrl: 'https://feeds.bbci.co.uk/news/politics/rss.xml' },
  { id: 'guardian-world',  category: 'politics',    label: 'The Guardian — World', feedUrl: 'https://www.theguardian.com/world/rss' },
  { id: 'aljazeera-all',   category: 'politics',    label: 'Al Jazeera',          feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'france24-en',     category: 'politics',    label: 'France 24',           feedUrl: 'https://www.france24.com/en/rss' },
  { id: 'lemonde-une',     category: 'politics',    label: 'Le Monde',            feedUrl: 'https://www.lemonde.fr/rss/une.xml' },

  // ── Economy & finance (scheduled reports, meetings, earnings) ────────────
  { id: 'bbc-business',    category: 'economy',     label: 'BBC Business',        feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { id: 'guardian-biz',    category: 'economy',     label: 'Guardian Business',   feedUrl: 'https://www.theguardian.com/uk/business/rss' },
  { id: 'lemonde-eco',     category: 'economy',     label: 'Le Monde Économie',   feedUrl: 'https://www.lemonde.fr/economie/rss_full.xml' },
  { id: 'cnbc-economy',    category: 'economy',     label: 'CNBC Economy',        feedUrl: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { id: 'cnbc-finance',    category: 'economy',     label: 'CNBC Finance',        feedUrl: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { id: 'npr-business',    category: 'economy',     label: 'NPR Business',        feedUrl: 'https://feeds.npr.org/1006/rss.xml' },

  // ── Technology & product launches ───────────────────────────────────────
  { id: 'bbc-tech',        category: 'technology',  label: 'BBC Technology',      feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { id: 'guardian-tech',   category: 'technology',  label: 'Guardian Tech',       feedUrl: 'https://www.theguardian.com/uk/technology/rss' },
  { id: 'techcrunch',      category: 'technology',  label: 'TechCrunch',          feedUrl: 'https://techcrunch.com/feed/' },
  { id: 'theverge',        category: 'technology',  label: 'The Verge',           feedUrl: 'https://www.theverge.com/rss/index.xml' },
  { id: 'ars-tech',        category: 'technology',  label: 'Ars Technica',        feedUrl: 'https://feeds.arstechnica.com/arstechnica/index' },

  // ── Sports (match previews, fixtures, upcoming events) ──────────────────
  { id: 'bbc-sport',       category: 'sports',      label: 'BBC Sport',           feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml?edition=uk' },
  { id: 'bbc-football',    category: 'sports',      label: 'BBC Football',        feedUrl: 'https://feeds.bbci.co.uk/sport/football/rss.xml?edition=uk' },
  { id: 'skysports-fl',    category: 'sports',      label: 'Sky Sports Football', feedUrl: 'https://www.skysports.com/rss/12040' },
  { id: 'espn-news',       category: 'sports',      label: 'ESPN Top Headlines',  feedUrl: 'https://www.espn.com/espn/rss/news' },
  { id: 'eurosport-en',    category: 'sports',      label: 'Eurosport',           feedUrl: 'https://www.eurosport.com/rss.xml' },
  { id: 'lequipe-une',     category: 'sports',      label: "L'Équipe",            feedUrl: 'https://www.lequipe.fr/rss/actu_rss_Une.xml' },
  { id: 'lequipe-foot',    category: 'sports',      label: "L'Équipe Football",   feedUrl: 'https://www.lequipe.fr/rss/actu_rss_Football.xml' },

  // ── Crypto ──────────────────────────────────────────────────────────────
  { id: 'coindesk',        category: 'crypto',      label: 'CoinDesk',            feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph',   category: 'crypto',      label: 'CoinTelegraph',       feedUrl: 'https://cointelegraph.com/rss' },

  // ── Society & global events ──────────────────────────────────────────────
  { id: 'bbc-world',       category: 'society',     label: 'BBC World',           feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'npr-news',        category: 'society',     label: 'NPR Top Stories',     feedUrl: 'https://feeds.npr.org/1001/rss.xml' },
];

const TRUSTED_NEWS_DOMAINS = new Set([
  // General news
  'bbc.co.uk', 'bbc.com',
  'theguardian.com', 'guardian.co.uk',
  'npr.org',
  'aljazeera.com',
  'france24.com',
  'lemonde.fr',
  'reuters.com',
  'apnews.com',
  'nytimes.com',
  'ft.com',
  'wsj.com',
  'bloomberg.com',
  'cnn.com',
  'cnbc.com',
  'washingtonpost.com',
  'economist.com',
  'politico.com', 'politico.eu',
  'axios.com',
  // Tech
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  // Crypto
  'coindesk.com',
  'cointelegraph.com',
  'decrypt.co',
  // Sports
  'skysports.com',
  'espn.com',
  'eurosport.com',
  'lequipe.fr',
  'bbc.co.uk',
  // HN
  'news.ycombinator.com', 'ycombinator.com',
]);

// Event-signalling phrases — articles with these phrases describe
// UPCOMING, TIME-BOUNDED events and are strongly preferred over
// generic commentary / analysis.
const EVENT_SIGNAL_PHRASES = [
  'tonight', 'today', 'this evening', 'this morning',
  'tomorrow', 'this week', 'next week', 'this weekend',
  'on monday', 'on tuesday', 'on wednesday', 'on thursday',
  'on friday', 'on saturday', 'on sunday',
  'set to', 'scheduled to', 'expected to', 'due to',
  'will face', 'will meet', 'will vote', 'will announce',
  'will host', 'will hold', 'will open', 'will close',
  'kick off', 'kicks off', 'tip off', 'tips off',
  'final', 'semi-final', 'quarter-final',
  'election day', 'vote day', 'summit', 'rally', 'conference',
  'hearing', 'meeting', 'session', 'debate', 'press conference',
  'earnings', 'results', 'report', 'announcement',
  'launch', 'premiere', 'opening',
  'grand prix', 'race day', 'match day', 'game day',
];

const CATEGORY_KEYWORDS = {
  politics: ['election', 'parliament', 'senate', 'president', 'minister', 'government', 'vote', 'political', 'democrat', 'republican', 'trump', 'biden', 'macron', 'starmer', 'summit', 'treaty', 'sanctions', 'referendum', 'inauguration', 'rally', 'campaign'],
  economy: ['inflation', 'gdp', 'market', 'stock', 'fed', 'interest rate', 'recession', 'economy', 'bank', 'ipo', 'earnings', 'trade', 'tariff', 'unemployment', 'rate decision', 'fomc', 'ecb', 'rate cut', 'rate hike', 'quarterly results', 'jobs report'],
  technology: ['ai', 'apple', 'google', 'microsoft', 'meta', 'openai', 'chatgpt', 'nvidia', 'chip', 'tech', 'software', 'startup', 'silicon valley', 'quantum', 'wwdc', 'product launch', 'keynote', 'announcement', 'release'],
  crypto: ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'btc', 'eth', 'stablecoin', 'sec lawsuit', 'coinbase', 'binance', 'halving', 'defi', 'etf'],
  sports: ['nba', 'nfl', 'fifa', 'world cup', 'olympics', 'ligue 1', 'premier league', 'champions league', 'tennis', 'f1', 'formula 1', 'final', 'semi-final', 'match', 'game', 'grand prix', 'tournament', 'championship', 'vs', 'face off', 'fixture', 'kick off'],
  society: ['climate', 'protest', 'strike', 'migration', 'court', 'supreme court', 'ruling', 'war', 'conflict', 'peace', 'treaty', 'hearing', 'verdict', 'trial', 'ceasefire', 'agreement'],
};

/**
 * Score an article for how "event-like" it is.
 * Articles describing upcoming, time-bounded, verifiable events score higher.
 * Returns a number 0–10; ≥ 3 is good enough for a prediction.
 */
function scoreEventSignal(item) {
  const text = [item.sourceTitle, item.sourceDescription].join(' ').toLowerCase();
  let score = 0;

  // Strong signals — imminent / scheduled event
  if (/\b(tonight|today|this evening|this morning|this afternoon)\b/.test(text)) score += 4;
  if (/\b(tomorrow|this weekend|this week)\b/.test(text)) score += 3;
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text)) score += 2;
  if (/\b(on (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2})\b/.test(text)) score += 3;

  // Future-tense event verbs
  if (/\bwill (face|play|host|meet|vote|announce|launch|open|sign|hold|address|testify|rule|decide|release)\b/.test(text)) score += 3;
  if (/\b(set|due|scheduled|expected|poised)\s+to\b/.test(text)) score += 3;
  if (/\bkicks? off\b/.test(text)) score += 3;

  // Event nouns
  if (/\b(final|semi-final|quarter-final|championship|tournament|grand prix|race)\b/.test(text)) score += 3;
  if (/\b(summit|conference|rally|hearing|session|press conference|keynote|debate)\b/.test(text)) score += 2;
  if (/\b(earnings|results|ipo|vote|election day|referendum|ruling|verdict)\b/.test(text)) score += 2;
  if (/\bvs\.?\b/.test(text)) score += 2; // match preview

  // Penalty for pure retrospective / opinion / analysis
  if (/\b(analysis|opinion|review|explainer|how|why|what to know|everything you need)\b/.test(text)) score -= 2;
  if (/\b(years? ago|last (week|month|year)|in \d{4})\b/.test(text)) score -= 2;

  return score;
}

function inferCategoryFromText(text) {
  const lower = String(text || '').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return cat;
  }
  return 'society';
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return normalizeWhitespace(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

function stripHtml(value) {
  const withoutCdata = String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeHtmlEntities(withoutCdata.replace(/<[^>]*>/g, ' '));
}

function normalizeDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^www\./, '');
}

function safeDomainFromUrl(url) {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch (_) {
    return '';
  }
}

function normalizeArticleUrl(input) {
  try {
    const url = new URL(String(input || '').trim());
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach(key => {
      url.searchParams.delete(key);
    });
    return url.toString();
  } catch (_) {
    return '';
  }
}

function extractTag(block, tagName) {
  const pattern = new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)</' + tagName + '>', 'i');
  const match = block.match(pattern);
  return match ? stripHtml(match[1]) : '';
}

function extractAttribute(block, tagName, attributeName) {
  const pattern = new RegExp('<' + tagName + '\\b[^>]*\\s' + attributeName + '=["\\x27]([^"\\x27]+)["\\x27][^>]*>', 'i');
  const match = block.match(pattern);
  return match ? decodeHtmlEntities(match[1]) : '';
}

function extractImageUrl(block) {
  const mediaThumbnail = extractAttribute(block, 'media:thumbnail', 'url');
  const mediaContent = extractAttribute(block, 'media:content', 'url');
  const enclosure = extractAttribute(block, 'enclosure', 'url');
  const imgTag = block.match(/<img[^>]+src=["\x27]([^"\x27]+)["\x27]/i);
  const imgFromDesc = imgTag ? decodeHtmlEntities(imgTag[1]) : '';
  return normalizeArticleUrl(mediaThumbnail || mediaContent || enclosure || imgFromDesc);
}

function parseRssItems(xml, topic) {
  const items = [...String(xml || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)];
  return items.map(match => {
    const block = match[0];
    const sourceTitle = extractTag(block, 'title');
    const sourceUrl = normalizeArticleUrl(extractTag(block, 'link'));
    const sourceDescription = extractTag(block, 'description');
    const publishedAt = (() => {
      const raw = extractTag(block, 'pubDate');
      const timestamp = Date.parse(raw);
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    })();
    const domain = normalizeDomain(safeDomainFromUrl(sourceUrl));
    const imageUrl = extractImageUrl(block);
    return {
      topicId: topic.id,
      category: topic.category,
      sourceType: 'rss',
      sourceFeedLabel: topic.label,
      sourceTitle,
      sourceUrl,
      sourceDescription,
      publishedAt,
      domain,
      language: topic.id.startsWith('lemonde') ? 'french' : 'english',
      sourceCountry: topic.id.startsWith('lemonde') || topic.id.startsWith('france24') ? 'fr' : 'uk',
      imageUrl,
      trustedDomain: TRUSTED_NEWS_DOMAINS.has(domain),
      sourceKey: sourceUrl ? sourceUrl.toLowerCase() : (domain + '::' + sourceTitle.toLowerCase()),
    };
  }).filter(item => item.sourceTitle && item.sourceUrl);
}

async function fetchTopicNews(topic) {
  const response = await fetchWithRetry(
    topic.feedUrl,
    {
      headers: {
        'accept': 'text/xml, application/rss+xml, application/xml',
        'user-agent': 'Mozilla/5.0 (compatible; BEEEF/1.0; +https://beeeef.vercel.app)',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!response.ok) throw new Error('RSS ' + topic.id + ' HTTP ' + response.status);
  const xml = await response.text();
  return parseRssItems(xml, topic);
}

const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERIES = [
  { query: '(election OR parliament OR president OR treaty) sourcelang:eng', category: 'politics' },
  { query: '(fed OR "interest rate" OR inflation OR stocks OR gdp) sourcelang:eng', category: 'economy' },
  { query: '("artificial intelligence" OR OpenAI OR Google OR Apple OR Microsoft) sourcelang:eng', category: 'technology' },
  { query: '(bitcoin OR ethereum OR crypto OR blockchain) sourcelang:eng', category: 'crypto' },
  { query: '(NBA OR NFL OR "world cup" OR Olympics OR "premier league") sourcelang:eng', category: 'sports' },
];

async function fetchGdeltQuery({ query, category }) {
  const url = new URL(GDELT_ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('format', 'json');
  url.searchParams.set('timespan', '24h');
  url.searchParams.set('sort', 'hybridrel');
  url.searchParams.set('maxrecords', '40');
  try {
    const response = await fetchWithRetry(url.toString(), {
      headers: {
        'accept': 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; BEEEF/1.0; +https://beeeef.vercel.app)',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('GDELT ' + response.status);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    const articles = Array.isArray(data && data.articles) ? data.articles : [];
    return articles.map(article => {
      const sourceUrl = normalizeArticleUrl(article.url);
      const domain = normalizeDomain(safeDomainFromUrl(sourceUrl));
      const title = decodeHtmlEntities(article.title || '');
      const publishedAt = (() => {
        const raw = article.seendate;
        if (!raw) return null;
        const match = String(raw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
        if (!match) return null;
        return match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + match[6] + '.000Z';
      })();
      return {
        topicId: 'gdelt-' + category,
        category: category || inferCategoryFromText(title),
        sourceType: 'gdelt',
        sourceFeedLabel: article.sourcecountry ? 'GDELT (' + article.sourcecountry + ')' : 'GDELT',
        sourceTitle: title,
        sourceUrl,
        sourceDescription: '',
        publishedAt,
        domain,
        language: String(article.language || 'english').toLowerCase(),
        sourceCountry: String(article.sourcecountry || '').toLowerCase(),
        imageUrl: normalizeArticleUrl(article.socialimage || ''),
        trustedDomain: TRUSTED_NEWS_DOMAINS.has(domain),
        sourceKey: sourceUrl ? sourceUrl.toLowerCase() : (domain + '::' + title.toLowerCase()),
      };
    }).filter(item => item.sourceTitle && item.sourceUrl && item.trustedDomain);
  } catch (error) {
    return [];
  }
}

async function fetchGdeltNews() {
  const batches = await Promise.allSettled(GDELT_QUERIES.map(fetchGdeltQuery));
  const out = [];
  batches.forEach(b => { if (b.status === 'fulfilled') out.push(...b.value); });
  return out;
}

async function fetchLatestNews() {
  const rssPromise = Promise.allSettled(RSS_TOPICS.map(topic => fetchTopicNews(topic)));
  const gdeltPromise = fetchGdeltNews();
  const [rssResults, gdeltItems] = await Promise.all([rssPromise, gdeltPromise]);
  const items = [];
  const errors = [];
  const dedupe = new Set();
  const push = (item) => {
    if (!item || !item.sourceKey) return;
    if (dedupe.has(item.sourceKey)) return;
    dedupe.add(item.sourceKey);
    items.push(item);
  };
  rssResults.forEach((result, index) => {
    const topic = RSS_TOPICS[index];
    if (result.status === 'rejected') {
      errors.push({ topicId: topic.id, message: (result.reason && result.reason.message) || 'Unknown fetch error' });
      return;
    }
    result.value.forEach(push);
  });
  gdeltItems.forEach(push);
  // Sort: event-signal score DESC first, then recency DESC
  // so articles describing upcoming scheduled events bubble to the top.
  items.forEach(item => { item._eventScore = scoreEventSignal(item); });
  items.sort((left, right) => {
    const scoreDiff = (right._eventScore || 0) - (left._eventScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime;
  });
  return {
    source: 'multi-source',
    endpoints: { rss: RSS_TOPICS.length, gdelt: GDELT_QUERIES.length },
    topics: RSS_TOPICS.map(topic => ({ id: topic.id, category: topic.category, label: topic.label, feedUrl: topic.feedUrl })),
    items,
    errors,
  };
}

module.exports = {
  RSS_TOPICS,
  TRUSTED_NEWS_DOMAINS,
  EVENT_SIGNAL_PHRASES,
  fetchLatestNews,
  inferCategoryFromText,
  scoreEventSignal,
};
