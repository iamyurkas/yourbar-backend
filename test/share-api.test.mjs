import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecipeId, isValidRecipeId } from '../dist/ids.js';
import { corsPreflight, escapeHtml, jsonError, withCors } from '../dist/http.js';
import { handleRequest, recipeChecksum, renderHomePage, renderRecipeLandingPage, scheduled } from '../dist/index.js';
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
    return type === 'json' ? JSON.parse(value.value) : value.value;
  }
  async put(key, value, options = {}) {
    this.values.set(key, { value, expirationTtl: options.expirationTtl });
  }
  async delete(key) {
    this.values.delete(key);
  }
}

class MockR2 {
  values = new Map();
  putCount = 0;
  async put(key, value, options = {}) {
    this.putCount += 1;
    this.values.set(key, {
      body: value,
      httpEtag: 'mock-etag',
      contentType: options.httpMetadata?.contentType,
      customMetadata: options.customMetadata,
    });
  }
  async get(key) {
    const value = this.values.get(key);
    if (!value) return null;
    return {
      body: value.body,
      httpEtag: value.httpEtag,
      customMetadata: value.customMetadata,
      writeHttpMetadata(headers) {
        if (value.contentType) headers.set('Content-Type', value.contentType);
      },
    };
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list() {
    return {
      objects: [...this.values.entries()].map(([key, value]) => ({ key, customMetadata: value.customMetadata })),
      truncated: false,
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

test('payload validation accepts substitute ingredients with amount and unit metadata', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      ingredients: [
        {
          name: 'Lime juice',
          amount: 30,
          unitId: 'unit-ml',
          unitName: 'ml',
          substitutes: [
            {
              id: 'ingredient-lemon-juice',
              baseIngredientId: [
                { id: 'base-ingredient-lemon', name: 'Lemon', tags: [{ id: 'ingredient-tag-citrus', name: 'Citrus' }] },
              ],
              styleIngredientId: 'style-ingredient-lemon-juice',
              name: 'Lemon juice',
              amount: 25,
              unitId: 'unit-ml',
              unitName: 'ml',
              description: 'Freshly squeezed lemon juice.',
              imageUrl: 'https://api.yourbar.app/images/lemon-juice.webp',
              tags: [{ id: 'ingredient-tag-citrus', name: 'Citrus' }],
            },
          ],
        },
      ],
    },
  });

  assert.equal(result.ok, true);
});

test('payload validation rejects invalid substitute ingredients', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      ingredients: [
        {
          name: 'Lime juice',
          substitutes: [
            { name: '', amount: { value: 25 }, unitName: 12 },
          ],
        },
      ],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].substitutes[0].name'));
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].substitutes[0].amount'));
  assert.ok(result.issues.some((issue) => issue.path === 'recipe.ingredients[0].substitutes[0].unitName'));
});

test('payload validation accepts detailed base and style ingredient arrays', () => {
  const result = validateRecipeSharePayloadV1({
    ...validPayload,
    recipe: {
      ...validPayload.recipe,
      ingredients: [
        {
          name: 'White rum',
          baseIngredientId: [
            {
              id: 'base-ingredient-rum',
              name: 'Rum',
              description: 'A sugarcane spirit.',
              imageUrl: 'https://api.yourbar.app/images/rum.webp',
              tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
            },
          ],
          styleIngredientId: [
            {
              id: 'style-ingredient-white-rum',
              name: 'White rum',
              description: 'A clear rum style.',
              imageUrl: 'https://api.yourbar.app/images/white-rum.webp',
              tags: ['rum'],
            },
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

  assert.match(html, /<title>Your Bar Cocktail App \| Home Bar &amp; Recipe Finder<\/title>/);
  assert.match(html, /<meta name="description" content="Your Bar is a free cocktail app for tracking your home bar, finding recipes you can make, planning parties, and sharing drinks with friends\.">/);
  assert.match(html, /<meta name="robots" content="index, follow, max-image-preview:large">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/api\.yourbar\.app\/">/);
  assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="any">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="\/assets\/images\/favicon\/favicon-32x32\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/assets\/images\/favicon\/apple-icon-180x180\.png">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/api\.yourbar\.app\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.yourbar\.app\/assets\/images\/cocktails\.svg">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@graph":/);
  assert.match(html, /"@type":"MobileApplication"/);
  assert.match(html, /"featureList":\["Track home bar ingredients","Discover cocktails you can make now"/);
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
  assert.match(html, /Completely free\. No ads\./);
  assert.match(html, /No account required for normal use/);
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
          { name: 'Lime juice', amount: 1, unit: 'oz', note: 'fresh', substitutes: [{ name: 'Lemon juice', amount: 0.75, unit: 'oz' }] },
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
  assert.match(html, /<span class="ingredient-name">Lime juice<\/span>/);
  assert.doesNotMatch(html, /Lemon juice/);
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

test('static favicon, home, and store badge assets are served from bundled image files', async () => {
  const faviconResponse = await handleRequest(new Request('https://api.yourbar.app/favicon.ico'), env());
  assert.equal(faviconResponse.status, 200);
  assert.equal(faviconResponse.headers.get('Content-Type'), 'image/x-icon');
  assert.equal(faviconResponse.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal((await faviconResponse.arrayBuffer()).byteLength, 664);

  const faviconPngResponse = await handleRequest(new Request('https://api.yourbar.app/assets/images/favicon/favicon-32x32.png'), env());
  assert.equal(faviconPngResponse.status, 200);
  assert.equal(faviconPngResponse.headers.get('Content-Type'), 'image/png');
  assert.equal((await faviconPngResponse.arrayBuffer()).byteLength, 1337);

  const appleTouchIconResponse = await handleRequest(new Request('https://api.yourbar.app/assets/images/favicon/apple-icon-180x180.png'), env());
  assert.equal(appleTouchIconResponse.status, 200);
  assert.equal(appleTouchIconResponse.headers.get('Content-Type'), 'image/png');
  assert.equal((await appleTouchIconResponse.arrayBuffer()).byteLength, 7954);

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
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
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


test('recipe reads refresh the 30-day retention window in KV', async () => {
  const bindings = env({ DEFAULT_RECIPE_TTL_SECONDS: '60' });
  const create = await handleRequest(new Request('https://api.yourbar.app/api/recipes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validPayload),
  }), bindings);
  const created = await create.json();
  const originalRecord = await bindings.RECIPE_SHARES.get(`recipe:${created.id}`, 'json');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const get = await handleRequest(new Request(created.apiUrl), bindings);

  assert.equal(get.status, 200);
  const refreshed = await get.json();
  assert.equal(refreshed.id, created.id);
  assert.ok(Date.parse(refreshed.lastAccessedAt) >= Date.parse(originalRecord.lastAccessedAt));
  assert.ok(Date.parse(refreshed.expiresAt) >= Date.parse(originalRecord.expiresAt));
  assert.equal(bindings.RECIPE_SHARES.values.get(`recipe:${created.id}`).expirationTtl, 60);
  assert.equal(bindings.RECIPE_SHARES.values.get(`recipe-checksum:${created.recipeChecksum}`).expirationTtl, 60);
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
          baseIngredientId: [
            {
              id: 'base-ingredient-rum',
              name: 'Rum',
              description: 'Sugarcane spirit.',
              imageUrl: 'https://api.yourbar.app/images/base-rum.webp',
              tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
            },
          ],
          styleIngredientId: [
            {
              id: 'style-ingredient-rum',
              name: 'Aged rum',
              description: 'Rum with barrel character.',
              imageUrl: 'https://api.yourbar.app/images/style-rum.webp',
              tags: ['rum'],
            },
          ],
          name: 'Rum',
          amount: 60,
          unitId: 'unit-ml',
          unitName: 'ml',
          description: 'Base spirit.',
          imageUrl: 'https://api.yourbar.app/images/rum.webp',
          tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
          substitutes: [
            {
              id: 'ingredient-cachaca',
              name: 'Cachaça',
              amount: 60,
              unitId: 'unit-ml',
              unitName: 'ml',
              description: 'Sugarcane spirit substitute.',
              imageUrl: 'https://api.yourbar.app/images/cachaca.webp',
              tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
            },
          ],
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
  assert.deepEqual(stored.payload.recipe.ingredients[0].baseIngredientId, [
    {
      id: 'base-ingredient-rum',
      name: 'Rum',
      description: 'Sugarcane spirit.',
      imageUrl: 'https://api.yourbar.app/images/base-rum.webp',
      tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
    },
  ]);
  assert.deepEqual(stored.payload.recipe.ingredients[0].styleIngredientId, [
    {
      id: 'style-ingredient-rum',
      name: 'Aged rum',
      description: 'Rum with barrel character.',
      imageUrl: 'https://api.yourbar.app/images/style-rum.webp',
      tags: ['rum'],
    },
  ]);
  assert.equal(stored.payload.recipe.ingredients[0].unitId, 'unit-ml');
  assert.equal(stored.payload.recipe.ingredients[0].unitName, 'ml');
  assert.equal(stored.payload.recipe.ingredients[0].description, 'Base spirit.');
  assert.equal(stored.payload.recipe.ingredients[0].imageUrl, 'https://api.yourbar.app/images/rum.webp');
  assert.deepEqual(stored.payload.recipe.ingredients[0].tags, [{ id: 'ingredient-tag-spirit', name: 'Spirit' }]);
  assert.deepEqual(stored.payload.recipe.ingredients[0].substitutes, [
    {
      id: 'ingredient-cachaca',
      name: 'Cachaça',
      amount: 60,
      unitId: 'unit-ml',
      unitName: 'ml',
      description: 'Sugarcane spirit substitute.',
      imageUrl: 'https://api.yourbar.app/images/cachaca.webp',
      tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }],
    },
  ]);
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
  assert.equal(image.headers.get('Cache-Control'), 'public, no-cache');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test('image upload reuses an existing image with the same bytes', async () => {
  const bucket = new MockR2();
  const bindings = env({ RECIPE_IMAGES: bucket, MAX_IMAGE_BYTES: '1024' });

  const firstForm = new FormData();
  firstForm.set('image', new File([new Uint8Array([1, 2, 3, 4])], 'first.webp', { type: 'image/webp' }));
  const first = await handleRequest(new Request('https://api.yourbar.app/api/images', {
    method: 'POST',
    body: firstForm,
  }), bindings);

  const secondForm = new FormData();
  secondForm.set('image', new File([new Uint8Array([1, 2, 3, 4])], 'second.webp', { type: 'image/webp' }));
  const second = await handleRequest(new Request('https://api.yourbar.app/api/images', {
    method: 'POST',
    body: secondForm,
  }), bindings);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);

  const created = await first.json();
  const duplicate = await second.json();
  assert.match(created.key, /^[0-9a-f]{64}\.webp$/);
  assert.equal(created.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.key, created.key);
  assert.equal(duplicate.imageUrl, created.imageUrl);
  assert.equal(duplicate.imageChecksum, created.imageChecksum);
  assert.equal(bucket.values.size, 1);
  assert.equal(bucket.putCount, 2);
});



test('scheduled cleanup removes images after their retention window expires', async () => {
  const bucket = new MockR2();
  const bindings = env({ RECIPE_IMAGES: bucket });
  await bucket.put('expired.webp', new Uint8Array([1, 2, 3]).buffer, {
    httpMetadata: { contentType: 'image/webp' },
    customMetadata: { imageChecksum: 'abc123', expiresAt: new Date(Date.now() - 1_000).toISOString() },
  });
  await bindings.RECIPE_SHARES.put('image-access:expired.webp', '1', { expirationTtl: 60 });
  await bindings.RECIPE_SHARES.put('image-checksum:abc123', 'expired.webp', { expirationTtl: 60 });

  await scheduled({}, bindings);

  assert.equal(bucket.values.has('expired.webp'), false);
  assert.equal(await bindings.RECIPE_SHARES.get('image-access:expired.webp'), null);
  assert.equal(await bindings.RECIPE_SHARES.get('image-checksum:abc123'), null);
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

class MockD1Statement {
  constructor(db, query) { this.db = db; this.query = query.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { const stmt = new MockD1Statement(this.db, this.query); stmt.values = values; return stmt; }
  async first() { const results = await this.db.execute(this.query, this.values); return results.results?.[0] ?? null; }
  async all() { return this.db.execute(this.query, this.values); }
  async run() { return this.db.execute(this.query, this.values); }
}

class MockD1 {
  submissions = new Map();
  recipes = new Map();
  saves = new Map();
  ratings = new Map();
  audit = [];
  prepare(query) { return new MockD1Statement(this, query); }
  async batch(statements) { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; }
  saveKey(recipeId, userId) { return `${recipeId}:${userId}`; }
  ratingKey(recipeId, userId) { return `${recipeId}:${userId}`; }
  withUserRows(rows, values) {
    const [ratingUser, saveUser] = values;
    return rows.map((row) => ({
      ...row,
      current_user_rating: this.ratings.get(this.ratingKey(row.id, ratingUser))?.rating ?? null,
      is_saved_by_current_user: this.saves.has(this.saveKey(row.id, saveUser)) ? 1 : 0,
    }));
  }
  async execute(query, values) {
    if (query.startsWith('INSERT INTO community_submissions')) {
      const [id, submitter_user_id, submitter_google_login, payload_json, recipe_checksum, created_at] = values;
      this.submissions.set(id, { id, submitter_user_id, submitter_google_login, payload_json, recipe_checksum, status: 'pending', rejection_reason: null, moderator_notes: null, created_at, reviewed_at: null, reviewed_by: null });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith('SELECT * FROM community_submissions WHERE id =')) {
      return { results: this.submissions.has(values[0]) ? [this.submissions.get(values[0])] : [] };
    }
    if (query.startsWith('SELECT * FROM community_submissions WHERE status =')) {
      const [status, limit, offset] = values;
      const rows = [...this.submissions.values()].filter((row) => row.status === status).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(offset, offset + limit);
      return { results: rows };
    }
    if (query.startsWith('SELECT * FROM community_recipes WHERE submission_id =')) {
      return { results: [...this.recipes.values()].filter((row) => row.submission_id === values[0]) };
    }
    if (query.startsWith('INSERT INTO community_recipes')) {
      const [id, submission_id, payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, author_google_login, published_at, updated_at] = values;
      this.recipes.set(id, { id, submission_id, payload_json, recipe_checksum, status: 'published', save_count: 0, rating_count: 0, rating_sum: 0, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, author_google_login, published_at, updated_at });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_recipes SET payload_json')) {
      const [payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, author_google_login, updated_at, id] = values;
      const row = this.recipes.get(id); Object.assign(row, { payload_json, recipe_checksum, status: 'published', name_normalized, search_tokens_json, tag_ids_json, method_ids_json, author_google_login, updated_at });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_submissions SET status = \'approved\'')) {
      const [reviewed_at, reviewed_by, moderator_notes, id] = values;
      Object.assign(this.submissions.get(id), { status: 'approved', reviewed_at, reviewed_by, moderator_notes, rejection_reason: null });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_submissions SET status = \'rejected\'')) {
      const [reviewed_at, reviewed_by, rejection_reason, moderator_notes, id] = values;
      Object.assign(this.submissions.get(id), { status: 'rejected', reviewed_at, reviewed_by, rejection_reason, moderator_notes });
      return { meta: { changes: 1 } };
    }
    if (query.startsWith('INSERT INTO admin_moderation_events')) {
      this.audit.push({ values }); return { meta: { changes: 1 } };
    }
    if (query.startsWith('SELECT * FROM community_recipes WHERE id =')) {
      const row = this.recipes.get(values[0]); return { results: row && row.status === 'published' ? [row] : [] };
    }
    if (query.startsWith('SELECT r.*, ur.rating') && query.includes('WHERE r.id =')) {
      const recipeId = values[2]; const row = this.recipes.get(recipeId);
      return { results: row && row.status === 'published' ? this.withUserRows([row], values) : [] };
    }
    if (query.startsWith('SELECT r.*, NULL') && query.includes('WHERE r.id =')) {
      const row = this.recipes.get(values[0]);
      return { results: row && row.status === 'published' ? [{ ...row, current_user_rating: null, is_saved_by_current_user: null }] : [] };
    }
    if (query.startsWith('SELECT r.*')) {
      const hasUser = query.includes('LEFT JOIN community_recipe_ratings');
      const userValues = hasUser ? values.slice(0, 2) : [];
      let paramIndex = hasUser ? 2 : 0;
      let rows = [...this.recipes.values()].filter((row) => row.status === 'published');
      if (query.includes('name_normalized LIKE')) {
        const q = String(values[paramIndex]).replaceAll('%', ''); paramIndex += 2;
        rows = rows.filter((row) => row.name_normalized.includes(q) || row.search_tokens_json.includes(q));
      }
      if (query.includes('r.tag_ids_json LIKE')) {
        const wanted = String(values[paramIndex++]).replaceAll('%', '').replaceAll('"', '');
        rows = rows.filter((row) => JSON.parse(row.tag_ids_json).includes(wanted));
      }
      if (query.includes('r.method_ids_json LIKE')) {
        const wanted = String(values[paramIndex++]).replaceAll('%', '').replaceAll('"', '');
        rows = rows.filter((row) => JSON.parse(row.method_ids_json).includes(wanted));
      }
      if (query.includes('rating_count DESC')) rows.sort((a, b) => b.rating_count - a.rating_count || b.rating_sum - a.rating_sum);
      else if (query.includes('save_count DESC')) rows.sort((a, b) => b.save_count - a.save_count);
      else if (query.includes('name_normalized ASC')) rows.sort((a, b) => a.name_normalized.localeCompare(b.name_normalized));
      else rows.sort((a, b) => b.published_at.localeCompare(a.published_at));
      const limit = values.at(-2); const offset = values.at(-1);
      rows = rows.slice(offset, offset + limit);
      return { results: hasUser ? this.withUserRows(rows, userValues) : rows.map((row) => ({ ...row, current_user_rating: null, is_saved_by_current_user: null })) };
    }
    if (query.startsWith('INSERT OR IGNORE INTO community_recipe_saves')) {
      const [recipe_id, user_id, created_at] = values; const key = this.saveKey(recipe_id, user_id);
      if (this.saves.has(key)) return { meta: { changes: 0 } };
      this.saves.set(key, { recipe_id, user_id, created_at }); return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_recipes SET save_count = save_count + 1')) {
      const [, id] = values; this.recipes.get(id).save_count += 1; return { meta: { changes: 1 } };
    }
    if (query.startsWith('DELETE FROM community_recipe_saves')) {
      const [recipe_id, user_id] = values; const key = this.saveKey(recipe_id, user_id); const existed = this.saves.delete(key);
      return { meta: { changes: existed ? 1 : 0 } };
    }
    if (query.startsWith('UPDATE community_recipes SET save_count = MAX')) {
      const [, id] = values; const row = this.recipes.get(id); row.save_count = Math.max(row.save_count - 1, 0); return { meta: { changes: 1 } };
    }
    if (query.startsWith('SELECT rating FROM community_recipe_ratings')) {
      const [recipe_id, user_id] = values; const rating = this.ratings.get(this.ratingKey(recipe_id, user_id)); return { results: rating ? [rating] : [] };
    }
    if (query.startsWith('INSERT INTO community_recipe_ratings')) {
      const [recipe_id, user_id, rating, created_at, updated_at] = values; this.ratings.set(this.ratingKey(recipe_id, user_id), { recipe_id, user_id, rating, created_at, updated_at }); return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_recipe_ratings')) {
      const [rating, updated_at, recipe_id, user_id] = values; Object.assign(this.ratings.get(this.ratingKey(recipe_id, user_id)), { rating, updated_at }); return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_recipes SET rating_count = rating_count + 1')) {
      const [rating, , id] = values; const row = this.recipes.get(id); row.rating_count += 1; row.rating_sum += rating; return { meta: { changes: 1 } };
    }
    if (query.startsWith('UPDATE community_recipes SET rating_sum = rating_sum +')) {
      const [delta, , id] = values; this.recipes.get(id).rating_sum += delta; return { meta: { changes: 1 } };
    }
    if (query.startsWith('DELETE FROM community_recipe_ratings')) {
      const [recipe_id, user_id] = values; const existed = this.ratings.delete(this.ratingKey(recipe_id, user_id)); return { meta: { changes: existed ? 1 : 0 } };
    }
    if (query.startsWith('UPDATE community_recipes SET rating_count = MAX')) {
      const [rating, , id] = values; const row = this.recipes.get(id); row.rating_count = Math.max(row.rating_count - 1, 0); row.rating_sum = Math.max(row.rating_sum - rating, 0); return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled D1 query: ${query}`);
  }
}

function communityEnv(overrides = {}) {
  return env({
    YOURBAR_DB: new MockD1(),
    COMMUNITY_FEATURE_ENABLED: 'true',
    COMMUNITY_SUBMISSIONS_ENABLED: 'true',
    COMMUNITY_ADMIN_ENABLED: 'true',
    COMMUNITY_PUBLIC_FEED_ENABLED: 'true',
    AUTH_TRUSTED_USER_HEADER_ENABLED: 'true',
    ...overrides,
  });
}

const richCommunityPayload = {
  ...validPayload,
  submitterGoogleLogin: 'Author@Gmail.com',
  recipe: {
    name: 'Community Daiquiri',
    description: 'A bright classic.',
    instructions: ['Shake with ice', 'Strain into coupe'],
    ingredients: [{ id: 'ing-rum', name: 'Rum', amount: 60, unitId: 'ml', unitName: 'ml', description: 'White rum', imageUrl: 'https://api.yourbar.app/images/rum.webp', tags: [{ id: 'ingredient-tag-spirit', name: 'Spirit' }], optional: false, garnish: false }],
    tags: [{ id: 'tag-classic', name: 'Classic' }],
    method: { id: 'method-shaken', name: 'Shaken' },
    methodId: 'method-shaken',
    methodName: 'Shaken',
    glasswareId: 'glass-coupe',
    glasswareName: 'Coupe',
    garnish: 'Lime wheel',
    servings: 1,
    imageUrl: 'https://api.yourbar.app/images/daiquiri.webp',
    video: 'https://www.youtube.com/watch?v=daiquiri-demo',
  },
};

async function createAndApproveCommunityRecipe(bindings, payload = richCommunityPayload) {
  const submissionResponse = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'user-1' }, body: JSON.stringify(payload),
  }), bindings);
  assert.equal(submissionResponse.status, 201);
  const submission = await submissionResponse.json();
  const approveResponse = await handleRequest(new Request(`https://api.yourbar.app/api/admin/community/submissions/${submission.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'CF-Access-Authenticated-User-Email': 'admin@example.com' }, body: JSON.stringify({ action: 'approve', moderatorNotes: 'Looks good' }),
  }), bindings);
  assert.equal(approveResponse.status, 200);
  return approveResponse.json();
}

test('community feature is disabled by default without changing personal share routes', async () => {
  const bindings = env();
  const community = await handleRequest(new Request('https://api.yourbar.app/api/community/recipes'), bindings);
  assert.equal(community.status, 404);
  const personal = await handleRequest(new Request('https://api.yourbar.app/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validPayload) }), bindings);
  assert.equal(personal.status, 201);
});

test('community submission validates shared RecipeSharePayloadV1 and creates pending record from auth user', async () => {
  const bindings = communityEnv();
  const response = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'real-user' }, body: JSON.stringify({ ...richCommunityPayload, userId: 'spoofed' }),
  }), bindings);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, 'pending');
  assert.ok(body.recipeChecksum);
  assert.equal(body.submitterGoogleLogin, 'author@gmail.com');
  const storedSubmission = [...bindings.YOURBAR_DB.submissions.values()][0];
  assert.equal(storedSubmission.submitter_user_id, 'real-user');
  assert.equal(storedSubmission.submitter_google_login, 'author@gmail.com');
  assert.equal(JSON.parse(storedSubmission.payload_json).submitterGoogleLogin, undefined);

  const missingGoogleLogin = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'real-user' }, body: JSON.stringify({ ...richCommunityPayload, submitterGoogleLogin: undefined, googleLogin: undefined, authorGoogleLogin: undefined }),
  }), bindings);
  assert.equal(missingGoogleLogin.status, 400);
  assert.equal((await missingGoogleLogin.json()).error.code, 'validation_failed');

  const invalid = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'real-user' }, body: JSON.stringify({ ...richCommunityPayload, recipe: { ...richCommunityPayload.recipe, name: '' } }),
  }), bindings);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'validation_failed');
});

test('community admin can reject and non-admin cannot moderate submissions', async () => {
  const bindings = communityEnv();
  const created = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'user-1' }, body: JSON.stringify(richCommunityPayload) }), bindings);
  const submission = await created.json();
  const nonAdmin = await handleRequest(new Request(`https://api.yourbar.app/api/admin/community/submissions/${submission.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) }), bindings);
  assert.equal(nonAdmin.status, 401);
  const rejected = await handleRequest(new Request(`https://api.yourbar.app/api/admin/community/submissions/${submission.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'CF-Access-Authenticated-User-Email': 'admin@example.com' }, body: JSON.stringify({ action: 'reject', rejectionReason: 'duplicate' }) }), bindings);
  assert.equal(rejected.status, 200);
  const list = await handleRequest(new Request('https://api.yourbar.app/api/community/recipes'), bindings);
  assert.equal((await list.json()).items.length, 0);
});

test('approved community recipe appears in list/detail with full importable recipe payload and filters', async () => {
  const bindings = communityEnv();
  const approved = await createAndApproveCommunityRecipe(bindings);
  const recipeId = approved.communityRecipe.id;
  const list = await handleRequest(new Request('https://api.yourbar.app/api/community/recipes?limit=1&sort=newest&q=daiquiri&tagIds=tag-classic&methodIds=method-shaken'), bindings);
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, recipeId);
  assert.equal(body.items[0].recipe.name, richCommunityPayload.recipe.name);
  assert.deepEqual(body.items[0].recipe.ingredients, richCommunityPayload.recipe.ingredients);
  assert.deepEqual(body.items[0].recipe.tags, richCommunityPayload.recipe.tags);
  assert.equal(body.items[0].recipe.methodId, 'method-shaken');
  assert.equal(body.items[0].recipe.glasswareName, 'Coupe');
  assert.equal(body.items[0].recipe.imageUrl, richCommunityPayload.recipe.imageUrl);
  assert.equal(body.items[0].recipe.video, richCommunityPayload.recipe.video);
  assert.equal(body.items[0].authorGoogleLogin, 'author@gmail.com');
  assert.equal(body.items[0].source.authorGoogleLogin, 'author@gmail.com');
  const detail = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}`), bindings);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).recipe.name, richCommunityPayload.recipe.name);
});

test('community list supports sort modes and authenticated personalization', async () => {
  const bindings = communityEnv();
  const first = await createAndApproveCommunityRecipe(bindings, { ...richCommunityPayload, recipe: { ...richCommunityPayload.recipe, name: 'B Cocktail' } });
  const second = await createAndApproveCommunityRecipe(bindings, { ...richCommunityPayload, recipe: { ...richCommunityPayload.recipe, name: 'A Cocktail' } });
  bindings.YOURBAR_DB.recipes.get(first.communityRecipe.id).save_count = 5;
  bindings.YOURBAR_DB.recipes.get(second.communityRecipe.id).rating_count = 2;
  bindings.YOURBAR_DB.recipes.get(second.communityRecipe.id).rating_sum = 10;
  for (const sort of ['newest', 'topRated', 'mostSaved', 'alphabetical', 'random']) {
    const response = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes?sort=${sort}&seed=s&limit=1`), bindings);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 1);
  }
  await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${first.communityRecipe.id}/save`, { method: 'POST', headers: { 'X-YourBar-User-Id': 'user-2' } }), bindings);
  await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${first.communityRecipe.id}/rating`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'user-2' }, body: JSON.stringify({ rating: 4 }) }), bindings);
  const personalized = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${first.communityRecipe.id}`, { headers: { 'X-YourBar-User-Id': 'user-2' } }), bindings);
  const body = await personalized.json();
  assert.equal(body.isSavedByCurrentUser, true);
  assert.equal(body.currentUserRating, 4);
});

test('community save is idempotent, returns import DTO, and unsave decrements once', async () => {
  const bindings = communityEnv();
  const approved = await createAndApproveCommunityRecipe(bindings);
  const recipeId = approved.communityRecipe.id;
  const req = () => new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}/save`, { method: 'POST', headers: { 'X-YourBar-User-Id': 'user-1' } });
  const first = await handleRequest(req(), bindings);
  const second = await handleRequest(req(), bindings);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const firstBody = await first.json(); const secondBody = await second.json();
  assert.equal(firstBody.saveCount, 1);
  assert.equal(secondBody.saveCount, 1);
  assert.equal(firstBody.import.kind, 'yourbar.communityRecipeImport');
  assert.deepEqual(firstBody.import.recipe, richCommunityPayload.recipe);
  const unsave1 = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}/save`, { method: 'DELETE', headers: { 'X-YourBar-User-Id': 'user-1' } }), bindings);
  const unsave2 = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}/save`, { method: 'DELETE', headers: { 'X-YourBar-User-Id': 'user-1' } }), bindings);
  assert.equal((await unsave1.json()).saveCount, 0);
  assert.equal((await unsave2.json()).saveCount, 0);
});

test('community rating create update delete adjusts aggregate statistics', async () => {
  const bindings = communityEnv();
  const approved = await createAndApproveCommunityRecipe(bindings);
  const recipeId = approved.communityRecipe.id;
  const put = (rating) => handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}/rating`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-YourBar-User-Id': 'user-1' }, body: JSON.stringify({ rating }) }), bindings);
  let body = await (await put(5)).json();
  assert.equal(body.ratingCount, 1); assert.equal(body.averageRating, 5);
  body = await (await put(3)).json();
  assert.equal(body.ratingCount, 1); assert.equal(body.averageRating, 3);
  body = await (await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${recipeId}/rating`, { method: 'DELETE', headers: { 'X-YourBar-User-Id': 'user-1' } }), bindings)).json();
  assert.equal(body.ratingCount, 0); assert.equal(body.averageRating, 0); assert.equal(body.currentUserRating, null);
});

test('unauthenticated users cannot submit save or rate community recipes', async () => {
  const bindings = communityEnv();
  const submit = await handleRequest(new Request('https://api.yourbar.app/api/community/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(richCommunityPayload) }), bindings);
  assert.equal(submit.status, 401);
  const approved = await createAndApproveCommunityRecipe(bindings);
  const save = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${approved.communityRecipe.id}/save`, { method: 'POST' }), bindings);
  assert.equal(save.status, 401);
  const rating = await handleRequest(new Request(`https://api.yourbar.app/api/community/recipes/${approved.communityRecipe.id}/rating`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: 5 }) }), bindings);
  assert.equal(rating.status, 401);
});
