# CHANGES.md — Chi tiết thay đổi

> Commit history ghi *what*. File này ghi *what + why + how* — đủ để hiểu quyết định mà không cần đọc diff.

---

## 2026-06-02

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
