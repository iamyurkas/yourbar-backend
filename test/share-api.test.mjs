import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipeId, isValidRecipeId } from '../dist/ids.js';
import { corsPreflight, escapeHtml, jsonError, withCors } from '../dist/http.js';
import { handleRequest, renderRecipeLandingPage } from '../dist/index.js';
import { validateRecipeSharePayloadV1 } from '../dist/schema.js';

const validPayload = {
  schemaVersion: 1,
  kind: 'yourbar.recipeShare',
  recipe: {
    name: 'Daiquiri',
    ingredients: [
      { name: 'Rum', amount: 2, unit: 'oz' },
      { name: 'Lime juice', amount: 1, unit: 'oz' },
    ],
  },
  source: { app: 'yourbar', appVersion: '1.0.0', platform: 'ios' },
};

class MockKV {
  values = new Map();
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
}

function env(overrides = {}) {
  return {
    RECIPE_SHARES: new MockKV(),
    PUBLIC_BASE_URL: 'https://api.yourbar.app',
    ...overrides,
  };
}

test('payload validation accepts a valid RecipeSharePayloadV1', () => {
  const result = validateRecipeSharePayloadV1(validPayload);
  assert.equal(result.ok, true);
});

test('payload validation rejects missing recipe.name', () => {
  const result = validateRecipeSharePayloadV1({ ...validPayload, recipe: { ...validPayload.recipe, name: '' } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.name'));
});

test('payload validation rejects invalid schemaVersion', () => {
  const result = validateRecipeSharePayloadV1({ ...validPayload, schemaVersion: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'schemaVersion'));
});

test('payload validation rejects invalid imageUrl', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: { ...validPayload.recipe, imageUrl: 'ftp://example.com/image.jpg' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.imageUrl'));
});

test('id generation format is short and URL-safe', () => {
  const id = generateRecipeId();
  assert.equal(id.length, 12);
  assert.equal(isValidRecipeId(id), true);
});

test('landing page escapes recipe names', () => {
  const record = {
    id: '23456789AB',
    payload: { ...validPayload, recipe: { ...validPayload.recipe, name: '<img src=x onerror="alert(1)">' } },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
  };
  const html = renderRecipeLandingPage(record, env());
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror="alert\(1\)">/);
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
});

test('JSON error helper returns a consistent error body', async () => {
  const response = jsonError('bad_request', 'Bad request', 400);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'bad_request', message: 'Bad request' } });
});

test('CORS allows all origins when no allow-list is configured', () => {
  const request = new Request('https://api.yourbar.app/api/recipes', { headers: { Origin: 'https://app.example' } });
  const response = withCors(new Response('ok'), request, undefined);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('CORS echoes allowed origins when an allow-list is configured', () => {
  const request = new Request('https://api.yourbar.app/api/recipes', { headers: { Origin: 'https://app.example' } });
  const response = withCors(new Response('ok'), request, 'https://app.example');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
});

test('CORS preflight is supported', () => {
  const request = new Request('https://api.yourbar.app/api/recipes', {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.example', 'Access-Control-Request-Headers': 'content-type' },
  });
  const response = corsPreflight(request, undefined);
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('route integration echoes configured CORS origin', async () => {
  const bindings = env({ CORS_ALLOWED_ORIGINS: 'http://localhost:8081,https://yourbar.app,https://www.yourbar.app' });
  const response = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'OPTIONS',
    headers: { Origin: 'https://yourbar.app', 'Access-Control-Request-Headers': 'content-type' },
  }), bindings);

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://yourbar.app');
});

test('route integration creates and retrieves a recipe share using mocked KV', async () => {
  const bindings = env({ DEFAULT_RECIPE_TTL_SECONDS: '60' });
  const create = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://mobile.example' },
    body: JSON.stringify(validPayload),
  }), bindings);

  assert.equal(create.status, 201);
  assert.equal(create.headers.get('Access-Control-Allow-Origin'), '*');
  const created = await create.json();

  assert.match(created.publicUrl, /^https:\/\/api\.yourbar\.app\/r\//);
  assert.match(created.apiUrl, /^https:\/\/api\.yourbar\.app\/api\/recipes\//);

  const get = await handleRequest(new Request(created.apiUrl), bindings);
  assert.equal(get.status, 200);
  const stored = await get.json();
  assert.equal(stored.id, created.id);
  assert.equal(stored.payload.recipe.name, 'Daiquiri');
});
