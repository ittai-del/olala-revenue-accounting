/**
 * ============================================================
 *  OLALA! — Guesty → Supabase + Sage 200 Spain  |  v4.0
 * ============================================================
 *
 *  WHAT IT DOES:
 *    1. Pulls Spain reservations from Guesty API
 *    2. Splits revenue equally per night (integer cents, zero drift)
 *    3. Saves everything to Supabase (reservations, invoice items,
 *       journal lines, run log)
 *    4. Generates Sage 200 CSV (stored in Supabase + local file)
 *
 *  HOW TO RUN:
 *    Daily   (yesterday):     node index.js
 *    Daily   (specific):      node index.js --date 2026-02-25
 *    Monthly (current month): node index.js --month
 *    Monthly (specific):      node index.js --month 2026-01
 *
 *  ENV VARS REQUIRED:
 *    GUESTY_CLIENT_ID
 *    GUESTY_CLIENT_SECRET
 *    SUPABASE_URL            (from Supabase → Settings → API)
 *    SUPABASE_SERVICE_KEY    (from Supabase → Settings → API → service_role key)
 *
 * ============================================================
 *  NOMINAL CODES  ←  REPLACE TODO BEFORE FIRST SAGE IMPORT
 * ============================================================
 */


const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────────────────────
//  NOMINAL CODES
// ─────────────────────────────────────────────────────────────
const NOM = {
  accommodation:  '7000',  // TODO: Ingresos Alojamiento
  cleaning:       '7010',  // TODO: Ingresos Limpieza
  markup:         '7020',  // TODO: Markup / Recargo canal
  cancellation:   '7030',  // TODO: Ingresos Cancelación
  late_checkout:  '7040',  // TODO: Ingresos Late Checkout
  extra_person:   '7050',  // TODO: Ingresos Extra Persona
  parking:        '7060',  // TODO: Ingresos Parking
  pet_fee:        '7070',  // TODO: Ingresos Mascotas
  other_revenue:  '7090',  // TODO: Otros Ingresos
  city_tax:       '4750',  // TODO: Tasa Municipal
  tourist_tax:    '4760',  // TODO: Tasa Turística
  vat:            '4770',  // TODO: IVA Repercutido
  gst:            '4780',  // TODO: GST
  other_tax:      '4790',  // TODO: Otros Impuestos
  channel_fee:    '6200',  // TODO: Comisiones Canal
  resolution:     '6210',  // TODO: Airbnb Resolution Center
  discount:       '6220',  // TODO: Descuentos
  clearing:       '4300',  // TODO: Deudores OTA / Clearing
};

const TYPE_MAP = {
  'AF': NOM.accommodation, 'AFA': NOM.accommodation, 'AFD': NOM.accommodation,
  'AFO': NOM.accommodation, 'AFE': NOM.other_revenue, 'AFWD': NOM.accommodation,
  'AFMD': NOM.accommodation, 'CF': NOM.cleaning, 'MAR': NOM.markup,
  'MARD': NOM.markup, 'CFE': NOM.cancellation, 'EPF': NOM.extra_person,
  'PF': NOM.pet_fee, 'SDC': NOM.other_revenue, 'CM': NOM.channel_fee,
  'PCM': NOM.channel_fee, 'GCD': NOM.discount, 'LOSD': NOM.discount,
  'CO': NOM.discount, 'PRO': NOM.discount, 'ARC': NOM.resolution,
  'TAXD': NOM.vat, 'CT': NOM.city_tax, 'COT': NOM.city_tax, 'LT': NOM.city_tax,
  'OCT': NOM.tourist_tax, 'TOT': NOM.tourist_tax, 'TT': NOM.tourist_tax,
  'VAT': NOM.vat, 'GST': NOM.gst, 'HST': NOM.gst, 'HSHAT': NOM.gst,
  'MAT': NOM.gst, 'ST': NOM.gst, 'TAX': NOM.other_tax, 'AGST': NOM.gst,
};

const SAGE       = { department: 'STR', source: '20' };
const CHANNEL_PFX = {
  airbnb2: 'AIR', 'booking.com': 'BDC', bookingcom: 'BDC',
  manual: 'DIR', manual_reservations: 'DIR',
  homeaway2: 'VBO', homeaway: 'VBO', vrbo: 'VBO',
  expedia: 'EXP', tripadvisor: 'TRP',
};
const CITY_CC = {
  'MADRID': 'SP.MD', 'BARCELONA': 'SP.BC',
  "L'HOSPITALET DE LLOBREGAT": 'SP.BC', 'SANT ADRIÀ DE BESÒS': 'SP.BC',
  'SANT ADRIA DE BESOS': 'SP.BC', 'SEVILLA': 'SP.SE', 'GRANADA': 'SP.GR',
  'VALENCIA': 'SP.VL', 'VIGO': 'SP.VG', 'SALAMANCA': 'SP.SA',
  'SITGES': 'SP.BC', 'CALELLA': 'SP.BC', 'TEIÀ': 'SP.BC',
};

// ─────────────────────────────────────────────────────────────
//  SUPABASE CLIENT  (no SDK needed — plain REST)
// ─────────────────────────────────────────────────────────────
class Supabase {
  constructor(url, key) {
    this.url  = url.replace(/\/$/, '');
    this.key  = key;
    this.headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey':         key,
      'Prefer':        'resolution=merge-duplicates',
    };
  }

  async upsert(table, rows) {
    if (!rows.length) return;
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method:  'POST',
      headers: { ...this.headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase upsert ${table}: ${res.status} ${err}`);
    }
  }

  async insert(table, row) {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method:  'POST',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body:    JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`Supabase insert ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data[0];
  }

  async update(table, id, patch) {
    const res = await fetch(`${this.url}/rest/v1/${table}?id=eq.${id}`, {
      method:  'PATCH',
      headers: this.headers,
      body:    JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`Supabase update ${table}: ${res.status} ${await res.text()}`);
  }

  async deleteWhere(table, field, value) {
    const res = await fetch(`${this.url}/rest/v1/${table}?${field}=eq.${encodeURIComponent(value)}`, {
      method:  'DELETE',
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Supabase delete ${table}: ${res.status} ${await res.text()}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────────
let _tok = { v: null, exp: 0 };

async function getToken() {
  if (_tok.v && Date.now() < _tok.exp - 300_000) return _tok.v;
  console.log('🔑 Authenticating with Guesty...');
  const r = await fetch('https://auth.guesty.com/oauth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`Auth: ${r.status} ${await r.text()}`);
  const d = await r.json();
  _tok = { v: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  console.log('   ✅ Token OK');
  return _tok.v;
}

// ─────────────────────────────────────────────────────────────
//  LISTING MAP
// ─────────────────────────────────────────────────────────────
async function buildListingMap(token) {
  console.log('\n🏠 Building Spain listing map...');
  const map = {};
  let skip = 0;
  while (true) {
    const r = await fetch(
      `https://open-api.guesty.com/v1/listings?fields=_id nickname title address.country address.city&limit=100&skip=${skip}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Listings: ${r.status}`);
    const { results, count } = await r.json();
    for (const l of results) {
      const country = (l.address?.country || '').toUpperCase().trim();
      if (!['ES', 'SPAIN', 'ESPAÑA'].includes(country)) continue;
      const city = (l.address?.city || '').toUpperCase();
      map[l._id] = {
        nickname:   l.nickname || l.title || l._id,
        city,
        costCentre: CITY_CC[city] || 'SP.XX',
      };
    }
    if (skip + results.length >= count || results.length === 0) break;
    skip += 100;
    await sleep(120);
  }
  console.log(`   ✅ ${Object.keys(map).length} Spain properties`);
  return map;
}

// ─────────────────────────────────────────────────────────────
//  FETCH RESERVATIONS
// ─────────────────────────────────────────────────────────────
async function fetchReservations(fromDate, toDate, spainIds, token) {
  console.log(`\n📅 Fetching reservations ${fromDate} → ${toDate}...`);
  const all  = [];
  let   skip = 0;

  const filters = JSON.stringify([
    { operator: '$lt',  field: 'checkInDateLocalized',  value: toDate },
    { operator: '$gt',  field: 'checkOutDateLocalized', value: fromDate },
    { operator: '$in',  field: 'status', value: ['confirmed', 'checked_in', 'checked_out'] },
  ]);

  const fields = [
    '_id', 'confirmationCode', 'listingId',
    'checkInDateLocalized', 'checkOutDateLocalized',
    'status', 'integration.platform', 'integration.guestId',
    'guest.firstName', 'guest.lastName',
    'money',
  ].join(' ');

  while (true) {
    const r = await fetch(
      `https://open-api.guesty.com/v1/reservations`
      + `?filters=${encodeURIComponent(filters)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&limit=100&skip=${skip}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Reservations: ${r.status} ${await r.text()}`);
    const { results, count } = await r.json();
    all.push(...results.filter(r => spainIds.has(r.listingId)));
    console.log(`   ${skip + results.length} / ${count} fetched, ${all.length} Spain`);
    if (skip + results.length >= count || results.length === 0) break;
    skip += 100;
    await sleep(120);
  }

  const deduped = [...new Map(all.map(r => [r._id, r])).values()];
  console.log(`   ✅ ${deduped.length} Spain reservations`);
  return deduped;
}

// ─────────────────────────────────────────────────────────────
//  DATE HELPERS
// ─────────────────────────────────────────────────────────────
function toISO(d)     { return d.toISOString().split('T')[0]; }
function toSage(iso)  { const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function yesterday()  { const d = new Date(); d.setDate(d.getDate()-1); return toISO(d); }

function stayNights(ci, co) {
  const nights = [], cur = new Date(ci), end = new Date(co);
  while (cur < end) { nights.push(toISO(new Date(cur))); cur.setDate(cur.getDate()+1); }
  return nights;
}

// Integer cents — zero rounding drift
function toCents(a)         { return Math.round(a * 100); }
function fromCents(c)       { return c / 100; }
function spreadCents(tc, n) {
  const base = Math.floor(tc / n), rem = tc - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────
//  BUILD JOURNAL LINES + DB ROWS
// ─────────────────────────────────────────────────────────────
function processReservation(reservation, listingMap, targetNights, runId, month) {
  const {
    _id, confirmationCode, listingId,
    checkInDateLocalized, checkOutDateLocalized,
    status, money, integration, guest,
  } = reservation;

  const prop       = listingMap[listingId] || { nickname: listingId, city: '', costCentre: 'SP.XX' };
  const channel    = (integration?.platform || 'manual').toLowerCase().replace(/\./g, '');
  const prefix     = CHANNEL_PFX[channel] || 'OTH';
  const code       = (confirmationCode || _id).slice(-8).toUpperCase();
  const baseRef    = `${prefix}-${code}`;
  const guestName  = [guest?.firstName, guest?.lastName].filter(Boolean).join(' ');
  const narrative  = `${prop.city} | ${prop.nickname.slice(0, 20)}`;

  const allNights    = stayNights(checkInDateLocalized, checkOutDateLocalized);
  const totalNights  = allNights.length;
  const nightsToPost = allNights.filter(n => targetNights.has(n));

  // ── Reservation row ────────────────────────────────────────
  const resRow = {
    id:                    _id,
    confirmation_code:     confirmationCode || null,
    channel_reservation_id: integration?.guestId || null,
    platform:              integration?.platform || 'manual',
    listing_id:            listingId,
    listing_nickname:      prop.nickname,
    city:                  prop.city,
    country:               'ES',
    cost_centre:           prop.costCentre,
    guest_name:            guestName || null,
    check_in:              checkInDateLocalized?.split('T')[0] || null,
    check_out:             checkOutDateLocalized?.split('T')[0] || null,
    nights:                totalNights,
    status,
    host_payout:           money?.hostPayout || 0,
    currency:              money?.currency || 'EUR',
    month,
  };

  // ── Invoice item rows ──────────────────────────────────────
  const items = money?.invoiceItems || [];
  const itemRows = items
    .filter(i => parseFloat(i.amount ?? i.totalAmount ?? 0) !== 0)
    .map(i => ({
      reservation_id: _id,
      normal_type:    i.normalType || i.type || 'AFE',
      label:          i.title || i.normalType || 'Fee',
      amount:         parseFloat(i.amount ?? i.totalAmount ?? 0),
      sage_nominal:   TYPE_MAP[(i.normalType || i.type || 'AFE').toUpperCase()] || NOM.other_revenue,
    }));

  // ── Journal lines per night ────────────────────────────────
  const journalRows = [];
  const csvLines    = [];

  if (nightsToPost.length === 0 || totalNights === 0) {
    return { resRow, itemRows, journalRows, csvLines };
  }

  // Build per-item cent buckets across ALL nights
  const buckets = [];
  if (items.length === 0) {
    const tc = toCents(money?.hostPayout || 0);
    if (tc !== 0) buckets.push({ nominal: NOM.accommodation, label: 'Accommodation', cents: spreadCents(tc, totalNights) });
  } else {
    for (const item of items) {
      const amount = parseFloat(item.amount ?? item.totalAmount ?? 0);
      if (amount === 0) continue;
      buckets.push({
        nominal: TYPE_MAP[(item.normalType || item.type || 'AFE').toUpperCase()] || NOM.other_revenue,
        label:   item.title || item.normalType || 'Fee',
        cents:   spreadCents(toCents(amount), totalNights),
      });
    }
  }

  for (const night of nightsToPost) {
    const nightIdx   = allNights.indexOf(night);
    const sageDate   = toSage(night);
    const ref        = `${baseRef}-N${String(nightIdx + 1).padStart(2, '0')}`;
    let   grossCents = 0;
    const credits    = [];

    for (const b of buckets) {
      const c = b.cents[nightIdx];
      if (c === 0) continue;
      const amount = fromCents(c);
      credits.push({ nominal: b.nominal, label: b.label, amount });
      grossCents += c;
    }

    if (grossCents === 0) continue;

    // Clearing debit
    const debitRow = {
      reservation_id:   _id,
      night_date:       night,
      night_index:      nightIdx + 1,
      account_number:   NOM.clearing,
      cost_centre:      prop.costCentre,
      department:       SAGE.department,
      transaction_date: sageDate,
      posted_date:      sageDate,
      reference:        ref,
      narrative:        `${channel.toUpperCase()} | ${narrative}`.slice(0, 60),
      goods_amount:     fromCents(grossCents),
      source:           SAGE.source,
      run_id:           runId,
    };
    journalRows.push(debitRow);
    csvLines.push(debitRow);

    // Credit lines
    for (const cr of credits) {
      const creditRow = {
        reservation_id:   _id,
        night_date:       night,
        night_index:      nightIdx + 1,
        account_number:   cr.nominal,
        cost_centre:      prop.costCentre,
        department:       SAGE.department,
        transaction_date: sageDate,
        posted_date:      sageDate,
        reference:        ref,
        narrative:        `${narrative} | ${cr.label}`.slice(0, 60),
        goods_amount:     -cr.amount,
        source:           SAGE.source,
        run_id:           runId,
      };
      journalRows.push(creditRow);
      csvLines.push(creditRow);
    }
  }

  return { resRow, itemRows, journalRows, csvLines };
}

// ─────────────────────────────────────────────────────────────
//  CSV
// ─────────────────────────────────────────────────────────────
const COLS = ['AccountNumber','CostCentre','Department','TransactionDate',
              'PostedDate','Reference','Narrative','GoodsAmount','Source'];

function toCSV(lines) {
  const rows = [COLS.join(';')];
  for (const l of lines) {
    rows.push([
      l.account_number, l.cost_centre, l.department,
      l.transaction_date, l.posted_date, l.reference,
      l.narrative, l.goods_amount.toFixed(2), l.source,
    ].map(v => `"${String(v??'').replace(/"/g,'""')}"`).join(';'));
  }
  return rows.join('\r\n');
}

// ─────────────────────────────────────────────────────────────
//  ARGS
// ─────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--month')) {
    const m = args[args.indexOf('--month') + 1];
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      const [y, mo] = m.split('-').map(Number);
      return { mode: 'monthly', year: y, month: mo };
    }
    const n = new Date();
    return { mode: 'monthly', year: n.getFullYear(), month: n.getMonth() + 1 };
  }
  const d = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
    || (args.includes('--date') && args[args.indexOf('--date')+1])
    || null;
  return { mode: 'daily', date: d || yesterday() };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  const required = ['GUESTY_CLIENT_ID','GUESTY_CLIENT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('❌  Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  const db   = new Supabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const args = parseArgs();

  // Resolve date range and target nights
  let fromDate, toDate, targetNights, period, month, mode, fileSuffix;
  mode = args.mode;

  if (mode === 'daily') {
    fromDate     = args.date;
    toDate       = args.date;
    targetNights = new Set([args.date]);
    period       = args.date;
    month        = args.date.slice(0, 7);
    fileSuffix   = args.date.replace(/-/g, '');
    console.log(`\n🚀  Olala! Guesty → Supabase + Sage 200  |  DAILY  |  ${args.date}\n`);
  } else {
    const lastDay = new Date(args.year, args.month, 0).getDate();
    fromDate  = `${args.year}-${String(args.month).padStart(2,'0')}-01`;
    toDate    = `${args.year}-${String(args.month).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    period    = `${String(args.month).padStart(2,'0')}/${args.year}`;
    month     = `${args.year}-${String(args.month).padStart(2,'0')}`;
    fileSuffix = `${args.year}${String(args.month).padStart(2,'0')}`;
    targetNights = new Set();
    const cur = new Date(fromDate), end = new Date(toDate);
    while (cur <= end) { targetNights.add(toISO(new Date(cur))); cur.setDate(cur.getDate()+1); }
    console.log(`\n🚀  Olala! Guesty → Supabase + Sage 200  |  MONTHLY  |  ${period}\n`);
  }

  // Create run record
  const run = await db.insert('import_runs', {
    mode, period, status: 'running',
  });
  const runId = run.id;
  console.log(`📋  Run ID: ${runId}`);

  try {
    const token      = await getToken();
    const listingMap = await buildListingMap(token);
    const spainIds   = new Set(Object.keys(listingMap));

    if (spainIds.size === 0) throw new Error('No Spain listings found');

    // Extend toDate by 1 day for the API filter
    const nextDay = new Date(toDate); nextDay.setDate(nextDay.getDate()+1);
    const reservations = await fetchReservations(fromDate, toISO(nextDay), spainIds, token);

    if (reservations.length === 0) {
      console.log('ℹ️  No Spain reservations in this period.');
      await db.update('import_runs', runId, { status: 'complete', reservations_count: 0 });
      return;
    }

    // Process all reservations
    console.log('\n⚙️  Processing reservations...');
    const allResRows     = [];
    const allItemRows    = [];
    const allJournalRows = [];
    const allCsvLines    = [];

    for (const r of reservations) {
      const { resRow, itemRows, journalRows, csvLines } =
        processReservation(r, listingMap, targetNights, runId, month);
      allResRows.push(resRow);
      allItemRows.push(...itemRows);
      allJournalRows.push(...journalRows);
      allCsvLines.push(...csvLines);
    }

    // Batch upsert to Supabase (50 rows at a time)
    console.log('\n💾  Saving to Supabase...');
    await batchUpsert(db, 'reservations',  allResRows,     50);
    await batchUpsert(db, 'invoice_items', allItemRows,    50);
    await batchUpsert(db, 'journal_lines', allJournalRows, 50);

    // Generate CSV
    const csvContent = toCSV(allCsvLines);
    const outputDir  = './output';
    fs.mkdirSync(outputDir, { recursive: true });
    const csvPath = path.join(outputDir, `olala_sage200_spain_${mode}_${fileSuffix}.csv`);
    fs.writeFileSync(csvPath, csvContent, 'utf8');

    // Summary
    const grossTotal = allCsvLines
      .filter(l => l.goods_amount > 0)
      .reduce((s, l) => s + l.goods_amount, 0);

    // Update run record
    await db.update('import_runs', runId, {
      status:              'complete',
      reservations_count:  reservations.length,
      journal_lines_count: allJournalRows.length,
      total_gross:         parseFloat(grossTotal.toFixed(2)),
      csv_content:         csvContent,
      completed_at:        new Date().toISOString(),
    });

    console.log('\n══════════════════════════════════════════════════════');
    console.log(`  OLALA! Spain — ${mode === 'daily' ? 'Daily' : 'Monthly'} Revenue Export`);
    console.log(`  Period          : ${period}`);
    console.log(`  Reservations    : ${reservations.length}`);
    console.log(`  Journal lines   : ${allJournalRows.length}`);
    console.log(`  Gross revenue   : €${grossTotal.toFixed(2)}`);
    console.log(`  Supabase run ID : ${runId}`);
    console.log('══════════════════════════════════════════════════════');
    console.log(`\n✅  CSV: ${csvPath}`);
    console.log(`🗄️   All data saved to Supabase\n`);

  } catch (err) {
    await db.update('import_runs', runId, {
      status: 'error',
      error_message: err.message,
      completed_at: new Date().toISOString(),
    });
    throw err;
  }
}

async function batchUpsert(db, table, rows, size) {
  for (let i = 0; i < rows.length; i += size) {
    await db.upsert(table, rows.slice(i, i + size));
    if (i + size < rows.length) await sleep(100);
  }
  console.log(`   ✅  ${table}: ${rows.length} rows`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
