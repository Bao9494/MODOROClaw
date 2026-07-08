'use strict';

const ROLE_ALIASES = {
  ceo: 'ceo',
  owner: 'ceo',
  admin: 'ceo',
  boss: 'ceo',
  internal: 'internal',
  staff: 'internal',
  team: 'internal',
  employee: 'internal',
  noi_bo: 'internal',
  'nội bộ': 'internal',
  customer: 'customer',
  client: 'customer',
  external: 'customer',
  group: 'customer',
  khach: 'customer',
  'khách': 'customer',
  unknown: 'unknown',
  unclassified: 'unknown',
};

const RESPONSE_MODE_ALIASES = {
  off: 'off',
  disabled: 'off',
  false: 'off',
  tat: 'off',
  'tắt': 'off',
  mention: 'mention',
  '@mention': 'mention',
  mentions: 'mention',
  all: 'all',
  auto: 'all',
  on: 'all',
  true: 'all',
  moi_tin: 'all',
  'mọi tin': 'all',
  ceo: 'ceo_priority',
  ceo_priority: 'ceo_priority',
  'ceo ưu tiên': 'ceo_priority',
};

function normalizeTelegramChatType(chatType = '') {
  const raw = String(chatType || '').trim().toLowerCase();
  if (['private', 'dm', 'direct'].includes(raw)) return 'private';
  if (['group', 'supergroup', 'channel'].includes(raw)) return raw;
  return raw || 'unknown';
}

function isTelegramGroupLike(chatType = '') {
  return ['group', 'supergroup', 'channel'].includes(normalizeTelegramChatType(chatType));
}

function normalizeTelegramRole(role, chatType = '') {
  const raw = String(role || '').trim().toLowerCase();
  if (raw && ROLE_ALIASES[raw]) return ROLE_ALIASES[raw];
  return isTelegramGroupLike(chatType) ? 'customer' : 'ceo';
}

function roleAudience(role) {
  const r = normalizeTelegramRole(role);
  if (r === 'ceo') return 'ceo';
  if (r === 'internal') return 'internal';
  if (r === 'unknown') return 'public';
  return 'customer';
}

function roleScopeHints(role) {
  const r = normalizeTelegramRole(role);
  if (r === 'ceo') return ['ceo', 'internal', 'workflow', 'public'];
  if (r === 'internal') return ['internal', 'workflow', 'public'];
  if (r === 'unknown') return ['public'];
  return ['customer', 'public'];
}

function roleToolScope(role) {
  const r = normalizeTelegramRole(role);
  if (r === 'ceo') return 'admin';
  if (r === 'internal') return 'internal';
  if (r === 'customer') return 'customer';
  return 'public_only';
}

function normalizeTelegramResponseMode(mode, { role = '', chatType = '' } = {}) {
  const raw = String(mode || '').trim().toLowerCase();
  if (raw && RESPONSE_MODE_ALIASES[raw]) return RESPONSE_MODE_ALIASES[raw];
  const r = normalizeTelegramRole(role, chatType);
  if (r === 'ceo') return 'all';
  if (r === 'internal') return isTelegramGroupLike(chatType) ? 'mention' : 'all';
  if (r === 'customer') return 'mention';
  return 'off';
}

function normalizeTelegramEnabled(value, defaultValue = true) {
  if (value == null || value === '') return defaultValue !== false;
  return !['0', 'false', 'off', 'disabled', 'no', 'khong', 'không', 'tat', 'tắt'].includes(String(value).trim().toLowerCase());
}

function buildTelegramConversationPolicy(input = {}) {
  const chatType = normalizeTelegramChatType(input.chatType || input.telegramChatType);
  const role = normalizeTelegramRole(input.role || input.telegramRole, chatType);
  const responseMode = normalizeTelegramResponseMode(input.responseMode || input.mode, { role, chatType });
  const enabled = normalizeTelegramEnabled(input.enabled, true);
  const audience = roleAudience(role);
  const scopeHints = roleScopeHints(role);
  const toolScope = input.toolScope || roleToolScope(role);
  return {
    enabled,
    role,
    chatType,
    responseMode,
    audience,
    scopeHints,
    toolScope,
    canReply: enabled && responseMode !== 'off',
    canUseAdminTools: enabled && role === 'ceo',
    canUseInternalKnowledge: enabled && (role === 'ceo' || role === 'internal'),
    canUseCustomerKnowledge: enabled && role === 'customer',
    canSendOutbound: enabled && responseMode !== 'off' && role !== 'unknown',
  };
}

function compareTelegramRoles(a, b) {
  const rank = { ceo: 0, internal: 1, customer: 2, unknown: 3 };
  return (rank[normalizeTelegramRole(a)] ?? 9) - (rank[normalizeTelegramRole(b)] ?? 9);
}

module.exports = {
  normalizeTelegramChatType,
  isTelegramGroupLike,
  normalizeTelegramRole,
  roleAudience,
  roleScopeHints,
  roleToolScope,
  normalizeTelegramResponseMode,
  normalizeTelegramEnabled,
  buildTelegramConversationPolicy,
  compareTelegramRoles,
};
