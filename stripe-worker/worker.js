/**
 * Cloudflare Worker — Stripe backend para el kiosco Carl's Jr
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const { action, amountCents, currency, description } = body;

    if (action !== 'create_intent') {
      return json({ error: 'Unknown action' }, 400);
    }

    const stripeKey = (env.STRIPE_SECRET_KEY || '').trim();
    if (!stripeKey) {
      return json({ error: 'STRIPE_SECRET_KEY not configured' }, 500);
    }

    const cents = Math.round(Number(amountCents));
    if (!cents || cents < 50) {
      return json({ error: 'amount_cents must be >= 50' }, 400);
    }

    const bodyStr = [
      `amount=${cents}`,
      `currency=${encodeURIComponent(currency || 'eur')}`,
      `description=${encodeURIComponent(description || "Carl's Jr — Pedido kiosco")}`,
      `payment_method_types[]=card`,
    ].join('&');

    let stripeRes, stripeText;
    try {
      stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
        method:  'POST',
        headers: {
          Authorization:  'Bearer ' + stripeKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyStr,
      });
      stripeText = await stripeRes.text();
    } catch (e) {
      return json({ error: 'Stripe network error: ' + e.message }, 502);
    }

    if (!stripeText) {
      return json({ error: 'Stripe empty response', status: stripeRes.status }, 502);
    }

    let stripeData;
    try {
      stripeData = JSON.parse(stripeText);
    } catch (e) {
      return json({ error: 'Stripe invalid JSON' }, 502);
    }

    if (!stripeRes.ok) {
      return json({ error: stripeData.error?.message || 'Stripe error' }, 502);
    }

    return json({ clientSecret: stripeData.client_secret });
  },
};
