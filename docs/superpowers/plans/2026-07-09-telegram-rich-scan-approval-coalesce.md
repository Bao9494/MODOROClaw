# Telegram Rich Scan And Approval Coalesce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram inherit the useful Zalo-style layered memory more completely by adding real member/admin metadata, and prevent OpenClaw approval payloads from being sent as multiple technical Telegram messages.

**Architecture:** Keep Telegram chat role/audience/profile as the policy source of truth, then add a separate member metadata layer for real Telegram membership status (`creator`, `administrator`, `member`, etc.). Approval safety is handled defense-in-depth: transport filter, deterministic suppression/coalescing, and a vendor dist patch that replaces raw approval-command payloads with a short private notice.

**Tech Stack:** Electron main process, Node.js CommonJS, Telegram Bot API `getChatMember`, OpenClaw vendor dist patching, existing `check-telegram-memory-contract.js` guard.

**Execution status:** Implemented in branch `telegram-private-notes-20260709`. RED guard failed first on member metadata/API/skill/vendor marker; GREEN guard passed after implementation. Current source verification: `node electron/scripts/check-telegram-memory-contract.js`.

## Global Constraints

- Worktree: `O:\project\MODOROClaw-latency-hotfix-20260707`.
- Branch: `telegram-private-notes-20260709`, tracking `fork/telegram-private-notes-20260709`.
- Telegram is the primary channel for CEO/internal/customer groups; Zalo is secondary/legacy.
- Do not change license, provider credentials, or unrelated OpenClaw behavior.
- Do not send raw `/approve`, command fences, pending shell command, or approval IDs to Telegram/Zalo chat content.
- Keep changes testable in source clone and build-safe for packaged app.

---

### Task 1: Guard Red For Telegram Member Metadata

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`

**Interfaces:**
- Consumes: `telegram-inbound-context`, `telegram-runtime-capture`, `telegram-history-archive`
- Produces expected fields: `sender.memberStatus`, `sender.memberTitle`, `sender.isAdmin`, history `memberStatus`

- [x] Add a failing assertion that `buildTelegramInboundContext()` preserves `memberStatus: "administrator"` and `customTitle`.
- [x] Add a failing assertion that `captureTelegramRuntimeEvent()` stores member metadata in the Telegram history archive.
- [x] Run `node electron/scripts/check-telegram-memory-contract.js`.
- [x] Expected RED: guard fails because member metadata is not yet captured.

### Task 2: Implement Member Metadata Layer

**Files:**
- Create: `electron/lib/telegram-member-metadata.js`
- Modify: `electron/lib/telegram-inbound-context.js`
- Modify: `electron/lib/telegram-history-archive.js`
- Modify: `electron/lib/telegram-runtime-capture.js`
- Modify: `electron/lib/cron-api.js`
- Modify: `skills/operations/telegram-ceo.md`

**Interfaces:**
- `normalizeTelegramMemberMetadata(raw): object`
- `getTelegramMemberMetadata({ chatId, userId }): object|null`
- `saveTelegramMemberMetadata({ chatId, userId, ...metadata }): object|null`
- `refreshTelegramMemberMetadata({ chatId, userId, token }): Promise<object>`
- `GET /api/telegram/member?targetChatId=<chatId>&userId=<telegramUserId>`

- [x] Implement metadata normalization for Telegram Bot API statuses.
- [x] Persist member metadata to a workspace JSON cache keyed by `chatId:userId`.
- [x] Add `/api/telegram/member` to refresh or read cached metadata.
- [x] Feed member metadata into inbound context, runtime capture, and history archive.
- [x] Update Telegram CEO skill so the agent knows to call `/api/telegram/member` before claiming real `owner/admin/member` rights.
- [x] Run the Telegram memory contract guard and expect GREEN.

### Task 3: Guard Red For Approval Payload Leakage

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`

**Interfaces:**
- Consumes: `channels.filterSensitiveOutput`
- Consumes: `vendor-patches.js` static marker

- [x] Add assertion that a full OpenClaw approval payload containing `/approve ... allow-once`, `Pending command`, and shell command is blocked with no raw command fragments in replacement text.
- [x] Add static assertion for a vendor patch marker `20260709-coalesce-exec-approval-reply-v1`.
- [x] Run `node electron/scripts/check-telegram-memory-contract.js`.
- [x] Expected RED: static marker is missing before vendor patch implementation.

### Task 4: Coalesce/Suppress Approval Technical Replies

**Files:**
- Modify: `electron/lib/channels.js`
- Modify: `electron/lib/vendor-patches.js`
- Modify: `docs/telegram-zalo-architecture-parity.md`

**Interfaces:**
- `filterSensitiveOutput(text)` must return one safe private notice for approval payloads and never include `/approve`, `allow-once`, `Pending command`, `python -c`, or raw URLs.
- `ensureExecApprovalReplyCoalescePatch(vendorDir, homeDir)` must patch hash-named OpenClaw dist files safely and idempotently.

- [x] Replace approval-leak output with deterministic text suitable for CEO Telegram only.
- [x] Patch OpenClaw `buildExecApprovalPendingReplyPayload()` so raw command detail stays in UI/interactive payload, not chat text.
- [x] Ensure vendor patch is called from `applyAllVendorPatches()`.
- [x] Run guard and source grep to verify no raw approval payload will pass through app transport.

### Task 5: Verification, Docs, Commit, Push

**Files:**
- Modify: `docs/telegram-zalo-architecture-parity.md`
- Regenerate or review: function/system map if the repo script changes it

- [ ] Run `node electron/scripts/check-telegram-memory-contract.js`.
- [ ] Run the relevant architecture guard from `package.json`.
- [ ] Run `git diff --check`.
- [ ] Commit changes in small logical commits.
- [ ] Push with plain `git push` so it uses `fork`, not `origin`.
- [ ] Report what was verified and what still needs live Telegram provider data.
