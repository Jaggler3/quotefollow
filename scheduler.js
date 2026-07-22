#!/usr/bin/env node

const db = require('./db');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { sendBatch } = require('./campaign');
const { processDueFollowups } = require('./followup-engine');
const { scrapeNewLeads } = require('./scrape-leads');

// ─── Config ───────────────────────────────────────────────────────
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const DAILY_CAP = 50; // max emails/day across cold + follow-ups (shared Gmail protection)
const FOLLOWUP_DELAYS = {
  followup_1: 2,   // days after initial
  followup_2: 5,
  followup_3: 10,
  followup_4: 18,
};

function sendsToday() {
  return db.prepare("SELECT COUNT(*) as c FROM cold_emails WHERE status = 'sent' AND date(sent_at) = date('now')").get().c;
}

// ─── Gmail OAuth2 Transport ──────────────────────────────────────
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

// ─── Gmail API (for reading replies) ─────────────────────────────
function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ─── Email Templates ─────────────────────────────────────────────
const FOLLOWUP_TEMPLATES = {
  followup_1: {
    subject: 'Re: Quick question about {business_name}',
    body: `Hi {contact_name},

Just circling back on my note about helping {business_name} capture more revenue from your quotes.

I know you're busy — that's kind of the point. We handle the follow-ups so you don't have to think about it.

Would a quick 5-minute call work better than 10? I can explain the whole thing in 5.

Best,
Martin
QuoteFollow`,
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
  followup_3: {
    subject: 'Quick math for {business_name}',
    body: `Hi {contact_name},

I'll keep this short:

- Average contractor sends 40 quotes/month
- Closes 7-8 without follow-up
- Closes 14-16 with proper follow-up sequence

That's $4,000-8,000/month in recovered revenue for a typical {trade} company.

I do this for a living. Want me to do it for {business_name}?

Martin
QuoteFollow`,
  },
  followup_4: {
    subject: 'Closing the loop, {contact_name}',
    body: `Hi {contact_name},

This is my last note. I don't want to be a pest.

If {business_name} is leaving money on the table from un-followed quotes, I can fix that. If not, no hard feelings.

Either way, I put together a free resource: a follow-up template kit that contractors use to close 30% more jobs. Want me to send it over?

Martin
QuoteFollow`,
  },
};

// ─── Personalize ──────────────────────────────────────────────────
function personalize(template, data) {
  let body = template.body;
  let subject = template.subject;
  for (const [key, value] of Object.entries(data)) {
    const re = new RegExp(`\\{${key}\\}`, 'g');
    body = body.replace(re, value || '');
    subject = subject.replace(re, value || '');
  }
  return { subject, body };
}

// ─── Check for email replies ──────────────────────────────────────
async function checkReplies() {
  console.log('[Scheduler] Checking for replies...');
  const gmail = getGmailClient();

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread (subject:"Re: You sent 47 quotes" OR subject:"Re: is losing" OR subject:"Re: How a" OR subject:"Re: Quick question about" OR subject:"Re: Last thing" OR subject:"Re: Quick math" OR subject:"Re: Closing the loop")',
      maxResults: 20,
    });

    const messages = res.data.messages || [];
    console.log(`[Scheduler] Found ${messages.length} unread replies`);

    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = full.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      // Extract email from "Name <email>" format
      const emailMatch = from.match(/<(.+?)>/) || [null, from];
      const replyEmail = emailMatch[1].toLowerCase();

      // Find matching lead
      const lead = db.prepare('SELECT * FROM leads WHERE LOWER(email) = ?').get(replyEmail);

      if (lead) {
        console.log(`[Scheduler] Reply from ${lead.business_name} (${replyEmail})`);

        // Check if already logged
        const existing = db.prepare(
          'SELECT id FROM email_replies WHERE gmail_message_id = ?'
        ).get(msg.id);

        if (!existing) {
          db.prepare(`
            INSERT INTO email_replies (lead_id, gmail_message_id, subject, body_preview, received_at)
            VALUES (?, ?, ?, ?, datetime('now'))
          `).run(lead.id, msg.id, subject, `Reply from ${from}`);

          // Update lead status
          db.prepare("UPDATE leads SET status = 'replied' WHERE id = ?").run(lead.id);

          // Stop follow-up sequence
          db.prepare(`
            UPDATE followups SET status = 'stopped' WHERE lead_id = ? AND status = 'scheduled'
          `).run(lead.id);

          console.log(`[Scheduler] Logged reply, stopped follow-ups for ${lead.business_name}`);
        }
      } else {
        console.log(`[Scheduler] Reply from unknown sender: ${replyEmail}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Error checking replies:', err.message);
  }
}

// ─── Send follow-up emails ────────────────────────────────────────
async function sendFollowups() {
  console.log('[Scheduler] Checking for follow-ups to send...');
  const transport = createTransport();
  const now = new Date();

  // Enforce daily cap (cold emails + follow-ups share the budget)
  const budget = Math.max(0, DAILY_CAP - sendsToday());
  if (budget <= 0) {
    console.log(`[Scheduler] Daily send cap reached (${DAILY_CAP}/day) — skipping follow-ups`);
    return;
  }

  // Find follow-ups that are due
  const due = db.prepare(`
    SELECT f.*, l.business_name, l.contact_name, l.email, l.trade, l.city
    FROM followups f
    JOIN leads l ON f.lead_id = l.id
    WHERE f.status = 'scheduled'
    AND datetime(f.send_at) <= datetime('now')
    LIMIT ?
  `).all(Math.min(10, budget));

  console.log(`[Scheduler] ${due.length} follow-ups due`);

  for (const fu of due) {
    const template = FOLLOWUP_TEMPLATES[fu.type];
    if (!template) {
      console.log(`[Scheduler] Unknown template: ${fu.type}`);
      continue;
    }

    const { subject, body } = personalize(template, {
      contact_name: fu.contact_name || 'there',
      business_name: fu.business_name,
      city: fu.city,
      trade: fu.trade,
    });

    try {
      await transport.sendMail({
        from: '"Martin @ QuoteFollow" <martin.protostar@gmail.com>',
        to: fu.email,
        subject,
        text: body,
      });

      db.prepare("UPDATE followups SET status = 'sent', sent_at = datetime('now') WHERE id = ?").run(fu.id);

      db.prepare(`
        INSERT INTO cold_emails (lead_id, email_subject, email_body, sent_at, status)
        VALUES (?, ?, ?, datetime('now'), 'sent')
      `).run(fu.lead_id, subject, body);

      console.log(`[Scheduler] Sent ${fu.type} to ${fu.business_name}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send ${fu.type} to ${fu.email}: ${err.message}`);
      db.prepare("UPDATE followups SET status = 'failed' WHERE id = ?").run(fu.id);
    }

    // Delay between sends
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
  }
}

// ─── Schedule follow-ups for newly contacted leads ────────────────
function scheduleFollowups() {
  const contacted = db.prepare(`
    SELECT * FROM leads
    WHERE status = 'contacted'
    AND id NOT IN (SELECT DISTINCT lead_id FROM followups WHERE status IN ('scheduled', 'sent'))
  `).all();

  for (const lead of contacted) {
    const contactDate = new Date(lead.updated_at || lead.created_at);

    for (const [type, delayDays] of Object.entries(FOLLOWUP_DELAYS)) {
      const sendAt = new Date(contactDate.getTime() + delayDays * 24 * 60 * 60 * 1000);

      // Only schedule if in the future
      if (sendAt > new Date()) {
        db.prepare(`
          INSERT INTO followups (lead_id, type, send_at, status)
          VALUES (?, ?, datetime(?), 'scheduled')
        `).run(lead.id, type, sendAt.toISOString());
        console.log(`[Scheduler] Scheduled ${type} for ${lead.business_name} at ${sendAt.toLocaleDateString()}`);
      }
    }
  }
}

// ─── Stats report ─────────────────────────────────────────────────
function printStats() {
  const stats = {
    totalLeads: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
    contacted: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'contacted'").get().c,
    replied: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'replied'").get().c,
    emailsSent: db.prepare("SELECT COUNT(*) as c FROM cold_emails WHERE status = 'sent'").get().c,
    sentToday: sendsToday(),
    followupsDue: db.prepare("SELECT COUNT(*) as c FROM followups WHERE status = 'scheduled' AND datetime(send_at) <= datetime('now')").get().c,
    followupsScheduled: db.prepare("SELECT COUNT(*) as c FROM followups WHERE status = 'scheduled'").get().c,
    newLeads: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'new'").get().c,
  };

  console.log('\n┌─────────────── QuoteFollow Stats ───────────────┐');
  console.log(`│ Leads:       ${String(stats.totalLeads).padStart(4)} total, ${String(stats.contacted).padStart(4)} contacted, ${String(stats.replied).padStart(3)} replied │`);
  console.log(`│ New leads:   ${String(stats.newLeads).padStart(4)} waiting for first email                  │`);
  console.log(`│ Emails sent: ${String(stats.emailsSent).padStart(4)}  (today: ${String(stats.sentToday).padStart(2)}/${DAILY_CAP})              │`);
  console.log(`│ Follow-ups:  ${String(stats.followupsDue).padStart(4)} due, ${String(stats.followupsScheduled).padStart(4)} scheduled         │`);
  console.log('└──────────────────────────────────────────────────┘\n');
}

// ─── Daily lead scrape (once per day) ─────────────────────────────
async function maybeScrapeLeads() {
  const lastScrape = db.prepare("SELECT MAX(created_at) as last FROM leads WHERE source = 'scraped'").get().last;
  const now = new Date();
  const lastScrapeDate = lastScrape ? new Date(lastScrape) : new Date(0);
  const hoursSinceLastScrape = (now - lastScrapeDate) / (1000 * 60 * 60);

  if (hoursSinceLastScrape >= 24) {
    console.log('[Scheduler] Running daily lead scrape...');
    await scrapeNewLeads();
  }
}

// ─── Main Loop ────────────────────────────────────────────────────
async function tick() {
  try {
    scheduleFollowups();
    await checkReplies();
    await sendFollowups();
    await processDueFollowups();
    await maybeScrapeLeads();
    // Send cold emails to new leads (5 per day, respecting daily cap)
    const newLeadsCount = db.prepare("SELECT COUNT(*) as c FROM leads WHERE status = 'new' AND email IS NOT NULL").get().c;
    const budget = Math.max(0, DAILY_CAP - sendsToday());
    if (newLeadsCount > 0 && budget >= 5) {
      console.log(`[Scheduler] Sending cold emails to ${Math.min(5, newLeadsCount)} new leads...`);
      await sendBatch('cold_intro', 5);
    }
    printStats();
  } catch (err) {
    console.error('[Scheduler] Tick error:', err);
  }
}


async function main() {
  console.log('[Scheduler] QuoteFollow autonomous scheduler started');
  console.log(`[Scheduler] Checking every ${CHECK_INTERVAL_MS / 1000 / 60} minutes`);

  // Run immediately
  await tick();

  // Then on interval
  setInterval(tick, CHECK_INTERVAL_MS);
}

// ─── CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === 'once') {
    tick().then(() => process.exit(0));
  } else if (cmd === 'stats') {
    printStats();
  } else if (cmd === 'daemon') {
    main();
  } else {
    console.log('Usage:');
    console.log('  node scheduler.js daemon   # Run as background daemon');
    console.log('  node scheduler.js once     # Run one tick then exit');
    console.log('  node scheduler.js stats    # Print current stats');
  }
}

module.exports = { checkReplies, sendFollowups, scheduleFollowups, printStats };
