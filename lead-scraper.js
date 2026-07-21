const fetch = require('node-fetch');
const cheerio = require('cheerio');
const db = require('./db');

const TRADES = [
  { keyword: 'HVAC contractor', slug: 'hvac' },
  { keyword: 'plumbing company', slug: 'plumbing' },
  { keyword: 'roofing contractor', slug: 'roofing' },
  { keyword: 'landscaping company', slug: 'landscaping' },
  { keyword: 'electrical contractor', slug: 'electrical' },
  { keyword: 'general contractor', slug: 'general' },
  { keyword: 'pest control company', slug: 'pest-control' },
  { keyword: 'painting contractor', slug: 'painting' },
];

const CITIES = [
  'Austin TX', 'Dallas TX', 'Houston TX', 'San Antonio TX',
  'Phoenix AZ', 'Denver CO', 'Nashville TN', 'Charlotte NC',
  'Raleigh NC', 'Atlanta GA', 'Miami FL', 'Tampa FL',
  'Portland OR', 'Seattle WA', 'Las Vegas NV', 'San Diego CA',
];

function generateSearchQueries(trade, cities = CITIES.slice(0, 5)) {
  return cities.map(city => ({
    query: `${trade.keyword} ${city}`,
    trade: trade.slug,
    city: city,
  }));
}

function parseBusinessFromHTML(html) {
  const $ = cheerio.load(html);
  const businesses = [];

  $('[data-attrid="kc:/local:one box"]').each((i, el) => {
    const name = $(el).find('.dbg0pd').text().trim();
    const rating = $(el).find('.yi40Hd').text().trim();
    const reviews = $(el).find('.rdCZK span').first().text().trim();
    const address = $(el).find('.rllt__details div:nth-child(2)').text().trim();
    const phone = $(el).find('.rllt__details div:nth-child(3)').text().trim();
    const website = $(el).find('a[href*="http"]').attr('href');

    if (name) {
      businesses.push({
        business_name: name,
        rating: parseFloat(rating) || 0,
        reviews: parseInt(reviews.replace(/[^\d]/g, '')) || 0,
        address,
        phone,
        website,
      });
    }
  });

  return businesses;
}

function extractEmailsFromWebsite(url) {
  return fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    timeout: 10000,
  })
    .then(res => res.text())
    .then(html => {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const emails = html.match(emailRegex) || [];
      const filtered = [...new Set(emails)].filter(e =>
        !e.includes('example.com') &&
        !e.includes('sentry.io') &&
        !e.includes('wixpress.com') &&
        !e.endsWith('.png') &&
        !e.endsWith('.jpg')
      );
      return filtered[0] || null;
    })
    .catch(() => null);
}

async function scrapeLeads(tradeSlug, city, limit = 20) {
  const trade = TRADES.find(t => t.slug === tradeSlug);
  if (!trade) {
    console.error(`Unknown trade: ${tradeSlug}`);
    return [];
  }

  console.log(`Scraping ${trade.keyword} in ${city}...`);

  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(trade.keyword + ' ' + city)}&num=${limit}`;

  try {
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });

    const html = await response.text();
    const businesses = parseBusinessFromHTML(html);

    const insertStmt = db.prepare(`
      INSERT INTO leads (business_name, phone, website, city, state, trade, source, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new')
    `);

    const saved = [];
    for (const biz of businesses.slice(0, limit)) {
      const state = city.split(' ').pop();
      const cityOnly = city.replace(/\s+\w+$/, '');

      let email = null;
      if (biz.website) {
        email = await extractEmailsFromWebsite(biz.website);
      }

      try {
        const result = insertStmt.run(
          biz.business_name,
          biz.phone || null,
          biz.website || null,
          cityOnly,
          state,
          trade.slug,
          'google-search'
        );
        saved.push({
          id: result.lastInsertRowid,
          ...biz,
          email,
          city: cityOnly,
          state,
          trade: trade.slug,
        });
      } catch (e) {
        console.log(`  Skipping duplicate: ${biz.business_name}`);
      }
    }

    console.log(`  Found ${saved.length} businesses`);
    return saved;
  } catch (err) {
    console.error(`  Error scraping: ${err.message}`);
    return [];
  }
}

async function scrapeAll(options = {}) {
  const trades = options.trades || TRADES.map(t => t.slug);
  const cities = options.cities || CITIES.slice(0, 5);
  const limit = options.limit || 15;

  let total = 0;

  for (const tradeSlug of trades) {
    for (const city of cities) {
      const leads = await scrapeLeads(tradeSlug, city, limit);
      total += leads.length;

      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }
  }

  console.log(`\nTotal leads scraped: ${total}`);
  return total;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const trade = args[0];
  const city = args[1];

  if (trade && city) {
    scrapeLeads(trade, city).then(leads => {
      console.log(`Scraped ${leads.length} leads`);
      process.exit(0);
    });
  } else {
    scrapeAll().then(() => process.exit(0));
  }
}

module.exports = { scrapeLeads, scrapeAll, TRADES, CITIES };
