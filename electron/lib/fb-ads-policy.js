'use strict';
// fb-ads-policy.js — code-level guard + money math for the FB Ads backend.
//
// WHY a code-level guard (not an LLM rule): VN ad accounts get banned for policy
// wording, and the model forgets diacritics-sensitive banned phrases under load.
// Per the project doctrine (rule-injection-at-code-level), the create/update
// endpoints call screenAdCopy() BEFORE any text reaches the Graph API and refuse
// RED copy — so a jailbroken or sloppy agent still cannot push a banning phrase.
//
// WHY the money math lives here too: setting a budget is the one place a wrong unit
// burns the CEO's money. The Graph API takes a budget in the account currency's MINOR
// unit: VND offset 1 (whole đồng — VERIFIED LIVE 2026-06-15: min_daily_budget=26507 ≈ $1;
// if the API wanted ×100 the min would read 2,650,700), USD offset 100 (cents). toApiAmount
// applies the right offset per currency; only VND + USD are allowed (verified offsets) —
// see unsupportedCurrencyError. clampDailyBudget() also refuses sub-minimum budgets.
//
// Pure functions, no I/O, no network — fully unit-testable (see
// electron/tests/fb-ads-policy.test.js). Mirrors the offline advisor copy at
// skills/marketing/facebook-ads-advisor/check-ad-copy.js; THIS module is the
// authoritative guard for the write path.

// RED = absolute claims / personal-attribute / banned-vertical wording that gets
// VN accounts limited or ads rejected. Matched on lowercased text (diacritics kept).
const RED = [
  '100%', '100 %', 'cam kết', 'cam kêt', 'chắc chắn', 'tuyệt đối', 'đảm bảo',
  'trị dứt điểm', 'dứt điểm', 'chữa khỏi', 'khỏi hẳn', 'khỏi 100', 'hết hẳn',
  'an toàn tuyệt đối', 'không tác dụng phụ', 'không có tác dụng phụ',
  'tốt nhất', 'số 1', 'số một', '#1', 'duy nhất', 'hiệu quả nhất', 'rẻ nhất',
  'bạn béo', 'bạn mập', 'bạn xấu', 'bạn bị bệnh', 'hôi miệng', 'bạn có bị',
  'lợi nhuận mỗi ngày', 'lãi suất cao nhất', 'không rủi ro', 'x2 tài khoản',
];
// YELLOW = restricted verticals / before-after / claims needing care or the right
// special_ad_category. Not auto-reject, but surfaced to the CEO.
const YELLOW = [
  'giảm cân', 'giảm béo', 'giảm mỡ', 'giảm số đo',
  'trị mụn', 'trị nám', 'trị sẹo', 'trắng da', 'trẻ hóa',
  'trước và sau', 'trước - sau', 'before after', 'before-after',
  'vay tiền', 'tín dụng', 'trả góp', 'việc làm lương cao', 'tuyển dụng',
  'collagen', 'tăng cân', 'sinh lý', 'thực phẩm chức năng', 'tpcn',
];

function screenAdCopy(text) {
  const t = String(text || '').toLowerCase();
  const hit = (list) => list.filter((w) => t.includes(w));
  const red = hit(RED);
  const yellow = hit(YELLOW);
  return { ok: red.length === 0 && yellow.length === 0, red, yellow };
}

// Graph-API currency offset = how many minor units in one human unit of the account
// currency. VND has no subunit → offset 1 (whole đồng, verified LIVE 2026-06-15);
// USD bills in cents → offset 100. ONLY currencies with a verified offset are allowed
// (see unsupportedCurrencyError): a wrong offset posts ~offset× the budget = burned money.
const CURRENCY_OFFSET = { VND: 1, USD: 100 };
const VND_OFFSET = CURRENCY_OFFSET.VND; // kept: existing callers/tests reference it

function offsetFor(currency) {
  const off = CURRENCY_OFFSET[String(currency || '').toUpperCase()];
  if (!off) throw new Error(`Tiền tệ ${currency} không được hỗ trợ (chưa có offset đã kiểm chứng)`);
  return off;
}

// Convert a human budget (đồng for VND, dollars for USD) to the Graph API minor-unit
// integer (đồng ×1, cents ×100). Integer only (the API rejects decimals). Throws on
// non-positive / non-finite input or an unsupported currency.
function toApiAmount(amount, currency = 'VND') {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Ngân sách phải là số dương');
  return Math.round(n * offsetFor(currency));
}
function vndToApiAmount(vnd) { return toApiAmount(vnd, 'VND'); } // back-compat alias

// CEO-facing money string: VND → "300.000đ", USD → "$20". Used in floor/confirm messages.
function formatMoney(amount, currency = 'VND') {
  const n = Math.round((Number(amount) || 0) * 100) / 100;
  return String(currency).toUpperCase() === 'USD'
    ? '$' + n.toLocaleString('en-US')
    : n.toLocaleString('vi-VN') + 'đ';
}

// FB hard minimum/day per currency (~$1), in HUMAN units (đồng / dollars). DISTINCT
// from VN_RECOMMENDED_FLOOR (the much higher learning-phase START budget): same "floor"
// word, different number, different purpose — don't sync them.
const DAILY_FLOOR = { VND: 26000, USD: 1 };
const VN_DAILY_FLOOR = DAILY_FLOOR.VND; // back-compat export

// Refuse a daily budget below the account's FB minimum. minDailyMinor is read live from
// GET /act_<id>?fields=min_daily_budget — in the currency's MINOR unit (cents for USD,
// đồng for VND). Falls back to DAILY_FLOOR. Returns { ok, value (human, rounded to the
// currency precision), apiAmount (minor unit the Graph API receives), floor (human), error }.
function clampDailyBudget(amount, minDailyMinor, currency = 'VND') {
  const cur = String(currency || 'VND').toUpperCase();
  const offset = offsetFor(cur);
  const n = Number(amount) || 0;
  const apiAmount = n > 0 ? Math.round(n * offset) : 0;             // minor unit, integer
  const value = apiAmount / offset;                                 // human unit at currency precision
  const floorMinor = Math.max(Math.round(Number(minDailyMinor) || 0), DAILY_FLOOR[cur] * offset);
  if (apiAmount < floorMinor) {
    const floor = floorMinor / offset;
    return { ok: false, floor, error: `Ngân sách/ngày tối thiểu là ${formatMoney(floor, cur)} (Facebook đặt cho tài khoản này).` };
  }
  return { ok: true, value, apiAmount };
}
function clampDailyBudgetVnd(vnd, minDaily) { return clampDailyBudget(vnd, minDaily, 'VND'); } // back-compat

// A daily budget at/above this is "large" — the budget-change confirm message shouts an
// extra warning to re-check the number. This is NOT the gate (every /budget change is
// confirmed regardless — CEO doctrine "thà confirm 2 lần còn hơn"); it only decides how loud
// the preview warning is, so a mis-parsed "5 triệu" is impossible to miss before confirming.
const CONFIRM_CEILING = { VND: 1000000, USD: 40 }; // 1tr đồng ≈ $40/ngày
const VN_DAILY_CONFIRM_CEILING = CONFIRM_CEILING.VND; // back-compat export
function isLargeBudget(amount, currency = 'VND') {
  const ceiling = CONFIRM_CEILING[String(currency || 'VND').toUpperCase()] || CONFIRM_CEILING.VND;
  return (Number(amount) || 0) >= ceiling;
}

// breakeven ROAS = revenue/adspend so ad cost = gross profit = 1/margin.
// target adds a ~30% buffer for shipping/refund/CS (rule-of-thumb, CEO tunes).
function roas(price, cost) {
  price = Number(price); cost = Number(cost);
  if (!(price > 0) || !(cost >= 0) || cost >= price) {
    return { error: 'price phải > cost >= 0' };
  }
  const marginPct = (price - cost) / price;
  const breakeven = price / (price - cost);
  return {
    margin_pct: Math.round(marginPct * 1000) / 10,
    breakeven_roas: Math.round(breakeven * 100) / 100,
    target_roas: Math.round(breakeven * 1.3 * 100) / 100,
  };
}

// Recommended START budget for lead/conversion in VN — below this the algorithm
// struggles to exit learning even if cpa*50/7 is lower. NOT the FB hard minimum
// (that's VN_DAILY_FLOOR=26000). Mirrored in skills/.../check-ad-copy.js.
const VN_RECOMMENDED_FLOOR = 300000;
// Min daily to clear learning phase (~50 conversions/week ⇒ cpa*50/7), floored at
// the recommended start above.
function suggestDailyBudget(cpa) {
  cpa = Number(cpa);
  const learning = cpa > 0 ? Math.ceil((cpa * 50) / 7) : null;
  const recommended = Math.max(learning || 0, VN_RECOMMENDED_FLOOR);
  return { min_learning_daily: learning, recommended_start_daily: recommended };
}

// Allow ONLY currencies with a VERIFIED offset (VND=1, USD=100). The budget math is
// correct for these two; any other currency has an unverified offset, so a budget could
// post ~offset× off = burned money. Refuse at connect/use-account (the two write paths
// that activate an account). Returns null when allowed, else a Vietnamese error string.
function unsupportedCurrencyError(currency) {
  if (CURRENCY_OFFSET[String(currency || '').toUpperCase()]) return null;
  return `Tài khoản quảng cáo này dùng ${currency} — công cụ hiện chỉ hỗ trợ tài khoản VND (đồng) hoặc USD. Anh/chị chọn tài khoản VND hoặc USD giúp em ạ.`;
}

// Targeting defaults + Meta's allowed custom-location radius bounds (named, not bare
// literals, so the contract is documented at one place).
const DEFAULT_AGE_MIN = 18;
const DEFAULT_AGE_MAX = 65;
const DEFAULT_RADIUS_KM = 5;
const META_RADIUS_MIN_KM = 1;  // Facebook rejects a custom-location radius outside 1–80 km
const META_RADIUS_MAX_KM = 80;

// Build a Meta targeting spec from simple params so the agent doesn't hand-write the
// JSON for the common VN cases. Returns the object passed to createAdSet's `targeting`.
//   - default = broad VN, age 18-65 (the correct 2026 baseline: let Advantage+ optimize)
//   - gender: 'male'/'nam'/'1' → [1]; 'female'/'nữ'/'2' → [2]; anything else → all
//   - local shop: lat+lng (+radiusKm, default 5, clamped 1-80) → radius targeting, no country
//   - interests: array of interest IDs (from /api/fb/ads/targeting-search) → flexible_spec
// Pure — no I/O. Unit-tested in fb-ads-policy.test.js.
function buildTargeting(opts = {}) {
  const t = { age_min: Number(opts.ageMin) || DEFAULT_AGE_MIN, age_max: Number(opts.ageMax) || DEFAULT_AGE_MAX };

  const g = String(opts.gender || '').toLowerCase();
  if (['male', 'nam', '1', 'm'].includes(g)) t.genders = [1];
  else if (['female', 'nu', 'nữ', '2', 'f'].includes(g)) t.genders = [2];

  const lat = Number(opts.lat), lng = Number(opts.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (hasPoint) {
    const radius = Math.min(Math.max(Number(opts.radiusKm) || DEFAULT_RADIUS_KM, META_RADIUS_MIN_KM), META_RADIUS_MAX_KM);
    t.geo_locations = { custom_locations: [{ latitude: lat, longitude: lng, radius, distance_unit: 'kilometer' }] };
  } else {
    const list = opts.countries
      ? (Array.isArray(opts.countries) ? opts.countries : String(opts.countries).split(','))
      : ['VN'];
    const countries = list.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    t.geo_locations = { countries: countries.length ? countries : ['VN'] };
  }

  let ids = opts.interests;
  if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = ids.split(',').map((s) => s.trim()).filter(Boolean); } }
  if (Array.isArray(ids) && ids.length) {
    t.flexible_spec = [{ interests: ids.map((x) => (x && typeof x === 'object' ? x : { id: String(x) })) }];
  }
  return t;
}

module.exports = {
  screenAdCopy, RED, YELLOW,
  CURRENCY_OFFSET, VND_OFFSET, offsetFor, toApiAmount, vndToApiAmount, formatMoney,
  DAILY_FLOOR, VN_DAILY_FLOOR, clampDailyBudget, clampDailyBudgetVnd,
  CONFIRM_CEILING, VN_DAILY_CONFIRM_CEILING, isLargeBudget,
  roas, suggestDailyBudget, VN_RECOMMENDED_FLOOR,
  buildTargeting,
  unsupportedCurrencyError,
};
