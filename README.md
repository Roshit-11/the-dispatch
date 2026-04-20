# The Dispatch — Local Build

A local Node.js app that:
1. **Summarizes any news URL** into your chosen language (10 native + 8 via translation)
2. **Aggregates Nepali news** from ekantipur, onlinekhabar, ratopati, and setopati — scraped + summarized every 10 minutes using Llama 3.2 3B

Runs entirely on your machine. No cloud deployment needed.

---

## Setup (one-time, 2 minutes)

**Requirements:** [Node.js 18+](https://nodejs.org) installed.

1. **Open this folder in VS Code**:
   ```
   File → Open Folder → select "news-summarizer"
   ```

2. **Open the built-in terminal** (Ctrl + ` or Terminal → New Terminal) and run:
   ```bash
   npm install
   ```
   This installs Express and dotenv. Takes ~20 seconds.

3. **Verify `.env`** — it should already have your keys. If not, open `.env` and fill in:
   ```
   RAPIDAPI_KEY=...
   MYMEMORY_EMAIL=...
   ```

---

## Running

```bash
npm start
```

You'll see:
```
✓ RapidAPI key loaded
✓ MyMemory email: noreply.meetingai@gmail.com

📰  The Dispatch is running
    Open:        http://localhost:3000
    News feed:   http://localhost:3000/news.html
    Health:      http://localhost:3000/api/health
    Trigger:     http://localhost:3000/api/admin/scrape-now
    Cycle every: 10 minute(s)
```

Open **http://localhost:3000** in your browser.

To stop the server: press `Ctrl + C` in the terminal.

For auto-restart while editing code, use `npm run dev` instead.

---

## How it works

### The single-article page (`/`)
Same as yesterday. Paste a news URL, pick language + length, hit Summarize. Backend proxies to the RapidAPI article summarizer, translates via MyMemory if the target language needs it.

### The Nepali aggregator page (`/news.html`)
The server runs a scrape cycle **on startup** and then **every 10 minutes** (configurable via `SCRAPE_INTERVAL_MINUTES` in `.env`). Each cycle:

1. Fetches article listings from the 4 Nepali sites (RSS for onlinekhabar, HTML scraping for the rest)
2. Filters to new articles not seen before (deduplicated on disk)
3. For up to 3 new articles per site, fetches the full article text
4. Sends the text to Llama 3.2 3B on RapidAPI, asks for a 3-sentence Nepali summary
5. Saves everything to `./cache/feed.json`

The news page just reads `/api/news` and renders whatever's in the cache. No scraping happens on page load.

### Project layout
```
news-summarizer/
├── .env                 ← your keys (DO NOT commit to git)
├── .gitignore
├── package.json
├── server.js            ← Express server + scrape loop
├── cache/               ← auto-created, stores feed.json and seen.json
│   ├── feed.json
│   └── seen.json
├── public/              ← static frontend served at /
│   ├── index.html       ← single-article summarizer
│   └── news.html        ← Nepali aggregator
└── README.md
```

---

## Testing it

After running `npm start`:

| Check | URL |
|---|---|
| Health check | http://localhost:3000/api/health |
| Summarize a URL | http://localhost:3000 → paste any news URL |
| Trigger scrape immediately | http://localhost:3000/api/admin/scrape-now |
| See the aggregator | http://localhost:3000/news.html |
| Raw feed JSON | http://localhost:3000/api/news |

Watch the terminal — every scrape cycle logs exactly what it found and summarized.

---

## Troubleshooting

**"No articles yet" on news.html after startup**
First scrape runs ~2 seconds after boot and takes 30-90 seconds to complete (fetches ~12 articles, sends each to Llama). Wait a minute, then refresh. Or hit `/api/admin/scrape-now` to force another cycle.

**Summary appears in English instead of Nepali**
Llama 3.2 3B is a small model and occasionally ignores language instructions. Not fixable from the client side — it corrects itself on the next cycle. If it happens constantly for a specific site, check the terminal logs to see what article text is being sent.

**"RAPIDAPI_KEY not configured"**
The `.env` file isn't being read. Make sure you're running `npm start` from inside the `news-summarizer/` folder, not from its parent.

**A specific site returns 0 articles every cycle**
That site may have changed its HTML structure. Check the terminal output — you'll see warnings like `[ekantipur] HTML scrape failed`. The fix is to update `ARTICLE_URL_PATTERNS` in `server.js` to match the site's current article URL format.

**Port 3000 already in use**
Change `PORT=3000` to `PORT=3001` (or any free port) in `.env`, then restart.

**Scrape runs, but nothing new appears**
Check `cache/seen.json` — URLs stay in there for 7 days to prevent re-summarizing. If you want a full reset, just delete the `cache/` folder and restart the server.

---

## Deploying to Render.com (10 minutes, no credit card)

### Step 1: Push to GitHub

1. Create a **new private repository** on [github.com](https://github.com/new)
   - Name: `news-summarizer`
   - Do NOT initialize with README (you already have one)

2. Push your code:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/news-summarizer.git
   git branch -M main
   git push -u origin main
   ```

### Step 2: Deploy on Render

1. Go to [render.com](https://render.com) and sign up (free tier is fine)
2. Click **"New +"** → **"Web Service"**
3. Select **"Deploy an existing Git repository"**
4. Paste your GitHub repo URL and authorize Render to access it
5. Fill in the form:
   - **Name**: `news-summarizer`
   - **Environment**: `Node`
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Region**: pick closest to you
   - **Plan**: Free (sufficient for this app)

6. Click **"Create Web Service"** — Render will deploy automatically

### Step 3: Add environment variables

After deployment starts:

1. In Render dashboard, go to your web service
2. Click **"Environment"** on the left
3. Add these variables (copy from your `.env` file):
   - `RAPIDAPI_KEY`
   - `OPENROUTER_API_KEY`
   - `MYMEMORY_EMAIL`
   - `PORT=3000`
   - `SCRAPE_INTERVAL_MINUTES=10`

4. Click "Save Changes" — service will redeploy

Your app is now live at `https://news-summarizer-xxx.onrender.com` ✓

### Step 4: Keep it alive with UptimeRobot (prevents spinning down)

The free tier on Render spins down services after 15 minutes of no traffic. This breaks the 10-minute news scrape cycle. Fix it:

1. Go to [uptimerobot.com](https://uptimerobot.com) and sign up (free)
2. Click **"Add New Monitor"**
3. Set up:
   - **Monitor Type**: HTTP(s)
   - **URL**: `https://news-summarizer-xxx.onrender.com/api/health`
   - **Monitoring Interval**: 5 minutes
   - Click **"Create Monitor"**

Now UptimeRobot pings your service every 5 minutes, keeping it warm. The scrape cycle runs without interruption.


