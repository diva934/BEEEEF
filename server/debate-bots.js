// server/debate-bots.js
// Bot personas that simulate realistic user activity in debates.
// Bots post staggered messages to seed initial engagement.

'use strict';

var BOT_PERSONAS = [
  { name: 'AlexM',      style: 'analytical',  side: 'yes' },
  { name: 'Sarah_K',    style: 'passionate',   side: 'no'  },
  { name: 'MikeD87',    style: 'skeptical',    side: 'no'  },
  { name: 'EmmaWatch',  style: 'journalist',   side: 'yes' },
  { name: 'ChrisEcon',  style: 'economist',    side: 'yes' },
  { name: 'RyanT',      style: 'neutral',      side: null  },
  { name: 'Jules_F',    style: 'informed',     side: 'yes' },
  { name: 'Pierre_V',   style: 'contrarian',   side: 'no'  },
  { name: 'Marie_A',    style: 'neutral',      side: null  },
  { name: 'ThomasD',    style: 'passionate',   side: 'yes' },
  { name: 'LucasLive',  style: 'skeptical',    side: 'no'  },
  { name: 'Nora_D',     style: 'journalist',   side: null  },
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
    ],
    no: [
      'The data does not support this claim at all.',
      'Analytically, the NO case is far stronger here.',
      'When you look at the numbers, the answer is clearly NO.',
      'The evidence points against this happening.',
      'A rational analysis shows this is unlikely to hold.',
    ],
    neutral: [
      'Interesting framing of the question.',
      'Both sides have valid data points worth considering.',
      'This is more complex than it appears on the surface.',
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
    ],
    no: [
      'Hard NO. I cannot believe people are falling for this.',
      'NO way this is going to work out.',
      'This is wrong on so many levels. Vote NO!',
      'I am completely against this. Always have been.',
      'NO. End of discussion for me.',
    ],
    neutral: [
      'This is getting really intense to watch!',
      'The crowd is fired up tonight.',
      'Wild debate. I can feel the energy here.',
    ],
  },
  skeptical: {
    yes: [
      'I was skeptical but the YES argument is more compelling than I expected.',
      'Still not fully convinced but leaning YES at this point.',
      'The YES case surprised me. More credible than I thought.',
    ],
    no: [
      'I have serious doubts about all of this.',
      'Not buying it. Too many unknowns. Voting NO.',
      'Show me the proof first. Until then, NO.',
      'The YES camp is ignoring too many red flags here.',
      'This sounds good on paper but reality is different.',
      'Way too many assumptions in the YES argument.',
    ],
    neutral: [
      'I remain skeptical of both positions honestly.',
      'Something does not add up here.',
      'Need more information before committing to a side.',
    ],
  },
  journalist: {
    yes: [
      'Sources on the ground confirm this is likely YES.',
      'According to insiders, the YES outcome is probable.',
      'Reporting suggests the YES camp has the stronger case.',
      'Multiple outlets are backing the YES narrative today.',
    ],
    no: [
      'The facts on the ground point clearly toward NO.',
      'Experts in the field are largely saying NO on this.',
      'Multiple independent sources lean toward the NO side.',
      'The story is more complicated than the YES camp admits.',
    ],
    neutral: [
      'Developing story here. More details expected shortly.',
      'Both sides making strong arguments in this debate.',
      'Worth watching how this plays out over the next hours.',
      'Key details are still emerging on this one.',
    ],
  },
  economist: {
    yes: [
      'From a market perspective, YES is the rational bet.',
      'Economic incentives clearly align with the YES outcome.',
      'The cost-benefit analysis strongly favors YES.',
      'Markets are already pricing in the YES scenario.',
      'Long-term fundamentals point firmly toward YES.',
    ],
    no: [
      'Economically, NO is the more defensible position.',
      'The fundamentals do not support the YES thesis here.',
      'Risk-adjusted, NO is the smarter call right now.',
      'The macro environment is not ready for this yet.',
    ],
    neutral: [
      'The economic impact could genuinely go either way.',
      'This will depend heavily on external market conditions.',
      'Both scenarios have significant tail risks worth noting.',
    ],
  },
  informed: {
    yes: [
      'I have been following this closely for weeks. YES is the answer.',
      'Everything points to YES if you have been paying attention.',
      'YES, without hesitation. The full context makes it clear.',
      'Spent a lot of time on this. It is YES.',
    ],
    no: [
      'I know this topic well and NO is the correct position.',
      'The full context clearly favors NO here.',
      'Been tracking this closely. NO is the right call.',
      'Deep dive on this says NO without question.',
    ],
    neutral: [
      'Both sides have informed supporters. Hard to call.',
      'There is genuine uncertainty despite what people claim.',
      'The details matter a lot on this one.',
    ],
  },
  contrarian: {
    yes: [
      'Against my instincts but YES might actually be right.',
      'The contrarian view surprisingly points to YES here.',
      'Everyone says NO so YES might be the real play.',
    ],
    no: [
      'The herd is saying YES so I am going NO just to be safe.',
      'The consensus is wrong. NO is coming.',
      'Contrarian take: this ends in NO for sure.',
      'When everyone agrees, be very careful. Voting NO.',
      'Too much YES energy in here. Fading it. NO.',
    ],
    neutral: [
      'The obvious answer is probably wrong here.',
      'I distrust any narrative that looks too clean.',
      'Everyone is so confident. That alone makes me nervous.',
    ],
  },
  neutral: {
    yes: [
      'Slightly more convinced by the YES arguments today.',
      'On balance, leaning YES at this point.',
      'YES feels right but I am keeping an open mind.',
    ],
    no: [
      'The NO argument makes more sense to me currently.',
      'Leaning NO after hearing both sides carefully.',
      'Cannot commit fully but NO seems more likely.',
    ],
    neutral: [
      'Watching this closely but not committing yet.',
      'Genuinely torn. Could go either way.',
      'Interesting debate. Good points on both sides.',
      'Still undecided but very engaged.',
      'One of the trickier calls I have seen on here.',
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
  var side = bot.side || 'neutral';
  var pool = style[side];
  if (!pool || !pool.length) {
    pool = (style.neutral || [])
      .concat(style.yes || [])
      .concat(style.no || []);
  }
  return pickRandom(pool) || 'Interesting debate.';
}

function sendBotMessage(debateId, bot, io, pushMsg) {
  var msg = {
    id: 'bot-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    debateId: String(debateId),
    user: bot.name,
    text: getBotMessage(bot),
    ts: Date.now(),
    isBot: true,
  };
  try {
    pushMsg(debateId, msg);
    io.to(String(debateId)).emit('debate_chat_message', msg);
  } catch (e) {
    // ignore send errors silently
  }
}

function startBotsForDebate(debateId, debate, io, pushMsg) {
  var id = String(debateId);
  if (_botTimers.has(id)) return;

  var shuffled = BOT_PERSONAS.slice().sort(function () { return Math.random() - 0.5; });
  var count = 3 + Math.floor(Math.random() * 3);
  var assigned = shuffled.slice(0, count);

  var timers = [];
  _botTimers.set(id, timers);

  assigned.forEach(function (bot, i) {
    var initialDelay = 20000 + i * (10000 + Math.floor(Math.random() * 15000));

    var initTimeout = setTimeout(function () {
      if (!_botTimers.has(id)) return;
      sendBotMessage(id, bot, io, pushMsg);

      function scheduleNext() {
        var delay = 60000 + Math.floor(Math.random() * 180000);
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

  console.log('[debate-bots] started', count, 'bots for debate', id);
}

function stopBotsForDebate(debateId) {
  var id = String(debateId);
  var timers = _botTimers.get(id);
  if (timers) {
    timers.forEach(function (t) { clearTimeout(t); });
    console.log('[debate-bots] stopped bots for debate', id);
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
  stopBotsForDebate: stopBotsForDebate,
  stopAllBots: stopAllBots,
};
