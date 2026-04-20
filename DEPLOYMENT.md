# Deployment Guide: The Dispatch on Render.com

This guide walks you through deploying the news summarizer to Render.com for free (no credit card needed).

---

## Quick Summary

1. **GitHub** — Push your code to a private GitHub repo
2. **Render** — Connect Render to GitHub, add environment variables, deploy
3. **UptimeRobot** — Ping your service every 5 minutes to prevent it from sleeping

**Total time:** ~10 minutes. **Cost:** $0.

---

## ⚡ Step 1: Push to GitHub

### 1a. Create a GitHub repository

1. Go to [github.com/new](https://github.com/new)
2. Fill in:
   - **Repository name**: `news-summarizer`
   - **Description**: "Local news summarizer + Nepali aggregator"
   - **Privacy**: Private (to keep your API keys safe)
   - **Do NOT** check "Initialize this repository with..."
3. Click **"Create repository"**

### 1b. Connect your local repo to GitHub

In your terminal:

```bash
cd /path/to/news-summarizer
git remote add origin https://github.com/YOUR_USERNAME/news-summarizer.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

**Result:** Your code is now on GitHub. ✓

---

## 🚀 Step 2: Deploy on Render

### 2a. Create a Web Service

1. Go to [render.com](https://render.com)
2. Click **"Sign up"** (or sign in if you have an account)
3. Click **"New"** → **"Web Service"**
4. Select **"Deploy an existing Git repository"**
5. Click **"Connect"** and authorize Render to access your GitHub repos
6. Select the `news-summarizer` repository

### 2b. Configure the service

Fill in the form:

| Field | Value |
|-------|-------|
| **Name** | `news-summarizer` |
| **Environment** | `Node` |
| **Region** | Pick one closest to you |
| **Branch** | `main` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free |

Click **"Create Web Service"** — Render will start building and deploying.

**Wait for the build to complete** (you'll see a URL like `https://news-summarizer-xxx.onrender.com`)

---

## 🔑 Step 3: Add Environment Variables

Once deployed (you'll see a green "Live" badge):

1. In the Render dashboard, click on your `news-summarizer` service
2. Click **"Environment"** on the left sidebar
3. Click **"Add Environment Variable"** and fill in:

| Variable | Value |
|----------|-------|
| `RAPIDAPI_KEY` | Your RapidAPI key (from `.env`) |
| `OPENROUTER_API_KEY` | Your OpenRouter key (from `.env`) |
| `MYMEMORY_EMAIL` | Your email (from `.env`) |
| `PORT` | `3000` |
| `SCRAPE_INTERVAL_MINUTES` | `10` |

4. Click **"Save Changes"** — the service will redeploy with your environment variables

**Result:** Your app is now live and running! ✓

**Your URL:** `https://news-summarizer-xxx.onrender.com`

---

## ⏰ Step 4: Keep It Awake with UptimeRobot

On Render's free tier, services go to sleep after 15 minutes of no traffic. This breaks the scrape cron. UptimeRobot solves this by pinging your service every 5 minutes.

### 4a. Set up UptimeRobot

1. Go to [uptimerobot.com](https://uptimerobot.com)
2. Click **"Sign Up"** (free account)
3. After login, click **"Add New Monitor"**

### 4b. Configure the monitor

Fill in:

| Field | Value |
|-------|-------|
| **Monitor Type** | `HTTP(s)` |
| **Friendly Name** | `The Dispatch Health Check` |
| **URL** | `https://news-summarizer-xxx.onrender.com/api/health` |
| **Monitoring Interval** | `5 minutes` |

(Replace `xxx` with your actual Render service ID)

4. Click **"Create Monitor"**

**Result:** UptimeRobot now pings your service every 5 minutes, keeping it alive. Your scrape cycle runs 24/7. ✓

---

## ✅ Verify Everything Works

After 5 minutes, check:

1. **Health check:** Visit `https://news-summarizer-xxx.onrender.com/api/health`
   - Should see: `{"status":"ok"}`

2. **Main page:** Visit `https://news-summarizer-xxx.onrender.com`
   - Should see the single-article summarizer UI

3. **News feed:** Visit `https://news-summarizer-xxx.onrender.com/news.html`
   - Should see Nepali articles (they populate on the first scrape cycle, ~2 min after boot)

4. **UptimeRobot logs:** In UptimeRobot, click your monitor and scroll down
   - Should see a series of green "Up" checks

---

## 🆘 Troubleshooting

### Service won't start / shows "Error Logs"

**Cause:** Missing or wrong environment variables.

**Fix:**
1. Go to your Render service → **"Logs"** tab
2. Look for errors mentioning `RAPIDAPI_KEY` or `OPENROUTER_API_KEY`
3. Go back to **"Environment"** and double-check all variables are set
4. Click **"Save Changes"** to redeploy

### News articles not appearing

**Cause:** Scrape cycle hasn't run yet, or the service is asleep.

**Fix:**
1. Wait 2–3 minutes after first deployment
2. Check that UptimeRobot is pinging (look at its logs)
3. Manually trigger a scrape: visit `https://news-summarizer-xxx.onrender.com/api/admin/scrape-now`
4. Wait 30–90 seconds and refresh `/news.html`

### "Cannot GET /news.html" or 404 errors

**Cause:** Service might not have finished deploying, or static files aren't being served.

**Fix:**
1. Wait 30 seconds and refresh
2. Check the Render dashboard — is there a green "Live" badge?
3. If not, click **"Manual Deploy"** → **"Deploy latest commit"**

### UptimeRobot shows "Down"

**Cause:** Service probably spun down (shouldn't happen if UptimeRobot is working).

**Fix:**
1. Check Render logs for errors
2. Manually trigger `/api/health` in your browser
3. If it works, UptimeRobot will pick it up on the next check (5 min later)
4. If it doesn't work, see "Service won't start" above

---

## 📋 Useful Render / GitHub commands

### Push a code update

```bash
cd /path/to/news-summarizer
git add .
git commit -m "Describe your changes"
git push origin main
```

Render will auto-redeploy your service within 1–2 minutes.

### View live logs

In Render dashboard → your service → **"Logs"** tab. Watch in real-time as requests come in and scrapes run.

### Stop/restart the service

In Render dashboard, click the menu (⋮) and select **"Stop"** or **"Restart"**.

### Change environment variables

Render → **"Environment"** → edit the variables → click **"Save Changes"** to redeploy.

---

## 🎉 You're done!

Your app is now running 24/7 on Render. The scrape cycle runs every 10 minutes, new articles appear in `/news.html`, and UptimeRobot keeps everything alive.

**Share your URL:** `https://news-summarizer-xxx.onrender.com`

---

## Optional: Add more monitoring

- **Sentry** — Catch errors in production (free tier)
- **Logtail** — Centralized log streaming (free tier)
- **DataDog** — Advanced monitoring (not free, but powerful)

For now, Render's built-in logs + UptimeRobot are plenty.

---

**Questions?** Check the main [README.md](./README.md) or the troubleshooting section there.
