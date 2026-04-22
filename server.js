// =============================================================
// The Dispatch — local backend server
// =============================================================
// Express server that:
//   1. Serves the frontend HTML from /public
//   2. Proxies calls to RapidAPI article summarizer + MyMemory translation
//   3. Runs a scrape loop every N minutes that:
//        - fetches articles from 4 Nepali news sites
//        - summarizes new ones via Llama 3.3 70B on OpenRouter (free tier)
//        - falls back through Gemma 3 27B, DeepSeek v3, Qwen3 8B, Mistral 7B
//        - stores results on disk in ./cache/feed.json
//   4. Serves the stored feed at /api/news
//
// Run with:  npm install  &&  npm start
// =============================================================

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------
// Config (from .env)
// -----------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SCRAPE_INTERVAL_MIN = Math.max(5, Number(process.env.SCRAPE_INTERVAL_MINUTES || 30));

const ARTICLE_HOST = 'article-extractor-and-summarizer.p.rapidapi.com';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Fallback chain for summarization. OpenRouter free models go in and out of
// availability constantly — having multiple fallbacks means we don't fail
// a whole cycle when one provider is rate-limited or delisted.
//
// Fallback chain ordered by Devanagari quality and availability.
// Using larger, more capable models first — they produce better Nepali output.
// Free-tier models rotate in/out so we maintain 5 fallbacks to stay resilient.
const OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',   // best free multilingual, great Nepali
  'google/gemma-3-27b-it:free',                // strong Devanagari support
  'deepseek/deepseek-chat-v3-0324:free',       // very capable, good multilingual
  'qwen/qwen3-8b:free',                        // lightweight fallback, good Nepali
  'mistralai/mistral-7b-instruct:free',        // last-resort fallback
];

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

const CACHE_DIR = path.join(__dirname, 'cache');
const FEED_FILE = path.join(CACHE_DIR, 'feed.json');
const SEEN_FILE = path.join(CACHE_DIR, 'seen.json');

const MAX_ARTICLES_IN_FEED = 24;
const MAX_PER_SOURCE = 6;
const MAX_NEW_PER_CYCLE = 3;
const ARTICLE_RETENTION_MS = 1000 * 60 * 60 * 48; // 48 hours
const SEEN_RETENTION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const NEWS_SOURCES = [
  {
    id: 'ekantipur',
    name: 'Ekantipur',
    nameNp: 'कान्तिपुर',
    listingUrl: 'https://ekantipur.com',
    rssUrl: null,
  },
  {
    id: 'onlinekhabar',
    name: 'Online Khabar',
    nameNp: 'अनलाइनखबर',
    listingUrl: 'https://www.onlinekhabar.com',
    rssUrl: 'https://www.onlinekhabar.com/feed',
  },
  {
    id: 'ratopati',
    name: 'Ratopati',
    nameNp: 'रातोपाटी',
    listingUrl: 'https://www.ratopati.com',
    rssUrl: null,
  },
  {
    id: 'setopati',
    name: 'Setopati',
    nameNp: 'सेतोपाटी',
    listingUrl: 'https://www.setopati.com',
    rssUrl: null,
  },
];

const ARTICLE_URL_PATTERNS = {
  ekantipur: /^https?:\/\/(?:www\.)?ekantipur\.com\/[a-z]+\/\d{4}\/\d{2}\/\d{2}\/[^\/]+$/i,
  onlinekhabar: /^https?:\/\/(?:www\.)?onlinekhabar\.com\/\d{4}\/\d{2}\/\d+/i,
  ratopati: /^https?:\/\/(?:www\.)?ratopati\.com\/(?:story|news)\/\d+/i,
  setopati: /^https?:\/\/(?:www\.)?setopati\.com\/[a-z\-]+\/\d+/i,
};

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// -----------------------------------------------------------
// Small helpers
// -----------------------------------------------------------
async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ne,en;q=0.9',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function matchTag(block, tagName) {
  const cdata = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tagName}>`, 'i');
  const plain = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = block.match(cdata) || block.match(plain);
  return m ? m[1].trim() : null;
}

function cleanText(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function absUrl(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

function hashUrl(u) {
  let h = 5381;
  for (let i = 0; i < u.length; i++) h = ((h << 5) + h) + u.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// -----------------------------------------------------------
// Disk-backed storage (simple JSON files, no DB needed)
// -----------------------------------------------------------
async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function loadFeed() {
  const data = await readJson(FEED_FILE, []);
  return Array.isArray(data) ? data : [];
}

async function saveFeed(articles) {
  const cutoff = Date.now() - ARTICLE_RETENTION_MS;
  const pruned = articles.filter(a => a.timestamp >= cutoff);
  pruned.sort((a, b) => b.timestamp - a.timestamp);
  await writeJson(FEED_FILE, pruned.slice(0, MAX_ARTICLES_IN_FEED * 2));
}

async function loadSeen() {
  const data = await readJson(SEEN_FILE, {});
  // Clean expired entries on load
  const cutoff = Date.now() - SEEN_RETENTION_MS;
  const cleaned = {};
  for (const [k, ts] of Object.entries(data)) {
    if (ts > cutoff) cleaned[k] = ts;
  }
  return cleaned;
}

async function saveSeen(seenMap) {
  await writeJson(SEEN_FILE, seenMap);
}

// -----------------------------------------------------------
// Article discovery (RSS + HTML scraping)
// -----------------------------------------------------------
function parseRss(xml, sourceBase) {
  const items = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const item of matches) {
    const link = matchTag(item, 'link');
    const title = matchTag(item, 'title');
    let imageUrl = null;
    const enc = item.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
    if (enc) imageUrl = enc[1];
    if (!imageUrl) {
      const mc = item.match(/<media:content[^>]+url=["']([^"']+)["']/i);
      if (mc) imageUrl = mc[1];
    }
    if (!imageUrl) {
      const mt = item.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
      if (mt) imageUrl = mt[1];
    }
    if (!imageUrl) {
      const desc = matchTag(item, 'description');
      if (desc) {
        const img = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (img) imageUrl = img[1];
      }
    }
    if (link && title) {
      items.push({
        url: absUrl(link, sourceBase),
        title: cleanText(title),
        imageUrl: imageUrl ? absUrl(imageUrl, sourceBase) : null,
      });
    }
  }
  return items;
}

function scrapeListingPage(html, sourceBase, linkPattern) {
  const results = [];
  const seen = new Set();
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = absUrl(match[1], sourceBase);
    if (!linkPattern.test(url)) continue;
    if (seen.has(url)) continue;

    const inner = match[2];
    let title = null;
    const h = inner.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i);
    if (h) title = cleanText(h[1]);
    if (!title) {
      const alt = inner.match(/<img[^>]+alt=["']([^"']+)["']/i);
      if (alt) title = cleanText(alt[1]);
    }
    if (!title) title = cleanText(inner);
    if (!title || title.length < 10 || title.length > 300) continue;

    let imageUrl = null;
    const imgIn = inner.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
    if (imgIn) {
      imageUrl = imgIn[1];
    } else {
      const wStart = Math.max(0, match.index - 400);
      const wEnd = Math.min(html.length, match.index + match[0].length + 400);
      const nearby = html.slice(wStart, wEnd).match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
      if (nearby) imageUrl = nearby[1];
    }

    seen.add(url);
    results.push({
      url,
      title,
      imageUrl: imageUrl ? absUrl(imageUrl, sourceBase) : null,
    });
    if (results.length >= 20) break;
  }
  return results;
}

async function discoverArticles(source) {
  const pattern = ARTICLE_URL_PATTERNS[source.id];

  if (source.rssUrl) {
    try {
      const res = await fetchWithTimeout(source.rssUrl);
      if (res.ok) {
        const xml = await res.text();
        const items = parseRss(xml, source.listingUrl);
        if (items.length > 0) return items.slice(0, 10);
      }
    } catch (err) {
      console.warn(`[${source.id}] RSS failed: ${err.message}`);
    }
  }

  try {
    const res = await fetchWithTimeout(source.listingUrl);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const html = await res.text();
    return scrapeListingPage(html, source.listingUrl, pattern).slice(0, 10);
  } catch (err) {
    console.warn(`[${source.id}] HTML scrape failed: ${err.message}`);
    return [];
  }
}

async function fetchArticleText(articleUrl) {
  const res = await fetchWithTimeout(articleUrl);
  if (!res.ok) throw new Error(`Article fetch failed: ${res.status}`);
  const html = await res.text();

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  const a = body.match(/<article[\s\S]*?<\/article>/i);
  if (a) body = a[0];
  else {
    const m = body.match(/<main[\s\S]*?<\/main>/i);
    if (m) body = m[0];
  }

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(body)) !== null) {
    const text = cleanText(m[1]);
    if (text.length > 40) paragraphs.push(text);
  }

  return paragraphs.join('\n\n').slice(0, 1200);
}

// -----------------------------------------------------------
// OpenRouter summarization (free models, with fallback chain)
// -----------------------------------------------------------

// Custom error class so we can distinguish rate-limit errors from other
// errors after all fallbacks have been tried. Rate limits should abort the
// whole scrape cycle; other errors should just skip the current article.
class RateLimitedError extends Error {
  constructor(message) { super(message); this.name = 'RateLimitedError'; }
}

async function callOpenRouter(model, messages) {
  const res = await fetchWithTimeout(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      // Optional but recommended — identifies the app in OpenRouter dashboards.
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'The Dispatch',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 120,
    }),
  }, 30_000);

  // Handle HTTP-level errors
  if (!res.ok) {
    const errBody = await res.text();
    const shortMsg = errBody.slice(0, 200);
    if (res.status === 429) {
      throw new RateLimitedError(`[${model}] rate-limited: ${shortMsg}`);
    }
    throw new Error(`[${model}] HTTP ${res.status}: ${shortMsg}`);
  }

  const data = await res.json();

  // OpenRouter sometimes returns errors inside a 200 OK response. Check for
  // both plain string errors and structured error objects.
  if (data.error) {
    const errMsg = typeof data.error === 'string'
      ? data.error
      : JSON.stringify(data.error);
    if (errMsg.includes('429') || /rate.?limit/i.test(errMsg)) {
      throw new RateLimitedError(`[${model}] rate-limited (in body): ${errMsg.slice(0, 200)}`);
    }
    throw new Error(`[${model}] error in body: ${errMsg.slice(0, 200)}`);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`[${model}] returned no content`);
  return text.trim();
}

async function summarizeWithLlama(articleText, title) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured in .env');
  }

  const systemMsg = `You are a professional Nepali news editor. You ALWAYS write in Nepali (Devanagari script). You summarize articles concisely and factually in exactly 3 short sentences. You never respond in English. You never add preamble like "Here is the summary" — you output only the summary itself.`;

  const userMsg = `तलको नेपाली समाचार लेखलाई ३ छोटो वाक्यमा सारांश गर्नुहोस्। नेपाली भाषामा मात्र लेख्नुहोस्। केवल मुख्य तथ्यहरू समावेश गर्नुहोस्। सारांश बाहेक अरू केही नलेख्नुहोस्।

शीर्षक: ${title}

लेख:
${articleText}

सारांश (नेपालीमा):`;

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user',   content: userMsg },
  ];

  // Walk the fallback chain. Different strategies for different error types:
  //   - Rate limit  → try next model immediately (maybe it's a different provider)
  //   - Other error → try next model too, but log it
  // Only throw if ALL models failed.
  let lastError = null;
  let allRateLimited = true;

  for (const model of OPENROUTER_MODELS) {
    try {
      const result = await callOpenRouter(model, messages);
      return result;
    } catch (err) {
      lastError = err;
      if (!(err instanceof RateLimitedError)) {
        allRateLimited = false;
      }
      console.warn(`[llama] ${err.message.slice(0, 150)} — trying next model…`);
    }
  }

  // All models failed. Preserve the rate-limited-ness of the error so the
  // cycle knows whether to abort or just skip this article.
  if (allRateLimited) {
    throw new RateLimitedError(`All models rate-limited. Last: ${lastError?.message?.slice(0, 200)}`);
  }
  throw new Error(`All models failed. Last: ${lastError?.message?.slice(0, 200)}`);
}

// -----------------------------------------------------------
// The scrape pipeline
// -----------------------------------------------------------
let scrapeInProgress = false;

async function runScrapeCycle() {
  if (scrapeInProgress) {
    console.log('[scrape] already running, skipping');
    return { skipped: true };
  }
  scrapeInProgress = true;
  const startTs = Date.now();

  try {
    const existing = await loadFeed();
    const seenMap = await loadSeen();
    const existingUrls = new Set(existing.map(a => a.url));
    const newlyAdded = [];
    let rateLimited = false; // set once any source hits 429, abort the cycle

    for (const source of NEWS_SOURCES) {
      if (rateLimited) break;
      let added = 0;
      try {
        const discovered = await discoverArticles(source);
        console.log(`[${source.id}] discovered ${discovered.length} candidate articles`);

        for (const art of discovered) {
          if (added >= MAX_NEW_PER_CYCLE) break;
          if (existingUrls.has(art.url)) continue;
          const h = hashUrl(art.url);
          if (seenMap[h]) continue;

          try {
            const articleText = await fetchArticleText(art.url);
            if (!articleText || articleText.length < 200) {
              seenMap[h] = Date.now();
              continue;
            }

            const summary = await summarizeWithLlama(articleText, art.title);

            newlyAdded.push({
              url: art.url,
              title: art.title,
              summary,
              imageUrl: art.imageUrl,
              source: source.id,
              sourceName: source.name,
              sourceNameNp: source.nameNp,
              timestamp: Date.now(),
            });

            seenMap[h] = Date.now();
            added++;
            console.log(`[${source.id}] summarized: ${art.title.slice(0, 60)}…`);
          } catch (err) {
            console.warn(`[${source.id}] failed to process article: ${err.message.slice(0, 150)}`);
            // If every model in our fallback chain was rate-limited, stop the
            // entire cycle — pounding the API further will only extend the
            // lockout and we won't get anything summarized.
            if (err instanceof RateLimitedError) {
              console.warn('[scrape] all models rate-limited — aborting this cycle, will retry next interval');
              rateLimited = true;
              break;
            }
          }
        }
      } catch (err) {
        console.error(`[${source.id}] source failed: ${err.message}`);
      }
    }

    if (newlyAdded.length > 0) {
      await saveFeed([...newlyAdded, ...existing]);
    }
    await saveSeen(seenMap);

    const elapsed = Date.now() - startTs;
    console.log(`[scrape] done in ${elapsed}ms, added ${newlyAdded.length} article(s)${rateLimited ? ' (aborted early due to rate limit)' : ''}`);
    return { added: newlyAdded.length, elapsedMs: elapsed, rateLimited };
  } finally {
    scrapeInProgress = false;
  }
}

// -----------------------------------------------------------
// Express app
// -----------------------------------------------------------
const app = express();

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    rapidApiConfigured: Boolean(RAPIDAPI_KEY),
    openRouterConfigured: Boolean(OPENROUTER_API_KEY),
    myMemoryEmail: MYMEMORY_EMAIL ? 'configured' : 'not set',
    scrapeIntervalMinutes: SCRAPE_INTERVAL_MIN,
  });
});

// Aggregator feed
app.get('/api/news', async (req, res) => {
  try {
    const feed = await loadFeed();
    const bySource = {};
    for (const art of feed) {
      if (!bySource[art.source]) bySource[art.source] = [];
      if (bySource[art.source].length < MAX_PER_SOURCE) bySource[art.source].push(art);
    }
    const merged = Object.values(bySource).flat()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_ARTICLES_IN_FEED);

    res.json({
      articles: merged,
      updatedAt: merged[0]?.timestamp || null,
      count: merged.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single-article summarizer proxy
app.get('/api/summarize', async (req, res) => {
  const { url, lang = 'en', engine = '2', length = '3' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" parameter' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid article URL' });
  }

  if (!RAPIDAPI_KEY) {
    return res.status(500).json({ error: 'RAPIDAPI_KEY not configured in .env' });
  }

  const upstream = new URL(`https://${ARTICLE_HOST}/summarize`);
  upstream.searchParams.set('url', url);
  upstream.searchParams.set('lang', lang);
  upstream.searchParams.set('engine', engine);
  upstream.searchParams.set('length', length);

  try {
    const r = await fetchWithTimeout(upstream.toString(), {
      headers: {
        'x-rapidapi-host': ARTICLE_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
    });
    const body = await r.text();
    res.status(r.status)
      .type(r.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
});

// Translation proxy (MyMemory)
app.get('/api/translate', async (req, res) => {
  const { q, langpair } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing "q" parameter' });
  if (!langpair) return res.status(400).json({ error: 'Missing "langpair" parameter' });
  if (!/^[a-z]{2,5}(-[A-Za-z]{2,4})?\|[a-z]{2,5}(-[A-Za-z]{2,4})?$/.test(langpair)) {
    return res.status(400).json({ error: 'Invalid langpair format' });
  }
  if (q.length > 500) return res.status(413).json({ error: 'Query too long (max 500 chars)' });

  const upstream = new URL(MYMEMORY_URL);
  upstream.searchParams.set('q', q);
  upstream.searchParams.set('langpair', langpair);
  if (MYMEMORY_EMAIL) upstream.searchParams.set('de', MYMEMORY_EMAIL);

  try {
    const r = await fetchWithTimeout(upstream.toString());
    const body = await r.text();
    res.status(r.status)
      .type(r.headers.get('content-type') || 'application/json')
      .send(body);
  } catch (err) {
    res.status(502).json({ error: `Translation fetch failed: ${err.message}` });
  }
});

// Manual scrape trigger — handy for testing
app.post('/api/admin/scrape-now', async (req, res) => {
  if (ADMIN_TOKEN) {
    if (req.query.token !== ADMIN_TOKEN) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  runScrapeCycle()
    .then(r => console.log('[scrape] manual trigger result:', r))
    .catch(err => console.error('[scrape] manual trigger error:', err));
  res.status(202).json({ ok: true, message: 'Scrape cycle triggered' });
});

// Allow GET too, for convenience (paste in browser)
app.get('/api/admin/scrape-now', (req, res) => {
  if (ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  runScrapeCycle()
    .then(r => console.log('[scrape] manual trigger result:', r))
    .catch(err => console.error('[scrape] manual trigger error:', err));
  res.status(202).json({ ok: true, message: 'Scrape cycle triggered — check server logs' });
});

// -----------------------------------------------------------
// Boot
// -----------------------------------------------------------
async function main() {
  await ensureCacheDir();

  if (!RAPIDAPI_KEY) {
    console.warn('\n⚠️  RAPIDAPI_KEY is not set in .env — single-article summarization will not work.\n');
  } else {
    console.log('✓ RapidAPI key loaded');
  }
  if (!OPENROUTER_API_KEY) {
    console.warn('⚠️  OPENROUTER_API_KEY is not set in .env — Nepali aggregator will not work.');
    console.warn('    Get a free key at https://openrouter.ai/settings/keys\n');
  } else {
    console.log('✓ OpenRouter key loaded');
  }
  if (MYMEMORY_EMAIL) {
    console.log(`✓ MyMemory email: ${MYMEMORY_EMAIL}`);
  }

  app.listen(PORT, () => {
    console.log(`\n📰  The Dispatch is running`);
    console.log(`    Open:        http://localhost:${PORT}`);
    console.log(`    News feed:   http://localhost:${PORT}/news.html`);
    console.log(`    Health:      http://localhost:${PORT}/api/health`);
    console.log(`    Trigger:     http://localhost:${PORT}/api/admin/scrape-now`);
    console.log(`    Cycle every: ${SCRAPE_INTERVAL_MIN} minute(s)\n`);
  });

  // First scrape on boot (after a short delay so the server is responsive first),
  // then every SCRAPE_INTERVAL_MIN minutes.
  setTimeout(() => {
    runScrapeCycle().catch(err => console.error('[scrape] initial run failed:', err));
  }, 2000);

  setInterval(() => {
    runScrapeCycle().catch(err => console.error('[scrape] scheduled run failed:', err));
  }, SCRAPE_INTERVAL_MIN * 60 * 1000);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
