'use strict';

const { makeTelegramConversationBindingKey } = require('./telegram-session-bindings');
const { getLatestTelegramMessageForThread } = require('./telegram-message-refs');

function compactTelegramContextText(value, max = 220) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeTelegramContextId(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return /^-?\d{1,64}$/.test(s) ? s : '';
}

function pickFirst(source = {}, keys = []) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function buildTelegramSenderContext(source = {}) {
  const senderId = sanitizeTelegramContextId(pickFirst(source, [
    'senderId',
    'telegramSenderId',
    'fromId',
    'fromUserId',
    'userId',
    'authorId',
  ]));
  return {
    id: senderId,
    username: compactTelegramContextText(pickFirst(source, ['senderUsername', 'fromUsername', 'username', 'handle']), 120),
    displayName: compactTelegramContextText(pickFirst(source, ['senderName', 'senderDisplayName', 'fromName', 'displayName', 'authorName']), 120),
    role: compactTelegramContextText(pickFirst(source, ['senderRole', 'fromRole', 'memberRole']), 40) || 'unknown',
    isBot: !!(source.senderIsBot || source.fromIsBot || source.isBot),
  };
}

function buildTelegramThreadContext(source = {}) {
  const threadId = sanitizeTelegramContextId(pickFirst(source, [
    'threadId',
    'topicId',
    'messageThreadId',
    'telegramThreadId',
    'telegramTopicId',
  ]));
  return {
    id: threadId,
    title: compactTelegramContextText(pickFirst(source, ['threadTitle', 'topicTitle', 'telegramTopicTitle']), 140),
  };
}

function buildTelegramMessageContext(source = {}) {
  return {
    id: sanitizeTelegramContextId(pickFirst(source, ['messageId', 'telegramMessageId', 'msgId', 'id'])),
    replyTo: sanitizeTelegramContextId(pickFirst(source, ['replyToMessageId', 'replyTo', 'quoteMessageId'])),
    textPreview: compactTelegramContextText(pickFirst(source, ['text', 'body', 'message', 'prompt']), 280),
    hasMedia: !!(source.hasMedia || source.media || source.mediaUrl || source.photo || source.document),
  };
}

function buildTelegramInboundContext({ conversation = {}, source = {}, profile = null, memory = null } = {}) {
  const policy = conversation.policy || {};
  const memories = Array.isArray(memory?.memories) ? memory.memories : [];
  const thread = buildTelegramThreadContext(source);
  const bindingKey = makeTelegramConversationBindingKey({
    chatId: conversation.targetChatId || conversation.chatId,
    threadId: thread.id,
  });
  const latestMessageRef = getLatestTelegramMessageForThread({
    chatId: conversation.targetChatId || conversation.chatId,
    threadId: thread.id,
  });
  return {
    trusted: true,
    channel: 'telegram',
    priority: 'primary',
    conversation: {
      chatId: conversation.chatId || '',
      targetChatId: conversation.targetChatId || conversation.chatId || '',
      entityId: conversation.entityId || '',
      chatType: conversation.chatType || 'unknown',
      directoryKind: conversation.directoryKind || 'unknown',
      role: conversation.role || 'unknown',
      audience: conversation.audience || 'public',
      responseMode: conversation.responseMode || 'off',
      toolScope: conversation.toolScope || 'public_only',
      label: conversation.label || '',
      aliases: Array.isArray(conversation.aliases) ? conversation.aliases : [],
      scopes: Array.isArray(conversation.scopeHints) ? conversation.scopeHints : [],
      bindingKey,
    },
    sender: buildTelegramSenderContext(source),
    thread: {
      ...thread,
      bindingKey,
    },
    message: buildTelegramMessageContext(source),
    latestMessageRef: latestMessageRef ? {
      messageId: latestMessageRef.messageId,
      shortId: latestMessageRef.shortId,
      direction: latestMessageRef.direction,
      timestamp: latestMessageRef.timestamp,
      preview: latestMessageRef.preview,
    } : null,
    memory: {
      profilePath: profile?.path || conversation.profilePath || '',
      profileLoaded: !!profile,
      memoryCount: memories.length,
      scopes: Array.isArray(conversation.scopeHints) ? conversation.scopeHints : [],
    },
    policy: {
      canReply: policy.canReply !== false,
      canUseAdminTools: !!policy.canUseAdminTools,
      canUseInternalKnowledge: !!policy.canUseInternalKnowledge,
      canUseCustomerKnowledge: !!policy.canUseCustomerKnowledge,
      canSendOutbound: policy.canSendOutbound !== false,
    },
  };
}

function formatTelegramInboundContextBlock(ctx) {
  if (!ctx) return '';
  return `<telegram-inbound-context trusted="true">\n${JSON.stringify(ctx)}\n</telegram-inbound-context>`;
}

module.exports = {
  compactTelegramContextText,
  sanitizeTelegramContextId,
  buildTelegramSenderContext,
  buildTelegramThreadContext,
  buildTelegramMessageContext,
  buildTelegramInboundContext,
  formatTelegramInboundContextBlock,
};
