# 9Router Codex Desktop Auth Sync

Date: 2026-07-14
Branch: `9router-codex-auth-sync-20260714`

## Problem

9Router can keep a stale Codex OAuth/access-token provider after the provider session expires. When this happens, Telegram/Zalo requests that need the LLM can fail with provider auth errors even though Codex Desktop still has a fresh signed-in token.

Runtime evidence from the current machine:

- Old Codex OAuth provider: inactive, `testStatus=error`, `errorCode=401`, `lastError=Token expired and refresh failed`.
- New Codex access-token provider imported from Codex Desktop: active and healthy.
- Direct 9Router LLM smoke after import: HTTP 200 / text `OK`.

## Scope

Make 9BizClaw recover this class of failure at 9Router startup:

1. Read Codex Desktop auth from `%USERPROFILE%\.codex\auth.json`.
2. Decode only non-secret JWT metadata: email, plan, subject, expiry.
3. Refuse missing, malformed, expired, or near-expiry tokens.
4. Check current 9Router Codex providers via 9Router's local provider-list endpoint.
5. If an active Codex provider looks healthy, test it through 9Router's provider-test endpoint.
6. If no healthy active Codex provider exists, import the Codex Desktop access token through 9Router's Codex import-token endpoint.
7. Test the imported/active Codex provider through 9Router's provider-test endpoint.

## Safety Rules

- Never log or document the access token.
- Use 9Router's local API instead of hand-writing provider records.
- Do not import on every boot when an active provider passes a real 9Router provider test.
- Do not change Telegram/Zalo prompt, memory, routing, or UI behavior in this change.

## Verification Plan

1. Add a contract test for token metadata parsing.
2. Watch the test fail before the helper exists.
3. Implement the minimal helper and startup scheduler.
4. Run the new contract test.
5. Run the existing 9Router v0.4.63 compatibility guard.
6. Run the helper against the live 9Router instance and confirm it skips when the provider is already healthy.
7. Run a direct 9Router LLM smoke without printing API keys or tokens.

## Verification Result

- RED: `node electron/scripts/check-9router-codex-auth-sync.js` failed because `parseCodexDesktopAccessTokenMetadata` did not exist.
- GREEN: `node electron/scripts/check-9router-codex-auth-sync.js` passed.
- Compatibility: `node electron/scripts/check-9router-0463-compat.js` passed.
- Live sync smoke: `ensure9RouterCodexDesktopAuthSync()` tested the active provider and returned `skipped=active-provider-healthy` for provider `a2f5f0b6-762a-401e-96c8-8f2c48668751` in about 370ms.
- Live LLM smoke: `call9Router('Reply with exactly: OK')` returned `OK` in about 1.2s.

## Follow-up

This source fix becomes durable after the next source build/install. The current machine is already operational because the Codex Desktop token was imported manually and the stale OAuth provider was disabled during runtime recovery.
