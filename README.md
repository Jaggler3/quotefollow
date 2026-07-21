# QuoteFollow

Done-for-you quote follow-up service for contractors.

## Quick Start

```bash
# Install dependencies
npm install

# Seed sample data
node seed.js

# Start the dashboard
npm start
# Open http://localhost:3456
```

## Configure Gmail (for sending emails)

1. Go to https://myaccount.google.com/apppasswords
2. Generate an app password for "Mail"
3. Copy the .env.example to .env and fill in your credentials:
   ```
   GMAIL_USER=your-email@gmail.com
   GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the dashboard server |
| `npm run scrape` | Scrape leads from Google |
| `npm run campaign` | Send cold email batch |
| `npm run followups` | Process due follow-ups |
| `node seed.js` | Seed sample data |

## Architecture

```
lead-scraper.js     → Find contractors via Google search
campaign.js         → Cold email sequences to pitch the service
followup-engine.js  → Automated quote follow-up sequences
server.js           → Web dashboard + API
db.js               → SQLite database
seed.js             → Sample data
```

## Pricing

- Starter: $149/mo (30 quotes)
- Growth: $249/mo (80 quotes)
- Enterprise: $499/mo (unlimited)
