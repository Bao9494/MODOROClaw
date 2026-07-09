# Telegram Startup Profile Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram start faster and inherit the Zalo-style layered memory more completely by auto-filling profiles from scanned data and loading referenced private knowledge into the agent prompt.

**Architecture:** Keep Telegram directory/settings/profile files as the source of truth. Gateway startup must spawn OpenClaw without waiting on 9Router model warmup, while Telegram memory uses explicit profile sections to decide what extra knowledge can be loaded and scoped by role.

**Tech Stack:** Electron main process, Node.js CommonJS, Markdown profile files under `memory/telegram-chats`, existing `electron/scripts/check-telegram-memory-contract.js` guard.

## Global Constraints

- Branch/worktree: `telegram-startup-profile-knowledge-20260709`.
- Push only to `fork`; do not push to `origin`.
- Telegram is the priority CEO/internal/customer channel; Zalo is secondary.
- Do not overwrite manually curated Telegram profile sections.
- Do not load internal/CEO-only files for Telegram conversations marked `customer`.
- Keep startup optimization scoped to non-critical 9Router warmup; do not remove config healing or vendor patches.

---

### Task 1: Startup Warmup Guard

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`
- Modify: `electron/lib/gateway.js`

**Interfaces:**
- Produces: non-blocking helper marker `BOOT_FAST_GATEWAY_SPAWN_MARKER`
- Produces: helper `schedule9RouterPostReadyWarmup({ t0 })`

- [x] **Step 1: Write failing contract assertions**

Add assertions that `electron/lib/gateway.js` contains the startup marker and the non-blocking warmup helper.

- [x] **Step 2: Run contract and verify RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`
Expected: FAIL because the helper/marker is not present yet.

- [x] **Step 3: Implement minimal startup change**

Move the `/v1/models` wait, 9Router combo/model default, and prewarm work into `schedule9RouterPostReadyWarmup({ t0 })`; call it with `void` before spawning OpenClaw so gateway spawn does not await 9Router model readiness.

- [x] **Step 4: Verify GREEN**

Run:
`node --check electron/lib/gateway.js`
`node electron/scripts/check-telegram-memory-contract.js`

### Task 2: Telegram Profile Auto-Fill From Scan

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`
- Modify: `electron/lib/telegram-memory.js`

**Interfaces:**
- Produces: `buildTelegramAutofillProfileSections(source): object`
- Produces: `backfillTelegramConversationProfileSectionsFromScan(source): object`

- [x] **Step 1: Write failing contract assertions**

Assert that a new Telegram profile created from scan metadata fills the three structured sections, while an existing manually edited profile is preserved.

- [x] **Step 2: Run contract and verify RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`
Expected: FAIL because auto-fill helpers are not exported/used.

- [x] **Step 3: Implement minimal auto-fill**

Use candidate metadata from runtime scan (`summary`, `sources`, `msgCount`, `lastSeen`, aliases, role) to fill only empty `(chua co)` sections in profile Markdown.

- [x] **Step 4: Verify GREEN**

Run:
`node --check electron/lib/telegram-memory.js`
`node electron/scripts/check-telegram-memory-contract.js`

### Task 3: Private Knowledge Loader

**Files:**
- Modify: `electron/scripts/check-telegram-memory-contract.js`
- Modify: `electron/lib/telegram-memory.js`
- Modify: `docs/telegram-zalo-architecture-parity.md`

**Interfaces:**
- Produces: `loadTelegramProfileKnowledgeContext({ conversation, profile, maxFiles, maxChars }): object`
- Extends: `buildTelegramMemoryContext()` with `privateKnowledge`
- Extends: `formatTelegramMemoryPromptBlock(ctx)` with scoped private knowledge content

- [x] **Step 1: Write failing contract assertions**

Assert that `file:` references in `Kien thuc rieng can nap` are loaded into the prompt, and that customer conversations cannot load internal/CEO-only paths.

- [x] **Step 2: Run contract and verify RED**

Run: `node electron/scripts/check-telegram-memory-contract.js`
Expected: FAIL because private knowledge refs are not loaded yet.

- [x] **Step 3: Implement minimal loader**

Parse explicit file references, resolve them safely under the workspace, read small allowed text files, and block internal paths for customer role.

- [x] **Step 4: Verify GREEN and docs**

Run:
`node --check electron/lib/telegram-memory.js`
`node electron/scripts/check-telegram-memory-contract.js`

### Task 4: Runtime Smoke

**Files:**
- Update installed `app.asar` only after source checks pass.

- [x] **Step 1: Patch installed runtime**

Copy changed Electron runtime files into an extracted `app.asar`, repack with backup, and restart 9BizClaw.

- [x] **Step 2: Smoke test**

Check `/health`, Telegram profile API, and startup logs for non-blocking warmup marker.

- [x] **Step 3: Commit and push**

Commit source changes and push to `fork/telegram-startup-profile-knowledge-20260709`.

## Progress Log

- 2026-07-09: Plan created after checking the worktree is clean on branch `telegram-startup-profile-knowledge-20260709`. Root-cause evidence from live logs shows startup previously serialized config heal, 9Router model readiness, and OpenClaw gateway readiness.
- 2026-07-09: RED contract failed only on missing startup non-blocking marker, profile scan autofill helpers, and private knowledge loader helper.
- 2026-07-09: GREEN contract passed after moving 9Router `/v1/models` wait/combo/model/prewarm into background warmup, adding profile auto-fill/backfill, and loading scoped `file:` knowledge refs into Telegram memory prompt.
- 2026-07-09: Source committed as `da6f439` and pushed to `fork/telegram-startup-profile-knowledge-20260709`.
- 2026-07-09: Installed runtime patched with `gateway.js` and `telegram-memory.js`; backup saved at `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw-backup-20260709-startup-profile-knowledge-20260709-230554`. Runtime smoke PASS: `/health` live, app.asar contains startup/profile/knowledge markers, startup log shows gateway spawn before 9Router model warmup completes, and `/api/telegram/profile?name=LLK` resolves `targetChatId=-1003857797941`, `role=internal`, `responseMode=mention`.
