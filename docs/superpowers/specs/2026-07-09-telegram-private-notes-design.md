# Telegram Private Notes Design

## Goal

Bring Telegram closer to the Zalo customer-memory experience by letting the CEO store private notes and customer/persona guidance on each Telegram conversation profile.

## Current State

Telegram already has layered profile files, conversation roles, response modes, directory lookup, and a split dashboard manager. Zalo still has one important advantage: the customer memory modal lets the CEO append private notes that are never sent to the customer but are loaded later as context.

Telegram profile files already contain sections such as `## Ho so doi tuong`, `## Kien thuc rieng can nap`, and `## Luu y khi tuong tac`, but the dashboard only reads the raw profile. There is no IPC or UI equivalent of `append-zalo-user-note`.

## Design

Add a Telegram note layer that mirrors the Zalo note pattern without rewriting the Telegram provider:

- Store notes in the existing Telegram conversation profile markdown file.
- Use a dedicated `## CEO notes` section for private CEO notes.
- Sanitize note text, cap each note at 2000 characters, and append timestamped markdown bullets.
- Add IPC/preload methods to append and delete Telegram conversation notes.
- Expand the Telegram profile modal with a private note textarea and save button.
- Keep role, response mode, enabled toggles, lookup, and runtime capture behavior unchanged.

## Data Model

Each Telegram profile file may include:

```markdown
## CEO notes
- **2026-07-09 10:30** - Khach thich trao doi ngan gon, uu tien bang gia ro rang.
```

This section is private operational memory. It is loaded through the existing `readTelegramConversationProfile()` and `buildTelegramMemoryContext()` path, so the agent can use it when the conversation profile is in scope.

## Safety

- Notes are stored only in the local workspace profile file.
- Notes are not sent to Telegram users.
- Notes follow the conversation's existing role and memory scope.
- Unknown chat IDs are rejected by the same numeric Telegram ID sanitizer already used by the manager.
- Deletes remove only timestamped CEO note lines, not the rest of the profile.

## Acceptance Criteria

- Dashboard can append a private note to any Telegram conversation profile.
- Dashboard can delete a timestamped Telegram CEO note.
- Telegram profile modal exposes the note input similarly to Zalo.
- Contract test verifies note append/delete and UI/IPC/preload wiring.
- Existing Telegram memory guard passes.
- Architecture docs mention Telegram private notes as a parity layer.
