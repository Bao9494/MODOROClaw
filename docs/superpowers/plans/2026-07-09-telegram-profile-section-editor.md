# Telegram Profile Section Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anh Bao edit Telegram conversation profile, private knowledge, and interaction notes from the dashboard modal.

**Architecture:** Keep the existing Markdown profile as source of truth. Add one whitelisted section updater in `telegram-memory.js`, expose it via IPC/preload, and add three modal textareas that save through the new bridge.

**Tech Stack:** Electron main/preload, dashboard HTML/JS, Node.js filesystem helpers, existing Telegram memory contract script.

## Global Constraints

- Do not change how `readTelegramConversationProfile()` loads context.
- Do not implement arbitrary file loading from the knowledge section.
- Preserve `## CEO notes`.
- Use the current Telegram feature branch/worktree.

---

### Task 1: Contract Test

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`

**Interfaces:**
- Expects: `saveTelegramConversationProfileSections(input)`
- Expects preload bridge: `saveTelegramConversationProfileSections`
- Expects IPC string: `save-telegram-conversation-profile-sections`
- Expects UI ids: `tg-profile-section-profile`, `tg-profile-section-knowledge`, `tg-profile-section-notes`

- [x] Add assertions that save three profile sections for chat `-1007777777777`.
- [x] Verify the content includes updated section text.
- [x] Verify the `## CEO notes` section remains after save.
- [x] Run `node electron/scripts/check-telegram-memory-contract.js` and confirm it fails because the helper does not exist yet.

### Task 2: Memory Helper

**Files:**
- Modify: `electron/lib/telegram-memory.js`

**Interfaces:**
- Produce: `saveTelegramConversationProfileSections(input): { success: boolean, path?: string, sections?: object, error?: string }`

- [x] Add a section key map for `profile`, `knowledge`, and `interactionNotes`.
- [x] Add sanitization for profile section text.
- [x] Add Markdown replacement helper that preserves other sections.
- [x] Export `saveTelegramConversationProfileSections`.
- [x] Run the contract test and confirm helper assertions pass or move to IPC gaps.

### Task 3: IPC And Preload

**Files:**
- Modify: `electron/lib/dashboard-ipc.js`
- Modify: `electron/preload.js`

**Interfaces:**
- Consume: `saveTelegramConversationProfileSections(input)`
- Produce: `window.claw.saveTelegramConversationProfileSections(chatId, sections, meta)`

- [x] Import the helper into dashboard IPC.
- [x] Add IPC handler `save-telegram-conversation-profile-sections`.
- [x] Add preload bridge method.
- [x] Run the contract test and confirm bridge assertions pass or move to UI gaps.

### Task 4: Dashboard UI

**Files:**
- Modify: `electron/ui/dashboard.html`

**Interfaces:**
- Consume: `window.claw.saveTelegramConversationProfileSections(chatId, sections, meta)`

- [x] Parse the three Markdown sections from the loaded profile content.
- [x] Render three textareas in the Telegram profile modal.
- [x] Add save button and loading/error toast behavior.
- [x] Reload the modal after save so the rendered memory view reflects the update.
- [x] Run the contract test and confirm all assertions pass.

### Task 5: Docs And Final Verification

**Files:**
- Modify: `docs/telegram-zalo-architecture-parity.md`

- [x] Update parity docs to mark Telegram structured profile editor as available.
- [x] Run `node electron/scripts/check-telegram-memory-contract.js`.
- [x] Check `git diff --stat` and `git status`.
- [x] Commit and push to `fork` branch.
