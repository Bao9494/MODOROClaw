'use strict';
const fs = require('fs');
const path = require('path');
const { rejectIfBooting } = require('./gateway');
const { getTelegramConfigWithRecovery } = require('./channels');
const { spawnOpenClawSafe } = require('./boot');
const { buildAgentArgs } = require('./cron');
const { buildSkillInjectionBlock } = require('./skill-manager');
const { getWorkspace } = require('./workspace');

const CHAT_HISTORY_MAX_BYTES = 512 * 1024; // 512KB cap
const MAX_DATA_URL_SIZE = 10 * 1024 * 1024; // 10MB — reject images larger than this
const DATA_URL_CACHE_MAX_SIZE = 50;
const CHAT_RATE_LIMIT_MS = 3000;
const CHAT_MAX_MESSAGE_LENGTH = 10000;
const IMAGE_PICKUP_TIMEOUT_S = 90;
const IMAGE_PICKUP_POLL_MS = 5000;
const IMAGE_PICKUP_MAX_WINDOW_MS = 10 * 60 * 1000;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME_MAP = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const _dataUrlCache = new Map();
let _chatLastSendTs = 0;

function _toDataUrl(urlOrPath) {
  if (!urlOrPath) return null;
  if (urlOrPath.startsWith('data:') || urlOrPath.startsWith('http')) return urlOrPath;
  const cached = _dataUrlCache.get(urlOrPath);
  if (cached) {
    _dataUrlCache.delete(urlOrPath);
    _dataUrlCache.set(urlOrPath, cached);
    return cached;
  }
  try {
    const ext = path.extname(urlOrPath).toLowerCase();
    const mime = MIME_MAP[ext];
    if (!mime || !fs.existsSync(urlOrPath)) return null;
    const buf = fs.readFileSync(urlOrPath);
    if (buf.length > MAX_DATA_URL_SIZE) return null;
    const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    _dataUrlCache.set(urlOrPath, dataUrl);
    if (_dataUrlCache.size > DATA_URL_CACHE_MAX_SIZE) {
      const first = _dataUrlCache.keys().next().value;
      _dataUrlCache.delete(first);
    }
    return dataUrl;
  } catch { return null; }
}

function _looksLikeImageGenReply(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return t.includes('tạo ảnh') || t.includes('tạo hình') || t.includes('generating')
    || t.includes('đang tạo') || t.includes('gửi qua telegram')
    || (t.includes('image') && (t.includes('generat') || t.includes('creat')));
}

function _pickupRecentImages(sinceTs) {
  const ws = getWorkspace();
  if (!ws) return [];
  const results = [];
  const maxWindow = IMAGE_PICKUP_MAX_WINDOW_MS;
  const dir = path.join(ws, 'brand-assets', 'generated');
  try {
    if (!fs.existsSync(dir)) return [];
    for (const f of fs.readdirSync(dir)) {
      if (!IMAGE_EXTS.has(path.extname(f).toLowerCase())) continue;
      const fp = path.join(dir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs >= sinceTs && st.mtimeMs <= sinceTs + maxWindow && st.size > 1024) {
          results.push({ fp, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
  } catch {}
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, 4).map(r => r.fp);
}

function _getChatHistoryPath() {
  const ws = getWorkspace();
  if (!ws) return null;
  const logsDir = path.join(ws, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  return path.join(logsDir, 'chat-history.jsonl');
}

function _appendChatEntry(role, text, ts, mediaUrls) {
  const fp = _getChatHistoryPath();
  if (!fp) return;
  try {
    const entry = JSON.stringify({ role, text, ts, mediaUrls: mediaUrls || [] }) + '\n';
    fs.appendFileSync(fp, entry, 'utf-8');
  } catch (e) {
    console.warn('[chat] history append failed:', e?.message);
  }
}

function _trimChatHistoryIfNeeded(fp) {
  try {
    const stat = fs.statSync(fp);
    if (stat.size <= CHAT_HISTORY_MAX_BYTES) return;
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const half = Math.floor(lines.length / 2);
    const trimmed = lines.slice(half).join('\n') + '\n';
    const tmpPath = fp + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, trimmed, 'utf-8');
    fs.renameSync(tmpPath, fp);
  } catch (e) {
    console.warn('[chat] trim failed:', e?.message);
  }
}

// Lazy-match user-skills injection: read registry, filter by trigger keywords
// against the CEO's current chat message, inject ONLY matching skills.
// Replaces the earlier eager INLINE.md merge that loaded all skills every turn.
function _injectActiveSkills(text) {
  try {
    const block = buildSkillInjectionBlock(text, { scope: 'operations/telegram-ceo' });
    if (!block) return text;
    return `<active-user-skills>\n${block}\n</active-user-skills>\n\n${text}`;
  } catch { return text; }
}

function _inferMemoryTaskType(text) {
  const t = String(text || '').toLowerCase();
  if (/sheet|excel|xlsx|google/.test(t)) return 'google_workspace';
  if (/facebook|fanpage|insight|fb\b/.test(t)) return 'facebook';
  if (/zalo|whatsapp|telegram|lark/.test(t)) return 'channel_workflow';
  if (/docx|word|pptx|powerpoint|pdf|slide/.test(t)) return 'document_generation';
  if (/ảnh|hình|image|poster|banner/.test(t)) return 'image_generation';
  return '';
}

async function _injectMemoryOsContext(text, queryText) {
  try {
    const { getMemoryContext } = require('./ceo-memory');
    const ctx = await getMemoryContext({
      query: queryText || text,
      channel: 'app',
      taskType: _inferMemoryTaskType(queryText || text),
      limit: 8,
    });
    if (!ctx.memories?.length && !ctx.procedures?.length && !ctx.safetyWarnings?.length) return text;
    const compact = {
      scopes: ctx.scopes,
      memories: (ctx.memories || []).map(m => ({
        id: m.id,
        type: m.type,
        scope: m.scope,
        content: m.content,
        evidenceIds: m.evidence_event_ids || [],
      })),
      procedures: (ctx.procedures || []).map(m => ({
        id: m.id,
        scope: m.scope,
        content: m.content,
      })),
      safetyWarnings: ctx.safetyWarnings || [],
    };
    return `<memory-os-context trusted="true">\n${JSON.stringify(compact)}\n</memory-os-context>\n\n${text}`;
  } catch (e) {
    console.warn('[chat] memory context injection failed:', e?.message);
    return text;
  }
}

// Parse openclaw agent --json output. Handle 3 stdout formats:
//   1. Single-line JSON: `{"result":{"payloads":[{"text":"..."}]}}`
//   2. Multi-line pretty-printed JSON (openclaw default for --json)
//   3. Noise-prefixed (npm warnings / boot logs before JSON)
// Strategy: try whole stdout first, then find balanced JSON block, then
// line-by-line as last resort.
function _parseAgentJsonOutput(stdout) {
  if (!stdout) return null;
  const trimmed = String(stdout).trim();
  if (!trimmed) return null;

  const extract = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const payloads = parsed?.result?.payloads || parsed?.payloads || [];
    if (Array.isArray(payloads) && payloads.length > 0) {
      const first = payloads[0];
      const text = first?.text || '';
      const mediaUrls = first?.mediaUrls || first?.mediaUrl || [];
      const mediaArr = Array.isArray(mediaUrls) ? mediaUrls : (mediaUrls ? [mediaUrls] : []);
      if (text || mediaArr.length > 0) return { text, mediaUrls: mediaArr };
    }
    if (typeof parsed?.result?.text === 'string' && parsed.result.text.trim()) return { text: parsed.result.text, mediaUrls: [] };
    if (typeof parsed?.text === 'string' && parsed.text.trim()) return { text: parsed.text, mediaUrls: [] };
    return null;
  };

  // Strategy 1: try parsing entire trimmed stdout (handles pretty-printed JSON).
  try {
    const reply = extract(JSON.parse(trimmed));
    if (reply) return reply;
  } catch {}

  // Strategy 2: find the LAST balanced JSON block in stdout (handles noise-prefixed).
  // Walk from end, find last `}`, then scan back for matching `{`.
  const lastClose = trimmed.lastIndexOf('}');
  if (lastClose !== -1) {
    let depth = 0;
    let startIdx = -1;
    for (let i = lastClose; i >= 0; i--) {
      const ch = trimmed[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        depth--;
        if (depth === 0) { startIdx = i; break; }
      }
    }
    if (startIdx !== -1) {
      try {
        const reply = extract(JSON.parse(trimmed.slice(startIdx, lastClose + 1)));
        if (reply) return reply;
      } catch {}
    }
  }

  // Strategy 3: line-by-line scan for single-line JSON (legacy fallback).
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const reply = extract(JSON.parse(line));
      if (reply) return reply;
    } catch {}
  }

  // Diagnostic: dump first 500 chars of stdout when ALL parse strategies fail.
  // This lets CEO send the log to support to debug openclaw output drift.
  console.warn('[chat] parse failed — stdout sample:', trimmed.slice(0, 500));
  return null;
}

// Parse [SUGGESTIONS] block from bot reply
function _extractSuggestions(text) {
  const match = text.match(/\[SUGGESTIONS\]\n([\s\S]*?)\n\[\/SUGGESTIONS\]/);
  if (!match) return { cleanText: text, suggestions: [] };
  const suggestions = match[1].split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  return { cleanText: text.replace(match[0], '').trim(), suggestions };
}

// Parse [ACTIONS] block from bot reply
function _extractActions(text) {
  const match = text.match(/\[ACTIONS\]\n([\s\S]*?)\n\[\/ACTIONS\]/);
  if (!match) return { cleanText: text, actions: [] };
  const actions = match[1].split('\n').map(l => {
    const [label, action] = l.replace(/^-\s*/, '').split('|');
    return { label: (label || '').trim(), action: (action || '').trim() };
  }).filter(a => a.label).slice(0, 4);
  return { cleanText: text.replace(match[0], '').trim(), actions };
}

// Reset in sendChatMessage — declaration value is only for type inference
let _chatGenerationAborted = false;
let _chatAbortController = null;

async function sendChatMessage(text) {
  if (Date.now() - (_chatLastSendTs || 0) < CHAT_RATE_LIMIT_MS) return { ok: false, error: 'rate_limited' };
  if (text.length > CHAT_MAX_MESSAGE_LENGTH) return { ok: false, error: 'message_too_long' };

  const bootCheck = rejectIfBooting('send-chat-message');
  if (bootCheck) return { ok: false, error: 'BOOT_IN_PROGRESS' };
  _chatLastSendTs = Date.now();

  let chatId;
  try {
    const cfg = await getTelegramConfigWithRecovery();
    chatId = cfg?.chatId;
  } catch {}
  if (!chatId) return { ok: false, error: 'no_chat_id' };

  // --json + --channel/--to without --reply-channel/--reply-to: openclaw
  // returns the agent's reply as JSON and does NOT deliver to Telegram.
  // This is the same pattern cron.js uses for journaled agent runs that
  // we deliver ourselves to Zalo — proven safe in production.
  if (_chatAbortController) { try { _chatAbortController.abort(); } catch {} }
  _chatAbortController = new AbortController();
  _chatGenerationAborted = false;
  const enrichedText = await _injectMemoryOsContext(_injectActiveSkills(text), text);
  const args = buildAgentArgs(enrichedText, chatId, true);
  args.push('--session-id', 'dashboard-chat');

  const sendTs = Date.now();
  _appendChatEntry('user', text, sendTs);

  try {
    const res = await spawnOpenClawSafe(args, {
      timeoutMs: 600000,
      allowCmdShellFallback: !text.includes('\n'),
      signal: _chatAbortController.signal,
    });
    if (_chatGenerationAborted || res.aborted) {
      return { ok: false, error: 'aborted' };
    }

    if (res.code !== 0) {
      const errSnippet = (res.stderr || res.stdout || '').slice(0, 300);
      console.error('[chat] agent failed (exit ' + res.code + '):', errSnippet);
      if (errSnippet.toLowerCase().includes('gateway not running') || errSnippet.toLowerCase().includes('econnrefused')) {
        return { ok: false, error: 'gateway_offline' };
      }
      return { ok: false, error: 'agent_error', detail: errSnippet.slice(0, 100) };
    }

    const parsed = _parseAgentJsonOutput(res.stdout);
    if (!parsed) {
      return { ok: true, reply: 'Trợ lý đã xử lý nhưng không có nội dung trả lời.', suggestions: [], actions: [] };
    }
    const rawReply = parsed.text || '';
    const { cleanText: t1, suggestions } = _extractSuggestions(rawReply);
    const { cleanText: finalReply, actions } = _extractActions(t1);
    let mediaUrls = parsed.mediaUrls || [];
    if (!mediaUrls.length) {
      mediaUrls = _pickupRecentImages(sendTs);
      if (!mediaUrls.length && _looksLikeImageGenReply(finalReply)) {
        console.log(`[chat] reply mentions image gen — waiting up to ${IMAGE_PICKUP_TIMEOUT_S}s for image to appear`);
        const maxPolls = Math.ceil(IMAGE_PICKUP_TIMEOUT_S * 1000 / IMAGE_PICKUP_POLL_MS);
        for (let _w = 0; _w < maxPolls && !mediaUrls.length; _w++) {
          await new Promise(r => setTimeout(r, IMAGE_PICKUP_POLL_MS));
          if (_chatGenerationAborted) break;
          mediaUrls = _pickupRecentImages(sendTs);
        }
        if (mediaUrls.length) console.log('[chat] image arrived after waiting');
      }
    }
    const displayUrls = mediaUrls.map(_toDataUrl).filter(Boolean);
    _appendChatEntry('assistant', finalReply, Date.now(), mediaUrls);
    const hp = _getChatHistoryPath();
    if (hp) _trimChatHistoryIfNeeded(hp);
    return { ok: true, reply: finalReply, mediaUrls: displayUrls, suggestions, actions };
  } catch (e) {
    console.error('[chat] spawn error:', e?.message || e);
    return { ok: false, error: 'spawn_error' };
  }
}

function getChatHistory(maxMessages = 50) {
  const fp = _getChatHistoryPath();
  if (!fp || !fs.existsSync(fp)) return [];
  try {
    const content = fs.readFileSync(fp, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e && e.role && typeof e.ts === 'number') entries.push(e);
      } catch {}
    }
    const recent = entries.slice(-maxMessages);
    for (const e of recent) {
      if (Array.isArray(e.mediaUrls) && e.mediaUrls.length) {
        e.mediaUrls = e.mediaUrls.map(_toDataUrl).filter(Boolean);
      }
    }
    return recent;
  } catch (e) {
    console.warn('[chat] history read failed:', e?.message);
    return [];
  }
}

function clearChatHistory() {
  try {
    const fp = _getChatHistoryPath();
    if (fp && fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf-8');
    return { success: true };
  } catch (e) { return { error: e.message }; }
}

function stopGeneration() {
  _chatGenerationAborted = true;
  if (_chatAbortController) { try { _chatAbortController.abort(); } catch {} }
  return { stopped: true };
}

function registerChatIpc() {
  const { ipcMain } = require('electron');
  ipcMain.handle('send-chat-message', async (_ev, text) => {
    if (!text || typeof text !== 'string') return { ok: false, error: 'empty_message' };
    return sendChatMessage(text.trim());
  });
  ipcMain.handle('get-chat-history', async () => {
    return getChatHistory();
  });
  ipcMain.handle('clear-chat-history', async () => {
    try { return clearChatHistory(); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('stop-chat-generation', async () => {
    try { return stopGeneration(); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('log-chat-feedback', async (_ev, { rating, msgTs }) => {
    try {
      const ws = getWorkspace();
      if (!ws) return { error: 'no workspace' };
      const fp = path.join(ws, 'logs', 'chat-feedback.jsonl');
      fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), rating, msgTs }) + '\n', 'utf-8');
      return { success: true };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('upload-chat-file', async (_ev, { filePath, fileName }) => {
    try {
      if (!fileName || /[\/\\]/.test(fileName) || fileName.includes('..'))
        return { error: 'Invalid filename' };
      if (!filePath || !fs.existsSync(filePath)) return { error: 'File not found' };
      const srcExt = path.extname(filePath).toLowerCase();
      const nameExt = path.extname(fileName).toLowerCase();
      if (srcExt !== nameExt) return { error: 'Extension mismatch' };
      const stat = fs.statSync(filePath);
      if (stat.size > 10 * 1024 * 1024) return { error: 'File quá lớn (tối đa 10MB)' };
      const allowed = ['.pdf', '.docx', '.xlsx', '.jpg', '.jpeg', '.png', '.txt'];
      if (!allowed.includes(path.extname(fileName).toLowerCase()))
        return { error: 'Định dạng không hỗ trợ' };
      const ws = getWorkspace();
      if (!ws) return { error: 'no workspace' };
      const uploadsDir = path.join(ws, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const dest = path.join(uploadsDir, safeName);
      fs.copyFileSync(filePath, dest);
      return { path: dest, name: fileName };
    } catch (e) { return { error: e.message }; }
  });
}

module.exports = { sendChatMessage, getChatHistory, clearChatHistory, stopGeneration, registerChatIpc };
