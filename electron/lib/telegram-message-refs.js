'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');
const { getWorkspace } = require('./workspace');
const { sanitizeTelegramChatId } = require('./telegram-directory');
const { sanitizeTelegramThreadId, makeTelegramConversationBindingKey } = require('./telegram-session-bindings');

const MESSAGE_REFS_FILE = 'telegram-message-refs.json';
const MESSAGE_REF_TTL_MS = 6 * 60 * 60 * 1000;
const MESSAGE_REF_MAX = 4000;

function compactTelegramMessageText(value, max = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeTelegramMessageId(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return /^[0-9A-Za-z_-]{1,96}$/.test(s) ? s : '';
}

function getTelegramMessageRefsPath(workspace = getWorkspace()) {
  if (!workspace) return null;
  return path.join(workspace, MESSAGE_REFS_FILE);
}

function makeTelegramThreadKey({ chatId, threadId = '' } = {}) {
  return makeTelegramConversationBindingKey({ chatId, threadId });
}

function makeTelegramMessageCacheKey({ chatId, threadId = '', messageId } = {}) {
  const threadKey = makeTelegramThreadKey({ chatId, threadId });
  const msgId = sanitizeTelegramMessageId(messageId);
  return threadKey && msgId ? `${threadKey}:message:${msgId}` : '';
}

function normalizeMessageRef(raw = {}, now = Date.now()) {
  const chatId = sanitizeTelegramChatId(raw.chatId || raw.targetChatId);
  const threadId = sanitizeTelegramThreadId(raw.threadId || raw.topicId);
  const messageId = sanitizeTelegramMessageId(raw.messageId || raw.telegramMessageId || raw.msgId || raw.id);
  if (!chatId || !messageId) return null;
  const timestamp = Number(raw.timestamp) > 0 ? Math.floor(Number(raw.timestamp)) : now;
  if (timestamp + MESSAGE_REF_TTL_MS <= now) return null;
  const shortId = sanitizeTelegramMessageId(raw.shortId) || messageId;
  return {
    cacheKey: makeTelegramMessageCacheKey({ chatId, threadId, messageId }),
    threadKey: makeTelegramThreadKey({ chatId, threadId }),
    channel: 'telegram',
    chatId,
    threadId,
    messageId,
    replyToMessageId: sanitizeTelegramMessageId(raw.replyToMessageId || raw.replyTo || raw.quoteMessageId),
    shortId,
    direction: ['inbound', 'outbound'].includes(String(raw.direction || '').toLowerCase())
      ? String(raw.direction).toLowerCase()
      : 'inbound',
    senderId: compactTelegramMessageText(raw.senderId || raw.telegramSenderId || raw.fromId || '', 80),
    sessionKey: compactTelegramMessageText(raw.sessionKey || raw.agentSessionKey || '', 260),
    timestamp,
    preview: compactTelegramMessageText(raw.preview || raw.textPreview || raw.text || raw.body || '', 260),
  };
}

function readTelegramMessageRefs(workspace = getWorkspace()) {
  const p = getTelegramMessageRefsPath(workspace);
  try {
    if (!p || !fs.existsSync(p)) return { version: 1, refs: [] };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rawRefs = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.refs)
        ? parsed.refs
        : Object.values(parsed?.refs || {});
    const now = Date.now();
    return {
      version: Number(parsed?.version) || 1,
      updatedAt: parsed?.updatedAt || '',
      refs: rawRefs.map(item => normalizeMessageRef(item, now)).filter(Boolean),
    };
  } catch {
    return { version: 1, refs: [] };
  }
}

function writeTelegramMessageRefs(refs = [], workspace = getWorkspace()) {
  const p = getTelegramMessageRefsPath(workspace);
  if (!p) return false;
  const now = Date.now();
  const clean = refs
    .map(item => normalizeMessageRef(item, now))
    .filter(Boolean)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, MESSAGE_REF_MAX);
  writeJsonAtomic(p, {
    version: 1,
    updatedAt: new Date().toISOString(),
    refs: clean,
  });
  return true;
}

function rememberTelegramMessageRef(params = {}) {
  const entry = normalizeMessageRef(params, Date.now());
  if (!entry) return null;
  const current = readTelegramMessageRefs().refs
    .filter(item => item.cacheKey !== entry.cacheKey);
  current.unshift(entry);
  writeTelegramMessageRefs(current);
  return entry;
}

function getLatestTelegramMessageForThread(params = {}) {
  const threadKey = makeTelegramThreadKey(params);
  if (!threadKey) return null;
  return readTelegramMessageRefs().refs
    .filter(item => item.threadKey === threadKey)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
}

function resolveTelegramMessageRef(params = {}) {
  const chatId = sanitizeTelegramChatId(params.chatId || params.targetChatId);
  const threadId = sanitizeTelegramThreadId(params.threadId || params.topicId);
  const raw = String(params.rawId || params.messageId || params.shortId || '').trim();
  if (!chatId || !raw) return null;
  if (['latest', 'last', 'newest'].includes(raw.toLowerCase())) {
    return getLatestTelegramMessageForThread({ chatId, threadId });
  }
  const refs = readTelegramMessageRefs().refs;
  const exactId = sanitizeTelegramMessageId(raw);
  if (!exactId) return null;
  return refs.find(item =>
    item.chatId === chatId
    && item.threadId === threadId
    && (item.messageId === exactId || item.shortId === exactId)
  ) || null;
}

module.exports = {
  MESSAGE_REFS_FILE,
  MESSAGE_REF_TTL_MS,
  MESSAGE_REF_MAX,
  compactTelegramMessageText,
  sanitizeTelegramMessageId,
  getTelegramMessageRefsPath,
  makeTelegramThreadKey,
  makeTelegramMessageCacheKey,
  readTelegramMessageRefs,
  writeTelegramMessageRefs,
  rememberTelegramMessageRef,
  getLatestTelegramMessageForThread,
  resolveTelegramMessageRef,
};
