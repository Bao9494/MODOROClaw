'use strict';

const fs = require('fs');
const path = require('path');
const { getWorkspace, getOpenclawAgentWorkspace } = require('./workspace');
const {
  sanitizeTelegramChatId,
  compactTelegramDirectoryText,
} = require('./telegram-directory');
const {
  normalizeTelegramChatType,
  isTelegramGroupLike,
} = require('./telegram-policy');
const {
  sanitizeTelegramThreadId,
  bindTelegramSession,
} = require('./telegram-session-bindings');
const {
  sanitizeTelegramMessageId,
  rememberTelegramMessageRef,
} = require('./telegram-message-refs');
const {
  appendTelegramHistoryEvent,
} = require('./telegram-history-archive');
const {
  normalizeTelegramMemberMetadata,
  saveTelegramMemberMetadata,
} = require('./telegram-member-metadata');

const TELEGRAM_USERS_PROFILE_DIR = path.join('memory', 'telegram-users');
const TELEGRAM_GROUPS_PROFILE_DIR = path.join('memory', 'telegram-groups');

function compactRuntimeText(value, max = 220) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function quoteFrontMatter(value) {
  return JSON.stringify(compactRuntimeText(value, 220));
}

function runtimeWorkspaceRoot() {
  return getOpenclawAgentWorkspace() || getWorkspace();
}

function getTelegramTierProfilePath(params = {}) {
  const root = runtimeWorkspaceRoot();
  if (!root) return null;
  const senderId = sanitizeTelegramChatId(params.senderId || params.telegramSenderId || params.userId || params.fromId);
  if (senderId && !params.chatId && !params.targetChatId && !params.telegramChatId) {
    return path.join(root, TELEGRAM_USERS_PROFILE_DIR, `${senderId}.md`);
  }
  const chatId = sanitizeTelegramChatId(params.chatId || params.targetChatId || params.telegramChatId);
  if (!chatId) return null;
  const chatType = normalizeTelegramChatType(params.chatType || params.telegramChatType || '');
  const dir = chatId.startsWith('-') || isTelegramGroupLike(chatType)
    ? TELEGRAM_GROUPS_PROFILE_DIR
    : TELEGRAM_USERS_PROFILE_DIR;
  return path.join(root, dir, `${chatId}.md`);
}

function ensureParentDir(filePath) {
  if (!filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function ensureTelegramTierProfile(params = {}) {
  const profilePath = getTelegramTierProfilePath(params);
  if (!profilePath || !ensureParentDir(profilePath)) return null;
  if (!fs.existsSync(profilePath)) {
    const chatId = sanitizeTelegramChatId(params.chatId || params.targetChatId || params.telegramChatId);
    const senderId = sanitizeTelegramChatId(params.senderId || params.telegramSenderId || params.userId || params.fromId);
    const chatType = normalizeTelegramChatType(params.chatType || params.telegramChatType || '');
    const profileTier = profilePath.includes(`${path.sep}telegram-groups${path.sep}`) ? 'group' : 'user';
    const title = compactRuntimeText(
      params.label
      || params.title
      || params.senderName
      || params.senderDisplayName
      || params.username
      || params.senderUsername
      || chatId
      || senderId
      || 'Telegram profile',
      120
    );
    const now = new Date().toISOString();
    const content = `---
channel: telegram
profileTier: ${profileTier}
chatId: ${chatId || ''}
senderId: ${senderId || ''}
chatType: ${chatType || 'unknown'}
role: ${compactRuntimeText(params.role || params.senderRole || 'unknown', 40)}
memberStatus: ${compactRuntimeText(params.memberStatus || 'unknown', 40)}
memberTitle: ${quoteFrontMatter(params.memberTitle || params.customTitle || '')}
label: ${quoteFrontMatter(title)}
lastSeen: ${now}
msgCount: 0
tags: []
---
# ${title}

## Profile
(auto-created)

## Private knowledge to load
(none yet)

## Interaction notes
(none yet)

---
*Auto-created from Telegram runtime capture at ${now}.*
`;
    try { fs.writeFileSync(profilePath, content, 'utf-8'); } catch {}
  }
  return profilePath;
}

function pickChat(raw = {}) {
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  return raw.chat && typeof raw.chat === 'object'
    ? raw.chat
    : result.chat && typeof result.chat === 'object'
      ? result.chat
      : {};
}

function pickSender(raw = {}) {
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  return raw.sender && typeof raw.sender === 'object'
    ? raw.sender
    : raw.from && typeof raw.from === 'object'
      ? raw.from
      : result.from && typeof result.from === 'object'
        ? result.from
        : {};
}

function chatLabel(chat = {}, raw = {}) {
  const firstLast = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return compactTelegramDirectoryText(
    raw.label
    || raw.title
    || chat.title
    || raw.chatTitle
    || firstLast
    || raw.username
    || chat.username
    || '',
    120
  );
}

function senderLabel(sender = {}, raw = {}) {
  const firstLast = [sender.first_name, sender.last_name].filter(Boolean).join(' ');
  return compactRuntimeText(
    raw.senderName
    || raw.senderDisplayName
    || raw.fromName
    || firstLast
    || raw.senderUsername
    || sender.username
    || '',
    120
  );
}

function eventTimestamp(raw = {}) {
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  const value = raw.timestamp || raw.date || result.date;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 100000000000 ? Math.floor(n) : Math.floor(n * 1000);
  return Date.now();
}

function mergeDirectoryEntry(conversation = {}, source = 'runtime-capture') {
  const tg = require('./telegram-memory');
  const current = tg.readTelegramDirectoryCache();
  const entries = (current.entries || []).filter(entry => entry.chatId !== conversation.chatId);
  entries.unshift({
    ...conversation,
    sources: [...new Set([...(conversation.sources || []), source])],
    source,
    lastSeen: new Date(eventTimestamp(conversation)).toISOString(),
    mtimeMs: Date.now(),
  });
  tg.writeTelegramDirectoryCache({ entries });
}

function captureTelegramRuntimeEvent(raw = {}) {
  const chat = pickChat(raw);
  const sender = pickSender(raw);
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  const chatId = sanitizeTelegramChatId(
    raw.chatId
    || raw.targetChatId
    || raw.telegramChatId
    || raw.originChatId
    || raw.replyChatId
    || chat.id
  );
  if (!chatId) return null;
  const chatType = normalizeTelegramChatType(raw.chatType || raw.telegramChatType || chat.type || (chatId.startsWith('-') ? 'supergroup' : 'private'));
  const threadId = sanitizeTelegramThreadId(raw.threadId || raw.topicId || raw.messageThreadId || result.message_thread_id);
  const messageId = sanitizeTelegramMessageId(raw.messageId || raw.telegramMessageId || raw.msgId || result.message_id);
  const senderId = sanitizeTelegramChatId(raw.senderId || raw.telegramSenderId || raw.fromId || sender.id);
  const direction = ['inbound', 'outbound'].includes(String(raw.direction || '').toLowerCase())
    ? String(raw.direction).toLowerCase()
    : 'inbound';
  const text = compactRuntimeText(raw.text || raw.body || raw.message || raw.caption || result.text || result.caption || '', 260);
  const label = chatLabel(chat, raw) || `Telegram ${chatId}`;
  const timestamp = eventTimestamp(raw);
  const memberMetadata = normalizeTelegramMemberMetadata({
    ...raw,
    chatId,
    userId: senderId,
  });
  const tg = require('./telegram-memory');
  const conversation = tg.ensureTelegramConversationProfile({
    telegramChatId: chatId,
    telegramChatType: chatType,
    title: label,
    label,
    username: raw.username || chat.username || '',
    role: raw.role || raw.telegramRole || '',
    responseMode: raw.responseMode || '',
  });
  if (!conversation) return null;
  mergeDirectoryEntry({
    ...conversation,
    chatId,
    chatType,
    label,
    username: raw.username || chat.username || '',
    lastSeen: new Date(timestamp).toISOString(),
    msgCount: Number(conversation.msgCount) || 0,
    summary: text,
  }, raw.source || `runtime-${direction}`);

  const groupProfilePath = ensureTelegramTierProfile({
    chatId,
    chatType,
    label,
    role: conversation.role,
  });
  const senderProfilePath = senderId ? ensureTelegramTierProfile({
    senderId,
    senderName: senderLabel(sender, raw) || senderId,
    senderUsername: raw.senderUsername || sender.username || '',
    senderRole: raw.senderRole || raw.fromRole || '',
    memberStatus: memberMetadata.memberStatus,
    memberTitle: memberMetadata.memberTitle,
  }) : null;
  if (senderId && memberMetadata.memberStatus && memberMetadata.memberStatus !== 'unknown') {
    try { saveTelegramMemberMetadata({ ...memberMetadata, chatId, userId: senderId, source: raw.source || `runtime-${direction}` }); } catch {}
  }
  const sessionKey = compactRuntimeText(raw.sessionKey || raw.agentSessionKey || raw.childSessionKey || '', 260);
  const binding = sessionKey ? bindTelegramSession({
    chatId,
    threadId,
    sessionKey,
    agentId: raw.agentId || 'main',
    label,
  }) : null;
  const messageRef = messageId ? rememberTelegramMessageRef({
    chatId,
    threadId,
    messageId,
    replyToMessageId: raw.replyToMessageId || raw.replyTo || raw.quoteMessageId || result.reply_to_message?.message_id,
    senderId,
    sessionKey,
    direction,
    timestamp,
    text,
  }) : null;
  const historyAppend = messageId ? appendTelegramHistoryEvent(null, {
    chatId,
    threadId,
    messageId,
    replyToMessageId: raw.replyToMessageId || raw.replyTo || raw.quoteMessageId || result.reply_to_message?.message_id,
    senderId,
    senderName: senderLabel(sender, raw) || '',
    senderRole: raw.senderRole || raw.fromRole || '',
    memberStatus: memberMetadata.memberStatus,
    memberTitle: memberMetadata.memberTitle,
    chatType,
    label,
    direction,
    timestamp,
    text,
    source: raw.source || `runtime-${direction}`,
    sessionKey,
    hasMedia: !!(raw.hasMedia || raw.media || raw.photo || raw.document || raw.imagePath || result.photo || result.document),
  }) : null;
  return {
    success: true,
    conversation,
    groupProfilePath,
    senderProfilePath,
    binding,
    messageRef,
    historyAppend,
    memberMetadata,
  };
}

module.exports = {
  TELEGRAM_USERS_PROFILE_DIR,
  TELEGRAM_GROUPS_PROFILE_DIR,
  compactRuntimeText,
  getTelegramTierProfilePath,
  ensureTelegramTierProfile,
  captureTelegramRuntimeEvent,
};
