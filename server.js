// Lahara Intelligence — Backend Enrichment Server
// Deploy: Railway / Render / Fly.io  (Node 18+)
// Routes: GET /health  GET /api/markets  POST /api/enrich-batch
'use strict';
const express = require('express');
const cors    = require('cors');
const fetch   = (...a) => import('node-fetch').then(({default:f})=>f(...a));

const app  = express();
const PORT = process.env.PORT || 3000;
const NEWS_API_KEY   = process.env.NEWS_API_KEY   || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ── Cache ────────────────────────────────────────────────────
const cache = new Map();
const TTL   = 8 * 60 * 1000;
const gc = k => { const e=cache.get(k); if(!e)return null; if(Date.now()-e.ts>TTL){cache.delete(k);return null;} return e.data; };
const sc = (k,d) => cache.set(k,{data:d,ts:Date.now()});

// ── Safe fetch ───────────────────────────────────────────────
async function sf(url,opts={},ms=8000){
  const c=new AbortController(), t=setTimeout(()=>c.abort(),ms);
  try{ const r=await fetch(url,{...opts,signal:c.signal}); clearTimeout(t);
    if(!r.ok)throw new Error('HTTP '+r.status); return r.json();
  }catch(e){ clearTimeout(t); throw e; }
}

// ── Polymarket proxy ─────────────────────────────────────────
app.get('/api/markets', async(req,res)=>{
  const k='pm'; const d=gc(k); if(d)return res.json({source:'cache',data:d});
  const u='https://gamma-api.polymarket.com/markets?'+new URLSearchParams({active:'true',closed:'false',archived:'false',limit:'25',order:'volume24hr',ascending:'false'});
  try{ const d=await sf(u); sc(k,d); res.json({source:'live',data:d}); }
  catch(e){ res.status(502).json({error:'Polymarket fetch failed',detail:e.message}); }
});

// ── Batch enrich ─────────────────────────────────────────────
app.post('/api/enrich-batch', async(req,res)=>{
  const mkts=(req.body?.markets||[]).slice(0,25);
  if(!mkts.length)return res.status(400).json({error:'markets[] required'});
  const results=[]; const B=4;
  for(let i=0;ienrich(m).catch(e=>({market_id:m.market_id,error:e.message,predP:m.q_yes||.5,predConf:.4,bdisFinancial:50,newsCount:0,sentiment:0,articles:[]}))));
    results.push(...en);
    if(i+B{
  const{question,market_id,q_yes}=req.body||{};
  if(!question)return res.status(400).json({error:'question required'});
  const k='e:'+( market_id||question).slice(0,60); const d=gc(k); if(d)return res.json({source:'cache',...d});
  try{ const e=await enrich({question,market_id,q_yes:q_yes||.5}); sc(k,e); res.json({source:'live',...e}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// ── News search ──────────────────────────────────────────────
app.get('/api/news',async(req,res)=>{
  const q=(req.query.q||'').trim(); if(!q)return res.status(400).json({error:'q required'});
  const k='n:'+q.slice(0,80); const d=gc(k); if(d)return res.json({source:'cache',articles:d});
  const a=await fetchAll(kw(q)); sc(k,a); res.json({source:'live',articles:a});
});

// ── Health ───────────────────────────────────────────────────
app.get('/health',(req,res)=>res.json({status:'ok',ts:new Date().toISOString(),newsApiConfigured:!!NEWS_API_KEY,cacheSize:cache.size}));

// ════════════════════════════════════════════════════════════
//  ENRICHMENT CORE
// ════════════════════════════════════════════════════════════
async function enrich({question,market_id,q_yes}){
  const keywords=kw(question);
  const [na,ga,ra]=await Promise.all([newsapi(keywords),gdelt(keywords),rss(keywords)]);
  const all=dedup([...na,...ga,...ra]);
  if(!all.length)return{market_id,predP:q_yes,predConf:.4,bdisFinancial:50,newsCount:0,sentiment:0,articles:[],keywords};
  const scored=all.map(a=>score(a,question));
  return{market_id,...agg(scored,q_yes),newsCount:all.length,
    articles:scored.slice(0,8).map(a=>({title:a.title,source:a.source,url:a.url,published:a.published,sentiment:a.sentiment,relevance:a.relevance,direction:a.direction})),keywords};
}

// ── NewsAPI ───────────────────────────────────────────────────
async function newsapi(kws){
  if(!NEWS_API_KEY)return[];
  const u='https://newsapi.org/v2/everything?'+new URLSearchParams({q:kws.slice(0,3).join(' OR '),language:'en',sortBy:'relevancy',pageSize:'15',apiKey:NEWS_API_KEY});
  try{ const d=await sf(u); return(d.articles||[]).map(a=>({title:a.title||'',body:a.description||a.content||'',source:a.source?.name||'NewsAPI',url:a.url||'',published:a.publishedAt||''})); }catch{return[];}
}

// ── GDELT ─────────────────────────────────────────────────────
async function gdelt(kws){
  const u='https://api.gdeltproject.org/api/v2/doc/doc?'+new URLSearchParams({query:kws.slice(0,3).join(' '),mode:'ArtList',maxrecords:'10',format:'json',timespan:'7d'});
  try{ const d=await sf(u,{},6000); return(d.articles||[]).map(a=>({title:a.title||'',body:a.title||'',source:a.domain||'GDELT',url:a.url||'',published:a.seendate||''})); }catch{return[];}
}

// ── RSS ───────────────────────────────────────────────────────
async function rss(kws){
  const q=kws.slice(0,2).join(' '), out=[];
  const feeds=[
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`,
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(q)}®ion=US&lang=en-US`
  ];
  for(const u of feeds){
    try{ const r=await fetch(u,{signal:AbortSignal.timeout(5000)}); const t=await r.text(); out.push(...parseRSS(t).slice(0,8)); }catch{}
  }
  return out;
}

function parseRSS(xml){
  const out=[]; const rx=/([\s\S]*?)<\/item>/g; let m;
  while((m=rx.exec(xml))!==null){
    const g=tag=>{const r=m[1].match(new RegExp('<'+tag+'[^>]*>|<'+tag+'[^>]*>([^<]*)'));return r?(r[1]||r[2]||'').trim():'';};
    out.push({title:g('title'),body:g('description'),source:g('source')||'RSS',url:g('link'),published:g('pubDate')});
  }
  return out;
}

// ════════════════════════════════════════════════════════════
//  NLP
// ════════════════════════════════════════════════════════════
function kw(q){
  const stop=new Set(['will','the','a','an','be','is','are','was','were','has','have','had','does','do','did','in','on','at','to','of','for','and','or','by','before','after','from','with','not','any','all','per','percent','billion','million','end','close','start']);
  const words=q.replace(/[^a-zA-Z0-9\s]/g,' ').split(/\s+/).map(w=>w.toLowerCase()).filter(w=>w.length>2&&!stop.has(w));
  const freq={}; words.forEach(w=>freq[w]=(freq[w]||0)+1);
  const ents=[]; const cr=/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g; let m;
  while((m=cr.exec(q))!==null){const e=m[1].trim();if(!stop.has(e.toLowerCase()))ents.push(e);}
  const top=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([w])=>w);
  return[...new Set([...ents.slice(0,3),...top])].slice(0,6);
}

const POS=new Set(['surge','surges','surged','rally','bullish','positive','growth','advance','gain','gains','rise','beat','exceed','outperform','strong','approve','approved','pass','passed','win','wins','won','victory','support','backed','likely','probable','confidence','optimism','record','breakthrough','agreement','deal','confirm','confirmed','increase','expand']);
const NEG=new Set(['fall','falls','fell','drop','drops','dropped','decline','declines','crash','plunge','slump','bearish','negative','loss','losses','lose','loses','miss','reject','rejected','veto','fail','fails','failed','unlikely','doubt','concern','worry','risk','threat','warning','delay','dispute','crisis','cut','ban','sanction','uncertainty','volatile','weak','halt']);

function sent(text){
  const words=text.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/);
  let s=0,c=0;
  words.forEach(w=>{if(POS.has(w)){s++;c++;}if(NEG.has(w)){s--;c++;}});
  const nr=/\b(not|no|never|don't|doesn't|didn't|won't|can't)\s+(\w+)/gi; let nm;
  while((nm=nr.exec(text))!==null){const w=nm[2].toLowerCase();if(POS.has(w))s-=2;if(NEG.has(w))s+=2;}
  return c>0?Math.max(-1,Math.min(1,s/Math.max(c,3))):0;
}

function score(a,question){
  const qw=new Set(kw(question).map(w=>w.toLowerCase()));
  const ft=`${a.title} ${a.body}`.toLowerCase();
  let hits=0; qw.forEach(w=>{if(ft.includes(w))hits++;});
  const relevance=qw.size>0?hits/qw.size:0;
  const sentiment=sent(ft);
  const direction=sentiment>.1?'BULLISH':sentiment<-.1?'BEARISH':'NEUTRAL';
  return{...a,relevance,sentiment,direction};
}

function agg(scored,q_yes){
  const w=scored.filter(a=>a.relevance>.1);
  if(!w.length)return{predP:q_yes,predConf:.42,bdisFinancial:48,sentiment:0,keySignals:[]};
  const tw=w.reduce((s,a)=>s+a.relevance,0);
  const avgs=w.reduce((s,a)=>s+a.sentiment*a.relevance,0)/tw;
  const vc=Math.min(.25,w.length*.025);
  const predP=Math.max(.05,Math.min(.95,q_yes+avgs*.12));
  const sc2=Math.min(.20,Math.abs(avgs)*.25);
  const predConf=Math.min(.92,.50+vc+sc2);
  const ar=tw/w.length;
  const cons=avgs>.15||avgs<-.15?15:5;
  const bdisFinancial=Math.min(95,Math.max(30,40+ar*30+cons+w.length*1.5));
  const keySignals=w.sort((a,b)=>b.relevance-a.relevance).slice(0,4).map(a=>({title:a.title,sentiment:a.sentiment,direction:a.direction,source:a.source}));
  return{predP:+predP.toFixed(4),predConf:+predConf.toFixed(3),bdisFinancial:+bdisFinancial.toFixed(1),sentiment:+avgs.toFixed(4),keySignals};
}

function dedup(arr){const s=new Set(); return arr.filter(a=>{const k=a.title.toLowerCase().slice(0,60).replace(/\s+/g,'');if(s.has(k))return false;s.add(k);return true;});}
function fetchAll(kws){return Promise.all([newsapi(kws),gdelt(kws),rss(kws)]).then(([a,b,c])=>dedup([...a,...b,...c]));}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

app.listen(PORT,()=>{
  console.log(`🌊 Lahara Backend :${PORT}  NewsAPI:${NEWS_API_KEY?'✓':'✗'}`);
});
