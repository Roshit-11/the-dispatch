# 🌐 Deploy to Render: Complete Step-by-Step

This guide walks you through the **entire process** from creating a GitHub repository to going live on Render.

---

## Phase 1: GitHub (5 minutes)

### 1.1 Create a GitHub Repository

1. Go to **[github.com/new](https://github.com/new)**
2. Fill in:
   - **Repository name:** `news-summarizer`
   - **Description:** "Local news summarizer + Nepali aggregator running on Render"
   - **Privacy:** Choose **Private** (to keep your API keys safe)
   - **Do NOT check** any initialization options
3. Click **"Create repository"**
4. You'll see a page with commands. **Copy the HTTPS URL** (it looks like):
   ```
   https://github.com/YOUR_USERNAME/news-summarizer.git
   ```

### 1.2 Connect Your Local Code to GitHub

Open your terminal and run:

```bash
# Navigate to your project
cd /Users/roshitlamichhane/Downloads/news-summarizer

# Add GitHub as the remote (replace URL with yours)
git remote add origin https://github.com/YOUR_USERNAME/news-summarizer.git

# Rename the branch to main (GitHub's default)
git branch -M main

# Push all your commits to GitHub
git push -u origin main
```

**Expected output:**
```
Enumerating objects: 12, done.
...
 * [new branch]      main -> main
Branch 'main' set up to track remote branch 'main' from 'origin'.
```

### 1.3 Verify

- Go to your GitHub repo URL: `https://github.com/YOUR_USERNAME/news-summarizer`
- You should see all your files (README.md, server.js, etc.)
- You should NOT see `.env` (it's in `.gitignore`)

✅ **Phase 1 complete!**

---

## Phase 2: Render (8 minutes)

### 2.1 Sign Up on Render

1. Go to **[render.com](https://render.com)**
2. Click **"Sign up"** (or log in if you have an account)
3. You can sign up with GitHub (easier) or email
4. After signup, you'll land on the dashboard

### 2.2 Create a Web Service

1. Click the **"New +"** button (top-left or top-right)
2. Select **"Web Service"**
3. Click **"Connect"** next to "Deploy an existing Git repository"

### 2.3 Authorize Render + GitHub

1. You'll be redirected to GitHub to authorize Render
2. Click **"Authorize render-rnw"** (or similar)
3. GitHub will ask you to authenticate and confirm
4. Return to Render and select **`news-summarizer`** from the list of repositories

### 2.4 Configure the Service

You'll now see a form. Fill it in:

| Field | Value |
|-------|-------|
| **Name** | `news-summarizer` |
| **Environment** | `Node` |
| **Region** | Choose closest to you (e.g., `Oregon` if in North America) |
| **Branch** | `main` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free |

**Leave everything else blank/default.**

### 2.5 Deploy

Click the **"Create Web Service"** button.

Render will now:
- Pull your code from GitHub
- Install dependencies
- Start your server

**Wait for the green "Live" badge** (takes 1–2 minutes).

You'll see a URL like:
```
https://news-summarizer-xxxxx.onrender.com
```

**Copy this URL — you'll need it in the next phase.**

✅ **Phase 2 complete! Your app is live!**

---

## Phase 3: Add Secrets (Environment Variables) (3 minutes)

### 3.1 Open Environment Settings

1. In your Render dashboard, click on your **`news-summarizer`** service
2. On the left sidebar, click **"Environment"**
3. You'll see a section for **"Environment Variables"**

### 3.2 Add Each Variable

Click **"Add Environment Variable"** for each of these. Get the values from your `.env` file:

#### `RAPIDAPI_KEY`
- **Key:** `RAPIDAPI_KEY`
- **Value:** (copy from your `.env` file, starting with `94d1...`)
- Click **"Add"**

#### `OPENROUTER_API_KEY`
- **Key:** `OPENROUTER_API_KEY`
- **Value:** (copy from your `.env` file, starting with `sk-or-v1-...`)
- Click **"Add"**

#### `MYMEMORY_EMAIL`
- **Key:** `MYMEMORY_EMAIL`
- **Value:** (from your `.env` file, e.g., `noreply.meetingai@gmail.com`)
- Click **"Add"**

#### `PORT`
- **Key:** `PORT`
- **Value:** `3000`
- Click **"Add"**

#### `SCRAPE_INTERVAL_MINUTES`
- **Key:** `SCRAPE_INTERVAL_MINUTES`
- **Value:** `10`
- Click **"Add"**

### 3.3 Save and Redeploy

After adding all variables, click the **"Save Changes"** button at the top.

Render will automatically redeploy your service with the new environment variables. **Wait for the green "Live" badge again** (30 seconds–1 minute).

✅ **Phase 3 complete!**

---

## Phase 4: Keep It Alive with UptimeRobot (3 minutes)

### Why This Is Needed

Render's free tier spins down services after 15 minutes of inactivity. Your scrape cycle runs every 10 minutes, so without UptimeRobot, it would freeze while the service is sleeping.

UptimeRobot solves this by pinging your service every 5 minutes, keeping it warm 24/7.

### 4.1 Sign Up on UptimeRobot

1. Go to **[uptimerobot.com](https://uptimerobot.com)**
2. Click **"Sign Up"** (or log in if you have an account)
3. Complete signup (free tier is perfect)

### 4.2 Create a Monitor

1. After login, click **"Add New Monitor"**
2. You'll see a form. Fill in:

| Field | Value |
|-------|-------|
| **Monitor Type** | `HTTP(s)` |
| **Friendly Name** | `The Dispatch Health Check` |
| **URL** | `https://news-summarizer-xxxxx.onrender.com/api/health` |
| **Monitoring Interval** | `5 minutes` |

(Replace `xxxxx` with your actual Render service ID from Phase 2)

3. Click **"Create Monitor"**

### 4.3 Verify It Works

- UptimeRobot will start monitoring immediately
- Wait 5 minutes
- You should see green "Up" checks in the UptimeRobot dashboard
- Your Render service should show activity in its logs every 5 minutes

✅ **Phase 4 complete! Service stays alive 24/7!**

---

## Phase 5: Verify Everything Works (5 minutes)

### 5.1 Health Check

Visit:
```
https://news-summarizer-xxxxx.onrender.com/api/health
```

You should see:
```json
{"status":"ok"}
```

### 5.2 Main Page

Visit:
```
https://news-summarizer-xxxxx.onrender.com
```

You should see the article summarizer UI (same as `http://localhost:3000`).

### 5.3 News Feed

Visit:
```
https://news-summarizer-xxxxx.onrender.com/news.html
```

You should see Nepali news articles. **Note:** On first boot, the first scrape cycle takes 30–90 seconds, so articles might not appear immediately. Wait a minute and refresh.

### 5.4 Check Logs

Back in Render dashboard:
1. Click on your service
2. Click the **"Logs"** tab
3. You should see:
   - Startup messages
   - First scrape cycle output (mentioning ekantipur, onlinekhabar, etc.)
   - Every 10 minutes: another scrape cycle
   - Every 5 minutes: UptimeRobot health check pings

✅ **Everything working!**

---

## 🎉 You're Done!

Your app is now:
- ✅ Deployed on Render
- ✅ Running 24/7
- ✅ Scraping Nepali news every 10 minutes
- ✅ Protected from sleep with UptimeRobot

---

## 📋 Your Live URLs

- **Main app:** `https://news-summarizer-xxxxx.onrender.com`
- **News feed:** `https://news-summarizer-xxxxx.onrender.com/news.html`
- **Health check:** `https://news-summarizer-xxxxx.onrender.com/api/health`
- **GitHub repo:** `https://github.com/YOUR_USERNAME/news-summarizer`

---

## 🆘 Troubleshooting

### Build Failed / Service Won't Start

**Symptoms:** Red error in Render dashboard, service showing "Failed to start"

**Fix:**
1. Go to **Logs** tab to see the error message
2. Look for mentions of missing environment variables
3. Go back to **Environment** and add any missing variables
4. Click **"Save Changes"** to redeploy

### Health Check Returns 404

**Symptoms:** Visit `/api/health` and get "Cannot GET /api/health"

**Fix:**
1. Service might still be starting. Wait 30 seconds and try again.
2. Check **Logs** for startup errors
3. If needed, click the menu (⋮) → **"Restart"**

### Articles Not Appearing

**Symptoms:** `/news.html` loads but shows "No articles yet"

**Fix:**
1. Wait 2–3 minutes after first deployment (first scrape takes time)
2. Check **Logs** for scrape errors
3. Manually trigger a scrape: visit `/api/admin/scrape-now`
4. Wait 30 seconds and refresh

### UptimeRobot Shows "Down"

**Symptoms:** UptimeRobot dashboard shows service as "Down"

**Fix:**
1. Manually visit `/api/health` in your browser — does it work?
2. If yes, UptimeRobot will pick it up on the next check (5 min)
3. If no, see "Health Check Returns 404" above

### Need More Help?

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed troubleshooting.

---

## 🚀 Next Steps (Optional)

Once deployed, you can:

1. **Share your URL** with others — they can use your live instance
2. **Monitor performance** — use Render's Metrics tab to see request patterns
3. **Update code** — just `git push origin main` and Render auto-redeploys
4. **Add analytics** — integrate Sentry or Logtail for better visibility
5. **Scale up** — upgrade to Render's paid plan if you outgrow the free tier

---

**Congratulations! 🎉 Your app is live on the internet!**
