'use strict';

// Phase-0 tunnel RUNNER for the Facebook Messenger webhook. This is the only
// component that exposes a local port to the public internet, so it stays tiny
// and every external dependency (9Router client, child spawn, binary resolver)
// is injectable for tests and for the Phase-0 proof harness.
//
// WHY an owned cloudflared child instead of 9Router's tunnel: verified against
// 9Router v0.5.4 source — `POST /api/tunnel/enable` sends no body and always
// tunnels 9Router's own port 20128 (internal `ad(a=20128)` is never handed a
// custom port over HTTP). We must tunnel the Messenger port (20210), so the
// capability probe is expected to fall back to the owned spawner. The spawn
// command + stderr URL parsing mirror the verified 9Router behavior.
//
// ANTI-FEATURES (Slice 1): no auto-restart loop, no network-change recovery,
// no multi-backend abstraction, no health dashboard. Just start → publicUrl,
// and stop.

const os = require('os');
const path = require('path');

const WEBHOOK_PATH = '/api/fb/messenger/webhook';
const MESSENGER_PORT = 20210;
const DEFAULT_READY_TIMEOUT_MS = 30000;

// cloudflared prints the quick-tunnel URL on stderr. 9Router's parser skips the
// `api.trycloudflare.com` housekeeping subdomain and keeps the LAST real match.
const TUNNEL_URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi;

function buildCallbackUrl(publicUrl) {
  return String(publicUrl).replace(/\/+$/, '') + WEBHOOK_PATH;
}

function parseTunnelUrl(text) {
  const matches = String(text).matchAll(TUNNEL_URL_RE);
  let last = null;
  for (const m of matches) {
    if (m[1] !== 'api') last = `https://${m[1]}.trycloudflare.com`;
  }
  return last;
}

// Strip anything that looks like a bearer/page/app token or our verify token so
// tunnel stdout/stderr can never leak a secret into logs or error surfaces.
function redactTunnelOutput(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\bEAA[A-Za-z0-9]+/g, '[redacted-fb-token]')
    .replace(/\b9bizclaw_[a-f0-9]{16,}\b/gi, '[redacted-verify-token]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[redacted-hex]');
}

// Resolve the cloudflared binary 9Router already downloaded, so we don't fetch a
// second copy. Mirrors 9Router's data-dir layout: <dataRoot>/bin/cloudflared(.exe).
function defaultResolveCloudflared() {
  const isWin = process.platform === 'win32';
  const dataRoot = isWin
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '9router')
    : path.join(os.homedir(), '.9router');
  return path.join(dataRoot, 'bin', isWin ? 'cloudflared.exe' : 'cloudflared');
}

// Start a public tunnel for `localPort`. Returns { backend, publicUrl, stop }.
// Deps are injected; in production main.js passes the real 9Router client +
// child_process.spawn.
async function start(localPort = MESSENGER_PORT, deps = {}) {
  const {
    nineRouter = null,
    spawn = require('child_process').spawn,
    resolveCloudflared = defaultResolveCloudflared,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = deps;

  // Capability probe: only reuse 9Router's tunnel if it can target our port.
  // (Verified false for v0.5.4's HTTP API — kept as a probe so a future 9Router
  // that accepts a port "just works" without a code change here.)
  if (nineRouter && nineRouter.supportsCustomPort) {
    const res = await nineRouter.enable(localPort);
    const publicUrl = res && res.publicUrl;
    if (!isHttpsUrl(publicUrl)) {
      throw new Error('9Router tunnel did not return an https public url');
    }
    return {
      backend: '9router',
      publicUrl,
      stop: async () => { try { await nineRouter.disable(); } catch {} },
    };
  }

  return startOwnedCloudflared(localPort, { spawn, resolveCloudflared, readyTimeoutMs });
}

function startOwnedCloudflared(localPort, { spawn, resolveCloudflared, readyTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const bin = resolveCloudflared();
    const args = [
      'tunnel',
      '--url', `http://127.0.0.1:${localPort}`,
      '--no-autoupdate',
      '--retries', '99',
    ];
    const child = spawn(bin, args);

    let settled = false;
    const timer = setTimeout(() => finish(new Error('tunnel ready timeout — no trycloudflare url on stderr')), readyTimeoutMs);

    function finish(err, handle) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { try { child.kill(); } catch {} return reject(err); }
      resolve(handle);
    }

    const onChunk = (buf) => {
      const url = parseTunnelUrl(buf.toString());
      if (url) {
        finish(null, {
          backend: 'cloudflared',
          publicUrl: url,
          stop: async () => { try { child.kill(); } catch {} },
        });
      }
    };
    if (child.stderr) child.stderr.on('data', onChunk);
    if (child.stdout) child.stdout.on('data', onChunk);
    child.on('error', (e) => finish(new Error('cloudflared spawn failed: ' + redactTunnelOutput(e.message))));
    child.on('exit', (code) => finish(new Error(`cloudflared exited (code=${code}) before a tunnel url was ready`)));
  });
}

function isHttpsUrl(u) {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

module.exports = {
  WEBHOOK_PATH,
  MESSENGER_PORT,
  buildCallbackUrl,
  parseTunnelUrl,
  redactTunnelOutput,
  start,
  _test: { defaultResolveCloudflared, isHttpsUrl },
};
