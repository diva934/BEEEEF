// server/live-monitor.js
// Monitors active live-stream debates.
// Polls YouTube (InnerTube API) every 90s to detect stream end.
// When a stream ends: generates verdict, closes debate, emits debate_ended.

'use strict';

var INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
var MONITOR_INTERVAL_MS = 90 * 1000;

// Check if a YouTube video is currently live via InnerTube player API.
// Returns: true (live), false (ended), null (unknown/error - do not act)
async function checkVideoLive(videoId) {
  try {
    var url = 'https://www.youtube.com/youtubei/v1/player?key=' + INNERTUBE_KEY;
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
          },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    var data = await res.json();
    var details = data && data.videoDetails;
    if (!details) return null;

    // isLive: true  = currently streaming
    // isLive: false + isLiveContent: true = was live, now ended
    if (details.isLive === true) return true;
    if (details.isLive === false && details.isLiveContent === true) return false;

    // For scheduled or non-live content, treat as ended
    if (details.isLiveContent === false) return false;

    return null;
  } catch (e) {
    console.warn('[live-monitor] checkVideoLive error for', videoId, ':', e.message);
    return null;
  }
}

// Generate a verdict from chat messages + debate betting state.
// Combines bet distribution (70%) with chat keyword signals (30%).
var YES_KEYWORDS = [
  'yes', 'oui', 'agree', 'correct', 'right', 'true', 'for',
  'support', 'absolutely', 'definitely', 'sure', 'win', 'winner',
];
var NO_KEYWORDS = [
  'no', 'non', 'disagree', 'wrong', 'false', 'against', 'never',
  'doubt', 'unlikely', 'nope', 'fail', 'lose',
];

function generateChatVerdict(debate, chatMessages) {
  var yesPct = Math.round(Number(debate.yesPct) || 50);
  var noPct  = 100 - yesPct;

  var yesSignals = 0;
  var noSignals  = 0;

  (chatMessages || []).forEach(function (msg) {
    if (msg.isBot) return;
    var text = String(msg.text || '').toLowerCase();
    YES_KEYWORDS.forEach(function (kw) { if (text.includes(kw)) yesSignals++; });
    NO_KEYWORDS.forEach(function (kw)  { if (text.includes(kw)) noSignals++;  });
  });

  var total      = yesSignals + noSignals;
  var chatYesPct = total > 0 ? Math.round((yesSignals / total) * 100) : 50;
  var combined   = yesPct * 0.7 + chatYesPct * 0.3;
  var winnerSide = combined >= 50 ? 'yes' : 'no';

  var winnerLabel = winnerSide === 'yes'
    ? String(debate.yesLabel || 'YES')
    : String(debate.noLabel  || 'NO');
  var loserLabel  = winnerSide === 'yes'
    ? String(debate.noLabel  || 'NO')
    : String(debate.yesLabel || 'YES');
  var winningPct  = winnerSide === 'yes' ? yesPct : noPct;
  var gap         = Math.abs(winningPct - (100 - winningPct));

  var conviction  = Math.min(10, Math.round(6 + gap / 14));
  var logic       = Math.min(10, Math.round(6 + gap / 18));
  var originality = Math.min(9,  Math.round(5 + gap / 22));

  var reasoning;
  if (total === 0) {
    reasoning = winnerLabel + ' led with a stronger betting distribution throughout the live debate. The ' + loserLabel + ' camp could not close the gap before the stream ended.';
  } else {
    reasoning = winnerLabel + ' secured both the betting majority (' + winningPct + '%) and the live chat sentiment. The discussion confirmed the outcome with ' + Math.round(combined) + '% combined support.';
  }

  return {
    winnerSide: winnerSide,
    winner: winnerLabel,
    winnerLabel: winnerLabel,
    reasoning: reasoning,
    conviction: winnerSide === 'yes'
      ? { yes: conviction,                      no: Math.max(4, conviction - 2)  }
      : { yes: Math.max(4, conviction - 2),     no: conviction                   },
    logic: winnerSide === 'yes'
      ? { yes: logic,                           no: Math.max(4, logic - 1)       }
      : { yes: Math.max(4, logic - 1),          no: logic                        },
    originality: winnerSide === 'yes'
      ? { yes: originality,                     no: Math.max(4, originality - 1) }
      : { yes: Math.max(4, originality - 1),    no: originality                  },
  };
}

var _monitorHandle = null;
// Track consecutive unknown results per debate to avoid permanent stalls
var _unknownCount = new Map();
var UNKNOWN_THRESHOLD = 3; // close after 3 consecutive unknowns (~4.5 min)

function startLiveMonitor(io, opts) {
  var listDebates   = opts.listDebates;
  var closeDebate   = opts.closeDebate;
  var getChat       = opts.getChat;
  var onDebateEnded = opts.onDebateEnded || null;
  var stopBots      = opts.stopBots || null;

  if (_monitorHandle) clearInterval(_monitorHandle);

  _monitorHandle = setInterval(async function () {
    var allDebates;
    try {
      allDebates = listDebates({ includeUnlisted: true });
    } catch (e) {
      return;
    }

    var liveDebates = allDebates.filter(function (d) {
      return d.liveVideoId && !d.closed;
    });

    if (!liveDebates.length) return;

    for (var i = 0; i < liveDebates.length; i++) {
      var debate = liveDebates[i];
      var debateId = String(debate.id);
      var isLive = await checkVideoLive(debate.liveVideoId);

      if (isLive === true) {
        _unknownCount.delete(debateId);
        continue;
      }

      if (isLive === null) {
        var prev = _unknownCount.get(debateId) || 0;
        _unknownCount.set(debateId, prev + 1);
        if (prev + 1 < UNKNOWN_THRESHOLD) continue;
        console.log('[live-monitor] debate', debateId, 'had', prev + 1, 'unknown checks, treating as ended');
      }

      _unknownCount.delete(debateId);
      console.log('[live-monitor] stream ended for debate', debateId, '-- generating verdict');

      try {
        var chatMessages = getChat(debateId) || [];
        var verdict = generateChatVerdict(debate, chatMessages);
        closeDebate(debateId, verdict);

        if (stopBots) stopBots(debateId);

        io.to(debateId).emit('debate_ended', {
          debateId: debateId,
          verdict: verdict,
        });

        if (onDebateEnded) onDebateEnded(debateId);
      } catch (err) {
        console.warn('[live-monitor] error closing debate', debateId, ':', err.message);
      }
    }
  }, MONITOR_INTERVAL_MS);

  console.log('[live-monitor] started -- interval:', MONITOR_INTERVAL_MS / 1000, 's');
  return _monitorHandle;
}

function stopLiveMonitor() {
  if (_monitorHandle) {
    clearInterval(_monitorHandle);
    _monitorHandle = null;
    console.log('[live-monitor] stopped');
  }
}

module.exports = {
  startLiveMonitor: startLiveMonitor,
  stopLiveMonitor: stopLiveMonitor,
  checkVideoLive: checkVideoLive,
  generateChatVerdict: generateChatVerdict,
};
