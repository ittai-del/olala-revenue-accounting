/**
 * OLALA! — Review Alert System  |  v1.0
 * ─────────────────────────────────────
 * Pulls new reviews from Guesty (all countries)
 * Flags reviews below threshold
 * Sends alerts via Slack
 * Stores all reviews in Supabase
 *
 * Required env vars:
 *   GUESTY_CLIENT_ID
 *   GUESTY_CLIENT_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   REVIEW_ALERT_THRESHOLD     (default: 4)
 */

'use strict';

// ── GUESTY AUTH ───────────────────────────────────────────────
let _tok = null;
async function getToken() {
  if (_tok && _tok.exp > Date.now() + 60000) return _tok.v;
  const r = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      scope:         'open-api',
      client_id:     process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Auth HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  _tok = { v: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return _tok.v;
}

// ── SUPABASE ──────────────────────────────────────────────────
class Supabase {
  constructor(url, key) { this.url = url; this.key = key; }
  async query(path) {
    const r = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { 'apikey': this.key, 'Authorization': `Bearer ${this.key}` }
    });
    if (!r.ok) throw new Error(`DB ${r.status}: ${await r.text()}`);
    return r.json();
  }
  async upsert(table, rows) {
    const r = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': this.key, 'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(`Upsert ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

// ── FETCH REVIEWS FROM GUESTY ─────────────────────────────────
async function fetchReviews(token, since) {
  const reviews = [];
  let skip = 0;
  const limit = 100;
  
  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      skip: String(skip),
      sort: '-submittedAt',
    });
    if (since) params.set('filters', JSON.stringify([
      { field: 'submittedAt', operator: '$gte', value: since }
    ]));

    const r = await fetch(`https://open-api.guesty.com/v1/reviews?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error(`Reviews HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const batch = d.results || d.data || [];
    reviews.push(...batch);
    console.log(`   Fetched ${reviews.length} reviews...`);
    if (batch.length < limit) break;
    skip += limit;
  }
  return reviews;
}

// ── FETCH LISTING DETAILS ─────────────────────────────────────
async function fetchListing(token, listingId) {
  try {
    const r = await fetch(`https://open-api.guesty.com/v1/listings/${listingId}?fields=nickname,title,address`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ── FORMAT REVIEW ─────────────────────────────────────────────
function formatReview(review, listing) {
  const name = listing?.nickname || listing?.title || review.listingId || 'Unknown property';
  const city = listing?.address?.city || '—';
  const score = review.ratings?.overall ?? review.score ?? review.rating ?? '?';
  const stars = '★'.repeat(Math.floor(score)) + '☆'.repeat(5 - Math.floor(score));
  const text = review.publicReview || review.reviewText || review.comment || '(no comment)';
  const guest = review.guestName || review.guest?.fullName || 'Guest';
  const date = review.submittedAt ? new Date(review.submittedAt).toLocaleDateString('en-GB') : '—';
  return { name, city, score, stars, text, guest, date };
}

// ── SLACK WEBHOOK ─────────────────────────────────────────────
const SLACK_WEBHOOK = 'https://hooks.slack.com/services/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';


async function sendSlack(review, listing) {
  const { name, city, score, stars, text, guest, date } = formatReview(review, listing);
  const threshold = Number(process.env.REVIEW_ALERT_THRESHOLD || 4);
  const color = score <= 2 ? '#e03e3e' : score <= 3 ? '#d97706' : '#dfab01';

  const payload = {
    text: `🚨 Low review alert — *${name}* got ${score}/5`,
    attachments: [{
      color,
      blocks: [
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Property*\n${name}` },
            { type: 'mrkdwn', text: `*City*\n${city}` },
            { type: 'mrkdwn', text: `*Score*\n${stars} ${score}/5` },
            { type: 'mrkdwn', text: `*Guest*\n${guest} · ${date}` },
          ]
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `_"${text.slice(0, 500)}${text.length > 500 ? '...' : ''}"_` }
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `⚠️ Below ${threshold} star threshold · Olala! Review Alert System` }]
        }
      ]
    }]
  };

  try {
    const r = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.ok) console.log(`   ✅ Slack alert sent`);
    else console.log(`   ❌ Slack failed: ${r.status}`);
  } catch (e) {
    console.log(`   ❌ Slack error: ${e.message}`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀  Olala! Review Alert System  |  v1.0\n');

  const required = ['GUESTY_CLIENT_ID','GUESTY_CLIENT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('❌ Missing env vars:', missing.join(', ')); process.exit(1); }

  const db = new Supabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const threshold = Number(process.env.REVIEW_ALERT_THRESHOLD || 4);

  // Get last run time to only fetch new reviews
  let since = null;
  try {
    const lastRun = await db.query('review_runs?order=created_at.desc&limit=1');
    if (lastRun.length) since = lastRun[0].created_at;
  } catch {
    console.log('   No previous run found — fetching last 30 days');
    const d = new Date(); d.setDate(d.getDate() - 30);
    since = d.toISOString();
  }

  console.log(`📅 Fetching reviews since: ${since || 'all time'}`);

  // Auth
  console.log('🔑 Authenticating with Guesty...');
  const token = await getToken();
  console.log('   ✅ Authenticated');

  // Fetch reviews
  console.log('⭐ Fetching reviews...');
  const reviews = await fetchReviews(token, since);
  console.log(`   Found ${reviews.length} reviews`);

  if (!reviews.length) {
    console.log('   No new reviews since last run');
    await db.upsert('review_runs', [{ reviews_fetched: 0, alerts_sent: 0, created_at: new Date().toISOString() }]);
    return;
  }

  // Process reviews
  let alertCount = 0;
  const reviewRows = [];

  for (const review of reviews) {
    const score = review.ratings?.overall ?? review.score ?? review.rating ?? null;
    
    // Fetch listing details (cache to avoid re-fetching same listing)
    let listing = null;
    if (review.listingId) {
      listing = await fetchListing(token, review.listingId);
    }

    const { name, city } = formatReview(review, listing);

    reviewRows.push({
      guesty_review_id: review._id || review.id,
      listing_id: review.listingId,
      listing_name: name,
      city,
      score,
      guest_name: review.guestName || review.guest?.fullName || null,
      review_text: review.publicReview || review.reviewText || review.comment || null,
      submitted_at: review.submittedAt || null,
      platform: review.source || review.channel || null,
      alerted: score !== null && score < threshold,
    });

    // Send alerts for low reviews
    if (score !== null && score < threshold) {
      console.log(`\n🚨 Low review: ${name} — ${score}/5`);
      alertCount++;

      if (process.env.SLACK_WEBHOOK_URL || SLACK_WEBHOOK) {
        await sendSlack(review, listing);
      }
    }
  }

  // Save to Supabase
  console.log(`\n💾 Saving ${reviewRows.length} reviews to Supabase...`);
  await db.upsert('reviews', reviewRows);
  await db.upsert('review_runs', [{ 
    reviews_fetched: reviews.length, 
    alerts_sent: alertCount, 
    created_at: new Date().toISOString() 
  }]);

  console.log('\n══════════════════════════════════════════');
  console.log('  OLALA! Review Alert System — Complete');
  console.log(`  Reviews fetched  : ${reviews.length}`);
  console.log(`  Low score alerts : ${alertCount}`);
  console.log(`  Threshold        : < ${threshold} stars`);
  console.log('══════════════════════════════════════════\n');
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
