'use strict';
// url-guard.js — SSRF guards for AI-generated media download URLs.
//
// Shared by higgsfield.js (dormant) and aivideoauto.js. Extracted here so both
// engines use the same battle-tested gate rather than duplicating it.
//
// ANTI-FEATURES (deliberately out of scope):
//   - No allowlist of specific CDN domains — we block the SSRF risk (private/
//     loopback targets) and allow all public HTTPS. CDN domains vary per provider
//     and change over time; a blanket private-IP block is the correct lever.
//   - No HTTPS→HTTP downgrade: the protocol check is HTTPS-only.

const fs = require('fs');

// test injection seam (mirrors higgsfield.js's pattern)
let _fetch = null;
function setFetchForTest(fn) { _fetch = fn; }

// ---------------------------------------------------------------------------
// Private-address helpers (sync)
// ---------------------------------------------------------------------------

function _isPrivateV4(host) {
  if (require('net').isIP(host) !== 4) return false;
  const p = host.split('.').map(Number);
  const a = p[0], b = p[1];
  return a === 0 || a === 127 || a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||           // link-local
    (a === 100 && b >= 64 && b <= 127);   // CGNAT
}

function _isPrivateV6(addr) {
  const h = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;                 // loopback / unspecified
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  const m = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped (::ffff:127.0.0.1)
  if (m) return _isPrivateV4(m[1]);
  return false; // public IPv6
}

// ---------------------------------------------------------------------------
// SSRF host gate — sync (literal hosts only)
// ---------------------------------------------------------------------------

// Returns true only for HTTPS URLs with a public, non-private hostname.
// Block ALL IPv6 literals (incl IPv4-mapped ::ffff:127.0.0.1, which would
// otherwise slip past a prefix check and reach loopback/metadata). AI media CDN
// domains are never raw IPv6 literals — a blanket IPv6-literal block is safe.
function isAllowedResultUrl(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // strip IPv6 brackets
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':') || require('net').isIP(host) === 6) return false;
  if (_isPrivateV4(host)) return false;   // private/loopback/link-local IPv4 literal
  return true;                            // public https domain or public IPv4
}

// ---------------------------------------------------------------------------
// DNS-rebinding guard — async
// ---------------------------------------------------------------------------

// Reject a DOMAIN that resolves to any private/loopback IP. Fail-OPEN on
// resolution error (broken DNS fails the fetch anyway — don't block a legit
// download on a DNS hiccup). net.fetch re-resolves at connect time, so this
// raises the bar rather than fully closing TOCTOU — proportionate.
async function hostResolvesPrivate(host) {
  if (require('net').isIP(host)) return false; // literal already gated synchronously
  let addrs;
  try { addrs = await require('dns').promises.lookup(host, { all: true }); }
  catch { return false; }
  return addrs.some(a => (a.family === 6 ? _isPrivateV6(a.address) : _isPrivateV4(a.address)));
}

// ---------------------------------------------------------------------------
// Extension helper
// ---------------------------------------------------------------------------

function extFor(url, type) {
  const m = String(url).match(/\.(png|jpg|jpeg|webp|mp4|mov|webm|mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/i);
  if (m) return '.' + m[1].toLowerCase();
  // Fallback by kind when the URL has no recognizable extension (CDN path + query).
  // audio/music must NOT fall through to '.png' — a music/TTS file saved as .png is unplayable.
  if (type === 'video') return '.mp4';
  if (type === 'audio' || type === 'music') return '.mp3';
  return '.png';
}

// ---------------------------------------------------------------------------
// SSRF-safe download
// ---------------------------------------------------------------------------

// Download helper: Electron net.fetch when available (proxy/AV-aware — undici
// `fetch` ignores the OS proxy/keychain), else global fetch under plain node
// (tests). Redirects are followed MANUALLY, re-checking the allowlist on EVERY
// hop — net.fetch would otherwise auto-follow a 3xx to an off-allowlist host
// (SSRF / arbitrary byte source).
async function download(url, destPath) {
  let fetchImpl = _fetch;
  if (!fetchImpl) {
    try { const { net } = require('electron'); if (net && net.fetch) fetchImpl = net.fetch.bind(net); } catch {}
    if (!fetchImpl && typeof fetch !== 'undefined') fetchImpl = fetch;
  }
  if (!fetchImpl) throw new Error('no fetch implementation available');
  let cur = url, res;
  for (let hop = 0; hop < 4; hop++) {
    if (!isAllowedResultUrl(cur)) throw new Error('result URL ngoài danh sách cho phép');
    if (await hostResolvesPrivate(new URL(cur).hostname.replace(/^\[|\]$/g, ''))) throw new Error('result URL trỏ vào địa chỉ nội bộ (chặn SSRF)');
    try { res = await fetchImpl(cur, { redirect: 'manual' }); }
    catch (e) { throw new Error('tải kết quả thất bại: ' + (e.message || e) + (e.cause ? ` (${e.cause.code || e.cause.message})` : '')); }
    if (res.status >= 300 && res.status < 400 && res.headers && res.headers.get) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect thiếu Location');
      cur = new URL(loc, cur).toString();
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error('tải kết quả thất bại: HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { isAllowedResultUrl, hostResolvesPrivate, extFor, download };

if (process.env.NODE_ENV !== 'production') {
  module.exports._test = { setFetchForTest };
}
