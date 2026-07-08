'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');
const { getWorkspace } = require('./workspace');
const { sanitizeTelegramChatId } = require('./telegram-directory');

const BINDINGS_FILE = 'telegram-session-bindings.json';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function compactTelegramBindingText(value, max = 220) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeTelegramThreadId(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return /^-?\d{1,64}$/.test(s) ? s : '';
}

function getTelegramSessionBindingsPath(workspace = getWorkspace()) {
  if (!workspace) return null;
  return path.join(workspace, BINDINGS_FILE);
}

function makeTelegramConversationBindingKey({ chatId, threadId = '' } = {}) {
  const id = sanitizeTelegramChatId(chatId);
  if (!id) return '';
  const topic = sanitizeTelegramThreadId(threadId);
  return topic ? `telegram:${id}:thread:${topic}` : `telegram:${id}`;
}

function normalizeTtlMs(value, fallback = DEFAULT_TTL_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.floor(n));
}

function normalizeBindingRecord(raw = {}, now = Date.now()) {
  const chatId = sanitizeTelegramChatId(raw.chatId || raw.targetChatId);
  const threadId = sanitizeTelegramThreadId(raw.threadId || raw.topicId);
  const sessionKey = compactTelegramBindingText(raw.sessionKey || raw.childSessionKey || raw.agentSessionKey, 260);
  if (!chatId || !sessionKey) return null;
  const bindingKey = makeTelegramConversationBindingKey({ chatId, threadId });
  const ttlMs = normalizeTtlMs(raw.ttlMs, DEFAULT_TTL_MS);
  const lastTouchedAt = Number(raw.lastTouchedAt) > 0 ? Math.floor(Number(raw.lastTouchedAt)) : now;
  const boundAt = Number(raw.boundAt) > 0 ? Math.floor(Number(raw.boundAt)) : lastTouchedAt;
  const expiresAt = Number(raw.expiresAt) > 0 ? Math.floor(Number(raw.expiresAt)) : lastTouchedAt + ttlMs;
  if (expiresAt <= now) return null;
  return {
    bindingKey,
    channel: 'telegram',
    chatId,
    threadId,
    entityId: `telegram:${chatId}`,
    sessionKey,
    agentId: compactTelegramBindingText(raw.agentId || 'main', 120),
    label: compactTelegramBindingText(raw.label || '', 160),
    boundAt,
    lastTouchedAt,
    ttlMs,
    expiresAt,
  };
}

function readTelegramSessionBindings(workspace = getWorkspace()) {
  const p = getTelegramSessionBindingsPath(workspace);
  try {
    if (!p || !fs.existsSync(p)) return { version: 1, bindings: [] };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const rawBindings = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.bindings)
        ? parsed.bindings
        : Object.values(parsed?.bindings || {});
    const now = Date.now();
    return {
      version: Number(parsed?.version) || 1,
      updatedAt: parsed?.updatedAt || '',
      bindings: rawBindings.map(item => normalizeBindingRecord(item, now)).filter(Boolean),
    };
  } catch {
    return { version: 1, bindings: [] };
  }
}

function writeTelegramSessionBindings(bindings = [], workspace = getWorkspace()) {
  const p = getTelegramSessionBindingsPath(workspace);
  if (!p) return false;
  const now = Date.now();
  const clean = bindings
    .map(item => normalizeBindingRecord(item, now))
    .filter(Boolean)
    .sort((a, b) => (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0));
  writeJsonAtomic(p, {
    version: 1,
    updatedAt: new Date().toISOString(),
    bindings: clean,
  });
  return true;
}

function bindTelegramSession(params = {}) {
  const now = Date.now();
  const record = normalizeBindingRecord({
    ...params,
    sessionKey: params.sessionKey || params.childSessionKey || params.agentSessionKey,
    lastTouchedAt: now,
    boundAt: params.boundAt || now,
    expiresAt: params.expiresAt || (now + normalizeTtlMs(params.ttlMs, DEFAULT_TTL_MS)),
  }, now);
  if (!record) return null;
  const current = readTelegramSessionBindings().bindings
    .filter(item => item.bindingKey !== record.bindingKey && item.sessionKey !== record.sessionKey);
  current.unshift(record);
  writeTelegramSessionBindings(current);
  return record;
}

function resolveTelegramSessionByConversation(params = {}) {
  const bindingKey = makeTelegramConversationBindingKey(params);
  if (!bindingKey) return null;
  return readTelegramSessionBindings().bindings.find(item => item.bindingKey === bindingKey) || null;
}

function resolveTelegramConversationBySession(sessionKey) {
  const key = compactTelegramBindingText(sessionKey, 260);
  if (!key) return null;
  return readTelegramSessionBindings().bindings.find(item => item.sessionKey === key) || null;
}

function touchTelegramSessionBinding(params = {}) {
  const binding = params.sessionKey
    ? resolveTelegramConversationBySession(params.sessionKey)
    : resolveTelegramSessionByConversation(params);
  if (!binding) return null;
  return bindTelegramSession({
    ...binding,
    ttlMs: binding.ttlMs,
    label: params.label || binding.label,
  });
}

module.exports = {
  BINDINGS_FILE,
  DEFAULT_TTL_MS,
  compactTelegramBindingText,
  sanitizeTelegramThreadId,
  getTelegramSessionBindingsPath,
  makeTelegramConversationBindingKey,
  readTelegramSessionBindings,
  writeTelegramSessionBindings,
  bindTelegramSession,
  resolveTelegramSessionByConversation,
  resolveTelegramConversationBySession,
  touchTelegramSessionBinding,
};
