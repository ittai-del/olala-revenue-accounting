/**
 * OLALA! — Review Intelligence System  |  v2.0
 * ─────────────────────────────────────────────
 * Pulls reviews from Guesty (all channels, all countries)
 * Captures overall score + all 6 Airbnb sub-scores
 * Caches listing details to minimise API calls
 * Full historical backfill on first run
 * Sends Slack alerts for reviews below threshold
 * Stores everything in Supabase
 *
 * Required env vars:
 *   GUESTY_CLIENT_ID
 *   GUESTY_CLIENT_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   SLACK_WEBHOOK_URL
 *   REVIEW_ALERT_THRESHOLD     (default: 4)
 *   BACKFILL_DAYS              (default: 730 = 2 years, only used on first ever run)
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
    if (!rows.length) return [];
    const r = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': this.key, 'Authorization': `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(rows)
    });
    if (!r.ok) throw new Error(`Upsert ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

// ── LISTING CACHE ─────────────────────────────────────────────
const listingCache = new Map();

async function fetchListing(token, listingId) {
  if (!listingId) return null;
  if (listingCache.has(listingId)) return listingCache.get(listingId);
  try {
    const r = await fetch(
      `https://open-api.guesty.com/v1/listings/${listingId}?fields=nickname,title,address,bedrooms,bathrooms`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } }
    );
    if (!r.ok) { listingCache.set(listingId, null); return null; }
    const data = await r.json();
    listingCache.set(listingId, data);
    return data;
  } catch {
    listingCache.set(listingId, null);
    return null;
  }
}

// ── FETCH ALL REVIEWS (paginated) ─────────────────────────────
async function fetchReviews(token, since) {
  const reviews = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      skip:  String(skip),
    });

    // Filter by date if provided
    if (since) {
      params.set('submittedAt[$gte]', since);
    }

    const r = await fetch(`https://open-api.guesty.com/v1/reviews?${params}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error(`Reviews HTTP ${r.status}: ${await r.text()}`);

    const d = await r.json();
    const batch = d.results || d.data || [];
    reviews.push(...batch);

    console.log(`   Fetched ${reviews.length} reviews so far...`);

    if (batch.length < limit) break;
    skip += limit;

    // Small delay to avoid rate limiting on large backfills
    await new Promise(res => setTimeout(res, 200));
  }

  return reviews;
}

// ── EXTRACT SUB-SCORES ────────────────────────────────────────
function extractSubScores(review) {
  const r = review.ratings || review.scores || {};
  return {
    score_cleanliness:   r.cleanliness   ?? r.Cleanliness   ?? null,
    score_accuracy:      r.accuracy      ?? r.Accuracy      ?? null,
    score_checkin:       r.checkIn       ?? r.checkin       ?? r.check_in ?? null,
    score_communication: r.communication ?? r.Communication ?? null,
    score_location:      r.location      ?? r.Location      ?? null,
    score_value:         r.value         ?? r.Value         ?? null,
  };
}

// ── BUILD REVIEW ROW ──────────────────────────────────────────
function buildReviewRow(review, listing, threshold) {
  const name    = listing?.nickname || listing?.title || review.listingId || 'Unknown';
  const city    = listing?.address?.city || '—';
  const country = listing?.address?.country || listing?.address?.countryCode || '—';
  const score   = review.ratings?.overall ?? review.score ?? review.rating ?? null;
  const subScores = extractSubScores(review);

  return {
    guesty_review_id:    review._id || review.id,
    listing_id:          review.listingId || null,
    listing_name:        name,
    city,
    country,
    score,
    ...subScores,
    guest_name:          review.guestName || review.guest?.fullName || null,
    review_text:         review.publicReview || review.reviewText || review.comment || null,
    host_response:       review.response || review.hostResponse || null,
    submitted_at:        review.submittedAt || null,
    platform:            review.source || review.channel || review.platform || null,
    alerted:             score !== null && score < threshold,
  };
}

// ── SLACK ALERT ───────────────────────────────────────────────
async function sendSlack(row, threshold) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return;

  const score = row.score ?? '?';
  const stars = score !== '?' ? '★'.repeat(Math.floor(score)) + '☆'.repeat(5 - Math.floor(score)) : '?????';
  const color = score <= 2 ? '#e03e3e' : score <= 3 ? '#d97706' : '#dfab01';
  const date  = row.submitted_at ? new Date(row.submitted_at).toLocaleDateString('en-GB') : '—';
  const text  = (row.review_text || '(no comment)').slice(0, 500);

  // Sub-score breakdown line
  const subs = [];
  if (row.score_cleanliness)   subs.push(`🧹 ${row.score_cleanliness}`);
  if (row.score_accuracy)      subs.push(`📋 ${row.score_accuracy}`);
  if (row.score_checkin)       subs.push(`🔑 ${row.score_checkin}`);
  if (row.score_communication) subs.push(`💬 ${row.score_communication}`);
  if (row.score_location)      subs.push(`📍 ${row.score_location}`);
  if (row.score_value)         subs.push(`💰 ${row.score_value}`);

  const blocks = [
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Property*\n${row.listing_name}` },
        { type: 'mrkdwn', text: `*City*\n${row.city}, ${row.country}` },
        { type: 'mrkdwn', text: `*Overall*\n${stars} *${score}/5*` },
        { type: 'mrkdwn', text: `*Guest*\n${row.guest_name || '—'} · ${date}` },
      ]
    },
    { type: 'section', text: { type: 'mrkdwn', text: `_"${text}"_` } },
  ];

  if (subs.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sub-scores:* ${subs.join('  ·  ')}` }
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `⚠️ Below ${threshold}★ · ${row.platform || 'unknown'} · Olala! Review Intelligence v2` }]
  });

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🚨 Low review — *${row.listing_name}* (${row.city}) got ${score}/5`,
        attachments: [{ color, blocks }]
      })
    });
    if (r.ok) console.log(`   ✅ Slack: ${row.listing_name} (${score}★)`);
    else console.log(`   ❌ Slack failed: ${r.status}`);
  } catch (e) {
    console.log(`   ❌ Slack error: ${e.message}`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀  Olala! Review Intelligence System  |  v2.0\n');

  const required = ['GUESTY_CLIENT_ID','GUESTY_CLIENT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { console.error('❌ Missing env vars:', missing.join(', ')); process.exit(1); }

  const db           = new Supabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const threshold    = Number(process.env.REVIEW_ALERT_THRESHOLD || 4);
  const backfillDays = Number(process.env.BACKFILL_DAYS || 730);

  // ── Determine fetch window ──────────────────────────────────
  let since      = null;
  let isFirstRun = false;

  try {
    const lastRun = await db.query('review_runs?order=created_at.desc&limit=1');
    if (lastRun.length) {
      since = lastRun[0].created_at;
      console.log(`📅 Incremental run — fetching since: ${since}`);
    } else {
      isFirstRun = true;
    }
  } catch {
    isFirstRun = true;
  }

  if (isFirstRun) {
    const d = new Date();
    d.setDate(d.getDate() - backfillDays);
    since = d.toISOString();
    console.log(`📅 First run — backfilling ${backfillDays} days (since ${since.slice(0,10)})`);
  }

  // ── Auth ────────────────────────────────────────────────────
  console.log('🔑 Authenticating with Guesty...');
  const token = await getToken();
  console.log('   ✅ Authenticated\n');

  // ── Fetch reviews ───────────────────────────────────────────
  console.log('⭐ Fetching reviews...');
  const reviews = await fetchReviews(token, since);
  console.log(`   ✅ ${reviews.length} reviews found\n`);

  if (!reviews.length) {
    console.log('   No new reviews since last run ✓');
    await db.upsert('review_runs', [{
      reviews_fetched: 0, alerts_sent: 0,
      created_at: new Date().toISOString()
    }]);
    return;
  }

  // ── Log raw structure of first review (helps debug field names) ──
  if (isFirstRun && reviews.length) {
    console.log('🔍 Sample review structure (first review):');
    console.log(JSON.stringify(reviews[0], null, 2).slice(0, 800));
    console.log('...\n');
  }

  // ── Process reviews ─────────────────────────────────────────
  console.log('🏠 Processing reviews & fetching listing details...');
  let alertCount = 0;
  const reviewRows = [];

  for (let i = 0; i < reviews.length; i++) {
    const review  = reviews[i];
    const listing = await fetchListing(token, review.listingId);
    const row     = buildReviewRow(review, listing, threshold);
    reviewRows.push(row);

    if ((i + 1) % 50 === 0 || i === reviews.length - 1) {
      console.log(`   Processed ${i + 1}/${reviews.length} · Cache: ${listingCache.size} listings`);
    }

    if (row.score !== null && row.score < threshold) {
      alertCount++;
      await sendSlack(row, threshold);
    }
  }

  // ── Save to Supabase in batches ─────────────────────────────
  console.log(`\n💾 Saving to Supabase...`);
  const batchSize = 500;
  for (let i = 0; i < reviewRows.length; i += batchSize) {
    await db.upsert('reviews', reviewRows.slice(i, i + batchSize));
    console.log(`   Saved ${Math.min(i + batchSize, reviewRows.length)}/${reviewRows.length}`);
  }

  // ── Log run ─────────────────────────────────────────────────
  await db.upsert('review_runs', [{
    reviews_fetched: reviews.length,
    alerts_sent:     alertCount,
    created_at:      new Date().toISOString()
  }]);

  // ── Platform breakdown ──────────────────────────────────────
  const byPlatform = {};
  reviewRows.forEach(r => {
    const p = r.platform || 'unknown';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  });

  console.log('\n══════════════════════════════════════════');
  console.log('  OLALA! Review Intelligence — v2.0 Done');
  console.log(`  Reviews fetched  : ${reviews.length}`);
  console.log(`  Low score alerts : ${alertCount}`);
  console.log(`  Threshold        : < ${threshold}★`);
  console.log(`  Listings cached  : ${listingCache.size}`);
  console.log('  Platforms:');
  Object.entries(byPlatform).sort((a,b) => b[1]-a[1]).forEach(([p, n]) => {
    console.log(`    ${p.padEnd(20)} ${n}`);
  });
  console.log('══════════════════════════════════════════\n');
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
