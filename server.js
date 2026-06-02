/**
 * Lahara Intelligence — Backend Server
 * Node 18+ | Express
 * Routes: GET /health  GET /api/markets  POST /api/enrich  POST /api/enrich-batch  GET /api/news
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;
const NEWS_API_KEY   = process.env.NEWS_API_KEY   || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ─── In-memory cache ────────────────────────────────────────────
const cache   = new Map();
const CACHE_TTL = 8 * 60 * 1000; // 8 minutes

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Safe fetch with timeout ────────────────────────────────────
async function safeFetch(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ts: new Date().toISOString(),
    newsApiConfigured: !!NEWS_API_KEY,
    cacheSize: cache.size
  });
});

// Polymarket proxy
app.get('/api/markets', async (req, res) => {
  const cacheKey = 'polymarket-markets';
  const cached = getCache(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const url = 'https://gamma-api.polymarket.com/markets?' +
    new URLSearchParams({
      active: 'true', closed: 'false', archived: 'false',
      limit: '25', order: 'volume24hr', ascending: 'false'
    });

  try {
    const data = await safeFetch(url);
    setCache(cacheKey, data);
    res.json({ source: 'live', data });
  } catch (e) {
    res.status(502).json({ error: 'Polymarket fetch failed', detail: e.message });
  }
});

// Raw news search
app.get('/api/news', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q param required' });

  const cacheKey = 'news:' + q.toLowerCase().slice(0, 80);
  const cached = getCache(cacheKey);
  if (cached) return res.json({ source: 'cache', articles: cached });

  const articles = await fetchAllNews(extractKeywords(q));
  setCache(cacheKey, articles);
  res.json({ source: 'live', articles });
});

// Single market enrich
app.post('/api/enrich', async (req, res) => {
  const { question, market_id, q_yes } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });

  const cacheKey = 'enrich:' + (market_id || question).slice(0, 60);
  const cached = getCache(cacheKey);
  if (cached) return res.json({ source: 'cache', ...cached });

  try {
    const result = await enrichMarket({ question, market_id, q_yes: q_yes || 0.5 });
    setCache(cacheKey, result);
    res.json({ source: 'live', ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch enrich — up to 25 markets
app.post('/api/enrich-batch', async (req, res) => {
  const markets = (req.body && req.body.markets ? req.body.markets : []).slice(0, 25);
  if (markets.length === 0) return res.status(400).json({ error: 'markets[] required' });

  const results = [];
  const BATCH_SIZE = 4;

  for (let i = 0; i < markets.length; i += BATCH_SIZE) {
    const chunk = markets.slice(i, i + BATCH_SIZE);
    const enriched = await Promise.all(
      chunk.map(function(m) {
        return enrichMarket(m).catch(function(e) {
          return {
            market_id:    m.market_id,
            error:        e.message,
            predP:        m.q_yes || 0.5,
            predConf:     0.40,
            bdisFinancial:50,
            newsCount:    0,
            sentiment:    0,
            articles:     []
          };
        });
      })
    );
    results.push.apply(results, enriched);
    if (i + BATCH_SIZE < markets.length) await sleep(300);
  }

  res.json({ results });
});

// ═══════════════════════════════════════════════════════════════
//  ENRICHMENT CORE
// ═══════════════════════════════════════════════════════════════
async function enrichMarket(opts) {
  var question  = opts.question;
  var market_id = opts.market_id;
  var q_yes     = opts.q_yes || 0.5;

  var keywords = extractKeywords(question);

  var results = await Promise.all([
    fetchNewsAPI(keywords),
    fetchGDELT(keywords),
    fetchRSSFeeds(keywords)
  ]);

  var allArticles = deduplicate(results[0].concat(results[1]).concat(results[2]));
  var newsCount   = allArticles.length;

  if (newsCount === 0) {
    return {
      market_id:    market_id,
      predP:        q_yes,
      predConf:     0.40,
      bdisFinancial:50,
      newsCount:    0,
      sentiment:    0,
      keySignals:   [],
      articles:     [],
      keywords:     keywords
    };
  }

  var scored  = allArticles.map(function(a) { return scoreArticle(a, question); });
  var signals = aggregateSignals(scored, q_yes);

  return Object.assign({ market_id: market_id }, signals, {
    newsCount: newsCount,
    articles:  scored.slice(0, 8).map(function(a) {
      return {
        title:     a.title,
        source:    a.source,
        url:       a.url,
        published: a.published,
        sentiment: a.sentiment,
        relevance: a.relevance,
        direction: a.direction
      };
    }),
    keywords: keywords
  });
}

// ═══════════════════════════════════════════════════════════════
//  NEWS SOURCES
// ═══════════════════════════════════════════════════════════════
async function fetchNewsAPI(keywords) {
  if (!NEWS_API_KEY) return [];
  var q = keywords.slice(0, 3).join(' OR ');
  var url = 'https://newsapi.org/v2/everything?' + new URLSearchParams({
    q: q, language: 'en', sortBy: 'relevancy', pageSize: '15', apiKey: NEWS_API_KEY
  });
  try {
    var data = await safeFetch(url);
    return (data.articles || []).map(function(a) {
      return {
        title:     a.title     || '',
        body:      a.description || a.content || '',
        source:    (a.source && a.source.name) ? a.source.name : 'NewsAPI',
        url:       a.url       || '',
        published: a.publishedAt || ''
      };
    });
  } catch (e) { return []; }
}

async function fetchGDELT(keywords) {
  var url = 'https://api.gdeltproject.org/api/v2/doc/doc?' + new URLSearchParams({
    query: keywords.slice(0, 3).join(' '),
    mode: 'ArtList', maxrecords: '10', format: 'json', timespan: '7d'
  });
  try {
    var data = await safeFetch(url, {}, 6000);
    return (data.articles || []).map(function(a) {
      return {
        title:     a.title  || '',
        body:      a.title  || '',
        source:    a.domain || 'GDELT',
        url:       a.url    || '',
        published: a.seendate || ''
      };
    });
  } catch (e) { return []; }
}

async function fetchRSSFeeds(keywords) {
  var q = keywords.slice(0, 2).join(' ');
  var feeds = [
    'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en',
    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(q) + '&region=US&lang=en-US'
  ];
  var results = [];
  for (var i = 0; i < feeds.length; i++) {
    try {
      var controller = new AbortController();
      var timer = setTimeout(function() { controller.abort(); }, 5000);
      var res  = await fetch(feeds[i], { signal: controller.signal });
      clearTimeout(timer);
      var text = await res.text();
      var items = parseRSSItems(text);
      results = results.concat(items.slice(0, 8));
    } catch (e) { /* continue */ }
  }
  return results;
}

function parseRSSItems(xml) {
  var items = [];
  var itemRx = /<item>([\s\S]*?)<\/item>/g;
  var match;
  while ((match = itemRx.exec(xml)) !== null) {
    var content = match[1];
    function getTag(tag) {
      var re = new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>|<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>');
      var m = content.match(re);
      return m ? (m[1] || m[2] || '').trim() : '';
    }
    items.push({
      title:     getTag('title'),
      body:      getTag('description'),
      source:    getTag('source') || 'RSS',
      url:       getTag('link'),
      published: getTag('pubDate')
    });
  }
  return items;
}

async function fetchAllNews(keywords) {
  var results = await Promise.all([
    fetchNewsAPI(keywords),
    fetchGDELT(keywords),
    fetchRSSFeeds(keywords)
  ]);
  return deduplicate(results[0].concat(results[1]).concat(results[2]));
}

// ═══════════════════════════════════════════════════════════════
//  NLP — keyword extraction, sentiment, signal aggregation
// ═══════════════════════════════════════════════════════════════
function extractKeywords(question) {
  var stopWords = new Set([
    'will','the','a','an','be','is','are','was','were','has','have','had',
    'does','do','did','in','on','at','to','of','for','and','or','by',
    'before','after','during','through','between','from','with','without',
    'least','most','more','than','that','this','these','those','which',
    'what','when','where','who','how','why','whether','if','not',
    'any','all','some','no','yes','ever','never','still','already',
    'above','below','over','under','per','percent','billion','million','trillion',
    'end','close','start','begin','result','announce','release','reach',
    'exceed','fall','rise','drop','pass'
  ]);

  var words = question
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(function(w) { return w.toLowerCase(); })
    .filter(function(w) { return w.length > 2 && !stopWords.has(w); });

  var freq = {};
  words.forEach(function(w) { freq[w] = (freq[w] || 0) + 1; });

  var entities = [];
  var capRx = /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g;
  var m;
  while ((m = capRx.exec(question)) !== null) {
    var e = m[1].trim();
    if (!stopWords.has(e.toLowerCase())) entities.push(e);
  }

  var topWords = Object.entries(freq)
    .sort(function(a, b) { return b[1] - a[1]; })
    .slice(0, 6)
    .map(function(pair) { return pair[0]; });

  var combined = entities.slice(0, 3).concat(topWords);
  var seen = new Set();
  var unique = [];
  combined.forEach(function(w) {
    if (!seen.has(w)) { seen.add(w); unique.push(w); }
  });
  return unique.slice(0, 6);
}

var POS_WORDS = new Set([
  'surge','surges','surged','rally','rallies','bullish','positive','growth',
  'advance','gain','gains','rise','rises','rose','soar','soars','soared',
  'beat','beats','exceed','exceeds','exceeded','outperform','strong','stronger',
  'approve','approved','pass','passes','passed','win','wins','won','victory',
  'support','supports','backed','favour','favor','likely','probable',
  'confidence','optimism','optimistic','record','high','breakthrough',
  'agreement','deal','signed','confirm','confirmed','increase','expand'
]);

var NEG_WORDS = new Set([
  'fall','falls','fell','drop','drops','dropped','decline','declines','declined',
  'crash','crashes','crashed','plunge','plunges','plunged','slump','slumped',
  'bearish','negative','loss','losses','lose','loses','lost',
  'miss','misses','missed','reject','rejected','veto','vetoed',
  'fail','fails','failed','unlikely','doubt','concern','concerns',
  'worry','worries','risk','risks','threat','threats','warning',
  'delay','delayed','dispute','crisis','cut','cuts','ban','banned','sanction',
  'uncertainty','volatile','volatility','weak','weaker','halt'
]);

function sentimentScore(text) {
  var words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
  var score = 0;
  var count = 0;
  words.forEach(function(w) {
    if (POS_WORDS.has(w)) { score += 1; count++; }
    if (NEG_WORDS.has(w)) { score -= 1; count++; }
  });
  var negRx = /\b(not|no|never|don't|doesn't|didn't|won't|can't)\s+(\w+)/gi;
  var nm;
  while ((nm = negRx.exec(text)) !== null) {
    var w = nm[2].toLowerCase();
    if (POS_WORDS.has(w)) score -= 2;
    if (NEG_WORDS.has(w)) score += 2;
  }
  if (count === 0) return 0;
  return Math.max(-1, Math.min(1, score / Math.max(count, 3)));
}

function scoreArticle(article, question) {
  var qWords = new Set(extractKeywords(question).map(function(w) { return w.toLowerCase(); }));
  var fullText = (article.title + ' ' + article.body).toLowerCase();
  var hits = 0;
  qWords.forEach(function(w) { if (fullText.indexOf(w) !== -1) hits++; });
  var relevance  = qWords.size > 0 ? hits / qWords.size : 0;
  var sentiment  = sentimentScore(fullText);
  var direction  = sentiment > 0.1 ? 'BULLISH' : sentiment < -0.1 ? 'BEARISH' : 'NEUTRAL';
  return Object.assign({}, article, { relevance: relevance, sentiment: sentiment, direction: direction });
}

function aggregateSignals(scored, q_yes) {
  var weighted = scored.filter(function(a) { return a.relevance > 0.1; });

  if (weighted.length === 0) {
    return { predP: q_yes, predConf: 0.42, bdisFinancial: 48, sentiment: 0, keySignals: [] };
  }

  var totalWeight  = weighted.reduce(function(s, a) { return s + a.relevance; }, 0);
  var avgSentiment = weighted.reduce(function(s, a) { return s + a.sentiment * a.relevance; }, 0) / totalWeight;

  var volumeConf   = Math.min(0.25, weighted.length * 0.025);
  var sentShift    = avgSentiment * 0.12;
  var predP        = Math.max(0.05, Math.min(0.95, q_yes + sentShift));
  var sentConf     = Math.min(0.20, Math.abs(avgSentiment) * 0.25);
  var predConf     = Math.min(0.92, 0.50 + volumeConf + sentConf);
  var avgRelevance = totalWeight / weighted.length;
  var consensus    = (avgSentiment > 0.15 || avgSentiment < -0.15) ? 15 : 5;
  var bdisFinancial = Math.min(95, Math.max(30, 40 + avgRelevance * 30 + consensus + weighted.length * 1.5));

  var keySignals = weighted
    .slice()
    .sort(function(a, b) { return b.relevance - a.relevance; })
    .slice(0, 4)
    .map(function(a) {
      return { title: a.title, sentiment: a.sentiment, direction: a.direction, source: a.source };
    });

  return {
    predP:         parseFloat(predP.toFixed(4)),
    predConf:      parseFloat(predConf.toFixed(3)),
    bdisFinancial: parseFloat(bdisFinancial.toFixed(1)),
    sentiment:     parseFloat(avgSentiment.toFixed(4)),
    keySignals:    keySignals
  };
}

function deduplicate(articles) {
  var seen = new Set();
  return articles.filter(function(a) {
    var key = a.title.toLowerCase().slice(0, 60).replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Start ──────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('');
  console.log('  Lahara Backend running on port ' + PORT);
  console.log('  NewsAPI: ' + (NEWS_API_KEY ? 'configured' : 'NOT SET — set NEWS_API_KEY env var'));
  console.log('  CORS origin: ' + ALLOWED_ORIGIN);
  console.log('');
});
