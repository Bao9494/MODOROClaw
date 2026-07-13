# Telegram Provider Auth Error Guard

Date: 2026-07-13
Branch: `telegram-response-mode-fastpath-20260713`

## Problem

Telegram bot can leak raw 9Router/provider auth errors to the CEO chat when the LLM provider session expires.

Observed runtime log:

- `provider=ninerouter`
- `model=zalo`
- `error=401 [codex/gpt-5.5] [401]`
- `code=token_expired`
- `message=Provided authentication token is expired. Please try signing in again.`
- failover decision: `surface_error`

The existing `channels.js` outbound filter already blocks this error family for the main Telegram transport. The leaking path is the vendor bot reply dispatcher, which sends provider error payloads through its own `sendPayload` boundary.

## Scope

Fix the Telegram vendor bot boundary so provider auth failures are converted to a short operator-facing message before any reply is delivered.

This change does not refresh, rebind, or replace the 9Router/OAuth session. It only prevents raw JSON/HTTP/provider payloads from being sent to Telegram and gives a clear recovery instruction.

## Expected Behavior

When provider output contains `401`, `token_expired`, or `Provided authentication token is expired`, Telegram should receive a concise Vietnamese message similar to:

`Da Sep, phien dang nhap 9Router/LLM provider da het han nen em chua xu ly duoc cau can AI. Anh mo 9Router va dang nhap/refresh lai provider, roi nhan lai giup em.`

The outgoing Telegram text must not contain:

- raw JSON error object
- `/approve` command
- Python/tool command
- provider model stack text such as `401 [codex/gpt-5.5]`

## Verification Plan

1. Add a static regression assertion to `electron/scripts/check-telegram-memory-contract.js`.
2. Run the contract script and confirm the new assertion fails before the patch.
3. Add a vendor patch in `electron/lib/vendor-patches.js` at the vendor `sendPayload` boundary.
4. Run the contract script again and confirm it passes.
5. Apply the patch to the installed runtime.
6. Restart 9BizClaw/OpenClaw.
7. E2E through Telegram Web using a prompt that requires the LLM provider while the provider session is expired.
8. Confirm the bot replies with the short recovery message and no raw 401 JSON.

## Verification Result

- RED: `node electron/scripts/check-telegram-memory-contract.js` failed on `Telegram provider auth errors are sanitized before Telegram delivery`.
- GREEN: after adding `ensureTelegramProviderAuthErrorGuardPatch()`, the same contract script passed.
- Runtime patch: applied `20260713-telegram-provider-auth-error-guard-v1` to `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\vendor\node_modules\openclaw\dist\bot-BwMz6R6-.js`.
- Runtime syntax check: `node --check` passed for the patched bot dist file.
- Restart check: gateway `18789`, router `20128`, and cron API `20200` were listening after restart.
- E2E Telegram Web prompt: `E2E-202607132353-AUTHGUARD`.
- Runtime log confirmed `telegram-provider-auth-error-sanitized` with marker `20260713-telegram-provider-auth-error-guard-v1`, then `sendPayload-start ... textLen=163 isError=false`.
- Telegram Web confirmed the outgoing reply was the short recovery message, not raw `401` JSON.

## Follow-up

The 9Router/OAuth session still needs to be refreshed by signing in again. This guard only prevents raw provider error payloads from leaking to Telegram.
