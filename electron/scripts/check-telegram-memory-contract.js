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
  try {
    mem.cleanupCeoMemoryTimers?.();
    const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron.js'), 'utf-8');
    const workspaceSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'workspace.js'), 'utf-8');
    const memorySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ceo-memory.js'), 'utf-8');
    const dashboardSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf-8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
    const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf-8');

    const group = tg.resolveTelegramConversation({
      telegramChatId: '-1003857797941',
      telegramChatType: 'supergroup',
      title: 'Nhom khach hang X3',
    });
    assert('telegram group defaults to customer role', group && group.role === 'customer' && group.audience === 'customer', JSON.stringify(group));
    assert('telegram group scopes are customer/public', JSON.stringify(group.scopeHints) === JSON.stringify(['customer', 'public']), JSON.stringify(group?.scopeHints));
    assert('telegram entity id is stable', tg.telegramEntityId('-1003857797941') === 'telegram:-1003857797941');
    assert('ceo-memory allows explicit telegram customer scope only via hints', memorySrc.includes("ch === 'telegram' && hints.includes('customer')"), 'missing explicit customer hint gate');
    assert('ceo-memory actor-scopes telegram customer memory', memorySrc.includes("_requiresActorScopedCustomerFilter(channel, allowedScopes)") && memorySrc.includes("'telegram_chat'"), 'missing telegram actor filter');
    assert('cron injects telegram conversation context when target exists', cronSrc.includes("require('./telegram-memory')") && cronSrc.includes('telegramTarget'));
    assert('workspace seeds telegram memory dir', workspaceSrc.includes("'memory', 'telegram-chats'"));
    assert('telegram manager IPC handlers exist', dashboardSrc.includes("list-telegram-conversations") && dashboardSrc.includes("save-telegram-conversation-settings") && dashboardSrc.includes("seed-telegram-conversations"), 'missing dashboard IPC handlers');
    assert('telegram manager preload bridge exists', preloadSrc.includes('listTelegramConversations') && preloadSrc.includes('saveTelegramConversationSettings') && preloadSrc.includes('readTelegramConversationMemory'), 'missing preload bridge');
    assert('telegram manager UI exists', uiSrc.includes('tg-conversations-list') && uiSrc.includes('renderTelegramConversations') && uiSrc.includes('switchTelegramConversationTab'), 'missing Telegram manager UI');

    const saved = tg.saveTelegramConversationSettings({
      conversations: [{
        chatId: '-1003857797941',
        chatType: 'supergroup',
        role: 'internal',
        label: 'Nhom noi bo Telegram',
        enabled: true,
      }],
    });
    const savedRow = (saved.conversations || []).find(c => c.chatId === '-1003857797941');
    assert('telegram conversation settings persist role override', savedRow && savedRow.role === 'internal' && savedRow.audience === 'internal', JSON.stringify(savedRow));

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
