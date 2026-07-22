const express = require('express');
const path = require('path');
const db = require('./db');
const { scheduleFollowups, processDueFollowups, getClientDashboard, getFollowupStats } = require('./followup-engine');
const { sendColdEmail, sendBatch, EMAIL_TEMPLATES } = require('./campaign');
const { scrapeLeads, scrapeAll, TRADES, CITIES } = require('./lead-scraper');
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

// Webhook route MUST be before express.json() — Stripe needs raw body for signature verification
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const name = session.customer_details?.name;
    const amount = session.amount_total;
    const plan = amount >= 49900 ? 'enterprise' : amount >= 24900 ? 'growth' : 'starter';
    const monthlyFee = amount / 100;

    console.log(`[Webhook] New signup: ${name} (${email}) - $${monthlyFee}/mo ${plan}`);

    // Create client record
    const result = db.prepare(`
      INSERT INTO clients (business_name, contact_name, email, plan, monthly_fee, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(name || email, name, email, plan, monthlyFee);

    // Record revenue
    db.prepare(`
      INSERT INTO revenue (client_id, amount, type, description, stripe_payment_id)
      VALUES (?, ?, 'subscription', ?, ?)
    `).run(result.lastInsertRowid, monthlyFee, `${plan} plan - Month 1`, session.id);

    // Send welcome email
    try {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: 'martin.protostar@gmail.com',
          clientId: process.env.GMAIL_CLIENT_ID,
          clientSecret: process.env.GMAIL_CLIENT_SECRET,
          refreshToken: process.env.GMAIL_REFRESH_TOKEN,
        },
      });

      await transport.sendMail({
        from: '"Martin @ QuoteFollow" <martin.protostar@gmail.com>',
        to: email,
        subject: 'Welcome to QuoteFollow! Let\'s get you set up',
        text: `Hi ${name || 'there'},

Welcome to QuoteFollow! You're now on the ${plan} plan ($${monthlyFee}/mo).

Here's what happens next:
1. I'll reach out within 24 hours to learn about your business
2. We'll set up your follow-up sequences
3. You'll start getting reports on quote follow-up activity

If you have any questions, just reply to this email.

Best,
Martin
QuoteFollow`,
      });
    } catch (err) {
      console.error('[Webhook] Welcome email failed:', err.message);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/leads', (req, res) => {
  const { trade, status, limit = 50 } = req.query;
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (trade) { query += ' AND trade = ?'; params.push(trade); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  res.json(db.prepare(query).all(...params));
});

app.post('/api/leads', (req, res) => {
  const { business_name, contact_name, email, phone, website, city, state, trade } = req.body;
  const result = db.prepare(`
    INSERT INTO leads (business_name, contact_name, email, phone, website, city, state, trade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(business_name, contact_name, email, phone, website, city, state, trade);
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/leads/scrape', async (req, res) => {
  const { trade, city } = req.body;
  try {
    const leads = await scrapeLeads(trade || 'plumbing', city || 'Austin TX');
    res.json({ scraped: leads.length, leads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign/send', async (req, res) => {
  const { template = 'cold_intro', limit = 20 } = req.body;
  try {
    const results = await sendBatch(template, limit);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campaign/preview/:template', (req, res) => {
  const template = EMAIL_TEMPLATES[req.params.template];
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { personalizeTemplate } = require('./campaign');
  const data = {
    contact_name: 'John',
    business_name: 'Ace Plumbing',
    city: 'Austin',
    trade: 'plumbing',
    lost_revenue: '3200',
  };
  res.json(personalizeTemplate(template, data));
});

app.get('/api/clients', (req, res) => {
  res.json(db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all());
});

app.post('/api/clients', (req, res) => {
  const { business_name, contact_name, email, phone, trade, plan, monthly_fee } = req.body;
  const result = db.prepare(`
    INSERT INTO clients (business_name, contact_name, email, phone, trade, plan, monthly_fee)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(business_name, contact_name, email, phone, trade, plan || 'starter', monthly_fee || 149);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const dashboard = getClientDashboard(client.id);
  const stats = getFollowupStats(client.id);

  res.json({ client, ...dashboard, followupStats: stats });
});

app.post('/api/clients/:id/quotes', (req, res) => {
  const { customer_name, customer_email, customer_phone, job_description, quote_amount, quote_date } = req.body;

  const result = db.prepare(`
    INSERT INTO quotes (client_id, customer_name, customer_email, customer_phone, job_description, quote_amount, quote_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, customer_name, customer_email, customer_phone, job_description, quote_amount, quote_date);

  try {
    scheduleFollowups(result.lastInsertRowid);
  } catch (err) {
    console.error('Failed to schedule follow-ups:', err.message);
  }

  res.json({ id: result.lastInsertRowid });
});

app.get('/api/quotes', (req, res) => {
  const { client_id, status } = req.query;
  let query = `
    SELECT q.*, c.business_name as client_name
    FROM quotes q
    JOIN clients c ON q.client_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (client_id) { query += ' AND q.client_id = ?'; params.push(client_id); }
  if (status) { query += ' AND q.status = ?'; params.push(status); }
  query += ' ORDER BY q.created_at DESC';

  res.json(db.prepare(query).all(...params));
});

app.post('/api/followups/process', async (req, res) => {
  try {
    const results = await processDueFollowups();
    res.json({ processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/revenue', (req, res) => {
  const total = db.prepare('SELECT SUM(amount) as total FROM revenue').get();
  const monthly = db.prepare(`
    SELECT SUM(amount) as total
    FROM revenue
    WHERE created_at >= date('now', 'start of month')
  `).get();
  const byType = db.prepare(`
    SELECT type, SUM(amount) as total, COUNT(*) as count
    FROM revenue
    GROUP BY type
  `).all();

  res.json({
    total: total.total || 0,
    monthly: monthly.total || 0,
    byType,
  });
});

app.post('/api/revenue', (req, res) => {
  const { client_id, amount, type, description, stripe_payment_id } = req.body;
  const result = db.prepare(`
    INSERT INTO revenue (client_id, amount, type, description, stripe_payment_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(client_id, amount, type, description, stripe_payment_id);
  res.json({ id: result.lastInsertRowid });
});

app.get('/api/stats', (req, res) => {
  const leads = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  const contacted = db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'contacted'").get();
  const clients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").get();
  const quotes = db.prepare('SELECT COUNT(*) as count FROM quotes').get();
  const closed = db.prepare("SELECT COUNT(*) as count FROM quotes WHERE status = 'closed'").get();
  const revenue = db.prepare('SELECT SUM(amount) as total FROM revenue').get();
  const emailsSent = db.prepare("SELECT COUNT(*) as count FROM cold_emails WHERE status = 'sent'").get();
  const followupsSent = db.prepare("SELECT COUNT(*) as count FROM followups WHERE status = 'sent'").get();

  res.json({
    leads: leads.count,
    contacted: contacted.count,
    activeClients: clients.count,
    totalQuotes: quotes.count,
    closedQuotes: closed.count,
    totalRevenue: revenue.total || 0,
    emailsSent: emailsSent.count,
    followupsSent: followupsSent.count,
  });
});

const PORT = process.env.PORT || 3457;
app.listen(PORT, () => {
  console.log(`\nQuoteFollow running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/stats\n`);
});
