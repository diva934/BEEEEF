// ─────────────────────────────────────────────────────────────
//  Tremendous — gift card delivery partner
//  Docs: https://developers.tremendous.com/reference
// ─────────────────────────────────────────────────────────────
//
//  Required env vars:
//    TREMENDOUS_API_KEY      — Bearer token from your Tremendous account
//    TREMENDOUS_FUNDING_ID   — Funding source ID (auto-detected if blank)
//    TREMENDOUS_ENV          — "sandbox" (default) or "production"
//
//  Optional product ID overrides (Tremendous catalog IDs):
//    TREMENDOUS_PRODUCT_APPLE
//    TREMENDOUS_PRODUCT_AMAZON
//    TREMENDOUS_PRODUCT_NETFLIX
//    TREMENDOUS_PRODUCT_SPOTIFY
//    TREMENDOUS_PRODUCT_PLAYSTATION
//    TREMENDOUS_PRODUCT_XBOX
//    TREMENDOUS_PRODUCT_EPIC
// ─────────────────────────────────────────────────────────────

const TREMENDOUS_BASE = {
  sandbox:    'https://testflight.tremendous.com/api/v2',
  production: 'https://www.tremendous.com/api/v2',
};

// Tremendous product IDs for EU/FR storefronts.
// These may differ by account — use env overrides if needed.
const DEFAULT_PRODUCT_IDS = {
  apple:        process.env.TREMENDOUS_PRODUCT_APPLE        || 'RNMA',
  amazon:       process.env.TREMENDOUS_PRODUCT_AMAZON       || 'QNQZC',
  netflix:      process.env.TREMENDOUS_PRODUCT_NETFLIX      || 'RTTB',
  spotify:      process.env.TREMENDOUS_PRODUCT_SPOTIFY      || 'SBUH',
  playstation:  process.env.TREMENDOUS_PRODUCT_PLAYSTATION  || 'WDLD',
  xbox:         process.env.TREMENDOUS_PRODUCT_XBOX         || 'WDKD',
  epic:         process.env.TREMENDOUS_PRODUCT_EPIC         || null,  // set via env
};

function isConfigured() {
  return Boolean(String(process.env.TREMENDOUS_API_KEY || '').trim());
}

function getBaseUrl() {
  const env = String(process.env.TREMENDOUS_ENV || 'sandbox').toLowerCase();
  return TREMENDOUS_BASE[env] || TREMENDOUS_BASE.sandbox;
}

async function tremendousFetch(path, options = {}) {
  const apiKey = String(process.env.TREMENDOUS_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('TREMENDOUS_API_KEY manquante — configurez cette variable Railway');
    err.status = 503;
    throw err;
  }

  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    json = { errors: [{ message: text || `HTTP ${res.status}` }] };
  }

  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(`Tremendous: ${msg}`);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    err.tremendous = json;
    throw err;
  }

  return json;
}

// ─────────────────────────────────────────────────────────────
//  Resolve funding source ID
//  Uses TREMENDOUS_FUNDING_ID env if set, otherwise fetches
//  the first "balance" funding source from the account.
// ─────────────────────────────────────────────────────────────
let _fundingIdCache = null;

async function getFundingSourceId() {
  const forced = String(process.env.TREMENDOUS_FUNDING_ID || '').trim();
  if (forced) return forced;

  if (_fundingIdCache) return _fundingIdCache;

  const data = await tremendousFetch('/funding_sources');
  const sources = Array.isArray(data?.funding_sources) ? data.funding_sources : [];
  if (!sources.length) {
    throw new Error('Aucune source de financement Tremendous disponible');
  }
  // Prefer account balance over credit card
  const preferred = sources.find(s => s.method === 'balance') || sources[0];
  _fundingIdCache = preferred.id;
  return _fundingIdCache;
}

// ─────────────────────────────────────────────────────────────
//  Send a gift card
//  Returns { orderId, rewardId, tremendousStatus }
// ─────────────────────────────────────────────────────────────
async function sendGiftCard({ brand, valueEur, recipientEmail, recipientName, idempotencyKey }) {
  const brandKey      = String(brand || '').toLowerCase();
  const productId     = DEFAULT_PRODUCT_IDS[brandKey] || null;
  const fundingId     = await getFundingSourceId();
  const displayName   = recipientName || recipientEmail.split('@')[0] || 'Client BEEEF';

  const orderBody = {
    payment: {
      funding_source_id: fundingId,
    },
    rewards: [
      {
        value: {
          denomination:  valueEur,
          currency_code: 'EUR',
        },
        delivery: {
          method: 'EMAIL',
        },
        recipient: {
          name:  displayName,
          email: recipientEmail,
        },
        ...(productId ? { products: [productId] } : {}),
      },
    ],
  };

  const headers = {};
  if (idempotencyKey) {
    // Tremendous supports idempotency via this header
    headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);
  }

  const data = await tremendousFetch('/orders', {
    method: 'POST',
    body:   JSON.stringify(orderBody),
    headers,
  });

  const order  = data?.order || data;
  const reward = Array.isArray(order?.rewards) ? order.rewards[0] : {};

  console.log(`[tremendous] order created: ${order?.id} — ${brandKey} ${valueEur}€ → ${recipientEmail}`);

  return {
    orderId:           order?.id   || null,
    rewardId:          reward?.id  || null,
    tremendousStatus:  order?.status || 'PENDING',
  };
}

module.exports = { isConfigured, sendGiftCard };
