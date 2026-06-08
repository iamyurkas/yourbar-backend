import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../dist/index.js';

function env() {
  return {
    RECIPE_SHARES: { async get() { return null; }, async put() {}, async delete() {} },
    COMMUNITY_FEATURE_ENABLED: 'true',
    COMMUNITY_ADMIN_ENABLED: 'true',
  };
}

test('admin moderation page is served at both canonical paths', async () => {
  for (const path of ['/admin', '/admin/']) {
    const response = await handleRequest(new Request(`https://staging-api.yourbar.app${path}`), env());
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /YourBar Community Moderation/);
    assert.match(html, /Review queue/);
    assert.match(html, /\/api\/admin\/community\/submissions/);
    assert.match(html, /Cloudflare Access/);
    const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  }
});

test('admin page rejects non-GET methods', async () => {
  const response = await handleRequest(new Request('https://staging-api.yourbar.app/admin', { method: 'POST' }), env());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal((await response.json()).error.code, 'method_not_allowed');
});


test('admin page stays hidden when Community administration is disabled', async () => {
  const response = await handleRequest(new Request('https://api.yourbar.app/admin'), {
    ...env(),
    COMMUNITY_FEATURE_ENABLED: 'false',
    COMMUNITY_ADMIN_ENABLED: 'false',
  });
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /Community moderation/);
});
