#!/usr/bin/env node

const db = require('./db');
const { scrapeLeads, TRADES, CITIES } = require('./lead-scraper');

async function scrapeNewLeads() {
  console.log('[LeadScraper] Starting new lead scrape...');
  
  const trades = ['plumbing', 'hvac', 'roofing', 'electrical'];
  const cities = ['Austin TX', 'Dallas TX', 'Houston TX', 'Denver CO', 'Phoenix AZ'];
  
  let totalNew = 0;
  
  for (const trade of trades) {
    for (const city of cities) {
      try {
        console.log(`[LeadScraper] Scraping ${trade} in ${city}...`);
        const leads = await scrapeLeads(trade, city);
        
        // Filter out duplicates
        const newLeads = leads.filter(lead => {
          const existing = db.prepare('SELECT id FROM leads WHERE email = ?').get(lead.email);
          return !existing && lead.email;
        });
        
        // Insert new leads
        const insert = db.prepare(`
          INSERT INTO leads (business_name, contact_name, email, phone, website, city, state, trade, source, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scraped', 'new')
        `);
        
        for (const lead of newLeads) {
          insert.run(lead.business_name, lead.contact_name, lead.email, lead.phone, lead.website, lead.city, lead.state, lead.trade);
        }
        
        totalNew += newLeads.length;
        console.log(`[LeadScraper] Found ${newLeads.length} new leads for ${trade} in ${city}`);
        
        // Rate limit
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      } catch (err) {
        console.error(`[LeadScraper] Error scraping ${trade} in ${city}: ${err.message}`);
      }
    }
  }
  
  console.log(`[LeadScraper] Complete. Added ${totalNew} new leads total.`);
  return totalNew;
}

if (require.main === module) {
  scrapeNewLeads().then(() => process.exit(0));
}

module.exports = { scrapeNewLeads };
