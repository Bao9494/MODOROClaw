# MEMORY.md — Bảng Chỉ Mục

> Bảng tham chiếu nhẹ. Chi tiết nằm trong các file liên kết.
> Nạp file này mỗi phiên (~1k tokens). Chỉ đi sâu vào file chi tiết khi cần.

---

## Ngữ cảnh đang hoạt động
Các file này chứa ngữ cảnh quan trọng. Nạp khi bắt đầu phiên.
- `memory/YYYY-MM-DD.md` — Nhật ký hôm nay (append-only)

## Người
| Tên | Vai trò | Chi tiết | Từ khóa kích hoạt |
|-----|---------|----------|---------------------|
| CEO | Chủ nhân | Đọc `IDENTITY.md` | chủ nhân, sếp, boss |

Bot tự tạo hồ sơ khách trong `memory/zalo-users/<senderId>.md`, `memory/zalo-groups/<groupId>.md` và hồ sơ Telegram trong `memory/telegram-chats/<chatId>.md`, `memory/telegram-users/<userId>.md`, `memory/telegram-groups/<chatId>.md`.

## Quy tắc đi sâu
1. **Cuộc trò chuyện nhắc đến chat/group Telegram?** -> Tra `/api/telegram/conversations`, rồi nạp `memory/telegram-chats/<chatId>.md`; nếu có profile tầng thì nạp thêm `memory/telegram-groups/<chatId>.md` hoặc `memory/telegram-users/<userId>.md`.
2. **Telegram role là `internal`?** -> Có thể nạp knowledge/vận hành nội bộ phù hợp.
3. **Telegram role là `customer`?** -> Chỉ nạp memory scope customer/public đúng chat đó; không nạp memory CEO/nội bộ.
4. **Cuộc trò chuyện nhắc đến khách Zalo?** -> Nạp file trong `memory/zalo-users/`
5. **Nhóm Zalo?** -> Nạp file trong `memory/zalo-groups/`
6. **Khách Zalo/Telegram customer hỏi SP/dịch vụ/giờ/chính sách?** -> CHỈ đọc `knowledge/cong-ty/index.md` + `knowledge/san-pham/index.md` + `knowledge/nhan-vien/index.md`. KHÔNG dùng COMPANY.md / PRODUCTS.md (2 file đó tóm lược từ wizard, không chính xác).
7. **Không chắc về ngữ cảnh?** -> Dùng `memory_search`
8. **Bắt đầu phiên:** Persona và tình trạng hôm nay đã inject sẵn vào SOUL.md và USER.md (tự động). KHÔNG cần đọc `active-persona.md` hay `shop-state.json` riêng. Tra knowledge khi cần: `knowledge/cong-ty/index.md` + `knowledge/san-pham/index.md` + `knowledge/nhan-vien/index.md`.
9. **Giới hạn cứng:** Tối đa 5 lần đi sâu khi bắt đầu phiên
10. **Thay đổi code:** MỌI thay đổi phải ghi vào `CHANGES.md` TRƯỚC KHI commit. Commit ghi what, CHANGES.md ghi what + why + how.

## File tham khảo
| File | Nội dung |
|------|----------|
| `memory/zalo-users/<id>.md` | Hồ sơ khách hàng Zalo (tên, tag, lịch sử) |
| `memory/zalo-groups/<id>.md` | Hồ sơ nhóm Zalo (thành viên, chủ đề) |
| `memory/telegram-chats/<chatId>.md` | Hồ sơ conversation Telegram tổng hợp, giữ tương thích runtime cũ |
| `memory/telegram-users/<userId>.md` | Hồ sơ người dùng/DM Telegram, được tạo từ runtime capture |
| `memory/telegram-groups/<chatId>.md` | Hồ sơ nhóm/kênh Telegram, được tạo từ runtime capture |
| `telegram-directory.json` | Cache directory Telegram: chat/group/channel/private, alias, role, mode, nguồn dữ liệu |
| `telegram-session-bindings.json` | Cache bind session/agent theo chat hoặc thread Telegram |
| `telegram-message-refs.json` | Cache message refs Telegram theo chat/thread để reply/edit/delete/pin đúng đích |
| `knowledge/*/index.md` | Tài liệu doanh nghiệp (công ty, sản phẩm, nhân viên) |
| `.learnings/LEARNINGS.md` | Bài học từ các phiên trước |

## Nhật ký hàng ngày
`memory/YYYY-MM-DD.md` (append-only, audit trail). Chỉ nạp khi cần chi tiết cụ thể về ngày nào đó.

## Lịch sử khách hàng
`memory/zalo-users/<senderId>.md` ngoài frontmatter (tên, tag, phone), còn có các section `## YYYY-MM-DD` chứa tóm tắt tương tác từng ngày. Bot đọc những section này khi khách reply.

---

*Cập nhật bảng chỉ mục này mỗi khi cập nhật file chi tiết.*
