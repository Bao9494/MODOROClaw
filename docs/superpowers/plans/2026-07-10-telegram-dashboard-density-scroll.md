# Telegram Dashboard Density Scroll Plan

## Trang thai

- Branch: `telegram-dashboard-scroll-density-20260710`
- Muc tieu: giam chieu cao vung tren trang Telegram va cho tung cot danh sach Telegram tu cuon doc lap.

## Pham vi

- Giam mat do header Telegram, pill trang thai, info/config band.
- Giam manager header/toolbar va an dong mo ta dai trong manager.
- Them layout scroll rieng cho `Nhom / kenh` va `Ca nhan / CEO / DM`.
- Khong doi schema, policy, memory loader, Telegram provider hay logic tra loi bot.

## Kiem thu

- Red: `npm.cmd run guard:telegram-memory` FAIL dung assertion `telegram conversation panes are dense and independently scrollable`.
- Green: `npm.cmd run guard:telegram-memory` PASS sau khi them density/scroll classes.
- Can chay tiep: `guard:dashboard-ux`, `map:generate`, `map:check`, build/patch runtime.

## Ghi chu

- Chi push vao `fork`, khong push `origin`.
- Runtime can duoc patch lai `app.asar` hoac cai bang installer moi thi anh Bao moi thay UI go live.
