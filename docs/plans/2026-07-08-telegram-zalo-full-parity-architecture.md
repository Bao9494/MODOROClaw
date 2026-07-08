# Plan: Telegram ke thua triệt để kiến trúc Zalo

Ngày lập: 2026-07-08  
Worktree: `O:\project\MODOROClaw-latency-hotfix-20260707`  
Branch: `runtime-latency-hotfix-20260707`

## Mục tiêu

Đưa Telegram từ trạng thái "có memory/routing giống Zalo một phần" thành một channel có kiến trúc vận hành tương đương Zalo:

- Telegram là kênh ưu tiên cho CEO, nội bộ và nhóm chăm sóc khách hàng.
- Zalo là kênh phụ/legacy, chỉ dùng khi CEO nói rõ Zalo hoặc dữ liệu chỉ tồn tại ở Zalo.
- Telegram có phân tầng người/nhóm/khách hàng/nội bộ/CEO rõ như Zalo.
- Agent không tự đoán ngữ cảnh; runtime phải nạp đúng context, memory và policy theo từng chat.
- UI Telegram trở thành bảng điều phối giống Zalo, nhưng có đặc thù Telegram: group, supergroup, channel, private, topic/thread, alias ID.

## Kết luận rà soát

Anh Bảo nhận định đúng: Telegram hiện chưa giống Zalo triệt để.

| Lớp | Zalo đang có | Telegram hiện có | Khoảng thiếu |
|---|---|---|---|
| Channel package | `electron/packages/modoro-zalo` có provider/channel/inbound/policy riêng | Telegram đi qua OpenClaw provider + các file `electron/lib/telegram-*` | Chưa có lớp channel riêng để gom policy, inbound context, session binding |
| Directory/cache | Zalo có friends/groups, group members, settings, cache giàu | Telegram seed từ config, cron, logs, sessions, profile | Chưa có directory chuẩn cho users/groups/members/topic |
| Policy | `policy.ts`, group policy, sender allowlist, mention mode, internal flag | Role cơ bản trong `telegram-conversation-settings.json` | Chưa có policy engine tương đương |
| Inbound context | `inbound.ts` đóng gói sender/group/metadata/history/message refs | Telegram có context block ở một số luồng | Chưa thống nhất cho mọi tin Telegram |
| Session binding | `subagent-bindings.ts` bind session theo conversation | Telegram còn phụ thuộc session/prewarm/runtime | Chưa có binding ổn định theo chat/thread |
| History/archive | Pending history, message refs, archive theo Zalo | Telegram có profile/scan nền tảng | Chưa có archive giàu cho từng chat |
| Memory | `memory/zalo-users`, `memory/zalo-groups` | `memory/telegram-chats`, foundation `memory/telegram-users`, `memory/telegram-groups` | Còn thiếu history archive và summary định kỳ từ inbound thật |
| UI | 2 cột Nhóm/Bạn bè, mode, nội bộ, bật/tắt, bulk action | Đã có foundation 2 cột Group/Channel và Private/CEO/DM, role/mode/enabled/profile/bulk action | Còn thiếu UI nhập alias/member/topic chi tiết và kiểm thử runtime sau build |

## Nguyên tắc thiết kế

1. Không vá trực tiếp từng lỗi nhỏ nếu lỗi thuộc kiến trúc channel.
2. Không copy UI Zalo 1:1; kế thừa cấu trúc điều phối, thêm đặc thù Telegram.
3. Không để agent tự quét file hoặc tự đoán ID khi runtime đã có API lookup.
4. Không nạp memory CEO/internal vào customer chat nếu role không cho phép.
5. Mọi thay đổi phải có guard/test trước khi build lại.
6. Ưu tiên sửa source chính, tránh runtime patch rời rạc trong `%APPDATA%`.

## Kiến trúc mục tiêu

### 1. Telegram channel spine

Tạo lớp trung tâm cho Telegram, có thể bắt đầu bằng `electron/lib/telegram-channel/*` hoặc package riêng sau này.

| Module đề xuất | Vai trò |
|---|---|
| `directory` | Chuẩn hóa chat/user/group/channel/member từ provider/cache/history |
| `policy` | Quyết định chat có được trả lời không, mode nào, quyền tool nào |
| `inbound-context` | Đóng gói context tin nhắn trước khi đưa vào agent |
| `session-bindings` | Bind session/agent với chat/thread Telegram ổn định |
| `history-archive` | Lưu lịch sử giàu theo chat/thread/user |
| `memory-scope` | Quyết định scope memory/knowledge được nạp |
| `target-resolver` | Resolve tên/alias/ID sang `targetChatId` |

### 2. Directory và dữ liệu

Telegram cần có directory tương tự Zalo nhưng đúng đặc thù Telegram.

| File/dữ liệu | Nội dung |
|---|---|
| `telegram-directory.json` | Danh sách chat/user/group/channel đã biết |
| `telegram-conversation-settings.json` | Role, enabled, responseMode, alias, target ID |
| `telegram-user-settings.json` | Vai trò từng người, CEO/internal/customer/contact |
| `telegram-group-settings.json` | Vai trò nhóm, nhóm khách hàng, nội bộ, topic config |
| `telegram-history/<chatId>.jsonl` | Message history đã chuẩn hóa |
| `memory/telegram-users/<userId>.md` | Hồ sơ từng người |
| `memory/telegram-groups/<chatId>.md` | Hồ sơ từng nhóm/kênh |
| `memory/telegram-chats/<chatId>.md` | Hồ sơ conversation tổng hợp, giữ tương thích bản hiện tại |

### 3. Policy tương đương Zalo

Mỗi Telegram chat cần các policy sau:

| Policy | Giá trị |
|---|---|
| `enabled` | Bot có xử lý chat này không |
| `role` | `ceo`, `internal`, `customer`, `unknown` |
| `chatType` | `private`, `group`, `supergroup`, `channel` |
| `responseMode` | `off`, `mention`, `all`, `ceo_priority` |
| `newChatPolicy` | `ignore`, `read_only`, `ask_ceo`, `auto_customer` |
| `toolScope` | `admin`, `internal`, `customer`, `public_only` |
| `memoryScope` | `ceo/internal/workflow/public/customer` theo role |
| `alias` | Tên thân thiện -> Telegram ID |

### 4. Inbound context bắt buộc

Mọi tin Telegram đưa vào agent phải có context block chuẩn:

```xml
<telegram-inbound-context trusted="true">
  <channel>telegram</channel>
  <priority>primary</priority>
  <chat id="..." type="..." title="..." role="..." responseMode="..." />
  <sender id="..." username="..." displayName="..." role="..." />
  <thread id="..." title="..." />
  <message id="..." replyTo="..." />
  <memory scopes="..." profilePath="..." />
  <policy canReply="..." canUseAdminTools="..." canSendOutbound="..." />
</telegram-inbound-context>
```

Agent chỉ nên hành động theo context này, không tự suy luận vai trò từ tên nhóm hoặc nội dung người dùng tự khai.

### 5. UI Telegram parity với Zalo

UI Telegram cần đổi từ một list kỹ thuật sang bảng điều phối 2 cột:

| Cột trái | Cột phải |
|---|---|
| Nhóm / supergroup / channel | Cá nhân / CEO / DM |

Mỗi cột nên có:

- Tab: `Đang bật`, `Tất cả`, `CEO`, `Nội bộ`, `Khách`, `Chưa phân loại`.
- Search theo tên, username, alias, ID.
- Bulk action: bật tất cả, tắt tất cả, scan, seed.
- Mỗi dòng: avatar, tên, ID, role, responseMode, enabled, profile, memory count, lastSeen.
- Nút hồ sơ mở đúng `memory/telegram-users`, `memory/telegram-groups` hoặc `memory/telegram-chats`.

Thanh trên cùng nên kế thừa Zalo:

- Chế độ tổng: tự động / đọc thôi / tạm dừng.
- Người lạ/chat mới: bỏ qua / đọc thôi / hỏi CEO / tự đưa vào khách hàng.
- Nhóm mới: tắt / mention / mọi tin.
- Gộp tin/debounce.
- Kiểm tra, đổi tài khoản, tạm dừng.

### 6. Memory và RAG theo tầng

Runtime phải chọn memory trước khi gọi LLM.

| Role chat | Memory được nạp |
|---|---|
| `ceo` | CEO, internal, workflow, public, chat profile |
| `internal` | internal, workflow, public, group/user profile |
| `customer` | customer/public đúng chat hoặc đúng nhóm khách hàng |
| `unknown` | public tối thiểu, không admin tools |

Khi một người nhắn trong group, cần xét hai tầng:

1. Role của nhóm.
2. Role của người gửi trong nhóm.

Ví dụ: nhóm là `internal`, người gửi là CEO hoặc nhân sự -> có thể dùng internal/workflow. Nhóm là `customer` -> chỉ dùng customer/public dù người tự nhận là admin.

## Giai đoạn triển khai

### Phase 0 - Chốt plan và guard

Mục tiêu: chưa sửa runtime lớn, chỉ chuẩn hóa tài liệu và guard.

- Tạo plan này.
- Cập nhật `docs/telegram-zalo-architecture-parity.md` để ghi rõ khoảng thiếu full parity.
- Rà `docs/generated/system-map.*` xem có cần cập nhật sau khi thêm module.
- Xác định test bắt buộc trước khi sửa code.

### Phase 1 - Schema và policy foundation

Mục tiêu: có schema dữ liệu Telegram rõ, chưa đụng mạnh vào provider.

- Tách policy ra khỏi `telegram-memory.js`.
- Thêm `telegram-policy.js`.
- Thêm settings/schema cho `responseMode`, `newChatPolicy`, `toolScope`, `alias`.
- Mở rộng `check-telegram-memory-contract.js` thành contract policy/memory.

Test:

- `node --check electron/lib/telegram-memory.js`
- `node --check electron/lib/telegram-policy.js`
- `node electron/scripts/check-telegram-memory-contract.js`
- `node electron/scripts/check-api-doc-drift.js`

### Phase 2 - Directory và rich cache

Mục tiêu: Telegram có cache/directory giống Zalo hơn.

- Thêm `telegram-directory.js`. (done)
- Thêm cache file `telegram-directory.json`. (done)
- Seed từ provider cache, sessions, logs, existing profiles, custom crons. (done ở mức runtime sources hiện có)
- Chuẩn hóa private/group/supergroup/channel bằng `directoryKind`. (done)
- Lưu alias tên -> ID. (done ở schema/settings/cache; UI nhập alias làm ở phase sau)
- Thêm API `/api/telegram/directory` và `/api/telegram/directory/refresh`. (done)
- Chuẩn bị chỗ cho members/topic nếu provider cung cấp. (pending)

Test:

- Lookup `LLK Agency (GMT +7) - LLK-999999` phải trả `-1003857797941`.
- Lookup không được quét đệ quy `%APPDATA%\9bizclaw`.
- Lookup dưới 1 giây trên cache hiện có.
- Contract phải kiểm tra settings override directory cache.

### Phase 3 - Inbound context và session binding

Mục tiêu: agent luôn biết đúng chat, sender, role, scope.

- Thêm context builder chuẩn cho Telegram. (done)
- Bind session theo `telegram:<chatId>` hoặc `telegram:<chatId>:thread:<topicId>`. (done ở helper/cache foundation; provider hook pending)
- Nhớ message refs theo chat/thread để reply/edit/delete/pin sau này. (done ở helper/cache foundation; provider hook pending)
- Đưa sender role và chat role vào prompt. (done ở memory prompt block nền)
- Không để cron/agent fallback sang sticky chat khi đã có target Telegram.

Test:

- Tin CEO hỏi ID group -> trả ID từ Telegram.
- Tin trong group internal -> agent nhận role internal.
- Tin trong group customer -> không nạp internal/CEO memory.
- Reminder/cron tạo từ group -> gửi đúng group.

### Phase 4 - UI parity

Mục tiêu: Telegram UI thành bảng quản trị giống Zalo.

- Chia 2 cột Group/Channel và Private/CEO/DM. (done foundation)
- Thêm tab/filter/bulk action/mode control. (done foundation)
- Mỗi dòng hiển thị role, responseMode, enabled, alias/source/target ID và memory count nếu có. (done foundation)
- Nút profile mở đúng tầng memory. (done qua profile button hiện có)
- Nút scan sâu/seed/import export rõ hơn. (done ở mức giữ nút hiện có; pending UX chi tiết)
- UI nhập/sửa alias, member, topic/thread trực tiếp trên từng chat. (pending)

Test:

- UI không mất chức năng hiện có.
- Có thể đổi role/mode/enabled từng Telegram chat.
- Có thể phân biệt group internal/customer trên giao diện.

### Phase 5 - History archive và memory tách tầng

Mục tiêu: agent có dữ liệu giàu như Zalo.

- Thêm lớp `telegram-runtime-capture` để mỗi event Telegram thật cập nhật directory, session binding, message refs và profile tầng. (done foundation)
- Hook outbound `sendTelegram`/`sendTelegramPhoto` để lưu message refs và directory từ kết quả Telegram API. (done foundation)
- Thêm `memory/telegram-users`. (done foundation)
- Thêm `memory/telegram-groups`. (done foundation)
- Giữ `memory/telegram-chats` để tương thích. (done từ các phase trước)
- Lưu `telegram-history/<chatId>.jsonl`. (pending)
- Tạo summary profile định kỳ từ history. (pending)
- Hook inbound provider/vendor để lưu inbound refs tự động. (pending, làm sau khi có guard chắc)

Test:

- Scan sâu tạo/cập nhật profile đúng tầng.
- Customer chat không thấy memory nội bộ.
- Internal group vẫn thấy workflow/internal khi được đánh dấu.

### Phase 6 - Build, cài và kiểm thử thực tế

Mục tiêu: chỉ build khi Phase 1-5 pass.

- Chạy guard/source test.
- Chạy sandbox smoke nếu vendor đầy đủ.
- Build unsigned installer.
- Cài thử.
- Test runtime: gateway, 9Router, Telegram lookup, Telegram send, cron reminder, UI role/mode.

## File dự kiến sẽ chạm

| Nhóm | File |
|---|---|
| Telegram runtime | `electron/lib/telegram-memory.js`, `electron/lib/telegram-routing.js`, file mới `electron/lib/telegram-policy.js`, `electron/lib/telegram-directory.js`, `electron/lib/telegram-inbound-context.js` |
| Cron/send | `electron/lib/cron-api.js`, `electron/lib/cron.js`, `electron/lib/channels.js`, `electron/lib/appointments.js` |
| UI | `electron/ui/dashboard.html`, `electron/preload.js`, `electron/lib/dashboard-ipc.js` |
| Test/guard | `electron/scripts/check-telegram-memory-contract.js`, có thể thêm `check-telegram-policy-contract.js` |
| Docs | `AGENTS.md`, `MEMORY.md`, `skills/operations/telegram-ceo.md`, `docs/telegram-zalo-architecture-parity.md`, `docs/generated/system-map.*` |

## Rủi ro và cách giảm

| Rủi ro | Cách giảm |
|---|---|
| Sửa rộng làm BOT chậm lại | Tách phase, test latency lookup trước/sau |
| UI đổi nhiều gây lỗi dashboard | Làm UI sau policy/schema, dùng preview nếu cần |
| Memory lẫn CEO/internal/customer | Contract test bắt buộc theo role |
| Provider Telegram không đủ metadata | Directory dùng nhiều nguồn, có fallback profile/settings |
| Runtime patch rời rạc khó kiểm soát | Chỉ sửa source, build lại sau khi test |
| Zalo đang ổn bị ảnh hưởng | Không sửa `modoro-zalo` trừ khi tạo parity test đọc-only |

## Điều kiện báo hoàn thiện

Chỉ coi là hoàn thiện khi đủ:

- Telegram UI có cấu trúc quản trị tương đương Zalo.
- Lookup tên/alias/ID Telegram ổn định, không fallback Zalo sai ngữ cảnh.
- Agent nhận đúng role chat và role sender.
- Memory được nạp đúng tầng: CEO/internal/customer/public.
- Gửi Telegram, cron, reminder đều dùng `targetChatId`.
- Guard/test pass.
- Docs/function map/system map đã rà và cập nhật nếu cần.
- Có bản build cài được và kiểm thử runtime thực tế.

## Bước tiếp theo đề xuất

Phase 1-4 foundation đã đi theo đúng hướng kế thừa Zalo. Bước tiếp theo nên là Phase 5:

1. Hoàn tất Phase 5 foundation: runtime capture, outbound hook, profile tầng group/user, contract guard.
2. Sau đó mới hook inbound provider/vendor để tránh làm BOT chập chờn vì patch quá rộng.
3. Bổ sung member/topic cache nếu provider có metadata đủ giàu.
4. Sau khi source guard pass mới build/cài runtime và test end-to-end: Telegram lookup, send, reminder, UI role/mode.

## Nhật ký thực hiện

- 2026-07-08: Đã bắt đầu Phase 1 bằng cách thêm `electron/lib/telegram-policy.js`, cho `telegram-memory.js` dùng policy chung, và mở rộng `check-telegram-memory-contract.js`.
- 2026-07-08: Verification source PASS: `node --check` cho Telegram policy/memory/contract, `check-telegram-memory-contract.js`, `check-api-doc-drift.js`, `generate-system-map.js --check`. Runtime DB filtering trong contract skip tại source clone vì `better-sqlite3` ABI khác Node hiện tại.
- 2026-07-08: Đã hoàn tất Phase 2 foundation bằng `electron/lib/telegram-directory.js`, cache `telegram-directory.json`, API `/api/telegram/directory`, `/api/telegram/directory/refresh` và contract guard.
- 2026-07-08: Đã hoàn tất Phase 3 foundation bằng `electron/lib/telegram-inbound-context.js`, `telegram-session-bindings.js`, `telegram-message-refs.js`; memory prompt block có inbound context, binding key và latest message ref.
- 2026-07-08: Đã hoàn tất Phase 4 UI foundation: Dashboard Telegram chuyển sang 2 cột Group/Channel và Private/CEO/DM, có tab riêng, search, bulk bật/tắt, role select, responseMode select, profile button và metadata alias/source/target ID. Chưa build/cài runtime.
- 2026-07-08: Đã hoàn tất Phase 5 runtime capture foundation: thêm `electron/lib/telegram-runtime-capture.js`, hook outbound `sendTelegram`/`sendTelegramPhoto`, seed `memory/telegram-users` và `memory/telegram-groups`, contract guard cho message refs/session binding/directory/tier profiles. Chưa hook inbound vendor sâu và chưa build/cài runtime.
