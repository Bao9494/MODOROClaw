# Spec: Telegram rich scan from history archive

Date: 2026-07-09
Branch: telegram-rich-scan-data-20260709

## Goal

Make Telegram seed/scan inherit the useful Zalo pattern more completely: a durable per-chat archive is treated as first-class source data, so Telegram conversations can be discovered, summarized, and auto-filled even when provider cache is thin.

## Current state

- Runtime capture already appends normalized Telegram events to `telegram-history/<chatId>.jsonl`.
- `seedTelegramConversationsFromRuntime()` already creates/updates `memory/telegram-chats/<chatId>.md`.
- Auto-fill already fills empty profile sections from label, role, sources, `msgCount`, `lastSeen`, and summary.
- Missing piece: `discoverTelegramConversationCandidates()` does not read `telegram-history`, so rich scanned history is not used as a seed source.

## Desired behavior

1. `discoverTelegramConversationCandidates()` reads known `telegram-history/*.jsonl` files.
2. Each history-backed candidate includes:
   - `chatId`
   - `chatType`
   - `label`
   - `msgCount`
   - `lastSeen`
   - `summary`
   - `sources` containing `history-archive`
   - participant/thread hints when available.
3. `seedTelegramConversationsFromRuntime()` passes the richer metadata into `ensureTelegramConversationProfile()`.
4. `buildTelegramAutofillProfileSections()` uses participant/thread hints to enrich:
   - `Ho so doi tuong`
   - `Kien thuc rieng can nap`
   - `Luu y khi tuong tac`
5. Existing manual profile sections are preserved. Backfill only fills empty sections.

## Non-goals

- Do not change Telegram fast-path response behavior.
- Do not change approval/tool execution behavior.
- Do not scrape remote Telegram history directly.
- Do not overwrite manual CEO notes or edited profile sections.

## Acceptance checks

- `node electron/scripts/check-telegram-memory-contract.js` proves history-only chats are discovered and profile sections are auto-filled.
- `node --check electron/lib/telegram-memory.js` passes.
- `node electron/scripts/generate-system-map.js --check` is reviewed; regenerate docs if needed.
- Runtime patch is only applied after source checks pass.
