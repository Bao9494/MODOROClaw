'use strict';
// Append-only raw ground-truth archive of Zalo DMs, account-namespaced + durable.
//
// WHY a separate store (not openzca's messages.sqlite): that DB is per-openzca-
// profile, mutable, and may be reset/replaced on account re-login → not durable
// across an account switch. This is our OWN append-only mirror, keyed by the
// owner account, in <userData>/zalo-history so it survives account switches and
// is protected by SACRED_DIRS.
//
// Layout: <userData>/zalo-history/<ownerAccountId>/<customerId>.jsonl
//   - ownerAccountId = self_profiles.user_id at capture time (a new account = a
//     new subfolder → per-account separation; old account's folder untouched).
//   - customerId = scope_thread_id (peer/customer thread id).
//   - one raw message per line, append-only, never rewritten; dedup by msgId.
//
// Anti-features: no pre-capture backfill (Zalo has no DM history API), no
// cross-account merge (always separate), not encrypted (local workspace data).

const fs = require('fs');
const path = require('path');

// Strict id allowlist — mirrors the inbound.ts path-traversal guard. Anything
// else (e.g. '../evil', empty, >64 chars) is rejected so a hostile id can never
// escape the zalo-history root.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Dedup only needs to catch RETRIES (msgs re-appended because the poller's cursor
// didn't advance), which are always the most recent lines. So we scan just the tail
// instead of the whole file — keeping append O(tail) not O(n) as the archive grows
// unbounded. A long-ago msgId can't reappear (the poller cursor is forward-only).
const DEDUP_TAIL_BYTES = 256 * 1024;

function _isSafeId(id) {
  return ID_RE.test(String(id == null ? '' : id));
}

// Resolve the archive root <ws>/zalo-history. wsOverride lets tests pass a temp
// dir; otherwise read userData via getWorkspace().
function archiveRoot(ws) {
  const base = ws || (function () {
    try { return require('./workspace').getWorkspace(); } catch { return null; }
  })();
  if (!base) return null;
  return path.join(base, 'zalo-history');
}

// <ws>/zalo-history/<account>/<customer>.jsonl, or null if any id is unsafe / no ws.
function _fileFor(ws, account, customerId) {
  if (!_isSafeId(account) || !_isSafeId(customerId)) return null;
  const root = archiveRoot(ws);
  if (!root) return null;
  return path.join(root, account, customerId + '.jsonl');
}

// Map a raw openzca message row to the archive line shape. dir is 'out' when the
// sender is the owner account, else 'in'.
function _toLine(row, ownerAccountId) {
  const senderId = String(row.sender_id == null ? '' : row.sender_id);
  return {
    msgId: String(row.msg_id == null ? '' : row.msg_id),
    ts: Number(row.timestamp_ms) || 0,
    senderId,
    senderName: String(row.sender_name == null ? '' : row.sender_name),
    dir: senderId === String(ownerAccountId) ? 'out' : 'in',
    msgType: String(row.msg_type == null ? '' : row.msg_type),
    text: String(row.content_text == null ? '' : row.content_text),
  };
}

// Read the existing msgIds already stored in a jsonl file (for dedup). Returns a
// Set; empty Set if the file is missing/unreadable.
function _existingMsgIds(file) {
  const seen = new Set();
  let raw;
  try {
    const size = fs.statSync(file).size;
    if (size > DEDUP_TAIL_BYTES) {
      // Read only the last DEDUP_TAIL_BYTES; drop the first (possibly partial) line.
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(DEDUP_TAIL_BYTES);
        const n = fs.readSync(fd, buf, 0, DEDUP_TAIL_BYTES, size - DEDUP_TAIL_BYTES);
        raw = buf.toString('utf-8', 0, n);
      } finally { fs.closeSync(fd); }
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(file, 'utf-8');
    }
  } catch { return seen; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.msgId != null) seen.add(String(o.msgId));
    } catch {}
  }
  return seen;
}

// Append new messages (deduped by msgId) to <account>/<customer>.jsonl.
// Append-only: existing lines are never rewritten. Never throws (catch + log).
function appendMessages(ws, ownerAccountId, customerId, rows) {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const file = _fileFor(ws, ownerAccountId, customerId);
    if (!file) return; // unsafe id or no workspace — skip silently (path-safety)

    fs.mkdirSync(path.dirname(file), { recursive: true });

    const seen = _existingMsgIds(file);
    const out = [];
    for (const row of rows) {
      const msgId = String(row && row.msg_id != null ? row.msg_id : '');
      if (!msgId || seen.has(msgId)) continue; // skip empties + dupes
      seen.add(msgId);
      out.push(JSON.stringify(_toLine(row, ownerAccountId)));
    }
    if (out.length === 0) return;
    fs.appendFileSync(file, out.join('\n') + '\n', 'utf-8'); // SACRED-OK: append-only ground-truth archive
  } catch (e) {
    console.error('[zalo-history] appendMessages failed (non-blocking):', e && e.message);
  }
}

// Read the most recent `limit` messages for a customer under `account`
// (newest-last). Returns [] on any error / missing file / unsafe id.
function readHistory(ws, customerId, { account, limit = 200 } = {}) {
  try {
    const file = _fileFor(ws, account, customerId);
    if (!file) return [];
    let raw;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    const msgs = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { msgs.push(JSON.parse(line)); } catch {}
    }
    const n = Number(limit) > 0 ? Number(limit) : msgs.length;
    return msgs.slice(-n); // newest-last (file is append-order = chronological)
  } catch (e) {
    console.error('[zalo-history] readHistory failed:', e && e.message);
    return [];
  }
}

// Owner-account subfolder names present under zalo-history.
function listAccounts(ws) {
  try {
    const root = archiveRoot(ws);
    if (!root) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && _isSafeId(e.name))
      .map(e => e.name);
  } catch { return []; }
}

// Customer file basenames (without .jsonl) under a given account.
function listCustomers(ws, account) {
  try {
    if (!_isSafeId(account)) return [];
    const root = archiveRoot(ws);
    if (!root) return [];
    return fs.readdirSync(path.join(root, account), { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => e.name.slice(0, -'.jsonl'.length));
  } catch { return []; }
}

module.exports = {
  appendMessages, readHistory, listAccounts, listCustomers, archiveRoot,
  // pure helpers exported for tests / runtime harness
  _isSafeId, _toLine, _fileFor, _existingMsgIds, ID_RE,
};
