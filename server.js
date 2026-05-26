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
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['text/html', 'text/plain'], limit: '10mb' }));

const PORT = process.env.PORT || 8787;
const OPR_KEY = process.env.OPENPAGERANK_API_KEY || '';
const SIMILARWEB_KEY = process.env.SIMILARWEB_API_KEY || '';
const CHECK_MINUTES = Math.max(5, +(process.env.CHECK_INTERVAL_MIN || 30));
const NEWS_REGION = process.env.NEWS_REGION || 'PH'; // hl/gl/ceid region
// Optional shared secret. If set, write endpoints (library, publish,
// unpublish) require a matching X-Clippings-Token header. Strongly
// recommended once the server is publicly reachable.
const API_TOKEN = process.env.API_TOKEN || '';
// Team access: an OWNER passcode (full access incl. invoicing) and an
// optional STAFF passcode (everything except invoicing). OWNER_PASS falls
// back to API_TOKEN so an existing single-token setup keeps working.
const OWNER_PASS = process.env.OWNER_PASS || API_TOKEN;
const STAFF_PASS = process.env.STAFF_PASS || '';
const AUTH_ON = !!OWNER_PASS;
// Public base URL for share links (set behind a proxy/custom domain).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// ── Persistence (simple JSON file; rebuilds itself if lost) ──────────
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'store.json');
const PUBLISHED_DIR = path.join(__dirname, 'published');
try { fs.mkdirSync(PUBLISHED_DIR, { recursive: true }); } catch {}
let store = { clients: [], mentions: [], seen: {}, published: [], library: null, brief: null, briefs: [], contacts: [], pitches: [] };
function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { /* fresh store */ }
  if (!store.clients) store.clients = [];
  if (!store.mentions) store.mentions = [];
  if (!store.seen) store.seen = {};
  if (!store.published) store.published = [];
  if (!('library' in store)) store.library = null;
  if (!('brief' in store)) store.brief = null;
  if (!store.briefs) store.briefs = [];
  if (!store.contacts) store.contacts = [];
  if (!store.pitches) store.pitches = [];
}

// ── Roles ───────────────────────────────────────────────────────────
// owner = full access (incl. invoicing); staff = everything but invoicing.
// When no passcodes are configured (local dev), everything is open as owner.
function roleFor(req) {
  if (!AUTH_ON) return 'owner';
  const t = (req.get('X-Clippings-Pass') || req.get('X-Clippings-Token') || '').trim();
  if (t && t === OWNER_PASS) return 'owner';
  if (STAFF_PASS && t === STAFF_PASS) return 'staff';
  return null;
}
function requireAuth(req, res, next) {
  const r = roleFor(req);
  if (!r) return res.status(401).json({ error: 'Sign in required' });
  req.role = r; next();
}
function requireOwner(req, res, next) {
  const r = roleFor(req);
  if (r !== 'owner') return res.status(r ? 403 : 401).json({ error: r ? 'Owner only' : 'Sign in required' });
  req.role = r; next();
}
// Staff never receive invoices or secret settings fields.
function staffView(lib) {
  const s = (lib && lib.settings) || {};
  return {
    books: ((lib && lib.books) || []).map(b => { const { invoice, ...rest } = b; return rest; }),
    settings: { agency: s.agency || '', agencyUrl: s.agencyUrl || '', currency: s.currency || 'PHP' },
    updatedAt: (lib && lib.updatedAt) || 0,
  };
}
// Staff saves coverage but can never read or change invoices/settings:
// preserve each book's stored invoice (by id) and the stored settings.
function mergeStaffLibrary(incoming) {
  const prev = store.library || { books: [], settings: {}, updatedAt: 0 };
  const invById = {};
  for (const b of (prev.books || [])) if (b && b.id) invById[b.id] = b.invoice;
  const books = (incoming.books || []).map(b => {
    if (b && b.id && invById[b.id] !== undefined) return { ...b, invoice: invById[b.id] };
    const { invoice, ...rest } = b || {}; return rest;
  });
  return { books, settings: prev.settings || {}, updatedAt: incoming.updatedAt || Date.now() };
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

// ── Contacts / byline harvest (the self-building media database) ─────
const UA = 'Mozilla/5.0 (compatible; ClippingsBot/1.0)';
function cleanName(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, '').replace(/\s+/g, ' ').trim().replace(/^by\s+/i, '').slice(0, 80);
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Extract an author/byline from article HTML — JSON-LD, then meta tags, then rel=author.
function extractByline(html) {
  if (!html) return '';
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const blk of blocks) {
    const json = blk.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    try {
      const data = JSON.parse(json);
      const nodes = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
      for (const n of nodes) {
        const a = n && n.author;
        if (!a) continue;
        const first = Array.isArray(a) ? a[0] : a;
        const name = first && (first.name || (typeof first === 'string' ? first : ''));
        if (name && typeof name === 'string' && name.length < 80) return cleanName(name);
      }
    } catch {}
  }
  const metas = [
    /<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']parsely-author["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+itemprop=["']author["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of metas) {
    const mm = html.match(re);
    if (mm && mm[1] && !/^https?:/i.test(mm[1])) return cleanName(mm[1]);
  }
  const rel = html.match(/<a[^>]+rel=["']author["'][^>]*>([^<]{2,60})<\/a>/i);
  if (rel && rel[1]) return cleanName(rel[1]);
  const cls = html.match(/class=["'][^"']*byline[^"']*["'][^>]*>\s*(?:by\s+)?([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3})/);
  if (cls && cls[1]) return cleanName(cls[1]);
  return '';
}

// Resolve a Google News link to the real article (best-effort) → {url, html}.
async function resolveArticleUrl(link) {
  try {
    const r = await fetch(link, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const finalUrl = r.url || link;
    const html = await r.text();
    if (!/news\.google\.com/i.test(finalUrl)) return { url: finalUrl, html };
    const m = html.match(/data-n-au="([^"]+)"/) || html.match(/<a[^>]+href="(https?:\/\/(?!news\.google\.com)[^"]+)"/i);
    if (m && m[1]) {
      try {
        const r2 = await fetch(m[1], { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        return { url: r2.url || m[1], html: await r2.text() };
      } catch {}
    }
    return { url: finalUrl, html: '' }; // still on Google News → don't scrape its interstitial; use outlet RSS instead
  } catch { return { url: link, html: '' }; }
}

// Microlink fallback (free tier) → {author, resolved}.
async function microlinkAuthor(url) {
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(9000) });
    const j = await r.json();
    if (j && j.status === 'success' && j.data) {
      const a = j.data.author;
      return { author: (a && typeof a === 'string') ? cleanName(a) : '', resolved: j.data.url || url };
    }
  } catch {}
  return { author: '', resolved: url };
}

// Free byline fallback: many WordPress-based outlets expose <dc:creator> in
// their RSS. Match the article by title and read the author. No API/quota.
const _feedCache = {};
async function outletRssByline(domain, title) {
  if (!domain || !title || _feedCache[domain] === null) return '';
  const tnorm = norm(title);
  const candidates = _feedCache[domain] ? [_feedCache[domain]] : [`https://${domain}/feed/`, `https://${domain}/rss`, `https://${domain}/?feed=rss2`];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<rss|<feed/i.test(xml)) continue;
      _feedCache[domain] = u;
      const items = xml.split(/<item[>\s]/i).slice(1);
      for (const it of items) {
        const t = (it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const tc = norm(t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''));
        if (tc && (tc === tnorm || tc.includes(tnorm.slice(0, 40)) || tnorm.includes(tc.slice(0, 40)))) {
          const cr = (it.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '';
          const name = cr.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
          if (name) return cleanName(name);
        }
      }
      return '';
    } catch {}
  }
  if (!_feedCache[domain]) _feedCache[domain] = null;
  return '';
}

// Outlet authority (cached per domain) via OpenPageRank.
const _daCache = {};
async function maybeSetOutletDA(c) {
  const d = c.outletDomain || cleanDomain(c.outlet);
  if (!d || !OPR_KEY) return;
  if (_daCache[d] !== undefined) { if (c.da == null) c.da = _daCache[d]; return; }
  const pr = await getPageRank(d);
  const da = pr ? daFromPageRank(pr.pageRank) : null;
  _daCache[d] = da; c.da = da; saveStore();
}

function findContact(name, outlet) {
  const n = norm(name), o = norm(outlet);
  if (!n) return null;
  return store.contacts.find(c => norm(c.name) === n && (!o || !c.outlet || norm(c.outlet) === o)) || null;
}
function findOrCreateContact(f) {
  let c = (f.id && store.contacts.find(x => x.id === f.id)) || findContact(f.name, f.outlet);
  if (!c) {
    c = {
      id: f.id || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: f.name || '', outlet: f.outlet || '', outletDomain: f.outletDomain || '',
      beat: Array.isArray(f.beat) ? f.beat : [], type: f.type || 'journalist',
      email: f.email || '', social: f.social || {}, tier: f.tier || '', status: f.status || '',
      clients: Array.isArray(f.clients) ? f.clients : [], articles: [], notes: f.notes || '',
      da: null, source: f.source || 'manual', createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.contacts.push(c);
  }
  return c;
}
// Merge provided fields onto an existing/new contact (used by the API).
function upsertContact(input) {
  if (!input || (!input.name && !input.id)) return null;
  const c = findOrCreateContact(input);
  for (const k of ['name', 'outlet', 'outletDomain', 'email', 'tier', 'status', 'notes', 'type', 'lastTouch']) {
    if (input[k] !== undefined && input[k] !== '') c[k] = input[k];
  }
  if (Array.isArray(input.beat)) c.beat = input.beat;
  if (input.social && typeof input.social === 'object') c.social = { ...c.social, ...input.social };
  if (Array.isArray(input.clients)) c.clients = [...new Set([...(c.clients || []), ...input.clients])];
  if (!c.outletDomain && c.outlet) c.outletDomain = cleanDomain(c.outlet);
  c.updatedAt = Date.now();
  maybeSetOutletDA(c);
  return c;
}
// Upsert a discovered journalist from a monitored mention + harvested byline.
function upsertContactFromMention(m, author, articleUrl) {
  const outletDomain = cleanDomain(m.sourceUrl || articleUrl || '');
  const c = findOrCreateContact({ name: author, outlet: m.outlet || outletDomain, outletDomain, type: 'journalist', source: 'discovered' });
  c.articles = c.articles || [];
  if (articleUrl && !c.articles.some(a => a.url === articleUrl)) {
    c.articles.unshift({ title: m.title || '', url: articleUrl, date: m.date || '', clientId: m.clientId || '' });
    if (c.articles.length > 25) c.articles = c.articles.slice(0, 25);
  }
  if (m.clientId) { c.clients = c.clients || []; if (!c.clients.includes(m.clientId)) c.clients.push(m.clientId); }
  c.lastSeen = m.date || new Date().toISOString().slice(0, 10);
  if (!c.outletDomain) c.outletDomain = outletDomain;
  c.updatedAt = Date.now();
  maybeSetOutletDA(c);
}
// Reject non-person / generic / site-name "authors" (e.g. "Google News").
function sanitizeAuthor(name) {
  const n = (name || '').trim();
  if (!n || n.length < 3 || n.length > 60 || /^https?:/i.test(n)) return '';
  const bad = ['google news', 'google', 'news', 'staff', 'admin', 'administrator', 'editor', 'editorial', 'newsroom', 'team', 'correspondent', 'contributor', 'guest', 'reporter', 'desk', 'agencies'];
  if (bad.includes(n.toLowerCase())) return '';
  return n;
}
// Enrich one mention: resolve URL → extract byline → upsert contact. Fail-soft.
async function enrichMention(m) {
  m.enrichTried = true;
  let author = '', articleUrl = m.url;
  const domain = cleanDomain(m.sourceUrl || '');
  try {
    const { url, html } = await resolveArticleUrl(m.url);
    articleUrl = url || m.url;
    author = sanitizeAuthor(extractByline(html));
    if (!author && domain) author = sanitizeAuthor(await outletRssByline(domain, m.title)); // free WP dc:creator fallback (no quota)
    // Only spend Microlink quota when we have a real (resolved) article URL — Google News links never resolve here.
    if (!author && !/news\.google\.com/i.test(articleUrl)) { const ml = await microlinkAuthor(articleUrl); author = sanitizeAuthor(ml.author); if (ml.resolved) articleUrl = ml.resolved; }
  } catch {}
  m.articleUrl = articleUrl;
  if (author) { m.author = author; upsertContactFromMention(m, author, articleUrl); }
  return !!author;
}

// ── Endpoints ───────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'clippings-backend',
    openpagerank: !!OPR_KEY,
    similarweb: !!SIMILARWEB_KEY,
    tokenRequired: !!API_TOKEN,
    authRequired: AUTH_ON,
    staffEnabled: !!STAFF_PASS,
    published: store.published.length,
    hasLibrary: !!store.library,
    clients: store.clients.length,
    mentions: store.mentions.length,
    contacts: store.contacts.length,
    pitches: store.pitches.length,
    checkEveryMinutes: CHECK_MINUTES,
  });
});

// Sign in with a passcode → returns the caller's role.
app.post('/api/login', (req, res) => {
  const code = (req.body && req.body.code ? String(req.body.code) : '').trim();
  if (!AUTH_ON) return res.json({ ok: true, role: 'owner' });
  if (code && code === OWNER_PASS) return res.json({ ok: true, role: 'owner' });
  if (STAFF_PASS && code === STAFF_PASS) return res.json({ ok: true, role: 'staff' });
  return res.status(401).json({ ok: false, error: 'Wrong code' });
});

// Live metrics for a domain: real DA (OpenPageRank) + traffic (SimilarWeb).
app.get('/api/metrics', requireAuth, async (req, res) => {
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
app.post('/api/monitors/sync', requireAuth, (req, res) => {
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
app.get('/api/mentions', requireAuth, (req, res) => {
  const since = req.query.since ? Date.parse(req.query.since) : 0;
  const clientId = req.query.clientId;
  let out = store.mentions;
  if (clientId) out = out.filter(m => m.clientId === clientId);
  if (since) out = out.filter(m => Date.parse(m.foundAt) > since);
  res.json({ mentions: out });
});

// ── Media contacts (journalists / influencers) — shared team DB ─────
app.get('/api/contacts', requireAuth, (req, res) => {
  res.json({ contacts: store.contacts });
});
app.post('/api/contacts', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.contacts) ? body.contacts : [body]);
  const out = [];
  for (const item of list) { const c = upsertContact(item); if (c) out.push(c); }
  saveStore();
  res.json({ ok: true, upserted: out.length, contacts: out });
});
app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  const before = store.contacts.length;
  store.contacts = store.contacts.filter(c => c.id !== req.params.id);
  saveStore();
  res.json({ ok: true, removed: before - store.contacts.length });
});

// ── Pitches (angle → journalist → status) — shared team pipeline ────
function upsertPitch(input) {
  if (!input || (!input.id && !input.angle && !input.subject)) return null;
  let p = input.id ? store.pitches.find(x => x.id === input.id) : null;
  if (!p) {
    p = { id: input.id || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), clientId: '', contactIds: [], angle: '', subject: '', body: '', status: 'draft', owner: '', createdAt: Date.now(), updatedAt: Date.now() };
    store.pitches.push(p);
  }
  for (const k of ['clientId', 'angle', 'subject', 'body', 'status', 'owner', 'sentAt', 'repliedAt', 'landedUrl']) {
    if (input[k] !== undefined) p[k] = input[k];
  }
  if (Array.isArray(input.contactIds)) p.contactIds = input.contactIds;
  if (p.status === 'sent' && !p.sentAt) p.sentAt = new Date().toISOString();
  if (p.status === 'replied' && !p.repliedAt) p.repliedAt = new Date().toISOString();
  p.updatedAt = Date.now();
  return p;
}
app.get('/api/pitches', requireAuth, (req, res) => { res.json({ pitches: store.pitches }); });
app.post('/api/pitches', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.pitches) ? body.pitches : [body]);
  const out = [];
  for (const item of list) { const p = upsertPitch(item); if (p) out.push(p); }
  saveStore();
  res.json({ ok: true, upserted: out.length, pitches: out });
});
app.delete('/api/pitches/:id', requireAuth, (req, res) => {
  const before = store.pitches.length;
  store.pitches = store.pitches.filter(p => p.id !== req.params.id);
  saveStore();
  res.json({ ok: true, removed: before - store.pitches.length });
});

// ── Cloud backup of the whole library (books + settings) ────────────
app.post('/api/library', requireAuth, (req, res) => {
  const { books, settings, updatedAt } = req.body || {};
  if (!Array.isArray(books)) return res.status(400).json({ error: 'books array required' });
  if (req.role === 'staff') {
    store.library = mergeStaffLibrary({ books, updatedAt });
  } else {
    store.library = { books, settings: settings || {}, updatedAt: updatedAt || Date.now() };
  }
  saveStore();
  res.json({ ok: true, books: store.library.books.length, updatedAt: store.library.updatedAt });
});

app.get('/api/library', requireAuth, (req, res) => {
  const lib = store.library || { books: [], settings: {}, updatedAt: 0 };
  res.json(req.role === 'staff' ? staffView(lib) : lib);
});

// ── Daily Intel brief (posted by the Cowork scheduled task) ─────────
// Owner posts the finished brief (raw text/html body, or JSON); any signed-in
// teammate can read it in the app's "Daily Intel" tab.
app.post('/api/brief', requireOwner, (req, res) => {
  let subject = (req.query.subject || '').toString();
  let date = (req.query.date || '').toString();
  let html = '', markdown = '';
  if (typeof req.body === 'string') {
    html = req.body;
  } else if (req.body && typeof req.body === 'object') {
    html = req.body.html || '';
    markdown = req.body.markdown || '';
    subject = subject || req.body.subject || '';
    date = date || req.body.date || '';
  }
  if (!html && !markdown) return res.status(400).json({ error: 'html or markdown required' });
  const entry = {
    subject: subject || 'PR Intelligence Brief',
    date: date || new Date().toISOString().slice(0, 10),
    html, markdown, postedAt: new Date().toISOString(),
  };
  store.brief = entry;
  store.briefs.push(entry);
  if (store.briefs.length > 10) store.briefs = store.briefs.slice(-10);
  saveStore();
  res.json({ ok: true, date: entry.date });
});

app.get('/api/brief', requireAuth, (req, res) => {
  res.json({ latest: store.brief || null, history: (store.briefs || []).slice(-10).reverse() });
});

// ── Publish a report to a shareable URL ─────────────────────────────
function shareUrl(req, slug) {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/r/${slug}`;
}

app.post('/api/reports/publish', requireAuth, (req, res) => {
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

app.delete('/api/reports/:slug', requireAuth, (req, res) => {
  const slug = req.params.slug;
  try { fs.unlinkSync(path.join(PUBLISHED_DIR, slug + '.html')); } catch {}
  store.published = store.published.filter(p => p.slug !== slug);
  saveStore();
  res.json({ ok: true });
});

// ── Serve the app itself (single-deploy: API + frontend, one URL) ───
// The app is a single index.html. Serve it at the root from wherever it
// sits — repo root or ./public — and expose nothing else (no static dir,
// so store.json / server.js stay private). API and /r routes above win.
const APP_HTML = fs.existsSync(path.join(__dirname, 'index.html'))
  ? path.join(__dirname, 'index.html')
  : path.join(__dirname, 'public', 'index.html');
app.get('/', (req, res) => res.sendFile(APP_HTML));

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
    // Byline harvest — enrich a few new, un-tried mentions per run (rate-limited
    // for Render CPU + Microlink's free quota). Builds the contacts DB for free.
    const _toEnrich = store.mentions.filter(m => !m.enrichTried && !m.author).slice(-8);
    for (const m of _toEnrich) { try { await enrichMention(m); } catch {} }
    if (_toEnrich.length) saveStore();
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
app.post('/api/sweep', requireAuth, async (req, res) => {
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
