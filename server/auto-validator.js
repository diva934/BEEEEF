'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  auto-validator.js
//  Real-event prediction auto-validation engine.
//
//  Runs every 30s. For each closed debate with validationState='validating'
//  and a real predictionSourceType ('crypto' or 'sports'), queries the live
//  data API (CoinGecko or ESPN) to determine YES/NO, then:
//    1. Calls resolveDebate()         — writes the verdict to debates.json
//    2. Calls settleDebateBetsAsAdmin() — credits winners, marks losers
//    3. Emits prediction:settled via Socket.IO
//
//  For debates cancelled (event never finished, etc.), calls
//  refundDebateBetsAsAdmin() and emits prediction:cancelled.
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATOR_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.VALIDATOR_INTERVAL_MS) || 30000
);
const REQUEST_TIMEOUT_MS = 10000;
const SPORTS_GIVE_UP_AFTER_MS = 4 * 60 * 60 * 1000; // 4h after close → cancel

// Track debates that have been validated to avoid double-settling
const _settled = new Set();

// ─────────────────────────────────────────────────────────────────────────────
//  CoinGecko — crypto price validation
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCoinGeckoPrice(assetId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(assetId)}&vs_currencies=usd&include_24hr_change=false`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const price = data?.[assetId]?.usd;
  return typeof price === 'number' ? price : null;
}

async function validateCryptoDebate(debate) {
  const rule = debate.actionRule;
  if (!rule?.assetId || !rule?.market || !Number.isFinite(Number(rule.targetPrice))) return null;

  let price;
  try {
    price = await fetchCoinGeckoPrice(rule.assetId);
  } catch (err) {
    console.warn(`[auto-validator] CoinGecko fetch failed for ${rule.assetId}:`, err.message);
    return null;
  }
  if (price === null) return null;

  let winnerSide;
  if (rule.market === 'price_above') {
    winnerSide = price >= Number(rule.targetPrice) ? 'yes' : 'no';
  } else if (rule.market === 'price_below') {
    winnerSide = price <= Number(rule.targetPrice) ? 'yes' : 'no';
  } else {
    console.warn(`[auto-validator] unknown crypto market: ${rule.market}`);
    return null;
  }

  return {
    winnerSide,
    evidence: {
      source: 'coingecko',
      assetId: rule.assetId,
      assetSymbol: rule.assetSymbol || rule.assetId,
      currentPrice: price,
      targetPrice: Number(rule.targetPrice),
      market: rule.market,
      checkedAt: new Date().toISOString(),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  ESPN — sports event validation
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEspnEventSummary(sport, league, eventId) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${encodeURIComponent(sport)}/${encodeURIComponent(league)}/summary?event=${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`);
  return res.json();
}

async function validateSportsDebate(debate) {
  const rule = debate.actionRule;
  if (!rule?.eventId || !rule?.sport || !rule?.league || !rule?.market) return null;

  let data;
  try {
    data = await fetchEspnEventSummary(rule.sport, rule.league, rule.eventId);
  } catch (err) {
    console.warn(`[auto-validator] ESPN fetch failed for event ${rule.eventId}:`, err.message);
    return null;
  }

  // Navigate the ESPN response to find competition/status
  const competition =
    data?.header?.competitions?.[0] ||
    data?.gamepackageJSON?.header?.competitions?.[0] ||
    null;

  if (!competition) return null;

  const isCompleted = competition.status?.type?.completed === true;

  if (!isCompleted) {
    // Not finished yet. If we've waited too long, cancel and refund.
    const closedAt = Number(debate.closedAt || 0);
    if (closedAt && Date.now() - closedAt > SPORTS_GIVE_UP_AFTER_MS) {
      return {
        cancelled: true,
        reason: 'sports_event_not_completed',
        evidence: {
          source: 'espn',
          eventId: rule.eventId,
          checkedAt: new Date().toISOString(),
          note: 'Event did not finish within the wait window.',
        },
      };
    }
    return null; // keep waiting
  }

  const competitors = competition.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = Number(home.score || 0);
  const awayScore = Number(away.score || 0);
  const totalScore = homeScore + awayScore;

  const evidence = {
    source: 'espn',
    eventId: rule.eventId,
    sport: rule.sport,
    league: rule.league,
    market: rule.market,
    homeScore,
    awayScore,
    totalScore,
    homeTeam: home.team?.shortDisplayName || home.team?.displayName || rule.homeName || 'Home',
    awayTeam: away.team?.shortDisplayName || away.team?.displayName || rule.awayName || 'Away',
    checkedAt: new Date().toISOString(),
  };

  let winnerSide;

  switch (rule.market) {
    case 'winner_home':
      winnerSide = homeScore > awayScore ? 'yes' : 'no';
      break;

    case 'total_over': {
      const threshold = Number(rule.threshold || 3);
      winnerSide = totalScore >= threshold ? 'yes' : 'no';
      evidence.threshold = threshold;
      break;
    }

    case 'both_teams_score':
      winnerSide = homeScore > 0 && awayScore > 0 ? 'yes' : 'no';
      break;

    case 'any_more_score': {
      const initial = Number(rule.initialTotal || 0);
      winnerSide = totalScore > initial ? 'yes' : 'no';
      evidence.initialTotal = initial;
      break;
    }

    case 'leader_holds': {
      const leaderSide = rule.leaderSide;
      if (leaderSide === 'home') winnerSide = homeScore > awayScore ? 'yes' : 'no';
      else winnerSide = awayScore > homeScore ? 'yes' : 'no';
      break;
    }

    case 'trailing_team_equalizes': {
      const trailingSide = rule.trailingSide;
      if (trailingSide === 'home') winnerSide = homeScore >= awayScore ? 'yes' : 'no';
      else winnerSide = awayScore >= homeScore ? 'yes' : 'no';
      break;
    }

    default:
      console.warn(`[auto-validator] unknown sports market: ${rule.market}`);
      return null;
  }

  return { winnerSide, evidence };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Verdict reasoning builder
// ─────────────────────────────────────────────────────────────────────────────

function buildVerdictReasoning(debate, winnerSide, evidence) {
  const yesLabel = String(debate.yesLabel || 'YES');
  const noLabel  = String(debate.noLabel  || 'NO');
  const winner   = winnerSide === 'yes' ? yesLabel : noLabel;

  if (!evidence) return `${winner} confirmed by the data source.`;

  if (evidence.source === 'coingecko') {
    const cur = evidence.currentPrice;
    const tgt = evidence.targetPrice;
    const fmt = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(v);
    if (evidence.market === 'price_above') {
      return winnerSide === 'yes'
        ? `${evidence.assetSymbol} reached ${fmt(cur)}, above the ${fmt(tgt)} target — ${winner} confirmed by CoinGecko.`
        : `${evidence.assetSymbol} ended at ${fmt(cur)}, below the ${fmt(tgt)} target — ${winner} confirmed by CoinGecko.`;
    }
    if (evidence.market === 'price_below') {
      return winnerSide === 'yes'
        ? `${evidence.assetSymbol} dropped to ${fmt(cur)}, below the ${fmt(tgt)} target — ${winner} confirmed by CoinGecko.`
        : `${evidence.assetSymbol} remained at ${fmt(cur)}, above the ${fmt(tgt)} floor — ${winner} confirmed by CoinGecko.`;
    }
  }

  if (evidence.source === 'espn') {
    const score = `${evidence.homeTeam} ${evidence.homeScore} – ${evidence.awayScore} ${evidence.awayTeam}`;
    if (evidence.market === 'winner_home') {
      return `Final score: ${score}. ${winner} confirmed by the official ESPN scoreboard.`;
    }
    if (evidence.market === 'total_over') {
      return `Total goals: ${evidence.totalScore} (threshold ${evidence.threshold}). Final score: ${score}. ${winner} confirmed by ESPN.`;
    }
    if (evidence.market === 'both_teams_score') {
      return `Final score ${score} — both sides ${evidence.homeScore > 0 && evidence.awayScore > 0 ? 'did' : 'did not'} score. ${winner} confirmed by ESPN.`;
    }
    return `Final score: ${score}. ${winner} confirmed by the official ESPN scoreboard.`;
  }

  return `${winner} confirmed by the official data source at ${evidence.checkedAt}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Odds calculation — parimutuel
// ─────────────────────────────────────────────────────────────────────────────

function calcOdds(debate, winnerSide) {
  const yesPct = Number(debate.yesPct) || 50;
  const winnerPct = winnerSide === 'yes' ? yesPct : 100 - yesPct;
  if (winnerPct <= 0 || winnerPct >= 100) return 2.0;
  return Math.round((100 / winnerPct) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main validation pass
// ─────────────────────────────────────────────────────────────────────────────

async function runValidationPass(allDebates, opts = {}) {
  const { resolveDebate, settleDebateBetsAsAdmin, refundDebateBetsAsAdmin, io } = opts;
  if (!resolveDebate || !settleDebateBetsAsAdmin) return;

  // Find debates that need real-event validation
  const pending = allDebates.filter(d =>
    d.closed &&
    d.validationState === 'validating' &&
    d.predictionSourceType &&
    ['crypto', 'sports'].includes(d.predictionSourceType) &&
    !_settled.has(String(d.id))
  );

  if (!pending.length) return;
  console.log(`[auto-validator] checking ${pending.length} pending debate(s)`);

  for (const debate of pending) {
    const debateId = String(debate.id);
    try {
      let result = null;

      if (debate.predictionSourceType === 'crypto') {
        result = await validateCryptoDebate(debate);
      } else if (debate.predictionSourceType === 'sports') {
        result = await validateSportsDebate(debate);
      }

      if (!result) continue; // not ready yet, retry next pass

      _settled.add(debateId); // mark as processed to avoid double-settling

      // ── Cancelled — refund all bets ──────────────────────────────────────
      if (result.cancelled) {
        console.log(`[auto-validator] cancelling ${debateId} — ${result.reason}`);

        try {
          resolveDebate(debateId, {
            winnerSide: null,
            validationState: 'cancelled',
            validationEvidence: result.evidence || null,
            verdictReasoning: `Auto-cancelled: ${result.reason}. All bets have been refunded.`,
            closureReason: result.reason,
          });
        } catch (e) {
          console.warn(`[auto-validator] resolveDebate(cancel) failed for ${debateId}:`, e.message);
        }

        if (typeof refundDebateBetsAsAdmin === 'function') {
          try {
            await refundDebateBetsAsAdmin(debateId, { reason: result.reason });
          } catch (e) {
            console.warn(`[auto-validator] refund failed for ${debateId}:`, e.message);
          }
        }

        if (io) {
          io.to(debateId).emit('prediction:settled', {
            debateId,
            winnerSide: null,
            cancelled: true,
            reason: result.reason,
          });
        }
        continue;
      }

      // ── Validated — settle bets ──────────────────────────────────────────
      const { winnerSide, evidence } = result;
      const odds = calcOdds(debate, winnerSide);
      const reasoning = buildVerdictReasoning(debate, winnerSide, evidence);

      console.log(`[auto-validator] validated ${debateId} → side=${winnerSide} odds=${odds} source=${debate.predictionSourceType}`);

      // 1. Write verdict to debates.json
      try {
        resolveDebate(debateId, {
          winnerSide,
          validationState: 'validated',
          validationEvidence: evidence,
          verdictReasoning: reasoning,
          closureReason: 'auto_validated',
        });
      } catch (e) {
        console.warn(`[auto-validator] resolveDebate failed for ${debateId}:`, e.message);
      }

      // 2. Settle bets in Supabase
      let settlement = { settledCount: 0, winners: 0, totalGain: 0 };
      try {
        settlement = await settleDebateBetsAsAdmin(debateId, winnerSide, odds, {
          reason: 'auto_validated',
          source: debate.predictionSourceType,
          evidence,
        });
        if (settlement?.settledCount) {
          console.log(`[auto-validator] settled ${debateId}: ${settlement.settledCount} bets, ${settlement.winners} winners, gain=${settlement.totalGain}`);
        }
      } catch (e) {
        console.warn(`[auto-validator] settleDebateBetsAsAdmin failed for ${debateId}:`, e.message);
      }

      // 3. Notify frontend via Socket.IO
      if (io) {
        io.to(debateId).emit('prediction:settled', {
          debateId,
          winnerSide,
          winnerLabel: winnerSide === 'yes' ? (debate.yesLabel || 'YES') : (debate.noLabel || 'NO'),
          odds,
          settledCount: settlement?.settledCount || 0,
          winners: settlement?.winners || 0,
          totalGain: settlement?.totalGain || 0,
          reasoning,
          source: debate.predictionSourceType,
        });

        // Also broadcast to all connected clients for live UI updates
        io.emit('debate_state_changed', {
          debateId,
          validationState: 'validated',
          winnerSide,
          settlementState: 'settled',
        });
      }
    } catch (err) {
      console.warn(`[auto-validator] unhandled error for debate ${debateId}:`, err.message);
      _settled.delete(debateId); // allow retry
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

let _handle = null;

function startAutoValidator(opts = {}) {
  const { listDebates, resolveDebate, settleDebateBetsAsAdmin, refundDebateBetsAsAdmin, io } = opts;

  if (!listDebates || !resolveDebate || !settleDebateBetsAsAdmin) {
    console.warn('[auto-validator] missing required opts — not starting');
    return null;
  }

  if (_handle) clearInterval(_handle);

  _handle = setInterval(async () => {
    try {
      const allDebates = listDebates({ includeUnlisted: true });
      await runValidationPass(allDebates, {
        resolveDebate,
        settleDebateBetsAsAdmin,
        refundDebateBetsAsAdmin,
        io,
      });
    } catch (err) {
      console.warn('[auto-validator] pass error:', err.message);
    }
  }, VALIDATOR_INTERVAL_MS);

  console.log(`[auto-validator] started — interval=${VALIDATOR_INTERVAL_MS / 1000}s`);
  return _handle;
}

function stopAutoValidator() {
  if (_handle) {
    clearInterval(_handle);
    _handle = null;
    console.log('[auto-validator] stopped');
  }
}

module.exports = {
  startAutoValidator,
  stopAutoValidator,
  runValidationPass,
  validateCryptoDebate,
  validateSportsDebate,
};
