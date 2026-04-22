'use strict';

/**
 * news-sources.js
 * Fetches raw articles from BBC RSS feeds using only Node.js built-ins.
 * No external XML parser — items are extracted with simple string splitting.
 */

const https = require('https');
const http = require('http');

// ─────────────────────────────────────────────────────────────
//  Feed definitions
// ─────────────────────────────────────────────────────────────
const BBC_FEEDS = [
  { key: 'bbc-tech',      url: 'http://feeds.bbci.co.uk/news/technology/rss.xml',  category: 'tech' },
  { key: 'bbc-business',  url: 'http://feeds.bbci.co.uk/news/business/rss.xml',    category: 'business' },
  { key: 'bbc-politics',  url: 'http://feeds.bbci.co.uk/news/politics/rss.xml',    category: 'politics' },
  { key: 'bbc-world',     url: 'http://feeds.bbci.co.uk/news/world/rss.xml',       category: 'world' },
  { key: 'bbc-sport',     url: 'http://feeds.bbci.co.uk/sport/rss.xml',            category: 'sport' },
];

// ─────────────────────────────────────────────────────────────
//  HTTP helper
// ─────────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'BEEEF-NewsPipeline/1.0' } }, (res) => {
      // Follow a single redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
//  RSS parser (no external deps)
// ─────────────────────────────────────────────────────────────
function extractTagContent(xml, tag) {
  // Handles both <tag>value</tag> and CDATA
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i');
  const match = xml.match(re);
  if (!match) return '';
  return (match[1] !== undefined ? match[1] : match[2] || '').trim();
}

function parseRssItems(xml, sourceKey, category) {
  const items = [];
  // Split on <item> boundaries
  const parts = xml.split(/<item[\s>]/i);
  // parts[0] is the channel header, skip it
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const endIdx = chunk.indexOf('</item>');
    const itemXml = endIdx !== -1 ? chunk.slice(0, endIdx) : chunk;

    const title = extractTagContent(itemXml, 'title');
    const description = extractTagContent(itemXml, 'description');
    const link = extractTagContent(itemXml, 'link') ||
                 (itemXml.match(/<link>([^<]+)<\/link>/i) || [])[1] || '';
    const pubDate = extractTagContent(itemXml, 'pubDate');

    if (!title || !link) continue;

    items.push({
      title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      description: description.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      link: link.trim(),
      pubDate: pubDate ? new Date(pubDate).getTime() : Date.now(),
      sourceKey,
      category,
    });
  }
  return items;
}

// ─────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all BBC feeds concurrently.
 * Returns a flat array of raw article objects.
 * Individual feed failures are logged and skipped gracefully.
 */
async function fetchAllFeeds() {
  const results = await Promise.allSettled(
    BBC_FEEDS.map(async (feed) => {
      const xml = await fetchUrl(feed.url);
      const items = parseRssItems(xml, feed.key, feed.category);
      console.log(`[news-sources] ${feed.key}: fetched ${items.length} items`);
      return items;
    })
  );

  const articles = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      console.warn(`[news-sources] feed ${BBC_FEEDS[i].key} failed:`, result.reason?.message || result.reason);
    }
  });

  console.log(`[news-sources] total raw articles: ${articles.length}`);
  return articles;
}

module.exports = { fetchAllFeeds, BBC_FEEDS };
