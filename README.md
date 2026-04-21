# The Dispatch — Nepali News Aggregator & Summarizer

A lightweight Node.js application that aggregates and summarizes Nepali news articles in real-time using AI. It features both a single-article summarizer and an automated Nepali news feed updated every 10 minutes.

**Live Demo:** [https://the-dispatch-wa0s.onrender.com](https://the-dispatch-wa0s.onrender.com)

---

## ✨ Features

- 🇳🇵 **Nepali News Aggregator** — Automatically scrapes & summarizes articles from 4 major Nepali news sites every 10 minutes
- 📰 **Single Article Summarizer** — Paste any news URL to get an instant summary in your chosen language
- 🤖 **AI-Powered Summaries** — Uses Llama 3.2 3B via OpenRouter for fast, accurate summaries
- 🌍 **Multi-Language Support** — 10 native languages + 8 via translation
- ⚡ **Real-Time Updates** — Live feed with deduplication to avoid redundant summaries
- 🚀 **Fully Automated** — Runs 24/7 on Render with UptimeRobot monitoring
- 📱 **Responsive UI** — Clean, mobile-friendly interface

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- Free API keys from [RapidAPI](https://rapidapi.com) and [OpenRouter](https://openrouter.ai)

### 1. Clone & Install

```bash
git clone https://github.com/Roshit-11/the-dispatch.git
cd the-dispatch
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory:

```env
# RapidAPI key (for article fetching)
RAPIDAPI_KEY=your_rapidapi_key_here

# OpenRouter API key (for Llama 3.2 3B summaries)
OPENROUTER_API_KEY=your_openrouter_key_here

# MyMemory email (for translation)
MYMEMORY_EMAIL=your_email@example.com

# Server configuration
PORT=3000
SCRAPE_INTERVAL_MINUTES=10
```

**Where to get keys:**
- **RapidAPI Key:** [RapidAPI Dashboard](https://rapidapi.com/account/settings/security)
- **OpenRouter Key:** [OpenRouter Settings](https://openrouter.ai/settings/keys) (free tier available)
- **MyMemory Email:** Any email address (used to raise translation quota)

### 3. Run Locally

```bash
npm start
```

You'll see:
```
✓ RapidAPI key loaded
✓ OpenRouter key loaded
✓ MyMemory email: your_email@example.com

📰 The Dispatch is running
   Open:        http://localhost:3000
   News feed:   http://localhost:3000/news.html
   Health:      http://localhost:3000/api/health
   Trigger:     http://localhost:3000/api/admin/scrape-now
   Cycle every: 10 minute(s)
```

Open **http://localhost:3000** in your browser.

---

## 📖 How It Works

### Single-Article Summarizer (`/`)
1. Paste any news article URL
2. Choose target language (10 native + 8 via translation)
3. Select summary length (short/medium/long)
4. Get an instant AI-powered summary

### Nepali News Aggregator (`/news.html`)
The server runs automated scrape cycles:

1. **Fetches** new articles from 4 Nepali news sites:
   - Ekantipur
   - Online Khabar
   - Ratopati
   - Setopati

2. **Filters** articles using deduplication (tracks seen URLs for 7 days)

3. **Summarizes** new articles using Llama 3.2 3B AI model (3-sentence summaries in Nepali)

4. **Caches** results locally for instant frontend load times

5. **Repeats** every 10 minutes (configurable)

---

## 📁 Project Structure

```
the-dispatch/
├── server.js              ← Express server + scrape scheduler
├── package.json           ← Dependencies
├── .env                   ← Environment variables (DO NOT commit)
├── .gitignore             ← Git ignore rules
├── public/
│   ├── index.html         ← Single-article summarizer UI
│   ├── news.html          ← Nepali news feed UI
│   ├── style.css          ← Styling
│   └── script.js          ← Frontend logic
├── cache/                 ← Auto-created storage
│   ├── feed.json          ← Cached articles
│   └── seen.json          ← Deduplication tracker
└── README.md
```

---

## 🔌 API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Single-article summarizer UI |
| `/news.html` | GET | Nepali news feed UI |
| `/api/health` | GET | Health check (for uptime monitoring) |
| `/api/news` | GET | Get cached news feed (JSON) |
| `/api/summarize` | POST | Summarize a URL + translate |
| `/api/admin/scrape-now` | GET | Trigger scrape immediately |

---

## 🚀 Deploy to Render (Free Tier)

### Step 1: Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/the-dispatch.git
git branch -M main
git push -u origin main
```

### Step 2: Create Render Service

1. Go to [render.com](https://render.com) and sign up (free)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Fill in:
   - **Name:** `the-dispatch`
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

5. Click **"Create Web Service"**

### Step 3: Add Environment Variables

1. Go to **Settings** → **Environment**
2. Add these variables (from your `.env`):
   - `RAPIDAPI_KEY`
   - `OPENROUTER_API_KEY`
   - `MYMEMORY_EMAIL`
   - `PORT=3000`
   - `SCRAPE_INTERVAL_MINUTES=10`

3. Click **"Save"** — service will redeploy

### Step 4: Keep Service Alive (UptimeRobot)

Render's free tier spins down after 15 minutes of inactivity. Fix this:

1. Go to [uptimerobot.com](https://uptimerobot.com) and sign up (free)
2. Click **"Add Monitor"**
3. Configure:
   - **Type:** HTTP(s)
   - **URL:** `https://your-service.onrender.com/api/health`
   - **Interval:** 5 minutes

4. Click **"Create"**

Now your service stays alive 24/7! ✅

---

## 🛠️ Troubleshooting

### "No articles yet" on first load
First scrape takes 30-90 seconds. Wait a minute or visit `/api/admin/scrape-now` to trigger manually.

### Summaries in English instead of Nepali
Llama 3.2 3B occasionally ignores language instructions. Usually corrects itself on next cycle.

### API key errors
- Check `.env` file exists in project root
- Verify keys are valid and not expired
- On Render, verify environment variables are set correctly

### Port already in use
Change `PORT=3000` to `PORT=3001` in `.env`

### Article scraping fails for a site
Sites may change HTML structure. Update URL patterns in `server.js` if needed.

---

## 📊 Performance

- **Scrape Time:** ~20-30 seconds per cycle (4 sites, ~10 articles)
- **API Calls/Day:** ~1,440 (well within free tier limits)
- **Cache Storage:** ~5-10 MB for 7-day history
- **Uptime:** 24/7 with UptimeRobot

---

## 📝 License

MIT License — see LICENSE file for details

---

## 🤝 Contributing

Found a bug? Have a feature idea? Feel free to:
1. Fork this repository
2. Create a feature branch
3. Submit a pull request

---

## 📧 Contact

For questions or feedback, reach out on GitHub Issues.

---

**Built with ❤️ for Nepali news readers**
