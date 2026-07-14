#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const nineRouter = require(path.join(__dirname, '..', 'lib', 'nine-router.js'));
const testApi = nineRouter._test || {};

function base64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function makeJwt(payload) {
  return [
    base64UrlJson({ alg: 'none', typ: 'JWT' }),
    base64UrlJson(payload),
    'signature',
  ].join('.');
}

assert.strictEqual(
  typeof testApi.parseCodexDesktopAccessTokenMetadata,
  'function',
  'parseCodexDesktopAccessTokenMetadata must be exported for contract tests',
);

const nowMs = Date.UTC(2026, 6, 14, 7, 0, 0);
const good = testApi.parseCodexDesktopAccessTokenMetadata(makeJwt({
  exp: Math.floor(nowMs / 1000) + 3600,
  email: 'bao@example.com',
  sub: 'user-123',
  'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
}), nowMs);

assert.strictEqual(good.valid, true, 'fresh token should be accepted');
assert.strictEqual(good.email, 'bao@example.com');
assert.strictEqual(good.plan, 'pro');
assert.strictEqual(good.subject, 'user-123');
assert.ok(good.expiresAt.endsWith('Z'), 'expiresAt should be ISO text');
assert.ok(!Object.prototype.hasOwnProperty.call(good, 'token'), 'metadata must not expose token');
assert.ok(!Object.prototype.hasOwnProperty.call(good, 'accessToken'), 'metadata must not expose accessToken');

const expired = testApi.parseCodexDesktopAccessTokenMetadata(makeJwt({
  exp: Math.floor(nowMs / 1000) - 1,
}), nowMs);

assert.strictEqual(expired.valid, false, 'expired token should be rejected');
assert.strictEqual(expired.reason, 'expired');

const malformed = testApi.parseCodexDesktopAccessTokenMetadata('not-a-jwt', nowMs);
assert.strictEqual(malformed.valid, false, 'malformed token should be rejected');

console.log('9Router Codex Desktop auth sync contract passed.');
