// server/youtube-live.js
// Live stream verifier for BEEEF debate platform.
// Uses YouTube oEmbed to verify that hardcoded 24/7 stream IDs are still live.
// No scraping, no YouTube API key needed.
// Debates are ONLY created from verified streams -- no hard fallback for pipeline.

'use strict';

var https = require('https');

// Hardcoded 24/7 live stream video IDs.
// These channels broadcast continuously. oEmbed 200 = stream is active.
var CHANNEL_SOURCES = [
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

// Category-to-videoId preference map
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

// Cache of verified live streams: Map<videoId, streamInfo>
var _liveStreams = new Map();
// Timestamp of last refresh attempt (set even when all fail, to avoid hammering)
var _lastRefreshAt = 0;
var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Whether a refresh is currently in progress (avoid concurrent refreshes)
var _refreshing = false;

function makeEmbedUrl(videoId) {
  return 'https://www.youtube.com/embed/' + videoId
    + '?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1&controls=1';
}

function makeThumbnailUrl(videoId, oembedThumb) {
  if (oembedThumb) return oembedThumb;
  return 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg';
}

// Fetch YouTube oEmbed data for a video ID using native https module.
// Returns parsed JSON or null on any error.
function fetchOembed(videoId) {
  return new Promise(function (resolve) {
    var url = 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D'
      + encodeURIComponent(videoId) + '&format=json';

    var timeout = setTimeout(function () { resolve(null); }, 5000);

    try {
      https.get(url, { headers: { 'User-Agent': 'BEEEF-LiveBot/1.0' } }, function (res) {
        if (res.statusCode !== 200) {
          clearTimeout(timeout);
          res.resume();
          resolve(null);
          return;
        }
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) { body += chunk; });
        res.on('end', function () {
          clearTimeout(timeout);
          try { resolve(JSON.parse(body)); }
          catch (e) { resolve(null); }
        });
        res.on('error', function () { clearTimeout(timeout); resolve(null); });
      }).on('error', function () { clearTimeout(timeout); resolve(null); });
    } catch (e) {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

// Verify a single source stream via oEmbed.
// Returns a full stream info object or null if stream is invalid/unreachable.
async function verifySource(source) {
  var oembed = await fetchOembed(source.videoId);
  if (!oembed || !oembed.title) {
    console.log('[youtube-live] FAIL ' + source.channel + ' (' + source.videoId + ')');
    return null;
  }
  console.log('[youtube-live] OK   ' + source.channel + ' (' + source.videoId + ') -- "' + oembed.title + '"');
  return {
    videoId:       source.videoId,
    title:         oembed.title || (source.channel + ' Live'),
    thumbnailUrl:  makeThumbnailUrl(source.videoId, oembed.thumbnail_url),
    channelTitle:  oembed.author_name || source.channel,
    channelHandle: source.channel,
    category:      source.category,
    lang:          source.lang,
    embedUrl:      makeEmbedUrl(source.videoId),
    sourceUrl:     'https://www.youtube.com/watch?v=' + source.videoId,
    verifiedAt:    Date.now(),
  };
}

// Refresh the live stream cache by verifying all source IDs via oEmbed.
// Runs all verifications in parallel. Sets _lastRefreshAt regardless of results.
async function refreshLiveStreams() {
  if (_refreshing) return;
  _refreshing = true;

  console.log('[youtube-live] refreshing -- verifying ' + CHANNEL_SOURCES.length + ' sources via oEmbed...');

  try {
    var results = await Promise.allSettled(CHANNEL_SOURCES.map(verifySource));
    var verified = results
      .filter(function (r) { return r.status === 'fulfilled' && r.value; })
      .map(function (r) { return r.value; });

    _liveStreams.clear();
    verified.forEach(function (s) { _liveStreams.set(s.videoId, s); });
    _lastRefreshAt = Date.now();

    console.log('[youtube-live] verified ' + verified.length + '/' + CHANNEL_SOURCES.length + ' streams live');
  } catch (e) {
    console.warn('[youtube-live] refresh error:', e.message);
    _lastRefreshAt = Date.now(); // still set so we don't hammer on error
  } finally {
    _refreshing = false;
  }
}

// Ensure cache is fresh. If stale or empty-and-never-refreshed, trigger refresh.
async function ensureCache() {
  var now = Date.now();
  var isStale = now - _lastRefreshAt > CACHE_TTL_MS;
  if (isStale && !_refreshing) {
    await refreshLiveStreams();
  }
}

// Return all currently verified live streams.
// Returns empty array if no streams are verified.
// Used by news-pipeline Phase 1 to create live debates.
async function fetchAllLiveStreams() {
  await ensureCache();
  return Array.from(_liveStreams.values());
}

// Return the best verified stream for a given category (synchronous).
// Returns null if no verified streams are available -- callers must handle this.
function getLiveStreamForCategory(category) {
  if (!_liveStreams.size) return null;
  var cat = String(category || '').toLowerCase();
  var preferredId = CATEGORY_VIDEO_ID[cat];
  if (preferredId && _liveStreams.has(preferredId)) {
    return _liveStreams.get(preferredId);
  }
  // Any verified stream as fallback
  return Array.from(_liveStreams.values())[0] || null;
}

// Return embed info for a category.
// Returns null if no streams verified (no debate should be created).
function getLiveEmbedForCategory(category) {
  var stream = getLiveStreamForCategory(category);
  if (!stream) return null;
  return {
    videoId:      stream.videoId,
    embedUrl:     stream.embedUrl,
    thumbnailUrl: stream.thumbnailUrl,
    channelTitle: stream.channelTitle,
    lang:         stream.lang,
  };
}

// Resolve a live stream for a debate's category.
// Returns null if no verified stream -- server.js will return isLive: false.
// Debates without a verified stream should NOT be shown.
async function resolveNewsLiveStream(category) {
  await ensureCache();
  var stream = getLiveStreamForCategory(category);
  if (!stream) return null;
  return {
    videoId:  stream.videoId,
    handle:   stream.channelTitle || 'Live News',
    embedUrl: stream.embedUrl,
  };
}

// Backward compat alias
var refreshCache = refreshLiveStreams;

// Warm cache on startup
refreshLiveStreams().catch(function (e) {
  console.warn('[youtube-live] startup refresh error:', e.message);
});

// Re-verify every 5 minutes
setInterval(function () {
  refreshLiveStreams().catch(function (e) {
    console.warn('[youtube-live] scheduled refresh error:', e.message);
  });
}, CACHE_TTL_MS);

module.exports = {
  CHANNEL_STREAMS:          CHANNEL_SOURCES,
  fetchAllLiveStreams:       fetchAllLiveStreams,
  getLiveStreamForCategory: getLiveStreamForCategory,
  getLiveEmbedForCategory:  getLiveEmbedForCategory,
  resolveNewsLiveStream:    resolveNewsLiveStream,
  refreshCache:             refreshCache,
  refreshLiveStreams:        refreshLiveStreams,
};
