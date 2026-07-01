# Plan: Restore Premium License Build

## Muc tieu

Khoi phuc kien truc license/membership tu ban premium cu vao source hien tai, giu lai cac thay doi Telegram layered memory da co tren HEAD.

## Pham vi

- Lam tren worktree rieng: `O:\project\MODOROClaw-premium-restore`
- Branch: `restore-premium-license`
- Khong sua truc tiep `main`.
- Khong in hoac ghi log license key day du.

## Dau vao da xac minh

- Source hien tai tren `main` dang clean, ahead remote 2 commit.
- Installer free vua cai co `version: 2.0.0-free`, `edition: free`, `membership: false`.
- Runtime license van con tai `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\license.json`, plan premium, con han den 2027-06-30, machine id khop.
- Backup premium `app.asar.before-telegram-memory` co `version: 2.4.22`, `membership: true`.
- Installer `9BizClaw Setup 2.4.20.exe` co `membership: true`, co `lib/license.js`, `lib/license-public.pem`, `ui/license.html`, license IPC va license gate.

## Cach lam

1. Doi chieu file premium 2.4.22 va source hien tai.
2. Trich xuat cac file license can thiet tu backup premium.
3. Ghe p vao source hien tai:
   - `lib/license.js`
   - `lib/license-public.pem`
   - `ui/license.html`
   - license gate trong `main.js`
   - IPC `activate-license`, `get-license-status`, `deactivate-license`
   - preload bridge neu can.
4. Cap nhat metadata build sang membership/premium.
5. Chay audit/test/build phu hop.
6. Kiem tra app moi doc duoc license hien co va khong hien `v2.0.0-free`.
7. Cap nhat tai lieu/function map neu co thay doi function/API/service.

## Rui ro

- `license.js` trong ban premium da duoc obfuscate, can giu nguyen khi trich xuat.
- Neu chi doi metadata ma thieu license gate/IPC thi app co the nhin nhu premium nhung khong kiem tra license.
- Neu cai lai truc tiep ban 2.4.20 se mat cac thay doi Telegram moi, nen chi dung lam nguon tham chieu.

## Trang thai

- 2026-07-01: Tao worktree `restore-premium-license`.
- 2026-07-01: Bat dau doi chieu source hien tai voi backup premium.
- 2026-07-01: Khoi phuc `lib/license.js`, `lib/license-public.pem`, `ui/license.html` tu backup premium 2.4.22.
- 2026-07-01: Them lai license gate trong `main.js`, license IPC trong `lib/dashboard-ipc.js`, preload bridge trong `preload.js`.
- 2026-07-01: Cap nhat build metadata sang `version: 2.4.23`, `membership: true`.
- 2026-07-01: License module doc duoc runtime license hien co voi `status=valid`, `plan=premium`, con 364 ngay; khong in full key.
- 2026-07-01: `npm.cmd run guard:telegram-memory` PASS.
- 2026-07-01: `npm.cmd run map:generate` da cap nhat `docs/generated/system-map.*`; `npm.cmd run map:check` PASS.
- 2026-07-01: `npm.cmd run guard:contracts` PASS; `npm.cmd run guard:obfuscation-residue` PASS.
- 2026-07-01: `npm.cmd run smoke` voi `NODE_PATH` tro sang dependency day du chay qua cac smoke/source guard, dung o `guard:anthropic-doc-runtime` do worktree moi thieu artifact `electron/vendor-bundle.tar`; build-temp co artifact nay.
