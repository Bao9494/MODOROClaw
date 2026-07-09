# Telegram Private Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Zalo-style private CEO notes to Telegram conversation profiles.

**Architecture:** Reuse the existing Telegram profile markdown files as the storage layer. Add small helpers in `telegram-memory.js`, expose them through dashboard IPC/preload, then extend the Telegram profile modal with a textarea and save/delete controls.

**Tech Stack:** Electron main IPC, preload bridge, dashboard HTML/JS, Node.js contract guard.

## Global Constraints

- Work on branch `telegram-private-notes-20260709`.
- Do not rewrite the Telegram provider or OpenClaw vendor integration.
- Do not change Zalo behavior.
- Use existing Telegram profile paths and sanitizers.
- Write a failing guard before implementation.

---

### Task 1: Contract Guard For Telegram Notes

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`

**Interfaces:**
- Consumes: planned `appendTelegramConversationNote(input)`, `deleteTelegramConversationNote(input)`.
- Produces: failing RED test that proves Telegram notes are not implemented yet.

- [ ] **Step 1: Add assertions that append and delete Telegram notes**

Add a test block after Telegram profile creation assertions that calls the planned helper functions against a temporary Telegram chat profile.

- [ ] **Step 2: Run guard and verify RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: FAIL because `appendTelegramConversationNote` is not exported.

### Task 2: Telegram Memory Note Helpers

**Files:**
- Modify: `electron/lib/telegram-memory.js`

**Interfaces:**
- Produces:
  - `appendTelegramConversationNote(input): { success: boolean, timestamp?: string, path?: string, error?: string }`
  - `deleteTelegramConversationNote(input): { success: boolean, path?: string, error?: string }`

- [ ] **Step 1: Implement note sanitization and append helper**

Use existing profile creation to ensure the file exists, add `## CEO notes` when missing, then insert a timestamped bullet.

- [ ] **Step 2: Implement delete helper**

Delete only the bullet line matching the supplied timestamp.

- [ ] **Step 3: Run guard and verify GREEN**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: PASS.

### Task 3: Dashboard IPC And Preload

**Files:**
- Modify: `electron/lib/dashboard-ipc.js`
- Modify: `electron/preload.js`

**Interfaces:**
- Consumes helper functions from Task 2.
- Produces:
  - `window.claw.appendTelegramConversationNote(chatId, note, meta)`
  - `window.claw.deleteTelegramConversationNote(chatId, noteTimestamp)`

- [ ] **Step 1: Add preload bridge methods**

Expose IPC methods beside `readTelegramConversationMemory`.

- [ ] **Step 2: Add IPC handlers**

Use `sanitizeTelegramChatId()` and helper functions. Return structured `{ success, error }`.

- [ ] **Step 3: Run syntax checks**

Run:

```powershell
node --check electron/lib/dashboard-ipc.js
node --check electron/preload.js
```

Expected: both exit 0.

### Task 4: Telegram UI Note Modal

**Files:**
- Modify: `electron/ui/dashboard.html`

**Interfaces:**
- Consumes preload methods from Task 3.
- Produces UI actions from the Telegram profile modal.

- [ ] **Step 1: Add note textarea and save button to Telegram memory modal**

Mirror Zalo wording but use Telegram-specific labels.

- [ ] **Step 2: Add save and delete functions**

Refresh the modal after successful append/delete.

- [ ] **Step 3: Run dashboard guard and syntax-adjacent checks**

Run:

```powershell
node electron/scripts/check-telegram-memory-contract.js
node electron/scripts/check-dashboard-ux.js
```

Expected: both pass.

### Task 5: Docs And Verification

**Files:**
- Modify: `docs/telegram-zalo-architecture-parity.md`
- Possibly modify generated system map if guard requires it.

**Interfaces:**
- Produces documented parity status and verification evidence.

- [ ] **Step 1: Update architecture parity doc**

Record that Telegram now has Zalo-style private notes foundation.

- [ ] **Step 2: Run focused checks**

Run:

```powershell
node --check electron/lib/telegram-memory.js
node --check electron/lib/dashboard-ipc.js
node --check electron/preload.js
node electron/scripts/check-telegram-memory-contract.js
```

Expected: all pass.

- [ ] **Step 3: Commit**

Commit with message: `Add Telegram private conversation notes`.

## Execution Log

- 2026-07-09: RED confirmed with `node electron/scripts/check-telegram-memory-contract.js`; guard failed on missing Telegram append/delete note helpers.
- 2026-07-09: Implemented Telegram profile note helpers in `electron/lib/telegram-memory.js`; GREEN confirmed with `node electron/scripts/check-telegram-memory-contract.js`.
- 2026-07-09: RED confirmed for Dashboard wiring; guard failed on missing IPC/preload/UI strings.
- 2026-07-09: Implemented Dashboard IPC, preload bridge, and Telegram profile modal note UI.
- 2026-07-09: Regenerated system map after IPC/preload additions.
- 2026-07-09: Verification PASS:
  - `node --check electron/lib/telegram-memory.js`
  - `node --check electron/lib/dashboard-ipc.js`
  - `node --check electron/preload.js`
  - `node electron/scripts/check-telegram-memory-contract.js`
  - `npm.cmd run map:check`
  - `node scripts/check-dashboard-ux-qol.js`
  - `npm.cmd run guard:architecture`
- 2026-07-09: Full build PASS with `LOCAL_UNSIGNED_BUILD=1 npm.cmd run build:win`.
- 2026-07-09: Installed unsigned build into `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw` after backing up the previous install to `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw-backup-20260709-telegram-private-notes`.
- 2026-07-09: Live runtime checks PASS:
  - App processes are running and ports `18789`, `20128`, `20129`, `20200` are listening.
  - Authenticated `GET /api/telegram/profile?name=LLK` returns `targetChatId=-1003857797941`, `role=internal`, `toolScope=internal`, and profile path `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\memory\telegram-chats\-1003857797941.md`.
  - Telegram private note append/delete helper was tested against the real LLK profile with a temporary marker; marker appeared after append and was absent after delete.
  - Installed `app.asar` contains `appendTelegramConversationNote`, `deleteTelegramConversationNote`, `append-telegram-conversation-note`, and `CEO notes`.
- 2026-07-09: Git lesson saved in `.learnings/LEARNINGS.md`: use the writable `fork` remote for this repo; direct push to read-only upstream `origin` returns GitHub 403.
- 2026-07-09: Runtime log review found no new Telegram profile/note errors. Residual operational warning: Zalo plugin is configured disabled (`channels.modoro-zalo.enabled=false`, `plugins.entries.modoro-zalo.enabled=false`), which is outside this Telegram private-notes change.
