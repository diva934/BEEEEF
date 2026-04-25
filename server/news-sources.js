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

// Multi-source RSS feeds (no API key required)
const RSS_TOPICS = [
  { id: 'bbc-tech', category: 'technology', label: 'BBC Technology', feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { id: 'bbc-business', category: 'economy', label: 'BBC Business', feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { id: 'bbc-politics', category: 'politics', label: 'BBC Politics', feedUrl: 'https://feeds.bbci.co.uk/news/politics/rss.xml' },
  { id: 'bbc-world', category: 'society', label: 'BBC World', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'bbc-sport', category: 'sports', label: 'BBC Sport', feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml?edition=uk' },
  { id: 'guardian-world', category: 'society', label: 'The Guardian — World', feedUrl: 'https://www.theguardian.com/world/rss' },
  { id: 'guardian-tech', category: 'technology', label: 'The Guardian — Tech', feedUrl: 'https://www.theguardian.com/uk/technology/rss' },
  { id: 'guardian-business', category: 'economy', label: 'The Guardian — Business', feedUrl: 'https://www.theguardian.com/uk/business/rss' },
  { id: 'npr-news', category: 'society', label: 'NPR — Top stories', feedUrl: 'https://feeds.npr.org/1001/rss.xml' },
  { id: 'npr-business', category: 'economy', label: 'NPR — Business', feedUrl: 'https://feeds.npr.org/1006/rss.xml' },
  { id: 'aljazeera-all', category: 'society', label: 'Al Jazeera', feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'france24-en', category: 'society', label: 'France 24', feedUrl: 'https://www.france24.com/en/rss' },
  { id: 'lemonde-une', category: 'society', label: 'Le Monde', feedUrl: 'https://www.lemonde.fr/rss/une.xml' },
  { id: 'lemonde-eco', category: 'economy', label: 'Le Monde — Économie', feedUrl: 'https://www.lemonde.fr/economie/rss_full.xml' },
  { id: 'coindesk', category: 'crypto', label: 'CoinDesk', feedUrl: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'hn-front', category: 'technology', label: 'Hacker News', feedUrl: 'https://hnrss.org/frontpage' },
];

const TRUSTED_NEWS_DOMAINS = new Set([
  'bbc.co.uk', 'bbc.com',
  'theguardian.com', 'guardian.co.uk',
  'npr.org',
  'aljazeera.com',
  'france24.com',
  'lemonde.fr',
  'coindesk.com',
  'news.ycombinator.com', 'ycombinator.com',
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
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
]);

const CATEGORY_KEYWORDS = {
  politics: ['election', 'parliament', 'senate', 'president', 'minister', 'government', 'vote', 'political', 'democrat', 'republican', 'trump', 'biden', 'macron', 'starmer'],
  economy: ['inflation', 'gdp', 'market', 'stock', 'fed', 'interest rate', 'recession', 'economy', 'bank', 'ipo', 'earnings', 'trade', 'tariff', 'unemployment'],
  technology: ['ai', 'apple', 'google', 'microsoft', 'meta', 'openai', 'chatgpt', 'nvidia', 'chip', 'tech', 'software', 'startup', 'silicon valley', 'quantum'],
  crypto: ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'btc', 'eth', 'stablecoin', 'sec lawsuit', 'coinbase', 'binance'],
  sports: ['nba', 'nfl', 'fifa', 'world cup', 'olympics', 'ligue 1', 'premier league', 'champions league', 'tennis', 'f1', 'formula 1'],
  society: ['climate', 'protest', 'strike', 'migration', 'court', 'supreme court', 'ruling', 'war', 'conflict', 'peace', 'treaty'],
};

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
  items.sort((left, right) => {
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
  fetchLatestNews,
  inferCategoryFromText,
};
