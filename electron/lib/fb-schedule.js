'use strict';

// Facebook scheduled auto-posting with CEO approval flow.
//
// Two-phase cron architecture:
//   Phase 1 (generate): fires at postTime minus leadMinutes. Generates image
//     via image-gen, sends preview to CEO via Telegram, writes pending file.
//   Phase 2 (publish): fires at postTime. Checks pending status. If approved
//     → post to Facebook. If still pending → skip + notify. If rejected → skip.
//
// Data files (inside workspace):
//   fb-scheduled-posts.json   — array of schedule configs
//   fb-pending/<id>_<YYYY-MM-DD>.json — one pending file per schedule per day

const fs = require('fs');
const path = require('path');
const { getWorkspace, getBrandAssetsDir, readFbConfig, writeFbConfig, auditLog, getFbPageById, getFbPageToken, getTokenById } = require('./workspace');
const { sendTelegram: _sendTelegram, sendTelegramPhoto: _sendTelegramPhoto } = require('./channels');

// ─── Callbacks ────────────────────────────────────────────────────
let _onScheduleChanged = null;
function setOnScheduleChanged(cb) { _onScheduleChanged = cb; }

// ─── Constants ─────────────────────────────────────────────────────
const SCHEDULES_FILE = 'fb-scheduled-posts.json';
const PENDING_DIR = 'fb-pending';
// Append-only publish ledger. One-time schedules auto-delete after firing, so the
// schedule list only ever shows NOT-YET-RUN posts — a multi-post campaign's already
// published items vanish from it. This ledger is the durable, enumerable record the
// bot reconciles against ("campaign of 14 = N published + M pending") so it can never
// again under-count or say "can't tell if it posted". See /api/fb/schedule/history.
const HISTORY_FILE = 'fb-post-history.jsonl';
const DEFAULT_LEAD_MINUTES = 60;
const PENDING_TTL_DAYS = 7;
const _generateInFlight = new Set();
const _publishInFlight = new Map();
const _regenPending = new Set();

// ─── Helpers ───────────────────────────────────────────────────────

function _normKeyPart(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function _scheduleCreateKey(schedule) {
  if (!schedule) return '';
  return [
    schedule.targetPageId,
    schedule.postDate || '',
    schedule.postTime,
    schedule.videoPath || '',
    schedule.imagePath || '',
    _normKeyPart(schedule.caption || ''),
    _normKeyPart(schedule.prompt || ''),
    schedule.campaignId || '',
    Number.isFinite(schedule.postIndex) ? schedule.postIndex : '',
  ].map(_normKeyPart).join('|');
}

function _findDuplicateSchedule(schedules, candidate) {
  const key = _scheduleCreateKey(candidate);
  if (!key) return null;
  return schedules.find(s => _scheduleCreateKey(s) === key) || null;
}

function getFbSchedulesPath() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, SCHEDULES_FILE);
}

function getPendingDir() {
  const ws = getWorkspace();
  if (!ws) return null;
  const dir = path.join(ws, PENDING_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function pendingFilename(scheduleId, dateStr) {
  return `${scheduleId}_${dateStr}.json`;
}

function getFbHistoryPath() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, HISTORY_FILE);
}

// Validate the image source for a schedule-create request. A post needs EITHER a
// generation prompt OR a pre-rendered frozen imagePath (campaign posts). If an
// imagePath is given, the file must already exist (fail fast — don't half-build a
// campaign) AND resolve inside an allowed root. fileExists + isAllowed are
// injected so this is unit-testable without a workspace.
//
// CONTAINMENT (security): imagePath is later read and sent to the CEO's Telegram
// (_sendTelegramPhoto). A prompt-injected agent could otherwise pass an arbitrary
// path (e.g. ../../license.json) and have its content surfaced. isAllowed pins the
// frozen banner to the workspace/brand-assets roots where the bot's own images
// live. Defaults to allow-all so pure unit tests stay workspace-free.
function _validateImageSource(params, fileExists, isAllowed = () => true) {
  const hasPrompt = !!(params && params.prompt);
  const hasImage = !!(params && params.imagePath);
  const hasVideo = !!(params && params.videoPath);
  if (!hasPrompt && !hasImage && !hasVideo) {
    return { ok: false, error: 'prompt, imagePath hoặc videoPath là bắt buộc (prompt để tạo ảnh; imagePath/videoPath nếu đã có sẵn ảnh/video)' };
  }
  // A frozen media file (image or video) must exist AND resolve inside an allowed
  // root — same containment as imagePath (it is later read & sent to FB / Telegram).
  for (const key of ['imagePath', 'videoPath']) {
    const val = params && params[key];
    if (!val) continue;
    if (!isAllowed(val)) return { ok: false, error: `${key} nằm ngoài thư mục cho phép: ${val}` };
    if (!fileExists(val)) return { ok: false, error: `${key} không tồn tại: ${val}` };
  }
  return { ok: true };
}

// True when `p` resolves inside one of `roots` (after symlink-agnostic normalize).
// Used to contain a frozen imagePath to the workspace / brand-assets dirs.
function _isPathUnderRoots(p, roots) {
  let abs;
  try { abs = path.resolve(String(p)); } catch { return false; }
  return roots.filter(Boolean).some((root) => {
    const r = path.resolve(String(root));
    const rel = path.relative(r, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// A "frozen" post carries pre-rendered media (a banner image OR a video/reel).
// The media is chosen + approved at plan time, so the generate phase must reuse
// it as-is and never regenerate (Bug B). Video posts are ALWAYS frozen — we never
// generate video at lead-time. Pure → unit-testable.
function _isFrozenPost(schedule) {
  return !!(schedule && (schedule.imagePath || schedule.videoPath));
}

// Resolve a frozen media path to absolute. Frozen paths are usually already
// absolute (image-gen output / downloaded video), but a workspace-relative path
// (e.g. "outputs/clip.mp4") must resolve against the workspace before fs access.
function _resolveMediaAbs(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const ws = getWorkspace();
  return ws ? path.join(ws, p) : p;
}

// Build one ledger record from a pending (+ optional schedule). Pure → testable.
// Pending wins over schedule because a one-time schedule is usually auto-deleted by
// publish time, so appendFbPostHistory is often called with schedule == null.
function _buildFbHistoryRecord(pending, schedule) {
  return {
    t: new Date().toISOString(),
    scheduleId: pending.scheduleId || schedule?.id || null,
    label: schedule?.label || pending.label || null,
    date: pending.date || null,
    postDate: schedule?.postDate || pending.date || null,
    campaignId: schedule?.campaignId || pending.campaignId || null,
    postIndex: Number.isFinite(pending.postIndex) ? pending.postIndex : (Number.isFinite(schedule?.postIndex) ? schedule.postIndex : null),
    postTotal: Number.isFinite(pending.postTotal) ? pending.postTotal : (Number.isFinite(schedule?.postTotal) ? schedule.postTotal : null),
    status: pending.status || 'unknown',
    postId: pending.postId || null,
    postUrl: pending.postUrl || null,
    publishedAt: pending.publishedAt || null,
    targetPageId: pending.targetPageId || schedule?.targetPageId || null,
    error: pending.error || null,
  };
}

/**
 * Append one terminal-outcome record to the publish ledger. Called once per post
 * (from publishPending, after the publish impl runs — covers both the cron path and
 * the immediate "fb ok" path). Fire-and-forget: never throws into the publish flow.
 */
function appendFbPostHistory(pending, schedule) {
  try {
    const p = getFbHistoryPath();
    if (!p || !pending) return;
    const rec = _buildFbHistoryRecord(pending, schedule);
    fs.appendFileSync(p, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[fb-schedule] appendFbPostHistory failed:', e?.message);
  }
}

/**
 * Read the publish ledger, most-recent first. Bounded tail of the last `limit`
 * records (clamped 1..500). The bot reconciles this (published) against
 * /schedule/list (pending) to report a multi-post campaign's true status.
 */
function readFbPostHistory({ limit = 50 } = {}) {
  try {
    const p = getFbHistoryPath();
    if (!p || !fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter(Boolean);
    const recs = [];
    for (const ln of lines) { try { recs.push(JSON.parse(ln)); } catch {} }
    return recs.reverse().slice(0, Math.max(1, Math.min(500, limit)));
  } catch (e) {
    console.warn('[fb-schedule] readFbPostHistory failed:', e?.message);
    return [];
  }
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function tomorrowStr() {
  return new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function nowInICT() {
  const now = new Date();
  const h = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false, hour: 'numeric' }));
  const m = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', minute: 'numeric' }));
  return { hour: h, minute: m };
}

/** Parse "HH:MM" → { hour, minute } or null */
function parseTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Subtract minutes from HH:MM. Returns { time: "HH:MM", prevDay: boolean }. */
function subtractMinutes(timeStr, minutes) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  let totalMin = parsed.hour * 60 + parsed.minute - minutes;
  const prevDay = totalMin < 0;
  if (totalMin < 0) totalMin += 1440;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return {
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    prevDay,
  };
}

/** Convert "HH:MM" to node-cron expression "MM HH * * *" */
function timeToCron(timeStr) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  return `${parsed.minute} ${parsed.hour} * * *`;
}

/** Convert "HH:MM" + day-of-week spec to cron expression */
function timeToCronWithDays(timeStr, daysOfWeek) {
  const parsed = parseTime(timeStr);
  if (!parsed) return null;
  const dow = Array.isArray(daysOfWeek) && daysOfWeek.length > 0
    ? daysOfWeek.join(',')
    : '*';
  return `${parsed.minute} ${parsed.hour} * * ${dow}`;
}

/** Parse "YYYY-MM-DD" → { year, month, day } or null. Rejects impossible dates. */
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip to reject e.g. 2026-02-30.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Shift "YYYY-MM-DD" by deltaDays (calendar math via UTC). Returns "YYYY-MM-DD" or null. */
function shiftDateStr(dateStr, deltaDays) {
  const parsed = parseDate(dateStr);
  if (!parsed) return null;
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/** Convert "HH:MM" + "YYYY-MM-DD" to node-cron "MM HH DD M *" (fires once on that date). */
function timeToCronOnDate(timeStr, dateStr) {
  const t = parseTime(timeStr);
  const d = parseDate(dateStr);
  if (!t || !d) return null;
  return `${t.minute} ${t.hour} ${d.day} ${d.month} *`;
}

const MAX_POSTDATE_AHEAD_DAYS = 730; // ~2 years — fail loud on fat-finger years

/**
 * Validate a one-time postDate against postTime. Returns { ok, error }.
 * Rejects: bad format, past dates, dates too far out, and same-day-but-time-passed
 * (a date-pinned cron for a past time today would silently fire next year).
 */
function validatePostDate(postDateStr, postTimeStr) {
  if (!parseDate(postDateStr)) return { ok: false, error: 'postDate phải có dạng YYYY-MM-DD' };
  const today = todayStr();
  if (postDateStr < today) return { ok: false, error: 'postDate không được ở quá khứ (hôm nay: ' + today + ')' };
  const maxDate = shiftDateStr(today, MAX_POSTDATE_AHEAD_DAYS);
  if (maxDate && postDateStr > maxDate) return { ok: false, error: 'postDate quá xa (tối đa ~2 năm tới)' };
  if (postDateStr === today && postTimeStr) {
    const pt = parseTime(postTimeStr);
    if (pt) {
      const ict = nowInICT();
      if (ict.hour * 60 + ict.minute >= pt.hour * 60 + pt.minute) {
        return { ok: false, error: 'Giờ đăng hôm nay đã qua — chọn giờ muộn hơn hoặc ngày khác' };
      }
    }
  }
  return { ok: true };
}

/**
 * Human-readable summary of which brand assets a post uses. Shown in every CEO
 * preview so a wrongly-chosen or unwanted asset is caught at the approval gate
 * (the one human checkpoint before publish — important for scheduled posts).
 */
function assetSummaryLine(assetNames) {
  const names = Array.isArray(assetNames) ? assetNames.filter(Boolean) : [];
  return names.length > 0
    ? `Tài sản thương hiệu: ${names.join(', ')}`
    : `Tài sản thương hiệu: (không dùng)`;
}

// ─── Data: Schedules ───────────────────────────────────────────────

/**
 * Load all scheduled FB post configs.
 * Returns [] on missing/corrupt file.
 *
 * Schedule shape:
 * {
 *   id: string,
 *   label: string,
 *   postTime: "HH:MM",
 *   leadMinutes: number (default 120),
 *   enabled: boolean,
 *   autoPost: boolean (skip CEO approval),
 *   prompt: string (image generation prompt),
 *   caption: string (FB post caption template),
 *   assetNames: string[] (brand asset filenames for image-gen),
 *   imageSize: string (e.g. "1024x1024"),
 *   daysOfWeek: number[] (0=Sun..6=Sat, empty=every day),
 *   targetPageId: string (internal page id — which fanpage to publish to),
 *   createdAt: ISO string,
 *   updatedAt: ISO string,
 * }
 */
function loadSchedules() {
  try {
    const raw = fs.readFileSync(getFbSchedulesPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  try {
    const p = getFbSchedulesPath();
    fs.writeFileSync(p, JSON.stringify(schedules, null, 2), 'utf-8');
    if (_onScheduleChanged) {
      try { _onScheduleChanged(); } catch (e) { console.warn('[fb-schedule] onScheduleChanged error:', e?.message); }
    }
    return true;
  } catch (e) {
    console.error('[fb-schedule] saveSchedules failed:', e.message);
    return false;
  }
}

function createScheduleIfMissing(newSchedule) {
  const schedules = loadSchedules();
  const duplicate = _findDuplicateSchedule(schedules, newSchedule);
  if (duplicate) return { schedule: duplicate, deduplicated: true };
  schedules.push(newSchedule);
  saveSchedules(schedules);
  return { schedule: newSchedule, deduplicated: false };
}

/**
 * Remove a schedule by id (idempotent — no-op if absent).
 * Used to auto-clean a one-time (postDate) schedule once it has run, so spent
 * plan entries don't linger. saveSchedules triggers onScheduleChanged → cron restart.
 */
function deleteScheduleById(id) {
  try {
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) return false;
    const removed = schedules.splice(idx, 1)[0];
    saveSchedules(schedules);
    auditLog('fb_schedule_autodeleted', { id, label: removed?.label, postDate: removed?.postDate || null });
    console.log(`[fb-schedule] auto-deleted one-time schedule ${id} (${removed?.label})`);
    return true;
  } catch (e) {
    console.error('[fb-schedule] deleteScheduleById failed:', e.message);
    return false;
  }
}

// ─── Data: Pending files ───────────────────────────────────────────

/**
 * Pending shape:
 * {
 *   scheduleId: string,
 *   date: "YYYY-MM-DD",
 *   status: "pending" | "approved" | "rejected" | "published" | "skipped" | "regenerating",
 *   imagePath: string (absolute),
 *   caption: string,
 *   prompt: string,
 *   targetPageId: string | null (internal page id for multi-page publish),
 *   generatedAt: ISO string,
 *   approvedAt: ISO string | null,
 *   publishedAt: ISO string | null,
 *   postId: string | null,
 *   postUrl: string | null,
 *   error: string | null,
 *   autoPost: boolean,
 * }
 */
function loadPending(scheduleId, dateStr) {
  try {
    const p = path.join(getPendingDir(), pendingFilename(scheduleId, dateStr));
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function savePending(pending) {
  try {
    const dir = getPendingDir();
    const filename = pendingFilename(pending.scheduleId, pending.date);
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(pending, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[fb-schedule] savePending failed:', e.message);
    return false;
  }
}

function listPendingForDate(dateStr) {
  try {
    const dir = getPendingDir();
    if (!fs.existsSync(dir)) return [];
    const suffix = `_${dateStr}.json`;
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(suffix))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Collect active pendings by SCANNING THE PENDING FILES ON DISK (not by iterating
// live schedules). This is the Bug A fix: a one-time schedule auto-deletes after it
// publishes, and an orphaned/late pending must still be approvable. Enrich with the
// schedule if it still exists (for label), else schedule=null — approvePending and
// publish already work from the pending alone. Deps injected for unit testing.
// dates order = priority (today, tomorrow, yesterday) → first wins per scheduleId.
function collectActivePendings(dates, schedules, listPendingForDateFn) {
  const seen = new Map();
  for (const date of dates) {
    for (const pending of listPendingForDateFn(date)) {
      if (!pending) continue;
      if (pending.status === 'pending' || pending.status === 'approved' || pending.status === 'regenerating') {
        if (!seen.has(pending.scheduleId)) {
          const schedule = schedules.find(s => s.id === pending.scheduleId) || null;
          seen.set(pending.scheduleId, { pending, schedule, date });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.pending.scheduleId < b.pending.scheduleId ? -1 : 1;
  });
}

// ─── Phase 1: Generate image + send preview ────────────────────────

/**
 * Called by cron at (postTime - leadMinutes).
 * Generates image, sends preview to CEO via Telegram, writes pending file.
 */
async function handleGenerate(scheduleId) {
  if (_generateInFlight.has(scheduleId)) {
    // A regenerate ("fb ảnh khác") arrived while a generate is already running.
    // Previously this was dropped silently and the CEO got the OLD image. Queue a
    // single re-run instead — the in-flight generate's finally will pick it up.
    console.log(`[fb-schedule] handleGenerate: ${scheduleId} already in flight — queuing one re-run`);
    _regenPending.add(scheduleId);
    return;
  }
  _generateInFlight.add(scheduleId);
  try { await _handleGenerateInner(scheduleId); }
  finally {
    _generateInFlight.delete(scheduleId);
    if (_regenPending.has(scheduleId)) {
      _regenPending.delete(scheduleId);
      console.log(`[fb-schedule] re-running queued regenerate for ${scheduleId}`);
      handleGenerate(scheduleId).catch(e => console.error('[fb-schedule] queued regenerate failed:', e?.message));
    }
  }
}

async function _handleGenerateInner(scheduleId) {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule) {
    console.warn(`[fb-schedule] handleGenerate: schedule "${scheduleId}" not found`);
    return;
  }
  if (!schedule.enabled) {
    console.log(`[fb-schedule] handleGenerate: schedule "${scheduleId}" disabled, skipping`);
    return;
  }

  const lead = typeof schedule.leadMinutes === 'number' ? schedule.leadMinutes : DEFAULT_LEAD_MINUTES;
  const genResult = subtractMinutes(schedule.postTime, lead);
  const date = (genResult && genResult.prevDay) ? tomorrowStr() : todayStr();
  const existing = loadPending(scheduleId, date);
  if (existing && existing.status !== 'regenerating') {
    console.log(`[fb-schedule] handleGenerate: pending already exists for ${scheduleId} on ${date} (status: ${existing.status}), skipping`);
    return;
  }

  // Frozen campaign post: image already chosen + approved at plan time. Skip image
  // generation entirely (Bug B: never regenerate an approved asset). For autoPost
  // (the campaign default) write an already-approved pending and send NO fire-time
  // heads-up — the campaign was pre-approved and we post-then-notify at publish.
  if (_isFrozenPost(schedule)) {
    const isVideo = !!schedule.videoPath;
    const mediaWord = isVideo ? 'Video' : 'Ảnh';
    const frozenAbs = _resolveMediaAbs(schedule.videoPath || schedule.imagePath);
    const fileOk = (() => { try { return fs.existsSync(frozenAbs); } catch { return false; } })();
    const frozen = {
      scheduleId, date,
      status: fileOk ? (schedule.autoPost ? 'approved' : 'pending') : 'skipped',
      imagePath: schedule.imagePath || null,
      videoPath: schedule.videoPath || null,
      videoType: isVideo ? (schedule.videoType === 'video' ? 'video' : 'reel') : null,
      caption: schedule.caption || '',
      prompt: schedule.prompt || '',
      targetPageId: schedule.targetPageId || null,
      campaignId: schedule.campaignId || null,
      postIndex: Number.isFinite(schedule.postIndex) ? schedule.postIndex : null,
      postTotal: Number.isFinite(schedule.postTotal) ? schedule.postTotal : null,
      label: schedule.label || null,
      generatedAt: new Date().toISOString(),
      approvedAt: (fileOk && schedule.autoPost) ? new Date().toISOString() : null,
      publishedAt: null, postId: null, postUrl: null,
      error: fileOk ? null : `${mediaWord} đóng băng không tồn tại trước giờ đăng`,
      autoPost: !!schedule.autoPost,
    };
    savePending(frozen);
    if (!fileOk) {
      if (_sendTelegram) { try { await _sendTelegram(`[FB Nhiệm vụ] "${schedule.label}" — ${mediaWord.toLowerCase()} đóng băng đã mất, bỏ qua bài này. Tạo lại nếu cần.`); } catch {} }
      return;
    }
    // Non-autoPost frozen post → still preview (reusing the frozen media, never regenerating).
    // Image → photo preview; video → text preview (can't send a video file as a Telegram photo).
    if (!schedule.autoPost) {
      const _cap = `[FB Preview] "${schedule.label}"${isVideo ? ` (${frozen.videoType})` : ''}\nCaption:\n${frozen.caption}\n\nTrả lời "fb ok" để duyệt, "fb hủy" để bỏ.`;
      if (isVideo) {
        if (_sendTelegram) { try { await _sendTelegram(_cap); } catch {} }
      } else if (_sendTelegramPhoto) {
        try { await _sendTelegramPhoto(frozenAbs, _cap); } catch {}
      }
    }
    return;
  }

  // Resolve target page name for preview messages
  let _targetPageName = null;
  let _targetShortName = null;
  if (schedule.targetPageId) {
    try {
      const _cfg = readFbConfig();
      const _page = _cfg ? getFbPageById(_cfg, schedule.targetPageId) : null;
      if (_page) { _targetPageName = _page.pageName; _targetShortName = _page.shortName; }
    } catch {}
  }

  const prompt = schedule.prompt || '';
  const caption = schedule.caption || '';
  if (!prompt) {
    console.warn(`[fb-schedule] handleGenerate: schedule "${scheduleId}" has no prompt`);
    if (_sendTelegram) {
      try { await _sendTelegram(`[FB Schedule] Nhiệm vụ "${schedule.label}" không có prompt tạo ảnh. Bỏ qua hôm nay.`); } catch {}
    }
    return;
  }

  // Write pending as "generating" so we know it's in progress
  const pending = {
    scheduleId,
    date,
    status: 'pending',
    imagePath: null,
    caption,
    prompt,
    targetPageId: schedule.targetPageId || null,
    generatedAt: null,
    approvedAt: null,
    publishedAt: null,
    postId: null,
    postUrl: null,
    error: null,
    autoPost: !!schedule.autoPost,
    label: schedule.label || null,
    campaignId: schedule.campaignId || null,
    postIndex: Number.isFinite(schedule.postIndex) ? schedule.postIndex : null,
    postTotal: Number.isFinite(schedule.postTotal) ? schedule.postTotal : null,
  };
  savePending(pending);

  // Generate image
  const imageGen = require('./image-gen');
  const jobId = imageGen.generateJobId();
  const brandAssetsDir = getBrandAssetsDir();
  const assetNames = Array.isArray(schedule.assetNames) ? schedule.assetNames : [];
  const imageSize = schedule.imageSize || '1024x1024';

  console.log(`[fb-schedule] generating image for "${schedule.label}" (jobId: ${jobId})`);
  auditLog('fb_schedule_generate_start', { scheduleId, date, jobId });

  try {
    const imagePath = await new Promise((resolve, reject) => {
      imageGen.startJob(jobId, prompt, brandAssetsDir, assetNames, imageSize, (err, imgPath) => {
        if (err) return reject(err);
        resolve(imgPath);
      });
    });

    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new Error('Tạo ảnh thành công nhưng file không tồn tại');
    }

    // Re-read pending from disk — CEO may have edited caption during generation
    const freshPending = loadPending(scheduleId, date) || pending;
    // If the CEO rejected/cancelled this post WHILE the image was generating, do
    // NOT resurrect it (and definitely don't auto-approve below) — discard the image.
    if (freshPending.status === 'rejected' || freshPending.status === 'skipped') {
      console.log(`[fb-schedule] post was ${freshPending.status} mid-generation — discarding new image for ${scheduleId} on ${date}`);
      return;
    }
    // A newer regenerate ("fb ảnh khác") was requested while this generate ran →
    // this image is stale. Leave status as-is ('regenerating') so the queued
    // re-run regenerates, and don't send a stale preview.
    if (_regenPending.has(scheduleId)) {
      console.log(`[fb-schedule] newer regenerate queued — discarding stale image for ${scheduleId}`);
      return;
    }
    freshPending.imagePath = imagePath;
    freshPending.generatedAt = new Date().toISOString();
    if (freshPending.status === 'regenerating') freshPending.status = 'pending';
    if (!freshPending.status || freshPending.status === 'generating') freshPending.status = 'pending';
    savePending(freshPending);
    Object.assign(pending, freshPending);

    auditLog('fb_schedule_generate_done', { scheduleId, date, jobId, imagePath });
    console.log(`[fb-schedule] image generated: ${imagePath}`);

    // Send preview to CEO via Telegram
    if (schedule.autoPost) {
      // Auto-post mode: mark as approved immediately
      pending.status = 'approved';
      pending.approvedAt = new Date().toISOString();
      savePending(pending);

      if (_sendTelegramPhoto) {
        const _pageLabel = _targetPageName ? `Bài cho **${_targetPageName}**${_targetShortName ? ` (${_targetShortName})` : ''} — lúc ${schedule.postTime}` : `Lúc ${schedule.postTime}`;
        try {
          await _sendTelegramPhoto(imagePath, `[FB Auto-post] "${schedule.label}"\n${_pageLabel}\n\nCaption:\n${caption}\n\n${assetSummaryLine(schedule.assetNames)}\n\nSẽ tự động đăng. Trả lời "fb hủy" để hủy.`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send auto-post preview:', e.message);
        }
      }
    } else {
      // Normal mode: send preview and wait for CEO approval
      const _pageLabel = _targetPageName ? `Bài cho **${_targetPageName}**${_targetShortName ? ` (${_targetShortName})` : ''} — lúc ${schedule.postTime}` : `Lúc ${schedule.postTime}`;
      if (_sendTelegramPhoto) {
        try {
          await _sendTelegramPhoto(imagePath, `[FB Preview] "${schedule.label}"\n${_pageLabel}\n\nCaption:\n${caption}\n\n${assetSummaryLine(schedule.assetNames)}\n\nTrả lời:\n• "fb ok" → duyệt đăng\n• "fb sửa caption: <nội dung mới>" → đổi caption\n• "fb ảnh khác" → tạo lại ảnh\n• "fb hủy" → bỏ bài này`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send photo preview:', e.message);
          // Fall back to a text preview — a photo-send hiccup must not silently
          // strand the post (CEO never sees it → it gets skipped at postTime).
          if (_sendTelegram) {
            try { await _sendTelegram(`[FB Preview] "${schedule.label}" (${_targetPageName || 'Facebook'}) — Ảnh đã tạo xong (gửi ảnh lỗi, ${assetSummaryLine(schedule.assetNames)}).\nCaption: ${caption}\n\nTrả lời "fb ok" để duyệt, "fb hủy" để bỏ.`); }
            catch (e2) { console.warn('[fb-schedule] text preview fallback also failed:', e2.message); }
          }
        }
      } else if (_sendTelegram) {
        try {
          await _sendTelegram(`[FB Preview] "${schedule.label}" (${_targetPageName || 'Facebook'}) — Ảnh đã tạo xong.\nCaption: ${caption}\n\nTrả lời "fb ok" để duyệt, "fb hủy" để bỏ.`);
        } catch (e) {
          console.warn('[fb-schedule] failed to send text preview:', e.message);
        }
      }
    }
  } catch (err) {
    pending.status = 'skipped';
    pending.error = err.message;
    savePending(pending);

    auditLog('fb_schedule_generate_failed', { scheduleId, date, jobId, error: err.message });
    console.error(`[fb-schedule] image generation failed for "${schedule.label}":`, err.message);

    if (_sendTelegram) {
      try {
        await _sendTelegram(`[FB Schedule] Tạo ảnh thất bại cho "${schedule.label}": ${err.message}`);
      } catch {}
    }
  }
}

// ─── Phase 2: Publish or skip ──────────────────────────────────────

/**
 * Called by cron at postTime.
 * Wraps the publish logic so that a one-time (postDate) schedule auto-deletes
 * after its single publish phase runs — regardless of outcome (published,
 * skipped, rejected, failed). The cron is date-pinned and fires only once, so
 * once we reach here the schedule is spent.
 */
async function handlePublish(scheduleId) {
  try {
    await _handlePublishInner(scheduleId);
  } finally {
    try {
      const sch = loadSchedules().find(s => s.id === scheduleId);
      if (sch && sch.postDate) {
        // Defer the delete (and the cron restart it triggers via onScheduleChanged)
        // to the next tick — restarting the cron set from INSIDE a live cron handler
        // could tear down another job scheduled to fire this same minute. The
        // publish is already done here, so the one-time job has served its purpose.
        setImmediate(() => {
          try { deleteScheduleById(scheduleId); }
          catch (e) { console.warn('[fb-schedule] deferred one-time delete failed:', e?.message); }
        });
      }
    } catch (e) {
      console.warn('[fb-schedule] one-time auto-delete (publish) failed:', e?.message);
    }
  }
}

/**
 * Checks pending status and either publishes or skips.
 */
async function _handlePublishInner(scheduleId) {
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);
  if (!schedule) {
    console.warn(`[fb-schedule] handlePublish: schedule "${scheduleId}" not found`);
    return;
  }
  if (!schedule.enabled) {
    console.log(`[fb-schedule] handlePublish: schedule "${scheduleId}" disabled, skipping`);
    return;
  }

  const date = todayStr();
  let pending = loadPending(scheduleId, date);

  if (!pending) {
    // Cross-midnight: a generate near midnight may have keyed the pending to an
    // adjacent date. Probe siblings (postDate / tomorrow / yesterday) before giving up.
    pending = loadPending(scheduleId, schedule.postDate || tomorrowStr())
      || loadPending(scheduleId, shiftDateStr(date, -1));
  }

  if (!pending) {
    console.log(`[fb-schedule] handlePublish: no pending for ${scheduleId} on ${date}`);
    // A one-time post with no pending means its generate phase was missed (machine
    // asleep at generate time) — a permanent miss, so surface it. Recurring
    // schedules just retry tomorrow, so don't alert daily.
    if (schedule.postDate && _sendTelegram) {
      try { await _sendTelegram(`[FB Schedule] Không có bài để đăng cho "${schedule.label}" (ngày ${schedule.postDate}) — có thể máy đã tắt lúc tạo ảnh. Anh tạo lại nếu cần nhé.`); } catch {}
    }
    return;
  }

  if (pending.status === 'published') {
    console.log(`[fb-schedule] handlePublish: ${scheduleId} already published on ${date}`);
    return;
  }

  if (pending.status === 'rejected' || pending.status === 'skipped') {
    console.log(`[fb-schedule] handlePublish: ${scheduleId} was ${pending.status} on ${date}`);
    return;
  }

  if (pending.status === 'pending' || pending.status === 'regenerating') {
    // CEO hasn't approved yet — skip and notify
    pending.status = 'skipped';
    pending.error = 'CEO chưa duyệt trước giờ đăng';
    savePending(pending);

    auditLog('fb_schedule_skipped', { scheduleId, date, reason: 'not_approved' });
    console.log(`[fb-schedule] skipped ${scheduleId} on ${date}: CEO chưa duyệt`);

    if (_sendTelegram) {
      try {
        await _sendTelegram(`[FB Schedule] Bỏ qua bài "${schedule.label}" hôm nay — chưa được duyệt trước ${schedule.postTime}.`);
      } catch {}
    }
    return;
  }

  if (pending.status !== 'approved') {
    console.warn(`[fb-schedule] handlePublish: unexpected status "${pending.status}" for ${scheduleId} on ${date}`);
    return;
  }

  // Status is "approved" — publish now
  await publishPending(pending, schedule);
}

/**
 * Actually post to Facebook. Used by both handlePublish and immediate approve.
 */
/**
 * Publish wrapper — guards against concurrent/duplicate publishing of the same
 * (scheduleId, date). Two paths can race: the publish cron (handlePublish) and an
 * immediate "fb ok" (approvePending) at the same minute. Without this, both read
 * status 'approved' before either writes 'published' → the post goes out TWICE.
 */
async function publishPending(pending, schedule) {
  const key = `${pending.scheduleId}:${pending.date}`;
  const inFlight = _publishInFlight.get(key);
  if (inFlight) {
    console.log(`[fb-schedule] publish already in flight for ${key} — waiting for result`);
    await inFlight;
    const fresh = loadPending(pending.scheduleId, pending.date);
    if (fresh) Object.assign(pending, fresh);
    return;
  }
  // Re-read from disk: another path may have already published it.
  const fresh = loadPending(pending.scheduleId, pending.date);
  if (fresh && fresh.status === 'published') {
    console.log(`[fb-schedule] ${key} already published — skipping`);
    Object.assign(pending, fresh);
    return;
  }
  const job = (async () => {
    try {
      await _publishPendingImpl(pending, schedule);
    } finally {
      // Record the terminal outcome to the durable ledger so the bot can reconcile a
      // multi-post campaign (published items are auto-removed from the schedule list).
      appendFbPostHistory(pending, schedule);
    }
  })();
  _publishInFlight.set(key, job);
  try {
    await job;
  } finally {
    _publishInFlight.delete(key);
  }
}

async function _publishPendingImpl(pending, schedule) {
  const cfg = readFbConfig();
  if (!cfg) {
    pending.status = 'skipped';
    pending.error = 'Facebook chưa kết nối (không có config)';
    savePending(pending);
    auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: pending.error });
    if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Không đăng được "${schedule?.label || pending.scheduleId}": Facebook chưa kết nối.`); } catch {} }
    return;
  }

  // Resolve target page — pending.targetPageId takes priority over schedule.targetPageId
  const targetPageId = pending.targetPageId || schedule?.targetPageId;
  if (!targetPageId) {
    pending.status = 'skipped';
    pending.error = 'Không có fanpage mục tiêu';
    savePending(pending);
    auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: pending.error });
    if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Nhiệm vụ đăng "${schedule?.label || pending.scheduleId}" bị bỏ qua — không có fanpage mục tiêu. Xóa và tạo lại nhiệm vụ này.`); } catch {} }
    return;
  }

  let publishPageId, publishToken, publishPageName;
  try {
    const pageInfo = getFbPageToken(cfg, targetPageId);
    publishPageId = pageInfo.pageId;
    publishToken = pageInfo.token;
    publishPageName = pageInfo.pageName;
  } catch (e) {
    pending.status = 'skipped';
    pending.error = e.message;
    savePending(pending);
    auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: e.message, targetPageId });
    const pName = (() => { try { const p = getFbPageById(cfg, targetPageId); return p?.pageName || targetPageId; } catch { return targetPageId; } })();
    if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Nhiệm vụ đăng "${schedule?.label || pending.scheduleId}" bị bỏ qua — fanpage "${pName}" không còn hoạt động.`); } catch {} }
    return;
  }

  const fbPub = require('./fb-publisher');
  const caption = pending.caption || '';

  // VIDEO / REEL scheduled post — frozen at plan time, posted exactly as-is (we
  // never generate video at lead-time). The publisher owns its queue + dedup +
  // live-verify, so no image-style retry loop here. Returns before image logic.
  if (pending.videoPath) {
    const vType = pending.videoType === 'video' ? 'video' : 'reel';
    const videoAbs = _resolveMediaAbs(pending.videoPath);
    if (!videoAbs || !fs.existsSync(videoAbs)) {
      console.warn(`[fb-schedule] video file missing at publish time: ${videoAbs} — skipping`);
      pending.status = 'skipped';
      pending.error = 'Video bị mất trước giờ đăng';
      savePending(pending);
      auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: 'video_missing' });
      if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Không đăng "${schedule?.label || pending.scheduleId}" — video đã mất trước giờ đăng. Anh tạo lại nếu cần nhé.`); } catch {} }
      return;
    }
    try {
      const result = vType === 'reel'
        ? await fbPub.postReel(publishPageId, publishToken, caption, videoAbs, pending.videoPath)
        : await fbPub.postVideo(publishPageId, publishToken, caption, videoAbs, pending.videoPath);
      pending.status = 'published';
      pending.publishedAt = new Date().toISOString();
      pending.postId = result.postId || null;
      pending.postUrl = result.postUrl || null;
      savePending(pending);
      auditLog('fb_schedule_published', { scheduleId: pending.scheduleId, date: pending.date, postId: result.postId, postUrl: result.postUrl, targetPageId, kind: vType, live: result.live });
      console.log(`[fb-schedule] published ${vType} ${pending.scheduleId} on ${pending.date}: ${result.postUrl} (live=${result.live})`);
      if (_sendTelegram) {
        try {
          const pgLabel = publishPageName ? ` lên **${publishPageName}**` : '';
          const seq = (Number.isFinite(pending.postIndex) && Number.isFinite(pending.postTotal)) ? ` (bài ${pending.postIndex}/${pending.postTotal})` : '';
          const liveNote = result.live ? '' : ' — FB đang xử lý, ~1-2 phút nữa mới hiện';
          await _sendTelegram(`[FB Schedule] Đã đăng ${vType} "${schedule?.label || pending.label || pending.scheduleId}"${seq}${pgLabel}${liveNote}.\n${result.postUrl || ''}`);
        } catch {}
      }
    } catch (err) {
      const msg = String(err.message || '');
      const isTokenExpired = err._isTokenExpired || err._httpStatus === 401 || /OAuthException|expired|invalid.*token|session.*invalid/i.test(msg);
      if (isTokenExpired && targetPageId) {
        try {
          const freshCfg = readFbConfig();
          const pg = (freshCfg && Array.isArray(freshCfg.pages)) ? getFbPageById(freshCfg, targetPageId) : null;
          if (pg) { pg.tokenExpired = true; writeFbConfig(freshCfg); }
        } catch {}
      }
      pending.status = 'skipped';
      pending.error = msg;
      savePending(pending);
      auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: msg, tokenExpired: isTokenExpired, targetPageId, kind: vType });
      console.error(`[fb-schedule] ${vType} publish failed for ${pending.scheduleId}:`, msg);
      if (_sendTelegram) {
        const hint = isTokenExpired ? ' Token fanpage hết hạn — vào Dashboard → Facebook để kết nối lại.' : '';
        try { await _sendTelegram(`[FB Schedule] Đăng ${vType} thất bại "${schedule?.label || pending.scheduleId}": ${msg}${hint}`); } catch {}
      }
    }
    return;
  }

  const imagePath = pending.imagePath;
  const imgBuf = (imagePath && fs.existsSync(imagePath)) ? fs.readFileSync(imagePath) : null;

  if (!imgBuf && imagePath) {
    // Image was expected (imagePath set) but the file is gone at publish time.
    // Don't silently downgrade to a text-only post on the public Fanpage — skip +
    // alert the CEO so they decide, rather than publishing a broken-looking post.
    console.warn(`[fb-schedule] image file missing at publish time: ${imagePath} — skipping (not posting text-only)`);
    pending.status = 'skipped';
    pending.error = 'Ảnh bị mất trước giờ đăng';
    savePending(pending);
    auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: 'image_missing' });
    if (_sendTelegram) {
      try { await _sendTelegram(`[FB Schedule] Không đăng "${schedule?.label || pending.scheduleId}" — ảnh đã tạo bị mất trước giờ đăng. Anh tạo lại nếu cần nhé.`); } catch {}
    }
    return;
  }

  // Validate the image bytes before upload — reject empty / >8MB / non-image (a
  // truncated image-gen write or a wrong file) instead of posting garbage or
  // letting FB reject it (which the retry loop might misclassify).
  if (imgBuf) {
    const okMagic = imgBuf.length >= 4 && (
      (imgBuf[0] === 0xFF && imgBuf[1] === 0xD8) ||                                              // JPEG
      (imgBuf[0] === 0x89 && imgBuf[1] === 0x50 && imgBuf[2] === 0x4E && imgBuf[3] === 0x47) || // PNG
      (imgBuf.slice(0, 4).toString('ascii') === 'RIFF') ||                                      // WEBP
      (imgBuf.slice(0, 3).toString('ascii') === 'GIF')                                          // GIF
    );
    if (imgBuf.length === 0 || imgBuf.length > 8 * 1024 * 1024 || !okMagic) {
      console.warn(`[fb-schedule] invalid image for ${pending.scheduleId}: ${imgBuf.length}B okMagic=${okMagic}`);
      pending.status = 'skipped';
      pending.error = imgBuf.length > 8 * 1024 * 1024 ? 'Ảnh quá lớn (>8MB)' : 'Ảnh không hợp lệ / hỏng';
      savePending(pending);
      auditLog('fb_schedule_publish_failed', { scheduleId: pending.scheduleId, date: pending.date, error: 'invalid_image' });
      if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Không đăng "${schedule?.label || pending.scheduleId}" — ảnh hỏng hoặc quá lớn. Anh thử "fb ảnh khác" nhé.`); } catch {} }
      return;
    }
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [2000, 4000, 8000];

  // Captured once before the first attempt: any post carrying our caption created
  // at/after this moment is OURS. Threaded into findRecentPostByCaption so an
  // indeterminate-error recovery can't mistake an older reused-template post for
  // this one, and can match leniently (FB may append a hashtag/link to the caption).
  const sendStartedMs = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      let result;
      if (imgBuf) {
        result = await fbPub.postPhoto(publishPageId, publishToken, caption, imgBuf, imagePath);
      } else {
        result = await fbPub.postText(publishPageId, publishToken, caption);
      }
      if (!result.postId) {
        // 200 but no post id returned (rare) — try to recover the real post id/url.
        try { const f = await fbPub.findRecentPostByCaption(publishPageId, publishToken, caption, undefined, sendStartedMs); if (f && f.postId) result = f; } catch {}
      }

      pending.status = 'published';
      pending.publishedAt = new Date().toISOString();
      pending.postId = result.postId || null;
      pending.postUrl = result.postUrl || null;
      savePending(pending);

      auditLog('fb_schedule_published', {
        scheduleId: pending.scheduleId,
        date: pending.date,
        postId: result.postId,
        postUrl: result.postUrl,
        targetPageId,
        attempt,
      });
      console.log(`[fb-schedule] published ${pending.scheduleId} on ${pending.date}: ${result.postUrl}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);

      if (_sendTelegram) {
        try {
          const pgLabel = publishPageName ? ` lên **${publishPageName}**` : '';
          const seq = (Number.isFinite(pending.postIndex) && Number.isFinite(pending.postTotal)) ? ` (bài ${pending.postIndex}/${pending.postTotal})` : '';
          await _sendTelegram(`[FB Schedule] Đã đăng "${schedule?.label || pending.label || pending.scheduleId}"${seq}${pgLabel} thành công.\n${result.postUrl || ''}`);
        } catch {}
      }
      return;
    } catch (err) {
      const msg = String(err.message || '');
      const isTokenExpired = err._isTokenExpired || err._httpStatus === 401 ||
        /OAuthException|expired|invalid.*token|session.*invalid/i.test(msg);
      const isPermission = !isTokenExpired && (err._httpStatus === 403 ||
        /permission|requires.*pages_manage_posts|not authorized/i.test(msg));
      // INDETERMINATE: timeout / 5xx / reset AFTER the body may have been sent — FB
      // may have accepted the post. Blind retry double-posts → verify first.
      // NOTE: "connect timeout" is req.setTimeout (whole-socket lifecycle, fires even
      // if FB got the body but is slow to return headers) and ECONNRESET can be
      // mid-send → both are indeterminate, NOT safe-to-retry.
      const isIndeterminate = !isTokenExpired && !isPermission &&
        (err._httpStatus >= 500 || /response body timeout|post queue timeout|socket hang up|ETIMEDOUT|connect timeout|ECONNRESET/i.test(msg));
      // CONNECT-PHASE: genuinely never reached FB (DNS / refused) → safe to retry.
      const isConnect = !isTokenExpired && !isPermission && !isIndeterminate &&
        /ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(msg);

      if (isIndeterminate) {
        let verifyFailed = false;
        try {
          const found = await fbPub.findRecentPostByCaption(publishPageId, publishToken, caption, undefined, sendStartedMs);
          if (found && found.verifyFailed) {
            verifyFailed = true;
          } else if (found) {
            pending.status = 'published';
            pending.publishedAt = new Date().toISOString();
            pending.postId = found.postId;
            pending.postUrl = found.postUrl;
            savePending(pending);
            auditLog('fb_schedule_published', { scheduleId: pending.scheduleId, date: pending.date, postId: found.postId, targetPageId, recovered: true });
            console.log(`[fb-schedule] recovered published ${pending.scheduleId} after "${msg}": ${found.postUrl}`);
            if (_sendTelegram) { try { await _sendTelegram(`[FB Schedule] Đã đăng "${schedule?.label || pending.scheduleId}" (xác nhận lại sau gián đoạn mạng).\n${found.postUrl || ''}`); } catch {} }
            return;
          }
        } catch { verifyFailed = true; }
        // If we could NOT verify whether the post landed (getRecentPosts errored),
        // do NOT blind-retry — FB may already have accepted it → a retry would
        // double-post. Stop and let the CEO check the page.
        if (verifyFailed) {
          console.warn(`[fb-schedule] indeterminate error + could NOT verify post existence — not retrying (avoid double-post): ${msg}`);
        } else {
          // Verify succeeded and post was NOT found → safe to retry, but only if the
          // caption is long enough for findRecentPostByCaption to verify on the NEXT
          // attempt (needs ≥8 normalized chars). Too short → stop (avoid double-post).
          const capNorm = String(caption || '').replace(/\s+/g, ' ').trim();
          if (capNorm.length >= 8 && attempt < MAX_RETRIES) {
            console.warn(`[fb-schedule] indeterminate error (post not found), retrying in ${RETRY_DELAYS[attempt]}ms: ${msg}`);
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
            continue;
          }
          if (capNorm.length < 8) console.warn(`[fb-schedule] indeterminate error + caption too short to verify — not retrying (avoid double-post): ${msg}`);
        }
      } else if (isConnect && attempt < MAX_RETRIES) {
        console.warn(`[fb-schedule] connect-phase error on attempt ${attempt + 1}, retrying in ${RETRY_DELAYS[attempt]}ms: ${msg}`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        continue;
      }

      // OAuthException: mark page token as expired + send differentiated CEO alert
      if (isTokenExpired && targetPageId) {
        try {
          const freshCfg = readFbConfig();
          if (freshCfg && Array.isArray(freshCfg.pages)) {
            const pg = getFbPageById(freshCfg, targetPageId);
            if (pg) {
              pg.tokenExpired = true;
              writeFbConfig(freshCfg);
              console.log(`[fb-schedule] marked page ${targetPageId} token as expired`);
            }
          }
        } catch (markErr) { console.warn('[fb-schedule] failed to mark token expired:', markErr?.message); }
      }

      pending.status = 'skipped';
      pending.error = msg;
      savePending(pending);

      auditLog('fb_schedule_publish_failed', {
        scheduleId: pending.scheduleId,
        date: pending.date,
        error: msg,
        tokenExpired: isTokenExpired,
        permission: isPermission,
        targetPageId,
        attempt,
      });
      console.error(`[fb-schedule] publish failed for ${pending.scheduleId} (attempt ${attempt + 1}):`, msg);

      if (_sendTelegram) {
        let hint = '';
        if (isTokenExpired) {
          // Differentiated CEO alert for legacy vs normal token
          const page = getFbPageById(cfg, targetPageId);
          let isLegacy = false;
          if (page && page.tokenId) {
            const tok = getTokenById(cfg, page.tokenId);
            isLegacy = !!(tok && tok.isLegacy);
          }
          const pName = publishPageName || targetPageId;
          hint = isLegacy
            ? ` Token fanpage "${pName}" đã hết hạn. Cần dán User Token mới (không phải Page Token cũ) trong Dashboard → Facebook.`
            : ` Token fanpage "${pName}" đã hết hạn. Vào Dashboard → Facebook để kết nối lại.`;
        } else if (isPermission) {
          hint = ' Token thiếu quyền đăng bài (pages_manage_posts) — kết nối lại Fanpage trong Dashboard.';
        } else if (isIndeterminate) {
          hint = ' (Mạng gián đoạn — em chưa chắc đã đăng được hay chưa, anh kiểm tra Fanpage giúp em nhé.)';
        }
        try {
          await _sendTelegram(`[FB Schedule] Đăng thất bại "${schedule?.label || pending.scheduleId}": ${msg}${hint}`);
        } catch {}
      }
      return;
    }
  }
}

// ─── Approval actions ──────────────────────────────────────────────

/**
 * CEO approves a pending post. If postTime already passed, publish immediately.
 */
async function approvePending(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt — kiểm tra scheduleId hiện hành qua GET /api/fb/schedule/list (đừng dùng id cũ).' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng' };
  if (pending.status === 'rejected') return { success: false, error: 'Bài đã bị hủy' };
  const wasSkipped = pending.status === 'skipped';
  pending.status = 'approved';
  pending.approvedAt = new Date().toISOString();
  if (wasSkipped) pending.error = null;
  savePending(pending);

  if (wasSkipped) {
    auditLog('fb_schedule_late_approve', { scheduleId, date, originalStatus: 'skipped' });
  }

  auditLog('fb_schedule_approved', { scheduleId, date });

  // Check if we should publish immediately (past postTime on the pending's date)
  const schedules = loadSchedules();
  const schedule = schedules.find(s => s.id === scheduleId);

  // The schedule may already be gone — a one-time post that hit postTime
  // unapproved was skipped and its schedule auto-deleted. The CEO is approving
  // late; the publish window has passed, so publish directly from the pending
  // record (it carries caption + imagePath). Without this we'd reply "Đã duyệt"
  // but nothing would ever post (schedule + cron deleted).
  if (!schedule) {
    await publishPending(pending, { label: pending.scheduleId, postDate: pending.date });
    if (pending.status === 'published') {
      return { success: true, published: true, postId: pending.postId, postUrl: pending.postUrl };
    }
    return { success: false, error: pending.error || 'Không đăng được — nhiệm vụ đã hết hạn. Tạo nhiệm vụ mới qua POST /api/fb/schedule/create với postDate/postTime tương lai.' };
  }

  const postTime = schedule?.postTime;
  if (postTime) {
    const parsed = parseTime(postTime);
    if (parsed) {
      const today = todayStr();
      const pendingDate = pending.date || date;
      if (pendingDate > today) {
        // Pending is for a future date (cross-midnight) — don't publish yet
        return { success: true, published: false, message: 'Đã duyệt. Sẽ đăng lúc ' + postTime + ' ngày ' + pendingDate };
      }
      const ict = nowInICT();
      const postMinutes = parsed.hour * 60 + parsed.minute;
      const nowMinutes = ict.hour * 60 + ict.minute;
      if (nowMinutes >= postMinutes) {
        await publishPending(pending, schedule);
        // One-time post approved+published outside the cron path → auto-delete.
        // Defer the delete (and the cron restart it triggers via onScheduleChanged)
        // to the next tick — restarting the cron set from here could tear down
        // another job scheduled to fire this same minute. Mirror handlePublish.
        if (schedule.postDate) {
          setImmediate(() => {
            try { deleteScheduleById(scheduleId); }
            catch (e) { console.warn('[fb-schedule] deferred one-time delete failed:', e?.message); }
          });
        }
        return { success: true, published: true, postId: pending.postId, postUrl: pending.postUrl };
      }
    }
  }

  return { success: true, published: false, message: 'Đã duyệt. Sẽ đăng lúc ' + (postTime || '?') };
}

/**
 * CEO rejects a pending post.
 */
function rejectPending(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt — kiểm tra scheduleId hiện hành qua GET /api/fb/schedule/list (đừng dùng id cũ).' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng rồi, không thể hủy' };

  pending.status = 'rejected';
  savePending(pending);

  auditLog('fb_schedule_rejected', { scheduleId, date });
  return { success: true };
}

/**
 * CEO edits the caption of a pending post.
 */
function editCaption(scheduleId, newCaption, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt — kiểm tra scheduleId hiện hành qua GET /api/fb/schedule/list (đừng dùng id cũ).' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng, không thể sửa' };
  if (pending.status === 'rejected' || pending.status === 'skipped') {
    return { success: false, error: 'Bài đã bị hủy hoặc bỏ qua' };
  }

  pending.caption = String(newCaption);
  savePending(pending);

  auditLog('fb_schedule_caption_edited', { scheduleId, date });
  return { success: true, caption: pending.caption };
}

/**
 * CEO requests a new image. Sets status to "regenerating" and triggers handleGenerate.
 */
async function regenerateImage(scheduleId, dateStr) {
  const date = dateStr || todayStr();
  const pending = loadPending(scheduleId, date);
  if (!pending) return { success: false, error: 'Không tìm thấy bài chờ duyệt — kiểm tra scheduleId hiện hành qua GET /api/fb/schedule/list (đừng dùng id cũ).' };

  if (pending.status === 'published') return { success: false, error: 'Bài đã được đăng' };

  pending.status = 'regenerating';
  pending.error = null;
  savePending(pending);

  auditLog('fb_schedule_regenerate', { scheduleId, date });

  // Fire handleGenerate async — it will detect "regenerating" status and re-create
  handleGenerate(scheduleId).catch(err => {
    console.error(`[fb-schedule] regenerateImage failed for ${scheduleId}:`, err.message);
  });

  return { success: true, message: 'Đang tạo ảnh mới...' };
}

// ─── Cron setup helper ─────────────────────────────────────────────

/**
 * Returns array of cron job definitions for main.js to schedule.
 * Each: { id, phase, cronExpr, handler }
 *   phase "generate" fires at postTime - leadMinutes
 *   phase "publish"  fires at postTime
 */
function getScheduledCronJobs() {
  const schedules = loadSchedules();
  const jobs = [];

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!schedule.postTime) continue;

    const postTimeParsed = parseTime(schedule.postTime);
    if (!postTimeParsed) continue;

    const lead = typeof schedule.leadMinutes === 'number' ? schedule.leadMinutes : DEFAULT_LEAD_MINUTES;
    const genResult = subtractMinutes(schedule.postTime, lead);
    if (!genResult) continue;

    const sid = schedule.id;

    // One-time dated post: fires exactly once on `postDate`, then auto-deletes
    // after the publish phase. This is how a multi-day plan is expressed — N
    // one-time schedules, one per calendar date. Without it, a "plan" had to be
    // N recurring schedules (postTime + daysOfWeek → "MM HH * * *"), every one
    // of which fired EVERY day → all posts dumped on the same day.
    if (schedule.postDate) {
      const pd = parseDate(schedule.postDate);
      if (!pd) continue;
      // Skip dates already past — a date-pinned cron ("MM HH DD M *") would
      // otherwise silently re-fire on the same calendar date next year.
      if (schedule.postDate < todayStr()) continue;
      // Generate phase runs the day before when the lead window crosses midnight.
      const genDate = genResult.prevDay ? shiftDateStr(schedule.postDate, -1) : schedule.postDate;
      const genCron = timeToCronOnDate(genResult.time, genDate);
      const pubCron = timeToCronOnDate(schedule.postTime, schedule.postDate);
      if (!genCron || !pubCron) continue;

      jobs.push({
        id: `fb-gen-${sid}`,
        phase: 'generate',
        scheduleId: sid,
        cronExpr: genCron,
        handler: () => handleGenerate(sid),
      });
      jobs.push({
        id: `fb-pub-${sid}`,
        phase: 'publish',
        scheduleId: sid,
        cronExpr: pubCron,
        handler: () => handlePublish(sid),
      });
      continue;
    }

    const daysOfWeek = Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length > 0
      ? schedule.daysOfWeek
      : null;

    // Cross-midnight: Phase 1 fires on previous day — shift daysOfWeek back by 1
    const genDays = (genResult.prevDay && daysOfWeek)
      ? daysOfWeek.map(d => d === 0 ? 6 : d - 1)
      : daysOfWeek;

    const genCron = genDays
      ? timeToCronWithDays(genResult.time, genDays)
      : timeToCron(genResult.time);
    const pubCron = daysOfWeek
      ? timeToCronWithDays(schedule.postTime, daysOfWeek)
      : timeToCron(schedule.postTime);

    if (!genCron || !pubCron) continue;

    jobs.push({
      id: `fb-gen-${sid}`,
      phase: 'generate',
      scheduleId: sid,
      cronExpr: genCron,
      handler: () => handleGenerate(sid),
    });

    jobs.push({
      id: `fb-pub-${sid}`,
      phase: 'publish',
      scheduleId: sid,
      cronExpr: pubCron,
      handler: () => handlePublish(sid),
    });
  }

  return jobs;
}

// ─── API route registrar ───────────────────────────────────────────

/**
 * Register FB schedule API routes onto the cron-api HTTP server.
 * Called from cron-api.js route handler.
 *
 * @param {string} urlPath - request URL path
 * @param {object} params - parsed request params
 * @param {function} jsonResp - (res, code, obj) response helper
 * @param {object} res - http response
 * @returns {boolean} true if route was handled, false if not a fb-schedule route
 */
function handleRoute(urlPath, params, jsonResp, res) {
  // List all schedules
  if (urlPath === '/api/fb/schedule/list') {
    const schedules = loadSchedules();
    const date = params.date || todayStr();
    const withPending = schedules.map(s => {
      // One-time posts key their pending file by postDate, not "today".
      const pendDate = s.postDate || date;
      const pending = loadPending(s.id, pendDate);
      return { ...s, pending: pending || null };
    });
    jsonResp(res, 200, { success: true, schedules: withPending, date });
    return true;
  }

  // Publish history (durable ledger). Use this — NOT /list — to see ALREADY-PUBLISHED
  // posts: one-time schedules auto-delete after firing, so /list shows only pending.
  // To report a campaign: reconcile /list (pending) + /history (published) vs the total.
  if (urlPath === '/api/fb/schedule/history') {
    const limit = parseInt(params.limit, 10) || 50;
    const history = readFbPostHistory({ limit });
    const published = history.filter(h => h.status === 'published').length;
    jsonResp(res, 200, { success: true, history, count: history.length, publishedCount: published });
    return true;
  }

  // Create a new schedule
  if (urlPath === '/api/fb/schedule/create') {
    const { label, postTime, prompt, caption } = params;
    if (!postTime) { jsonResp(res, 400, { success: false, error: 'postTime required (HH:MM)' }); return true; }
    if (!parseTime(postTime)) { jsonResp(res, 400, { success: false, error: 'postTime phải có dạng HH:MM' }); return true; }
    // Resolve frozen media to ABSOLUTE (against workspace) BEFORE containment +
    // storage. This makes the _isPathUnderRoots check base-correct (it resolves
    // via path.resolve = cwd, which ≠ workspace), rejects any '..' escape, and —
    // by STORING the absolute path — guarantees publish reuses the exact contained
    // path instead of re-resolving a relative string that could collapse out of root.
    const _absImagePath = params.imagePath ? _resolveMediaAbs(String(params.imagePath)) : null;
    const _absVideoPath = params.videoPath ? _resolveMediaAbs(String(params.videoPath)) : null;
    const _allowedImageRoots = [getWorkspace(), getBrandAssetsDir && getBrandAssetsDir()];
    const _imgCheck = _validateImageSource(
      { prompt: params.prompt, imagePath: _absImagePath, videoPath: _absVideoPath },
      (p) => { try { return require('fs').existsSync(p); } catch { return false; } },
      (p) => _isPathUnderRoots(p, _allowedImageRoots),
    );
    if (!_imgCheck.ok) { jsonResp(res, 400, { success: false, error: _imgCheck.error }); return true; }

    // Validate targetPageId — every schedule must target a specific fanpage
    const targetPageId = params.targetPageId;
    if (!targetPageId) { jsonResp(res, 400, { success: false, error: 'targetPageId is required — lấy pageId qua GET /api/fb/pages (KHÔNG truyền page=<tên> như khi đăng ngay; nhiệm vụ cần targetPageId là id nội bộ)' }); return true; }
    const cfg = readFbConfig();
    if (!cfg || !getFbPageById(cfg, targetPageId)) {
      jsonResp(res, 400, { success: false, error: 'Page not found' });
      return true;
    }

    const schedules = loadSchedules();
    const id = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();

    let leadMinutes = DEFAULT_LEAD_MINUTES;
    if (params.leadMinutes !== undefined) {
      const parsed = parseInt(params.leadMinutes, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 480) leadMinutes = parsed;
    }

    let daysOfWeek = [];
    if (params.daysOfWeek) {
      try {
        const raw = typeof params.daysOfWeek === 'string' ? JSON.parse(params.daysOfWeek) : params.daysOfWeek;
        if (Array.isArray(raw)) {
          daysOfWeek = raw.map(Number).filter(n => n >= 0 && n <= 6);
        }
      } catch {}
    }

    const autoPost = params.autoPost === true || params.autoPost === 'true';
    let assetNames = [];
    if (params.assetNames) {
      try {
        const raw = typeof params.assetNames === 'string' ? JSON.parse(params.assetNames) : params.assetNames;
        if (Array.isArray(raw)) assetNames = raw.map(String);
      } catch {}
    }

    // One-time dated post (a single day of a multi-day plan). When set, the post
    // fires exactly once on this calendar date then auto-deletes. daysOfWeek is
    // ignored. Must be today or a future date (Asia/Ho_Chi_Minh).
    let postDate = null;
    if (params.postDate !== undefined && params.postDate !== null && params.postDate !== '') {
      const v = validatePostDate(String(params.postDate), postTime);
      if (!v.ok) { jsonResp(res, 400, { success: false, error: v.error }); return true; }
      postDate = String(params.postDate);
    }

    const newSchedule = {
      id,
      label: label || 'Bài đăng Facebook',
      postTime,
      leadMinutes,
      enabled: true,
      autoPost,
      prompt: prompt ? String(prompt) : '',
      caption: caption || '',
      assetNames,
      imageSize: params.imageSize || '1024x1024',
      daysOfWeek: postDate ? [] : daysOfWeek,
      postDate,
      targetPageId,
      // A post is EITHER a video/reel OR an image — video wins if both are sent
      // (avoids an ambiguous frozen post). videoType defaults to 'reel'. Paths are
      // the workspace-contained ABSOLUTE forms resolved+validated above.
      videoPath: _absVideoPath,
      videoType: _absVideoPath ? (params.videoType === 'video' ? 'video' : 'reel') : null,
      imagePath: (_absImagePath && !_absVideoPath) ? _absImagePath : null,
      campaignId: params.campaignId ? String(params.campaignId) : null,
      postIndex: Number.isFinite(parseInt(params.postIndex, 10)) ? parseInt(params.postIndex, 10) : null,
      postTotal: Number.isFinite(parseInt(params.postTotal, 10)) ? parseInt(params.postTotal, 10) : null,
      createdAt: now,
      updatedAt: now,
    };

    const createResult = createScheduleIfMissing(newSchedule);
    const savedSchedule = createResult.schedule;

    auditLog(createResult.deduplicated ? 'fb_schedule_create_deduped' : 'fb_schedule_created', { id: savedSchedule.id, label: savedSchedule.label, postTime });

    if (!createResult.deduplicated && autoPost && _sendTelegram) {
      _sendTelegram(`[FB Schedule] Đã tạo nhiệm vụ "${savedSchedule.label}" ở chế độ tự động đăng (không cần duyệt). Trả lời "tắt autopost ${savedSchedule.id}" để bật duyệt thủ công.`).catch(e => console.warn('[fb-schedule] notify error:', e?.message));
    }

    // Nếu giờ đăng còn dưới leadMinutes → generate preview ngay lập tức.
    // Chỉ áp dụng cho lịch không có postDate (lặp) hoặc postDate chính là hôm nay —
    // không generate sớm cho bài one-time ở ngày tương lai.
    try {
      if (!createResult.deduplicated && (!postDate || postDate === todayStr())) {
        const postTimeParsed = parseTime(postTime);
        if (postTimeParsed) {
          const ict = nowInICT();
          const postMin = postTimeParsed.hour * 60 + postTimeParsed.minute;
          const nowMin = ict.hour * 60 + ict.minute;
          const remaining = postMin - nowMin;
          if (remaining > 0 && remaining <= leadMinutes) {
            console.log(`[fb-schedule] postTime trong ${remaining}p (< lead ${leadMinutes}p) — generate preview ngay`);
            handleGenerate(savedSchedule.id).catch(e => console.error('[fb-schedule] immediate generate failed:', e.message));
          }
        }
      }
    } catch (e) { console.warn('[fb-schedule] immediate generate check failed:', e.message); }

    jsonResp(res, 200, { success: true, schedule: savedSchedule, deduplicated: createResult.deduplicated });
    return true;
  }

  // Update a schedule
  if (urlPath === '/api/fb/schedule/update') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }

    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) { jsonResp(res, 404, { success: false, error: 'Không tìm thấy nhiệm vụ' }); return true; }

    const existing = schedules[idx];

    if (params.label !== undefined) existing.label = String(params.label);
    if (params.postTime !== undefined) {
      if (!parseTime(params.postTime)) { jsonResp(res, 400, { success: false, error: 'postTime phải có dạng HH:MM' }); return true; }
      existing.postTime = params.postTime;
    }
    if (params.leadMinutes !== undefined) {
      const parsed = parseInt(params.leadMinutes, 10);
      if (!isNaN(parsed) && parsed >= 1 && parsed <= 480) existing.leadMinutes = parsed;
    }
    if (params.enabled !== undefined) existing.enabled = params.enabled === true || params.enabled === 'true';
    if (params.autoPost !== undefined) {
      const newAutoPost = params.autoPost === true || params.autoPost === 'true';
      if (newAutoPost && !existing.autoPost && _sendTelegram) {
        _sendTelegram(`[FB Schedule] Chuyển "${existing.label}" sang chế độ tự động đăng. Bài sẽ đăng không cần duyệt.`).catch(e => console.warn('[auto-fix] promise rejected:', e?.message));
      }
      existing.autoPost = newAutoPost;
    }
    if (params.prompt !== undefined) existing.prompt = String(params.prompt);
    if (params.caption !== undefined) existing.caption = String(params.caption);
    if (params.imageSize !== undefined) existing.imageSize = String(params.imageSize);
    if (params.assetNames !== undefined) {
      try {
        const raw = typeof params.assetNames === 'string' ? JSON.parse(params.assetNames) : params.assetNames;
        if (Array.isArray(raw)) existing.assetNames = raw.map(String);
      } catch {}
    }
    if (params.daysOfWeek !== undefined) {
      try {
        const raw = typeof params.daysOfWeek === 'string' ? JSON.parse(params.daysOfWeek) : params.daysOfWeek;
        if (Array.isArray(raw)) existing.daysOfWeek = raw.map(Number).filter(n => n >= 0 && n <= 6);
      } catch {}
    }
    if (params.postDate !== undefined) {
      if (params.postDate === null || params.postDate === '') {
        // Clear → revert to recurring schedule.
        delete existing.postDate;
      } else {
        const v = validatePostDate(String(params.postDate), existing.postTime);
        if (!v.ok) { jsonResp(res, 400, { success: false, error: v.error }); return true; }
        existing.postDate = String(params.postDate);
        existing.daysOfWeek = [];
      }
    }
    if (params.targetPageId !== undefined) {
      const updateCfg = readFbConfig();
      if (!updateCfg || !getFbPageById(updateCfg, params.targetPageId)) {
        jsonResp(res, 400, { success: false, error: 'Page not found' });
        return true;
      }
      existing.targetPageId = params.targetPageId;
    }

    existing.updatedAt = new Date().toISOString();
    schedules[idx] = existing;
    saveSchedules(schedules);

    auditLog('fb_schedule_updated', { id });
    jsonResp(res, 200, { success: true, schedule: existing });
    return true;
  }

  // Delete a schedule
  if (urlPath === '/api/fb/schedule/delete') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }

    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) { jsonResp(res, 404, { success: false, error: 'Không tìm thấy nhiệm vụ' }); return true; }

    const removed = schedules.splice(idx, 1)[0];
    saveSchedules(schedules);

    auditLog('fb_schedule_deleted', { id, label: removed.label });
    jsonResp(res, 200, { success: true });
    return true;
  }

  // Approve pending
  if (urlPath === '/api/fb/schedule/approve') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    approvePending(id, date).then(result => {
      jsonResp(res, result.success ? 200 : 400, result);
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  // Reject pending
  if (urlPath === '/api/fb/schedule/reject') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    const result = rejectPending(id, date);
    jsonResp(res, result.success ? 200 : 400, result);
    return true;
  }

  // Edit caption
  if (urlPath === '/api/fb/schedule/edit-caption') {
    const { id, caption, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    if (caption === undefined) { jsonResp(res, 400, { success: false, error: 'caption required' }); return true; }
    const result = editCaption(id, caption, date);
    jsonResp(res, result.success ? 200 : 400, result);
    return true;
  }

  // Regenerate image
  if (urlPath === '/api/fb/schedule/regenerate') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    regenerateImage(id, date).then(result => {
      jsonResp(res, result.success ? 200 : 400, result);
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  // Get pending details for a specific schedule + date
  if (urlPath === '/api/fb/schedule/pending') {
    const { id, date } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    const pending = loadPending(id, date || todayStr());
    if (!pending) { jsonResp(res, 404, { success: false, error: 'Không có bài chờ duyệt' }); return true; }
    jsonResp(res, 200, { success: true, pending });
    return true;
  }

  // Trigger manual generate (for testing)
  if (urlPath === '/api/fb/schedule/trigger-generate') {
    const { id } = params;
    if (!id) { jsonResp(res, 400, { success: false, error: 'id required' }); return true; }
    handleGenerate(id).then(() => {
      const pending = loadPending(id, todayStr());
      jsonResp(res, 200, { success: true, pending });
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  if (urlPath === '/api/fb/schedule/telegram-command') {
    const { text } = params;
    if (!text) { jsonResp(res, 400, { success: false, error: 'text required' }); return true; }
    const cmd = parseTelegramCommand(text);
    if (!cmd) { jsonResp(res, 200, { success: true, handled: false }); return true; }
    handleTelegramCommand(cmd).then(result => {
      jsonResp(res, 200, { success: true, ...result });
    }).catch(err => {
      jsonResp(res, 500, { success: false, error: err.message });
    });
    return true;
  }

  return false;
}

/**
 * Wrapper matching the export signature described in requirements.
 * Designed to be called from cron-api.js inside the request handler.
 */
function registerRoutes(urlPath, params, jsonResp, res) {
  return handleRoute(urlPath, params, jsonResp, res);
}

// ─── Cleanup old pending files ─────────────────────────────────────

function cleanupOldPending() {
  try {
    const dir = getPendingDir();
    if (!fs.existsSync(dir)) return 0;

    const now = Date.now();
    const cutoff = now - PENDING_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {}
    }

    if (removed > 0) {
      console.log(`[fb-schedule] cleaned up ${removed} old pending file(s)`);
      auditLog('fb_schedule_cleanup', { removed });
    }
    return removed;
  } catch (e) {
    console.error('[fb-schedule] cleanup failed:', e.message);
    return 0;
  }
}

/**
 * Delete one-time (postDate) schedules whose date is already past. Without this,
 * a one-time post missed because the machine slept across its publish window
 * (App Nap / lid closed) would linger a full year — its date-pinned cron would
 * re-fire on the same calendar date next year. Called at every cron (re)start.
 *
 * Safe to call inside startCronJobs: saveSchedules → onScheduleChanged →
 * restartCronJobs is suppressed by startCronJobs' _startCronJobsInFlight guard,
 * so no restart loop. The second pass finds nothing spent and writes nothing.
 */
function cleanupSpentOneTimeSchedules() {
  try {
    const schedules = loadSchedules();
    const today = todayStr();
    const spent = schedules.filter(s => s && s.postDate && s.postDate < today);
    if (spent.length === 0) return 0;
    const kept = schedules.filter(s => !(s && s.postDate && s.postDate < today));
    saveSchedules(kept);
    for (const s of spent) {
      // If the CEO had APPROVED this one-time post but it never published (machine
      // asleep across the publish window), that's a lost explicit commitment — alert
      // instead of deleting silently. (We don't auto-publish late: the day is gone.)
      let pend = null;
      try { pend = loadPending(s.id, s.postDate); } catch {}
      if (pend && pend.status === 'approved' && _sendTelegram) {
        try { _sendTelegram(`[FB Schedule] Bài "${s.label}" (anh đã duyệt cho ngày ${s.postDate}) KHÔNG đăng được đúng ngày đó (máy tắt/ngủ, hoặc app không chạy vào lúc đó). Anh tạo lại nếu vẫn cần nhé.`).catch(e => console.warn('[auto-fix] promise rejected:', e?.message)); } catch {}
      }
      auditLog('fb_schedule_onetime_expired', { id: s.id, label: s.label, postDate: s.postDate, pendingStatus: pend?.status || null });
    }
    console.log(`[fb-schedule] removed ${spent.length} spent one-time schedule(s) (past postDate)`);
    return spent.length;
  } catch (e) {
    console.error('[fb-schedule] cleanupSpentOneTimeSchedules failed:', e.message);
    return 0;
  }
}

// ─── Telegram command parser ───────────────────────────────────────

/**
 * Parse CEO Telegram reply for FB schedule actions.
 * Returns null if text is not a FB schedule command.
 * Returns { action, scheduleId?, caption?, date? } if it is.
 *
 * Recognized patterns:
 *   "ok", "đăng đi", "duyệt" → approve
 *   "hủy", "hủy <id>" → reject
 *   "sửa caption: <text>" → edit caption
 *   "tạo ảnh khác", "tạo lại ảnh" → regenerate
 *   "tắt autopost <id>" → disable autoPost
 */
function parseTelegramCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  // A trailing FB schedule id (fb_...) targets a specific post when several are
  // awaiting approval. ONLY an fb_ token counts as an id — so "hủy ngay" cancels
  // the active post (it doesn't treat "ngay" as an id and silently fail to cancel).
  const idMatch = t.match(/\b(fb_[0-9a-z_]+)\b/i);
  // Schedule ids are auto-generated lowercase (fb_<ts>_<rand>); lowercase the
  // captured token so an uppercased "FB_1" still matches via strict ===.
  const sid = idMatch ? idMatch[1].toLowerCase() : null;

  // NOTE: use a lookahead boundary (?=$|\s|[.,:!?]) instead of \b — JS \b is
  // ASCII-only, so it FAILS after a Vietnamese diacritic char (e.g. "bỏ", "huỷ"
  // end in non-ASCII) and the keyword would never match → command silently ignored.

  // Approve all — must check before single approve
  if (/^(tất cả|tat ca|all)$/i.test(t)) {
    return { action: 'approveAll' };
  }

  // Select a specific pending by number (disambiguation response: "1", "2", etc.)
  if (/^[0-9]+$/.test(t)) {
    return { action: 'selectPending', index: parseInt(t, 10) };
  }

  // Approve — prefix match so "ok nhé", "duyệt đi" etc. still work. Bare "đăng"
  // dropped (matched "đăng ký"/"đăng nhập"); use "đăng đi"/"đăng bài".
  if (/^(ok|okay|duyệt|duyet|đăng đi|đăng bài|post|approve)(?=$|\s|[.,:!?])/i.test(t)) {
    return { action: 'approve', scheduleId: sid };
  }

  // Edit caption (check before reject/regenerate so "sửa caption: hủy ..." works)
  const captionMatch = t.match(/^sửa\s+caption:\s*(.+)$/is);
  if (captionMatch) {
    return { action: 'editCaption', caption: captionMatch[1].trim(), scheduleId: sid };
  }

  // Reject
  if (/^(hủy|huỷ|bỏ|cancel|thôi|không đăng|khong dang)(?=$|\s|[.,:!?])/i.test(t)) {
    return { action: 'reject', scheduleId: sid };
  }

  // Regenerate image
  if (/^(tạo ảnh khác|tạo lại ảnh|ảnh khác|đổi ảnh|regenerate|regen)(?=$|\s|[.,:!?])/i.test(t)) {
    return { action: 'regenerate', scheduleId: sid };
  }

  // Disable autoPost
  const autoMatch = t.match(/^tắt\s+autopost\s+(.+)$/i);
  if (autoMatch) {
    return { action: 'disableAutoPost', scheduleId: sid || autoMatch[1].trim() };
  }

  return null;
}

// When several FB posts await approval and the CEO didn't specify which, present
// a numbered list with page names so they can reply with a number or "tất cả".
function _fbDisambig(list) {
  // Resolve page names for each entry
  let cfg = null;
  try { cfg = readFbConfig(); } catch {}
  const lines = list.map((x, i) => {
    let pageLabel = '';
    const tpid = x.pending?.targetPageId || x.schedule?.targetPageId;
    if (tpid && cfg) {
      const page = getFbPageById(cfg, tpid);
      if (page) pageLabel = `${page.pageName || tpid}${page.shortName ? ` (${page.shortName})` : ''}`;
    }
    const capSnippet = x.pending?.caption ? `"${x.pending.caption.slice(0, 30)}${x.pending.caption.length > 30 ? '...' : ''}"` : '';
    return `${i + 1}. ${pageLabel ? pageLabel + ' — ' : ''}${capSnippet || `"${x.schedule?.label || x.pending.label || x.pending.scheduleId}"`}`;
  }).join('\n');
  return `Có ${list.length} bài đang chờ duyệt:\n${lines}\nNhắn số (1, 2, ...) hoặc "tất cả" để duyệt.`;
}

/**
 * Handle a parsed Telegram command against the most recent pending post.
 * Returns { handled: boolean, response?: string } for the caller to reply.
 */
async function handleTelegramCommand(cmd) {
  if (!cmd) return { handled: false };

  // Search today, tomorrow, then yesterday — covers cross-midnight previews and a
  // generate that fired late after a wake. ORDER MATTERS: collectActive() takes the
  // FIRST date that has an active pending per schedule, so today must come before
  // yesterday — a fresh today pending must win over a stale yesterday one.
  const dates = [todayStr(), tomorrowStr(), shiftDateStr(todayStr(), -1)];
  const schedules = loadSchedules();

  // All currently-active pendings (deduped by scheduleId; first date in `dates`
  // order wins → today preferred over tomorrow over yesterday).
  // Sorted deterministically by date + scheduleId so numbered disambiguation list
  // is stable across repeated calls (CEO picks by number).
  function collectActive() {
    return collectActivePendings(dates, schedules, listPendingForDate);
  }

  // Resolve the target. { found } | { notFound } | { ambiguous: [...] }.
  // When the CEO didn't give an id and >1 post is active, we DON'T auto-pick the
  // first (that could approve/cancel the WRONG post) — we ask which one.
  function resolve(specificId) {
    if (specificId) {
      for (const date of dates) {
        const pending = loadPending(specificId, date);
        if (pending) {
          const schedule = schedules.find(s => s.id === specificId) || null;
          return { found: { pending, schedule, date } };
        }
      }
      return { notFound: true };
    }
    const active = collectActive();
    if (active.length === 0) return { notFound: true };
    if (active.length === 1) return { found: active[0] };
    return { ambiguous: active };
  }

  const NONE = 'Không có bài Facebook nào đang chờ duyệt.';

  if (cmd.action === 'approve') {
    const r = resolve(cmd.scheduleId);
    if (r.notFound) return { handled: true, response: NONE };
    if (r.ambiguous) return { handled: true, response: _fbDisambig(r.ambiguous) };
    const result = await approvePending(r.found.pending.scheduleId, r.found.date);
    if (!result.success) return { handled: true, response: result.error };
    if (result.published) return { handled: true, response: `Đã duyệt và đăng "${r.found.schedule?.label || r.found.pending.label || r.found.pending.scheduleId}" thành công.\n${result.postUrl || ''}` };
    return { handled: true, response: result.message || 'Đã duyệt.' };
  }

  if (cmd.action === 'selectPending') {
    const active = collectActive();
    if (active.length === 0) return { handled: true, response: NONE };
    const idx = cmd.index;
    if (idx < 1 || idx > active.length) {
      return { handled: true, response: `Số không hợp lệ. Nhắn 1-${active.length} hoặc "tất cả".` };
    }
    const target = active[idx - 1];
    const result = await approvePending(target.pending.scheduleId, target.date);
    if (!result.success) return { handled: true, response: result.error };
    if (result.published) return { handled: true, response: `Đã duyệt và đăng "${target.schedule?.label || target.pending.label || target.pending.scheduleId}" thành công.\n${result.postUrl || ''}` };
    return { handled: true, response: result.message || `Đã duyệt "${target.schedule?.label || target.pending.label || target.pending.scheduleId}".` };
  }

  if (cmd.action === 'approveAll') {
    const active = collectActive();
    if (active.length === 0) return { handled: true, response: NONE };
    const results = [];
    for (const entry of active) {
      const result = await approvePending(entry.pending.scheduleId, entry.date);
      results.push({ label: entry.schedule?.label || entry.pending.label || entry.pending.scheduleId, ...result });
    }
    const ok = results.filter(r => r.success);
    const fail = results.filter(r => !r.success);
    let msg = `Đã duyệt ${ok.length}/${results.length} bài.`;
    if (fail.length > 0) msg += `\nLỗi: ${fail.map(r => `"${r.label}": ${r.error}`).join('; ')}`;
    return { handled: true, response: msg };
  }

  if (cmd.action === 'reject') {
    const r = resolve(cmd.scheduleId);
    if (r.notFound) return { handled: true, response: NONE };
    if (r.ambiguous) return { handled: true, response: _fbDisambig(r.ambiguous) };
    const result = rejectPending(r.found.pending.scheduleId, r.found.date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: `Đã hủy bài "${r.found.schedule?.label || r.found.pending.label || r.found.pending.scheduleId}".` };
  }

  if (cmd.action === 'editCaption') {
    const r = resolve(cmd.scheduleId);
    if (r.notFound) return { handled: true, response: NONE };
    if (r.ambiguous) return { handled: true, response: _fbDisambig(r.ambiguous) };
    const result = editCaption(r.found.pending.scheduleId, cmd.caption, r.found.date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: `Đã cập nhật caption cho "${r.found.schedule?.label || r.found.pending.label || r.found.pending.scheduleId}":\n${cmd.caption}` };
  }

  if (cmd.action === 'regenerate') {
    const r = resolve(cmd.scheduleId);
    if (r.notFound) return { handled: true, response: NONE };
    if (r.ambiguous) return { handled: true, response: _fbDisambig(r.ambiguous) };
    const result = await regenerateImage(r.found.pending.scheduleId, r.found.date);
    if (!result.success) return { handled: true, response: result.error };
    return { handled: true, response: 'Đang tạo ảnh mới. Sẽ gửi preview khi xong.' };
  }

  if (cmd.action === 'disableAutoPost') {
    const idx = schedules.findIndex(s => s.id === cmd.scheduleId);
    if (idx === -1) return { handled: true, response: `Không tìm thấy nhiệm vụ "${cmd.scheduleId}".` };
    schedules[idx].autoPost = false;
    schedules[idx].updatedAt = new Date().toISOString();
    saveSchedules(schedules);
    auditLog('fb_schedule_autopost_disabled', { id: cmd.scheduleId });
    return { handled: true, response: `Đã tắt chế độ tự động đăng cho "${schedules[idx].label}". Từ nay sẽ cần duyệt trước khi đăng.` };
  }

  return { handled: false };
}

// ─── Telegram FB command poller ────────────────────────────────────
// Peeks at recent Telegram updates (non-destructive, offset=-10) and routes
// CEO messages starting with "fb " to the FB schedule command handler.
// Only polls when there are active pending FB posts for today.

const https = require('https');
let _pollerTimer = null;
const _processedUpdateIds = new Set();
const _FB_POLL_INTERVAL_MS = 30000;

function startFbTelegramPoller() {
  // DISABLED: independent getUpdates poller conflicts with gateway's Telegram
  // long-polling (HTTP 409). CEO approval commands ("fb ok") are now routed
  // by the AI agent via web_fetch to /api/fb/schedule/telegram-command.
  // See AGENTS.md "Facebook duyệt bài" section.
  console.log('[fb-schedule] Telegram command poller DISABLED (gateway routes via AGENTS.md)');
}

function stopFbTelegramPoller() {
  if (_pollerTimer) { clearInterval(_pollerTimer); _pollerTimer = null; }
}

async function _pollTelegramForFbCommands() {
  return;
}

function _peekTelegramUpdates(_token) {
  return null;
}

// ─── Module exports ────────────────────────────────────────────────

module.exports = {
  // Data
  loadSchedules,
  saveSchedules,
  deleteScheduleById,
  loadPending,
  savePending,

  // Phase handlers (called from startCronJobs in main.js)
  handleGenerate,
  handlePublish,

  // Approval (called from API endpoints or Telegram command handler)
  approvePending,
  rejectPending,
  editCaption,
  regenerateImage,

  // API route registrar (called from cron-api.js request handler)
  registerRoutes,

  // Cron setup helper
  getScheduledCronJobs,
  assetSummaryLine,

  // Telegram integration
  parseTelegramCommand,
  handleTelegramCommand,

  // Cleanup
  cleanupOldPending,
  cleanupSpentOneTimeSchedules,
  validatePostDate,

  // Telegram FB command poller
  startFbTelegramPoller,
  stopFbTelegramPoller,

  // Callback registration
  setOnScheduleChanged,

  // Pure helpers exported for tests
  _validateImageSource,
  _isPathUnderRoots,
  _isFrozenPost,
  _buildFbHistoryRecord,
  collectActivePendings,
};
