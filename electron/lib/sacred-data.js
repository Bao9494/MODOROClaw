'use strict';
// Single source of truth for irreplaceable CEO/customer-generated data.
// Layers 1-4 of Sacred Data Protection — see docs/superpowers/specs/2026-06-04-sacred-data-protection-design.md
//
// Anti-features:
//  - Not encryption or cloud backup (local only — out of scope).
//  - Not protecting regenerable data (daily journals, RAG index).
//  - Guard (Layer 1) is heuristic, not full taint analysis — Layers 2-4 cover gaps.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Layer 1: Sacred constants ─────────────────────────────────────────────────

const SACRED_DIRS = [
  'memory/zalo-users', 'memory/zalo-groups',
  'memory/telegram-users', 'memory/telegram-groups',
  'memory/whatsapp-users', 'memory/whatsapp-groups',
  'user-skills',
  'zalo-history', // append-only raw ground-truth archive (account-namespaced)
  'telegram-history', // append-only raw ground-truth archive (chat-namespaced)
];

const SACRED_FILES = [
  'CEO-MEMORY.md', 'so-sach.md', 'cong-no.md',
  'schedules.json', 'custom-crons.json',
  'zalo-blocklist.json', 'zalo-allowlist.json',
  'user-skills/_registry.json',
];

// Leaf segments used by the static guard to spot sacred paths in fs-op arguments.
// IMPORTANT: 'user-skills' is a segment; bare 'skills' is NOT — avoid false matches.
const SACRED_SEGMENTS = [
  'zalo-users', 'zalo-groups',
  'telegram-users', 'telegram-groups',
  'whatsapp-users', 'whatsapp-groups',
  'user-skills',
  'zalo-history', 'telegram-history',
  'CEO-MEMORY.md', 'so-sach.md', 'cong-no.md',
];

/**
 * Returns true if relPath refers to a sacred directory or file.
 * relPath is workspace-relative (forward slashes).
 */
function isSacredPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  return (
    SACRED_DIRS.some(d => p === d || p.startsWith(d + '/')) ||
    SACRED_FILES.includes(p)
  );
}

// ── External backup root (outside workspace — survives factory-reset wipe) ───
// CRITICAL: this must be OUTSIDE userData/workspace so factory-reset's rmSync
// cannot destroy the backup. We use ~/9BizClaw-SacredBackups.
const SACRED_BACKUP_ROOT = path.join(os.homedir(), '9BizClaw-SacredBackups');

// Max snapshots to keep (oldest is always preserved on top of this).
const MAX_SNAPSHOTS = 20;

// One-shot sentinel: when present, the next healSacredOnBoot() skips its restore
// step (so a deliberate factory-reset actually sticks) then deletes the sentinel.
// Lives in SACRED_BACKUP_ROOT (outside the workspace) so it survives the reset wipe.
const SUPPRESS_HEAL_FILE = '.suppress-next-heal';

// Persistent factory-reset epoch (ms). Heal NEVER restores from a snapshot taken
// at/before this time, so a deliberately-wiped profile can't be resurrected on a
// LATER boot (the one-shot sentinel only covered the immediate next boot). The
// pre-reset snapshot is kept on disk for manual recovery via restoreFrom().
const RESET_EPOCH_FILE = '.reset-epoch';

function _readResetEpoch() {
  try {
    const v = Number(fs.readFileSync(path.join(SACRED_BACKUP_ROOT, RESET_EPOCH_FILE), 'utf-8').trim());
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

// Parse the ISO timestamp embedded in a snapshot dir name (`<ts>-<reason>`, where
// ts has ':' replaced by '-') back to epoch ms. Authoritative for the epoch check
// even when a snapshot's manifest is missing/corrupt — so a double fault (reset +
// bad manifest) can't make heal silently skip a valid post-reset snapshot.
function _snapshotDirMs(dirName) {
  const m = String(dirName).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

// ── Lazy imports (avoid circular deps at require-time) ────────────────────────

function _getWorkspace() {
  try { return require('./workspace').getWorkspace(); } catch { return null; }
}

// sendCeoAlert is async; we never throw from alert failures.
function _sendCeoAlert(text) {
  try {
    const { sendCeoAlert } = require('./channels');
    return sendCeoAlert(text);
  } catch (e) {
    console.error('[sacred-data] sendCeoAlert import failed:', e?.message);
    return Promise.resolve(false);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Count files in a directory recursively. Returns 0 if dir doesn't exist.
 */
function _countFiles(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) count += _countFiles(path.join(dir, e.name));
      else if (e.isFile()) count++;
    }
  } catch {}
  return count;
}

/**
 * Copy a file, creating the destination directory tree as needed.
 */
function _copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // SACRED-OK: sacred-data.js is the backup/restore engine — copying sacred files here is the purpose
  fs.copyFileSync(src, dest); // SACRED-OK
}

/**
 * List all files under dir recursively, returning workspace-relative paths.
 * dir is an absolute path; wsRoot is the workspace root used to make paths relative.
 */
function _listFilesRelative(dir, wsRoot) {
  const result = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) result.push(path.relative(wsRoot, full).replace(/\\/g, '/'));
    }
  }
  walk(dir);
  return result;
}

/**
 * Sanitize a reason string to [a-z0-9-] for use in directory names.
 */
function _safeReason(reason) {
  return String(reason || 'manual').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
}

/**
 * List existing snapshot dirs sorted newest-first.
 * Each snapshot dir is a direct child of SACRED_BACKUP_ROOT.
 */
function _listSnapshotDirs() {
  try {
    const entries = fs.readdirSync(SACRED_BACKUP_ROOT, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse(); // newest first (ISO timestamp prefix sorts lexicographically)
  } catch {
    return [];
  }
}

/**
 * Apply retention: keep newest MAX_SNAPSHOTS + always keep the oldest.
 * Deletes the rest from SACRED_BACKUP_ROOT.
 */
function _applyRetention() {
  const dirs = _listSnapshotDirs(); // newest first
  if (dirs.length <= MAX_SNAPSHOTS + 1) return; // +1 for the oldest slot

  // dirs[0] = newest, dirs[dirs.length-1] = oldest
  const keep = new Set();
  // Keep newest MAX_SNAPSHOTS
  for (let i = 0; i < Math.min(MAX_SNAPSHOTS, dirs.length); i++) keep.add(dirs[i]);
  // Always keep oldest
  keep.add(dirs[dirs.length - 1]);

  for (const d of dirs) {
    if (!keep.has(d)) {
      try {
        // SACRED-OK: this removes old snapshot dirs (not workspace data); backups outside userData
        fs.rmSync(path.join(SACRED_BACKUP_ROOT, d), { recursive: true, force: true }); // SACRED-OK
      } catch (e) {
        console.error('[sacred-data] retention delete failed for', d, e?.message);
      }
    }
  }
}

// ── Layer 2: snapshotSacred ───────────────────────────────────────────────────

/**
 * _snapshotTo — pure copy logic, testable with explicit paths.
 * @param {string} ws       - workspace root (absolute)
 * @param {string} destRoot - where snapshots live (e.g. SACRED_BACKUP_ROOT)
 * @param {string} reason   - human reason tag
 * @returns {{ dir: string, counts: Object }}
 */
function _snapshotTo(ws, destRoot, reason) {
  const ts = new Date().toISOString().replace(/:/g, '-');
  const safeR = _safeReason(reason);
  const destDir = path.join(destRoot, `${ts}-${safeR}`);

  // Incremental: for files byte-identical to the previous snapshot (same size+mtime),
  // HARDLINK the already-backed-up copy instead of re-copying content. This keeps an
  // unbounded store (zalo-history) from being fully re-copied on every version-bump.
  // Hardlinks are retention-safe: deleting one snapshot keeps the inode alive while
  // any other snapshot still links it.
  let prevDir = null;
  let prevStats = {};
  try {
    // List siblings under destRoot (NOT the global backup root) so this stays correct
    // when tests pass a temp destRoot.
    const prev = fs.readdirSync(destRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort().reverse()
      .find(d => d !== `${ts}-${safeR}`);
    if (prev) {
      prevDir = path.join(destRoot, prev);
      const pm = path.join(prevDir, 'manifest.json');
      if (fs.existsSync(pm)) prevStats = (JSON.parse(fs.readFileSync(pm, 'utf-8')).stats) || {};
    }
  } catch {}

  fs.mkdirSync(destDir, { recursive: true });

  const counts = {};
  const files = [];
  const stats = {};

  const _backupOne = (relF, srcFile) => {
    let st;
    try { st = fs.statSync(srcFile); } catch { return; }
    const meta = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    const destFile = path.join(destDir, relF);
    const prev = prevStats[relF];
    const unchanged = prevDir && prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs;
    try {
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      if (unchanged) {
        try { fs.linkSync(path.join(prevDir, relF), destFile); } // no content read
        catch { _copyFile(srcFile, destFile); }                  // fallback (cross-device / missing)
      } else {
        _copyFile(srcFile, destFile);
      }
      files.push(relF);
      stats[relF] = meta;
    } catch (e) {
      console.error('[sacred-data] snapshot copy failed:', relF, e?.message);
    }
  };

  // Copy each SACRED_DIR
  for (const rel of SACRED_DIRS) {
    const src = path.join(ws, rel);
    if (!fs.existsSync(src)) continue;
    const relFiles = _listFilesRelative(src, ws);
    for (const f of relFiles) _backupOne(f, path.join(ws, f));
    counts[rel] = relFiles.length;
  }

  // Copy each SACRED_FILE
  for (const rel of SACRED_FILES) {
    const src = path.join(ws, rel);
    if (!fs.existsSync(src)) continue;
    _backupOne(rel, src);
  }

  // Write manifest
  const manifest = {
    ts,
    reason,
    counts,
    files,
    stats,
  };
  try {
    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (e) {
    console.error('[sacred-data] manifest write failed:', e?.message);
  }

  return { dir: destDir, counts };
}

/**
 * snapshotSacred(reason) — Layer 2: take an external backup of all sacred data.
 * Backup is stored in ~/9BizClaw-SacredBackups/<ts>-<reason>/.
 * Never throws — backup failure must not block the caller.
 * @param {string} reason  - tag for why this snapshot was taken
 * @returns {Promise<{ dir?: string, counts?: Object, skipped?: true }>}
 */
async function snapshotSacred(reason) {
  try {
    const ws = _getWorkspace();
    if (!ws) {
      console.warn('[sacred-data] snapshotSacred: workspace null — skipped');
      return { skipped: true };
    }

    fs.mkdirSync(SACRED_BACKUP_ROOT, { recursive: true });

    const result = _snapshotTo(ws, SACRED_BACKUP_ROOT, reason);

    // Apply retention after writing the new snapshot
    try { _applyRetention(); } catch (e) { console.error('[sacred-data] retention failed:', e?.message); }

    console.log(`[sacred-data] snapshot '${reason}' → ${result.dir} counts=${JSON.stringify(result.counts)}`);
    return result;
  } catch (e) {
    console.error('[sacred-data] snapshotSacred FAILED (non-blocking):', e?.message);
    return { skipped: true };
  }
}

// ── Factory-reset heal suppression (one-shot) ─────────────────────────────────

/**
 * markHealSuppressed() — write the one-shot sentinel into SACRED_BACKUP_ROOT so
 * the NEXT boot's healSacredOnBoot() skips its restore step. Called by the
 * factory-reset handler so a deliberate wipe actually sticks. The external
 * backups themselves are kept, so the CEO can still recover manually.
 * Never throws — failure here must not block factory-reset.
 */
function markHealSuppressed() {
  try {
    fs.mkdirSync(SACRED_BACKUP_ROOT, { recursive: true });
    const sentinel = path.join(SACRED_BACKUP_ROOT, SUPPRESS_HEAL_FILE);
    fs.writeFileSync(sentinel, new Date().toISOString(), 'utf-8');
    // Persistent epoch: also bars resurrection on every later boot, not just the next.
    try { fs.writeFileSync(path.join(SACRED_BACKUP_ROOT, RESET_EPOCH_FILE), String(Date.now()), 'utf-8'); } catch {}
    console.log('[sacred-data] heal suppression + reset epoch marked at', sentinel);
  } catch (e) {
    console.error('[sacred-data] markHealSuppressed failed (non-blocking):', e?.message);
  }
}

/**
 * _consumeSuppressSentinel — pure, path-injectable check used by healSacredOnBoot.
 * If the sentinel exists in backupRoot, delete it (one-shot consume) and return
 * true (caller must skip restore). Otherwise return false.
 * @param {string} backupRoot - dir that holds the sentinel
 * @returns {boolean} true if heal should be suppressed this boot
 */
function _consumeSuppressSentinel(backupRoot) {
  const sentinel = path.join(backupRoot, SUPPRESS_HEAL_FILE);
  if (!fs.existsSync(sentinel)) return false;
  try {
    // SACRED-OK: removes the suppression sentinel in the external backup root, not a sacred path
    fs.unlinkSync(sentinel); // SACRED-OK
  } catch (e) {
    console.error('[sacred-data] could not delete suppress sentinel:', e?.message);
  }
  return true;
}

// ── Layer 3+4: healSacredOnBoot ───────────────────────────────────────────────

/**
 * _healInto — pure heal logic, testable with explicit paths.
 * For any file present in snapshotDir but absent in ws, copy it back.
 * Never overwrites a file that exists in ws (live wins).
 * @param {string} ws           - live workspace root
 * @param {string} snapshotDir  - absolute path to the snapshot directory
 * @returns {{ restored: number, missing: string[] }}
 */
function _healInto(ws, snapshotDir) {
  let restored = 0;
  const missing = [];

  // Gather all files in snapshot (from SACRED_DIRS and SACRED_FILES only)
  const snapshotFiles = [];
  for (const rel of SACRED_DIRS) {
    const snapSrc = path.join(snapshotDir, rel);
    if (!fs.existsSync(snapSrc)) continue;
    snapshotFiles.push(..._listFilesRelative(snapSrc, snapshotDir));
  }
  for (const rel of SACRED_FILES) {
    if (fs.existsSync(path.join(snapshotDir, rel))) snapshotFiles.push(rel);
  }

  for (const relFile of snapshotFiles) {
    const liveFile = path.join(ws, relFile);
    if (fs.existsSync(liveFile)) continue; // live wins — never overwrite

    const snapFile = path.join(snapshotDir, relFile);
    try {
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      // SACRED-OK: heal path — restoring missing files back into workspace from external snapshot
      fs.copyFileSync(snapFile, liveFile); // SACRED-OK
      restored++;
      missing.push(relFile);
      console.log('[sacred-data] heal: restored missing file:', relFile);
    } catch (e) {
      console.error('[sacred-data] heal copy failed:', relFile, e?.message);
    }
  }

  return { restored, missing };
}

/**
 * Build a census object: { dirName: fileCount } for all SACRED_DIRS in ws.
 */
function _buildCensus(ws) {
  const census = {};
  for (const rel of SACRED_DIRS) {
    const dir = path.join(ws, rel);
    census[rel] = fs.existsSync(dir) ? _countFiles(dir) : 0;
  }
  return census;
}

/**
 * healSacredOnBoot() — Layers 3+4: on boot, detect data loss and restore from latest snapshot.
 * - Compares live workspace vs newest snapshot.
 * - Union-restores: only adds missing files; never overwrites live files.
 * - Sends CEO alert if any data was restored.
 * - Logs one-line census every boot.
 * Never throws.
 * @returns {Promise<{ restored: number, census: Object }>}
 */
async function healSacredOnBoot() {
  try {
    const ws = _getWorkspace();
    if (!ws) {
      console.warn('[sacred-data] healSacredOnBoot: workspace null — skipped');
      return { restored: 0, census: {} };
    }

    const census = _buildCensus(ws);
    const censusLine = Object.entries(census).map(([k, v]) => `${path.basename(k)}=${v}`).join(' ');
    console.log(`[sacred-data] census ${censusLine}`);

    // One-shot suppression: a deliberate factory-reset set the sentinel so this
    // boot must NOT resurrect the wiped data. Consume the sentinel and skip restore.
    // External backups are kept — the CEO can still recover manually via restoreFrom().
    if (_consumeSuppressSentinel(SACRED_BACKUP_ROOT)) {
      console.log(`[sacred-data] heal suppressed once after factory-reset — backups kept at ${SACRED_BACKUP_ROOT}`);
      return { suppressed: true, restored: 0, census };
    }

    // Find newest snapshot — but skip any taken at/before the last factory-reset so
    // deliberately-wiped data is never resurrected on a later boot.
    const snapshotDirs = _listSnapshotDirs();
    if (snapshotDirs.length === 0) {
      console.log('[sacred-data] no snapshots yet — census written, no heal needed');
      return { restored: 0, census };
    }

    const resetEpoch = _readResetEpoch();
    let newestDir = null;
    let snapshotManifest = null;
    for (const d of snapshotDirs) {
      const abs = path.join(SACRED_BACKUP_ROOT, d);
      let m = null;
      try {
        const mp = path.join(abs, 'manifest.json');
        if (fs.existsSync(mp)) m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
      } catch (e) {
        console.warn('[sacred-data] could not read snapshot manifest for', d, e?.message);
      }
      if (resetEpoch > 0) {
        // Prefer the dir-name timestamp (always present) over manifest.ts (may be corrupt).
        const dirMs = _snapshotDirMs(d);
        const snapMs = Number.isFinite(dirMs) ? dirMs : (m && m.ts ? Date.parse(m.ts) : NaN);
        if (!Number.isFinite(snapMs) || snapMs <= resetEpoch) continue; // pre-reset → never resurrect
      }
      newestDir = abs;
      snapshotManifest = m;
      break;
    }
    if (!newestDir) {
      console.log('[sacred-data] no post-reset snapshot to heal from — skipping restore');
      return { restored: 0, census };
    }

    // Heal: restore any missing files from newest snapshot
    const { restored, missing } = _healInto(ws, newestDir);

    if (restored > 0) {
      const snapshotTs = snapshotManifest?.ts || path.basename(newestDir);
      const alertText = `[Sacred Data] Phát hiện thiếu ${restored} hồ sơ — đã tự khôi phục từ backup ${snapshotTs}.`;
      console.error('[sacred-data] HEAL ALERT:', alertText, 'files:', missing);
      try { await _sendCeoAlert(alertText); } catch (e) { console.error('[sacred-data] alert failed:', e?.message); }
    }

    // Also alert if any live sacred dir count < snapshot count (even if heal filled some)
    if (snapshotManifest?.counts) {
      const liveCensus = _buildCensus(ws);
      for (const [rel, snapCount] of Object.entries(snapshotManifest.counts)) {
        const liveCount = liveCensus[rel] || 0;
        if (liveCount < snapCount && restored === 0) {
          // restored === 0 means files existed live but something else is off
          console.warn(`[sacred-data] count mismatch for ${rel}: live=${liveCount} snapshot=${snapCount}`);
        }
      }
    }

    return { restored, census };
  } catch (e) {
    console.error('[sacred-data] healSacredOnBoot FAILED (non-blocking):', e?.message);
    return { restored: 0, census: {} };
  }
}

// ── Layer 3: manual recovery helpers ─────────────────────────────────────────

/**
 * listSnapshots() → array of { dir, ts, reason, counts }
 * Reads manifest.json from each snapshot dir.
 */
function listSnapshots() {
  const dirs = _listSnapshotDirs();
  const result = [];
  for (const d of dirs) {
    const absDir = path.join(SACRED_BACKUP_ROOT, d);
    try {
      const manifestPath = path.join(absDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        result.push({ dir: absDir, ts: m.ts, reason: m.reason, counts: m.counts });
      } else {
        result.push({ dir: absDir, ts: null, reason: null, counts: {} });
      }
    } catch (e) {
      console.warn('[sacred-data] listSnapshots: could not read manifest for', d, e?.message);
    }
  }
  return result;
}

/**
 * restoreFrom(snapshotDir, { overwrite = false }) — manual recovery.
 * Union-restore by default (overwrite=false). Set overwrite=true to force-overwrite all.
 * @param {string} snapshotDir - absolute path to a snapshot directory
 * @param {{ overwrite?: boolean }} opts
 * @returns {{ restored: number, skipped: number }}
 */
function restoreFrom(snapshotDir, { overwrite = false } = {}) {
  const ws = _getWorkspace();
  if (!ws) {
    console.error('[sacred-data] restoreFrom: workspace null — aborted');
    return { restored: 0, skipped: 0 };
  }

  let restored = 0;
  let skipped = 0;

  // Gather all files from the snapshot directory that are sacred
  const allFiles = [];
  for (const rel of SACRED_DIRS) {
    const snapSrc = path.join(snapshotDir, rel);
    if (!fs.existsSync(snapSrc)) continue;
    allFiles.push(..._listFilesRelative(snapSrc, snapshotDir));
  }
  for (const rel of SACRED_FILES) {
    if (fs.existsSync(path.join(snapshotDir, rel))) allFiles.push(rel);
  }

  for (const relFile of allFiles) {
    const liveFile = path.join(ws, relFile);
    const snapFile = path.join(snapshotDir, relFile);

    if (fs.existsSync(liveFile) && !overwrite) {
      skipped++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      // SACRED-OK: manual restore — intentional write back to sacred path
      fs.copyFileSync(snapFile, liveFile); // SACRED-OK
      restored++;
    } catch (e) {
      console.error('[sacred-data] restoreFrom copy failed:', relFile, e?.message);
    }
  }

  console.log(`[sacred-data] restoreFrom ${snapshotDir}: restored=${restored} skipped=${skipped}`);
  return { restored, skipped };
}

// ── Layer 4: audit helper ────────────────────────────────────────────────────

/**
 * appendSacredAudit(entry) — append to <workspace>/logs/sacred-writes.jsonl
 * Each line: { ts: ISO-string, ...entry }
 * Silent on failure — audit must not block the caller.
 */
function appendSacredAudit(entry) {
  try {
    const ws = _getWorkspace();
    if (!ws) return;
    const logsDir = path.join(ws, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(logsDir, 'sacred-writes.jsonl'), line, 'utf-8');
  } catch (e) {
    console.error('[sacred-data] appendSacredAudit failed:', e?.message);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Layer 1
  SACRED_DIRS,
  SACRED_FILES,
  SACRED_SEGMENTS,
  isSacredPath,
  // Layer 2
  snapshotSacred,
  // Layer 3+4
  healSacredOnBoot,
  listSnapshots,
  restoreFrom,
  appendSacredAudit,
  // Factory-reset heal suppression (one-shot)
  markHealSuppressed,
  // Testable internals (underscore = private, exposed for testing only)
  _snapshotTo,
  _healInto,
  _consumeSuppressSentinel,
  SACRED_BACKUP_ROOT,
  SUPPRESS_HEAL_FILE,
};
