import assert from 'node:assert/strict';
import test from 'node:test';
import { requireAdmin, AuthError } from '../dist/auth.js';

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function accessFixture(overrides = {}) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  publicJwk.kid = 'test-access-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: ['correct-audience'],
    email: 'admin@example.com',
    exp: now + 300,
    iat: now,
    nbf: now - 5,
    iss: 'https://your-team.cloudflareaccess.com',
    sub: 'admin-1',
    type: 'app',
    ...overrides,
  };
  const header = { alg: 'RS256', kid: publicJwk.kid, typ: 'JWT' };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
  return { token: `${unsigned}.${base64Url(signature)}`, publicJwk };
}

async function errorBody(promise) {
  try {
    await promise;
    assert.fail('Expected requireAdmin to reject');
  } catch (error) {
    assert.ok(error instanceof AuthError);
    return { status: error.response.status, body: await error.response.json() };
  }
}

test('Access authentication returns a precise audience mismatch error', async (t) => {
  const fixture = await accessFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [fixture.publicJwk] });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await errorBody(requireAdmin(new Request('https://staging-api.yourbar.app/api/admin/community/submissions', {
    headers: { 'Cf-Access-Jwt-Assertion': fixture.token },
  }), {
    CF_ACCESS_TEAM_DOMAIN: 'your-team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'wrong-audience',
  }));

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, {
    error: {
      code: 'access_token_audience_mismatch',
      message: 'Cloudflare Access token audience does not match CF_ACCESS_AUD',
    },
  });
});

test('Access authentication validates issuer and accepts comma-separated audiences', async (t) => {
  const fixture = await accessFixture({ iss: 'https://other-team.cloudflareaccess.com' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [fixture.publicJwk] });
  t.after(() => { globalThis.fetch = originalFetch; });

  const user = await requireAdmin(new Request('https://staging-api.yourbar.app/api/admin/community/submissions', {
    headers: { 'Cf-Access-Jwt-Assertion': fixture.token },
  }), {
    CF_ACCESS_TEAM_DOMAIN: ' https://other-team.cloudflareaccess.com/ ',
    CF_ACCESS_AUD: 'previous-audience, correct-audience',
  });

  assert.deepEqual(user, { id: 'admin-1', email: 'admin@example.com' });
});

test('Access authentication identifies the missing Worker binding without exposing values', async () => {
  const fixture = await accessFixture();
  const request = new Request('https://staging-api.yourbar.app/api/admin/community/submissions', {
    headers: { 'Cf-Access-Jwt-Assertion': fixture.token },
  });

  const missingAudience = await errorBody(requireAdmin(request.clone(), {
    CF_ACCESS_TEAM_DOMAIN: 'your-team.cloudflareaccess.com',
  }));
  assert.equal(missingAudience.status, 503);
  assert.deepEqual(missingAudience.body, {
    error: {
      code: 'access_not_configured',
      message: 'Cloudflare Access validation is not configured; missing Worker binding: CF_ACCESS_AUD',
    },
  });

  const missingBoth = await errorBody(requireAdmin(request.clone(), {}));
  assert.equal(missingBoth.status, 503);
  assert.deepEqual(missingBoth.body, {
    error: {
      code: 'access_not_configured',
      message: 'Cloudflare Access validation is not configured; missing Worker bindings: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD',
    },
  });
});
