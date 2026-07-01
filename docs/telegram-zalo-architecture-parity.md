# Đối chiếu kiến trúc Zalo sang Telegram

Ngày rà: 2026-07-01

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
| Memory injection khi cron Telegram chạy | `cron.js` nạp `<telegram-conversation-context>` nếu job có `telegramTarget` | Đã thêm |
| UI quản lý conversation | Tab Telegram có danh sách chat/group, bộ lọc CEO/nội bộ/khách, nút xem hồ sơ, role select và bật/tắt conversation | Đã thêm |
| Seed danh sách conversation | `telegram-memory.js` đọc `openclaw.json`, `custom-crons.json`, log/cache Telegram và profile đã có để seed `memory/telegram-chats/<chatId>.md` | Đã thêm nền tảng |
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

## Kết luận kỹ thuật

Telegram đã được mô phỏng theo Zalo ở ba lớp:

1. Lớp routing cron: target normalization, context capture, persisted delivery target, shared resolver, explicit outbound target.
2. Lớp memory/audience nền tảng: conversation profile, role, scope hints, actor-scoped memory retrieval, prompt context block.
3. Lớp quản trị Dashboard: danh sách Telegram conversations, role CEO/nội bộ/khách, xem hồ sơ riêng và seed hồ sơ từ dữ liệu runtime đang có.

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

Full `node electron/scripts/smoke-test.js` đã chạy tới cuối phần static; các check Telegram routing đều pass. Build smoke còn bị chặn bởi dependency chưa có trong clone source (`node-cron`, `xlsx`, `electron`).
