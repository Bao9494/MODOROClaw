'use strict';

const fs = require('fs');
const path = require('path');
const ctx = require('./context');
const { writeJsonAtomic } = require('./util');
const { readOpenclawJsonFile } = require('./openclaw-json');
const { getWorkspace, getOpenclawAgentWorkspace } = require('./workspace');
const { buildTelegramTargetFromContext, resolveTelegramChatIdFromTarget } = require('./telegram-routing');
const {
  normalizeTelegramRole,
  roleScopeHints,
  roleAudience,
  normalizeTelegramChatType,
  normalizeTelegramResponseMode,
  normalizeTelegramEnabled,
  buildTelegramConversationPolicy,
} = require('./telegram-policy');
const {
  buildTelegramDirectoryEntry,
  sortTelegramDirectoryEntries,
  filterTelegramDirectoryEntries,
  summarizeTelegramDirectory,
  normalizeTelegramAliases,
} = require('./telegram-directory');
const {
  buildTelegramInboundContext,
  formatTelegramInboundContextBlock,
} = require('./telegram-inbound-context');

const SETTINGS_FILE = 'telegram-conversation-settings.json';
const DIRECTORY_FILE = 'telegram-directory.json';
const PROFILE_DIR = path.join('memory', 'telegram-chats');
const USER_PROFILE_DIR = path.join('memory', 'telegram-users');
const GROUP_PROFILE_DIR = path.join('memory', 'telegram-groups');
const TELEGRAM_PROFILE_SECTION_MAP = {
  profile: 'Ho so doi tuong',
  knowledge: 'Kien thuc rieng can nap',
  interactionNotes: 'Luu y khi tuong tac',
};

function sanitizeTelegramChatId(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return /^-?\d{5,32}$/.test(s) ? s : '';
}

function telegramEntityId(chatId) {
  const id = sanitizeTelegramChatId(chatId);
  return id ? `telegram:${id}` : '';
}

function getTelegramProfilesDir(profileDir = PROFILE_DIR) {
  const agentWs = getOpenclawAgentWorkspace();
  if (agentWs) return path.join(agentWs, profileDir);
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, profileDir);
}

function ensureTelegramProfilesDir(profileDir = PROFILE_DIR) {
  const dir = getTelegramProfilesDir(profileDir);
  if (!dir) return null;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getTelegramProfilePath(chatId) {
  const id = sanitizeTelegramChatId(chatId);
  const dir = ensureTelegramProfilesDir();
  if (!id || !dir) return null;
  return path.join(dir, `${id}.md`);
}

function compactTelegramText(value, max = 160) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTelegramSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTelegramEntityPrefix(value) {
  return String(value || '').replace(/^telegram:/i, '');
}

function quoteTelegramFrontMatter(value) {
  return JSON.stringify(compactTelegramText(value, 220));
}

function getTelegramSettingsPath(workspace = getWorkspace()) {
  if (!workspace) return null;
  return path.join(workspace, SETTINGS_FILE);
}

function getTelegramDirectoryPath(workspace = getWorkspace()) {
  if (!workspace) return null;
  return path.join(workspace, DIRECTORY_FILE);
}

function readTelegramConversationSettings(workspace = getWorkspace()) {
  if (!workspace) return {};
  const p = getTelegramSettingsPath(workspace);
  try {
    if (!fs.existsSync(p)) return {};
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeTelegramConversationSettings(settings, workspace = getWorkspace()) {
  const p = getTelegramSettingsPath(workspace);
  if (!p) return false;
  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(settings || {})) {
    const value = rawValue && typeof rawValue === 'object' ? rawValue : {};
    const id = sanitizeTelegramChatId(value.chatId || stripTelegramEntityPrefix(rawKey));
    if (!id) continue;
    const chatType = normalizeTelegramChatType(value.chatType || '');
    const policy = buildTelegramConversationPolicy({
      ...value,
      chatType,
      role: value.role,
      enabled: value.enabled,
    });
    clean[telegramEntityId(id)] = {
      chatId: id,
      entityId: telegramEntityId(id),
      label: compactTelegramText(value.label || value.title || '', 120),
      chatType,
      role: policy.role,
      audience: policy.audience,
      scopeHints: policy.scopeHints,
      responseMode: policy.responseMode,
      toolScope: policy.toolScope,
      enabled: policy.enabled,
      aliases: normalizeTelegramAliases(value.aliases || value.alias || []),
      updatedAt: value.updatedAt || new Date().toISOString(),
    };
  }
  writeJsonAtomic(p, clean);
  return true;
}

function getTelegramSetting(settings, chatId) {
  const id = sanitizeTelegramChatId(chatId);
  if (!id) return {};
  return settings[id] || settings[telegramEntityId(id)] || {};
}

function parseTelegramProfileMeta(content = '') {
  const text = String(content || '');
  const meta = {};
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[m[1]] = value;
    }
  }
  const title = text.match(/^#\s+(.+)$/m);
  if (title) meta.title = compactTelegramText(title[1], 120);
  const body = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !/^\(?chua co\)?$/i.test(line) && !/^\(?chưa có\)?$/i.test(line));
  meta.summary = compactTelegramText(body.slice(0, 3).join(' '), 220);
  return meta;
}

function addTelegramConversationCandidate(map, candidate = {}) {
  const chatId = sanitizeTelegramChatId(candidate.chatId || candidate.telegramChatId || candidate.originChatId || candidate.replyChatId);
  if (!chatId) return null;
  const prev = map.get(chatId) || {};
  const prevSources = Array.isArray(prev.sources) ? prev.sources : (prev.source ? [prev.source] : []);
  const source = compactTelegramText(candidate.source || 'runtime', 60);
  const chatType = normalizeTelegramChatType(candidate.chatType || candidate.telegramChatType || prev.chatType || '');
  const roleInput = candidate.role || prev.role;
  const policy = buildTelegramConversationPolicy({
    role: roleInput,
    chatType,
    responseMode: candidate.responseMode || candidate.mode || prev.responseMode,
    enabled: candidate.enabled != null ? candidate.enabled : prev.enabled,
    toolScope: candidate.toolScope || prev.toolScope,
  });
  const label = compactTelegramText(candidate.label || candidate.title || candidate.username || prev.label || '', 120);
  const summary = compactTelegramText(candidate.summary || prev.summary || '', 220);
  const next = {
    ...prev,
    chatId,
    entityId: telegramEntityId(chatId),
    entityType: 'telegram_chat',
    label,
    chatType,
    role: policy.role,
    audience: policy.audience,
    scopeHints: policy.scopeHints,
    responseMode: policy.responseMode,
    toolScope: policy.toolScope,
    enabled: policy.enabled,
    policy,
    aliases: candidate.aliases || candidate.alias || prev.aliases || [],
    username: candidate.username || candidate.handle || prev.username || '',
    profilePath: candidate.profilePath || prev.profilePath || '',
    lastSeen: candidate.lastSeen || prev.lastSeen || '',
    msgCount: Number.isFinite(Number(candidate.msgCount)) ? Number(candidate.msgCount) : (Number(prev.msgCount) || 0),
    summary,
    sources: [...new Set([...prevSources, source].filter(Boolean))],
    mtimeMs: Math.max(Number(prev.mtimeMs) || 0, Number(candidate.mtimeMs) || 0),
  };
  map.set(chatId, next);
  return next;
}

function collectSettingsCandidates(map, settings = readTelegramConversationSettings()) {
  for (const [key, value] of Object.entries(settings || {})) {
    const v = value && typeof value === 'object' ? value : {};
    addTelegramConversationCandidate(map, {
      ...v,
      chatId: v.chatId || stripTelegramEntityPrefix(key),
      source: 'settings',
    });
  }
}

function listTelegramProfilesInDir(profileDir = PROFILE_DIR, { source = 'profile', defaultChatType = '' } = {}) {
  const dir = getTelegramProfilesDir(profileDir);
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!/^-?\d{5,32}\.md$/.test(file)) continue;
      const chatId = file.replace(/\.md$/, '');
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseTelegramProfileMeta(content);
        const profileChatId = sanitizeTelegramChatId(meta.chatId || meta.senderId || chatId) || chatId;
        out.push({
          chatId: profileChatId,
          entityId: telegramEntityId(profileChatId),
          label: meta.label || meta.title || '',
          chatType: meta.chatType || defaultChatType,
          role: meta.role || '',
          audience: meta.audience || '',
          lastSeen: meta.lastSeen || stat.mtime.toISOString(),
          msgCount: Number(meta.msgCount) || 0,
          summary: meta.summary || '',
          profilePath: filePath,
          mtimeMs: stat.mtimeMs,
          source,
        });
      } catch {}
    }
  } catch {}
  out.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return out;
}

function listTelegramProfiles() {
  return [
    ...listTelegramProfilesInDir(PROFILE_DIR, { source: 'profile', defaultChatType: '' }),
    ...listTelegramProfilesInDir(GROUP_PROFILE_DIR, { source: 'profile-tier-group', defaultChatType: 'supergroup' }),
    ...listTelegramProfilesInDir(USER_PROFILE_DIR, { source: 'profile-tier-user', defaultChatType: 'private' }),
  ].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
}

function collectProfileCandidates(map) {
  for (const profile of listTelegramProfiles()) addTelegramConversationCandidate(map, profile);
}

function collectDirectoryCacheCandidates(map, cache = readTelegramDirectoryCache()) {
  for (const entry of cache.entries || []) {
    addTelegramConversationCandidate(map, {
      ...entry,
      chatId: entry.chatId || entry.targetChatId,
      source: 'directory-cache',
    });
  }
}

function collectOpenclawConfigCandidates(map) {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return;
    const cfg = readOpenclawJsonFile(configPath);
    const tg = cfg?.channels?.telegram || {};
    const allowFrom = Array.isArray(tg.allowFrom) ? tg.allowFrom : [];
    for (const uid of allowFrom) {
      const chatId = sanitizeTelegramChatId(uid);
      if (!chatId) continue;
      addTelegramConversationCandidate(map, {
        chatId,
        chatType: 'private',
        role: 'ceo',
        label: 'CEO Telegram',
        source: 'openclaw-config',
      });
    }
  } catch {}
}

function collectCustomCronCandidates(map) {
  try {
    const ws = getWorkspace();
    if (!ws) return;
    const p = path.join(ws, 'custom-crons.json');
    if (!fs.existsSync(p)) return;
    const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const target = entry && typeof entry === 'object' ? entry.telegramTarget : null;
      const chatId = resolveTelegramChatIdFromTarget(target);
      if (!chatId) continue;
      addTelegramConversationCandidate(map, {
        chatId,
        chatType: target?.originChatType || target?.replyChatType || '',
        label: entry.label || entry.name || `Telegram ${chatId}`,
        source: 'custom-crons',
      });
    }
  } catch {}
}

function collectTelegramTextCandidates(text, map, source) {
  const raw = String(text || '');
  if (!raw || !/telegram|conversation_label|group_subject|chat[_-]?id|groupId|LLK/i.test(raw)) return;

  const add = (chatId, extra = {}) => {
    const id = sanitizeTelegramChatId(chatId);
    if (!id) return;
    addTelegramConversationCandidate(map, {
      chatId: id,
      chatType: extra.chatType || (id.startsWith('-') ? 'supergroup' : ''),
      label: extra.label || '',
      role: extra.role || '',
      lastSeen: extra.lastSeen || '',
      source,
    });
  };

  let m;
  const convRe = /"conversation_label"\s*:\s*"([^"]*?)(?:\s+id:\s*(-?\d{5,32}))?"/gi;
  while ((m = convRe.exec(raw))) {
    const label = compactTelegramText(m[1] || '', 120);
    const id = m[2] || '';
    if (id) add(id, { label, chatType: id.startsWith('-') ? 'supergroup' : '' });
  }

  const subject = (raw.match(/"group_subject"\s*:\s*"([^"]+)"/i) || [])[1] || '';
  const isGroup = /"is_group_chat"\s*:\s*true/i.test(raw) || /telegram:group:/i.test(raw);
  const idPatterns = [
    /telegram:(?:group:)?(-?\d{5,32})/gi,
    /(?:Telegram\s+ID|chat[_-]?id|groupId|targetChatId|telegramChatId|originChatId|replyChatId)["':=\s]+(-?\d{5,32})/gi,
    /"(?:chatId|chat_id|groupId|targetChatId|telegramChatId|originChatId|replyChatId)"\s*:\s*"?(-?\d{5,32})"?/gi,
  ];
  for (const re of idPatterns) {
    while ((m = re.exec(raw))) {
      const id = m[1];
      add(id, {
        label: subject ? compactTelegramText(subject, 120) : '',
        chatType: isGroup || String(id).startsWith('-') ? 'supergroup' : '',
      });
    }
  }
}

function readTelegramDirectoryCache(workspace = getWorkspace()) {
  if (!workspace) return { version: 1, entries: [] };
  const p = getTelegramDirectoryPath(workspace);
  try {
    if (!p || !fs.existsSync(p)) return { version: 1, entries: [] };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.entries)
        ? parsed.entries
        : Object.values(parsed?.entries || parsed?.directory || {});
    return {
      version: Number(parsed?.version) || 1,
      updatedAt: parsed?.updatedAt || '',
      entries: entries.filter(v => v && typeof v === 'object'),
    };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeTelegramDirectoryCache(input = {}, workspace = getWorkspace()) {
  const p = getTelegramDirectoryPath(workspace);
  if (!p) return false;
  const entries = Array.isArray(input)
    ? input
    : Array.isArray(input.entries)
      ? input.entries
      : Array.isArray(input.conversations)
        ? input.conversations
        : [];
  const cleanEntries = entries
    .map(entry => buildTelegramDirectoryEntry(entry))
    .filter(Boolean)
    .map(entry => ({
      chatId: entry.chatId,
      targetChatId: entry.targetChatId,
      entityId: entry.entityId,
      label: entry.label,
      username: entry.username,
      aliases: entry.aliases,
      chatType: entry.chatType,
      directoryKind: entry.directoryKind,
      role: entry.role,
      audience: entry.audience,
      scopeHints: entry.scopeHints,
      responseMode: entry.responseMode,
      toolScope: entry.toolScope,
      enabled: entry.enabled,
      profilePath: entry.profilePath || '',
      lastSeen: entry.lastSeen || '',
      msgCount: Number(entry.msgCount) || 0,
      summary: entry.summary || '',
      sources: entry.sources || [],
      mtimeMs: Number(entry.mtimeMs) || 0,
    }));
  writeJsonAtomic(p, {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: sortTelegramDirectoryEntries(cleanEntries),
  });
  return true;
}

function collectTelegramObjectCandidates(value, map, source, depth = 0) {
  if (!value || depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectTelegramObjectCandidates(item, map, source, depth + 1);
    return;
  }
  if (typeof value === 'string') {
    collectTelegramTextCandidates(value, map, source);
    return;
  }
  if (typeof value !== 'object') return;

  const jsonHint = JSON.stringify(value).slice(0, 2000);
  const hasTelegramSignal = /telegram/i.test(jsonHint)
    || value.telegramTarget
    || value.telegramChatId
    || value.originChatId
    || value.replyChatId;
  if (hasTelegramSignal) {
    const target = value.telegramTarget && typeof value.telegramTarget === 'object' ? value.telegramTarget : null;
    const chatId = resolveTelegramChatIdFromTarget(target)
      || sanitizeTelegramChatId(value.telegramChatId || value.originChatId || value.replyChatId || value.targetChatId || value.chatId || value.groupId || value.id);
    if (chatId) {
      addTelegramConversationCandidate(map, {
        chatId,
        chatType: value.telegramChatType || value.originChatType || target?.originChatType || value.type || value.chatType || (String(chatId).startsWith('-') ? 'supergroup' : ''),
        label: value.title || value.name || value.username || value.label || value.subject || value.group_subject || value.metadata?.label || '',
        role: value.role || '',
        lastSeen: value.lastSeen || value.createdAt || value.updatedAt || '',
        source,
      });
    }
  }

  for (const child of Object.values(value).slice(0, 60)) {
    if (child != null) collectTelegramObjectCandidates(child, map, source, depth + 1);
  }
}

function collectJsonLinesCandidates(filePath, map, source) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return;
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = Math.min(stat.size, 512 * 1024);
      const buffer = Buffer.alloc(len);
      fs.readSync(fd, buffer, 0, len, Math.max(0, stat.size - len));
      const text = buffer.toString('utf-8');
      for (const line of text.split(/\r?\n/).slice(-1500)) {
        if (!/telegram/i.test(line)) continue;
        try {
          const obj = JSON.parse(line);
          collectTelegramObjectCandidates(obj, map, source);
        } catch {
          const re = /"(?:telegramChatId|originChatId|replyChatId|chatId)"\s*:\s*"?(-?\d{5,32})"?/g;
          let m;
          while ((m = re.exec(line))) {
            addTelegramConversationCandidate(map, { chatId: m[1], source });
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

function collectRuntimeLogCandidates(map) {
  const roots = [
    path.join(getWorkspace() || '', 'logs'),
    path.join(ctx.HOME, '.openclaw', 'logs'),
  ].filter(Boolean);
  const names = ['audit.jsonl', 'gateway.jsonl', 'telegram.jsonl', 'inbound.jsonl', 'messages.jsonl', 'cron-runs.jsonl'];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const name of names) collectJsonLinesCandidates(path.join(root, name), map, 'runtime-logs');
  }
}

function collectProviderCacheCandidates(map) {
  const root = path.join(ctx.HOME, '.openclaw');
  if (!fs.existsSync(root)) return;
  let scanned = 0;
  const maxFiles = 80;
  const walk = (dir, depth) => {
    if (scanned >= maxFiles || depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (scanned >= maxFiles) return;
      if (['node_modules', 'agents', 'sessions', 'tmp'].includes(entry.name) && !/telegram/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const lower = full.toLowerCase();
      if (entry.isDirectory()) {
        if (/telegram|tg|provider|openclaw|cache|data/.test(lower)) walk(full, depth + 1);
        continue;
      }
      if (!/\.(json|jsonl)$/i.test(entry.name)) continue;
      if (!/telegram|tg|update|message|chat|dialog|history|cache/.test(lower)) continue;
      scanned += 1;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 3 * 1024 * 1024) continue;
        if (/\.jsonl$/i.test(entry.name)) {
          collectJsonLinesCandidates(full, map, 'provider-cache');
        } else {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
          collectTelegramObjectCandidates(parsed, map, 'provider-cache');
        }
      } catch {}
    }
  };
  walk(root, 0);
}

function collectOpenclawSessionCandidates(map) {
  const dir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
  if (!fs.existsSync(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const full = path.join(dir, entry.name);
        let stat = null;
        try { stat = fs.statSync(full); } catch {}
        return { name: entry.name, full, stat };
      })
      .filter(item => item.stat && item.stat.size > 0 && item.stat.size <= 5 * 1024 * 1024)
      .filter(item => /^sessions\.json/i.test(item.name) || /\.jsonl(\.|$)/i.test(item.name))
      .sort((a, b) => (b.stat.mtimeMs || 0) - (a.stat.mtimeMs || 0))
      .slice(0, 30);
  } catch {
    return;
  }
  for (const item of entries) {
    if (/^sessions\.json/i.test(item.name)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(item.full, 'utf-8'));
        collectTelegramObjectCandidates(parsed, map, 'openclaw-sessions');
      } catch {}
    } else {
      collectJsonLinesCandidates(item.full, map, 'openclaw-sessions');
    }
  }
}

function discoverTelegramConversationCandidates({ includeDirectoryCache = true } = {}) {
  const map = new Map();
  collectOpenclawConfigCandidates(map);
  collectCustomCronCandidates(map);
  collectRuntimeLogCandidates(map);
  collectProviderCacheCandidates(map);
  collectOpenclawSessionCandidates(map);
  collectProfileCandidates(map);
  if (includeDirectoryCache) collectDirectoryCacheCandidates(map);
  collectSettingsCandidates(map);
  return map;
}

function finalizeTelegramConversation(row) {
  return buildTelegramDirectoryEntry({
    ...row,
    entityId: telegramEntityId(row.chatId),
    hasProfile: !!(row.profilePath && fs.existsSync(row.profilePath)),
  });
}

function listTelegramConversations() {
  const map = discoverTelegramConversationCandidates();
  const conversations = sortTelegramDirectoryEntries(
    Array.from(map.values()).map(finalizeTelegramConversation).filter(Boolean)
  );
  return {
    success: true,
    conversations,
    directory: {
      version: 1,
      source: 'telegram-memory-runtime',
      counts: summarizeTelegramDirectory(conversations),
    },
    counts: summarizeTelegramDirectory(conversations),
    profileDir: getTelegramProfilesDir() || '',
    settingsPath: getTelegramSettingsPath() || '',
  };
}

function listTelegramDirectory(opts = {}) {
  const listed = listTelegramConversations();
  const conversations = filterTelegramDirectoryEntries(listed.conversations, {
    query: opts.query || opts.name || '',
    role: opts.role || '',
    chatType: opts.chatType || opts.type || '',
    kind: opts.kind || '',
    enabled: opts.enabled,
    limit: opts.limit || 200,
  });
  return {
    success: true,
    version: 1,
    query: String(opts.query || opts.name || '').trim(),
    count: conversations.length,
    counts: summarizeTelegramDirectory(conversations),
    conversations,
    directory: {
      version: 1,
      source: 'telegram-memory-runtime',
      totalCounts: listed.counts,
    },
  };
}

function refreshTelegramDirectoryFromRuntime() {
  const map = discoverTelegramConversationCandidates({ includeDirectoryCache: false });
  const conversations = sortTelegramDirectoryEntries(
    Array.from(map.values()).map(finalizeTelegramConversation).filter(Boolean)
  );
  writeTelegramDirectoryCache({ entries: conversations });
  const refreshed = listTelegramDirectory({ limit: 200 });
  return {
    success: true,
    refreshed: conversations.length,
    directoryPath: getTelegramDirectoryPath() || '',
    updatedAt: new Date().toISOString(),
    counts: summarizeTelegramDirectory(conversations),
    conversations: refreshed.conversations,
  };
}

function findTelegramConversations({ query = '', role = '', chatType = '', kind = '', enabled = null, autoMode = false, limit = 50 } = {}) {
  const all = listTelegramConversations().conversations;
  const q = String(query || '').trim();
  const rows = filterTelegramDirectoryEntries(all, { query: q, role, chatType, kind, enabled, limit });
  const result = {
    success: true,
    query: q,
    count: rows.length,
    conversations: rows,
    directory: {
      version: 1,
      source: 'telegram-directory',
    },
  };
  if (autoMode && rows.length) {
    result.picked = rows[0].chatId;
    result.pickedConversation = rows[0];
    result.autoMode = true;
  }
  return result;
}

function saveTelegramConversationSettings(input = {}) {
  const current = readTelegramConversationSettings();
  const next = { ...current };
  let items = [];
  if (Array.isArray(input)) {
    items = input;
  } else if (Array.isArray(input.conversations)) {
    items = input.conversations;
  } else if (input.chatId) {
    items = [input];
  } else {
    items = Object.entries(input.settings || input || {})
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => ({ ...value, chatId: value.chatId || stripTelegramEntityPrefix(key) }));
  }
  for (const item of items) {
    const chatId = sanitizeTelegramChatId(item.chatId);
    if (!chatId) continue;
    const prev = getTelegramSetting(next, chatId);
    const chatType = normalizeTelegramChatType(item.chatType || prev.chatType || '');
    const policy = buildTelegramConversationPolicy({
      ...prev,
      ...item,
      chatType,
      role: item.role || prev.role,
      responseMode: item.responseMode || item.mode || prev.responseMode,
      enabled: item.enabled != null ? item.enabled : prev.enabled,
    });
    const aliasesInput = Object.prototype.hasOwnProperty.call(item, 'aliases')
      ? item.aliases
      : Object.prototype.hasOwnProperty.call(item, 'alias')
        ? item.alias
        : prev.aliases;
    next[telegramEntityId(chatId)] = {
      chatId,
      entityId: telegramEntityId(chatId),
      label: compactTelegramText(item.label || prev.label || '', 120),
      chatType,
      role: policy.role,
      audience: policy.audience,
      scopeHints: policy.scopeHints,
      responseMode: policy.responseMode,
      toolScope: policy.toolScope,
      enabled: policy.enabled,
      aliases: normalizeTelegramAliases(aliasesInput || []),
      updatedAt: new Date().toISOString(),
    };
  }
  writeTelegramConversationSettings(next);
  return listTelegramConversations();
}

function seedTelegramConversationsFromRuntime() {
  const map = discoverTelegramConversationCandidates();
  const seeded = [];
  for (const row of map.values()) {
    const conversation = finalizeTelegramConversation(row);
    const beforePath = getTelegramProfilePath(conversation.chatId);
    const existed = !!(beforePath && fs.existsSync(beforePath));
    const profile = ensureTelegramConversationProfile({
      telegramChatId: conversation.chatId,
        telegramChatType: conversation.chatType,
        role: conversation.role,
        responseMode: conversation.responseMode,
        toolScope: conversation.toolScope,
        aliases: conversation.aliases || [],
        label: conversation.label,
      });
    if (profile) {
      seeded.push({
        ...conversation,
        profilePath: profile.profilePath,
        hasProfile: true,
        created: !existed,
      });
    }
  }
  return {
    success: true,
    seeded,
    created: seeded.filter(c => c.created).length,
    conversations: listTelegramConversations().conversations,
  };
}

function resolveTelegramConversation(source = {}, headers = {}) {
  const target = buildTelegramTargetFromContext(source, headers);
  const chatId = sanitizeTelegramChatId(
    source.chatId
    || source.telegramChatId
    || source.originChatId
    || resolveTelegramChatIdFromTarget(target)
  );
  if (!chatId) return null;
  const settings = readTelegramConversationSettings();
  const perChat = getTelegramSetting(settings, chatId);
  const chatType = normalizeTelegramChatType(source.chatType || source.telegramChatType || source.originChatType || target?.originChatType || perChat.chatType || '');
  const directoryEntry = buildTelegramDirectoryEntry({
    ...perChat,
    ...source,
    chatId,
    chatType,
    role: source.role || source.telegramRole || perChat.role,
    responseMode: source.responseMode || source.mode || perChat.responseMode,
    enabled: source.enabled != null ? source.enabled : perChat.enabled,
    label: source.label || source.title || source.username || perChat.label || perChat.title || '',
  });
  const label = String(source.label || source.title || source.username || perChat.label || perChat.title || '').trim();
  return {
    ...(directoryEntry || {}),
    channel: 'telegram',
    chatId,
    entityId: telegramEntityId(chatId),
    entityType: 'telegram_chat',
    label: label || directoryEntry?.label || `Telegram ${chatId}`,
    telegramTarget: target,
  };
}

function ensureTelegramConversationProfile(source = {}) {
  const conversation = resolveTelegramConversation(source);
  if (!conversation) return null;
  const profilePath = getTelegramProfilePath(conversation.chatId);
  if (!profilePath) return null;
  if (!fs.existsSync(profilePath)) {
    const title = conversation.label || `Telegram ${conversation.chatId}`;
    const now = new Date().toISOString();
    const content = `---
channel: telegram
chatId: ${conversation.chatId}
entityId: ${conversation.entityId}
chatType: ${conversation.chatType || 'unknown'}
role: ${conversation.role}
audience: ${conversation.audience}
responseMode: ${conversation.responseMode}
toolScope: ${conversation.toolScope}
directoryKind: ${conversation.directoryKind}
label: ${quoteTelegramFrontMatter(title)}
lastSeen: ${now}
msgCount: 0
tags: []
---
# ${title}

## Ho so doi tuong
(chua co)

## Kien thuc rieng can nap
(chua co)

## Luu y khi tuong tac
(chua co)

---
*Ho so duoc tao tu dong cho Telegram conversation luc ${now}.*
`;
    try { fs.writeFileSync(profilePath, content, 'utf-8'); } catch {}
  }
  return { ...conversation, profilePath };
}

function readTelegramConversationProfile(chatId, maxChars = 2500) {
  const profilePath = getTelegramProfilePath(chatId);
  if (!profilePath || !fs.existsSync(profilePath)) return null;
  try {
    const content = fs.readFileSync(profilePath, 'utf-8');
    return {
      path: profilePath,
      content: content.slice(0, Math.max(200, Number(maxChars) || 2500)),
    };
  } catch {
    return null;
  }
}

function escapeTelegramProfileRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeTelegramProfileSection(value, maxChars = 6000) {
  const text = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim()
    .slice(0, Math.max(1, Number(maxChars) || 6000));
  return text || '(chua co)';
}

function insertTelegramProfileSection(content, title, body) {
  const block = `\n\n## ${title}\n${body}\n`;
  const raw = String(content || '');
  const footerMatch = raw.match(/\n---\s*\n\*Ho so duoc tao tu dong cho Telegram conversation/i);
  if (footerMatch?.index != null) {
    return raw.slice(0, footerMatch.index) + block + raw.slice(footerMatch.index);
  }
  const ceoMatch = raw.match(/\n## CEO notes\s*\n/i);
  if (ceoMatch?.index != null) {
    return raw.slice(0, ceoMatch.index) + block + raw.slice(ceoMatch.index);
  }
  return raw.replace(/\s*$/, block);
}

function replaceTelegramProfileSection(content, title, body) {
  const raw = String(content || '');
  const heading = new RegExp(`(^|\\n)## ${escapeTelegramProfileRegex(title)}\\s*\\n`, 'i');
  const match = heading.exec(raw);
  if (!match) return insertTelegramProfileSection(raw, title, body);
  const headingStart = match.index + (match[1] ? match[1].length : 0);
  const bodyStart = match.index + match[0].length;
  const tail = raw.slice(bodyStart);
  const boundaries = [
    tail.search(/\n##\s+/),
    tail.search(/\n---\s*\n/),
  ].filter(index => index >= 0);
  const bodyEndOffset = boundaries.length ? Math.min(...boundaries) : tail.length;
  const replacement = `## ${title}\n${body}\n`;
  return raw.slice(0, headingStart) + replacement + tail.slice(bodyEndOffset);
}

function saveTelegramConversationProfileSections(input = {}) {
  try {
    const chatId = sanitizeTelegramChatId(input.chatId || input.telegramChatId || input.targetChatId);
    if (!chatId) return { success: false, error: 'invalid chatId' };
    const sections = input.sections && typeof input.sections === 'object' ? input.sections : {};
    const requestedKeys = Object.keys(TELEGRAM_PROFILE_SECTION_MAP)
      .filter(key => Object.prototype.hasOwnProperty.call(sections, key));
    if (!requestedKeys.length) return { success: false, error: 'empty sections' };
    const conversation = ensureTelegramConversationProfile({
      ...input,
      telegramChatId: chatId,
      chatId,
    });
    if (!conversation?.profilePath) return { success: false, error: 'profile not available' };
    let content = '';
    try { content = fs.readFileSync(conversation.profilePath, 'utf-8'); } catch {}
    const saved = {};
    for (const key of requestedKeys) {
      const title = TELEGRAM_PROFILE_SECTION_MAP[key];
      const body = sanitizeTelegramProfileSection(sections[key]);
      content = replaceTelegramProfileSection(content, title, body);
      saved[key] = body;
    }
    fs.writeFileSync(conversation.profilePath, content, 'utf-8');
    return { success: true, path: conversation.profilePath, sections: saved };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

function sanitizeTelegramConversationNote(note, maxChars = 2000) {
  return String(note || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Number(maxChars) || 2000));
}

function makeTelegramNoteTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 16).replace('T', ' ');
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function ensureTelegramCeoNotesSection(content) {
  const raw = String(content || '');
  if (/(^|\n)## CEO notes\s*\n/i.test(raw)) return raw;
  return raw.replace(/\s*$/, '\n\n## CEO notes\n');
}

function appendTelegramConversationNote(input = {}) {
  try {
    const chatId = sanitizeTelegramChatId(input.chatId || input.telegramChatId || input.targetChatId);
    if (!chatId) return { success: false, error: 'invalid chatId' };
    const note = sanitizeTelegramConversationNote(input.note);
    if (!note) return { success: false, error: 'empty note' };
    const conversation = ensureTelegramConversationProfile({
      ...input,
      telegramChatId: chatId,
      chatId,
    });
    if (!conversation?.profilePath) return { success: false, error: 'profile not available' };
    let content = '';
    try { content = fs.readFileSync(conversation.profilePath, 'utf-8'); } catch {}
    content = ensureTelegramCeoNotesSection(content);
    const timestamp = makeTelegramNoteTimestamp(input.timestamp || new Date());
    const line = `- **${timestamp}** - ${note}\n`;
    content = content.replace(/(^|\n)(## CEO notes\s*\n)/i, (match, prefix, header) => `${prefix}${header}${line}`);
    fs.writeFileSync(conversation.profilePath, content, 'utf-8');
    return { success: true, timestamp, path: conversation.profilePath };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

function deleteTelegramConversationNote(input = {}) {
  try {
    const chatId = sanitizeTelegramChatId(input.chatId || input.telegramChatId || input.targetChatId);
    const noteTimestamp = String(input.noteTimestamp || input.timestamp || '').trim().slice(0, 32);
    if (!chatId || !noteTimestamp) return { success: false, error: 'missing params' };
    const profilePath = getTelegramProfilePath(chatId);
    if (!profilePath || !fs.existsSync(profilePath)) return { success: false, error: 'profile not found' };
    const content = fs.readFileSync(profilePath, 'utf-8');
    const escapedTs = noteTimestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRegex = new RegExp('^- \\*\\*' + escapedTs + '\\*\\*\\s+-\\s+.*$\\n?', 'm');
    const next = content.replace(lineRegex, '');
    if (next === content) return { success: false, error: 'note not found' };
    fs.writeFileSync(profilePath, next, 'utf-8');
    return { success: true, path: profilePath };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

async function buildTelegramMemoryContext(source = {}) {
  const conversation = ensureTelegramConversationProfile(source);
  if (!conversation) return null;
  const profile = readTelegramConversationProfile(conversation.chatId, source.profileMaxChars || 1800);
  const { getMemoryContext } = require('./ceo-memory');
  const memory = await getMemoryContext({
    query: [conversation.label, source.query, source.body, source.prompt].filter(Boolean).join('\n'),
    channel: 'telegram',
    actorId: conversation.entityId,
    scopeHints: conversation.scopeHints,
    taskType: source.taskType || '',
    intent: source.intent || conversation.label,
    limit: source.limit || 8,
  });
  return {
    conversation,
    profile,
    memory,
    inboundContext: buildTelegramInboundContext({
      conversation,
      source,
      profile,
      memory,
    }),
  };
}

function formatTelegramMemoryPromptBlock(ctx) {
  if (!ctx || !ctx.conversation) return '';
  const compact = {
    conversation: {
      channel: ctx.conversation.channel,
      chatId: ctx.conversation.chatId,
      entityId: ctx.conversation.entityId,
      chatType: ctx.conversation.chatType,
      role: ctx.conversation.role,
      audience: ctx.conversation.audience,
      label: ctx.conversation.label,
      aliases: ctx.conversation.aliases || [],
      directoryKind: ctx.conversation.directoryKind,
      scopes: ctx.conversation.scopeHints,
      responseMode: ctx.conversation.responseMode,
      toolScope: ctx.conversation.toolScope,
      policy: ctx.conversation.policy || null,
    },
    profile: ctx.profile ? ctx.profile.content : '',
    inboundContext: ctx.inboundContext || null,
    inboundContextBlock: ctx.inboundContext ? formatTelegramInboundContextBlock(ctx.inboundContext) : '',
    memories: (ctx.memory?.memories || []).map(m => ({
      id: m.id,
      type: m.type,
      scope: m.scope,
      entityType: m.entity_type,
      entityId: m.entity_id,
      content: m.content,
    })),
    safetyWarnings: ctx.memory?.safetyWarnings || [],
  };
  return `<telegram-conversation-context trusted="true">\n${JSON.stringify(compact)}\n</telegram-conversation-context>`;
}

module.exports = {
  SETTINGS_FILE,
  DIRECTORY_FILE,
  PROFILE_DIR,
  USER_PROFILE_DIR,
  GROUP_PROFILE_DIR,
  sanitizeTelegramChatId,
  telegramEntityId,
  getTelegramProfilesDir,
  ensureTelegramProfilesDir,
  getTelegramProfilePath,
  normalizeTelegramRole,
  normalizeTelegramChatType,
  normalizeTelegramResponseMode,
  normalizeTelegramEnabled,
  buildTelegramConversationPolicy,
  buildTelegramInboundContext,
  formatTelegramInboundContextBlock,
  roleScopeHints,
  roleAudience,
  getTelegramSettingsPath,
  getTelegramDirectoryPath,
  readTelegramDirectoryCache,
  writeTelegramDirectoryCache,
  readTelegramConversationSettings,
  writeTelegramConversationSettings,
  parseTelegramProfileMeta,
  listTelegramProfiles,
  listTelegramConversations,
  listTelegramDirectory,
  refreshTelegramDirectoryFromRuntime,
  findTelegramConversations,
  saveTelegramConversationSettings,
  seedTelegramConversationsFromRuntime,
  resolveTelegramConversation,
  ensureTelegramConversationProfile,
  readTelegramConversationProfile,
  saveTelegramConversationProfileSections,
  appendTelegramConversationNote,
  deleteTelegramConversationNote,
  buildTelegramMemoryContext,
  formatTelegramMemoryPromptBlock,
};
