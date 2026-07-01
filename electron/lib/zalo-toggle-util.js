'use strict';
// Pure helpers for the Zalo per-entity toggle routes (group-toggle / friend-toggle).
// No fs / electron deps so guards can unit-test them directly.
//
// CRITICAL invariant (verified 2026-06 vs modoro-zalo inbound.ts):
//   - Friend ON/OFF (curation) is `zalo-allowlist.json` (decideZaloDmAllowlist) — the
//     INBOUND gate for whether the bot serves a given friend.
//   - `zalo-blocklist.json` is a SEPARATE, harder block: enforced INBOUND by a
//     code-guard in modoro-zalo inbound.ts (drops the sender before the AI) AND
//     OUTBOUND in channels.js. So friend on/off goes through the allowlist; the
//     blocklist is a stronger "never talk to this person" on top.
//   - An EMPTY allowlist means "reply to everyone" when stranger-policy != 'ignore'
//     (backwards-compat). So removing the last entry must collapse to the `['__NONE__']`
//     deny-all sentinel, NOT to `[]` — otherwise "tắt bạn" leaks the gate wide open.

// Parse a toggle direction into true (bật) / false (tắt) / null (invalid).
function parseToggleOn(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(s)) return true;
  if (['false', '0', 'off', 'no'].includes(s)) return false;
  return null;
}

// Apply a friend ON/OFF toggle to the DM allowlist — mirrors the Dashboard's
// toggleUserReply exactly. Strips the `__NONE__` sentinel for manipulation, then
// re-applies `['__NONE__']` when the result is empty (deny-all), so "tắt" can never
// collapse to empty = allow-all.
function applyFriendAllowlistToggle(allowlist, uid, on) {
  const id = String(uid || '').trim();
  const real = (Array.isArray(allowlist) ? allowlist : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .filter((x) => x !== '__NONE__');
  const i = real.indexOf(id);
  if (on) {
    if (id && i === -1) real.push(id);
  } else if (i !== -1) {
    real.splice(i, 1);
  }
  return real.length > 0 ? real : ['__NONE__'];
}

module.exports = { parseToggleOn, applyFriendAllowlistToggle };
