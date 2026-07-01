# Plan: Restore Premium Feature Surface

## Muc tieu

Khoi phuc cac module premium bi thieu so voi ban premium truoc khi sua: Google Workspace, Facebook, Brain tab va cac IPC/preload/UI lien quan, dong thoi giu lai Telegram layered memory da them tren `main`.

## Pham vi

- Lam tren worktree rieng: `O:\project\MODOROClaw-premium-features`
- Branch: `restore-premium-feature-surface`
- Nguon tham chieu chinh: backup premium 2.4.22 tai `C:\Users\bao.nguyen\AppData\Local\Temp\premium-2422-full-reference`
- Khong in hoac ghi log license key day du.
- Khong thay truc tiep app dang cai cho den khi da build/test du.

## Kiem tra ban dau

- `main` hien tai da co license/premium gate, nhung thieu nhieu feature premium trong UI/IPC/preload.
- Backup premium 2.4.22 co dau hieu ro rang:
  - Brain preload bridge: `getBrainGraph`, `getBrainNodeDetail`, `rebuildBrainGraph`
  - Google Workspace preload bridge va IPC: auth, calendar, gmail, drive, docs, contacts, tasks, sheets, appscript
  - Facebook preload bridge va IPC
  - `main.js` co lich build Brain graph va cleanup Google process

## Cach lam du kien

1. So sanh file list va API surface giua backup premium 2.4.22 va source hien tai.
2. Phan loai:
   - File premium missing co the copy nguyen ven.
   - File da duoc sua boi Telegram memory can merge thu cong.
3. Khoi phuc cac file/module premium can thiet.
4. Cap nhat preload, dashboard IPC, main boot/lifecycle, UI dashboard.
5. Cap nhat package dependency/build file neu premium can them package.
6. Chay syntax check, system-map, contract/guard/smoke phu hop.
7. Neu build duoc `win-unpacked`, thay `app.asar` vao app cai sau khi backup.

## Rui ro

- Premium backup 2.4.22 cu hon source hien tai, copy de len toan bo co the lam mat Telegram layered memory.
- `dashboard.html`, `dashboard-ipc.js`, `preload.js`, `main.js` deu la file giao thoa lon, can merge theo tung khoi.
- Build NSIS co the van loi moi truong `winCodeSign`; neu vay chi co the dung `win-unpacked/app.asar` de cap nhat runtime.

## Trang thai

- 2026-07-02: Tao worktree/branch `restore-premium-feature-surface`.
- 2026-07-02: Bat dau doi chieu premium backup 2.4.22 voi source `main` hien tai.
- 2026-07-02: Copy 30 file premium bi thieu tu backup 2.4.22, gom Brain, Facebook, Google Workspace va cac service lien quan.
- 2026-07-02: Merge `preload.js`, `dashboard-ipc.js`, `workspace.js`, `main.js`, `dashboard.html` de khoi phuc UI/API premium nhung van giu Telegram layered memory.
- 2026-07-02: Them dependency Brain premium `graphology` va `graphology-layout-forceatlas2` vao `electron/package.json` va `electron/package-lock.json`.
- 2026-07-02: Da chay `node --check` cho cac file JS chinh va toan bo file premium moi them.
- 2026-07-02: Da chay `npm run map:generate`, `map:check`, `guard:contracts`, `guard:telegram-memory`, `guard:obfuscation-residue`.
- 2026-07-02: Build-temp `C:\Users\bao.nguyen\AppData\Local\Temp\MODOROClaw-build-main` da chay `npm.cmd run smoke` PASS day du sau khi bo sung Brain dependency va cap nhat smoke parity cho chat IPC module.
- 2026-07-02: Phat hien va sua lech idle-memory do `dashboard-ipc.js` tu premium 2.4.22 goi `startIdleMemoryWatcher`, trong khi source hien tai dung `setIdleMemoryRunCronAgent(runCronViaSessionOrFallback)`.
- 2026-07-02: `npm.cmd run build:win` tao duoc `dist/win-unpacked/resources/app.asar`; buoc dong goi NSIS van dung o loi moi truong `winCodeSign-2.6.0.7z` khong tao duoc symlink Darwin trong cache Windows.
- 2026-07-02: Da thay `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw\resources\app.asar` bang ban `win-unpacked` moi. Backup truoc khi thay ban cuoi: `C:\Users\BAO~1.NGU\AppData\Local\Temp\9bizclaw-install-backup-20260702011657-before-idle-memory-fix\app.asar.before-idle-memory-fix`.
- 2026-07-02: SHA256 `app.asar` da cai khop ban build moi: `128F3046D0949CF8796EB475C835B7BDBA1B1DF5C3E6CFB6DE2FCFC8487808CA`.
- 2026-07-02: Kiem tra `app.asar` da cai: `version=2.4.23`, `membership=true`, co Brain/Google/Facebook/Telegram memory/license va dependency `graphology`.
- 2026-07-02: Mo app that thanh cong voi moi truong nguoi dung binh thuong; log xac nhan `membership build, license valid` va load `dashboard.html`; khong con warning `startIdleMemoryWatcher is not a function`.
