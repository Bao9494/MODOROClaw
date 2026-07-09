'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

let ipcMain, dialog, shell, app, BrowserWindow;
try { ({ ipcMain, dialog, shell, app, BrowserWindow } = require('electron')); } catch {}

const ELECTRON_DIR = path.join(__dirname, '..');

const ctx = require('./context');
const { isPathSafe, writeJsonAtomic, sanitizeZaloText, stripTelegramMarkdown } = require('./util');
const { readOpenclawJsonFile } = require('./openclaw-json');
const zaloMenu = require('./zalo-menu');
const {
  getWorkspace, invalidateWorkspaceCache, getWorkspaceTemplateRoot,
  getOpenclawAgentWorkspace, seedWorkspace, purgeAgentSessions,
  getBrandAssetsDir, getFbConfigPath, readFbConfig, writeFbConfig, generateFbId,
  readFbAdsConfig, writeFbAdsConfig, getFbAdsConfigPath,
  getSetupCompletePath, hasCompletedOnboarding, markOnboardingComplete,
  isOpenClawConfigured, getAppPrefsPath, loadAppPrefs, saveAppPrefs,
  auditLog, backupWorkspace,
  DEFAULT_SCHEDULES_JSON, BRAND_ASSET_FORMATS, BRAND_ASSET_MAX_SIZE,
} = require('./workspace');
zaloMenu.init({ getWorkspace });
const zaloMenuImportSelections = new Map();
const ZALO_MENU_IMPORT_TOKEN_TTL_MS = 15 * 60 * 1000;
const ZALO_MENU_IMPORT_TOKEN_LIMIT = 20;
const ZALO_MENU_IMPORT_HASH_LIMIT_BYTES = 5 * 1024 * 1024;

function hashZaloMenuImportFile(filePath, size) {
  if (size > ZALO_MENU_IMPORT_HASH_LIMIT_BYTES) return '';
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function cleanupZaloMenuImportSelections() {
  const now = Date.now();
  for (const [token, entry] of zaloMenuImportSelections.entries()) {
    if (!entry || now - entry.createdAt > ZALO_MENU_IMPORT_TOKEN_TTL_MS) {
      zaloMenuImportSelections.delete(token);
    }
  }
  while (zaloMenuImportSelections.size > ZALO_MENU_IMPORT_TOKEN_LIMIT) {
    const oldest = zaloMenuImportSelections.keys().next().value;
    if (!oldest) break;
    zaloMenuImportSelections.delete(oldest);
  }
}

function createZaloMenuImportToken(filePath) {
  cleanupZaloMenuImportSelections();
  const stat = fs.statSync(filePath);
  const token = randomUUID();
  zaloMenuImportSelections.set(token, {
    filePath,
    createdAt: Date.now(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: hashZaloMenuImportFile(filePath, stat.size),
  });
  return token;
}

function resolveZaloMenuImportToken(token, consume = false) {
  cleanupZaloMenuImportSelections();
  const key = String(token || '').trim();
  const entry = key ? zaloMenuImportSelections.get(key) : null;
  if (!entry || !entry.filePath) throw new Error('Import token không hợp lệ hoặc đã hết hạn');
  const stat = fs.statSync(entry.filePath);
  const currentHash = hashZaloMenuImportFile(entry.filePath, stat.size);
  if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || currentHash !== entry.sha256) {
    zaloMenuImportSelections.delete(key);
    throw new Error('File import đã thay đổi sau khi chọn. Vui lòng chọn lại file XLSX.');
  }
  if (consume) zaloMenuImportSelections.delete(key);
  return entry.filePath;
}
const {
  getBundledVendorDir, getBundledNodeBin, augmentPathWithBundledNode,
  appDataDir, findOpenClawBin, findOpenClawBinSync, findNodeBin, findOpenClawCliJs,
  spawnOpenClawSafe, runOpenClaw,
  bootDiagRunFullCheck,
  npmGlobalModules, findGlobalPackageFile,
} = require('./boot');
const {
  healOpenClawConfigInline,
  withOpenClawConfigLock,
  writeOpenClawConfigIfChanged,
} = require('./config');
const {
  ensure9RouterDefaultPassword, saveProviderKey, ensure9RouterProviderKeys,
  start9Router, stop9Router, nineRouterApi, autoFix9RouterSqlite,
  waitFor9RouterReady, validateOllamaKeyDirect,
  call9Router, call9RouterVision, detectChatgptPlusOAuth,
  getRouterProcess,
} = require('./nine-router');
const {
  extractConversationHistoryRaw, extractConversationHistory,
  writeDailyMemoryJournal, appendPerCustomerSummaries, trimZaloMemoryFile,
  withMemoryFileLock, touchIdleMemoryTimer, setIdleMemoryRunCronAgent,
} = require('./conversation');
const {
  compareVersions, checkForUpdates, downloadUpdate, installDmgUpdate, openGitHubUrl,
  getLatestRelease, getUpdateDownloadInFlight, setUpdateDownloadInFlight,
} = require('./updates');
const {
  getTelegramConfig, getTelegramConfigWithRecovery,
  getGatewayAuthToken, getCeoSessionKey, sendToGatewaySession,
  filterSensitiveOutput,
  setChannelPermanentPause, clearChannelPermanentPause,
  isZaloChannelEnabled, setZaloChannelEnabled,
  isChannelPaused, pauseChannel, resumeChannel, getChannelPauseStatus,
  sendTelegram, sendTelegramPhoto, sendZalo, sendZaloTo, sendCeoAlert,
  probeTelegramReady, probeZaloReady,
  broadcastChannelStatusOnce, startChannelStatusBroadcast,
  registerTelegramCommands,
} = require('./channels');
const {
  listTelegramConversations,
  saveTelegramConversationSettings,
  readTelegramConversationProfile,
  seedTelegramConversationsFromRuntime,
  ensureTelegramConversationProfile,
  sanitizeTelegramChatId,
  appendTelegramConversationNote,
  deleteTelegramConversationNote,
} = require('./telegram-memory');
const {
  getAppointmentsPath, readAppointments, writeAppointments,
  newAppointmentId, mutateAppointments,
  vnHHMM, vnDDMM, normalizeAppointment,
  substituteApptTemplate, defaultApptPushTemplate, buildApptReminderText,
  fireApptPushTarget, startAppointmentDispatcher, apptDispatcherTick,
} = require('./appointments');
const mediaLibrary = require('./media-library');
const {
  getZcaProfile, getZcaCacheDir, getZcaCacheDirForProfile,
  readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget,
  invalidateZaloFriendsCache, getZaloFriendsCached, setZaloFriendsCached,
  runZaloCacheRefresh, startZaloCacheAutoRefresh,
  getZaloUsersDir, ensureZaloUsersDir, sanitizeZaloUserId, parseZaloUserMemoryMeta,
  getZaloGroupsDir, getZaloBlocklistPath, getZaloAllowlistPath, cleanBlocklist,
} = require('./zalo-memory');
const { normalizeZaloBlocklist, resolveZaloBlocklistSave } = require('./zalo-settings');
const { saveActiveZaloAccountSettings } = require('./zalo-account-settings');
const {
  cleanupOrphanZaloListener, ensureModoroZaloNodeModulesLink,
  ensureZaloPlugin, seedZaloCustomersFromCache,
  findOpenzcaCliJs, seedGroupHistorySummary, seedAllGroupHistories,
  checkZaloCookieAge, isZaloReady, getZaloPluginVersion,
} = require('./zalo-plugin');
const {
  compilePersonaMix, syncPersonaToBootstrap,
  syncShopStateToBootstrap, syncAllBootstrapData, syncProfileToUserMd,
} = require('./persona');
const {
  processEscalationQueue, startEscalationChecker,
} = require('./escalation');
const {
  getFollowUpQueuePath, readFollowUpQueue, writeFollowUpQueue,
  queueFollowUpSafe, startFollowUpChecker,
} = require('./follow-up');
const {
  killPort, killAllOpenClawProcesses,
  isGatewayAlive, rejectIfBooting,
  startOpenClaw, stopOpenClaw,
  ensureVisionFix, ensureVisionCatalogFix, ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix, ensureOpenzcaFriendEventFix,
  ensureOpenclawPricingFix, ensureOpenclawPrewarmFix,
  startFastWatchdog, triggerGatewayMessage,
} = require('./gateway');
const {
  getDocumentsDir, ensureDocumentsDir, getDocumentsDb, autoFixBetterSqlite3,
  KNOWLEDGE_CATEGORIES, DEFAULT_KNOWLEDGE_CATEGORIES, KNOWLEDGE_LABELS,
  VISIBILITY_SUBFOLDERS, _watcherSkipPaths,
  getKnowledgeCategories, getKnowledgeDir,
  insertDocumentRow, ensureKnowledgeFolders, backfillKnowledgeFromDisk,
  resolveUniqueFilename, describeImageForKnowledge, summarizeKnowledgeContent,
  sanitizeKnowledgeContentForIndex, rewriteKnowledgeIndex, listKnowledgeFilesFromDisk,
  setKnowledgeDocumentEnabledState, moveKnowledgeDocumentState, removeKnowledgeDocumentState,
  searchKnowledge, searchKnowledgeFTS5, getRagConfig,
  extractTextFromFile, expandSearchQuery, rerankSearchResults,
  indexDocumentChunks,
  embedText, vecToBlob,
} = require('./knowledge');
const {
  runCronAgentPrompt,
  runCronViaSessionOrFallback,
  getSchedulesPath, getCustomCronsPath,
  loadSchedules, loadCustomCrons,
  loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
  loadPromptTemplate,
  buildMorningBriefingPrompt, buildEveningSummaryPrompt,
  buildWeeklyReportPrompt, buildMonthlyReportPrompt,
  scanZaloFollowUpCandidates, buildZaloFollowUpPrompt,
  buildMemoryCleanupPrompt,
  healCustomCronEntries, watchCustomCrons,
  startCronJobs, stopCronJobs, restartCronJobs,
  _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError,
  _readJsonlTail, _readCeoNameFromIdentity, _readRecentZaloCustomers, _nextFireTime,
  _OVERVIEW_EVENT_LABELS,
  setSaveZaloManagerInFlightGetter,
  getAgentFlagProfile, getAgentCliHealthy,
} = require('./cron');
const { startCronApi, getCronApiToken, getCronApiPort } = require('./cron-api');
const { startOnboardingNudgeTimer, resetOnboardingState, getOnboardingStatus, dismissOnboarding, advanceOnboardingDay } = require('./onboarding-nudge');
const { registerChatIpc } = require('./chat');

// ============================================
//  GOOGLE CALENDAR
// ============================================


// ── Module-level state (used across IPC handlers) ──
let _zaloLoginStartedAt = 0;
let _saveZaloManagerInFlight = false;

// Wire _saveZaloManagerInFlight getter into cron.js
setSaveZaloManagerInFlightGetter(() => _saveZaloManagerInFlight);

function startRuntimeSidecars(source) {
  const prefix = source ? `[${source}]` : '[runtime-sidecars]';
  try { startCronApi(); } catch (e) { console.error(prefix, 'startCronApi error:', e?.message || e); }
  try { startCronJobs(); } catch (e) { console.error(prefix, 'startCronJobs error:', e?.message || e); }
  try { startFollowUpChecker(); } catch (e) { console.error(prefix, 'startFollowUpChecker error:', e?.message || e); }
  try { startEscalationChecker(); } catch (e) { console.error(prefix, 'startEscalationChecker error:', e?.message || e); }
  try { watchCustomCrons(); } catch (e) { console.error(prefix, 'watchCustomCrons error:', e?.message || e); }
  try { startZaloCacheAutoRefresh(); } catch (e) { console.error(prefix, 'startZaloCacheAutoRefresh error:', e?.message || e); }
  try { startAppointmentDispatcher(); } catch (e) { console.error(prefix, 'startAppointmentDispatcher error:', e?.message || e); }
  try { startOnboardingNudgeTimer(); } catch (e) { console.error(prefix, 'startOnboardingNudgeTimer error:', e?.message || e); }
}

// v2.4.10 fix: fs.watch on Zalo config files so Dashboard auto-refreshes when
// underlying state changes (QR rescan, auto-friend addition, openzca CLI edits).
// Without this, the renderer cache shows stale strangerPolicy / friend toggles
// after the bot itself rewrites these files.
function startZaloConfigWatcher() {
  try {
    const ws = getWorkspace();
    // v2.4.10 fix: do NOT gate on ctx.mainWindow here — registerAllIpcHandlers()
    // runs at module load (before app.whenReady() creates the BrowserWindow), so
    // ctx.mainWindow is always null at this point. Previously this returned early
    // and the watcher was permanently dead. The emit() closure re-checks
    // ctx.mainWindow before sending, so initialization is safe before the window
    // exists.
    if (!ws) return;
    const watchFiles = [
      'zalo-stranger-policy.json',
      'zalo-allowlist.json',
      'zalo-blocklist.json',
      'zalo-user-settings.json',
      'zalo-group-settings.json',
      'zalo-active-account.json',
    ];
    let debounceTimer = null;
    let lastEmit = 0;
    const emit = () => {
      const now = Date.now();
      if (now - lastEmit < 300) return; // dedupe burst writes (atomic rename = double-fire)
      lastEmit = now;
      try {
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('zalo-manager-config-changed', { changedAt: new Date().toISOString() });
        }
      } catch {}
    };
    for (const name of watchFiles) {
      const fp = path.join(ws, name);
      try {
        // watch the directory entry so we capture rename-replace patterns (writeJsonAtomic).
        fs.watch(ws, { persistent: false }, (eventType, filename) => {
          if (!filename) return;
          if (!watchFiles.includes(String(filename))) return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(emit, 150);
        });
        break; // one workspace watcher handles all 5 files
      } catch (e) {
        // fall through, try next entry
      }
    }
    // Also watch openzca friends cache so new auto-added friends trigger refresh.
    // Uses a SEPARATE timer from the workspace watcher — otherwise writeLegacyZaloState
    // (triggered by the seed itself) fires the workspace watcher which cancels this timer.
    let friendSyncInFlight = false;
    let friendSyncTimer = null;
    try {
      const home = require('os').homedir();
      const friendsDir = path.join(home, '.openzca', 'profiles', 'default', 'cache');
      if (fs.existsSync(friendsDir)) {
        fs.watch(friendsDir, { persistent: false }, (eventType, filename) => {
          if (filename === 'friends.json' || filename === 'groups.json') {
            clearTimeout(friendSyncTimer);
            friendSyncTimer = setTimeout(async () => {
              if (filename === 'friends.json' && !friendSyncInFlight) {
                friendSyncInFlight = true;
                try { await seedZaloCustomersFromCache(); } catch (e) {
                  console.warn('[zalo-watcher] auto-seed failed:', e?.message);
                }
                friendSyncInFlight = false;
              }
              emit();
            }, 500);
          }
        });
      }
    } catch {}
  } catch (e) {
    console.warn('[zalo-watcher] failed to start:', e?.message || e);
  }
}

// ─── MODORO AI provider setup + boot-time endpoint auto-heal ───────────────────
//     At module scope so ensureModoroEndpoint can be exported; the modoro:setup IPC
//     handler stays inside registerAllIpcHandlers and calls setupModoroProvider.
// MODORO AI brain endpoint. When this URL changes (e.g. tunnel migration), list the
// retired URL(s) in MODORO_AI_OLD_BASE_URLS so ensureModoroEndpoint() can find and
// repoint an existing install's node at boot — the CEO never re-pastes the key.
const MODORO_AI_BASE_URL = 'https://models.9bizclaw.com/v1';
const MODORO_AI_OLD_BASE_URLS = ['https://rd5utqj.abc-tunnel.us/v1'];
const MODORO_AI_PROVIDER_NAME = 'MODORO AI';
const MODORO_AI_PREFIX = 'Modoro';            // custom-node prefix → combos reference Modoro/<model>
// Combo model chain (replicates the working machine): primary cx/gpt-5.4, fallback cx/gpt-5.5 — both via the Modoro node.
const MODORO_AI_COMBO_MODELS = ['Modoro/cx/gpt-5.4', 'Modoro/cx/gpt-5.5'];

// Create/repoint the MODORO AI provider node in 9Router and wire combos main+zalo to
// it. Extracted from the modoro:setup IPC handler so boot-time auto-heal can reuse the
// EXACT same proven path (no copy-paste drift). Returns the same result shape.
async function setupModoroProvider(apiKey) {
  const key = String(apiKey || '').trim();
  if (key.length < 12) return { success: false, error: 'API key chưa đúng — kiểm tra lại đã dán đủ chưa.' };
  try {
    // 1. Ensure 9router is up
    if (!getRouterProcess()) start9Router();
    let ready = await waitFor9RouterReady(15000);
    if (!ready) {
      const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
      if (ping.statusCode && ping.statusCode >= 500) {
        const fixed = await autoFix9RouterSqlite();
        if (fixed) { stop9Router(); await new Promise(r => setTimeout(r, 2500)); start9Router(); ready = await waitFor9RouterReady(30000); }
      }
    }
    if (!ready) return { success: false, error: '9router chưa khởi động được. Đóng/mở lại app rồi thử lại.' };

    // 2. Custom endpoints (openai-compatible) are 9router "provider NODES", NOT
    //    /api/providers connections (that endpoint only accepts built-in provider types
    //    and returns "Invalid provider"). Remove any previous Modoro node (dedupe re-runs).
    const nodeBody = { name: MODORO_AI_PROVIDER_NAME, prefix: MODORO_AI_PREFIX, baseUrl: MODORO_AI_BASE_URL, type: 'openai-compatible', apiType: 'chat', apiKey: key };
    const _knownUrls = [MODORO_AI_BASE_URL, ...MODORO_AI_OLD_BASE_URLS].map(u => u.replace(/\/+$/, ''));
    const listRes = await nineRouterApi('GET', '/api/provider-nodes');
    if (listRes.success) {
      const dupes = (listRes.data?.nodes || []).filter(n =>
        n.prefix === MODORO_AI_PREFIX || n.name === MODORO_AI_PROVIDER_NAME ||
        _knownUrls.includes(String(n.baseUrl || '').replace(/\/+$/, '')));
      for (const old of dupes) { try { await nineRouterApi('DELETE', `/api/provider-nodes/${old.id}`); } catch {} }
    }
    // Also remove any stale MODORO credential connection (re-run safety).
    try {
      const connList = await nineRouterApi('GET', '/api/providers');
      const cdupes = (connList.data?.connections || []).filter(c =>
        c.name === MODORO_AI_PROVIDER_NAME ||
        _knownUrls.includes(String(c.providerSpecificData?.baseUrl || '').replace(/\/+$/, '')));
      for (const old of cdupes) { try { await nineRouterApi('DELETE', `/api/providers/${old.id}`); } catch {} }
    } catch {}

    // 3. Validate the key against the tunnel first (fast-fail on a bad key)
    try {
      const valRes = await nineRouterApi('POST', '/api/provider-nodes/validate', nodeBody, 12000);
      const valErr = String(valRes.data?.error || valRes.error || '');
      const valid = valRes.success && valRes.data?.valid !== false;
      const transient = /^HTTP\s*5\d{2}$/.test(valErr) || /ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|network/i.test(valErr);
      if (!valid && !transient && /401|403|unauthor|invalid.*key|forbidden/i.test(valErr)) {
        return { success: false, error: 'API key MODORO không hợp lệ (bị từ chối). Kiểm tra lại key anh được cấp.', validationFailed: true };
      }
    } catch { /* non-fatal — proceed to create */ }

    // 4. Create the Modoro custom provider node. The key on THIS request only TESTS the
    //    connection — 9router does NOT persist it as the routing credential.
    const createRes = await nineRouterApi('POST', '/api/provider-nodes', nodeBody);
    if (!createRes.success) return { success: false, error: 'Không thêm được MODORO AI: ' + (createRes.error || 'không rõ') };
    const nodeId = createRes.data?.id || createRes.data?.node?.id || createRes.data?.providerNode?.id;
    if (!nodeId) return { success: false, error: '9router không trả về node ID cho MODORO AI.' };
    saveProviderKey('modoro', key); // local backup so a 9router UI wipe can be re-healed

    // 4b. Attach the REAL routing credential: a connection whose `provider` IS the node id
    //     (verified live — "openai-compatible" alone returns "Invalid provider"). Without this
    //     the node exists but has no key, so routing through Modoro/* fails.
    const connRes = await nineRouterApi('POST', '/api/providers', { provider: nodeId, name: MODORO_AI_PROVIDER_NAME, apiKey: key });
    if (!connRes.success) {
      try { await nineRouterApi('DELETE', `/api/provider-nodes/${nodeId}`); } catch {}
      return { success: false, error: 'Không lưu được API key cho MODORO AI: ' + (connRes.error || 'không rõ') };
    }
    const connId = connRes.data?.connection?.id || connRes.data?.id || null;

    // 4c. Import the provider's models as ALIASES — replicates the 9router "Import from
    //     /models" button exactly (so models show in the provider page / model picker without
    //     a manual Import click). Per model: PUT /api/models/alias {model:"<prefix>/<slug>", alias}.
    //     Collision-safe: alias = last path segment; if taken (e.g. a local codex already
    //     registered "gpt-5.5"), fall back to "<prefix>-<segment>"; if both taken, skip.
    let importedModels = [];
    try {
      if (connId) {
        const existing = (await nineRouterApi('GET', '/api/models/alias', null, 6000)).data?.aliases || {};
        const m = await nineRouterApi('GET', `/api/providers/${connId}/models`, null, 15000);
        const slugs = Array.isArray(m.data?.models)
          ? m.data.models.map(x => (typeof x === 'string' ? x : (x.slug || x.id || x.name))).filter(Boolean)
          : [];
        for (const slug of slugs) {
          const seg = String(slug).split('/').pop();
          const alias = existing[seg] ? `${MODORO_AI_PREFIX}-${seg}` : seg;
          if (existing[alias]) continue; // already imported under both names → skip
          const r = await nineRouterApi('PUT', '/api/models/alias', { model: `${MODORO_AI_PREFIX}/${slug}`, alias });
          if (r.success) { existing[alias] = true; importedModels.push(alias); }
        }
        console.log('[modoro:setup] imported model aliases:', importedModels.slice(0, 12));
      }
    } catch (e) { console.warn('[modoro:setup] model import warning:', e?.message); }

    // 5. Point combos main + zalo at the Modoro models (primary cx/gpt-5.4 + fallback cx/gpt-5.5)
    const combosRes = await nineRouterApi('GET', '/api/combos');
    const combos = combosRes.data?.combos || combosRes.data || [];
    const setCombo = async (name) => {
      const existing = (Array.isArray(combos) ? combos : []).find(c => c.name === name);
      if (existing) await nineRouterApi('PUT', `/api/combos/${existing.id}`, { name, models: MODORO_AI_COMBO_MODELS });
      else await nineRouterApi('POST', '/api/combos', { name, models: MODORO_AI_COMBO_MODELS });
    };
    await setCombo('main');
    await setCombo('zalo');
    console.log('[modoro:setup] node created + combos main+zalo →', MODORO_AI_COMBO_MODELS.join(', '));

    // 6. Ensure a local 9router API key exists (openclaw.json already references it).
    //    Capture its value so the wizard can write models.providers.ninerouter.apiKey
    //    (Dashboard ignores this field — it only reads modelCount).
    let localApiKey = null;
    try {
      const keysRes = await nineRouterApi('GET', '/api/keys');
      const keys = keysRes.data?.keys || keysRes.data || [];
      const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
      if (activeKey) {
        localApiKey = activeKey.key;
      } else {
        const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
        localApiKey = createKey.data?.key?.key || createKey.data?.key || null;
      }
    } catch {}

    return {
      success: true,
      apiKey: localApiKey || undefined,
      modelCount: importedModels.length || MODORO_AI_COMBO_MODELS.length,
      models: (importedModels.length ? importedModels : MODORO_AI_COMBO_MODELS).slice(0, 8),
    };
  } catch (e) {
    return { success: false, error: 'Lỗi kết nối MODORO AI: ' + (e?.message || String(e)) };
  }
}

// Boot-time auto-heal: when MODORO_AI_BASE_URL changes (tunnel migration), an already
// connected install still has its 9Router node pointing at the OLD url. On every boot —
// AFTER 9Router is confirmed ready — check the live nodes; if none points at the NEW
// url but a node points at an OLD one, re-run setup with the SAVED key so the CEO never
// re-pastes it. Idempotent: if a node already points at the new url, do nothing.
async function ensureModoroEndpoint() {
  try {
    const newUrl = MODORO_AI_BASE_URL.replace(/\/+$/, '');
    const oldUrls = MODORO_AI_OLD_BASE_URLS.map(u => u.replace(/\/+$/, ''));
    const listRes = await nineRouterApi('GET', '/api/provider-nodes', null, 5000);
    if (!listRes.success) return { skipped: 'list-failed' };
    const nodes = listRes.data?.nodes || [];

    // Find THIS install's Modoro node (by prefix/name; baseUrl may be old or new).
    const node = nodes.find(n => n.prefix === MODORO_AI_PREFIX || n.name === MODORO_AI_PROVIDER_NAME)
      || nodes.find(n => oldUrls.includes(String(n.baseUrl || '').replace(/\/+$/, '')));
    if (!node) return { skipped: 'no-modoro-node' };             // never connected → leave wizard to set it up
    if (String(node.baseUrl || '').replace(/\/+$/, '') === newUrl) return { ok: true, alreadyCurrent: true };

    // Update the node's baseUrl IN PLACE (PUT /api/provider-nodes/{id}). This preserves
    // the node id, its routing-credential connection, model aliases, and combos — unlike
    // delete+recreate, which would briefly leave the customer with NO brain node if the
    // recreate failed. 9Router's PUT reads {name, prefix, apiType, baseUrl} and does NOT
    // touch the stored apiKey (verified against the bundled provider-nodes/[id] route).
    const body = {
      name: node.name || MODORO_AI_PROVIDER_NAME,
      prefix: node.prefix || MODORO_AI_PREFIX,
      apiType: node.apiType || 'chat',
      baseUrl: MODORO_AI_BASE_URL,
    };
    console.log('[modoro] repointing existing node', node.id, '→', newUrl, '(in-place, key preserved)');
    const r = await nineRouterApi('PUT', `/api/provider-nodes/${node.id}`, body, 12000);
    if (r.success) { console.log('[modoro] endpoint repointed in place →', newUrl); return { ok: true, repointed: true }; }
    console.warn('[modoro] in-place repoint failed:', r.error || r.statusCode);
    return { ok: false, error: r.error || `HTTP ${r.statusCode}` };
  } catch (e) { console.warn('[modoro] ensureModoroEndpoint error:', e?.message); return { error: e?.message }; }
}

function registerAllIpcHandlers() {

registerChatIpc();
// Wire idle memory extraction through the current cron/session fallback path.
try { setIdleMemoryRunCronAgent(runCronViaSessionOrFallback); } catch {}
// Start auto-refresh watcher (idempotent: gated by ctx.mainWindow availability).
try { startZaloConfigWatcher(); } catch (e) { console.warn('[zalo-watcher] init error:', e?.message); }

// ============================================
//  IPC HANDLERS
// ============================================

// Start 9Router and open dashboard in browser
ipcMain.handle('start-9router', async () => {
  try {
    start9Router();
    await new Promise(r => setTimeout(r, 2000));
    const { shell } = require('electron');
    shell.openExternal('http://127.0.0.1:20128');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('setup-9router-auto', async (_event, opts = {}) => {
  try {
    // --- ensureRunning: just start 9router, no provider setup ---
    if (opts.ensureRunning) {
      if (!getRouterProcess()) {
        console.log('[setup-9router-auto] ensureRunning — starting 9router');
        start9Router();
      }
      const ready = await waitFor9RouterReady(45000);
      return { success: ready, error: ready ? undefined : '9Router không khởi động được.' };
    }

    if (opts.openCodexAuthed) {
      if (!getRouterProcess()) {
        console.log('[setup-9router-auto] openCodexAuthed — starting 9router');
        start9Router();
      }
      const ready = await waitFor9RouterReady(30000);
      if (!ready) return { success: false, error: '9Router không khởi động được. Đợi vài giây rồi thử lại.' };

      let loginFailed = false;
      try {
        const http = require('http');
        const loginData = JSON.stringify({ password: '123456' });
        const cookieValue = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port: 20128, path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) },
            timeout: 5000,
          }, (res) => {
            const cookies = res.headers['set-cookie'] || [];
            const authCookie = cookies.find(c => c.startsWith('auth_token='));
            if (authCookie) {
              const val = authCookie.split('=')[1].split(';')[0];
              resolve(val);
            } else {
              reject(new Error('no auth_token cookie in response'));
            }
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('login timeout')); });
          req.write(loginData);
          req.end();
        });

        const { getCronApiPort, startCronApi: ensureCronApi } = require('./cron-api');
        try { ensureCronApi(); } catch (e) { console.warn('[setup-9router-auto] ensureCronApi failed:', e.message); }
        const port = getCronApiPort();
        const { shell } = require('electron');
        if (!port) {
          shell.openExternal('http://127.0.0.1:20128/dashboard/providers/codex');
        } else {
          const redirectUrl = `http://127.0.0.1:${port}/api/internal/9router-redirect?token=${encodeURIComponent(cookieValue)}&path=/dashboard/providers/codex`;
          shell.openExternal(redirectUrl);
        }
        console.log('[setup-9router-auto] openCodexAuthed — opened in default browser via cookie bridge');
      } catch (loginErr) {
        console.warn('[setup-9router-auto] openCodexAuthed — login failed:', loginErr.message);
        loginFailed = true;
        const { shell } = require('electron');
        shell.openExternal('http://127.0.0.1:20128/dashboard/providers/codex');
      }

      return { success: true, windowOpened: true, loginFailed };
    }

    // --- detectChatGPT: find codex provider + auto-create combo cx/gpt-5.4 ---
    if (opts.detectChatGPT) {
      if (!getRouterProcess()) start9Router();
      let ready = await waitFor9RouterReady(30000);
      if (!ready) {
        // Same auto-fix as Ollama path: distinguish 5xx (native module crash)
        // from ECONNREFUSED (process dead / never started).
        const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
        if (ping.statusCode && ping.statusCode >= 500) {
          console.log('[setup-9router-auto] detectChatGPT: 9router crash (HTTP', ping.statusCode, ') — attempting native module auto-fix');
          const fixed = await autoFix9RouterSqlite();
          if (fixed) {
            stop9Router();
            await new Promise(r => setTimeout(r, 2500));
            try { killPort(20128); } catch {}
            start9Router();
            ready = await waitFor9RouterReady(30000);
            if (!ready) return { success: false, error: '9Router vẫn không khởi động được sau khi tự sửa. Thử tắt app, mở lại.' };
          } else {
            return { success: false, error: '9Router gặp lỗi khởi động (HTTP 500) và không thể tự sửa. Thử tắt app, mở lại.' };
          }
        } else {
          return { success: false, error: '9Router chưa sẵn sàng. Đợi vài giây rồi nhấn lại "Kiểm tra kết nối".' };
        }
      }

      const listRes = await nineRouterApi('GET', '/api/providers');
      const conns = listRes.data?.connections || listRes.data?.providers || listRes.data || [];
      const codexConn = (Array.isArray(conns) ? conns : []).find(p =>
        p.provider === 'codex' || p.type === 'codex' || p.kind === 'codex' ||
        String(p.provider || p.type || p.kind || '').toLowerCase().includes('chatgpt')
      );
      if (!codexConn) {
        return { success: false, error: 'Chưa tìm thấy kết nối ChatGPT. Nhấn "Kết nối ChatGPT", đăng nhập trên trình duyệt, rồi quay lại nhấn "Kiểm tra kết nối".' };
      }
      console.log('[setup-9router-auto] found codex provider:', codexConn.id, codexConn.name || codexConn.provider);

      const picked = 'cx/gpt-5.4';
      // Main combo carries BOTH models so the agent falls back to gpt-5.5 when 5.4
      // is unavailable/rate-limited (CEO asked for 5.5 in the combo, not just 5.4).
      const comboModels = ['cx/gpt-5.4', 'cx/gpt-5.5'];
      const combosRes = await nineRouterApi('GET', '/api/combos');
      const combos = combosRes.data?.combos || combosRes.data || [];
      let mainCombo = (Array.isArray(combos) ? combos : []).find(c => c.name === 'main');
      if (mainCombo) {
        await nineRouterApi('PUT', `/api/combos/${mainCombo.id}`, { name: 'main', models: comboModels });
      } else {
        await nineRouterApi('POST', '/api/combos', { name: 'main', models: comboModels });
      }
      console.log('[setup-9router-auto] combo "main" set to:', comboModels.join(', '));

      const keysRes = await nineRouterApi('GET', '/api/keys');
      const keys = keysRes.data?.keys || keysRes.data || [];
      let apiKeyValue = null;
      const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
      if (activeKey) {
        apiKeyValue = activeKey.key;
      } else {
        const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
        apiKeyValue = createKey.data?.key?.key || createKey.data?.key || null;
      }
      if (!apiKeyValue) {
        return { success: false, error: 'Không tạo được API key. Thử nhấn lại "Kiểm tra kết nối".' };
      }
      return { success: true, apiKey: apiKeyValue, selectedModel: picked };
    }

    if (opts.ollamaKey) {
      const trimmedKey = String(opts.ollamaKey).trim();
      if (trimmedKey.length < 20) {
        return { success: false, error: 'Ollama API key quá ngắn — kiểm tra lại đã paste đủ chưa.' };
      }
    }

    // FAST PATH: use 9router HTTP API for create+test+models. ~3-5 seconds
    // total instead of the old write-file-and-restart approach (~30s).
    //
    // Steps:
    //   1. Ensure 9router is running + reachable
    //   2. POST /api/providers (create Ollama connection)
    //   3. POST /api/providers/{id}/test (instant validate)
    //   4. If invalid: DELETE the connection + return clear error
    //   5. If valid: GET /api/providers/{id}/models, pick first
    //   6. Update or create combo "main" with picked model via /api/combos
    //   7. Ensure an API key exists (GET/POST /api/keys)
    //
    // No restart, no db.json writes — 9router persists everything itself.
    // If the API is unreachable (vendor broken, 9router won't start), fall
    // back to the legacy file-based approach below.
    if (opts.ollamaKey) {
      try {
        // 1. Make sure 9router is running
        if (!getRouterProcess()) {
          console.log('[setup-9router-auto] 9router not running — starting');
          start9Router();
        }
        let ready = await waitFor9RouterReady(10000);
        if (!ready) {
          // Distinguish crash (5xx = native module broken) from not-started (ECONNREFUSED)
          const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
          if (ping.statusCode && ping.statusCode >= 500) {
            // Native module crash (e.g. better-sqlite3 arch mismatch on Mac).
            // Attempt runtime rebuild — takes up to ~60s but wizard shows spinner.
            console.log('[setup-9router-auto] 9router crash (HTTP', ping.statusCode, ') — attempting native module auto-fix');
            const fixed = await autoFix9RouterSqlite();
            if (fixed) {
              stop9Router();
              // Wait > 1500ms (Mac SIGKILL grace period) so old process releases
              // port 20128 before we restart. Also force-clear any lingering process
              // on the port as belt-and-braces.
              await new Promise(r => setTimeout(r, 2500));
              try { killPort(20128); } catch {}
              start9Router();
              ready = await waitFor9RouterReady(30000);
              if (ready) {
                console.log('[setup-9router-auto] 9router ready after native module auto-fix');
              } else {
                // BUG-A fix: return directly so we don't fall through to legacy
                // file mode (which also fails with 500 when 9router is broken).
                return { success: false, error: '9router vẫn không khởi động được sau khi tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
              }
            } else {
              // BUG-A fix: return directly, same reason as above.
              return { success: false, error: '9router gặp lỗi khởi động (HTTP 500) và không thể tự sửa native module. Mở thư mục log (9router.log) để xem chi tiết.' };
            }
          } else {
            throw new Error('9Router không khởi động được trong 10 giây — chuyển sang chế độ tệp');
          }
        }
        console.log('[setup-9router-auto] 9router API reachable');

        // Advisory-only direct validation against ollama.com/api/ps.
        // Previously this was FAIL-CLOSED on 401/403 but ollama.com's /api/ps
        // endpoint behavior is brittle: Cloudflare challenge pages, regional
        // firewall, new key-format changes, or rate-limit can return 401 even
        // for valid keys. 9router's own test against ollama.com is the
        // authoritative source — we trust its result, not ours. Log for debug
        // but never block on direct check.
        if (opts.ollamaKey && typeof opts.ollamaKey === 'string') {
          try {
            const directCheck = await validateOllamaKeyDirect(opts.ollamaKey.trim());
            if (!directCheck.valid) {
              console.warn('[setup-9router-auto] direct-check advisory:', directCheck.statusCode, directCheck.error, '— proceeding via 9router');
            } else {
              console.log('[setup-9router-auto] direct-check PASSED (ollama.com 200)');
            }
          } catch (e) {
            console.warn('[setup-9router-auto] direct-check threw (non-fatal):', e?.message);
          }
        }

        // 2. Look for existing Ollama provider — if exists, delete it first
        //    so we don't accumulate dupes when user re-runs wizard
        const listRes = await nineRouterApi('GET', '/api/providers');
        if (listRes.success) {
          const existing = (listRes.data?.connections || []).filter(c => c.provider === 'ollama');
          for (const old of existing) {
            await nineRouterApi('DELETE', `/api/providers/${old.id}`);
            console.log('[setup-9router-auto] removed old Ollama provider', old.id);
          }
        }

        // 3. Create new Ollama provider — DO NOT set baseUrl.
        // 9Router knows the correct Ollama cloud endpoint internally for
        // provider type 'ollama'. Setting baseUrl: 'https://ollama.com'
        // previously overrode the default → requests hit wrong URL → 401.
        const createRes = await nineRouterApi('POST', '/api/providers', {
          provider: 'ollama',
          name: 'Ollama',
          apiKey: opts.ollamaKey.trim(),
        });
        if (!createRes.success) {
          throw new Error('Không tạo được nhà cung cấp: ' + (createRes.error || 'không rõ'));
        }
        const providerId = createRes.data?.id || createRes.data?.connection?.id;
        if (!providerId) {
          throw new Error('9router không trả về provider ID');
        }
        console.log('[setup-9router-auto] created Ollama provider', providerId);
        // Save key in our own file so we can re-inject if 9Router UI wipes it
        saveProviderKey('ollama', opts.ollamaKey.trim());

        // 4. Test it (THIS is the fast validator — usually 1-3 seconds)
        const testRes = await nineRouterApi('POST', `/api/providers/${providerId}/test`, null, 8000);
        const testErrMsg = testRes.data?.error || testRes.error || 'Ollama key không hợp lệ';
        const testValid = testRes.success && (testRes.data?.valid !== false);

        if (!testValid) {
          console.warn('[setup-9router-auto] provider test failed:', testErrMsg);

          // HTTP 5xx = 9router internal unhandled exception (NOT a key validation failure).
          // Root cause: testConnection() in 9router writes the test result to SQLite AFTER
          // the fetch completes, and that write throws without a try/catch → propagates to
          // the route handler catch → 500. This is a 9router bug, not an invalid key.
          //
          // Key was already validated directly via validateOllamaKey() in wizard.html
          // before this IPC was called, so we KNOW the key is valid.
          // Skip the test result, do NOT delete the provider, fall through to models.
          // 5xx OR transient network errors (ECONNRESET, EPIPE, ETIMEDOUT,
          // socket hang up) = NOT a key validation failure. Bypass test,
          // proceed to models. If models lookup later also fails, we'll
          // surface the real error there.
          if (
            /^HTTP [5]\d{2}$/.test(String(testErrMsg)) ||
            /ECONNRESET|EPIPE|socket hang up|ETIMEDOUT|read ETIMEDOUT|network/i.test(String(testErrMsg))
          ) {
            console.warn('[setup-9router-auto] transient test error — proceeding (key trusted):', testErrMsg);
          } else {
            // Non-5xx = genuine key/network failure (401, ENOTFOUND, etc.)
            // Delete the bad provider so it doesn't pollute db.json
            await nineRouterApi('DELETE', `/api/providers/${providerId}`);
            let viError = testErrMsg;
            if (/401|unauthor/i.test(testErrMsg)) {
              viError = 'Ollama trả về 401. Nếu key chắc chắn đúng, có thể do Cloudflare/firewall chặn — thử đổi mạng (4G, VPN khác) rồi thử lại.';
            } else if (/ENOTFOUND|DNS/i.test(testErrMsg)) {
              viError = 'Không kết nối được ollama.com. Kiểm tra Internet hoặc thử đổi mạng.';
            } else if (/429|rate/i.test(testErrMsg)) {
              viError = 'Ollama trả về 429 (quá giới hạn). Đợi 1 phút rồi thử lại.';
            } else if (/\b5\d{2}\b|internal.server.error/i.test(testErrMsg)) {
              viError = 'Ollama đang gặp sự cố tạm thời (HTTP 5xx). Thử lại sau vài phút hoặc kiểm tra status.ollama.com.';
            }
            return { success: false, error: viError, validationFailed: true };
          }
        }
        console.log('[setup-9router-auto] provider test PASSED (or bypassed — key pre-validated)');

        // 5. Get models for this provider
        const modelsRes = await nineRouterApi('GET', `/api/providers/${providerId}/models`);
        const modelIds = Array.isArray(modelsRes.data?.models)
          ? modelsRes.data.models.map(m => typeof m === 'string' ? m : (m?.id || m?.name)).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] models:', modelIds.slice(0, 5));
        if (modelIds.length === 0) {
          await nineRouterApi('DELETE', `/api/providers/${providerId}`);
          return {
            success: false,
            error: 'Ollama key hợp lệ nhưng không có model nào. Tài khoản Ollama có thể chưa subscribe gói nào.',
            validationFailed: true,
          };
        }

        // Smart model selection: pick the best model for demo/daily use.
        // Priority: large capable models first, avoid tiny/quantized variants.
        const PREFERRED_MODELS = [
          'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
          'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
          'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
          'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          'qwen3-coder:480b', 'qwen3-coder-next', 'cogito-2.1:671b',
          'nemotron-3-super', 'devstral-2:123b',
        ];
        // Strip ollama/ prefix for matching, then re-add
        const bareIds = modelIds.map(id => id.replace(/^ollama\//, ''));
        let pickedBare = null;
        for (const pref of PREFERRED_MODELS) {
          const match = bareIds.find(id => id === pref || id.startsWith(pref + ':'));
          if (match) { pickedBare = match; break; }
        }
        if (!pickedBare) pickedBare = bareIds[0]; // fallback to first
        let picked = modelIds.find(id => id.endsWith(pickedBare)) || modelIds[0];
        // 9router model IDs may not have ollama/ prefix in the response; add it
        if (!picked.startsWith('ollama/')) picked = 'ollama/' + picked;
        console.log('[setup-9router-auto] smart pick:', picked, '(from', modelIds.length, 'models)');

        // 6. Get or create combo 'main'
        const combosRes = await nineRouterApi('GET', '/api/combos');
        const combos = combosRes.data?.combos || combosRes.data || [];
        let mainCombo = (Array.isArray(combos) ? combos : []).find(c => c.name === 'main');
        if (mainCombo) {
          // Update existing
          const upRes = await nineRouterApi('PUT', `/api/combos/${mainCombo.id}`, {
            name: 'main',
            models: [picked],
          });
          if (!upRes.success) console.warn('[setup-9router-auto] combo update failed:', upRes.error);
        } else {
          // Create new
          const createCombo = await nineRouterApi('POST', '/api/combos', {
            name: 'main',
            models: [picked],
          });
          if (!createCombo.success) console.warn('[setup-9router-auto] combo create failed:', createCombo.error);
        }
        console.log('[setup-9router-auto] combo "main" set to model:', picked);

        // 7. Get or create API key
        const keysRes = await nineRouterApi('GET', '/api/keys');
        const keys = keysRes.data?.keys || keysRes.data || [];
        let apiKeyValue = null;
        const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
        if (activeKey) {
          apiKeyValue = activeKey.key;
        } else {
          const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
          apiKeyValue = createKey.data?.key?.key || createKey.data?.key || null;
        }

        if (!apiKeyValue) {
          // Last resort: read from db.json directly
          try {
            const dbCheck = JSON.parse(fs.readFileSync(path.join(appDataDir(), '9router', 'db.json'), 'utf-8'));
            const k = (dbCheck.apiKeys || []).find(k => k.isActive);
            if (k) apiKeyValue = k.key;
          } catch {}
        }

        return {
          success: true,
          apiKey: apiKeyValue || '(see 9router web UI)',
          selectedModel: picked,
        };
      } catch (apiErr) {
        // Fall through to legacy file-based approach if API path fails
        console.warn('[setup-9router-auto] API path failed, falling back to file mode:', apiErr.message);
      }
    }
    // (legacy file-based approach continues below as fallback)

    const { randomUUID, randomBytes } = require('crypto');
    const dbPath = path.join(appDataDir(), '9router', 'db.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Read existing or create fresh
    let db = {};
    if (fs.existsSync(dbPath)) {
      try { db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch (e) { console.warn('[setup-9router] db.json parse error:', e?.message); }
    }
    if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
    if (!Array.isArray(db.combos)) db.combos = [];
    if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
    if (!db.settings) db.settings = {};
    if (!Array.isArray(db.providerNodes)) db.providerNodes = [];
    if (!db.proxyPools) db.proxyPools = [];
    if (!db.modelAliases) db.modelAliases = {};
    if (!db.mitmAlias) db.mitmAlias = {};
    if (!db.pricing) db.pricing = {};

    // 1. Add Ollama provider — ONLY if user supplied a key. Don't touch
    //    existing providers the user may have configured directly via 9router
    //    web UI (ChatGPT Plus OAuth, Claude, Gemini, local Ollama, etc.).
    if (opts.ollamaKey) {
      db.providerConnections = db.providerConnections.filter(p => p.provider !== 'ollama');
      db.providerConnections.push({
        id: randomUUID(),
        provider: 'ollama',
        authType: 'apikey',
        name: 'Ollama',
        apiKey: opts.ollamaKey.trim(),
        priority: 1,
        isActive: true,
        testStatus: 'unknown',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      saveProviderKey('ollama', opts.ollamaKey.trim());
    }

    // 2. Combo 'main' handling — create if missing, leave existing alone.
    //    We'll auto-populate models below by querying 9router /v1/models AFTER
    //    restart, so whatever model the connected provider actually exposes
    //    gets picked. No hardcoding, no guessing model names that might be typos
    //    or stale (the old 'ollama/qwen3.5' hardcode failed this way).
    let combo = db.combos.find(c => c.name === 'main');
    let createdCombo = false;
    if (!combo) {
      combo = {
        id: randomUUID(),
        name: 'main',
        models: [], // Populated below from /v1/models
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      db.combos.push(combo);
      createdCombo = true;
    }

    // 3. Create API key
    let apiKey = db.apiKeys.find(k => k.isActive);
    if (!apiKey) {
      const machineId = randomBytes(8).toString('hex');
      const keyValue = `sk-${machineId}-modoro-${randomBytes(4).toString('hex')}`;
      apiKey = { id: randomUUID(), name: '9BizClaw', key: keyValue, machineId, isActive: true, createdAt: new Date().toISOString() };
      db.apiKeys.push(apiKey);
    }

    db.settings.comboStrategy = 'fallback';

    // Write db.json
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
    console.log('9Router db.json written:', db.providerConnections.length, 'providers,', db.combos.length, 'combos');

    // Restart 9Router to pick up new provider config
    stop9Router();
    await new Promise(r => setTimeout(r, 500));
    start9Router();

    // AUTO-DETECT MODELS: wait for 9Router to be ready, then query /v1/models
    // with our API key to see what models the connected providers actually
    // expose. Pick the first one and populate combo 'main' if it's empty.
    //
    // Why this instead of hardcoding (e.g. 'ollama/qwen3.5'):
    // - Hardcoded model names may not exist on the provider (CEO hit this
    //   with 'ollama/qwen3.5' which was a typo / stale name → 9router
    //   fallback → 404 openai)
    // - /v1/models returns the actual connected models, source of truth
    // - Respects whatever provider the user already has configured —
    //   if they had ChatGPT Plus OAuth before wizard, that provider's
    //   models get picked; if they pasted Ollama key now, Ollama models
    //   get picked. Provider-agnostic.
    //
    // If the query or pick fails, combo stays empty and user is directed
    // to the 9Router web UI to configure manually.
    let autoSelectedModel = null;
    let autoDetectError = null;
    if (createdCombo || !combo.models || combo.models.length === 0) {
      try {
        // Wait up to 15s for 9router to respond to /v1/models after restart.
        // Windows cold-start of 9router can take 10-12s on slower machines;
        // 8s was cutting it close and occasionally returned timeout → empty
        // combo → bot 404 on first real message.
        let modelsList = null;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            modelsList = await new Promise((resolve, reject) => {
              const req = require('http').request({
                hostname: '127.0.0.1', port: 20128, path: '/v1/models',
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey.key}` },
                timeout: 3000,
              }, (res) => {
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { buf += c; });
                res.on('end', () => {
                  if (res.statusCode !== 200) {
                    reject(new Error(`/v1/models returned ${res.statusCode}: ${buf.slice(0, 200)}`));
                    return;
                  }
                  try { resolve(JSON.parse(buf)); }
                  catch (e) { reject(new Error('invalid JSON from /v1/models: ' + e.message)); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(new Error('timeout')); });
              req.end();
            });
            break; // got a response
          } catch (e) {
            if (i === 14) throw e;
            // else keep retrying
          }
        }

        const modelIds = Array.isArray(modelsList?.data)
          ? modelsList.data.map(m => m && m.id).filter(Boolean)
          : [];
        console.log('[setup-9router-auto] /v1/models returned', modelIds.length, 'models:', modelIds.slice(0, 10));

        if (modelIds.length > 0) {
          // Smart model selection (same priority list as API path above)
          const PREFERRED_MODELS_FB = [
            'qwen3.5:397b', 'qwen3.5', 'deepseek-v3.2', 'deepseek-v3.1:671b',
            'glm-5.1', 'glm-5', 'mistral-large-3:675b', 'kimi-k2.5', 'kimi-k2:1t',
            'minimax-m2.7', 'minimax-m2.5', 'minimax-m2.1', 'minimax-m2',
            'gemma4:31b', 'gemma3:27b', 'gemma3:12b',
          ];
          let picked = null;
          for (const pref of PREFERRED_MODELS_FB) {
            picked = modelIds.find(id => id === pref || id.endsWith('/' + pref) || id.startsWith(pref));
            if (picked) break;
          }
          if (!picked && opts.ollamaKey) picked = modelIds.find(id => id.startsWith('ollama/'));
          if (!picked) picked = modelIds[0];

          // Re-read db.json in case 9router rewrote it during restart
          let currentDb;
          try { currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); }
          catch { currentDb = db; }
          const currentCombo = currentDb.combos.find(c => c.name === 'main');
          if (currentCombo) {
            if (!currentCombo.models || currentCombo.models.length === 0) {
              currentCombo.models = [picked];
              currentCombo.updatedAt = new Date().toISOString();
              fs.writeFileSync(dbPath, JSON.stringify(currentDb, null, 2), 'utf-8');
              // VERIFY: re-read db.json to confirm the write really persisted.
              // Zero-risk guarantee: if the file got rewritten by a racing
              // 9router process without our combo update, we want to know now,
              // not at first user message.
              let verified = false;
              try {
                const reRead = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
                const reCombo = reRead.combos?.find(c => c.name === 'main');
                verified = Array.isArray(reCombo?.models) && reCombo.models.includes(picked);
              } catch {}
              if (!verified) {
                autoDetectError = 'combo write verification failed — 9router may have overwritten our update';
                console.error('[setup-9router-auto]', autoDetectError);
              } else {
                autoSelectedModel = picked;
                console.log('[setup-9router-auto] auto-populated combo "main" with model:', picked, '(verified)');
                // Restart 9router one more time so it picks up the new combo
                stop9Router();
                await new Promise(r => setTimeout(r, 500));
                start9Router();
              }
            } else {
              autoSelectedModel = currentCombo.models[0];
              console.log('[setup-9router-auto] combo "main" already has models, leaving alone:', currentCombo.models);
            }
          } else {
            autoDetectError = 'combo "main" not found after restart';
          }
        } else {
          autoDetectError = 'no models returned by /v1/models — provider may have failed to connect';
        }
      } catch (e) {
        autoDetectError = 'auto-detect failed: ' + (e.message || String(e));
        console.warn('[setup-9router-auto]', autoDetectError);
      }
    }

    return {
      success: true,
      apiKey: apiKey.key,
      selectedModel: autoSelectedModel,
      autoDetectError,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// → cleanupOrphanZaloListener, ensureModoroZaloNodeModulesLink, ensureZaloPlugin,
// → seedZaloCustomersFromCache, findOpenzcaCliJs, seedGroupHistorySummary,
// → seedAllGroupHistories, checkZaloCookieAge, _ensureZaloPluginImpl
// → extracted to lib/zalo-plugin.js
// Setup Zalo — only runs QR login (fast), plugin already installed
ipcMain.handle('setup-zalo', async () => {
  try {
    _zaloLoginStartedAt = Date.now();

    // Delete old QR files
    for (const qr of [path.join(ctx.userDataDir, 'qr.png'), path.join(ELECTRON_DIR, 'qr.png'), path.join(ctx.resourceDir, 'qr.png'), path.join(process.cwd(), 'qr.png')]) {
      try { fs.unlinkSync(qr); } catch {}
    }

    // Run openzca auth login hidden — QR saved to known path
    const logsDir = path.join(ctx.userDataDir, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const qrSavePath = path.join(ctx.userDataDir, 'qr.png');
    const zaloLogFd = fs.openSync(path.join(logsDir, 'openzca.log'), 'a');
    // Spawn node directly — no CMD window. findGlobalPackageFile searches ALL
    // Node-manager lib dirs, not just the first existing one (the npmGlobalModules
    // shortcut breaks on mixed nvm/system Node setups).
    const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
    let zcaCmd, zcaArgs;
    if (zcaScript) {
      zcaCmd = findNodeBin() || 'node';
      zcaArgs = [zcaScript, 'auth', 'login', '--qr-path', qrSavePath];
    } else {
      // Fallback to PATH lookup. Use shell=true on Windows so .cmd shim resolves.
      zcaCmd = process.platform === 'win32' ? 'openzca.cmd' : 'openzca';
      zcaArgs = ['auth', 'login', '--qr-path', qrSavePath];
    }
    // Prevent openzca from auto-opening QR image in external viewer
    const zcaEnv = { ...process.env, OPENZCA_QR_OPEN: '0', OPENZCA_QR_AUTO_OPEN: '0' };
    const zaloProc = spawn(zcaCmd, zcaArgs, {
      stdio: ['ignore', zaloLogFd, zaloLogFd],
      detached: true,
      windowsHide: true,
      shell: process.platform === 'win32' && zcaCmd.endsWith('.cmd'),
      env: zcaEnv,
    });
    zaloProc.on('exit', () => { try { fs.closeSync(zaloLogFd); } catch {} });
    zaloProc.unref();
    return { success: true };
  } catch (e) {
    try { if (typeof zaloLogFd === 'number') fs.closeSync(zaloLogFd); } catch {}
    return { success: false, error: e.message };
  }
});

// Find QR image and return as base64 data URL (avoids CSP file:// issues)
ipcMain.handle('find-zalo-qr', async () => {
  const candidates = [
    path.join(ctx.userDataDir, 'qr.png'),
    path.join(ELECTRON_DIR, 'qr.png'),
    path.join(ctx.resourceDir, 'qr.png'),
    path.join(process.cwd(), 'qr.png'),
    path.join(ctx.HOME, 'qr.png'),
    path.join(ctx.HOME, '.openzca', 'qr.png'),
    path.join(ctx.HOME, '.openclaw', 'qr.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p);
      return 'data:image/png;base64,' + data.toString('base64');
    }
  }
  return null;
});

// Check if Zalo login succeeded (openzca stores session)
ipcMain.handle('check-zalo-login', async () => {
  try {
    const home = ctx.HOME;
    const sessionPaths = [
      path.join(home, '.openzca', 'profiles', 'default', 'credentials.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'creds.json'),
      path.join(home, '.openzca', 'profiles', 'default', 'session.json'),
      path.join(home, '.openzca', 'default', 'credentials.json'),
    ];
    for (const p of sessionPaths) {
      if (fs.existsSync(p)) {
        // Count as logged in if file was modified AFTER login started OR within
        // 5s tolerance (clock precision, filesystem timestamp rounding).
        const mtime = fs.statSync(p).mtimeMs;
        if (_zaloLoginStartedAt && mtime < _zaloLoginStartedAt - 5000) continue;
        return { loggedIn: true };
      }
    }
    // Also try openzca status command — use direct node path for reliability
    // (execFile with shell=false on Mac can't resolve PATH-based commands).
    try {
      const zcaScript = findGlobalPackageFile('openzca', 'dist/cli.js');
      if (zcaScript) {
        const nodeBin = findNodeBin() || 'node';
        const { stdout } = await execFilePromise(nodeBin, [zcaScript, 'auth', 'status'], { timeout: 5000, encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
        if (stdout.toLowerCase().includes('logged in') || stdout.toLowerCase().includes('authenticated')) return { loggedIn: true };
      }
    } catch {}
    return { loggedIn: false };
  } catch { return { loggedIn: false }; }
});

// Get current Zalo mode
ipcMain.handle('get-zalo-mode', async () => {
  try {
    const configPath = path.join(getWorkspace(), 'config', 'zalo-mode.txt');
    if (fs.existsSync(configPath)) return fs.readFileSync(configPath, 'utf-8').trim();
    return 'auto';
  } catch { return 'auto'; }
});

// Save Zalo mode to workspace config (read by AGENTS.md)
// ================================
// Shop State — "Tình trạng hôm nay"
// ================================
// CEO updates via Dashboard. Bot reads workspace/shop-state.json before each
// reply to know real-time shop state (out of stock, staff absent, shipping
// delay, active promotions, early closing, special notes).
// Note: no daily auto-reset cron — CEO clears fields manually via Dashboard
// "Xoá hết (bình thường)" button. May add cron in a later release.
ipcMain.handle('get-shop-state', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'shop-state.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-shop-state] error:', e?.message);
    return null;
  }
});
ipcMain.handle('set-shop-state', async (_event, state) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    const p = path.join(ws, 'shop-state.json');
    const payload = {
      updatedAt: new Date().toISOString(),
      updatedBy: 'CEO via Dashboard',
      ...(state || {}),
    };
    writeJsonAtomic(p, payload);
    syncShopStateToBootstrap();
    try { auditLog('shop_state_updated', { fields: Object.keys(state || {}).length }); } catch {}
    return { ok: true };
  } catch (e) {
    console.error('[set-shop-state] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

// ================================
// Persona Mix — Dashboard re-edit (post-wizard)
// ================================
// Dashboard has a "Tính cách bot" page where CEO can edit persona mix after
// wizard. These handlers bridge between Dashboard UI state and the 2 workspace
// files (active-persona.json + active-persona.md).
ipcMain.handle('get-persona-mix', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return null;
    const p = path.join(ws, 'active-persona.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[get-persona-mix] error:', e?.message);
    return null;
  }
});
ipcMain.handle('save-persona-mix', async (_event, mix) => {
  try {
    const ws = getWorkspace();
    if (!ws) return { ok: false, error: 'no workspace' };
    if (!mix || typeof mix !== 'object') return { ok: false, error: 'invalid mix' };
    const normalized = {
      voice: mix.voice || 'em-nu-tre',
      customer: mix.customer || 'anh-chi',
      traits: Array.isArray(mix.traits) ? mix.traits.slice(0, 5) : [],
      formality: Math.max(1, Math.min(10, parseInt(mix.formality, 10) || 5)),
      greeting: (mix.greeting || '').toString().slice(0, 300),
      closing: (mix.closing || '').toString().slice(0, 300),
      phrases: (mix.phrases || '').toString().slice(0, 1000),
    };
    const jsonPath = path.join(ws, 'active-persona.json');
    const mdPath = path.join(ws, 'active-persona.md');
    writeJsonAtomic(jsonPath, normalized);
    fs.writeFileSync(mdPath, compilePersonaMix(normalized), 'utf-8');
    syncPersonaToBootstrap();
    try { auditLog('persona_mix_updated', { voice: normalized.voice, traits: normalized.traits.length, formality: normalized.formality }); } catch {}
    console.log('[save-persona-mix] updated via Dashboard');
    return { ok: true };
  } catch (e) {
    console.error('[save-persona-mix] error:', e?.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-zalo-mode', async (_event, mode) => {
  try {
    const ws = getWorkspace();
    const configPath = path.join(ws, 'config', 'zalo-mode.txt');
    fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
    fs.writeFileSync(configPath, mode, 'utf-8');

    // Also update AGENTS.md Zalo section based on mode
    const agentsPath = path.join(ws, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      let content = fs.readFileSync(agentsPath, 'utf-8');
      // Replace Zalo mode marker if exists, or add after Zalo section header
      const modeText = mode === 'auto'
        ? '**Chế độ: Tự động trả lời.** Trợ lý tự reply khách hàng. Vấn đề phức tạp escalate qua Telegram.'
        : mode === 'read'
        ? '**Chế độ: Chỉ đọc.** KHÔNG tự trả lời trên Zalo. Đọc tin nhắn và báo qua Telegram cho CEO. CEO quyết định trả lời.'
        : '**Chế độ: Tóm tắt cuối ngày.** KHÔNG tự trả lời. Đọc tất cả tin nhắn trong ngày, gửi bản tổng hợp qua Telegram 1 lần vào cuối ngày.';

      if (content.includes('**Chế độ:')) {
        content = content.replace(/\*\*Chế độ:.*?\*\*/s, modeText.split('**')[1] ? modeText : modeText);
        // Simpler: replace the whole mode line
        content = content.replace(/\*\*Chế độ:.*$/m, modeText);
      } else if (content.includes('### Zalo (kênh khách hàng/nhân viên)')) {
        content = content.replace(
          '### Zalo (kênh khách hàng/nhân viên)\n',
          `### Zalo (kênh khách hàng/nhân viên)\n\n${modeText}\n`
        );
      }
      fs.writeFileSync(agentsPath, content, 'utf-8');
    }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  ZALO MANAGER — Group whitelist + User blacklist
// ============================================
// getZcaProfile, getZcaCacheDir, getZcaCacheDirForProfile,
// readZaloChannelState, isZaloTargetAllowed, isKnownZaloTarget
// → extracted to lib/zalo-memory.js


// Friends cache state + invalidateZaloFriendsCache → extracted to lib/zalo-memory.js
ipcMain.handle('list-zalo-friends', async () => {
  try {
    const now = Date.now();
    const { cache, cacheAt, ttl } = getZaloFriendsCached();
    if (cache && (now - cacheAt) < ttl) {
      return cache;
    }
    const p = path.join(getZcaCacheDir(), 'friends.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Normalize — only return fields the UI needs
    const result = (Array.isArray(data) ? data : []).map(f => ({
      userId: String(f.userId || f.userKey || ''),
      displayName: f.displayName || f.zaloName || f.username || '(không tên)',
      avatar: f.avatar || '',
      phoneNumber: f.phoneNumber || '',
      isFriend: f.isFr === 1,
      isBlocked: f.isBlocked === 1,
    })).filter(f => f.userId);
    setZaloFriendsCached(result);
    return result;
  } catch (e) {
    console.error('[zalo] list friends error:', e.message);
    return [];
  }
});

// runZaloCacheRefresh + cache refresh state → extracted to lib/zalo-memory.js
// startZaloCacheAutoRefresh + _zaloCacheInterval → extracted to lib/zalo-memory.js

// Trigger openzca to refresh its cache from live Zalo server (manual)
ipcMain.handle('refresh-zalo-cache', async () => {
  try {
    const result = await runZaloCacheRefresh({ source: 'manual' });
    if (result?.ok) {
      try { seedZaloCustomersFromCache(); } catch (e) { console.warn('[zalo-cache] post-refresh account sync failed:', e?.message || e); }
    }
    return {
      success: !!result?.ok,
      skipped: !!result?.skipped,
      rateLimited: !!result?.rateLimited,
      retryAfterSec: result?.retryAfterSec || 0,
      error: result?.error || null,
    };
  } catch (e) {
    console.error('[zalo-cache] refresh error:', e?.message);
    return { success: false, error: e?.message || 'refresh failed' };
  }
});

ipcMain.handle('list-zalo-groups', async () => {
  try {
    const p = path.join(getZcaCacheDir(), 'groups.json');
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (Array.isArray(data) ? data : []).map(g => ({
      groupId: String(g.groupId || g.id || ''),
      name: g.name || g.groupName || '(không tên)',
      avatar: g.avatar || g.groupAvatar || g.avt || g.fullAvt || '',
      memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || (g.memVerList?.length) || 0,
      desc: g.desc || '',
      createdTime: g.createdTime || 0,
    })).filter(g => g.groupId);
  } catch (e) {
    console.error('[zalo] list groups error:', e.message);
    return [];
  }
});

// === Zalo per-user memory ===
// getZaloUsersDir, ensureZaloUsersDir, sanitizeZaloUserId, parseZaloUserMemoryMeta
// → extracted to lib/zalo-memory.js

ipcMain.handle('list-zalo-user-memories', async () => {
  try {
    const dir = getZaloUsersDir();
    if (!dir || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    const out = [];
    for (const f of files) {
      try {
        const senderId = f.replace(/\.md$/, '');
        const filePath = path.join(dir, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const meta = parseZaloUserMemoryMeta(content);
        out.push({
          senderId,
          name: meta.name,
          lastSeen: meta.lastSeen || stat.mtime.toISOString(),
          msgCount: meta.msgCount,
          gender: meta.gender,
          summary: meta.summary,
          mtimeMs: stat.mtimeMs,
        });
      } catch {}
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  } catch (e) {
    console.error('[zalo-user-memory] list error:', e?.message);
    return [];
  }
});

ipcMain.handle('read-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { exists: false, content: '' };
    const dir = getZaloUsersDir();
    if (!dir) return { exists: false, content: '' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { exists: false, content: '' };
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseZaloUserMemoryMeta(content);
    return { exists: true, content, meta };
  } catch (e) {
    console.error('[zalo-user-memory] read error:', e?.message);
    return { exists: false, content: '', error: e.message };
  }
});

ipcMain.handle('reset-zalo-user-memory', async (_event, { senderId }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const dir = getZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { success: true };
    // Move to .archive/<id>-<ts>.md instead of deleting (audit trail)
    const archDir = path.join(dir, '.archive');
    fs.mkdirSync(archDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archPath = path.join(archDir, id + '-' + ts + '.md');
    fs.renameSync(filePath, archPath);
    return { success: true };
  } catch (e) {
    console.error('[zalo-user-memory] reset error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('append-zalo-user-note', async (_event, { senderId, note }) => {
  try {
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid id' };
    const cleanNote = String(note || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 2000);
    if (!cleanNote) return { success: false, error: 'empty note' };
    const dir = ensureZaloUsersDir();
    if (!dir) return { success: false, error: 'no workspace' };
    const filePath = path.join(dir, id + '.md');
    return await withMemoryFileLock(filePath, () => {
      let content = '';
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
      } else {
        content = `---\nname: \nlastSeen: ${new Date().toISOString()}\nmsgCount: 0\ngender: unknown\n---\n# Khách Zalo ${id}\n\n## Tóm tắt\n(Chưa có dữ liệu)\n\n## CEO notes\n`;
      }
      if (!content.includes('## CEO notes')) {
        content = content.replace(/$/, '\n\n## CEO notes\n');
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      content = content.replace(/(## CEO notes\s*\n)/, `$1- **${stamp}** — ${cleanNote}\n`);
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    }, { senderId: id, action: 'append-ceo-note', source: 'dashboard-ipc' });
  } catch (e) {
    console.error('[zalo-user-memory] append note error:', e?.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('delete-zalo-user-note', async (_event, { senderId, noteTimestamp }) => {
  try {
    if (!senderId || !noteTimestamp) return { success: false, error: 'missing params' };
    const id = sanitizeZaloUserId(senderId);
    if (!id) return { success: false, error: 'invalid senderId' };
    const dir = getZaloUsersDir();
    if (!dir) return { success: false, error: 'workspace not ready' };
    const filePath = path.join(dir, id + '.md');
    if (!fs.existsSync(filePath)) return { success: false, error: 'file not found' };
    return await withMemoryFileLock(filePath, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const escapedTs = noteTimestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lineRegex = new RegExp('^- \\*\\*' + escapedTs + '\\*\\*.*$\\n?', 'm');
      const newContent = content.replace(lineRegex, '');
      if (newContent === content) return { success: false, error: 'note not found' };
      fs.writeFileSync(filePath, newContent, 'utf-8');
      return { success: true };
    }, { senderId: id, action: 'delete-ceo-note', source: 'dashboard-ipc' });
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// === Zalo group memory ===
// getZaloGroupsDir → extracted to lib/zalo-memory.js

ipcMain.handle('get-zalo-group-summaries', async () => {
  try {
    const dir = getZaloGroupsDir();
    if (!dir || !fs.existsSync(dir)) return {};
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const summaries = {};
    for (const f of files) {
      const groupId = f.replace('.md', '');
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        // Extract key sections from the group memory file
        const lines = content.split('\n');
        let topics = '', members = '', decisions = '';
        let currentSection = '';
        for (const line of lines) {
          if (line.startsWith('## Chủ đề thường thảo luận')) { currentSection = 'topics'; continue; }
          if (line.startsWith('## Thành viên key')) { currentSection = 'members'; continue; }
          if (line.startsWith('## Quyết định/thông báo')) { currentSection = 'decisions'; continue; }
          if (line.startsWith('## ') || line.startsWith('---')) { currentSection = ''; continue; }
          const trimmed = line.trim();
          if (!trimmed || trimmed === '(chưa có)') continue;
          if (currentSection === 'topics') topics += (topics ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'members') members += (members ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
          if (currentSection === 'decisions') decisions += (decisions ? ', ' : '') + trimmed.replace(/^[-*]\s*/, '');
        }
        summaries[groupId] = {
          topics: topics.slice(0, 120) || '',
          members: members.slice(0, 120) || '',
          decisions: decisions.slice(0, 120) || '',
          hasContent: !!(topics || members || decisions),
        };
      } catch {}
    }
    return summaries;
  } catch (e) {
    console.error('[zalo-group-memory] error:', e?.message);
    return {};
  }
});

// Read full group memory file for display in Dashboard modal.
ipcMain.handle('get-zalo-group-memory', async (_evt, groupId) => {
  try {
    if (!groupId || typeof groupId !== 'string' || /[\/\\.]/.test(groupId)) return { content: '', exists: false };
    const dir = getZaloGroupsDir();
    if (!dir) return { content: '', exists: false };
    const fp = path.join(dir, groupId + '.md');
    if (!fs.existsSync(fp)) return { content: '', exists: false };
    return { content: fs.readFileSync(fp, 'utf-8'), exists: true };
  } catch (e) {
    return { content: '', exists: false, error: e?.message };
  }
});

// Manually re-seed a single group's history summary (dashboard "refresh context").
// Returns { ok, reason, msgCount? }.
ipcMain.handle('seed-group-history-now', async (_evt, groupId, threadName, opts = {}) => {
  try {
    if (!groupId || typeof groupId !== 'string' || /[\/\\.]/.test(groupId)) return { ok: false, reason: 'invalid-groupId' };
    return await seedGroupHistorySummary(groupId, threadName || groupId, opts || {});
  } catch (e) {
    return { ok: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// Manually trigger batch re-seed across all groups (CEO "refresh all group context").
// Fire-and-forget: returns immediately with started=true, run continues in background.
ipcMain.handle('seed-group-history-all', async () => {
  try {
    // Kick off in background, return immediately so dashboard isn't blocked.
    // seedAllGroupHistories has its own in-flight guard internally.
    seedAllGroupHistories({ source: 'ipc-manual' }).catch(e => {
      console.warn('[group-history-seed] manual run error:', e && e.message ? e.message : String(e));
    });
    return { started: true };
  } catch (e) {
    return { started: false, reason: 'exception: ' + (e && e.message ? e.message : String(e)) };
  }
});

// REMOVED: Zalo owner identification — owner/chủ nhân feature fully removed.
// All Zalo messages are treated as customer messages uniformly.

// === Zalo Menu feature DISABLED for v2.4.10 client release ===
// Reason: catalog editor not finalized, not reviewed for client-facing usage.
// All 7 IPC handlers short-circuit to a disabled response. UI sub-tab also hidden.
// To re-enable: flip ZALO_MENU_DISABLED to false (and unhide the sub-tab in dashboard.html).
const ZALO_MENU_DISABLED = true;
function _zaloMenuDisabledResponse() {
  return { success: false, ok: false, disabled: true, error: 'Tính năng Menu Zalo đang phát triển, sẽ mở trong bản cập nhật sau.' };
}

ipcMain.handle('get-zalo-menu-catalog', async () => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    return { success: true, catalog: zaloMenu.loadCatalog() };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('save-zalo-menu-catalog', async (_evt, catalog) => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const result = zaloMenu.saveCatalog(catalog || {});
    return { success: result.ok, ...result };
  } catch (e) {
    return { success: false, ok: false, error: e?.message || String(e), errors: [e?.message || String(e)] };
  }
});

ipcMain.handle('dry-run-zalo-menu-command', async (_evt, payload) => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const command = payload && typeof payload === 'object' ? payload.command : payload;
    let catalog;
    if (payload && typeof payload === 'object' && payload.catalog) {
      const checked = zaloMenu.validateCatalog(payload.catalog);
      if (!checked.ok) return { success: false, handled: false, errors: checked.errors, error: checked.errors.join('; ') };
      catalog = checked.catalog;
    }
    return { success: true, ...zaloMenu.dryRunCommand(command, catalog) };
  } catch (e) {
    return { success: false, handled: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('download-zalo-menu-template', async () => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const parentWin = BrowserWindow?.getFocusedWindow?.() || ctx.mainWindow || null;
    const saveRes = await dialog.showSaveDialog(parentWin, {
      title: 'Tải mẫu XLSX menu Zalo',
      defaultPath: 'zalo-menu-template.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) return { success: false, canceled: true };
    fs.writeFileSync(saveRes.filePath, zaloMenu.buildTemplateWorkbookBuffer());
    return { success: true, fileName: path.basename(saveRes.filePath) };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('pick-zalo-menu-import', async () => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const parentWin = BrowserWindow?.getFocusedWindow?.() || ctx.mainWindow || null;
    const result = await dialog.showOpenDialog(parentWin, {
      title: 'Import XLSX menu Zalo',
      properties: ['openFile'],
      filters: [
        { name: 'Excel Workbook', extensions: ['xlsx'] },
      ],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    return { success: true, token: createZaloMenuImportToken(filePath), fileName: path.basename(filePath) };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('preview-zalo-menu-import', async (_evt, token) => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const filePath = resolveZaloMenuImportToken(token);
    const result = zaloMenu.previewImport(filePath);
    return { success: result.ok, ...result };
  } catch (e) {
    return { success: false, ok: false, error: e?.message || String(e), errors: [e?.message || String(e)] };
  }
});

ipcMain.handle('apply-zalo-menu-import', async (_evt, token) => {
  if (ZALO_MENU_DISABLED) return _zaloMenuDisabledResponse();
  try {
    const filePath = resolveZaloMenuImportToken(token, true);
    const result = zaloMenu.applyImport(filePath);
    return { success: result.ok, ...result };
  } catch (e) {
    return { success: false, ok: false, error: e?.message || String(e), errors: [e?.message || String(e)] };
  }
});


// === Security Layer 1 (scoped) — File permission hardening ===
// Real Layer 1 (DPAPI/Keychain encryption) is high-risk because decryption
// failure = bot can't boot. Until we have a battle-tested decryption shim,
// scoped Layer 1 protects sensitive files at the FILESYSTEM level only:
// chmod 600 (owner-only read/write) on Unix. Windows NTFS already inherits
// per-user ACL from `C:\Users\<user>\` so no additional work needed there.
//
// Files protected:
// getZaloBlocklistPath + cleanBlocklist → extracted to lib/zalo-memory.js

ipcMain.handle('get-zalo-manager-config', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    let zalo = {};
    if (fs.existsSync(configPath)) {
      const cfg = readOpenclawJsonFile(configPath);
      zalo = cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo || {};
    }
    let blocklist = [];
    const bp = getZaloBlocklistPath();
    if (fs.existsSync(bp)) {
      try { blocklist = JSON.parse(fs.readFileSync(bp, 'utf-8')); } catch (e) { console.warn('[zalo-manager] blocklist parse error:', e?.message); }
    }
    let allowlist = [];
    const ap = getZaloAllowlistPath();
    if (ap && fs.existsSync(ap)) {
      try { allowlist = JSON.parse(fs.readFileSync(ap, 'utf-8')); } catch (e) { console.warn('[zalo-manager] allowlist parse error:', e?.message); }
    }
    let groupSettings = {};
    try {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      if (fs.existsSync(gsPath)) groupSettings = JSON.parse(fs.readFileSync(gsPath, 'utf-8'));
    } catch (e) { console.warn('[zalo-manager] groupSettings parse error:', e?.message); }
    let userSettings = {};
    try {
      const usPath = path.join(getWorkspace(), 'zalo-user-settings.json');
      if (fs.existsSync(usPath)) userSettings = JSON.parse(fs.readFileSync(usPath, 'utf-8'));
    } catch (e) { console.warn('[zalo-manager] userSettings parse error:', e?.message); }
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (fs.existsSync(spPath)) strangerPolicy = JSON.parse(fs.readFileSync(spPath, 'utf-8')).mode || 'ignore';
    } catch (e) { console.warn('[zalo-manager] strangerPolicy parse error:', e?.message); }
    return {
      enabled: zalo.enabled !== false,
      groupPolicy: zalo.groupPolicy || 'open',
      groupAllowFrom: Array.isArray(zalo.groupAllowFrom) ? zalo.groupAllowFrom.filter(x => x !== '*') : [],
      dmPolicy: zalo.dmPolicy || 'open',
      userBlocklist: normalizeZaloBlocklist(blocklist),
      userAllowlist: Array.isArray(allowlist) ? allowlist.map(x => String(x || '').trim()).filter(Boolean) : [],
      groupSettings,
      userSettings,
      strangerPolicy,
    };
  } catch (e) {
    return { enabled: false, groupPolicy: 'open', groupAllowFrom: [], dmPolicy: 'open', userBlocklist: [] };
  }
});

// Merge incoming per-user internal flags into zalo-user-settings.json.
// Sanitizes to `{ internal: true }` only; deletes entries where internal !== true.
// Emits audit log on each diff. Skips write if result is empty AND file doesn't
// exist yet (avoids stub file on fresh install when CEO hasn't touched feature).
function _mergeUserSettingsFile(userSettings) {
  if (!userSettings || typeof userSettings !== 'object' || Array.isArray(userSettings)) return;
  const usPath = path.join(getWorkspace(), 'zalo-user-settings.json');
  let existingUs = {};
  try {
    if (fs.existsSync(usPath)) existingUs = JSON.parse(fs.readFileSync(usPath, 'utf-8')) || {};
    if (typeof existingUs !== 'object' || Array.isArray(existingUs)) existingUs = {};
  } catch {}
  let oldExistingUs = {};
  try { oldExistingUs = JSON.parse(JSON.stringify(existingUs)); } catch {}
  for (const [uid, us] of Object.entries(userSettings)) {
    if (!us || typeof us !== 'object') continue;
    if (us.internal === true) {
      existingUs[uid] = { internal: true };
    } else {
      delete existingUs[uid];
    }
  }
  try {
    const allUids = new Set([...Object.keys(oldExistingUs), ...Object.keys(existingUs)]);
    for (const uid of allUids) {
      const wasInternal = oldExistingUs[uid]?.internal === true;
      const isInternal = existingUs[uid]?.internal === true;
      if (wasInternal !== isInternal) {
        auditLog('user-internal-change', { userId: uid, internal: isInternal, ts: Date.now() });
      }
    }
  } catch {}
  // Mirror groupSettings: don't create empty stub file.
  if (Object.keys(existingUs).length > 0 || fs.existsSync(usPath)) {
    writeJsonAtomic(usPath, existingUs);
  }
}

// Merge CEO group-mode settings into the on-disk `existing` map (mutated in place).
// An entry carrying only `internal` (no explicit mode) inherits __default.mode instead
// of being dropped — otherwise marking a default-mode group "Nội bộ" is silently lost
// (2026-06 bug). Shared by both group-settings save paths so the fix can't drift.
function _mergeGroupSettingsIntoExisting(groupSettings, existing) {
  const dflt = (groupSettings.__default && ['off', 'mention', 'all'].includes(groupSettings.__default.mode))
    ? groupSettings.__default.mode
    : ((existing.__default && existing.__default.mode) || 'off');
  for (const [gid, gs] of Object.entries(groupSettings)) {
    if (!gs || typeof gs !== 'object') continue;
    const validMode = ['off', 'mention', 'all'].includes(gs.mode);
    if (!validMode && gs.internal !== true) continue; // empty/garbage entry
    const sanitized = { mode: validMode ? gs.mode : dflt };
    if (gs.internal === true) sanitized.internal = true;
    existing[gid] = sanitized;
  }
}

function saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, userAllowlist, userAllowlistTouched, groupSettings, userSettings, strangerPolicy }) {
  const bp = getZaloBlocklistPath();
  let existingBl = [];
  try {
    if (bp && fs.existsSync(bp)) existingBl = JSON.parse(fs.readFileSync(bp, 'utf-8'));
  } catch {}

  const blocklistSave = resolveZaloBlocklistSave({
    existingBlocklist: existingBl,
    incomingBlocklist: userBlocklist,
    userBlocklistTouched: userBlocklistTouched === true,
  });

  if (bp && blocklistSave.preservedExisting) {
    console.warn(`[save-zalo-manager] incoming blocklist empty while file has ${blocklistSave.blocklist.length} entries; preserving existing friend settings`);
    try { fs.copyFileSync(bp, bp + '.bak'); } catch {}
  } else if (bp && (blocklistSave.shouldWrite || !fs.existsSync(bp))) {
    writeJsonAtomic(bp, blocklistSave.blocklist);
  }

  // Allowlist (v2.4.4+): explicit list of friends CEO turned ON
  if (userAllowlistTouched) {
    const ap = getZaloAllowlistPath();
    if (ap) {
      const al = Array.isArray(userAllowlist) ? userAllowlist.map(x => String(x || '').trim()).filter(Boolean) : [];
      writeJsonAtomic(ap, al);
    }
  }

  if (groupSettings && typeof groupSettings === 'object') {
    const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
    let existing = {};
    try {
      if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {};
      if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    } catch {}
    let oldExisting = {};
    try { oldExisting = JSON.parse(JSON.stringify(existing)); } catch {}
    _mergeGroupSettingsIntoExisting(groupSettings, existing);
    try {
      for (const gid of Object.keys(existing)) {
        const wasInternal = oldExisting[gid]?.internal === true;
        const isInternal = existing[gid]?.internal === true;
        if (wasInternal !== isInternal) {
          auditLog('group-internal-change', { groupId: gid, internal: isInternal, ts: Date.now() });
        }
      }
    } catch {}
    if (Object.keys(existing).length > 0) {
      writeJsonAtomic(gsPath, existing);
    }
  }

  _mergeUserSettingsFile(userSettings);

  if (strangerPolicy !== undefined) {
    const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
    if (strangerPolicy) {
      writeJsonAtomic(spPath, { mode: strangerPolicy });
    } else if (fs.existsSync(spPath)) {
      try { fs.unlinkSync(spPath); } catch {}
    }
  }

  try {
    saveActiveZaloAccountSettings({ workspace: getWorkspace() });
  } catch (e) {
    console.warn('[zalo-account] snapshot save after manager update failed:', e?.message || e);
  }

  return { blocklistLength: blocklistSave.blocklist.length };
}

async function forceDisableZaloFailClosed(source = 'manager-disabled') {
  const pauseOk = setChannelPermanentPause('zalo', source);
  let configOk = false;
  let stickyOk = false;
  try {
    await withOpenClawConfigLock(async () => {
      const openclawDir = path.join(ctx.HOME, '.openclaw');
      try { fs.mkdirSync(openclawDir, { recursive: true }); } catch {}
      try {
        writeJsonAtomic(path.join(openclawDir, 'modoroclaw-sticky-zalo-enabled.json'), {
          enabled: false,
          ts: Date.now(),
          source,
        });
        stickyOk = true;
      } catch (e) {
        console.warn('[zalo] fail-closed sticky write error:', e?.message);
      }

      const configPath = path.join(openclawDir, 'openclaw.json');
      if (!fs.existsSync(configPath)) return;
      const cfg = readOpenclawJsonFile(configPath);
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels['modoro-zalo'] || typeof cfg.channels['modoro-zalo'] !== 'object') cfg.channels['modoro-zalo'] = {};
      cfg.channels['modoro-zalo'].enabled = false;
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') cfg.plugins.entries['modoro-zalo'] = {};
      cfg.plugins.entries['modoro-zalo'].enabled = false;
      writeOpenClawConfigIfChanged(configPath, cfg);
      configOk = true;
    });
  } catch (e) {
    console.error('[zalo] fail-closed disable error:', e?.message || e);
  }
  try { auditLog('zalo_fail_closed_disabled', { source, pauseOk, configOk, stickyOk }); } catch {}
  return { pauseOk, configOk, stickyOk };
}

ipcMain.handle('save-zalo-manager-config', async (_event, { enabled, groupPolicy, groupAllowFrom, userBlocklist, userBlocklistTouched, userAllowlist, userAllowlistTouched, groupSettings, userSettings, strangerPolicy }) => {
  invalidateZaloFriendsCache(); // PERF: bust friends cache on config save
  const booting = rejectIfBooting('save-zalo-manager-config');
  if (booting) {
    if (enabled === false) {
      ctx.ipcInFlightCount++;
      try {
        const realtime = saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, userAllowlist, userAllowlistTouched, groupSettings, userSettings, strangerPolicy });
        const off = await forceDisableZaloFailClosed('manager-disabled-while-booting');
        return {
          success: off.pauseOk || off.configOk || off.stickyOk,
          booting: true,
          pendingRestart: true,
          blocklistLength: realtime.blocklistLength,
          message: 'Đã tắt Zalo ngay. App đang khởi động nên gateway sẽ áp dụng đầy đủ sau khi xong.',
        };
      } finally {
        ctx.ipcInFlightCount--;
      }
    }
    if (userBlocklistTouched === true || userAllowlistTouched === true || groupSettings || userSettings || strangerPolicy !== undefined) {
      if (enabled !== false && isZaloChannelEnabled() === false) return booting;
      ctx.ipcInFlightCount++;
      try {
        const realtime = saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, userAllowlist, userAllowlistTouched, groupSettings, userSettings, strangerPolicy });
        return {
          success: true,
          booting: true,
          realtimeOnly: true,
          blocklistLength: realtime.blocklistLength,
          message: 'Đã lưu danh sách Zalo. Bot đang khởi động nên phần bật/tắt kênh sẽ áp dụng sau.',
        };
      } finally {
        ctx.ipcInFlightCount--;
      }
    }
    return booting;
  }
  // Double-click guard: a rapid 2nd save before the 1st completes would
  // read the same prev snapshot, both compute identical diffs, both try
  // to restart gateway → two concurrent stopOpenClaw calls racing.
  if (_saveZaloManagerInFlight) {
    return { success: false, error: 'Lưu đang chạy — thử lại sau 1-2 giây' };
  }
  _saveZaloManagerInFlight = true;
  ctx.ipcInFlightCount++;
  // [A2] Serialize concurrent openclaw.json writers with config mutex.
  try {
  return await withOpenClawConfigLock(async () => {
    console.log('[config-lock] save-zalo-manager-config acquired');
    // Detect whether `channels['modoro-zalo'].enabled` actually changes. Only this
    // field needs a hard gateway restart (stop+wait+start) because it
    // controls whether openclaw loads the modoro-zalo plugin + spawns the
    // openzca listener subprocess at all. All other fields (blocklist,
    // groupSettings, strangerPolicy) are read realtime by inbound.ts patches
    // so zero restart is needed for them.
    let prevEnabled = null;
    try {
      const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = readOpenclawJsonFile(configPath);
        prevEnabled = (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled !== false;
      }
    } catch {}
    const newEnabled = enabled !== false;
    const enabledChanged = (prevEnabled !== null) && (prevEnabled !== newEnabled);

    // 1. Update openclaw.json (groups handled natively by OpenZalo)
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const cfg = readOpenclawJsonFile(configPath);
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels['modoro-zalo']) cfg.channels['modoro-zalo'] = {};
      cfg.channels['modoro-zalo'].enabled = enabled !== false;
      // ALWAYS keep native gate open — let code-level patch in inbound.ts
      // handle group filtering via zalo-group-settings.json (realtime, no restart).
      // Setting allowlist here blocks groups at the native gate BEFORE our
      // patches run, making Dashboard group toggle useless.
      cfg.channels['modoro-zalo'].groupPolicy = 'open';
      cfg.channels['modoro-zalo'].groupAllowFrom = ['*'];
      // CRITICAL: modoro-zalo plugin defaults dmPolicy to "pairing" → unknown DM
      // sender → "OpenClaw: access not configured." pairing reply. We always
      // want CEO + their contacts to DM the bot directly without pairing dance.
      // Force dmPolicy="open" + allowFrom=["*"] every save so wizard/manager
      // never leaves these unset (which would re-trigger pairing on next boot).
      cfg.channels['modoro-zalo'].dmPolicy = 'open';
      if (!Array.isArray(cfg.channels['modoro-zalo'].allowFrom)) {
        cfg.channels['modoro-zalo'].allowFrom = ['*'];
      }
      // CRIT #5: zalo-group-settings.json is single source of truth —
      // inbound.ts GROUP-SETTINGS PATCH v3 handles off/mention/all modes
      // realtime. Purge any legacy groups[gid] entries from openclaw.json.
      if (cfg.channels['modoro-zalo'].groups) delete cfg.channels['modoro-zalo'].groups;
      // Also sync plugins.entries['modoro-zalo'].enabled with channels['modoro-zalo'].enabled
      // so "Tắt Zalo" is a real hard-off (gateway won't even load plugin
      // on next boot). ensureDefaultConfig syncs this too but doing it here
      // ensures the in-memory flip propagates immediately.
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.entries) cfg.plugins.entries = {};
      if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') {
        cfg.plugins.entries['modoro-zalo'] = {};
      }
      cfg.plugins.entries['modoro-zalo'].enabled = newEnabled;
      writeOpenClawConfigIfChanged(configPath, cfg);
    }
    let gateOk = true;
    if (enabled === false) gateOk = setChannelPermanentPause('zalo', 'manager-disabled');
    else {
      gateOk = clearChannelPermanentPause('zalo');
      markOnboardingComplete('zalo-manager-enable');
    }
    // 2. Workspace files are read realtime by inbound.ts patches. The helper
    // preserves an existing friend blocklist when autosave sends an untouched [].
    saveZaloRealtimeManagerFiles({ userBlocklist, userBlocklistTouched, userAllowlist, userAllowlistTouched, groupSettings, strangerPolicy });
    // 3. CRIT #5: Persist ALL explicit modes (off/mention/all) — zalo-group-settings.json
    // is the single source of truth used by GROUP-SETTINGS PATCH v2. If user
    // sets 'mention' in Dashboard we must persist it so the patch enforces
    // @mention gating (not modoro-zalo native which we bypassed above).
    //
    // CRITICAL FIX (user report 2026-04-17): Previously this REPLACED the
    // whole file on every save, and DELETED it if incoming groupSettings was
    // empty. That caused settings to be wiped whenever Dashboard sent partial
    // or empty state (e.g., user saves with only stranger policy changed →
    // groupSettings unchanged in UI but sent as-is → wiped other modes).
    //
    // New behavior: MERGE incoming into existing. Never delete file on empty
    // input. User's only way to reset a mode is to change it explicitly via
    // the dropdown.
    if (groupSettings && typeof groupSettings === 'object') {
      const gsPath = path.join(getWorkspace(), 'zalo-group-settings.json');
      let existing = {};
      try {
        if (fs.existsSync(gsPath)) existing = JSON.parse(fs.readFileSync(gsPath, 'utf-8')) || {};
        if (typeof existing !== 'object' || Array.isArray(existing)) existing = {};
      } catch {}
      // Read old file for audit diff before mutating
      let oldExisting = {};
      try { oldExisting = JSON.parse(JSON.stringify(existing)); } catch {}
      _mergeGroupSettingsIntoExisting(groupSettings, existing);
      // Audit log internal flag changes
      try {
        for (const gid of Object.keys(existing)) {
          const wasInternal = oldExisting[gid]?.internal === true;
          const isInternal = existing[gid]?.internal === true;
          if (wasInternal !== isInternal) {
            auditLog('group-internal-change', { groupId: gid, internal: isInternal, ts: Date.now() });
          }
        }
      } catch {}
      if (Object.keys(existing).length > 0) {
        writeJsonAtomic(gsPath, existing);
      }
    }
    // 3b. User settings (per-friend internal flag) — mirror group settings.
    // CEO marks 1-on-1 friend as internal employee → DM grants same trust as
    // being in an internal group (RAG internal-tier docs, command-block bypass).
    _mergeUserSettingsFile(userSettings);
    // 4. Write stranger policy to workspace — mirror groupSettings pattern:
    // if no explicit strangerPolicy provided, REMOVE file so patch falls back
    // to plugin default (prevents stale policy file leaking after CEO clears
    // the field in Dashboard).
    if (strangerPolicy !== undefined) {
      const spPath = path.join(getWorkspace(), 'zalo-stranger-policy.json');
      if (strangerPolicy) {
        writeJsonAtomic(spPath, { mode: strangerPolicy });
      } else if (fs.existsSync(spPath)) {
        try { fs.unlinkSync(spPath); } catch {}
      }
    }
    // 5. Hard gateway restart ONLY when modoro-zalo enabled flag actually flipped.
    // This is the only field that requires full gateway reload — the plugin
    // loader decides at boot whether to register modoro-zalo + spawn openzca
    // listener subprocess. Toggling it without a restart means:
    //   disable → plugin still loaded, listener still running (memory leak)
    //   enable  → plugin NOT loaded (it was disabled at boot), no listener
    //             → Dashboard shows green but customers get silence
    // Proper restart pattern: stopOpenClaw + wait + startOpenClaw.
    // startOpenClaw alone is a no-op when ctx.botRunning=true, so we MUST stop first.
    //
    // [restart-guard A1] Set ctx.gatewayRestartInFlight BEFORE the IIFE starts so
    // the fast watchdog (which also polls every 20s) will skip its
    // own restart attempt if it fires while we're mid-sequence. Clear in the
    // IIFE's finally only.
    if (enabledChanged) {
      // [zalo-watchdog rearm] CEO toggling Zalo enabled/disabled rearms the
      // listener watchdog. Config flip means CEO has deliberately changed
      // channel state — prior gave-up / restart streak is stale. Reset all 3.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      if (ctx.startOpenClawInFlight) {
        console.log(`[save-zalo-manager] channels.modoro-zalo.enabled ${prevEnabled}→${newEnabled} — gateway spawn in progress, skip restart (will read new config)`);
      } else if (ctx.gatewayRestartInFlight) {
        console.log('[restart-guard] save-zalo-manager: restart already in-flight — skipping duplicate');
      } else {
        ctx.gatewayRestartInFlight = true;
        console.log(`[save-zalo-manager] channels.modoro-zalo.enabled ${prevEnabled}→${newEnabled} — hard-restart gateway (bg)`);
        // Fire-and-forget so IPC returns fast — UI sidebar dots will flip
        // to checking→ready via channel-status broadcast as gateway boots.
        (async () => {
          try {
            console.log('[restart-guard] save-zalo-manager: hard-restart begin');
            try { await stopOpenClaw(); } catch (e1) { console.warn('[save-zalo-manager] stop failed:', e1?.message); }
            await new Promise(r => setTimeout(r, 2000));
            try { await startOpenClaw({ ignoreCooldown: true }); } catch (e2) { console.warn('[save-zalo-manager] start failed:', e2?.message); }
            global._zaloListenerMissStreak = 0;
            console.log('[restart-guard] save-zalo-manager: hard-restart end');
          } finally {
            ctx.gatewayRestartInFlight = false;
          }
        })();
      }
    } else {
      console.log('[save-zalo-manager] no enable/disable flip — skipping restart (realtime patches apply)');
    }
    return { success: gateOk };
  });
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    _saveZaloManagerInFlight = false;
    ctx.ipcInFlightCount--;
  }
});

// Save personalization (tone, pronouns; `industry` accepted but ignored since 2026-06-07 — generic profile)
ipcMain.handle('save-personalization', async (_event, { industry, tone, pronouns, ceoTitle, botName, personaMix, selectedPersona, ceoName, companyName }) => {
  try {
    // Validate inputs. Industry-specific tailoring was removed (2026-06-07):
    // the bot ships ONE generic profile — vertical/industry skills are
    // delivered separately on request (every business differs; bundling them
    // caused confusion). The `industry` arg is accepted but ignored.
    const VALID_TONES = ['professional', 'friendly', 'concise'];
    if (!VALID_TONES.includes(tone)) tone = 'friendly';
    const VALID_PRONOUNS = ['em-anh-chi', 'toi-quy-khach', 'minh-ban'];
    if (!VALID_PRONOUNS.includes(pronouns)) pronouns = 'em-anh-chi';
    ceoTitle = (ceoTitle || '').replace(/[\n\r]/g, '').substring(0, 50).trim();
    // Bot name is optional — if provided, replace the placeholder in IDENTITY.md.
    // If empty, the bot self-refers as "em" (from pronouns config) without a personal name.
    botName = (botName || '').replace(/[\n\r]/g, '').substring(0, 30).trim();
    // Empty ceoTitle is a wizard bug — IDENTITY.md would end up with literal
    // "gọi chủ nhân là " with no name → bot falls back to template default
    // (which used to be hardcoded "thầy Huy" — see IDENTITY.md template fix).
    // Refuse to write a broken file: surface error so wizard can re-prompt.
    if (!ceoTitle) {
      console.error('[save-personalization] empty ceoTitle — refusing to write IDENTITY.md');
      return { success: false, error: 'ceoTitle bắt buộc — vui lòng nhập "Trợ lý gọi bạn là" trong wizard' };
    }
    console.log('[save-personalization] tone=' + tone + ' pronouns=' + pronouns + ' ceoTitle="' + ceoTitle + '" botName="' + botName + '"');

    const ws = getWorkspace();

    // Update IDENTITY.md with tone + pronouns (industry tailoring removed)
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (!fs.existsSync(identityPath)) {
      // seedWorkspace should have created this. If missing, the bot would
      // fall back to whatever stale copy is in the bundle (with hardcoded
      // example name). Log loudly and try to seed it now from the template.
      console.error('[save-personalization] IDENTITY.md missing at ' + identityPath + ' — re-seeding');
      try { seedWorkspace(); } catch (e) { console.error('[save-personalization] re-seed failed:', e.message); }
    }
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const pronounMap = {
        'em-anh-chi': 'em — gọi ' + ceoTitle,
        'toi-quy-khach': 'tôi — gọi ' + ceoTitle,
        'minh-ban': 'mình — gọi ' + ceoTitle,
      };
      const toneMap = {
        'professional': 'Chuyên nghiệp, lịch sự, rõ ràng. Phù hợp giao tiếp doanh nghiệp.',
        'friendly': 'Thân thiện, gần gũi, nhiệt tình. Phù hợp ngành dịch vụ, bán lẻ.',
        'concise': 'Ngắn gọn, hiệu quả, đi thẳng vào vấn đề. Không dài dòng.',
      };
      const xunghoLine = `- **Cách xưng hô:** ${pronounMap[pronouns] || pronounMap['em-anh-chi']}`;
      const phongcachLine = `- **Phong cách:** ${toneMap[tone] || toneMap['friendly']}`;
      const before = content;
      // Bot name — replace the "[Tên trợ lý của bạn]" placeholder or update
      // an existing name. If botName is empty, write a sensible default so the
      // template placeholder doesn't show up in bot introductions.
      const botNameLine = `- **Tên:** ${botName || 'Trợ lý 9BizClaw'}`;
      content = content.replace(/- \*\*Tên:\*\* .*/, botNameLine);
      content = content.replace(/- \*\*Cách xưng hô:\*\* .*/, xunghoLine);
      content = content.replace(/- \*\*Phong cách:\*\* .*/, phongcachLine);
      if (content === before) {
        // Replace did nothing — IDENTITY.md is missing the expected lines.
        // Append them so bot still gets the right ceoTitle even on a malformed
        // template.
        console.warn('[save-personalization] IDENTITY.md missing expected lines — appending');
        content = content.trimEnd() + '\n\n' + xunghoLine + '\n' + phongcachLine + '\n';
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
      // Read back to confirm the write actually persisted (catches silent
      // permission failures on packaged Windows installs where workspace
      // happens to be the install dir).
      const verify = fs.readFileSync(identityPath, 'utf-8');
      if (!verify.includes(ceoTitle)) {
        console.error('[save-personalization] write verification FAILED — ceoTitle not in file after write');
        return { success: false, error: 'IDENTITY.md write verification failed — file does not contain ceoTitle after write. Có thể workspace không writable.' };
      }
      console.log('[save-personalization] IDENTITY.md updated OK at ' + identityPath);
    } else {
      console.error('[save-personalization] IDENTITY.md still missing after re-seed attempt');
      return { success: false, error: 'IDENTITY.md không tồn tại — workspace bị hỏng' };
    }

    // Save persona mix config from wizard. Bot reads compiled active-persona.md
    // on bootstrap. JSON config saved separately for Dashboard settings edit.
    // personaMix format: { region, voice, customer, traits:[], formality:1-10,
    //                      greeting, closing, phrases }
    // Legacy: `selectedPersona` (archetype id) still accepted for backwards
    // compat — if present and personaMix missing, map to default mix.
    try {
      let mix = personaMix;
      if (!mix || typeof mix !== 'object') {
        // Legacy fallback: single archetype id → default mix
        mix = { voice: 'em-nu-tre', customer: 'anh-chi', traits: ['am-ap', 'chu-dao'], formality: 5, greeting: '', closing: '', phrases: '' };
      }
      // Write structured JSON for Dashboard settings editor
      const mixJsonPath = path.join(ws, 'active-persona.json');
      writeJsonAtomic(mixJsonPath, mix);
      // Write compiled Markdown for bot bootstrap read
      const compiledPath = path.join(ws, 'active-persona.md');
      fs.writeFileSync(compiledPath, compilePersonaMix(mix), 'utf-8');
      // Clean up legacy active-persona.txt if present (from v2.2.35)
      try {
        const legacyPath = path.join(ws, 'active-persona.txt');
        if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
      } catch {}
      console.log('[save-personalization] persona mix saved: voice=' + mix.voice + ' traits=' + (mix.traits || []).length + ' formality=' + mix.formality);
      syncPersonaToBootstrap();
    } catch (e) { console.warn('[save-personalization] persona mix write failed:', e?.message); }

    // Sync the full personalization profile (CEO name, xưng hô, bot name, company)
    // into USER.md so it holds the complete personalization the bot reads each message.
    try { syncProfileToUserMd({ ceoName, ceoTitle, botName, company: companyName }); }
    catch (e) { console.warn('[save-personalization] profile→USER.md sync failed:', e?.message); }

    // Delete BOOTSTRAP.md — it's single-use, wizard completion means bot is
    // bootstrapped. Leaving it wastes ~1.5k chars per session-bootstrap read.
    // The file itself says "Sau lần chạy đầu: Xoá file này" — we enforce that
    // here so the bot doesn't need to remember to do it.
    try {
      const bootstrapPath = path.join(ws, 'BOOTSTRAP.md');
      if (fs.existsSync(bootstrapPath)) {
        fs.unlinkSync(bootstrapPath);
        console.log('[save-personalization] BOOTSTRAP.md deleted (wizard complete)');
      }
    } catch (e) { console.warn('[save-personalization] BOOTSTRAP.md cleanup failed:', e?.message); }

    return { success: true };
  } catch (e) {
    console.error('[save-personalization] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// =====================================================================
//  Save business profile (wizard step 1+1c) — enterprise onboarding
// =====================================================================
// Collects high-impact business context and writes:
//   - COMPANY.md      → company name + description (bot uses to reply Zalo customers
//                       with real context, not generic boilerplate)
//   - IDENTITY.md     → team size note (bot knows when to escalate vs decide alone)
//   - schedules.json  → morning cron time = workStart, evening cron time = workEnd
//                       (instead of hardcoded 07:30 / 21:00)
//   - memory/projects/business-goals.md → list of selected goals (bot reads on session
//                       start to know focus area)
ipcMain.handle('save-business-profile', async (_event, payload) => {
  try {
    const {
      companyName = '',
      companyDesc = '',
      teamSize = 'small',
      workStart = '07:30',
      workEnd = '21:00',
      goals = [],
      ceoName = '',
      bizProduct = '',
      bizAudience = '',
      bizHighlight = '',
      bizPhone = '',
      bizAddress = '',
    } = payload || {};

    // Sanitize inputs (file content goes into Markdown templates → strip control chars)
    const sanitize = (s, maxLen = 500) => String(s || '').replace(/[\u0000-\u001F\u007F]/g, ' ').substring(0, maxLen).trim();
    const cName = sanitize(companyName, 100);
    const cDesc = sanitize(companyDesc, 500);
    const ceoN = sanitize(ceoName, 100);
    const bProduct = sanitize(bizProduct, 300);
    const bAudience = sanitize(bizAudience, 300);
    const bHighlight = sanitize(bizHighlight, 500);
    const bPhone = sanitize(bizPhone, 20);
    const bAddress = sanitize(bizAddress, 200);
    const VALID_TEAM = ['solo', 'small', 'medium', 'large'];
    const tSize = VALID_TEAM.includes(teamSize) ? teamSize : 'small';
    const VALID_GOALS = ['zalo-auto-reply', 'daily-reports', 'schedule-mgmt', 'staff-reminders', 'customer-followup', 'competitor-watch'];
    const gList = Array.isArray(goals) ? goals.filter(g => VALID_GOALS.includes(g)) : [];
    // Validate HH:MM format
    const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
    const wStart = validTime(workStart) ? workStart : '07:30';
    const wEnd = validTime(workEnd) ? workEnd : '21:00';

    console.log('[save-business-profile]', { cName, tSize, wStart, wEnd, goalCount: gList.length });

    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'Workspace không tồn tại' };

    // 1. Update COMPANY.md (overwrite "Thông tin chung" section if exists, else append)
    const companyPath = path.join(ws, 'COMPANY.md');
    if (!fs.existsSync(companyPath)) {
      try { seedWorkspace(); } catch {}
    }
    if (fs.existsSync(companyPath)) {
      let content = fs.readFileSync(companyPath, 'utf-8');
      const teamSizeLabel = {
        solo: 'Solo founder (chỉ 1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      const profileBlock =
        '<!-- WIZARD AUTO-FILLED -->\n' +
        '## Thông tin chung\n\n' +
        '- **Tên:** ' + (cName || '[chưa điền]') + '\n' +
        (ceoN ? '- **Người đại diện:** ' + ceoN + '\n' : '') +
        '- **Quy mô:** ' + teamSizeLabel + '\n' +
        '- **Giờ làm việc:** ' + wStart + ' - ' + wEnd + '\n' +
        (bPhone ? '- **SĐT:** ' + bPhone + '\n' : '') +
        (bAddress ? '- **Địa chỉ:** ' + bAddress + '\n' : '') +
        (cDesc ? '\n## Giới thiệu\n\n' + cDesc + '\n' : '') +
        '<!-- /WIZARD AUTO-FILLED -->\n';
      // Replace block if marker present, else inject after first H1 or at top
      if (content.includes('<!-- WIZARD AUTO-FILLED -->')) {
        content = content.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?/, profileBlock);
      } else {
        // First run: strip the empty template "## Thông tin chung" section so we
        // don't end up with duplicate headings (template has placeholder fields,
        // wizard has real ones — wizard wins). Match from "## Thông tin chung"
        // to next "## " heading or end of file.
        content = content.replace(/## Thông tin chung[\s\S]*?(?=\n## |\n*$)/, '');
        // Inject wizard block right after H1 + blockquote
        const lines = content.split('\n');
        const h1Idx = lines.findIndex(l => l.startsWith('# '));
        if (h1Idx >= 0) {
          let insertAt = h1Idx + 1;
          while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
          lines.splice(insertAt, 0, '', profileBlock);
          content = lines.join('\n');
        } else {
          content = profileBlock + '\n' + content;
        }
      }
      fs.writeFileSync(companyPath, content, 'utf-8');
      console.log('[save-business-profile] COMPANY.md updated');
    }

    // 1b. Update PRODUCTS.md — replace placeholder template with wizard-collected info.
    // Wizard asks "Bán gì" (product) + "Cho ai" (audience) + "Điểm khác biệt" (highlight).
    // Bot reads PRODUCTS.md to answer customer questions about products/services.
    // If user has already edited PRODUCTS.md manually (no marker), skip to preserve their edits.
    const productsPath = path.join(ws, 'PRODUCTS.md');
    if (fs.existsSync(productsPath) && (bProduct || bAudience || bHighlight)) {
      let productsContent = fs.readFileSync(productsPath, 'utf-8');
      const isTemplate = productsContent.includes('[Tên sản phẩm 1]') || productsContent.includes('<!-- WIZARD AUTO-FILLED -->');
      if (isTemplate) {
        const wizardBlock =
          '<!-- WIZARD AUTO-FILLED -->\n' +
          '## Sản phẩm / Dịch vụ chính\n\n' +
          (bProduct ? '**Bán gì:** ' + bProduct + '\n\n' : '') +
          (bAudience ? '**Khách hàng mục tiêu:** ' + bAudience + '\n\n' : '') +
          (bHighlight ? '**Điểm khác biệt / Lợi thế:** ' + bHighlight + '\n\n' : '') +
          '> Anh/chị bổ sung bảng giá chi tiết bên dưới khi có.\n' +
          '<!-- /WIZARD AUTO-FILLED -->\n\n';
        if (productsContent.includes('<!-- WIZARD AUTO-FILLED -->')) {
          productsContent = productsContent.replace(/<!-- WIZARD AUTO-FILLED -->[\s\S]*?<!-- \/WIZARD AUTO-FILLED -->\n?\n?/, wizardBlock);
        } else {
          // First run: strip placeholder product table (from "## Bảng sản phẩm" to next "## ")
          productsContent = productsContent.replace(/## Bảng sản phẩm[\s\S]*?(?=\n## |$)/, '');
          const lines = productsContent.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          if (h1Idx >= 0) {
            let insertAt = h1Idx + 1;
            while (insertAt < lines.length && (lines[insertAt].trim() === '' || lines[insertAt].startsWith('>') || lines[insertAt].trim() === '---')) insertAt++;
            lines.splice(insertAt, 0, '', wizardBlock);
            productsContent = lines.join('\n');
          } else {
            productsContent = wizardBlock + productsContent;
          }
        }
        fs.writeFileSync(productsPath, productsContent, 'utf-8');
        console.log('[save-business-profile] PRODUCTS.md updated');
      } else {
        console.log('[save-business-profile] PRODUCTS.md has custom edits — skipping wizard overwrite');
      }
    }

    // 2. Update schedules.json — set morning cron = workStart, evening cron = workEnd
    const schedPath = path.join(ws, 'schedules.json');
    let schedules = DEFAULT_SCHEDULES_JSON.map(s => ({ ...s }));
    let schedReadOk = true;
    if (fs.existsSync(schedPath)) {
      // File exists → it owns the source of truth (incl. CEO-disabled defaults).
      // If it's unreadable, SKIP the write — never clobber disabled state with
      // all-enabled defaults. Only seed defaults when the file is truly missing.
      try {
        const parsed = JSON.parse(fs.readFileSync(schedPath, 'utf-8'));
        if (Array.isArray(parsed)) schedules = parsed; else schedReadOk = false;
      } catch { schedReadOk = false; }
    }
    if (schedReadOk) {
      let schedChanged = false;
      for (const s of schedules) {
        if (s.id === 'morning' && s.time !== wStart) { s.time = wStart; schedChanged = true; }
        if (s.id === 'evening' && s.time !== wEnd) { s.time = wEnd; schedChanged = true; }
      }
      if (schedChanged) {
        writeJsonAtomic(schedPath, schedules);
        console.log('[save-business-profile] schedules.json updated: morning=' + wStart + ' evening=' + wEnd);
      }
    } else {
      console.warn('[save-business-profile] schedules.json unreadable — skipping schedule write to preserve disabled state');
    }

    // 3. Write business goals to memory/projects/business-goals.md
    // Bot reads memory on session start → knows focus area without CEO restating it
    if (gList.length > 0) {
      const GOAL_LABELS = {
        'zalo-auto-reply': 'Trả tin Zalo tự động cho khách hàng',
        'daily-reports': 'Báo cáo hàng ngày (doanh thu, KPI, vấn đề)',
        'schedule-mgmt': 'Quản lý lịch họp + nhắc lịch + follow-up',
        'staff-reminders': 'Nhắc nhở nhân viên (báo cáo, deadline, ca trực)',
        'customer-followup': 'Follow-up khách quan tâm chưa chốt',
        'competitor-watch': 'Theo dõi tin tức đối thủ + biến động thị trường',
      };
      const goalsDir = path.join(ws, 'memory', 'projects');
      try { fs.mkdirSync(goalsDir, { recursive: true }); } catch {}
      const goalsPath = path.join(goalsDir, 'business-goals.md');
      const goalsContent =
        '# Mục tiêu CEO khi dùng 9BizClaw\n\n' +
        '> Tự fill từ wizard onboarding. CEO chọn các việc trợ lý nên giúp nhiều nhất.\n' +
        '> Bot đọc file này MỖI session để biết focus area.\n\n' +
        '## Ưu tiên hỗ trợ\n\n' +
        gList.map((g, i) => (i + 1) + '. **' + GOAL_LABELS[g] + '**').join('\n') + '\n\n' +
        '---\n\n' +
        '_Cập nhật: ' + new Date().toISOString().slice(0, 10) + '_\n';
      fs.writeFileSync(goalsPath, goalsContent, 'utf-8');
      console.log('[save-business-profile] business-goals.md written with ' + gList.length + ' goals');
    }

    // 4. Add team-size hint to IDENTITY.md (bot knows when to escalate vs decide solo)
    const identityPath = path.join(ws, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      let content = fs.readFileSync(identityPath, 'utf-8');
      const teamHint = {
        solo: 'Solo founder — anh/chị tự quyết mọi việc, em báo trực tiếp, không cần hỏi ý kiến team.',
        small: '2-10 người — em có thể nhắc nhân viên qua Zalo, nhưng quyết định lớn phải hỏi anh/chị.',
        medium: '11-50 người — có nhiều phòng ban, em escalate đúng người chịu trách nhiệm khi cần.',
        large: '51+ người — quy mô lớn, em ưu tiên báo cáo cấp cao, không can thiệp vận hành chi tiết.',
      }[tSize];
      const teamLine = '- **Quy mô đội ngũ:** ' + teamHint;
      if (content.includes('- **Quy mô đội ngũ:**')) {
        content = content.replace(/- \*\*Quy mô đội ngũ:\*\* .*/, teamLine);
      } else {
        // Insert after the Cách xưng hô line
        content = content.replace(
          /(- \*\*Cách xưng hô:\*\* .*)/,
          '$1\n' + teamLine
        );
      }
      // Inject "## Em đang làm việc tại" block at top so bot ALWAYS sees company
      // context — bot reads IDENTITY.md first per AGENTS.md bootstrap chain. This
      // is critical: COMPANY.md is technically loaded but bot may skip reads on
      // short messages ("ping"). IDENTITY.md is small + highest-priority → never
      // skipped. Idempotent via marker.
      const bizMarkerStart = '<!-- WIZARD-BUSINESS-PROFILE -->';
      const bizMarkerEnd = '<!-- /WIZARD-BUSINESS-PROFILE -->';
      const bizLines = [bizMarkerStart, '## Em đang làm việc tại'];
      if (cName) bizLines.push('- **Công ty:** ' + cName);
      if (cDesc) bizLines.push('- **Mô tả:** ' + cDesc);
      bizLines.push(bizMarkerEnd, '');
      const bizBlock = bizLines.join('\n');
      if (cName || cDesc) {
        if (content.includes(bizMarkerStart)) {
          content = content.replace(
            new RegExp(bizMarkerStart + '[\\s\\S]*?' + bizMarkerEnd + '\\n?'),
            bizBlock
          );
        } else {
          // Insert AFTER the H1 title (# IDENTITY.md — Tôi Là Ai?) so it's the
          // first content block bot sees after the heading.
          const lines = content.split('\n');
          const h1Idx = lines.findIndex(l => l.startsWith('# '));
          const insertAt = h1Idx >= 0 ? h1Idx + 1 : 0;
          // Skip blank lines after H1
          let insertPos = insertAt;
          while (insertPos < lines.length && lines[insertPos].trim() === '') insertPos++;
          lines.splice(insertPos, 0, '', bizBlock);
          content = lines.join('\n');
        }
      }
      fs.writeFileSync(identityPath, content, 'utf-8');
    }

    // 5. Write business profile to memory/projects/business-profile.md so it
    // shows up in MEMORY.md projects index + bot can search/recall it via
    // memory_search("bán gì") etc. Stable file name → idempotent overwrite.
    try {
      const projDir = path.join(ws, 'memory', 'projects');
      fs.mkdirSync(projDir, { recursive: true });
      const profPath = path.join(projDir, 'business-profile.md');
      const profLines = [
        '# Hồ sơ doanh nghiệp',
        '',
        '> File này do wizard onboarding tự ghi. Bot dùng để biết "công ty làm gì, bán gì, bán cho ai".',
        '> Cập nhật bằng cách chạy lại wizard hoặc sửa tay file này.',
        '',
        '## Tổng quan',
        '',
      ];
      if (cName) profLines.push('- **Tên công ty:** ' + cName);
      if (ceoN) profLines.push('- **Người đại diện:** ' + ceoN);
      if (bPhone) profLines.push('- **SĐT:** ' + bPhone);
      if (bAddress) profLines.push('- **Địa chỉ:** ' + bAddress);
      const teamSizeLabel2 = {
        solo: 'Solo founder (1 người)',
        small: '2-10 người',
        medium: '11-50 người',
        large: '51+ người',
      }[tSize];
      profLines.push('- **Quy mô:** ' + teamSizeLabel2);
      profLines.push('- **Giờ làm việc:** ' + wStart + ' - ' + wEnd);
      if (cDesc) {
        profLines.push('');
        profLines.push('## Mô tả');
        profLines.push('');
        profLines.push(cDesc);
      }
      if (gList.length > 0) {
        profLines.push('');
        profLines.push('## Trợ lý dùng để');
        profLines.push('');
        const goalLabels = {
          'zalo-auto-reply': 'Trả tin Zalo tự động',
          'daily-reports': 'Báo cáo hàng ngày',
          'schedule-mgmt': 'Quản lý lịch họp',
          'staff-reminders': 'Nhắc nhân viên',
          'customer-followup': 'Follow-up khách',
          'competitor-watch': 'Theo dõi đối thủ',
        };
        for (const g of gList) profLines.push('- ' + (goalLabels[g] || g));
      }
      profLines.push('');
      profLines.push('---');
      profLines.push('Cập nhật lần cuối: ' + new Date().toISOString().slice(0, 10));
      profLines.push('');
      fs.writeFileSync(profPath, profLines.join('\n'), 'utf-8');
      console.log('[save-business-profile] memory/projects/business-profile.md written');
    } catch (e) {
      console.warn('[save-business-profile] business-profile.md write failed:', e?.message);
    }

    return { success: true };
  } catch (e) {
    console.error('[save-business-profile] error:', e?.message || e);
    return { success: false, error: e.message };
  }
});

// Google Calendar + Gmail integration via `gog-cli`.
//
// STATUS (2026-04-07): The `gog-cli` npm package referenced here does NOT
// currently exist on the public npm registry. Calling this handler used to
// silently fail in npm install (404), then crash with "command not found"
// when spawning `gog auth`. On Mac the failure is even louder because
// `npm install -g` requires write permission to /usr/local/lib/node_modules
// and pops a permission error.
//
// Until a working Google integration is shipped, this handler returns a
// graceful "not implemented" response so the wizard can show a clear message
// instead of throwing. The Dashboard's "Google" channel chip stays at
// `not_configured` (handled by check-all-channels which only looks for
// ~/.gog/token.json — won't exist).
// Batch config set (for complex nested objects like model providers)
// Batch config set — write JSON directly
ipcMain.handle('set-batch-config', async (_event, ops) => {
  if (!Array.isArray(ops)) return { success: false, error: 'ops must be an array' };
  const booting = rejectIfBooting('set-batch-config');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] set-batch-config acquired');
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = readOpenclawJsonFile(configPath); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const op of ops) {
          const parts = op.path.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = op.value;
        }
        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

// Save config by writing openclaw.json directly — no CLI dependency
ipcMain.handle('save-wizard-config', async (_event, configs) => {
  if (!Array.isArray(configs)) return { success: false, error: 'configs must be an array' };
  // Not gated by rejectIfBooting — wizard runs before boot by design.
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        console.log('[config-lock] save-wizard-config acquired');
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = readOpenclawJsonFile(configPath); } catch {}
        }
        const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
        for (const { key, value } of configs) {
          const parts = key.split('.');
          if (parts.some(p => UNSAFE_KEYS.includes(p))) continue;
          let obj = config;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        }

      // Auto-fix required fields OpenClaw expects
      if (config.channels?.telegram?.botToken && !config.channels.telegram.enabled) {
        config.channels.telegram.enabled = true;
      }
      // If wizard enabled modoro-zalo, ensure dmPolicy="open" + allowFrom=["*"] so
      // unknown DM senders don't get the "access not configured" pairing reply.
      // (modoro-zalo plugin defaults dmPolicy to "pairing" if missing.)
      if (config.channels?.['modoro-zalo']?.enabled) {
        if (config.channels['modoro-zalo'].dmPolicy !== 'open') {
          config.channels['modoro-zalo'].dmPolicy = 'open';
        }
        if (!Array.isArray(config.channels['modoro-zalo'].allowFrom)) {
          config.channels['modoro-zalo'].allowFrom = ['*'];
        }
      }
      // Create required dirs
      const sessDir = path.join(ctx.HOME, '.openclaw', 'agents', 'main', 'sessions');
      fs.mkdirSync(sessDir, { recursive: true });

        writeOpenClawConfigIfChanged(configPath, config);
        return { success: true };
      } catch (e) { return { success: false, error: e.message }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

// Add cron — save custom times to claw-schedules.json (bypasses broken CLI)
ipcMain.handle('add-cron', async (_event, { name, cron, tz, message, channel }) => {
  try {
    if (!name || typeof name !== 'string' || name.trim().length === 0) return { success: false, error: 'name is required' };
    if (!cron || typeof cron !== 'string' || cron.trim().length === 0) return { success: false, error: 'cron expression is required' };
    // Parse cron expression to extract time (e.g., "30 7 * * *" → "07:30")
    const parts = (cron || '').split(/\s+/);
    if (parts.length >= 2) {
      const m = parts[0].padStart(2, '0');
      const h = parts[1].padStart(2, '0');
      const time = `${h}:${m}`;
      const schedules = loadSchedules();
      // Map cron name to schedule ID
      if (name && name.toLowerCase().includes('sang') || name && name.toLowerCase().includes('morning')) {
        const s = schedules.find(x => x.id === 'morning');
        if (s) { s.time = time; } // only update time; never re-enable a CEO-disabled default
      } else if (name && name.toLowerCase().includes('toi') || name && name.toLowerCase().includes('evening')) {
        const s = schedules.find(x => x.id === 'evening');
        if (s) { s.time = time; } // only update time; never re-enable a CEO-disabled default
      }
      writeJsonAtomic(getSchedulesPath(), schedules);
      restartCronJobs();
      console.log('[add-cron] Saved custom time:', name, time);
    }
    return { success: true };
  } catch (e) {
    console.error('[add-cron] error:', e.message);
    return { success: false, error: e.message };
  }
});

// Schedule management — extracted to lib/cron.js (Task 19)
// getSchedulesPath, getCustomCronsPath, legacySchedulesPaths, legacyCustomCronsPaths,
// loadSchedules, loadDailySummaries, generateWeeklySummary, loadWeeklySummaries,
// loadPromptTemplate, buildMorningBriefingPrompt, buildEveningSummaryPrompt,
// buildWeeklyReportPrompt, buildMonthlyReportPrompt, scanZaloFollowUpCandidates,
// buildZaloFollowUpPrompt, buildMeditationPrompt, buildMemoryCleanupPrompt
// — all now imported from lib/cron.js
// (legacyCustomCronsPaths moved to lib/cron.js)

// loadSchedules — moved to lib/cron.js

ipcMain.handle('get-schedules', async () => {
  return loadSchedules();
});

ipcMain.handle('get-custom-crons', async () => {
  // Merge 9BizClaw custom-crons.json + OpenClaw built-in cron/jobs.json.
  // The bot creates crons via OpenClaw's `cron` tool (saved to
  // ~/.openclaw/cron/jobs.json), NOT to custom-crons.json. The Dashboard
  // previously only read custom-crons.json, so bot-created crons were
  // invisible to the CEO. Fix: read both, merge, dedupe by ID, label
  // OpenClaw crons with source:'openclaw' so Dashboard can distinguish.
  const modoroEntries = loadCustomCrons().map(c => ({ ...c, source: 'modoro' }));
  let openclawEntries = [];
  try {
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    if (fs.existsSync(ocJobsPath)) {
      const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      for (const j of jobs) {
        if (!j || !j.id) continue;
        // Map OpenClaw cron format → 9BizClaw display format
        const schedExpr = j.schedule?.expr || j.schedule?.at || '';
        const kind = j.schedule?.kind || 'cron';
        let displayTime = schedExpr;
        if (kind === 'at') {
          try {
            const d = new Date(j.schedule.at);
            displayTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (một lần)`;
          } catch {}
        }
        openclawEntries.push({
          id: 'oc_' + j.id,
          label: j.name || 'OpenClaw cron',
          cronExpr: schedExpr,
          displayTime,
          prompt: j.payload?.text || j.payload?.message || '(hệ thống)',
          enabled: j.enabled !== false,
          createdAt: j.createdAtMs ? new Date(j.createdAtMs).toISOString() : '',
          source: 'openclaw',
          // Extra metadata for display
          lastStatus: j.state?.lastRunStatus || null,
          nextRunAt: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null,
          deleteAfterRun: j.deleteAfterRun || false,
        });
      }
    }
  } catch (e) {
    console.warn('[get-custom-crons] failed to read OpenClaw cron/jobs.json:', e?.message);
  }
  // Merge: OpenClaw entries first (they're the ones bot created), then 9BizClaw
  return [...openclawEntries, ...modoroEntries];
});

ipcMain.handle('save-custom-crons', async (_event, crons) => {
  try {
    if (!Array.isArray(crons)) return { success: false, error: 'crons must be an array' };
    // CRIT #7: Dashboard `get-custom-crons` merges 9BizClaw crons with
    // OpenClaw-sourced entries (source:'openclaw' — bot-created crons read
    // from ~/.openclaw/agents/main/jobs.json). FE passes the merged array back
    // on any toggle/delete. If we wrote it verbatim, those OpenClaw entries
    // would get copied INTO our custom-crons.json and double-fire every day.
    // Strip anything not ours before persisting.
    const mine = crons.filter(c => c && c.source !== 'openclaw');
    // Validate cronExpr so a malformed entry doesn't crash the cron scheduler
    // on the watcher reload (which would then keep re-firing).
    const nodeCron = require('node-cron');
    for (const c of mine) {
      if (c && typeof c.cronExpr === 'string' && !nodeCron.validate(c.cronExpr)) {
        return { success: false, error: `Cron expression invalid: "${c.cronExpr}" (label: ${c.label || c.id || '?'})` };
      }
    }
    await _withCustomCronLock(async () => { writeJsonAtomic(getCustomCronsPath(), mine); });
    // CRITICAL: do NOT rely on the file watcher alone — fs.watch is unreliable
    // on Windows + atomic-replace editors. Explicitly reload cron jobs after
    // every write so the new schedule takes effect immediately, even if the
    // watcher missed the event. The watcher's debounce will dedupe the second
    // call if it does fire.
    try { restartCronJobs(); } catch (e) { console.error('[save-custom-crons] restartCronJobs error:', e.message); }
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('delete-openclaw-cron', async (_event, jobId) => {
  try {
    if (!jobId || typeof jobId !== 'string') return { success: false, error: 'jobId required' };
    const realId = jobId.startsWith('oc_') ? jobId.slice(3) : jobId;
    const ocJobsPath = path.join(ctx.HOME, '.openclaw', 'cron', 'jobs.json');
    if (!fs.existsSync(ocJobsPath)) return { success: false, error: 'jobs.json not found' };
    const raw = JSON.parse(fs.readFileSync(ocJobsPath, 'utf-8'));
    const before = Array.isArray(raw?.jobs) ? raw.jobs.length : 0;
    raw.jobs = (raw.jobs || []).filter(j => j && j.id !== realId);
    if (raw.jobs.length === before) return { success: false, error: 'job not found: ' + realId };
    writeJsonAtomic(ocJobsPath, raw);
    console.log('[delete-openclaw-cron] deleted job:', realId);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('save-schedules', async (_event, schedules) => {
  try {
    // schedules.json is an ARRAY everywhere (loadSchedules requires array,
    // getSchedules returns array, the Dashboard's currentSchedules is array).
    // A 2026-05-08 regression rejected arrays here, so every toggle/disable
    // silently failed to persist and disabled schedules kept firing.
    if (!Array.isArray(schedules)) return { success: false, error: 'schedules must be an array' };
    writeJsonAtomic(getSchedulesPath(), schedules);
    restartCronJobs(); // Re-schedule with new settings
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Re-run boot diagnostic on demand (Dashboard exposes a "Diagnostic" button).
// Returns the latest diagnostic file content as a string the UI can render.
ipcMain.handle('cron-diagnostic', async () => {
  try {
    bootDiagRunFullCheck();
    const file = path.join(getWorkspace(), 'logs', 'boot-diagnostic.txt');
    const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    return {
      success: true,
      file,
      content,
      summary: {
        platform: process.platform,
        arch: process.arch,
        nodeBin: findNodeBin() || null,
        openclawBin: findOpenClawBinSync() || null,
        openclawCli: findOpenClawCliJs() || null,
        agentProfile: getAgentFlagProfile(),
        agentHealthy: getAgentCliHealthy(),
        botRunning: ctx.botRunning,
      },
    };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

// Manually trigger a cron handler (for "Test ngay" button in Dashboard).
// CRITICAL: test fires MUST be byte-identical to scheduled cron fires so the
// customer's test preview matches what they'll receive in production. No
// "[TEST]" preambles, no "(tin test thủ công)" footers — reuse the exact same
// prompt builders.
ipcMain.handle('test-cron', async (_event, { type, id }) => {
  try {
    if (type === 'fixed') {
      const schedules = loadSchedules();
      const s = schedules.find(x => x.id === id);
      if (!s) return { success: false, error: 'Schedule not found' };
      if (id === 'morning') {
        const prompt = buildMorningBriefingPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — morning-briefing' });
        return { success: ok, sent: ok };
      } else if (id === 'evening') {
        const prompt = buildEveningSummaryPrompt(s.time);
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — evening-summary' });
        return { success: ok, sent: ok };
      } else if (id === 'meditation') {
        return { success: false, error: 'Meditation cron đã bị xóa.' };
      } else if (id === 'weekly') {
        const prompt = await buildWeeklyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — weekly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'monthly') {
        const prompt = buildMonthlyReportPrompt();
        const ok = await runCronViaSessionOrFallback(prompt, { label: 'TEST — monthly-report' });
        return { success: ok, sent: ok };
      } else if (id === 'zalo-followup') {
        const ws = getWorkspace();
        const candidates = ws ? scanZaloFollowUpCandidates(ws) : [];
        const prompt = buildZaloFollowUpPrompt(candidates);
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — zalo-followup' });
        return { success: ok, sent: ok };
      } else if (id === 'memory-cleanup') {
        const prompt = buildMemoryCleanupPrompt();
        const ok = await runCronAgentPrompt(prompt, { label: 'TEST — memory-cleanup' });
        return { success: ok, sent: ok };
      }
      return { success: false, error: 'Unknown schedule id' };
    } else if (type === 'custom') {
      const customs = loadCustomCrons();
      const c = customs.find(x => x.id === id);
      if (!c) return { success: false, error: 'Custom cron not found' };
      if (!c.prompt) return { success: false, error: 'Cron không có prompt' };
      const ok = !c.prompt.startsWith('exec:')
        ? await runCronViaSessionOrFallback(c.prompt, { label: `TEST — ${c.label || c.id}` })
        : await runCronAgentPrompt(c.prompt, { label: `TEST — ${c.label || c.id}` });
      return { success: ok, sent: ok };
    }
    return { success: false, error: 'Unknown type' };
  } catch (e) { return { success: false, error: e.message }; }
});

// ============================================
//  CRON SCHEDULER (node-cron + Telegram Bot API)
// ============================================

// cron, cronJobs, setGetTelegramConfig, runCronViaSessionOrFallback — moved to lib/cron.js

// skipFilter: bypass output filter for system alerts (cron errors, boot pings)
// that are OUR messages, not AI-generated. Blocking these would cause silent failures.
// R1: strip Telegram Markdown v1 syntax tokens so plain-text send doesn't
// leak raw `*` / backtick / triple-backtick into CEO's alert output.
// sendCeoAlert call sites use `*bold*` + ``` code fences historically.
// NOTE: Output filter patterns, pause functions, and send functions moved to lib/channels.js
// _outputFilterPatterns, filterSensitiveOutput, _getPausePath, setChannelPermanentPause,
// clearChannelPermanentPause, isZaloChannelEnabled, setZaloChannelEnabled,
// isChannelPaused, pauseChannel, resumeChannel, getChannelPauseStatus,
// sendTelegram, sendTelegramPhoto, sendZalo — all now in lib/channels.js

// getAppointmentsPath, readAppointments, writeAppointments, newAppointmentId,
// mutateAppointments, vnHHMM, vnDDMM, vnHHMMNow, vnDateKeyNow,
// normalizeAppointment, substituteApptTemplate, defaultApptPushTemplate,
// buildApptReminderText, fireApptPushTarget, startAppointmentDispatcher,
// apptDispatcherTick, cleanupAppointmentTimers — all now in lib/appointments.js

// --- IPC: appointments CRUD ---
ipcMain.handle('list-appointments', async () => {
  try { return readAppointments(); }
  catch (e) { return []; }
});

ipcMain.handle('create-appointment', async (_e, data) => {
  try {
    const apt = normalizeAppointment(data || {});
    if (!apt) return { ok: false, error: 'Dữ liệu không hợp lệ' };
    if (!apt.title) return { ok: false, error: 'Thiếu tiêu đề' };
    if (!apt.start) return { ok: false, error: 'Thiếu thời gian bắt đầu' };
    const startMs = new Date(apt.start).getTime();
    if (!Number.isFinite(startMs)) return { ok: false, error: 'Thời gian không hợp lệ' };
    const result = await mutateAppointments(async (list) => { list.push(apt); return list; });
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file appointments.json' };
    try { auditLog('appt_created', { id: apt.id, title: apt.title, start: apt.start }); } catch {}
    return { ok: true, appointment: apt };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('update-appointment', async (_e, payload) => {
  try {
    const { id, patch } = payload || {};
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => {
      const idx = list.findIndex(a => a.id === id);
      if (idx < 0) return null;
      const oldApt = list[idx];
      const newStart = (patch && patch.start) || oldApt.start;
      const newEnd = (patch && patch.end) || oldApt.end;
      const timeChanged = newStart !== oldApt.start || newEnd !== oldApt.end;
      const merged = { ...oldApt, ...(patch || {}), id };
      if (timeChanged) {
        // Time changed — reset delivery state so reminder/push fire for new time.
        merged.reminderFiredAt = null;
        merged.pushedAt = {};
      }
      list[idx] = normalizeAppointment(merged);
      return list;
    });
    if (!Array.isArray(result)) return { ok: false, error: 'Không tìm thấy hoặc không ghi được lịch hẹn' };
    const updated = result.find(a => a.id === id);
    if (!updated) return { ok: false, error: 'Lịch hẹn đã bị xóa trước khi cập nhật' };
    return { ok: true, appointment: updated };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-appointment', async (_e, payload) => {
  try {
    const id = payload?.id;
    if (!id) return { ok: false, error: 'Thiếu id' };
    const result = await mutateAppointments(async (list) => list.filter(a => a.id !== id));
    if (!Array.isArray(result)) return { ok: false, error: 'Không ghi được file' };
    try { auditLog('appt_deleted', { id }); } catch {}
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Bot + UI helper: resolve Zalo target by name from openzca cache.
// Returns fuzzy matches (accent-insensitive substring) so bot can confirm with CEO.
ipcMain.handle('resolve-zalo-target', async (_e, payload) => {
  try {
    const query = payload?.query;
    const type = payload?.type || 'any'; // 'group' | 'user' | 'any'
    // NFD decomposes most Vietnamese diacritics, but đ/Đ are atomic (U+0111/U+0110)
    // and don't decompose. Map them explicitly so "Đội bán hàng" matches "doi ban hang".
    const normalize = (s) => String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'd');
    const q = normalize(query);
    if (!q) return { matches: [] };
    const results = [];
    if (type === 'group' || type === 'any') {
      const pg = path.join(getZcaCacheDir(), 'groups.json');
      if (fs.existsSync(pg)) {
        try {
          const data = JSON.parse(fs.readFileSync(pg, 'utf-8'));
          for (const g of (Array.isArray(data) ? data : [])) {
            const name = g.name || g.groupName || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_group',
                toId: String(g.groupId || g.id || ''),
                toName: name,
                memberCount: g.totalMember || g.memberCount || (g.memberIds?.length) || 0,
              });
            }
          }
        } catch {}
      }
    }
    if (type === 'user' || type === 'any') {
      const pf = path.join(getZcaCacheDir(), 'friends.json');
      if (fs.existsSync(pf)) {
        try {
          const data = JSON.parse(fs.readFileSync(pf, 'utf-8'));
          for (const u of (Array.isArray(data) ? data : [])) {
            const name = u.displayName || u.zaloName || u.name || '';
            if (normalize(name).includes(q)) {
              results.push({
                type: 'zalo_user',
                toId: String(u.userId || u.id || ''),
                toName: name,
              });
            }
          }
        } catch {}
      }
    }
    return { matches: results.slice(0, 10) };
  } catch (e) { return { matches: [], error: e.message }; }
});

ipcMain.handle('get-telegram-config', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    const config = readOpenclawJsonFile(configPath);
    const tg = config.channels?.telegram || {};
    const token = tg.botToken || '';
    return {
      botToken: token ? token.slice(0, 6) + '…' + token.slice(-4) : '',
      botTokenSet: !!token,
      allowFrom: tg.allowFrom || [],
    };
  } catch { return { botToken: '', botTokenSet: false, allowFrom: [] }; }
});

ipcMain.handle('save-telegram-config', async (_e, { botToken, userId }) => {
  const booting = rejectIfBooting('save-telegram-config');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      try {
        const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        const config = readOpenclawJsonFile(configPath);
        if (!config.channels) config.channels = {};
        if (!config.channels.telegram) config.channels.telegram = {};
        const oldToken = config.channels.telegram.botToken;
        const tokenChanged = botToken !== undefined && botToken !== oldToken;
        if (botToken !== undefined) config.channels.telegram.botToken = botToken;
        if (userId !== undefined) {
          const uid = parseInt(userId, 10);
          if (!isNaN(uid) && uid > 0) config.channels.telegram.allowFrom = [uid];
        }
        writeOpenClawConfigIfChanged(configPath, config);

        // Token changed → gateway MUST restart or it keeps using the old bot token.
        // Same pattern as save-zalo-manager (stop + wait + start).
        if (tokenChanged) {
          if (ctx.gatewayRestartInFlight) {
            console.log('[save-telegram-config] token changed — restart already in-flight, skip duplicate');
          } else {
            ctx.gatewayRestartInFlight = true;
            console.log('[save-telegram-config] bot token changed — hard-restart gateway (bg)');
            (async () => {
              try {
                try { await stopOpenClaw(); } catch (e1) { console.warn('[save-telegram-config] stop failed:', e1?.message); }
                await new Promise(r => setTimeout(r, 2000));
                try { await startOpenClaw({ ignoreCooldown: true }); } catch (e2) { console.warn('[save-telegram-config] start failed:', e2?.message); }
                console.log('[save-telegram-config] gateway hard-restart complete');
              } finally {
                ctx.gatewayRestartInFlight = false;
              }
            })();
          }
        }

        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    });
  } finally { ctx.ipcInFlightCount--; }
});

ipcMain.handle('check-telegram-ready', async () => probeTelegramReady());
ipcMain.handle('check-zalo-ready', async () => probeZaloReady());

// --- Telegram conversation manager (Dashboard) ---
ipcMain.handle('list-telegram-conversations', async () => {
  try {
    return listTelegramConversations();
  } catch (e) {
    console.error('[telegram-manager] list error:', e?.message || e);
    return { success: false, conversations: [], error: e?.message || String(e) };
  }
});

ipcMain.handle('save-telegram-conversation-settings', async (_event, payload) => {
  try {
    return saveTelegramConversationSettings(payload || {});
  } catch (e) {
    console.error('[telegram-manager] save error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('read-telegram-conversation-memory', async (_event, payload) => {
  try {
    const request = payload && typeof payload === 'object' ? payload : { chatId: payload };
    const id = sanitizeTelegramChatId(request.chatId);
    if (!id) return { exists: false, content: '', error: 'invalid chatId' };
    const profile = readTelegramConversationProfile(id, 8000);
    if (profile) return { exists: true, content: profile.content, path: profile.path };
    const seeded = ensureTelegramConversationProfile({
      telegramChatId: id,
      telegramChatType: request.chatType || request.telegramChatType || '',
      role: request.role || '',
      label: request.label || request.title || '',
    });
    const created = seeded ? readTelegramConversationProfile(id, 8000) : null;
    return created
      ? { exists: true, created: true, content: created.content, path: created.path }
      : { exists: false, content: '' };
  } catch (e) {
    console.error('[telegram-manager] read memory error:', e?.message || e);
    return { exists: false, content: '', error: e?.message || String(e) };
  }
});

ipcMain.handle('append-telegram-conversation-note', async (_event, payload) => {
  try {
    const request = payload && typeof payload === 'object' ? payload : {};
    const id = sanitizeTelegramChatId(request.chatId);
    if (!id) return { success: false, error: 'invalid chatId' };
    return appendTelegramConversationNote({
      ...request,
      chatId: id,
      telegramChatId: id,
    });
  } catch (e) {
    console.error('[telegram-manager] append note error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('delete-telegram-conversation-note', async (_event, payload) => {
  try {
    const request = payload && typeof payload === 'object' ? payload : {};
    const id = sanitizeTelegramChatId(request.chatId);
    if (!id) return { success: false, error: 'invalid chatId' };
    return deleteTelegramConversationNote({
      ...request,
      chatId: id,
      telegramChatId: id,
    });
  } catch (e) {
    console.error('[telegram-manager] delete note error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('seed-telegram-conversations', async () => {
  try {
    return seedTelegramConversationsFromRuntime();
  } catch (e) {
    console.error('[telegram-manager] seed error:', e?.message || e);
    return { success: false, seeded: [], error: e?.message || String(e) };
  }
});


// Manual smoke test: send a real Telegram message to the CEO. The strongest
// possible proof — if this succeeds the channel is end-to-end working.
ipcMain.handle('telegram-self-test', async () => {
  // Self-test bypasses pause + filter — CEO explicitly clicked "Gửi tin test"
  const ok = await sendTelegram(
    'Test kết nối\n\nĐây là tin nhắn test từ Dashboard. Nếu thấy tin này,' +
    'channel Telegram đã sẵn sàng nhận lệnh.',
    { skipFilter: true, skipPauseCheck: true }
  );
  return { success: ok === true };
});

// --- Telegram behavior settings (mirrors Zalo behavior pattern) ---
ipcMain.handle('get-telegram-behavior', async () => {
  try {
    const ws = getWorkspace();
    if (!ws) return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };

    // Stranger policy — file-based like Zalo
    let strangerPolicy = 'ignore';
    try {
      const spPath = path.join(ws, 'telegram-stranger-policy.json');
      if (fs.existsSync(spPath)) {
        const sp = JSON.parse(fs.readFileSync(spPath, 'utf-8'));
        if (['reply', 'greet-only', 'ignore'].includes(sp.policy)) strangerPolicy = sp.policy;
      }
    } catch {}

    // Default group mode — file-based
    let defaultGroupMode = 'mention';
    try {
      const gmPath = path.join(ws, 'telegram-group-defaults.json');
      if (fs.existsSync(gmPath)) {
        const gm = JSON.parse(fs.readFileSync(gmPath, 'utf-8'));
        if (['mention', 'all', 'off'].includes(gm.mode)) defaultGroupMode = gm.mode;
      }
    } catch {}

    // History limit — from openclaw.json
    let historyLimit = 50;
    try {
      const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const cfg = readOpenclawJsonFile(configPath);
        historyLimit = cfg?.channels?.telegram?.historyLimit || 50;
      }
    } catch {}

    return { strangerPolicy, defaultGroupMode, historyLimit };
  } catch (e) {
    console.error('[get-telegram-behavior] error:', e.message);
    return { strangerPolicy: 'ignore', defaultGroupMode: 'mention', historyLimit: 50 };
  }
});

ipcMain.handle('save-telegram-behavior', async (_event, behavior) => {
  const booting = rejectIfBooting('save-telegram-behavior');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    const ws = getWorkspace();
    if (!ws) return { success: false, error: 'No workspace' };
    const { strangerPolicy, defaultGroupMode, historyLimit } = behavior || {};

    // Save stranger policy
    if (strangerPolicy && ['reply', 'greet-only', 'ignore'].includes(strangerPolicy)) {
      writeJsonAtomic(path.join(ws, 'telegram-stranger-policy.json'), {
        policy: strangerPolicy,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save default group mode
    if (defaultGroupMode && ['mention', 'all', 'off'].includes(defaultGroupMode)) {
      writeJsonAtomic(path.join(ws, 'telegram-group-defaults.json'), {
        mode: defaultGroupMode,
        updatedAt: new Date().toISOString(),
      });
    }

    // Save history limit to openclaw.json
    if (historyLimit) {
      const limit = Math.min(Math.max(parseInt(historyLimit, 10) || 50, 5), 50);
      try {
        await withOpenClawConfigLock(async () => {
          const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
          if (fs.existsSync(configPath)) {
            const cfg = readOpenclawJsonFile(configPath);
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.telegram) cfg.channels.telegram = {};
            cfg.channels.telegram.historyLimit = limit;
            writeOpenClawConfigIfChanged(configPath, cfg);
          }
        });
      } catch (e) {
        console.warn('[save-telegram-behavior] historyLimit write error:', e.message);
      }
    }

    try { auditLog('telegram-behavior-changed', { strangerPolicy, defaultGroupMode, historyLimit }); } catch {}
    console.log('[save-telegram-behavior] saved:', { strangerPolicy, defaultGroupMode, historyLimit });
    return { success: true };
  } catch (e) {
    console.error('[save-telegram-behavior] error:', e.message);
    return { success: false, error: e.message };
  } finally { ctx.ipcInFlightCount--; }
});

// --- Channel pause/resume (symmetric for both Telegram + Zalo) ---
ipcMain.handle('pause-telegram', async (_e, { minutes } = {}) => {
  try { return { success: pauseChannel('telegram', minutes || 30) }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('resume-telegram', async () => {
  try { return { success: resumeChannel('telegram') }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('get-telegram-pause-status', async () => {
  try { return getChannelPauseStatus('telegram'); }
  catch (e) { return { paused: true, permanent: true, error: e.message }; }
});
ipcMain.handle('pause-zalo', async (_e, { minutes } = {}) => {
  try { return { success: pauseChannel('zalo', minutes || 30) }; }
  catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('resume-zalo', async () => {
  const booting = rejectIfBooting('resume-zalo');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    return await withOpenClawConfigLock(async () => {
      console.log('[config-lock] resume-zalo acquired');
      // [zalo-watchdog rearm] CEO's manual Resume rearms the listener watchdog.
      // Without this, once _zaloListenerGaveUp flipped true (3 restarts in 2h),
      // it stuck until app restart — CEO fixing the root cause + pressing
      // Resume wouldn't re-enable auto-restart. Reset all 3 counters.
      global._zaloListenerGaveUp = false;
      global._zaloListenerRestartHistory = [];
      global._zaloListenerMissStreak = 0;
      console.log('[zalo-watchdog] reset gave-up / streak by CEO action');
      // Detect if enabled was previously false — transitioning false→true needs
      // a hard gateway restart so openclaw loads the modoro-zalo plugin + spawns
      // openzca listener (both skipped at boot when enabled=false).
      let wasDisabled = false;
      try {
        const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = readOpenclawJsonFile(cfgPath);
          wasDisabled = (cfg?.channels?.['modoro-zalo'] || cfg?.channels?.openzalo)?.enabled === false;
        }
      } catch {}
      const resumed = resumeChannel('zalo');
      // Inline config write — do NOT call setZaloChannelEnabled() here because
      // it acquires withOpenClawConfigLock internally, and we already hold it.
      let enabled = false;
      try {
        const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = readOpenclawJsonFile(cfgPath);
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels['modoro-zalo'] || typeof cfg.channels['modoro-zalo'] !== 'object') {
            cfg.channels['modoro-zalo'] = {};
          }
          cfg.channels['modoro-zalo'].enabled = true;
          if (!cfg.plugins) cfg.plugins = {};
          if (!cfg.plugins.entries) cfg.plugins.entries = {};
          if (!cfg.plugins.entries['modoro-zalo'] || typeof cfg.plugins.entries['modoro-zalo'] !== 'object') {
            cfg.plugins.entries['modoro-zalo'] = {};
          }
          cfg.plugins.entries['modoro-zalo'].enabled = true;
          writeOpenClawConfigIfChanged(cfgPath, cfg);
          enabled = true;
        }
      } catch (e) { console.error('[resume-zalo] inline config write error:', e.message); }
      const cleared = clearChannelPermanentPause('zalo');
      if (enabled && cleared) markOnboardingComplete('resume-zalo');
      // [restart-guard A1] Flipping enabled/permanent-pause doesn't reach the running
      // gateway (config is read at boot). Kick off a hard-restart in the
      // background so Zalo actually comes back. Only restart if disabled→enabled
      // transition (HEAD's smart check) AND not in-flight already (A1 guard).
      if (wasDisabled) {
        // Defer restart if gateway spawn is already in progress (wizard just
        // finished, boot path still spawning). Killing mid-spawn causes 240s
        // WS timeout → null.stdout crash → gateway dead permanently.
        if (ctx.startOpenClawInFlight) {
          console.log('[resume-zalo] gateway spawn in progress — skip restart, config change will apply on its own');
        } else if (ctx.gatewayRestartInFlight) {
          console.log('[restart-guard] resume-zalo: restart already in-flight — skipping duplicate');
        } else {
          ctx.gatewayRestartInFlight = true;
          console.log('[resume-zalo] transitioning disabled→enabled — hard-restart gateway (bg)');
          (async () => {
            try {
              console.log('[restart-guard] resume-zalo: hard-restart begin');
              try { await stopOpenClaw(); } catch (e1) { console.warn('[resume-zalo] stop failed:', e1?.message); }
              await new Promise(r => setTimeout(r, 5000));
              try { await startOpenClaw({ ignoreCooldown: true }); } catch (e2) { console.warn('[resume-zalo] start failed:', e2?.message); }
              // [zalo-watchdog rearm] Post-restart: wipe any pre-restart miss
              // streak so next watchdog miss doesn't immediately re-trip cap.
              global._zaloListenerMissStreak = 0;
              console.log('[restart-guard] resume-zalo: hard-restart end');
            } finally {
              ctx.gatewayRestartInFlight = false;
            }
          })();
        }
      }
      return { success: resumed && enabled && cleared };
    });
  } finally { ctx.ipcInFlightCount--; }
});
ipcMain.handle('get-zalo-pause-status', async () => {
  try { return getChannelPauseStatus('zalo'); }
  catch (e) { return { paused: true, permanent: true, error: e.message }; }
});

// Inbound debounce — how long bot waits to coalesce rapid messages from
// same customer into 1 turn. Openclaw has one global setting; we expose
// it via 2 sliders (Telegram + Zalo pages) that share the same backend
// so CEO can adjust from either page. Default 3000ms; 0 = no coalesce.
ipcMain.handle('get-inbound-debounce', async () => {
  try {
    const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return { telegram: 0, zalo: 0 };
    const cfg = readOpenclawJsonFile(cfgPath);
    const globalMs = cfg?.messages?.inbound?.debounceMs ?? 0;
    return { telegram: globalMs, zalo: globalMs };
  } catch { return { telegram: 0, zalo: 0 }; }
});
ipcMain.handle('set-inbound-debounce', async (_e, { channel, ms } = {}) => {
  const booting = rejectIfBooting('set-inbound-debounce');
  if (booting) return booting;
  ctx.ipcInFlightCount++;
  try {
    if (!['telegram', 'zalo'].includes(channel)) return { success: false, error: 'channel must be telegram or zalo' };
    const clampedMs = Math.max(0, Math.min(10000, Number(ms) || 0));
    return await withOpenClawConfigLock(async () => {
      const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(cfgPath)) return { success: false, error: 'config not found' };
      const cfg = readOpenclawJsonFile(cfgPath);
      // Write debounce at global level only — per-channel `channels.telegram.messages`
      // is NOT in openclaw's Telegram schema and causes "must NOT have additional
      // properties" rejection. openclaw reads `config.messages.inbound.debounceMs`.
      if (!cfg.messages) cfg.messages = {};
      if (!cfg.messages.inbound) cfg.messages.inbound = {};
      const prev = cfg.messages.inbound.debounceMs;
      cfg.messages.inbound.debounceMs = clampedMs;
      // Do NOT clean up channels.telegram.messages here — deleting it
      // changes the channels.telegram subtree, which triggers a Telegram
      // channel hot restart via gateway config reloader. That tears down
      // the Telegram bot handler mid-operation → messages lost → "hư".
      // Legacy cleanup is handled by ensureDefaultConfig at boot (config.js line 650).
      writeOpenClawConfigIfChanged(cfgPath, cfg);

      // Gateway captures debounceMs in a closure at startup — config reload
      // plan for "messages" prefix is kind:"none" (no hot reload). Must
      // restart gateway for the new value to take effect.
      if (prev !== clampedMs) {
        setTimeout(async () => {
          try {
            console.log('[debounce] restarting gateway to apply new debounceMs:', clampedMs);
            await stopOpenClaw();
            await startOpenClaw({ silent: true });
          } catch (e) { console.error('[debounce] gateway restart failed:', e?.message); }
        }, 1500);
      }

      return { success: true, ms: clampedMs };
    });
  } catch (e) {
    return { success: false, error: e?.message };
  } finally { ctx.ipcInFlightCount--; }
});

// App prefs (start minimized, etc.) — persisted in <userData>/app-prefs.json
ipcMain.handle('get-app-prefs', async () => {
  try { return loadAppPrefs(); }
  catch (e) { return {}; }
});
ipcMain.handle('set-app-prefs', async (_e, partial) => {
  try { const next = saveAppPrefs(partial || {}); return next || loadAppPrefs(); }
  catch (e) { return { error: e.message }; }
});

// ─── Brand Assets IPC ────────────────────────────────────────────
ipcMain.handle('list-brand-assets', async () => {
  try {
    mediaLibrary.backfillLegacyBrandAssets();
    // audience:'ceo' — this is the CEO's own Dashboard (trusted local UI), so it
    // must see brand assets regardless of visibility. Brand assets default to
    // 'internal'; without an explicit audience listMediaAssets fail-closes to
    // 'customer' and hides them all (the "brand images lost" bug).
    return mediaLibrary.listMediaAssets({ type: 'brand', audience: 'ceo' }).map(asset => {
      const filePath = asset.path;
      if (!filePath || !fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      let thumbDataUrl = '';
      try {
        if (stat.size < 10 * 1024 * 1024) {
          const buf = fs.readFileSync(filePath);
          thumbDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        }
      } catch {}
      return { id: asset.id, name: asset.filename, title: asset.title, size: stat.size, thumbDataUrl, description: asset.description || '', status: asset.status || 'indexed' };
    }).filter(Boolean);
  } catch { return []; }
});

ipcMain.handle('upload-brand-asset', async (_event, filePath, name) => {
  try {
    const dir = getBrandAssetsDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(name || path.basename(filePath)).replace(/[\\/:*?"<>|]/g, '_');
    if (!isPathSafe(dir, safeName)) return { success: false, error: 'invalid filename' };
    const ext = path.extname(safeName).toLowerCase();
    if (!BRAND_ASSET_FORMATS.includes(ext)) return { success: false, error: 'only png/jpg/webp allowed' };
    const buf = fs.readFileSync(filePath);
    if (buf.length > BRAND_ASSET_MAX_SIZE) return { success: false, error: 'file too large (max 10MB)' };
    const dst = path.join(dir, safeName);
    fs.writeFileSync(dst, buf);
    try {
      const asset = mediaLibrary.registerExistingMediaFile(dst, {
        type: 'brand',
        visibility: 'internal',
        source: 'dashboard-brand-upload',
        status: 'indexed',
      });
      // Fire-and-forget: generate description async so bot can use asset immediately
      if (asset && asset.id) {
        mediaLibrary.describeMediaAsset(asset.id).catch(e =>
          console.warn('[media] brand describe failed:', e?.message)
        );
      }
    } catch (e) { console.warn('[media] brand upload register failed:', e.message); }
    return { success: true, name: safeName };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('delete-brand-asset', async (_event, name) => {
  try {
    const dir = getBrandAssetsDir();
    const asset = mediaLibrary.findMediaAsset(name);
    if (asset) return mediaLibrary.deleteMediaAsset(asset.id);
    if (!isPathSafe(dir, name)) return { success: false };
    const fp = path.resolve(dir, name);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch { return { success: false }; }
});

ipcMain.handle('pick-brand-asset-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Chọn ảnh tài sản thương hiệu',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

// ─── Premium Onboarding 7 Ngày IPC ────────────────────────────────

// ─── Media Assets ─────────────────────────────────────────────────
ipcMain.handle('list-media-assets', async (_event, filters) => {
  try {
    mediaLibrary.backfillLegacyBrandAssets();
    // Default audience:'ceo' — the Media tab is the CEO's own Dashboard, so it
    // sees all visibility tiers. (A renderer can still pass an explicit audience
    // to preview a narrower view.) Without this it fail-closes to 'customer' and
    // hides every internal/generated asset.
    return mediaLibrary.listMediaAssets({ ...(filters || {}), audience: (filters && filters.audience) || 'ceo' });
  } catch { return []; }
});

ipcMain.handle('upload-media-asset', async (_event, { filePath, type = 'product', title = '', tags = '', aliases = '', description = '', visibility } = {}) => {
  try {
    const asset = mediaLibrary.importMediaFile(filePath, { type, title, tags, aliases, description, visibility });
    if (!asset.description || asset.type === 'product') {
      mediaLibrary.describeMediaAsset(asset.id).catch(e => {
        console.warn('[media] async describe failed:', e.message);
      });
    }
    return { success: true, asset };
  } catch (e) { return { success: false, error: mediaLibrary.localizeMediaError(e) }; }
});

ipcMain.handle('describe-media-asset', async (_event, id) => {
  try {
    const asset = await mediaLibrary.describeMediaAsset(id);
    return { success: true, asset };
  } catch (e) { return { success: false, error: mediaLibrary.localizeMediaError(e) }; }
});

ipcMain.handle('search-media-assets', async (_event, { query, type = 'product', limit = 10 } = {}) => {
  try {
    if (!query || query.trim().length < 2) return [];
    return mediaLibrary.searchMediaAssets(query.trim(), {
      type: type && type !== 'brand' ? type : undefined,
      limit: Math.min(Number(limit) || 10, 20),
      audience: 'customer',
      minScore: 2,
    });
  } catch (e) { return []; }
});

ipcMain.handle('delete-media-asset', async (_event, id) => {
  try { return mediaLibrary.deleteMediaAsset(id); }
  catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('pick-media-asset-file', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Chọn ảnh tài sản hình ảnh',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

// ─── Facebook IPC ────────────────────────────────────────────────
ipcMain.handle('get-fb-schedules', async () => {
  try {
    const fbSched = require('./fb-schedule');
    return fbSched.loadSchedules();
  } catch { return []; }
});

ipcMain.handle('delete-fb-schedule', async (_event, id) => {
  try {
    const fbSched = require('./fb-schedule');
    const schedules = fbSched.loadSchedules();
    const filtered = schedules.filter(s => s.id !== id);
    if (filtered.length === schedules.length) return { success: false, error: 'not_found' };
    fbSched.saveSchedules(filtered);
    auditLog('fb_schedule_deleted', { id });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('toggle-fb-schedule', async (_event, { id, enabled }) => {
  try {
    const fbSched = require('./fb-schedule');
    const schedules = fbSched.loadSchedules();
    const target = schedules.find(s => s.id === id);
    if (!target) return { success: false, error: 'not_found' };
    target.enabled = !!enabled;
    fbSched.saveSchedules(schedules);
    auditLog('fb_schedule_toggled', { id, enabled: !!enabled });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-fb-config', async () => {
  const cfg = readFbConfig();
  if (!cfg) return null;
  const fbPub = require('./fb-publisher');
  // listPages() returns [{id, pageId, pageName, shortName, enabled, tokenId, tokenStatus}]
  return { connectedAt: cfg.connectedAt, pages: fbPub.listPages() };
});

ipcMain.handle('save-fb-config', async (_event, { accessToken }) => {
  try {
    const fbPub = require('./fb-publisher');
    const result = await fbPub.verifyToken(accessToken);
    if (!result.valid) return { success: false, error: result.error };
    const verified = result.pages || [];
    if (!verified.length) return { success: false, error: 'Không tìm thấy Fanpage nào có quyền đăng bài.' };

    // Preserve per-page settings (shortName/enabled) across reconnect. Internal
    // page ids are deterministic from the Facebook pageId, so re-pasting the same
    // token re-maps to the same internal ids and keeps the CEO's customizations.
    const existing = readFbConfig();
    const prevById = {};
    if (existing && Array.isArray(existing.pages)) {
      for (const p of existing.pages) prevById[p.id] = p;
    }

    const connectedAt = new Date().toISOString();
    const tokenId = generateFbId('tok', verified.map(p => p.pageId).sort().join(','));
    const pages = verified.map(v => {
      const internalId = generateFbId('page', v.pageId);
      const prev = prevById[internalId] || {};
      return {
        id: internalId,
        tokenId,
        pageId: v.pageId,
        pageAccessToken: v.pageToken,
        pageName: v.pageName,
        shortName: prev.shortName ?? null,
        enabled: prev.enabled !== undefined ? prev.enabled : true,
        connectedAt: prev.connectedAt || connectedAt,
      };
    });
    // Pages that existed before but the new token no longer grants — they vanish
    // from config, so surface the names to the CEO instead of dropping silently.
    const newIds = new Set(pages.map(p => p.id));
    const removed = (existing && Array.isArray(existing.pages) ? existing.pages : [])
      .filter(p => !newIds.has(p.id))
      .map(p => p.pageName || p.pageId);
    const cfg = {
      tokens: [{
        id: tokenId,
        userToken: null,
        isLegacy: false,
        pageIds: pages.map(p => p.id),
        connectedAt,
      }],
      pages,
      connectedAt,
    };
    writeFbConfig(cfg);
    return { success: true, count: pages.length, removed, pages: pages.map(p => ({ id: p.id, pageName: p.pageName })) };
  } catch (e) { return { success: false, error: e.message }; }
});

// Toggle a page on/off or set its short name (used by the bot for "post to <shortName>").
ipcMain.handle('update-fb-page', async (_event, { id, shortName, enabled }) => {
  try {
    const cfg = readFbConfig();
    if (!cfg || !Array.isArray(cfg.pages)) return { success: false, error: 'Chưa kết nối Facebook' };
    const page = cfg.pages.find(p => p.id === id);
    if (!page) return { success: false, error: 'Không tìm thấy Fanpage' };
    if (shortName !== undefined) page.shortName = shortName ? String(shortName).trim() : null;
    if (enabled !== undefined) page.enabled = !!enabled;
    writeFbConfig(cfg);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('verify-fb-token', async () => {
  const cfg = readFbConfig();
  const page = cfg && Array.isArray(cfg.pages) ? cfg.pages.find(p => p.enabled && p.pageAccessToken) : null;
  if (!page) return { valid: false, error: 'Chưa kết nối Facebook' };
  const fbPub = require('./fb-publisher');
  const result = await fbPub.verifyToken(page.pageAccessToken);
  if (!result.valid) return result;
  // Strip pageToken from each page before sending to renderer
  const pages = (result.pages || []).map(({ pageToken, ...rest }) => rest);
  return { valid: true, pages };
});

// ─── Facebook Ads (bring-your-own token; the CEO's OWN ad account) ───────────
// A different grant (ads_management/ads_read) from the page token, stored in a
// separate encrypted file. The renderer NEVER receives the token back — only the
// connection status and account metadata. Connect is two steps so the CEO can
// pick which ad account when the token manages more than one.
ipcMain.handle('get-fb-ads-config', async () => {
  const cfg = readFbAdsConfig();
  if (!cfg || !cfg.systemUserToken) return { connected: false };
  return {
    connected: true,
    tokenError: !!cfg.tokenError,
    account: { id: cfg.adAccountId, name: cfg.accountName, currency: cfg.currency, minDailyBudget: cfg.minDailyBudget },
    hasAdsManagement: cfg.hasAdsManagement,
    tokenKind: cfg.tokenKind,
    connectedAt: cfg.connectedAt,
  };
});

// Step 1: verify a pasted token and list the ad accounts it can manage. Saves
// nothing — the CEO picks an account, then save-fb-ads-config persists it.
ipcMain.handle('verify-fb-ads-token', async (_event, { token }) => {
  try {
    const adsApi = require('./fb-ads-api');
    const t = String(token || '').trim();
    if (!t) return { ok: false, error: 'Chưa nhập token.' };
    const v = await adsApi.verifyAdsToken(t);
    if (!v.ok) return { ok: false, error: 'Token không có quyền quảng cáo (cần ads_management hoặc ads_read).' };
    const accounts = await adsApi.getAdAccounts(t);
    return { ok: true, userName: v.userName, hasAdsManagement: v.hasAdsManagement, hasAdsRead: v.hasAdsRead, accounts };
  } catch (e) {
    if (e._isTokenExpired || e._httpStatus === 401) return { ok: false, error: 'Token hết hạn hoặc sai. Tạo token mới trong Meta.' };
    return { ok: false, error: e.message };
  }
});

// Step 2: persist the chosen account + token (encrypted at rest).
ipcMain.handle('save-fb-ads-config', async (_event, { token, adAccountId, tokenKind }) => {
  try {
    const adsApi = require('./fb-ads-api');
    const t = String(token || '').trim();
    const want = String(adAccountId || '').trim();
    if (!t || !want) return { success: false, error: 'Thiếu token hoặc tài khoản quảng cáo.' };
    const v = await adsApi.verifyAdsToken(t);
    if (!v.ok) return { success: false, error: 'Token không có quyền quảng cáo.' };
    const accounts = await adsApi.getAdAccounts(t);
    const chosen = accounts.find(a => a.id === adsApi.normalizeActId(want));
    if (!chosen) return { success: false, error: 'Không tìm thấy tài khoản quảng cáo đã chọn.' };
    // Allow VND + USD (both have a verified Graph-API offset: đồng ×1, cents ×100); reject
    // any other currency whose offset is unverified — a wrong offset mis-scales the budget.
    // Mirrors cron-api.js /api/fb/ads/connect so BOTH connect paths (Telegram + Dashboard)
    // check, and a currency we can't price can never be persisted whichever UI the CEO uses.
    const _curErr = require('./fb-ads-policy').unsupportedCurrencyError(chosen.currency);
    if (_curErr) return { success: false, error: _curErr };
    writeFbAdsConfig({
      systemUserToken: t,
      adAccountId: chosen.id,
      currency: chosen.currency,
      accountName: chosen.name,
      minDailyBudget: chosen.minDailyBudget,
      hasAdsManagement: v.hasAdsManagement,
      tokenKind: tokenKind === 'system_user' ? 'system_user' : 'user',
      connectedAt: new Date().toISOString(),
    });
    auditLog('fb_ads_connect', { account: chosen.id, currency: chosen.currency, source: 'dashboard' });
    return { success: true, account: { id: chosen.id, name: chosen.name, currency: chosen.currency, minDailyBudget: chosen.minDailyBudget }, hasAdsManagement: v.hasAdsManagement };
  } catch (e) {
    if (e._isTokenExpired || e._httpStatus === 401) return { success: false, error: 'Token hết hạn hoặc sai.' };
    if (e._isPermission) return { success: false, error: 'Token thiếu quyền ads_management.' };
    return { success: false, error: e.message };
  }
});

ipcMain.handle('disconnect-fb-ads', async () => {
  try { require('fs').unlinkSync(getFbAdsConfigPath()); } catch {}
  auditLog('fb_ads_disconnect', { source: 'dashboard' });
  return { success: true };
});

ipcMain.handle('get-fb-recent-posts', async () => {
  const cfg = readFbConfig();
  // Shows the first enabled page's posts — the UI labels which page so the CEO
  // isn't misled into thinking these are from a different connected fanpage.
  const page = cfg && Array.isArray(cfg.pages) ? cfg.pages.find(p => p.enabled && p.pageAccessToken) : null;
  if (!page) return { pageName: null, posts: [] };
  try {
    const fbPub = require('./fb-publisher');
    const posts = await fbPub.getRecentPosts(page.pageId, page.pageAccessToken, 5);
    return { pageName: page.pageName, posts: posts || [] };
  } catch { return { pageName: page.pageName, posts: [] }; }
});


// -> fastWatchdog, triggerGatewayMessage extracted to lib/gateway.js

// ============================================================================
// handleTimCommand, handleThongkeCommand, handleBaocaoCommand, handleTelegramBuiltinCommand — moved to lib/cron.js
// healCustomCronEntries, loadCustomCrons, customCronWatcher/state, watchCustomCrons — moved to lib/cron.js
// ─── Local Cron API (port 20200) — moved to lib/cron-api.js ────────────────
// startCronApi, getCronApiToken, getCronApiPort, cleanupCronApi imported above.
// _cronApiServer, _cronApiPort, _cronApiToken are module-level state in cron-api.js.
// Legacy marker (do not remove — used by grep/audit tooling):
// function startCronApi() {

// IPC: bot or dashboard can queue a follow-up.
// Race safety: processFollowUpQueue holds _followUpQueueLock for the entire async duration
// (up to 600s while runCronAgentPrompt executes). A 150ms yield was insufficient.
// Instead, processFollowUpQueue re-reads the queue file before its final write (see above),
// so any IPC-written entries that arrived during the long await are merged back in.
// The IPC handler itself simply writes immediately — it only appends, never overwrites.
ipcMain.handle('queue-follow-up', async (_event, { channel, recipientId, recipientName, question, prompt, delayMinutes }) => {
  try {
    const clampedDelay = Math.max(1, Math.min(Number(delayMinutes) || 15, 1440));
    const id = 'fu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const fireAt = new Date(Date.now() + clampedDelay * 60 * 1000).toISOString();
    await queueFollowUpSafe({ id, channel: channel || 'zalo', recipientId, recipientName, question, prompt, fireAt });
    console.log('[follow-up] Queued:', id, 'fire at', fireAt);
    return { success: true, id, fireAt };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// _startCronJobsInFlight, startCronJobs, _startCronJobsInner, _customCronWriteChain, _withCustomCronLock, _removeCustomCronById, surfaceCronConfigError, stopCronJobs, restartCronJobs — moved to lib/cron.js
// ============================================
//  DOCUMENT LIBRARY (Telegram file → FTS5 index)
// ============================================

/**
 * Guard against a compromised renderer supplying a crafted filepath to exfiltrate
 * sensitive files via the knowledge-upload path.
 *
 * Strategy: denylist of clearly-sensitive locations (conservative — we block the
 * obvious dangerous dirs, NOT allowlist valid doc paths, so Desktop/Downloads/etc.
 * all pass). The normal flow (main-process file dialog → pick-knowledge-file →
 * renderer → upload-knowledge-file) always returns a user-chosen path that will
 * pass this check.
 *
 * @param {string} absPath - Renderer-supplied source path
 * @returns {boolean} true = safe to proceed; false = reject
 */
function isUploadSourceSafe(absPath) {
  if (!absPath || typeof absPath !== 'string') return false;
  let resolved;
  try {
    // realpathSync resolves symlinks so a link into /etc still gets caught.
    resolved = fs.realpathSync(absPath);
  } catch {
    // File does not exist or is inaccessible — reject (statSync below will also
    // reject, but being explicit here avoids a misleading error message).
    return false;
  }
  let stat;
  try { stat = fs.statSync(resolved); } catch { return false; }
  if (!stat.isFile()) return false;

  // Normalize to forward-slash lowercase for portable substring checks.
  const norm = resolved.toLowerCase().replace(/\\/g, '/');

  // Sensitive directory prefixes / substrings — block anything touching these.
  const BLOCKED = [
    '/.ssh/',          // SSH private keys (all OS)
    '/.openclaw/',     // app credentials/tokens
    '/.openzca/',      // openzca session/credentials
    '/.aws/',          // AWS credentials
    '/.gnupg/',        // GPG private keys
    '/.config/gcloud', // GCP credentials
    '/appdata/roaming/9bizclaw/',  // app license store (Windows)
    '/windows/system32',           // Windows OS files
    '/windows/syswow64',           // Windows OS files (32-bit compat)
    '/private/etc/',               // macOS /etc
    '/etc/passwd',
    '/etc/shadow',
    '/etc/ssh/',
    // Common credential file name fragments (path-segment check below handles dirs;
    // these catch individual files that might live anywhere)
  ];
  if (BLOCKED.some(b => norm.includes(b))) return false;

  // Also block if any path segment looks like a well-known credential store.
  const BLOCKED_SEGMENTS = ['.ssh', '.gnupg', '.aws', '.openclaw', '.openzca'];
  const segments = norm.split('/');
  if (segments.some(seg => BLOCKED_SEGMENTS.includes(seg))) return false;

  return true;
}

ipcMain.handle('upload-knowledge-file', async (_event, { category, filepath, originalName, visibility = 'public' }) => {
  if (!['public', 'internal', 'private'].includes(visibility)) {
    return { success: false, error: 'Chế độ hiển thị không hợp lệ. Vui lòng chọn Công khai, Nội bộ hoặc Chỉ CEO.' };
  }
  if (!isUploadSourceSafe(filepath)) {
    return { success: false, error: 'Đường dẫn file không hợp lệ hoặc nằm trong vùng bảo mật.' };
  }
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) {
      return { success: false, error: 'Loại không hợp lệ' };
    }
    if (!fs.existsSync(filepath)) return { success: false, error: 'File không tồn tại' };
    const stat = fs.statSync(filepath);
    // 100MB cap: CEO brochures/catalogs/handbooks routinely 20-80MB. pdf-parse 1.1.1 loads full buffer in memory,
    // but 100MB peak is fine on 8GB-RAM laptop (parsed briefly, GC'd after). summarizeKnowledgeContent slices
    // content before LLM + DB row, so steady-state memory footprint remains small.
    if (stat.size > 100 * 1024 * 1024) return { success: false, error: 'File quá lớn (tối đa 100MB). Vui lòng tách PDF thành nhiều phần nhỏ hơn.' };

    ensureKnowledgeFolders();
    const baseFilesDir = path.join(getKnowledgeDir(category), 'files');
    const subDir = VISIBILITY_SUBFOLDERS[visibility] || 'public';
    const filesDir = path.join(baseFilesDir, subDir);
    try { fs.mkdirSync(filesDir, { recursive: true }); } catch {}
    let safeName = (originalName || path.basename(filepath)).replace(/[\\/:*?"<>|]/g, '_');
    safeName = safeName.replace(/[\x00-\x1F\x7F]/g, '');
    const finalName = resolveUniqueFilename(filesDir, safeName);
    const dst = path.join(filesDir, finalName);
    _watcherSkipPaths.add(dst);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, finalName, { visibility, category });
    if (content && /^\[(PDF|DOCX|Excel) extract failed: /.test(content)) {
      try { fs.unlinkSync(dst); } catch {}
      const errMsg = content.replace(/^\[/, '').replace(/\]$/, '');
      const prettyErr = errMsg.replace(/^(PDF|DOCX|Excel) extract failed:\s*/i, '').trim();
      return {
        success: false,
        error: `Không đọc được file "${finalName}": ${prettyErr}. Vui lòng kiểm tra 9Router/model vision hoặc thử export lại PDF rồi upload lại.`,
      };
    }
    // R3-F7: reject mostly-binary / OCR-garbage content. Scanned receipts
    // extracted by pdf-parse often return strings like "¶▶Ω≈∑ I p h O N e"
    // — embedding that pollutes the vector corpus. Require ≥30% printable
    // ASCII chars (digits/letters/punct/space) OR Vietnamese letter chars.
    // Skip for images — vision descriptions are always clean text.
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(path.extname(finalName).toLowerCase());
    if (content && content.length > 50 && !isImage) {
      // R4-F1: tighten OCR-garbage regex. Previous range \u00C0-\u1EF9 covers
      // ~8000 chars incl. Greek/Cyrillic/Arabic/Armenian/Hebrew — an Arabic
      // product catalog would pass the 30% gate. Narrow to Latin + Latin
      // Extended-A/B + Latin Extended Additional (VN range = \u1E00-\u1EFF).
      const printable = (content.match(/[\x20-\x7E\u00C0-\u024F\u1E00-\u1EFF]/g) || []).length;
      const ratio = printable / content.length;
      if (ratio < 0.30) {
        try { fs.unlinkSync(dst); } catch {}
        return {
          success: false,
          error: `File có vẻ là scan/ảnh chưa OCR (chỉ ${Math.round(ratio * 100)}% ký tự đọc được). Vui lòng OCR trước khi upload.`,
        };
      }
    }
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filetype = path.extname(finalName).toLowerCase().replace('.', '');
    const summary = await summarizeKnowledgeContent(content, finalName);
    const isKnowledgeImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(filetype);
    let mediaAsset = null;
    if (isKnowledgeImage) {
      try {
        mediaAsset = mediaLibrary.registerExistingMediaFile(dst, {
          type: 'knowledge_image',
          visibility,
          title: path.basename(finalName, path.extname(finalName)),
          description: content || '',
          source: 'knowledge-upload',
          status: content ? 'ready' : 'needs_vision',
          metadata: {
            knowledgeCategory: category,
            knowledgeFilename: finalName,
            knowledgeFilepath: dst,
          },
        });
      } catch (e) {
        console.warn('[knowledge] media register failed:', e.message);
      }
    }

    let dbWarning = null;
    const db = getDocumentsDb();
    if (db) {
      let insertedDocId = null;
      try {
        const insertBoth = db.transaction(() => {
          const info = insertDocumentRow(db, {
            filename: finalName, filepath: dst, content,
            filetype, filesize: stat.size, wordCount,
            category, summary, visibility
          });
          insertedDocId = Number(info.lastInsertRowid);
          db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)').run(finalName, content);
        });
        insertBoth();
        if (mediaAsset && insertedDocId) {
          try {
            mediaAsset = mediaLibrary.updateMediaAsset(mediaAsset.id, {
              metadata: {
                ...(mediaAsset.metadata || {}),
                documentId: insertedDocId,
              },
            });
          } catch (e) { console.warn('[knowledge] media document link failed:', e.message); }
        }
      } catch (e) {
        console.error('[knowledge] db insert error:', e.message);
        dbWarning = 'DB insert failed (file vẫn lưu trên disk): ' + e.message;
      }
      // K1: chunk + index for Vietnamese FTS5 search. Non-fatal if it fails —
      // the full document is still in documents_fts, just not snippet-retrievable.
      if (insertedDocId && content) {
        try {
          const res = indexDocumentChunks(db, insertedDocId, category, content);
          if (res && res.chunks > 0) {
            console.log(`[knowledge] indexed ${res.chunks} chunks for ${finalName}`);
          }
        } catch (e) { console.error('[knowledge] chunk index error:', e.message); }

        // RAG: embed every chunk for vector search (Tier 1). ~13ms/chunk sync —
        // for a 200-chunk doc (~100-page PDF) adds ~3s to upload. Non-fatal:
        // upload still succeeds on failure; boot-time backfill catches missed
        // rows. Skip rows with too-short text (noise, boilerplate).
        try {
          const chunkRows = db.prepare(
            'SELECT id, chunk_index, char_start, char_end FROM documents_chunks WHERE document_id = ? ORDER BY chunk_index'
          ).all(insertedDocId);
          const upsert = db.prepare(
            'UPDATE documents_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
          );
          const MODEL_STAMP = 'multilingual-e5-small-q';
          let embedded = 0;
          for (const row of chunkRows) {
            const chunkText = content.substring(row.char_start, row.char_end);
            if (!chunkText || chunkText.length < 50) continue;
            const vec = await embedText(chunkText, false);
            upsert.run(vecToBlob(vec), MODEL_STAMP, row.id);
            embedded++;
          }
          console.log(`[knowledge] embedded ${embedded}/${chunkRows.length} chunks for ${finalName}`);
        } catch (e) {
          console.error('[knowledge] embed error:', e.message);
          // Non-fatal — upload still succeeds. Backfill on boot catches missed rows.
        }
      }
    } else {
      dbWarning = 'DB không mở được — file đã lưu trên disk, sẽ index lại sau khi sửa DB.';
    }

    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-upload');
    return { success: true, filename: finalName, summary, wordCount, dbWarning, mediaAsset };
  } catch (e) {
    console.error('[knowledge] upload error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-knowledge-visibility', async (_event, { docId, visibility }) => {
  try {
    if (!Number.isInteger(docId) || docId <= 0) {
      return { success: false, error: 'Invalid docId' };
    }
    if (!['public', 'internal', 'private'].includes(visibility)) {
      return { success: false, error: 'Invalid visibility value' };
    }
    const db = getDocumentsDb();
    if (!db) return { success: false, error: 'DB unavailable' };
    let info, category, filename, filepath;
    try {
      const row = db.prepare('SELECT category, filename, filepath FROM documents WHERE id=?').get(docId);
      if (!row) return { success: false, error: 'Document not found' };
      category = row.category; filename = row.filename; filepath = row.filepath;
    } catch (e) {
      return { success: false, error: 'DB error: ' + e.message };
    }

    // ATOMIC ORDER: move the file to its visibility subfolder FIRST, then write
    // the DB. If the move fails we abort before touching the DB, so the DB's
    // visibility never disagrees with the file's folder — which the disk-scan /
    // backfill / DB-down display paths derive visibility from. If the DB write
    // fails after a successful move, we roll the file back.
    let newPath = filepath;
    let moved = false;
    if (filepath && filename && category) {
      const targetSubDir = VISIBILITY_SUBFOLDERS[visibility] || 'public';
      const targetDir = path.join(getKnowledgeDir(category), 'files', targetSubDir);
      const candidate = path.join(targetDir, filename);
      if (fs.existsSync(filepath) && filepath !== candidate) {
        try {
          fs.mkdirSync(targetDir, { recursive: true });
          _watcherSkipPaths.add(filepath);
          _watcherSkipPaths.add(candidate);
          fs.renameSync(filepath, candidate);
          try { moveKnowledgeDocumentState(filepath, candidate); } catch {}
          newPath = candidate;
          moved = true;
        } catch (e) {
          return { success: false, error: 'Không di chuyển được file sang thư mục ' + targetSubDir + ': ' + e.message };
        }
      }
    }
    try {
      info = db.prepare('UPDATE documents SET visibility=?, filepath=? WHERE id=?').run(visibility, newPath, docId);
    } catch (e) {
      if (moved) { try { fs.renameSync(newPath, filepath); moveKnowledgeDocumentState(newPath, filepath); } catch {} }
      return { success: false, error: 'DB error: ' + e.message };
    }
    if (!info || info.changes === 0) {
      if (moved) { try { fs.renameSync(newPath, filepath); moveKnowledgeDocumentState(newPath, filepath); } catch {} }
      return { success: false, error: 'Document not found' };
    }

    try { auditLog('visibility-change', { docId, visibility, ts: Date.now() }); } catch {}
    let indexWarning;
    if (category) {
      try { rewriteKnowledgeIndex(category); } catch (e) { indexWarning = e.message; }
      purgeAgentSessions('knowledge-visibility');
    }
    try {
      mediaLibrary.updateKnowledgeMediaAssets({ docId, filename, filepath: newPath }, { visibility });
    } catch (e) {
      indexWarning = indexWarning || e.message;
    }
    return { success: true, indexWarning };
  } catch (e) {
    console.error('[set-knowledge-visibility] error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-knowledge-enabled', async (_event, { docId, enabled }) => {
  try {
    if (!Number.isInteger(docId) || docId <= 0) {
      return { success: false, error: 'Invalid docId' };
    }
    const nextEnabled = enabled !== false;
    const db = getDocumentsDb();
    if (!db) return { success: false, error: 'DB unavailable' };
    let row, info;
    try {
      row = db.prepare('SELECT category, filename, filepath, enabled AS previousEnabled FROM documents WHERE id=?').get(docId);
      if (!row) return { success: false, error: 'Document not found' };
    } catch (e) {
      return { success: false, error: 'DB error: ' + e.message };
    }

    const previousEnabled = row.previousEnabled;
    try {
      setKnowledgeDocumentEnabledState(row.filepath, nextEnabled);
    } catch (e) {
      console.warn('[set-knowledge-enabled] state write error:', e.message);
      return { success: false, error: 'State write error: ' + e.message };
    }

    try {
      info = db.prepare('UPDATE documents SET enabled=? WHERE id=?').run(nextEnabled ? 1 : 0, docId);
    } catch (e) {
      try { setKnowledgeDocumentEnabledState(row.filepath, previousEnabled !== 0); } catch {}
      return { success: false, error: 'DB error: ' + e.message };
    }
    if (!info || (info.changes === 0 && (previousEnabled !== 0) !== nextEnabled)) {
      try { setKnowledgeDocumentEnabledState(row.filepath, previousEnabled !== 0); } catch {}
      return { success: false, error: 'Document not found' };
    }

    try { auditLog('knowledge-enabled-change', { docId, enabled: nextEnabled, ts: Date.now() }); } catch {}

    let indexWarning;
    if (row.category) {
      try { rewriteKnowledgeIndex(row.category); } catch (e) { indexWarning = e.message; }
      purgeAgentSessions('knowledge-enabled');
    }
    return { success: true, enabled: nextEnabled, indexWarning };
  } catch (e) {
    console.error('[set-knowledge-enabled] error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('list-knowledge-files', async (_event, { category }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return [];
    const diskRows = listKnowledgeFilesFromDisk(category);
    const db = getDocumentsDb();
    if (!db) {
      // DB unavailable (typically better-sqlite3 ABI mismatch). Return what's
      // actually on disk so the CEO never sees a blank Knowledge tab.
      return diskRows;
    }
    let dbRows = [];
    try {
      dbRows = db.prepare(
        'SELECT id, filename, filetype, filesize, word_count, summary, visibility, enabled, created_at FROM documents WHERE category = ? ORDER BY created_at DESC'
      ).all(category);
    } catch (e) {
      console.error('[knowledge] db query error:', e.message);
    }
    // Merge: prefer DB row (has summary) but include disk-only files (uploaded
    // while DB was broken).
    const dbNames = new Set(dbRows.map(r => r.filename));
    const diskOnly = diskRows.filter(r => !dbNames.has(r.filename));
    return [...dbRows, ...diskOnly];
  } catch (e) {
    console.error('[knowledge] list error:', e.message);
    // Last-ditch: still try disk-only.
    try { return listKnowledgeFilesFromDisk(category); } catch { return []; }
  }
});

ipcMain.handle('delete-knowledge-file', async (_event, { category, filename }) => {
  try {
    if (!KNOWLEDGE_CATEGORIES.includes(category)) return { success: false };
    if (!filename || typeof filename !== 'string' || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return { success: false, error: 'invalid filename' };
    }
    const db = getDocumentsDb();
    let docId = null;
    let storedFilepath = null;
    if (db) {
      try {
        const row = db.prepare('SELECT id, filepath FROM documents WHERE category = ? AND filename = ?').get(category, filename);
        docId = row?.id || null;
        storedFilepath = row?.filepath || null;
        const deleteAll = db.transaction(() => {
          if (row) {
            db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(row.id);
          }
          db.prepare('DELETE FROM documents WHERE category = ? AND filename = ?').run(category, filename);
          db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
        });
        deleteAll();
      } catch (e) {
        console.warn('[knowledge] DB delete failed:', e.message);
      }
    }
    const fp = storedFilepath || path.join(getKnowledgeDir(category), 'files', filename);
    try {
      mediaLibrary.deleteKnowledgeMediaAssets({ docId, filename, filepath: fp }, { keepPath: fp });
    } catch (e) { console.warn('[knowledge] media cleanup failed:', e.message); }
    try { removeKnowledgeDocumentState(fp); } catch {}
    if (fp) { _watcherSkipPaths.add(fp); }
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    // Fallback: check root level for legacy installs
    const rootFp = path.join(getKnowledgeDir(category), 'files', filename);
    if (rootFp !== fp && fs.existsSync(rootFp)) fs.unlinkSync(rootFp);
    rewriteKnowledgeIndex(category);
    purgeAgentSessions('knowledge-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-knowledge-counts', async () => {
  try {
    const cats = getKnowledgeCategories();
    const db = getDocumentsDb();
    const counts = {};
    for (const cat of cats) counts[cat] = 0;
    if (!db) {
      for (const cat of cats) counts[cat] = listKnowledgeFilesFromDisk(cat).length;
      return counts;
    }
    try {
      for (const cat of cats) {
        let n = 0;
        try { n = db.prepare('SELECT COUNT(*) as n FROM documents WHERE category = ?').get(cat)?.n || 0; } catch {}
        const diskFiles = listKnowledgeFilesFromDisk(cat);
        const dbNames = new Set();
        try {
          for (const r of db.prepare('SELECT filename FROM documents WHERE category = ?').all(cat)) dbNames.add(r.filename);
        } catch {}
        const diskExtra = diskFiles.filter(f => !dbNames.has(f.filename)).length;
        counts[cat] = n + diskExtra;
      }
      return counts;
    } catch (e) {
      console.warn('[knowledge] counts query failed:', e.message);
      return counts;
    }
  } catch {
    const counts = {};
    for (const cat of getKnowledgeCategories()) counts[cat] = 0;
    return counts;
  }
});

// === FIRST-TIME CHANNEL GUIDE IPC ===

ipcMain.handle('check-guide-needed', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { needed: false };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    if (fs.existsSync(guideFile)) {
      const data = JSON.parse(fs.readFileSync(guideFile, 'utf-8'));
      if (data && data[channel]) return { needed: false };
    }
  } catch {}
  return { needed: true };
});

ipcMain.handle('mark-guide-complete', async (_e, { channel }) => {
  const ws = getWorkspace();
  if (!ws) return { ok: false, error: 'workspace not ready' };
  const guideFile = path.join(ws, 'guide-completed.json');
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(guideFile, 'utf-8')); } catch {}
    existing[channel] = true;
    existing.completedAt = existing.completedAt || new Date().toISOString();
    writeJsonAtomic(guideFile, existing);
    return { ok: true };
  } catch (e) {
    console.error('[mark-guide-complete] write failed:', e?.message);
    return { ok: false, error: e?.message || 'write failed' };
  }
});

// List all knowledge folders with labels
ipcMain.handle('list-knowledge-folders', async () => {
  const cats = getKnowledgeCategories();
  return cats.map(cat => ({
    id: cat,
    label: KNOWLEDGE_LABELS[cat] || cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    isDefault: DEFAULT_KNOWLEDGE_CATEGORIES.includes(cat),
  }));
});

ipcMain.handle('knowledge-search', async (_event, payload) => {
  const { query, category, limit } = payload || {};
  try {
    const results = await searchKnowledge({ query, category, limit, audience: 'ceo' });
    return { success: true, results };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// RAG config — read/write rag-config.json in workspace root
ipcMain.handle('get-rag-config', async () => getRagConfig());
ipcMain.handle('set-rag-config', async (_event, cfg) => {
  try {
    const p = path.join(getWorkspace(), 'rag-config.json');
    // Whitelist rewriteModel to known 9Router slots. Prevents devtools/buggy-UI
    // from persisting invalid model IDs that would silently fail tier2 calls.
    const ALLOWED_MODELS = ['ninerouter/main', 'ninerouter/fast'];
    const requested = String((cfg && cfg.rewriteModel) || 'ninerouter/fast');
    const rewriteModel = ALLOWED_MODELS.includes(requested) ? requested : 'ninerouter/fast';
    writeJsonAtomic(p, {
      tier2Enabled: !!(cfg && cfg.tier2Enabled),
      rewriteModel,
      updatedAt: new Date().toISOString(),
    });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

// Open knowledge folder in OS file manager
ipcMain.handle('open-knowledge-folder', async (_event, { category }) => {
  try {
    const filesDir = path.join(getKnowledgeDir(category), 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const { shell } = require('electron');
    const err = await shell.openPath(filesDir);
    return { success: !err, error: err || undefined };
  } catch (e) { return { success: false, error: e.message }; }
});

// ─── Run-on-startup toggle (login item, Win + Mac; XDG autostart on Linux) ───
// The OS startup state IS the source of truth — the checkbox reads/writes it
// directly. main.js sets the default ON once on first boot (idempotent marker).
ipcMain.handle('startup:get', () => {
  try {
    if (process.platform === 'linux') return { enabled: require('./linux-autostart').isEnabled() };
    return { enabled: !!app.getLoginItemSettings().openAtLogin };
  } catch (e) { return { enabled: false, error: e.message }; }
});
ipcMain.handle('startup:set', (_event, { enabled } = {}) => {
  try {
    if (process.platform === 'linux') return require('./linux-autostart').setEnabled(!!enabled);
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return { success: true, enabled: !!enabled };
  } catch (e) { return { success: false, error: e.message }; }
});

// ─── MODORO AI: one-key turnkey provider setup ──────────────────────
// The CEO distributes ONE API key per customer. Pasting it here auto-configures the
// LOCAL 9router to route its combos through MODORO's hosted ChatGPT (an openai-compatible
// endpoint behind a fixed tunnel) — so the customer needs no ChatGPT account of their own.
// Flow: create a custom provider NODE (POST /api/provider-nodes, prefix "Modoro") → point
// the main+zalo combos at Modoro/<model>. Does NOT touch openclaw.json (it already routes
// ninerouter/main + ninerouter/zalo to the local 9router; combos are a 9router-side concern).
// NOTE: custom endpoints are NODES, not /api/providers connections (that 400s "Invalid provider").

ipcMain.handle('modoro:setup', async (_event, { apiKey } = {}) => setupModoroProvider(apiKey));


// ─── Free models: OpenCode (built-in, no key) ───────────────────────
// 9router ships a built-in noAuth/passthrough provider `opencode` (alias `oc`,
// baseUrl https://opencode.ai, x-opencode-client:desktop). Its catalog is
// live-fetched from opencode.ai/zen/v1/models and exposes "*-free" models that
// route at zero cost WITHOUT creating any provider connection — verified live:
// `oc/deepseek-v4-flash-free` and `oc/mimo-v2.5-free` return 200 / cost:"0".
// So "free" setup is purely combo wiring: point main+zalo at these two and
// ensure a local 9router API key exists. No provider create, no key paste.
const FREE_COMBO_MODELS = ['oc/deepseek-v4-flash-free', 'oc/mimo-v2.5-free'];

ipcMain.handle('free:setup', async () => {
  try {
    // 1. Ensure 9router is up
    if (!getRouterProcess()) start9Router();
    let ready = await waitFor9RouterReady(15000);
    if (!ready) {
      const ping = await nineRouterApi('GET', '/api/settings', null, 1500);
      if (ping.statusCode && ping.statusCode >= 500) {
        const fixed = await autoFix9RouterSqlite();
        if (fixed) { stop9Router(); await new Promise(r => setTimeout(r, 2500)); start9Router(); ready = await waitFor9RouterReady(30000); }
      }
    }
    if (!ready) return { success: false, error: '9router chưa khởi động được. Đóng/mở lại app rồi thử lại.' };

    // 2. Point combos main + zalo at the free OpenCode models (no provider connect needed)
    const combosRes = await nineRouterApi('GET', '/api/combos');
    const combos = combosRes.data?.combos || combosRes.data || [];
    const setCombo = async (name) => {
      const existing = (Array.isArray(combos) ? combos : []).find(c => c.name === name);
      if (existing) await nineRouterApi('PUT', `/api/combos/${existing.id}`, { name, models: FREE_COMBO_MODELS });
      else await nineRouterApi('POST', '/api/combos', { name, models: FREE_COMBO_MODELS });
    };
    await setCombo('main');
    await setCombo('zalo');
    console.log('[free:setup] combos main+zalo →', FREE_COMBO_MODELS.join(', '));

    // 3. Ensure a local 9router API key exists + capture it for the wizard
    let localApiKey = null;
    try {
      const keysRes = await nineRouterApi('GET', '/api/keys');
      const keys = keysRes.data?.keys || keysRes.data || [];
      const activeKey = (Array.isArray(keys) ? keys : []).find(k => k.isActive !== false && k.key);
      if (activeKey) {
        localApiKey = activeKey.key;
      } else {
        const createKey = await nineRouterApi('POST', '/api/keys', { name: '9BizClaw' });
        localApiKey = createKey.data?.key?.key || createKey.data?.key || null;
      }
    } catch {}
    if (!localApiKey) return { success: false, error: 'Không lấy được khóa 9router nội bộ. Thử lại.' };

    return {
      success: true,
      apiKey: localApiKey,
      modelCount: FREE_COMBO_MODELS.length,
      models: FREE_COMBO_MODELS.slice(),
    };
  } catch (e) {
    return { success: false, error: 'Lỗi kết nối model miễn phí: ' + (e?.message || String(e)) };
  }
});

// Open the AI-generated images folder (brand-assets/generated) in OS file manager.
// All generated images are kept here forever (no auto-cleanup), so this is the CEO's
// way to browse / back them up by hand.
ipcMain.handle('open-generated-folder', async () => {
  try {
    const dir = path.join(getBrandAssetsDir(), 'generated');
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = require('electron');
    const err = await shell.openPath(dir);
    return { success: !err, error: err || undefined };
  } catch (e) { return { success: false, error: e.message }; }
});

// Create custom knowledge folder
ipcMain.handle('create-knowledge-folder', async (_event, { name }) => {
  try {
    // Sanitize: lowercase, replace spaces with dash, remove non-alphanumeric
    const id = String(name).toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id || id.length < 2) return { success: false, error: 'Tên thư mục quá ngắn' };
    if (id.length > 30) return { success: false, error: 'Tên thư mục quá dài (tối đa 30 ký tự)' };
    const dir = path.join(getWorkspace(), 'knowledge', id, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const label = String(name).trim();
    KNOWLEDGE_LABELS[id] = label;
    const indexFile = path.join(getWorkspace(), 'knowledge', id, 'index.md');
    if (!fs.existsSync(indexFile)) {
      fs.writeFileSync(indexFile, `# Knowledge — ${label}\n\n*Chưa có tài liệu nào.*\n`, 'utf-8');
    }
    return { success: true, id, label };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Delete custom knowledge folder (only non-default)
ipcMain.handle('delete-knowledge-folder', async (_event, { id }) => {
  try {
    if (!/^[a-z0-9-]+$/.test(id)) return { success: false, error: 'Invalid folder name' };
    if (DEFAULT_KNOWLEDGE_CATEGORIES.includes(id)) return { success: false, error: 'Không thể xóa thư mục mặc định' };
    const dir = path.join(getWorkspace(), 'knowledge', id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clean DB entries (documents + FTS + chunks)
    try {
      const db = getDocumentsDb();
      if (db) {
        const rows = db.prepare('SELECT id, filename FROM documents WHERE category = ?').all(id);
        const delChunks = db.prepare('DELETE FROM documents_chunks WHERE document_id = ?');
        const delFts = db.prepare('DELETE FROM documents_fts WHERE filename = ?');
        for (const row of rows) {
          try { delChunks.run(row.id); } catch {}
          try { delFts.run(row.filename); } catch {}
        }
        db.prepare('DELETE FROM documents WHERE category = ?').run(id);
      }
    } catch {}
    purgeAgentSessions('knowledge-folder-delete');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// File picker (Electron native dialog) — for upload UI
ipcMain.handle('pick-knowledge-file', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Chọn file để thêm vào Knowledge',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Tài liệu', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'csv'] },
        { name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'Tất cả', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, filePaths: result.filePaths };
  } catch (e) {
    return { canceled: true, error: e.message };
  }
});

ipcMain.handle('index-document', async (_event, { filepath, filename }) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    if (!isUploadSourceSafe(filepath)) return { success: false, error: 'Invalid or disallowed source path' };
    ensureDocumentsDir();
    const dst = path.join(getDocumentsDir(), filename);
    fs.copyFileSync(filepath, dst);

    const content = await extractTextFromFile(dst, filename);
    const wordCount = content ? content.split(/\s+/).length : 0;
    const filesize = fs.statSync(dst).size;
    const filetype = path.extname(filename).toLowerCase().replace('.', '');

    const db = getDocumentsDb();
    if (db) {
      const insertBoth = db.transaction(() => {
        insertDocumentRow(db, {
          filename, filepath: dst, content,
          filetype, filesize, wordCount
        });
        db.prepare('INSERT INTO documents_fts (filename, content) VALUES (?, ?)')
          .run(filename, content);
      });
      insertBoth();
    }

    return { success: true, filename, wordCount, filesize };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('search-documents', async (_event, query) => {
  let db;
  try {
    db = getDocumentsDb();
    if (!db) return [];
    // Layer 1: expand query for better recall.
    const expandedQuery = await expandSearchQuery(query);
    if (expandedQuery !== query) console.log(`[search] expanded "${query}" → "${expandedQuery}"`);
    // Layer 2: FTS5 search with expanded query.
    // NOTE: documents_fts JOIN on filename can fan-out when the same filename
    // exists in multiple categories (unique index is on (filename, category),
    // not filename alone). We select d.id and dedupe by it in JS (rank order
    // preserved) so cross-category duplicates are eliminated without touching
    // the visibility gate.
    let results;
    try {
      results = db.prepare(`
        SELECT d.id, d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
          AND d.enabled = 1
          AND d.visibility IN ('public')
        ORDER BY rank
        LIMIT 20
      `).all(expandedQuery);
    } catch {
      // Expanded query may have FTS5 syntax issues — fall back to original.
      results = db.prepare(`
        SELECT d.id, d.filename, d.filetype, d.word_count, d.created_at,
               snippet(documents_fts, 1, '**', '**', '...', 32) as snippet
        FROM documents_fts f
        JOIN documents d ON d.filename = f.filename
        WHERE documents_fts MATCH ?
          AND d.enabled = 1
          AND d.visibility IN ('public')
        ORDER BY rank
        LIMIT 20
      `).all(query);
    }
    // Dedupe by document id (eliminates cross-category fan-out from filename JOIN).
    // Rank order is preserved; first occurrence of each id wins.
    const seenIds = new Set();
    results = results.filter(r => { if (seenIds.has(r.id)) return false; seenIds.add(r.id); return true; }).slice(0, 10);
    if (results.length === 0) return results;
    // Layer 3: rerank for semantic relevance.
    return await rerankSearchResults(query, results);
  } catch (e) { return []; }
  finally {}
});

ipcMain.handle('list-documents', async () => {
  try {
    const db = getDocumentsDb();
    if (!db) return [];
    const docs = db.prepare('SELECT filename, filetype, word_count, filesize, created_at FROM documents ORDER BY created_at DESC').all();
    return docs;
  } catch { return []; }
});

ipcMain.handle('delete-document', async (_event, filename) => {
  try {
    if (!filename || /[\/\\]/.test(filename) || filename.includes('..')) return { success: false, error: 'Invalid filename' };
    const db = getDocumentsDb();
    if (db) {
      const row = db.prepare('SELECT id FROM documents WHERE filename = ?').get(filename);
      if (row) { try { db.prepare('DELETE FROM documents_chunks WHERE document_id = ?').run(row.id); } catch {} }
      db.prepare('DELETE FROM documents WHERE filename = ?').run(filename);
      db.prepare('DELETE FROM documents_fts WHERE filename = ?').run(filename);
    }
    const fp = path.join(getDocumentsDir(), filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('test-telegram', async (_event, { token, chatId }) => {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({
      chat_id: chatId, text: '9BizClaw — Kết nối thành công!', parse_mode: 'Markdown',
    });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => { try { resolve({ success: JSON.parse(data).ok }); } catch { resolve({ success: false }); } });
      }
    );
    req.on('error', () => resolve({ success: false }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ success: false }); });
    req.write(payload);
    req.end();
  });
});

// Check all channels — fast, reliable, based on config + process state + HTTP ping
ipcMain.handle('check-all-channels', async () => {
  const r = {
    telegram: 'not_configured',
    zalo: 'not_configured',
    ai: 'stopped',
    google: 'not_configured',
    gateway: ctx.botRunning ? 'ok' : 'stopped',
  };

  // 1. 9Router — HTTP ping 127.0.0.1:20128
  r.ai = await new Promise((resolve) => {
    const req = require('http').get('http://127.0.0.1:20128/v1/models', { timeout: 3000 }, (res) => {
      res.resume();
      console.log('9Router check: status', res.statusCode);
      resolve(res.statusCode === 200 ? 'ok' : 'error');
    });
    req.on('error', (e) => { console.log('9Router check ERROR:', e.code, e.message); resolve('stopped'); });
    req.on('timeout', () => { console.log('9Router check TIMEOUT'); req.destroy(); resolve('stopped'); });
  });

  // 2. Telegram — check botToken in openclaw.json
  try {
    const tg = await probeTelegramReady();
    const { token } = getTelegramConfig();
    const telegramPause = getChannelPauseStatus('telegram');
    if (!token) {
      r.telegram = 'not_configured';
    } else if (telegramPause?.permanent) {
      r.telegram = 'disabled';
    } else if (telegramPause?.paused) {
      r.telegram = 'paused';
    } else if (tg.ready) {
      r.telegram = 'ok';
    } else if (tg.awaitingConfirmation) {
      r.telegram = 'checking';
    } else if (tg.reason === 'no-ceo-chat-id') {
      r.telegram = 'error';
    } else {
      r.telegram = ctx.botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 3. Zalo — check credentials file
  try {
    const zl = await probeZaloReady();
    if (zl.reason === 'config-error') {
      r.zalo = 'error';
    } else if (zl.reason === 'disabled' || zl.reason === 'paused-permanent') {
      r.zalo = 'disabled';
    } else if (zl.reason === 'paused') {
      r.zalo = 'paused';
    } else if (zl.ready) {
      r.zalo = 'ok';
    } else if (zl.awaitingConfirmation) {
      r.zalo = 'checking';
    } else if (zl.reason === 'no-credentials') {
      r.zalo = 'not_configured';
    } else {
      r.zalo = ctx.botRunning ? 'error' : 'stopped';
    }
  } catch {}

  // 4. Google Workspace — check via gogcli
  try {
    const googleApi = require('./google-api');
    const gs = await googleApi.authStatus();
    if (gs.connected) r.google = ctx.botRunning ? 'ok' : 'configured';
  } catch {}

  return r;
});

ipcMain.handle('get-dashboard', async () => {
  const data = { botRunning: ctx.botRunning };
  return data;
});

// _OVERVIEW_EVENT_LABELS, _readJsonlTail, _readCeoNameFromIdentity, _readRecentZaloCustomers, _nextFireTime — moved to lib/cron.js
ipcMain.handle('get-overview-data', async () => {
  try {
    const ws = getWorkspace();
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);

    // 1. GREETING — CEO name + date + bot status
    const ceoInfo = _readCeoNameFromIdentity();
    const ceoName = ceoInfo.name || '';
    const ceoTitle = ceoInfo.title || '';
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const dayName = dayNames[now.getDay()];
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Chào buổi sáng' : hour < 18 ? 'Chào buổi chiều' : 'Chào buổi tối';

    // 2. RECENT ACTIVITY — last 50 audit entries, mapped to display labels
    const auditFile = ws ? path.join(ws, 'logs', 'audit.jsonl') : null;
    const rawAudit = auditFile ? _readJsonlTail(auditFile, 50) : [];
    const activity = [];
    for (const e of rawAudit) {
      const meta = _OVERVIEW_EVENT_LABELS[e.event];
      if (!meta || !meta.show) continue;
      activity.push({
        ts: e.t,
        label: meta.label,
        icon: meta.icon,
        event: e.event,
      });
      if (activity.length >= 8) break;
    }

    // 3. UPCOMING — compute next firings for built-in schedules + custom crons
    const upcoming = [];
    try {
      const schedFile = path.join(ws, 'schedules.json');
      if (fs.existsSync(schedFile)) {
        const sched = JSON.parse(fs.readFileSync(schedFile, 'utf-8'));
        if (Array.isArray(sched)) {
          for (const s of sched) {
            if (!s || s.enabled === false) continue;
            const next = _nextFireTime(s.time, now);
            if (next) upcoming.push({ label: s.label || s.id, time: next, kind: 'built-in' });
          }
        }
      }
    } catch {}
    try {
      const cronsFile = path.join(ws, 'custom-crons.json');
      if (fs.existsSync(cronsFile)) {
        const crons = JSON.parse(fs.readFileSync(cronsFile, 'utf-8'));
        if (Array.isArray(crons)) {
          for (const c of crons) {
            if (!c || c.enabled === false) continue;
            const next = _nextFireTime(c.time, now, c.cronExpr);
            if (next) upcoming.push({ label: c.label || c.name || 'Cron tuỳ chỉnh', time: next, kind: 'custom' });
          }
        }
      }
    } catch {}
    upcoming.sort((a, b) => new Date(a.time) - new Date(b.time));
    const upcomingTrimmed = upcoming.slice(0, 6);

    // 4. ACTION ITEMS — things CEO should look at
    const actions = [];

    // 4a. Output filter blocked count today
    try {
      const filterFile = ws ? path.join(ws, 'logs', 'security-output-filter.jsonl') : null;
      if (filterFile && fs.existsSync(filterFile)) {
        const entries = _readJsonlTail(filterFile, 100);
        const todayCount = entries.filter(e => e.t && e.t.slice(0, 10) === todayISO).length;
        if (todayCount > 0) {
          actions.push({
            severity: 'medium',
            text: `${todayCount} tin Zalo bị bộ lọc chặn hôm nay`,
            cta: 'Xem log',
            ctaPage: null, // CTA opens log folder via tray
            kind: 'filter-blocked',
          });
        }
      }
    } catch {}

    // 4b. Zalo login status — only warn if not logged in at all
    try {
      const credFile = path.join(ctx.HOME, '.openzca', 'profiles', 'default', 'credentials.json');
      if (!fs.existsSync(credFile)) {
        // No credentials → user hasn't logged in Zalo yet
        actions.push({
          severity: 'low',
          text: 'Chưa đăng nhập Zalo',
          cta: 'Đăng nhập',
          ctaPage: 'zalo',
          kind: 'no-zalo-login',
        });
      }
    } catch {}

    // 4c. Strangers DMing today (count Zalo user memories created today)
    try {
      const zaloMemDir = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir && fs.existsSync(zaloMemDir)) {
        const files = fs.readdirSync(zaloMemDir).filter(f => f.endsWith('.md'));
        let newToday = 0;
        for (const f of files) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir, f)).mtimeMs;
            const ageH = (Date.now() - mtime) / (60 * 60 * 1000);
            if (ageH < 24) newToday++;
          } catch {}
        }
        if (newToday > 0) {
          actions.push({
            severity: 'low',
            text: `${newToday} khách Zalo mới tương tác hôm nay`,
            cta: 'Mở Zalo',
            ctaPage: 'zalo',
            kind: 'new-zalo-customers',
          });
        }
      }
    } catch {}

    // 4d. Bot stopped warning
    if (!ctx.botRunning) {
      actions.push({
        severity: 'high',
        text: 'Bot đang dừng — khách nhắn sẽ không có ai trả lời',
        cta: 'Khởi động',
        ctaPage: null,
        kind: 'bot-stopped',
      });
    }

    // 4e. RAG circuit breaker — recent rag_degraded audit entry within 10min
    try {
      const nowMs = Date.now();
      const recentRag = rawAudit.filter(e => {
        if (e.event !== 'rag_degraded') return false;
        const tMs = e.t ? Date.parse(e.t) : 0;
        return tMs && (nowMs - tMs) < 10 * 60 * 1000;
      });
      if (recentRag.length > 0) {
        actions.push({
          severity: 'medium',
          text: 'Tìm kiếm tài liệu tạm dừng (lỗi giao tiếp). Tự khôi phục sau 5 phút.',
          cta: null,
          ctaPage: null,
          kind: 'rag-degraded',
        });
      }
    } catch {}

    // 4f. Missed CEO alerts — ceo-alerts-missed.log has entries not yet surfaced
    try {
      const missedLogPath = ws ? path.join(ws, 'logs', 'ceo-alerts-missed.log') : null;
      if (missedLogPath && fs.existsSync(missedLogPath)) {
        const missedContent = fs.readFileSync(missedLogPath, 'utf-8').trim();
        if (missedContent.length > 0) {
          const lineCount = missedContent.split('\n').filter(l => l.trim()).length;
          actions.push({
            severity: 'high',
            text: `${lineCount} alert chưa gửi được cho CEO (Telegram có thể lỗi)`,
            cta: 'Kiểm tra Telegram',
            ctaPage: 'telegram',
            kind: 'missed-alerts',
          });
        }
      }
    } catch {}

    // 4g. Recent cron failures today
    try {
      const cronRunsFile2 = ws ? path.join(ws, 'logs', 'cron-runs.jsonl') : null;
      if (cronRunsFile2 && fs.existsSync(cronRunsFile2)) {
        const cronEntries2 = _readJsonlTail(cronRunsFile2, 100);
        const failsToday = cronEntries2.filter(e =>
          e.t && e.t.slice(0, 10) === todayISO && e.phase === 'fail'
        ).length;
        if (failsToday > 0) {
          actions.push({
            severity: 'high',
            text: `${failsToday} cron bị lỗi hôm nay`,
            cta: 'Xem log',
            ctaPage: null,
            kind: 'cron-failures',
          });
        }
      }
    } catch {}

    // 5. STATS — count of audit events today (rough proxy for "bot was busy")
    let eventsToday = 0;
    for (const e of rawAudit) {
      if (e.t && e.t.slice(0, 10) === todayISO) eventsToday++;
    }

    // 5b. New Zalo customers today (reuse actions computation)
    let newZaloCustomersToday = 0;
    try {
      const zaloMemDir2 = ws ? path.join(ws, 'memory', 'zalo-users') : null;
      if (zaloMemDir2 && fs.existsSync(zaloMemDir2)) {
        const files2 = fs.readdirSync(zaloMemDir2).filter(f => f.endsWith('.md'));
        for (const f of files2) {
          try {
            const mtime = fs.statSync(path.join(zaloMemDir2, f)).mtimeMs;
            if ((Date.now() - mtime) / (60 * 60 * 1000) < 24) newZaloCustomersToday++;
          } catch {}
        }
      }
    } catch {}

    // 5c. Cron OK count today
    let cronOkToday = 0;
    try {
      const cronRunsFile = ws ? path.join(ws, 'logs', 'cron-runs.jsonl') : null;
      if (cronRunsFile && fs.existsSync(cronRunsFile)) {
        const cronEntries = _readJsonlTail(cronRunsFile, 200);
        for (const e of cronEntries) {
          if (e.t && e.t.slice(0, 10) === todayISO && e.phase === 'ok') cronOkToday++;
        }
      }
    } catch {}

    // 5d. Workspace writability check — detect read-only filesystem / permissions
    try {
      if (ws) {
        const probeFile = path.join(ws, '.modoro-write-probe');
        fs.writeFileSync(probeFile, String(Date.now()), 'utf-8');
        fs.unlinkSync(probeFile);
      }
    } catch (writeErr) {
      actions.push({
        severity: 'high',
        text: 'Workspace chỉ đọc — config/cron/memory sẽ không lưu được',
        cta: null,
        ctaPage: null,
        kind: 'workspace-readonly',
      });
    }

    // 5e. Config staleness — openclaw.json older than 7 days may indicate stuck config
    try {
      const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (fs.existsSync(cfgPath)) {
        const cfgAge = Date.now() - fs.statSync(cfgPath).mtimeMs;
        if (cfgAge > 7 * 24 * 60 * 60 * 1000) {
          actions.push({
            severity: 'low',
            text: 'Config chưa được cập nhật > 7 ngày',
            cta: null,
            ctaPage: null,
            kind: 'config-stale',
          });
        }
      }
    } catch {}

    // 6. RECENT ZALO CUSTOMERS — from memory/zalo-users/*.md
    const recentCustomers = ws ? _readRecentZaloCustomers(ws, 5) : [];

    return {
      success: true,
      greeting: {
        salutation: greeting,
        ceoName: ceoName || '',
        ceoTitle: ceoTitle || '',
        dayName,
        dateStr,
        botRunning: ctx.botRunning,
      },
      activity,
      upcoming: upcomingTrimmed,
      actions,
      recentCustomers,
      stats: {
        eventsToday,
        newZaloCustomersToday,
        cronOkToday,
      },
    };
  } catch (e) {
    console.error('[get-overview-data] error:', e?.message);
    return { success: false, error: e?.message };
  }
});

ipcMain.handle('wizard-complete', async () => {
  if (ctx.wizardCompleteInFlight) { console.log('[wizard] already in flight, skipping'); return { success: true }; }
  ctx.wizardCompleteInFlight = true;
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed()) { ctx.wizardCompleteInFlight = false; return { success: false }; }
  // GUARANTEE navigation: even if anything below throws/hangs, force-navigate
  // to dashboard.html on a short timer so CEO never sees forever-spinner.
  const navGuard = setTimeout(() => {
    try {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        console.warn('[wizard-complete] nav-guard fired — forcing dashboard load');
        ctx.mainWindow.loadFile(path.join(ELECTRON_DIR, 'ui', 'dashboard.html'));
        try { ctx.mainWindow.maximize(); } catch {}
      }
    } catch (e) { console.error('[wizard-complete nav-guard] error:', e && e.message); }
  }, 5000);
  // Fresh install: seed workspace files with defaults
  try { seedWorkspace(); } catch (e) { console.error('[wizard-complete seed] error:', e.message); }
  try { markOnboardingComplete('wizard-complete'); } catch {}
  // Start Premium Onboarding 7-day tracking — reset handled in IIFE below
  // Navigate to dashboard IMMEDIATELY (perf: save up to 3s from credential
  // poll + RAG prefill). Credential poll + cleanup + RAG prefill moved to
  // fire-and-forget IIFE below. Channel status broadcast picks up Zalo state.
  clearTimeout(navGuard);
  try { ctx.mainWindow.loadFile(path.join(ELECTRON_DIR, 'ui', 'dashboard.html')); } catch (e) { console.error('[wizard-complete loadFile] error:', e && e.message); }
  try { ctx.mainWindow.maximize(); } catch {}
  (async () => {
    try {
    // Deferred from before dashboard load — credential poll + cleanup + RAG prefill
    try { cleanupOrphanZaloListener(); } catch {}
    try {
      const ragPath = path.join(getWorkspace(), 'rag-config.json');
      if (!fs.existsSync(ragPath)) {
        const isChatgptPlus = await detectChatgptPlusOAuth();
        writeJsonAtomic(ragPath, {
          tier2Enabled: false,
          rewriteModel: isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast',
          updatedAt: new Date().toISOString(),
        });
        console.log(`[wizard-complete] rag-config.json seeded (tier2=off, model=${isChatgptPlus ? 'ninerouter/main' : 'ninerouter/fast'})`);
      }
    } catch (e) { console.warn('[wizard-complete] RAG config prefill failed:', e?.message); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-ensureZaloPlugin)'); return; }
    try { await ensureZaloPlugin(); } catch (e) { console.error('[wizard-complete ensureZaloPlugin] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-seedZaloCustomers)'); return; }
    try { seedZaloCustomersFromCache(); } catch (e) { console.error('[wizard-complete seedZaloCustomers] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startOpenClaw)'); return; }
    try { startCronApi(); } catch (e) { console.error('[wizard-complete startCronApi preflight] error:', e?.message || e); }
    try { await startOpenClaw(); } catch (e) { console.error('[wizard-complete startOpenClaw] error:', e?.message || e); }
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-startCronJobs)'); return; }
    try { startCronJobs(); } catch (e) { console.error('[wizard-complete startCronJobs] error:', e?.message || e); }
    try { startCronApi(); } catch (e) { console.error('[wizard-complete startCronApi] error:', e?.message || e); }
    try { watchCustomCrons(); } catch {}
    try { startZaloCacheAutoRefresh(); } catch {}
    try { startAppointmentDispatcher(); } catch {}
    try { startFollowUpChecker(); } catch {}
    try { startEscalationChecker(); } catch {}
    setTimeout(() => { try { checkZaloCookieAge(); } catch {} }, 30000);

    // Welcome flow: first-time introduction after wizard
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-welcome)'); return; }
    try {
      const ws = getWorkspace();
      const welcomeSent = ws && fs.existsSync(path.join(ws, '.welcome-sent'));
      if (!welcomeSent) {
        const { chatId } = getTelegramConfig();
        if (chatId) {
          const welcomeMsg = [
            'Chào anh/chị, em đã sẵn sàng làm việc.',
            '',
            'Vài thứ có thể thử ngay:',
            '- Nhắn tin cho em trên Telegram này -- em sẽ trả lời như cố vấn kinh doanh',
            '- Nhờ khách hàng nhắn Zalo cho shop -- em sẽ tự động tư vấn dựa trên Knowledge',
            '- Gõ "báo cáo" -- em gửi tóm tắt hoạt động ngay lập tức',
            '- Gõ "tạo cron gửi nhóm VIP mỗi sáng 9h: Chào buổi sáng" -- em tạo lịch gửi tự động',
            '',
            'Mỗi sáng và tối em sẽ gửi báo cáo tự động. Reply tự nhiên để ra lệnh.',
            '',
            'Nếu cần thêm Knowledge (bảng giá, FAQ, chính sách), mở Dashboard tab Knowledge và upload file.',
          ].join('\n');
          // Write marker BEFORE send (write-then-send = safe order per AGENTS.md)
          if (ws) fs.writeFileSync(path.join(ws, '.welcome-sent'), new Date().toISOString(), 'utf-8');
          await sendTelegram(welcomeMsg, { skipFilter: true, skipPauseCheck: true });
          console.log('[welcome] sent first-time introduction via Telegram');
        }
      }
    } catch (e) { console.error('[welcome] failed:', e?.message); }

    // Premium onboarding nudge: reset 7-day state + start timer at wizard-complete
    if (ctx.appIsQuitting) { console.log('[wizard-iife] aborting — app quitting (pre-onboarding-nudge)'); return; }
    try {
      resetOnboardingState();  // resets startedAt to now, clears sentDays
      startOnboardingNudgeTimer();
    } catch (e) { console.error('[wizard-iife onboarding-nudge] error:', e?.message); }
    } finally { ctx.wizardCompleteInFlight = false; }
  })();
  return { success: true };
});

// Install OpenClaw automatically (async — no UI freeze)
ipcMain.handle('install-openclaw', async (event) => {
  const sender = event.sender;
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const send = (msg) => sender.send('install-progress', msg);

  // SHORT-CIRCUIT: if runtime-installed vendor already has all packages,
  // skip npm install. Verifying openclaw + 9router + openzca + modoro-zalo
  // all exist in userData/vendor/ is enough.
  try {
    const vendorDir = getBundledVendorDir();
    if (vendorDir) {
      const openclawCli = path.join(vendorDir, 'node_modules', 'openclaw', 'openclaw.mjs');
      const ninerouterPkg = path.join(vendorDir, 'node_modules', '9router', 'package.json');
      const openzcaCli = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
      const modoroZaloPlugin = path.join(vendorDir, 'node_modules', 'modoro-zalo', 'openclaw.plugin.json');
      const zaloPluginExists = fs.existsSync(modoroZaloPlugin);
      const all = [openclawCli, ninerouterPkg, openzcaCli];
      const allPresent = all.every(p => { try { return fs.existsSync(p); } catch { return false; } }) && zaloPluginExists;
      if (allPresent) {
        send('App đã có sẵn OpenClaw bundled — bỏ qua npm install.');
        send('Bundled vendor: ' + vendorDir);
        send('  openclaw: OK');
        send('  9router: OK');
        send('  openzca: OK');
        send('  modoro-zalo: OK');
        send('Hoàn tất.');
        return { success: true, bundled: true };
      } else {
        const missing = all.filter(p => { try { return !fs.existsSync(p); } catch { return true; } });
        send('Cảnh báo: vendor folder có nhưng thiếu file:');
        for (const m of missing) send('  - ' + m);
        send('Sẽ thử npm install để bổ sung...');
      }
    }
  } catch (e) {
    send('Lỗi khi kiểm tra bundled vendor: ' + String(e.message || e));
    send('Sẽ fallback sang npm install...');
  }

  // PRE-CHECK 1: Verify Node.js is available + version is recent enough.
  // openzca requires Node >= 22.13.0. If user has older Node, npm install will
  // log a warning but proceed; openzca's compiled output (tsup --target node22)
  // may then fail at runtime with syntax errors. Show a clear actionable error
  // BEFORE wasting 5 minutes on a doomed npm install.
  // NOTE: This intentionally checks SYSTEM node (`node -v` via PATH), not the
  // bundled vendor/node/bin/node. Reason: this handler runs `npm install -g`
  // which goes through the user's npm prefix and uses their globally-installed
  // Node. Bundled vendor node is for RUNTIME spawning of openclaw/openzca/9router
  // by the gateway, not for installing global packages. The two roles are
  // separate by design — vendor node never touches the user's npm tree.
  let nodeVersionMajor = 0;
  try {
    const { execSync } = require('child_process');
    const out = execSync('node -v', { encoding: 'utf-8', timeout: 5000 }).trim();
    const m = out.match(/^v(\d+)/);
    if (m) nodeVersionMajor = parseInt(m[1], 10);
  } catch {
    return {
      success: false,
      error: isMac
        ? 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n(hoặc: brew install node@22)\n\nSau đó mở lại 9BizClaw.'
        : 'Không tìm thấy Node.js trên máy.\n\nCài Node 22 LTS từ https://nodejs.org\n\nSau đó mở lại 9BizClaw.',
    };
  }
  if (nodeVersionMajor < 22) {
    return {
      success: false,
      error: `Node.js quá cũ (v${nodeVersionMajor}). 9BizClaw cần Node 22+ để chạy openzca (Zalo plugin).\n\n` +
             (isMac
               ? 'Cập nhật:\n  brew upgrade node\nhoặc tải installer từ https://nodejs.org'
               : 'Cập nhật từ https://nodejs.org'),
    };
  }

  // PRE-CHECK 2 (Mac only): Verify npm has write permission to global prefix.
  // On Mac without sudo, /usr/local/lib/node_modules is often write-protected.
  // We check `npm config get prefix` and try to detect EACCES early so the
  // user gets a clear hint to set up `~/.npm-global` or use `sudo`.
  if (isMac) {
    try {
      const { execSync } = require('child_process');
      const npmPrefix = execSync('npm config get prefix', { encoding: 'utf-8', timeout: 5000 }).trim();
      // Probe writability of the global lib dir
      const libDir = path.join(npmPrefix, 'lib', 'node_modules');
      try { fs.accessSync(libDir, fs.constants.W_OK); }
      catch {
        send(`C\u1EA3nh b\u00E1o: npm global prefix kh\u00F4ng ghi \u0111\u01B0\u1EE3c: ${npmPrefix}`);
        send('');
        send('Kh\u1EAFc ph\u1EE5c: thi\u1EBFt l\u1EADp user-prefix cho npm:');
        send('  mkdir -p ~/.npm-global');
        send('  npm config set prefix ~/.npm-global');
        send('  echo \'export PATH=~/.npm-global/bin:$PATH\' >> ~/.zshrc');
        send('  source ~/.zshrc');
        send('');
        send('Sau \u0111\u00F3 th\u1EED l\u1EA1i. (Tr\u00E1nh d\u00F9ng sudo cho npm install -g.)');
        // We don't hard-fail here — npm install may still succeed if user
        // has /usr/local writable. Just warn loudly.
      }
    } catch {}
  }

  // Kill 9Router/OpenClaw before npm install to avoid EBUSY
  try { await stop9Router(); } catch {}
  try { await stopOpenClaw(); } catch {}
  if (isWin) {
    try { spawn('taskkill', ['/f', '/im', '9router.exe'], { stdio: 'ignore' }); } catch {}
  } else {
    try { spawn('killall', ['9router', 'openclaw'], { stdio: 'ignore' }); } catch {}
  }
  await new Promise(r => setTimeout(r, 1000));

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    send('=== Bắt đầu cài đặt OpenClaw ===');
    send('');
    send('Hệ điều hành: ' + (isWin ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform));
    send('Node.js: v' + nodeVersionMajor);
    send('Thời gian: ' + new Date().toLocaleTimeString('vi-VN'));
    send('');
    send('--- Cài đặt OpenClaw via npm ---');

    // Install OpenClaw + 9Router + openzca via npm AT PINNED VERSIONS.
    // CRITICAL: pin versions to protect against upstream schema breakage.
    // Without pinning, fresh installs months from now will pull `latest` which
    // may have incompatible schema → wizard fails on day 1 with "Config invalid".
    // Upgrade: edit electron/scripts/versions.json only. All files read from it.
    // NOTE: modoro-zalo is the renamed fork; @tuyenhx/openzalo kept as fallback
    // for dev-mode network installs until modoro-zalo is published to npm.
    const SHARED_VERSIONS = (() => {
      try {
        return JSON.parse(require('fs').readFileSync(
          require('path').join(__dirname, '..', 'scripts', 'versions.json'), 'utf-8'
        ));
      } catch {
        return { openclaw: '2026.4.14', openzca: '0.1.59', nineRouter: '0.5.12' };
      }
    })();
    const PINNED_VERSIONS = [
      'openclaw@' + SHARED_VERSIONS.openclaw,
      '9router@' + SHARED_VERSIONS.nineRouter,
      'openzca@' + SHARED_VERSIONS.openzca,
    ];
    let cmd, args;
    if (isWin) {
      cmd = 'npm.cmd';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    } else {
      cmd = 'npm';
      args = ['install', '-g', '--save-exact', ...PINNED_VERSIONS];
    }

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin, windowsHide: true });
    let output = '';

    // Stream ALL output — both stdout and stderr
    const handleOutput = (stream, prefix) => {
      let buffer = '';
      stream.on('data', (data) => {
        buffer += data.toString();
        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete last line in buffer
        for (const raw of lines) {
          const clean = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (clean) {
            output += clean + '\n';
            send(prefix + clean);
          }
        }
      });
      // Flush remaining buffer
      stream.on('end', () => {
        const clean = buffer.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) {
          output += clean + '\n';
          send(prefix + clean);
        }
      });
    };

    handleOutput(proc.stdout, '');
    handleOutput(proc.stderr, '');

    // Timeout after 10 minutes (npm install can be slow)
    const timeout = setTimeout(() => {
      proc.kill();
      send('');
      send('Qu\u00E1 th\u1EDDi gian (10 ph\u00FAt).');
      safeResolve({ success: false, error: 'Quá thời gian. Thử lại hoặc cài thủ công.' });
    }, 10 * 60 * 1000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      send('');
      send('--- Bước 2: Kiểm tra cài đặt ---');
      send('Exit code: ' + code);

      // Verify — small delay for PATH to propagate
      // (_cachedBin is private to lib/boot.js; findOpenClawBin() re-probes automatically)
      setTimeout(async () => {
        const bin = await findOpenClawBin();
        if (bin) {
          send('OpenClaw binary: ' + bin);
          send('');
          send('CÀI ĐẶT THÀNH CÔNG');
          safeResolve({ success: true });
        } else if (code === 0) {
          send('');
          send('C\u1EA3nh b\u00E1o: Installer ch\u1EA1y xong nh\u01B0ng kh\u00F4ng t\u00ECm th\u1EA5y openclaw.');
          send('Thử khởi động lại app.');
          safeResolve({ success: false, error: 'Cài xong nhưng không tìm thấy openclaw. Khởi động lại app.' });
        } else {
          send('');
          send('C\u00E0i \u0111\u1EB7t th\u1EA5t b\u1EA1i.');
          safeResolve({ success: false, error: `Mã lỗi: ${code}\n\n${output.slice(-1000)}` });
        }
      }, 2000);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      send('');
      send('Không chạy được: ' + err.message);
      safeResolve({ success: false, error: err.message });
    });
  });
});

// Relaunch app after OpenClaw install
ipcMain.handle('relaunch', async () => {
  app.relaunch();
  app.exit(0);
});

// Factory reset — wipe ALL user data. Called from Dashboard with 2-layer
// confirmation (modal + type-to-confirm "XOA"). After wipe, Dashboard calls
// relaunch() so app starts fresh with wizard onboarding.
ipcMain.handle('factory-reset', async () => {
  try {
    console.log('[factory-reset] Starting full wipe...');
    // Layer 2: sacred snapshot BEFORE any wipe — makes factory-reset reversible
    // SACRED-OK: snapshotSacred copies sacred files to external ~/9BizClaw-SacredBackups before wipe
    try { await require('./sacred-data').snapshotSacred('factory-reset'); } catch (e) { console.error('[factory-reset] sacred snapshot failed (continuing):', e?.message); }
    // Suppress the NEXT boot's heal so this deliberate wipe sticks (backups kept
    // for manual recovery). Sentinel lives outside the workspace, surviving rmSync.
    try { require('./sacred-data').markHealSuppressed(); } catch (e) { console.error('[factory-reset] markHealSuppressed failed (continuing):', e?.message); }
    // Stop background processes so they don't hold file handles
    try { await stopOpenClaw(); } catch {}
    try { stop9Router(); } catch {}
    try { stopCronJobs(); } catch {}
    // Small delay for process cleanup
    await new Promise(r => setTimeout(r, 500));

    const targets = [];
    const ws = getWorkspace();
    if (ws) targets.push(ws);
    targets.push(path.join(ctx.HOME, '.openclaw'));
    targets.push(path.join(ctx.HOME, '.openzca'));
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(ctx.HOME, 'AppData', 'Roaming');
      targets.push(path.join(appData, '9router'));
    } else if (process.platform === 'darwin') {
      targets.push(path.join(ctx.HOME, 'Library', 'Application Support', '9router'));
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(ctx.HOME, '.config');
      targets.push(path.join(xdg, '9router'));
    }

    const results = [];
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) {
          fs.rmSync(t, { recursive: true, force: true });
          console.log('[factory-reset] removed:', t);
          results.push({ path: t, ok: true });
        }
      } catch (e) {
        console.error('[factory-reset] failed to remove', t, e?.message);
        results.push({ path: t, ok: false, error: e?.message });
      }
    }

    console.log('[factory-reset] done');
    return { success: true, results };
  } catch (e) {
    console.error('[factory-reset] error:', e?.message || e);
    return { success: false, error: e?.message || String(e) };
  }
});

// Export workspace — create a tar archive of the user's workspace (config,
// memory, knowledge metadata, schedules, etc.) for backup / migration to a
// new machine. Excludes Electron cache dirs, logs, backups, and heavy
// knowledge/*/files blobs to keep the archive lean.
ipcMain.handle('export-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws || !fs.existsSync(ws)) {
      return { ok: false, error: 'workspace not found' };
    }
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const defaultName = `modoroclaw-export-${Date.now()}.tar`;
    const saveRes = await dialog.showSaveDialog(win, {
      title: 'Lưu file export',
      defaultPath: defaultName,
      filters: [{ name: 'TAR archive', extensions: ['tar'] }],
    });
    if (saveRes.canceled || !saveRes.filePath) {
      return { ok: false, canceled: true };
    }
    const outfile = saveRes.filePath;

    // Excluded dir/file name set (Electron cache, heavy state, transient).
    const EXCLUDED = new Set([
      'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Network',
      'Local Storage', 'Session Storage', 'logs', 'backups',
      'Shared Dictionary', 'SharedStorage', 'blob_storage', 'Partitions',
      'node_modules', 'tmp', 'temp',
    ]);
    // Build explicit include list from top-level workspace entries.
    const include = [];
    for (const name of fs.readdirSync(ws)) {
      if (EXCLUDED.has(name)) continue;
      // Skip dotfiles coming from Chromium/Electron state.
      if (name === '.org.chromium.Chromium' || name.startsWith('.com.google.Chrome')) continue;
      include.push(name);
    }
    if (include.length === 0) {
      return { ok: false, error: 'nothing to export' };
    }

    // For each knowledge/<cat>/files subdir, exclude via --exclude patterns
    // (still include knowledge/<cat>/index.md + metadata). tar honors
    // --exclude relative to -C root on both BSD tar (mac) and bsdtar
    // bundled with Windows 10+.
    const excludePatterns = [
      'knowledge/*/files',
      'knowledge/*/files/*',
    ];

    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';

    const args = ['-cf', outfile];
    for (const pat of excludePatterns) args.push(`--exclude=${pat}`);
    args.push('-C', ws);
    for (const n of include) args.push(n);

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    const stat = fs.statSync(outfile);
    console.log('[export-workspace] wrote', outfile, stat.size, 'bytes');
    return { ok: true, path: outfile, sizeBytes: stat.size };
  } catch (e) {
    console.error('[export-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Import workspace — restore a previously exported tar archive over the
// current workspace. Overwrites existing files. Caller is expected to show
// a confirm dialog in the UI before invoking. App restart is recommended
// afterwards so in-memory state re-reads the fresh files.
ipcMain.handle('import-workspace', async () => {
  try {
    const { dialog } = require('electron');
    const ws = getWorkspace();
    if (!ws) {
      return { ok: false, error: 'workspace not found' };
    }
    try { fs.mkdirSync(ws, { recursive: true }); } catch {}
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const openRes = await dialog.showOpenDialog(win, {
      title: 'Chọn file .tar export để khôi phục',
      properties: ['openFile'],
      filters: [
        { name: 'Workspace Tar Export', extensions: ['tar'] },
      ],
    });
    if (openRes.canceled || !openRes.filePaths || openRes.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const infile = openRes.filePaths[0];
    if (!fs.existsSync(infile)) {
      return { ok: false, error: 'file not found' };
    }

    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : '/usr/bin/tar';
    const args = ['-xf', infile, '-C', ws];

    await new Promise((resolve, reject) => {
      const proc = spawn(tarBin, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar exit ${code}: ${stderr.trim()}`));
      });
    });

    console.log('[import-workspace] restored from', infile, 'into', ws);
    return { ok: true, path: infile };
  } catch (e) {
    console.error('[import-workspace] error:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
});

// Diagnostic log IPC — lets Dashboard/wizard grab the main.log contents
// without the user needing to open DevTools.
ipcMain.handle('get-diagnostic-log', async (_event, { tailLines = 500 } = {}) => {
  try {
    const logPath = ctx.getLogFilePath ? ctx.getLogFilePath() : null;
    if (!logPath || !fs.existsSync(logPath)) {
      return { ok: false, error: 'log file not found', path: logPath || null };
    }
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n');
    const tail = tailLines > 0 ? lines.slice(-tailLines).join('\n') : raw;
    const redacted = tail.replace(/\b(bot\d{5,}:\S{30,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/=]{40,})/g, '[REDACTED]');
    return { ok: true, path: logPath, content: redacted, totalLines: lines.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-log-folder', async () => {
  try {
    const logPath = ctx.getLogFilePath ? ctx.getLogFilePath() : null;
    if (logPath && fs.existsSync(logPath)) {
      shell.showItemInFolder(logPath);
      return { ok: true };
    }
    if (logPath) {
      shell.openPath(path.dirname(logPath));
      return { ok: true };
    }
    return { ok: false, error: 'no log path' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  try {
    const parsed = new URL(url);
    const allowedOrigins = [
      'https://ollama.com',
      'https://t.me',
      'https://youtube.com',
      'https://www.youtube.com',
      'https://business.facebook.com',
      'https://developers.facebook.com',
      'https://www.facebook.com',
      'https://facebook.com',
      'https://console.cloud.google.com',
      'https://console.developers.google.com',
      'https://cloud.google.com',
      'https://developers.google.com',
      'https://support.google.com',
      'https://github.com',
      'https://chatgpt.com',
      'https://drive.google.com',
      'https://docs.google.com',
      'https://mail.google.com',
      'http://localhost:20128',
      'http://127.0.0.1:20128',
      'http://127.0.0.1:18789',
      'http://localhost:18789',
      'http://127.0.0.1:18791',
      'http://localhost:18791',
    ];
    // Telegram deep-link: tg://resolve?domain=<bot> opens native app directly.
    // Allow ONLY the resolve action (no msg_url, no join) to keep the surface
    // tight. Non-resolve tg:// URLs are rejected.
    const isTelegramResolve = parsed.protocol === 'tg:' && parsed.href.startsWith('tg://resolve?domain=') && /^[A-Za-z0-9_]{1,32}$/.test(parsed.searchParams.get('domain') || '');
    if (allowedOrigins.includes(parsed.origin) || isTelegramResolve) {
      const { shell } = require('electron');
      shell.openExternal(parsed.href);
    }
  } catch {} // Invalid URL — ignore
});

ipcMain.handle('get-gateway-token', async () => {
  try {
    const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = readOpenclawJsonFile(configPath);
      return config.gateway?.auth?.token || null;
    }
  } catch {}
  return null;
});

ipcMain.handle('get-bot-status', async () => ({ running: ctx.botRunning }));

ipcMain.handle('get-app-version', async () => {
  try { return app.getVersion(); } catch { return ''; }
});

// ---- License IPC handlers (membership builds only) ----

ipcMain.handle('activate-license', async (_event, { key }) => {
  const license = require('./license');
  try {
    const result = await license.activateLicense(key);
    if (!result.success) return result;
    // Check if app was already set up (re-activation after expiry)
    const configured = isOpenClawConfigured() && hasCompletedOnboarding();
    return { ...result, configured };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-license-status', async () => {
  const license = require('./license');
  const status = license.checkLicenseStatus();
  status.machineId = license.getMachineId();
  return status;
});

ipcMain.handle('deactivate-license', async () => {
  const license = require('./license');
  await license.clearLicense();
  return { success: true };
});

ipcMain.handle('toggle-bot', async () => {
  // [rapid-toggle guard FM-04] ONE toggle at a time. The STOP branch used to run UNGUARDED,
  // so rapid on/off clicks could fire concurrent stopOpenClaw() OR race a stop against an
  // in-flight start → two openzca listeners / port churn / 409 / EADDRINUSE. The guard now
  // wraps BOTH branches; a 2nd click while a start OR stop is in flight returns pending.
  if (ctx.startOpenClawInFlight || ctx.gatewayRestartInFlight) {
    return { running: ctx.botRunning, pending: true };
  }
  ctx.gatewayRestartInFlight = true;
  try {
    if (ctx.botRunning) {
      try { await stopOpenClaw(); } catch (e0) { console.warn('[toggle-bot] stop failed:', e0?.message); }
    } else {
      try { startCronApi(); } catch (e) { console.error('[toggle-bot] startCronApi preflight error:', e?.message || e); }
      // [dual-listener guard] Explicit user start: tear down FIRST, then spawn. stopOpenClaw
      // kills the port + ALL openzca listeners + clears owner-locks and polls the port free,
      // so the start below can never adopt an orphan gateway — it always spawns exactly one
      // fresh listener.
      try { await stopOpenClaw(); } catch (e1) { console.warn('[toggle-bot] stop failed:', e1?.message); }
      try { await startOpenClaw(); } catch (e2) { console.warn('[toggle-bot] start failed:', e2?.message); }
      startRuntimeSidecars('toggle-bot');
    }
  } finally {
    ctx.gatewayRestartInFlight = false;
  }
  return { running: ctx.botRunning };
});

ipcMain.handle('check-for-updates', async () => {
  try {
    const result = await checkForUpdates();
    if (result) return { available: true, ...result };
    return { available: false, version: app.getVersion() };
  } catch (e) {
    return { available: false, error: e.message };
  }
});

ipcMain.handle('download-and-install-update', async () => {
  const _latestRel = getLatestRelease();
  if (!_latestRel) return { success: false, error: 'No update available' };
  // H1: concurrency guard — prevent double-click corruption
  if (getUpdateDownloadInFlight()) return { success: false, error: 'Download already in progress' };
  setUpdateDownloadInFlight(true);
  try {
    const platform = process.platform;
    let asset = null;
    if (platform === 'win32') {
      asset = _latestRel.assets.find(a => a.name.endsWith('.exe'));
    } else if (platform === 'darwin') {
      // Mac: download correct DMG (arm64 vs x64) → mount → install → relaunch
      const arch = process.arch; // 'arm64' or 'x64'
      // Asset naming: 9BizClaw-2.3.4-arm64.dmg (Apple Silicon), 9BizClaw-2.3.4.dmg (Intel x64)
      asset = _latestRel.assets.find(a => {
        if (!a.name.endsWith('.dmg')) return false;
        if (arch === 'arm64') return a.name.includes('arm64');
        // x64: pick DMG that does NOT have 'arm64' in name
        return !a.name.includes('arm64');
      });
      if (!asset) {
        // Fallback: open release page in browser
        console.warn('[update] No matching DMG for arch:', arch);
        openGitHubUrl(_latestRel.html_url);
        return { success: true, method: 'browser' };
      }
    }
    if (!asset) {
      // Fallback: open release page
      openGitHubUrl(_latestRel.html_url);
      return { success: true, method: 'browser' };
    }
    // Download asset (EXE on Windows, DMG on Mac)
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('update-download-progress', { received: 0, total: asset.size, percent: 0 });
    }
    const localPath = await downloadUpdate(asset.url, asset.name, asset.size, asset.sha512);

    if (platform === 'darwin') {
      // Mac: mount DMG → copy .app → remove quarantine → relaunch
      await installDmgUpdate(localPath);
      return { success: true, method: 'dmg-install' };
    }
    // Windows: launch EXE installer and quit
    const { shell } = require('electron');
    const openErr = await shell.openPath(localPath);
    if (openErr) throw new Error(openErr);
    // Give installer 2s to start then quit app
    setTimeout(() => { app.quit(); }, 2000);
    return { success: true, method: 'installer', path: localPath };
  } catch (e) {
    console.error('[update] download/install error:', e.message);
    // Mac fallback: if DMG install fails, open release page in browser
    const _latestRelFb = getLatestRelease();
    if (process.platform === 'darwin' && _latestRelFb && _latestRelFb.html_url) {
      openGitHubUrl(_latestRelFb.html_url);
      return { success: false, error: e.message, fallback: 'browser' };
    }
    return { success: false, error: e.message };
  } finally {
    setUpdateDownloadInFlight(false);
  }
});


  // --- Google Workspace (via gogcli) ---
  const googleApi = require('./google-api');

  ipcMain.handle('google-auth-status', async () => {
    try { return await googleApi.authStatus(); }
    catch (e) { return { connected: false, error: e.message }; }
  });

  // --- aivideoauto (Gommo AI — BYO token+domain, encrypted via safeStorage) ---
  // Boundary: authStatus composition (readConfig + verify) lives HERE, not in the engine.
  // The engine stays pure — no workspace dependency. Use the SAME selector as the job
  // path (cron-api _avEngine) so connect/verify validates against the engine that will
  // actually run jobs: v2 default, AIVIDEOAUTO_ENGINE=legacy to roll back.
  const _avEngine = () => process.env.AIVIDEOAUTO_ENGINE === 'legacy' ? require('./aivideoauto') : require('./aivideoauto-v2');
  ipcMain.handle('aivideoauto-verify', async (_ev, { token, domain } = {}) => {
    try { return await _avEngine().verify({ token, domain }); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('aivideoauto-connect', async (_ev, { token, domain } = {}) => {
    const { readAiVideoAutoConfig, writeAiVideoAutoConfig } = require('./workspace');
    try {
      const r = await _avEngine().verify({ token, domain });
      // Preserve CEO-declared subscription plans across reconnect (token re-paste).
      const prev = readAiVideoAutoConfig();
      const plans = require('./aivideoauto-plans').sanitizeKeys(prev && prev.plans);
      writeAiVideoAutoConfig({ token, domain, userName: r.userName || null, connectedAt: new Date().toISOString(), plans });
      return { connected: true, userName: r.userName, credits: r.credits, currency: r.currency, plans };
    } catch (e) { return { connected: false, error: e.message }; }
  });
  ipcMain.handle('aivideoauto-status', async () => {
    const { readAiVideoAutoConfig } = require('./workspace');
    try {
      const cfg = readAiVideoAutoConfig();
      if (!cfg || !cfg.token) return { connected: false };
      const plans = require('./aivideoauto-plans').sanitizeKeys(cfg.plans);
      const r = await _avEngine().verify({ token: cfg.token, domain: cfg.domain });
      return { connected: true, userName: r.userName, credits: r.credits, currency: r.currency, plans };
    } catch (e) { return { connected: false, error: e.message }; }
  });
  // CEO declares which subscription plan(s) they own (advisory — Gommo still decides
  // at submit). Stored in aivideoauto-config.json; drives Dashboard display + bot hint.
  ipcMain.handle('aivideoauto-save-plans', async (_ev, { plans } = {}) => {
    const { readAiVideoAutoConfig, writeAiVideoAutoConfig } = require('./workspace');
    try {
      const cfg = readAiVideoAutoConfig();
      if (!cfg || !cfg.token) return { ok: false, error: 'Chưa kết nối aivideoauto' };
      const clean = require('./aivideoauto-plans').sanitizeKeys(plans);
      writeAiVideoAutoConfig({ ...cfg, plans: clean });
      return { ok: true, plans: clean };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('aivideoauto-list-plans', async () => {
    return { plans: require('./aivideoauto-plans').PLANS.map(p => ({ key: p.key, label: p.label, models: p.models })) };
  });
  ipcMain.handle('google-health', async () => {
    try { return await googleApi.serviceHealth(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('google-upload-credentials', async (_ev, filePath) => {
    try {
      googleApi.validateOAuthClientSecret(filePath);
      const configDir = googleApi.getGogConfigDir();
      fs.mkdirSync(configDir, { recursive: true });
      const dest = path.join(configDir, 'client_secret.json');
      fs.copyFileSync(filePath, dest);
      await googleApi.registerCredentials(dest);
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-get-auth-url', async (_ev, email) => {
    try {
      const url = await googleApi.getAuthUrl(email);
      return { url };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-connect', async (_ev, email) => {
    try {
      const result = await googleApi.connectAccount(email);
      return { ok: true, ...result };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-disconnect', async () => {
    try { return await googleApi.disconnectAccount(); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-calendar-events', async (_ev, opts) => {
    try { return await googleApi.listEvents(opts?.from, opts?.to, opts?.calendarId); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-calendar-list', async () => {
    try { return await googleApi.listCalendars(); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-create', async (_ev, opts) => {
    try {
      if (!opts?.summary || !opts?.start || !opts?.end) return { error: 'summary, start, end required' };
      const r = await googleApi.createEvent(opts.summary, opts.start, opts.end, opts.attendees, opts.calendarId);
      try { auditLog('google_calendar_create', { summary: opts.summary }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-update', async (_ev, opts) => {
    try {
      if (!opts?.eventId) return { error: 'eventId required' };
      const hasUpdate = ['summary', 'start', 'end', 'description', 'location', 'attendees']
        .some(key => opts[key] !== undefined);
      if (!hasUpdate) return { error: 'at least one update field required' };
      const r = await googleApi.updateEvent(opts.eventId, opts, opts.calendarId);
      try { auditLog('google_calendar_update', { eventId: opts.eventId, summary: opts.summary }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-delete', async (_ev, opts) => {
    try {
      if (!opts?.eventId) return { error: 'eventId required' };
      const r = await googleApi.deleteEvent(opts.eventId, opts.calendarId);
      try { auditLog('google_calendar_delete', { eventId: opts.eventId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-freebusy', async (_ev, opts) => {
    try { return await googleApi.getFreeBusy(opts?.from, opts?.to); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-calendar-free-slots', async (_ev, opts) => {
    try { return await googleApi.getFreeSlots(opts.date, opts.workStart, opts.workEnd, opts.slotMinutes); }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-gmail-inbox', async (_ev, opts) => {
    try { return await googleApi.listInbox(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-read', async (_ev, opts) => {
    try { return await googleApi.readEmail(opts.id); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-send', async (_ev, opts) => {
    try {
      if (!opts?.to || !opts?.subject || !opts?.body) return { error: 'to, subject, body required' };
      const r = await googleApi.sendEmail(opts.to, opts.subject, opts.body);
      try { auditLog('google_gmail_send', { to: opts.to, subject: opts.subject }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-gmail-reply', async (_ev, opts) => {
    try {
      if (!opts?.id || !opts?.body) return { error: 'id, body required' };
      const r = await googleApi.replyEmail(opts.id, opts.body);
      try { auditLog('google_gmail_reply', { id: opts.id }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-drive-list', async (_ev, opts) => {
    try { return await googleApi.listFiles(opts?.query, opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-upload', async (_ev, opts) => {
    try {
      if (!opts?.filePath) return { error: 'filePath required' };
      const googleRoutes = require('./google-routes');
      if (googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.filePath)) return { error: 'filePath blocked by path validation' };
      const r = await googleApi.uploadFile(opts.filePath, opts.folderId);
      try { auditLog('google_drive_upload', { filePath: opts.filePath }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-download', async (_ev, opts) => {
    try {
      if (!opts?.fileId || !opts?.destPath) return { error: 'fileId, destPath required' };
      const googleRoutes = require('./google-routes');
      if (googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.destPath)) return { error: 'destPath blocked by path validation' };
      const r = await googleApi.downloadFile(opts.fileId, opts.destPath, opts.format);
      try { auditLog('google_drive_download', { fileId: opts.fileId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-drive-share', async (_ev, opts) => {
    try {
      if (!opts?.fileId || !opts?.email) return { error: 'fileId, email required' };
      const r = await googleApi.shareFile(opts.fileId, opts.email, opts.role);
      try { auditLog('google_drive_share', { fileId: opts.fileId, email: opts.email }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-docs-list', async (_ev, opts) => {
    try { return await googleApi.listDocs(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-info', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      return await googleApi.getDocInfo(opts.docId);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-read', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      return await googleApi.readDoc(opts.docId, opts);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-create', async (_ev, opts) => {
    try {
      if (!opts?.title) return { error: 'title required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.createDoc(opts.title, opts);
      try { auditLog('google_docs_create', { title: opts.title }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-write', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      if (opts.text === undefined && !opts.file) return { error: 'text or file required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.writeDoc(opts.docId, opts);
      try { auditLog('google_docs_write', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-insert', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      if (opts.content === undefined && !opts.file) return { error: 'content or file required' };
      const googleRoutes = require('./google-routes');
      if (opts.file && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.file)) return { error: 'file blocked by path validation' };
      const r = await googleApi.insertDoc(opts.docId, opts.content, opts);
      try { auditLog('google_docs_insert', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-find-replace', async (_ev, opts) => {
    try {
      if (!opts?.docId || !opts?.find) return { error: 'docId and find required' };
      const googleRoutes = require('./google-routes');
      if (opts.contentFile && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.contentFile)) return { error: 'contentFile blocked by path validation' };
      const r = await googleApi.findReplaceDoc(opts.docId, opts.find, opts.replace, opts);
      try { auditLog('google_docs_find_replace', { docId: opts.docId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-docs-export', async (_ev, opts) => {
    try {
      if (!opts?.docId) return { error: 'docId required' };
      const googleRoutes = require('./google-routes');
      if (opts.out && googleRoutes.isHomedirPathSafe && !googleRoutes.isHomedirPathSafe(opts.out)) return { error: 'out blocked by path validation' };
      return await googleApi.exportDoc(opts.docId, opts);
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-contacts-list', async (_ev, opts) => {
    try { return await googleApi.listContacts(opts?.query); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-contacts-create', async (_ev, opts) => {
    try {
      if (!opts?.name) return { error: 'name required' };
      const r = await googleApi.createContact(opts.name, opts.phone, opts.email);
      try { auditLog('google_contacts_create', { name: opts.name }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-list', async (_ev, opts) => {
    try { return await googleApi.listTasks(opts?.listId); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-lists', async (_ev, opts) => {
    try { return await googleApi.listTaskLists(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-create', async (_ev, opts) => {
    try {
      if (!opts?.title) return { error: 'title required' };
      const r = await googleApi.createTask(opts.title, opts.due, opts.listId);
      try { auditLog('google_tasks_create', { title: opts.title }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-tasks-complete', async (_ev, opts) => {
    try {
      if (!opts?.taskId) return { error: 'taskId required' };
      const r = await googleApi.completeTask(opts.taskId, opts.listId);
      try { auditLog('google_tasks_complete', { taskId: opts.taskId }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('google-sheets-metadata', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId) return { error: 'spreadsheetId required' };
      return await googleApi.getSheetMetadata(opts.spreadsheetId);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-list', async (_ev, opts) => {
    try { return await googleApi.listSheets(opts?.max); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-get', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      return await googleApi.getSheet(opts.spreadsheetId, opts.range, opts);
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-update', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      const googleRoutes = require('./google-routes');
      const parsedValues = googleRoutes.normalizeSheetValues
        ? googleRoutes.normalizeSheetValues(opts)
        : { ok: true, values: opts.values };
      if (parsedValues && !parsedValues.ok) return { error: parsedValues.error };
      const values = parsedValues ? parsedValues.values : opts.values;
      const range = googleRoutes.fitSheetRangeToValues
        ? googleRoutes.fitSheetRangeToValues(opts.range, values)
        : opts.range;
      const r = await googleApi.updateSheet(opts.spreadsheetId, range, values, opts);
      try { auditLog('google_sheets_update', { spreadsheetId: opts.spreadsheetId, range }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-sheets-append', async (_ev, opts) => {
    try {
      if (!opts?.spreadsheetId || !opts?.range) return { error: 'spreadsheetId and range required' };
      const googleRoutes = require('./google-routes');
      const parsedValues = googleRoutes.normalizeSheetValues
        ? googleRoutes.normalizeSheetValues(opts)
        : { ok: true, values: opts.values };
      if (parsedValues && !parsedValues.ok) return { error: parsedValues.error };
      const values = parsedValues ? parsedValues.values : opts.values;
      const r = await googleApi.appendSheet(opts.spreadsheetId, opts.range, values, opts);
      try { auditLog('google_sheets_append', { spreadsheetId: opts.spreadsheetId, range: opts.range }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('google-appscript-run', async (_ev, opts) => {
    try {
      if (!opts?.scriptId || !opts?.functionName) return { error: 'scriptId and functionName required' };
      const r = await googleApi.runAppScript(opts.scriptId, opts.functionName, opts.params, opts.devMode);
      try { auditLog('google_appscript_run', { scriptId: opts.scriptId, functionName: opts.functionName }); } catch {}
      return r;
    } catch (e) { return { error: e.message }; }
  });

  // Compaction IPC handlers — expose compact engine to UI and Telegram agent
  ipcMain.handle('compact-session', async (_ev, opts = {}) => {
    // opts: { sessionPath, mode, focus, fromMessageId }
    const { compactSession: doCompact } = require('./compact');
    try {
      if (!opts?.sessionPath) {
        return { success: false, error: 'sessionPath required' };
      }
      const result = await doCompact(opts.sessionPath, {
        mode: opts.mode || 'full',
        focus: opts.focus || '',
        fromMessageId: opts.fromMessageId || null,
      });
      return result;
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('compact-all-sessions', async () => {
    const { compactAllSessions: sweep } = require('./compact');
    try {
      await sweep();
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('get-compact-stats', async () => {
    const { getAllSessionStats } = require('./compact');
    try {
      return getAllSessionStats();
    } catch (e) { return []; }
  });

  // ============================================
  //  CEO MEMORY (Hermes-style learned knowledge)
  // ============================================

  ipcMain.handle('get-ceo-memories', async () => {
    try {
      const { listMemories, getMemoryCount, getLastMemoryAt } = require('./ceo-memory');
      return { memories: listMemories({ limit: 100 }), count: getMemoryCount(), lastAt: getLastMemoryAt() };
    } catch (e) {
      console.error('[ceo-memory] list error:', e?.message);
      return { memories: [], count: 0, lastAt: null };
    }
  });

  ipcMain.handle('delete-ceo-memory', async (_event, { id }) => {
    try {
      const { deleteMemory } = require('./ceo-memory');
      return deleteMemory(id);
    } catch (e) {
      console.error('[ceo-memory] delete error:', e?.message);
      return { deleted: false, reason: e?.message };
    }
  });

  ipcMain.handle('write-ceo-memory', async (_event, { type, content, source }) => {
    try {
      const { writeMemory } = require('./ceo-memory');
      return await writeMemory({ type, content, source: source || 'manual' });
    } catch (e) {
      console.error('[ceo-memory] write error:', e?.message);
      return { error: e?.message };
    }
  });

  ipcMain.handle('search-ceo-memories', async (_event, { query, limit }) => {
    try {
      const { searchMemory } = require('./ceo-memory');
      return await searchMemory(query, { limit: limit || 5, bumpRelevance: false });
    } catch (e) {
      console.error('[ceo-memory] search error:', e?.message);
      return [];
    }
  });

  ipcMain.handle('update-ceo-memory-status', async (_event, { id, status }) => {
    try {
      const { updateMemoryStatus } = require('./ceo-memory');
      return await updateMemoryStatus(id, status);
    } catch (e) {
      console.error('[ceo-memory] status update error:', e?.message);
      return { updated: false, error: e?.message };
    }
  });

  ipcMain.handle('prioritize-ceo-memory', async (_event, { id, delta }) => {
    try {
      const { prioritizeMemory } = require('./ceo-memory');
      return await prioritizeMemory(id, delta);
    } catch (e) {
      console.error('[ceo-memory] prioritize error:', e?.message);
      return { updated: false, error: e?.message };
    }
  });

  ipcMain.handle('supersede-ceo-memory', async (_event, { id, supersededById }) => {
    try {
      const { supersedeMemory } = require('./ceo-memory');
      return await supersedeMemory(id, supersededById || null);
    } catch (e) {
      console.error('[ceo-memory] supersede error:', e?.message);
      return { updated: false, error: e?.message };
    }
  });

  ipcMain.handle('get-ceo-memory-events', async (_event, { limit, channel, actorId, ids } = {}) => {
    try {
      const { listMemoryEvents } = require('./ceo-memory');
      return { events: listMemoryEvents({ limit: limit || 100, channel, actorId, ids }) };
    } catch (e) {
      console.error('[ceo-memory] events list error:', e?.message);
      return { events: [], error: e?.message };
    }
  });

  ipcMain.handle('get-ceo-memory-count', async () => {
    try {
      const { getMemoryCount } = require('./ceo-memory');
      return getMemoryCount();
    } catch (e) {
      return 0;
    }
  });

  // ================================
  // User Skills — Dashboard CRUD
  // ================================

  ipcMain.handle('list-all-skills', async () => {
    try {
      const sm = require('./skill-manager');
      const shipped = sm.listShippedSkills();
      const user = sm.listUserSkills();
      return { shipped, user };
    } catch (e) {
      console.error('[list-all-skills]', e?.message);
      return { shipped: [], user: [] };
    }
  });

  ipcMain.handle('get-skill-detail', async (_event, id, source) => {
    try {
      const sm = require('./skill-manager');
      if (source === 'shipped') return sm.getShippedSkillContent(id);
      return sm.getUserSkillContent(id);
    } catch (e) { return null; }
  });

  // Broadcast helper — notify all renderer windows that the skill registry
  // changed, so Dashboard auto-refreshes without a manual reload.
  function _broadcastSkillUpdated() {
    try {
      const { BrowserWindow } = require('electron');
      const sm = require('./skill-manager');
      const skills = sm.listUserSkills();
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('skill-updated', { skills }); } catch {}
      }
    } catch {}
  }

  ipcMain.handle('create-user-skill', async (_event, data) => {
    try {
      const sm = require('./skill-manager');
      if (sm.isContentTooLong(data?.content)) {
        throw new Error(`Nội dung dài quá ${String(data.content).length}/${sm.SKILL_CONTENT_MAX} ký tự.`);
      }
      const entry = await sm.createUserSkill({ ...data, createdVia: 'dashboard' });
      _broadcastSkillUpdated();
      return entry;
    } catch (e) { throw new Error(e.message); }
  });

  ipcMain.handle('update-user-skill', async (_event, id, data) => {
    try {
      const sm = require('./skill-manager');
      if (data?.content !== undefined && sm.isContentTooLong(data.content)) {
        throw new Error(`Nội dung dài quá ${String(data.content).length}/${sm.SKILL_CONTENT_MAX} ký tự.`);
      }
      const skill = await sm.updateUserSkill(id, data);
      _broadcastSkillUpdated();
      return skill;
    } catch (e) { throw new Error(e.message); }
  });

  ipcMain.handle('delete-user-skill', async (_event, id) => {
    try {
      const sm = require('./skill-manager');
      const result = await sm.deleteUserSkill(id);
      _broadcastSkillUpdated();
      return result;
    } catch (e) { throw new Error(e.message); }
  });

  ipcMain.handle('toggle-user-skill', async (_event, id, enabled) => {
    try {
      const sm = require('./skill-manager');
      const skill = await sm.toggleUserSkill(id, enabled);
      _broadcastSkillUpdated();
      return skill;
    } catch (e) { throw new Error(e.message); }
  });

  ipcMain.handle('restore-user-skill', async (_event, id) => {
    try {
      const sm = require('./skill-manager');
      // Shipped skills aren't in _trash — "restore" clears the _shipped-state override
      // (un-disable / un-delete / un-replace). User skills restore from _trash.
      const entry = sm._isShippedId(id) ? await sm.restoreShippedSkill(id) : await sm.restoreUserSkill(id);
      _broadcastSkillUpdated();
      return entry;
    } catch (e) { throw new Error(e.message); }
  });

  ipcMain.handle('check-skill-conflict', async (_event, data) => {
    try {
      const sm = require('./skill-manager');
      const layer1 = sm.checkConflict(data);
      let layer2 = null;
      if (layer1.length === 0) {
        try {
          const http = require('http');
          const allSkills = sm.listUserSkills().filter(s => s.enabled);
          if (allSkills.length > 0) {
            const prompt = `Các quy tắc hiện có:\n${allSkills.map(s => `- ${s.name}: ${s.summary}`).join('\n')}\n\nQuy tắc mới:\n${data.content}\n\nCó mâu thuẫn logic hay trùng chức năng không? Trả lời JSON: {"hasConflict":bool,"description":"..."}`;
            const body = JSON.stringify({ model: 'gpt-5-mini', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
            layer2 = await new Promise((resolve) => {
              const timer = setTimeout(() => resolve(null), 15000);
              const req = http.request({ hostname: '127.0.0.1', port: 20128, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => { clearTimeout(timer); try { const r = JSON.parse(d); const txt = r.choices?.[0]?.message?.content || ''; resolve(JSON.parse(txt)); } catch { resolve(null); } });
              });
              req.on('error', () => { clearTimeout(timer); resolve(null); });
              req.end(body);
            });
          }
        } catch {}
      }
      return { conflicts: layer1, semantic: layer2 };
    } catch (e) { return { conflicts: [], semantic: null, error: e.message }; }
  });

  // ================================
  // Zalo Behavior Control — preview-stack + replace-shipped
  // ================================

  ipcMain.handle('preview-zalo-stack', async (_event, { senderId, threadId, isGroup, text } = {}) => {
    try {
      const sm = require('./skill-manager');
      const stack = sm.previewZaloStack({
        rawBody: text || '',
        senderId: senderId || '',
        threadId: threadId || '',
        isGroup: !!isGroup,
      });
      return { stack };
    } catch (e) {
      console.error('[preview-zalo-stack]', e?.message);
      return { stack: null, error: e?.message };
    }
  });

  ipcMain.handle('replace-shipped-skill', async (_event, { shippedId, withUserSkillId } = {}) => {
    try {
      const sm = require('./skill-manager');
      if (!shippedId || !withUserSkillId) throw new Error('shippedId và withUserSkillId là bắt buộc');
      const r = await sm.replaceShippedSkill(shippedId, withUserSkillId);
      _broadcastSkillUpdated();
      return { success: true, ...r };
    } catch (e) { throw new Error(e.message); }
  });

  // --- Brain tab (knowledge graph) ---
  ipcMain.handle('get-brain-graph', async () => {
    const ws = getWorkspace();
    if (!ws) return null;
    try {
      const fp = path.join(ws, 'brain-graph.json');
      if (!fs.existsSync(fp)) return null;
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch (e) { console.warn('[brain] get-brain-graph error:', e.message); return null; }
  });

  ipcMain.handle('get-brain-node-detail', async (_e, nodeId) => {
    const ws = getWorkspace();
    if (!ws || !nodeId) return null;
    try {
      let fp = null;
      if (nodeId.startsWith('user:')) {
        const segment = nodeId.slice(5);
        if (!segment || /[\/\\]|\.\./.test(segment)) return null;
        fp = path.join(ws, 'memory', 'zalo-users', segment + '.md');
      }
      else if (nodeId.startsWith('group:')) {
        const segment = nodeId.slice(6);
        if (!segment || /[\/\\]|\.\./.test(segment)) return null;
        fp = path.join(ws, 'memory', 'zalo-groups', segment + '.md');
      }
      else if (nodeId.startsWith('doc:')) {
        const cats = ['cong-ty', 'san-pham', 'nhan-vien', 'framework', 'workflow'];
        const fname = nodeId.slice(4);
        if (!fname || /[\/\\]|\.\./.test(fname)) return null;
        // Files live under files/<public|noi-bo|ceo-only>/ since the v2.4 migration
        // (brain-graph emits doc:<filename> from those subfolders); '' keeps the
        // legacy flat layout working. Without the subfolders, every doc-node click
        // resolves to null on current installs.
        const subs = ['', 'public', 'noi-bo', 'ceo-only'];
        outer: for (const cat of cats) {
          for (const sub of subs) {
            const candidate = path.join(ws, 'knowledge', cat, 'files', sub, fname);
            if (fs.existsSync(candidate)) { fp = candidate; break outer; }
          }
        }
      }
      else if (nodeId.startsWith('learning:')) {
        const lf = path.join(ws, '.learnings', 'LEARNINGS.md');
        if (fs.existsSync(lf)) {
          const content = fs.readFileSync(lf, 'utf-8');
          const lid = nodeId.slice(9);
          const re = new RegExp('### \\[\\d{4}-\\d{2}-\\d{2}\\] ID: ' + lid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?=### \\[|$)');
          const match = content.match(re);
          return match ? { content: match[0].trim(), meta: { type: 'learning' } } : null;
        }
        return null;
      }
      else if (nodeId.startsWith('skill:')) {
        const sid = nodeId.slice(6);
        if (!sid || /[\/\\]|\.\./.test(sid)) return null;
        const candidates = [path.join(ws, 'user-skills', sid, 'SKILL.md'), path.join(ws, 'user-skills', sid + '.md')];
        for (const c of candidates) { if (fs.existsSync(c)) { fp = c; break; } }
      }
      if (!fp || !fs.existsSync(fp)) return null;
      return { content: fs.readFileSync(fp, 'utf-8'), meta: { type: nodeId.split(':')[0] } };
    } catch (e) { console.warn('[brain] get-brain-node-detail error:', e.message); return null; }
  });

  let _brainBuildInFlight = false;
  ipcMain.handle('rebuild-brain-graph', async () => {
    if (_brainBuildInFlight) return { started: false, reason: 'already running' };
    _brainBuildInFlight = true;
    try {
      const { buildBrainGraph } = require('./brain-graph');
      buildBrainGraph(getWorkspace()).then(() => {
        _brainBuildInFlight = false;
        try { ctx.mainWindow?.webContents?.send('brain-graph-rebuilt'); } catch {}
      }).catch(e => { _brainBuildInFlight = false; console.error('[brain] rebuild error:', e.message); });
    } catch (e) { _brainBuildInFlight = false; console.error('[brain] rebuild require error:', e.message); }
    return { started: true };
  });

  // === CEO Backup (encrypted .9bizclaw-backup) ===
  let _backupInFlight = false;
  ipcMain.handle('create-backup', async (_event, { password }) => {
    if (_backupInFlight) return { ok: false, error: 'Đang sao lưu/khôi phục, vui lòng đợi' };
    _backupInFlight = true;
    try {
      const { createBackup } = require('./backup');
      const { BrowserWindow, dialog, app } = require('electron');
      const parentWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const { filePath, canceled } = await dialog.showSaveDialog(parentWin, {
        title: 'Sao lưu dữ liệu',
        defaultPath: '9bizclaw-backup-' + new Date().toISOString().slice(0, 10) + '.9bizclaw-backup',
        filters: [{ name: '9BizClaw Backup', extensions: ['9bizclaw-backup'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      try { killAllOpenClawProcesses(); } catch {}
      try { stop9Router(); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      const result = createBackup(filePath, password, app.getVersion());
      // Restart processes after backup
      try { await startOpenClaw(); } catch (re) { console.warn('[backup] restart gateway failed:', re?.message); }
      return { ok: true, filePath, ...result };
    } catch (e) {
      console.error('[backup] create error:', e?.message);
      try { await startOpenClaw(); } catch {}
      return { ok: false, error: e?.message };
    } finally {
      _backupInFlight = false;
    }
  });

  ipcMain.handle('restore-backup-preview', async (_event, { filePath, password }) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'invalid filePath' };
      if (!password || typeof password !== 'string') return { ok: false, error: 'invalid password' };
      const { restoreBackupPreview } = require('./backup');
      return restoreBackupPreview(filePath, password);
    } catch (e) {
      console.error('[backup] preview error:', e?.message);
      return { ok: false, error: e?.message };
    }
  });

  ipcMain.handle('restore-backup-apply', async (_event, { filePath, password }) => {
    if (_backupInFlight) return { ok: false, error: 'Đang sao lưu/khôi phục, vui lòng đợi' };
    _backupInFlight = true;
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'invalid filePath' };
      if (!password || typeof password !== 'string') return { ok: false, error: 'invalid password' };
      const { restoreBackup } = require('./backup');
      const { app } = require('electron');
      try { killAllOpenClawProcesses(); } catch {}
      try { stop9Router(); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      const result = restoreBackup(filePath, password, app.getVersion());
      setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
      return { ok: true, ...result };
    } catch (e) {
      console.error('[backup] restore error:', e?.message);
      return { ok: false, error: e?.message };
    } finally {
      _backupInFlight = false;
    }
  });

  ipcMain.handle('open-backup-file-dialog', async () => {
    try {
      const { BrowserWindow, dialog } = require('electron');
      const parentWin = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const { filePaths, canceled } = await dialog.showOpenDialog(parentWin, {
        title: 'Chọn file backup',
        filters: [{ name: '9BizClaw Backup', extensions: ['9bizclaw-backup'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths?.length) return { ok: false, canceled: true };
      return { ok: true, filePath: filePaths[0] };
    } catch (e) {
      return { ok: false, error: e?.message };
    }
  });

  // ── ChatGPT session import (fallback when OAuth OTP fails) ──
  ipcMain.handle('import-chatgpt-session', async (_event, { sessionJson }) => {
    try {
      let session;
      try {
        let raw = sessionJson.replace(/^﻿/, '').trim();
        const fi = raw.indexOf('{'), li = raw.lastIndexOf('}');
        if (fi >= 0 && li > fi) raw = raw.substring(fi, li + 1);
        session = JSON.parse(raw);
      } catch { return { success: false, error: 'JSON không hợp lệ — hãy copy toàn bộ nội dung từ chatgpt.com/api/auth/session' }; }

      const accessToken = session.accessToken;
      if (!accessToken || typeof accessToken !== 'string' || accessToken.length < 50) {
        return { success: false, error: 'Thiếu accessToken — hãy copy toàn bộ nội dung trang, không chỉ một phần' };
      }

      let jwtPayload = {};
      try {
        const parts = accessToken.split('.');
        if (parts.length === 3) jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
      } catch { /* non-JWT token — proceed without metadata */ }

      const authClaims = jwtPayload['https://api.openai.com/auth'] || {};
      const profileClaims = jwtPayload['https://api.openai.com/profile'] || {};
      const email = session.user?.email || profileClaims.email || '';
      if (!email) return { success: false, error: 'Không tìm thấy email trong session — JSON có thể không đúng định dạng' };

      const planType = authClaims.chatgpt_plan_type || 'unknown';
      const expiresIn = (jwtPayload.exp && jwtPayload.iat) ? (jwtPayload.exp - jwtPayload.iat) : 864000;

      const entry = {
        id: require('crypto').randomUUID(),
        provider: 'codex',
        authType: 'oauth',
        name: email,
        priority: 1,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        email,
        accessToken,
        refreshToken: session.refreshToken || null,
        expiresAt: session.expires || (jwtPayload.exp ? new Date(jwtPayload.exp * 1000).toISOString() : null),
        idToken: null,
        testStatus: 'active',
        expiresIn,
        providerSpecificData: {
          chatgptAccountId: authClaims.chatgpt_account_id || null,
          chatgptPlanType: planType,
        },
        lastUsedAt: null,
        consecutiveUseCount: 0,
        lastError: null,
        errorCode: null,
        lastErrorAt: null,
        backoffLevel: 0,
      };

      // Strategy 0: 9Router v0.4.63 stores providers in SQLite and exposes a
      // Codex access-token import route. Use it before the older /api/providers
      // and db.json fallbacks.
      const importTokenRes = await nineRouterApi('POST', '/api/oauth/codex/import-token', {
        accessToken,
        name: email,
      }, 10000);
      if (importTokenRes.success) return { success: true, email, planType, method: 'api-import-token' };

      // Strategy 1: POST full entry to 9router API (works on all platforms)
      const apiRes = await nineRouterApi('POST', '/api/providers', entry, 10000);
      if (apiRes.success) return { success: true, email, planType, method: 'api' };

      // Strategy 2: POST minimal provider (some 9router versions only accept basic fields)
      const apiRes2 = await nineRouterApi('POST', '/api/providers', { provider: 'codex', name: email, apiKey: accessToken }, 10000);
      if (apiRes2.success) return { success: true, email, planType, method: 'api-minimal' };

      // Strategy 3: Direct db.json write (works on Windows, may fail on Mac sandbox)
      try {
        const dbPath = path.join(appDataDir(), '9router', 'db.json');
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        let db = {};
        if (fs.existsSync(dbPath)) {
          try { db = JSON.parse(fs.readFileSync(dbPath, 'utf-8')); } catch { db = {}; }
        }
        if (!Array.isArray(db.providerConnections)) db.providerConnections = [];
        if (!Array.isArray(db.combos)) db.combos = [];
        if (!Array.isArray(db.apiKeys)) db.apiKeys = [];
        if (!db.settings) db.settings = {};
        const existingIdx = db.providerConnections.findIndex(p => p.provider === 'codex' && p.email === email);
        if (existingIdx >= 0) {
          entry.id = db.providerConnections[existingIdx].id;
          entry.createdAt = db.providerConnections[existingIdx].createdAt;
          entry.priority = db.providerConnections[existingIdx].priority;
          db.providerConnections[existingIdx] = entry;
        } else {
          entry.priority = db.providerConnections.reduce((m, p) => Math.max(m, p.priority || 0), 0) + 1;
          db.providerConnections.push(entry);
        }
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
        try { stop9Router(); await new Promise(r => setTimeout(r, 1200)); start9Router(); } catch (e) { console.error('[import-chatgpt] 9router restart failed:', e?.message); }
        return { success: true, email, planType, method: 'file' };
      } catch (writeErr) {
        console.error('[import-chatgpt] all 3 strategies failed. API1:', apiRes.error, 'API2:', apiRes2.error, 'File:', writeErr?.message);
        return { success: false, error: 'Import thất bại. Hãy mở 9Router (tab AI Models), dùng chức năng Import trong 9Router để thêm tài khoản thủ công.' };
      }
    } catch (e) {
      console.error('[import-chatgpt-session]', e);
      return { success: false, error: 'Không ghi được cấu hình 9router: ' + (e?.message || String(e)) };
    }
  });

  // --- Generic channel IPC (WhatsApp, Lark, future channels) ---
  const { getChannel } = require('./channel-registry');

  ipcMain.handle('channel:ready', async (_e, { ch }) => {
    const def = getChannel(ch);
    if (!def) return { ready: false, error: 'unknown channel' };
    try {
      const { probeChannelReady } = require('./channels');
      return await probeChannelReady(ch);
    } catch (e) { return { ready: false, error: e?.message }; }
  });

  ipcMain.handle('channel:connect', async (_e, { ch }) => {
    const def = getChannel(ch);
    if (!def || !def.loginChannel) return { success: false, error: 'channel does not support login' };
    try {
      const { connectNewChannel } = require('./channels');
      return await connectNewChannel(ch);
    } catch (e) { return { success: false, error: e?.message }; }
  });

  ipcMain.handle('channel:disconnect', async (_e, { ch }) => {
    const def = getChannel(ch);
    if (!def) return { success: false, error: 'unknown channel' };
    try {
      const { disconnectChannel } = require('./channels');
      return await disconnectChannel(ch);
    } catch (e) { return { success: false, error: e?.message }; }
  });

  ipcMain.handle('channel:config:get', async (_e, { ch }) => {
    try {
      const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
      if (!fs.existsSync(cfgPath)) return {};
      const cfg = readOpenclawJsonFile(cfgPath);
      const def = getChannel(ch);
      return def ? (cfg.channels?.[def.id] || {}) : {};
    } catch { return {}; }
  });

  ipcMain.handle('channel:config:save', async (_e, { ch, config }) => {
    const def = getChannel(ch);
    if (!def) return { success: false, error: 'unknown channel' };
    try {
      return await withOpenClawConfigLock(async () => {
        const cfgPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
        const cfg = readOpenclawJsonFile(cfgPath);
        if (!cfg.channels) cfg.channels = {};
        if (!cfg.channels[def.id]) cfg.channels[def.id] = {};
        const ALLOWED_FIELDS = ['enabled', 'dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom'];
        for (const key of Object.keys(config)) {
          if (ALLOWED_FIELDS.includes(key)) {
            cfg.channels[def.id][key] = config[key];
          }
        }
        writeOpenClawConfigIfChanged(cfgPath, cfg);
        return { success: true };
      });
    } catch (e) { return { success: false, error: e?.message }; }
  });

  ipcMain.handle('channel:pause', async (_e, { ch, minutes }) => {
    try {
      const { pauseChannel } = require('./channels');
      pauseChannel(ch, minutes || 30);
      return { success: true };
    } catch (e) { return { success: false, error: e?.message }; }
  });

  ipcMain.handle('channel:resume', async (_e, { ch }) => {
    try {
      const { resumeChannel } = require('./channels');
      resumeChannel(ch);
      return { success: true };
    } catch (e) { return { success: false, error: e?.message }; }
  });

  ipcMain.handle('channel:pause-status', async (_e, { ch }) => {
    try {
      const { getChannelPauseStatus } = require('./channels');
      return getChannelPauseStatus(ch);
    } catch { return { paused: false }; }
  });

  // ── Premium Onboarding 7 Ngày ─────────────────────────────────────────
  ipcMain.handle('onboarding:status', async () => {
    try {
      return getOnboardingStatus() || { active: false };
    } catch (e) {
      console.error('[onboarding:status]', e?.message);
      return { active: false, error: e?.message };
    }
  });

  ipcMain.handle('onboarding:dismiss', async () => {
    try {
      dismissOnboarding();
      return { success: true };
    } catch (e) {
      console.error('[onboarding:dismiss]', e?.message);
      return { success: false, error: e?.message };
    }
  });

  ipcMain.handle('onboarding:advance', async () => {
    try {
      advanceOnboardingDay();
      return { success: true };
    } catch (e) {
      console.error('[onboarding:advance]', e?.message);
      return { success: false, error: e?.message };
    }
  });

} // end registerAllIpcHandlers

module.exports = { registerAllIpcHandlers, ensureModoroEndpoint };
