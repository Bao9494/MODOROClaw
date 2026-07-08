'use strict';

const {
  normalizeTelegramChatType,
  isTelegramGroupLike,
  buildTelegramConversationPolicy,
  compareTelegramRoles,
  normalizeTelegramEnabled,
} = require('./telegram-policy');

function sanitizeTelegramChatId(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return /^-?\d{5,32}$/.test(s) ? s : '';
}

function telegramDirectoryEntityId(chatId) {
  const id = sanitizeTelegramChatId(chatId);
  return id ? `telegram:${id}` : '';
}

function compactTelegramDirectoryText(value, max = 160) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTelegramDirectorySearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Ä‘/g, 'd')
    .replace(/Ä/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9@_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTelegramAliases(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n;]/);
  return [...new Set(items
    .map(v => compactTelegramDirectoryText(v, 120))
    .filter(Boolean))];
}

function mergeTelegramAliases(...values) {
  const out = [];
  for (const value of values) {
    for (const alias of normalizeTelegramAliases(value)) out.push(alias);
  }
  return [...new Set(out)];
}

function telegramDirectoryKind(chatType = '') {
  const type = normalizeTelegramChatType(chatType);
  if (type === 'private') return 'private';
  if (type === 'channel') return 'channel';
  if (type === 'group' || type === 'supergroup') return 'group';
  return 'unknown';
}

function buildTelegramDirectoryEntry(row = {}) {
  const chatId = sanitizeTelegramChatId(row.chatId || row.telegramChatId || row.targetChatId);
  if (!chatId) return null;
  const policy = buildTelegramConversationPolicy(row);
  const label = compactTelegramDirectoryText(row.label || row.title || row.username || `Telegram ${chatId}`, 120);
  const username = compactTelegramDirectoryText(row.username || row.handle || '', 120);
  const aliases = mergeTelegramAliases(
    row.aliases,
    row.alias,
    row.title && row.title !== label ? row.title : '',
    username ? [username, username.replace(/^@/, '')] : []
  ).filter(alias => alias !== label);
  const kind = telegramDirectoryKind(policy.chatType);
  const sources = Array.isArray(row.sources)
    ? row.sources.map(s => compactTelegramDirectoryText(s, 60)).filter(Boolean)
    : normalizeTelegramAliases(row.source || '');
  const searchText = normalizeTelegramDirectorySearchText([
    chatId,
    telegramDirectoryEntityId(chatId),
    label,
    username,
    aliases.join(' '),
    row.summary || '',
    sources.join(' '),
  ].filter(Boolean).join(' '));
  return {
    chatId,
    targetChatId: chatId,
    entityId: telegramDirectoryEntityId(chatId),
    entityType: 'telegram_chat',
    label,
    title: label,
    username,
    aliases,
    chatType: policy.chatType,
    directoryKind: kind,
    isGroupLike: isTelegramGroupLike(policy.chatType),
    isPrivate: kind === 'private',
    role: policy.role,
    audience: policy.audience,
    scopeHints: policy.scopeHints,
    responseMode: policy.responseMode,
    toolScope: policy.toolScope,
    enabled: policy.enabled,
    policy,
    profilePath: row.profilePath || '',
    hasProfile: !!row.hasProfile,
    lastSeen: row.lastSeen || '',
    msgCount: Number(row.msgCount) || 0,
    summary: compactTelegramDirectoryText(row.summary || '', 260),
    sources,
    sourceCount: sources.length,
    mtimeMs: Number(row.mtimeMs) || 0,
    searchText,
  };
}

function sortTelegramDirectoryEntries(entries = []) {
  return [...entries].sort((a, b) => {
    const rr = compareTelegramRoles(a.role, b.role);
    if (rr !== 0) return rr;
    const ak = a.directoryKind === 'group' ? 0 : a.directoryKind === 'channel' ? 1 : a.directoryKind === 'private' ? 2 : 3;
    const bk = b.directoryKind === 'group' ? 0 : b.directoryKind === 'channel' ? 1 : b.directoryKind === 'private' ? 2 : 3;
    if (ak !== bk) return ak - bk;
    if ((b.mtimeMs || 0) !== (a.mtimeMs || 0)) return (b.mtimeMs || 0) - (a.mtimeMs || 0);
    return (a.label || '').localeCompare(b.label || '');
  });
}

function scoreTelegramDirectoryEntry(entry, query) {
  const raw = String(query || '').trim();
  if (!raw) return 1;
  const q = normalizeTelegramDirectorySearchText(raw);
  const chatId = String(entry.chatId || '');
  const entityId = String(entry.entityId || '');
  const label = normalizeTelegramDirectorySearchText(entry.label || '');
  const username = normalizeTelegramDirectorySearchText(entry.username || '');
  const aliases = normalizeTelegramDirectorySearchText((entry.aliases || []).join(' '));
  const searchText = entry.searchText || normalizeTelegramDirectorySearchText(JSON.stringify(entry));
  if (chatId === raw || entityId === raw || entityId === `telegram:${raw}`) return 1000;
  if (normalizeTelegramDirectorySearchText(chatId) === q || normalizeTelegramDirectorySearchText(entityId) === q) return 980;
  if (label === q || username === q || aliases.split(' ').includes(q)) return 920;
  if (label.includes(q) || username.includes(q) || aliases.includes(q)) return 760;
  const words = q.split(' ').filter(Boolean);
  if (words.length && words.every(w => searchText.includes(w))) return 700;
  if (searchText.includes(q)) return 420;
  return 0;
}

function optionalEnabledFilter(value) {
  if (value == null || value === '') return null;
  return normalizeTelegramEnabled(value, false);
}

function filterTelegramDirectoryEntries(entries = [], {
  query = '',
  role = '',
  chatType = '',
  kind = '',
  enabled = null,
  limit = 50,
} = {}) {
  const wantedRole = String(role || '').trim().toLowerCase();
  const wantedType = normalizeTelegramChatType(chatType || '');
  const wantedKind = String(kind || '').trim().toLowerCase();
  const enabledFilter = optionalEnabledFilter(enabled);
  const q = String(query || '').trim();
  return entries
    .map(entry => ({ ...entry, score: scoreTelegramDirectoryEntry(entry, q) }))
    .filter(entry => !q || entry.score > 0)
    .filter(entry => !wantedRole || entry.role === wantedRole)
    .filter(entry => !wantedType || wantedType === 'unknown' || entry.chatType === wantedType)
    .filter(entry => !wantedKind || entry.directoryKind === wantedKind)
    .filter(entry => enabledFilter == null || (entry.enabled !== false) === enabledFilter)
    .sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return sortTelegramDirectoryEntries([a, b])[0] === a ? -1 : 1;
    })
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

function summarizeTelegramDirectory(entries = []) {
  const counts = {
    total: entries.length,
    ceo: 0,
    internal: 0,
    customer: 0,
    unknown: 0,
    enabled: 0,
    group: 0,
    channel: 0,
    private: 0,
  };
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(counts, entry.role)) counts[entry.role] += 1;
    if (entry.enabled !== false) counts.enabled += 1;
    if (Object.prototype.hasOwnProperty.call(counts, entry.directoryKind)) counts[entry.directoryKind] += 1;
  }
  return counts;
}

module.exports = {
  sanitizeTelegramChatId,
  telegramDirectoryEntityId,
  compactTelegramDirectoryText,
  normalizeTelegramDirectorySearchText,
  normalizeTelegramAliases,
  mergeTelegramAliases,
  telegramDirectoryKind,
  buildTelegramDirectoryEntry,
  sortTelegramDirectoryEntries,
  scoreTelegramDirectoryEntry,
  filterTelegramDirectoryEntries,
  summarizeTelegramDirectory,
};
