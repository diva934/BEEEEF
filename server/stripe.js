// ──────────────────────────────────────────────────────────────────
//  Stripe Checkout + webhook handler
//  Deps: stripe (npm i stripe)
//  Env required:
//    STRIPE_SECRET_KEY           Secret key (sk_test_... or sk_live_...)
//    STRIPE_WEBHOOK_SECRET       Webhook signing secret (whsec_...)
//    STRIPE_SUCCESS_URL          Redirect after success (e.g. https://beeeef.vercel.app/?paid=ok)
//    STRIPE_CANCEL_URL           Redirect if user cancels
// ──────────────────────────────────────────────────────────────────

const STRIPE_PACKS = [
  { id: 'pack_starter', name: 'Starter', points: 500,   bonus: 0,    priceCents: 299,  label: '500 PTS'    },
  { id: 'pack_popular', name: 'Popular', points: 1500,  bonus: 100,  priceCents: 799,  label: '1 500 PTS', popular: true },
  { id: 'pack_pro',     name: 'Pro',     points: 5000,  bonus: 500,  priceCents: 1999, label: '5 000 PTS'  },
  { id: 'pack_whale',   name: 'Whale',   points: 15000, bonus: 2000, priceCents: 4999, label: '15 000 PTS' },
];

function getPackById(id) {
  return STRIPE_PACKS.find(p => p.id === id) || null;
}

let _stripe = null;
function getStripeClient() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require('stripe');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    return _stripe;
  } catch (err) {
    console.warn('[stripe] stripe SDK not installed yet, run `npm install`');
    return null;
  }
}

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function listPacks() {
  return STRIPE_PACKS.map(p => ({
    id: p.id,
    points: p.points,
    priceCents: p.priceCents,
    priceEur: (p.priceCents / 100).toFixed(2),
    bonus: p.bonus,
    popular: !!p.popular,
    label: p.label,
  }));
}

async function createCheckoutSession({ packId, authUser, successUrl, cancelUrl }) {
  const pack = getPackById(packId);
  if (!pack) {
    const err = new Error('Pack inconnu');
    err.status = 400;
    throw err;
  }

  const stripe = getStripeClient();
  if (!stripe) {
    const err = new Error('Stripe non configuré sur le serveur (STRIPE_SECRET_KEY manquante)');
    err.status = 503;
    throw err;
  }

  const userId = authUser && authUser.id ? authUser.id : null;
  const userEmail = authUser && authUser.email ? authUser.email : undefined;
  const totalPoints = pack.points + (pack.bonus || 0);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: userEmail,
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: pack.priceCents,
        product_data: {
          name: `BEEEF · Pack ${pack.name}`,
          description: pack.bonus > 0
            ? `${pack.points.toLocaleString('fr-FR')} tokens + ${pack.bonus.toLocaleString('fr-FR')} bonus offerts`
            : `${pack.points.toLocaleString('fr-FR')} tokens`,
        },
      },
      quantity: 1,
    }],
    metadata: {
      userId: userId || '',
      packId: pack.id,
      points: String(totalPoints),
    },
    success_url: successUrl || process.env.STRIPE_SUCCESS_URL || 'https://beeeef.vercel.app/?paid=ok&session={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl || process.env.STRIPE_CANCEL_URL || 'https://beeeef.vercel.app/?paid=cancel',
  });

  return {
    id: session.id,
    url: session.url,
    packId: pack.id,
    points: totalPoints,
    priceCents: pack.priceCents,
  };
}

// Verify webhook signature; returns the parsed Stripe event or throws
function constructWebhookEvent(rawBody, signatureHeader) {
  const stripe = getStripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    const err = new Error('Webhook non configuré');
    err.status = 503;
    throw err;
  }
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

// Parse relevant info out of a Stripe event.
// Returns a credit intent for checkout.session.completed only.
// payment_intent events carry no metadata — skip them silently.
function extractCreditIntent(event) {
  if (!event) return null;
  if (event.type !== 'checkout.session.completed') return null;

  const session = event.data && event.data.object ? event.data.object : {};
  // Only credit when payment is confirmed
  if (session.payment_status && session.payment_status !== 'paid') return null;

  const metadata = session.metadata || {};
  const points = Number(metadata.points || 0);
  const userId = metadata.userId || '';
  if (!Number.isFinite(points) || points <= 0) return null;

  return {
    userId,
    points,
    packId: metadata.packId || '',
    sessionId: session.id,
    paymentIntentId: session.payment_intent || '',
    amountPaidCents: session.amount_total || 0,
    email: (session.customer_details && session.customer_details.email) || '',
  };
}

module.exports = {
  STRIPE_PACKS,
  getPackById,
  isConfigured,
  listPacks,
  createCheckoutSession,
  constructWebhookEvent,
  extractCreditIntent,
};
