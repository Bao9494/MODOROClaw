'use strict';

function normalizeTelegramChatId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return /^-?\d{5,32}$/.test(s) ? s : null;
}

function pickHeader(headers, ...names) {
  for (const name of names) {
    const v = headers && headers[String(name).toLowerCase()];
    if (Array.isArray(v) && v.length) return String(v[0]);
    if (v != null && String(v).trim()) return String(v);
  }
  return '';
}

function extractTelegramChatIdFromSessionKey(sessionKey) {
  const s = String(sessionKey || '').trim();
  if (!s) return null;
  const patterns = [
    /(?:^|:)telegram:(?:direct|private|group|supergroup):(-?\d{5,32})(?::|$)/i,
    /(?:^|:)telegram:(-?\d{5,32})(?::|$)/i,
    /(?:^|:)direct:(-?\d{5,32})(?::|$)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return normalizeTelegramChatId(m[1]);
  }
  return null;
}

function buildTelegramTargetFromContext(source = {}, headers = {}) {
  const nested = source.telegramTarget && typeof source.telegramTarget === 'object' ? source.telegramTarget : {};
  const sessionKey = String(
    source.agentSessionKey
    || source.sessionKey
    || nested.agentSessionKey
    || pickHeader(headers, 'x-9bizclaw-agent-session-key', 'x-agent-session-key')
    || ''
  ).trim();
  const explicitTarget = normalizeTelegramChatId(
    source.explicitTarget
    || source.explicitTelegramTarget
    || source.telegramTargetChatId
    || nested.explicitTarget
    || pickHeader(headers, 'x-9bizclaw-telegram-explicit-target', 'x-telegram-explicit-target')
  );
  const replyChatId = normalizeTelegramChatId(
    source.replyChatId
    || source.telegramReplyChatId
    || nested.replyChatId
    || pickHeader(headers, 'x-9bizclaw-telegram-reply-chat-id', 'x-9bizclaw-reply-chat-id', 'x-telegram-reply-chat-id')
  );
  const originChatId = normalizeTelegramChatId(
    source.originChatId
    || source.telegramOriginChatId
    || source.telegramChatId
    || source.chatId
    || nested.originChatId
    || pickHeader(headers, 'x-9bizclaw-telegram-origin-chat-id', 'x-9bizclaw-telegram-chat-id', 'x-telegram-chat-id')
    || extractTelegramChatIdFromSessionKey(sessionKey)
  );
  if (!explicitTarget && !replyChatId && !originChatId) return null;
  const originChatType = String(
    source.originChatType
    || source.telegramChatType
    || nested.originChatType
    || pickHeader(headers, 'x-9bizclaw-telegram-chat-type', 'x-telegram-chat-type')
    || ''
  ).trim();
  const out = {
    originChannel: 'telegram',
    replyMode: explicitTarget ? 'explicit_target' : 'same_chat',
  };
  if (originChatId) out.originChatId = originChatId;
  if (originChatType) out.originChatType = originChatType;
  if (replyChatId || originChatId) out.replyChatId = replyChatId || originChatId;
  if (explicitTarget) out.explicitTarget = explicitTarget;
  return out;
}

function resolveTelegramChatIdFromTarget(telegramTarget) {
  if (!telegramTarget || typeof telegramTarget !== 'object') return null;
  return normalizeTelegramChatId(telegramTarget.explicitTarget)
    || normalizeTelegramChatId(telegramTarget.replyChatId)
    || normalizeTelegramChatId(telegramTarget.originChatId);
}

module.exports = {
  normalizeTelegramChatId,
  pickHeader,
  extractTelegramChatIdFromSessionKey,
  buildTelegramTargetFromContext,
  resolveTelegramChatIdFromTarget,
};
