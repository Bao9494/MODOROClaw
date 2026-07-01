'use strict';
// aivideoauto-v2.js — Gommo Jobs gateway (v2.api.gommo.net) media engine.
//
// One concern: own a job map (mirrors aivideoauto.js's idiom), talk to the v2 Jobs
// gateway, and expose the SAME export surface as the legacy engine so it is drop-in
// for cron-api.js — PLUS the new capabilities the raw host could not do: motion
// (TikTok dance character-swap), avatar-lipsync, edit, extend, multi-shots, omni.
//
// WHY a separate module (not an edit of aivideoauto.js): the legacy engine is a
// battle-tested money path with many live-verified quirks. This v2 engine is selected
// behind a flag (AIVIDEOAUTO_ENGINE=v2) and stays dormant until live-verified on real
// credit; legacy remains the default + rollback. Cutover = flip the flag.
//
// CONTRACT vs legacy: same exported names/signatures, same creds = {token, domain},
// same {jobId, retryStatusUrl} returns, same terminal statuses (done /
// done-download-failed / error), same onComplete({status, file?/downloadUrl?/error?})
// fired once from the poller. Reuses url-guard.js (SSRF + download) UNCHANGED.
//
// CONFIRM-LIVE (gateway specifics not verifiable without credit — see
// docs/aivideoauto-v2-gateway-migration.md §10): exact data.status strings, whether
// motion needs image_url AND images[0][url], multipart field plumbing, whether a v2
// balance/voices endpoint exists (we fall back to the legacy account host for those).
//
// ANTI-FEATURES: no workspace/safeStorage reads (creds come from the route layer); no
// new npm deps (Node built-ins + url-guard.js only); no ffmpeg here (concat/voiceover
// stay in ffmpeg-concat.js via the API layer).

const fs = require('fs');
const path = require('path');
const https = require('https');

const _urlGuard = require('./url-guard');
const { isAllowedResultUrl, hostResolvesPrivate, extFor, download } = _urlGuard;

// TTS/voices/music are NOT v2 Jobs-gateway features — their working contract lives on the
// legacy account host. We delegate those to the proven legacy engine (lazy require: no cycle,
// legacy never requires this module). Music jobs created via delegation live in the legacy
// engine's job map, so getJobStatus/retryDownload fall back to it for ids we don't own.
const _legacy = () => require('./aivideoauto');

const HOST_V2 = 'v2.api.gommo.net';        // Jobs gateway (Worker/reverse proxy)
const HOST_LEGACY = 'api.gommo.net';       // account host — balance/voices fallback only
const AV_DOMAIN = 'aivideoauto.com';       // whitelisted domain; hardcoded per gateway docs
const PROJECT_ID = 'default';              // gateway default; no persisted project_id today

const RESP_TIMEOUT_MS = 600000;
const CONNECT_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36';

const UNSAFE_MODE_RE = /spicy|crazy|nsfw|18\+|adult/i;
const URL_LAG_MAX_RETRIES = 5;

// Job map — keys = jobId. job shape: {jobId, kind, media, providerId, status,
// onComplete, creds, startedAt, downloadUrl?, file?, error?, _urlLagRetries, _timer}
const _jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 50;

function _inFlight(j) { return j.status === 'processing'; }

function _pruneJobs() {
  if (_jobs.size <= MAX_JOBS) return;
  const now = Date.now();
  for (const [id, j] of _jobs) {
    if (!_inFlight(j) && now - j.startedAt > JOB_TTL_MS) _jobs.delete(id);
  }
  const terminal = [..._jobs.entries()]
    .filter(([, j]) => !_inFlight(j))
    .sort((a, b) => a[1].startedAt - b[1].startedAt);
  while (_jobs.size > MAX_JOBS && terminal.length) _jobs.delete(terminal.shift()[0]);
}

let _outputsOverride = null;
function _outputsDir() {
  if (_outputsOverride) return _outputsOverride;
  try {
    const ws = require('./workspace').getWorkspace();
    const d = path.join(ws, 'outputs');
    fs.mkdirSync(d, { recursive: true });
    return d;
  } catch {
    const d = path.join(process.cwd(), 'outputs');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

let _pollMs = 5000;

// Opt-in diagnostic for the FIRST live runs (AIVIDEOAUTO_DEBUG=1). Logs job shape only —
// NEVER creds/token. Silent by default so the money path stays quiet in production.
function _dlog(...a) { if (process.env.AIVIDEOAUTO_DEBUG) { try { console.error('[aivideoauto-v2]', ...a); } catch {} } }

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Encode params as application/x-www-form-urlencoded; JSON-stringify nested objects.
// Bracket keys (images[0][url], multi_prompt[0][prompt]) are passed through as-is —
// they carry their own structure and must NOT be JSON-stringified.
function _form(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
  }
  return parts.join('&');
}

function _parseEnvelope(raw, httpStatus) {
  // v2 gateway wraps everything as {success, data, raw, message}. Reject on
  // success===false (read message) or any HTTP >= 400. Tag token-invalid for 401.
  let j;
  try { j = raw ? JSON.parse(raw) : {}; } catch { const e = new Error('Invalid JSON from v2 gateway'); throw e; }
  if (j && j.success === false) {
    const e = new Error(j.message || 'Gommo v2 error');
    e._gommo = j; e._httpStatus = httpStatus;
    if (httpStatus === 401 || /token|unauthor/i.test(j.message || '')) e._isTokenInvalid = true;
    throw e;
  }
  if (httpStatus >= 400) {
    const e = new Error(`Gommo v2 HTTP ${httpStatus}`);
    e._httpStatus = httpStatus;
    if (httpStatus === 401) e._isTokenInvalid = true;
    throw e;
  }
  return j;
}

// POST form-urlencoded to the v2 gateway with Bearer auth + domain/project_id merged
// into the body (the gateway reads domain from the body; Bearer is the preferred auth).
function _postV2(endpoint, creds, params) {
  return new Promise((resolve, reject) => {
    const payload = _form({ ...params, domain: AV_DOMAIN, project_id: PROJECT_ID, access_token: creds.token });
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': 'Bearer ' + creds.token,
      'User-Agent': UA,
    };
    const req = https.request({ hostname: HOST_V2, path: endpoint, method: 'POST', headers }, res => {
      let d = '';
      const t = setTimeout(() => { req.destroy(); reject(new Error('response timeout')); }, RESP_TIMEOUT_MS);
      res.on('data', c => (d += c));
      res.on('end', () => {
        clearTimeout(t);
        try { resolve(_parseEnvelope(d, res.statusCode)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => { req.destroy(); reject(new Error('connect timeout')); });
    req.write(payload); req.end();
  });
}

// Multipart POST to the v2 gateway (uploads). fileField: 'file' (image) | 'video_file'.
function _ctypeFor(fileName) {
  const ext = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
  return map[ext] || 'application/octet-stream';
}

function _postMultipartV2(endpoint, creds, fileField, fileName, buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----avb' + Date.now() + Math.random().toString(36).slice(2);
    const fields = { domain: AV_DOMAIN, project_id: PROJECT_ID, access_token: creds.token };
    const head = [];
    for (const [k, v] of Object.entries(fields)) {
      head.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    head.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
      `Content-Type: ${_ctypeFor(fileName)}\r\n\r\n`));
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([...head, buffer, tail]);
    const headers = {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': payload.length,
      'Authorization': 'Bearer ' + creds.token,
      'User-Agent': UA,
    };
    const req = https.request({ hostname: HOST_V2, path: endpoint, method: 'POST', headers }, res => {
      let d = '';
      const t = setTimeout(() => { req.destroy(); reject(new Error('response timeout')); }, RESP_TIMEOUT_MS);
      res.on('data', c => (d += c));
      res.on('end', () => { clearTimeout(t); try { resolve(_parseEnvelope(d, res.statusCode)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => { req.destroy(); reject(new Error('connect timeout')); });
    req.write(payload); req.end();
  });
}

// Legacy account host (api.gommo.net) — used ONLY for balance/voices, which have no
// documented v2 endpoint yet. Same token works (account-level). access_token+domain in
// body, parses the legacy {error,message} envelope. CONFIRM-LIVE: replace with v2
// endpoints if the gateway exposes them.
function _postLegacy(endpoint, creds, params) {
  return new Promise((resolve, reject) => {
    const payload = _form({ ...params, access_token: creds.token, domain: creds.domain || AV_DOMAIN });
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': UA,
    };
    const req = https.request({ hostname: HOST_LEGACY, path: endpoint, method: 'POST', headers }, res => {
      let d = '';
      const t = setTimeout(() => { req.destroy(); reject(new Error('response timeout')); }, RESP_TIMEOUT_MS);
      res.on('data', c => (d += c));
      res.on('end', () => {
        clearTimeout(t);
        try {
          const j = d ? JSON.parse(d) : {};
          if (j && j.error && j.error !== 0) {
            const e = new Error(j.message || 'Gommo API error');
            e._gommo = j; e._httpStatus = res.statusCode;
            if (res.statusCode === 401 || /access_token/i.test(j.message || '')) e._isTokenInvalid = true;
            return reject(e);
          }
          if (res.statusCode >= 400) { const e = new Error(`Gommo HTTP ${res.statusCode}`); e._httpStatus = res.statusCode; return reject(e); }
          resolve(j);
        } catch { reject(new Error('Invalid JSON from Gommo API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => { req.destroy(); reject(new Error('connect timeout')); });
    req.write(payload); req.end();
  });
}

// ---------------------------------------------------------------------------
// verify — Account Info (legacy account host; v2 has no documented /me yet)
// ---------------------------------------------------------------------------

async function verify(creds) {
  const r = await _postLegacy('/api/apps/go-mmo/ai/me', creds, {});
  const b = r.balancesInfo || {};
  return {
    ok: true,
    userName: (r.userInfo || {}).name || null,
    credits: b.credits_ai ?? null,
    currency: b.currency || null,
  };
}

// ---------------------------------------------------------------------------
// listModels — v2 catalog (/ai/models), normalize + filter NSFW
// ---------------------------------------------------------------------------

async function listModels(creds, type = 'video') {
  const r = await _postV2('/ai/models', creds, { type });
  // v2 wraps the list in data; tolerate data being the array or {models:[...]}.
  const list = Array.isArray(r.data) ? r.data : (Array.isArray(r.data && r.data.models) ? r.data.models : (r.data || []));
  const _modesOf = (m) => (m.modes || m.mode || []);
  return list
    .filter(m => !_modesOf(m).some(x => UNSAFE_MODE_RE.test(`${x.type || ''} ${x.name || ''} ${x.description || ''}`)))
    .map(m => ({
      id: m.model,
      name: m.name,
      description: m.description || '',
      server: m.server,
      price: m.price ?? null,
      prices: Array.isArray(m.prices) ? m.prices : [],
      caps: {
        startText: !!m.startText,
        startImage: !!m.startImage,
        startImageAndEnd: !!m.startImageAndEnd,
        withReference: !!m.withReference,
        withLipsync: !!m.withLipsync,
        withMotion: !!m.withMotion,        // V5 motion / dance driving
        withReplace: !!m.withReplace,      // performer replace
        withMultiShots: !!m.withMultiShots,
        withEdit: !!m.withEdit,
        extendVideo: !!m.extendVideo,
      },
      configs: m.configs || null,          // V9 omni reference config (allowedTypes, limits)
      ratios: (m.ratios || []).map(x => x.type),
      resolutions: (m.resolutions || []).map(x => x.type),
      durations: (m.durations || []).map(x => x.type),
      modes: _modesOf(m).map(x => x.type),
    }));
}

// ---------------------------------------------------------------------------
// Catalog validation — anti-hallucination guard (copied idiom from legacy)
// ---------------------------------------------------------------------------

const _modelCache = new Map();
const MODEL_CACHE_MS = 60000;
const CATALOG_FETCH_TIMEOUT_MS = 10000;

async function _modelsFor(creds, type) {
  const hit = _modelCache.get(type);
  if (hit && (Date.now() - hit.at) < MODEL_CACHE_MS) return hit.list;
  let timer;
  const list = await Promise.race([
    listModels(creds, type),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('catalog fetch timeout')), CATALOG_FETCH_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  _modelCache.set(type, { at: Date.now(), list });
  return list;
}

function _assertOpt(name, val, allowed, model) {
  if (val == null || val === '') return;
  if (!Array.isArray(allowed) || !allowed.length) return;
  if (!allowed.map(String).includes(String(val))) {
    const e = new Error(`${name}="${val}" không hợp lệ cho model "${model}". Hợp lệ: ${allowed.join(', ')}`);
    e._badOpt = true; throw e;
  }
}

async function _catalogEntry(creds, type, model) {
  let catalog;
  try { catalog = await _modelsFor(creds, type); } catch { return null; }
  if (!Array.isArray(catalog) || !catalog.length) return null;
  const entry = catalog.find(m => m.id === model);
  if (!entry) {
    const e = new Error(`Model "${model}" không tồn tại cho loại ${type}. Model hợp lệ: ${catalog.map(m => m.id).join(', ')}`);
    e._badModel = true; throw e;
  }
  return entry;
}

// Preflight a job's model + options against the LIVE catalog (anti-hallucination guard —
// a documented PRESERVE invariant). Refuses a hallucinated model id / invalid option
// HERE with the real list, before any gateway spend. Fail-open (returns null) only when
// the catalog itself is unreachable. EVERY credit-spending builder must call this.
async function _preflight(creds, type, model, { ratio, resolution, duration, mode } = {}) {
  const entry = await _catalogEntry(creds, type, model);
  if (entry) {
    _assertOpt('ratio', ratio, entry.ratios, model);
    _assertOpt('resolution', resolution, entry.resolutions, model);
    _assertOpt('duration', duration, entry.durations, model);
    _assertOpt('mode', mode, entry.modes, model);
  }
  return entry;
}

// Names of the cheaper/standard quality tier — preferred when a mode is auto-filled so a
// FORGOTTEN mode never silently bills the premium tier (CEO 2026-06-19: forget → standard,
// hero pieces go professional only when the bot/skill asks for it explicitly).
const _ECONOMICAL_MODES = ['standard', 'std', 'basic', 'normal', 'draft', 'lite', 'economy'];

// Some video models REQUIRE their options (live: kling_video_motion_3 rejects with
// "truyền đầy đủ các options của model" if ratio/mode are omitted). When the caller leaves
// an option blank AND the catalog lists valid values, fill it so a job never hard-fails on
// a missing option. Caller's explicit value ALWAYS wins; empty catalog lists fill nothing.
// ratio/resolution/duration → catalog[0] (the gateway default). mode → the economical tier
// if the catalog offers one, else catalog[0] (motion modes are listed premium-first).
function _effectiveOpts(entry, { ratio, resolution, duration, mode } = {}) {
  const pick = (v, list) => (v != null && v !== '') ? v : (Array.isArray(list) && list.length ? list[0] : undefined);
  if (!entry) return { ratio, resolution, duration, mode };
  const pickMode = () => {
    if (mode != null && mode !== '') return mode;
    const list = entry.modes;
    if (!Array.isArray(list) || !list.length) return undefined;
    return list.find(m => _ECONOMICAL_MODES.includes(String(m).toLowerCase())) || list[0];
  };
  return {
    ratio: pick(ratio, entry.ratios),
    resolution: pick(resolution, entry.resolutions),
    duration: pick(duration, entry.durations),
    mode: pickMode(),
  };
}

// Pick a caller-provided IMAGE option when it is valid for the model; else coerce to
// the catalog default (list[0]). Keeps start-frame quality (respects a valid 'high'/
// '2k') while never sending a value Gommo would reject (error 600). Catalog
// unreachable (empty list) → pass the caller value through unchanged.
function _pickValidImageOpt(v, list) {
  if (Array.isArray(list) && list.length) return list.includes(v) ? v : list[0];
  return (v != null && v !== '') ? v : undefined;
}

// ---------------------------------------------------------------------------
// uploadImage / uploadVideo — multipart, return hosted URL
// ---------------------------------------------------------------------------

function _uploadUrlFrom(r) {
  // Tolerate envelope shapes: data.url | data.result_url | data.imageInfo.url | url.
  const d = r.data || {};
  return d.url || d.result_url || (d.imageInfo || {}).url || (d.videoInfo || {}).url || r.url || null;
}

async function uploadImage(creds, { base64, fileName }) {
  const data = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(data, 'base64');
  const r = await _postMultipartV2('/ai/upload/image', creds, 'file', fileName || 'image.png', buf);
  return _uploadUrlFrom(r);
}

async function uploadVideo(creds, { base64, fileName }) {
  const data = String(base64).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(data, 'base64');
  const r = await _postMultipartV2('/ai/upload/video', creds, 'video_file', fileName || 'video.mp4', buf);
  return _uploadUrlFrom(r);
}

// ---------------------------------------------------------------------------
// Generation — generic job runner + per-capability builders
// ---------------------------------------------------------------------------

function _generateJobId() {
  return 'av_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// Status token sets. The live gateway emits COMPOUND statuses (observed: "PENDING_ACTIVE"),
// so we tokenize on non-letters and match whole tokens — NOT substrings, NOT whole-string.
// Substring matching is unsafe ("ABANDONED" contains "DONE"); whole-string matching misses
// compounds ("PENDING_ACTIVE" → would slow-fail to the 40-min cap). Token sets fix both.
const _ST_ERR = new Set(['FAILED', 'FAIL', 'ERROR', 'ERRORED', 'CANCELLED', 'CANCELED', 'REJECTED', 'ABANDONED', 'EXPIRED', 'TIMEOUT', 'DEAD']);
const _ST_OK = new Set(['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'DONE', 'COMPLETED', 'COMPLETE', 'FINISHED']);
const _ST_PROC = new Set(['PROCESSING', 'PROGRESS', 'PENDING', 'QUEUED', 'ACTIVE', 'RUNNING', 'STARTED', 'CREATED', 'WAITING', 'INIT']);

// v2 gateway returns a status string in data.status; result_url presence = terminal success.
function _mapV2Status(s, hasUrl) {
  const toks = String(s || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const has = (set) => toks.some(t => set.has(t));
  if (has(_ST_ERR)) return 'error';          // fail-first: a dead job never reads as done
  if (has(_ST_OK)) return 'successful';
  if (has(_ST_PROC)) return 'processing';
  if (hasUrl) return 'successful';           // terminal-with-url, unknown status string
  return 'processing';
}

async function _downloadResult(job, url) {
  if (!isAllowedResultUrl(url)) { const e = new Error('result URL ngoài danh sách cho phép'); e._ssrf = true; throw e; }
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (await hostResolvesPrivate(hostname)) { const e = new Error('result URL trỏ vào địa chỉ nội bộ (chặn SSRF)'); e._ssrf = true; throw e; }
  const kindForExt = job.kind === 'music' ? 'audio' : (job.media === 'image' ? 'image' : (job.kind === 'image' ? 'image' : 'video'));
  const ext = extFor(url, kindForExt);
  const dest = path.join(_outputsDir(), `aivideoauto-${job.jobId}${ext}`);
  return download(url, dest);
}

function _finalizeJob(job, status, extras) {
  if (job.status !== 'processing') return;
  job.status = status;
  if (extras) Object.assign(job, extras);
  job._timer = null;
  try { job.onComplete && job.onComplete({ status, ...extras }); } catch {}
}

// Background poller — self-rescheduling setTimeout (no setInterval: prevents overlapping
// ticks double-downloading + double-firing onComplete). Polls the unified v2 status
// endpoint /ai/jobs/{id}?media={media}.
function _startPoller(jobId, creds, { maxMs = 2400000 } = {}) {
  const startedAt = Date.now();

  async function tick() {
    const job = _jobs.get(jobId);
    if (!job || job.status !== 'processing') return;
    if (Date.now() - startedAt > maxMs) { _finalizeJob(job, 'error', { error: 'timeout' }); return; }

    try {
      const r = await _postV2(`/ai/jobs/${encodeURIComponent(job.providerId)}?media=${job.media}`, creds, {});
      const d = r.data || {};
      const url = d.result_url || null;
      const internalStatus = _mapV2Status(d.status, !!url);

      if (internalStatus === 'error') { _finalizeJob(job, 'error', { error: d.message || r.message || d.status || 'failed' }); return; }

      if (internalStatus === 'successful') {
        if (!url) {
          job._urlLagRetries = (job._urlLagRetries || 0) + 1;
          if (job._urlLagRetries > URL_LAG_MAX_RETRIES) { _finalizeJob(job, 'done-download-failed'); return; }
          // fall through to reschedule
        } else {
          job.downloadUrl = url;
          let file;
          try { file = await _downloadResult(job, url); }
          catch (e) { _finalizeJob(job, e._ssrf ? 'error' : 'done-download-failed', { error: e.message }); return; }
          _finalizeJob(job, 'done', { file });
          return;
        }
      }
    } catch (e) {
      // Fast-fail on a definitive auth/client error — polling for 40 min cannot recover a
      // bad token or a 4xx. Anything else (5xx, ECONNRESET, parse) is transient: keep trying.
      if (e._isTokenInvalid || (e._httpStatus >= 400 && e._httpStatus < 500)) {
        _finalizeJob(job, 'error', { error: e.message || 'auth/client error' }); return;
      }
    }

    const job2 = _jobs.get(jobId);
    if (job2 && job2.status === 'processing') job2._timer = setTimeout(tick, _pollMs);
  }

  return setTimeout(tick, _pollMs);
}

// Generic: POST /ai/jobs/{type}/{model}, register a job, start poller, return sync.
async function _startJob({ type, model, params, kind, media, onComplete }, creds) {
  const r = await _postV2(`/ai/jobs/${type}/${encodeURIComponent(model)}`, creds, params);
  const d = r.data || {};
  const providerId = d.id_base || d.job_id || d.videoId || null;
  _dlog('create', type + '/' + model, 'providerId=' + providerId, 'status=' + (d.status || '?'));
  if (!providerId) throw new Error('v2 gateway: không nhận được id_base từ job ' + type + '/' + model);
  _pruneJobs();
  const jobId = _generateJobId();
  const job = { jobId, kind, media, providerId, status: 'processing', onComplete, creds, startedAt: Date.now(), _urlLagRetries: 0 };
  _jobs.set(jobId, job);
  job._timer = _startPoller(jobId, creds);
  return { jobId, retryStatusUrl: '/api/aivideoauto/status?jobId=' + jobId };
}

// Plain text/image-to-video + text-to-image (cases V1/V2/V3 + image A/E). Drop-in for
// the legacy startGenerate signature.
async function startGenerate({ type, model, prompt, translateToEn, ratio, resolution, duration, mode, images, onComplete } = {}, creds) {
  let catalogEntry = null;
  if (type === 'video' || type === 'image') {
    catalogEntry = await _catalogEntry(creds, type, model);
    if (catalogEntry) {
      _assertOpt('ratio', ratio, catalogEntry.ratios, model);
      if (type === 'video') {
        _assertOpt('resolution', resolution, catalogEntry.resolutions, model);
        _assertOpt('duration', duration, catalogEntry.durations, model);
        _assertOpt('mode', mode, catalogEntry.modes, model);
      }
    }
  }

  if (type === 'video') {
    // Auto-fill required options from the catalog (same safety net as the other video
    // builders) — many video models reject a job when ratio/mode are omitted.
    const o = _effectiveOpts(catalogEntry, { ratio, resolution, duration, mode });
    const params = {
      prompt,
      translate_to_en: translateToEn !== undefined ? translateToEn : undefined,
      ratio: o.ratio || undefined, resolution: o.resolution || undefined,
      duration: o.duration || undefined, mode: o.mode || undefined,
    };
    if (Array.isArray(images) && images.length) {
      images.forEach((u, i) => { params[`images[${i}][url]`] = u; });
    }
    return _startJob({ type: 'video', model, params, kind: 'video', media: 'video', onComplete }, creds);
  }

  if (type === 'image') {
    // Start-frame quality MATTERS — it is the seed the video model propagates
    // (IMAGE-FIRST), so we no longer force the cheapest tier (CEO 2026-06-19:
    // "tiết kiệm vô nghĩa"). Respect the caller's mode/resolution WHEN VALID for this
    // image model; coerce an invalid/omitted value to the catalog default (Gommo
    // requires a valid mode+resolution — error 600 otherwise). The skill now tells the
    // agent to pick a quality tier (e.g. high / ≥1k) for the start frame.
    const params = {
      prompt,
      ratio: ratio || undefined,
      resolution: _pickValidImageOpt(resolution, catalogEntry && catalogEntry.resolutions),
      mode: _pickValidImageOpt(mode, catalogEntry && catalogEntry.modes),
    };
    if (Array.isArray(images) && images.length) images.forEach((u, i) => { params[`subjects[${i}][url]`] = u; });
    return _startJob({ type: 'image', model, params, kind: 'image', media: 'image', onComplete }, creds);
  }

  throw new Error('type không hợp lệ (phải là video hoặc image)');
}

// V5 — Motion / dance character-swap: character still + driving clip → new character
// performing the same motion. Sends image_url AND images[0][url] (gateway docs note they
// usually coincide) + video_url + subType=motion.
async function startMotion({ model, prompt, characterImageUrl, drivingVideoUrl, remixUrl, backgroundSource, ratio, resolution, duration, mode, onComplete } = {}, creds) {
  if (!characterImageUrl) throw new Error('startMotion: thiếu characterImageUrl (ảnh nhân vật)');
  if (!drivingVideoUrl) throw new Error('startMotion: thiếu drivingVideoUrl (clip lái chuyển động)');
  const entry = await _preflight(creds, 'video', model, { ratio, resolution, duration, mode });
  const o = _effectiveOpts(entry, { ratio, resolution, duration, mode });   // motion REQUIRES ratio+mode
  const params = {
    subType: 'motion',
    prompt: prompt || undefined,
    image_url: characterImageUrl,
    'images[0][url]': characterImageUrl,
    video_url: drivingVideoUrl,
    remix_url: remixUrl || undefined,
    background_source: backgroundSource || undefined,
    ratio: o.ratio || undefined, resolution: o.resolution || undefined,
    duration: o.duration || undefined, mode: o.mode || undefined,
  };
  return _startJob({ type: 'video', model, params, kind: 'motion', media: 'video', onComplete }, creds);
}

// avatar-lipsync — character image + audio → talking/singing avatar.
async function startLipsync({ model, imageUrl, audioUrl, prompt, onComplete } = {}, creds) {
  if (!imageUrl) throw new Error('startLipsync: thiếu imageUrl');
  if (!audioUrl) throw new Error('startLipsync: thiếu audioUrl (file giọng đã upload)');
  await _preflight(creds, 'avatar-lipsync', model, {});
  const params = { image_url: imageUrl, audio_file: audioUrl, prompt: prompt || undefined };
  return _startJob({ type: 'avatar-lipsync', model, params, kind: 'lipsync', media: 'video', onComplete }, creds);
}

// V6 — edit/trim an existing video.
async function startEdit({ model, videoUrl, startSeconds, endSeconds, prompt, onComplete } = {}, creds) {
  if (!videoUrl) throw new Error('startEdit: thiếu videoUrl');
  await _preflight(creds, 'video', model, {});
  const params = { video_url: videoUrl, start_seconds: startSeconds, end_seconds: endSeconds, prompt: prompt || undefined };
  return _startJob({ type: 'video', model, params, kind: 'edit', media: 'video', onComplete }, creds);
}

// V7 — extend / stitch from multiple source clips.
async function startExtend({ model, videoUrl, videoUrls, prompt, mode, duration, onComplete } = {}, creds) {
  if (!videoUrl) throw new Error('startExtend: thiếu videoUrl (clip gốc)');
  const entry = await _preflight(creds, 'video', model, { mode, duration });
  const o = _effectiveOpts(entry, { mode, duration });
  const params = { video_url: videoUrl, prompt: prompt || undefined, mode: o.mode || undefined, duration: o.duration || undefined };
  if (Array.isArray(videoUrls)) videoUrls.forEach((u, i) => { params[`video_urls[${i}][url]`] = u; });
  return _startJob({ type: 'video', model, params, kind: 'extend', media: 'video', onComplete }, creds);
}

// V8 — multi-shots (one job, several prompted shots).
async function startMultiShots({ model, shots, multiShotMode, prompt, ratio, resolution, duration, mode, onComplete } = {}, creds) {
  if (!Array.isArray(shots) || !shots.length) throw new Error('startMultiShots: cần mảng shots');
  const entry = await _preflight(creds, 'video', model, { ratio, resolution, duration, mode });
  const o = _effectiveOpts(entry, { ratio, resolution, duration, mode });
  const params = {
    multi_shots: true, multi_shot_mode: multiShotMode || undefined,
    prompt: prompt || undefined,
    ratio: o.ratio || undefined, resolution: o.resolution || undefined, duration: o.duration || undefined, mode: o.mode || undefined,
  };
  shots.forEach((s, i) => {
    params[`multi_prompt[${i}][prompt]`] = s.prompt;
    if (s.duration != null) params[`multi_prompt[${i}][duration]`] = s.duration;
  });
  return _startJob({ type: 'video', model, params, kind: 'multishots', media: 'video', onComplete }, creds);
}

// V9 — omni: compose a video from image / video / audio reference components per the
// model's configs.reference.allowedTypes.
async function startOmni({ model, references, videoUrls, audioUrls, prompt, ratio, resolution, duration, mode, onComplete } = {}, creds) {
  const entry = await _preflight(creds, 'video', model, { ratio, resolution, duration, mode });
  const o = _effectiveOpts(entry, { ratio, resolution, duration, mode });
  const params = {
    prompt: prompt || undefined,
    ratio: o.ratio || undefined, resolution: o.resolution || undefined, duration: o.duration || undefined, mode: o.mode || undefined,
  };
  if (Array.isArray(references)) references.forEach((u, i) => { params[`references[${i}][url]`] = u; });
  if (Array.isArray(videoUrls)) videoUrls.forEach((u, i) => { params[`video_urls[${i}][url]`] = u; });
  if (Array.isArray(audioUrls)) audioUrls.forEach((u, i) => { params[`audio_urls[${i}][url]`] = u; });
  return _startJob({ type: 'video', model, params, kind: 'omni', media: 'video', onComplete }, creds);
}

// Upscale / enhance an existing image or video to higher resolution. NOT a prompt job — it
// takes a SOURCE media URL. Live contract (2026-06-19): image → generative_upscale_v2 with the
// source at subjects[0][url]; video → video_upscale_1_0 with video_urls[0][url]. Like motion,
// the model REQUIRES its options (resolution/mode/…) — auto-filled from the catalog.
async function startUpscale({ type, model, sourceUrl, ratio, resolution, duration, mode, onComplete } = {}, creds) {
  if (type !== 'image' && type !== 'video') throw new Error('startUpscale: type phải là image hoặc video');
  if (!sourceUrl) throw new Error('startUpscale: thiếu sourceUrl (ảnh/video cần upscale)');
  const m = model || (type === 'image' ? 'generative_upscale_v2' : 'video_upscale_1_0');
  const entry = await _preflight(creds, type, m, { ratio, resolution, duration, mode });
  const o = _effectiveOpts(entry, { ratio, resolution, duration, mode });
  const params = {
    ratio: o.ratio || undefined, resolution: o.resolution || undefined,
    duration: o.duration || undefined, mode: o.mode || undefined,
  };
  if (type === 'image') params['subjects[0][url]'] = sourceUrl;
  else params['video_urls[0][url]'] = sourceUrl;
  // kind mirrors the media so delivery routes correctly (image → photo, video → video).
  return _startJob({ type, model: m, params, kind: type === 'image' ? 'image' : 'video', media: type, onComplete }, creds);
}

function getJobStatus(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return _legacy().getJobStatus(jobId);   // delegated music jobs live in legacy's map
  const out = { status: job.status };
  if (job.file) out.file = job.file;
  if (job.downloadUrl) out.downloadUrl = job.downloadUrl;
  if (job.error) out.error = job.error;
  return out;
}

async function retryDownload(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return _legacy().retryDownload(jobId);   // delegated music jobs live in legacy's map
  if (job.status !== 'done-download-failed') throw new Error('Job không ở trạng thái cần tải lại (phải là done-download-failed)');
  if (!job.downloadUrl) throw new Error('job không có downloadUrl để tải lại');
  const file = await _downloadResult(job, job.downloadUrl);
  job.status = 'done';
  job.file = file;
  return getJobStatus(jobId);
}

// ---------------------------------------------------------------------------
// TTS / voices / music — DELEGATED to the legacy engine (see _legacy note at top).
// A live test of guessed v2 /ai/jobs/{tts,music} paths returned 0 voices and a
// charged-but-lost music job (2026-06-19); the legacy /ai/audio + /api/apps/go-mmo/ai_musics/*
// contract is the proven one. Same token + same workspace outputs dir → drop-in.
// ---------------------------------------------------------------------------

function listVoices(opts, creds) { return _legacy().listVoices(opts, creds); }
function createTts(opts, creds) { return _legacy().createTts(opts, creds); }
function createMusic(opts, creds) { return _legacy().createMusic(opts, creds); }

// ---------------------------------------------------------------------------
// Exports — superset of the legacy contract (drop-in + new capabilities)
// ---------------------------------------------------------------------------

module.exports = {
  verify, listModels, uploadImage, uploadVideo,
  startGenerate, getJobStatus, retryDownload,
  startMotion, startLipsync, startEdit, startExtend, startMultiShots, startOmni, startUpscale,
  listVoices, createTts, createMusic,
};

// Test seam — gated like legacy (never exposed in production builds).
if (process.env.NODE_ENV !== 'production') {
  module.exports._test = {
    _form, _postV2, _postLegacy, _mapV2Status, _effectiveOpts,
    clearModelCache: () => { _modelCache.clear(); },
    setPollMs: (ms) => { _pollMs = ms; },
    setOutputsDirForTest: (d) => { _outputsOverride = d; },
    injectJob: (jobId, job) => { _jobs.set(jobId, job); },
    getJob: (jobId) => _jobs.get(jobId),
    stopAllJobs: () => {
      for (const job of _jobs.values()) { if (job._timer) { clearTimeout(job._timer); job._timer = null; } job.status = 'error'; }
      _jobs.clear();
    },
  };
}
