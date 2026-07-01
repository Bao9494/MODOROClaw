'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');
const workspace = require('./workspace');
const { sendTelegram } = require('./channels');

const MAX_ITEMS = 500;
const MAX_ACTIVE_JOBS = 3;
const TEXT_PHOTO_CONCURRENCY = 5;
const VIDEO_CONCURRENCY = 1;
const BATCH_MIN_LEAD_S = 15 * 60;
const DEFAULT_GLOBAL_CREATE_DELAY_MS = 2000;
const DEFAULT_PER_PAGE_CREATE_DELAY_MS = 15000;
const MAX_AUTO_RESUME_ATTEMPTS = 2;
const JOB_DIR = 'fb-schedule-batches';
const HISTORY_FILE = 'fb-schedule-batch-history.jsonl';

let _publisher = require('./fb-publisher');
let _notifyOverride = null;
const _jobs = new Map();
const _batchIndex = new Map(); // fingerprint -> jobId
const _resumeTimers = new Map(); // jobId -> Timeout
let _dripConfig = { globalDelayMs: DEFAULT_GLOBAL_CREATE_DELAY_MS, perPageDelayMs: DEFAULT_PER_PAGE_CREATE_DELAY_MS };
let _nextGlobalCreateAt = 0;
const _nextPageCreateAt = new Map();
let _createSlotChain = Promise.resolve();

function _nowIso() { return new Date().toISOString(); }
function _normText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function _hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function _sleep(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }

function _setDripConfig(cfg) {
  _dripConfig = {
    globalDelayMs: Math.max(0, Number(cfg && cfg.globalDelayMs) || 0),
    perPageDelayMs: Math.max(0, Number(cfg && cfg.perPageDelayMs) || 0),
  };
}

function _resetDripForTest() {
  _setDripConfig({ globalDelayMs: 0, perPageDelayMs: 0 });
  _nextGlobalCreateAt = 0;
  _nextPageCreateAt.clear();
  _createSlotChain = Promise.resolve();
}

async function _waitForCreateSlot(pageId) {
  const reserve = _createSlotChain.then(async () => {
    const readyAt = Math.max(_nextGlobalCreateAt, _nextPageCreateAt.get(pageId) || 0);
    await _sleep(Math.max(0, readyAt - Date.now()));
    const startAt = Date.now();
    _nextGlobalCreateAt = startAt + _dripConfig.globalDelayMs;
    _nextPageCreateAt.set(pageId, startAt + _dripConfig.perPageDelayMs);
  });
  _createSlotChain = reserve.catch(() => {});
  await reserve;
}

function _jobDir() {
  const ws = workspace.getWorkspace();
  if (!ws) throw new Error('workspace not available');
  return path.join(ws, JOB_DIR);
}
function _jobPath(jobId) { return path.join(_jobDir(), `${jobId}.json`); }
function _historyPath() { return path.join(workspace.getWorkspace(), HISTORY_FILE); }

function _appendHistory(event, meta) {
  try {
    fs.appendFileSync(_historyPath(), JSON.stringify({ t: _nowIso(), event, ...meta }) + '\n', 'utf-8');
  } catch (e) {
    console.warn('[fb-native-batch] history write failed:', e && e.message);
  }
}

async function _notifyTelegram(text) {
  if (_notifyOverride) return _notifyOverride(text);
  if (process.env.NODE_ENV === 'test' || process.env._9BIZ_SUPPRESS_TG) return;
  try { await sendTelegram(text); }
  catch (e) { console.warn('[fb-native-batch] Telegram notify failed:', e && e.message); }
}

function _safeRealpathInsideWorkspace(relPath) {
  const ws = workspace.getWorkspace();
  if (!ws) throw new Error('workspace not available');
  const rel = String(relPath || '').trim();
  if (!rel || rel.includes('\0') || rel.includes('..')) throw new Error('đường dẫn media không hợp lệ');
  let wsReal, real;
  try { wsReal = fs.realpathSync(ws); }
  catch (e) { throw new Error('workspace không truy cập được: ' + e.message); }
  const abs = path.resolve(ws, rel);
  try { real = fs.realpathSync(abs); }
  catch { throw new Error('file media không tồn tại: ' + rel); }
  if (!(real === wsReal || real.startsWith(wsReal + path.sep))) throw new Error('file media nằm ngoài workspace');
  return real;
}

function _mediaIdentity(kind, relPath, driveFileId) {
  if (driveFileId) return `drive:${String(driveFileId)}`;
  if (!relPath) return '';
  const real = _safeRealpathInsideWorkspace(relPath);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('media không phải file: ' + relPath);
  if (st.size <= 0) throw new Error('media rỗng: ' + relPath);
  return `${kind}:${real}:${st.size}:${Math.floor(st.mtimeMs)}`;
}

function _resolvePage(cfg, item) {
  if (!cfg || !Array.isArray(cfg.pages) || cfg.pages.length === 0) throw new Error('Facebook chưa kết nối fanpage');
  const ref = item.pageId != null ? String(item.pageId) : '';
  if (ref) return workspace.getFbPageToken(cfg, ref);
  const qRaw = item.page != null ? String(item.page) : '';
  const q = qRaw.trim().toLowerCase();
  if (!q) throw new Error('page hoặc pageId là bắt buộc');
  const enabled = cfg.pages.filter(p => p.enabled);
  const short = enabled.filter(p => p.shortName && String(p.shortName).toLowerCase() === q);
  if (short.length === 1) return workspace.getFbPageToken(cfg, short[0].id || short[0].pageId);
  if (short.length > 1) throw new Error(`Nhiều fanpage khớp "${qRaw}"`);
  const name = enabled.filter(p => p.pageName && String(p.pageName).toLowerCase().includes(q));
  if (name.length === 1) return workspace.getFbPageToken(cfg, name[0].id || name[0].pageId);
  if (name.length > 1) throw new Error(`Nhiều fanpage khớp "${qRaw}"`);
  const disabled = cfg.pages.find(p => !p.enabled && (
    (p.shortName && String(p.shortName).toLowerCase() === q) ||
    (p.pageName && String(p.pageName).toLowerCase().includes(q))
  ));
  if (disabled) throw new Error(`Fanpage "${qRaw}" đang tắt`);
  throw new Error(`Không tìm thấy fanpage "${qRaw}"`);
}

function _normalizeItem(raw, index, cfg) {
  if (!raw || typeof raw !== 'object') throw new Error(`item ${index + 1} không hợp lệ`);
  const page = _resolvePage(cfg, raw);
  const typeRaw = String(raw.type || (raw.driveFileId ? 'drive-reel' : raw.videoPath ? 'reel' : raw.imagePath ? 'photo' : 'text')).toLowerCase();
  let type = typeRaw;
  if (type === 'image') type = 'photo';
  if (type === 'drive-video') type = 'drive-video';
  else if (type === 'drive-reel') type = 'drive-reel';
  else if (type === 'video') type = 'video';
  else if (type === 'reel') type = 'reel';
  else if (type === 'photo') type = 'photo';
  else type = 'text';

  const message = _normText(raw.message != null ? raw.message : raw.caption);
  const link = raw.link ? String(raw.link) : '';
  if (type === 'text' && !message && !link) throw new Error(`item ${index + 1}: text/link required`);
  if (message.length > 63206) throw new Error(`item ${index + 1}: message too long`);

  const ts = _publisher.normalizeScheduleTime(raw.scheduledPublishTime != null ? raw.scheduledPublishTime : (raw.when || raw.scheduleTime || raw.time));
  const lead = ts - Math.floor(Date.now() / 1000);
  if (lead < BATCH_MIN_LEAD_S) throw new Error(`item ${index + 1}: batch cần hẹn tối thiểu 15 phút để đủ thời gian tạo lịch`);

  let media = {};
  let mediaId = '';
  if (type === 'photo') {
    if (!raw.imagePath) throw new Error(`item ${index + 1}: imagePath required`);
    media.imagePath = String(raw.imagePath);
    media.absImagePath = _safeRealpathInsideWorkspace(media.imagePath);
    mediaId = _mediaIdentity('photo', media.imagePath);
  } else if (type === 'video' || type === 'reel') {
    if (!raw.videoPath) throw new Error(`item ${index + 1}: videoPath required`);
    media.videoPath = String(raw.videoPath);
    media.absVideoPath = _safeRealpathInsideWorkspace(media.videoPath);
    mediaId = _mediaIdentity(type, media.videoPath);
  } else if (type === 'drive-video' || type === 'drive-reel') {
    const driveFileId = raw.driveFileId || raw.fileId || raw.driveId;
    if (!driveFileId) throw new Error(`item ${index + 1}: driveFileId required`);
    media.driveFileId = String(driveFileId);
    mediaId = _mediaIdentity(type, '', media.driveFileId);
  }

  const fingerprint = _hash([
    page.pageId, ts, type, message, mediaId, link,
  ].join('|'));
  return {
    itemId: raw.itemId ? String(raw.itemId) : `item_${index + 1}`,
    index,
    fingerprint,
    pageId: page.pageId,
    pageName: page.pageName,
    token: page.token,
    type,
    message,
    link,
    scheduledPublishTime: ts,
    media,
    status: 'pending',
    attempts: 0,
    postId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function _summarize(items) {
  const pages = new Set(items.map(i => i.pageId));
  const times = items.map(i => i.scheduledPublishTime).filter(Boolean).sort((a, b) => a - b);
  return {
    total: items.length,
    pages: pages.size,
    earliest: times[0] || null,
    latest: times[times.length - 1] || null,
    sample: items.slice(0, 5).map(i => ({ itemId: i.itemId, pageName: i.pageName, type: i.type, scheduledPublishTime: i.scheduledPublishTime, message: i.message.slice(0, 120) })),
  };
}

function _normalizeBatch(input) {
  const arr = Array.isArray(input && input.items) ? input.items : null;
  if (!arr || arr.length === 0) throw new Error('items array required');
  if (arr.length > MAX_ITEMS) throw new Error(`Một batch tối đa ${MAX_ITEMS} bài`);
  const cfg = workspace.readFbConfig();
  const items = arr.map((it, i) => _normalizeItem(it, i, cfg));
  const fingerprint = _hash(items.map(i => `${i.fingerprint}:${i.index}`).sort().join('\n'));
  return { success: true, fingerprint, summary: _summarize(items), items };
}

function _publicMedia(item) {
  const out = {};
  if (item.media && item.media.imagePath) out.imagePath = item.media.imagePath;
  if (item.media && item.media.videoPath) out.videoPath = item.media.videoPath;
  if (item.media && item.media.driveFileId) out.driveFileId = item.media.driveFileId;
  return Object.keys(out).length ? out : undefined;
}

function _publicPreviewItem(item) {
  const out = {
    itemId: item.itemId,
    pageId: item.pageId,
    pageName: item.pageName,
    type: item.type,
    message: item.message,
    scheduledPublishTime: item.scheduledPublishTime,
  };
  if (item.link) out.link = item.link;
  const media = _publicMedia(item);
  if (media) out.media = media;
  return out;
}

async function previewBatch(input) {
  const normalized = _normalizeBatch(input || {});
  return {
    success: true,
    fingerprint: normalized.fingerprint,
    summary: normalized.summary,
    items: normalized.items.map(_publicPreviewItem),
  };
}

function _publicJob(job) {
  return {
    jobId: job.jobId,
    fingerprint: job.fingerprint,
    status: job.status,
    total: job.total,
    scheduled: job.scheduled,
    failed: job.failed,
    deduplicated: job.deduplicated,
    skipped: job.skipped,
    paused: job.paused || 0,
    pauseReason: job.pauseReason || null,
    resumeAt: job.resumeAt || null,
    resumeAttempt: job.resumeAttempt || 0,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(job.jobId)}`,
    items: (Array.isArray(job.items) ? job.items : []).map(i => {
      const out = {
        itemId: i.itemId,
        pageId: i.pageId,
        pageName: i.pageName,
        type: i.type,
        message: i.message,
        scheduledPublishTime: i.scheduledPublishTime,
        status: i.status,
        attempts: i.attempts,
        postId: i.postId,
        error: i.error,
        startedAt: i.startedAt,
        finishedAt: i.finishedAt,
        deduplicatedFrom: i.deduplicatedFrom || null,
      };
      if (i.link) out.link = i.link;
      const media = _publicMedia(i);
      if (media) out.media = media;
      return out;
    }),
  };
}

function _recount(job) {
  job.scheduled = job.items.filter(i => i.status === 'scheduled').length;
  job.failed = job.items.filter(i => i.status === 'failed').length;
  job.deduplicated = job.items.filter(i => i.status === 'deduplicated').length;
  job.skipped = job.items.filter(i => i.status === 'skipped').length;
  job.paused = job.items.filter(i => i.status === 'paused').length;
  const terminal = job.scheduled + job.failed + job.deduplicated + job.skipped + job.paused;
  if (job.status === 'paused') {
    job.finishedAt = null;
  } else if (terminal >= job.total) {
    job.finishedAt = job.finishedAt || _nowIso();
    job.status = (job.failed === 0 && job.paused === 0) ? 'done' : ((job.scheduled + job.deduplicated) > 0 ? 'partial' : 'failed');
  } else if (job.status !== 'failed') {
    job.status = 'running';
  }
  job.updatedAt = _nowIso();
}

function _persistableJob(job) {
  return {
    ...job,
    // Page tokens are runtime credentials from fb-config.json. Never duplicate them
    // into batch status files; the durable record is for progress/recovery only.
    items: job.items.map(({ token, _pageFatal, _pageRateLimited, _estimatedTimeToRegainAccessSec, ...rest }) => rest),
  };
}

function _persist(job) {
  _recount(job);
  writeJsonAtomic(_jobPath(job.jobId), _persistableJob(job));
}

function _isPageFatalError(e) {
  if (e && e._isTokenExpired) return true;
  const msg = String(e && e.message || e || '');
  return /token.*(hết hạn|expired|invalid)|(hết hạn|expired|invalid).*token|permission|quyền/i.test(msg);
}

function _isRateLimitedError(e) {
  return !!(e && e._isRateLimited);
}

function _resumeDelayMs(e, attempt) {
  const fromMeta = Number(e && e._estimatedTimeToRegainAccessSec);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta * 1000;
  return (attempt <= 1 ? 15 : 30) * 60 * 1000;
}

function _formatLocalTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function _limitReason(resumeAt) {
  const retry = resumeAt ? ` Em sẽ tự thử lại lúc ${_formatLocalTime(resumeAt)}.` : '';
  return 'Facebook đang báo giới hạn tạm thời. Đây là cơ chế bảo vệ khi tạo nhiều lịch trong thời gian ngắn, không phải bài bị mất hay fanpage bị khóa.' + retry;
}

function _pauseJobForLimit(job, err) {
  if (job.status === 'paused') return;
  const attempt = (job.resumeAttempt || 0) + 1;
  const willRetry = attempt <= MAX_AUTO_RESUME_ATTEMPTS;
  const resumeAt = willRetry ? new Date(Date.now() + _resumeDelayMs(err, attempt)).toISOString() : null;
  job.status = 'paused';
  job.resumeAttempt = attempt;
  job.resumeAt = resumeAt;
  job.pauseReason = willRetry
    ? _limitReason(resumeAt) + ' Các bài đã hẹn thành công vẫn nằm trong Facebook Planner và sẽ tự đăng đúng giờ.'
    : 'Facebook vẫn đang báo giới hạn tạm thời. Em dừng batch tại đây để an toàn, tránh phải chờ lâu hơn. Các bài đã hẹn thành công vẫn nằm trong Facebook Planner và sẽ tự đăng đúng giờ.';
  for (const item of job.items) {
    if (!['scheduled', 'deduplicated', 'failed', 'skipped'].includes(item.status)) {
      item.status = 'paused';
      item.error = job.pauseReason;
      item.finishedAt = item.finishedAt || _nowIso();
    }
  }
  _scheduleResume(job);
}

function _preparePausedJobForResume(job) {
  job.status = 'running';
  job.pauseReason = null;
  job.resumeAt = null;
  job.finishedAt = null;
  for (const item of job.items) {
    if (item.status === 'paused') {
      item.status = 'pending';
      item.error = null;
      item.finishedAt = null;
      item.startedAt = null;
      delete item._pageRateLimited;
      delete item._estimatedTimeToRegainAccessSec;
      delete item._pageFatal;
    }
  }
}

function _clearResumeTimer(jobId) {
  const timer = _resumeTimers.get(jobId);
  if (timer) clearTimeout(timer);
  _resumeTimers.delete(jobId);
}

function _scheduleResume(job) {
  _clearResumeTimer(job.jobId);
  if (!job.resumeAt || job.resumeAttempt > MAX_AUTO_RESUME_ATTEMPTS) return;
  const delayMs = Math.max(0, Date.parse(job.resumeAt) - Date.now());
  const timer = setTimeout(() => { _resumeJobNow(job.jobId); }, delayMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _resumeTimers.set(job.jobId, timer);
}

function _resumeJobNow(jobId) {
  const job = _jobs.get(jobId);
  if (!job || job.status !== 'paused') return false;
  _clearResumeTimer(jobId);
  _preparePausedJobForResume(job);
  _startRunner(job);
  return true;
}

function _resumeDue(job) {
  return !!(job && job.status === 'paused' && job.resumeAt && Date.parse(job.resumeAt) <= Date.now());
}

function _rehydrateTokens(job) {
  const cfg = workspace.readFbConfig();
  for (const item of job.items || []) {
    if (!item.token && item.pageId) {
      item.token = workspace.getFbPageToken(cfg, item.pageId).token;
    }
  }
  return job;
}

function _isHeavyItem(item) {
  return ['video', 'reel', 'drive-video', 'drive-reel'].includes(item.type);
}

async function _runOne(job, item) {
  item.status = 'running';
  item.startedAt = _nowIso();
  item.attempts += 1;
  delete item._pageRateLimited;
  delete item._estimatedTimeToRegainAccessSec;
  delete item._pageFatal;
  _persist(job);
  try {
    let result;
    await _waitForCreateSlot(item.pageId);
    if (job.status === 'paused') {
      item.status = 'paused';
      item.error = job.pauseReason || 'Facebook đang báo giới hạn tạm thời';
      item.finishedAt = _nowIso();
      return item;
    }
    if (item.type === 'photo') {
      const img = fs.readFileSync(item.media.absImagePath);
      result = await _publisher.schedulePhoto(item.pageId, item.token, item.message, img, item.media.absImagePath, item.scheduledPublishTime);
    } else if (item.type === 'video') {
      result = await _publisher.scheduleVideo(item.pageId, item.token, item.message, item.media.absVideoPath, item.scheduledPublishTime);
    } else if (item.type === 'reel') {
      result = await _publisher.scheduleReel(item.pageId, item.token, item.message, item.media.absVideoPath, item.scheduledPublishTime);
    } else if (item.type === 'drive-video' || item.type === 'drive-reel') {
      result = await _publisher.scheduleMediaFromDrive(item.pageId, item.token, item.message, item.media.driveFileId, item.scheduledPublishTime, item.type === 'drive-video' ? 'video' : 'reel');
    } else {
      result = await _publisher.scheduleText(item.pageId, item.token, item.message, item.scheduledPublishTime, item.link);
    }
    if (!result || !result.postId) throw new Error('Facebook không trả postId — chưa thể coi là đã hẹn');
    item.status = 'scheduled';
    item.postId = result.postId;
    item.result = result;
    item.error = null;
    item.finishedAt = _nowIso();
    _appendHistory('fb_schedule_batch_item_scheduled', { jobId: job.jobId, itemId: item.itemId, pageId: item.pageId, postId: item.postId });
    try { workspace.auditLog('fb_schedule_batch_item_scheduled', { jobId: job.jobId, itemId: item.itemId, pageId: item.pageId, postId: item.postId }); } catch {}
    return item;
  } catch (e) {
    item.status = 'failed';
    item.error = String(e && e.message || e).slice(0, 500);
    if (_isRateLimitedError(e)) {
      item.status = 'paused';
      item._pageRateLimited = true;
      item._estimatedTimeToRegainAccessSec = e._estimatedTimeToRegainAccessSec;
      item.error = _limitReason(null).slice(0, 500);
    }
    if (_isPageFatalError(e)) item._pageFatal = true;
    item.finishedAt = _nowIso();
    _appendHistory('fb_schedule_batch_item_failed', { jobId: job.jobId, itemId: item.itemId, pageId: item.pageId, error: item.error });
    try { workspace.auditLog('fb_schedule_batch_item_failed', { jobId: job.jobId, itemId: item.itemId, pageId: item.pageId, error: item.error }); } catch {}
    return item;
  } finally {
    _persist(job);
  }
}

async function _pool(tasks, limit) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor++;
      await tasks[idx]();
    }
  });
  await Promise.all(workers);
}

function _makeLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  return fn => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < max) run();
    else queue.push(run);
  });
}

async function _runJob(job) {
  try {
    job.status = 'running';
    _persist(job);
    try { workspace.auditLog('fb_schedule_batch_started', { jobId: job.jobId, total: job.total }); } catch {}
    _notifyTelegram(`Bắt đầu hẹn lịch Facebook batch ${job.jobId}: ${job.total} bài. Em sẽ báo khi xong.`);

    const firstByFp = new Map();
    const duplicates = new Map();
    for (const item of job.items) {
      const first = firstByFp.get(item.fingerprint);
      if (!first) firstByFp.set(item.fingerprint, item);
      else {
        if (!duplicates.has(first.itemId)) duplicates.set(first.itemId, []);
        duplicates.get(first.itemId).push(item);
      }
    }

    const unique = [...firstByFp.values()];
    const pageFatal = new Map();
    const pageLimited = new Map();
    const limitedPages = new Set();
    let maxLimitRegainSec = 0;
    const inPageOrder = new Map();
    for (const item of unique) {
      if (!inPageOrder.has(item.pageId)) inPageOrder.set(item.pageId, []);
      inPageOrder.get(item.pageId).push(item);
    }
    const runHeavy = _makeLimiter(VIDEO_CONCURRENCY);
    const runAndPropagate = async (item) => {
      const fatal = pageFatal.get(item.pageId);
      const limited = pageLimited.get(item.pageId);
      if (job.status === 'paused' && !['scheduled', 'failed', 'skipped', 'deduplicated'].includes(item.status)) {
        item.status = 'paused';
        item.error = job.pauseReason || 'Facebook đang báo giới hạn tạm thời';
        item.finishedAt = _nowIso();
      } else if (fatal && !['scheduled', 'failed', 'skipped', 'deduplicated'].includes(item.status)) {
        item.status = 'skipped';
        item.error = fatal;
        item.finishedAt = _nowIso();
      } else if (limited && !['scheduled', 'failed', 'skipped', 'deduplicated', 'paused'].includes(item.status)) {
        item.status = 'paused';
        item.error = limited;
        item.finishedAt = _nowIso();
      } else if (!['scheduled', 'failed', 'skipped', 'deduplicated', 'paused'].includes(item.status)) {
        if (_isHeavyItem(item)) await runHeavy(() => _runOne(job, item));
        else await _runOne(job, item);
        if (item.status === 'failed' && item.error && item._pageFatal) pageFatal.set(item.pageId, item.error);
        if (item._pageRateLimited) {
          limitedPages.add(item.pageId);
          const regain = Number(item._estimatedTimeToRegainAccessSec);
          if (Number.isFinite(regain) && regain > maxLimitRegainSec) maxLimitRegainSec = regain;
          const reason = _limitReason(null);
          pageLimited.set(item.pageId, reason);
          if (limitedPages.size >= 2) {
            _pauseJobForLimit(job, { _estimatedTimeToRegainAccessSec: maxLimitRegainSec });
            _persist(job);
            _notifyTelegram(job.pauseReason);
          }
        }
      } else if (item.status === 'failed' && item.error && _isPageFatalError(item.error)) {
        pageFatal.set(item.pageId, item.error);
      }
      const dups = duplicates.get(item.itemId) || [];
      for (const dup of dups) {
        dup.finishedAt = _nowIso();
        dup.deduplicatedFrom = item.itemId;
        if (item.status === 'scheduled') {
          dup.status = 'deduplicated';
          dup.postId = item.postId;
          dup.error = null;
        } else if (item.status === 'skipped') {
          dup.status = 'skipped';
          dup.error = item.error || 'Bỏ qua do bài gốc bị bỏ qua';
        } else if (item.status === 'paused') {
          dup.status = 'paused';
          dup.error = item.error || 'Bỏ qua do bài gốc đang tạm dừng';
        } else {
          dup.status = 'failed';
          dup.error = `Trùng với ${item.itemId}, nhưng bài gốc lỗi: ${item.error || 'unknown'}`;
        }
      }
      _persist(job);
    };

    await _pool([...inPageOrder.values()].map(items => async () => {
      for (const item of items) await runAndPropagate(item);
    }), TEXT_PHOTO_CONCURRENCY);
    _persist(job);
    if (job.status === 'paused') return;
    _appendHistory('fb_schedule_batch_finished', { jobId: job.jobId, status: job.status, scheduled: job.scheduled, failed: job.failed, deduplicated: job.deduplicated });
    try { workspace.auditLog('fb_schedule_batch_finished', { jobId: job.jobId, status: job.status, scheduled: job.scheduled, failed: job.failed, deduplicated: job.deduplicated }); } catch {}
    _notifyTelegram(`Facebook batch ${job.jobId} đã xong: ${job.scheduled} hẹn thành công, ${job.deduplicated} trùng đã gom, ${job.failed} lỗi. Trạng thái: ${job.status}.`);
  } catch (e) {
    job.status = 'failed';
    job.error = String(e && e.message || e).slice(0, 500);
    job.finishedAt = _nowIso();
    _persist(job);
  }
}

function _readJobFile(jobId) {
  try { return JSON.parse(fs.readFileSync(_jobPath(jobId), 'utf-8')); }
  catch { return null; }
}

function _findExistingByFingerprint(fingerprint) {
  const activeId = _batchIndex.get(fingerprint);
  if (activeId) return { jobId: activeId, active: _jobs.has(activeId), job: _jobs.get(activeId) || _readJobFile(activeId) };
  let files = [];
  try { files = fs.readdirSync(_jobDir()).filter(f => f.endsWith('.json')); } catch { return null; }
  const matches = [];
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(_jobDir(), file), 'utf-8'));
      if (job && job.fingerprint === fingerprint) matches.push(job);
    } catch {}
  }
  if (!matches.length) return null;
  matches.sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
  const preferred = matches.find(j => j.status !== 'failed') || matches[0];
  _batchIndex.set(fingerprint, preferred.jobId);
  return { jobId: preferred.jobId, active: false, job: preferred };
}

function _newJob(jobId, normalized) {
  const now = _nowIso();
  return {
    jobId,
    fingerprint: normalized.fingerprint,
    status: 'queued',
    total: normalized.items.length,
    scheduled: 0,
    failed: 0,
    deduplicated: 0,
    skipped: 0,
    paused: 0,
    pauseReason: null,
    resumeAt: null,
    resumeAttempt: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    summary: normalized.summary,
    items: normalized.items,
  };
}

function _mergePersistedStatus(job, persisted) {
  const byItemId = new Map((persisted.items || []).map(i => [i.itemId, i]));
  for (const item of job.items) {
    const old = byItemId.get(item.itemId);
    if (!old) continue;
    if (['scheduled', 'deduplicated', 'failed', 'skipped', 'paused'].includes(old.status)) {
      item.status = old.status;
      item.attempts = old.attempts || item.attempts;
      item.postId = old.postId || null;
      item.error = old.error || null;
      item.startedAt = old.startedAt || null;
      item.finishedAt = old.finishedAt || null;
      item.deduplicatedFrom = old.deduplicatedFrom || null;
    } else if (old.status === 'running') {
      item.status = 'failed';
      item.attempts = old.attempts || item.attempts;
      item.error = 'Không rõ kết quả lần tạo lịch trước sau khi app khởi động lại; em không tự tạo lại để tránh trùng trên Facebook Planner.';
      item.startedAt = old.startedAt || null;
      item.finishedAt = _nowIso();
    }
  }
  job.status = persisted.status === 'paused' ? 'paused' : job.status;
  job.pauseReason = persisted.pauseReason || null;
  job.resumeAt = persisted.resumeAt || null;
  job.resumeAttempt = persisted.resumeAttempt || 0;
  job.startedAt = persisted.startedAt || job.startedAt;
  job.finishedAt = null;
  return job;
}

function _startRunner(job) {
  _jobs.set(job.jobId, job);
  _batchIndex.set(job.fingerprint, job.jobId);
  _persist(job);
  setImmediate(() => { _runJob(job).catch(e => console.warn('[fb-native-batch] run failed:', e && e.message)); });
}

async function startBatch(input) {
  const normalized = _normalizeBatch(input || {});
  const existing = _findExistingByFingerprint(normalized.fingerprint);
  if (existing) {
    const st = getBatchStatus(existing.jobId);
    if (st.status === 'done' || (st.status === 'partial' && !(st.paused > 0))) {
      return { success: true, jobId: existing.jobId, status: st.status, deduplicated: true, retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(existing.jobId)}` };
    }
    if (existing.active && st.status !== 'failed' && !(st.status === 'partial' && st.paused > 0)) {
      return { success: true, jobId: existing.jobId, status: st.status, deduplicated: true, retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(existing.jobId)}` };
    }
    if (st.status === 'paused' && st.resumeAt && Date.parse(st.resumeAt) > Date.now()) {
      return { success: true, jobId: existing.jobId, status: 'paused', deduplicated: true, retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(existing.jobId)}` };
    }
    if (st.status !== 'failed') {
      const resumed = _mergePersistedStatus(_newJob(existing.jobId, normalized), existing.job || {});
      _rehydrateTokens(resumed);
      if (resumed.status === 'paused' || (st.status === 'partial' && st.paused > 0)) _preparePausedJobForResume(resumed);
      _startRunner(resumed);
      return { success: true, jobId: existing.jobId, status: 'running', resumed: true, deduplicated: true, retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(existing.jobId)}` };
    }
  }
  const activeCount = [..._jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
  if (activeCount >= MAX_ACTIVE_JOBS) throw new Error(`Đang có ${activeCount} batch Facebook chạy, thử lại sau khi batch hiện tại xong`);
  const jobId = `fbnb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const job = _newJob(jobId, normalized);
  _startRunner(job);
  return { success: true, jobId, status: 'running', retryStatusUrl: `/api/fb/schedule-batch/status?jobId=${encodeURIComponent(jobId)}` };
}

function getBatchStatus(jobId) {
  const id = String(jobId || '').trim();
  if (!/^fbnb_[A-Za-z0-9_-]+$/.test(id)) return { success: false, error: 'jobId không hợp lệ' };
  const live = _jobs.get(id);
  if (live) {
    if (_resumeDue(live)) _resumeJobNow(id);
    return { success: true, ..._publicJob(_jobs.get(id) || live) };
  }
  try {
    const job = JSON.parse(fs.readFileSync(_jobPath(id), 'utf-8'));
    if (job && job.fingerprint) _batchIndex.set(job.fingerprint, job.jobId);
    if (_resumeDue(job)) {
      _rehydrateTokens(job);
      _jobs.set(job.jobId, job);
      _resumeJobNow(job.jobId);
      return { success: true, ..._publicJob(_jobs.get(job.jobId) || job) };
    }
    if (job && job.status === 'paused') _scheduleResume(_jobs.get(job.jobId) || job);
    return { success: true, ..._publicJob(job) };
  } catch {
    return { success: false, error: 'Không tìm thấy batch Facebook: ' + id };
  }
}

function listBatchJobs(limit = 20) {
  let files = [];
  try { files = fs.readdirSync(_jobDir()).filter(f => f.endsWith('.json')); } catch { return { success: true, jobs: [] }; }
  const jobs = files.map(f => {
    try {
      const p = path.join(_jobDir(), f);
      const job = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { jobId: job.jobId, status: job.status, total: job.total, scheduled: job.scheduled, failed: job.failed, deduplicated: job.deduplicated, updatedAt: job.updatedAt };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { success: true, jobs: jobs.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))) };
}

module.exports = {
  previewBatch,
  startBatch,
  getBatchStatus,
  listBatchJobs,
  _test: {
    setPublisher(pub) { _publisher = pub; },
    setNotifier(fn) { _notifyOverride = fn; },
    setDripConfig: _setDripConfig,
    resumeJobNow: _resumeJobNow,
    resetForTest() { _jobs.clear(); _batchIndex.clear(); _notifyOverride = null; _resetDripForTest(); _publisher = require('./fb-publisher'); },
    dropActiveJob(jobId) { _jobs.delete(jobId); },
    waitForJob(jobId, timeoutMs = 5000) {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const tick = () => {
          const st = getBatchStatus(jobId);
          if (st.success && ['done', 'partial', 'failed', 'paused'].includes(st.status)) return resolve(st);
          if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for job ' + jobId));
          setTimeout(tick, 10);
        };
        tick();
      });
    },
  },
};
