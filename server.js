// ═══════════════════════════════════════════════════════════════════
// Clippings backend — live metrics + 24/7 news monitoring.
// Holds API keys server-side (never exposed to the browser) and runs
// the keyword monitor on a schedule so it works even when the app is
// closed. Plain Node + Express; deploy anywhere (Render, Railway, Fly).
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// CORS — allow the static frontend to call this API. Restrict to a
// specific origin by setting ALLOW_ORIGIN; defaults to open for ease.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
app.use(cors({ origin: ALLOW_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8787;
const OPR_KEY = process.env.OPENPAGERANK_API_KEY || '';
const SIMILARWEB_KEY = process.env.SIMILARWEB_API_KEY || '';
const CHECK_MINUTES = Math.max(5, +(process.env.CHECK_INTERVAL_MIN || 30));
const NEWS_REGION = process.env.NEWS_REGION || 'PH'; // hl/gl/ceid region
// Optional shared secret. If set, write endpoints (library, publish,
// unpublish) require a matching X-Clippings-Token header. Strongly
// recommended once the server is publicly reachable.
const API_TOKEN = process.env.API_TOKEN || '';
// Public base URL for share links (set behind a proxy/custom domain).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// ── Persistence (simple JSON file; rebuilds itself if lost) ──────────
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'store.json');
const PUBLISHED_DIR = path.join(__dirname, 'published');
try { fs.mkdirSync(PUBLISHED_DIR, { recursive: true }); } catch {}
let store = { clients: [], mentions: [], seen: {}, published: [], library: null };
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { /* fresh store */ }
  if (!store.clients) store.clients = [];
  if (!store.mentions) store.mentions = [];
  if (!store.seen) store.seen = {};
  if (!store.published) store.published = [];
  if (!('library' in store)) store.library = null;
}

// Token guard for write endpoints. No-op when API_TOKEN is unset.
function requireToken(req, res, next) {
  if (!API_TOKEN) return next();
  const t = req.get('X-Clippings-Token') || '';
  if (t === API_TOKEN) return next();
  return res.status(401).json({ error: 'Invalid or missing token' });
}

// URL-safe slug from a base string + short random suffix.
function makeSlug(base) {
  const root = String(base || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';
  return root + '-' + Math.random().toString(36).slice(2, 7);
}
let _saveTimer = null;
function saveStore() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); }
    catch (e) { console.error('store save failed:', e.message); }
  }, 250);
}
loadStore();

// ── Metric sources ──────────────────────────────────────────────────
async function getPageRank(domain) {
  if (!OPR_KEY) return null;
  try {
    const r = await fetch(`https://openpagerank.com/api/v1.0/getPageRank?domains[]=${encodeURIComponent(domain)}`,
      { headers: { 'API-OPR': OPR_KEY } });
    const j = await r.json();
    const it = j?.response?.[0];
    if (it && it.status_code === 200) return { pageRank: it.page_rank_decimal || 0, rank: it.rank || 0 };
  } catch (e) { console.error('OpenPageRank error:', e.message); }
  return null;
}

async function getSimilarWeb(domain) {
  if (!SIMILARWEB_KEY) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const url = `https://api.similarweb.com/v1/website/${encodeURIComponent(domain)}/total-traffic-and-engagement/visits`
    + `?api_key=${SIMILARWEB_KEY}&start_date=${ym(start)}&end_date=${ym(end)}`
    + `&country=world&granularity=monthly&main_domain_only=false&format=json`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const v = j?.visits;
    if (Array.isArray(v) && v.length) return Math.round(+v[v.length - 1].visits || 0);
  } catch (e) { console.error('SimilarWeb error:', e.message); }
  return null;
}

// PageRank (0–10) → DA-like score (0–100), same curve as the frontend.
function daFromPageRank(pr) {
  if (pr <= 0) return 1;
  if (pr >= 10) return 100;
  const c = [1, 12, 22, 32, 40, 50, 58, 68, 78, 90, 100];
  const f = Math.floor(pr), cc = Math.ceil(pr), fr = pr - f;
  return Math.round(c[f] * (1 - fr) + c[cc] * fr);
}

function cleanDomain(input) {
  return String(input || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
}

// ── Google News RSS parsing ─────────────────────────────────────────
function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  const pick = (s, tag) => {
    const mm = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return mm ? mm[1] : '';
  };
  const clean = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    // <source url="https://www.outlet.com">Outlet Name</source>
    const srcUrl = (b.match(/<source[^>]*\burl="([^"]+)"/) || [])[1] || '';
    items.push({
      title: clean(pick(b, 'title')),
      link: clean(pick(b, 'link')),
      pubDate: clean(pick(b, 'pubDate')),
      source: clean(pick(b, 'source')),
      sourceUrl: srcUrl,
    });
  }
  return items;
}

// ── Endpoints ───────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'clippings-backend',
    openpagerank: !!OPR_KEY,
    similarweb: !!SIMILARWEB_KEY,
    tokenRequired: !!API_TOKEN,
    published: store.published.length,
    hasLibrary: !!store.library,
    clients: store.clients.length,
    mentions: store.mentions.length,
    checkEveryMinutes: CHECK_MINUTES,
  });
});

// Live metrics for a domain: real DA (OpenPageRank) + traffic (SimilarWeb).
app.get('/api/metrics', async (req, res) => {
  const domain = cleanDomain(req.query.domain);
  if (!domain) return res.status(400).json({ error: 'domain query param required' });
  const pr = await getPageRank(domain);
  const visits = await getSimilarWeb(domain);
  res.json({
    domain,
    domainAuthority: pr ? daFromPageRank(pr.pageRank) : null,
    pageRank: pr ? pr.pageRank : null,
    rank: pr ? pr.rank : null,
    visits: visits != null ? visits : null,
    sources: {
      da: pr ? 'OpenPageRank' : null,
      traffic: visits != null ? 'SimilarWeb' : null,
    },
  });
});

// Frontend syncs its full keyword set here; we monitor it 24/7.
app.post('/api/monitors/sync', (req, res) => {
  const clients = Array.isArray(req.body && req.body.clients) ? req.body.clients : [];
  store.clients = clients
    .map(c => ({
      id: String(c.id || ''),
      name: String(c.name || ''),
      keywords: (c.keywords || []).map(String).map(s => s.trim()).filter(Boolean),
    }))
    .filter(c => c.id && c.keywords.length);
  saveStore();
  res.json({ ok: true, clients: store.clients.length });
  sweep().catch(() => {}); // kick an immediate check
});

// Mentions discovered by the monitor. Filter by client and/or since-time.
app.get('/api/mentions', (req, res) => {
  const since = req.query.since ? Date.parse(req.query.since) : 0;
  const clientId = req.query.clientId;
  let out = store.mentions;
  if (clientId) out = out.filter(m => m.clientId === clientId);
  if (since) out = out.filter(m => Date.parse(m.foundAt) > since);
  res.json({ mentions: out });
});

// ── Cloud backup of the whole library (books + settings) ────────────
app.post('/api/library', requireToken, (req, res) => {
  const { books, settings, updatedAt } = req.body || {};
  if (!Array.isArray(books)) return res.status(400).json({ error: 'books array required' });
  store.library = { books, settings: settings || {}, updatedAt: updatedAt || Date.now() };
  saveStore();
  res.json({ ok: true, books: books.length, updatedAt: store.library.updatedAt });
});

app.get('/api/library', (req, res) => {
  res.json(store.library || { books: [], settings: {}, updatedAt: 0 });
});

// ── Publish a report to a shareable URL ─────────────────────────────
function shareUrl(req, slug) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/r/${slug}`;
}

app.post('/api/reports/publish', requireToken, (req, res) => {
  const { slug, title, html } = req.body || {};
  if (!html || typeof html !== 'string') return res.status(400).json({ error: 'html required' });
  const finalSlug = (slug && /^[a-z0-9-]{3,60}$/.test(slug)) ? slug : makeSlug(title);
  try {
    fs.writeFileSync(path.join(PUBLISHED_DIR, finalSlug + '.html'), html);
    const idx = store.published.findIndex(p => p.slug === finalSlug);
    const entry = { slug: finalSlug, title: title || 'Report', updatedAt: Date.now() };
    if (idx >= 0) store.published[idx] = entry; else store.published.push(entry);
    saveStore();
    res.json({ ok: true, slug: finalSlug, url: shareUrl(req, finalSlug) });
  } catch (e) {
    res.status(500).json({ error: 'Could not publish', detail: String(e) });
  }
});

app.get('/r/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return res.status(404).send('Not found');
  try {
    const html = fs.readFileSync(path.join(PUBLISHED_DIR, slug + '.html'), 'utf8');
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch {
    res.status(404).send('Report not found or unpublished.');
  }
});

app.delete('/api/reports/:slug', requireToken, (req, res) => {
  const slug = req.params.slug;
  try { fs.unlinkSync(path.join(PUBLISHED_DIR, slug + '.html')); } catch {}
  store.published = store.published.filter(p => p.slug !== slug);
  saveStore();
  res.json({ ok: true });
});

// ── Serve the app itself (single-deploy: API + frontend, one URL) ───
// The Clippings app lives in ./public. API and /r routes above take
// priority; everything else is served as static files.
app.use(express.static(path.join(__dirname, 'public')));

// ── Monitoring sweep (runs on a schedule) ───────────────────────────
let _sweeping = false;
async function sweep() {
  if (_sweeping) return;
  _sweeping = true;
  let added = 0;
  try {
    for (const c of store.clients) {
      for (const kw of c.keywords) {
        const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(kw)}&hl=en&gl=${NEWS_REGION}&ceid=${NEWS_REGION}:en`;
        try {
          const r = await fetch(rss, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClippingsBot/1.0)' } });
          const xml = await r.text();
          for (const it of parseRss(xml)) {
            if (!it.link) continue;
            const key = c.id + '|' + it.link;
            if (store.seen[key]) continue;
            store.seen[key] = Date.now();
            let date = '';
            try { date = new Date(it.pubDate).toISOString().slice(0, 10); } catch {}
            store.mentions.push({
              id: Math.random().toString(36).slice(2, 10),
              clientId: c.id, clientName: c.name, keyword: kw,
              title: it.title, url: it.link, outlet: it.source || '',
              sourceUrl: it.sourceUrl || '',
              date, foundAt: new Date().toISOString(),
            });
            added++;
          }
        } catch (e) { console.error('sweep error for', kw, '-', e.message); }
      }
    }
    // Keep storage bounded.
    if (store.mentions.length > 500) store.mentions = store.mentions.slice(-500);
    pruneSeen();
    if (added) { console.log(`[sweep] +${added} new mention(s)`); saveStore(); }
  } finally {
    _sweeping = false;
  }
  return added;
}

// Drop dedupe keys older than 45 days so the map doesn't grow forever.
function pruneSeen() {
  const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(store.seen)) {
    if (store.seen[k] < cutoff) delete store.seen[k];
  }
}

// Manual trigger (handy for testing).
app.post('/api/sweep', async (req, res) => {
  const added = await sweep();
  res.json({ ok: true, added });
});

setInterval(() => { sweep().catch(() => {}); }, CHECK_MINUTES * 60 * 1000);
setTimeout(() => { sweep().catch(() => {}); }, 3000);

app.listen(PORT, () => {
  console.log(`Clippings backend listening on :${PORT}`);
  console.log(`  OpenPageRank: ${OPR_KEY ? 'configured' : 'not set'} · SimilarWeb: ${SIMILARWEB_KEY ? 'configured' : 'not set'}`);
  console.log(`  Monitoring every ${CHECK_MINUTES} min · region ${NEWS_REGION}`);
});
