# Telegram Profile Section Editor Design

## Goal

Add a dashboard editor for the three Telegram conversation profile sections that already feed the agent context:

- `## Ho so doi tuong`
- `## Kien thuc rieng can nap`
- `## Luu y khi tuong tac`

## Current State

Telegram conversation profiles are stored as Markdown files under `memory/telegram-chats/<chatId>.md`. The agent already loads the raw profile content through `readTelegramConversationProfile()` and injects it into `<telegram-conversation-context>`.

The dashboard can already edit identity/policy controls and append/delete `## CEO notes`, but the three structured profile sections still require manual Markdown edits.

## Design

Keep the storage format unchanged. Add a small whitelist-based updater in `electron/lib/telegram-memory.js` that only edits the three approved sections and preserves frontmatter, headings, footer text, and `## CEO notes`.

Expose the updater through:

- IPC: `save-telegram-conversation-profile-sections`
- Preload: `window.claw.saveTelegramConversationProfileSections(chatId, sections, meta)`
- Dashboard modal: three textareas and one save button near the existing Telegram profile controls

## Scope

This feature edits direct Markdown text only. It does not add a document loader for file paths listed under `Kien thuc rieng can nap`. If file-reference loading is needed later, it should be a separate feature with its own safety rules.

## Safety

- Only known section keys are accepted.
- Input is trimmed, normalized for line endings, capped per section, and rejects control characters.
- Missing sections are created before `## CEO notes` when possible.
- The existing context-loading path remains unchanged.

## Verification

Use `electron/scripts/check-telegram-memory-contract.js` as the regression guard. The test must prove:

- The helper is exported.
- Saving sections updates only the intended profile sections.
- `## CEO notes` remains intact.
- IPC/preload/UI strings exist.
