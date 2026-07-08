# Plan: OpenClaw Latency Hotfix Source Port

## Muc tieu

Port cac latency hotfix da kiem chung tren runtime 2.4.20 vao source/build chuan de build sau tu dong ap dung, khong can sua tay trong `AppData`.

## Pham vi

- Worktree: `O:\project\MODOROClaw-latency-hotfix-20260707`
- Branch: `runtime-latency-hotfix-20260707`
- Source goc: `O:\project\MODOROClaw` tai commit `987c563`
- File chinh du kien sua:
  - `electron/lib/vendor-patches.js`
  - `electron/scripts/prebuild-vendor.js`
  - guard/smoke test lien quan den vendor patches
  - `docs/generated/system-map.*` neu map thay doi

## Nguon tham chieu

- Runtime hotfix package: `O:\project\9bizclaw\hotfix-packages\openclaw-latency-20260707`
- Runbook: `O:\project\9bizclaw\docs\runbooks\openclaw-latency-hotfix-20260707.md`
- Installed runtime da test: `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\vendor\node_modules\openclaw\dist`

## Cach lam du kien

1. Dua logic latency vao `vendor-patches.js` bang patch idempotent theo marker.
2. Khong copy bundle JS patched vao source, vi source se npm-install OpenClaw khi `prebuild:vendor`.
3. Patch theo nhom:
   - Skip implicit provider discovery khi da co explicit provider.
   - Chat channels dung tool set nhe, heavy tools chi bat bang config.
   - Provider `auth = "api-key"` bo qua auth-profile override moi turn.
   - Cache static model resolve cho provider config tinh.
   - Diagnostic timing chi log khi `OPENCLAW_LATENCY_DIAG=1`.
4. Wire patch vao build-time `applyAllVendorPatches` va runtime boot.
5. Them guard de dam bao patch khong bi mat sau refactor.
6. Chay syntax/guard phu hop va cap nhat system map neu can.

## Rui ro va gioi han

- OpenClaw dist la bundle hash-file, anchor co the doi khi OpenClaw bump version.
- Neu anchor doi, patch se log warning/patch-failures thay vi sua sai im lang.
- Khong cache LLM response hay noi dung chat; chi cache metadata/config tinh.
- Khong thay doi license, token, API key, Telegram token.

## Kiem tra ban dau

- `O:\project\9bizclaw` khong phai Git repo.
- `O:\project\MODOROClaw` la repo source sach nhat, branch `main` clean nhung ahead remote 11 commit.
- Source da co `electron/lib/vendor-patches.js` va `prebuild-vendor.js` tu dong apply vendor patches o build-time.
- Source hien co patch `authCacheTtl` va `sessionFreeze`, nhung chua co cac latency patch con lai cua goi runtime 2026-07-07.

## Trang thai

- 2026-07-07: Tao worktree/branch `runtime-latency-hotfix-20260707`.
- 2026-07-07: Bat dau port hotfix vao source/build chuan.
- 2026-07-07: Them `ensureOpenclawLatencyPatches` vao `electron/lib/vendor-patches.js`.
- 2026-07-07: Wire latency patch vao build-time `applyAllVendorPatches` va runtime boot `gateway.js`.
- 2026-07-07: Them smoke guard cho latency patch va thu tu `web_fetch localhost` truoc `fast-chat tool gating`.
- 2026-07-07: Test ap patch tren bundle backup tam PASS, xac nhan 5 nhom marker duoc chen dung.
- 2026-07-07: `node --check` PASS cho `vendor-patches.js`, `gateway.js`, `smoke-test.js`.
- 2026-07-07: `node scripts/smoke-test.js` PASS khi dat `NODE_PATH=O:\project\MODOROClaw\electron\node_modules`; 6 warning khong blocking do worktree khong co vendor OpenClaw/models.
- 2026-07-07: `node scripts/smoke-skill-runtime.js` PASS.
- 2026-07-07: `node scripts/check-media-library-contract.js` PASS.
- 2026-07-07: `node scripts/generate-system-map.js` va `--check` PASS; da cap nhat `docs/generated/system-map.*`.
- 2026-07-08: Them `--ignore-scripts` cho buoc npm install vendor trong `electron/scripts/prebuild-vendor.js` de tranh `9router` postinstall warm-up ghi vao runtime user va lam build treo.
- 2026-07-08: Build tren o `O:` bi cham/treo khi xoa/cai `vendor/node_modules`; da dung sandbox local `C:\Users\bao.nguyen\AppData\Local\Temp\9bizclaw-build-latency-hotfix-20260707` de build.
- 2026-07-08: `prebuild:models` PASS, `prebuild:vendor` PASS; `vendor-bundle.tar` tao thanh cong, co models va latency patches.
- 2026-07-08: `prebuild:modoro-zalo` PASS.
- 2026-07-08: `npm run smoke` PASS trong sandbox local.
- 2026-07-08: `npm run build:win` di qua prebuild + smoke nhung electron-builder fail o `winCodeSign` do user hien tai khong co quyen tao symlink.
- 2026-07-08: Tao duoc unsigned Windows installer bang `electron-builder --win --publish never --config.win.signAndEditExecutable=false --config.nsis.packElevateHelper=false`; `scripts/check-bundle-size.js --strict` PASS.
- 2026-07-08: Artifact sandbox: `C:\Users\bao.nguyen\AppData\Local\Temp\9bizclaw-build-latency-hotfix-20260707\dist\9BizClaw Setup 2.4.23.exe`.
- 2026-07-08: `node scripts/check-obfuscation-residue.js` PASS sau khi restore obfuscation trong sandbox.

## Ghi chu build Windows

- Nen build tren o local thay vi o `O:` neu can tao vendor bundle, vi thao tac xoa/cai/pack `vendor/node_modules` co gan 100k entries va rat cham tren o mang.
- Lenh electron-builder chuan co the fail tren may khong co quyen symlink khi giai nen `winCodeSign`.
- De tao installer unsigned cho test noi bo tren may hien tai:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
node scripts\obfuscate.js
try {
  npx.cmd electron-builder --win --publish never --config.win.signAndEditExecutable=false --config.nsis.packElevateHelper=false
} finally {
  node scripts\obfuscate.js --restore
}
node scripts\fix-artifact-name.js
node scripts\check-bundle-size.js --strict
```

- Neu can installer co ky/chinh metadata day du, can chay build tren moi truong co Developer Mode hoac quyen tao symlink.
