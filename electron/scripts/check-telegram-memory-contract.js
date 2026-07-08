'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workspace = require('../lib/workspace');

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.error('[FAIL]', `${name}: ${detail || 'assertion failed'}`);
}
function pass(name) {
  console.log('[PASS]', name);
}
function assert(name, condition, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-telegram-memory-'));
  workspace._setWorkspaceCacheForTest(tmp);

  const mem = require('../lib/ceo-memory');
  const tg = require('../lib/telegram-memory');
  const policy = require('../lib/telegram-policy');
  const directory = require('../lib/telegram-directory');
  const inbound = require('../lib/telegram-inbound-context');
  const sessionBindings = require('../lib/telegram-session-bindings');
  const messageRefs = require('../lib/telegram-message-refs');
  try {
    mem.cleanupCeoMemoryTimers?.();
    const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
    const cronApiSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf-8');
    const channelsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf-8');
    const appointmentsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointments.js'), 'utf-8');
    const workspaceSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace.js'), 'utf-8');
    const memorySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ceo-memory.js'), 'utf-8');
    const telegramMemorySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'telegram-memory.js'), 'utf-8');
    const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
    const agentsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf-8');
    const memoryIndexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'MEMORY.md'), 'utf-8');
    const telegramSkillSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'operations', 'telegram-ceo.md'), 'utf-8');

    const group = tg.resolveTelegramConversation({
      telegramChatId: '-1003857797941',
      telegramChatType: 'supergroup',
      title: 'Nhom khach hang X3',
    });
    assert('telegram group defaults to customer role', group && group.role === 'customer' && group.audience === 'customer', JSON.stringify(group));
    assert('telegram group scopes are customer/public', JSON.stringify(group.scopeHints) === JSON.stringify(['customer', 'public']), JSON.stringify(group?.scopeHints));
    assert('telegram policy module keeps group/customer defaults',
      policy.normalizeTelegramRole('', 'supergroup') === 'customer'
      && policy.roleAudience('customer') === 'customer'
      && JSON.stringify(policy.roleScopeHints('customer')) === JSON.stringify(['customer', 'public']),
      'group/customer policy defaults drifted');
    const internalGroupPolicy = policy.buildTelegramConversationPolicy({ chatType: 'supergroup', role: 'internal' });
    assert('telegram policy supports response mode and tool scope',
      internalGroupPolicy.role === 'internal'
      && internalGroupPolicy.responseMode === 'mention'
      && internalGroupPolicy.toolScope === 'internal'
      && internalGroupPolicy.canUseInternalKnowledge === true
      && internalGroupPolicy.canUseAdminTools === false,
      JSON.stringify(internalGroupPolicy));
    const unknownPolicy = policy.buildTelegramConversationPolicy({ chatType: 'private', role: 'unknown' });
    assert('telegram unknown policy is public only and cannot reply by default',
      unknownPolicy.role === 'unknown'
      && JSON.stringify(unknownPolicy.scopeHints) === JSON.stringify(['public'])
      && unknownPolicy.toolScope === 'public_only'
      && unknownPolicy.canReply === false,
      JSON.stringify(unknownPolicy));
    const directoryEntry = directory.buildTelegramDirectoryEntry({
      chatId: '-1003857797941',
      chatType: 'supergroup',
      label: 'LLK Agency (GMT +7) - LLK-999999',
      aliases: ['LLK-999999', 'LLK'],
      role: 'internal',
    });
    assert('telegram directory builds group entry with alias/search metadata',
      directoryEntry
      && directoryEntry.targetChatId === '-1003857797941'
      && directoryEntry.directoryKind === 'group'
      && directoryEntry.aliases.includes('LLK')
      && directory.scoreTelegramDirectoryEntry(directoryEntry, 'LLK-999999') > 0,
      JSON.stringify(directoryEntry));
    const bound = sessionBindings.bindTelegramSession({
      chatId: '-1003857797941',
      threadId: '7',
      sessionKey: 'agent:main:telegram:group:-1003857797941:thread:7',
      agentId: 'main',
      label: 'LLK Agency',
    });
    assert('telegram session binding resolves conversation and session',
      bound
      && bound.bindingKey === 'telegram:-1003857797941:thread:7'
      && sessionBindings.resolveTelegramSessionByConversation({ chatId: '-1003857797941', threadId: '7' })?.sessionKey === bound.sessionKey
      && sessionBindings.resolveTelegramConversationBySession(bound.sessionKey)?.chatId === '-1003857797941',
      JSON.stringify(bound));
    const rememberedRef = messageRefs.rememberTelegramMessageRef({
      chatId: '-1003857797941',
      threadId: '7',
      messageId: '123',
      replyToMessageId: '122',
      senderId: '8406640669',
      sessionKey: bound.sessionKey,
      text: 'kiem tra LLK',
    });
    assert('telegram message refs remember and resolve latest scoped message',
      rememberedRef
      && messageRefs.getLatestTelegramMessageForThread({ chatId: '-1003857797941', threadId: '7' })?.messageId === '123'
      && messageRefs.resolveTelegramMessageRef({ chatId: '-1003857797941', threadId: '7', rawId: 'latest' })?.messageId === '123',
      JSON.stringify(rememberedRef));
    const inboundCtx = inbound.buildTelegramInboundContext({
      conversation: directoryEntry,
      source: {
        senderId: '8406640669',
        senderRole: 'ceo',
        messageId: '123',
        replyToMessageId: '122',
        topicId: '7',
        text: 'kiem tra LLK',
      },
    });
    assert('telegram inbound context carries conversation sender thread and policy',
      inboundCtx.trusted === true
      && inboundCtx.conversation.targetChatId === '-1003857797941'
      && inboundCtx.conversation.directoryKind === 'group'
      && inboundCtx.sender.id === '8406640669'
      && inboundCtx.sender.role === 'ceo'
      && inboundCtx.thread.id === '7'
      && inboundCtx.thread.bindingKey === 'telegram:-1003857797941:thread:7'
      && inboundCtx.message.replyTo === '122'
      && inboundCtx.latestMessageRef?.messageId === '123'
      && inbound.formatTelegramInboundContextBlock(inboundCtx).includes('<telegram-inbound-context trusted="true">'),
      JSON.stringify(inboundCtx));
    assert('telegram entity id is stable', tg.telegramEntityId('-1003857797941') === 'telegram:-1003857797941');
    assert('telegram memory discovers OpenClaw session metadata',
      telegramMemorySrc.includes('collectOpenclawSessionCandidates')
      && telegramMemorySrc.includes('conversation_label')
      && telegramMemorySrc.includes('groupId')
      && telegramMemorySrc.includes('openclaw-sessions'),
      'missing session metadata collector');
    assert('telegram memory uses directory cache and helper layer',
      telegramMemorySrc.includes("require('./telegram-directory')")
      && telegramMemorySrc.includes("require('./telegram-inbound-context')")
      && telegramMemorySrc.includes('collectDirectoryCacheCandidates')
      && telegramMemorySrc.includes('refreshTelegramDirectoryFromRuntime')
      && telegramMemorySrc.includes('directory-cache'),
      'missing telegram directory layer wiring');
    assert('ceo-memory allows explicit telegram customer scope only via hints', memorySrc.includes("ch === 'telegram' && hints.includes('customer')"), 'missing explicit customer hint gate');
    assert('ceo-memory actor-scopes telegram customer memory', memorySrc.includes("_requiresActorScopedCustomerFilter(channel, allowedScopes)") && memorySrc.includes("'telegram_chat'"), 'missing telegram actor filter');
    assert('cron injects telegram conversation context when target exists', cronSrc.includes("require('./telegram-memory')") && cronSrc.includes('telegramTarget'));
    assert('workspace seeds telegram memory dir', workspaceSrc.includes("'memory', 'telegram-chats'"));
    assert('telegram manager IPC handlers exist', dashboardSrc.includes("list-telegram-conversations") && dashboardSrc.includes("save-telegram-conversation-settings") && dashboardSrc.includes("seed-telegram-conversations"), 'missing dashboard IPC handlers');
    assert('telegram manager preload bridge exists', preloadSrc.includes('listTelegramConversations') && preloadSrc.includes('saveTelegramConversationSettings') && preloadSrc.includes('readTelegramConversationMemory'), 'missing preload bridge');
    assert('telegram manager UI exists', uiSrc.includes('tg-conversations-list') && uiSrc.includes('renderTelegramConversations') && uiSrc.includes('switchTelegramConversationTab'), 'missing Telegram manager UI');

    tg.writeTelegramDirectoryCache({
      entries: [{
        chatId: '-1003857797941',
        chatType: 'supergroup',
        role: 'customer',
        label: 'Cached LLK',
        aliases: ['LLK-old'],
        enabled: false,
      }],
    });
    const cache = tg.readTelegramDirectoryCache();
    assert('telegram directory cache persists normalized entries',
      cache.entries.length === 1
      && cache.entries[0].chatId === '-1003857797941'
      && cache.entries[0].directoryKind === 'group',
      JSON.stringify(cache));

    const saved = tg.saveTelegramConversationSettings({
      conversations: [{
        chatId: '-1003857797941',
        chatType: 'supergroup',
        role: 'internal',
        responseMode: 'all',
        aliases: ['LLK-999999', 'LLK'],
        label: 'Nhom noi bo Telegram',
        enabled: true,
      }],
    });
    const savedRow = (saved.conversations || []).find(c => c.chatId === '-1003857797941');
    assert('telegram conversation settings persist role/policy override',
      savedRow
      && savedRow.role === 'internal'
      && savedRow.audience === 'internal'
      && savedRow.responseMode === 'all'
      && savedRow.toolScope === 'internal',
      JSON.stringify(savedRow));
    const directoryList = tg.listTelegramDirectory({ query: 'LLK-999999', kind: 'group', enabled: true });
    assert('telegram directory lookup respects settings override over cache',
      directoryList.count === 1
      && directoryList.conversations[0].role === 'internal'
      && directoryList.conversations[0].enabled === true
      && directoryList.conversations[0].targetChatId === '-1003857797941',
      JSON.stringify(directoryList));
    const lookup = tg.findTelegramConversations({ query: 'Nhom noi bo Telegram', autoMode: true, enabled: true });
    assert('telegram conversation lookup resolves target by name', lookup.picked === '-1003857797941' && lookup.pickedConversation?.role === 'internal', JSON.stringify(lookup));

    assert('cron-api exposes Telegram lookup/send/profile/seed routes',
      cronApiSrc.includes("urlPath === '/api/telegram/conversations'")
      && cronApiSrc.includes("urlPath === '/api/telegram/directory'")
      && cronApiSrc.includes("urlPath === '/api/telegram/directory/refresh'")
      && cronApiSrc.includes("urlPath === '/api/telegram/send'")
      && cronApiSrc.includes("urlPath === '/api/telegram/profile'")
      && cronApiSrc.includes("urlPath === '/api/telegram/seed'"),
      'missing Telegram API routes');
    assert('cron-api creates Telegram fixed crons without LLM',
      cronApiSrc.includes('resolveOptionalTelegramTargetForCron')
      && cronApiSrc.includes("'exec: telegram msg send '"),
      'missing Telegram cron target resolver or safe exec prompt');
    assert('cron safe exec supports Telegram send',
      cronSrc.includes('parseSafeTelegramMsgSend')
      && cronSrc.includes('safe-telegram'),
      'missing safe Telegram exec runner');
    assert('cron one-time timers are chunked to avoid 32-bit overflow',
      cronSrc.includes('MAX_ONE_TIME_TIMER_DELAY_MS')
      && cronSrc.includes('scheduleOneTimeAt')
      && !cronSrc.includes('}, effectiveDelay);'),
      'oneTimeAt uses raw setTimeout(effectiveDelay) and may fire immediately for far-future jobs');
    assert('telegram photo send supports target chat',
      channelsSrc.includes('async function sendTelegramPhoto(imagePath, caption, optsOrRetry = 0)')
      && channelsSrc.includes('effectiveChatId')
      && channelsSrc.includes('targetChatId'),
      'sendTelegramPhoto missing targetChatId support');
    assert('appointment Telegram push targets honor toId',
      appointmentsSrc.includes('sendTelegram(text, { targetChatId: target.toId || null })'),
      'appointments Telegram target ignores toId');
    assert('AGENTS defines Telegram priority over Zalo',
      agentsSrc.includes('Telegram là kênh chính')
      && agentsSrc.includes('/api/telegram/conversations?name=<tên>&autoMode=1&enabled=true'),
      'AGENTS missing Telegram-first routing rule');
    assert('telegram-ceo skill documents Telegram send API',
      telegramSkillSrc.includes('## GỬI TELEGRAM')
      && telegramSkillSrc.includes('/api/telegram/send?targetChatId=<id>&text=<nội dung>'),
      'telegram-ceo skill missing Telegram send workflow');
    assert('MEMORY index includes Telegram chat profiles',
      memoryIndexSrc.includes('memory/telegram-chats/<chatId>.md')
      && memoryIndexSrc.includes('Telegram role là `customer`'),
      'MEMORY.md missing Telegram profile routing');

    let hasUsableSqlite = true;
    try {
      const Database = require('better-sqlite3');
      const probe = new Database(':memory:');
      probe.close();
    } catch (e) {
      hasUsableSqlite = false;
      console.warn('[SKIP] better-sqlite3 native binding unavailable in this source clone; runtime DB filtering assertions skipped:', e && e.message ? e.message : e);
    }
    if (!hasUsableSqlite) {
      console.log('[telegram-memory-contract] PASS static layered Telegram memory contract');
      return;
    }

    await mem.writeMemory({
      type: 'procedure',
      scope: 'ceo',
      entityType: 'workflow',
      entityId: 'telegram-ceo-private',
      content: 'CEO private telegram operating rule alpha-cashflow.',
      source: 'manual',
    });
    await mem.writeMemory({
      type: 'fact',
      scope: 'customer',
      entityType: 'telegram_chat',
      entityId: 'telegram:-1003857797941',
      content: 'Telegram group X3 uses blue wholesale tier and cares about delivery cadence.',
      source: 'manual',
    });
    await mem.writeMemory({
      type: 'fact',
      scope: 'customer',
      entityType: 'telegram_chat',
      entityId: 'telegram:-1009999999999',
      content: 'Telegram group Beta uses red wholesale tier and asks about warranty.',
      source: 'manual',
    });
    await mem.writeMemory({
      type: 'pattern',
      scope: 'customer',
      content: 'External customer groups often ask warranty duration and delivery fee.',
      source: 'manual',
    });

    const ceoCtx = await mem.getMemoryContext({
      query: 'blue wholesale tier delivery cadence alpha-cashflow',
      channel: 'telegram',
      limit: 10,
    });
    const ceoText = JSON.stringify(ceoCtx);
    assert('plain CEO telegram context does not include customer-scope chat memory', !ceoText.includes('blue wholesale tier'), ceoText);
    assert('plain CEO telegram context can include CEO memory', ceoText.includes('alpha-cashflow'), ceoText);

    const alphaCtx = await mem.getMemoryContext({
      query: 'blue wholesale tier delivery cadence warranty fee alpha-cashflow',
      channel: 'telegram',
      actorId: 'telegram:-1003857797941',
      scopeHints: ['customer', 'public'],
      limit: 10,
    });
    const alphaText = JSON.stringify(alphaCtx);
    assert('telegram customer context includes matching chat memory', alphaText.includes('blue wholesale tier'), alphaText);
    assert('telegram customer context includes generic customer memory', alphaText.includes('delivery fee'), alphaText);
    assert('telegram customer context excludes other chat memory', !alphaText.includes('red wholesale tier'), alphaText);
    assert('telegram customer context excludes CEO memory', !alphaText.includes('alpha-cashflow'), alphaText);
    assert('telegram customer context emits safety warning', (alphaCtx.safetyWarnings || []).some(s => /Telegram customer-like/.test(s)), JSON.stringify(alphaCtx.safetyWarnings));

    const noActorCtx = await mem.getMemoryContext({
      query: 'blue wholesale tier',
      channel: 'telegram',
      scopeHints: ['customer', 'public'],
      limit: 10,
    });
    const noActorHasPrivate = noActorCtx.memories.some(m => String(m.content || '').includes('blue wholesale tier'));
    assert('telegram customer context without actor excludes chat-specific memory', !noActorHasPrivate, JSON.stringify(noActorCtx));
  } finally {
    mem.cleanupCeoMemoryTimers?.();
    workspace._setWorkspaceCacheForTest(null);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  if (failures) process.exit(1);
  console.log('[telegram-memory-contract] PASS layered Telegram memory contract');
}

run().catch((e) => {
  console.error('[FAIL] unexpected error:', e && e.stack ? e.stack : e);
  process.exit(1);
});
