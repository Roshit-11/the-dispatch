# Pre-Deployment Checklist

Use this before you push to GitHub and deploy to Render.

## ✅ Local Setup (Already Done)

- [x] Node.js 18+ installed
- [x] Dependencies installed (`npm install`)
- [x] `.env` file exists with valid keys
- [x] App runs locally (`npm start`)
- [x] Health check works (`http://localhost:3000/api/health`)
- [x] Single-article summarizer works
- [x] Nepali news page loads

## ✅ Git Setup (Already Done)

- [x] `.gitignore` includes `.env`, `node_modules/`, `cache/`
- [x] `.env.example` created (documents required variables)
- [x] Initial commit created
- [x] Ready to push to GitHub

## ⬜ GitHub Setup (Do This Next)

- [ ] Create repository at [github.com/new](https://github.com/new)
  - Name: `news-summarizer`
  - Privacy: Private
  - Do NOT initialize with README
- [ ] Copy the repository URL (looks like `https://github.com/YOUR_USERNAME/news-summarizer.git`)
- [ ] Push code:
  ```bash
  cd /path/to/news-summarizer
  git remote add origin https://github.com/YOUR_USERNAME/news-summarizer.git
  git branch -M main
  git push -u origin main
  ```
- [ ] Verify code is on GitHub (refresh github.com/YOUR_USERNAME/news-summarizer)

## ⬜ Render Setup (Do This After GitHub)

### Deployment
- [ ] Go to [render.com](https://render.com) and sign up
- [ ] Click "New" → "Web Service"
- [ ] Select "Deploy an existing Git repository"
- [ ] Authorize Render with GitHub
- [ ] Select `news-summarizer` repo
- [ ] Fill in form:
  - [ ] Name: `news-summarizer`
  - [ ] Environment: `Node`
  - [ ] Build Command: `npm install`
  - [ ] Start Command: `npm start`
  - [ ] Plan: Free
- [ ] Click "Create Web Service"
- [ ] Wait for build to complete (green "Live" badge)
- [ ] Copy your service URL (e.g., `https://news-summarizer-abc123.onrender.com`)

### Environment Variables
- [ ] Click "Environment" on the left
- [ ] Add these variables (from your `.env` file):
  - [ ] `RAPIDAPI_KEY` = (your key)
  - [ ] `OPENROUTER_API_KEY` = (your key)
  - [ ] `MYMEMORY_EMAIL` = (your email)
  - [ ] `PORT` = `3000`
  - [ ] `SCRAPE_INTERVAL_MINUTES` = `10`
- [ ] Click "Save Changes"
- [ ] Wait for redeploy (should see "Live" again)

### Verification
- [ ] Health check: `https://news-summarizer-abc123.onrender.com/api/health`
  - Should return: `{"status":"ok"}`
- [ ] Main page: `https://news-summarizer-abc123.onrender.com`
  - Should see summarizer UI
- [ ] News page: `https://news-summarizer-abc123.onrender.com/news.html`
  - Should see Nepali articles (may take 2–5 min on first boot)

## ⬜ UptimeRobot Setup (Do This Last)

### Create Monitor
- [ ] Go to [uptimerobot.com](https://uptimerobot.com) and sign up (free)
- [ ] Click "Add New Monitor"
- [ ] Fill in:
  - [ ] Monitor Type: `HTTP(s)`
  - [ ] Friendly Name: `The Dispatch Health Check`
  - [ ] URL: `https://news-summarizer-abc123.onrender.com/api/health`
  - [ ] Monitoring Interval: `5 minutes`
- [ ] Click "Create Monitor"

### Verification
- [ ] Wait 5 minutes
- [ ] Check UptimeRobot dashboard — should show at least 1 green "Up" check
- [ ] Check Render logs — should see activity every 5 minutes

## 🎉 Success Indicators

After 15–30 minutes, you should see:

1. ✅ Service showing "Live" in Render dashboard (green badge)
2. ✅ UptimeRobot showing "Up" (not "Down")
3. ✅ News articles appearing in `/news.html` (first cycle takes 30–90 sec)
4. ✅ Render logs showing scrape cycle every 10 minutes
5. ✅ UptimeRobot logs showing health checks every 5 minutes

## 🆘 If Something Breaks

**Service won't start:**
1. Check Render → "Logs" tab for error messages
2. Look for missing environment variables
3. Verify all keys are correct in Render Environment panel

**Articles not appearing:**
1. Wait 2–3 minutes after first deploy
2. Check Render logs for scrape errors
3. Manually trigger: `https://news-summarizer-abc123.onrender.com/api/admin/scrape-now`

**UptimeRobot shows "Down":**
1. Visit the health check URL manually — does it work?
2. If yes, UptimeRobot will recover on next check
3. If no, see "Service won't start" above

**For detailed help:** See [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## Notes

- **Don't commit `.env`** — it's in `.gitignore` and should never go to GitHub
- **Service URL format:** `https://news-summarizer-RANDOM-ID.onrender.com` (Render generates the ID)
- **First deployment takes ~2 min** — build, dependencies, startup
- **Scrape cron runs every 10 min** — visible in Render logs
- **UptimeRobot must ping every 5 min** — or service will sleep and cron stops

---

**Ready?** Start with the [GitHub Setup](#-github-setup-do-this-next) section above!
