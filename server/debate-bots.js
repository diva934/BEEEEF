// server/debate-bots.js
// 30 bot personas that simulate realistic user activity in live debates.
// Bots post staggered messages to seed engagement from the moment a debate opens.

'use strict';

var BOT_PERSONAS = [
  { name: 'AlexM',        style: 'analytical',  side: 'yes' },
  { name: 'Sarah_K',      style: 'passionate',   side: 'no'  },
  { name: 'MikeD87',      style: 'skeptical',    side: 'no'  },
  { name: 'EmmaWatch',    style: 'journalist',   side: 'yes' },
  { name: 'ChrisEcon',    style: 'economist',    side: 'yes' },
  { name: 'RyanT',        style: 'neutral',      side: null  },
  { name: 'Jules_F',      style: 'informed',     side: 'yes' },
  { name: 'Pierre_V',     style: 'contrarian',   side: 'no'  },
  { name: 'Marie_A',      style: 'neutral',      side: null  },
  { name: 'ThomasD',      style: 'passionate',   side: 'yes' },
  { name: 'LucasLive',    style: 'skeptical',    side: 'no'  },
  { name: 'Nora_D',       style: 'journalist',   side: null  },
  { name: 'OlivierB',     style: 'economist',    side: 'no'  },
  { name: 'ClaraW',       style: 'analytical',   side: 'yes' },
  { name: 'JakobN',       style: 'contrarian',   side: 'yes' },
  { name: 'Sofia_R',      style: 'informed',     side: 'no'  },
  { name: 'BenT',         style: 'passionate',   side: 'no'  },
  { name: 'AnaL',         style: 'neutral',      side: null  },
  { name: 'MaxG',         style: 'skeptical',    side: 'yes' },
  { name: 'IsabelC',      style: 'journalist',   side: 'no'  },
  { name: 'KarimO',       style: 'analytical',   side: 'no'  },
  { name: 'LeaP',         style: 'passionate',   side: 'yes' },
  { name: 'DanielH',      style: 'economist',    side: 'yes' },
  { name: 'YukiT',        style: 'informed',     side: null  },
  { name: 'FredM',        style: 'contrarian',   side: 'no'  },
  { name: 'ChloeBR',      style: 'neutral',      side: null  },
  { name: 'SamP',         style: 'skeptical',    side: 'no'  },
  { name: 'ElenaV',       style: 'journalist',   side: 'yes' },
  { name: 'RafaelS',      style: 'passionate',   side: 'no'  },
  { name: 'AmelieK',      style: 'analytical',   side: 'yes' },
];

var MESSAGES = {
  analytical: {
    yes: [
      'The data clearly supports the YES position here.',
      'From an analytical standpoint, the evidence favors this.',
      'Looking at historical precedent, YES makes more sense.',
      'The metrics consistently point in one direction on this.',
      'Objectively speaking, this outcome is highly probable.',
      'When you break down the numbers, YES wins easily.',
      'The trend lines are unambiguous. Voting YES.',
    ],
    no: [
      'The data does not support this claim at all.',
      'Analytically, the NO case is far stronger here.',
      'When you look at the numbers, the answer is clearly NO.',
      'The evidence points against this happening.',
      'A rational analysis shows this is unlikely to hold.',
      'The statistics favor NO on this one. No contest.',
    ],
    neutral: [
      'Interesting framing of the question.',
      'Both sides have valid data points worth considering.',
      'This is more complex than it appears on the surface.',
      'Need more context before making a call.',
    ],
  },
  passionate: {
    yes: [
      'Absolutely YES!! This is a no-brainer.',
      'I strongly believe this is going to happen.',
      'Come on, YES is obviously the right call here!',
      'This is exactly what we need. Full YES from me.',
      '100% YES. No doubt in my mind.',
      'Voting YES all day long. Easy decision.',
      'YES YES YES. Why is this even a debate?!',
    ],
    no: [
      'Hard NO. I cannot believe people are falling for this.',
      'NO way this is going to work out.',
      'This is wrong on so many levels. Vote NO!',
      'I am completely against this. Always have been.',
      'NO. End of discussion for me.',
      'Are you serious? This is obviously NO.',
    ],
    neutral: [
      'This is getting really intense to watch!',
      'The crowd is fired up tonight.',
      'Wild debate. I can feel the energy here.',
      'Incredible. Both sides are going hard.',
    ],
  },
  skeptical: {
    yes: [
      'I was skeptical but the YES argument is more compelling than I expected.',
      'Still not fully convinced but leaning YES at this point.',
      'The YES case surprised me. More credible than I thought.',
      'Okay I will admit the YES side made a strong point just now.',
    ],
    no: [
      'I have serious doubts about all of this.',
      'Not buying it. Too many unknowns. Voting NO.',
      'Show me the proof first. Until then, NO.',
      'The YES camp is ignoring too many red flags here.',
      'This sounds good on paper but reality is different.',
      'Way too many assumptions in the YES argument.',
      'Something feels off here. I am staying NO.',
    ],
    neutral: [
      'I remain skeptical of both positions honestly.',
      'Something does not add up here.',
      'Need more information before committing to a side.',
      'The more I watch this the less certain I feel.',
    ],
  },
  journalist: {
    yes: [
      'Sources on the ground confirm this is likely YES.',
      'According to insiders, the YES outcome is probable.',
      'Reporting suggests the YES camp has the stronger case.',
      'Multiple outlets are backing the YES narrative today.',
      'Breaking: the YES side just got a major endorsement.',
    ],
    no: [
      'The facts on the ground point clearly toward NO.',
      'Experts in the field are largely saying NO on this.',
      'Multiple independent sources lean toward the NO side.',
      'The story is more complicated than the YES camp admits.',
      'Just spoke to someone close to the situation. NO.',
    ],
    neutral: [
      'Developing story here. More details expected shortly.',
      'Both sides making strong arguments in this debate.',
      'Worth watching how this plays out over the next hours.',
      'Key details are still emerging on this one.',
      'We are watching history unfold in real time.',
    ],
  },
  economist: {
    yes: [
      'From a market perspective, YES is the rational bet.',
      'Economic incentives clearly align with the YES outcome.',
      'The cost-benefit analysis strongly favors YES.',
      'Markets are already pricing in the YES scenario.',
      'Long-term fundamentals point firmly toward YES.',
      'The macro case for YES is stronger than most realize.',
    ],
    no: [
      'Economically, NO is the more defensible position.',
      'The fundamentals do not support the YES thesis here.',
      'Risk-adjusted, NO is the smarter call right now.',
      'The macro environment is not ready for this yet.',
      'I am an economist. The answer here is clearly NO.',
    ],
    neutral: [
      'The economic impact could genuinely go either way.',
      'This will depend heavily on external market conditions.',
      'Both scenarios have significant tail risks worth noting.',
      'Watching the spreads closely. Inconclusive so far.',
    ],
  },
  informed: {
    yes: [
      'I have been following this closely for weeks. YES is the answer.',
      'Everything points to YES if you have been paying attention.',
      'YES, without hesitation. The full context makes it clear.',
      'Spent a lot of time on this. It is YES.',
      'Trust me on this one. I have done the research. YES.',
    ],
    no: [
      'I know this topic well and NO is the correct position.',
      'The full context clearly favors NO here.',
      'Been tracking this closely. NO is the right call.',
      'Deep dive on this says NO without question.',
      'Anyone who has studied this knows it is NO.',
    ],
    neutral: [
      'Both sides have informed supporters. Hard to call.',
      'There is genuine uncertainty despite what people claim.',
      'The details matter a lot on this one.',
      'This one could really go either way.',
    ],
  },
  contrarian: {
    yes: [
      'Against my instincts but YES might actually be right.',
      'The contrarian view surprisingly points to YES here.',
      'Everyone says NO so YES might be the real play.',
      'I am going against the herd. YES on this one.',
    ],
    no: [
      'The herd is saying YES so I am going NO just to be safe.',
      'The consensus is wrong. NO is coming.',
      'Contrarian take: this ends in NO for sure.',
      'When everyone agrees, be very careful. Voting NO.',
      'Too much YES energy in here. Fading it. NO.',
      'Every contrarian signal I know says NO right now.',
    ],
    neutral: [
      'The obvious answer is probably wrong here.',
      'I distrust any narrative that looks too clean.',
      'Everyone is so confident. That alone makes me nervous.',
      'When the crowd this certain, I fade it.',
    ],
  },
  neutral: {
    yes: [
      'Slightly more convinced by the YES arguments today.',
      'On balance, leaning YES at this point.',
      'YES feels right but I am keeping an open mind.',
      'Reluctantly going YES. The argument just barely tips it.',
    ],
    no: [
      'The NO argument makes more sense to me currently.',
      'Leaning NO after hearing both sides carefully.',
      'Cannot commit fully but NO seems more likely.',
      'Going NO but would not be surprised either way.',
    ],
    neutral: [
      'Watching this closely but not committing yet.',
      'Genuinely torn. Could go either way.',
      'Interesting debate. Good points on both sides.',
      'Still undecided but very engaged.',
      'One of the trickier calls I have seen on here.',
      'Absorbing all the arguments. Not ready to decide.',
    ],
  },
};

var _botTimers = new Map();

function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

function getBotMessage(bot) {
  var style = MESSAGES[bot.style] || MESSAGES.neutral;
  var side  = bot.side || 'neutral';
  var pool  = style[side];
  if (!pool || !pool.length) {
    pool = [].concat(style.neutral || [], style.yes || [], style.no || []);
  }
  return pickRandom(pool) || 'Interesting debate.';
}

function sendBotMessage(debateId, bot, io, pushMsg) {
  var msg = {
    id:       'bot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    debateId: String(debateId),
    user:     bot.name,
    text:     getBotMessage(bot),
    ts:       Date.now(),
    isBot:    true,
  };
  try {
    pushMsg(debateId, msg);
    io.to(String(debateId)).emit('debate_chat_message', msg);
  } catch (e) {
    // ignore silently
  }
}

// Start bots for a debate. Target: 25-30 bots per debate.
// onBotBet(debateId, side, amount) — optional callback that updates the real pool.
function startBotsForDebate(debateId, debate, io, pushMsg, onBotBet) {
  var id = String(debateId);
  if (_botTimers.has(id)) return;

  // Shuffle and pick 25-30 bots
  var shuffled = BOT_PERSONAS.slice().sort(function () { return Math.random() - 0.5; });
  var count    = 25 + Math.floor(Math.random() * 6); // 25-30
  var assigned = shuffled.slice(0, Math.min(count, shuffled.length));

  var timers = [];
  _botTimers.set(id, timers);

  // ── Chat messages ─────────────────────────────────────────────
  assigned.forEach(function (bot, i) {
    // Stagger initial messages: first bot at 8s, spread out over ~4 minutes
    var initialDelay = 8000 + i * (6000 + Math.floor(Math.random() * 8000));

    var initTimeout = setTimeout(function () {
      if (!_botTimers.has(id)) return;
      sendBotMessage(id, bot, io, pushMsg);

      function scheduleNext() {
        // Each bot posts every 2-5 minutes
        var delay = 120000 + Math.floor(Math.random() * 180000);
        var t = setTimeout(function () {
          if (!_botTimers.has(id)) return;
          sendBotMessage(id, bot, io, pushMsg);
          scheduleNext();
        }, delay);
        timers.push(t);
      }

      scheduleNext();
    }, initialDelay);

    timers.push(initTimeout);
  });

  // ── Market activity: bots place real bets to move the pool ────
  // First bet arrives 20-60 s after debate opens, then every 90-240 s.
  if (typeof onBotBet === 'function') {
    (function scheduleBotBet(delay) {
      var t = setTimeout(function () {
        if (!_botTimers.has(id)) return;

        // Pick a random bot and determine which side it bets on
        var betBot = assigned[Math.floor(Math.random() * assigned.length)];
        var side;
        if (betBot.side) {
          // 70 % on the bot's natural side, 30 % on the opposite
          side = Math.random() < 0.70 ? betBot.side : (betBot.side === 'yes' ? 'no' : 'yes');
        } else {
          side = Math.random() < 0.5 ? 'yes' : 'no';
        }

        // Realistic bet amounts: 30-250 pts, occasionally larger (5 % chance of 500-1500 pts)
        var amount = Math.random() < 0.05
          ? 500 + Math.floor(Math.random() * 1001)
          : 30  + Math.floor(Math.random() * 221);

        try { onBotBet(id, side, amount); } catch (e) { /* ignore */ }

        // Schedule the next bet: 90-240 s
        scheduleBotBet(90000 + Math.floor(Math.random() * 150001));
      }, delay);
      timers.push(t);
    })(20000 + Math.floor(Math.random() * 40001)); // first bet: 20-60 s
  }

  console.log('[debate-bots] started ' + assigned.length + ' bots for debate ' + id + (onBotBet ? ' (market-active)' : ''));
}

function stopBotsForDebate(debateId) {
  var id     = String(debateId);
  var timers = _botTimers.get(id);
  if (timers) {
    timers.forEach(function (t) { clearTimeout(t); });
    console.log('[debate-bots] stopped bots for debate ' + id);
  }
  _botTimers.delete(id);
}

function stopAllBots() {
  _botTimers.forEach(function (timers) {
    timers.forEach(function (t) { clearTimeout(t); });
  });
  _botTimers.clear();
}

module.exports = {
  startBotsForDebate: startBotsForDebate,
  stopBotsForDebate:  stopBotsForDebate,
  stopAllBots:        stopAllBots,
};
