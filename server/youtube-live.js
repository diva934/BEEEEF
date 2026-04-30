// server/youtube-live.js
// Returns hardcoded 24/7 news stream embed URLs for BEEEF debate platform.
// No oEmbed verification -- debates are always created from these sources.
// If a video ID becomes stale, YouTube shows an error in the embed.
// Update the IDs in CHANNEL_SOURCES to fix stale streams.

'use strict';

// Stable 24/7 news channel live stream video IDs.
// To find a new ID: go to youtube.com/@ChannelName/live and copy the video ID from the URL.
var CHANNEL_SOURCES = [
  { videoId: 'F-PODziGFpI', channel: 'Al Jazeera English',  category: 'monde',     lang: 'en' },
  { videoId: 'mGHOslU6pM4', channel: 'DW News',             category: 'general',   lang: 'en' },
  { videoId: 'w_Ma8oQLmSM', channel: 'BBC News',            category: 'general',   lang: 'en' },
  { videoId: 'dp8PhLsUcFE', channel: 'Bloomberg TV',        category: 'economie',  lang: 'en' },
  { videoId: 'l8pmfNyEMZE', channel: 'France 24 English',   category: 'monde',     lang: 'en' },
  { videoId: 'ybIwUkepYh8', channel: 'BFMTV',               category: 'france',    lang: 'fr' },
  { videoId: 'cKCz-oMDJkY', channel: 'franceinfo',          category: 'politique', lang: 'fr' },
  { videoId: '9Auq9mYxFEE', channel: 'Sky News',            category: 'general',   lang: 'en' },
  { videoId: 'Y3eFSMl5ibc', channel: 'Euronews',            category: 'monde',     lang: 'en' },
];

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

function makeEmbedUrl(videoId) {
  return 'https://www.youtube.com/embed/' + videoId
    + '?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1&controls=1';
}

function makeThumbnailUrl(videoId) {
  return 'https://i.ytimg.com/vi/' + videoId + '/maxresdefault.jpg';
}

function buildStreamInfo(source) {
  return {
    videoId:       source.videoId,
    title:         source.channel + ' Live',
    thumbnailUrl:  makeThumbnailUrl(source.videoId),
    channelTitle:  source.channel,
    channelHandle: source.channel,
    category:      source.category,
    lang:          source.lang,
    embedUrl:      makeEmbedUrl(source.videoId),
    sourceUrl:     'https://www.youtube.com/watch?v=' + source.videoId,
  };
}

// Return all streams immediately -- no network calls needed
function getAllStreams() {
  return CHANNEL_SOURCES.map(buildStreamInfo);
}

function getLiveStreamForCategory(category) {
  var cat = String(category || '').toLowerCase();
  var preferredId = CATEGORY_VIDEO_ID[cat] || DEFAULT_VIDEO_ID;
  var preferred = CHANNEL_SOURCES.find(function (s) { return s.videoId === preferredId; });
  return buildStreamInfo(preferred || CHANNEL_SOURCES[0]);
}

function getLiveEmbedForCategory(category) {
  var stream = getLiveStreamForCategory(category);
  return {
    videoId:      stream.videoId,
    embedUrl:     stream.embedUrl,
    thumbnailUrl: stream.thumbnailUrl,
    channelTitle: stream.channelTitle,
    lang:         stream.lang,
  };
}

// Async wrappers for backward compat
async function fetchAllLiveStreams() {
  var streams = getAllStreams();
  console.log('[youtube-live] returning ' + streams.length + ' hardcoded streams');
  return streams;
}

async function resolveNewsLiveStream(category) {
  var embed = getLiveEmbedForCategory(category);
  return {
    videoId:  embed.videoId,
    handle:   embed.channelTitle || 'Live News',
    embedUrl: embed.embedUrl,
  };
}

async function refreshCache() {
  console.log('[youtube-live] no-op refresh (hardcoded streams, no oEmbed verification)');
}
var refreshLiveStreams = refreshCache;

module.exports = {
  CHANNEL_STREAMS:          CHANNEL_SOURCES,
  fetchAllLiveStreams:       fetchAllLiveStreams,
  getLiveStreamForCategory: getLiveStreamForCategory,
  getLiveEmbedForCategory:  getLiveEmbedForCategory,
  resolveNewsLiveStream:    resolveNewsLiveStream,
  refreshCache:             refreshCache,
  refreshLiveStreams:        refreshLiveStreams,
};
