const { URL } = require('url');

const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.NEWS_REQUEST_TIMEOUT_MS) || 12_000);

const RSS_TOPICS = [
  {
    id: 'technology',
    category: 'technology',
    label: 'BBC Technology',
    feedUrl: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  },
  {
    id: 'business',
    category: 'economy',
    label: 'BBC Business',
    feedUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml',
  },
  {
    id: 'politics',
    category: 'politics',
    label: 'BBC Politics',
    feedUrl: 'https://feeds.bbci.co.uk/news/politics/rss.xml',
  },
  {
    id: 'world',
    category: 'society',
    label: 'BBC World',
    feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  },
  {
    id: 'sports',
    category: 'sports',
    label: 'BBC Sport',
    feedUrl: 'https://feeds.bbci.co.uk/sport/rss.xml?edition=uk',
  },
];

const TRUSTED_NEWS_DOMAINS = new Set([
  'bbc.co.uk',
  'bbc.com',
]);

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
    .replace(/&gt;/gi, '>');
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
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(pattern);
  return match ? stripHtml(match[1]) : '';
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
      language: 'english',
      sourceCountry: 'uk',
      imageUrl: '',
      trustedDomain: TRUSTED_NEWS_DOMAINS.has(domain),
      sourceKey: sourceUrl ? sourceUrl.toLowerCase() : `${domain}::${sourceTitle.toLowerCase()}`,
    };
  }).filter(item => item.sourceTitle && item.sourceUrl);
}

async function fetchTopicNews(topic) {
  const response = await fetch(topic.feedUrl, {
    headers: {
      'accept': 'text/xml',
      'user-agent': 'BEEEF/1.0 news-automation',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`RSS ${topic.id} ${response.status}`);
  }

  const xml = await response.text();
  return parseRssItems(xml, topic);
}

async function fetchLatestNews() {
  const settled = await Promise.allSettled(RSS_TOPICS.map(topic => fetchTopicNews(topic)));
  const items = [];
  const errors = [];
  const dedupe = new Set();

  settled.forEach((result, index) => {
    const topic = RSS_TOPICS[index];
    if (result.status === 'rejected') {
      errors.push({
        topicId: topic.id,
        message: result.reason?.message || 'Unknown fetch error',
      });
      return;
    }

    result.value.forEach(item => {
      if (dedupe.has(item.sourceKey)) {
        return;
      }
      dedupe.add(item.sourceKey);
      items.push(item);
    });
  });

  items.sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime;
  });

  return {
    source: 'bbc-rss',
    endpoint: 'https://feeds.bbci.co.uk/news/10628494',
    topics: RSS_TOPICS.map(topic => ({
      id: topic.id,
      category: topic.category,
      label: topic.label,
      feedUrl: topic.feedUrl,
    })),
    items,
    errors,
  };
}

module.exports = {
  RSS_TOPICS,
  TRUSTED_NEWS_DOMAINS,
  fetchLatestNews,
};
