import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipeId, isValidRecipeId } from '../dist/ids.js';
import { corsPreflight, escapeHtml, jsonError, withCors } from '../dist/http.js';
import { handleRequest, recipeChecksum, renderHomePage, renderRecipeLandingPage } from '../dist/index.js';
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

test('payload validation accepts a recipe video URL', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: { ...validPayload.recipe, video: 'https://www.youtube.com/watch?v=daiquiri-demo' },
  });

  assert.equal(result.ok, true);
});

test('payload validation accepts unit, glassware, method, and tag ids with display names', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      glasswareId: 'coupe-glass',
      glasswareName: 'Coupe',
      method: { id: 'method-shaken', name: 'Shaken' },
      methodId: 'method-shaken',
      methodName: 'Shaken',
      tags: [{ id: 'tag-classic', name: 'Classic' }, 'rum'],
      ingredients: [
        { name: 'Rum', amount: 60, unitId: 'ml', unitName: 'ml' },
        { name: 'Lime juice', amount: 30, unitId: 'ml', unitName: 'ml' },
      ],
    },
  });

  assert.equal(result.ok, true);
});


test('payload validation accepts rich ingredient metadata', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      ingredients: [
        {
          id: 'ingredient-white-rum',
          baseIngredientId: 'base-ingredient-rum',
          styleIngredientId: 'style-ingredient-white-rum',
          name: 'White rum',
          amount: 60,
          unitId: 'unit-ml',
          unitName: 'ml',
          description: 'A light-bodied rum for sours.',
          imageUrl: 'https://api.yourbar.app/images/white-rum.webp',
          tags: [
            { id: 'ingredient-tag-spirit', name: 'Spirit' },
            { id: 'ingredient-tag-rum', name: 'Rum' },
          ],
        },
      ],
    },
  });

  assert.equal(result.ok, true);
});

test('payload validation rejects invalid rich ingredient metadata', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      ingredients: [
        {
          name: 'White rum',
          baseIngredientId: 123,
          styleIngredientId: {},
          imageUrl: 'not-a-url',
          tags: [{ id: '', name: 'Spirit' }],
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].baseIngredientId'));
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].styleIngredientId'));
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].imageUrl'));
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].tags[0].id'));
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

test('payload validation rejects invalid video URL', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: { ...validPayload.recipe, video: 'ftp://example.com/video' },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.video'));
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

test('home page presents the app logo, description, and store links', async () => {
  const html = renderHomePage(env());

  assert.match(html, /<h1 id="app-title">Your Bar<\/h1>/);
  assert.match(html, /--brand-blue: #4DABF7;/);
  assert.match(html, /width: min\(1230px, 100%\);/);
  assert.match(html, /<img src="\/assets\/images\/cocktails\.svg" alt="" aria-hidden="true">/);
  assert.match(html, /filter: brightness\(0\) invert\(1\);/);
  assert.match(html, /Your Bar helps you discover cocktails you can actually make\./);
  assert.match(html, /Add the ingredients you already have and instantly see which cocktails are available\./);
  assert.match(html, /Track ingredients and build your home bar/);
  assert.match(html, /Add ingredients manually or by scanning barcodes/);
  assert.match(html, /Share cocktail recipes with friends using public links/);
  assert.match(html, /Open shared recipes and import them into your bar/);
  assert.match(html, /Optionally sync your bars, ingredients, cocktails, and settings via Google Drive/);
  assert.match(html, /\(rum OR gin\) AND \(campari OR aperol\)/);
  assert.match(html, /Completely free\. No ads\. No account required for normal use\./);
  assert.match(html, /<a class="store-badge" href="https:\/\/apps\.apple\.com\/app\/your-bar-cocktail-recipes\/id6758964503" aria-label="Download YourBar on the App Store"><img src="\/assets\/images\/appstore\.png" alt="Download on the App Store" loading="lazy"><\/a>/);
  assert.match(html, /<a class="store-badge" href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.yourbarapp\.free" aria-label="Get YourBar on Google Play"><img src="\/assets\/images\/playmarket\.png" alt="Get it on Google Play" loading="lazy"><\/a>/);

  const response = await handleRequest(new Request('https://api.yourbar.app/'), env());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(await response.text(), /<main class="page">/);
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
          {
            name: 'White rum',
            amount: 2,
            unit: 'oz',
            description: 'A **clean** base spirit.',
            imageUrl: 'https://api.yourbar.app/images/white-rum.webp',
            tags: [{ id: 'ingredient-tag-base-spirit', name: 'Base spirit' }, { id: 'ingredient-tag-liqueur', name: 'Liqueur' }],
          },
          { name: 'Lime juice', amount: 1, unit: 'oz', note: 'fresh' },
          { name: 'Simple syrup', amount: 0.75, unit: 'oz' },
        ],
        method: ['Shake with ice.', 'Fine strain into the glass.'],
        instructions: 'Garnish and serve immediately.',
        glassware: 'Coupe',
        garnish: 'Lime wheel',
        servings: 1,
        tags: ['classic', 'Equal Parts', 'Medium', 'Shot'],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /<main class="app-detail-screen">/);
  assert.match(html, /<div class="top-bar">/);
  assert.match(html, /<header class="recipe-header">/);
  assert.doesNotMatch(html, /<article class="hero-card">/);
  assert.match(html, /<section class="action-panel">/);
  assert.match(html, /--background: #0B1017;/);
  assert.match(html, /--surface: #0F1720;/);
  assert.match(html, /--surface-bright: #1B2733;/);
  assert.match(html, /--primary: #9CCAFF;/);
  assert.match(html, /--on-primary: #001529;/);
  assert.match(html, /\.cocktail-image-frame \{[\s\S]*?background: #ffffff;[\s\S]*?overflow: hidden;/);
  assert.match(html, /\.cocktail-image \{[\s\S]*?object-fit: contain;/);
  assert.match(html, /\.ingredient-thumb \{[\s\S]*?background: #ffffff;[\s\S]*?flex: 0 0 auto;/);
  assert.match(html, /\.ingredient-thumb img \{[\s\S]*?object-fit: contain;/);
  assert.doesNotMatch(html, /#ff8a3d/i);
  assert.doesNotMatch(html, /#fff7ed/i);
  assert.doesNotMatch(html, /#c7b8aa/i);
  assert.match(html, /<link rel="canonical" href="https:\/\/api\.yourbar\.app\/r\/23456789AB">/);
  assert.match(html, /<link rel="alternate" type="application\/json" href="https:\/\/api\.yourbar\.app\/api\/recipes\/23456789AB">/);
  assert.match(html, /<div class="cocktail-image-frame"><img class="cocktail-image" src="https:\/\/api\.yourbar\.app\/images\/daiquiri\.webp"/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.yourbar\.app\/images\/daiquiri\.webp">/);
  assert.match(html, /White rum/);
  assert.match(html, /<span class="ingredient-amount">2 oz<\/span>/);
  assert.match(html, /<div class="ingredient-thumb"><img src="https:\/\/api\.yourbar\.app\/images\/white-rum\.webp"/);
  assert.match(html, /A <strong>clean<\/strong> base spirit\./);
  assert.match(html, /<span class="ingredient-tag" style="--tag-color: #707070">Base spirit<\/span>/);
  assert.match(html, /<span class="ingredient-tag" style="--tag-color: #ec5a5a">Liqueur<\/span>/);
  assert.match(html, /Lime juice/);
  assert.match(html, /<span class="note">fresh<\/span>/);
  assert.match(html, /Shake with ice\./);
  assert.match(html, /Fine strain into the glass\./);
  assert.match(html, /Garnish and serve immediately\./);
  assert.match(html, /Coupe/);
  assert.match(html, /Lime wheel/);
  assert.match(html, /<span class="tag-chip" style="--tag-color: #9CCAFF">classic<\/span>/);
  assert.match(html, /<span class="tag-chip" style="--tag-color: #64B5F6">Equal Parts<\/span>/);
  assert.match(html, /<span class="tag-chip" style="--tag-color: #F06292">Medium<\/span>/);
  assert.match(html, /<span class="tag-chip" style="--tag-color: #FF8A65">Shot<\/span>/);
  assert.match(html, /<details class="share-menu">/);
  assert.match(html, /<summary class="button share-trigger">Share cocktail<\/summary>/);
  assert.match(html, /<div class="share-popover" role="dialog" aria-label="Share cocktail">/);
  assert.match(html, /<a class="button secondary-button" href="https:\/\/api\.yourbar\.app\/images\/daiquiri\.webp" download>Export as photo<\/a>/);
  assert.match(html, /<button class="button secondary-button" type="button" data-share-link="https:\/\/api\.yourbar\.app\/r\/23456789AB">Share as link<\/button>/);
  assert.match(html, /const shareButton = document\.querySelector\('\[data-share-link\]'\);/);
  assert.match(html, /<div class="store-badges">/);
  assert.match(html, /<a class="store-badge" href="https:\/\/apps\.apple\.com\/app\/your-bar-cocktail-recipes\/id6758964503" aria-label="Download YourBar on the App Store"><img src="\/assets\/images\/appstore\.png" alt="Download on the App Store" loading="lazy"><\/a>/);
  assert.match(html, /<a class="store-badge" href="https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.yourbarapp\.free" aria-label="Get YourBar on Google Play"><img src="\/assets\/images\/playmarket\.png" alt="Get it on Google Play" loading="lazy"><\/a>/);
  assert.doesNotMatch(html, /<h2>Canonical API URL<\/h2>/);
});

test('landing page renders a tertiary-colored service icon link for recipe video', () => {
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        video: 'https://www.youtube.com/watch?v=daiquiri-demo',
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /--tertiary: #ff3366;/);
  assert.match(html, /\.video-link \{[\s\S]*?color: var\(--tertiary\);/);
  assert.match(html, /<a class="video-link" href="https:\/\/www\.youtube\.com\/watch\?v=daiquiri-demo" target="_blank" rel="noopener noreferrer" aria-label="Watch cocktail video on YouTube" title="Watch on YouTube">[\s\S]*?<span>YouTube<\/span><\/a>/);
});

test('static home and store badge assets are served from bundled image files', async () => {
  const logoResponse = await handleRequest(new Request('https://api.yourbar.app/assets/images/cocktails.svg'), env());
  assert.equal(logoResponse.status, 200);
  assert.equal(logoResponse.headers.get('Content-Type'), 'image/svg+xml');
  assert.equal(logoResponse.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await logoResponse.text()).startsWith('<svg viewBox="0 0 26 24"'), true);

  const appStoreResponse = await handleRequest(new Request('https://api.yourbar.app/assets/images/appstore.png'), env());
  assert.equal(appStoreResponse.status, 200);
  assert.equal(appStoreResponse.headers.get('Content-Type'), 'image/png');
  assert.equal(appStoreResponse.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await appStoreResponse.arrayBuffer()).byteLength, 7161);

  const playMarketResponse = await handleRequest(new Request('https://api.yourbar.app/assets/images/playmarket.png'), env());
  assert.equal(playMarketResponse.status, 200);
  assert.equal(playMarketResponse.headers.get('Content-Type'), 'image/png');
  assert.equal((await playMarketResponse.arrayBuffer()).byteLength, 10320);
});

test('landing page applies required cocktail and ingredient tag colors', () => {
  const cocktailTags = [
    ['IBA Official', '#81C784'],
    [' Equal Parts ', '#64B5F6'],
    ['Bitter', '#9575CD'],
    ['Tiki', '#4DD0E1'],
    ['Strong', '#ec5a5a'],
    ['Medium', '#F06292'],
    ['Soft', '#FFD54F'],
    ['Long', '#FFB74D'],
    ['Shot', '#FF8A65'],
    ['Non-alcoholic', '#CBD664'],
    ['Custom', '#a8a8a8'],
    ['Unknown cocktail tag', '#9CCAFF'],
  ];
  const ingredientTags = [
    ['Base spirit', '#707070'],
    [' liqueur ', '#ec5a5a'],
    ['Wine/Vermouth', '#F06292'],
    ['Beer/Cider', '#9575CD'],
    ['Bitters', '#FF8A65'],
    ['Syrup', '#FFB74D'],
    ['Mixer', '#81C784'],
    ['Fruit/Veg & Juice', '#AED581'],
    ['Fridge/Pantry', '#4FC3F7'],
    ['Other', '#a8a8a8'],
    ['Unknown ingredient tag', '#9CCAFF'],
  ];
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        tags: cocktailTags.map(([name]) => name),
        ingredients: [
          {
            name: 'Tagged ingredient',
            amount: 1,
            unit: 'oz',
            tags: ingredientTags.map(([name]) => ({ id: `ingredient-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name })),
          },
        ],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  for (const [name, color] of cocktailTags) {
    assert.match(html, new RegExp(`<span class="tag-chip" style="--tag-color: ${color}">${escapeHtml(name.trim())}<\\/span>`));
  }
  for (const [name, color] of ingredientTags) {
    assert.match(html, new RegExp(`<span class="ingredient-tag" style="--tag-color: ${color}">${escapeHtml(name.trim())}<\\/span>`));
  }
});

test('landing page prefers display names for units and glassware', () => {
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        glasswareId: 'glass-123',
        glasswareName: 'Nick & Nora',
        ingredients: [
          { name: 'Gin', amount: 45, unitId: 'unit-ml', unitName: 'ml' },
          { name: 'Vermouth', amount: 20, unitId: 'unit-ml', unitName: 'ml' },
        ],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /<span class="ingredient-amount">45 ml<\/span>/);
  assert.match(html, /Nick &amp; Nora/);
  assert.doesNotMatch(html, /glass-123/);
  assert.doesNotMatch(html, /unit-ml/);
});

test('landing page prefers localized method and tag names', () => {
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        method: { id: 'method-shaken', name: 'shake' },
        methodName: 'збовтати',
        tags: [
          { id: 'tag-classic', name: 'Класика' },
          { id: 'tag-sour', name: 'Сауер' },
        ],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /<section>\s*<h2>Method<\/h2>\s*<p>Збовтати<\/p>\s*<\/section>/);
  assert.match(html, /Класика/);
  assert.match(html, /Сауер/);
  assert.doesNotMatch(html, /method-shaken/);
  assert.doesNotMatch(html, /tag-classic/);
});

test('landing page renders inline markup and a single capitalized method without numbering', () => {
  const record = {
    id: '23456789AB',
    payload: {
      ...validPayload,
      recipe: {
        ...validPayload.recipe,
        description: 'A **crisp** Cuban *classic*.',
        method: 'shake',
        instructions: ['Add **rum**.', 'Serve *cold*.'],
      },
    },
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(1_000).toISOString(),
    recipeChecksum: 'test-checksum',
  };

  const html = renderRecipeLandingPage(record, env());

  assert.match(html, /<p class="recipe-description">A <strong>crisp<\/strong> Cuban <em>classic<\/em>\.<\/p>/);
  assert.match(html, /<section>\s*<h2>Method<\/h2>\s*<p>Shake<\/p>\s*<\/section>/);
  assert.match(html, /<li>Add <strong>rum<\/strong>\.<\/li>/);
  assert.match(html, /<li>Serve <em>cold<\/em>\.<\/li>/);
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

test('route integration returns localized display names from recipe JSON', async () => {
  const bindings = env({ DEFAULT_RECIPE_TTL_SECONDS: '60' });
  const payload = {
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      glasswareId: 'glass-123',
      glasswareName: 'Coupe',
      methodId: 'method-shaken',
      methodName: 'Shaken',
      video: 'https://www.instagram.com/reel/daiquiri-demo/',
      tags: [{ id: 'tag-classic', name: 'Classic' }],
      ingredients: [
        {
          id: 'ingredient-rum',
          baseIngredientId: 'base-ingredient-rum',
          styleIngredientId: 'style-ingredient-rum',
          name: 'Rum',
          amount: 60,
          unitId: 'unit-ml',
          unitName: 'ml',
          description: 'Base spirit.',
          imageUrl: 'https://api.yourbar.app/images/rum.webp',
          tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
        },
      ],
    },
  };
  const create = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }), bindings);
  const created = await create.json();

  const get = await handleRequest(new Request(created.apiUrl), bindings);
  assert.equal(get.status, 200);
  const stored = await get.json();
  assert.equal(stored.payload.recipe.glasswareId, 'glass-123');
  assert.equal(stored.payload.recipe.glasswareName, 'Coupe');
  assert.equal(stored.payload.recipe.methodId, 'method-shaken');
  assert.equal(stored.payload.recipe.methodName, 'Shaken');
  assert.equal(stored.payload.recipe.video, 'https://www.instagram.com/reel/daiquiri-demo/');
  assert.deepEqual(stored.payload.recipe.tags, [{ id: 'tag-classic', name: 'Classic' }]);
  assert.equal(stored.payload.recipe.ingredients[0].id, 'ingredient-rum');
  assert.equal(stored.payload.recipe.ingredients[0].baseIngredientId, 'base-ingredient-rum');
  assert.equal(stored.payload.recipe.ingredients[0].styleIngredientId, 'style-ingredient-rum');
  assert.equal(stored.payload.recipe.ingredients[0].unitId, 'unit-ml');
  assert.equal(stored.payload.recipe.ingredients[0].unitName, 'ml');
  assert.equal(stored.payload.recipe.ingredients[0].description, 'Base spirit.');
  assert.equal(stored.payload.recipe.ingredients[0].imageUrl, 'https://api.yourbar.app/images/rum.webp');
  assert.deepEqual(stored.payload.recipe.ingredients[0].tags, [{ id: 'ingredient-tag-spirit', name: 'Spirit' }]);
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
