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
const { authenticationTarget, loadSites, isChatGptSignInDocument, isDlpDocument, isNavigationAllowed } = await import(pathToFileURL(out).href);

const prod = loadSites({});
const chatgpt = prod.chatgpt;
const perplexity = prod.perplexity;

test('own hosts and subdomains are allowed over https', () => {
  assert.ok(isNavigationAllowed(chatgpt, 'https://chatgpt.com/c/123'));
  assert.ok(isNavigationAllowed(chatgpt, 'https://auth.openai.com/log-in'));
  assert.ok(isNavigationAllowed(perplexity, 'https://www.perplexity.ai/search/x'));
  assert.ok(isNavigationAllowed(perplexity, 'https://accounts.google.com/o/oauth2/auth'));
});

test('sign-in redirects have no DLP scanning IPC access', () => {
  const providers = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com'];
  for (const site of [chatgpt, perplexity]) {
    assert.ok(isDlpDocument(site, site.url));
    for (const host of providers) {
      assert.ok(isNavigationAllowed(site, `https://${host}/`));
      assert.ok(!isDlpDocument(site, `https://${host}/`));
      assert.ok(!isNavigationAllowed(site, `https://${host}:8443/`));
      assert.ok(!isNavigationAllowed(site, `https://${host}.example.com/`));
    }
  }
  assert.ok(isNavigationAllowed(chatgpt, 'https://auth.openai.com/log-in'));
  assert.ok(!isDlpDocument(chatgpt, 'https://auth.openai.com/log-in'));
});

test('public starts and recognised authentication destinations are distinct', () => {
  assert.equal(chatgpt.url, 'https://chatgpt.com/');
  assert.equal(perplexity.url, 'https://www.perplexity.ai/');
  for (const site of [chatgpt, perplexity]) {
    assert.equal(authenticationTarget(site, site.url), null);
    for (const route of ['auth/login_with', 'login', 'sign-in', 'api/auth/signin']) {
      const url = new URL(route, site.url).href;
      assert.equal(authenticationTarget(site, url), 'sign-in');
      assert.ok(!isDlpDocument(site, url));
    }
    assert.equal(authenticationTarget(site, 'https://accounts.google.com/o/oauth2/v2/auth'), 'google');
    assert.equal(authenticationTarget(site, 'https://login.microsoftonline.com/tenant/oauth2/authorize'), 'sign-in');
    assert.equal(authenticationTarget(site, 'https://accounts.google.com.example.org/o/oauth2/v2/auth'), null);
  }
  assert.equal(authenticationTarget(chatgpt, 'https://auth.openai.com/oauth/authorize'), 'sign-in');
});

test('ChatGPT’s Google entry is recognised before the provider redirect', () => {
  assert.equal(authenticationTarget(chatgpt, 'https://chatgpt.com/auth/login_with?connection=google-oauth2'), 'google');
  assert.equal(authenticationTarget(chatgpt, 'https://chatgpt.com/auth/login_with?connection=apple'), 'sign-in');
  assert.equal(authenticationTarget(chatgpt, 'https://chatgpt.com/?connection=google-oauth2'), null);
  assert.equal(authenticationTarget(chatgpt, 'https://chatgpt.com.example.org/auth/login_with?connection=google-oauth2'), null);
});

test('sign-in completion recovery is limited to ChatGPT and its OpenAI sign-in hosts', () => {
  assert.ok(isChatGptSignInDocument(chatgpt, 'https://chatgpt.com/auth/verify'));
  assert.ok(isChatGptSignInDocument(chatgpt, 'https://auth.openai.com/mfa'));
  for (const url of ['https://chatgpt.com/', 'https://accounts.google.com/o/oauth2/auth',
    'https://appleid.apple.com/auth', 'https://auth.openai.com.example.org/mfa', 'https://auth.openai.com:8443/mfa']) {
    assert.ok(!isChatGptSignInDocument(chatgpt, url));
  }
  assert.ok(!isChatGptSignInDocument(perplexity, 'https://www.perplexity.ai/auth/verify'));
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
});
