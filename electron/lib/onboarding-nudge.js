'use strict';
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('./workspace');
const { probeTelegramReady, probeZaloReady, sendCeoAlert } = require('./channels');
const { auditLog } = require('./workspace');
const mediaLibrary = require('./media-library');

let _nudgeTimerId = null;
let _isRunning = false;

const STATE_FILE = 'premium-onboarding.json';
const MAX_DAYS = 7;

// ─── State schema ─────────────────────────────────────────────────────────────
// {
//   startedAt: "2026-06-01T..."  ← wizard-complete timestamp
//   sentDays: [2, 4]            ← days (1-based) already sent
//   currentDay: 3,               ← current onboarding day (1-7, default 1)
//   dismissed: false,           ← if true, hide dashboard card + skip nudges
//   lastCheckedAt: "2026-06-02T..."
// }

function _getStatePath() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, STATE_FILE);
}

function _readState() {
  try {
    const p = _getStatePath();
    if (!p) return null;
    if (!fs.existsSync(p)) {
      const oldPath = path.join(path.dirname(p), 'onboarding-state.json');
      if (fs.existsSync(oldPath)) {
        try {
          const old = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
          const migrated = {
            startedAt: old.startedAt || new Date().toISOString(),
            sentDays: Array.isArray(old.sentDays) ? old.sentDays : [],
            currentDay: typeof old.currentDay === 'number' ? old.currentDay : 1,
            dismissed: !!old.dismissed,
            lastCheckedAt: new Date().toISOString(),
          };
          _writeState(migrated);
          fs.unlinkSync(oldPath);
          console.log('[onboarding-nudge] migrated state from onboarding-state.json → premium-onboarding.json');
          return migrated;
        } catch (e) {
          console.warn('[onboarding-nudge] old-state migration failed:', e?.message);
        }
      }
      return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function _writeState(state) {
  try {
    const p = _getStatePath();
    if (!p) return;
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[onboarding-nudge] state write error:', e?.message);
  }
}

function _initState() {
  const existing = _readState();
  if (existing) return existing;
  const state = {
    startedAt: new Date().toISOString(),
    sentDays: [],
    currentDay: 1,
    dismissed: false,
    lastCheckedAt: new Date().toISOString(),
  };
  _writeState(state);
  return state;
}

// ─── Setup-state detection ────────────────────────────────────────────────────

async function _detectSetupState() {
  const ws = getWorkspace();
  if (!ws) return {};

  const state = {
    telegramReady: false,
    zaloReady: false,
    hasKnowledge: false,
    hasProductImages: false,
  };

  // Channels
  try {
    const tg = await probeTelegramReady().catch(() => ({}));
    state.telegramReady = !!(tg && tg.ready);
  } catch {}
  try {
    const zl = await probeZaloReady().catch(() => ({}));
    state.zaloReady = !!(zl && zl.ready);
  } catch {}

  // Knowledge: any .md file in knowledge/<cat>/ other than index.md
  try {
    const kDir = path.join(ws, 'knowledge');
    if (fs.existsSync(kDir)) {
      for (const cat of ['cong-ty', 'san-pham', 'nhan-vien', 'framework', 'workflow']) {
        const catDir = path.join(kDir, cat);
        if (!fs.existsSync(catDir)) continue;
        const files = fs.readdirSync(catDir).filter(f => f !== 'index.md' && f.endsWith('.md'));
        if (files.length > 0) { state.hasKnowledge = true; break; }
      }
    }
  } catch {}

  // Product images: any product asset in the media library.
  try {
    const productAssets = mediaLibrary.listMediaAssets({ type: 'product', audience: 'ceo' });
    state.hasProductImages = productAssets.some(a => a && a.path && fs.existsSync(a.path));
  } catch {}

  return state;
}

// ─── Message content ──────────────────────────────────────────────────────────

function _buildMessage(day, setup) {
  const { telegramReady, zaloReady, hasKnowledge, hasProductImages } = setup;
  const tg = telegramReady ? 'Telegram ✓' : 'Telegram (chưa kết nối)';
  const zl = zaloReady ? 'Zalo ✓' : 'Zalo (chưa kết nối)';

  const lines = [];

  if (day === 1) {
    lines.push('Cài xong rồi ạ — từ giờ anh/chị cứ giao việc bằng tiếng Việt bình thường là được.');
    lines.push('');
    lines.push('Để anh/chị thấy rõ năng lực (và dùng được ngay), thử 3 bài test nhanh:');
    lines.push('');
    lines.push('1) Trả lời khách theo tài liệu (không bịa)');
    lines.push('   Dashboard > Tài liệu');
    lines.push('   Upload 1 file bảng giá/chính sách/FAQ → rồi nhắn em: “Khách hỏi giá sản phẩm X”');
    lines.push('');
    lines.push('2) Chọn đúng ảnh sản phẩm khi cần gửi');
    lines.push('   Dashboard > Nội dung > Tài sản hình ảnh > Hình ảnh sản phẩm > Upload');
    lines.push('   Upload vài ảnh + từ khóa → rồi nhắn em: “Gửi giúp anh ảnh sản phẩm X”');
    lines.push('');
    lines.push('3) Đăng bài Facebook (nếu đã kết nối Fanpage)');
    lines.push('   Dashboard > Facebook');
    lines.push('   Chỉ cần nhắn: “Đăng Facebook: <caption…>” (kèm ảnh nếu có)');
    lines.push('');
    lines.push('Ghi chú: phần gửi tin cho khách (Zalo/WhatsApp/…) trong chế độ thường sẽ luôn chờ anh/chị duyệt trước.');
  } else if (day === 2) {
    lines.push('Gợi ý nhỏ ngày 2 cho anh/chị.');
    lines.push('');
    if (!hasKnowledge) {
      lines.push('Muốn em trả lời khách chắc hơn, anh/chị vào Dashboard > Tài liệu để upload vài tài liệu cơ bản (bảng giá, chính sách, FAQ, thông tin sản phẩm). Có dữ liệu chuẩn thì em trả lời đúng hơn nhiều.');
    } else {
      lines.push('Knowledge đã có dữ liệu rồi ạ. Anh/chị có thể xem/điều chỉnh tại Dashboard > Tài liệu.');
    }
  } else if (day === 3) {
    lines.push('Ngày 3, anh/chị có thể bắt đầu dùng nhiệm vụ tự động.');
    lines.push('');
    lines.push('Đường dẫn: Dashboard > Nhiệm vụ tự động.');
    lines.push('');
    lines.push('Ví dụ anh/chị nhắn: "tạo cron gửi nhóm VIP mỗi sáng 8h: Chào buổi sáng, chúc cả nhà một ngày thuận lợi". Em sẽ tự đặt nhiệm vụ và gửi đúng giờ.');
    lines.push('');
    lines.push('Khi nào cần, anh/chị chỉ cần nói bằng câu bình thường là được.');
  } else if (day === 4) {
    if (!hasProductImages) {
      lines.push('Gợi ý ngày 4: thêm Hình ảnh sản phẩm cho em.');
      lines.push('');
      lines.push('Đường dẫn: Dashboard > Nội dung > Tài sản hình ảnh > Hình ảnh sản phẩm > Upload.');
      lines.push('');
      lines.push('Anh/chị upload ảnh thật và thêm vài từ khóa. Sau đó khi khách hỏi qua Zalo, WhatsApp hoặc Telegram, em có thể tự chọn đúng ảnh để gửi, không cần anh/chị lục thủ công.');
    } else {
      lines.push('Em thấy anh/chị đã có Hình ảnh sản phẩm rồi.');
      lines.push('');
      lines.push('Đường dẫn: Dashboard > Nội dung > Tài sản hình ảnh > Hình ảnh sản phẩm.');
      lines.push('');
      lines.push('Nếu muốn em chọn ảnh chính xác hơn nữa, anh/chị thêm vài tên gọi thay thế cho từng nhóm ảnh, ví dụ tên sản phẩm, màu, mã hàng, cách khách hay gọi ngoài đời.');
      lines.push('');
      lines.push('Tip thêm: logo/mascot nằm ở Dashboard > Nội dung > Tài sản hình ảnh > Tài sản thương hiệu > Upload.');
    }
  } else if (day === 5) {
    lines.push('Ngày 5, anh/chị thử cho em xử lý một tình huống thật nhé.');
    lines.push('');
    lines.push('Gợi ý nhanh: vào Dashboard > Zalo để xem bot có đang sẵn sàng nhận tin không.');
    lines.push('');
    lines.push('Anh/chị có thể nhờ một khách nhắn Zalo hỏi sản phẩm, hoặc gửi cho em một câu khách hay hỏi. Em sẽ trả lời dựa trên Knowledge và cách bán hàng của shop.');
  } else if (day === 6) {
    lines.push('Tóm tắt nhanh để anh/chị dễ nhớ em làm được gì.');
    lines.push('');
    lines.push('- Trả lời khách tự động trên Zalo');
    lines.push('- Soạn và gửi tin Zalo sau khi anh/chị duyệt');
    lines.push('- Tạo ảnh, viết caption, hỗ trợ đăng Facebook');
    lines.push('- Tạo nhiệm vụ gửi tự động');
    lines.push('- Làm báo giá, báo cáo Excel, file PDF');
    lines.push('- Ngồi cùng anh/chị như một trợ lý kinh doanh trên Telegram');
    lines.push('');
    lines.push('Đường dẫn hay dùng: Dashboard > Skills (dạy thêm quy trình), Dashboard > Tính cách (chỉnh giọng/độ chủ động).');
    lines.push('');
    lines.push('Anh/chị cứ giao việc bằng tiếng Việt bình thường, không cần nhớ câu lệnh.');
  } else if (day === 7) {
    lines.push('Hết tuần đầu rồi ạ.');
    lines.push('');
    lines.push('Nếu có phần nào cần tối ưu (giọng văn, cách tư vấn, mẫu câu bán hàng), anh/chị vào Dashboard > Tính cách để chỉnh.');
    lines.push('');
    lines.push('Khi cần kết nối hoặc đăng bài: Dashboard > Facebook.');
    lines.push('Khi cần kết nối Google Drive/Sheets/Docs: Dashboard > Google.');
    lines.push('');
    lines.push('Từ giờ nếu có việc lặp lại, việc mất thời gian, hoặc tin nhắn khách cần xử lý nhanh, anh/chị cứ giao cho em. Em sẽ giúp anh/chị giữ mọi thứ gọn và đều hơn mỗi ngày.');
  }

  return lines.join('\n');
}

// ─── Core nudge logic ─────────────────────────────────────────────────────────

function _computeDay(state) {
  const startedAt = new Date(state.startedAt);
  const now = new Date();
  const diffMs = now - startedAt;
  // Use Math.ceil so a partial day counts — e.g. started at 10:00, now is 09:00
  // next day (23h later) = still day 1, not day 2. A full 24h = day 2.
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.min(diffDays, MAX_DAYS));
}

async function _tick() {
  const state = _readState();
  if (!state) return;

  // Skip if dismissed
  if (state.dismissed) return;

  const todayDay = _computeDay(state);

  // Only tick on days 1-7
  if (todayDay < 1 || todayDay > MAX_DAYS) return;

  // Use currentDay from state (advance can skip ahead)
  const activeDay = state.currentDay || todayDay;

  // Already sent today
  if (state.sentDays && state.sentDays.includes(activeDay)) return;

  // Not yet 10:00 local
  const localHour = new Date().getHours();
  if (localHour < 10) return;

  // CEO messaged within last 24h → skip (already engaged)
  const ws = getWorkspace();
  if (ws) {
    const auditPath = path.join(ws, 'logs', 'audit.jsonl');
    try {
      if (fs.existsSync(auditPath)) {
        const stat = fs.statSync(auditPath);
        const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
        // Walk backwards to find last telegram message
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.event === 'message_inbound' && entry.channel === 'telegram') {
              const msgAge = Date.now() - new Date(entry.at || stat.mtime);
              if (msgAge < 24 * 60 * 60 * 1000) return; // active → skip
              break;
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Detect setup state
  const setup = await _detectSetupState();

  // Build message using activeDay (allows manual advance to show next day's content)
  const msg = _buildMessage(activeDay, setup);
  if (!msg) return;

  // Send
  try {
    await sendCeoAlert(msg);
    console.log(`[onboarding-nudge] sent day ${activeDay}`);

    // Record sent
    state.sentDays = [...(state.sentDays || []), activeDay];
    state.lastCheckedAt = new Date().toISOString();
    _writeState(state);

    try {
      auditLog('onboarding_nudge', { day: activeDay, setup });
    } catch {}
  } catch (e) {
    console.warn('[onboarding-nudge] send failed:', e?.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Returns the full onboarding state for Dashboard display.
// Returns null if no onboarding has started (no state file).
function getOnboardingStatus() {
  const state = _readState();
  if (!state) return null;

  const todayDay = _computeDay(state);
  const currentDay = state.currentDay || 1;

  // Map day number → title/body/cta for Dashboard card
  const dayMeta = _getDayMeta(currentDay);

  return {
    active: !state.dismissed,
    day: currentDay,
    todayDay,        // what day it would be based purely on elapsed time
    maxDays: MAX_DAYS,
    title: dayMeta.title,
    body: dayMeta.body,
    cta: dayMeta.cta,
    dismissed: !!state.dismissed,
    startedAt: state.startedAt,
  };
}

function _getDayMeta(day) {
  switch (day) {
    case 1: return {
      title: 'Chào mừng đến với 9BizClaw Premium!',
      body: 'Cài xong rồi ạ — từ giờ anh/chị cứ giao việc bằng tiếng Việt bình thường là được.',
      cta: 'Xem hướng dẫn',
    };
    case 2: return {
      title: 'Ngày 2 — Dạy bot hiểu sản phẩm',
      body: 'Upload bảng giá hoặc tài liệu sản phẩm để bot trả lời khách chính xác hơn.',
      cta: 'Upload tài liệu',
    };
    case 3: return {
      title: 'Ngày 3 — Đặt nhiệm vụ tự động',
      body: 'Tạo cron gửi tin nhắn chào buổi sáng cho nhóm khách VIP mỗi ngày.',
      cta: 'Tạo nhiệm vụ tự động',
    };
    case 4: return {
      title: 'Ngày 4 — Thêm hình ảnh sản phẩm',
      body: 'Upload ảnh sản phẩm để bot tự gửi đúng ảnh khi khách hỏi.',
      cta: 'Upload hình ảnh',
    };
    case 5: return {
      title: 'Ngày 5 — Kết nối kênh khách',
      body: 'Bot đã sẵn sàng nhận tin từ khách. Thử một tình huống thật nhé!',
      cta: 'Xem Dashboard Zalo',
    };
    case 6: return {
      title: 'Ngày 6 — Tổng kết năng lực',
      body: 'Em có thể trả lời khách, đăng Facebook, tạo báo giá, và nhiều hơn nữa.',
      cta: 'Khám phá Premium',
    };
    case 7: return {
      title: 'Ngày 7 — Mở khóa tính năng nâng cao',
      body: 'Hết tuần đầu rồi ạ! Anh/chị có thể tinh chỉnh giọng văn và kết nối thêm công cụ.',
      cta: 'Cài đặt nâng cao',
    };
    default: return {
      title: 'Premium Onboarding hoàn tất',
      body: 'Anh/chị đã hoàn thành 7 ngày đầu tiên với 9BizClaw Premium!',
      cta: 'Mở Dashboard',
    };
  }
}

// Dismiss onboarding card + stop nudge sending.
// Does NOT reset the startedAt — can be re-shown later if needed.
function dismissOnboarding() {
  const state = _readState();
  if (!state) return;
  state.dismissed = true;
  state.lastCheckedAt = new Date().toISOString();
  _writeState(state);
  console.log('[onboarding-nudge] dismissed');
}

// Advance to the next day manually (CEO clicks "Đã làm xong" CTA).
// Also clears today's sentDays entry so the nudge can re-fire if needed.
function advanceOnboardingDay() {
  const state = _readState();
  if (!state) return;
  const next = Math.min((state.currentDay || 1) + 1, MAX_DAYS);
  state.currentDay = next;
  // Remove today from sentDays so nudge can fire for the new day
  const today = _computeDay(state);
  state.sentDays = (state.sentDays || []).filter(d => d !== today);
  state.lastCheckedAt = new Date().toISOString();
  _writeState(state);
  console.log(`[onboarding-nudge] advanced to day ${next}`);
}

// Force a nudge tick (used by /api/onboarding/tick for testing).
function forceTickOnboarding() {
  return _tick();
}

function startOnboardingNudgeTimer() {
  if (_isRunning) return;
  const existing = _readState();
  if (!existing) {
    // Do not start onboarding before wizard-complete. The resetOnboardingState()
    // call is the explicit marker that the 7-day onboarding window has begun.
    return;
  }
  _isRunning = true;

  // Check every 30 minutes
  _nudgeTimerId = setInterval(() => {
    _tick().catch(e => console.warn('[onboarding-nudge] tick error:', e?.message));
  }, 30 * 60 * 1000);

  // Also fire once soon after startup (5 min) so day-1 nudge fires if
  // wizard completed close to 10:00 AM
  setTimeout(() => {
    _tick().catch(e => console.warn('[onboarding-nudge] initial tick error:', e?.message));
  }, 5 * 60 * 1000);
}

function cleanupOnboardingNudgeTimers() {
  if (_nudgeTimerId) {
    clearInterval(_nudgeTimerId);
    _nudgeTimerId = null;
  }
  _isRunning = false;
}

// ─── Forced re-init on wizard-complete ───────────────────────────────────────
// Called from wizard-complete handler: resets startedAt so day 1 = wizard day.

function resetOnboardingState() {
  const state = {
    startedAt: new Date().toISOString(),
    sentDays: [],
    currentDay: 1,
    dismissed: false,
    lastCheckedAt: new Date().toISOString(),
  };
  _writeState(state);
  console.log('[onboarding-nudge] state reset at wizard-complete');
}

module.exports = {
  startOnboardingNudgeTimer,
  cleanupOnboardingNudgeTimers,
  resetOnboardingState,
  getOnboardingStatus,
  dismissOnboarding,
  advanceOnboardingDay,
  forceTickOnboarding,
};
