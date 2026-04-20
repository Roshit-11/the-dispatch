# 🚀 Quick Start: Deploy to Render in 10 Minutes

This is the fastest path from "code on laptop" to "live on the internet".

---

## Step 1: Push to GitHub (2 minutes)

1. Go to [github.com/new](https://github.com/new)
2. Name it `news-summarizer`, set it to **Private**, click **Create**
3. Copy the repo URL (looks like `https://github.com/YOUR_USERNAME/news-summarizer.git`)
4. In terminal:
```bash
cd /path/to/news-summarizer
git remote add origin https://github.com/YOUR_USERNAME/news-summarizer.git
git branch -M main
git push -u origin main
```

✅ Your code is now on GitHub.

---

## Step 2: Deploy on Render (3 minutes)

1. Go to [render.com](https://render.com) → Sign up (free)
2. Click **New** → **Web Service**
3. Click **Connect** and authorize GitHub
4. Select `news-summarizer` repo
5. Fill in:
   - **Name:** `news-summarizer`
   - **Build:** `npm install`
   - **Start:** `npm start`
   - **Plan:** Free
6. Click **Create Web Service** and wait for the green "Live" badge

✅ Your app is deployed. Copy your URL (e.g., `https://news-summarizer-abc123.onrender.com`)

---

## Step 3: Add Environment Variables (2 minutes)

1. In Render dashboard, go to **Environment**
2. Add these from your `.env` file:
   - `RAPIDAPI_KEY`
   - `OPENROUTER_API_KEY`
   - `MYMEMORY_EMAIL`
   - `PORT=3000`
   - `SCRAPE_INTERVAL_MINUTES=10`
3. Click **Save Changes** (service redeploys automatically)

✅ Your app now has all its keys and will work.

---

## Step 4: Keep It Alive with UptimeRobot (3 minutes)

1. Go to [uptimerobot.com](https://uptimerobot.com) → Sign up (free)
2. Click **Add New Monitor**
3. Fill in:
   - **Type:** HTTP(s)
   - **Name:** `The Dispatch`
   - **URL:** `https://news-summarizer-abc123.onrender.com/api/health`
   - **Interval:** 5 minutes
4. Click **Create Monitor**

✅ UptimeRobot pings your service every 5 minutes. It stays alive 24/7 and the scrape cron runs continuously.

---

## Test It

After waiting 2–3 minutes:

- **Health:** https://news-summarizer-abc123.onrender.com/api/health
- **UI:** https://news-summarizer-abc123.onrender.com
- **News:** https://news-summarizer-abc123.onrender.com/news.html (articles appear after first scrape ~30 sec)

---

## Done! 🎉

Your app is live, running 24/7, scraping Nepali news every 10 minutes.

**Questions?** See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed help or [DEPLOYMENT-CHECKLIST.md](./DEPLOYMENT-CHECKLIST.md) for a step-by-step guide.
