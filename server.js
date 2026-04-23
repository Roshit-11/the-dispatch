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
// Pollinations generates images on demand from a URL — no API key, no quota,
// no server-side call needed. We just build the URL; the browser fetches it
// and Pollinations renders the image at request time.
const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';
// Primary + optional backup OpenRouter keys. When one key's daily quota is
// exhausted, we transparently retry with the next. Auto-detects any env var
// named OPENROUTER_API_KEY, OPENROUTER_API_KEY_2, OPENROUTER_API_KEY_3, …
// Add as many as you want — no code change needed.
const OPENROUTER_API_KEYS = (() => {
  const keys = [];
  if (process.env.OPENROUTER_API_KEY) keys.push(process.env.OPENROUTER_API_KEY);
  const numbered = Object.keys(process.env)
    .filter(k => /^OPENROUTER_API_KEY_\d+$/.test(k))
    .sort((a, b) => {
      const na = Number(a.split('_').pop());
      const nb = Number(b.split('_').pop());
      return na - nb;
    });
  for (const name of numbered) {
    const val = process.env[name];
    if (val && !keys.includes(val)) keys.push(val);
  }
  return keys;
})();
const OPENROUTER_API_KEY = OPENROUTER_API_KEYS[0] || ''; // back-compat
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SCRAPE_INTERVAL_MIN = Math.max(5, Number(process.env.SCRAPE_INTERVAL_MINUTES || 30));

const ARTICLE_HOST = 'article-extractor-and-summarizer.p.rapidapi.com';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// xAI (Grok) — primary provider. OpenAI-compatible /chat/completions.
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const XAI_MODELS = [
  'grok-4-fast-reasoning',
  'grok-4-fast-non-reasoning',
  'grok-3-mini',
  'grok-2-latest',
];

// OpenRouter's :free roster changes frequently — any single model can 404
// without notice. Instead of hardcoding stale IDs, fetch the live list from
// /api/v1/models at startup (and refresh periodically) and filter to `:free`.
// A hardcoded seed list is used as a fallback if the fetch fails.
let OPENROUTER_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'qwen/qwen3-coder:free',
  'z-ai/glm-4.5-air:free',
  'tngtech/deepseek-r1t-chimera:free',
  'microsoft/mai-ds-r1:free',
];
let OPENROUTER_MODELS_LAST_REFRESH = 0;
const OPENROUTER_MODELS_TTL_MS = 30 * 60 * 1000;

async function refreshOpenRouterModels() {
  try {
    const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
      headers: OPENROUTER_API_KEY ? { Authorization: `Bearer ${OPENROUTER_API_KEY}` } : {},
    }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const free = (json.data || [])
      .filter(m => typeof m.id === 'string' && m.id.endsWith(':free'))
      .map(m => m.id);
    if (free.length > 0) {
      // Prioritize larger/stronger models first by a rough heuristic.
      const rank = (id) => {
        const s = id.toLowerCase();
        let score = 0;
        if (/70b|72b|235b|mixtral|r1\b|v3|glm-4\.5|gemini-2/.test(s)) score += 100;
        if (/27b|24b|chimera|mai-ds/.test(s)) score += 60;
        if (/7b|8b|9b/.test(s)) score += 20;
        if (/1b|3b/.test(s)) score += 5;
        return -score;
      };
      free.sort((a, b) => rank(a) - rank(b));
      OPENROUTER_MODELS = free;
      OPENROUTER_MODELS_LAST_REFRESH = Date.now();
      console.log(`[openrouter] refreshed free model list: ${free.length} models, top=${free[0]}`);
    }
  } catch (err) {
    console.warn(`[openrouter] model list refresh failed: ${err.message} (using existing list of ${OPENROUTER_MODELS.length})`);
  }
}

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
  // Send fully browser-like headers. Sites like Ekantipur 403 on server-side
  // fetches that look stripped-down. A Referer from their own origin + a
  // realistic Accept chain usually gets past the cheap bot checks.
  let origin;
  try { origin = new URL(articleUrl).origin; } catch { origin = ''; }
  const browserHeaders = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ne-NP,ne;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    ...(origin ? { 'Referer': origin + '/' } : {}),
  };

  let res = await fetchWithTimeout(articleUrl, { headers: browserHeaders });
  // Retry once with Google as referer if the origin referer was rejected.
  if (res.status === 403) {
    res = await fetchWithTimeout(articleUrl, {
      headers: { ...browserHeaders, 'Referer': 'https://www.google.com/' },
    });
  }
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
// Pollinations image generation (fallback cover image)
// -----------------------------------------------------------
// Detect a rough topic from the Nepali title so we can pick a better style
// prompt than generic "news photo" (which yields corporate headshots).
function detectTopicEn(title = '', summary = '') {
  const t = `${title} ${summary}`;
  const rules = [
    { re: /राजनीति|संसद|प्रधानमन्त्री|मन्त्री|पार्टी|निर्वाचन|सरकार|कांग्रेस|एमाले|माओवादी/, en: 'parliament building, politics' },
    { re: /क्रिकेट|cricket/i,                                                               en: 'cricket stadium, sports photography' },
    { re: /फुटबल|football|soccer/i,                                                         en: 'football match, sports photography' },
    { re: /खेल|खेलाडी|ओलम्पिक/,                                                              en: 'sports event, stadium' },
    { re: /मौसम|वर्षा|हिमपात|बाढी|पहिरो/,                                                    en: 'weather landscape, sky, mountains' },
    { re: /अर्थ|बजार|शेयर|बैंक|व्यापार|economy|market/i,                                      en: 'financial district, economy' },
    { re: /स्वास्थ्य|अस्पताल|बिरामी|औषधी/,                                                    en: 'hospital, healthcare' },
    { re: /शिक्षा|विद्यालय|विश्वविद्यालय|परीक्षा/,                                             en: 'classroom, education' },
    { re: /प्रहरी|अपराध|हत्या|गिरफ्तार/,                                                     en: 'police, investigation scene' },
    { re: /यातायात|सडक|दुर्घटना|बस|विमान/,                                                   en: 'road traffic, nepal street' },
    { re: /पर्यटन|यात्रा|पर्वतारोहण|एभरेस्ट/,                                                  en: 'himalayas, nepal landscape' },
    { re: /कृषि|किसान|खेती|अन्न/,                                                             en: 'terrace farming nepal, agriculture' },
    { re: /प्रविधि|टेक्नोलोजी|मोबाइल|इन्टरनेट|AI/i,                                            en: 'technology, digital screens' },
    { re: /मनोरञ्जन|फिल्म|संगीत|कलाकार/,                                                     en: 'concert stage, entertainment' },
  ];
  for (const r of rules) if (r.re.test(t)) return r.en;
  return 'kathmandu nepal street scene';
}

// Translate short Nepali text to English via MyMemory (free, no key).
// Falls back to the original string on any error.
async function translateNpToEn(text) {
  if (!text) return '';
  try {
    const u = new URL(MYMEMORY_URL);
    u.searchParams.set('q', text.slice(0, 450));
    u.searchParams.set('langpair', 'ne|en');
    if (MYMEMORY_EMAIL) u.searchParams.set('de', MYMEMORY_EMAIL);
    const res = await fetchWithTimeout(u.toString(), {}, 8000);
    if (!res.ok) return text;
    const j = await res.json();
    const out = j?.responseData?.translatedText;
    return (typeof out === 'string' && out.length > 0) ? out : text;
  } catch {
    return text;
  }
}

function pollinationsUrlFromPrompt(prompt) {
  const params = new URLSearchParams({
    width: '768',
    height: '432',
    nologo: 'true',
    model: 'flux',
    seed: String((hashUrl(prompt) >>> 0) % 999999),
  });
  return `${POLLINATIONS_BASE}${encodeURIComponent(prompt)}?${params.toString()}`;
}

// Sync version — no translation. Used for retroactive fill of older articles
// where we don't want to spend MyMemory quota on every /api/news request.
function buildPollinationsImageUrl(title, summary) {
  const base = (title && title.length >= 20) ? title : (summary || title || '').slice(0, 150);
  if (!base) return null;
  const topic = detectTopicEn(title, summary);
  const prompt = `${topic}, documentary photograph, photojournalism, natural light, high detail, no text, no watermark`;
  return pollinationsUrlFromPrompt(prompt);
}

// Async version — translates the Nepali title to English first so Flux
// understands the subject, then adds a topic-aware style suffix.
async function buildPollinationsImageUrlAsync(title, summary) {
  const base = (title && title.length >= 10) ? title : (summary || title || '').slice(0, 200);
  if (!base) return null;
  const topic = detectTopicEn(title, summary);
  const en = await translateNpToEn(base.slice(0, 200));
  const subject = (en || base).replace(/\s+/g, ' ').trim().slice(0, 180);
  const prompt = `${subject}. ${topic}. documentary news photograph, photojournalism, cinematic natural light, realistic, high detail, no text, no watermark, no logo`;
  return pollinationsUrlFromPrompt(prompt);
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

async function callOpenRouter(model, messages, apiKey = OPENROUTER_API_KEY) {
  const res = await fetchWithTimeout(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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

  // Reasoning models (glm-4.5-air, nemotron-nano, deepseek-r1, etc.) often
  // return the final answer in `reasoning` or `reasoning_content`, leaving
  // `content` empty. Also strip <think>…</think> blocks that sometimes leak
  // into content.
  const msg = data?.choices?.[0]?.message || {};
  let text = msg.content || msg.reasoning_content || msg.reasoning || '';
  if (typeof text === 'string') {
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }
  if (!text) throw new Error(`[${model}] returned no content`);
  return text.trim();
}

async function summarizeWithLlama(articleText, title) {
  if (!XAI_API_KEY && OPENROUTER_API_KEYS.length === 0) {
    throw new Error('No summarizer key set — configure XAI_API_KEY or OPENROUTER_API_KEY');
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

  return await runSummarizerChain(messages);
}

// Try xAI first (primary), fall back to OpenRouter if xAI key is absent or
// all xAI models fail. This is the single entry point every summarizer uses.
async function runSummarizerChain(messages) {
  if (XAI_API_KEY) {
    try {
      return await runXAIChain(messages);
    } catch (err) {
      console.warn(`[summarize] xAI failed (${err.message?.slice(0, 140)}) — falling back to OpenRouter`);
    }
  }
  return await runOpenRouterChain(messages);
}

// Generic OpenRouter summarizer used by the single-URL endpoint as a fallback
// when RapidAPI fails. Accepts target language and sentence count so the
// frontend's language/length selectors still work.
async function summarizeGeneric(articleText, title, lang = 'en', sentenceCount = 3) {
  if (!XAI_API_KEY && OPENROUTER_API_KEYS.length === 0) {
    throw new Error('No summarizer key set');
  }
  const langName = ({
    en: 'English', ne: 'Nepali', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil',
    ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
    zh: 'Chinese', ja: 'Japanese', ru: 'Russian', pt: 'Portuguese',
  })[lang] || lang;
  const systemMsg = `You are a professional news editor. Summarize the given article factually in exactly ${sentenceCount} short sentence(s) in ${langName}. Output only the summary — no preamble, no labels, no quotes.`;
  const userMsg = `Title: ${title || '(untitled)'}\n\nArticle:\n${articleText}\n\nSummary in ${langName} (${sentenceCount} sentence${sentenceCount > 1 ? 's' : ''}):`;
  return await runSummarizerChain([
    { role: 'system', content: systemMsg },
    { role: 'user',   content: userMsg },
  ]);
}

// Models that returned 404 recently — skip them to avoid wasting 4 calls
// on every scrape cycle. Cleared whenever refreshOpenRouterModels runs.
const DEAD_MODELS = new Set();

async function callXAI(model, messages) {
  const res = await fetchWithTimeout(XAI_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: 200,
    }),
  }, 30_000);

  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 200);
    if (res.status === 429) throw new RateLimitedError(`[xai ${model}] rate-limited: ${errBody}`);
    throw new Error(`[xai ${model}] HTTP ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw new Error(`[xai ${model}] error: ${msg.slice(0, 200)}`);
  }
  const msgObj = data?.choices?.[0]?.message || {};
  let text = msgObj.content || msgObj.reasoning_content || msgObj.reasoning || '';
  if (typeof text === 'string') text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) throw new Error(`[xai ${model}] returned no content`);
  return text.trim();
}

async function runXAIChain(messages) {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY not set');
  let lastError = null;
  for (const model of XAI_MODELS) {
    if (DEAD_MODELS.has(`xai:${model}`)) continue;
    try {
      const result = await callXAI(model, messages);
      console.log(`[xai] ✓ success via ${model}`);
      return result;
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      if (/HTTP 404|does not exist|invalid model/i.test(msg)) {
        DEAD_MODELS.add(`xai:${model}`);
        console.warn(`[xai] ${model}: 404/invalid — marking dead`);
        continue;
      }
      console.warn(`[xai] ${model}: ${msg.slice(0, 140)} — trying next…`);
    }
  }
  throw lastError || new Error('all xai models failed');
}

async function runOpenRouterChain(messages) {
  if (Date.now() - OPENROUTER_MODELS_LAST_REFRESH > OPENROUTER_MODELS_TTL_MS) {
    await refreshOpenRouterModels();
    DEAD_MODELS.clear();
  }
  let lastError = null;

  const activeModels = OPENROUTER_MODELS.filter(m => !DEAD_MODELS.has(m));

  // Column-major: try model[0] across all keys first, then model[1] across
  // all keys, etc. This way the primary model is exhausted on every key
  // before we degrade to a weaker model.
  for (const model of activeModels) {
    for (let keyIdx = 0; keyIdx < OPENROUTER_API_KEYS.length; keyIdx++) {
      const apiKey = OPENROUTER_API_KEYS[keyIdx];
      const keyLabel = `key#${keyIdx + 1}`;
      try {
        const result = await callOpenRouter(model, messages, apiKey);
        console.log(`[llama ${keyLabel}] ✓ success via ${model}`);
        return result;
      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        // 404 is key-independent — mark the model dead and stop looping keys.
        if (/HTTP 404|No endpoints found/i.test(msg)) {
          DEAD_MODELS.add(model);
          console.warn(`[llama] ${model}: 404 — marking dead for this refresh window`);
          break;
        }
        // "no content" is also usually key-independent (model output format
        // issue) — skip remaining keys for this model.
        if (/returned no content/i.test(msg)) {
          console.warn(`[llama] ${model}: empty output — skipping remaining keys`);
          break;
        }
        console.warn(`[llama ${keyLabel}] ${model}: ${msg.slice(0, 120)} — trying next…`);
      }
    }
  }

  throw new RateLimitedError(`All keys/models unavailable. Last: ${lastError?.message?.slice(0, 200)}`);
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

            // If the article has no scraped image, generate one via Pollinations.
            // This is just URL construction — the browser fetches the image lazily,
            // so no server-side quota or latency cost here.
            let imageUrl = art.imageUrl;
            let imageGenerated = false;
            if (!imageUrl) {
              const generated = await buildPollinationsImageUrlAsync(art.title, summary);
              if (generated) {
                imageUrl = generated;
                imageGenerated = true;
              }
            }

            newlyAdded.push({
              url: art.url,
              title: art.title,
              summary,
              imageUrl,
              imageGenerated,
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
    // Retroactively fill missing cover images for older articles saved before
    // the Pollinations fallback was added. Pure URL construction, no cost.
    for (const art of feed) {
      if (!art.imageUrl) {
        const generated = buildPollinationsImageUrl(art.title, art.summary);
        if (generated) {
          art.imageUrl = generated;
          art.imageGenerated = true;
        }
      }
    }
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

// Single-article summarizer. Tries RapidAPI first for speed/quality; if that
// fails (quota, 5xx, timeout, etc.) falls back to local scrape + OpenRouter
// so the endpoint stays working as long as either service is up.
app.get('/api/summarize', async (req, res) => {
  const { url, lang = 'en', engine = '2', length = '3' } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing "url" parameter' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid article URL' });
  }

  const sentenceCount = Math.max(1, Math.min(7, Number(length) || 3));

  // --- Attempt 1: RapidAPI (if configured) ---
  if (RAPIDAPI_KEY) {
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
      // Success path — return as-is.
      if (r.ok) {
        return res.status(r.status)
          .type(r.headers.get('content-type') || 'application/json')
          .send(body);
      }
      console.warn(`[summarize] RapidAPI ${r.status}, falling back to OpenRouter`);
    } catch (err) {
      console.warn(`[summarize] RapidAPI error: ${err.message} — falling back to OpenRouter`);
    }
  }

  // --- Attempt 2: Local fetch + OpenRouter fallback ---
  try {
    const articleText = await fetchArticleText(url);
    if (!articleText || articleText.length < 200) {
      return res.status(422).json({ error: 'Could not extract article text (may be paywalled, JS-rendered, or blocked).' });
    }
    // Best-effort title: pull <title> from article page. Cheap second fetch
    // would be wasteful, so accept that title may be missing.
    const summary = await summarizeGeneric(articleText, '', lang, sentenceCount);
    return res.json({ summary, source: 'openrouter-fallback' });
  } catch (err) {
    const code = err?.name === 'RateLimitedError' ? 429 : 502;
    return res.status(code).json({ error: `Summarization failed: ${err.message}` });
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
  if (OPENROUTER_API_KEYS.length === 0) {
    console.warn('⚠️  OPENROUTER_API_KEY is not set in .env — Nepali aggregator will not work.');
    console.warn('    Get a free key at https://openrouter.ai/settings/keys\n');
  } else {
    console.log(`✓ OpenRouter keys loaded (${OPENROUTER_API_KEYS.length})`);
  if (XAI_API_KEY) console.log(`✓ xAI (Grok) configured as primary summarizer`);
  else console.log(`! XAI_API_KEY not set — OpenRouter will be used directly`);
  }
  if (MYMEMORY_EMAIL) {
    console.log(`✓ MyMemory email: ${MYMEMORY_EMAIL}`);
  }
  console.log('✓ Pollinations image fallback enabled (no key required)');

  app.listen(PORT, () => {
    console.log(`\n📰  The Dispatch is running`);
    console.log(`    Open:        http://localhost:${PORT}`);
    console.log(`    News feed:   http://localhost:${PORT}/news.html`);
    console.log(`    Health:      http://localhost:${PORT}/api/health`);
    console.log(`    Trigger:     http://localhost:${PORT}/api/admin/scrape-now`);
    console.log(`    Cycle every: ${SCRAPE_INTERVAL_MIN} minute(s)\n`);
  });

  // Refresh the OpenRouter free-model list on boot so we don't hit 404s on
  // stale IDs. Don't block startup on it.
  refreshOpenRouterModels();

  // First scrape on boot (after a short delay so the server is responsive first),
  // then every SCRAPE_INTERVAL_MIN minutes.
  setTimeout(() => {
    runScrapeCycle().catch(err => console.error('[scrape] initial run failed:', err));
  }, 4000);

  setInterval(() => {
    runScrapeCycle().catch(err => console.error('[scrape] scheduled run failed:', err));
  }, SCRAPE_INTERVAL_MIN * 60 * 1000);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
