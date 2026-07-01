'use strict';

// Pending store for CEO-confirmed verbatim Zalo crons (2026-06-07 guarantee).
//
// A fixed-`content` cron is PARKED here by /api/cron/create and written to disk
// only after the CEO confirms the exact text on Telegram. Holding the intent in
// a pure, side-effect-free module keeps the confirm flow unit-testable without
// booting the HTTP server (which would fire a real Telegram preview). cron-api.js
// owns the actual disk write — it needs the custom-cron write-lock; this module
// only remembers intent, hands it out by a short confirm CODE, and classifies the
// CEO's reply.
//
// CODE BINDING: each pending carries a 6-char code (prefix of its hex nonce) shown
// in the preview. The CEO confirms a SPECIFIC code, so a second parked entry can't
// be substituted for the one they previewed (bait-and-switch), and `take()` claims
// it atomically so a duplicated "ĐĂNG" can't double-write. 6 hex (16.7M space) keeps
// the collision odds negligible across the MAX live slots (vs 65k at 4 — the code
// exists precisely to prevent mis-routing, so don't shrink it back).
//
// Anti-feature: no persistence across restart. Pending intents are deliberately
// in-memory — a 30-min TTL means a crashed/restarted app simply forgets an
// unconfirmed post (the CEO re-issues it), which is safer than reviving a stale
// approval after the process died.

const TTL_MS = 30 * 60 * 1000;
const MAX = 50;
const CODE_LEN = 6; // hex chars of the confirm code (16.7M space — collision-negligible)

const _pending = new Map(); // nonce -> { ...spec, createdAtMs }

const codeOf = (nonce) => String(nonce).slice(0, CODE_LEN); // short confirm code shown to the CEO

function cleanup(now = Date.now()) {
  for (const [nonce, e] of _pending.entries()) {
    if (!e || (now - e.createdAtMs) > TTL_MS) _pending.delete(nonce);
  }
  while (_pending.size > MAX) {
    const oldest = _pending.keys().next().value;
    if (oldest === undefined) break;
    _pending.delete(oldest);
  }
}

function park(nonce, spec, now = Date.now()) {
  cleanup(now);
  _pending.set(String(nonce), { ...spec, createdAtMs: now });
  return String(nonce);
}

// All live (non-expired) pendings, newest-first, each tagged with its code.
function pending(now = Date.now()) {
  cleanup(now);
  const out = [];
  for (const [nonce, e] of _pending.entries()) out.push({ nonce, code: codeOf(nonce), ...e });
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// Atomically claim a pending by nonce (returns it AND removes it, or null).
// Synchronous Map ops → a duplicated "ĐĂNG" finds nothing on the second call,
// so the cron is written at most once.
function take(nonce) {
  const key = String(nonce);
  const e = _pending.get(key);
  if (!e) return null;
  _pending.delete(key);
  return { nonce: key, code: codeOf(key), ...e };
}

function size() { return _pending.size; }
function clear() { _pending.clear(); } // test-only reset

// CEO reply → { cmd: 'confirm'|'cancel'|'unhandled', code: '<6hex>'|null }.
// A trailing 6-hex token is taken as the confirm code (binds approval to the
// exact pending the CEO saw). "ok" is deliberately NOT a confirm word — it's
// reserved for the Facebook approval flow so the agent can route the two without
// ambiguity. Matches both diacritic and plain forms.
function classifyCommand(text) {
  let norm = String(text || '').trim().normalize('NFC').toLowerCase();
  let code = null;
  const m = norm.match(/\b([0-9a-f]{6})$/);
  if (m) { code = m[1]; norm = norm.slice(0, m.index).trim(); }
  if (/^(đăng|đăng đi|đăng nhóm|đăng luôn|đăng bài|đăng ngay|duyệt|xác nhận|dang|dang di|dang nhom|dang luon|dang bai|dang ngay|duyet|xac nhan)$/i.test(norm)) return { cmd: 'confirm', code };
  if (/^(bỏ|hủy|huỷ|không đăng|đừng đăng|hủy đăng|bo|huy|khong dang|dung dang|huy dang)$/i.test(norm)) return { cmd: 'cancel', code };
  return { cmd: 'unhandled', code: null };
}

module.exports = { park, pending, take, cleanup, size, clear, classifyCommand, codeOf, TTL_MS, MAX, CODE_LEN };
