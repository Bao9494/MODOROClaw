// vendor-patches.js — all vendor source-code patches in one place.
// Shared by: main.js (runtime, defense-in-depth) and prebuild-vendor.js (build-time).
// Every function is idempotent via markers — safe to call from both.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Uses homeDir param (not getWorkspace()) because this file is shared with prebuild-vendor.js
// where workspace module is not available at build time.
function _logPatchFailure(homeDir, functionName, detail) {
  try {
    const auditDir = path.join(homeDir, '.openclaw', 'logs');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'patch-failures.log'),
      `${new Date().toISOString()} ${functionName}: ${detail}\n`
    );
  } catch {}
}

function _getOpenclawDistDir(vendorDir) {
  if (!vendorDir) return null;
  const d = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  return fs.existsSync(d) ? d : null;
}

// Generic: inject `return true;` at the top of a named function in matching files.
function _patchFunctionReturnTrue(distDir, homeDir, { filePrefix, funcSig, marker, logTag }) {
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith(filePrefix) && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (src.includes(marker)) continue;
    if (!src.includes(funcSig)) {
      console.warn(`[${logTag}] WARNING: ${file} exists but FUNC_SIG missing — upstream refactor detected`);
      _logPatchFailure(homeDir, logTag, `FUNC_SIG missing in ${file}`);
      continue;
    }
    const injected = `${funcSig}\n\treturn true; // ${marker}`;
    const patched = src.replace(funcSig, injected);
    if (patched !== src) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[${logTag}] applied to ${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Vision patches (layers 1-4): force vision ON for all models via 9Router
// ---------------------------------------------------------------------------

function ensureVisionFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;
    const MARKER_V1 = '// MODOROClaw VISION PATCH — default vision ON for unknown models (9Router proxy)';
    const MARKER_V2 = '// 9BizClaw VISION PATCH V2 — unconditional vision ON';
    const FUNC_SIG = 'async function resolveGatewayModelSupportsImages(params) {';
    const files = fs.readdirSync(distDir).filter(f => f.startsWith('session-utils-') && f.endsWith('.js'));
    for (const file of files) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(MARKER_V2)) continue;
      if (!src.includes(FUNC_SIG)) {
        console.warn(`[vision-fix] WARNING: ${file} exists but FUNC_SIG missing`);
        _logPatchFailure(homeDir, 'ensureVisionFix', `FUNC_SIG missing in ${file}`);
        continue;
      }
      if (src.includes(MARKER_V1)) {
        src = src.split('\n').filter(l => !l.includes(MARKER_V1)).join('\n');
      }
      const injected = `${FUNC_SIG}\n\treturn true; ${MARKER_V2}`;
      const patched = src.replace(FUNC_SIG, injected);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[vision-fix] V2 applied to', file);
      }
    }
  } catch (e) {
    console.warn('[vision-fix] non-fatal:', e?.message);
  }
}

function ensureVisionCatalogFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    _patchFunctionReturnTrue(distDir, homeDir, {
      filePrefix: 'model-catalog-',
      funcSig: 'function modelSupportsVision(entry) {',
      marker: '9BizClaw VISION-CATALOG PATCH — unconditional modelSupportsVision',
      logTag: 'vision-catalog-fix',
    });
  } catch (e) {
    console.warn('[vision-catalog-fix] non-fatal:', e?.message);
  }
}

function ensureVisionSerializationFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;
    const targets = [
      {
        prefix: 'model-context-tokens-',
        funcSig: 'function supportsImageInput(modelOverride) {',
        marker: '9BizClaw VISION-SERIALIZE PATCH — supportsImageInput always-true',
      },
      {
        prefix: 'stream-',
        funcSig: 'function supportsExplicitImageInput(model) {',
        marker: '9BizClaw VISION-STREAM PATCH — supportsExplicitImageInput always-true',
      },
    ];
    const allFiles = fs.readdirSync(distDir);
    for (const target of targets) {
      const candidates = allFiles.filter(f => f.startsWith(target.prefix) && f.endsWith('.js'));
      let patched = false;
      for (const file of candidates) {
        const fp = path.join(distDir, file);
        let src = fs.readFileSync(fp, 'utf-8');
        if (src.includes(target.marker)) { patched = true; continue; }
        if (!src.includes(target.funcSig)) continue;
        const injected = `${target.funcSig}\n\treturn true; // ${target.marker}`;
        const out = src.replace(target.funcSig, injected);
        if (out !== src) {
          fs.writeFileSync(fp, out, 'utf-8');
          console.log('[vision-serialize-fix] applied to', file);
          patched = true;
        }
      }
      if (!patched) {
        console.warn(`[vision-serialize-fix] WARNING: FUNC_SIG "${target.funcSig}" not found`);
        _logPatchFailure(homeDir, 'ensureVisionSerializationFix', `FUNC_SIG "${target.funcSig}" missing`);
      }
    }
  } catch (e) {
    console.warn('[vision-serialize-fix] non-fatal:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// SSRF localhost bypass: allow web_fetch to 127.0.0.1 for cron API
// ---------------------------------------------------------------------------

function ensureWebFetchLocalhostFix(vendorDir, homeDir) {
  try {
    const distDir = _getOpenclawDistDir(vendorDir);
    if (!distDir) return;

    // Part 1: SSRF allow 127.0.0.1
    const files = fs.readdirSync(distDir).filter(f => f.startsWith('ssrf-') && f.endsWith('.js') && !f.includes('policy') && !f.includes('runtime'));
    const MARKER = '// 9BizClaw SSRF LOCALHOST PATCH — allow 127.0.0.1 for cron API';
    const FUNC_SIG = 'function isBlockedHostnameOrIp(hostname, policy) {';
    for (const file of files) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(MARKER)) continue;
      if (!src.includes(FUNC_SIG)) {
        console.warn(`[ssrf-localhost-fix] WARNING: ${file} anchor missing`);
        _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix', `FUNC_SIG missing in ${file}`);
        continue;
      }
      const injected = `${FUNC_SIG}\n\tconst _n = normalizeHostname(hostname); if (_n === '127.0.0.1') return false; ${MARKER}`;
      const patched = src.replace(FUNC_SIG, injected);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[ssrf-localhost-fix] applied to', file);
      }
    }

    // Part 2: strip SECURITY NOTICE wrapper from localhost web_fetch responses
    const toolFiles = fs.readdirSync(distDir).filter(f => f.startsWith('openclaw-tools-') && f.endsWith('.js'));
    const NOWRAP_MARKER = '// 9BizClaw LOCALHOST NOWRAP PATCH';
    const NOWRAP_FUNC = 'function normalizeProviderWebFetchPayload(params) {';
    const NOWRAP_INJECT = `function normalizeProviderWebFetchPayload(params) {\n\tif (params.requestedUrl && /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](\\\/|$)/.test(params.requestedUrl)) { const _lp = isRecord(params.payload) ? params.payload : {}; const _lt = typeof _lp.text === 'string' ? _lp.text : ''; const _ls = typeof _lp.status === 'number' ? Math.floor(_lp.status) : 200; return { url: params.requestedUrl, finalUrl: params.requestedUrl, status: _ls, extractMode: params.extractMode, extractor: params.providerId, externalContent: { untrusted: false, source: 'web_fetch', wrapped: false }, truncated: false, length: _lt.length, rawLength: _lt.length, wrappedLength: _lt.length, fetchedAt: new Date().toISOString(), tookMs: typeof _lp.tookMs === 'number' ? Math.max(0, Math.floor(_lp.tookMs)) : 0, text: _lt }; } ${NOWRAP_MARKER}`;
    for (const file of toolFiles) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      if (src.includes(NOWRAP_MARKER)) continue;
      if (!src.includes(NOWRAP_FUNC)) {
        console.warn(`[ssrf-nowrap-fix] WARNING: ${file} anchor missing`);
        _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix-nowrap', `anchor missing in ${file}`);
        continue;
      }
      const patched = src.replace(NOWRAP_FUNC, NOWRAP_INJECT);
      if (patched !== src) {
        fs.writeFileSync(fp, patched, 'utf-8');
        console.log('[ssrf-nowrap-fix] applied to', file);
      }
    }

    // Part 3: auth localhost Cron API automatically for CEO Telegram sessions.
    //
    // We deliberately do NOT put the live token into AGENTS.md or model-visible
    // tool output. The OpenClaw web_fetch runtime already knows the current
    // agentChannel; only Telegram direct CEO sessions receive a bearer header.
    // Zalo/customer sessions still hit the Cron API without auth and get 403.
    const TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH v4';
    const LEGACY_TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH';
    const LEGACY_V2_TOKEN_MARKER = '// 9BizClaw WEB_FETCH CRON TOKEN PATCH v2';
    const CACHE_MARKER = '// 9BizClaw WEB_FETCH LOCAL API CACHE BYPASS';
    const RUN_FUNC = 'async function runWebFetch(params) {';
    const HEADER_BLOCK = `init: { headers: {\n\t\t\t\tAccept: "text/markdown, text/html;q=0.9, */*;q=0.1",\n\t\t\t\t"User-Agent": params.userAgent,\n\t\t\t\t"Accept-Language": "en-US,en;q=0.9"\n\t\t\t} }`;
    const HEADER_HELPER = `async function maybeBuild9BizClawWebFetchHeaders(params) {\n\tconst headers = { Accept: "text/markdown, text/html;q=0.9, */*;q=0.1", "User-Agent": params.userAgent, "Accept-Language": "en-US,en;q=0.9" };\n\ttry {\n\t\tconst agentChannel = String(params.agentChannel || "").trim().toLowerCase();\n\t\tconst sessionKey = String(params.agentSessionKey || "").trim();\n\t\tconst chatId = String(params.telegramChatId || params.originChatId || params.replyChatId || params.chatId || "").trim();\n\t\tconst chatType = String(params.telegramChatType || params.originChatType || "").trim();\n\t\tconst isTelegram = agentChannel === "telegram";\n\t\tif (isTelegram && /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || ""))) {\n\t\t\tconst candidates = [path.join(process.cwd(), "cron-api-token.txt")];\n\t\t\tif (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "9bizclaw", "cron-api-token.txt"));\n\t\t\tfor (const tokenPath of candidates) {\n\t\t\t\ttry {\n\t\t\t\t\tconst token = String(await fs.readFile(tokenPath, "utf8")).trim();\n\t\t\t\t\tif (/^[a-f0-9]{48}$/i.test(token)) { headers.Authorization = "Bearer " + token; headers["X-9BizClaw-Agent-Channel"] = "telegram"; headers["X-Source-Channel"] = "telegram"; if (sessionKey) headers["X-9BizClaw-Agent-Session-Key"] = sessionKey; if (/^-?\\d{5,32}$/.test(chatId)) { headers["X-9BizClaw-Telegram-Chat-Id"] = chatId; headers["X-9BizClaw-Telegram-Origin-Chat-Id"] = chatId; headers["X-9BizClaw-Telegram-Reply-Chat-Id"] = chatId; } if (chatType) headers["X-9BizClaw-Telegram-Chat-Type"] = chatType; break; }\n\t\t\t\t} catch {}\n\t\t\t}\n\t\t}\n\t} catch {}\n\treturn headers;\n}\n${TOKEN_MARKER}\n`;
    const LEGACY_HELPER_RE = /async function maybeBuild9BizClawWebFetchHeaders\(params\) \{[\s\S]*?\/\/ 9BizClaw WEB_FETCH CRON TOKEN PATCH\n/;
    for (const file of toolFiles) {
      const fp = path.join(distDir, file);
      let src = fs.readFileSync(fp, 'utf-8');
      let changed = false;
      if (!src.includes(TOKEN_MARKER)) {
        // Remove any legacy version (v1/v2/v3) before re-injecting v4.
        const LEGACY_V2_RE = /async function maybeBuild9BizClawWebFetchHeaders\(params\) \{[\s\S]*?\/\/ 9BizClaw WEB_FETCH CRON TOKEN PATCH v2\n/;
        const LEGACY_V3_RE = /async function maybeBuild9BizClawWebFetchHeaders\(params\) \{[\s\S]*?\/\/ 9BizClaw WEB_FETCH CRON TOKEN PATCH v3\n/;
        if (LEGACY_V3_RE.test(src)) {
          src = src.replace(LEGACY_V3_RE, '');
          console.log('[web-fetch-token-fix] removed legacy v3 helper');
        }
        if (LEGACY_V2_RE.test(src)) {
          src = src.replace(LEGACY_V2_RE, '');
          console.log('[web-fetch-token-fix] removed legacy v2 helper');
        }
        if (src.includes(LEGACY_TOKEN_MARKER) && LEGACY_HELPER_RE.test(src)) {
          src = src.replace(LEGACY_HELPER_RE, HEADER_HELPER);
          changed = true;
        } else if (!src.includes(RUN_FUNC)) {
          console.warn(`[web-fetch-token-fix] WARNING: ${file} runWebFetch anchor missing`);
          _logPatchFailure(homeDir, 'ensureWebFetchLocalhostFix-token-helper', `runWebFetch anchor missing in ${file}`);
        } else {
          src = src.replace(RUN_FUNC, HEADER_HELPER + RUN_FUNC);
          changed = true;
        }
      }
      if (src.includes(HEADER_BLOCK)) {
        src = src.replace(HEADER_BLOCK, 'init: { headers: await maybeBuild9BizClawWebFetchHeaders(params) }');
        changed = true;
      }
      // Part 3b: auto-convert localhost GET-with-params to POST-with-JSON-body.
      // web_fetch is GET-only (no method/body in schema). Vietnamese text in URL
      // query params gets mangled on Windows (codepage issue). POST with JSON body
      // is always UTF-8 safe.
      const POST_CONVERT_MARKER = '// 9BizClaw LOCALHOST AUTO-POST';
      const POST_CONVERT_ANCHOR = 'init: { headers: await maybeBuild9BizClawWebFetchHeaders(params) }';
      if (!src.includes(POST_CONVERT_MARKER) && src.includes(POST_CONVERT_ANCHOR)) {
        const POST_CONVERT_CODE = `(() => { const _h = maybeBuild9BizClawWebFetchHeaders(params); const _lre = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3]\\//; if (_lre.test(String(params.url || ""))) { const _u = new URL(params.url); if (typeof params.body === "string" && params.body.trim()) { return _h.then(h => ({ headers: { ...h, "Content-Type": "application/json; charset=utf-8" }, method: String(params.method || "POST").toUpperCase(), body: params.body })); } if (_u.search.length > 1) { const _b = {}; for (const [k,v] of _u.searchParams) _b[k] = v; _u.search = ""; params.url = _u.toString(); return _h.then(h => ({ headers: { ...h, "Content-Type": "application/json; charset=utf-8" }, method: "POST", body: JSON.stringify(_b) })); } return _h.then(h => ({ headers: h })); } return _h.then(h => ({ headers: h })); })() ${POST_CONVERT_MARKER}`;
        src = src.replace(POST_CONVERT_ANCHOR, 'init: await ' + POST_CONVERT_CODE);
        changed = true;
        console.log('[web-fetch-token-fix] added localhost auto-POST conversion');
      }
      const WEBFETCH_CACHE_BLOCK = 'const cacheKey = normalizeCacheKey(`fetch:${params.url}:${params.extractMode}:${params.maxChars}${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}`);\n\tconst cached = readCache(FETCH_CACHE, cacheKey);';
      if (!src.includes(CACHE_MARKER) && src.includes(WEBFETCH_CACHE_BLOCK)) {
        src = src.replace(WEBFETCH_CACHE_BLOCK, `${CACHE_MARKER}\n\tconst skip9BizClawLocalApiCache = /^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || ""));\n\tconst cacheKey = normalizeCacheKey(\`fetch:\${params.url}:\${params.extractMode}:\${params.maxChars}\${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}\`);\n\tconst cached = skip9BizClawLocalApiCache ? null : readCache(FETCH_CACHE, cacheKey);`);
        changed = true;
      }
      const WEBFETCH_WRITE_CACHE_LINE = '\t\twriteCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);';
      if (src.includes(CACHE_MARKER) && src.includes(WEBFETCH_WRITE_CACHE_LINE)) {
        src = src.replace(WEBFETCH_WRITE_CACHE_LINE, '\t\tif (!skip9BizClawLocalApiCache) writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);');
        changed = true;
      }
      // Part 3d: compact successful localhost web_fetch results too. The earlier
      // nowrap patch only covered provider fallback responses; direct successful
      // JSON responses still included SECURITY NOTICE wrappers and echoed huge
      // prompt URLs in finalUrl, which can overflow long AUTO-MODE tool loops.
      const DIRECT_COMPACT_MARKER = '// 9BizClaw LOCALHOST DIRECT COMPACT';
      const DIRECT_COMPACT_ANCHOR = 'const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);\n\t\tconst payload = {';
      if (!src.includes(DIRECT_COMPACT_MARKER) && src.includes(DIRECT_COMPACT_ANCHOR)) {
        const DIRECT_COMPACT_CODE = `const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);\n\t\tif (/^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):2020[0-3](?:\\/|$)/.test(String(params.url || finalUrl || ""))) { const _lw = wrapWebFetchContent(text, params.maxChars); const _scrub = (_url) => { try { const _u = new URL(String(_url || params.url || "")); if (/^(?:127\\.0\\.0\\.1|localhost)$/i.test(_u.hostname) && _u.pathname.startsWith("/api/")) { _u.search = ""; return _u.toString(); } } catch {} return String(_url || params.url || ""); }; return { url: _scrub(params.url), finalUrl: _scrub(finalUrl), status: res.status, contentType: normalizedContentType, title: wrappedTitle, extractMode: params.extractMode, extractor, externalContent: { untrusted: false, source: "web_fetch", wrapped: false }, truncated: _lw.truncated, length: _lw.wrappedLength, rawLength: _lw.rawLength, wrappedLength: _lw.wrappedLength, fetchedAt: new Date().toISOString(), tookMs: Date.now() - start, text: _lw.text, warning: wrappedWarning }; } ${DIRECT_COMPACT_MARKER}\n\t\tconst payload = {`;
        src = src.replace(DIRECT_COMPACT_ANCHOR, DIRECT_COMPACT_CODE);
        changed = true;
      }
      const WEBFETCH_OPTIONS_BLOCK = `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch\n\t});`;
      if (src.includes(WEBFETCH_OPTIONS_BLOCK)) {
        src = src.replace(WEBFETCH_OPTIONS_BLOCK, `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey,\n\t\tagentChannel: options?.agentChannel\n\t});`);
        changed = true;
      }
      const WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK = `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey\n\t});`;
      if (src.includes(WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK)) {
        src = src.replace(WEBFETCH_OPTIONS_SESSION_ONLY_BLOCK, `const webFetchTool = createWebFetchTool({\n\t\tconfig: options?.config,\n\t\tsandboxed: options?.sandboxed,\n\t\truntimeWebFetch: runtimeWebTools?.fetch,\n\t\tagentSessionKey: options?.agentSessionKey,\n\t\tagentChannel: options?.agentChannel\n\t});`);
        changed = true;
      }
      const WEBFETCH_RUN_PARAMS_BLOCK = `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback\n\t\t\t}));`;
      if (src.includes(WEBFETCH_RUN_PARAMS_BLOCK)) {
        src = src.replace(WEBFETCH_RUN_PARAMS_BLOCK, `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\t\tagentChannel: options?.agentChannel\n\t\t\t}));`);
        changed = true;
      }
      const WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK = `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey\n\t\t\t}));`;
      if (src.includes(WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK)) {
        src = src.replace(WEBFETCH_RUN_PARAMS_SESSION_ONLY_BLOCK, `lookupFn: options?.lookupFn,\n\t\t\t\tresolveProviderFallback,\n\t\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\t\tagentChannel: options?.agentChannel\n\t\t\t}));`);
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(fp, src, 'utf-8');
        console.log('[web-fetch-token-fix] applied to', file);
      }
    }
  } catch (e) {
    console.warn('[ssrf-localhost-fix] non-fatal:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// OpenRouter pricing fail-fast: rewrite URLs to unreachable local addr
// ---------------------------------------------------------------------------

function ensureOpenclawPricingFix(vendorDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    const urlPattern = /"https:\/\/openrouter\.ai\/api\/v1([^"]*)"/g;
    const markerStr = '// 9BIZCLAW_OPENROUTER_DISABLED';
    const allFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
    let patchedCount = 0, scannedCount = 0;

    for (const fname of allFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (!urlPattern.test(content)) continue;
      scannedCount++;
      urlPattern.lastIndex = 0;
      if (content.includes(markerStr)) continue;
      const patched = content.replace(urlPattern, '"http://127.0.0.1:1/disabled$1"') + `\n${markerStr}\n`;
      try {
        fs.writeFileSync(filePath, patched, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-pricing-fix] patched ${fname}`);
      } catch (e) {
        console.warn(`[openclaw-pricing-fix] write failed ${fname}: ${e.message}`);
      }
    }
    if (patchedCount > 0) console.log(`[openclaw-pricing-fix] ${patchedCount}/${scannedCount} file(s) patched`);
    else if (scannedCount > 0) console.log(`[openclaw-pricing-fix] already patched — skipping`);
  } catch (e) {
    console.warn('[openclaw-pricing-fix] error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// Prewarm disable: skip 4+ min model catalog fetch at boot
// ---------------------------------------------------------------------------

function ensureOpenclawPrewarmFix(vendorDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    const files = fs.readdirSync(distDir).filter(f => /^server\.impl-[A-Za-z0-9_-]+\.js$/.test(f));
    const markerStr = '9BIZCLAW_PREWARM_DISABLED';
    const funcSignature = 'async function prewarmConfiguredPrimaryModel(params) {';
    let patchedCount = 0;

    for (const fname of files) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (content.includes(markerStr)) continue;
      if (!content.includes(funcSignature)) continue;
      const patched = content.replace(
        funcSignature,
        funcSignature + '\n\treturn; // ' + markerStr + ' — avoid 4+min openrouter.ai model catalog fetch'
      );
      if (patched === content) continue;
      try {
        fs.writeFileSync(filePath, patched, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-prewarm-fix] patched ${fname}`);
      } catch (e) {
        console.warn(`[openclaw-prewarm-fix] write failed ${fname}: ${e.message}`);
      }
    }
    if (patchedCount > 0) console.log(`[openclaw-prewarm-fix] ${patchedCount} file(s) patched`);
  } catch (e) {
    console.warn('[openclaw-prewarm-fix] error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// OpenClaw self-update disable: hide upstream update UI and disable update.run
// ---------------------------------------------------------------------------

function ensureOpenclawUpdateUiDisabled(vendorDir, homeDir) {
  try {
    if (!vendorDir) return;
    const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
    if (!fs.existsSync(distDir)) return;

    let patchedCount = 0;

    const serverFiles = fs.readdirSync(distDir).filter(f => /^server\.impl-[A-Za-z0-9_-]+\.js$/.test(f));
    for (const fname of serverFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      let next = content;

      const updateCheckMarker = '9BIZCLAW_OPENCLAW_UPDATE_CHECK_DISABLED';
      if (!next.includes(updateCheckMarker)) {
        next = next.replace(
          'function getUpdateAvailable() {',
          'function getUpdateAvailable() {\n\treturn null; // ' + updateCheckMarker
        );
        next = next.replace(
          'function scheduleGatewayUpdateCheck(params) {',
          'function scheduleGatewayUpdateCheck(params) {\n\treturn () => {}; // ' + updateCheckMarker
        );
      }

      const updateRunMarker = '9BIZCLAW_OPENCLAW_UPDATE_RUN_DISABLED';
      if (!next.includes(updateRunMarker)) {
        next = next.replace(
          'const updateHandlers = { "update.run": async ({ params, respond, client, context }) => {',
          'const updateHandlers = { "update.run": async ({ params, respond, client, context }) => {\n\trespond(true, { ok: false, result: { status: "disabled", reason: "OpenClaw self-update is disabled in 9BizClaw." } }, void 0); return; // ' + updateRunMarker
        );
      }

      if (next !== content) {
        fs.writeFileSync(filePath, next, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-update-disable] patched server ${fname}`);
      } else if (!content.includes(updateCheckMarker) || !content.includes(updateRunMarker)) {
        _logPatchFailure(homeDir, 'ensureOpenclawUpdateUiDisabled', `server anchors missing in ${fname}`);
      }
    }

    const statusFiles = fs.readdirSync(distDir).filter(f => /^status\.update-[A-Za-z0-9_-]+\.js$/.test(f));
    for (const fname of statusFiles) {
      const filePath = path.join(distDir, fname);
      let content;
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
      const marker = '9BIZCLAW_OPENCLAW_UPDATE_CHECK_DISABLED';
      if (content.includes(marker)) continue;
      let next = content
        .replace(
          'function resolveUpdateAvailability(update) {',
          'function resolveUpdateAvailability(update) {\n\treturn { available: false, hasGitUpdate: false, hasRegistryUpdate: false, latestVersion: null, gitBehind: null }; // ' + marker
        )
        .replace(
          'function formatUpdateAvailableHint(update) {',
          'function formatUpdateAvailableHint(update) {\n\treturn null; // ' + marker
        );
      if (next !== content) {
        fs.writeFileSync(filePath, next, 'utf-8');
        patchedCount++;
        console.log(`[openclaw-update-disable] patched status ${fname}`);
      } else {
        _logPatchFailure(homeDir, 'ensureOpenclawUpdateUiDisabled', `status anchors missing in ${fname}`);
      }
    }

    const controlAssetsDir = path.join(distDir, 'control-ui', 'assets');
    if (fs.existsSync(controlAssetsDir)) {
      const uiFiles = fs.readdirSync(controlAssetsDir).filter(f => f.endsWith('.js'));
      for (const fname of uiFiles) {
        const filePath = path.join(controlAssetsDir, fname);
        let content;
        try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
        let next = content;
        const marker = '9BIZCLAW_OPENCLAW_UPDATE_UI_DISABLED';
        if (next.includes(marker)) continue;

        next = next.replace(
          'e.updateAvailable&&e.updateAvailable.latestVersion!==e.updateAvailable.currentVersion&&!GM(e.updateAvailable)?i`<div class="update-banner callout danger"',
          'false&&e.updateAvailable&&e.updateAvailable.latestVersion!==e.updateAvailable.currentVersion&&!GM(e.updateAvailable)?i`<div class="update-banner callout danger"'
        );
        next = next.replace(
          'async function Or(e){',
          'async function Or(e){return;/* 9BIZCLAW_OPENCLAW_UPDATE_RUN_DISABLED */'
        );
        next = next.replace(
          /<button class="btn btn--sm" \?disabled=\$\{!ne\} @click=\$\{e\.onUpdate\}>[\s\S]*?\$\{e\.updating\?`Updating…`:`Update`\}\s*<\/button>/,
          ''
        );
        next = next.replace('{key:`update`,label:`Updates`},', '');

        if (next !== content) {
          if (!next.includes(marker)) next += `\n/* ${marker} */\n`;
          fs.writeFileSync(filePath, next, 'utf-8');
          patchedCount++;
          console.log(`[openclaw-update-disable] patched ui ${fname}`);
        }
      }
    }

    if (patchedCount > 0) console.log(`[openclaw-update-disable] ${patchedCount} file(s) patched`);
  } catch (e) {
    console.warn('[openclaw-update-disable] error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// Openzca friend-event: auto-accept friend requests + cache refresh
// ---------------------------------------------------------------------------

function ensureOpenzcaFriendEventFix(vendorDir, workspaceDir) {
  try {
    if (!vendorDir) {
      console.log('[openzca-friend-event] no bundled vendor — skipping');
      return;
    }
    const cliPath = path.join(vendorDir, 'node_modules', 'openzca', 'dist', 'cli.js');
    if (!fs.existsSync(cliPath)) {
      console.warn('[openzca-friend-event] cli.js not found at', cliPath);
      return;
    }
    let content = fs.readFileSync(cliPath, 'utf-8');
    if (content.includes('9BIZCLAW FRIEND-EVENT PATCH')) {
      console.log('[openzca-friend-event] already patched');
      return;
    }

    const anchor = 'api.listener.on("message", async (message) => {';
    const anchorIdx = content.indexOf(anchor);
    if (anchorIdx === -1) {
      console.error('[openzca-friend-event] CRITICAL: anchor not found');
      try {
        const diagPath = path.join(workspaceDir || '.', 'logs', 'boot-diagnostic.txt');
        fs.mkdirSync(path.dirname(diagPath), { recursive: true });
        fs.appendFileSync(diagPath,
          `\n[${new Date().toISOString()}] [openzca-friend-event] anchor regex failed — openzca cli.js structure changed\n`,
          'utf-8');
      } catch {}
      return;
    }

    const injection = `// === 9BIZCLAW FRIEND-EVENT PATCH ===
        api.listener.on("friend_event", async (event) => {
          try {
            if (!event || typeof event.type !== "number") return;
            console.log("[friend_event] type=" + event.type + " threadId=" + (event.threadId || ""));
            if (event.type === 2) {
              const fromUid = event.data && event.data.fromUid;
              if (fromUid) {
                try {
                  await api.acceptFriendRequest(fromUid);
                  console.log("[friend_event] auto-accepted friend request from " + fromUid);
                } catch (acceptErr) {
                  console.error("[friend_event] auto-accept failed:", acceptErr && acceptErr.message ? acceptErr.message : String(acceptErr));
                }
              }
            }
            if (event.type === 0 || event.type === 2 || event.type === 7) {
              try {
                await refreshCacheForProfile(profile, api);
                console.log("[friend_event] cache refreshed for " + profile);
              } catch (refreshErr) {
                console.error("[friend_event] cache refresh failed:", refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr));
              }
            }
            if (event.type === 0) {
              try {
                const newFriendUid = event.data && (event.data.fromUid || event.threadId);
                if (newFriendUid) {
                  let friendName = "";
                  try {
                    const __welFs = require("fs");
                    const __welPath = require("path");
                    const __welOs = require("os");
                    const cachePath = __welPath.join(__welOs.homedir(), ".openzca", "profiles", "default", "cache", "friends.json");
                    if (__welFs.existsSync(cachePath)) {
                      const friends = JSON.parse(__welFs.readFileSync(cachePath, "utf-8"));
                      if (Array.isArray(friends)) {
                        const match = friends.find(f => String(f.userId || f.uid || f.id || "").trim() === String(newFriendUid).trim());
                        if (match) friendName = String(match.displayName || match.name || match.zaloName || "").trim();
                      }
                    }
                  } catch {}
                  let pronoun = "ban";
                  if (friendName) {
                    const lastName = friendName.split(/\\s+/).pop() || "";
                    const maleNames = ["huy","minh","duc","hung","dung","tuan","thanh","long","quan","khanh","bao","hai","son","tu","duy","dat","kien","cuong","hoang","tri","nam","phuc","vinh"];
                    const femaleNames = ["huong","linh","trang","lan","mai","nga","ngoc","thao","vy","uyen","yen","hang","dung","thu","ha","nhung","hanh","chau","anh","quynh","my","nhi"];
                    const lnLower = lastName.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
                    if (maleNames.includes(lnLower)) pronoun = "anh " + friendName;
                    else if (femaleNames.includes(lnLower)) pronoun = "chi " + friendName;
                    else pronoun = "anh/chi " + friendName;
                  }
                  let botIntro = "tr\\u1EE3 l\\u00FD AI c\\u1EE7a doanh nghi\\u1EC7p";
                  try {
                    const __welFs2 = require("fs");
                    const __welPath2 = require("path");
                    const ws = process.env['9BIZ_WORKSPACE'] || "";
                    if (ws) {
                      const companyPath = __welPath2.join(ws, "COMPANY.md");
                      if (__welFs2.existsSync(companyPath)) {
                        const companyContent = __welFs2.readFileSync(companyPath, "utf-8");
                        const nameMatch = companyContent.match(/Ten cong ty[^:]*:\\\\s*(.+)/i) || companyContent.match(/^#\\\\s+(.+)/m);
                        if (nameMatch) botIntro = "tr\\u1EE3 l\\u00FD AI c\\u1EE7a " + nameMatch[1].trim();
                      }
                    }
                  } catch {}
                  const welcomeMsg = "Ch\\u00E0o " + pronoun + "! C\\u1EA3m \\u01A1n " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "b\\u1EA1n") + " \\u0111\\u00E3 k\\u1EBFt b\\u1EA1n.\\\\n\\\\n"
                    + "M\\u00ECnh l\\u00E0 " + botIntro + ". M\\u00ECnh c\\u00F3 th\\u1EC3 h\\u1ED7 tr\\u1EE3 " + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0] : "b\\u1EA1n") + ":\\\\n\\\\n"
                    + "1. Xem s\\u1EA3n ph\\u1EA9m / d\\u1ECBch v\\u1EE5\\\\n"
                    + "2. T\\u00ECm hi\\u1EC3u gi\\u00E1 c\\u1EA3\\\\n"
                    + "3. \\u0110\\u1EB7t l\\u1ECBch h\\u1EB9n / t\\u01B0 v\\u1EA5n\\\\n"
                    + "4. H\\u1ECFi c\\u00E2u h\\u1ECFi kh\\u00E1c\\\\n\\\\n"
                    + (pronoun.startsWith("anh") || pronoun.startsWith("chi") ? pronoun.split(" ")[0].charAt(0).toUpperCase() + pronoun.split(" ")[0].slice(1) : "B\\u1EA1n") + " ch\\u1EC9 c\\u1EA7n tr\\u1EA3 l\\u1EDDi s\\u1ED1 (1-4) \\u0111\\u1EC3 m\\u00ECnh h\\u1ED7 tr\\u1EE3 ngay!";
                  await api.sendMessage({ body: welcomeMsg }, newFriendUid, 0);
                  console.log("[friend_event] welcome message sent to new friend " + newFriendUid + " (" + friendName + ")");
                }
              } catch (welcomeErr) {
                console.error("[friend_event] welcome send failed:", welcomeErr && welcomeErr.message ? welcomeErr.message : String(welcomeErr));
              }
            }
          } catch (handlerErr) {
            console.error("[friend_event] handler error:", handlerErr && handlerErr.message ? handlerErr.message : String(handlerErr));
          }
        });
        // === END 9BIZCLAW FRIEND-EVENT PATCH ===
        `;

    const patched = content.slice(0, anchorIdx) + injection + content.slice(anchorIdx);
    fs.writeFileSync(cliPath, patched, 'utf-8');
    console.log('[openzca-friend-event] Injected friend_event listener');
  } catch (e) {
    console.error('[openzca-friend-event] error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// OpenClaw latency patches
// ---------------------------------------------------------------------------

function ensureExplicitProviderDiscoverySkip(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('models-config-') && f.endsWith('.js'));
  const MARKER = '9BizClaw LATENCY EXPLICIT_PROVIDER_SKIP';
  const ANCHOR =
    '\tconst explicitProviders = cfg.models?.providers ?? {};\n' +
    '\treturn mergeProviders({\n' +
    '\t\timplicit: await (deps?.resolveImplicitProviders ?? resolveImplicitProviders)({';
  const REPLACEMENT =
    '\tconst explicitProviders = cfg.models?.providers ?? {};\n' +
    '\tconst hasExplicitProviders = Object.keys(explicitProviders).length > 0;\n' +
    '\tif (hasExplicitProviders) {\n' +
    '\t\treturn mergeProviders({\n' +
    `\t\t\timplicit: {}, // ${MARKER}\n` +
    '\t\t\texplicit: explicitProviders\n' +
    '\t\t});\n' +
    '\t}\n' +
    '\treturn mergeProviders({\n' +
    '\t\timplicit: await (deps?.resolveImplicitProviders ?? resolveImplicitProviders)({';
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes('async function resolveProvidersForModelsJsonWithDeps')) continue;
    if (src.includes(MARKER) || src.includes('const hasExplicitProviders = Object.keys(explicitProviders).length > 0;')) {
      console.log('[openclaw-latency] explicit-provider-skip: already patched');
      return;
    }
    if (!src.includes(ANCHOR)) {
      console.warn('[openclaw-latency] explicit-provider-skip: anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureExplicitProviderDiscoverySkip', `anchor missing in ${file}`);
      return;
    }
    src = src.replace(ANCHOR, REPLACEMENT);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] explicit-provider-skip: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] explicit-provider-skip: no models-config file found');
}

function ensureChatToolLatencyPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('openclaw-tools-') && f.endsWith('.js'));
  const MARKER = '9BizClaw LATENCY FAST_CHAT_TOOLS';

  function gateFactory(src, constName, factoryName) {
    const start = `\tconst ${constName} = ${factoryName}({`;
    const replacement = `\tconst ${constName} = shouldCreateHeavyTools ? ${factoryName}({`;
    const startIdx = src.indexOf(start);
    if (startIdx < 0) return { src, changed: false, missing: `${constName}:${factoryName}:start` };
    let next = src.slice(0, startIdx) + replacement + src.slice(startIdx + start.length);
    const closeIdx = next.indexOf('\n\t});', startIdx + replacement.length);
    if (closeIdx < 0) return { src, changed: false, missing: `${constName}:${factoryName}:end` };
    next = next.slice(0, closeIdx) + '\n\t}) : null;' + next.slice(closeIdx + '\n\t});'.length);
    return { src: next, changed: true };
  }

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes('function createOpenClawTools(options)')) continue;
    if (src.includes(MARKER) || src.includes('heavyChatToolsEnabled')) {
      console.log('[openclaw-latency] fast-chat-tools: already patched');
      return;
    }

    const fnAnchor = 'function createOpenClawTools(options) {\n\tconst resolvedConfig = options?.config ?? openClawToolsDeps.config;';
    if (!src.includes(fnAnchor)) {
      console.warn('[openclaw-latency] fast-chat-tools: function anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureChatToolLatencyPatch', `function anchor missing in ${file}`);
      return;
    }
    src = src.replace(fnAnchor,
      'function createOpenClawTools(options) {\n' +
      '\tconst __ocToolsDiagT0 = Date.now();\n' +
      '\tconst __ocToolsDiag = (stage, extra = "") => {\n' +
      '\t\tif (process.env.OPENCLAW_LATENCY_DIAG !== "1") return;\n' +
      '\t\ttry {\n' +
      '\t\t\tconst channel = options?.agentChannel ?? "unknown";\n' +
      '\t\t\tconst suffix = extra ? ` ${extra}` : "";\n' +
      '\t\t\tconsole.log(`[openclaw-tools-diag] stage=${stage} elapsedMs=${Date.now() - __ocToolsDiagT0} channel=${channel}${suffix}`);\n' +
      '\t\t} catch {}\n' +
      `\t}; // ${MARKER}\n` +
      '\t__ocToolsDiag("start");\n' +
      '\tconst resolvedConfig = options?.config ?? openClawToolsDeps.config;'
    );

    const sandboxAnchor =
      '\tconst sandbox = options?.sandboxRoot && options?.sandboxFsBridge ? {\n' +
      '\t\troot: options.sandboxRoot,\n' +
      '\t\tbridge: options.sandboxFsBridge\n' +
      '\t} : void 0;\n' +
      '\tconst imageTool = options?.agentDir?.trim() ? createImageTool({';
    const sandboxReplacement =
      '\tconst sandbox = options?.sandboxRoot && options?.sandboxFsBridge ? {\n' +
      '\t\troot: options.sandboxRoot,\n' +
      '\t\tbridge: options.sandboxFsBridge\n' +
      '\t} : void 0;\n' +
      '\tconst normalizedAgentChannel = typeof options?.agentChannel === "string" ? options.agentChannel.trim().toLowerCase() : "";\n' +
      '\tconst isLowLatencyChatChannel = ["telegram", "webchat", "zalo", "modoro-zalo", "openzca"].includes(normalizedAgentChannel);\n' +
      '\tconst heavyChatToolsEnabled = options?.config?.tools?.heavyChatTools === true || options?.config?.tools?.enableHeavyChatTools === true;\n' +
      '\tconst shouldCreateHeavyTools = !isLowLatencyChatChannel || heavyChatToolsEnabled;\n' +
      '\t__ocToolsDiag("after-runtime-web-tools");\n' +
      '\tconst imageTool = shouldCreateHeavyTools && options?.agentDir?.trim() ? createImageTool({';
    if (!src.includes(sandboxAnchor)) {
      console.warn('[openclaw-latency] fast-chat-tools: sandbox anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureChatToolLatencyPatch', `sandbox anchor missing in ${file}`);
      return;
    }
    src = src.replace(sandboxAnchor, sandboxReplacement);

    const pdfNeedle = '\tconst pdfTool = options?.agentDir?.trim() ? createPdfTool({';
    if (src.includes(pdfNeedle)) {
      src = src.replace(pdfNeedle, '\tconst pdfTool = shouldCreateHeavyTools && options?.agentDir?.trim() ? createPdfTool({');
    } else {
      console.warn('[openclaw-latency] fast-chat-tools: pdf anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureChatToolLatencyPatch', `pdf anchor missing in ${file}`);
      return;
    }

    for (const [constName, factoryName] of [
      ['imageGenerateTool', 'createImageGenerateTool'],
      ['videoGenerateTool', 'createVideoGenerateTool'],
      ['musicGenerateTool', 'createMusicGenerateTool'],
      ['webSearchTool', 'createWebSearchTool'],
      ['webFetchTool', 'createWebFetchTool'],
    ]) {
      const result = gateFactory(src, constName, factoryName);
      if (!result.changed) {
        console.warn('[openclaw-latency] fast-chat-tools: anchor not found ' + result.missing + ' in ' + file);
        _logPatchFailure(homeDir, 'ensureChatToolLatencyPatch', `${result.missing} in ${file}`);
        return;
      }
      src = result.src;
    }

    const pluginAnchor = '\tif (options?.disablePluginTools) return tools;';
    if (!src.includes(pluginAnchor)) {
      console.warn('[openclaw-latency] fast-chat-tools: plugin anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureChatToolLatencyPatch', `plugin anchor missing in ${file}`);
      return;
    }
    src = src.replace(pluginAnchor,
      '\t__ocToolsDiag("after-built-in-tools", `count=${tools.length} heavy=${shouldCreateHeavyTools ? "yes" : "no"}`);\n' +
      '\tif (options?.disablePluginTools || isLowLatencyChatChannel && !heavyChatToolsEnabled) return tools;'
    );

    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] fast-chat-tools: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] fast-chat-tools: no openclaw-tools file found');
}

function ensureStaticConfigModelResolvePatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('model-') && f.endsWith('.js'));
  const MARKER = '9BizClaw LATENCY STATIC_CONFIG_MODEL_RESOLVE';
  const helperAnchor =
    'function resolveRuntimeHooks(params) {\n' +
    '\tif (params?.skipProviderRuntimeHooks) return STATIC_PROVIDER_RUNTIME_HOOKS;\n' +
    '\treturn params?.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;\n' +
    '}\n';
  const helperCode =
    helperAnchor +
    `const STATIC_CONFIG_MODEL_RESOLVE_CACHE = /* @__PURE__ */ new Map(); // ${MARKER}\n` +
    'function resolveStaticConfigModelCacheKey(params) {\n' +
    '\tif (!params.options?.skipProviderRuntimeHooks) return;\n' +
    '\tconst providerConfig = params.cfg?.models?.providers?.[params.provider];\n' +
    '\tif (!providerConfig?.baseUrl || !providerConfig?.api || !Array.isArray(providerConfig.models)) return;\n' +
    '\tconst modelEntry = providerConfig.models.find((entry) => entry?.id === params.modelId);\n' +
    '\tif (!modelEntry) return;\n' +
    '\treturn JSON.stringify([\n' +
    '\t\tparams.provider,\n' +
    '\t\tparams.modelId,\n' +
    '\t\tparams.agentDir,\n' +
    '\t\tproviderConfig.baseUrl,\n' +
    '\t\tproviderConfig.api,\n' +
    '\t\tproviderConfig.auth,\n' +
    '\t\tmodelEntry.contextWindow,\n' +
    '\t\tmodelEntry.contextTokens,\n' +
    '\t\tmodelEntry.maxTokens\n' +
    '\t]);\n' +
    '}\n';

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes('async function resolveModelAsync(provider, modelId, agentDir, cfg, options)')) continue;
    if (src.includes(MARKER) || src.includes('STATIC_CONFIG_MODEL_RESOLVE_CACHE')) {
      console.log('[openclaw-latency] static-model-resolve: already patched');
      return;
    }
    if (!src.includes(helperAnchor)) {
      console.warn('[openclaw-latency] static-model-resolve: helper anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureStaticConfigModelResolvePatch', `helper anchor missing in ${file}`);
      return;
    }
    src = src.replace(helperAnchor, helperCode);

    const runtimeAnchor = '\tconst runtimeHooks = resolveRuntimeHooks(options);\n';
    const runtimeReplacement =
      '\tconst runtimeHooks = resolveRuntimeHooks(options);\n' +
      '\tconst staticConfigCacheKey = resolveStaticConfigModelCacheKey({\n' +
      '\t\tprovider: normalizedRef.provider,\n' +
      '\t\tmodelId: normalizedRef.model,\n' +
      '\t\tagentDir: resolvedAgentDir,\n' +
      '\t\tcfg,\n' +
      '\t\toptions\n' +
      '\t});\n' +
      '\tif (staticConfigCacheKey && STATIC_CONFIG_MODEL_RESOLVE_CACHE.has(staticConfigCacheKey)) return STATIC_CONFIG_MODEL_RESOLVE_CACHE.get(staticConfigCacheKey);\n';
    if (!src.includes(runtimeAnchor)) {
      console.warn('[openclaw-latency] static-model-resolve: runtime anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureStaticConfigModelResolvePatch', `runtime anchor missing in ${file}`);
      return;
    }
    src = src.replace(runtimeAnchor, runtimeReplacement);

    const modelReturn =
      '\tif (model) return {\n' +
      '\t\tmodel,\n' +
      '\t\tauthStorage,\n' +
      '\t\tmodelRegistry\n' +
      '\t};\n' +
      '\treturn {\n' +
      '\t\terror: buildUnknownModelError({';
    const modelReplacement =
      '\tif (model) {\n' +
      '\t\tconst resolved = {\n' +
      '\t\t\tmodel,\n' +
      '\t\t\tauthStorage,\n' +
      '\t\t\tmodelRegistry\n' +
      '\t\t};\n' +
      '\t\tif (staticConfigCacheKey) STATIC_CONFIG_MODEL_RESOLVE_CACHE.set(staticConfigCacheKey, resolved);\n' +
      '\t\treturn resolved;\n' +
      '\t}\n' +
      '\tconst resolvedError = {\n' +
      '\t\terror: buildUnknownModelError({';
    if (!src.includes(modelReturn)) {
      console.warn('[openclaw-latency] static-model-resolve: return anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureStaticConfigModelResolvePatch', `return anchor missing in ${file}`);
      return;
    }
    src = src.replace(modelReturn, modelReplacement);

    const errorReturn =
      '\t\t}),\n' +
      '\t\tauthStorage,\n' +
      '\t\tmodelRegistry\n' +
      '\t};\n' +
      '}\n' +
      '/**\n' +
      '* Build a more helpful error when the model is not found.';
    const errorReplacement =
      '\t\t}),\n' +
      '\t\tauthStorage,\n' +
      '\t\tmodelRegistry\n' +
      '\t};\n' +
      '\tif (staticConfigCacheKey) STATIC_CONFIG_MODEL_RESOLVE_CACHE.set(staticConfigCacheKey, resolvedError);\n' +
      '\treturn resolvedError;\n' +
      '}\n' +
      '/**\n' +
      '* Build a more helpful error when the model is not found.';
    if (!src.includes(errorReturn)) {
      console.warn('[openclaw-latency] static-model-resolve: error return anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureStaticConfigModelResolvePatch', `error return anchor missing in ${file}`);
      return;
    }
    src = src.replace(errorReturn, errorReplacement);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] static-model-resolve: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] static-model-resolve: no model file found');
}

function ensureSessionOverrideApiKeyPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('session-override-') && f.endsWith('.js'));
  const MARKER = '9BizClaw LATENCY API_KEY_SESSION_OVERRIDE_SKIP';
  const helperAnchor =
    'function isProfileForProvider(params) {\n' +
    '\tconst entry = params.store.profiles[params.profileId];\n' +
    '\tif (!entry?.provider) return false;\n' +
    '\treturn normalizeProviderId(entry.provider) === normalizeProviderId(params.provider);\n' +
    '}\n';
  const helperCode =
    helperAnchor +
    `function hasExplicitConfigApiKeyProvider(cfg, provider) { // ${MARKER}\n` +
    '\tconst providerConfig = cfg?.models?.providers?.[provider];\n' +
    '\treturn providerConfig?.auth === "api-key" && typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim().length > 0;\n' +
    '}\n';
  const earlyAnchor = '\tif (!sessionEntry.authProfileOverride?.trim() && !hasConfiguredAuthProfiles && !hasAnyAuthProfileStoreSource(agentDir)) return;\n';
  const earlyCode =
    earlyAnchor +
    '\tif (!sessionEntry.authProfileOverride?.trim() && hasExplicitConfigApiKeyProvider(cfg, provider)) return;\n';
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes('async function resolveSessionAuthProfileOverride(params)')) continue;
    if (src.includes(MARKER) || src.includes('hasExplicitConfigApiKeyProvider')) {
      console.log('[openclaw-latency] api-key-session-override: already patched');
      return;
    }
    if (!src.includes(helperAnchor) || !src.includes(earlyAnchor)) {
      console.warn('[openclaw-latency] api-key-session-override: anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureSessionOverrideApiKeyPatch', `anchor missing in ${file}`);
      return;
    }
    src = src.replace(helperAnchor, helperCode).replace(earlyAnchor, earlyCode);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] api-key-session-override: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] api-key-session-override: no session-override file found');
}

function ensureEmbeddedPiStaticModelResolvePatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('pi-embedded-runner-') && f.endsWith('.js'));
  const MARKER = '9BizClaw LATENCY PI_STATIC_MODEL_RESOLVE';
  const anchor = '\t\t\tconst { model, error, authStorage, modelRegistry } = await resolveModelAsync(provider, modelId, agentDir, params.config);\n';
  const replacement =
    '\t\t\tconst configuredProvider = params.config?.models?.providers?.[provider];\n' +
    '\t\t\tconst useStaticConfigModelResolve = Boolean(configuredProvider?.baseUrl && configuredProvider?.api && Array.isArray(configuredProvider?.models) && configuredProvider.models.some((entry) => entry?.id === modelId));\n' +
    `\t\t\tconst { model, error, authStorage, modelRegistry } = await resolveModelAsync(provider, modelId, agentDir, params.config, useStaticConfigModelResolve ? { skipProviderRuntimeHooks: true } : void 0); // ${MARKER}\n`;
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes('async function runEmbeddedPiAgent(params)')) continue;
    if (src.includes(MARKER) || src.includes('useStaticConfigModelResolve')) {
      console.log('[openclaw-latency] pi-static-model-resolve: already patched');
      return;
    }
    if (!src.includes(anchor)) {
      console.warn('[openclaw-latency] pi-static-model-resolve: anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureEmbeddedPiStaticModelResolvePatch', `anchor missing in ${file}`);
      return;
    }
    src = src.replace(anchor, replacement);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] pi-static-model-resolve: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] pi-static-model-resolve: no pi runner file found');
}

function ensureTelegramFastIdLookupPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260708-fast-telegram-id-lookup-v1';
  const helperAnchor = 'const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps = defaultTelegramBotDeps, opts }) => {';
  const dispatchAnchor =
    '\tlogTelegramDiag("dispatch-start", `streamMode=${streamMode ?? "n/a"} replyToMode=${replyToMode ?? "n/a"}`);\n' +
    '\tconst draftMaxChars = Math.min(textLimit, 4096);';
  const helperCode =
    'const MODOROCLAW_FAST_TELEGRAM_ID_LOOKUP_MARKER = "' + MARKER + '";\n' +
    'function normalize9BizClawTelegramLookupText(value) {\n' +
    '\treturn String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();\n' +
    '}\n' +
    'function extract9BizClawTelegramIdLookupQuery(text) {\n' +
    '\tconst raw = String(text || "").trim();\n' +
    '\tif (!raw) return "";\n' +
    '\tconst normalized = normalize9BizClawTelegramLookupText(raw);\n' +
    '\tif (!/\\bid\\b/.test(normalized)) return "";\n' +
    '\tif (!/(tim|kiem tra|xem|tra|lay|cho|id nhom|id group|id chat|id kenh)/.test(normalized)) return "";\n' +
    '\tlet q = raw.replace(/^.*?\\bid\\s*(?:nhóm|nhom|group|chat|kênh|kenh)?\\s*/i, "").trim();\n' +
    '\tq = q.replace(/^[:：,\\-\\s]+/, "").trim();\n' +
    '\treturn q.length >= 2 ? q : "";\n' +
    '}\n' +
    'async function try9BizClawTelegramIdLookupFastPath(text) {\n' +
    '\tconst query = extract9BizClawTelegramIdLookupQuery(text);\n' +
    '\tif (!query) return null;\n' +
    '\ttry {\n' +
    '\t\tconst fs = await import("node:fs");\n' +
    '\t\tconst path = await import("node:path");\n' +
    '\t\tconst baseDir = process.env.APPDATA ? path.join(process.env.APPDATA, "9bizclaw") : "";\n' +
    '\t\tif (!baseDir) return null;\n' +
    '\t\tconst rows = [];\n' +
    '\t\tconst settingsPath = path.join(baseDir, "telegram-conversation-settings.json");\n' +
    '\t\tif (fs.existsSync(settingsPath)) {\n' +
    '\t\t\ttry {\n' +
    '\t\t\t\tconst settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));\n' +
    '\t\t\t\tfor (const item of Object.values(settings || {})) {\n' +
    '\t\t\t\t\tif (item && item.chatId) rows.push(item);\n' +
    '\t\t\t\t}\n' +
    '\t\t\t} catch {}\n' +
    '\t\t}\n' +
    '\t\tconst memoryDir = path.join(baseDir, "memory", "telegram-chats");\n' +
    '\t\tif (fs.existsSync(memoryDir)) {\n' +
    '\t\t\tfor (const file of fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md"))) {\n' +
    '\t\t\t\ttry {\n' +
    '\t\t\t\t\tconst chatId = file.replace(/\\.md$/i, "");\n' +
    '\t\t\t\t\tconst raw = fs.readFileSync(path.join(memoryDir, file), "utf8").slice(0, 2500);\n' +
    '\t\t\t\t\tconst label = raw.match(/^label:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || raw.match(/^#\\s+(.+)$/m)?.[1] || chatId;\n' +
    '\t\t\t\t\trows.push({ chatId, label, chatType: "unknown", role: "unknown", enabled: true });\n' +
    '\t\t\t\t} catch {}\n' +
    '\t\t\t}\n' +
    '\t\t}\n' +
    '\t\tconst q = normalize9BizClawTelegramLookupText(query);\n' +
    '\t\tconst scored = rows.filter((row) => row && row.enabled !== false && row.chatId).map((row) => {\n' +
    '\t\t\tconst label = String(row.label || row.title || row.name || row.chatId || "");\n' +
    '\t\t\tconst hay = normalize9BizClawTelegramLookupText([label, row.chatId, row.entityId, row.role, row.chatType].join(" "));\n' +
    '\t\t\tlet score = 0;\n' +
    '\t\t\tif (hay === q) score += 100;\n' +
    '\t\t\tif (hay.includes(q)) score += 80;\n' +
    '\t\t\tfor (const part of q.split(/\\s+/).filter(Boolean)) {\n' +
    '\t\t\t\tif (hay.includes(part)) score += Math.min(12, part.length + 3);\n' +
    '\t\t\t}\n' +
    '\t\t\treturn { row, score };\n' +
    '\t\t}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);\n' +
    '\t\tconst picked = scored[0]?.row;\n' +
    '\t\tif (!picked) return null;\n' +
    '\t\treturn {\n' +
    '\t\t\tlabel: String(picked.label || picked.chatId),\n' +
    '\t\t\tchatId: String(picked.chatId),\n' +
    '\t\t\trole: String(picked.role || "unknown"),\n' +
    '\t\t\tchatType: String(picked.chatType || "unknown")\n' +
    '\t\t};\n' +
    '\t} catch {\n' +
    '\t\treturn null;\n' +
    '\t}\n' +
    '}\n' +
    helperAnchor;
  const fastPathCode =
    '\tlogTelegramDiag("dispatch-start", `streamMode=${streamMode ?? "n/a"} replyToMode=${replyToMode ?? "n/a"}`);\n' +
    '\tconst fastTelegramIdLookup = await try9BizClawTelegramIdLookupFastPath(ctxPayload.RawBody ?? ctxPayload.Body ?? "");\n' +
    '\tif (fastTelegramIdLookup) {\n' +
    '\t\tconst fastText = "ID nhóm Telegram " + fastTelegramIdLookup.label + " là:\\n\\n" + fastTelegramIdLookup.chatId;\n' +
    '\t\tlogTelegramDiag("fast-telegram-id-lookup", `chatId=${fastTelegramIdLookup.chatId} marker=${MODOROCLAW_FAST_TELEGRAM_ID_LOOKUP_MARKER}`);\n' +
    '\t\tawait bot.api.sendMessage(chatId, fastText, buildTelegramThreadParams(threadSpec) ?? {});\n' +
    '\t\tlogTelegramDiag("dispatch-end", "fastPath=telegram-id-lookup delivered=true");\n' +
    '\t\treturn;\n' +
    '\t}\n' +
    '\tconst draftMaxChars = Math.min(textLimit, 4096);';

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(helperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('try9BizClawTelegramIdLookupFastPath')) {
      console.log('[openclaw-latency] telegram-fast-id-lookup: already patched');
      return;
    }
    if (!src.includes(dispatchAnchor)) {
      console.warn('[openclaw-latency] telegram-fast-id-lookup: dispatch anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureTelegramFastIdLookupPatch', `dispatch anchor missing in ${file}`);
      return;
    }
    src = src.replace(helperAnchor, helperCode).replace(dispatchAnchor, fastPathCode);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-fast-id-lookup: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-fast-id-lookup: no telegram bot dist file found');
}

function ensureTelegramFastRoleLookupPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260709-fast-telegram-role-lookup-v1';
  const helperAnchor = 'const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps = defaultTelegramBotDeps, opts }) => {';
  const idLookupAnchor = '\tconst fastTelegramIdLookup = await try9BizClawTelegramIdLookupFastPath(ctxPayload.RawBody ?? ctxPayload.Body ?? "");';
  const draftAnchor = '\tconst draftMaxChars = Math.min(textLimit, 4096);';
  const helperCode =
    'const MODOROCLAW_FAST_TELEGRAM_ROLE_LOOKUP_MARKER = "' + MARKER + '";\n' +
    'function normalize9BizClawTelegramRoleLookupText(value) {\n' +
    '\treturn String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();\n' +
    '}\n' +
    'function display9BizClawTelegramRole(role) {\n' +
    '\tconst normalized = String(role || "unknown").trim().toLowerCase();\n' +
    '\tif (normalized === "ceo") return "CEO";\n' +
    '\tif (normalized === "internal") return "n\\u1ed9i b\\u1ed9";\n' +
    '\tif (normalized === "customer") return "kh\\u00e1ch h\\u00e0ng";\n' +
    '\treturn "ch\\u01b0a ph\\u00e2n lo\\u1ea1i";\n' +
    '}\n' +
    'function extract9BizClawTelegramRoleLookupQuery(text) {\n' +
    '\tconst raw = String(text || "").trim();\n' +
    '\tif (!raw) return "";\n' +
    '\tconst normalized = normalize9BizClawTelegramRoleLookupText(raw);\n' +
    '\tif (/\\b(quyen|owner|admin|member|memberstatus|metadata|api telegram member|ho so|profile|history|lich su|kien thuc|luu y|tuong tac|nguon|ket hop|response mode|bat moi tin|doi role|thao tac)\\b/.test(normalized)) return "";\n' +
    '\tif (!/(noi bo|khach hang|khach|role|vai tro|phan loai|thuoc|dang la)/.test(normalized)) return "";\n' +
    '\tlet match = raw.match(/(?:nh\\u00f3m|nhom|group|k\\u00eanh|kenh|chat)\\s+(.+?)(?:\\s+(?:\\u0111ang|dang|l\\u00e0|la|thu\\u1ed9c|thuoc|role|vai|ph\\u00e2n|phan|n\\u1ed9i|noi|kh\\u00e1ch|khach)\\b|[?.!,]|$)/i);\n' +
    '\tlet q = match && match[1] ? match[1].trim() : "";\n' +
    '\tif (!q) {\n' +
    '\t\tmatch = raw.match(/\\b[A-Z0-9][A-Z0-9._-]{1,}(?:\\s*-\\s*[A-Z0-9][A-Z0-9._-]+)*\\b/);\n' +
    '\t\tq = match && match[0] ? match[0].trim() : "";\n' +
    '\t}\n' +
    '\tq = q.replace(/^[:\\uFF1A,\\-\\s]+/, "").replace(/[?.!,]+$/, "").trim();\n' +
    '\treturn q.length >= 2 ? q : "";\n' +
    '}\n' +
    'async function try9BizClawTelegramRoleLookupFastPath(text) {\n' +
    '\tconst query = extract9BizClawTelegramRoleLookupQuery(text);\n' +
    '\tif (!query) return null;\n' +
    '\ttry {\n' +
    '\t\tconst fs = await import("node:fs");\n' +
    '\t\tconst path = await import("node:path");\n' +
    '\t\tconst baseDir = process.env.APPDATA ? path.join(process.env.APPDATA, "9bizclaw") : "";\n' +
    '\t\tif (!baseDir) return null;\n' +
    '\t\tconst rows = [];\n' +
    '\t\tconst settingsPath = path.join(baseDir, "telegram-conversation-settings.json");\n' +
    '\t\tif (fs.existsSync(settingsPath)) {\n' +
    '\t\t\ttry {\n' +
    '\t\t\t\tconst settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));\n' +
    '\t\t\t\tfor (const item of Object.values(settings || {})) {\n' +
    '\t\t\t\t\tif (item && item.chatId) rows.push(item);\n' +
    '\t\t\t\t}\n' +
    '\t\t\t} catch {}\n' +
    '\t\t}\n' +
    '\t\tconst memoryDir = path.join(baseDir, "memory", "telegram-chats");\n' +
    '\t\tif (fs.existsSync(memoryDir)) {\n' +
    '\t\t\tfor (const file of fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md"))) {\n' +
    '\t\t\t\ttry {\n' +
    '\t\t\t\t\tconst chatId = file.replace(/\\.md$/i, "");\n' +
    '\t\t\t\t\tconst raw = fs.readFileSync(path.join(memoryDir, file), "utf8").slice(0, 2500);\n' +
    '\t\t\t\t\tconst label = raw.match(/^label:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || raw.match(/^#\\s+(.+)$/m)?.[1] || chatId;\n' +
    '\t\t\t\t\tconst role = raw.match(/^role:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || "unknown";\n' +
    '\t\t\t\t\tconst chatType = raw.match(/^chatType:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || "unknown";\n' +
    '\t\t\t\t\trows.push({ chatId, label, chatType, role, enabled: true });\n' +
    '\t\t\t\t} catch {}\n' +
    '\t\t\t}\n' +
    '\t\t}\n' +
    '\t\tconst q = normalize9BizClawTelegramRoleLookupText(query);\n' +
    '\t\tconst scored = rows.filter((row) => row && row.enabled !== false && row.chatId).map((row) => {\n' +
    '\t\t\tconst label = String(row.label || row.title || row.name || row.chatId || "");\n' +
    '\t\t\tconst aliases = Array.isArray(row.aliases) ? row.aliases.join(" ") : "";\n' +
    '\t\t\tconst hay = normalize9BizClawTelegramRoleLookupText([label, aliases, row.chatId, row.entityId, row.role, row.chatType].join(" "));\n' +
    '\t\t\tlet score = 0;\n' +
    '\t\t\tif (hay === q) score += 100;\n' +
    '\t\t\tif (hay.includes(q)) score += 80;\n' +
    '\t\t\tfor (const part of q.split(/\\s+/).filter(Boolean)) {\n' +
    '\t\t\t\tif (hay.includes(part)) score += Math.min(12, part.length + 3);\n' +
    '\t\t\t}\n' +
    '\t\t\treturn { row, score };\n' +
    '\t\t}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);\n' +
    '\t\tconst picked = scored[0]?.row;\n' +
    '\t\tif (!picked) return null;\n' +
    '\t\treturn {\n' +
    '\t\t\tlabel: String(picked.label || picked.title || picked.name || picked.chatId),\n' +
    '\t\t\tchatId: String(picked.chatId),\n' +
    '\t\t\trole: String(picked.role || "unknown"),\n' +
    '\t\t\tchatType: String(picked.chatType || "unknown")\n' +
    '\t\t};\n' +
    '\t} catch {\n' +
    '\t\treturn null;\n' +
    '\t}\n' +
    '}\n' +
    helperAnchor;
  const fastPathCode =
    '\tconst fastTelegramRoleLookup = await try9BizClawTelegramRoleLookupFastPath(ctxPayload.RawBody ?? ctxPayload.Body ?? "");\n' +
    '\tif (fastTelegramRoleLookup) {\n' +
    '\t\tconst roleLabel = display9BizClawTelegramRole(fastTelegramRoleLookup.role);\n' +
    '\t\tconst noun = fastTelegramRoleLookup.chatType === "private" ? "Chat" : "Nh\\u00f3m";\n' +
    '\t\tconst fastText = noun + " " + fastTelegramRoleLookup.label + " \\u0111ang l\\u00e0 " + roleLabel + ".\\n\\nChi ti\\u1ebft:\\n- T\\u00ean: " + fastTelegramRoleLookup.label + "\\n- Telegram chat ID: " + fastTelegramRoleLookup.chatId + "\\n- Role: " + fastTelegramRoleLookup.role + "\\n- Lo\\u1ea1i chat: " + fastTelegramRoleLookup.chatType;\n' +
    '\t\tlogTelegramDiag("fast-telegram-role-lookup", `chatId=${fastTelegramRoleLookup.chatId} role=${fastTelegramRoleLookup.role} marker=${MODOROCLAW_FAST_TELEGRAM_ROLE_LOOKUP_MARKER}`);\n' +
    '\t\tawait bot.api.sendMessage(chatId, fastText, buildTelegramThreadParams(threadSpec) ?? {});\n' +
    '\t\tlogTelegramDiag("dispatch-end", "fastPath=telegram-role-lookup delivered=true");\n' +
    '\t\treturn;\n' +
    '\t}\n';

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(helperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('try9BizClawTelegramRoleLookupFastPath')) {
      console.log('[openclaw-latency] telegram-fast-role-lookup: already patched');
      return;
    }
    const dispatchAnchor = src.includes(idLookupAnchor) ? idLookupAnchor : draftAnchor;
    if (!src.includes(dispatchAnchor)) {
      console.warn('[openclaw-latency] telegram-fast-role-lookup: dispatch anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureTelegramFastRoleLookupPatch', `dispatch anchor missing in ${file}`);
      return;
    }
    src = src.replace(helperAnchor, helperCode).replace(dispatchAnchor, fastPathCode + dispatchAnchor);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-fast-role-lookup: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-fast-role-lookup: no telegram bot dist file found');
}

function ensureTelegramFastContextLookupPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260710-fast-telegram-context-lookup-v1';
  const helperAnchor = 'const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps = defaultTelegramBotDeps, opts }) => {';
  const dispatchAnchor = '\tlogTelegramDiag("dispatch-start", `streamMode=${streamMode ?? "n/a"} replyToMode=${replyToMode ?? "n/a"}`);\n';
  const helperLines = [
    'const MODOROCLAW_FAST_TELEGRAM_CONTEXT_LOOKUP_MARKER = "' + MARKER + '";',
    'function normalize9BizClawTelegramContextText(value) {',
    '\treturn String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim();',
    '}',
    'function clean9BizClawTelegramContextText(value, max = 420) {',
    '\tconst text = String(value || "").replace(/\\r/g, "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();',
    '\treturn text.length > max ? text.slice(0, max - 1).trim() + "\\u2026" : text;',
    '}',
    'function display9BizClawTelegramContextRole(role) {',
    '\tconst normalized = String(role || "unknown").trim().toLowerCase();',
    '\tif (normalized === "ceo") return "CEO";',
    '\tif (normalized === "internal") return "n\\u1ed9i b\\u1ed9";',
    '\tif (normalized === "customer") return "kh\\u00e1ch h\\u00e0ng";',
    '\treturn "ch\\u01b0a ph\\u00e2n lo\\u1ea1i";',
    '}',
    'function extract9BizClawTelegramProfileSection(raw, headings) {',
    '\tconst wanted = headings.map((heading) => normalize9BizClawTelegramContextText(heading));',
    '\tconst lines = String(raw || "").split(/\\r?\\n/);',
    '\tlet start = -1;',
    '\tfor (let i = 0; i < lines.length; i += 1) {',
    '\t\tif (!/^##\\s+/.test(lines[i])) continue;',
    '\t\tconst heading = normalize9BizClawTelegramContextText(lines[i].replace(/^##\\s+/, ""));',
    '\t\tif (wanted.some((item) => heading.includes(item))) { start = i + 1; break; }',
    '\t}',
    '\tif (start < 0) return "";',
    '\tconst out = [];',
    '\tfor (let i = start; i < lines.length; i += 1) {',
    '\t\tif (/^##\\s+/.test(lines[i]) || /^---\\s*$/.test(lines[i])) break;',
    '\t\tout.push(lines[i]);',
    '\t}',
    '\treturn clean9BizClawTelegramContextText(out.join("\\n"));',
    '}',
    'function parse9BizClawTelegramProfile(raw) {',
    '\tconst profile = extract9BizClawTelegramProfileSection(raw, ["Ho so doi tuong", "H\\u1ed3 s\\u01a1 \\u0111\\u1ed1i t\\u01b0\\u1ee3ng", "Profile"]);',
    '\tconst knowledge = extract9BizClawTelegramProfileSection(raw, ["Kien thuc rieng can nap", "Ki\\u1ebfn th\\u1ee9c ri\\u00eang c\\u1ea7n n\\u1ea1p", "Private knowledge to load"]);',
    '\tconst interaction = extract9BizClawTelegramProfileSection(raw, ["Luu y khi tuong tac", "L\\u01b0u \\u00fd khi t\\u01b0\\u01a1ng t\\u00e1c", "Interaction notes"]);',
    '\tconst ceoNotes = extract9BizClawTelegramProfileSection(raw, ["CEO notes"]);',
    '\tconst ceoNoteCount = ceoNotes ? ceoNotes.split(/\\n+/).filter((line) => /^[-*]\\s+/.test(line.trim())).length || 1 : 0;',
    '\treturn { profile, knowledge, interaction, ceoNoteCount };',
    '}',
    'function safeRead9BizClawJson(fs, filePath, fallback) {',
    '\ttry { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }',
    '}',
    'function read9BizClawTelegramHistory(fs, path, baseDir, chatId) {',
    '\tconst filePath = path.join(baseDir, "telegram-history", chatId + ".jsonl");',
    '\tif (!fs.existsSync(filePath)) return null;',
    '\ttry {',
    '\t\tconst lines = fs.readFileSync(filePath, "utf8").split(/\\r?\\n/).filter(Boolean);',
    '\t\tconst parsed = [];',
    '\t\tfor (const line of lines.slice(-20)) { try { parsed.push(JSON.parse(line)); } catch {} }',
    '\t\tconst last = parsed[parsed.length - 1] || null;',
    '\t\tconst participants = Array.from(new Set(parsed.map((row) => row.senderName || row.senderUsername || row.senderId).filter(Boolean))).slice(0, 5);',
    '\t\treturn { count: lines.length, lastIso: last?.iso || "", lastText: clean9BizClawTelegramContextText(last?.text || "", 180), participants };',
    '\t} catch { return null; }',
    '}',
    'async function try9BizClawTelegramContextLookupFastPath(text, senderId) {',
    '\tconst raw = String(text || "").trim();',
    '\tif (!raw) return null;',
    '\tconst normalized = normalize9BizClawTelegramContextText(raw);',
    '\tconst wantsContext = /\\b(ket hop|nguon|directory|profile|ho so|history|lich su|member metadata|metadata|quyen|owner|admin|member|kien thuc|luu y|tuong tac|response mode|bat moi tin|doi role|phan loai|file noi bo|cron|tool)\\b/.test(normalized);',
    '\tif (!wantsContext) return null;',
    '\tif (!/(telegram|nhom|group|kenh|chat|llk|id|khach|cron|file noi bo)/.test(normalized)) return null;',
    '\ttry {',
    '\t\tconst fs = await import("node:fs");',
    '\t\tconst path = await import("node:path");',
    '\t\tconst baseDir = process.env.APPDATA ? path.join(process.env.APPDATA, "9bizclaw") : "";',
    '\t\tif (!baseDir) return null;',
    '\t\tconst rowsById = new Map();',
    '\t\tconst addRow = (row, source) => {',
    '\t\t\tconst chatId = String(row?.chatId || row?.targetChatId || (String(row?.entityId || "").startsWith("telegram:") ? String(row.entityId).slice(9) : "") || "").trim();',
    '\t\t\tif (!chatId) return;',
    '\t\t\tconst prev = rowsById.get(chatId) || {};',
    '\t\t\tconst sources = new Set([...(prev.__sources || []), source]);',
    '\t\t\trowsById.set(chatId, { ...prev, ...row, chatId, __sources: Array.from(sources) });',
    '\t\t};',
    '\t\tconst settings = safeRead9BizClawJson(fs, path.join(baseDir, "telegram-conversation-settings.json"), {});',
    '\t\tfor (const item of Object.values(settings || {})) addRow(item, "settings");',
    '\t\tconst directory = safeRead9BizClawJson(fs, path.join(baseDir, "telegram-directory.json"), {});',
    '\t\tfor (const item of directory?.entries || []) addRow(item, "directory");',
    '\t\tfor (const relDir of ["memory/telegram-groups", "memory/telegram-users", "memory/telegram-chats"]) {',
    '\t\t\tconst memoryDir = path.join(baseDir, relDir);',
    '\t\t\tif (!fs.existsSync(memoryDir)) continue;',
    '\t\t\tfor (const file of fs.readdirSync(memoryDir).filter((name) => name.endsWith(".md"))) {',
    '\t\t\t\ttry {',
    '\t\t\t\t\tconst chatId = file.replace(/\\.md$/i, "");',
    '\t\t\t\t\tconst profilePath = path.join(memoryDir, file);',
    '\t\t\t\t\tconst body = fs.readFileSync(profilePath, "utf8").slice(0, 2500);',
    '\t\t\t\t\tconst label = body.match(/^label:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || body.match(/^#\\s+(.+)$/m)?.[1] || chatId;',
    '\t\t\t\t\tconst role = body.match(/^role:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || "";',
    '\t\t\t\t\tconst audience = body.match(/^audience:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || "";',
    '\t\t\t\t\tconst chatType = body.match(/^chatType:\\s*"?([^"\\r\\n]+)"?/m)?.[1] || "";',
    '\t\t\t\t\taddRow({ chatId, label, role, audience, chatType, profilePath }, "profile");',
    '\t\t\t\t} catch {}',
    '\t\t\t}',
    '\t\t}',
    '\t\tconst wantsGroupTarget = /\\b(nhom|group|kenh)\\b/.test(normalized);',
    '\t\tconst scored = Array.from(rowsById.values()).filter((row) => row.enabled !== false).map((row) => {',
    '\t\t\tconst label = String(row.label || row.title || row.name || row.chatId || "");',
    '\t\t\tconst aliases = Array.isArray(row.aliases) ? row.aliases.join(" ") : "";',
    '\t\t\tconst hay = normalize9BizClawTelegramContextText([label, aliases, row.chatId, row.entityId, row.username].join(" "));',
    '\t\t\tconst targetKind = normalize9BizClawTelegramContextText([row.chatType, row.directoryKind].join(" "));',
    '\t\t\tlet score = 0;',
    '\t\t\tif (normalized.includes(normalize9BizClawTelegramContextText(label))) score += 120;',
    '\t\t\tif (normalized.includes(String(row.chatId).replace(/^-100/, "")) || normalized.includes(String(row.chatId))) score += 80;',
    '\t\t\tif (wantsGroupTarget && /(group|supergroup|channel)/.test(targetKind)) score += 90;',
    '\t\t\tif (wantsGroupTarget && /(private|user|ceo)/.test(targetKind)) score -= 120;',
    '\t\t\tfor (const token of hay.split(/\\s+/).filter((part) => part.length >= 2)) if (normalized.includes(token)) score += Math.min(18, token.length + 6);',
    '\t\t\treturn { row, score };',
    '\t\t}).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);',
    '\t\tconst picked = scored[0]?.row;',
    '\t\tif (!picked) return null;',
    '\t\tlet profileRaw = "";',
    '\t\tconst profilePath = picked.profilePath && fs.existsSync(picked.profilePath) ? picked.profilePath : path.join(baseDir, "memory", "telegram-chats", picked.chatId + ".md");',
    '\t\tif (fs.existsSync(profilePath)) { try { profileRaw = fs.readFileSync(profilePath, "utf8"); } catch {} }',
    '\t\tconst profile = parse9BizClawTelegramProfile(profileRaw);',
    '\t\tconst members = safeRead9BizClawJson(fs, path.join(baseDir, "telegram-member-metadata.json"), { entries: {} })?.entries || {};',
    '\t\tconst memberKey = senderId ? picked.chatId + ":" + senderId : "";',
    '\t\tconst member = memberKey ? members[memberKey] : Object.values(members).find((item) => String(item?.chatId) === String(picked.chatId));',
    '\t\tconst history = read9BizClawTelegramHistory(fs, path, baseDir, picked.chatId);',
    '\t\tconst sensitiveActionRequest = /\\b(file noi bo|doc file|tiet lo|lo noi dung|tool|system internals|prompt|config|memory noi bo|cron|tao cron|sua cron|xoa cron)\\b/.test(normalized);',
    '\t\tconst rolePolicyChangeRequest = /\\b(doi|chuyen|cap nhat|sua|bat|tat)\\b/.test(normalized) && /\\b(role|vai tro|phan loai|audience|response mode|moi tin|mention|noi bo|khach hang|khach)\\b/.test(normalized);',
    '\t\tconst actionSafety = sensitiveActionRequest || rolePolicyChangeRequest;',
    '\t\tconst roleLabel = display9BizClawTelegramContextRole(picked.role || picked.audience);',
    '\t\tconst lines = ["Em ki\\u1ec3m tra theo ki\\u1ebfn tr\\u00fac nhi\\u1ec1u l\\u1edbp c\\u1ee7a Telegram:", "", "1. Ph\\u00e2n lo\\u1ea1i chat", "- T\\u00ean: " + (picked.label || picked.chatId), "- Telegram chat ID: " + picked.chatId, "- Lo\\u1ea1i: " + (picked.chatType || picked.directoryKind || "ch\\u01b0a r\\u00f5"), "- Role/audience: " + (picked.role || "unknown") + " / " + (picked.audience || "unknown") + " (" + roleLabel + ")", "- Response mode: " + (picked.responseMode || "ch\\u01b0a r\\u00f5") + ", enabled=" + (picked.enabled !== false), "", "2. Quy\\u1ec1n Telegram th\\u1eadt c\\u1ee7a ng\\u01b0\\u1eddi \\u0111ang h\\u1ecfi", member ? "- memberStatus=" + (member.memberStatus || "unknown") + ", isOwner=" + !!member.isOwner + ", isAdmin=" + !!member.isAdmin + ", isMember=" + !!member.isMember : "- Ch\\u01b0a c\\u00f3 member metadata cho user n\\u00e0y trong nh\\u00f3m.", member ? "- Ngu\\u1ed3n quy\\u1ec1n: " + (member.source || "unknown") + ", fetchedAt=" + (member.fetchedAt || member.updatedAt || "unknown") : "- C\\u1ea7n g\\u1ecdi /api/telegram/member ho\\u1eb7c getChatMember tr\\u01b0\\u1edbc khi kh\\u1eb3ng \\u0111\\u1ecbnh owner/admin/member.", "", "3. H\\u1ed3 s\\u01a1 ri\\u00eang c\\u1ea7n n\\u1ea1p", "- H\\u1ed3 s\\u01a1 \\u0111\\u1ed1i t\\u01b0\\u1ee3ng: " + (profile.profile || "(ch\\u01b0a c\\u00f3)"), "- Ki\\u1ebfn th\\u1ee9c ri\\u00eang: " + (profile.knowledge || "(ch\\u01b0a c\\u00f3)"), "- L\\u01b0u \\u00fd t\\u01b0\\u01a1ng t\\u00e1c: " + (profile.interaction || "(ch\\u01b0a c\\u00f3)"), "- CEO notes ri\\u00eang: " + (profile.ceoNoteCount ? "c\\u00f3 " + profile.ceoNoteCount + " ghi ch\\u00fa n\\u1ed9i b\\u1ed9, ch\\u1ec9 d\\u00f9ng l\\u00e0m b\\u1ed1i c\\u1ea3nh khi c\\u1ea7n" : "ch\\u01b0a c\\u00f3"), "", "4. History/cache", history ? "- telegram-history: " + history.count + " d\\u00f2ng, tin g\\u1ea7n nh\\u1ea5t " + (history.lastIso || "unknown") + ": " + (history.lastText || "(tr\\u1ed1ng)") : "- telegram-history: ch\\u01b0a c\\u00f3 file history ri\\u00eang cho chat n\\u00e0y.", history?.participants?.length ? "- Ng\\u01b0\\u1eddi t\\u1eebng xu\\u1ea5t hi\\u1ec7n g\\u1ea7n \\u0111\\u00e2y: " + history.participants.join(", ") : "- Ng\\u01b0\\u1eddi t\\u1eebng xu\\u1ea5t hi\\u1ec7n g\\u1ea7n \\u0111\\u00e2y: ch\\u01b0a \\u0111\\u1ee7 d\\u1eef li\\u1ec7u.", picked.summary ? "- Summary directory: " + clean9BizClawTelegramContextText(picked.summary, 220) : "- Summary directory: ch\\u01b0a c\\u00f3.", "", "Ngu\\u1ed3n \\u0111\\u00e3 d\\u00f9ng: " + ((picked.__sources || []).join(", ") || "settings/profile") + ", telegram-member-metadata" + (history ? ", telegram-history" : "") + "."];',
    '\t\tif (actionSafety) lines.splice(1, 0, "K\\u1ebft lu\\u1eadn thao t\\u00e1c: Em kh\\u00f4ng \\u0111\\u01b0\\u1ee3c t\\u1ef1 \\u0111\\u1ed5i role/response mode, \\u0111\\u1ecdc file n\\u1ed9i b\\u1ed9, ti\\u1ebft l\\u1ed9 file/tool/system internals, ho\\u1eb7c t\\u1ea1o cron ch\\u1ec9 v\\u00ec user t\\u1ef1 khai c\\u00f3 quy\\u1ec1n.", "Tr\\u01b0\\u1edbc khi thao t\\u00e1c nh\\u1ea1y c\\u1ea3m ph\\u1ea3i x\\u00e1c minh target chat t\\u1eeb directory/settings, x\\u00e1c minh ng\\u01b0\\u1eddi y\\u00eau c\\u1ea7u b\\u1eb1ng member metadata/getChatMember, v\\u00e0 ch\\u1ec9 cho ph\\u00e9p khi \\u0111\\u00fang CEO/owner/admin theo ch\\u00ednh s\\u00e1ch n\\u1ed9i b\\u1ed9. N\\u1ebfu l\\u00e0 kh\\u00e1ch/customer th\\u00ec t\\u1eeb ch\\u1ed1i, kh\\u00f4ng xin duy\\u1ec7t ti\\u1ebfp.");',
    '\t\treturn { chatId: picked.chatId, role: picked.role || "unknown", actionSafety, text: clean9BizClawTelegramContextText(lines.join("\\n"), 3600) };',
    '\t} catch { return null; }',
    '}',
  ];
  const helperCode = helperLines.join('\n') + '\n' + helperAnchor;
  const fastPathCode =
    dispatchAnchor +
    '\tconst fastTelegramContextLookup = await try9BizClawTelegramContextLookupFastPath(ctxPayload.RawBody ?? ctxPayload.Body ?? "", msg?.from?.id);\n' +
    '\tif (fastTelegramContextLookup) {\n' +
    '\t\tlogTelegramDiag("fast-telegram-context-lookup", "chatId=" + fastTelegramContextLookup.chatId + " role=" + fastTelegramContextLookup.role + " actionSafety=" + fastTelegramContextLookup.actionSafety + " marker=" + MODOROCLAW_FAST_TELEGRAM_CONTEXT_LOOKUP_MARKER);\n' +
    '\t\tawait bot.api.sendMessage(chatId, fastTelegramContextLookup.text, buildTelegramThreadParams(threadSpec) ?? {});\n' +
    '\t\tlogTelegramDiag("dispatch-end", "fastPath=telegram-context-lookup delivered=true");\n' +
    '\t\treturn;\n' +
    '\t}\n';

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(helperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('try9BizClawTelegramContextLookupFastPath')) {
      console.log('[openclaw-latency] telegram-fast-context-lookup: already patched');
      return;
    }
    if (!src.includes(dispatchAnchor)) {
      console.warn('[openclaw-latency] telegram-fast-context-lookup: dispatch anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureTelegramFastContextLookupPatch', `dispatch anchor missing in ${file}`);
      return;
    }
    src = src.replace(helperAnchor, helperCode).replace(dispatchAnchor, fastPathCode);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-fast-context-lookup: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-fast-context-lookup: no telegram bot dist file found');
}

function ensureTelegramProviderTimeoutGuardPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260709-telegram-provider-timeout-guard-v1';
  const helperAnchor = 'const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, telegramDeps = defaultTelegramBotDeps, opts }) => {';
  const helperCode =
    'const MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_GUARD_MARKER = "' + MARKER + '";\n' +
    'function resolve9BizClawTelegramProviderTimeoutMs(telegramCfg, cfg) {\n' +
    '\tconst raw = Number(process.env.MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_MS || telegramCfg?.providerTimeoutMs || cfg?.telegram?.providerTimeoutMs || 9e4);\n' +
    '\tif (!Number.isFinite(raw)) return 9e4;\n' +
    '\treturn Math.min(18e4, Math.max(3e4, Math.floor(raw)));\n' +
    '}\n' +
    'async function run9BizClawTelegramProviderTimeoutGuard({ promise, timeoutMs, onTimeout, logTelegramDiag }) {\n' +
    '\tlet timer;\n' +
    '\tlet providerTimeoutSettled = false;\n' +
    '\treturn await new Promise((resolve, reject) => {\n' +
    '\t\ttimer = setTimeout(() => {\n' +
    '\t\t\tproviderTimeoutSettled = true;\n' +
    '\t\t\tPromise.resolve(onTimeout()).then(resolve, reject);\n' +
    '\t\t}, timeoutMs);\n' +
    '\t\tPromise.resolve(promise).then((value) => {\n' +
    '\t\t\tif (providerTimeoutSettled) { try { logTelegramDiag("telegram-provider-late-result-suppressed", `timeoutMs=${timeoutMs} marker=${MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_GUARD_MARKER}`); } catch {} return; }\n' +
    '\t\t\tproviderTimeoutSettled = true;\n' +
    '\t\t\tclearTimeout(timer);\n' +
    '\t\t\tresolve(value);\n' +
    '\t\t}, (err) => {\n' +
    '\t\t\tif (providerTimeoutSettled) { try { logTelegramDiag("telegram-provider-late-error-suppressed", `timeoutMs=${timeoutMs} marker=${MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_GUARD_MARKER}`); } catch {} return; }\n' +
    '\t\t\tproviderTimeoutSettled = true;\n' +
    '\t\t\tclearTimeout(timer);\n' +
    '\t\t\treject(err);\n' +
    '\t\t});\n' +
    '\t});\n' +
    '}\n' +
    helperAnchor;
  const beforeTryAnchor = '\tlet dispatchError;\n\ttry {';
  const beforeTryCode =
    '\tlet dispatchError;\n' +
    '\tlet providerTimeoutTriggered = false;\n' +
    '\tconst providerTimeoutMs = resolve9BizClawTelegramProviderTimeoutMs(telegramCfg, cfg);\n' +
    '\tconst shouldSuppress9BizClawProviderEvent = (kind) => {\n' +
    '\t\tif (!providerTimeoutTriggered) return false;\n' +
    '\t\tlogTelegramDiag("telegram-provider-late-callback-suppressed", `kind=${kind} timeoutMs=${providerTimeoutMs} marker=${MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_GUARD_MARKER}`);\n' +
    '\t\treturn true;\n' +
    '\t};\n' +
    '\ttry {';
  const callStartAnchor = '\t\t({queuedFinal} = await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({';
  const callStartCode = '\t\tconst providerReplyPromise = telegramDeps.dispatchReplyWithBufferedBlockDispatcher({';
  const callEndAnchor =
    '\t\t}));\n' +
    '\t\tlogTelegramDiag("reply-dispatch-done", `queuedFinal=${queuedFinal}`);';
  const callEndCode =
    '\t\t});\n' +
    '\t\t({queuedFinal} = await run9BizClawTelegramProviderTimeoutGuard({\n' +
    '\t\t\tpromise: providerReplyPromise,\n' +
    '\t\t\ttimeoutMs: providerTimeoutMs,\n' +
    '\t\t\tlogTelegramDiag,\n' +
    '\t\t\tonTimeout: async () => {\n' +
    '\t\t\t\tproviderTimeoutTriggered = true;\n' +
    '\t\t\t\tlogTelegramDiag("telegram-provider-timeout", `timeoutMs=${providerTimeoutMs} marker=${MODOROCLAW_TELEGRAM_PROVIDER_TIMEOUT_GUARD_MARKER}`);\n' +
    '\t\t\t\tconst delivered = await sendPayload({ text: "Lu\\u1ed3ng AI \\u0111ang ph\\u1ea3n h\\u1ed3i qu\\u00e1 l\\u00e2u n\\u00ean em \\u0111\\u00e3 ng\\u1eaft \\u0111\\u1ec3 tr\\u00e1nh treo. Anh th\\u1eed l\\u1ea1i gi\\u00fap em.", isError: false });\n' +
    '\t\t\t\treturn { queuedFinal: delivered };\n' +
    '\t\t\t}\n' +
    '\t\t}));\n' +
    '\t\tlogTelegramDiag("reply-dispatch-done", `queuedFinal=${queuedFinal}`);';
  const callbackAnchors = [
    {
      name: 'deliver',
      anchor: '\t\t\t\tdeliver: async (payload, info) => {\n',
      replacement: '\t\t\t\tdeliver: async (payload, info) => {\n\t\t\t\t\tif (shouldSuppress9BizClawProviderEvent("deliver")) return;\n',
    },
    {
      name: 'onSkip',
      anchor: '\t\t\t\tonSkip: (payload, info) => {\n',
      replacement: '\t\t\t\tonSkip: (payload, info) => {\n\t\t\t\t\tif (shouldSuppress9BizClawProviderEvent("skip")) return;\n',
    },
    {
      name: 'onError',
      anchor: '\t\t\t\tonError: (err, info) => {\n',
      replacement: '\t\t\t\tonError: (err, info) => {\n\t\t\t\t\tif (shouldSuppress9BizClawProviderEvent("error")) return;\n',
    },
  ];
  const scopedIndexOf = (src, startNeedle, needle) => {
    const start = src.indexOf(startNeedle);
    return start >= 0 ? src.indexOf(needle, start) : -1;
  };
  const scopedReplace = (src, startNeedle, needle, replacement) => {
    const idx = scopedIndexOf(src, startNeedle, needle);
    if (idx < 0) return src;
    return src.slice(0, idx) + replacement + src.slice(idx + needle.length);
  };

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(helperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('run9BizClawTelegramProviderTimeoutGuard')) {
      console.log('[openclaw-latency] telegram-provider-timeout: already patched');
      return;
    }
    for (const [label, anchor] of [
      ['helper', helperAnchor],
      ['before-try', beforeTryAnchor],
      ['call-start', callStartAnchor],
      ['call-end', callEndAnchor],
    ]) {
      if (!src.includes(anchor)) {
        console.warn('[openclaw-latency] telegram-provider-timeout: ' + label + ' anchor not found in ' + file);
        _logPatchFailure(homeDir, 'ensureTelegramProviderTimeoutGuardPatch', `${label} anchor missing in ${file}`);
        return;
      }
    }
    for (const item of callbackAnchors) {
      if (scopedIndexOf(src, callStartAnchor, item.anchor) < 0) {
        console.warn('[openclaw-latency] telegram-provider-timeout: ' + item.name + ' anchor not found in ' + file);
        _logPatchFailure(homeDir, 'ensureTelegramProviderTimeoutGuardPatch', `${item.name} anchor missing in ${file}`);
        return;
      }
    }
    src = src
      .replace(helperAnchor, helperCode)
      .replace(beforeTryAnchor, beforeTryCode)
      .replace(callStartAnchor, callStartCode)
      .replace(callEndAnchor, callEndCode);
    for (const item of callbackAnchors) src = scopedReplace(src, callStartCode, item.anchor, item.replacement);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-provider-timeout: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-provider-timeout: no telegram bot dist file found');
}

function ensureTelegramInboundHistoryCapturePatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260710-telegram-inbound-history-capture-v1';
  const bodyHelperAnchor = 'async function resolveTelegramInboundBody(params) {';
  const dispatchAnchor = '\tlogTelegramDiag("dispatch-start", `streamMode=${streamMode ?? "n/a"} replyToMode=${replyToMode ?? "n/a"}`);\n';
  const mentionSkipAnchor = '\t\trecordPendingHistoryEntryIfEnabled({\n';
  const helperCode = [
    'const MODOROCLAW_TELEGRAM_INBOUND_HISTORY_CAPTURE_MARKER = "' + MARKER + '";',
    'function compact9BizClawTelegramInboundHistoryText(value, max = 4000) {',
    '\tconst text = value == null ? "" : String(value);',
    '\treturn text.length > max ? text.slice(0, max) : text;',
    '}',
    'function resolve9BizClawTelegramInboundHistoryChatId(params = {}) {',
    '\tconst ctxPayload = params.ctxPayload || {};',
    '\tlet raw = params.chatId ?? params.msg?.chat?.id ?? ctxPayload.To ?? ctxPayload.From ?? "";',
    '\tlet value = String(raw || "").trim();',
    '\tvalue = value.replace(/^telegram:group:/i, "").replace(/^telegram:/i, "").replace(/:thread:.+$/i, "");',
    '\treturn value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);',
    '}',
    'function resolve9BizClawTelegramInboundHistoryMessageId(params = {}) {',
    '\tconst ctxPayload = params.ctxPayload || {};',
    '\tconst raw = ctxPayload.MessageSid ?? params.msg?.message_id ?? "";',
    '\tconst value = String(raw || "").trim() || String(Date.now());',
    '\treturn value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);',
    '}',
    'function has9BizClawTelegramInboundHistoryMessage(fs, file, messageId) {',
    '\ttry {',
    '\t\tif (!fs.existsSync(file)) return false;',
    '\t\tconst stat = fs.statSync(file);',
    '\t\tconst size = Math.min(stat.size, 262144);',
    '\t\tconst fd = fs.openSync(file, "r");',
    '\t\ttry {',
    '\t\t\tconst buffer = Buffer.alloc(size);',
    '\t\t\tfs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));',
    '\t\t\tconst lines = buffer.toString("utf8").split(/\\r?\\n/).filter(Boolean);',
    '\t\t\tfor (let i = lines.length - 1; i >= 0; i -= 1) {',
    '\t\t\t\ttry { if (JSON.parse(lines[i]).messageId === messageId) return true; } catch {}',
    '\t\t\t}',
    '\t\t} finally {',
    '\t\t\tfs.closeSync(fd);',
    '\t\t}',
    '\t} catch {}',
    '\treturn false;',
    '}',
    'async function record9BizClawTelegramInboundHistory(params = {}) {',
    '\ttry {',
    '\t\tconst fs = await import("node:fs");',
    '\t\tconst path = await import("node:path");',
    '\t\tconst baseDir = process.env.APPDATA ? path.join(process.env.APPDATA, "9bizclaw") : "";',
    '\t\tif (!baseDir) return false;',
    '\t\tconst ctxPayload = params.ctxPayload || {};',
    '\t\tconst msg = params.msg || {};',
    '\t\tconst chatId = resolve9BizClawTelegramInboundHistoryChatId({ ctxPayload, msg, chatId: params.chatId });',
    '\t\tconst messageId = resolve9BizClawTelegramInboundHistoryMessageId({ ctxPayload, msg });',
    '\t\tif (!chatId || !messageId) return false;',
    '\t\tconst root = path.join(baseDir, "telegram-history");',
    '\t\tfs.mkdirSync(root, { recursive: true });',
    '\t\tconst file = path.join(root, chatId + ".jsonl");',
    '\t\tif (has9BizClawTelegramInboundHistoryMessage(fs, file, messageId)) return false;',
    '\t\tconst from = msg.from || {};',
    '\t\tconst senderName = compact9BizClawTelegramInboundHistoryText(ctxPayload.SenderName || [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "", 160);',
    '\t\tconst timestamp = Number(ctxPayload.Timestamp ?? (msg.date ? msg.date * 1000 : Date.now()));',
    '\t\tconst chatType = params.isGroup ? (msg.chat?.type || "supergroup") : (msg.chat?.type || ctxPayload.ChatType || "private");',
    '\t\tconst label = compact9BizClawTelegramInboundHistoryText(ctxPayload.GroupSubject || msg.chat?.title || ctxPayload.ConversationLabel || senderName || chatId, 240);',
    '\t\tconst text = compact9BizClawTelegramInboundHistoryText(params.rawBody ?? ctxPayload.RawBody ?? ctxPayload.BodyForAgent ?? ctxPayload.Body ?? msg.text ?? msg.caption ?? "", 4000);',
    '\t\tconst threadId = String(ctxPayload.MessageThreadId ?? params.threadSpec?.id ?? params.resolvedThreadId ?? msg.message_thread_id ?? "");',
    '\t\tconst row = {',
    '\t\t\tdirection: "inbound",',
    '\t\t\tchannel: "telegram",',
    '\t\t\tchatId,',
    '\t\t\tchatType,',
    '\t\t\tlabel,',
    '\t\t\tmessageId,',
    '\t\t\tthreadId,',
    '\t\t\tsenderId: String(ctxPayload.SenderId ?? params.senderId ?? from.id ?? ""),',
    '\t\t\tsenderName,',
    '\t\t\tsenderUsername: String(ctxPayload.SenderUsername ?? params.senderUsername ?? from.username ?? ""),',
    '\t\t\tsenderRole: String(ctxPayload.SenderRole ?? params.senderRole ?? ""),',
    '\t\t\tmemberStatus: String(params.memberStatus ?? ""),',
    '\t\t\tmemberTitle: String(params.memberTitle ?? ""),',
    '\t\t\tisOwner: params.isOwner === true,',
    '\t\t\tisAdmin: params.isAdmin === true,',
    '\t\t\tisMember: params.isMember === true,',
    '\t\t\ttext,',
    '\t\t\ttimestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),',
    '\t\t\tiso: new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString(),',
    '\t\t\tsessionKey: String(ctxPayload.SessionKey ?? params.sessionKey ?? params.route?.sessionKey ?? ""),',
    '\t\t\taccountId: String(params.accountId ?? params.route?.accountId ?? ""),',
    '\t\t\treplyToMessageId: String(ctxPayload.ReplyToId ?? msg.reply_to_message?.message_id ?? ""),',
    '\t\t\thasMedia: Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio || msg.sticker),',
    '\t\t\tsource: String(params.source || "telegram-provider-inbound"),',
    '\t\t\tcaptureMarker: MODOROCLAW_TELEGRAM_INBOUND_HISTORY_CAPTURE_MARKER',
    '\t\t};',
    '\t\tfs.appendFileSync(file, JSON.stringify(row) + "\\n", "utf8");',
    '\t\ttry { params.runtime?.log?.(`[telegram-history] inbound captured chat=${chatId} msg=${messageId} source=${row.source} marker=${MODOROCLAW_TELEGRAM_INBOUND_HISTORY_CAPTURE_MARKER}`); } catch {}',
    '\t\treturn true;',
    '\t} catch (err) {',
    '\t\ttry { params.runtime?.log?.(`[telegram-history] inbound capture skipped: ${err?.message || err}`); } catch {}',
    '\t\treturn false;',
    '\t}',
    '}',
    bodyHelperAnchor,
  ].join('\n');
  const dispatchCaptureCode =
    dispatchAnchor +
    '\tawait record9BizClawTelegramInboundHistory({ ctxPayload, msg, chatId, isGroup, threadSpec, route, runtime, source: "telegram-provider-inbound-dispatch" });\n';
  const mentionSkipCaptureCode =
    '\t\tawait record9BizClawTelegramInboundHistory({ msg, chatId, isGroup, accountId, senderId, senderUsername, sessionKey, resolvedThreadId, rawBody, source: "telegram-provider-inbound-skip" });\n' +
    mentionSkipAnchor;

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(bodyHelperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('record9BizClawTelegramInboundHistory')) {
      console.log('[openclaw-latency] telegram-inbound-history: already patched');
      return;
    }
    for (const [label, anchor] of [
      ['body-helper', bodyHelperAnchor],
      ['dispatch-start', dispatchAnchor],
      ['mention-skip', mentionSkipAnchor],
    ]) {
      if (!src.includes(anchor)) {
        console.warn('[openclaw-latency] telegram-inbound-history: ' + label + ' anchor not found in ' + file);
        _logPatchFailure(homeDir, 'ensureTelegramInboundHistoryCapturePatch', `${label} anchor missing in ${file}`);
        return;
      }
    }
    src = src
      .replace(bodyHelperAnchor, helperCode)
      .replace(dispatchAnchor, dispatchCaptureCode)
      .replace(mentionSkipAnchor, mentionSkipCaptureCode);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-inbound-history: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-inbound-history: no telegram bot dist file found');
}

function ensureTelegramNoMentionPretypingPatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bot-') && f.endsWith('.js'));
  const MARKER = '20260710-telegram-no-mention-pretyping-v1';
  const helperAnchor = 'function createTelegramSendChatActionHandler({ sendChatActionFn, logger, maxConsecutive401 = 10 }) {';
  const ingressTypingAnchor = '\t\t\tctx.api.sendChatAction(normalizedMsg.chat.id, "typing", threadParams).catch(() => {});';
  const middlewareTypingAnchor = '\t\t\t\tctx.api.sendChatAction(msg.chat.id, "typing", threadParams).catch(() => {});';
  const helperCode = [
    'const MODOROCLAW_TELEGRAM_NO_MENTION_PRETYPING_MARKER = "' + MARKER + '";',
    'function should9BizClawTelegramPreTyping(ctx, msg) {',
    '\ttry {',
    '\t\tconst chatType = msg?.chat?.type;',
    '\t\tif (chatType !== "group" && chatType !== "supergroup") return true;',
    '\t\tconst botId = ctx?.me?.id;',
    '\t\tconst botUsername = String(ctx?.me?.username || "").replace(/^@/, "").toLowerCase();',
    '\t\tif (botId != null && msg?.reply_to_message?.from?.id === botId) return true;',
    '\t\tconst text = String(msg?.text || msg?.caption || "");',
    '\t\tconst entities = [].concat(Array.isArray(msg?.entities) ? msg.entities : [], Array.isArray(msg?.caption_entities) ? msg.caption_entities : []);',
    '\t\tfor (const ent of entities) {',
    '\t\t\tif (!ent) continue;',
    '\t\t\tif (ent.type === "text_mention" && botId != null && ent.user?.id === botId) return true;',
    '\t\t\tif (ent.type === "bot_command") return true;',
    '\t\t\tif (ent.type === "mention" && botUsername) {',
    '\t\t\t\tconst mention = text.slice(ent.offset || 0, (ent.offset || 0) + (ent.length || 0)).replace(/^@/, "").toLowerCase();',
    '\t\t\t\tif (mention === botUsername) return true;',
    '\t\t\t}',
    '\t\t}',
    '\t\treturn false;',
    '\t} catch {',
    '\t\treturn true;',
    '\t}',
    '}',
    helperAnchor,
  ].join('\n');
  const ingressTypingCode =
    '\t\t\tif (should9BizClawTelegramPreTyping(ctx, normalizedMsg)) ctx.api.sendChatAction(normalizedMsg.chat.id, "typing", threadParams).catch(() => {});';
  const middlewareTypingCode =
    '\t\t\t\tif (should9BizClawTelegramPreTyping(ctx, msg)) ctx.api.sendChatAction(msg.chat.id, "typing", threadParams).catch(() => {});';

  for (const file of files) {
    const fp = path.join(distDir, file);
    let src = fs.readFileSync(fp, 'utf-8');
    if (!src.includes(helperAnchor)) continue;
    if (src.includes(MARKER) || src.includes('should9BizClawTelegramPreTyping')) {
      console.log('[openclaw-latency] telegram-no-mention-pretyping: already patched');
      return;
    }
    for (const [label, anchor] of [
      ['helper', helperAnchor],
      ['ingress-typing', ingressTypingAnchor],
      ['middleware-typing', middlewareTypingAnchor],
    ]) {
      if (!src.includes(anchor)) {
        console.warn('[openclaw-latency] telegram-no-mention-pretyping: ' + label + ' anchor not found in ' + file);
        _logPatchFailure(homeDir, 'ensureTelegramNoMentionPretypingPatch', `${label} anchor missing in ${file}`);
        return;
      }
    }
    src = src
      .replace(helperAnchor, helperCode)
      .replace(ingressTypingAnchor, ingressTypingCode)
      .replace(middlewareTypingAnchor, middlewareTypingCode);
    fs.writeFileSync(fp, src, 'utf-8');
    console.log('[openclaw-latency] telegram-no-mention-pretyping: applied to ' + file);
    return;
  }
  console.warn('[openclaw-latency] telegram-no-mention-pretyping: no telegram bot dist file found');
}

function ensureOpenclawLatencyPatches(vendorDir, homeDir) {
  if (process.env.MODOROCLAW_DISABLE_LATENCY_PATCHES === '1') {
    console.log('[openclaw-latency] disabled via MODOROCLAW_DISABLE_LATENCY_PATCHES=1');
    return;
  }
  ensureExplicitProviderDiscoverySkip(vendorDir, homeDir);
  ensureChatToolLatencyPatch(vendorDir, homeDir);
  ensureStaticConfigModelResolvePatch(vendorDir, homeDir);
  ensureSessionOverrideApiKeyPatch(vendorDir, homeDir);
  ensureEmbeddedPiStaticModelResolvePatch(vendorDir, homeDir);
  ensureTelegramFastIdLookupPatch(vendorDir, homeDir);
  ensureTelegramFastRoleLookupPatch(vendorDir, homeDir);
  ensureTelegramFastContextLookupPatch(vendorDir, homeDir);
  ensureTelegramProviderTimeoutGuardPatch(vendorDir, homeDir);
  ensureTelegramInboundHistoryCapturePatch(vendorDir, homeDir);
  ensureTelegramNoMentionPretypingPatch(vendorDir, homeDir);
}

function ensureExecApprovalReplyCoalescePatch(vendorDir, homeDir) {
  const distDir = _getOpenclawDistDir(vendorDir);
  if (!distDir) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('exec-approval-reply') && f.endsWith('.js'));
  const MARKER = '20260709-coalesce-exec-approval-reply-v1';
  const anchor =
    '\tconst descriptors = buildExecApprovalActionDescriptors({\n' +
    '\t\tapprovalCommandId,\n' +
    '\t\tallowedDecisions\n' +
    '\t});';
  const safeReturn =
    '\tconst modoroApprovalSafeText = "Cần duyệt thao tác trong OpenClaw. Anh mở Dashboard hoặc Web UI để duyệt; chi tiết lệnh kỹ thuật không được gửi ra chat."; // ' + MARKER + '\n' +
    '\treturn {\n' +
    '\t\ttext: modoroApprovalSafeText,\n' +
    '\t\tinteractive: buildApprovalInteractiveReply({\n' +
    '\t\t\tapprovalId: params.approvalId,\n' +
    '\t\t\tallowedDecisions\n' +
    '\t\t}),\n' +
    '\t\tchannelData: { execApproval: {\n' +
    '\t\t\tapprovalId: params.approvalId,\n' +
    '\t\t\tapprovalSlug: params.approvalSlug,\n' +
    '\t\t\tapprovalKind: "exec",\n' +
    '\t\t\tagentId: normalizeOptionalString(params.agentId),\n' +
    '\t\t\tallowedDecisions,\n' +
    '\t\t\tsessionKey: normalizeOptionalString(params.sessionKey)\n' +
    '\t\t} }\n' +
    '\t};\n' +
    anchor;
  let scanned = 0;
  let patched = 0;
  for (const file of files) {
    const fp = path.join(distDir, file);
    let src;
    try { src = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!src.includes('function buildExecApprovalPendingReplyPayload(params)')) continue;
    scanned += 1;
    if (src.includes(MARKER)) continue;
    if (!src.includes(anchor)) {
      console.warn('[approval-reply-coalesce] anchor not found in ' + file);
      _logPatchFailure(homeDir, 'ensureExecApprovalReplyCoalescePatch', `anchor missing in ${file}`);
      continue;
    }
    fs.writeFileSync(fp, src.replace(anchor, safeReturn), 'utf-8');
    patched += 1;
    console.log('[approval-reply-coalesce] applied to ' + file);
  }
  if (patched > 0) console.log(`[approval-reply-coalesce] ${patched}/${scanned} file(s) patched`);
  else if (scanned > 0) console.log('[approval-reply-coalesce] already patched');
  else {
    console.warn('[approval-reply-coalesce] no exec-approval-reply file found');
    _logPatchFailure(homeDir, 'ensureExecApprovalReplyCoalescePatch', 'no exec approval reply file found');
  }
}

// ---------------------------------------------------------------------------
// applyAllVendorPatches — one call from boot or build script
// ---------------------------------------------------------------------------

function applyAllVendorPatches({ vendorDir, homeDir, workspaceDir }) {
  const results = {};

  // Openclaw dist patches (build-time safe)
  results.pricing = _tryPatch('pricing', () => ensureOpenclawPricingFix(vendorDir));
  results.prewarm = _tryPatch('prewarm', () => ensureOpenclawPrewarmFix(vendorDir));
  results.openclawUpdate = _tryPatch('openclawUpdate', () => ensureOpenclawUpdateUiDisabled(vendorDir, homeDir));
  results.vision = _tryPatch('vision', () => ensureVisionFix(vendorDir, homeDir));
  results.visionCatalog = _tryPatch('visionCatalog', () => ensureVisionCatalogFix(vendorDir, homeDir));
  results.visionSerialization = _tryPatch('visionSerialization', () => ensureVisionSerializationFix(vendorDir, homeDir));
  results.ssrf = _tryPatch('ssrf', () => ensureWebFetchLocalhostFix(vendorDir, homeDir));
  results.friendEvent = _tryPatch('friendEvent', () => ensureOpenzcaFriendEventFix(vendorDir, workspaceDir));
  results.authCacheTtl = _tryPatch('authCacheTtl', () => ensureAuthCacheTtlExtension(vendorDir));
  results.sessionFreeze = _tryPatch('sessionFreeze', () => ensureSessionFreezePatches(vendorDir));
  results.approvalReplyCoalesce = _tryPatch('approvalReplyCoalesce', () => ensureExecApprovalReplyCoalescePatch(vendorDir, homeDir));
  results.latency = _tryPatch('latency', () => ensureOpenclawLatencyPatches(vendorDir, homeDir));

  return results;
}

function _tryPatch(name, fn) {
  try { fn(); return 'ok'; }
  catch (e) { console.error(`[vendor-patches] ${name} failed:`, e?.message); return 'error'; }
}

// ---------------------------------------------------------------------------
// Auth cache TTL extension (15min → 1hr)
// openclaw caches auth-profiles for 15min (9e5 ms). After 15min idle, next
// message pays full auth sync cost (~10-15s). Extending to 1hr (36e5) keeps
// the cache warm for typical CEO usage patterns.
// ---------------------------------------------------------------------------

function ensureAuthCacheTtlExtension(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  // Find store file by content (hash suffix changes on update)
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('store-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('syncedAtMs')) continue;
    // Already patched?
    const AUTH_TTL_MARKER = '/* 9BizClaw AUTH_CACHE_TTL_EXTENDED */';
    if (content.includes(AUTH_TTL_MARKER)) {
      console.log('[vendor-patches] auth-cache-ttl: already patched');
      return;
    }
    // Find and replace the TTL
    const original = 'Date.now() - cached.syncedAtMs >= 9e5';
    if (!content.includes(original)) {
      console.warn('[vendor-patches] auth-cache-ttl: anchor not found in ' + file);
      return;
    }
    const patched = content.replace(original, 'Date.now() - cached.syncedAtMs >= 36e5 ' + AUTH_TTL_MARKER);
    fs.writeFileSync(fp, patched, 'utf-8');
    console.log(`[vendor-patches] auth-cache-ttl: extended 15min → 1hr in ${file}`);
    return;
  }
  console.warn('[vendor-patches] auth-cache-ttl: no store file with syncedAtMs found');
}

// ---------------------------------------------------------------------------
// Session Freeze: Bootstrap file cache (Patch 1/3)
// ---------------------------------------------------------------------------

function ensureBootstrapFileCache(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('bootstrap-files-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('resolveBootstrapContextForRun')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_BOOTSTRAP */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] bootstrap-cache: already patched');
      return;
    }
    // Replace the entire function (small, 10 lines) with a cached version
    const originalFunc =
      'async function resolveBootstrapContextForRun(params) {\n' +
      '\tconst bootstrapFiles = await resolveBootstrapFilesForRun(params);\n' +
      '\treturn {\n' +
      '\t\tbootstrapFiles,\n' +
      '\t\tcontextFiles: buildBootstrapContextFiles(bootstrapFiles, {\n' +
      '\t\t\tmaxChars: resolveBootstrapMaxChars(params.config),\n' +
      '\t\t\ttotalMaxChars: resolveBootstrapTotalMaxChars(params.config),\n' +
      '\t\t\twarn: params.warn\n' +
      '\t\t})\n' +
      '\t};\n' +
      '}';
    if (!content.includes(originalFunc)) {
      console.warn('[session-freeze] bootstrap-cache: full function anchor not found in ' + file + ' — upstream may have changed');
      return;
    }
    const cachedFunc =
      `async function resolveBootstrapContextForRun(params) { ${MARKER}\n` +
      '\tconst __sfT0 = Date.now();\n' +
      '\tconst __sfSyncFs = (await import(\'node:fs\')).default;\n' +
      '\tconst __sfWs = params.workspaceDir || \'\';\n' +
      '\tconst __sfCache = global.__mcBootstrapCache || (global.__mcBootstrapCache = new Map());\n' +
      '\tconst __sfEntry = __sfCache.get(__sfWs);\n' +
      '\tif (__sfEntry) {\n' +
      '\t\tlet __sfOk = true;\n' +
      '\t\tfor (const [__sfF, __sfMt] of Object.entries(__sfEntry.mt)) {\n' +
      '\t\t\ttry { if (__sfSyncFs.statSync(__sfF).mtimeMs !== __sfMt) { __sfOk = false; break; } }\n' +
      '\t\t\tcatch { __sfOk = false; break; }\n' +
      '\t\t}\n' +
      '\t\tif (__sfOk) { console.log(`[session-freeze] bootstrap CACHE HIT (${Date.now()-__sfT0}ms)`); return { bootstrapFiles: [...__sfEntry.r.bootstrapFiles], contextFiles: [...__sfEntry.r.contextFiles] }; }\n' +
      '\t\tconsole.log(`[session-freeze] bootstrap CACHE MISS — mtime changed (${Date.now()-__sfT0}ms)`);\n' +
      '\t}\n' +
      '\tconst bootstrapFiles = await resolveBootstrapFilesForRun(params);\n' +
      '\tconst result = {\n' +
      '\t\tbootstrapFiles,\n' +
      '\t\tcontextFiles: buildBootstrapContextFiles(bootstrapFiles, {\n' +
      '\t\t\tmaxChars: resolveBootstrapMaxChars(params.config),\n' +
      '\t\t\ttotalMaxChars: resolveBootstrapTotalMaxChars(params.config),\n' +
      '\t\t\twarn: params.warn\n' +
      '\t\t})\n' +
      '\t};\n' +
      '\tconst __sfMt = {};\n' +
      '\tfor (const bf of bootstrapFiles) {\n' +
      '\t\tif (bf.path) try { __sfMt[bf.path] = __sfSyncFs.statSync(bf.path).mtimeMs; } catch {}\n' +
      '\t}\n' +
      '\t__sfCache.set(__sfWs, { r: result, mt: __sfMt });\n' +
      '\tconsole.log(`[session-freeze] bootstrap CACHE MISS — cold (${Date.now()-__sfT0}ms, ${bootstrapFiles.length} files)`);\n' +
      '\treturn { bootstrapFiles: [...result.bootstrapFiles], contextFiles: [...result.contextFiles] };\n' +
      '}';
    const patched = content.replace(originalFunc, cachedFunc);
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] bootstrap-cache: applied to ${file}`);
    }
    return;
  }
  console.warn('[session-freeze] bootstrap-cache: no bootstrap-files file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: External CLI sync skip (Patch 2/3)
// ---------------------------------------------------------------------------

function ensureExternalCliSyncSkip(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('store-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('shouldSyncExternalCliCredentials')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_CLI_SYNC */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] cli-sync-skip: already patched');
      return;
    }
    const anchor = 'function shouldSyncExternalCliCredentials(options) {\n\treturn options?.syncExternalCli !== false;\n}';
    if (!content.includes(anchor)) {
      console.warn('[session-freeze] cli-sync-skip: anchor not found in ' + file);
      return;
    }
    const patched = content.replace(anchor,
      `function shouldSyncExternalCliCredentials(options) { ${MARKER}\n` +
      `\tif (global.__mcCliSyncDone) { console.log('[session-freeze] cli-sync SKIPPED (already synced this boot)'); return false; }\n` +
      `\treturn options?.syncExternalCli !== false;\n` +
      `}`
    );
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] cli-sync-skip: applied to ${file}`);
    }
    // Also mark sync as done after first successful sync
    const syncAnchor = 'if (shouldSyncExternalCliCredentials(options)) syncExternalCliCredentialsTimed(asStore';
    if (patched.includes(syncAnchor)) {
      const syncPatched = patched.replace(syncAnchor,
        'if (shouldSyncExternalCliCredentials(options)) { syncExternalCliCredentialsTimed(asStore'
      ).replace(
        'syncExternalCliCredentialsTimed(asStore, { log: !readOnly });',
        'syncExternalCliCredentialsTimed(asStore, { log: !readOnly }); global.__mcCliSyncDone = true; }'
      );
      if (syncPatched !== patched) {
        fs.writeFileSync(fp, syncPatched, 'utf-8');
        console.log(`[session-freeze] cli-sync-done-marker: applied to ${file}`);
      }
    }
    return;
  }
  console.warn('[session-freeze] cli-sync-skip: no store file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: System prompt freeze (Patch 3/3)
// ---------------------------------------------------------------------------

function ensureSystemPromptFreeze(vendorDir) {
  if (!vendorDir) return;
  const distDir = path.join(vendorDir, 'node_modules', 'openclaw', 'dist');
  if (!fs.existsSync(distDir)) return;
  const files = fs.readdirSync(distDir).filter(f => f.startsWith('pi-embedded-runner-') && f.endsWith('.js'));
  for (const file of files) {
    const fp = path.join(distDir, file);
    let content;
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes('createSystemPromptOverride')) continue;
    const MARKER = '/* 9BizClaw SESSION_FREEZE_PROMPT */';
    if (content.includes(MARKER)) {
      console.log('[session-freeze] prompt-freeze: already patched');
      return;
    }
    const anchor = 'let systemPromptText = createSystemPromptOverride(appendPrompt)();';
    if (!content.includes(anchor)) {
      console.warn('[session-freeze] prompt-freeze: anchor not found in ' + file);
      return;
    }
    const replacement = `${MARKER}
\t\t\tconst __sfPT0 = Date.now();
\t\t\tconst __sfPHash = crypto.createHash('sha256').update(appendPrompt).digest('hex');
\t\t\tlet systemPromptText;
\t\t\tif (global.__mcPromptHash === __sfPHash && global.__mcPromptText) {
\t\t\t\tsystemPromptText = global.__mcPromptText;
\t\t\t\tconsole.log(\`[session-freeze] prompt CACHE HIT (\${Date.now()-__sfPT0}ms, hash=\${__sfPHash.slice(0,8)})\`);
\t\t\t} else {
\t\t\t\tsystemPromptText = createSystemPromptOverride(appendPrompt)();
\t\t\t\tglobal.__mcPromptHash = __sfPHash;
\t\t\t\tglobal.__mcPromptText = systemPromptText;
\t\t\t\tconsole.log(\`[session-freeze] prompt CACHE MISS (\${Date.now()-__sfPT0}ms, \${appendPrompt.length} chars, hash=\${__sfPHash.slice(0,8)})\`);
\t\t\t}`;
    const patched = content.replace(anchor, replacement);
    if (patched !== content) {
      fs.writeFileSync(fp, patched, 'utf-8');
      console.log(`[session-freeze] prompt-freeze: applied to ${file}`);
    }
    return;
  }
  console.warn('[session-freeze] prompt-freeze: no pi-embedded-runner file found');
}

// ---------------------------------------------------------------------------
// Session Freeze: apply all 3 patches
// ---------------------------------------------------------------------------

function ensureSessionFreezePatches(vendorDir) {
  if (process.env.MODOROCLAW_DISABLE_SESSION_FREEZE === '1') {
    console.log('[session-freeze] disabled via MODOROCLAW_DISABLE_SESSION_FREEZE=1');
    return;
  }
  ensureBootstrapFileCache(vendorDir);
  ensureExternalCliSyncSkip(vendorDir);
  ensureSystemPromptFreeze(vendorDir);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ensureVisionFix,
  ensureVisionCatalogFix,
  ensureVisionSerializationFix,
  ensureWebFetchLocalhostFix,
  ensureOpenclawPricingFix,
  ensureOpenclawPrewarmFix,
  ensureOpenclawUpdateUiDisabled,
  ensureOpenzcaFriendEventFix,
  ensureAuthCacheTtlExtension,
  ensureSessionFreezePatches,
  ensureOpenclawLatencyPatches,
  ensureExecApprovalReplyCoalescePatch,
  ensureTelegramFastContextLookupPatch,
  ensureTelegramProviderTimeoutGuardPatch,
  ensureTelegramInboundHistoryCapturePatch,
  ensureTelegramNoMentionPretypingPatch,
  applyAllVendorPatches,
};
