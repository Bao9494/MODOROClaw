# Đối chiếu kiến trúc Zalo sang Telegram

Ngày rà: 2026-07-01
Cập nhật: 2026-07-09 — Telegram được nâng lên kênh ưu tiên, thêm API lookup/send/profile/seed, cron Telegram safe exec, appointment target theo `targetChatId`, fast role lookup và cron source header cho request đến từ Telegram.

## Phạm vi

Tài liệu này ghi lại phần đã học từ kiến trúc Zalo và phần đã mô phỏng lại cho Telegram.

Trọng tâm không chỉ là routing cron. Kiến trúc tốt của Zalo nằm ở mô hình phân tầng: nhận diện đối tượng, vai trò nội bộ/khách hàng, hồ sơ memory riêng theo người/nhóm, RAG theo audience, skill theo scope và frame hành vi trước khi agent xử lý.

Không coi đây là rewrite Telegram channel. Mục tiêu hiện tại là dựng nền tảng tương đương để Telegram có thể dùng nhiều tầng phân loại và memory riêng theo từng cuộc trò chuyện.

## Mẫu kiến trúc Zalo đã học

| Lớp | Zalo đang có | Ý nghĩa |
|---|---|---|
| Target resolver | `resolver-target.ts`, `send.ts` | Chuẩn hóa đích gửi là user/group trước khi gửi |
| Inbound context | `inbound.ts` | Đóng gói `SessionKey`, `From`, `To`, `ChatType`, `OriginatingChannel`, metadata quote/media |
| Conversation binding | `subagent-bindings.ts` | Gắn session/agent con với đúng cuộc trò chuyện |
| Outbound guard | `outbound-dedupe.ts`, policy/filter trong `send.ts` | Chống gửi trùng, lọc output lỗi, kiểm soát quyền gửi |
| Delivery memory | `message-refs.ts`, `pending-history.ts` | Nhớ message refs/history để trả lời đúng ngữ cảnh |

## Kiến trúc phân tầng memory của Zalo

| Tầng | Cơ chế | Vì sao hiệu quả |
|---|---|---|
| Kênh | `modoro-zalo` có inbound/provider riêng | Tách rõ customer channel khỏi Telegram CEO/admin |
| Đối tượng | `senderId`, `threadId`, `isGroup` | Mỗi người/nhóm có identity ổn định, không trộn ngữ cảnh |
| Vai trò | `zalo-user-settings.json`, `zalo-group-settings.json` với cờ `internal` | Nội bộ được dùng tài liệu internal; khách chỉ thấy public |
| Hồ sơ riêng | `memory/zalo-users/<senderId>.md`, `memory/zalo-groups/<groupId>.md` | Agent nhớ lịch sử, sở thích, chủ đề, quyết định riêng của từng đối tượng |
| Cold start | `seedZaloCustomersFromCache()` tạo hồ sơ từ friends/groups cache | Vừa cài app đã nhận diện được khách/nhóm cũ, không đợi bot học lại từ đầu |
| Knowledge audience | RAG gọi `/search?...&audience=customer|internal` | Nạp đúng tầng tài liệu; giảm rủi ro lộ tài liệu nội bộ |
| Behavioral frame | Inbound đổi frame khách hàng/nội bộ trước prompt | Agent đổi vai: bán hàng/chăm sóc khách hoặc trợ lý nội bộ |
| Skill scope | User skill lazy-match theo `operations/zalo` | Chỉ nạp skill liên quan, tiết kiệm context và giảm nhiễu |
| Actor filter | Memory OS lọc entity theo actor | Không đọc nhầm hồ sơ khách/nhóm khác |

Kết luận: hiệu quả chính đến từ việc filter trước khi scoring/nạp prompt. Agent không phải "tự nhớ để chọn", mà hệ thống chỉ đưa đúng lớp dữ liệu nó được phép thấy và cần dùng.

## Phần đã mô phỏng cho Telegram

| Mẫu Zalo | Telegram hiện đã có | Trạng thái |
|---|---|---|
| Target resolver dùng chung | `electron/lib/telegram-routing.js` | Đã thêm |
| Hồ sơ conversation riêng | `electron/lib/telegram-memory.js`, `memory/telegram-chats/<chatId>.md` | Đã thêm nền tảng |
| Vai trò conversation | `ceo`, `internal`, `customer`; group/supergroup mặc định customer-like | Đã thêm nền tảng |
| Scope memory theo vai trò | `ceo/internal/workflow/public` hoặc `customer/public` | Đã thêm |
| Actor filter cho Telegram customer-like | Memory OS chỉ cho `actorId=telegram:<chatId>` thấy entity của chính chat đó | Đã thêm |
| Inbound/chat context tối thiểu | `vendor-patches.js` truyền session/chat headers vào API local | Đã thêm ở mức cần cho cron |
| Lưu delivery target theo job | `cron-api.js` lưu `telegramTarget` vào custom cron | Đã thêm |
| Resolver khi cron fire | `cron.js` ưu tiên `explicitTarget` → `replyChatId` → `originChatId` | Đã thêm |
| Outbound gửi đúng target | `channels.js` cho `sendTelegram(text, { targetChatId })` | Đã thêm |
| Lookup chat/group theo tên | `/api/telegram/conversations?name=...&autoMode=1` dùng `findTelegramConversations()` | Đã thêm |
| Fast role lookup theo tên/alias | `vendor-patches.js` trả lời nhanh câu hỏi nội bộ/khách hàng/role từ settings + memory Telegram trước khi vào LLM loop | Đã thêm |
| API gửi Telegram theo tên/ID | `/api/telegram/send`, `/api/telegram/send-photo`, `/api/telegram/profile`, `/api/telegram/seed` | Đã thêm |
| Cron fixed Telegram không qua LLM | `cron-api.js` tạo `exec: telegram msg send <chatId> "<text>"`; `cron.js` chạy safe exec | Đã thêm |
| Cron Telegram giữ đúng source khi chỉ có `name` | `cron-api.js` đọc `X-Source-Channel: telegram` để scope `name/groupName/chatName` sang Telegram trước Zalo | Đã thêm |
| Appointment push target Telegram | `appointments.js` dùng `pushTargets[].toId` làm `targetChatId` | Đã thêm |
| Memory injection khi cron Telegram chạy | `cron.js` nạp `<telegram-conversation-context>` nếu job có `telegramTarget` | Đã thêm |
| Inbound context foundation | `electron/lib/telegram-inbound-context.js` đóng gói conversation/sender/thread/message/policy để nhúng vào memory prompt block | Đã thêm nền tảng |
| Conversation/session binding | `electron/lib/telegram-session-bindings.js` bind session theo `telegram:<chatId>` hoặc `telegram:<chatId>:thread:<threadId>` | Đã thêm nền tảng |
| Message refs | `electron/lib/telegram-message-refs.js` nhớ latest message theo chat/thread để reply/edit/delete/pin sau này | Đã thêm nền tảng |
| Runtime capture | `electron/lib/telegram-runtime-capture.js` cập nhật directory, session binding, message refs và profile tầng từ event Telegram thật | Đã thêm foundation |
| Outbound capture | `sendTelegram`/`sendTelegramPhoto` lưu message ref thật sau khi Telegram API trả `message_id` | Đã thêm foundation |
| Memory tầng Telegram | `memory/telegram-users/<userId>.md`, `memory/telegram-groups/<chatId>.md`, giữ `memory/telegram-chats/<chatId>.md` để tương thích; directory scanner đọc cả 3 tầng | Đã thêm foundation |
| UI quản lý conversation | Tab Telegram có bảng 2 cột Group/Channel và Private/CEO/DM, bộ lọc riêng từng cột, nút xem hồ sơ, role select, responseMode select và bật/tắt/bulk action theo conversation | Đã thêm foundation |
| Seed danh sách conversation | `telegram-memory.js` đọc `openclaw.json`, `custom-crons.json`, log/cache Telegram và profile đã có để seed `memory/telegram-chats/<chatId>.md` | Đã thêm nền tảng |
| Directory/cache Telegram | `electron/lib/telegram-directory.js`, `telegram-directory.json`, `/api/telegram/directory`, `/api/telegram/directory/refresh` | Đã thêm nền tảng |
| Regression guard | `smoke-test.js`, `check-media-library-contract.js`, `check-telegram-memory-contract.js` | Đã thêm |

## Mô hình Telegram mới

| Loại Telegram conversation | Role mặc định | Memory scopes | Actor/entity |
|---|---|---|---|
| Private/DM CEO | `ceo` | `ceo`, `internal`, `workflow`, `public` | Không đổi hành vi cũ |
| Group/supergroup | `customer` | `customer`, `public` | `entityType=telegram_chat`, `entityId=telegram:<chatId>` |
| Conversation được đánh dấu nội bộ sau này | `internal` | `internal`, `workflow`, `public` | `telegram:<chatId>` |

Điểm an toàn: Telegram group mặc định không được tự đọc CEO memory. Muốn một group thành nội bộ thì cấu hình explicit trong `telegram-conversation-settings.json` hoặc đổi trực tiếp trên UI Telegram manager.

## Điểm cố ý chưa mô phỏng

| Phần Zalo | Lý do chưa làm cho Telegram |
|---|---|
| Full inbound package riêng như `packages/modoro-zalo` | Telegram hiện đi qua OpenClaw provider/plugin; viết provider riêng là phạm vi lớn hơn lỗi cron |
| Subagent binding đầy đủ theo conversation | Cần metadata ổn định từ Telegram inbound provider, chưa đủ bằng chứng để sửa an toàn |
| Dedupe outbound toàn kênh | Có thể ảnh hưởng alert CEO và retry Telegram; chỉ nên thêm sau khi có test E2E rõ |
| Provider Telegram riêng giàu metadata như openzca | UI hiện seed được từ cấu hình, cron, log/cache và profile; provider Telegram vẫn chưa có cache danh bạ/group đầy đủ như Zalo |

## Trạng thái full parity

Bản 2026-07-08 mới đạt nền tảng parity ở routing, API lookup/send, profile conversation, policy foundation, directory/cache foundation, inbound context foundation, session binding foundation, message refs foundation, runtime capture foundation, outbound capture hook và UI 2 cột foundation như Zalo. Telegram chưa đạt full parity với Zalo vì còn thiếu channel spine riêng, provider hook inbound thật sự, member/topic cache, history archive định kỳ, UI nhập/sửa alias/member/topic chi tiết và kiểm thử runtime sau build.

Plan triển khai triệt để nằm ở `docs/plans/2026-07-08-telegram-zalo-full-parity-architecture.md`.

## Kết luận kỹ thuật

Telegram đã được mô phỏng theo Zalo ở bốn lớp:

1. Lớp routing cron: target normalization, context capture, persisted delivery target, shared resolver, explicit outbound target.
2. Lớp memory/audience nền tảng: conversation profile, role, scope hints, actor-scoped memory retrieval, prompt context block.
3. Lớp runtime capture: outbound Telegram thật cập nhật directory, session binding, message refs và profile tầng user/group.
4. Lớp quản trị Dashboard: bảng Telegram 2 cột Group/Channel và Private/CEO/DM, role CEO/nội bộ/khách/chưa rõ, responseMode, bật/tắt, bulk action, xem hồ sơ riêng và seed hồ sơ từ dữ liệu runtime đang có.

Từ bản cập nhật 2026-07-08, Telegram còn có thêm lớp điều phối API giống Zalo:

1. BOT tra `targetChatId` bằng tên chat/group trước khi gửi.
2. BOT gửi Telegram theo `targetChatId` thay vì rơi sang cache Zalo.
3. Cron/nhắc lịch Telegram có thể lưu target rõ ràng và dùng safe exec, không cần gọi LLM chỉ để gửi một câu.
4. Appointment push target Telegram dùng `toId` đúng nghĩa là `targetChatId`.

Lỗi gốc “cron tạo từ Telegram group nhưng kết quả quay về CEO DM/sticky chat” được xử lý bằng cách biến chat context thành dữ liệu của job, thay vì để runtime đoán lại bằng `allowFrom[0]` hoặc sticky chat.

Kiến trúc memory phân tầng của Zalo thật sự tối ưu ở 4 điểm:

- Giảm nhiễu context: agent chỉ nhận memory/skill/knowledge liên quan tới đối tượng hiện tại.
- Giảm rủi ro bảo mật: customer không thấy CEO/internal/private memory; nội bộ chỉ thấy public + internal.
- Tăng chất lượng chăm sóc: mỗi nhóm/người có hồ sơ riêng, nên agent nhớ chủ đề, quyết định, sở thích, vai trò.
- Mở rộng tốt: thêm role hoặc group mới chỉ thêm settings/profile, không cần nhồi tất cả vào prompt chung.

## Kiểm tra đã chạy

- `node --check electron/lib/telegram-routing.js`
- `node --check electron/lib/cron-api.js`
- `node --check electron/lib/cron.js`
- `node --check electron/lib/dashboard-ipc.js`
- `node --check electron/lib/telegram-memory.js`
- `node --check electron/preload.js`
- `node --check electron/scripts/check-media-library-contract.js`
- `node --check electron/scripts/smoke-test.js`
- `node electron/scripts/check-media-library-contract.js`
- `node electron/scripts/smoke-skill-runtime.js`
- `node electron/scripts/check-capability-contracts.js`
- `node electron/scripts/check-api-doc-drift.js`
- `node electron/scripts/generate-system-map.js --check`
- `node electron/scripts/check-telegram-memory-contract.js`
- `node --check electron/lib/channels.js`
- `node --check electron/lib/appointments.js`
- Sandbox local: `npm.cmd run smoke` PASS
- Sandbox local: unsigned Windows installer build PASS
- Artifact: `O:\project\9bizclaw\artifacts\9BizClaw Setup 2.4.23-telegram-parity-unsigned-20260708.exe`
- 2026-07-09: `npm.cmd run guard:architecture` PASS sau fast role/header fix
- 2026-07-09: unsigned Windows installer build PASS, installed runtime PASS
- 2026-07-09: Runtime verify PASS: `telegram-fast-role-lookup: applied`, 4 cổng `18789/20128/20129/20200` listen, `/api/telegram/profile?name=LLK` trả `role=internal`, cron `name=LLK` + `X-Source-Channel: telegram` resolve đúng `targetChatId=-1003857797941`
- Artifact mới: `O:\project\9bizclaw\artifacts\9BizClaw Setup 2.4.23-telegram-fast-role-unsigned-20260709.exe`

Ghi chú: smoke trong source worktree trên ổ `O:` còn đỏ nếu `electron/vendor` chưa extract đủ `9router`/`modoro-zalo`; sandbox local đã có vendor bundle đầy đủ nên dùng để xác nhận build/package.
