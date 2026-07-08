# CHANGES.md — Chi tiết thay đổi

> Commit history ghi *what*. File này ghi *what + why + how* — đủ để hiểu quyết định mà không cần đọc diff.

---

## 2026-07-08

### Telegram session binding and message refs foundation

**File(s):** `electron/lib/telegram-session-bindings.js`, `electron/lib/telegram-message-refs.js`, `electron/lib/telegram-inbound-context.js`, `electron/scripts/check-telegram-memory-contract.js`, `docs/plans/2026-07-08-telegram-zalo-full-parity-architecture.md`

**Root cause:** Zalo có `subagent-bindings.ts` và `message-refs.ts` để khóa session/message theo đúng conversation. Telegram mới có context/directory, nhưng chưa có nền để bind session theo `chatId:threadId` hoặc nhớ message refs cho reply/edit/delete/pin sau này.

**Fix/Change:**
- Thêm `telegram-session-bindings.js` với cache `telegram-session-bindings.json`, binding key `telegram:<chatId>` hoặc `telegram:<chatId>:thread:<threadId>`, resolve theo conversation hoặc session.
- Thêm `telegram-message-refs.js` với cache `telegram-message-refs.json`, TTL/max, latest message theo chat/thread và resolver `latest/messageId/shortId`.
- Cho `telegram-inbound-context.js` nhúng `bindingKey` và `latestMessageRef`.
- Mở rộng contract test để kiểm tra session binding, latest message ref và inbound context có binding/message ref.

**Tradeoff/Decision:** Chưa hook vào Telegram provider để tự nhớ mọi inbound/outbound message. Đây là nền data contract để phase provider/UI sau dùng chung.

**Verification:** `node --check` cho `telegram-session-bindings.js`, `telegram-message-refs.js`, `telegram-inbound-context.js`, `check-telegram-memory-contract.js` PASS; `check-telegram-memory-contract.js` PASS static guards. Runtime DB filtering vẫn skip ở source clone do `better-sqlite3` ABI khác Node hiện tại.

**State:** Phase 3b session/message refs foundation done in source branch; chưa build/cài runtime.

---

### Telegram inbound context foundation

**File(s):** `electron/lib/telegram-inbound-context.js`, `electron/lib/telegram-memory.js`, `electron/scripts/check-telegram-memory-contract.js`, `docs/plans/2026-07-08-telegram-zalo-full-parity-architecture.md`

**Root cause:** Telegram memory context mới có conversation/profile/memory, nhưng chưa có block inbound chuẩn tương đương Zalo để gói conversation, sender, thread/topic, message refs và policy trước khi agent xử lý.

**Fix/Change:**
- Thêm `telegram-inbound-context.js` để build context chuẩn cho conversation, sender, thread/topic, message và policy.
- Cho `resolveTelegramConversation()` trả directory fields đầy đủ như `targetChatId`, `directoryKind`, `aliases`.
- Cho `buildTelegramMemoryContext()` tạo thêm `inboundContext`.
- Cho `formatTelegramMemoryPromptBlock()` nhúng `inboundContext` và `inboundContextBlock`, vẫn giữ tag cũ `telegram-conversation-context` để tương thích.
- Mở rộng contract test để khóa sender/thread/message/policy context.

**Tradeoff/Decision:** Chưa hook sâu vào Telegram provider/poller. Đây là helper chuẩn để cron/runtime/UI phase sau dùng chung.

**Verification:** `node --check` cho `telegram-inbound-context.js`, `telegram-memory.js`, `check-telegram-memory-contract.js` PASS; `check-telegram-memory-contract.js` PASS static guards. Runtime DB filtering vẫn skip ở source clone do `better-sqlite3` ABI khác Node hiện tại.

**State:** Phase 3 inbound context foundation done in source branch; chưa build/cài runtime.

---

### Telegram directory/rich-cache foundation

**File(s):** `electron/lib/telegram-directory.js`, `electron/lib/telegram-memory.js`, `electron/lib/cron-api.js`, `electron/scripts/check-telegram-memory-contract.js`, `docs/telegram-zalo-architecture-parity.md`, `docs/plans/2026-07-08-telegram-zalo-full-parity-architecture.md`

**Root cause:** Telegram lookup/list vẫn đang là tập hợp heuristics trong `telegram-memory.js`, chưa có lớp directory/cache ổn định như Zalo. Điều này làm UI khó tách group/private/channel và làm agent dễ phải dựa vào tên/trace thay vì một directory canonical.

**Fix/Change:**
- Thêm `telegram-directory.js` để chuẩn hóa entry theo `chatId`, `targetChatId`, `entityId`, `directoryKind`, `aliases`, `role`, `responseMode`, `toolScope`, `policy`, `sources` và search metadata.
- Thêm cache file `telegram-directory.json` cùng hàm đọc/ghi/refresh trong `telegram-memory.js`.
- Cho discover pipeline đọc `directory-cache` trước `settings`, để Dashboard/settings vẫn là override cuối cùng.
- Cho `listTelegramConversations()` và `findTelegramConversations()` đi qua directory helper thay vì tự sort/search.
- Thêm API đọc-only `/api/telegram/directory` và refresh cache `/api/telegram/directory/refresh`.
- Mở rộng contract test để kiểm tra alias/search, cache, settings override cache và route directory.

**Tradeoff/Decision:** Chưa dùng Bot API `getUpdates` để refresh directory vì có nguy cơ xung đột poller Telegram đang chạy. Phase này chỉ gom và chuẩn hóa các nguồn runtime hiện có.

**Verification:** `node --check` cho `telegram-directory.js`, `telegram-memory.js`, `cron-api.js`, `check-telegram-memory-contract.js` PASS; `check-telegram-memory-contract.js` PASS static guards. Runtime DB filtering vẫn skip ở source clone do `better-sqlite3` ABI khác Node hiện tại.

**State:** Phase 2 directory foundation done in source branch; chưa build/cài runtime.

---

### Telegram full Zalo-parity architecture plan + policy foundation

**File(s):** `electron/lib/telegram-policy.js`, `electron/lib/telegram-memory.js`, `electron/scripts/check-telegram-memory-contract.js`, `docs/telegram-zalo-architecture-parity.md`, `docs/plans/2026-07-08-telegram-zalo-full-parity-architecture.md`

**Root cause:** Telegram đã được harden ở tầng routing/API/memory nền, nhưng vẫn chưa giống Zalo triệt để vì thiếu lớp policy riêng. `telegram-memory.js` đang tự suy role/audience/scope, khiến UI, inbound, cron và memory dễ phát triển lệch nhau.

**Fix/Change:**
- Tạo plan full parity để kế thừa kiến trúc Zalo theo từng tầng: channel spine, directory/cache, policy, inbound context, session binding, history archive, memory tier và UI 2 cột.
- Ghi rõ trong tài liệu đối chiếu rằng Telegram hiện mới đạt nền tảng parity, chưa đạt full parity.
- Thêm `telegram-policy.js` để chuẩn hóa `role`, `audience`, `scopeHints`, `responseMode`, `toolScope` và quyền hành vi.
- Cho `telegram-memory.js` dùng policy chung khi đọc/ghi settings, finalize conversation và resolve conversation.
- Giữ export cũ từ `telegram-memory.js` để không làm vỡ caller hiện có.
- Mở rộng `check-telegram-memory-contract.js` để khóa policy mặc định của group/customer, internal group và unknown chat.

**Tradeoff/Decision:** Chưa đổi UI hoặc viết provider Telegram riêng trong bước này. Đây là nền an toàn để các phase sau dùng cùng một policy trước khi chạm inbound/UI lớn.

**Verification:** `node --check` cho `telegram-policy.js`, `telegram-memory.js`, `check-telegram-memory-contract.js` PASS; `check-telegram-memory-contract.js` PASS static guards; `check-api-doc-drift.js` PASS; `generate-system-map.js --check` PASS sau khi regenerate map. Runtime DB filtering trong contract vẫn skip ở source clone do `better-sqlite3` ABI khác Node hiện tại.

**State:** Phase 1 policy foundation done in source branch; chưa build/cài runtime.

---

### Telegram priority + Zalo-parity hardening

**File(s):** `electron/lib/telegram-memory.js`, `electron/lib/cron-api.js`, `electron/lib/cron.js`, `electron/lib/channels.js`, `electron/lib/appointments.js`, `AGENTS.md`, `MEMORY.md`, `skills/operations/telegram-ceo.md`, `skills/appointments.md`, `electron/scripts/check-telegram-memory-contract.js`, `docs/telegram-zalo-architecture-parity.md`, `docs/plans/2026-07-08-telegram-zalo-parity-hardening.md`

**Root cause:** Telegram đã có nền memory/UI nhưng BOT vẫn dễ suy luận theo Zalo: hỏi tên group thì đi tìm cache Zalo, gửi/nhắc lịch không có API Telegram lookup rõ ràng, appointment Telegram push bỏ qua `toId`, và cron fixed muốn gửi Telegram phải đi vòng qua LLM hoặc default chat.

**Fix/Change:**
- Thêm `findTelegramConversations()` để tra conversation theo tên/ID/role/type/enabled.
- Thêm API local `/api/telegram/conversations`, `/api/telegram/seed`, `/api/telegram/profile`, `/api/telegram/send`.
- Cho `sendTelegramPhoto()` nhận `targetChatId`.
- Cho `/api/cron/create` nhận target Telegram theo `targetChatId`/`telegramName`/`telegramGroupName`, lưu `telegramTarget` cho agent cron, và tạo fixed cron dạng `exec: telegram msg send <chatId> "<text>"`.
- Cho `cron.js` chạy `telegram msg send` như safe exec, không cần LLM để gửi một câu cố định.
- Cho `appointments.js` dùng `pushTargets[].toId` làm Telegram `targetChatId`.
- Cập nhật AGENTS/MEMORY/skills để Telegram là kênh ưu tiên; Zalo chỉ dùng khi CEO nói rõ Zalo hoặc Telegram lookup không có kết quả.
- Thêm regression guard vào `check-telegram-memory-contract.js`.

**Tradeoff/Decision:** Chưa viết provider Telegram riêng như Zalo/openzca vì phạm vi lớn và rủi ro cao. Bản này harden các tầng đã có: cache/runtime settings/API/cron/memory, đủ để BOT không rơi lại sang Zalo trong các luồng gửi group và nhắc lịch phổ biến.

**Runtime verification/follow-up fixes:**
- Added OpenClaw session metadata collector so Telegram names can resolve from `.openclaw/agents/main/sessions` when provider cache is thin.
- Fixed one-time cron timers scheduled farther than Node's 32-bit timeout limit; long timers now re-arm in safe chunks and log `next check`.
- Fixed Telegram session pre-warm in `gateway.js` by importing `getTelegramConfigWithRecovery` and `spawnOpenClawSafe`.
- Installed the rebuilt runtime into `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw`; license stayed valid, 9Router returned 36 models, gateway returned 200, Telegram lookup resolved LLK/NovaTria/CEO, and a 30-day cron test did not fire early.
- Current source `npm run smoke` still fails 3 vendor sentinels because `electron/vendor` is missing `9router` and `modoro-zalo`; runtime packaged preflight is OK because it uses `%APPDATA%\9bizclaw\vendor`.
- Residual: Zalo is currently disabled by Dashboard config, not crashed; cron API is listening on both `20200` and `20201` and should be cleaned up in a later narrow pass.

**Provider error fix:** Runtime log showed the user-facing `LLM request failed: provider rejected the request schema or tool payload` was actually a 9Router/Codex model mismatch: combo `zalo` pointed at an unsupported older Codex model for the current ChatGPT account. Backed up `C:\Users\bao.nguyen\AppData\Roaming\9router\db\data.sqlite`, updated combo `zalo` to `["cx/gpt-5.4","cx/gpt-5.5"]`, and updated source `ensure9RouterZaloCombo()` to repair both SQLite and legacy `db.json` stores. Verified `/v1/chat/completions` with `model=zalo` returns via `gpt-5.4`, and `openclaw agent --agent main ... --json` succeeds with model `zalo`.

**SQLite ABI fix:** 9Router's `better-sqlite3` native binding belongs to the vendor Node runtime, not the Electron process or the user's system Node. The SQLite combo repair now spawns the vendor Node binary to read/write `data.sqlite`, preventing ABI mismatch errors during startup.

**Cron session fix:** After a clean restart, the gateway pre-warm reliably creates `agent:main:main` with Telegram CEO delivery context, while `agent:main:telegram:direct:<id>` may not exist until an inbound Telegram message creates it. Cron now uses the pre-warmed CEO session key so reminders do not hit `session not found` and fall into the slow agent fallback path.

**Telegram ID lookup latency fix:** A CEO Telegram message asking for the ID of `LLK Agency (GMT +7) - LLK-999999` took 218,489ms end-to-end because the agent chose `rg` over the full `%APPDATA%\9bizclaw` tree; the tool call alone took 196,752ms and hit browser/cache lock files. Updated `skills/operations/telegram-ceo.md` to use `/api/telegram/conversations` for name->ID lookup and added an OpenClaw vendor fast-path for simple Telegram ID lookup questions so these requests can be answered from `telegram-conversation-settings.json` / `memory/telegram-chats/*.md` without an LLM tool scan. Runtime verification: `/api/telegram/conversations?name=LLK Agency...` returned `-1003857797941` in 345ms; `model=zalo` returned `pong` in 3301ms after restart.

**Runtime disk-full recovery note:** During live verification, drive `C:` reached `0GB` free and runtime logs showed `ENOSPC` / `DISK FULL` while Brain, Zalo cache, and OpenClaw session store were writing. Offloaded partial temp build artifacts to `O:\project\9bizclaw\backups\offloaded-temp-20260708-135024` and removed stale temp build/check folders `MODOROClaw-build-main` and `MODOROClaw-vendor-check`; `C:` recovered to ~14.76GB free. Verified small writes in `.openclaw\agents\main\sessions` and `%APPDATA%\9bizclaw`, gateway `18789`, Telegram lookup, and 9Router `model=zalo`.

**Cron API idempotent startup fix:** Startup paths can call `startCronApi()` from main boot, gateway boot, tray, Dashboard, or wizard completion. The server object was only assigned after `listen()`, so near-simultaneous calls could start one server on `20200` and another fallback on `20201` in the same Electron process. Added `_cronApiStarting` so repeated calls while the first server is binding are skipped, and reset it on successful listen, real listen failure, or cleanup.

**Runtime config restore note:** A manual PowerShell JSON write added a UTF-8 BOM to `C:\Users\bao.nguyen\.openclaw\openclaw.json`, which made OpenClaw preflight treat the config as corrupt. Restored the latest backup by stripping the BOM with Node and verified `openclaw.json` parses without BOM.

**State:** done in source branch + runtime installed/verified. Merge/commit pending.

---

## 2026-06-02

### Version: free edition renumbered 3.0.1-free → 2.0.0-free

**File(s):** `electron/package.json`, `electron/package-lock.json` (2 fields),
`README.md`, `.github/workflows/build-mac-release.yml` (example hint)

**Why:** The free edition was at 3.0.1-free — *higher* than the premium product
(2.4.x), which is backwards for a free/premium split. Renumbered the free line to
2.0.0-free so it visibly sits below premium. README was also stale (still showed
v3.0.0 while the build was 3.0.1-free); now consistent at v2.0.0-free.

**Also (release side, done outside the repo):** the published v3.0.0-free and
v3.0.1-free GitHub releases + tags were deleted and a single v2.0.0-free release
cut in their place. The current installers were re-uploaded under it — note they
still internally report 3.0.1-free until the next build is cut natively at 2.0.0.
`skills/operations/zalo.md` `version: 3.0.0` left as-is (that's the skill doc's own
metadata version, not the app version).

**State:** done

---

### Security/hygiene: public-repo cleanup (MODOROClaw is public)

**File(s):** `electron/lib/nine-router.js` (JWT secret), `.gitignore` + `CLAUDE.md` (untrack), `README.md`

**What + why:** The repo `modoro-digital/MODOROClaw` is public. Three problems fixed:

1. **Hardcoded JWT secret** — `nine-router.js` pinned `JWT_SECRET` to the literal
   `'REDACTED-ROTATED-SECRET'`. A shared constant in public source
   lets anyone forge a valid 9Router auth cookie. **Fix:** new `get9RouterJwtSecret()`
   generates a random 256-bit secret on first run, persists it to
   `<DATA_DIR>/.jwt-secret` (mode 0600), and reuses it — so cookies still survive
   restarts but each install has its own secret. `INITIAL_PASSWORD=123456` kept
   (localhost-only default, intentional).

2. **CLAUDE.md published** — the internal engineering journal documents the
   licensing/revocation Gist URL + GitHub handle, hardware-lock seal scheme,
   default credentials, ports, and every plugin bypass. **Fix:** `git rm --cached
   CLAUDE.md` + added to `.gitignore`. Kept on disk for local dev; not shipped in
   the product, so no build impact.

3. **README pointed at a non-existent repo** — all Releases + clone links used
   `github.com/modoro-digital/9BizClaw` (404; real repo is `MODOROClaw`). Dev-mode
   block called the gitignored `RUN.bat`. **Fix:** corrected all URLs to
   `MODOROClaw`, replaced `RUN.bat` with `npm start`, dropped the now-private
   `CLAUDE.md`/`RESET.bat` references from the dev-rules section.

**Not done (left to CEO — irreversible / business calls):** the old JWT literal,
Gist URL, and default password remain in *git history* — forward edits don't purge
them (rotating the JWT is the real mitigation since each install now self-generates).
A full purge needs a history rewrite + force-push, or making the repo private.
`AGENTS.md` left tracked: it ships inside every distributed binary (extractable from
any install) and removing it breaks source builds — making the repo private is the
only real protection. `9BizClaw-Premium` repo is also public (separate from this fix).

**State:** done (local). Push to `modoroclaw/main` pending.

---

### Fix: zalo-followup cron 9:30 AM gửi lỗi "parameter conflict" cho sessions_send

**File(s):** `electron/lib/cron.js` — `buildZaloFollowUpPrompt()` (lines ~1227-1229, ~1250)

**Root cause:** `buildZaloFollowUpPrompt()` dặn LLM "Gửi đúng tool sessions_send." Tool `sessions_send` trong openclaw yêu cầu tham số `sessionKey` (bắt buộc) để xác định target session. Khi LLM gọi `sessions_send` mà không có `sessionKey`, openclaw tool validator phản bác "parameter conflict" (sai schema). Cron chạy 3 lần retry rồi thất bại im lặng — CEO không nhận được tin.

**Tại sao bug xảy ra:** Hướng dẫn "sessions_send" đã được thêm vào prompt builder mà không hiểu schema của tool. `sessions_send` là internal inter-session RPC, không phải tool gửi tin ra ngoài. Tool đúng để LLM dùng là `message` (gửi tin đến CEO Telegram session — đã được AGENTS.md điều khiển).

**Fix:** Xoá 2 chỉ dẫn "Gửi qua tool sessions_send." khỏi `buildZaloFollowUpPrompt()`. Thay bằng "Gửi cho CEO báo cáo... qua tin nhắn." — LLM tự dùng `message` tool đúng theo AGENTS.md rules.

**Phạm vi kiểm tra:** Đã kiểm tra TẤT CẢ cronjob:
- Morning briefing, evening summary, afternoon nudge, weekly report, monthly report — dùng `runCronViaSessionOrFallback` → `sendToGatewaySession` (gateway CLI, không qua LLM tool) — **OK**
- Zalo follow-up — dùng `runCronAgentPrompt` với hướng dẫn `sessions_send` — **BROKEN → FIXED**
- Memory cleanup — dùng `runCronAgentPrompt` không có tool instruction — **OK**
- Custom crons (user-created) — dùng `runCronViaSessionOrFallback` hoặc `runCronAgentPrompt` tùy zaloTarget — phụ thuộc prompt user viết, không ảnh hưởng

**All 6 built-in cronjob tool paths verified:**
| Cron | Mode | Tool instruction | Status |
|------|------|-----------------|--------|
| Morning briefing | session-send (gateway CLI) | None | OK |
| Evening summary | session-send (gateway CLI) | None | OK |
| Afternoon nudge | session-send (gateway CLI) | None | OK |
| Weekly report | session-send (gateway CLI) | None | OK |
| Monthly report | session-send (gateway CLI) | None | OK |
| Zalo follow-up | runCronAgentPrompt | sessions_send (SAI) | FIXED |
| Memory cleanup | runCronAgentPrompt | None | OK |

**State:** done

---

## 2026-06-01

### Quy tắc ghi chép

**Mỗi khi có thay đổi** (fix, edit, new function, new feature, refactor, config change), phải ghi vào file này **TRƯỚC KHI commit**. Format:

```markdown
### YYYY-MM-DD — <Mô tả ngắn>

**File(s):** `<list files>`
**Root cause:** (nếu là bug fix) Tại sao bug xảy ra
**Fix/Change:** Giải thích cách sửa / thiết kế
**Tradeoff/Decision:** (nếu có) Tại sao chọn cách này thay vì cách khác
**State:** done / in-progress / reverted
```

Ghi đủ để:
- Hiểu quyết định mà không cần đọc code
- Trace một bug về nguyên nhân gốc
- Onboard dev mới nhanh
- Không cần đọc commit history

---
