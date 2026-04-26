// server/youtube-live.js
// Live stream resolver -- oEmbed only, no scraping.
// Uses a curated list of stable 24/7 news channel video IDs.
// oEmbed is a public YouTube API that works from cloud servers.

'use strict';

// Known stable 24/7 live stream video IDs.
// These IDs rarely change for major 24/7 broadcast channels.
var CHANNEL_STREAMS = [
  { videoId: 'F-PODziGFpI', channel: 'Al Jazeera English',  category: 'monde',     lang: 'en' },
  { videoId: 'mGHOslU6pM4', channel: 'DW News',             category: 'general',   lang: 'en' },
  { videoId: 'w_Ma8oQLmSM', channel: 'BBC News',            category: 'general',   lang: 'en' },
  { videoId: 'dp8PhLsUcFE', channel: 'Bloomberg TV',        category: 'economie',  lang: 'en' },
  { videoId: 'h3MuIUncRnQ', channel: 'France 24 English',   category: 'monde',     lang: 'en' },
  { videoId: 'ybIwUkepYh8', channel: 'BFMTV',               category: 'france',    lang: 'fr' },
  { videoId: 'cKCz-oMDJkY', channel: 'franceinfo',          category: 'politique', lang: 'fr' },
  { videoId: '9Auq9mYxFEE', channel: 'Sky News',            category: 'general',   lang: 'en' },
  { videoId: 'YardpC0tMdA', channel: 'Euronews',            category: 'monde',     lang: 'en' },
];

// Map category to preferred video ID
var CATEGORY_VIDEO_ID = {
  monde:       'F-PODziGFpI',
  world:       'F-PODziGFpI',
  geopolitics: 'F-PODziGFpI',
  politics:    'mGHOslU6pM4',
  general:     'mGHOslU6pM4',
  technology:  'w_Ma8oQLmSM',
  economie:    'dp8PhLsUcFE',
  economy:     'dp8PhLsUcFE',
  crypto:      'dp8PhLsUcFE',
  france:      'ybIwUkepYh8',
  politique:   'cKCz-oMDJkY',
  sports:      'mGHOslU6pM4',
  sport:       'mGHOslU6pM4',
  society:     'mGHOslU6pM4',
  culture:     'w_Ma8oQLmSM',
};
var DEFAULT_VIDEO_ID = 'mGHOslU6pM4';

// Cache: Map<videoId, streamInfo>
var _cache = new Map();
var _cacheAt = 0;
var CACHE_TTL = 10 * 60 * 1000; // 10 min

function makeEmbedUrl(videoId) {
  return 'https://www.youtube.com/embed/' + videoId + '?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1';
}

function makeThumbnailUrl(videoId, oembed) {
  if (oembed && oembed.thumbnail_url) return oembed.thumbnail_url;
  return 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg';
}

async function fetchOembed(videoId) {
  try {
    var res = await fetch(
      'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + videoId + '&format=json',
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function verifyStream(stream) {
  var oembed = await fetchOembed(stream.videoId);
  if (!oembed || !oembed.title) {
    console.warn('[youtube-live] oEmbed failed for', stream.videoId, '(' + stream.channel + ')');
    return null;
  }
  return {
    videoId:      stream.videoId,
    title:        oembed.title || stream.channel,
    thumbnailUrl: makeThumbnailUrl(stream.videoId, oembed),
    channelTitle: oembed.author_name || stream.channel,
    channelHandle:stream.channel,
    category:     stream.category,
    lang:         stream.lang,
    embedUrl:     makeEmbedUrl(stream.videoId),
    sourceUrl:    'https://www.youtube.com/watch?v=' + stream.videoId,
    fetchedAt:    Date.now(),
  };
}

async function refreshCache() {
  console.log('[youtube-live] refreshing oEmbed cache for', CHANNEL_STREAMS.length, 'streams...');
  var results = await Promise.allSettled(CHANNEL_STREAMS.map(verifyStream));
  _cache.clear();
  results.forEach(function (r) {
    if (r.status === 'fulfilled' && r.value) {
      _cache.set(r.value.videoId, r.value);
    }
  });
  _cacheAt = Date.now();
  console.log('[youtube-live]', _cache.size, '/' + CHANNEL_STREAMS.length, 'streams verified');
}

async function ensureCache() {
  if (!_cache.size || Date.now() - _cacheAt > CACHE_TTL) {
    await refreshCache();
  }
}

// Return all verified live streams (used by news-pipeline Phase 1)
async function fetchAllLiveStreams() {
  await ensureCache();
  return Array.from(_cache.values());
}

// Return best verified stream for a category (synchronous after cache warmed)
function getLiveStreamForCategory(category) {
  var cat = String(category || '').toLowerCase();
  var preferredId = CATEGORY_VIDEO_ID[cat] || DEFAULT_VIDEO_ID;
  if (_cache.has(preferredId)) return _cache.get(preferredId);
  // fallback: any verified stream
  var fallback = Array.from(_cache.values())[0] || null;
  return fallback;
}

// Return embed info for a category (convenience wrapper)
function getLiveEmbedForCategory(category) {
  var stream = getLiveStreamForCategory(category);
  if (!stream) {
    // Hard fallback if cache not yet warmed: use default ID
    var videoId = CATEGORY_VIDEO_ID[String(category || '').toLowerCase()] || DEFAULT_VIDEO_ID;
    return {
      videoId:      videoId,
      embedUrl:     makeEmbedUrl(videoId),
      thumbnailUrl: 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg',
      channelTitle: 'Live News',
    };
  }
  return {
    videoId:      stream.videoId,
    embedUrl:     stream.embedUrl,
    thumbnailUrl: stream.thumbnailUrl,
    channelTitle: stream.channelTitle,
    lang:         stream.lang,
  };
}

// API endpoint resolver (category string -> embed info)
async function resolveNewsLiveStream(category) {
  await ensureCache();
  var embed = getLiveEmbedForCategory(category);
  if (!embed) return null;
  return {
    videoId:  embed.videoId,
    handle:   embed.channelTitle || 'Live News',
    embedUrl: embed.embedUrl,
  };
}

// Warm cache on startup
refreshCache().catch(function (e) {
  console.warn('[youtube-live] startup cache refresh error:', e.message);
});

module.exports = {
  CHANNEL_STREAMS:          CHANNEL_STREAMS,
  fetchAllLiveStreams:       fetchAllLiveStreams,
  getLiveStreamForCategory: getLiveStreamForCategory,
  getLiveEmbedForCategory:  getLiveEmbedForCategory,
  resolveNewsLiveStream:    resolveNewsLiveStream,
  refreshCache:             refreshCache,
};
