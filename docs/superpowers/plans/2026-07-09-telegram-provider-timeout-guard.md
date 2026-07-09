# Telegram Provider Timeout Guard Plan

**Goal:** Prevent one slow Telegram LLM/provider request from making the bot look frozen for several minutes.

**Root Cause Evidence:** `openclaw.log` showed Telegram message `706` received at `20:14:10`, prompt cache completed at `20:14:15`, and final LLM callback returned only at `20:19:11` (`300436ms`). Telegram send after callback took about `477ms`, so the hang is upstream/provider latency, not Telegram delivery.

## Scope

- Add a vendor patch guard around Telegram dispatch so long-running LLM requests fail fast.
- Keep Telegram memory/profile architecture unchanged.
- Keep existing fast-path lookup patches intact.
- Add contract checks before implementation.

## Tasks

- [x] Add failing contract assertions for Telegram provider timeout guard.
- [x] Implement idempotent vendor patch for Telegram provider timeout guard.
- [x] Run targeted contract test.
- [x] Patch installed runtime and restart app.
- [x] Verify app ports and recent logs.
- [x] Update docs/function map decision.

## Implementation Notes

- Source patch: `electron/lib/vendor-patches.js`
  - Adds `ensureTelegramProviderTimeoutGuardPatch`.
  - Injects marker `20260709-telegram-provider-timeout-guard-v1` into OpenClaw Telegram vendor runtime.
  - Wraps `telegramDeps.dispatchReplyWithBufferedBlockDispatcher` with a timeout guard.
  - Default timeout is `90000ms`, clamped to `30000..180000ms`.
  - Supports overrides via `MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_MS`, `telegram.providerTimeoutMs`, or `cfg.telegram.providerTimeoutMs`.
  - Sends one friendly fallback message on timeout, then suppresses late deliver/skip/error callbacks to avoid duplicate Telegram replies.
- Contract patch: `electron/scripts/check-telegram-memory-contract.js`
  - Verifies the timeout guard marker, patch function, timeout log label, and settled guard are present.
- Installed runtime was patched and `app.asar` was replaced after backup:
  - Backup: `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw-backup-20260709-telegram-provider-timeout-guard\app.asar.before-provider-timeout-guard`
  - Previous `app.asar` hash: `F337D9B23B414CFDB3348914B36EF35C2E90A8B2141810DE33BBF745918DBA85`
  - New `app.asar` hash: `EA083125BDAC37878500A1D1D704F06177CD660F99E22C8521CC5BAFA20DC9BE`

## Verification

- `node electron/scripts/check-telegram-memory-contract.js` passed.
  - `better-sqlite3` runtime DB assertions were skipped because the source clone native binding targets a different Node module version; static Telegram contract assertions passed.
- `node -c electron/lib/vendor-patches.js` passed.
- Runtime vendor syntax check passed for:
  - `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\vendor\node_modules\openclaw\dist\bot-BwMz6R6-.js`
- App restart verification:
  - `http://127.0.0.1:18789/` returned HTTP 200.
  - `http://127.0.0.1:18789/health` returned HTTP 200 with `{"ok":true,"status":"live"}`.
  - Listening ports confirmed: `18789`, `20128`, `20129`, `20200`.
  - `audit.jsonl` recorded `gateway_ready_late` after `270763ms`; startup was slow but recovered without rollback.

## Docs / Function Map Decision

- `rg --files` found no `FUNCTION_DEPENDENCY_MAP.md` or function-map file in this worktree.
- This plan file is the related project documentation for the hotfix and has been updated with implementation and verification details.
