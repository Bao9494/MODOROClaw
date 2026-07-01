'use strict';
// aivideoauto.js — Gommo AI (api.gommo.net) media engine.
//
// One concern: own a job map (mirrors higgsfield.js's idiom), POST form-urlencoded
// to api.gommo.net, parse the Gommo error envelope {error, message}, and expose
// verify / listModels / uploadImage / startGenerate / getJobStatus / retryDownload /
// createTts / listVoices / createMusic.
//
// ANTI-FEATURES (deliberately out of scope):
//   - No workspace / safeStorage reads — config I/O lives in dashboard-ipc.js (Chunk 4).
//   - No Higgsfield require — this is the replacement engine, not a wrapper.
//   - No new npm dependencies — Node built-ins + url-guard.js only.

const fs = require('fs');
const path = require('path');
const https = require('https');

// SSRF guards shared with higgsfield.js (dormant) — same battle-tested gate.
// Do NOT require('./higgsfield') — that loads the dormant CLI-spawn module into the live path.
const _urlGuard = require('./url-guard');
const { isAllowedResultUrl, hostResolvesPrivate, extFor, download } = _urlGuard;

const HOST = 'api.gommo.net';
const RESP_TIMEOUT_MS = 600000;    // generation polls are short; create calls can be slow
const CONNECT_TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36';

// Filter models that expose a spicy/crazy/nsfw mode — marketing content only.
const UNSAFE_MODE_RE = /spicy|crazy|nsfw|18\+|adult/i;

// Max retries when SUCCESSFUL status comes back without a download URL yet (CDN lag).
const URL_LAG_MAX_RETRIES = 5;

// Job map (mirrors higgsfield.js's idiom). Keys = jobId strings.
// job shape: {jobId, kind:'video'|'image'|'music', providerId, status, onComplete, creds,
//             startedAt, downloadUrl?, file?, error?, _urlLagRetries, _timer}
const _jobs = new Map();

// Pruning: mirror higgsfield.js's pruneJobs idiom so _jobs doesn't grow unbounded.
// Never evict a processing job — its result would become unreachable after it finishes.
const JOB_TTL_MS = 60 * 60 * 1000;   // 1 h — long enough to re-download done-download-failed
const MAX_JOBS = 50;

function _inFlight(j) { return j.status === 'processing'; }

function _pruneJobs() {
  if (_jobs.size <= MAX_JOBS) return;
  const now = Date.now();
  for (const [id, j] of _jobs) {
    if (!_inFlight(j) && now - j.startedAt > JOB_TTL_MS) _jobs.delete(id);
  }
  // If still over limit, evict oldest terminal jobs first
  const terminal = [..._jobs.entries()]
    .filter(([, j]) => !_inFlight(j))
    .sort((a, b) => a[1].startedAt - b[1].startedAt);
  while (_jobs.size > MAX_JOBS && terminal.length) _jobs.delete(terminal.shift()[0]);
}

// Outputs directory — overridable in tests (mirrors higgsfield.js's _outputsOverride pattern).
let _outputsOverride = null;
function _outputsDir() {
  if (_outputsOverride) return _outputsOverride;
  // In production, workspace.getWorkspace() provides the path; fall back to cwd/outputs.
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

// poll interval; tests shrink via _test.setPollMs
let _pollMs = 5000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Encode params as application/x-www-form-urlencoded; JSON-stringify objects/arrays.
// null/undefined values are omitted (no empty form fields).
// NOTE: token+domain injection happens in _request (not here) — _form is a pure encoder.
function _form(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const val = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
  }
  return parts.join('&');
}

// POST endpoint with {access_token, domain} merged in. Resolves parsed JSON or
// rejects with an Error carrying ._gommo (the {error,message} envelope) +
// ._httpStatus. Sets ._isTokenInvalid for 401 or access_token-related messages.
function _request(endpoint, creds, params) {
  return new Promise((resolve, reject) => {
    const payload = _form({ ...params, access_token: creds.token, domain: creds.domain });
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': UA,
    };
    const req = https.request({ hostname: HOST, path: endpoint, method: 'POST', headers }, res => {
      let d = '';
      const t = setTimeout(() => { req.destroy(); reject(new Error('response timeout')); }, RESP_TIMEOUT_MS);
      res.on('data', c => (d += c));
      res.on('end', () => {
        clearTimeout(t);
        try {
          const j = d ? JSON.parse(d) : {};
          // Gommo error envelope: {error:1,message} or {error:'xxx',message}
          if (j && j.error && j.error !== 0) {
            const e = new Error(j.message || 'Gommo API error');
            e._gommo = j; e._httpStatus = res.statusCode;
            if (res.statusCode === 401 || /access_token/i.test(j.message || '')) e._isTokenInvalid = true;
            return reject(e);
          }
          if (res.statusCode >= 400) {
            const e = new Error(`Gommo HTTP ${res.statusCode}`);
            e._httpStatus = res.statusCode;
            return reject(e);
          }
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
// verify — Account Info
// ---------------------------------------------------------------------------

// POST /api/apps/go-mmo/ai/me → {ok, userName, credits, currency}
async function verify(creds) {
  const r = await _request('/api/apps/go-mmo/ai/me', creds, {});
  const b = r.balancesInfo || {};
  return {
    ok: true,
    userName: (r.userInfo || {}).name || null,
    credits: b.credits_ai ?? null,
    currency: b.currency || null,
  };
}

// ---------------------------------------------------------------------------
// listModels — normalize + filter NSFW
// ---------------------------------------------------------------------------

// POST /ai/models {type} → normalized array, unsafe models filtered.
async function listModels(creds, type = 'video') {
  const r = await _request('/ai/models', creds, { type });
  // Gommo names the mode list `mode` (singular) for VIDEO models but `modes` (plural) for
  // IMAGE models — same shape, different key. Read both everywhere or image models lose
  // their modes: the NSFW filter goes blind AND the coerced start-frame `mode` comes back
  // undefined → Gommo error 600 "truyền đầy đủ các options". (Live-verified 2026-06-17.)
  const _modesOf = (m) => (m.modes || m.mode || []);
  return (r.data || [])
    .filter(m => !_modesOf(m).some(x => UNSAFE_MODE_RE.test(`${x.type || ''} ${x.name || ''} ${x.description || ''}`)))
    .map(m => ({
      id: m.model,
      name: m.name,
      description: m.description || '',
      server: m.server,
      price: m.price ?? null,
      // prices[] is the AUTHORITATIVE per-combination cost (keyed by some of mode/resolution/
      // duration); top-level `price` is only the cheapest/base. Surface it so the bot quotes the
      // RIGHT credit cost for the chosen combo (e.g. veo_3_1 fast=1000 vs quality=4000), not the base.
      prices: Array.isArray(m.prices) ? m.prices : [],
      caps: {
        startText: !!m.startText,
        startImage: !!m.startImage,
        startImageAndEnd: !!m.startImageAndEnd,
        withReference: !!m.withReference,
        withLipsync: !!m.withLipsync,
        // withMotion = model follows controlled motion (e.g. Kling Motion Control); extendVideo =
        // model can extend a clip. Surfaced so the bot knows they exist — but note the Create Video
        // API takes only prompt + images (1 or 2 frames); there is NO motion-reference input field.
        withMotion: !!m.withMotion,
        extendVideo: !!m.extendVideo,
      },
      ratios: (m.ratios || []).map(x => x.type),
      resolutions: (m.resolutions || []).map(x => x.type),
      durations: (m.durations || []).map(x => x.type),
      modes: _modesOf(m).map(x => x.type),
    }));
}

// ---------------------------------------------------------------------------
// Catalog validation — CODE-LEVEL anti-hallucination guard
// ---------------------------------------------------------------------------
// WHY (a code guard, not an LLM rule): under load the agent invents model ids that do
// NOT exist ("veo_3_1_lite" — there is no such model; "lite" is a MODE of veo_3_1) or
// passes a ratio/resolution/duration the model doesn't support. Gommo then answers with
// the cryptic "NOT_RESOURCES" / "Cấu hình Model không hợp lệ", which the agent
// mis-paraphrases ("đòi option riêng") and the job silently dies. We refuse a
// non-existent model/option HERE and hand back the REAL list so the agent self-corrects —
// a customer never burns a turn (or credits) on a model/service that does not exist.

// Short per-type cache of the live catalog so a 4-job batch makes ONE /models call.
// Single-tenant by design (one Gommo token per process); not keyed by creds.
const _modelCache = new Map(); // type -> { at, list }
const MODEL_CACHE_MS = 60000;
// The guard must FAIL FAST → fail-open if /models stalls, NOT hang on _request's 10-min
// global response timeout. 10s is ample for a cheap read-only catalog call.
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

// Throw _badOpt if a provided option isn't one the model lists. Skips when the value is
// absent (optional) or when the catalog lists none for that field (model doesn't gate it).
function _assertOpt(name, val, allowed, model) {
  if (val == null || val === '') return;
  if (!Array.isArray(allowed) || !allowed.length) return;
  if (!allowed.map(String).includes(String(val))) {
    const e = new Error(`${name}="${val}" không hợp lệ cho model "${model}". Hợp lệ: ${allowed.join(', ')}`);
    e._badOpt = true; throw e;
  }
}

// Pick a valid option value: keep `provided` if it's in the model's `allowed` list, else fall
// back to the model's FIRST listed value, else `fallback`. Used for image mode/resolution —
// internal knobs we COERCE (not reject) so a start-frame always generates.
function _pickOpt(provided, allowed, fallback) {
  if (provided != null && provided !== '' && Array.isArray(allowed) && allowed.map(String).includes(String(provided))) return provided;
  if (Array.isArray(allowed) && allowed.length) return allowed[0];
  return fallback;
}

// Return the live catalog entry for `model`, or throw _badModel with the REAL id list.
// Returns null (fail-open) ONLY if the catalog itself is unreachable — in that case Gommo
// still rejects a truly bad model, so we never silently spend on a hallucinated one.
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

// ---------------------------------------------------------------------------
// uploadImage — strip base64 prefix, POST, return hosted URL
// ---------------------------------------------------------------------------

// POST /ai/image-upload {data:base64NoPrefix, file_name} → hosted URL string
async function uploadImage(creds, { base64, fileName }) {
  // Strip any "data:<mime>;base64," prefix
  const data = String(base64).replace(/^data:[^;]+;base64,/, '');
  const r = await _request('/ai/image-upload', creds, { data, file_name: fileName });
  return (r.imageInfo || {}).url;
}

// ---------------------------------------------------------------------------
// Generation — startGenerate, _startPoller, getJobStatus, retryDownload
// ---------------------------------------------------------------------------

// Mirror higgsfield.js's generateJobId() pattern; prefix av_ for traceability.
function _generateJobId() {
  return 'av_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// Map Gommo video/image/music status strings to our internal status.
function _mapVideoStatus(s) {
  if (!s) return 'processing';
  if (/PENDING|ACTIVE|PROCESSING/.test(s)) return 'processing';
  if (/SUCCESSFUL/.test(s)) return 'successful'; // internal only — triggers download
  return 'error';
}

function _mapImageStatus(s) {
  if (!s) return 'processing';
  if (s === 'SUCCESS') return 'successful';
  if (s === 'ERROR') return 'error';
  return 'processing'; // PENDING_ACTIVE, PENDING_PROCESSING
}

function _mapMusicStatus(s) {
  if (!s) return 'processing';
  if (s === 'success') return 'successful';
  if (s === 'failed') return 'error';
  return 'processing'; // pending
}

// Download a result URL into outputs/.
// Returns the dest file path.
// Throws an error tagged ._ssrf=true when the URL is blocked by SSRF guards —
// the poller must treat those as hard errors (not retryable done-download-failed).
async function _downloadResult(job, url) {
  if (!isAllowedResultUrl(url)) {
    const e = new Error('result URL ngoài danh sách cho phép');
    e._ssrf = true; throw e;
  }
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (await hostResolvesPrivate(hostname)) {
    const e = new Error('result URL trỏ vào địa chỉ nội bộ (chặn SSRF)');
    e._ssrf = true; throw e;
  }
  const ext = extFor(url, job.kind === 'music' ? 'audio' : job.kind);
  const dest = path.join(_outputsDir(), `aivideoauto-${job.jobId}${ext}`);
  return download(url, dest);
}

// Finalize a job in a terminal state and fire onComplete exactly once.
// The status check at entry is belt-and-suspenders: if the job was already
// finalized (e.g. a cancelled timer fires after the job is done), this is a no-op.
function _finalizeJob(job, status, extras) {
  if (job.status !== 'processing') return; // already finalized — do not double-fire
  job.status = status;
  if (extras) Object.assign(job, extras);
  job._timer = null;
  try { job.onComplete && job.onComplete({ status, ...extras }); } catch {}
}

// Background poller using a self-rescheduling async setTimeout loop.
//
// WHY setTimeout instead of setInterval:
//   setInterval fires unconditionally at each tick regardless of whether the previous
//   async body is still awaiting. If a status-poll resolves slower than _pollMs, two
//   ticks will both see status=SUCCESSFUL and both download + call onComplete — the CEO
//   gets the finished file 2-4×. With setTimeout the next tick is only scheduled AFTER
//   the current await completes, making overlapping ticks structurally impossible.
//
// maxMs guards against runaway pollers (default 40 min, covers Veo/Kling latency).
function _startPoller(jobId, creds, { maxMs = 2400000 } = {}) {
  const startedAt = Date.now();

  async function tick() {
    const job = _jobs.get(jobId);
    if (!job || job.status !== 'processing') return; // job gone or already finalized

    if (Date.now() - startedAt > maxMs) {
      _finalizeJob(job, 'error', { error: 'timeout' });
      return;
    }

    try {
      let raw, internalStatus, url;
      if (job.kind === 'video') {
        // /ai/video nests status+download_url under videoInfo (like /ai/image's imageInfo) —
        // NOT top-level. Reading raw.status (undefined) made _mapVideoStatus return 'processing'
        // forever → finished videos were never delivered (poller ran to the 40-min maxMs).
        // (live-verified 2026-06-17: videoInfo.status MEDIA_GENERATION_STATUS_SUCCESSFUL,
        // videoInfo.download_url = CDN mp4.)
        raw = (await _request('/ai/video', creds, { videoId: job.providerId })).videoInfo || {};
        internalStatus = _mapVideoStatus(raw.status);
        url = raw.download_url || null;
      } else if (job.kind === 'image') {
        // /ai/image nests EVERYTHING under imageInfo — status + url are NOT top-level
        // (unlike /ai/video). Reading raw.status (undefined) made _mapImageStatus return
        // 'processing' forever → the poller ran to the 40-min maxMs → "tạo ảnh thất bại:
        // timeout" even though the image finished in ~2 min. (live-verified 2026-06-17:
        // imageInfo.status PENDING_ACTIVE→PENDING_PROCESSING→SUCCESS, imageInfo.url = CDN jpg.)
        raw = (await _request('/ai/image', creds, { id_base: job.providerId })).imageInfo || {};
        internalStatus = _mapImageStatus(raw.status);
        url = raw.url || null;
      } else if (job.kind === 'music') {
        raw = await _request('/api/apps/go-mmo/ai_musics/getInfo', creds, { id_base: job.providerId });
        const mi = raw.musicInfo || {};
        internalStatus = _mapMusicStatus(mi.status);
        url = mi.audio_url || null;
      } else {
        return; // unknown kind — stop polling
      }

      if (internalStatus === 'error') {
        _finalizeJob(job, 'error');
        return;
      }

      if (internalStatus === 'successful') {
        if (!url) {
          // CDN lag: URL not yet present — retry a few times before giving up.
          job._urlLagRetries = (job._urlLagRetries || 0) + 1;
          if (job._urlLagRetries > URL_LAG_MAX_RETRIES) {
            _finalizeJob(job, 'done-download-failed');
            return;
          }
          // fall through to reschedule below
        } else {
          // Terminal: download and finalize. Do NOT reschedule.
          job.downloadUrl = url;
          let file;
          try {
            file = await _downloadResult(job, url);
          } catch (e) {
            // SSRF blocks are hard errors (not retriable) — credit was spent but we must
            // not let the retry path re-attempt a private-IP target.
            const terminal = e._ssrf ? 'error' : 'done-download-failed';
            _finalizeJob(job, terminal, { error: e.message });
            return;
          }
          _finalizeJob(job, 'done', { file });
          return;
        }
      }
      // still processing (or url-lag retry) — schedule next tick AFTER this one completes
    } catch {
      // transient poll error — keep trying until maxMs
    }

    // Reschedule: only reached when still processing or transient error
    const job2 = _jobs.get(jobId);
    if (job2 && job2.status === 'processing') {
      job2._timer = setTimeout(tick, _pollMs);
    }
  }

  // Schedule the first tick
  const timer = setTimeout(tick, _pollMs);
  return timer;
}

// POST the create endpoint, register a job, kick the poller, return synchronously.
// type:'video' → /ai/create-video; type:'image' → /ai/generateImage.
// images:[u1] = start frame; [u1,u2] = start+end.
async function startGenerate({ type, model, prompt, translateToEn, ratio, resolution, duration, mode, images, onComplete } = {}, creds) {
  const jobId = _generateJobId();
  let providerId, kind;

  // CODE-LEVEL anti-hallucination guard: the model id AND its options must exist in the
  // LIVE catalog before we spend anything. A hallucinated model/option is refused here
  // (with the real list) instead of dying on Gommo's cryptic error. Fail-open only if the
  // catalog is unreachable (see _catalogEntry).
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
    const params = {
      model, privacy: 'PRIVATE', prompt,
      translate_to_en: translateToEn !== undefined ? translateToEn : undefined,
      ratio: ratio || undefined, resolution: resolution || undefined,
      duration: duration || undefined, mode: mode || undefined,
    };
    // First/end frames go as bracket-notation form fields — images[0][url]=<url> — NOT a
    // JSON-stringified array. The public doc says "pass arrays as a JSON string", but the
    // real API (and the web UI) use brackets; a JSON array is silently rejected at
    // create-video with "Ảnh đính kèm không hợp lệ" for EVERY image (any model/ratio).
    // 1 url = first frame; 2 = first+end (model needs caps.startImageAndEnd).
    if (Array.isArray(images) && images.length) {
      images.forEach((u, i) => { params[`images[${i}][url]`] = u; });
      // The web UI tags every image-to-video request with a generation group; match it —
      // image-to-video is validated/gated differently from plain text-to-video.
      params.generation_group_name = String(Date.now());
    }
    const r = await _request('/ai/create-video', creds, params);
    providerId = (r.videoInfo || {}).id_base;
    kind = 'video';
  } else if (type === 'image') {
    // editImage='true'|'false' is the EDIT MODE flag; base64Image is the edit source.
    // We do plain text→image (with optional reference subjects), NOT edit mode — YAGNI.
    // Image models REQUIRE mode + resolution (else Gommo error 600 "truyền đầy đủ options").
    //
    // Start-frame quality MATTERS — it is the SEED the video model propagates
    // (IMAGE-FIRST), so we no longer force the cheapest tier (CEO 2026-06-19:
    // "tiết kiệm vô nghĩa"). Respect the caller's mode/resolution WHEN VALID for this
    // image model; coerce an invalid/omitted value to the catalog default (Gommo
    // requires a valid mode+resolution — error 600 otherwise).
    const pickValid = (v, list) => (Array.isArray(list) && list.length ? (list.includes(v) ? v : list[0]) : ((v != null && v !== '') ? v : undefined));
    const params = {
      action_type: 'create', model, prompt,
      ratio: ratio || undefined,
      resolution: pickValid(resolution, catalogEntry && catalogEntry.resolutions),
      mode: pickValid(mode, catalogEntry && catalogEntry.modes),
      subjects: (Array.isArray(images) && images.length) ? images : undefined,
    };
    const r = await _request('/ai/generateImage', creds, params);
    providerId = (r.imageInfo || {}).id_base;
    kind = 'image';
  } else {
    throw new Error('type không hợp lệ (phải là video hoặc image)');
  }

  _pruneJobs();
  const job = { jobId, kind, providerId, status: 'processing', onComplete, creds, startedAt: Date.now(), _urlLagRetries: 0 };
  _jobs.set(jobId, job);
  job._timer = _startPoller(jobId, creds);

  return { jobId, retryStatusUrl: '/api/aivideoauto/status?jobId=' + jobId };
}

// Read job status from the map.
function getJobStatus(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return null;
  const out = { status: job.status };
  if (job.file) out.file = job.file;
  if (job.downloadUrl) out.downloadUrl = job.downloadUrl;
  if (job.error) out.error = job.error;
  return out;
}

// Re-download for a done-download-failed job (credits already spent; just re-fetch).
// Bug #3 guard: status must be exactly 'done-download-failed'. An SSRF-rejected job
// has status='error' but still has downloadUrl set — the old !downloadUrl guard
// wrongly allowed retrying a hard-error (unreachable private-IP) target.
async function retryDownload(jobId) {
  const job = _jobs.get(jobId);
  if (!job) throw new Error('job không tồn tại');
  if (job.status !== 'done-download-failed') {
    throw new Error('Job không ở trạng thái cần tải lại (phải là done-download-failed)');
  }
  if (!job.downloadUrl) throw new Error('job không có downloadUrl để tải lại');
  const file = await _downloadResult(job, job.downloadUrl);
  job.status = 'done';
  job.file = file;
  return getJobStatus(jobId);
}

// ---------------------------------------------------------------------------
// TTS — listVoices + createTts (synchronous: create call blocks, returns result)
// ---------------------------------------------------------------------------

// POST /ai/audio {action_type:'searchVoices',...} → voices array.
// Live shape (2026-06-19): searchVoices nests the premade catalog at r.voices.data.voices —
// NOT r.data.items (that's the getVoices = custom-voices shape, empty for most accounts).
// Reading the wrong path returned 0 voices and silently broke TTS. Handle both shapes.
async function listVoices({ server = 'elevenlabs', type = 'design', limit, page } = {}, creds) {
  const r = await _request('/ai/audio', creds, { action_type: 'searchVoices', server, type, limit, page });
  const sv = r && r.voices && r.voices.data && r.voices.data.voices;   // searchVoices (premade)
  if (Array.isArray(sv)) return sv;
  return ((r.data || {}).items) || [];                                 // getVoices (custom)
}

// POST /ai/audio {action_type:'create',...} — blocks (~10s), returns SUCCESS immediately.
// On SUCCESS: download file_url → {status:'done',file}. Otherwise {status:'error'}.
// No poller — Gommo TTS has no per-id status endpoint (synchronous API).
async function createTts({ text, voiceId, model = 'eleven_v3', settings } = {}, creds) {
  let r;
  try {
    const params = { action_type: 'create', text, voice_id: voiceId, model };
    if (settings && typeof settings === 'object') {
      // Gommo expects bracket-key form fields: voice_settings[speed]=1.1 etc.
      // _form will URL-encode the bracket key as-is, which is what the API requires.
      for (const [k, v] of Object.entries(settings)) {
        params['voice_settings[' + k + ']'] = v;
      }
    }
    r = await _request('/ai/audio', creds, params);
  } catch {
    return { status: 'error' };
  }
  const ai = r.audioInfo || {};
  if (ai.status !== 'SUCCESS' || !ai.file_url) return { status: 'error' };
  // Apply the SAME SSRF guards that _downloadResult applies for video/image/music.
  // Skipping these checks was a security gap: a malicious Gommo response with a
  // private-IP file_url would have fetched an internal resource unchecked.
  try {
    if (!isAllowedResultUrl(ai.file_url)) {
      const e = new Error('TTS result URL ngoài danh sách cho phép');
      e._ssrf = true; throw e;
    }
    const hostname = new URL(ai.file_url).hostname.replace(/^\[|\]$/g, '');
    if (await hostResolvesPrivate(hostname)) {
      const e = new Error('TTS result URL trỏ vào địa chỉ nội bộ (chặn SSRF)');
      e._ssrf = true; throw e;
    }
    const jobId = _generateJobId();
    const ext = extFor(ai.file_url, 'audio');
    const dest = path.join(_outputsDir(), `aivideoauto-${jobId}${ext || '.mp3'}`);
    const file = await download(ai.file_url, dest);
    return { status: 'done', file };
  } catch (e) {
    // Surface an SSRF block instead of swallowing it silently — a blocked private-IP
    // file_url is a security event the operator should see in logs, not an invisible
    // generic failure. Non-SSRF download errors stay generic.
    if (e && e._ssrf) console.warn('[aivideoauto] TTS SSRF block:', e.message);
    return { status: 'error', error: e && e._ssrf ? e.message : undefined };
  }
}

// ---------------------------------------------------------------------------
// Music — createMusic (async poller on ai_musics/getInfo)
// ---------------------------------------------------------------------------

async function createMusic({ name, prompt, styles, model = 'suno-v4.5', gender, onComplete } = {}, creds) {
  const r = await _request('/api/apps/go-mmo/ai_musics/create', creds, {
    name, prompt, model,
    styles: styles || undefined,
    gender: gender || undefined,
  });
  const data = r.data || [];
  if (!data.length) throw new Error('createMusic: không nhận được id_base từ Gommo');
  const providerId = data[0].id_base;
  // Gommo always returns 2 variants; store the 2nd for later reference.
  // We poll data[0] as primary — no second poller needed (YAGNI).
  const altProviderId = data[1] ? data[1].id_base : undefined;
  _pruneJobs();
  const jobId = _generateJobId();
  const job = { jobId, kind: 'music', providerId, altProviderId, status: 'processing', onComplete, creds, startedAt: Date.now(), _urlLagRetries: 0 };
  _jobs.set(jobId, job);
  job._timer = _startPoller(jobId, creds);
  return { jobId, retryStatusUrl: '/api/aivideoauto/status?jobId=' + jobId };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { verify, listModels, uploadImage, startGenerate, getJobStatus, retryDownload, listVoices, createTts, createMusic };

// Test seam — gated like higgsfield.js (never exposed in production builds).
if (process.env.NODE_ENV !== 'production') {
  module.exports._test = {
    _form,
    _request,
    clearModelCache: () => { _modelCache.clear(); },
    setPollMs: (ms) => { _pollMs = ms; },
    setOutputsDirForTest: (d) => { _outputsOverride = d; },
    // Direct job injection for retryDownload tests (avoids needing a full create→poll cycle)
    injectJob: (jobId, job) => { _jobs.set(jobId, job); },
    // Read a raw job from the map — used to verify internal fields (e.g. altProviderId)
    getJob: (jobId) => _jobs.get(jobId),
    // Cancel all pending timers and clear the job map — call in afterEach to prevent
    // stray poller ticks from leaking across tests and clobbering shared mock state.
    stopAllJobs: () => {
      for (const job of _jobs.values()) {
        if (job._timer) { clearTimeout(job._timer); job._timer = null; }
        job.status = 'error'; // mark terminal so any in-flight tick's reschedule guard drops it
      }
      _jobs.clear();
    },
  };
}
