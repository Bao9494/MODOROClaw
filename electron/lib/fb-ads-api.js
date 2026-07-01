'use strict';
// fb-ads-api.js — Meta Marketing API wrapper for the FB Ads backend.
//
// Transport only. All money math + ad-copy screening lives in fb-ads-policy.js;
// callers pass budgets that already went through vndToApiAmount/clamp. Mirrors
// fb-publisher.js's https/error shape (same host, same v25.0, same _isTokenExpired)
// so every FB caller handles errors uniformly.
//
// TWO differences from fb-publisher, both deliberate:
//   1. Marketing API write endpoints take FORM-URLENCODED params (nested objects
//      like targeting / object_story_spec are JSON-stringified field values), not
//      a JSON body. That's the canonical, version-stable Marketing API contract.
//   2. SPEND IS GATED IN CODE, not by an LLM rule. createCampaign/createAdSet/
//      createAd FORCE status:'PAUSED' and ignore any caller-supplied status, so a
//      buggy or jailbroken caller still cannot create a spending object. The only
//      path to ACTIVE is setStatus(...,'ACTIVE',{confirm:true}); without confirm
//      it throws. The cron-api activate endpoint supplies confirm only after the
//      CEO consumes an approval nonce — there is no autoMode bypass.

const https = require('https');
const { screenAdCopy } = require('./fb-ads-policy');

const GRAPH_API = 'graph.facebook.com';
const API_VERSION = 'v25.0'; // matches fb-publisher.js
const RESPONSE_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

// ODAX objectives (v25). Reject anything else loudly — a typo'd objective is a
// 400 from Graph with a cryptic message; failing here names the real problem.
const VALID_OBJECTIVES = new Set([
  'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_SALES',
  'OUTCOME_LEADS', 'OUTCOME_AWARENESS', 'OUTCOME_APP_PROMOTION',
]);

const INSIGHTS_FIELDS = 'spend,impressions,reach,clicks,cpc,cpm,ctr,actions,cost_per_action_type,date_start,date_stop';

// ─── transport ──────────────────────────────────────────────────

function _encodeForm(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
  }
  return parts.join('&');
}

function _request(method, endpoint, token, params) {
  return new Promise((resolve, reject) => {
    let reqPath = `/${API_VERSION}${endpoint}`;
    const isWrite = method === 'POST';
    let payload = null;
    if (isWrite) {
      payload = _encodeForm(params); // empty string is fine
    } else if (params && Object.keys(params).length) {
      const qs = _encodeForm(params);
      if (qs) reqPath += (reqPath.includes('?') ? '&' : '?') + qs;
    }
    const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': USER_AGENT };
    if (isWrite) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: GRAPH_API, path: reqPath, method, headers }, res => {
      let d = '';
      const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('response body timeout')); }, RESPONSE_TIMEOUT_MS);
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(bodyTimer);
        try {
          const parsed = d ? JSON.parse(d) : {};
          if (parsed.error) {
            const e = parsed.error;
            const err = new Error(e.error_user_msg || e.message || 'Marketing API error');
            err._httpStatus = res.statusCode;
            err._fbCode = e.code;
            err._fbSubcode = e.error_subcode;
            err._fbUserMsg = e.error_user_msg || e.error_user_title || null;
            if (res.statusCode === 401 || e.code === 190 || /expired|invalid.*token/i.test(e.message || '')) {
              err._isTokenExpired = true;
            }
            if (e.code === 200 || e.code === 10 || e.code === 272 || /permission|ads_management|ads_read/i.test(e.message || '')) {
              err._isPermission = true;
            }
            // Graph rate-limit codes: 17 = rate limit, 32 = page-rate limit,
            // 613 = custom tier limit. CEO sees a clear retry message, not a
            // cryptic "Marketing API error".
            if (e.code === 17 || e.code === 32 || e.code === 613) {
              err._isRateLimit = true;
            }
            return reject(err);
          }
          if (res.statusCode >= 400) {
            const err = new Error(`Marketing API HTTP ${res.statusCode}`);
            err._httpStatus = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        } catch { reject(new Error('Invalid JSON from Marketing API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => { req.destroy(); reject(new Error('connect timeout')); });
    if (isWrite) req.write(payload);
    req.end();
  });
}

// Retry 5xx ONLY for idempotent GET — same rule as fb-publisher: retrying a POST
// can double-create an object FB already accepted before its 5xx.
async function request(method, endpoint, token, params) {
  try {
    return await _request(method, endpoint, token, params);
  } catch (e) {
    if (method === 'GET' && e._httpStatus >= 500 && e._httpStatus < 600) {
      await new Promise(r => setTimeout(r, 2000));
      return await _request(method, endpoint, token, params);
    }
    throw e;
  }
}

function normalizeActId(actId) {
  const s = String(actId || '').trim();
  if (!s) throw new Error('Thiếu ad account id');
  return s.startsWith('act_') ? s : `act_${s.replace(/^act_?/, '')}`;
}

function _assertBudgetMinor(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Ngân sách (minor unit) phải là số nguyên dương — đã qua vndToApiAmount chưa?');
  }
}

// special_ad_categories MUST reach Graph as an array (e.g. ['HOUSING']). A GET query
// delivers it as a comma string ("HOUSING"); left as-is, _encodeForm would send the
// bare JSON string "HOUSING" and Graph 400s. Normalize so every caller is safe.
function _normCategories(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === 'string') return x.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return [];
}

// ─── read ───────────────────────────────────────────────────────

async function verifyAdsToken(token) {
  // /me first: identity works for every token type, and a 401/expired here is the
  // cleanest signal — it must propagate (the expired-token contract), so it is NOT
  // wrapped below.
  const me = await request('GET', '/me', token, { fields: 'id,name' });

  // Scope detection is token-type dependent:
  //  - User/OAuth tokens expose granted scopes at /me/permissions.
  //  - System User tokens (the PERMANENT production token in the BYO-token model)
  //    return empty/erroring permissions — their scopes live at the business-asset
  //    level — so NEVER hard-fail on this. Fall back to a capability probe: a token
  //    that can list ad accounts can at least READ ads; per-account `tasks` (present
  //    on Business-owned accounts) reveal MANAGE/ADVERTISE = can create/spend.
  let granted = new Set();
  try {
    const perms = await request('GET', '/me/permissions', token, {});
    granted = new Set((perms.data || []).filter(p => p.status === 'granted').map(p => p.permission));
  } catch { /* System User / asset token — rely on the capability probe below */ }

  let accounts = [];
  try {
    const r = await request('GET', '/me/adaccounts', token, { fields: 'id,tasks', limit: 50 });
    accounts = r.data || [];
  } catch { /* no ad-account visibility — leave empty (reported as not-ok) */ }
  const tasks = new Set(accounts.flatMap(a => a.tasks || []));

  const hasAdsManagement = granted.has('ads_management') || tasks.has('MANAGE') || tasks.has('ADVERTISE');
  const hasAdsRead = hasAdsManagement || granted.has('ads_read') || accounts.length > 0;
  return {
    ok: hasAdsManagement || hasAdsRead,
    userId: me.id,
    userName: me.name,
    hasAdsManagement,                  // can CREATE/spend
    hasAdsRead,                        // enough to READ only
    adAccountCount: accounts.length,
    scopes: [...granted],
  };
}

async function getAdAccounts(token) {
  const r = await request('GET', '/me/adaccounts', token, {
    fields: 'id,account_id,name,currency,account_status,min_daily_budget,amount_spent,balance,disable_reason',
    limit: 50,
  });
  return (r.data || []).map(a => ({
    id: a.id,                       // act_<id> — pass this everywhere
    accountId: a.account_id,
    name: a.name,
    currency: a.currency,
    status: a.account_status,       // 1 = active, 2 = disabled, 3 = unsettled ...
    minDailyBudget: Number(a.min_daily_budget) || 0, // minor unit; for VND = đồng
    amountSpent: a.amount_spent,
    balance: a.balance,
    disableReason: a.disable_reason,
  }));
}

async function getAccountInfo(token, actId) {
  const id = normalizeActId(actId);
  const a = await request('GET', `/${id}`, token, {
    fields: 'id,account_id,name,currency,account_status,min_daily_budget,amount_spent,balance,disable_reason,timezone_name',
  });
  return {
    id: a.id, accountId: a.account_id, name: a.name, currency: a.currency,
    status: a.account_status, minDailyBudget: Number(a.min_daily_budget) || 0,
    amountSpent: a.amount_spent, balance: a.balance, disableReason: a.disable_reason,
    timezone: a.timezone_name,
  };
}

async function listCampaigns(token, actId) {
  const id = normalizeActId(actId);
  const r = await request('GET', `/${id}/campaigns`, token, {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,start_time,stop_time',
    limit: 100,
  });
  return r.data || [];
}

async function listAdSets(token, campaignId) {
  const r = await request('GET', `/${campaignId}/adsets`, token, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting',
    limit: 100,
  });
  return r.data || [];
}

async function getInsights(token, objectId, opts = {}) {
  const params = { fields: opts.fields || INSIGHTS_FIELDS };
  if (opts.datePreset) params.date_preset = opts.datePreset; // e.g. 'last_7d', 'today'
  else if (opts.since && opts.until) params.time_range = { since: opts.since, until: opts.until };
  else params.date_preset = 'last_7d';
  if (opts.level) params.level = opts.level; // 'campaign' | 'adset' | 'ad'
  const r = await request('GET', `/${objectId}/insights`, token, params);
  // Single aggregate row for the period — we request no time_increment/breakdown, so
  // Graph returns one row (a snapshot, not a per-day series). {} when no data yet.
  return (r.data && r.data[0]) || {};
}

// Meta interest/behavior search → the IDs the agent plugs into a targeting
// flexible_spec. Targeting takes IDs, not names, so "thời trang" must be resolved to
// an interest id here first. kind: 'interest' (default) or 'behavior'.
async function searchTargeting(token, query, kind = 'interest') {
  const params = { q: String(query || ''), limit: 25, locale: 'vi_VN' };
  if (kind === 'behavior') { params.type = 'adTargetingCategory'; params.class = 'behaviors'; }
  else { params.type = 'adinterest'; }
  const r = await request('GET', '/search', token, params);
  return (r.data || []).map((x) => ({
    id: x.id,
    name: x.name,
    audienceSize: x.audience_size_lower_bound || x.audience_size || null,
    path: Array.isArray(x.path) ? x.path.join(' > ') : (x.path || null),
  }));
}

// ─── write (every create is PAUSED-first; status param is IGNORED) ──────────

async function createCampaign(token, actId, opts = {}) {
  const id = normalizeActId(actId);
  const objective = String(opts.objective || '').toUpperCase();
  if (!VALID_OBJECTIVES.has(objective)) {
    throw new Error(`Objective không hợp lệ: "${opts.objective}". Dùng một trong: ${[...VALID_OBJECTIVES].join(', ')}`);
  }
  const params = {
    name: opts.name || 'Chiến dịch mới',
    objective,
    status: 'PAUSED',                 // HARD: never created spending
    special_ad_categories: _normCategories(opts.specialAdCategories), // ALWAYS an array
    buying_type: 'AUCTION',
    // Newer Graph requires an explicit true/false here on non-CBO campaigns or it
    // 400s (subcode 4834011, "is_adset_budget_sharing_enabled True/False"). false =
    // each ad set keeps its own budget (our default; CBO sets daily_budget below).
    is_adset_budget_sharing_enabled: false,
  };
  // Campaign Budget Optimization (CBO): budget at campaign level. Optional —
  // omit to budget at the ad-set level instead.
  if (opts.dailyBudgetMinor != null) {
    _assertBudgetMinor(opts.dailyBudgetMinor);
    params.daily_budget = opts.dailyBudgetMinor;
    params.bid_strategy = opts.bidStrategy || 'LOWEST_COST_WITHOUT_CAP';
  }
  const r = await request('POST', `/${id}/campaigns`, token, params);
  return { id: r.id, status: 'PAUSED' };
}

async function createAdSet(token, actId, opts = {}) {
  const id = normalizeActId(actId);
  if (!opts.campaignId) throw new Error('createAdSet thiếu campaignId');
  if (!opts.targeting) throw new Error('createAdSet thiếu targeting');
  // Meta now REQUIRES targeting.targeting_automation.advantage_audience as an explicit
  // 0/1 on ad-set create, else 400 (subcode 1870227, "cần cờ đối tượng Advantage").
  // Default 0 = OFF → the ad set runs the EXACT audience the caller built (no silent
  // Advantage+ expansion); opts.advantageAudience===true opts in. Live-account-only:
  // the mock Graph never demanded it, so it surfaces only against the real API.
  const targeting = { ...opts.targeting };
  if (!targeting.targeting_automation || targeting.targeting_automation.advantage_audience == null) {
    targeting.targeting_automation = {
      ...(targeting.targeting_automation || {}),
      advantage_audience: opts.advantageAudience === true ? 1 : 0,
    };
  }
  const params = {
    name: opts.name || 'Nhóm quảng cáo',
    campaign_id: opts.campaignId,
    status: 'PAUSED',                 // HARD
    billing_event: opts.billingEvent || 'IMPRESSIONS',
    optimization_goal: opts.optimizationGoal || 'REACH',
    bid_strategy: opts.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    targeting,                        // object → JSON-stringified by _encodeForm
  };
  // Ad-set budget only when the campaign is NOT CBO. Caller passes exactly one.
  if (opts.dailyBudgetMinor != null) {
    _assertBudgetMinor(opts.dailyBudgetMinor);
    params.daily_budget = opts.dailyBudgetMinor;
  }
  if (opts.promotedObject) params.promoted_object = opts.promotedObject;
  if (opts.startTime) params.start_time = opts.startTime;
  if (opts.endTime) params.end_time = opts.endTime;
  const r = await request('POST', `/${id}/adsets`, token, params);
  return { id: r.id, status: 'PAUSED' };
}

async function createAdCreative(token, actId, opts = {}) {
  const id = normalizeActId(actId);
  // Final code-level backstop: screen any ad text BEFORE it reaches Graph. The
  // endpoint screens too (to message the CEO early); this catches a direct caller.
  const text = [opts.message, opts.name].filter(Boolean).join(' ');
  if (text) {
    const scr = screenAdCopy(text);
    if (scr.red.length) {
      const err = new Error(`Nội dung quảng cáo có từ ngữ bị Facebook cấm: ${scr.red.join(', ')}`);
      err._policyRed = scr.red;
      throw err;
    }
  }
  const params = { name: opts.name || 'Creative' };
  if (opts.objectStorySpec) {
    params.object_story_spec = opts.objectStorySpec;
  } else if (opts.objectStoryId) {
    // Promote an EXISTING organic page post (the safest, most common VN action —
    // the post already passed review and performed organically).
    params.object_story_id = opts.objectStoryId;
  } else {
    throw new Error('createAdCreative cần objectStorySpec hoặc objectStoryId');
  }
  const r = await request('POST', `/${id}/adcreatives`, token, params);
  return { id: r.id };
}

async function createAd(token, actId, opts = {}) {
  const id = normalizeActId(actId);
  if (!opts.adsetId) throw new Error('createAd thiếu adsetId');
  if (!opts.creativeId) throw new Error('createAd thiếu creativeId');
  const r = await request('POST', `/${id}/ads`, token, {
    name: opts.name || 'Quảng cáo',
    adset_id: opts.adsetId,
    creative: { creative_id: opts.creativeId },
    status: 'PAUSED',                 // HARD
  });
  return { id: r.id, status: 'PAUSED' };
}

// Run the full promote-a-post funnel (campaign → adset → creative → ad), all PAUSED.
// On any mid-step failure, best-effort delete the campaign (Marketing API cascades the
// adset + ad) so no untracked PAUSED orphan stays in the live account, then rethrow with
// `._partial` = the ids created so far (caller surfaces them for manual cleanup). The
// caller prepares each step's opts (policy/budget/targeting); this only orchestrates +
// rolls back, so the one branch that could leave a live orphan is unit-testable.
async function runCreateFunnel(token, actId, opts = {}) {
  const created = { status: 'PAUSED' };
  try {
    const camp = await createCampaign(token, actId, opts.campaign || {});
    created.campaignId = camp.id;
    const adset = await createAdSet(token, actId, { ...(opts.adset || {}), campaignId: camp.id });
    created.adsetId = adset.id;
    const creative = await createAdCreative(token, actId, opts.creative || {});
    created.creativeId = creative.id;
    const ad = await createAd(token, actId, { ...(opts.ad || {}), adsetId: adset.id, creativeId: creative.id });
    created.adId = ad.id;
    return created;
  } catch (e) {
    // Roll back so no untracked object lingers in the live account. Deleting the campaign
    // cascades its adset + ad — but an adcreative is ACCOUNT-scoped (not cascaded), so if
    // step 4 (createAd) failed after the creative was made, delete the creative too.
    if (created.creativeId) {
      try { await deleteObject(token, created.creativeId); } catch { created.rollbackFailed = true; }
    }
    if (created.campaignId) {
      try { await deleteObject(token, created.campaignId); created.rolledBack = true; }
      catch { created.rollbackFailed = true; }
    }
    e._partial = created;
    throw e;
  }
}

async function updateDailyBudget(token, objectId, dailyBudgetMinor) {
  _assertBudgetMinor(dailyBudgetMinor);
  await request('POST', `/${objectId}`, token, { daily_budget: dailyBudgetMinor });
  return { success: true, id: objectId, daily_budget: dailyBudgetMinor };
}

// The ONE spend gate. PAUSED/ARCHIVED/DELETED are always allowed (they STOP
// spend). Flipping to ACTIVE is the only money-spending action in this module and
// requires opts.confirm === true — the cron-api activate endpoint sets that only
// after the CEO consumes an approval nonce. No autoMode, no default.
// Deletion goes through deleteObject() (HTTP DELETE), NOT a status flip — DELETED is
// intentionally absent so setStatus can't be misused for it (wrong verb for this API).
const STATUSES = new Set(['ACTIVE', 'PAUSED', 'ARCHIVED']);
async function setStatus(token, objectId, status, opts = {}) {
  const s = String(status || '').toUpperCase();
  if (!STATUSES.has(s)) throw new Error(`Status không hợp lệ: ${status}`);
  if (s === 'ACTIVE' && opts.confirm !== true) {
    const err = new Error('Bật ACTIVE = bắt đầu tiêu tiền — cần xác nhận của CEO (confirm).');
    err._needsConfirm = true;
    throw err;
  }
  await request('POST', `/${objectId}`, token, { status: s });
  return { success: true, id: objectId, status: s };
}

async function deleteObject(token, objectId) {
  await request('DELETE', `/${objectId}`, token, null);
  return { success: true, id: objectId };
}

module.exports = {
  verifyAdsToken, getAdAccounts, getAccountInfo,
  listCampaigns, listAdSets, getInsights, searchTargeting,
  createCampaign, createAdSet, createAdCreative, createAd, runCreateFunnel,
  updateDailyBudget, setStatus, deleteObject,
  normalizeActId, VALID_OBJECTIVES,
  _test: { _encodeForm, _request, request },
};
