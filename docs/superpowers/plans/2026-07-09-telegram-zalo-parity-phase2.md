# Telegram Zalo Parity Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the next practical Telegram parity layer by making the Telegram conversation profile modal a Zalo-like control surface for identity aliases, role, response mode, memory profile, and private CEO notes.

**Architecture:** Keep the existing Telegram directory/settings/profile foundation. Add no new provider spine in this phase; instead expose the already-supported settings fields (`label`, `aliases`, `role`, `responseMode`, `enabled`) directly in the Dashboard profile modal so the CEO can curate Telegram identities and memory tiers without editing JSON.

**Tech Stack:** Electron Dashboard HTML/JS, preload IPC bridge already present, `electron/lib/telegram-memory.js`, static contract guard `electron/scripts/check-telegram-memory-contract.js`, generated system map.

## Global Constraints

- Telegram remains the priority channel; Zalo remains the secondary channel.
- Do not change Zalo runtime or Zalo config in this phase.
- Do not weaken Telegram customer/internal/CEO memory boundaries.
- Keep edits scoped to Telegram manager UI, Telegram settings normalization, docs, and guards.
- Push to `fork`, not upstream `origin`.

---

## File Structure

- Modify `electron/lib/telegram-memory.js`: normalize aliases consistently when settings are saved.
- Modify `electron/ui/dashboard.html`: add editable identity/policy controls to the Telegram memory modal.
- Modify `electron/scripts/check-telegram-memory-contract.js`: guard alias persistence and UI parity markers.
- Modify `docs/telegram-zalo-architecture-parity.md`: record the new editable profile controls.
- Modify generated system map only if `map:check` requires it.

## Tasks

### Task 1: Settings Alias Normalization Guard

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`
- Modify: `electron/lib/telegram-memory.js`

**Interfaces:**
- Consumes: `saveTelegramConversationSettings(input)`.
- Produces: settings entries with normalized `aliases` arrays.

- [ ] **Step 1: Add failing assertion**

Add an assertion that saving aliases from a comma/newline string produces a normalized alias array and lookup resolves by the alias.

- [ ] **Step 2: Run guard and confirm RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: FAIL because settings currently stores raw alias input.

- [ ] **Step 3: Normalize aliases on save**

Use the existing Telegram directory alias helper or equivalent local normalization before writing `aliases`.

- [ ] **Step 4: Run guard and confirm GREEN**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: PASS.

### Task 2: Telegram Profile Modal Controls

**Files:**
- Modify: `electron/ui/dashboard.html`
- Modify: `electron/scripts/check-telegram-memory-contract.js`

**Interfaces:**
- Consumes: `window.claw.saveTelegramConversationSettings`.
- Produces: Dashboard function `saveTelegramConversationProfileSettings()`.

- [ ] **Step 1: Add failing static guard**

Guard for the presence of:
- `tg-profile-label`
- `tg-profile-aliases`
- `tg-profile-role`
- `tg-profile-response-mode`
- `saveTelegramConversationProfileSettings`

- [ ] **Step 2: Run guard and confirm RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: FAIL before the UI controls exist.

- [ ] **Step 3: Add modal identity/policy panel**

In `viewTelegramConversationMemory`, show:
- `chatId`/`targetChatId`
- chat type and source labels
- editable display label
- editable aliases
- role select
- response mode select
- enabled checkbox
- save settings button

- [ ] **Step 4: Add save function**

Implement `saveTelegramConversationProfileSettings()` to update the matching row, call `saveTelegramConversationSettings`, refresh the list, and reopen the modal.

- [ ] **Step 5: Run guard and confirm GREEN**

Run: `node electron/scripts/check-telegram-memory-contract.js`

Expected: PASS.

### Task 3: Docs, Map, Build, Runtime Verification

**Files:**
- Modify: `docs/telegram-zalo-architecture-parity.md`
- Modify: `docs/superpowers/plans/2026-07-09-telegram-zalo-parity-phase2.md`
- Possibly modify: `docs/generated/system-map.json`, `docs/generated/system-map.txt`

**Interfaces:**
- Produces documented runtime evidence.

- [ ] **Step 1: Update architecture doc**

Record that Telegram profile modal now supports editable aliases and policy settings.

- [ ] **Step 2: Run focused verification**

Run:

```powershell
node --check electron/lib/telegram-memory.js
node --check electron/preload.js
node --check electron/lib/dashboard-ipc.js
node electron/scripts/check-telegram-memory-contract.js
npm.cmd run map:check
```

Expected: all pass when run from the correct package directory where applicable.

- [ ] **Step 3: Runtime smoke**

Use the local cron API token to confirm `/api/telegram/profile?name=LLK` still resolves `-1003857797941`.

- [ ] **Step 4: Commit and push**

Commit with message `Improve Telegram Zalo parity profile controls`, then `git push` to the tracked `fork` branch.

## Execution Log

- 2026-07-09: Plan created after confirming the worktree is isolated and clean on branch `telegram-private-notes-20260709`.
- 2026-07-09: Task 1 RED/GREEN complete. Guard failed when raw settings stored aliases as a string, then passed after `saveTelegramConversationSettings()` and `writeTelegramConversationSettings()` normalized aliases to arrays.
- 2026-07-09: Task 2 RED/GREEN complete. Guard failed before the Telegram profile modal exposed editable identity/policy controls, then passed after adding label, alias, role, responseMode, enabled, and `saveTelegramConversationProfileSettings()`.
- 2026-07-09: Focused verification PASS:
  - `node --check electron/lib/telegram-memory.js`
  - `node --check electron/preload.js`
  - `node --check electron/lib/dashboard-ipc.js`
  - `node electron/scripts/check-telegram-memory-contract.js`
  - `node scripts/check-dashboard-ux-qol.js`
  - `npm.cmd run map:check`
- 2026-07-09: Runtime smoke PASS: authenticated `GET /api/telegram/profile?name=LLK` returns `targetChatId=-1003857797941`, `role=internal`, `responseMode=mention`, `toolScope=internal`, `hasProfile=true`.
