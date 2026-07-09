'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const { getWorkspace } = require('./workspace');
const {
  sanitizeTelegramChatId,
  compactTelegramDirectoryText,
} = require('./telegram-directory');

const TELEGRAM_MEMBER_METADATA_FILE = 'telegram-member-metadata.json';

function getTelegramMemberMetadataPath(ws) {
  const base = ws || getWorkspace();
  return base ? path.join(base, TELEGRAM_MEMBER_METADATA_FILE) : null;
}

function normalizeTelegramMemberStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'owner') return 'creator';
  if (raw === 'admin') return 'administrator';
  if (['creator', 'administrator', 'member', 'restricted', 'left', 'kicked'].includes(raw)) return raw;
  return 'unknown';
}

function telegramMemberFlags(status) {
  const normalized = normalizeTelegramMemberStatus(status);
  const isOwner = normalized === 'creator';
  const isAdmin = isOwner || normalized === 'administrator';
  const isMember = isAdmin || normalized === 'member' || normalized === 'restricted';
  return { isOwner, isAdmin, isMember };
}

function pickTelegramMemberObject(raw = {}) {
  if (raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)) return raw.result;
  if (raw.chatMember && typeof raw.chatMember === 'object' && !Array.isArray(raw.chatMember)) return raw.chatMember;
  if (raw.member && typeof raw.member === 'object' && !Array.isArray(raw.member)) return raw.member;
  return raw;
}

function pickTelegramMemberUser(raw = {}, member = {}) {
  if (member.user && typeof member.user === 'object' && !Array.isArray(member.user)) return member.user;
  if (raw.user && typeof raw.user === 'object' && !Array.isArray(raw.user)) return raw.user;
  if (raw.from && typeof raw.from === 'object' && !Array.isArray(raw.from)) return raw.from;
  if (raw.sender && typeof raw.sender === 'object' && !Array.isArray(raw.sender)) return raw.sender;
  return {};
}

function normalizeTelegramMemberMetadata(raw = {}) {
  const member = pickTelegramMemberObject(raw);
  const user = pickTelegramMemberUser(raw, member);
  const chatId = sanitizeTelegramChatId(
    raw.chatId
    || raw.targetChatId
    || raw.telegramChatId
    || raw.originChatId
    || member.chatId
    || member.chat_id
  );
  const userId = sanitizeTelegramChatId(
    raw.userId
    || raw.senderId
    || raw.telegramSenderId
    || raw.fromId
    || raw.fromUserId
    || raw.telegramUserId
    || member.userId
    || member.user_id
    || user.id
  );
  const memberStatus = normalizeTelegramMemberStatus(
    raw.memberStatus
    || raw.telegramMemberStatus
    || raw.memberRole
    || raw.telegramMemberRole
    || raw.status
    || member.memberStatus
    || member.telegramMemberStatus
    || member.status
  );
  const flags = telegramMemberFlags(memberStatus);
  const memberTitle = compactTelegramDirectoryText(
    raw.memberTitle
    || raw.customTitle
    || raw.custom_title
    || member.memberTitle
    || member.customTitle
    || member.custom_title
    || '',
    120
  );
  const username = compactTelegramDirectoryText(
    raw.username
    || raw.senderUsername
    || raw.fromUsername
    || user.username
    || '',
    120
  );
  const displayName = compactTelegramDirectoryText(
    raw.displayName
    || raw.senderName
    || raw.senderDisplayName
    || raw.fromName
    || [user.first_name, user.last_name].filter(Boolean).join(' ')
    || '',
    120
  );
  return {
    chatId,
    userId,
    memberStatus,
    memberTitle,
    username,
    displayName,
    isBot: !!(raw.isBot || raw.senderIsBot || raw.fromIsBot || user.is_bot),
    ...flags,
    source: compactTelegramDirectoryText(raw.source || 'runtime', 80),
    fetchedAt: raw.fetchedAt || raw.updatedAt || new Date().toISOString(),
  };
}

function memberCacheKey(chatId, userId) {
  const chat = sanitizeTelegramChatId(chatId);
  const user = sanitizeTelegramChatId(userId);
  return chat && user ? `${chat}:${user}` : '';
}

function readTelegramMemberMetadataCache(ws) {
  const file = getTelegramMemberMetadataPath(ws);
  if (!file) return { entries: {}, updatedAt: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      entries: parsed && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries) ? parsed.entries : {},
      updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : '',
    };
  } catch {
    return { entries: {}, updatedAt: '' };
  }
}

function writeTelegramMemberMetadataCache(cache = {}, ws) {
  const file = getTelegramMemberMetadataPath(ws);
  if (!file) return { success: false, error: 'workspace missing' };
  const payload = {
    updatedAt: new Date().toISOString(),
    entries: cache.entries && typeof cache.entries === 'object' && !Array.isArray(cache.entries) ? cache.entries : {},
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return { success: true, path: file, ...payload };
}

function saveTelegramMemberMetadata(raw = {}, ws) {
  const metadata = normalizeTelegramMemberMetadata(raw);
  const key = memberCacheKey(metadata.chatId, metadata.userId);
  if (!key) return null;
  const cache = readTelegramMemberMetadataCache(ws);
  cache.entries[key] = {
    ...(cache.entries[key] || {}),
    ...metadata,
    updatedAt: new Date().toISOString(),
  };
  writeTelegramMemberMetadataCache(cache, ws);
  return cache.entries[key];
}

function getTelegramMemberMetadata({ chatId, userId } = {}, ws) {
  const key = memberCacheKey(chatId, userId);
  if (!key) return null;
  const cache = readTelegramMemberMetadataCache(ws);
  return cache.entries[key] || null;
}

function requestTelegramJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { return reject(new Error('invalid Telegram response JSON')); }
        if (!parsed.ok) {
          const desc = parsed.description || `Telegram API returned ${res.statusCode}`;
          return reject(new Error(desc));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Telegram getChatMember timeout'));
    });
    req.end();
  });
}

async function fetchTelegramChatMember({ token, chatId, userId } = {}) {
  const chat = sanitizeTelegramChatId(chatId);
  const user = sanitizeTelegramChatId(userId);
  if (!token) throw new Error('telegram bot token missing');
  if (!chat) throw new Error('chatId required');
  if (!user) throw new Error('userId required');
  const qs = new URLSearchParams({ chat_id: chat, user_id: user });
  const url = `https://api.telegram.org/bot${token}/getChatMember?${qs.toString()}`;
  const parsed = await requestTelegramJson(url);
  return normalizeTelegramMemberMetadata({
    chatId: chat,
    userId: user,
    result: parsed.result,
    source: 'telegram-getChatMember',
    fetchedAt: new Date().toISOString(),
  });
}

async function refreshTelegramMemberMetadata({ token, chatId, userId } = {}, ws) {
  const metadata = await fetchTelegramChatMember({ token, chatId, userId });
  return saveTelegramMemberMetadata(metadata, ws);
}

module.exports = {
  TELEGRAM_MEMBER_METADATA_FILE,
  getTelegramMemberMetadataPath,
  normalizeTelegramMemberStatus,
  telegramMemberFlags,
  normalizeTelegramMemberMetadata,
  memberCacheKey,
  readTelegramMemberMetadataCache,
  writeTelegramMemberMetadataCache,
  saveTelegramMemberMetadata,
  getTelegramMemberMetadata,
  fetchTelegramChatMember,
  refreshTelegramMemberMetadata,
};
