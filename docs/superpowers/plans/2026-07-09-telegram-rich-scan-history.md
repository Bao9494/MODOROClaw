# Plan: Telegram rich scan from history archive

Date: 2026-07-09
Branch: telegram-rich-scan-data-20260709

## Scope

Add a low-risk history-backed scan source for Telegram so the current UI/API seed action can create richer profiles from `telegram-history/<chatId>.jsonl`, similar to how Zalo benefits from cached friend/group history.

## Steps

1. Add a RED contract to `electron/scripts/check-telegram-memory-contract.js`.
   - Create a synthetic Telegram history chat.
   - Assert the seed flow discovers it from `history-archive`.
   - Assert generated profile sections include message count, last seen, participant/thread hints, and recent summary.

2. Implement a collector in `electron/lib/telegram-memory.js`.
   - Import `telegram-history-archive`.
   - Add `collectHistoryArchiveCandidates(map)`.
   - Summarize recent rows safely with size and text limits.
   - Merge optional `participants`, `threadIds`, and `historyStats` into candidate rows.

3. Enrich profile auto-fill.
   - Add participant/thread lines when present.
   - Keep manual sections and CEO notes unchanged.
   - Keep customer/internal/CEO policy notes unchanged.

4. Update docs and generated map.
   - Update `docs/telegram-zalo-architecture-parity.md`.
   - Update the full parity plan if this closes the pending history-summary gap.
   - Run system map check and regenerate if stale.

5. Verify and publish.
   - Run syntax and contract checks.
   - Commit on branch `telegram-rich-scan-data-20260709`.
   - Push to `fork`, not `origin`.
   - Patch runtime only after source verification passes.
