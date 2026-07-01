'use strict';

// Single source of truth for aivideoauto.com subscription plans (MEMBER_PLAN_AI),
// DECLARED by the CEO in the Dashboard — because the Gommo API exposes no readable
// plan field. (Verified 2026-06-22: /me carries no plan key, /ai/models is global
// regardless of plan, and the buy-time plan_id is opaque + write-only.)
//
// This catalog is ADVISORY: it steers which models the bot proposes and what the
// Dashboard shows. It NEVER hard-blocks generation — Gommo enforces entitlement
// server-side at submit, so a stale list here can't wrongly refuse a valid
// subscriber (the exact bug we are fixing).
//
// `models` are the FRIENDLY names from the pricing page (the bot matches them
// against the LIVE /models catalog at runtime). We deliberately do NOT store raw
// catalog ids — those drift; the friendly names on the pricing page are stable.

const PLANS = [
  { key: 'mini',             label: 'Mini (Video)',          models: ['VEO 3.1', 'Grok Heavy'] },
  { key: 'starter',          label: 'Starter (Video)',       models: ['VEO 3.1', 'Grok Heavy'] },
  { key: 'unlimited_flex',   label: 'Unlimited - Flex',      models: ['Kling 2.5', 'Hailuo 2.3'] },
  { key: 'seedance2_combo1', label: 'Seedance 2 - Combo 1',  models: ['Seedance 2.0 Omni', 'Seedance 2.0'] },
];

const _byKey = new Map(PLANS.map(p => [p.key, p]));

function isValidKey(k) { return _byKey.has(k); }

// Keep only the recognized keys from a (possibly stale/garbage) declared list.
function sanitizeKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const seen = new Set();
  return keys.filter(k => isValidKey(k) && !seen.has(k) && seen.add(k));
}

// Union of friendly model names across the declared plans — the bot hint.
function declaredModelNames(keys) {
  const out = [];
  const seen = new Set();
  for (const k of sanitizeKeys(keys)) {
    for (const m of _byKey.get(k).models) if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
}

module.exports = { PLANS, isValidKey, sanitizeKeys, declaredModelNames };
