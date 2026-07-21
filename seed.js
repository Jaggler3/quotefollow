const db = require('./db');

function seedSampleData() {
  console.log('Seeding sample data...\n');

  // Sample leads
  const leads = [
    { name: 'Ace Plumbing', trade: 'plumbing', city: 'Austin', state: 'TX', email: 'info@aceplumbing.com', phone: '(512) 555-0101' },
    { name: 'CoolBreeze HVAC', trade: 'hvac', city: 'Dallas', state: 'TX', email: 'service@coolbreezehvac.com', phone: '(214) 555-0202' },
    { name: 'Summit Roofing', trade: 'roofing', city: 'Denver', state: 'CO', email: 'jobs@summitroofing.com', phone: '(303) 555-0303' },
    { name: 'GreenThumb Landscaping', trade: 'landscaping', city: 'Nashville', state: 'TN', email: 'hello@greenthumb.com', phone: '(615) 555-0404' },
    { name: 'Spark Electric', trade: 'electrical', city: 'Charlotte', state: 'NC', email: 'office@sparkelectric.com', phone: '(704) 555-0505' },
    { name: 'ProFlow Plumbing', trade: 'plumbing', city: 'Phoenix', state: 'AZ', email: 'dispatch@proflow.com', phone: '(602) 555-0606' },
    { name: 'IceCold Mechanical', trade: 'hvac', city: 'Houston', state: 'TX', email: 'service@icecold.com', phone: '(713) 555-0707' },
    { name: 'Titan Roofing Co', trade: 'roofing', city: 'San Antonio', state: 'TX', email: 'estimates@titanroofing.com', phone: '(210) 555-0808' },
    { name: 'Pacific Electric', trade: 'electrical', city: 'Portland', state: 'OR', email: 'info@pacificelectric.com', phone: '(503) 555-0909' },
    { name: 'SunState Landscapes', trade: 'landscaping', city: 'Tampa', state: 'FL', email: 'design@sunstate.com', phone: '(813) 555-1010' },
  ];

  const insertLead = db.prepare(`
    INSERT INTO leads (business_name, email, phone, city, state, trade, source, status)
    VALUES (?, ?, ?, ?, ?, ?, 'seed', 'new')
  `);

  for (const l of leads) {
    insertLead.run(l.name, l.email, l.phone, l.city, l.state, l.trade);
  }
  console.log(`  Added ${leads.length} sample leads`);

  // Sample clients
  const clients = [
    { name: 'Ace Plumbing', contact: 'John Smith', email: 'john@aceplumbing.com', trade: 'plumbing', plan: 'growth', fee: 249 },
    { name: 'CoolBreeze HVAC', contact: 'Mike Johnson', email: 'mike@coolbreezehvac.com', trade: 'hvac', plan: 'starter', fee: 149 },
  ];

  const insertClient = db.prepare(`
    INSERT INTO clients (business_name, contact_name, email, trade, plan, monthly_fee, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `);

  for (const c of clients) {
    insertClient.run(c.name, c.contact, c.email, c.trade, c.plan, c.fee);
  }
  console.log(`  Added ${clients.length} sample clients`);

  // Sample quotes for client 1
  const quotes = [
    { cust: 'Sarah Wilson', email: 'sarah@email.com', job: 'Water heater replacement', amount: 2800, status: 'pending' },
    { cust: 'Tom Brown', email: 'tom@email.com', job: 'Bathroom sink repair', amount: 450, status: 'closed' },
    { cust: 'Lisa Davis', email: 'lisa@email.com', job: 'Kitchen drain clog', amount: 350, status: 'pending' },
    { cust: 'James Wilson', email: 'james@email.com', job: 'Full bathroom remodel', amount: 12000, status: 'pending' },
    { cust: 'Emily Chen', email: 'emily@email.com', job: 'Garbage disposal install', amount: 600, status: 'closed' },
  ];

  const insertQuote = db.prepare(`
    INSERT INTO quotes (client_id, customer_name, customer_email, job_description, quote_amount, status, quote_date)
    VALUES (?, ?, ?, ?, ?, ?, date('now', '-' || ? || ' days'))
  `);

  quotes.forEach((q, i) => {
    insertQuote.run(1, q.cust, q.email, q.job, q.amount, q.status, i * 3);
  });
  console.log(`  Added ${quotes.length} sample quotes`);

  // Sample revenue
  const insertRevenue = db.prepare(`
    INSERT INTO revenue (client_id, amount, type, description, created_at)
    VALUES (?, ?, ?, ?, datetime('now', '-' || ? || ' days'))
  `);

  insertRevenue.run(1, 249, 'subscription', 'Growth plan - Month 1', 30);
  insertRevenue.run(2, 149, 'subscription', 'Starter plan - Month 1', 25);
  insertRevenue.run(1, 99, 'setup', 'Setup fee', 30);
  insertRevenue.run(2, 99, 'setup', 'Setup fee', 25);
  insertRevenue.run(1, 249, 'subscription', 'Growth plan - Month 2', 0);

  console.log('  Added sample revenue records');
  console.log('\nSample data seeded successfully!');
}

if (require.main === module) {
  seedSampleData();
}

module.exports = { seedSampleData };
