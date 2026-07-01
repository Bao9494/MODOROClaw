'use strict';

// Guard against an agent/workflow-intent prompt being stored or sent as a
// fixed-text Zalo cron `content`.
//
// A fixed cron sends `content` VERBATIM to a customer group (cron-api.js builds
// `exec: openzca msg send <id> "<content>" --group`; cron.js runSafeExecCommand
// delivers it as-is). Agent-mode crons instead run the AI and deliver its
// generated reply. On 2026-06-07 a self-perpetuating "[WORKFLOW] mỗi ngày tạo 1
// bài viết… tạo 1 cron one-time mới cho ngày hôm sau…" prompt was stored as
// fixed `content` and posted verbatim into the PREMIUM Club group instead of
// running the agent. Such prompts are orchestration instructions, never
// customer-facing text — refuse them at create time and at fire time and force
// mode=agent. (Doctrine: code-level guard at the pipeline point — LLM rules
// alone are unreliable.)
//
// IMPORTANT: only apply this to the FIXED `content` path. Agent-mode prompts
// legitimately contain [WORKFLOW], web_fetch, /api/ and mediaId references.

// Internal orchestration tags — must never reach a customer. High-precision.
// `[^\]]*` is OUTSIDE the alternation so a tag WITH content also matches
// (`[WORKFLOW: post]`, `[AUTO-MODE v2]`), not just the bare `[WORKFLOW]`.
const AGENT_MARKERS = /\[\s*(?:WORKFLOW|AUTO-?MODE|SKILL)[^\]]*\]/i;

// Internal infra / orchestration strings that NEVER appear in a real Zalo post —
// shared by both the input guard and the (tighter) output verifier. Anchored on
// literal tokens (web_fetch, an internal endpoint, mode=agent, cronExpr=…) so a
// normal customer message can't trip them.
const INFRA_LEAK = [
  /\bweb_fetch\b/i,
  /\/api\/(?:cron|zalo|fb|media|memory|google|image)\b/i,
  /127\.0\.0\.1:20200/,
  /\bmode\s*=\s*agent\b/i,
  /\boneTimeAt\b/i,
  /\bcron(?:Expr|_expr)\s*[=:]/i,
];

// Input guard for fixed `content` about to be posted VERBATIM: infra + broader
// cron phrasing. In a fixed post the literal word "cron" is never legitimate, so
// "tạo … cron" / "cron … one-time" are safe to flag. We deliberately do NOT match
// bare "tạo lịch kế tiếp" (ambiguous with a real promo "tạo lịch kế tiếp: giảm
// giá") — the workflow case always also carries "cron" or a tag.
const AUTOMATION_PHRASES = [
  ...INFRA_LEAK,
  /\bcron\b[^\n]{0,20}one-?time\b/i,
  /\bt[ạa]o\b[^\n]{0,30}\bcron\b/i,   // Vietnamese (with/without dấu): "tạo … cron"
];

// A workspace media FILE PATH posted verbatim = a build mistake: the bot meant to
// SEND the image (mode=agent + mediaId), not paste its path as text. A customer
// must never receive "brand-assets/generated/img_x.png". High-precision: a local
// media-dir prefix (brand-assets/ | outputs/) + a media extension — never present
// in a real customer post, and excludes external image URLs (no http match). The
// skill has a written warning for this; it has failed in the wild → code guard.
const FILE_PATH_CONTENT = /\b(?:brand-assets|media-assets|outputs)[\/\\]\S*\.(?:png|jpe?g|webp|gif|bmp|svg|mp4|mov|avi|webm|pdf)\b/i;

/**
 * @param {string} text candidate fixed-content text
 * @returns {{reason: string}|null} non-null when the text looks like an
 *   agent/workflow prompt OR a local file path that must NOT be sent verbatim.
 */
function detectAgentPromptAsContent(text) {
  // NFC so composed/decomposed Vietnamese diacritics (tạo) match identically.
  const s = String(text || '').normalize('NFC');
  if (!s) return null;
  if (AGENT_MARKERS.test(s)) return { reason: 'agent-marker' };
  if (FILE_PATH_CONTENT.test(s)) return { reason: 'file-path' };
  for (const re of AUTOMATION_PHRASES) {
    if (re.test(s)) return { reason: 'automation-phrase' };
  }
  return null;
}

// Output-side verifier for AGENT-GENERATED text about to be delivered to a Zalo
// customer (the #5 layer). Deliberately TIGHTER than detectAgentPromptAsContent:
// tags + infra ONLY — NOT bare "cron"/"tạo lịch", because a legitimate generated
// article about automation/workflows CAN say those words; only an echoed prompt
// (cron.js prepends [AUTO-MODE]) or leaked meta-text carries a tag/endpoint.
function detectOrchestrationLeak(text) {
  const s = String(text || '').normalize('NFC');
  if (!s) return null;
  if (AGENT_MARKERS.test(s)) return { reason: 'orchestration-leak' };
  for (const re of INFRA_LEAK) if (re.test(s)) return { reason: 'orchestration-leak' };
  return null;
}

module.exports = { detectAgentPromptAsContent, detectOrchestrationLeak };
