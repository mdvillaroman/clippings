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

// ── Durable store (optional, free): mirror the JSON store to a PRIVATE
// GitHub repo so data survives the host's ephemeral-disk wipes (every
// redeploy + idle cold-start on free tiers). Set STORE_REPO ("owner/repo",
// a *private* repo) and GITHUB_TOKEN (a fine-grained PAT with Contents:
// read & write on just that repo) to enable. Unset or unreachable ⇒ the
// server falls back to the local JSON file below and never blocks a
// request on the network. The store can hold invoice figures, so the repo
// MUST be private (a fine-grained token scoped to that one repo keeps the
// blast radius tiny if it ever leaks).
const STORE_REPO = (process.env.STORE_REPO || '').trim();   // e.g. "mdvillaroman/clippings-data"
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const STORE_PATH = (process.env.STORE_PATH || 'store.json').trim();
const STORE_BRANCH = (process.env.STORE_BRANCH || 'main').trim();
const REMOTE_ENABLED = !!(STORE_REPO && GITHUB_TOKEN);
let _remoteSha = null;   // last known blob SHA (GitHub needs it to update a file)
const GH_HEADERS = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  'User-Agent': 'clippings-backend',
  Accept: 'application/vnd.github+json',
});

// ── Persistence (simple JSON file; rebuilds itself if lost) ──────────
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'store.json');
const PUBLISHED_DIR = path.join(__dirname, 'published');
try { fs.mkdirSync(PUBLISHED_DIR, { recursive: true }); } catch {}
let store = { clients: [], mentions: [], seen: {}, published: [], library: null, brief: null, briefs: [], contacts: [], pitches: [] };
function normalizeStore() {
  if (!store || typeof store !== 'object') store = {};
  if (!store.clients) store.clients = [];
  if (!store.mentions) store.mentions = [];
  if (!store.seen) store.seen = {};
  if (!store.published) store.published = [];
  if (!('library' in store)) store.library = null;
  if (!('brief' in store)) store.brief = null;
  if (!store.briefs) store.briefs = [];
  if (!store.contacts) store.contacts = [];
  if (!store.pitches) store.pitches = [];
  if (!store.expenses) store.expenses = [];
  if (!store.opportunities) store.opportunities = [];
  if (!store.coverage) store.coverage = [];                // auto-filed coverage (monthly books)
  if (!store.coverageSuppress) store.coverageSuppress = {}; // "clientId|url" she removed → never re-file
  if (!('asanaToken' in store)) store.asanaToken = '';
}
function loadStore() {
  try { store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { /* fresh store */ }
  normalizeStore();
}
// Pull the durable copy from the private repo on boot. Overrides the local
// file when present; on any failure we keep whatever loadStore() set.
async function loadStoreRemote() {
  if (!REMOTE_ENABLED) return false;
  try {
    const url = `https://api.github.com/repos/${STORE_REPO}/contents/${encodeURIComponent(STORE_PATH)}?ref=${encodeURIComponent(STORE_BRANCH)}`;
    const r = await fetch(url, { headers: GH_HEADERS() });
    if (r.status === 404) { console.log('durable store: none yet (created on first save)'); return false; }
    if (!r.ok) { console.error('durable store load failed: HTTP', r.status); return false; }
    const j = await r.json();
    _remoteSha = j.sha || null;
    const content = Buffer.from(j.content || '', j.encoding || 'base64').toString('utf8');
    if (!content.trim()) return false;
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      store = parsed; normalizeStore();
      console.log('durable store: loaded from', STORE_REPO);
      return true;
    }
  } catch (e) { console.error('durable store load error:', e.message); }
  return false;
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
  saveStoreRemote();
}
// Mirror the store to the private repo (debounced + non-overlapping, so a
// burst of saves coalesces into a single commit and a slow network never
// blocks or stacks requests). Fully fail-soft: errors are logged, not thrown.
let _remoteTimer = null, _remoteInflight = false, _remoteDirty = false;
function saveStoreRemote() {
  if (!REMOTE_ENABLED) return;
  clearTimeout(_remoteTimer);
  _remoteTimer = setTimeout(pushRemote, 4000);
}
async function pushRemote() {
  if (!REMOTE_ENABLED) return;
  if (_remoteInflight) { _remoteDirty = true; return; }
  _remoteInflight = true; _remoteDirty = false;
  try {
    const url = `https://api.github.com/repos/${STORE_REPO}/contents/${encodeURIComponent(STORE_PATH)}`;
    const body = {
      message: `store ${new Date().toISOString()}`,
      content: Buffer.from(JSON.stringify(store)).toString('base64'),
      branch: STORE_BRANCH,
    };
    if (_remoteSha) body.sha = _remoteSha;
    let r = await fetch(url, { method: 'PUT', headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409) {            // SHA drifted — refetch it and retry once
      await loadShaOnly();
      if (_remoteSha) body.sha = _remoteSha; else delete body.sha;
      r = await fetch(url, { method: 'PUT', headers: { ...GH_HEADERS(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (r.ok) { const j = await r.json(); _remoteSha = (j.content && j.content.sha) || _remoteSha; }
    else console.error('durable store save failed: HTTP', r.status);
  } catch (e) { console.error('durable store save error:', e.message); }
  finally {
    _remoteInflight = false;
    if (_remoteDirty) saveStoreRemote();   // a change landed mid-flight — flush it
  }
}
async function loadShaOnly() {
  try {
    const url = `https://api.github.com/repos/${STORE_REPO}/contents/${encodeURIComponent(STORE_PATH)}?ref=${encodeURIComponent(STORE_BRANCH)}`;
    const r = await fetch(url, { headers: GH_HEADERS() });
    if (r.ok) { const j = await r.json(); _remoteSha = j.sha || _remoteSha; }
  } catch { /* keep old sha */ }
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

// ── News query curation (kills the Shiba-Inu-COIN collision, not tech news) ──
// Narrow, memecoin-specific signals only. We deliberately DON'T block generic
// fintech words (crypto/token/blockchain/funding) — those legitimately appear
// in startup/CFO/funding coverage of our clients (e.g. e27, Tech in Asia), and
// blocking them was silently dropping real Dr. Shiba / Tyger Brands stories.
const NOISE_TERMS = ['dogecoin', ' shib ', '$shib', 'shiba inu coin', 'shib price', 'shib token', 'shibarium', 'shib army', 'memecoin', 'altcoin', 'price prediction', 'whale alert', 'to the moon'];
function isNoise(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  return NOISE_TERMS.some(n => t.includes(n));
}
// Appended to every Google News query — only the precise coin collisions, so
// startup/tech/business coverage of our brands is NOT excluded.
const QUERY_EXCLUSIONS = '-dogecoin -memecoin -"price prediction" -"shiba inu coin" -shibarium';
// Turn a bare keyword into a precise query: exact-phrase a multi-word brand
// name (unless the user already used quotes/operators), then add exclusions.
// Power users can write full boolean directly, e.g.
//   "Dr. Shiba" OR "Tyger Brands" OR "Magic Mist"
// and it passes through untouched (just exclusions appended).
function buildQuery(kw) {
  let q = String(kw || '').trim();
  if (!q) return '';
  const hasOps = /["()]|\bOR\b|\bAND\b|(^|\s)-\S/.test(q);
  if (!hasOps && /\s/.test(q)) q = `"${q}"`;
  return `${q} ${QUERY_EXCLUSIONS}`;
}
// Two query variants per keyword: the precise exact-phrase, plus a broader
// unquoted recall pass for multi-word brands (relevance-guarded at ingest).
// Boolean keywords (with quotes/OR/AND) are used verbatim — no broad variant.
function queryVariants(kw) {
  const q = String(kw || '').trim();
  if (!q) return [];
  const hasOps = /["()]|\bOR\b|\bAND\b|(^|\s)-\S/.test(q);
  // Precise/boolean pass: trust Google's phrase match (the brand may be in the
  // article body, not the title — don't second-guess it).
  const out = [{ q: buildQuery(q), guard: false }];
  // Broad recall pass for plain multi-word brands: looser match, so we apply a
  // title relevance guard to keep coin/unrelated posts out.
  if (!hasOps && /\s/.test(q)) out.push({ q: `${q} ${QUERY_EXCLUSIONS}`, guard: true });
  const seen = new Set();
  return out.filter(v => !seen.has(v.q) && seen.add(v.q));
}
// Relevance guard for the broad pass: every significant word of a plain
// keyword must appear in the title, so "Shiba Inu (SHIB)" coin posts don't
// sneak in under a "Dr. Shiba" search. Explicit-boolean keywords are trusted.
function titleRelevant(title, kw) {
  const q = String(kw || '');
  if (/["()]|\bOR\b|\bAND\b/.test(q)) return true;
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  const words = q.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 1);
  if (!words.length) return true;
  return words.every(w => t.includes(w));
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
    persisted: REMOTE_ENABLED,
    staffEnabled: !!STAFF_PASS,
    published: store.published.length,
    hasLibrary: !!store.library,
    clients: store.clients.length,
    mentions: store.mentions.length,
    contacts: store.contacts.length,
    pitches: store.pitches.length,
    coverage: store.coverage.length,
    asana: !!asanaToken(),
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
// Ingest coverage found OUTSIDE the Google News sweep — e.g. a Cowork task that
// reads your Google Alerts (Google's WEB index catches Cloudflare-walled outlets
// like e27 that the News RSS can't), or a manual paste. Lands in the Newsroom
// "to review" queue, deduped by client+url. Body: one object or {mentions:[...]}.
app.post('/api/mentions', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.mentions) ? body.mentions : [body]);
  let added = 0; const out = [];
  for (const m of list) {
    const url = String(m.url || '').trim();
    if (!url && !m.title) continue;
    let client = m.clientId ? store.clients.find(c => c.id === m.clientId) : null;
    if (!client && m.clientName) client = store.clients.find(c => (c.name || '').toLowerCase() === String(m.clientName).toLowerCase());
    const clientId = client ? client.id : (m.clientId || '');
    const clientName = client ? client.name : (m.clientName || '');
    const key = (clientId || '*') + '|' + url;
    if (url && store.seen[key]) continue;        // already known — skip
    if (url) store.seen[key] = Date.now();
    let date = m.date || '';
    try { if (m.date) date = new Date(m.date).toISOString().slice(0, 10); } catch {}
    const mention = {
      id: Math.random().toString(36).slice(2, 10),
      clientId, clientName, keyword: m.keyword || '',
      title: m.title || '', url, outlet: m.outlet || '', author: m.author || '',
      date, source: m.source || 'alert', foundAt: new Date().toISOString(),
    };
    store.mentions.push(mention); out.push(mention); added++;
  }
  if (added) saveStore();
  res.json({ ok: true, added, mentions: out });
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

// ── Expenses (team-shared) — what the owner pays for monthly; staff log them ─
// NOT invoicing: invoices (client billing) stay owner-only. Expenses are the
// record of tools/subscriptions/reimbursements the owner covers for the team.
function upsertExpense(input) {
  if (!input || (!input.id && !input.item)) return null;
  let e = input.id ? store.expenses.find(x => x.id === input.id) : null;
  if (!e) {
    e = { id: input.id || ('e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), item: '', category: '', client: '', amount: 0, currency: 'PHP', recurring: 'monthly', date: '', status: 'pending', notes: '', loggedBy: '', createdAt: Date.now(), updatedAt: Date.now() };
    store.expenses.push(e);
  }
  for (const k of ['item', 'category', 'client', 'amount', 'currency', 'recurring', 'date', 'status', 'notes', 'loggedBy']) if (input[k] !== undefined) e[k] = input[k];
  e.amount = +e.amount || 0;
  e.updatedAt = Date.now();
  return e;
}
app.get('/api/expenses', requireAuth, (req, res) => { res.json({ expenses: store.expenses }); });
app.post('/api/expenses', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.expenses) ? body.expenses : [body]);
  const out = []; for (const item of list) { const e = upsertExpense(item); if (e) out.push(e); }
  saveStore();
  res.json({ ok: true, upserted: out.length, expenses: out });
});
app.delete('/api/expenses/:id', requireAuth, (req, res) => {
  const before = store.expenses.length;
  store.expenses = store.expenses.filter(e => e.id !== req.params.id);
  saveStore();
  res.json({ ok: true, removed: before - store.expenses.length });
});

// ── Opportunities (team-shared) — live, news-driven openings ────────
// collab targets, competitor counters, news tie-ins. Fed by the daily brief
// (source:'brief') or flagged manually. Sits above the seasonal calendar.
function upsertOpportunity(input) {
  if (!input || (!input.id && !input.title)) return null;
  let o = input.id ? store.opportunities.find(x => x.id === input.id) : null;
  // Re-runs daily/weekly — match an existing card (even a dismissed one) and update it in place; never duplicate, and a dismissed "no" stays dismissed unless a human reopens it.
  if (!o && input.title) o = store.opportunities.find(x => (x.title || '').toLowerCase().trim() === String(input.title).toLowerCase().trim() && (x.client || '') === (input.client || ''));
  if (!o) {
    o = { id: input.id || ('o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)), type: 'news', title: '', client: '', why: '', link: '', source: 'manual', status: 'open', date: '', owner: '', createdAt: Date.now(), updatedAt: Date.now() };
    store.opportunities.push(o);
  }
  for (const k of ['type', 'title', 'client', 'why', 'link', 'source', 'status', 'date', 'owner']) if (input[k] !== undefined) o[k] = input[k];
  o.updatedAt = Date.now();
  return o;
}
app.get('/api/opportunities', requireAuth, (req, res) => { res.json({ opportunities: store.opportunities }); });
app.post('/api/opportunities', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.opportunities) ? body.opportunities : [body]);
  const out = []; for (const item of list) { const o = upsertOpportunity(item); if (o) out.push(o); }
  saveStore();
  res.json({ ok: true, upserted: out.length, opportunities: out });
});
app.delete('/api/opportunities/:id', requireAuth, (req, res) => {
  const before = store.opportunities.length;
  store.opportunities = store.opportunities.filter(o => o.id !== req.params.id);
  saveStore();
  res.json({ ok: true, removed: before - store.opportunities.length });
});

// ── Auto-coverage: pieces the daily AI task files into monthly books ──
// A "monthly book" is not a stored object — it is all coverage for one client
// in one month, grouped by the app. The agent POSTs filed pieces here; the
// owner can edit or remove (remove suppresses the URL so it never re-files).
function monthOf(dateStr) {
  const t = Date.parse(dateStr || '');
  const d = t ? new Date(t) : new Date();
  return d.toISOString().slice(0, 7);   // "2026-05"
}
function coverageKey(clientId, url) { return (clientId || '') + '|' + (url || ''); }
const COV_NUM = ['domainAuthority', 'estimatedViews', 'reach', 'socialShares'];
function upsertCoverage(input) {
  if (!input || !input.url) return null;
  const clientId = input.clientId || '';
  const key = coverageKey(clientId, input.url);
  if (store.coverageSuppress[key]) return null;     // removed by owner → never re-file
  let c = store.coverage.find(x => coverageKey(x.clientId, x.url) === key);
  if (c) return c;                                   // already filed → never clobber an edit
  c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    clientId, clientName: input.clientName || '',
    month: input.month || monthOf(input.date),
    title: input.title || '', url: input.url,
    outlet: input.outlet || '', outletDomain: input.outletDomain || '',
    date: input.date || '',
    screenshot: input.screenshot || '',
    domainAuthority: +input.domainAuthority || 0,
    estimatedViews: +input.estimatedViews || 0,
    reach: +input.reach || 0,
    socialShares: +input.socialShares || 0,
    source: input.source === 'manual' ? 'manual' : 'auto',
    confidence: input.confidence === 'low' ? 'low' : 'high',
    edited: false,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  store.coverage.push(c);
  return c;
}
app.get('/api/coverage', requireAuth, (req, res) => {
  let out = store.coverage;
  const { client, month } = req.query;
  if (client) out = out.filter(c => c.clientId === client || (c.clientName || '').toLowerCase() === String(client).toLowerCase());
  if (month) out = out.filter(c => c.month === month);
  res.json({ coverage: out });
});
app.post('/api/coverage', requireAuth, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : (Array.isArray(body.coverage) ? body.coverage : [body]);
  const out = []; for (const item of list) { const c = upsertCoverage(item); if (c) out.push(c); }
  saveStore();
  res.json({ ok: true, upserted: out.length, coverage: out });
});
app.patch('/api/coverage/:id', requireAuth, (req, res) => {
  const c = store.coverage.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'not found' });
  const b = req.body || {};
  for (const k of ['title', 'outlet', 'outletDomain', 'screenshot', 'clientName', ...COV_NUM]) {
    if (b[k] !== undefined) c[k] = COV_NUM.includes(k) ? (+b[k] || 0) : b[k];
  }
  if (b.date !== undefined) { c.date = b.date; c.month = monthOf(b.date); }
  c.edited = true; c.updatedAt = Date.now();
  saveStore();
  res.json({ ok: true, coverage: c });
});
app.delete('/api/coverage/:id', requireAuth, (req, res) => {
  const c = store.coverage.find(x => x.id === req.params.id);
  const before = store.coverage.length;
  store.coverage = store.coverage.filter(x => x.id !== req.params.id);
  if (c) store.coverageSuppress[coverageKey(c.clientId, c.url)] = Date.now();  // never re-file
  saveStore();
  res.json({ ok: true, removed: before - store.coverage.length });
});

// ── Asana integration (live two-way) ───────────────────────────────
// Token: ASANA_TOKEN env var (durable across Render redeploys) OR an in-app
// paste stored in store.asanaToken. The in-app value wins so it can be updated
// without a redeploy; on the free tier store.asanaToken resets on redeploy, so
// the env var is the durable option. The token is owner-set and never returned.
const ASANA_TOKEN_ENV = process.env.ASANA_TOKEN || '';
const ASANA_BASE = 'https://app.asana.com/api/1.0';
function asanaToken() { return (store.asanaToken || ASANA_TOKEN_ENV || '').trim(); }
let _asanaWs = null;
let _asanaCache = { at: 0, tasks: null };

async function asanaApi(p, opts = {}) {
  const tok = asanaToken();
  if (!tok) { const e = new Error('Asana not connected'); e.code = 'not_connected'; throw e; }
  const headers = { Authorization: 'Bearer ' + tok, Accept: 'application/json', ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(ASANA_BASE + p, { method: opts.method || 'GET', headers, body: opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.errors && j.errors[0] && j.errors[0].message) || ('Asana error ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function asanaWorkspace() {
  if (_asanaWs) return _asanaWs;
  const me = await asanaApi('/users/me?opt_fields=workspaces.name');
  _asanaWs = me.data && me.data.workspaces && me.data.workspaces[0] && me.data.workspaces[0].gid;
  if (!_asanaWs) throw new Error('No Asana workspace found for this token');
  return _asanaWs;
}
// Best-effort client tag from a task's project names. Never invented —
// blank when no client keyword matches (those group under "Other / Ops").
function asanaClient(projNames) {
  const s = (projNames || []).join(' ').toLowerCase();
  // Dr. Shiba is the umbrella: Prof. Bengal (cats) + CEO Philipp Renner + CFO all roll up here.
  if (/shiba|prof\.? ?bengal|bengal|furpal|\bpal\b|oatside|sunnies|content360|magic mist|philipp renner|\brenner\b|gruenewald|tyger/.test(s)) return 'Dr. Shiba';
  if (/sicilian|frozen tiramisu|\broast\b|lorenzo vega|matt navarro|navarro/.test(s)) return 'Sicilian Roast';
  if (/seed inclusivity|seedstars|demo day|visa foundation|\beso\b|petanetra|karla|silang|sanad|elevateher|cohort/.test(s)) return 'Seedstars';
  return '';
}
function asanaTaskStatus(dueOn) {
  if (!dueOn) return 'none';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dueOn + 'T00:00:00');
  const days = Math.round((d - today) / 86400000);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'soon';
  return 'upcoming';
}
function mapAsanaTask(t) {
  const projects = (t.projects || []).map(p => p.name).filter(Boolean);
  return {
    gid: t.gid, name: t.name || '(untitled)', dueOn: t.due_on || '',
    completed: !!t.completed, projects, client: asanaClient(projects),
    url: t.permalink_url || ('https://app.asana.com/0/0/' + t.gid),
    status: asanaTaskStatus(t.due_on),
  };
}

app.get('/api/asana/status', requireAuth, (req, res) => {
  res.json({ connected: !!asanaToken(), source: store.asanaToken ? 'app' : (ASANA_TOKEN_ENV ? 'env' : null) });
});
// Owner pastes / clears the Personal Access Token. Validates by hitting Asana.
app.post('/api/asana/connect', requireOwner, async (req, res) => {
  const token = ((req.body && req.body.token) || '').trim();
  store.asanaToken = token; _asanaWs = null; _asanaCache = { at: 0, tasks: null };
  saveStore();
  if (!token) return res.json({ ok: true, connected: false });
  try { await asanaWorkspace(); res.json({ ok: true, connected: true }); }
  catch (e) { res.status(400).json({ ok: false, connected: false, error: e.message }); }
});
// Live read of the token owner's incomplete tasks (60s cache; ?fresh=1 bypasses).
app.get('/api/asana/tasks', requireAuth, async (req, res) => {
  if (!asanaToken()) return res.json({ connected: false, tasks: [] });
  try {
    if (req.query.fresh || !_asanaCache.tasks || (Date.now() - _asanaCache.at) > 60000) {
      const ws = await asanaWorkspace();
      const j = await asanaApi(`/tasks?assignee=me&workspace=${ws}&completed_since=now&limit=100&opt_fields=name,due_on,completed,projects.name,permalink_url`);
      _asanaCache = { at: Date.now(), tasks: (j.data || []).map(mapAsanaTask).filter(t => !t.completed) };
    }
    res.json({ connected: true, tasks: _asanaCache.tasks, cachedAt: _asanaCache.at });
  } catch (e) { res.status(502).json({ connected: true, tasks: [], error: e.message }); }
});
// Projects for the create-task picker.
app.get('/api/asana/projects', requireAuth, async (req, res) => {
  if (!asanaToken()) return res.json({ connected: false, projects: [] });
  try {
    const ws = await asanaWorkspace();
    const j = await asanaApi(`/projects?workspace=${ws}&archived=false&limit=100&opt_fields=name`);
    res.json({ connected: true, projects: (j.data || []).map(p => ({ gid: p.gid, name: p.name })) });
  } catch (e) { res.status(502).json({ connected: true, projects: [], error: e.message }); }
});
// Create a task (write-back from a pitch / opportunity / ad-hoc).
app.post('/api/asana/tasks', requireAuth, async (req, res) => {
  if (!asanaToken()) return res.status(400).json({ ok: false, error: 'Asana not connected' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ ok: false, error: 'Task name required' });
  try {
    const ws = await asanaWorkspace();
    const data = { name: String(b.name).trim(), assignee: b.assignee || 'me' };
    if (b.notes) data.notes = String(b.notes);
    if (b.dueOn) data.due_on = b.dueOn;
    // Asana errors if both projects + workspace are given — use one or the other.
    if (b.projectGid) data.projects = [b.projectGid]; else data.workspace = ws;
    const j = await asanaApi('/tasks?opt_fields=name,due_on,completed,projects.name,permalink_url', { method: 'POST', body: JSON.stringify({ data }) });
    _asanaCache = { at: 0, tasks: null };
    res.json({ ok: true, task: mapAsanaTask(j.data || {}) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
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
        for (const v of queryVariants(kw)) {
          const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(v.q)}&hl=en&gl=${NEWS_REGION}&ceid=${NEWS_REGION}:en`;
          try {
            const r = await fetch(rss, { headers: { 'User-Agent': UA } });
            const xml = await r.text();
            for (const it of parseRss(xml)) {
              if (!it.link) continue;
              if (isNoise(it.title)) continue;          // cut memecoin collision noise
              if (v.guard && !titleRelevant(it.title, kw)) continue; // broad pass only
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
    }
    // Byline harvest — enrich a few new, un-tried mentions per run (rate-limited
    // for Render CPU + Microlink's free quota). Builds the contacts DB for free.
    const _toEnrich = store.mentions.filter(m => !m.enrichTried && !m.author).slice(-8);
    for (const m of _toEnrich) { try { await enrichMention(m); } catch {} }
    if (_toEnrich.length) saveStore();
    // Drop any stored noise (crypto/coin collisions) + keep storage bounded.
    store.mentions = store.mentions.filter(m => !isNoise(m.title));
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

// Flush all mentions + dedupe memory, then re-sweep with the curated queries.
app.post('/api/mentions/clear', requireAuth, (req, res) => {
  store.mentions = []; store.seen = {};
  saveStore();
  res.json({ ok: true });
  sweep().catch(() => {});
});

(async () => {
  await loadStoreRemote();   // restore the durable copy before we start serving
  app.listen(PORT, () => {
    console.log(`Clippings backend listening on :${PORT}`);
    console.log(`  OpenPageRank: ${OPR_KEY ? 'configured' : 'not set'} · SimilarWeb: ${SIMILARWEB_KEY ? 'configured' : 'not set'}`);
    console.log(`  Monitoring every ${CHECK_MINUTES} min · region ${NEWS_REGION}`);
    console.log(`  Durable store: ${REMOTE_ENABLED ? STORE_REPO + ' (private repo)' : 'local file only'}`);
  });
  setInterval(() => { sweep().catch(() => {}); }, CHECK_MINUTES * 60 * 1000);
  setTimeout(() => { sweep().catch(() => {}); }, 3000);
})();
