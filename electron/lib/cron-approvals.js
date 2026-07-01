'use strict';
// cron-approvals.js — single-use, fingerprinted, expiring approval nonces.
//
// This is the gate that turns a CEO "chạy đi" into a money-spending action EXACTLY
// once: a preview call issues a nonce bound to a fingerprint of the action; the
// follow-up call must present that nonce AND describe the same action, or it's
// refused. Pure logic over a caller-owned Map, so the money gate is unit-testable
// without booting the cron-api server (see electron/tests/cron-approvals.test.js).
//
// Anti-feature: the older /api/fb/post and /api/fb/post-video gates predate this and
// keep their own inline copies of this pattern. They are production-proven and NOT
// rewired here (surgical) — this module is used by /api/fb/ads/activate and is the
// home for any future consolidation.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min — matches the inline gates

// Issue a nonce bound to `fingerprint`, store it in `map`, return {nonce, expiresAt}.
// `nowMs` is injectable so tests can pin time deterministically.
function issueApproval(map, fingerprint, ttlMs = DEFAULT_TTL_MS, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const nonce = crypto.randomBytes(18).toString('hex');
  const expiresAt = now + ttlMs;
  map.set(nonce, { fingerprint, expiresAt });
  return { nonce, expiresAt };
}

// Consume a nonce. Succeeds (and deletes it — single use) ONLY if it exists, hasn't
// expired, AND its fingerprint matches the action being performed. A wrong-fingerprint
// attempt (e.g. a nonce issued for objectId A used to activate objectId B) is refused
// and does NOT burn the nonce, so the legitimate action can still proceed.
function consumeApproval(map, nonce, fingerprint, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const key = nonce ? String(nonce) : '';
  const entry = key ? map.get(key) : null;
  if (!entry || entry.expiresAt <= now || entry.fingerprint !== fingerprint) {
    return { ok: false };
  }
  map.delete(key); // single-use
  return { ok: true };
}

module.exports = { issueApproval, consumeApproval, DEFAULT_TTL_MS };
