// Unit tests for the navigation allowlist (electron/sites.ts). Run: node --test test/sites.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = path.join(mkdtempSync(path.join(tmpdir(), 'walled-sites-')), 'sites.mjs');
await build({ entryPoints: ['electron/sites.ts'], outfile: out, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { loadSites, isNavigationAllowed, isDlpDocument } = await import(pathToFileURL(out).href);

const prod = loadSites({});
const chatgpt = prod.chatgpt;
const perplexity = prod.perplexity;

test('own hosts and subdomains are allowed over https', () => {
  assert.ok(isNavigationAllowed(chatgpt, 'https://chatgpt.com/c/123'));
  assert.ok(isNavigationAllowed(chatgpt, 'https://auth.openai.com/log-in'));
  assert.ok(isNavigationAllowed(perplexity, 'https://www.perplexity.ai/search/x'));
  assert.ok(isNavigationAllowed(perplexity, 'https://accounts.google.com/o/oauth2/auth'));
});

test('other sites are refused, including look-alike hosts', () => {
  assert.ok(!isNavigationAllowed(chatgpt, 'https://example.com/'));
  assert.ok(!isNavigationAllowed(chatgpt, 'https://chatgpt.com.evil.io/'));
  assert.ok(!isNavigationAllowed(chatgpt, 'https://evilchatgpt.com/'));
  assert.ok(!isNavigationAllowed(chatgpt, 'https://www.perplexity.ai/'), 'tabs do not navigate into each other');
  assert.ok(!isNavigationAllowed(perplexity, 'https://chatgpt.com/'));
});

test('plain http is refused in production', () => {
  assert.ok(!isNavigationAllowed(chatgpt, 'http://chatgpt.com/'));
  assert.ok(!isNavigationAllowed(perplexity, 'http://www.perplexity.ai/'));
});

test('dangerous schemes are never allowed', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://chatgpt.com/x',
    'ftp://chatgpt.com/', 'chrome://gpu', 'devtools://devtools/x', 'view-source:https://chatgpt.com/', 'not a url', '']) {
    assert.ok(!isNavigationAllowed(chatgpt, url), url);
  }
  assert.ok(isNavigationAllowed(chatgpt, 'about:blank'));
  assert.ok(!isNavigationAllowed(chatgpt, 'about:srcdoc'));
});

test('test overrides are ignored unless WALLED_E2E=1', () => {
  const env = { WALLED_E2E_SITES: JSON.stringify({ chatgpt: 'http://127.0.0.1:9/' }) };
  assert.equal(loadSites(env).chatgpt.url, 'https://chatgpt.com/');
  const t = loadSites({ ...env, WALLED_E2E: '1' }).chatgpt;
  assert.equal(t.url, 'http://127.0.0.1:9/');
  assert.ok(isNavigationAllowed(t, 'http://127.0.0.1:9/x'));
  assert.ok(!isNavigationAllowed(t, 'http://127.0.0.2:9/x'));
  assert.ok(!isNavigationAllowed(t, 'http://127.0.0.1:10/x'));
  assert.ok(isDlpDocument(t, 'http://127.0.0.1:9/x'));
  assert.ok(!isDlpDocument(t, 'http://127.0.0.1:10/x'));
});

test('inspection only applies to configured site documents', () => {
  assert.ok(isDlpDocument(chatgpt, 'https://chatgpt.com/c/123'));
  assert.ok(isDlpDocument(perplexity, 'https://www.perplexity.ai/search/x'));
  assert.ok(!isDlpDocument(chatgpt, 'https://chatgpt.com/auth/login'));
  assert.ok(!isDlpDocument(chatgpt, 'https://auth.openai.com/log-in'));
  assert.ok(!isDlpDocument(chatgpt, 'https://www.perplexity.ai/search/x'));
  assert.ok(!isDlpDocument(chatgpt, 'https://chatgpt.com:8080/c/123'));
});
