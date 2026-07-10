# Telegram Memory Modal Polish Design

## Muc tieu

Lam ro modal ho so Telegram sau khi UI da co day du hai cot `Nhom / kenh` va `Ca nhan / CEO / DM`.

Van de thuc te: phan `Bo nho rieng Telegram` va phan render markdown ben duoi dang hien thi cung mot noi dung theo hai dang khac nhau. Du lieu khong bi luu trung, nhung UI de lam nguoi dung hieu nham la co hai bo nho rieng.

## Pham vi

- Khong doi cau truc file profile Telegram.
- Khong doi API, IPC, memory loader, private notes, hay policy.
- Chi doi cach hien thi modal:
  - form tren la noi chinh sua bo nho rieng;
  - preview duoi la ban xem truoc AI se nap;
  - preview duoc thu gon de tranh cam giac lap noi dung.

## Thiet ke

Modal Telegram memory gom ba lop ro rang:

1. `Ho so dieu phoi Telegram`: chinh label, alias, role, response mode, trang thai bat/tat.
2. `Chinh sua bo nho rieng Telegram`: chinh 3 section AI se nap gom ho so doi tuong, kien thuc rieng can nap, luu y khi tuong tac.
3. `Ban xem truoc ho so AI se nap`: render markdown tu cung file profile, mac dinh thu gon, chi dung de kiem tra noi dung AI doc.

## Kiem thu

Them contract trong `check-telegram-memory-contract.js` de dam bao modal co marker rieng cho editor va preview:

- `tg-profile-section-editor-title`
- `tg-profile-preview`
- `tg-profile-preview-title`
- `tg-profile-preview-collapsible`

