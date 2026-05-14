import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipeId, isValidRecipeId } from '../dist/ids.js';
import { corsPreflight, escapeHtml, jsonError, withCors } from '../dist/http.js';
import { handleRequest, recipeChecksum, renderRecipeLandingPage } from '../dist/index.js';
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

class MockR2 {
  values = new Map();
  async put(key, value, options = {}) {
    this.values.set(key, {
      body: value,
      httpEtag: 'mock-etag',
      contentType: options.httpMetadata?.contentType,
    });
  }
  async get(key) {
    const value = this.values.get(key);
    if (!value) return null;
    return {
      body: value.body,
      httpEtag: value.httpEtag,
      writeHttpMetadata(headers) {
        if (value.contentType) headers.set('Content-Type', value.contentType);
      },
    };
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


test('recipe checksum is stable for object key order and trimmed strings', async () => {
  const left = await recipeChecksum({ name: ' Daiquiri ', ingredients: [{ name: 'Rum', amount: 2, unit: 'oz' }] });
  const right = await recipeChecksum({ ingredients: [{ unit: 'oz', amount: 2, name: 'Rum' }], name: 'Daiquiri' });

  assert.equal(left, right);
  assert.match(left, /^[0-9a-f]{64}$/);
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
    recipeChecksum: 'test-checksum',
  };
  const html = renderRecipeLandingPage(record, env());
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror="alert\(1\)">/);
  assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
});

test('landing page includes the full recipe and image when available', () => {
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        description: 'A crisp Cuban classic.',
        imageUrl: 'https://api.yourbar.app/images/daiquiri.webp',
        ingredients: [
          { name: 'White rum', amount: 2, unit: 'oz' },
          { name: 'Lime juice', amount: 1, unit: 'oz', note: 'fresh' },
          { name: 'Simple syrup', amount: 0.75, unit: 'oz' },
        ],
        method: ['Shake with ice.', 'Fine strain into the glass.'],
        instructions: 'Garnish and serve immediately.',
        glassware: 'Coupe',
        garnish: 'Lime wheel',
        servings: 1,
        tags: ['classic', 'sour'],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /<img class="recipe-image" src="https:\/\/api\.yourbar\.app\/images\/daiquiri\.webp"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.yourbar\.app\/images\/daiquiri\.webp">/);
  assert.match(html, /White rum/);
  assert.match(html, /<span class="amount">2 oz<\/span>/);
  assert.match(html, /Lime juice/);
  assert.match(html, /\(fresh\)/);
  assert.match(html, /Shake with ice\./);
  assert.match(html, /Fine strain into the glass\./);
  assert.match(html, /Garnish and serve immediately\./);
  assert.match(html, /Coupe/);
  assert.match(html, /Lime wheel/);
  assert.match(html, /classic/);
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


test('well-known apple app site association is generated from configured iOS app IDs', async () => {
  const response = await handleRequest(new Request('https://api.yourbar.app/.well-known/apple-app-site-association'), env({
    IOS_APP_IDS: 'ABCDE12345.app.yourbar.ios, ABCDE12345.app.yourbar.ios.dev',
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.deepEqual(await response.json(), {
    applinks: {
      details: [
        {
          appIDs: ['ABCDE12345.app.yourbar.ios', 'ABCDE12345.app.yourbar.ios.dev'],
          paths: ['/r/*'],
          components: [{ '/': '/r/*', comment: 'Matches YourBar recipe share links' }],
        },
      ],
    },
  });
});

test('well-known android asset links are generated from package and signing fingerprints', async () => {
  const response = await handleRequest(new Request('https://api.yourbar.app/.well-known/assetlinks.json'), env({
    ANDROID_PACKAGE_NAME: 'app.yourbar',
    ANDROID_SHA256_CERT_FINGERPRINTS: '11:22:33, AA:BB:CC',
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'app.yourbar',
        sha256_cert_fingerprints: ['11:22:33', 'AA:BB:CC'],
      },
    },
  ]);
});

test('well-known raw JSON overrides generated association documents', async () => {
  const response = await handleRequest(new Request('https://api.yourbar.app/.well-known/assetlinks.json'), env({
    ANDROID_PACKAGE_NAME: 'app.yourbar',
    ANDROID_SHA256_CERT_FINGERPRINTS: '11:22:33',
    ANDROID_ASSET_LINKS_JSON: '[{"custom":true}]',
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ custom: true }]);
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



test('route integration reuses an existing recipe share for duplicate recipes', async () => {
  const bindings = env({ DEFAULT_RECIPE_TTL_SECONDS: '60' });
  const first = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validPayload),
  }), bindings);
  const second = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...validPayload,
      recipe: {
        ingredients: validPayload.recipe.ingredients,
        name: ` ${validPayload.recipe.name} `,
      },
      source: { app: 'yourbar', appVersion: '2.0.0', platform: 'android' },
    }),
  }), bindings);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);

  const created = await first.json();
  const duplicate = await second.json();
  assert.equal(duplicate.id, created.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recipeChecksum, created.recipeChecksum);
});

test('route integration uploads and serves a recipe image using mocked R2', async () => {
  const bindings = env({ RECIPE_IMAGES: new MockR2(), MAX_IMAGE_BYTES: '1024' });
  const form = new FormData();
  form.set('image', new File([new Uint8Array([1, 2, 3, 4])], 'daiquiri.webp', { type: 'image/webp' }));

  const upload = await handleRequest(new Request('https://api.yourbar.app/api/images', {
    method: 'POST',
    headers: { Origin: 'https://mobile.example' },
    body: form,
  }), bindings);

  assert.equal(upload.status, 201);
  assert.equal(upload.headers.get('Access-Control-Allow-Origin'), '*');
  const uploaded = await upload.json();

  assert.match(uploaded.key, /^[0-9a-f-]+\.webp$/);
  assert.equal(uploaded.imageUrl, `https://api.yourbar.app/images/${uploaded.key}`);

  const image = await handleRequest(new Request(uploaded.imageUrl), bindings);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/webp');
  assert.equal(image.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test('image upload rejects unsupported content types', async () => {
  const bindings = env({ RECIPE_IMAGES: new MockR2() });
  const form = new FormData();
  form.set('image', new File(['not an image'], 'notes.txt', { type: 'text/plain' }));

  const response = await handleRequest(new Request('https://api.yourbar.app/api/images', {
    method: 'POST',
    body: form,
  }), bindings);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'validation_failed');
});

test('image upload enforces configured max size', async () => {
  const bindings = env({ RECIPE_IMAGES: new MockR2(), MAX_IMAGE_BYTES: '3' });
  const form = new FormData();
  form.set('image', new File([new Uint8Array([1, 2, 3, 4])], 'daiquiri.png', { type: 'image/png' }));

  const response = await handleRequest(new Request('https://api.yourbar.app/api/images', {
    method: 'POST',
    body: form,
  }), bindings);

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'payload_too_large');
});
