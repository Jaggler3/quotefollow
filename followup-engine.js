const nodemailer = require('nodemailer');
const db = require('./db');

const FOLLOWUP_SEQUENCE = [
  {
    step: 1,
    delayDays: 2,
    subject: 'Just checking in on your quote for {job_description}',
    body: `Hi {customer_name},

I wanted to quickly follow up on the quote we sent over for {job_description}.

We know you're weighing your options, and that's completely fine. If you have any questions about the quote or want to adjust anything, I'm happy to chat.

No pressure at all — just wanted to make sure you got everything you need to make the best decision.

Looking forward to hearing from you!

Best,
{client_name}
{client_trade}`,
  },
  {
    step: 2,
    delayDays: 5,
    subject: 'A few things to consider about your {job_description}',
    body: `Hi {customer_name},

Following up again on your {job_description} quote of {quote_amount}.

A few things our past customers have found helpful:
- We stand behind our work with a {warranty} warranty
- Financing options are available if that helps
- We can adjust the scope if the budget needs tweaking

Would you like to hop on a quick call to discuss? Sometimes it's easier to talk through it.

{client_name}`,
  },
  {
    step: 3,
    delayDays: 10,
    subject: 'Your {job_description} quote expires soon',
    body: `Hi {customer_name},

Just a heads up — the quote for your {job_description} ({quote_amount}) is valid through {expiry_date}.

We've had a few similar projects come in recently, so our schedule is filling up for the coming weeks. If you'd like to lock in this price and timeline, now's a great time to move forward.

Happy to answer any last questions.

{client_name}`,
  },
  {
    step: 4,
    delayDays: 18,
    subject: 'Last follow-up — {job_description}',
    body: `Hi {customer_name},

This is my last follow-up on your {job_description} quote.

I don't want to be pushy, but I also don't want you to miss out if this is something you still need. Our offer stands:

{quote_amount} for {job_description}

If your plans have changed, no worries at all. But if you'd still like to get this done, just reply to this email and we'll get you on the schedule.

Wishing you the best either way!

{client_name}`,
  },
];

function personalizeTemplate(template, data) {
  let body = template.body;
  let subject = template.subject;

  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    body = body.replace(regex, value || '');
    subject = subject.replace(regex, value || '');
  }

  return { subject, body };
}

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: 'martin.protostar@gmail.com',
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
    },
  });
}

function scheduleFollowups(quoteId) {
  const quote = db.prepare(`
    SELECT q.*, c.business_name as client_name, c.trade as client_trade, c.email as client_email
    FROM quotes q
    JOIN clients c ON q.client_id = c.id
    WHERE q.id = ?
  `).get(quoteId);

  if (!quote) throw new Error(`Quote ${quoteId} not found`);

  const insertFollowup = db.prepare(`
    INSERT INTO followups (quote_id, type, sequence_step, send_at, status)
    VALUES (?, 'quote_followup', ?, datetime('now', '+' || ? || ' days'), 'scheduled')
  `);

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + 30);

  for (const step of FOLLOWUP_SEQUENCE) {
    const templateData = {
      customer_name: quote.customer_name,
      job_description: quote.job_description || 'project',
      quote_amount: quote.quote_amount ? `$${quote.quote_amount}` : 'your project',
      client_name: quote.client_name,
      client_trade: quote.client_trade,
      warranty: '1-year',
      expiry_date: expiryDate.toLocaleDateString(),
    };

    const { subject, body } = personalizeTemplate(step, templateData);

    insertFollowup.run(
      quoteId,
      step.step,
      step.delayDays
    );
  }

  console.log(`Scheduled ${FOLLOWUP_SEQUENCE.length} follow-ups for quote #${quoteId}`);
}

async function processDueFollowups() {
  const due = db.prepare(`
    SELECT f.*, q.customer_email, q.customer_name, q.job_description, q.quote_amount, q.client_id
    FROM followups f
    JOIN quotes q ON f.quote_id = q.id
    WHERE f.status = 'scheduled'
    AND f.send_at <= datetime('now')
    AND f.type = 'quote_followup'
  `).all();

  console.log(`Processing ${due.length} due follow-ups...`);

  const results = [];

  if (process.env.GMAIL_CLIENT_ID) {
    const transport = createTransport();

    for (const followup of due) {
      if (!followup.customer_email) {
        console.log(`  No email for quote #${followup.quote_id}, skipping`);
        continue;
      }

      const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(followup.client_id);
      
      // Find the matching template
      const template = FOLLOWUP_SEQUENCE.find(s => s.step === followup.sequence_step);
      if (!template) {
        console.log(`  No template for step ${followup.sequence_step}, skipping`);
        continue;
      }

      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 30);

      const templateData = {
        customer_name: followup.customer_name,
        job_description: followup.job_description || 'project',
        quote_amount: followup.quote_amount ? `$${followup.quote_amount}` : 'your project',
        client_name: client ? client.business_name : 'QuoteFollow',
        client_trade: client ? client.trade : '',
        warranty: '1-year',
        expiry_date: expiryDate.toLocaleDateString(),
      };

      const { subject, body } = personalizeTemplate(template, templateData);

      try {
        await transport.sendMail({
          from: `"${client ? client.business_name : 'QuoteFollow'}" <martin.protostar@gmail.com>`,
          to: followup.customer_email,
          subject,
          text: body,
        });

        db.prepare(`
          UPDATE followups SET status = 'sent', sent_at = datetime('now')
          WHERE id = ?
        `).run(followup.id);

        console.log(`  Sent step ${followup.sequence_step} to ${followup.customer_email}`);
        results.push({ id: followup.id, status: 'sent' });
      } catch (err) {
        console.error(`  Failed: ${err.message}`);
        db.prepare(`UPDATE followups SET status = 'failed' WHERE id = ?`).run(followup.id);
        results.push({ id: followup.id, status: 'failed', error: err.message });
      }

      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
    }
  } else {
    console.log('  Gmail not configured — follow-ups saved but not sent');
  }

  return results;
}

function getFollowupStats(clientId) {
  const stats = db.prepare(`
    SELECT
      f.status,
      f.sequence_step,
      COUNT(*) as count
    FROM followups f
    JOIN quotes q ON f.quote_id = q.id
    WHERE q.client_id = ?
    GROUP BY f.status, f.sequence_step
    ORDER BY f.sequence_step
  `).all(clientId);

  return stats;
}

function getClientDashboard(clientId) {
  const quotes = db.prepare(`
    SELECT q.*,
      (SELECT COUNT(*) FROM followups f WHERE f.quote_id = q.id AND f.status = 'sent') as followups_sent,
      (SELECT COUNT(*) FROM followups f WHERE f.quote_id = q.id AND f.status = 'scheduled') as followups_pending
    FROM quotes q
    WHERE q.client_id = ?
    ORDER BY q.created_at DESC
  `).all(clientId);

  const totalQuotes = quotes.length;
  const closedQuotes = quotes.filter(q => q.status === 'closed').length;
  const pendingQuotes = quotes.filter(q => q.status === 'pending').length;

  return {
    quotes,
    summary: {
      total: totalQuotes,
      closed: closedQuotes,
      pending: pendingQuotes,
      closeRate: totalQuotes > 0 ? ((closedQuotes / totalQuotes) * 100).toFixed(1) : 0,
    },
  };
}

if (require.main === module) {
  const action = process.argv[2];

  if (action === 'process') {
    processDueFollowups().then(() => process.exit(0));
  } else if (action === 'stats') {
    const clientId = parseInt(process.argv[3]);
    if (!clientId) {
      console.log('Usage: node followup-engine.js stats <client_id>');
      process.exit(1);
    }
    console.log(JSON.stringify(getFollowupStats(clientId), null, 2));
    process.exit(0);
  } else {
    console.log('Usage: node followup-engine.js process|stats');
  }
}

module.exports = { scheduleFollowups, processDueFollowups, getFollowupStats, getClientDashboard, FOLLOWUP_SEQUENCE };
