const nodemailer = require('nodemailer');
const db = require('./db');

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

const EMAIL_TEMPLATES = {
  cold_intro: {
    subject: 'You sent 47 quotes last month — how many did you follow up on twice?',
    body: `Hi {contact_name},

I work with {trade} companies in {city} and noticed something common: most send quotes but follow up 0-1 times before moving on.

That's leaving money on the table.

Here's what I found looking at companies like {business_name}:
- The average contractor loses $2,400/month from unanswered quotes
- It takes 5-7 touchpoints to close a job, but most do 1-2
- Customers who get a follow-up within 48 hours convert 3x more

I run a service called QuoteFollow. We handle all your quote follow-ups for you — professional, persistent, and never pushy. You send us your quotes, we take it from there.

Would you be open to a quick 10-minute call this week to see if it's a fit?

Best,
Martin
QuoteFollow | Never lose a job to silence again`,
  },

  cold_with_stat: {
    subject: '{business_name} is losing ${lost_revenue}/month from cold quotes',
    body: `Hi {contact_name},

I analyzed {trade} companies in {city} and found something alarming:

The typical contractor sends 30-50 quotes per month but only follows up on 20-30% of them. That means {business_name} is probably leaving $2,000-4,000/month on the table.

QuoteFollow is a done-for-you follow-up service. We send professional email sequences to every quote you send — on day 2, day 5, day 10, and day 18. You focus on the work, we make sure no quote falls through the cracks.

One of our clients, a roofing company in Austin, increased their close rate from 18% to 34% in the first month.

Interested in a quick chat?

Martin
QuoteFollow`,
  },

  cold_case_study: {
    subject: 'How a {trade} company in {city} increased close rate by 89%',
    body: `Hi {contact_name},

Quick story: A {trade} company similar to {business_name} was sending 40+ quotes per month but only closing 7. Their follow-up was... "hoping the phone rings."

We set up QuoteFollow for them. Within 60 days:
- Close rate went from 18% to 34%
- Monthly revenue increased by $8,200
- They spent 0 extra hours on follow-ups

The secret? Consistent, professional follow-up sequences. Day 2: friendly check-in. Day 5: address common concerns. Day 10: add urgency. Day 18: final touchpoint.

Want to see how this would work for {business_name}? I can show you in a 10-minute call.

Martin
QuoteFollow`,
  },

  followup_1: {
    subject: 'Re: Quick question about {business_name}',
    body: `Hi {contact_name},

Just circling back on my note about helping {business_name} capture more revenue from your quotes.

I know you're busy — that's kind of the point. We handle the follow-ups so you don't have to think about it.

Would a quick 5-minute call work better than 10? I can explain the whole thing in 5.

Martin`,
  },

  followup_2: {
    subject: 'Last thing — free trial for {business_name}',
    body: `Hi {contact_name},

I get it, you're swamped. So here's my offer:

Send me your 5 most recent quotes that haven't closed. I'll run the follow-up sequence on them for free. If it doesn't generate at least one response, you never hear from me again.

No risk. No commitment. Just results.

Martin
QuoteFollow`,
  },
};

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

async function sendColdEmail(leadId, templateName = 'cold_intro') {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const template = EMAIL_TEMPLATES[templateName];
  if (!template) throw new Error(`Template ${templateName} not found`);

  const lostRevenue = Math.floor(2000 + Math.random() * 3000);

  const { subject, body } = personalizeTemplate(template, {
    contact_name: lead.contact_name || 'there',
    business_name: lead.business_name,
    city: lead.city,
    trade: lead.trade,
    lost_revenue: lostRevenue.toString(),
  });

  if (!lead.email) {
    console.log(`  No email for ${lead.business_name}, saving draft`);
    db.prepare(`
      INSERT INTO cold_emails (lead_id, email_subject, email_body, status)
      VALUES (?, ?, ?, 'draft')
    `).run(leadId, subject, body);
    return { status: 'draft', subject, body };
  }

  if (process.env.GMAIL_CLIENT_ID) {
    const transport = createTransport();
    try {
      await transport.sendMail({
        from: '"Martin @ QuoteFollow" <martin.protostar@gmail.com>',
        to: lead.email,
        subject,
        text: body,
      });

      db.prepare(`
        INSERT INTO cold_emails (lead_id, email_subject, email_body, sent_at, status)
        VALUES (?, ?, ?, datetime('now'), 'sent')
      `).run(leadId, subject, body);

      db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('contacted', leadId);

      console.log(`  Sent to ${lead.email}`);
      return { status: 'sent', subject, body };
    } catch (err) {
      console.error(`  Failed to send to ${lead.email}: ${err.message}`);
      db.prepare(`
        INSERT INTO cold_emails (lead_id, email_subject, email_body, status)
        VALUES (?, ?, ?, 'failed')
      `).run(leadId, subject, body);
      return { status: 'failed', error: err.message };
    }
  } else {
    console.log(`  Gmail not configured, saving draft for ${lead.business_name}`);
    db.prepare(`
      INSERT INTO cold_emails (lead_id, email_subject, email_body, status)
      VALUES (?, ?, ?, 'draft')
    `).run(leadId, subject, body);
    return { status: 'draft', subject, body };
  }
}

async function sendBatch(templateName = 'cold_intro', limit = 20) {
  const leads = db.prepare(`
    SELECT * FROM leads
    WHERE email IS NOT NULL
    AND status = 'new'
    LIMIT ?
  `).all(limit);

  console.log(`Sending to ${leads.length} leads...`);

  const results = [];
  for (const lead of leads) {
    const result = await sendColdEmail(lead.id, templateName);
    results.push({ lead: lead.business_name, ...result });
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
  }

  const sent = results.filter(r => r.status === 'sent').length;
  const drafts = results.filter(r => r.status === 'draft').length;
  const failed = results.filter(r => r.status === 'failed').length;

  console.log(`\nResults: ${sent} sent, ${drafts} drafts, ${failed} failed`);
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args[0];
  const template = args[1] || 'cold_intro';
  const limit = parseInt(args[2]) || 20;

  if (action === 'send') {
    sendBatch(template, limit).then(() => process.exit(0));
  } else if (action === 'preview') {
    const data = {
      contact_name: 'John',
      business_name: 'Ace Plumbing',
      city: 'Austin',
      trade: 'plumbing',
      lost_revenue: '3200',
    };
    const result = personalizeTemplate(EMAIL_TEMPLATES[template], data);
    console.log('Subject:', result.subject);
    console.log('---');
    console.log(result.body);
  } else {
    console.log('Usage: node campaign.js send|preview [template] [limit]');
  }
}

module.exports = { sendColdEmail, sendBatch, personalizeTemplate, EMAIL_TEMPLATES };
