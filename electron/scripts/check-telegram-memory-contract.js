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
  const runtimeCapture = require('../lib/telegram-runtime-capture');
  const historyArchive = require('../lib/telegram-history-archive');
  const channels = require('../lib/channels');
  try {
    mem.cleanupCeoMemoryTimers?.();
    const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
    const cronApiSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf-8');
    const channelsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf-8');
    const appointmentsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointments.js'), 'utf-8');
    const workspaceSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace.js'), 'utf-8');
    const sacredDataSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sacred-data.js'), 'utf-8');
    const memorySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ceo-memory.js'), 'utf-8');
    const telegramMemorySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'telegram-memory.js'), 'utf-8');
    const vendorPatchSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vendor-patches.js'), 'utf-8');
    const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
    const gatewaySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gateway.js'), 'utf-8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');
    const agentsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf-8');
    const memoryIndexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'MEMORY.md'), 'utf-8');
    const telegramSkillSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'operations', 'telegram-ceo.md'), 'utf-8');

    assert('telegram vendor patch captures inbound history from dispatch and mention-skip paths',
      vendorPatchSrc.includes('20260710-telegram-inbound-history-capture-v1')
      && vendorPatchSrc.includes('ensureTelegramInboundHistoryCapturePatch')
      && vendorPatchSrc.includes('record9BizClawTelegramInboundHistory')
      && vendorPatchSrc.includes('telegram-provider-inbound-dispatch')
      && vendorPatchSrc.includes('telegram-provider-inbound-skip')
      && vendorPatchSrc.includes('ensureTelegramInboundHistoryCapturePatch(vendorDir, homeDir)'),
      'missing Telegram inbound history vendor patch guard');
    assert('telegram vendor patch suppresses pre-typing for no-mention group messages',
      vendorPatchSrc.includes('20260710-telegram-no-mention-pretyping-v1')
      && vendorPatchSrc.includes('ensureTelegramNoMentionPretypingPatch')
      && vendorPatchSrc.includes('should9BizClawTelegramPreTyping')
      && vendorPatchSrc.includes('ensureTelegramNoMentionPretypingPatch(vendorDir, homeDir)'),
      'missing Telegram no-mention pretyping guard');
    assert('telegram vendor patch answers layered context lookups without slow provider path',
      vendorPatchSrc.includes('20260710-fast-telegram-context-lookup-v1')
      && vendorPatchSrc.includes('ensureTelegramFastContextLookupPatch')
      && vendorPatchSrc.includes('try9BizClawTelegramContextLookupFastPath')
      && vendorPatchSrc.includes('fast-telegram-context-lookup')
      && vendorPatchSrc.includes('ensureTelegramFastContextLookupPatch(vendorDir, homeDir)'),
      'missing Telegram fast context lookup vendor patch guard');
    assert('telegram fast context guard only warns on real sensitive actions',
      vendorPatchSrc.includes('const sensitiveActionRequest =')
      && vendorPatchSrc.includes('const rolePolicyChangeRequest =')
      && vendorPatchSrc.includes('const actionSafety = sensitiveActionRequest || rolePolicyChangeRequest;'),
      'Telegram fast context actionSafety is too broad for read-only context questions');

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
    const staleScopePolicy = policy.buildTelegramConversationPolicy({ chatType: 'supergroup', role: 'internal', toolScope: 'customer' });
    assert('telegram policy rejects stale tool scope when role changes',
      staleScopePolicy.role === 'internal'
      && staleScopePolicy.toolScope === 'internal'
      && staleScopePolicy.canUseInternalKnowledge === true
      && staleScopePolicy.canUseCustomerKnowledge === false,
      JSON.stringify(staleScopePolicy));
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
    const directoryCounts = directory.summarizeTelegramDirectory([
      directoryEntry,
      directory.buildTelegramDirectoryEntry({ chatId: '8406640669', chatType: 'private', role: 'unknown' }),
      directory.buildTelegramDirectoryEntry({ chatId: '1234567890', chatType: 'unknown', role: 'customer' }),
    ]);
    assert('telegram directory counts keep role unknown separate from unknown chat kind',
      directoryCounts.unknown === 1
      && directoryCounts.unknownKind === 1
      && directoryCounts.private === 1
      && directoryCounts.group === 1,
      JSON.stringify(directoryCounts));
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
        memberStatus: 'administrator',
        customTitle: 'Ops Admin',
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
      && inboundCtx.sender.memberStatus === 'administrator'
      && inboundCtx.sender.memberTitle === 'Ops Admin'
      && inboundCtx.sender.isAdmin === true
      && inboundCtx.thread.id === '7'
      && inboundCtx.thread.bindingKey === 'telegram:-1003857797941:thread:7'
      && inboundCtx.message.replyTo === '122'
      && inboundCtx.latestMessageRef?.messageId === '123'
      && inbound.formatTelegramInboundContextBlock(inboundCtx).includes('<telegram-inbound-context trusted="true">'),
      JSON.stringify(inboundCtx));
    const capturedRuntime = runtimeCapture.captureTelegramRuntimeEvent({
      direction: 'inbound',
      chatId: '-1003857797941',
      chatType: 'supergroup',
      title: 'LLK Agency (GMT +7) - LLK-999999',
      senderId: '8406640669',
      senderName: 'Anh Bao',
      senderRole: 'ceo',
      memberStatus: 'administrator',
      customTitle: 'Ops Admin',
      threadId: '7',
      messageId: '456',
      replyToMessageId: '123',
      sessionKey: 'agent:main:telegram:group:-1003857797941:thread:7',
      text: 'cap nhat memory Telegram runtime',
      timestamp: Date.now(),
    });
    const capturedGroupProfile = runtimeCapture.getTelegramTierProfilePath({ chatId: '-1003857797941', chatType: 'supergroup' });
    const capturedUserProfile = runtimeCapture.getTelegramTierProfilePath({ senderId: '8406640669' });
    assert('telegram runtime capture updates refs bindings directory and tier profiles',
      capturedRuntime
      && capturedRuntime.conversation?.chatId === '-1003857797941'
      && capturedRuntime.messageRef?.messageId === '456'
      && capturedRuntime.historyAppend?.appended === 1
      && messageRefs.getLatestTelegramMessageForThread({ chatId: '-1003857797941', threadId: '7' })?.messageId === '456'
      && sessionBindings.resolveTelegramSessionByConversation({ chatId: '-1003857797941', threadId: '7' })?.sessionKey === capturedRuntime.binding?.sessionKey
      && fs.existsSync(capturedGroupProfile)
      && fs.existsSync(capturedUserProfile)
      && tg.listTelegramDirectory({ query: 'LLK-999999', kind: 'group', enabled: true }).count >= 1,
      JSON.stringify(capturedRuntime));
    runtimeCapture.captureTelegramRuntimeEvent({
      direction: 'inbound',
      chatId: '-1003857797941',
      chatType: 'supergroup',
      title: 'LLK Agency (GMT +7) - LLK-999999',
      senderId: '8406640669',
      threadId: '7',
      messageId: '456',
      text: 'duplicate should not append twice',
      timestamp: Date.now(),
    });
    const archivedThread = historyArchive.readTelegramHistory(tmp, '-1003857797941', { threadId: '7', limit: 10 });
    assert('telegram history archive stores runtime capture and dedups message ids',
      archivedThread.length === 1
      && archivedThread[0].messageId === '456'
      && archivedThread[0].chatId === '-1003857797941'
      && archivedThread[0].threadId === '7'
      && archivedThread[0].memberStatus === 'administrator'
      && archivedThread[0].memberTitle === 'Ops Admin'
      && archivedThread[0].text.includes('cap nhat memory'),
      JSON.stringify(archivedThread));
    historyArchive.appendTelegramHistoryEvents(tmp, [
      {
        direction: 'inbound',
        chatId: '-1005555555555',
        chatType: 'supergroup',
        label: 'History Rich Telegram Group',
        senderId: '111111111',
        senderName: 'Anh Bao',
        threadId: '42',
        messageId: '9001',
        text: 'Khach dang quan tam goi SaaS premium va can cham soc gan gui.',
        timestamp: Date.parse('2026-07-09T09:00:00.000Z'),
      },
      {
        direction: 'outbound',
        chatId: '-1005555555555',
        chatType: 'supergroup',
        label: 'History Rich Telegram Group',
        senderId: '222222222',
        senderName: 'LLD_ASSISTANT',
        threadId: '42',
        messageId: '9002',
        text: 'Em se uu tien phan hoi ngan gon va xac nhan dung nhu cau premium.',
        timestamp: Date.parse('2026-07-09T09:01:00.000Z'),
      },
    ]);
    const historyOnlySeeded = tg.seedTelegramConversationsFromRuntime();
    const historyOnlyConversation = historyOnlySeeded.seeded.find(c => c.chatId === '-1005555555555');
    const historyOnlyProfile = tg.readTelegramConversationProfile('-1005555555555', 12000)?.content || '';
    assert('telegram seed discovers history-only chats and auto-fills rich profile sections',
      historyOnlyConversation
      && historyOnlyConversation.sources.includes('history-archive')
      && historyOnlyConversation.msgCount >= 2
      && historyOnlyConversation.summary.includes('SaaS premium')
      && historyOnlyProfile.includes('History Rich Telegram Group')
      && historyOnlyProfile.includes('Nguoi tham gia gan day: Anh Bao, LLD_ASSISTANT')
      && historyOnlyProfile.includes('Topic/thread gan day: 42')
      && historyOnlyProfile.includes('So tin da luu: 2')
      && historyOnlyProfile.includes('SaaS premium')
      && !historyOnlyProfile.includes('## Ho so doi tuong\n(chua co)'),
      JSON.stringify({ historyOnlyConversation, historyOnlyProfile }));
    runtimeCapture.ensureTelegramTierProfile({
      chatId: '-1007777777777',
      chatType: 'supergroup',
      label: 'Tier Only Telegram Group',
      role: 'internal',
    });
    const tierOnlyLookup = tg.listTelegramDirectory({ query: 'Tier Only Telegram Group', kind: 'group', limit: 5 });
    assert('telegram memory scans tier user/group profile dirs',
      tierOnlyLookup.count >= 1
      && tierOnlyLookup.conversations.some(c => c.chatId === '-1007777777777' && c.directoryKind === 'group'),
      JSON.stringify(tierOnlyLookup));
    assert('telegram private note helpers are exported',
      typeof tg.appendTelegramConversationNote === 'function'
      && typeof tg.deleteTelegramConversationNote === 'function',
      'missing append/delete Telegram conversation note helpers');
    if (typeof tg.appendTelegramConversationNote === 'function' && typeof tg.deleteTelegramConversationNote === 'function') {
      const appendedNote = tg.appendTelegramConversationNote({
        chatId: '-1007777777777',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Tier Only Telegram Group',
        note: 'Khach nay thich trao doi ngan gon va can nhac lai bang gia truoc khi chot.',
      });
      const noteProfile = tg.readTelegramConversationProfile('-1007777777777', 8000);
      assert('telegram private note append writes CEO notes section',
        appendedNote?.success === true
        && !!appendedNote.timestamp
        && noteProfile?.content.includes('## CEO notes')
        && noteProfile?.content.includes('Khach nay thich trao doi ngan gon'),
        JSON.stringify({ appendedNote, content: noteProfile?.content }));
      const deletedNote = tg.deleteTelegramConversationNote({
        chatId: '-1007777777777',
        noteTimestamp: appendedNote.timestamp,
      });
      const noteProfileAfterDelete = tg.readTelegramConversationProfile('-1007777777777', 8000);
      assert('telegram private note delete removes only matching CEO note line',
        deletedNote?.success === true
        && noteProfileAfterDelete?.content.includes('## CEO notes')
        && !noteProfileAfterDelete?.content.includes('Khach nay thich trao doi ngan gon'),
        JSON.stringify({ deletedNote, content: noteProfileAfterDelete?.content }));
    }
    assert('telegram profile section editor helper is exported',
      typeof tg.saveTelegramConversationProfileSections === 'function',
      'missing saveTelegramConversationProfileSections helper');
    if (typeof tg.saveTelegramConversationProfileSections === 'function') {
      tg.appendTelegramConversationNote({
        chatId: '-1007777777777',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Tier Only Telegram Group',
        note: 'CEO note must survive section edits.',
        timestamp: '2026-07-09 09:00',
      });
      const savedSections = tg.saveTelegramConversationProfileSections({
        chatId: '-1007777777777',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Tier Only Telegram Group',
        sections: {
          profile: 'Nhom noi bo LLK, dung cho dieu phoi lich hop va van hanh.',
          knowledge: 'Uu tien dung SOP noi bo va ngu canh Telegram truoc Zalo.',
          interactionNotes: 'Tra loi ngan gon, xac nhan dung group truoc khi gui lenh.',
        },
      });
      const sectionProfile = tg.readTelegramConversationProfile('-1007777777777', 8000);
      assert('telegram profile section editor updates whitelisted sections and preserves CEO notes',
        savedSections?.success === true
        && sectionProfile?.content.includes('## Ho so doi tuong\nNhom noi bo LLK')
        && sectionProfile?.content.includes('## Kien thuc rieng can nap\nUu tien dung SOP noi bo')
        && sectionProfile?.content.includes('## Luu y khi tuong tac\nTra loi ngan gon')
        && sectionProfile?.content.includes('## CEO notes')
        && sectionProfile?.content.includes('CEO note must survive section edits.'),
        JSON.stringify({ savedSections, content: sectionProfile?.content }));
      const missingPath = tg.getTelegramProfilePath('-1009999999999');
      try { if (missingPath && fs.existsSync(missingPath)) fs.unlinkSync(missingPath); } catch {}
      tg.ensureTelegramConversationProfile({
        telegramChatId: '-1009999999999',
        telegramChatType: 'supergroup',
        role: 'internal',
        label: 'Missing Section Group',
      });
      tg.appendTelegramConversationNote({
        chatId: '-1009999999999',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Missing Section Group',
        note: 'Existing note.',
        timestamp: '2026-07-09 09:10',
      });
      const missingBefore = fs.readFileSync(missingPath, 'utf-8')
        .replace(/\n## Kien thuc rieng can nap\n[\s\S]*?(?=\n## Luu y khi tuong tac\n)/, '\n');
      fs.writeFileSync(missingPath, missingBefore, 'utf-8');
      const missingSaved = tg.saveTelegramConversationProfileSections({
        chatId: '-1009999999999',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Missing Section Group',
        sections: {
          knowledge: 'Inserted knowledge before footer.',
        },
      });
      const missingAfter = tg.readTelegramConversationProfile('-1009999999999', 8000)?.content || '';
      assert('telegram profile section editor inserts missing sections before footer and CEO notes',
        missingSaved?.success === true
        && missingAfter.indexOf('## Kien thuc rieng can nap') >= 0
        && missingAfter.indexOf('## Kien thuc rieng can nap') < missingAfter.indexOf('\n---\n*Ho so duoc tao tu dong')
        && missingAfter.indexOf('\n---\n*Ho so duoc tao tu dong') < missingAfter.indexOf('## CEO notes'),
        JSON.stringify({ missingSaved, content: missingAfter }));
    }
    assert('telegram profile scan autofill helpers are exported',
      typeof tg.buildTelegramAutofillProfileSections === 'function'
      && typeof tg.backfillTelegramConversationProfileSectionsFromScan === 'function',
      'missing Telegram profile scan autofill helpers');
    if (typeof tg.buildTelegramAutofillProfileSections === 'function' && typeof tg.backfillTelegramConversationProfileSectionsFromScan === 'function') {
      const autoPath = tg.getTelegramProfilePath('-1006666666666');
      try { if (autoPath && fs.existsSync(autoPath)) fs.unlinkSync(autoPath); } catch {}
      const autoProfile = tg.ensureTelegramConversationProfile({
        telegramChatId: '-1006666666666',
        telegramChatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
        aliases: ['VIP-2026', 'VIP'],
        summary: 'Khach mua goi premium va can cham soc gan gui.',
        sources: ['provider-cache', 'runtime-logs'],
        msgCount: 42,
        lastSeen: '2026-07-09T10:00:00.000Z',
      });
      const autoContent = tg.readTelegramConversationProfile('-1006666666666', 12000)?.content || '';
      assert('telegram profile auto-fills empty sections from scan metadata',
        autoProfile?.profilePath
        && autoContent.includes('VIP Customer Group')
        && autoContent.includes('Tom tat scan: Khach mua goi premium')
        && autoContent.includes('Nguon scan: provider-cache, runtime-logs')
        && autoContent.includes('So tin da luu: 42')
        && autoContent.includes('Chi dung kien thuc public/customer')
        && !autoContent.includes('## Ho so doi tuong\n(chua co)'),
        JSON.stringify({ autoContent }));
      tg.saveTelegramConversationProfileSections({
        chatId: '-1006666666666',
        chatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
        sections: {
          profile: 'Manual profile must stay.',
        },
      });
      tg.backfillTelegramConversationProfileSectionsFromScan({
        telegramChatId: '-1006666666666',
        telegramChatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
        summary: 'New scan should not override manual profile.',
      });
      const manualAfter = tg.readTelegramConversationProfile('-1006666666666', 12000)?.content || '';
      assert('telegram profile auto-fill preserves manual profile sections',
        manualAfter.includes('## Ho so doi tuong\nManual profile must stay.')
        && !manualAfter.includes('New scan should not override manual profile'),
        manualAfter);
    }
    assert('telegram private knowledge loader helper is exported',
      typeof tg.loadTelegramProfileKnowledgeContext === 'function',
      'missing Telegram private knowledge loader helper');
    if (typeof tg.loadTelegramProfileKnowledgeContext === 'function') {
      const publicKnowledgePath = path.join(tmp, 'knowledge', 'telegram', 'public', 'vip-playbook.md');
      const internalKnowledgePath = path.join(tmp, 'knowledge', 'telegram', 'noi-bo', 'internal-playbook.md');
      fs.mkdirSync(path.dirname(publicKnowledgePath), { recursive: true });
      fs.mkdirSync(path.dirname(internalKnowledgePath), { recursive: true });
      fs.writeFileSync(publicKnowledgePath, 'VIP public playbook: uu tien giai thich ngan gon va ro buoc tiep theo.', 'utf-8');
      fs.writeFileSync(internalKnowledgePath, 'Internal-only playbook: khong bao gio nap cho khach hang.', 'utf-8');
      tg.saveTelegramConversationProfileSections({
        chatId: '-1006666666666',
        chatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
        sections: {
          knowledge: [
            'file: knowledge/telegram/public/vip-playbook.md',
            'file: knowledge/telegram/noi-bo/internal-playbook.md',
          ].join('\n'),
        },
      });
      const knowledgeConversation = tg.resolveTelegramConversation({
        telegramChatId: '-1006666666666',
        telegramChatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
      });
      const knowledgeProfile = tg.readTelegramConversationProfile('-1006666666666', 12000);
      const loadedKnowledge = tg.loadTelegramProfileKnowledgeContext({
        conversation: knowledgeConversation,
        profile: knowledgeProfile,
        maxChars: 4000,
      });
      assert('telegram private knowledge loader loads public refs and blocks internal refs for customers',
        loadedKnowledge?.items?.some(item => item.content.includes('VIP public playbook'))
        && !loadedKnowledge?.items?.some(item => item.content.includes('Internal-only playbook'))
        && loadedKnowledge?.blocked?.some(item => /noi-bo|internal/i.test(item.ref || item.path || '')),
        JSON.stringify(loadedKnowledge));
      const memoryContext = await tg.buildTelegramMemoryContext({
        telegramChatId: '-1006666666666',
        telegramChatType: 'supergroup',
        role: 'customer',
        label: 'VIP Customer Group',
        query: 'can nap kien thuc rieng',
        limit: 1,
      });
      const promptBlock = tg.formatTelegramMemoryPromptBlock(memoryContext);
      assert('telegram memory prompt includes scoped private knowledge content',
        promptBlock.includes('VIP public playbook')
        && !promptBlock.includes('Internal-only playbook')
        && promptBlock.includes('privateKnowledge'),
        promptBlock);
    }
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
      && telegramMemorySrc.includes('profile-tier-group')
      && telegramMemorySrc.includes('profile-tier-user')
      && telegramMemorySrc.includes('directory-cache'),
      'missing telegram directory layer wiring');
    assert('ceo-memory allows explicit telegram customer scope only via hints', memorySrc.includes("ch === 'telegram' && hints.includes('customer')"), 'missing explicit customer hint gate');
    assert('ceo-memory actor-scopes telegram customer memory', memorySrc.includes("_requiresActorScopedCustomerFilter(channel, allowedScopes)") && memorySrc.includes("'telegram_chat'"), 'missing telegram actor filter');
    assert('cron injects telegram conversation context when target exists', cronSrc.includes("require('./telegram-memory')") && cronSrc.includes('telegramTarget'));
    assert('workspace seeds telegram memory dirs',
      workspaceSrc.includes("'memory', 'telegram-chats'")
      && workspaceSrc.includes("'memory', 'telegram-users'")
      && workspaceSrc.includes("'memory', 'telegram-groups'"),
      'workspace does not seed all Telegram memory tiers');
    assert('workspace and sacred data protect telegram history/profile tiers',
      workspaceSrc.includes("'telegram-history'")
      && sacredDataSrc.includes("'memory/telegram-users'")
      && sacredDataSrc.includes("'memory/telegram-groups'")
      && sacredDataSrc.includes("'telegram-history'"),
      'telegram history/profile tiers are not seeded/protected');
    assert('telegram manager IPC handlers exist',
      dashboardSrc.includes("list-telegram-conversations")
      && dashboardSrc.includes("save-telegram-conversation-settings")
      && dashboardSrc.includes("seed-telegram-conversations")
      && dashboardSrc.includes("append-telegram-conversation-note")
      && dashboardSrc.includes("delete-telegram-conversation-note")
      && dashboardSrc.includes("save-telegram-conversation-profile-sections"),
      'missing dashboard IPC handlers');
    assert('telegram manager preload bridge exists',
      preloadSrc.includes('listTelegramConversations')
      && preloadSrc.includes('saveTelegramConversationSettings')
      && preloadSrc.includes('readTelegramConversationMemory')
      && preloadSrc.includes('appendTelegramConversationNote')
      && preloadSrc.includes('deleteTelegramConversationNote')
      && preloadSrc.includes('saveTelegramConversationProfileSections'),
      'missing preload bridge');
    assert('telegram manager UI exists',
      uiSrc.includes('tg-groups-list')
      && uiSrc.includes('tg-people-list')
      && uiSrc.includes('renderTelegramConversations')
      && uiSrc.includes("switchTelegramConversationTab('groups'")
      && uiSrc.includes("switchTelegramConversationTab('people'")
      && uiSrc.includes('updateTelegramConversationResponseMode')
      && uiSrc.includes('setTelegramPaneEnabled')
      && uiSrc.includes('saveTelegramConversationNote')
      && uiSrc.includes('deleteTelegramConversationNote'),
      'missing Telegram split manager UI');
    assert('telegram status/config cards are compact dashboard controls',
      uiSrc.includes('tg-info-grid tg-info-grid-compact')
      && uiSrc.includes('tg-info-card tg-info-card-compact')
      && uiSrc.includes('tg-config-inline')
      && uiSrc.includes('tg-test-inline'),
      'Telegram top status/config cards must stay compact so conversation manager remains first-screen visible');
    assert('telegram conversation panes are dense and independently scrollable',
      uiSrc.includes('tg-manager tg-manager-density')
      && uiSrc.includes('tg-split tg-split-scroll')
      && uiSrc.includes('tg-conv-list tg-conv-list-scroll')
      && uiSrc.includes('height:calc(100vh - 278px)')
      && uiSrc.includes('overflow-y:auto; overflow-x:hidden'),
      'Telegram split panes must use viewport-bounded scroll areas like Zalo');
    assert('telegram profile modal exposes editable identity and policy controls',
      uiSrc.includes('tg-profile-label')
      && uiSrc.includes('tg-profile-aliases')
      && uiSrc.includes('tg-profile-role')
      && uiSrc.includes('tg-profile-response-mode')
      && uiSrc.includes('tg-profile-enabled')
      && uiSrc.includes('saveTelegramConversationProfileSettings')
      && uiSrc.includes('tg-profile-section-profile')
      && uiSrc.includes('tg-profile-section-knowledge')
      && uiSrc.includes('tg-profile-section-notes')
      && uiSrc.includes('saveTelegramConversationProfileSections'),
      'missing Telegram profile modal identity/policy controls');
    assert('telegram profile modal separates memory editor from rendered preview',
      uiSrc.includes('tg-profile-section-editor-title')
      && uiSrc.includes('tg-profile-preview')
      && uiSrc.includes('tg-profile-preview-title')
      && uiSrc.includes('tg-profile-preview-collapsible'),
      'Telegram memory modal must make editor vs AI-loaded preview explicit');

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
    const savedAliases = tg.saveTelegramConversationSettings({
      conversations: [{
        chatId: '-1008888888888',
        chatType: 'supergroup',
        role: 'customer',
        aliases: 'Alias A, Alias B\nAlias A',
        label: 'Alias Normalized Group',
        enabled: true,
      }],
    });
    const aliasRow = (savedAliases.conversations || []).find(c => c.chatId === '-1008888888888');
    const aliasRawSetting = tg.readTelegramConversationSettings()[tg.telegramEntityId('-1008888888888')];
    const aliasLookup = tg.findTelegramConversations({ query: 'Alias B', autoMode: true, enabled: true });
    assert('telegram conversation settings normalize editable aliases',
      aliasRow
      && Array.isArray(aliasRow.aliases)
      && Array.isArray(aliasRawSetting?.aliases)
      && aliasRawSetting.aliases.length === 2
      && aliasRow.aliases.length === 2
      && aliasRow.aliases.includes('Alias A')
      && aliasRow.aliases.includes('Alias B')
      && aliasLookup.picked === '-1008888888888',
      JSON.stringify({ aliasRawSetting, aliasRow, aliasLookup }));
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
      && cronApiSrc.includes("urlPath === '/api/telegram/member'")
      && cronApiSrc.includes("urlPath === '/api/telegram/seed'"),
      'missing Telegram API routes');
    assert('cron-api creates Telegram fixed crons without LLM',
      cronApiSrc.includes('resolveOptionalTelegramTargetForCron')
      && cronApiSrc.includes("'exec: telegram msg send '"),
      'missing Telegram cron target resolver or safe exec prompt');
    assert('cron-api honors Telegram source header for name-based cron target lookup',
      cronApiSrc.includes('hasTelegramTargetHintForCron(params = {}, headers = {})')
      && cronApiSrc.includes('scopedTelegramCronParams(params = {}, headers = {})')
      && cronApiSrc.includes("headers['x-source-channel']")
      && cronApiSrc.includes('hasTelegramTargetHintForCron(params, headers)')
      && cronApiSrc.includes('scopedTelegramCronParams(params, headers)'),
      'Telegram cron resolver ignores source-channel headers');
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
    assert('telegram outbound runtime capture hook exists',
      channelsSrc.includes("require('./telegram-runtime-capture')")
      && channelsSrc.includes("source: 'sendTelegram'")
      && channelsSrc.includes("source: 'sendTelegramPhoto'"),
      'channels.js missing Telegram outbound runtime capture hook');
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
    assert('telegram-ceo skill documents real Telegram member lookup',
      telegramSkillSrc.includes('/api/telegram/member?targetChatId=<id>&userId=<telegramUserId>')
      && telegramSkillSrc.includes('owner/admin/member'),
      'telegram-ceo skill missing Telegram member metadata workflow');
    assert('MEMORY index includes Telegram chat profiles',
      memoryIndexSrc.includes('memory/telegram-chats/<chatId>.md')
      && memoryIndexSrc.includes('memory/telegram-users/<userId>.md')
      && memoryIndexSrc.includes('memory/telegram-groups/<chatId>.md')
      && memoryIndexSrc.includes('Telegram role là `customer`'),
      'MEMORY.md missing Telegram profile routing');

    assert('Telegram fast role lookup vendor patch exists',
      vendorPatchSrc.includes('20260709-fast-telegram-role-lookup-v1')
      && vendorPatchSrc.includes('try9BizClawTelegramRoleLookupFastPath')
      && vendorPatchSrc.includes('fast-telegram-role-lookup'),
      'missing Telegram fast role lookup patch');
    assert('Telegram provider timeout guard vendor patch exists',
      vendorPatchSrc.includes('20260709-telegram-provider-timeout-guard-v1')
      && vendorPatchSrc.includes('ensureTelegramProviderTimeoutGuardPatch')
      && vendorPatchSrc.includes('telegram-provider-timeout')
      && vendorPatchSrc.includes('providerTimeoutSettled'),
      'missing Telegram provider timeout guard patch');
    assert('startup launches gateway without blocking on 9Router model warmup',
      gatewaySrc.includes('BOOT_FAST_GATEWAY_SPAWN_MARKER')
      && gatewaySrc.includes('schedule9RouterPostReadyWarmup')
      && gatewaySrc.includes('gateway spawn does not await 9Router /v1/models'),
      'gateway startup still lacks non-blocking 9Router post-ready warmup marker');
    const approvalLeak = channels.filterSensitiveOutput([
      'Approval required.',
      'Run:',
      '```txt',
      '/approve fc52e293 allow-once',
      '```',
      'Pending command:',
      '```sh',
      'python -c "import urllib.request;print(urllib.request.urlopen(\'https://example.com\', timeout=20).read())"',
      '```',
    ].join('\n'));
    assert('approval output filter blocks raw command payloads',
      approvalLeak.blocked === true
      && !/\/approve|allow-once|Pending command|python\s+-c|urllib\.request/i.test(approvalLeak.text),
      JSON.stringify(approvalLeak));
    assert('exec approval reply coalesce vendor patch exists',
      vendorPatchSrc.includes('20260709-coalesce-exec-approval-reply-v1')
      && vendorPatchSrc.includes('ensureExecApprovalReplyCoalescePatch')
      && vendorPatchSrc.includes('approval-reply-coalesce'),
      'missing exec approval reply coalesce patch');

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
      if (failures) process.exit(1);
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
