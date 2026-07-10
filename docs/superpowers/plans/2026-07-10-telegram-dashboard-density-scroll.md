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
- `npm.cmd run guard:dashboard-ux`: PASS.
- `npm.cmd run map:generate`: PASS.
- `npm.cmd run map:check`: PASS routes=90 ipc=236 capabilities=3.
- `npm.cmd run build:win`: PASS, tao installer moi.
- Runtime installed `app.asar`: PASS density/scroll markers.

## Artifact

- Installer: `O:\project\MODOROClaw\dist\9BizClaw Setup 2.4.23.exe`
- SHA256: `09271E6D7A3B901E774984F54511EF24A3873606FF2E208D4341DC9AAF488CE9`
- Backup runtime cu: `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw-backup-dashboard-scroll-density-20260710-150644`

## Ghi chu

- Chi push vao `fork`, khong push `origin`.
- Runtime can duoc patch lai `app.asar` hoac cai bang installer moi thi anh Bao moi thay UI go live.
