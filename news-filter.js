const MIN_SCORE = Math.max(4, Number(process.env.NEWS_MIN_SCORE) || 6);
const MAX_AGE_HOURS = Math.max(6, Number(process.env.NEWS_MAX_AGE_HOURS) || 36);

const TITLE_BLOCKLIST = [
  /^(how|why|what|when|where|who)\b/i,
  /\blive\b/i,
  /\blive updates?\b/i,
  /\bminute-by-minute\b/i,
  /\bwatch\b/i,
  /\bpodcast\b/i,
  /\bnewsletter\b/i,
  /\bobituary\b/i,
  /\bphotos?\b/i,
  /\bgallery\b/i,
  /\bquiz\b/i,
  /\breview\b/i,
  /\bhow to\b/i,
  /\bexplained\b/i,
];

const TOPIC_KEYWORDS = [
  /\bwill\b/i,
  /\bcould\b/i,
  /\bmay\b/i,
  /\bmight\b/i,
  /\bshould\b/i,
  /\blaunch(?:es|ed)?\b/i,
  /\bunveil(?:s|ed)?\b/i,
  /\bannounce(?:s|d)?\b/i,
  /\bapprove(?:s|d)?\b/i,
  /\bban(?:s|ned)?\b/i,
  /\bblock(?:s|ed)?\b/i,
  /\bregulat(?:e|es|ed|ion)\b/i,
  /\belection\b/i,
  /\bpolls?\b/i,
  /\bvote\b/i,
  /\bcampaign\b/i,
  /\bmerger\b/i,
  /\bacquisition\b/i,
  /\bearnings\b/i,
  /\btariff\b/i,
  /\binflation\b/i,
  /\brates?\b/i,
  /\bbitcoin\b/i,
  /\bethereum\b/i,
  /\bcrypto\b/i,
  /\bplayoff\b/i,
  /\bfinal\b/i,
  /\bchampionship\b/i,
  /\btitle race\b/i,
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will',
  'with', 'after', 'amid', 'over', 'under', 'than', 'about', 'against', 'new', 'says', 'say',
]);

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fingerprintTitle(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token))
    .slice(0, 10)
    .join(' ');
}

function isMostlyResolvedHeadline(title) {
  return /\b(dead|dies|died|sentenced|convicted|rescued|killed)\b/i.test(title);
}

function ageHours(publishedAt) {
  if (!publishedAt) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return (Date.now() - timestamp) / 3_600_000;
}

function scoreNewsItem(item) {
  let score = 0;
  const title = item.sourceTitle || '';
  const normalizedAge = ageHours(item.publishedAt);

  if (item.trustedDomain) score += 3;
  if (normalizedAge <= 12) score += 3;
  else if (normalizedAge <= 24) score += 2;
  else if (normalizedAge <= MAX_AGE_HOURS) score += 1;

  if (title.length >= 35 && title.length <= 110) score += 1;
  if (item.sourceDescription) score += 1;
  if (['technology', 'economy', 'politics', 'crypto', 'sports', 'society', 'culture'].includes(item.category)) {
    score += 1;
  }

  TOPIC_KEYWORDS.forEach(pattern => {
    if (pattern.test(title)) {
      score += 1;
    }
  });

  if (/\bvs\b/i.test(title)) score += 1;
  if (/\?/.test(title)) score += 1;
  if (isMostlyResolvedHeadline(title)) score -= 2;

  return score;
}

function filterNewsItems(items, options = {}) {
  const {
    existingSourceKeys = [],
    existingTitleFingerprints = [],
    usedSourceKeys = [],
    usedTitleFingerprints = [],
  } = options;

  const seenSourceKeys = new Set(existingSourceKeys.map(value => String(value || '').toLowerCase()));
  const seenFingerprints = new Set(existingTitleFingerprints.map(value => String(value || '')));
  const alreadyUsedSources = new Set(usedSourceKeys.map(value => String(value || '').toLowerCase()));
  const alreadyUsedFingerprints = new Set(usedTitleFingerprints.map(value => String(value || '')));
  const keptFingerprints = new Set();

  return items
    .map(item => {
      const titleFingerprint = fingerprintTitle(item.sourceTitle);
      const score = scoreNewsItem(item);
      return {
        ...item,
        titleFingerprint,
        score,
      };
    })
    .filter(item => {
      const title = item.sourceTitle || '';
      if (!item.sourceUrl || !item.sourceKey || !item.titleFingerprint) return false;
      if (!item.trustedDomain) return false;
      if (ageHours(item.publishedAt) > MAX_AGE_HOURS) return false;
      if (title.length < 25 || title.length > 140) return false;
      if (TITLE_BLOCKLIST.some(pattern => pattern.test(title))) return false;
      if (isMostlyResolvedHeadline(title)) return false;
      if (seenSourceKeys.has(item.sourceKey) || alreadyUsedSources.has(item.sourceKey)) return false;
      if (seenFingerprints.has(item.titleFingerprint) || alreadyUsedFingerprints.has(item.titleFingerprint)) return false;
      if (keptFingerprints.has(item.titleFingerprint)) return false;
      if (item.score < MIN_SCORE) return false;
      keptFingerprints.add(item.titleFingerprint);
      return true;
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
      const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
      return rightTime - leftTime;
    });
}

module.exports = {
  filterNewsItems,
  fingerprintTitle,
};
