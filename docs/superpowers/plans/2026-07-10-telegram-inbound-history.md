# Plan: Telegram inbound group history capture

Date: 2026-07-10
Branch: telegram-inbound-history-20260710

## Steps

1. Investigate current inbound flow.
   - Read OpenClaw Telegram bot dispatcher.
   - Confirm existing source only captures outbound.
   - Confirm group messages without mention can return before dispatch.

2. Add a RED contract.
   - Extend `check-telegram-memory-contract.js`.
   - Assert `vendor-patches.js` contains an idempotent inbound-history patch and is wired into `ensureOpenclawLatencyPatches()`.

3. Implement vendor patch.
   - Add `ensureTelegramInboundHistoryCapturePatch()`.
   - Insert helper before `resolveTelegramInboundBody()`.
   - Capture processed messages at the first `dispatch-start` anchor.
   - Capture no-mention group messages before `recordPendingHistoryEntryIfEnabled()`.
   - Keep all failures non-blocking.

4. Verify source.
   - `node --check electron/lib/vendor-patches.js`
   - `node electron/scripts/check-telegram-memory-contract.js`
   - `node electron/scripts/generate-system-map.js --check`

5. Commit and push.
   - Push only to `fork`.

6. Patch runtime and smoke test.
   - Backup `app.asar`.
   - Replace `vendor-patches.js` in runtime.
   - Restart app.
   - Verify ports and Telegram seed/lookup.

## Follow-up: silent no-mention capture

Evidence from runtime testing showed no-mention group messages were correctly saved as `telegram-provider-inbound-skip`, but OpenClaw still showed `typing...` because a global Telegram middleware sent `sendChatAction("typing")` before the mention gate.

Add a second vendor patch:

- `ensureTelegramNoMentionPretypingPatch()`.
- Keep pre-typing for private chats, bot replies, explicit bot mentions, and bot commands.
- Suppress pre-typing for normal group/supergroup messages that will only be captured as background memory.
