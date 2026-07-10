# Telegram Dashboard Compact Plan

## Trang thai

- Branch: `telegram-dashboard-compact-20260710`
- Muc tieu: lam gon vung thong tin ket noi/cau hinh Telegram va dam bao runtime cai dat nhan dung UI moi.

## Pham vi

- Compact hai card dau trang Telegram de danh them dien tich cho danh sach chat/group.
- Giu nguyen kien truc hai cot `Nhom / kenh` va `Ca nhan / CEO / DM`.
- Giu nguyen schema, loader, policy va memory prompt.
- Xac minh modal memory da dung ban moi, khong con title cu `Bo nho rieng Telegram`.

## Checklist

- [x] Kiem tra source va runtime: source co marker modal moi, runtime `app.asar` dang cai dat van la ban cu.
- [x] Viet contract guard truoc cho marker compact dashboard.
- [x] Xem guard fail khi UI compact marker chua co.
- [x] Sua `electron/ui/dashboard.html` de them layout compact.
- [x] Chay `npm.cmd run guard:telegram-memory`.
- [x] Chay dashboard UX guard va map check.
- [ ] Build/patch runtime cai dat de thay doi go live.
- [ ] Xac minh `app.asar` da co marker UI moi.
- [ ] Push branch vao `fork`, merge vao `main`, push `fork/main`.

## Ghi chu

- Khong push vao `origin`; chi push vao `fork`.
- Neu app dang mo khoa `app.asar`, can dong/mo lai app hoac chay installer moi.

## Kiem thu

- `npm.cmd run guard:telegram-memory`: PASS. Co warning `better-sqlite3` ABI trong clone local, cac assertion Telegram van PASS.
- `npm.cmd run guard:dashboard-ux`: PASS.
- `npm.cmd run map:check`: PASS routes=90 ipc=236 capabilities=3.
