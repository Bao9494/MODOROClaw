'use strict';
// Append-only raw ground-truth archive of Telegram messages.
//
// Layout: <workspace>/telegram-history/<chatId>.jsonl
//   - chatId = Telegram private/group/channel id.
//   - one normalized message per line, append-only, dedup by messageId per chat.
//   - threadId/topicId is stored inside each line so one group can have topics.
//
// The archive intentionally mirrors the Zalo archive principle: runtime cache and
// provider cache may be thin or replaced, while this workspace-owned mirror stays
// durable and can be used later for profile summaries.

const fs = require('fs');
const path = require('path');
const { sanitizeTelegramChatId } = require('./telegram-directory');
const { sanitizeTelegramThreadId } = require('./telegram-session-bindings');
const { sanitizeTelegramMessageId } = require('./telegram-message-refs');
const { normalizeTelegramMemberMetadata } = require('./telegram-member-metadata');

const TELEGRAM_HISTORY_DIR = 'telegram-history';
const DEDUP_TAIL_BYTES = 256 * 1024;
const DEFAULT_HISTORY_LIMIT = 200;

function archiveRoot(ws) {
  const base = ws || (function () {
    try { return require('./workspace').getWorkspace(); } catch { return null; }
  })();
  if (!base) return null;
  return path.join(base, TELEGRAM_HISTORY_DIR);
}

function _fileFor(ws, chatId) {
  const id = sanitizeTelegramChatId(chatId);
  const root = archiveRoot(ws);
  if (!id || !root) return null;
  return path.join(root, `${id}.jsonl`);
}

function _existingMessageIds(file) {
  const seen = new Set();
  let raw;
  try {
    const size = fs.statSync(file).size;
    if (size > DEDUP_TAIL_BYTES) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(DEDUP_TAIL_BYTES);
        const n = fs.readSync(fd, buf, 0, DEDUP_TAIL_BYTES, size - DEDUP_TAIL_BYTES);
        raw = buf.toString('utf-8', 0, n);
      } finally {
        fs.closeSync(fd);
      }
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(file, 'utf-8');
    }
  } catch {
    return seen;
  }
  for (const line of String(raw || '').split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.messageId != null) seen.add(String(parsed.messageId));
    } catch {}
  }
  return seen;
}

function compactHistoryText(value, max = 4000) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTimestamp(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 100000000000 ? Math.floor(n) : Math.floor(n * 1000);
  return Date.now();
}

function normalizeTelegramHistoryEvent(raw = {}) {
  const chatId = sanitizeTelegramChatId(raw.chatId || raw.targetChatId || raw.telegramChatId || raw.originChatId || raw.replyChatId);
  if (!chatId) return null;
  const messageId = sanitizeTelegramMessageId(raw.messageId || raw.telegramMessageId || raw.msgId || raw.id);
  if (!messageId) return null;
  const direction = ['inbound', 'outbound'].includes(String(raw.direction || '').toLowerCase())
    ? String(raw.direction).toLowerCase()
    : 'inbound';
  const ts = normalizeTimestamp(raw.timestamp || raw.ts || raw.date);
  const member = normalizeTelegramMemberMetadata({ ...raw, chatId });
  return {
    messageId,
    ts,
    iso: new Date(ts).toISOString(),
    channel: 'telegram',
    direction,
    chatId,
    threadId: sanitizeTelegramThreadId(raw.threadId || raw.topicId || raw.messageThreadId || raw.telegramThreadId),
    senderId: compactHistoryText(raw.senderId || raw.telegramSenderId || raw.fromId || '', 80),
    senderName: compactHistoryText(raw.senderName || raw.senderDisplayName || raw.fromName || '', 160),
    senderRole: compactHistoryText(raw.senderRole || raw.fromRole || '', 40),
    memberStatus: compactHistoryText(member.memberStatus || 'unknown', 40),
    memberTitle: compactHistoryText(member.memberTitle || '', 120),
    isOwner: !!member.isOwner,
    isAdmin: !!member.isAdmin,
    isMember: !!member.isMember,
    chatType: compactHistoryText(raw.chatType || raw.telegramChatType || '', 40),
    label: compactHistoryText(raw.label || raw.title || raw.chatTitle || '', 180),
    text: compactHistoryText(raw.text || raw.body || raw.message || raw.caption || ''),
    hasMedia: !!(raw.hasMedia || raw.media || raw.photo || raw.document || raw.imagePath),
    source: compactHistoryText(raw.source || 'runtime-capture', 80),
    sessionKey: compactHistoryText(raw.sessionKey || raw.agentSessionKey || '', 260),
    replyToMessageId: sanitizeTelegramMessageId(raw.replyToMessageId || raw.replyTo || raw.quoteMessageId),
  };
}

function appendTelegramHistoryEvents(ws, events = []) {
  try {
    const rows = Array.isArray(events) ? events : [events];
    const byChat = new Map();
    for (const raw of rows) {
      const line = normalizeTelegramHistoryEvent(raw);
      if (!line) continue;
      if (!byChat.has(line.chatId)) byChat.set(line.chatId, []);
      byChat.get(line.chatId).push(line);
    }
    let appended = 0;
    for (const [chatId, lines] of byChat.entries()) {
      const file = _fileFor(ws, chatId);
      if (!file) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const seen = _existingMessageIds(file);
      const out = [];
      for (const line of lines) {
        if (seen.has(line.messageId)) continue;
        seen.add(line.messageId);
        out.push(JSON.stringify(line));
      }
      if (!out.length) continue;
      fs.appendFileSync(file, out.join('\n') + '\n', 'utf-8'); // SACRED-OK: append-only Telegram archive
      appended += out.length;
    }
    return { appended };
  } catch (e) {
    console.error('[telegram-history] append failed (non-blocking):', e && e.message);
    return { appended: 0, error: e && e.message ? e.message : String(e) };
  }
}

function appendTelegramHistoryEvent(ws, event = {}) {
  return appendTelegramHistoryEvents(ws, [event]);
}

function readTelegramHistory(ws, chatId, { limit = DEFAULT_HISTORY_LIMIT, since = null, until = null, threadId = '' } = {}) {
  try {
    const file = _fileFor(ws, chatId);
    if (!file) return [];
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    let rows = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
    const topic = sanitizeTelegramThreadId(threadId);
    if (topic) rows = rows.filter(row => String(row.threadId || '') === topic);
    if (since != null) {
      const s = Number(since);
      if (Number.isFinite(s)) rows = rows.filter(row => (Number(row.ts) || 0) >= s);
    }
    if (until != null) {
      const u = Number(until);
      if (Number.isFinite(u)) rows = rows.filter(row => (Number(row.ts) || 0) <= u);
    }
    const n = Number(limit) > 0 ? Number(limit) : rows.length;
    return rows.slice(-n);
  } catch (e) {
    console.error('[telegram-history] read failed:', e && e.message);
    return [];
  }
}

function listTelegramHistoryChats(ws) {
  try {
    const root = archiveRoot(ws);
    if (!root) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^-?\d{5,32}\.jsonl$/.test(entry.name))
      .map(entry => entry.name.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

module.exports = {
  TELEGRAM_HISTORY_DIR,
  DEFAULT_HISTORY_LIMIT,
  archiveRoot,
  _fileFor,
  _existingMessageIds,
  normalizeTelegramHistoryEvent,
  appendTelegramHistoryEvent,
  appendTelegramHistoryEvents,
  readTelegramHistory,
  listTelegramHistoryChats,
};
