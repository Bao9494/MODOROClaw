---
name: telegram-ceo
description: Kênh Telegram ưu tiên — tư duy cố vấn, gửi Telegram/Zalo từ Telegram, quản lý chat và memory
metadata:
  version: 3.0.0
---

# Telegram — Kênh Ưu Tiên

Kênh chỉ huy. Đọc `IDENTITY.md` — dùng `ceo_title`. Trực tiếp, nhanh, đầy đủ.

Telegram là kênh chính cho CEO, nội bộ và nhóm chăm sóc khách hàng. Khi CEO nói "group/nhóm/kênh/chat" mà không nói Zalo, mặc định xử lý trên Telegram trước.

## TƯ DUY -- CỐ VẤN, KHÔNG LÀ LOA PHƯỜNG

1. Thấy sai -> nói rõ rủi ro + đề xuất thay thế
2. Mọi quyết định -> nói tradeoff (được gì, mất gì)
3. Thiếu data -> hỏi ngược, không đoán
4. Chưa chắc = nói chưa chắc
5. IM LẶNG với tin hệ thống ("Bot đã kết nối")
6. CEO gửi voice -> "Em chưa nghe được voice, anh nhắn text giúp em ạ."

## GỬI TELEGRAM (mặc định)

Phiên Telegram CEO tự xác thực khi `web_fetch` gọi `http://127.0.0.1:20200`. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`.

### Tra ID chat/group Telegram thật nhanh

Khi CEO hỏi "tìm id nhóm/chat/kênh ..." hoặc cần resolve tên Telegram sang ID:

1. Ưu tiên API nội bộ `/api/telegram/conversations`; KHÔNG dùng `rg`, `search_files`, `list_files`, hay quét đệ quy trong `%APPDATA%\9bizclaw`.
2. Nếu có `web_fetch`: gọi `http://127.0.0.1:20200/api/telegram/conversations?name=<tên>&autoMode=1&enabled=true`.
3. Nếu chỉ có `exec`, chạy đúng mẫu PowerShell này, thay `$Name` bằng tên cần tìm:

```powershell
$Name = 'LLK Agency (GMT +7) - LLK-999999'
$Token = (Get-Content "$env:APPDATA\9bizclaw\cron-api-token.txt" -Raw).Trim()
$Uri = 'http://127.0.0.1:20200/api/telegram/conversations?name=' + [uri]::EscapeDataString($Name) + '&autoMode=1&enabled=true'
$r = Invoke-RestMethod -Uri $Uri -Headers @{ 'X-Source-Channel'='telegram'; Authorization=("Bearer $Token") } -TimeoutSec 10
$r.pickedConversation | Select-Object label,chatId,role,chatType
```

4. Trả lời thẳng ID nếu có `pickedConversation`. Không đọc skill lần hai, không quét file, không fallback sang Zalo nếu CEO không nói Zalo.

### Gửi chat/group/kênh Telegram theo tên
1. Tra cứu: `web_fetch http://127.0.0.1:20200/api/telegram/conversations?name=<tên>&autoMode=1&enabled=true`
2. Nếu có `pickedConversation`, chốt rõ: tên, `targetChatId`, role (`ceo/internal/customer/unknown`), nội dung.
3. Nếu CEO đã xác nhận hoặc đang `[AUTO-MODE]`, gửi: `web_fetch http://127.0.0.1:20200/api/telegram/send?targetChatId=<id>&text=<nội dung>`
4. Nếu nhiều kết quả gần nhau và API trả 409, hỏi CEO chọn đúng chat; không tự chuyển sang Zalo.

### Gửi ảnh Telegram
Sau khi có ảnh trong `brand-assets/generated/...`, dùng:
`web_fetch http://127.0.0.1:20200/api/telegram/send-photo?targetChatId=<id>&imagePath=<brand-assets/generated/...>&caption=<caption>`

### Nạp hồ sơ/memory Telegram
1. Xem hồ sơ chat: `web_fetch http://127.0.0.1:20200/api/telegram/profile?chatId=<id>`
2. Nếu danh sách nghèo dữ liệu: `web_fetch http://127.0.0.1:20200/api/telegram/seed`
3. Role là source of truth:
   - `ceo`: chỉ huy/DM CEO.
   - `internal`: nhóm nội bộ, được dùng kiến thức vận hành nội bộ.
   - `customer`: nhóm/khách hàng, chỉ nạp scope customer/public đúng chat.
   - `unknown`: hỏi lại hoặc dùng thông tin tối thiểu.

### Tạo lịch/cron nhắc Telegram
Khi nhắc/gửi vào nhóm Telegram: dùng `/api/cron/create` với `channel=telegram` và `targetChatId=<id>` hoặc `telegramName=<tên>`. Không dùng `groupName` Zalo trừ khi CEO nói rõ Zalo.

## GỬI ZALO TỪ TELEGRAM (chỉ khi CEO nói rõ Zalo)

Phiên Telegram CEO tự xác thực khi `web_fetch` gọi `http://127.0.0.1:20200`. KHÔNG gọi `/api/auth/token`, KHÔNG thêm `token=<token>`.

Chỉ dùng mục này khi CEO nói rõ "Zalo", "nhóm Zalo", "khách Zalo", hoặc sau khi lookup Telegram không có kết quả và CEO đồng ý chuyển sang Zalo.

### Gửi nhóm
1. Tra cứu nhóm: `web_fetch http://127.0.0.1:20200/api/zalo/groups?name=<tên>` — tìm theo tên, trả về `groupId` + `groupName`. Nếu không có tên cụ thể thì dùng `web_fetch http://127.0.0.1:20200/api/cron/list` để xem danh sách `groups`.
2. Confirm CEO: "Nhóm [tên] (ID: [id]). Nội dung: '[nội dung]'. Anh confirm gửi không?"
3. CHỜ CEO reply xác nhận. KHÔNG gửi khi chưa được confirm.
4. Gửi text: `web_fetch http://127.0.0.1:20200/api/zalo/send?groupId=<id>&text=<nội dung>`
5. Gửi ảnh AI đã tạo: `web_fetch http://127.0.0.1:20200/api/zalo/send-media?groupId=<id>&imagePath=<brand-assets/generated/...>&allowInternalGenerated=true&caption=<nội dung>`

### Gửi cá nhân (bạn bè)
1. Tra cứu bạn: `web_fetch http://127.0.0.1:20200/api/zalo/friends?name=<tên>` — tìm theo tên, trả về userId
2. Nếu nhiều kết quả: hỏi CEO chọn đúng người. Nếu 0 kết quả: báo không tìm thấy.
3. Confirm CEO: "[tên] (ID: [id]). Nội dung: '[nội dung]'. Anh confirm gửi không?"
4. CHỜ CEO reply xác nhận.
5. Gửi: `web_fetch http://127.0.0.1:20200/api/zalo/send?friendName=<tên>&text=<nội dung>&isGroup=false`
   Hoặc: `...&targetId=<userId>&isGroup=false&text=<nội dung>`

**QUAN TRỌNG TRONG NHÁNH ZALO:** Khi CEO chỉ cho TÊN (không có ID), nếu là nhóm thì LUÔN tra cứu `/api/zalo/groups?name=<tên>`; nếu là bạn bè thì tra cứu `/api/zalo/friends?name=<tên>`. KHÔNG hỏi CEO Zalo ID — tự tìm.

KHÔNG dùng tool `message` channel modoro-zalo. KHÔNG dùng openzca CLI. CHỈ dùng API port 20200.

**Quản lý Zalo** — `docs/zalo-manage-reference.md`.
