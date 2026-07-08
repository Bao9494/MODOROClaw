# Plan: Telegram Zalo-Parity Hardening

## Muc tieu

Lam Telegram tro thanh kenh uu tien va co kien truc gan voi Zalo: tra chat/group theo ten, gui dung Telegram target, gan role/memory theo tung conversation, va tao lich nhac Telegram khong bi roi ve Zalo/default chat.

## Pham vi

- Worktree: `O:\project\MODOROClaw-latency-hotfix-20260707`
- Branch: `runtime-latency-hotfix-20260707`
- Khong sua license/key.
- Khong viet provider Telegram moi; chi harden tren cache/API/runtime hien co.

## Cach lam

1. Them lookup Telegram conversation theo ten/role/type/enabled.
2. Them API local `/api/telegram/conversations`, `/api/telegram/seed`, `/api/telegram/profile`, `/api/telegram/send`.
3. Cho `sendTelegramPhoto` nhan `targetChatId`.
4. Cho cron fixed Telegram tao `exec: telegram msg send <chatId> "<text>"` va runner xu ly nhu safe exec.
5. Cho cron agent luu `telegramTarget` khi CEO chi dinh group Telegram theo ten/ID.
6. Cho appointment push target Telegram ton trong `toId` la `targetChatId`.
7. Cap nhat `AGENTS.md`, `MEMORY.md`, `skills/operations/telegram-ceo.md`, `skills/appointments.md`.
8. Them guard vao `check-telegram-memory-contract.js`.
9. Them collector doc/session OpenClaw de Telegram group/private co the resolve theo ten neu provider cache chua du giau.
10. Fix one-time cron > 24 ngay khong bi `setTimeout` 32-bit overflow va khong fire ngay.
11. Fix boot session pre-warm trong `gateway.js` bi thieu import.
12. Fix latency lookup ID Telegram: neu CEO hoi "tim ID nhom/chat/kênh Telegram", BOT phai tra qua `/api/telegram/conversations` hoac fast-path runtime, khong quet de quy `%APPDATA%\9bizclaw`.

## Ket qua kiem tra

- `node --check` PASS cho:
  - `electron/lib/telegram-memory.js`
  - `electron/lib/channels.js`
  - `electron/lib/cron-api.js`
  - `electron/lib/cron.js`
  - `electron/lib/appointments.js`
  - `electron/scripts/check-telegram-memory-contract.js`
- `node electron/scripts/check-telegram-memory-contract.js` PASS static/API guards.
- Runtime DB filtering trong guard bi skip o source clone vi `better-sqlite3` native binding dang build cho Node ABI khac; can kiem lai trong sandbox/app packaged co dung ABI.
- Sandbox local `C:\Users\bao.nguyen\AppData\Local\Temp\9bizclaw-build-latency-hotfix-20260707\electron`: `npm.cmd run smoke` PASS sau khi sync thay doi.
- Source worktree `electron`: `npm.cmd run smoke` ngay sau rebuild runtime FAIL 3 vendor sentinel vi `electron/vendor` thieu `vendor/node_modules/9router/package.json` va `vendor/node_modules/modoro-zalo/openclaw.plugin.json`; module contracts/RAG/API/security checks trong smoke da PASS truoc khi fail. Runtime packaged van PASS preflight vi dung vendor o `%APPDATA%\9bizclaw\vendor`.
- Build unsigned PASS bang `electron-builder --win --publish never --config.win.signAndEditExecutable=false --config.nsis.packElevateHelper=false`.
- `node scripts/check-obfuscation-residue.js` PASS.
- `node scripts/check-bundle-size.js --strict` PASS.
- Artifact: `O:\project\9bizclaw\artifacts\9BizClaw Setup 2.4.23-telegram-parity-unsigned-20260708.exe`
- SHA256: `807D7BC048B0E0C481E42DCE00EDEBA3F96D16A08F400EE62D6B67185965DDCC`
- Runtime install PASS tu `dist\win-unpacked` vao `C:\Users\bao.nguyen\AppData\Local\Programs\9bizclaw`.
- Runtime preflight PASS: license valid, `better-sqlite3` loads OK, 9Router `/v1/models` co 36 models, gateway `:18789` status 200.
- Telegram lookup PASS:
  - `LLK` -> `-1003857797941`, label `LLK Agency (GMT +7) - LLK-999999`, role `internal`, source `openclaw-sessions,profile,settings`.
  - `NovaTria` -> `8492277411`, role `internal`.
  - `8406640669` -> `CEO Telegram`, role `ceo`.
- Telegram profile PASS cho `-1003857797941`: `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw\memory\telegram-chats\-1003857797941.md`.
- One-time cron long-delay PASS: test cron 30 ngay log `next check 86400s`, khong co `TimeoutOverflowWarning`, khong co `firing`, da xoa test cron.
- Boot session pre-warm PASS: log `[boot] session pre-warm OK`.
- 9Router direct completion PASS: `model=main` tra choices trong khoang 1.5s.
- Provider error fix PASS: loi `LLM request failed: provider rejected the request schema or tool payload` co raw error `The 'gpt-5.2' model is not supported when using Codex with a ChatGPT account`; da backup `9router\db\data.sqlite`, doi combo `zalo` thanh `["cx/gpt-5.4","cx/gpt-5.5"]`, va test `model=zalo` tra `pong` qua `gpt-5.4`.
- SQLite ABI fix PASS: `ensure9RouterZaloCombo()` khong require `better-sqlite3` truc tiep trong Electron nua; repair SQLite duoc chay qua vendor Node de khop native ABI.
- OpenClaw agent PASS sau fix: `openclaw agent --agent main --message ... --json` exit 0, provider `ninerouter`, model `zalo`, reply `OK`.
- Runtime config restore PASS: strip UTF-8 BOM khoi `C:\Users\bao.nguyen\.openclaw\openclaw.json` sau khi preflight backup nham thanh `.corrupt`; gateway/Telegram doc lai du config.
- Cron session fix PASS: sau restart `sessions.list` chi co `agent:main:main` voi deliveryContext Telegram CEO, nen `getCeoSessionKey()` da doi sang dung session prewarm nay thay vi direct session sinh lazy de tranh `session not found`.
- Telegram ID lookup latency RCA/PASS:
  - Log `openclaw.log`: message 628 dispatch `11:34:58` -> `11:38:36`, elapsed `218489ms`.
  - Session JSONL: agent goi `rg` tren `C:\Users\bao.nguyen\AppData\Roaming\9bizclaw`; tool duration `196752ms`, exit 1 do dung file cache/LOCK.
  - Runtime/source `skills/operations/telegram-ceo.md` da them quy tac dung `/api/telegram/conversations`, khong dung `rg/search_files/list_files` cho Telegram ID lookup.
  - Runtime OpenClaw vendor da co marker `20260708-fast-telegram-id-lookup-v1`.
  - Sau restart, `/api/telegram/conversations?name=LLK Agency...` tra `-1003857797941` trong `345ms`; 9Router `model=zalo` tra `pong` trong `3301ms`.
  - Test thuc te sau do: message 632/634 di fast-path, lookup marker xuat hien sau `5-53ms`, dispatch ket thuc `2327-2454ms` gom ca Telegram send.
- Runtime disk-full recovery PASS:
  - Sau test fast-path, o C bi `0GB` trong, gay `ENOSPC` khi Brain/Zalo/session store ghi file.
  - Da offload mot phan build artifact cu sang `O:\project\9bizclaw\backups\offloaded-temp-20260708-135024` va xoa 2 thu muc temp build/check cu `MODOROClaw-build-main`, `MODOROClaw-vendor-check`.
  - O C tang len khoang `14.76GB` trong; test ghi/xoa file nho trong `.openclaw\agents\main\sessions` va `%APPDATA%\9bizclaw` PASS.
  - Sau cleanup: gateway `18789` status `200`, Telegram lookup `-1003857797941` trong `346ms`, 9Router `model=zalo` tra `pong` trong `3598ms`.
- Zalo runtime khong crash nhung dang `ready:false`, reason `disabled` vi Dashboard dang tat Zalo.
- Residual risk: cron API dang nghe ca `20200` va `20201` trong cung process; chua sua sau vi app dang on dinh va route chinh van dung.

## Trang thai

- 2026-07-08: Da hoan thanh code + instruction-memory + guard.
- 2026-07-08: Da cap nhat docs/system map, smoke sandbox PASS, unsigned installer da build va copy ve artifacts.
- 2026-07-08: Da cai runtime moi, fix scheduler/pre-warm, verify Telegram/Zalo/Router/Gateway/Cron API. Merge/commit pending.
