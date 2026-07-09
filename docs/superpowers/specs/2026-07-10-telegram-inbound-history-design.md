# Spec: Telegram inbound group history capture

Date: 2026-07-10
Branch: telegram-inbound-history-20260710

## Goal

Make Telegram group conversations accumulate durable history automatically, so the rich scan work can populate group profiles from real inbound traffic like Zalo does.

## Current Evidence

- Outbound Telegram messages are captured by `sendTelegram()` / `sendTelegramPhoto()`.
- Runtime history exists for the CEO/private chat because outbound readiness notifications were captured.
- The LLK group has directory/profile/settings data, but no `telegram-history/-1003857797941.jsonl` file yet.
- Existing vendor patches already modify OpenClaw's Telegram bot dispatcher for fast lookup and timeout protection.
- Group messages that require mention can return before `dispatchTelegramMessage`, so a dispatch-only hook would miss normal background group traffic.

## Design

Patch the OpenClaw Telegram bot provider in two places:

- `resolveTelegramInboundBody()`: capture group messages skipped by the no-mention gate.
- `dispatchTelegramMessage()`: capture messages that continue into fast-path or LLM handling.

The patch will:

1. Extract the inbound message context from `context`.
2. Normalize:
   - chat id, type, title
   - sender id, sender name, sender role
   - message id, reply id, thread/topic id
   - text/raw body
   - session key
3. Append a durable JSONL event with `direction: "inbound"` to `telegram-history/<chatId>.jsonl`.
4. Dedup by recent `messageId` tail checks so repeated provider retries do not duplicate history.
5. Never block reply flow: failures are logged and ignored.

## Safety

- No bot reply behavior changes.
- No LLM/provider behavior changes.
- No outbound send changes.
- The dispatch hook runs before fast-path/LLM so even fast-path handled group messages are archived.
- The no-mention hook runs before the provider returns `null`, so passive group traffic can enrich future scan/profile data.
- Direct JSONL append avoids coupling the vendored provider to Electron app internals inside `app.asar`.

## Acceptance Checks

- Source contract proves vendor-patch code contains the inbound-history marker and both dispatch/no-mention sources.
- Existing Telegram memory contract still passes.
- Runtime smoke verifies all local ports are up after patch.
