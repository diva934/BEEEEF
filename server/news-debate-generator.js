const crypto = require('crypto');
const { hasUsablePreviewImage, isControversialNewsItem } = require('./news-filter');

const MIN_DEBATE_DURATION_MS = 20 * 60 * 1000;
const MAX_DEBATE_DURATION_MS = 5 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = Math.max(
  MIN_DEBATE_DURATION_MS,
  Math.min(MAX_DEBATE_DURATION_MS, Number(process.env.NEWS_DEBATE_DURATION_MS) || 2 * 60 * 60 * 1000)
);

const CATEGORY_STYLES = {
  technology: ['#3d9eff', '#667eea', '#0d0d1a'],
  economy: ['#00d97e', '#00b865', '#0a1a12'],
  politics: ['#ff6432', '#dd3311', '#1a0a00'],
  crypto: ['#f7931a', '#ff6432', '#1a1a2e'],
  sports: ['#aa55ff', '#764ba2', '#130d1a'],
  culture: ['#ff7f50', '#ff4f7b', '#1a0d16'],
  society: ['#ffc800', '#ff9900', '#1a1500'],
  general: ['#ff6432', '#ff8c55', '#1a0a00'],
};

// Curated Unsplash fallback images per category (stable IDs, freely accessible)
const CATEGORY_FALLBACK_IMAGES = {
  technology: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&q=80&auto=format&fit=crop',
  economy:    'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&q=80&auto=format&fit=crop',
  politics:   'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=800&q=80&auto=format&fit=crop',
  crypto:     'https://images.unsplash.com/photo-1621504450181-5d356f61d307?w=800&q=80&auto=format&fit=crop',
  sports:     'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=800&q=80&auto=format&fit=crop',
  geopolitics:'https://images.unsplash.com/photo-1576485375217-d6a95e34d043?w=800&q=80&auto=format&fit=crop',
  society:    'https://images.unsplash.com/photo-1573164713988-8665fc963095?w=800&q=80&auto=format&fit=crop',
  culture:    'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80&auto=format&fit=crop',
  general:    'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800&q=80&auto=format&fit=crop',
};

function buildDebateVideoQuery(item) {
  const title = cleanHeadline(item.sourceTitle || '');
  const category = String(item.category || 'general').toLowerCase();
  if (!title) return '';

  const stopwords = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'with',
    'as', 'by', 'from', 'into', 'its', 'this', 'that', 'will', 'after',
    'amid', 'over', 'under', 'about', 'what', 'why', 'how',
  ]);

  const terms = title
    .split(/\s+/)
    .map(token => token.replace(/[^A-Za-z0-9&'.-]/g, ''))
    .filter(token => token.length > 2 && !stopwords.has(token.toLowerCase()))
    .slice(0, 6);

  const categoryHints = {
    politics: 'political analysis panel discussion',
    geopolitics: 'world news analysis panel documentary discussion',
    economy: 'economy market analysis panel discussion',
    technology: 'technology AI analysis report discussion',
    crypto: 'crypto market analysis panel discussion',
    sports: 'sports analysis debate discussion highlights',
    culture: 'talk show cultural analysis discussion',
    society: 'news analysis panel discussion',
    general: 'news analysis panel discussion',
  };

  const editorialHint = categoryHints[category] || categoryHints.general;
  const channelHint = ['BBC News', 'Reuters', 'DW News', 'France 24', 'Sky News'].join(' OR ');

  return [...terms, editorialHint, channelHint].join(' ').trim();
}

function buildYouTubeSearchUrl(item) {
  const query = buildDebateVideoQuery(item);
  if (!query) return '';
  return `https://www.youtube.com/embed?autoplay=1&mute=1&playsinline=1&controls=0&modestbranding=1&rel=0&listType=search&list=${encodeURIComponent(query)}&index=1`;
}

function resolvePreviewImage(item) {
  if (hasUsablePreviewImage(item.imageUrl)) return item.imageUrl;
  const fallback = CATEGORY_FALLBACK_IMAGES[item.category] || CATEGORY_FALLBACK_IMAGES.general;
  return fallback;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanHeadline(title) {
  return normalizeWhitespace(title)
    .replace(/\s+[|-]\s+.*$/, '')
    .replace(/[.?!]+$/, '')
    .trim();
}

function cleanSegment(value, maxWords = 7) {
  const cleaned = normalizeWhitespace(value)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[,;:]+.*$/, '')
    .trim();

  return cleaned
    .split(/\s+/)
    .slice(0, maxWords)
    .join(' ')
    .trim();
}

function possessive(subject) {
  const value = cleanSegment(subject, 5);
  if (!value) return '';
  return /s$/i.test(value) ? `${value}'` : `${value}'s`;
}

function extractLeadingEntity(title) {
  const directMatch = cleanHeadline(title).match(/^([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,4})/);
  if (directMatch) {
    return cleanSegment(directMatch[1], 5);
  }

  const assetMatch = cleanHeadline(title).match(/\b(Bitcoin|Ethereum|OpenAI|Nvidia|Apple|Microsoft|Google|Tesla|Meta|Amazon|Fed|ECB|PSG|Real Madrid|Arsenal|Liverpool)\b/i);
  return assetMatch ? cleanSegment(assetMatch[1], 5) : '';
}

function hashNumber(seed) {
  const digest = crypto.createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 8);
  return parseInt(digest, 16);
}

/**
 * Generate a stable, deterministic debate ID from a seed (article URL / sourceKey).
 * Same seed → same ID across server restarts → Supabase history survives reboots.
 * Format: 8-4-4-4-12 hex (UUID v5-ish, NOT RFC-compliant but fine as a DB key).
 */
function deterministicDebateId(seed) {
  const h = crypto.createHash('sha1').update(String(seed || '')).digest('hex');
  return h.slice(0,8) + '-' + h.slice(8,12) + '-5' + h.slice(13,16) + '-' + h.slice(16,20) + '-' + h.slice(20,32);
}

function seededRange(seed, min, max) {
  const value = hashNumber(seed);
  return min + (value % (max - min + 1));
}

function clampDurationMs(value) {
  return Math.max(MIN_DEBATE_DURATION_MS, Math.min(MAX_DEBATE_DURATION_MS, Number(value) || DEFAULT_DURATION_MS));
}

function resolveDebateDurationMs(pool, explicitDurationMs) {
  const explicit = Number(explicitDurationMs);
  if (Number.isFinite(explicit) && explicit > 0) {
    return clampDurationMs(explicit);
  }

  const amount = Number(pool) || 0;
  if (amount >= 160000) return 5 * 60 * 60 * 1000;
  if (amount >= 120000) return 4 * 60 * 60 * 1000;
  if (amount >= 85000) return 3 * 60 * 60 * 1000;
  if (amount >= 50000) return 2 * 60 * 60 * 1000;
  if (amount >= 20000) return 60 * 60 * 1000;
  return MIN_DEBATE_DURATION_MS;
}

function buildDescription(item) {
  const sourceName = item.domain ? item.domain.replace(/^www\./, '') : item.sourceFeedLabel || 'news source';
  const headline = cleanHeadline(item.sourceTitle);
  return `Auto-generated from recent coverage on ${sourceName}: ${headline}.`;
}

function buildSourceExcerpt(item) {
  const excerpt = normalizeWhitespace(item.sourceDescription);
  if (!excerpt) return '';
  return excerpt.length > 220 ? `${excerpt.slice(0, 217).trim()}...` : excerpt;
}

/**
 * Extract a short time reference from a headline/description.
 * Returns strings like "tonight", "this Saturday", "at the summit", etc.
 * Returns '' if nothing specific is found.
 */
function extractTimeRef(text) {
  const t = String(text || '').toLowerCase();

  const patterns = [
    // Imminent
    /\b(tonight|this evening|this morning|this afternoon|today)\b/,
    /\b(tomorrow morning|tomorrow night|tomorrow evening|tomorrow)\b/,
    // Day-specific
    /\b(this (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/,
    /\b(on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/,
    // Named events
    /\b(at the summit|at the conference|at the hearing|at the press conference)\b/,
    /\bat (?:the )?(\w+ (?:summit|conference|rally|meeting|congress|forum))\b/,
    // Relative
    /\b(this week|next week|this weekend|next weekend)\b/,
    /\b(in the coming (days|hours|weeks))\b/,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[0].trim();
  }
  return '';
}

// ── Named-entity lookup: maps common lowercase variants to canonical display names ──
const NAMED_ENTITIES = {
  // US Politics
  'trump': 'Trump', 'donald trump': 'Trump',
  'biden': 'Biden', 'joe biden': 'Biden',
  'harris': 'Kamala Harris', 'kamala harris': 'Kamala Harris',
  'desantis': 'DeSantis', 'ron desantis': 'DeSantis',
  'pelosi': 'Pelosi', 'schumer': 'Schumer', 'mcconnell': 'McConnell',
  'rubio': 'Rubio', 'marco rubio': 'Rubio',
  // World leaders
  'macron': 'Macron', 'emmanuel macron': 'Macron',
  'putin': 'Putin', 'vladimir putin': 'Putin',
  'zelensky': 'Zelensky', 'volodymyr zelensky': 'Zelensky',
  'xi': 'Xi Jinping', 'xi jinping': 'Xi Jinping',
  'modi': 'Modi', 'narendra modi': 'Modi',
  'starmer': 'Starmer', 'keir starmer': 'Starmer',
  'scholz': 'Scholz', 'olaf scholz': 'Scholz',
  'meloni': 'Meloni', 'giorgia meloni': 'Meloni',
  'netanyahu': 'Netanyahu', 'benjamin netanyahu': 'Netanyahu',
  'erdogan': 'Erdoğan', 'erdoğan': 'Erdoğan',
  'kim jong un': 'Kim Jong Un', 'kim': 'Kim Jong Un',
  // Tech / Business
  'musk': 'Elon Musk', 'elon musk': 'Elon Musk',
  'altman': 'Sam Altman', 'sam altman': 'Sam Altman',
  'zuckerberg': 'Zuckerberg', 'mark zuckerberg': 'Zuckerberg',
  'pichai': 'Sundar Pichai', 'sundar pichai': 'Sundar Pichai',
  'cook': 'Tim Cook', 'tim cook': 'Tim Cook',
  // Institutions / bodies
  'the fed': 'the Fed', 'federal reserve': 'the Fed', 'fed': 'the Fed',
  'ecb': 'the ECB', 'european central bank': 'the ECB',
  'boe': 'the BoE', 'bank of england': 'the BoE',
  'boj': 'the BoJ', 'bank of japan': 'the BoJ',
  'imf': 'the IMF', 'world bank': 'the World Bank',
  'supreme court': 'the Supreme Court',
  'nato': 'NATO', 'g7': 'the G7', 'g20': 'the G20',
  'congress': 'Congress', 'senate': 'the Senate', 'house': 'the House',
  'eu': 'the EU', 'european union': 'the EU',
  'un': 'the UN', 'united nations': 'the UN',
  // Crypto assets
  'bitcoin': 'Bitcoin', 'btc': 'Bitcoin',
  'ethereum': 'Ethereum', 'eth': 'Ethereum',
  'solana': 'Solana', 'sol': 'Solana',
  'xrp': 'XRP', 'ripple': 'XRP',
  'dogecoin': 'Dogecoin', 'doge': 'Dogecoin',
  'bnb': 'BNB', 'binance coin': 'BNB',
  'cardano': 'Cardano', 'ada': 'Cardano',
};

function resolveNamedEntity(raw) {
  if (!raw) return '';
  const key = String(raw).toLowerCase().trim();
  if (NAMED_ENTITIES[key]) return NAMED_ENTITIES[key];
  // Partial match: check if text contains a known entity key
  for (const [pattern, canonical] of Object.entries(NAMED_ENTITIES)) {
    if (key === pattern || (key.length > 4 && key.includes(pattern))) return canonical;
  }
  return '';
}

/**
 * Extract a price target like "$100k", "$4,000", "$100,000" from text.
 * Returns the formatted string like "100,000" or null.
 */
function extractPriceTarget(text) {
  const m = String(text || '').match(/\$\s*(\d[\d,]*)\s*([km])?(?:\s*(?:billion|million|thousand))?\b/i);
  if (!m) return null;
  let num = Number(m[1].replace(/,/g, ''));
  if (m[2]) {
    if (/k/i.test(m[2])) num *= 1000;
    if (/m/i.test(m[2])) num *= 1000000;
  }
  if (!Number.isFinite(num) || num <= 0) return null;
  return num >= 1000 ? num.toLocaleString('en-US') : String(num);
}

/**
 * Extract a named bill/act/law from a headline.
 * e.g. "Senate votes on the Immigration Reform Act" → "Immigration Reform Act"
 */
function extractBillName(text) {
  const m = String(text || '').match(/\b((?:[A-Z][A-Za-z-]+ ){1,6}(?:Act|Bill|Reform|Law|Amendment|Resolution|Package|Plan|Proposal))\b/);
  return m ? m[1].trim() : null;
}

/**
 * Build a Polymarket-style binary prediction question from a news item.
 *
 * Priority chain (first match wins):
 *  0.  Direct binary question in headline ("Will X …?" → keep)
 *  1.  Crypto price target ("Bitcoin may reach $100k" → "Will Bitcoin reach $100,000 this week?")
 *  2.  Named bill / legislation vote ("Will the [Act] pass Congress?")
 *  3.  Sports match ("A vs B / A face B")
 *  4.  Election / referendum / vote result
 *  5.  Central bank rate decision
 *  6.  Summit / peace talks with named leaders
 *  7.  Earnings / IPO
 *  8.  Court verdict / ruling with named defendant
 *  9.  Named political figure + specific scheduled action
 * 10.  Tech product launch / keynote
 * 11.  Military / geopolitical action
 * 12.  "Set to / expected to / due to + verb"
 * 13.  Approval / passage / signing
 * 14.  Price / market movement
 * 15.  Category-aware fallback using leading entity
 *
 * Returns a question string ending in "?", or null if nothing usable.
 */
function buildQuestion(item) {
  const title = cleanHeadline(item.sourceTitle);
  const desc  = String(item.sourceDescription || '').slice(0, 200);
  const full  = title + ' ' + desc;
  const t     = full.toLowerCase();
  const timeRef    = extractTimeRef(full);
  const timeSuffix = timeRef ? ` ${timeRef}` : '';

  // Reject open-ended journalism questions
  if (/^(How|Why|What|When|Where|Who)\b/i.test(title)) return null;

  // 0. Headline already contains a binary question
  const directQ = title.match(/^(Will|Could|Can|Should|Would)\s+(.+)$/i);
  if (directQ) {
    const body = cleanSegment(directQ[2], 12);
    if (body && body.length > 6) return `Will ${body}?`;
  }

  // 1. Crypto price target — "Bitcoin may reach $100k", "ETH could hit $4,000"
  const cryptoAssets = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'ripple',
                        'dogecoin', 'doge', 'bnb', 'cardano', 'ada', 'crypto'];
  const hasCrypto = cryptoAssets.some(a => t.includes(a));
  if (hasCrypto) {
    const priceTarget = extractPriceTarget(full);
    if (priceTarget) {
      const assetMatch = full.match(/\b(Bitcoin|Ethereum|Solana|XRP|Ripple|Dogecoin|BNB|Cardano|BTC|ETH|SOL|DOGE|ADA)\b/i);
      const asset = assetMatch ? (resolveNamedEntity(assetMatch[1]) || cleanSegment(assetMatch[1], 1)) : 'Bitcoin';
      const th = timeRef ? ` ${timeRef}` : ' by end of month';
      return `Will ${asset} reach $${priceTarget}${th}?`;
    }
  }

  // 2. Named bill / legislation
  const billName = extractBillName(full);
  if (billName) {
    const chamber = /\bsenate\b/i.test(t) ? 'the Senate' :
                    /\bhouse\b/i.test(t)   ? 'the House' :
                    /\bcongress\b/i.test(t) ? 'Congress' : 'Congress';
    if (/\b(votes?|pass(es)?|approve[sd]?|blocks?|rejects?|filibuster|signs?|vetoes?)\b/i.test(t)) {
      return `Will the ${billName} pass ${chamber}?`;
    }
  }

  // 3. Sports match preview
  const vsMatch = title.match(/^(.+?)\s+(?:vs\.?|v\.?|face[s]?|hosts?|takes? on|meet[s]?)\s+(.+?)(?:\s+in\s+(.+))?$/i);
  if (vsMatch && item.category === 'sports') {
    const teamA = cleanSegment(vsMatch[1], 4);
    const teamB = cleanSegment(vsMatch[2], 4);
    const comp  = vsMatch[3] ? ` in ${cleanSegment(vsMatch[3], 4)}` : '';
    if (teamA && teamB) return `Will ${teamA} beat ${teamB}${comp}?`;
  }

  // 4. Election / referendum / vote result
  const elecMatch = title.match(/^(.+?)\s+(wins?|leads?|defeats?|clinches?|secures?)\s+(election|vote|referendum|primary|runoff|seat|majority)\b/i);
  if (elecMatch) {
    const entity = resolveNamedEntity(elecMatch[1]) || cleanSegment(elecMatch[1], 5);
    if (entity) return `Will ${entity} win the ${cleanSegment(elecMatch[3], 3)}?`;
  }
  if (/\b(election|referendum)\b/.test(t)) {
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    if (entity) {
      const geoM    = full.match(/\b(presidential|senate|congressional|gubernatorial|state|primary|general)\s+(election|race|vote|primary)\b/i);
      const elecType = geoM ? `${geoM[1]} ${geoM[2]}` : 'election';
      return `Will ${entity} win the ${elecType}?`;
    }
  }
  if (/\b(vote|ballot|polls?\s+(open|close))\b/.test(t) && /\b(today|tonight|tomorrow|this week)\b/.test(t)) {
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    if (entity) return `Will ${entity} secure enough votes${timeSuffix}?`;
  }

  // 5. Central bank rate decision
  if (/\b(fed|fomc|ecb|bank of england|boe|rba|boj|reserve bank)\b/.test(t) &&
      /\b(rate|rates|cut|hike|raise|hold|decision|meeting|policy)\b/.test(t)) {
    const bank = /\becb\b/.test(t)             ? 'the ECB' :
                 /\bbank of england|boe\b/.test(t) ? 'the BoE' :
                 /\brba\b/.test(t)             ? 'the RBA' :
                 /\bboj\b/.test(t)             ? 'the BoJ' : 'the Fed';
    const action = /\b(cut|lower|reduce)\b/.test(t) ? 'cut rates' :
                   /\b(raise|hike|increase)\b/.test(t) ? 'raise rates' : 'hold rates';
    return `Will ${bank} ${action}${timeSuffix}?`;
  }

  // 6. Summit / peace talks — try to get named leaders
  if (/\b(summit|peace talks?|ceasefire|negotiations?|diplomatic talks?|deal|accord)\b/.test(t) &&
      /\b(set to|expected|scheduled|agreed|hold|meet|sign|reach|forge)\b/.test(t)) {
    const leaderList = ['trump', 'putin', 'zelensky', 'macron', 'xi jinping', 'modi',
                        'netanyahu', 'starmer', 'scholz', 'erdogan'];
    const leaderA = leaderList.find(n => t.includes(n));
    const leaderB = leaderList.filter(n => n !== leaderA).find(n => t.includes(n));
    if (leaderA && leaderB) {
      const a = NAMED_ENTITIES[leaderA] || leaderA;
      const b = NAMED_ENTITIES[leaderB] || leaderB;
      return `Will ${a} and ${b} reach a deal${timeSuffix}?`;
    }
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    if (entity) return `Will ${entity} reach a deal${timeSuffix}?`;
  }

  // 7. Earnings / IPO / financial results
  const earningsMatch = title.match(/^(.+?)\s+(earnings|results|quarterly results|profit|revenue|ipo)\b/i);
  if (earningsMatch) {
    const co   = cleanSegment(earningsMatch[1], 4);
    const type = earningsMatch[2].toLowerCase();
    if (co) {
      if (/ipo/.test(type)) return `Will ${co}'s IPO price above expectations?`;
      return `Will ${co} beat earnings expectations${timeSuffix}?`;
    }
  }

  // 8. Trial / ruling / court verdict — try to get named defendant/party
  if (/\b(trial|verdict|ruling|sentence|acquit|convict|court)\b/.test(t) &&
      /\b(today|tomorrow|this week|expected|scheduled|due|set to)\b/.test(t)) {
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    const courtT = /\bsupreme court\b/i.test(t) ? 'the Supreme Court' :
                   /\bappeals?\s+court\b/i.test(t) ? 'the appeals court' : 'the court';
    // Avoid "Will the Supreme Court prevail in the Supreme Court"
    const entityIsTheCourt = entity && entity.toLowerCase().includes('court');
    if (entity && !entityIsTheCourt) return `Will ${entity} prevail in ${courtT}${timeSuffix}?`;
    return `Will ${courtT} rule in favor of the defense${timeSuffix}?`;
  }

  // 9. Named political figure + specific scheduled action
  const knownLeaders = ['Trump', 'Biden', 'Harris', 'Macron', 'Putin', 'Zelensky',
                        'Xi', 'Modi', 'Netanyahu', 'Starmer', 'Scholz', 'Musk', 'Erdogan'];
  const leaderHit = knownLeaders.find(l => t.includes(l.toLowerCase()));
  if (leaderHit) {
    const leader = NAMED_ENTITIES[leaderHit.toLowerCase()] || leaderHit;
    if (/\b(sign|veto|block|approve|enact)\b/.test(t)) {
      const bn = extractBillName(full);
      if (bn) return `Will ${leader} sign the ${bn}?`;
      return `Will ${leader} sign the bill${timeSuffix}?`;
    }
    if (/\b(announce|unveil|reveal|confirm|declare)\b/.test(t)) {
      const topic = /\b(tariff|sanction|deal|plan|policy|agreement|withdrawal|invasion)\b/i.exec(full)?.[1];
      if (topic) return `Will ${leader} announce new ${topic.toLowerCase()}s${timeSuffix}?`;
      return `Will ${leader} make a major announcement${timeSuffix}?`;
    }
    if (/\b(win|lose|lead|ahead|behind)\b/.test(t) && /\b(election|primary|vote|race)\b/.test(t)) {
      return `Will ${leader} win the election?`;
    }
    if (/\b(testify|appear|address|speak|face)\b/.test(t) && /\b(congress|senate|court|hearing|committee|icc|tribunal)\b/.test(t)) {
      return `Will ${leader} face serious consequences at the hearing${timeSuffix}?`;
    }
  }

  // 10. Tech product launch / keynote / announcement
  // Only match when the subject doesn't contain "set to / due to / expected to"
  const launchMatch = title.match(/^(.+?)\s+(launches?|unveils?|announces?|releases?|debuts?|reveals?|introduces?)\s+(.+)$/i);
  if (launchMatch && !/\b(set|due|expected|poised|likely)\s+to\b/i.test(launchMatch[1])) {
    const co  = cleanSegment(launchMatch[1], 3);
    const obj = cleanSegment(launchMatch[3], 5);
    if (co && obj) return `Will ${possessive(co)} ${obj} be a hit${timeSuffix}?`;
  }
  if (/\b(keynote|wwdc|developer conference|product event|build conference|google i\/o)\b/.test(t)) {
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    if (entity) return `Will ${entity} announce something major at the event?`;
  }

  // 11. Military / geopolitical action
  if (/\b(strike|attack|invasion|offensive|troops?|military|ceasefire|truce)\b/.test(t) &&
      /\b(set to|expected|planned|threat|could|may|imminent)\b/.test(t)) {
    const raw    = extractLeadingEntity(title);
    const entity = resolveNamedEntity(raw) || raw;
    if (entity) return `Will ${entity} take military action${timeSuffix}?`;
  }

  // 12. "Set to / expected to / due to / poised to + verb"
  const setToMatch = title.match(/^(.+?)\s+(?:set|due|expected|poised|likely)\s+to\s+(\w+(?:\s+\w+)?)/i);
  if (setToMatch) {
    const raw  = setToMatch[1];
    const subj = resolveNamedEntity(raw) || cleanSegment(raw, 5);
    const verb = cleanSegment(setToMatch[2], 3);
    if (subj && verb && verb.length > 2) return `Will ${subj} ${verb}${timeSuffix}?`;
  }

  // 13. Approval / passage / signing
  const approvalMatch = title.match(/^(.+?)\s+(approves?|passes?|backs?|blocks?|bans?|signs?|vetoes?)\s+(.+)$/i);
  if (approvalMatch) {
    const obj  = cleanSegment(approvalMatch[3], 6);
    const raw  = approvalMatch[1];
    const subj = resolveNamedEntity(raw) || cleanSegment(raw, 4);
    if (subj && obj) return `Will ${subj} ${approvalMatch[2].toLowerCase()} ${obj}?`;
  }

  // 14. Price / market movement
  const moveMatch = title.match(/^(.+?)\s+(rises?|jumps?|surges?|falls?|slumps?|drops?|soars?|plunges?|hits?)\b/i);
  if (moveMatch) {
    const subj = cleanSegment(moveMatch[1], 4);
    const dir  = /rises?|jumps?|surges?|soars?/.test(moveMatch[2]) ? 'continue rising' : 'keep falling';
    if (subj) return `Will ${subj} ${dir}${timeSuffix}?`;
  }

  // 15. Category-aware fallback using leading named entity
  const raw    = extractLeadingEntity(title);
  const entity = resolveNamedEntity(raw) || raw;
  if (entity) {
    if (item.category === 'sports')     return `Will ${entity} win${timeSuffix}?`;
    if (item.category === 'crypto')     return `Will ${entity} break its all-time high this week?`;
    if (item.category === 'economy')    return `Will ${entity} move the market${timeSuffix}?`;
    if (item.category === 'technology') return `Will ${entity} dominate the headlines this week?`;
    if (item.category === 'politics')   return `Will ${entity} succeed${timeSuffix}?`;
    return `Will ${entity} make headlines${timeSuffix}?`;
  }

  return null;
}


function isUsableQuestion(question) {
  if (!question) return false;
  if (!question.endsWith('?')) return false;
  if (question.length < 25 || question.length > 100) return false;
  if (/^Will (this|it|the move|the story)\b/i.test(question)) return false;
  return true;
}

function buildDebateFromNews(item, options = {}) {
  const title = buildQuestion(item);

  // Controversy is still required
  if (!isControversialNewsItem(item)) {
    return null;
  }

  if (!isUsableQuestion(title)) {
    return null;
  }

  const seed = item.sourceKey || item.titleFingerprint || item.sourceTitle;
  const category = item.category || 'general';
  const gradColors = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
  const yesPct = seededRange(seed, 42, 58);
  const viewers = seededRange(`${seed}:viewers`, 650, 2600);
  const pool = seededRange(`${seed}:pool`, 25, 95) * 1000;
  const durationMs = resolveDebateDurationMs(pool, options.durationMs);
  const openedAt = Date.now();

  const imageUrl = resolvePreviewImage(item);
  const contextVideoUrl = normalizeWhitespace(options.contextVideoUrl || buildYouTubeSearchUrl(item));

  return {
    id: deterministicDebateId(item.sourceKey || item.sourceUrl || item.sourceTitle),
    title,
    description: buildDescription(item),
    sourceExcerpt: buildSourceExcerpt(item),
    sourceDescription: normalizeWhitespace(item.sourceDescription),
    sourceImageUrl: imageUrl,
    photo: imageUrl,
    previewVideoUrl: contextVideoUrl,
    contextVideoUrl,
    liveVideoId: null,
    liveEmbedUrl: null,
    liveChannel: null,
    createdFromLive: false,
    sourceFeedLabel: item.sourceFeedLabel || '',
    sourceDomain: item.domain || '',
    yesLabel: 'YES',
    noLabel: 'NO',
    sourceUrl: item.sourceUrl,
    sourceTitle: item.sourceTitle,
    sourceKey: item.sourceKey,
    newsPublishedAt: item.publishedAt,
    createdFromNews: true,
    category,
    trending: item.score >= 8,
    ai: /\b(ai|artificial intelligence)\b/i.test(item.sourceTitle),
    yesPct,
    pool,
    viewers,
    gradColors,
    lang: 'en',
    durationMs,
    openedAt,
    endsAt: openedAt + durationMs,
    listed: true,
  };
}

// ─────────────────────────────────────────────────────────────
//  Build a debate from a live YouTube stream
// ─────────────────────────────────────────────────────────────

// Strip common live-stream title prefixes/suffixes so we can build a question.
// e.g. "LIVE | Ukraine War Update | Al Jazeera" -> "Ukraine War Update"
function cleanLiveTitle(rawTitle) {
  return rawTitle
    // Remove emoji (Unicode ranges for misc symbols/pictographs)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '')
    // Remove common live prefixes
    .replace(/^(LIVE\s*[:|-]?|BREAKING\s*[:|-]?|EN\s+DIRECT\s*[:|-]?|DIRECT\s*[:|-]?\s*)/gi, '')
    // Remove trailing channel name after last pipe
    .replace(/\s*[|]\s*[^|]{1,40}$/, '')
    // Remove hashtags
    .replace(/\s*#\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildQuestionFromLiveTitle(rawTitle) {
  const title = cleanHeadline(cleanLiveTitle(rawTitle));
  if (!title || title.length < 5) return null;

  if (/^(How|Why|What|When|Where|Who)\b/i.test(title)) return null;

  const directQ = title.match(/^(Will|Could|Can|Should|Would)\s+(.+)$/i);
  if (directQ) {
    const rem = cleanSegment(directQ[2], 8);
    if (rem) return `Will ${rem}?`;
  }

  const launchM = title.match(/^(.+?)\s+(launches|unveils|announces|releases|debuts)\s+(.+)$/i);
  if (launchM) {
    const owner = possessive(launchM[1]);
    const obj   = cleanSegment(launchM[3], 6);
    if (owner && obj) return `Will ${owner} ${obj} be a success?`;
  }

  const approvalM = title.match(/^(.+?)\s+(approves|passes|backs|blocks|bans|regulates|cuts|raises)\s+(.+)$/i);
  if (approvalM) {
    const obj = cleanSegment(approvalM[3], 7);
    if (obj) return `Will ${obj} have a lasting impact?`;
  }

  const moveM = title.match(/^(.+?)\s+(rises|jumps|surges|falls|slumps|drops|soars|plunges)\b/i);
  if (moveM) {
    const subj = cleanSegment(moveM[1], 5);
    if (subj) return `Will ${subj} keep moving this way?`;
  }

  if (/\b(bitcoin|ethereum|crypto|etf)\b/i.test(title)) {
    const subj = cleanSegment(title.match(/\b(Bitcoin|Ethereum|crypto ETF|crypto)\b/i)?.[1] || 'crypto', 4);
    if (subj) return `Will ${subj} keep the momentum?`;
  }

  if (/\b(election|poll|campaign|vote)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} come out on top?`;
  }

  if (/\b(war|conflict|attack|crisis|ceasefire|invasion)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} resolve this conflict?`;
    return 'Will this conflict reach a resolution?';
  }

  if (/\b(tariff|inflation|interest rates?|recession|market|earnings|layoffs?)\b/i.test(title)) {
    const subj = extractLeadingEntity(title) || 'markets';
    return `Will ${subj} move the market?`;
  }

  if (/\b(deal|agreement|summit|talks|negotiat)\b/i.test(title)) {
    const subj = extractLeadingEntity(title);
    if (subj) return `Will ${subj} reach a deal?`;
  }

  if (/\b(ai|artificial intelligence|chatgpt|openai|gemini)\b/i.test(title)) {
    const subj = extractLeadingEntity(title) || 'AI';
    if (subj) return `Will ${subj} reshape the industry?`;
  }

  const entity = extractLeadingEntity(title);
  if (entity && entity.length > 3) return `Will ${entity} change the course of events?`;

  return null;
}

function buildDebateFromLiveStream(streamItem, options = {}) {
  const title      = buildQuestionFromLiveTitle(streamItem.title);

  if (!isUsableQuestion(title)) return null;

  const seed       = streamItem.videoId;
  const category   = streamItem.category || 'general';
  const gradColors = CATEGORY_STYLES[category] || CATEGORY_STYLES.general;
  const yesPct     = seededRange(seed, 42, 58);
  const viewers    = seededRange(`${seed}:viewers`, 650, 2600);
  const pool       = seededRange(`${seed}:pool`, 25, 95) * 1000;
  const durationMs = resolveDebateDurationMs(pool, options.durationMs);
  const openedAt   = Date.now();

  const channelLabel = streamItem.channelTitle || streamItem.channelHandle;
  const thumbnail    = streamItem.thumbnailUrl
    || `https://i.ytimg.com/vi/${streamItem.videoId}/maxresdefault.jpg`;

  return {
    id: deterministicDebateId('yt-live-' + streamItem.videoId),
    title,
    description     : `Debate from live stream: ${channelLabel} - "${streamItem.title}"`,
    sourceExcerpt   : streamItem.title,
    sourceDescription: streamItem.title,
    sourceImageUrl  : thumbnail,
    previewVideoUrl : streamItem.embedUrl,
    contextVideoUrl : streamItem.embedUrl,
    sourceFeedLabel : channelLabel,
    sourceDomain    : 'youtube.com',
    yesLabel        : 'YES',
    noLabel         : 'NO',
    sourceUrl       : streamItem.sourceUrl,
    sourceTitle     : streamItem.title,
    sourceKey       : `yt-live-${streamItem.videoId}`,
    newsPublishedAt : new Date().toISOString(),
    createdFromNews : true,
    createdFromLive : true,
    category,
    trending        : false,
    ai              : /\b(ai|artificial intelligence|chatgpt|openai|gemini)\b/i.test(streamItem.title),
    yesPct,
    pool,
    viewers,
    gradColors,
    lang            : streamItem.lang || 'en',
    photo           : thumbnail,
    durationMs,
    openedAt,
    endsAt          : openedAt + durationMs,
    listed          : true,
    liveVideoId     : streamItem.videoId,
    liveEmbedUrl    : streamItem.embedUrl,
    liveChannel     : streamItem.channelHandle,
  };
}

module.exports = {
  DEFAULT_DURATION_MS,
  MAX_DEBATE_DURATION_MS,
  MIN_DEBATE_DURATION_MS,
  buildDebateFromNews,
  buildDebateFromLiveStream,
  resolveDebateDurationMs,
};
