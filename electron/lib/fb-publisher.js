// Facebook Graph API - page posting and insights

const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const GRAPH_API = 'graph.facebook.com';
const API_VERSION = 'v25.0';
const RESPONSE_TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DEFAULT_INSIGHTS_DAYS = 7;
const INSIGHTS_METRICS = [
  'page_media_view',
  'page_post_engagements',
  'page_follows',
];
const SNAPSHOT_METRICS = new Set(['page_follows']);

// NOTE (CEO 2026-06-14): the old 10-min global MIN_POST_INTERVAL throttle was
// removed. It ran INSIDE the synchronous /api/fb/post, so a post made within
// 10 min of the previous one blocked the HTTP response for ~10 min — far past
// the caller's timeout ("post just doesn't respond") — and it was GLOBAL, so it
// wrongly serialized DIFFERENT fanpages against one clock.
//
// Scale fix (2026-06-25): a single process-global queue also serialized 30-50
// different fanpages. Keep a bounded Facebook write pool instead: enough
// parallelism for many pages, still capped so Graph/API/network pressure is loud
// and predictable rather than an unbounded Promise.all storm.
const FB_WRITE_MAX_CONCURRENT = 5;
let _fbWriteActive = 0;
const _fbWriteWaiters = [];
const POST_QUEUE_TIMEOUT_MS = 15 * 60 * 1000;

// Recent-publish dedup. A retry (network blip, the agent or CEO re-asking) or a
// backlog of queued jobs for the SAME (page, caption, image) must NOT create
// duplicate Fanpage posts — this is what produced 4 identical posts on
// 2026-06-14. We fingerprint each post and remember its result for a short
// window; a second attempt within the window returns the SAME post instead of
// posting again. The check runs INSIDE the serialized _postQueue, so a later
// queued job sees an earlier one's result. In-process only (cleared on restart)
// — the duplicate window is minutes, so that's enough.
const _recentPosts = new Map(); // fingerprint -> { result, at }
const DEDUP_TTL_MS = 10 * 60 * 1000;

function _postFingerprint(pageId, message, imagePath) {
  return `${pageId || ''}|${String(message).replace(/\s+/g, ' ').trim()}|${imagePath || ''}`;
}
function _recentPost(fp) {
  const hit = _recentPosts.get(fp);
  if (hit && Date.now() - hit.at < DEDUP_TTL_MS) return hit.result;
  if (hit) _recentPosts.delete(fp);
  return null;
}
function _rememberPost(fp, result) {
  _recentPosts.set(fp, { result, at: Date.now() });
  if (_recentPosts.size > 100) {
    const now = Date.now();
    for (const [k, v] of _recentPosts) if (now - v.at > DEDUP_TTL_MS) _recentPosts.delete(k);
  }
}

function _acquireFbWriteSlot() {
  if (_fbWriteActive < FB_WRITE_MAX_CONCURRENT) { _fbWriteActive++; return Promise.resolve(); }
  return new Promise(resolve => _fbWriteWaiters.push(resolve));
}
function _releaseFbWriteSlot() {
  const next = _fbWriteWaiters.shift();
  if (next) next();
  else _fbWriteActive--;
}
async function _withFbWriteSlot(fn) {
  await _acquireFbWriteSlot();
  try {
    return await _withTimeout(Promise.resolve().then(fn), POST_QUEUE_TIMEOUT_MS);
  } finally {
    _releaseFbWriteSlot();
  }
}

// Scheduled-post dedup. The native schedule* functions (scheduleText/Photo/Video/Reel)
// create a post on FB in HELD state — it never appears in /feed until FB auto-publishes
// at the scheduled time. The live-post dedup (_recentPosts + getRecentPosts recovery)
// does NOT cover these because the post is invisible to Graph /feed queries until it
// goes live. A network drop AFTER FB accepted the create, or the agent/CEO retrying,
// therefore creates duplicate Planner entries with no way to detect the duplicate via
// the API. The in-memory fingerprint is the right guard: the duplication window is
// minutes; retries within that window hit the cached postId and never call FB again.
// Same TTL and structure as _recentPosts. Key: pageId|caption|scheduledTime|type.
const _scheduledPosts = new Map(); // fingerprint -> { result, at }
const _scheduledInFlight = new Map(); // fingerprint -> Promise<result>

function _schedFp(pageId, caption, ts, type, mediaId) {
  return `sched|${pageId || ''}|${String(caption == null ? '' : caption).replace(/\s+/g, ' ').trim()}|${ts || 0}|${type || 'text'}|${mediaId || ''}`;
}
function _mediaFp(value) {
  if (!value) return '';
  if (Buffer.isBuffer(value)) return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  return String(value);
}
function _recentSched(fp) {
  const hit = _scheduledPosts.get(fp);
  if (hit && Date.now() - hit.at < DEDUP_TTL_MS) return hit.result;
  if (hit) _scheduledPosts.delete(fp);
  return null;
}
function _rememberSched(fp, result) {
  _scheduledPosts.set(fp, { result, at: Date.now() });
  if (_scheduledPosts.size > 100) {
    const now = Date.now();
    for (const [k, v] of _scheduledPosts) if (now - v.at > DEDUP_TTL_MS) _scheduledPosts.delete(k);
  }
}
async function _dedupScheduled(fp, createFn) {
  const dup = _recentSched(fp);
  if (dup) return { ...dup, deduplicated: true };
  const inFlight = _scheduledInFlight.get(fp);
  if (inFlight) {
    const result = await inFlight;
    return { ...result, deduplicated: true };
  }
  const job = Promise.resolve().then(createFn);
  _scheduledInFlight.set(fp, job);
  try {
    const result = await job;
    _rememberSched(fp, result);
    return result;
  } finally {
    _scheduledInFlight.delete(fp);
  }
}

function _withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('post queue timeout')), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

async function graphRequest(method, endpoint, token, body) {
  try {
    return await _graphRequestOnce(method, endpoint, token, body);
  } catch (e) {
    // Auto-retry 5xx ONLY for idempotent GET. Retrying a POST (feed/photo) on a
    // 5xx is unsafe: Facebook may have ACCEPTED the write before returning 5xx →
    // the retry double-posts. POST callers handle their own verify-then-retry.
    if (method === 'GET' && e._httpStatus && e._httpStatus >= 500 && e._httpStatus < 600) {
      console.warn('[fb-publisher] Graph API 5xx (GET) - retrying in 3s:', e.message);
      await new Promise(r => setTimeout(r, 3000));
      return await _graphRequestOnce(method, endpoint, token, body);
    }
    throw e;
  }
}

function _parseJsonHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try { return JSON.parse(String(raw)); }
  catch { return null; }
}

function _header(headers, name) {
  if (!headers) return null;
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return v;
  }
  return null;
}

function _extractUsageHeaders(headers) {
  const app = _parseJsonHeader(_header(headers, 'x-app-usage'));
  const business = _parseJsonHeader(_header(headers, 'x-business-use-case-usage'));
  const out = {};
  if (app) out.app = app;
  if (business) out.business = business;
  return Object.keys(out).length ? out : null;
}

function _maxEstimatedRegainSec(value) {
  let max = 0;
  const stack = [value];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(cur, 'estimated_time_to_regain_access')) {
      const n = Number(cur.estimated_time_to_regain_access);
      if (Number.isFinite(n) && n > max) max = n;
    }
    if (Array.isArray(cur)) stack.push(...cur);
    else stack.push(...Object.values(cur));
  }
  return max;
}

function _decorateGraphError(err, fbError, res) {
  const code = Number(fbError && fbError.code);
  if (Number.isFinite(code)) err._fbErrorCode = code;
  const subcode = Number(fbError && fbError.error_subcode);
  if (Number.isFinite(subcode)) err._fbErrorSubcode = subcode;
  const usage = _extractUsageHeaders(res && res.headers);
  if (usage) {
    err._fbUsage = usage;
    const regain = _maxEstimatedRegainSec(usage);
    if (regain > 0) err._estimatedTimeToRegainAccessSec = regain;
  }
  if ([4, 17, 32, 613, 80001].includes(code)) {
    err._isRateLimited = true;
    if (code === 32 || code === 80001) err._rateLimitScope = 'page';
  }
  return err;
}

function _attachUsage(data, res) {
  const usage = _extractUsageHeaders(res && res.headers);
  if (usage && data && typeof data === 'object') data._fbUsage = usage;
  return data;
}

function _graphRequestOnce(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const url = `/${API_VERSION}${endpoint}`;
    const isPost = method === 'POST';
    const payload = isPost && body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: GRAPH_API, path: url, method, headers }, res => {
      let d = '';
      const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('response body timeout')); }, RESPONSE_TIMEOUT_MS);
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(bodyTimer);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            const err = new Error(parsed.error.message || 'Graph API error');
            err._httpStatus = res.statusCode;
            if (res.statusCode === 401 || parsed.error.code === 190 || /expired|invalid.*token/i.test(parsed.error.message || '')) {
              err._isTokenExpired = true;
            }
            return reject(_decorateGraphError(err, parsed.error, res));
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Graph API HTTP ${res.statusCode}`);
            err._httpStatus = res.statusCode;
            return reject(_decorateGraphError(err, null, res));
          }
          resolve(_attachUsage(parsed, res));
        } catch { reject(new Error('Invalid JSON from Graph API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('connect timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function detectMime(imagePath) {
  const ext = path.extname(imagePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function graphMultipartPhoto(pageId, token, message, imageBuffer, imagePath, extraFields = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----FBBoundary' + crypto.randomBytes(16).toString('hex');
    const safeMessage = String(message).replace(/\r/g, '');
    let body = '';
    body += `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${safeMessage}\r\n`;
    // Optional extra text fields (e.g. published=false + scheduled_publish_time for
    // native scheduling). Empty for the live-post path → byte-identical to before.
    for (const [k, v] of Object.entries(extraFields || {})) {
      body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v).replace(/\r/g, '')}\r\n`;
    }
    const mime = detectMime(imagePath);
    const ext = mime.split('/')[1] || 'png';
    body += `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="image.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const prefix = Buffer.from(body, 'utf-8');
    const suffix = Buffer.from(tail, 'utf-8');
    const payload = Buffer.concat([prefix, imageBuffer, suffix]);

    const req = https.request({
      hostname: GRAPH_API,
      path: `/${API_VERSION}/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    }, res => {
      let d = '';
      const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('response body timeout')); }, RESPONSE_TIMEOUT_MS);
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(bodyTimer);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            const err = new Error(parsed.error.message || 'Graph API photo upload error');
            err._httpStatus = res.statusCode;
            if (res.statusCode === 401 || parsed.error.code === 190 || /expired|invalid.*token/i.test(parsed.error.message || '')) {
              err._isTokenExpired = true;
            }
            return reject(_decorateGraphError(err, parsed.error, res));
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Graph API photo upload HTTP ${res.statusCode}`);
            err._httpStatus = res.statusCode;
            return reject(_decorateGraphError(err, null, res));
          }
          resolve(_attachUsage(parsed, res));
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('connect timeout')); });
    req.write(payload);
    req.end();
  });
}

function formatPostUrl(compoundId) {
  if (!compoundId) return null;
  const parts = String(compoundId).split('_');
  if (parts.length === 2) return `https://www.facebook.com/${parts[0]}/posts/${parts[1]}`;
  return `https://www.facebook.com/${compoundId}`;
}

function hasPageCreateContentTask(tasks) {
  if (!Array.isArray(tasks)) return true;
  return tasks.includes('CREATE_CONTENT') || tasks.includes('PROFILE_PLUS_CREATE_CONTENT');
}

function normalizePermissionName(permission) {
  if (!permission) return null;
  if (typeof permission === 'string') return permission;
  if (typeof permission !== 'object') return null;
  if (permission.status && permission.status !== 'granted') return null;
  return permission.permission || permission.name || null;
}

function hasNamedPermission(permissions, name) {
  if (!Array.isArray(permissions)) return false;
  return permissions.some(p => normalizePermissionName(p) === name);
}

function hasPageInsightsPermission(permissions) {
  return hasNamedPermission(permissions, 'read_insights') ||
    hasNamedPermission(permissions, 'pages_read_engagement');
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function unixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function metricValueToNumber(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, child) => {
      return typeof child === 'number' ? sum + child : sum;
    }, 0);
  }
  return 0;
}

function summarizeMetric(metricName, values, currentStartMs) {
  const daily = [];
  const previousDaily = [];
  for (const row of Array.isArray(values) ? values : []) {
    const n = metricValueToNumber(row && row.value);
    const endMs = Date.parse(row && row.end_time);
    if (Number.isFinite(endMs) && endMs > currentStartMs) daily.push(n);
    else previousDaily.push(n);
  }
  if (SNAPSHOT_METRICS.has(metricName)) {
    const latestCurrent = daily.length ? daily[daily.length - 1] : 0;
    const latestPrevious = previousDaily.length ? previousDaily[previousDaily.length - 1] : 0;
    return { current: latestCurrent, previous: latestPrevious, daily };
  }
  return {
    current: daily.reduce((sum, n) => sum + n, 0),
    previous: previousDaily.reduce((sum, n) => sum + n, 0),
    daily,
  };
}

function normalizeInsights(data, currentStartMs) {
  const out = {};
  for (const item of (data && data.data) || []) {
    if (!item || !item.name) continue;
    out[item.name] = summarizeMetric(item.name, item.values, currentStartMs);
  }
  return out;
}

async function fetchInsightMetric(pageId, token, metric, previousStart, until, currentStart) {
  const endpoint = `/${pageId}/insights?metric=${encodeURIComponent(metric)}` +
    `&period=day&since=${unixSeconds(previousStart)}&until=${unixSeconds(until)}`;
  const insights = await graphRequest('GET', endpoint, token);
  return normalizeInsights(insights, currentStart.getTime());
}

function addCompatibilityMetricAliases(metrics) {
  const out = { ...metrics };
  if (metrics.page_media_view) {
    out.page_views_total = metrics.page_media_view;
  }
  if (metrics.page_follows) {
    out.page_followers = metrics.page_follows;
  }
  return out;
}

function normalizePost(post) {
  if (!post || typeof post !== 'object') return null;
  return {
    id: post.id,
    message: post.message || '',
    created_time: post.created_time || null,
    full_picture: post.full_picture || null,
    likes: post.likes?.summary?.total_count || 0,
    comments: post.comments?.summary?.total_count || 0,
    shares: post.shares?.count || 0,
    url: post.permalink_url || formatPostUrl(post.id),
  };
}

async function getPagePermissions(pageId, token) {
  try {
    const data = await graphRequest('GET', `/${pageId}/permissions`, token);
    return data.data || [];
  } catch (e) {
    if (e._isTokenExpired) throw e;
    return [];
  }
}

async function getPageInfo(pageId, token, fallbackName) {
  try {
    const data = await graphRequest('GET', `/${pageId}?fields=id,name`, token);
    return { pageId: data.id || pageId, pageName: data.name || fallbackName || null };
  } catch (e) {
    if (e._isTokenExpired) throw e;
    return { pageId, pageName: fallbackName || null };
  }
}

// Page through ALL fanpages on /me/accounts. FB returns at most ~25 (default) /
// 100 (max) per response and hides the rest behind a cursor; without following it
// a CEO who manages many fanpages would silently only see the first batch. We use
// limit=100 + a bounded cursor walk (cap 20 rounds = 2000 pages — a safety stop,
// never a real customer ceiling). `fields` is passed through verbatim so callers
// keep their exact field set (incl. picture{url}).
async function fetchAllAccounts(token, fields) {
  const out = [];
  let after = '';
  for (let round = 0; round < 20; round++) {
    const q = `/me/accounts?fields=${fields}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    let resp;
    try {
      resp = await graphRequest('GET', q, token);
    } catch (e) {
      // Round 0 fail → propagate, so verifyToken's /me fallback (a PAGE token that
      // 4xx's on /me/accounts) still fires exactly as before. A LATER-round fail
      // (transient Graph error mid-walk) must NOT discard the pages already fetched
      // — return the partial set instead of failing the whole connect/verify.
      if (out.length === 0) throw e;
      console.warn(`[fb-publisher] fetchAllAccounts partial after round ${round}: ${e.message}`);
      break;
    }
    if (resp && Array.isArray(resp.data)) out.push(...resp.data);
    after = (resp && resp.paging && resp.paging.cursors && resp.paging.cursors.after) || '';
    const hasNext = !!(resp && resp.paging && resp.paging.next);
    if (!after || !hasNext || !resp.data || resp.data.length === 0) break;
  }
  return out;
}

// New Pages Experience (and business-portfolio) pages frequently return an EMPTY
// /me/accounts even though the user granted page permissions and a Page Access Token
// IS obtainable — which made verifyToken/connectToken wrongly report "no fanpage".
// Recover those pages from the token's granular scopes: debug_token lists the page
// ids the user opted in to (target_ids of pages_manage_posts), then fetch each page
// node directly for its name + page access token. The page node does NOT expose
// `tasks` (Graph #100), so callers pass tasks-free fields; the granted
// pages_manage_posts scope is the create-content signal (hasPageCreateContentTask
// treats absent tasks as allowed). Reuses graphRequest → inherits the app's API_VERSION.
async function fetchPagesViaScopes(userToken, fields) {
  let dbg;
  try {
    dbg = await graphRequest('GET', `/debug_token?input_token=${encodeURIComponent(userToken)}`, userToken);
  } catch (e) {
    if (e._isTokenExpired) throw e;
    console.warn(`[fb-publisher] debug_token failed: ${e.message}`);
    return [];
  }
  const scopes = (dbg && dbg.data && Array.isArray(dbg.data.granular_scopes)) ? dbg.data.granular_scopes : [];
  const pageIds = new Set();
  for (const s of scopes) {
    if (s && s.scope === 'pages_manage_posts' && Array.isArray(s.target_ids)) {
      for (const id of s.target_ids) pageIds.add(String(id));
    }
  }
  const out = [];
  for (const pageId of pageIds) {
    try {
      const p = await graphRequest('GET', `/${pageId}?fields=${fields}`, userToken);
      if (p && p.access_token) out.push(p);
    } catch (e) {
      if (e._isTokenExpired) throw e;
      console.warn(`[fb-publisher] scope-recovered page ${pageId} fetch failed: ${e.message}`);
    }
  }
  return out;
}

async function verifyToken(token) {
  if (!token || !String(token).trim()) {
    return { valid: false, error: 'Token Facebook trống.' };
  }
  const requiredMsg = 'Token cần là Page Access Token hoặc User Token có pages_show_list, pages_manage_posts, pages_read_engagement và Page task CREATE_CONTENT.';
  try {
    let accounts = await fetchAllAccounts(token, 'id,name,access_token,tasks');
    if (accounts.length === 0) {
      // New Pages Experience: /me/accounts empty though the user granted a page.
      accounts = await fetchPagesViaScopes(token, 'id,name,access_token');
    }
    if (accounts.length > 0) {
      const pages = accounts
        .filter(p => p && p.access_token && hasPageCreateContentTask(p.tasks))
        .map(p => ({ pageId: p.id, pageName: p.name, pageToken: p.access_token }));
      if (pages.length === 0) {
        return { valid: false, error: 'Không tìm thấy Fanpage có quyền tạo nội dung. ' + requiredMsg };
      }
      return { valid: true, pages };
    }
    return { valid: false, error: 'Không tìm thấy Fanpage nào. ' + requiredMsg };
  } catch (accountsErr) {
    try {
      const meData = await graphRequest('GET', '/me?fields=id,name,category', token);
      if (meData.id && meData.category !== undefined) {
        return { valid: true, pages: [{ pageId: meData.id, pageName: meData.name, pageToken: token }] };
      }
      return { valid: false, error: requiredMsg };
    } catch (pageErr) {
      return { valid: false, error: accountsErr.message || pageErr.message || requiredMsg };
    }
  }
}

async function connectToken(userToken) {
  const meResp = await graphRequest('GET', '/me?fields=name', userToken);
  let accounts = await fetchAllAccounts(userToken, 'id,name,access_token,tasks,category,picture{url}');
  if (accounts.length === 0) {
    // New Pages Experience: recover pages from the token's granular scopes.
    accounts = await fetchPagesViaScopes(userToken, 'id,name,access_token,category,picture{url}');
  }
  if (accounts.length === 0) {
    return { userName: meResp.name || 'Unknown', pages: [] };
  }
  const pages = accounts
    .filter(p => p && p.access_token && hasPageCreateContentTask(p.tasks))
    .map(p => ({
      pageId: p.id,
      pageName: p.name,
      pageAccessToken: p.access_token,
      category: p.category || null,
      avatarUrl: p.picture && p.picture.data ? p.picture.data.url : null,
    }));
  return { userName: meResp.name || 'Unknown', pages };
}

function resolvePageByName(query) {
  const { readFbConfig } = require('./workspace');
  const cfg = readFbConfig();
  if (!cfg || !cfg.pages || cfg.pages.length === 0) {
    return { page: null, reason: 'not_found' };
  }

  const q = query.trim().toLowerCase();
  const enabledPages = cfg.pages.filter(p => p.enabled);

  // 1. Exact shortName match (case-insensitive)
  const shortNameMatch = enabledPages.filter(p => p.shortName && p.shortName.toLowerCase() === q);
  if (shortNameMatch.length === 1) return { page: shortNameMatch[0], reason: 'found' };
  if (shortNameMatch.length > 1) return { page: null, matches: shortNameMatch, reason: 'ambiguous' };

  // 2. Substring pageName match (case-insensitive)
  const nameMatch = enabledPages.filter(p => p.pageName && p.pageName.toLowerCase().includes(q));
  if (nameMatch.length === 1) return { page: nameMatch[0], reason: 'found' };
  if (nameMatch.length > 1) return { page: null, matches: nameMatch, reason: 'ambiguous' };

  // 3. Check disabled pages for better error message
  const allPages = cfg.pages;
  const disabledMatch = allPages.filter(p => !p.enabled && (
    (p.shortName && p.shortName.toLowerCase() === q) ||
    (p.pageName && p.pageName.toLowerCase().includes(q))
  ));
  if (disabledMatch.length > 0) return { page: disabledMatch[0], reason: 'disabled' };

  return { page: null, reason: 'not_found' };
}

function listPages() {
  const { readFbConfig } = require('./workspace');
  const cfg = readFbConfig();
  if (!cfg || !cfg.pages) return [];
  return cfg.pages.map(p => ({
    id: p.id,
    pageId: p.pageId,
    pageName: p.pageName,
    shortName: p.shortName || null,
    enabled: p.enabled,
    tokenId: p.tokenId,
    tokenStatus: (!p.pageAccessToken || p.tokenExpired) ? (p.tokenExpired ? 'expired' : 'missing') : 'ok',
  }));
}

// On a POST error, FB may have ACCEPTED the write before failing (5xx/timeout) —
// graphRequest deliberately does NOT retry POSTs, so the caller would otherwise
// retry and DOUBLE-POST (the 2026-06-14 incident). Verify whether our post landed:
// exactly-one caption match in the time window → recover it (no duplicate, cache
// it so further retries dedup). null / ambiguous (verifyFailed) → return null so
// the caller throws; the skill then must NOT claim "đã đăng" without a post id.
async function _recoverPostAfterError(pageId, token, message, startedAt, fp) {
  const found = await findRecentPostByCaption(pageId, token, message, undefined, startedAt).catch(() => null);
  if (found && found.postId) {
    const result = { postId: found.postId, postUrl: found.postUrl || formatPostUrl(found.postId), recovered: true };
    _rememberPost(fp, result);
    console.warn('[fb-publisher] post errored but landed on FB — recovered existing post, not re-posting');
    return result;
  }
  return null;
}

function postText(pageId, token, message) {
  const fp = _postFingerprint(pageId, message, '');
  return _withFbWriteSlot(async () => {
    const dup = _recentPost(fp);
    if (dup) { console.warn('[fb-publisher] dedup: identical text post within window — returning existing post, not re-posting'); return { ...dup, deduplicated: true }; }
    const startedAt = Date.now();
    let data;
    try {
      data = await graphRequest('POST', `/${pageId}/feed`, token, { message });
    } catch (e) {
      const recovered = await _recoverPostAfterError(pageId, token, message, startedAt, fp);
      if (recovered) return recovered;
      throw e;
    }
    const result = { postId: data.id, postUrl: formatPostUrl(data.id) };
    _rememberPost(fp, result);
    return result;
  });
}

function postPhoto(pageId, token, message, imageBuffer, imagePath) {
  const fp = _postFingerprint(pageId, message, imagePath);
  return _withFbWriteSlot(async () => {
    const dup = _recentPost(fp);
    if (dup) { console.warn('[fb-publisher] dedup: identical photo post within window — returning existing post, not re-posting'); return { ...dup, deduplicated: true }; }
    const startedAt = Date.now();
    let data;
    try {
      data = await graphMultipartPhoto(pageId, token, message, imageBuffer, imagePath);
    } catch (e) {
      const recovered = await _recoverPostAfterError(pageId, token, message, startedAt, fp);
      if (recovered) return recovered;
      throw e;
    }
    const postId = data.post_id || data.id;
    const result = { postId, postUrl: formatPostUrl(postId) };
    _rememberPost(fp, result);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Video + Reels publishing (v2.4.15). Source is always a LOCAL file: FB cannot
// fetch a Google Drive share link, so postMediaFromDrive downloads the file to a
// temp path, STREAMS it up (fs.createReadStream — never readFileSync, so RAM stays
// flat regardless of size), then deletes the temp (finally). Single-request upload
// (no chunked/resumable): a mid-upload network drop fails loud and the CEO re-posts.
// Type is EXPLICIT — the app bundles no ffprobe, so it does not auto-detect
// orientation/duration; the caller says 'reel' (vertical short, /video_reels
// 3-phase) or 'video' (/videos). FB validates the actual format; we surface errors.
// ---------------------------------------------------------------------------
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // ~1GB — single-request upload ceiling
const VIDEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // ~1GB from Drive on a slow line
const VIDEO_RESPONSE_TIMEOUT_MS = 20 * 60 * 1000; // streaming a large file up takes minutes

function formatReelUrl(videoId) {
  return videoId ? `https://www.facebook.com/reel/${videoId}` : null;
}

// Shared response reader for the streaming uploads below.
function _readGraphRes(req, res, resolve, reject, { reelMode } = {}) {
  let d = '';
  const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('upload response timeout')); }, VIDEO_RESPONSE_TIMEOUT_MS);
  res.on('data', c => d += c);
  res.on('end', () => {
    clearTimeout(bodyTimer);
    let parsed = {}; try { parsed = JSON.parse(d); } catch { if (!reelMode) return reject(new Error('Invalid JSON from Graph API')); }
    if (parsed.error) {
      const err = new Error(parsed.error.message || 'Graph API error');
      err._httpStatus = res.statusCode;
      if (res.statusCode === 401 || parsed.error.code === 190) err._isTokenExpired = true;
      return reject(_decorateGraphError(err, parsed.error, res));
    }
    if (res.statusCode >= 400 || parsed.success === false) {
      const err = new Error(`upload HTTP ${res.statusCode}`);
      err._httpStatus = res.statusCode;
      return reject(_decorateGraphError(err, null, res));
    }
    resolve(_attachUsage(parsed, res));
  });
}

// Pipe a file stream into a request body, rejecting on file/request error.
function _pipeFile(req, filePath, reject, { head, tail } = {}) {
  req.on('error', reject);
  req.setTimeout(VIDEO_RESPONSE_TIMEOUT_MS, () => { req.destroy(); reject(new Error('upload timeout')); });
  const stream = fs.createReadStream(filePath);
  stream.on('error', e => { req.destroy(); reject(e); });
  if (head) req.write(head);
  if (tail) { stream.on('end', () => req.end(tail)); stream.pipe(req, { end: false }); }
  else stream.pipe(req);
}

// Streamed multipart POST of one text field + one file to a Graph edge.
// (graphMultipartPhoto predates this and is intentionally left untouched — it's a
// tested path and a hotfix shouldn't refactor it; the small overlap is accepted.)
function _graphMultipartStream(pageId, token, edge, textField, textValue, filePath, fileSize, filename, mime, extraFields = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----FBBoundary' + crypto.randomBytes(16).toString('hex');
    // Optional extra text fields (e.g. published=false + scheduled_publish_time).
    // Empty for the live-post path → head byte-identical to before; Content-Length
    // below is derived from head.length so it stays correct when fields are added.
    let extra = '';
    for (const [k, v] of Object.entries(extraFields || {})) {
      extra += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v).replace(/\r/g, '')}\r\n`;
    }
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${textField}"\r\n\r\n${String(textValue).replace(/\r/g, '')}\r\n` +
      extra +
      `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const req = https.request({
      hostname: GRAPH_API,
      path: `/${API_VERSION}/${pageId}/${edge}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + fileSize + tail.length,
      },
    }, res => _readGraphRes(req, res, resolve, reject));
    _pipeFile(req, filePath, reject, { head, tail });
  });
}

// Reels upload phase 2: stream the file as a raw binary body to the rupload URL
// from the start phase (a different host from graph.facebook.com).
function _uploadReelStream(uploadUrl, token, filePath, fileSize) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Authorization': `OAuth ${token}`,
        'offset': '0',
        'file_size': String(fileSize),
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
        'User-Agent': USER_AGENT,
      },
    }, res => _readGraphRes(req, res, resolve, reject, { reelMode: true }));
    _pipeFile(req, filePath, reject);
  });
}

// filePath = a local temp file; size from statSync. dedupKey = the stable Drive
// file id (NOT the temp path, which changes per call) so an agent/CEO retry within
// the window hits the in-process dedup, not a repost.
// After upload, FB processes video/reels ASYNCHRONOUSLY. The upload returning an
// id does NOT mean the post is live — clicking the link too early shows "video
// unavailable". Poll the real status so we return a link FB confirms works and
// only claim success when it's actually live. Returns FB's real permalink + state.
async function _verifyVideoLive(id, token, { tries = 6, delayMs = 5000 } = {}) {
  let last = { live: false, status: 'processing', permalink: null };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await graphRequest('GET', `/${id}?fields=permalink_url,status`, token);
      const vs = (r && r.status && r.status.video_status) || '';
      last = { live: vs === 'ready', status: vs || 'processing', permalink: r.permalink_url || null };
      if (vs === 'ready' || vs === 'error') return last;
    } catch { /* transient — keep polling */ }
    if (i < tries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return last; // still processing after the poll window — caller reports "processing"
}

function postVideo(pageId, token, caption, filePath, dedupKey) {
  const fp = _postFingerprint(pageId, caption, `video:${dedupKey || ''}`);
  return _withFbWriteSlot(async () => {
    const dup = _recentPost(fp);
    if (dup) { console.warn('[fb-publisher] dedup: identical video within window — returning existing, not re-posting'); return { ...dup, deduplicated: true }; }
    const fileSize = fs.statSync(filePath).size;
    const startedAt = Date.now();
    let data;
    try {
      data = await _graphMultipartStream(pageId, token, 'videos', 'description', caption, filePath, fileSize, 'video.mp4', 'video/mp4');
    } catch (e) {
      const recovered = await _recoverPostAfterError(pageId, token, caption, startedAt, fp);
      if (recovered) return recovered;
      throw e;
    }
    const id = data.id;
    const v = await _verifyVideoLive(id, token);
    const result = {
      postId: id,
      postUrl: v.permalink || (id ? `https://www.facebook.com/watch/?v=${id}` : null),
      kind: 'video', live: v.live, status: v.status,
    };
    _rememberPost(fp, result);
    return result;
  });
}

function postReel(pageId, token, caption, filePath, dedupKey) {
  const fp = _postFingerprint(pageId, caption, `reel:${dedupKey || ''}`);
  return _withFbWriteSlot(async () => {
    const dup = _recentPost(fp);
    if (dup) { console.warn('[fb-publisher] dedup: identical reel within window — returning existing, not re-posting'); return { ...dup, deduplicated: true }; }
    const fileSize = fs.statSync(filePath).size;
    // 3-phase: start → stream binary → finish/publish. graphRequest never
    // auto-retries POSTs, so a transient 5xx won't silently create a 2nd reel.
    // Residual: if finish() lands on FB but returns a network error, an agent
    // retry re-posts (reels don't reliably appear in getRecentPosts, so the
    // photo/text verify-recover can't catch it). In-process dedup covers the
    // common retry; the skill's CEO confirmation is the backstop. (Documented.)
    const start = await graphRequest('POST', `/${pageId}/video_reels`, token, { upload_phase: 'start' });
    const videoId = start.video_id;
    const uploadUrl = start.upload_url;
    if (!videoId || !uploadUrl) throw new Error('Reels start phase did not return video_id/upload_url');
    await _uploadReelStream(uploadUrl, token, filePath, fileSize);
    await graphRequest('POST', `/${pageId}/video_reels?video_id=${encodeURIComponent(videoId)}&upload_phase=finish&video_state=PUBLISHED&description=${encodeURIComponent(caption || '')}`, token);
    // Reel processes async on FB. Verify it actually goes live before reporting a
    // link (a landscape/invalid reel can fail here even though finish() returned ok).
    const v = await _verifyVideoLive(videoId, token);
    const result = {
      postId: videoId,
      postUrl: v.permalink || formatReelUrl(videoId),
      kind: 'reel', live: v.live, status: v.status,
    };
    _rememberPost(fp, result);
    return result;
  });
}

// Download a Drive file to a temp path, STREAM it up as reel|video, then ALWAYS
// delete the temp (finally), success or fail. No readFileSync — flat RAM.
async function postMediaFromDrive(pageId, token, caption, driveFileId, type = 'reel') {
  if (!driveFileId) throw new Error('driveFileId required');
  const kind = type === 'video' ? 'video' : 'reel';
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `9bizclaw-fb-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`);
  try {
    await require('./google-api').downloadFile(driveFileId, tmp, undefined, VIDEO_DOWNLOAD_TIMEOUT_MS);
    let size;
    try { size = fs.statSync(tmp).size; } catch { throw new Error('Drive download produced no file — check the file id and Google connection'); }
    if (!size) throw new Error('Drive file is empty');
    if (size > MAX_VIDEO_BYTES) {
      throw new Error(`Video ${(size / 1048576).toFixed(0)}MB exceeds the ${MAX_VIDEO_BYTES / 1048576}MB limit`);
    }
    return kind === 'reel'
      ? await postReel(pageId, token, caption, tmp, driveFileId)
      : await postVideo(pageId, token, caption, tmp, driveFileId);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// === Native FB scheduling (v2.4.16) ========================================
// published=false + scheduled_publish_time → FB itself holds the post and
// auto-publishes server-side (shows in Meta Business Suite "Planner"), so it goes
// out even if THIS app is off at post time — unlike the local-cron path. FB requires
// the time 10 min–30 days ahead. Video/reels still upload the bytes to FB now (the
// file MUST exist at schedule time); only the publish moment is deferred. These are
// deliberately NOT run through _postQueue (nothing goes live instantly → no
// double-post window) and NOT verify-recovered (a scheduled post is absent from
// /feed until it publishes, so getRecentPosts recovery cannot see it).
const SCHEDULE_MIN_LEAD_S = 10 * 60;           // FB rejects < 10 minutes ahead
const SCHEDULE_MAX_LEAD_S = 30 * 24 * 60 * 60; // Meta Page feed docs: max 30 days

// Accept a unix-seconds number (tolerating accidental ms) or an ISO/parseable date
// string; return validated unix seconds. Throws a CEO-readable VN message on a time
// FB would reject, so the bot never silently schedules into the past or too far out.
function normalizeScheduleTime(when) {
  let ts;
  if (typeof when === 'number' && Number.isFinite(when)) {
    ts = when > 1e12 ? Math.floor(when / 1000) : Math.floor(when);
  } else if (typeof when === 'string' && when.trim()) {
    const p = Date.parse(when.trim());
    if (!Number.isFinite(p)) throw new Error('Thời gian hẹn không hợp lệ (cần ISO date hoặc unix seconds)');
    ts = Math.floor(p / 1000);
  } else {
    throw new Error('Thiếu thời gian hẹn (scheduledPublishTime)');
  }
  const lead = ts - Math.floor(Date.now() / 1000);
  if (lead < SCHEDULE_MIN_LEAD_S) throw new Error('Facebook cần hẹn tối thiểu 10 phút sau hiện tại');
  if (lead > SCHEDULE_MAX_LEAD_S) throw new Error('Facebook chỉ cho hẹn tối đa khoảng 30 ngày');
  return ts;
}

// Schedule a text (optionally link) post → { postId, scheduled, scheduledPublishTime }.
async function scheduleText(pageId, token, message, when, link) {
  const ts = normalizeScheduleTime(when);
  const fp = _schedFp(pageId, message, ts, 'text', link ? `link:${link}` : '');
  return _dedupScheduled(fp, async () => {
    const body = { message: String(message == null ? '' : message), published: false, scheduled_publish_time: ts };
    if (link) body.link = String(link);
    const data = await graphRequest('POST', `/${pageId}/feed`, token, body);
    return { postId: data.id, scheduled: true, scheduledPublishTime: ts };
  });
}

// Schedule a photo post (imageBuffer/imagePath as in postPhoto).
async function schedulePhoto(pageId, token, message, imageBuffer, imagePath, when) {
  const ts = normalizeScheduleTime(when);
  const fp = _schedFp(pageId, message, ts, 'photo', imagePath || _mediaFp(imageBuffer));
  return _dedupScheduled(fp, async () => {
    const data = await graphMultipartPhoto(pageId, token, String(message == null ? '' : message), imageBuffer, imagePath,
      { published: 'false', scheduled_publish_time: String(ts) });
    const postId = data.post_id || data.id;
    return { postId, scheduled: true, scheduledPublishTime: ts };
  });
}

// Schedule a video — local file streamed to FB now; FB holds + publishes at time.
async function scheduleVideo(pageId, token, caption, filePath, when) {
  const ts = normalizeScheduleTime(when);
  const fp = _schedFp(pageId, caption, ts, 'video', filePath);
  return _dedupScheduled(fp, async () => {
    const fileSize = fs.statSync(filePath).size;
    if (!fileSize) throw new Error('File video rỗng');
    if (fileSize > MAX_VIDEO_BYTES) throw new Error(`Video vượt giới hạn ${MAX_VIDEO_BYTES / 1048576}MB`);
    const data = await _graphMultipartStream(pageId, token, 'videos', 'description', caption || '', filePath, fileSize, 'video.mp4', 'video/mp4',
      { published: 'false', scheduled_publish_time: String(ts) });
    return { postId: data.id, scheduled: true, scheduledPublishTime: ts, kind: 'video' };
  });
}

// Schedule a Reel — 3-phase upload, finish in SCHEDULED state. File streamed now.
async function scheduleReel(pageId, token, caption, filePath, when) {
  const ts = normalizeScheduleTime(when);
  const fp = _schedFp(pageId, caption, ts, 'reel', filePath);
  return _dedupScheduled(fp, async () => {
    const fileSize = fs.statSync(filePath).size;
    if (!fileSize) throw new Error('File reel rỗng');
    if (fileSize > MAX_VIDEO_BYTES) throw new Error(`Reel vượt giới hạn ${MAX_VIDEO_BYTES / 1048576}MB`);
    const start = await graphRequest('POST', `/${pageId}/video_reels`, token, { upload_phase: 'start' });
    const videoId = start.video_id;
    const uploadUrl = start.upload_url;
    if (!videoId || !uploadUrl) throw new Error('Reels start phase did not return video_id/upload_url');
    await _uploadReelStream(uploadUrl, token, filePath, fileSize);
    await graphRequest('POST',
      `/${pageId}/video_reels?video_id=${encodeURIComponent(videoId)}&upload_phase=finish&video_state=SCHEDULED&scheduled_publish_time=${ts}&description=${encodeURIComponent(caption || '')}`,
      token);
    return { postId: videoId, scheduled: true, scheduledPublishTime: ts, kind: 'reel' };
  });
}

// Schedule a Drive video/reel: validate the time, download to temp, schedule (bytes
// upload to FB now), then ALWAYS delete the temp. Mirrors postMediaFromDrive's flat-RAM
// lifecycle. Validate the time FIRST so an obviously-bad time fails before a slow download.
async function scheduleMediaFromDrive(pageId, token, caption, driveFileId, when, type = 'reel') {
  if (!driveFileId) throw new Error('driveFileId required');
  const ts = normalizeScheduleTime(when);
  const kind = type === 'video' ? 'video' : 'reel';
  const os = require('os');
  const tmp = path.join(os.tmpdir(), `9bizclaw-fb-sch-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`);
  try {
    await require('./google-api').downloadFile(driveFileId, tmp, undefined, VIDEO_DOWNLOAD_TIMEOUT_MS);
    let size;
    try { size = fs.statSync(tmp).size; } catch { throw new Error('Drive download produced no file — check the file id and Google connection'); }
    if (!size) throw new Error('Drive file is empty');
    if (size > MAX_VIDEO_BYTES) {
      throw new Error(`Video ${(size / 1048576).toFixed(0)}MB exceeds the ${MAX_VIDEO_BYTES / 1048576}MB limit`);
    }
    return kind === 'reel'
      ? await scheduleReel(pageId, token, caption, tmp, ts)
      : await scheduleVideo(pageId, token, caption, tmp, ts);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// List pending scheduled posts (Business Suite Planner content).
async function listScheduledPosts(pageId, token) {
  const fields = 'id,message,scheduled_publish_time,created_time';
  const data = await graphRequest('GET', `/${pageId}/scheduled_posts?fields=${encodeURIComponent(fields)}`, token);
  const rows = Array.isArray(data && data.data) ? data.data : [];
  return rows.map(p => ({
    postId: p.id,
    message: p.message || '',
    scheduledPublishTime: p.scheduled_publish_time || null,
    createdTime: p.created_time || null,
  }));
}

// Move a scheduled post to a new time. Cancel = delete the post id (existing /api/fb/delete).
async function rescheduleScheduledPost(token, postId, when) {
  const ts = normalizeScheduleTime(when);
  // postId is interpolated straight into the Graph path — validate it's a real FB post
  // id (numeric, or pageId_postId) so a crafted value can't redirect the POST to another
  // edge (e.g. "me/feed?message=...") even from a prompt-injected CEO turn.
  const id = String(postId);
  if (!/^\d+(_\d+)?$/.test(id)) throw new Error('postId không hợp lệ (phải là id số của bài đã lên lịch — lấy từ /api/fb/scheduled)');
  await graphRequest('POST', `/${encodeURIComponent(id)}`, token, { scheduled_publish_time: ts });
  return { postId: id, scheduled: true, scheduledPublishTime: ts };
}

async function getRecentPosts(pageId, token, limit = 5) {
  const safeLimit = clampInt(limit, 5, 1, 25);
  const fields = [
    'id',
    'message',
    'created_time',
    'full_picture',
    'permalink_url',
    'likes.summary(true)',
    'comments.summary(true)',
    'shares',
  ].join(',');
  const data = await graphRequest('GET',
    `/${pageId}/feed?fields=${encodeURIComponent(fields)}&limit=${safeLimit}`, token);
  return data.data || [];
}

// After an INDETERMINATE post error (timeout/5xx where FB may have accepted the
// write), check whether a post with this caption already landed — so we recover the
// real post instead of blindly retrying and double-posting. The hard problem is
// telling OUR post apart from a reused template caption on an earlier/other post:
//   1. TIME is the decisive signal. When the caller threads `sendStartedAt` (captured
//      before the publish POST), our post — if it landed — was created in
//      [sendStartedAt − 60s skew, sendStartedAt + max publish latency]. Bounding on
//      sendStartedAt (NOT `now`) means a slow publish stall (recovery running minutes
//      later) still recovers our own post, while a post created outside that window
//      (an earlier schedule, or an unrelated later post) is excluded.
//   2. CAPTION confirms identity: normalized exact, OR a SUBSTANTIAL containment match
//      (one string is a substring of the other, the shorter is ≥12 chars AND ≥50% of
//      the longer) — tolerates FB whitespace/edge normalization without matching a
//      short reused-template prefix of a longer caption.
//   3. AMBIGUITY fails closed: if >1 post matches in the window we cannot tell which is
//      ours, so return a verify-failed sentinel (caller will not blind-retry).
//   4. WITHOUT a timestamp gate we fall back to STRICT matching (exact, or ≥80-char
//      prefix for long captions) within `withinMs`, to avoid recovering a reused caption.
// NOTE: FB returns `message` ~verbatim (whitespace aside); it does not strip leading
// emoji / truncate to a few chars, so those theoretical mutations are out of scope.
const PUBLISH_MAX_LATENCY_MS = 15 * 60 * 1000; // FB post-queue timeout ceiling
async function findRecentPostByCaption(pageId, token, caption, withinMs = 3 * 60 * 1000, sendStartedAt = null) {
  try {
    const capNorm = String(caption || '').replace(/\s+/g, ' ').trim();
    if (capNorm.length < 8) return null; // too short to match reliably
    const minPrefix = Math.min(capNorm.length, 80);
    const capKey = capNorm.slice(0, minPrefix);
    const gated = typeof sendStartedAt === 'number' && Number.isFinite(sendStartedAt);
    const minCreatedMs = gated ? sendStartedAt - 60 * 1000 : null;
    const maxCreatedMs = gated ? sendStartedAt + PUBLISH_MAX_LATENCY_MS : null;
    const posts = await getRecentPosts(pageId, token, 5);
    const now = Date.now();
    const matches = [];
    for (const p of posts) {
      const msg = String(p.message || '').replace(/\s+/g, ' ').trim();
      const t = Date.parse(p.created_time || '');
      // gated → created in [sendStartedAt−skew, sendStartedAt+maxLatency] (bounded on
      // sendStartedAt so a slow stall still recovers our own post and a later unrelated
      // post is excluded); ungated → within `withinMs` of now.
      const inWindow = gated
        ? (Number.isFinite(t) && t >= minCreatedMs && t <= maxCreatedMs)
        : (!withinMs || (Number.isFinite(t) && (now - t) < withinMs));
      if (!inWindow || !msg) continue;
      let captionMatch;
      if (gated) {
        const shorter = msg.length <= capNorm.length ? msg : capNorm;
        const longer = msg.length <= capNorm.length ? capNorm : msg;
        captionMatch = msg === capNorm ||
          (longer.includes(shorter) && shorter.length >= 12 && shorter.length * 2 >= longer.length);
      } else {
        captionMatch = msg === capNorm || (capNorm.length >= 80 && msg.slice(0, minPrefix) === capKey);
      }
      if (captionMatch) {
        matches.push({ postId: p.id, postUrl: p.permalink_url || formatPostUrl(p.id) });
      }
    }
    // Exactly one match → recover it. >1 → ambiguous (e.g. an external post reused the
    // template caption inside our window) → fail closed: do NOT record a possibly-wrong
    // URL and do NOT let the caller blind-retry. The caller marks it for the CEO.
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      console.warn(`[fb-publisher] findRecentPostByCaption: ${matches.length} posts match this caption in window — ambiguous, not recovering`);
      return { verifyFailed: true };
    }
  } catch (e) {
    // getRecentPosts threw — we could NOT determine whether the post landed.
    // Return a distinct sentinel so the caller does NOT treat this as "not found"
    // and blind-retry (which would double-post if FB had actually accepted it).
    console.warn('[fb-publisher] findRecentPostByCaption verify failed:', e?.message);
    return { verifyFailed: true };
  }
  return null;
}

async function getInsights(pageId, token, opts = {}) {
  if (!pageId) return { valid: false, tokenValid: false, error: 'pageId required' };
  if (!token || !String(token).trim()) {
    return { valid: false, tokenValid: false, error: 'Facebook token missing' };
  }

  const days = clampInt(opts.days, DEFAULT_INSIGHTS_DAYS, 1, 90);
  const recentLimit = clampInt(opts.limit, 5, 1, 10);
  const until = opts.until instanceof Date ? opts.until : new Date();
  const currentStart = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const previousStart = new Date(currentStart.getTime() - days * 24 * 60 * 60 * 1000);

  const pageInfo = await getPageInfo(pageId, token, opts.pageName);
  const permissions = await getPagePermissions(pageId, token);
  const permissionSummary = {
    read_insights: hasNamedPermission(permissions, 'read_insights'),
    pages_read_engagement: hasNamedPermission(permissions, 'pages_read_engagement'),
  };

  let metrics = {};
  let insightsError = null;
  const metricErrors = {};
  for (const metric of INSIGHTS_METRICS) {
    try {
      Object.assign(metrics, await fetchInsightMetric(pageId, token, metric, previousStart, until, currentStart));
    } catch (e) {
      if (e._isTokenExpired) throw e;
      metricErrors[metric] = e.message || 'Facebook insights unavailable';
    }
  }
  metrics = addCompatibilityMetricAliases(metrics);
  if (Object.keys(metricErrors).length === INSIGHTS_METRICS.length) {
    insightsError = Object.values(metricErrors)[0] || 'Facebook insights unavailable';
  }

  let recentPosts = [];
  try {
    recentPosts = (await getRecentPosts(pageId, token, recentLimit)).map(normalizePost).filter(Boolean);
  } catch (e) {
    if (e._isTokenExpired) throw e;
  }

  const metricValues = Object.values(metrics);
  const hasMetricRows = metricValues.some(metric => metric && metric.daily && metric.daily.length > 0);
  const hasMetricData = metricValues.some(metric => {
    return metric && (metric.current !== 0 || metric.previous !== 0 || (metric.daily && metric.daily.length > 0));
  });

  return {
    valid: true,
    tokenValid: true,
    tokenName: pageInfo.pageName,
    pageName: pageInfo.pageName,
    pageId: pageInfo.pageId,
    since: isoDate(currentStart),
    until: isoDate(until),
    days,
    hasInsights: hasMetricData,
    hasInsightsPermission: hasPageInsightsPermission(permissions) || hasMetricRows,
    permissions: permissionSummary,
    metrics,
    metricErrors,
    recentPosts,
    insightsError,
  };
}

// Resolve whatever the caller passes (compound "<pageId>_<postId>", a bare numeric
// post id, or a full facebook.com/.../posts/<id> URL) to FB's deletable id
// "<pageId>_<postId>". Falls through unchanged if it can't parse — FB will validate.
function _resolveDeletableId(pageId, ref) {
  const s = String(ref || '').trim();
  if (/^\d+_\d+$/.test(s)) return s;                 // already compound
  if (/^\d+$/.test(s)) return pageId ? `${pageId}_${s}` : s; // bare post id
  // A full feed URL carries BOTH ids: use the URL's OWN page id, never re-pair the
  // post id onto a different (CEO-named) page — a mismatch must not silently target
  // another page's post. If the URL's page ≠ this page, FB rejects (safe).
  let m = s.match(/(\d{6,})\/posts\/(\d+)/);
  if (m) return `${m[1]}_${m[2]}`;
  // Other shapes carry only the post/story id → pair with the resolved page.
  m = s.match(/story_fbid=(\d+)/) || s.match(/\/(?:permalink|photos|videos)\/(?:[^/]*\/)?(\d+)/);
  if (m && pageId) return `${pageId}_${m[1]}`;
  return s; // can't parse confidently → pass through, let FB validate
}

// Delete a Fanpage post. FB Graph: DELETE /<pageId>_<postId> with the page token
// returns { success: true }. Used to clean up duplicate/wrong posts.
async function deletePost(pageId, token, postRef) {
  const id = _resolveDeletableId(pageId, postRef);
  const data = await graphRequest('DELETE', `/${id}`, token);
  return { success: data.success !== false, id };
}

// Edit the TEXT of an existing Fanpage post. FB Graph: POST /<pageId>_<postId>
// with { message } + page token. ONLY the message/caption is editable — the
// image/video/attachments of a published post CANNOT be changed via the API
// (to swap media you must delete + re-post). Some post types (shared/linked
// stories, certain media) reject the edit; FB validates and we surface its error.
// No dedup/queue: editing is idempotent (re-applying the same text is harmless).
async function editPost(pageId, token, postRef, message) {
  const id = _resolveDeletableId(pageId, postRef);
  const data = await graphRequest('POST', `/${id}`, token, { message: String(message == null ? '' : message) });
  return { success: data.success !== false, id, postUrl: formatPostUrl(id) };
}

module.exports = {
  scheduleText, schedulePhoto, scheduleVideo, scheduleReel, scheduleMediaFromDrive,
  listScheduledPosts, rescheduleScheduledPost, normalizeScheduleTime,
  verifyToken,
  connectToken,
  resolvePageByName,
  listPages,
  postText,
  postPhoto,
  postVideo,
  postReel,
  postMediaFromDrive,
  deletePost,
  editPost,
  getRecentPosts,
  findRecentPostByCaption,
  getInsights,
  _test: { hasPageCreateContentTask, hasPageInsightsPermission, insightsMetrics: INSIGHTS_METRICS, _resolveDeletableId, formatReelUrl },
};
