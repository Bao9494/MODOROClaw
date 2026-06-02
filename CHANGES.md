# CHANGES.md — Chi tiết thay đổi

> Commit history ghi *what*. File này ghi *what + why + how* — đủ để hiểu quyết định mà không cần đọc diff.

---

## 2026-06-02

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
