import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from '../dist/index.js';

const richPayload = {
  schemaVersion: 1,
  kind: 'yourbar.recipeShare',
  recipe: {
    name: 'Garden Daiquiri',
    description: 'A bright community cocktail.',
    instructions: ['Shake with ice', 'Double strain'],
    ingredients: [{
      id: 'rum', name: 'White rum', amount: 60, unit: 'ml', unitId: 'ml', unitName: 'ml',
      description: 'Light rum', imageUrl: 'https://example.com/rum.png', tags: [{ id: 'spirit', name: 'Spirit' }],
      baseIngredientId: 'rum-base', styleIngredientId: 'white-rum', substitutes: [{ name: 'Light rum' }],
      synonyms: ['silver rum'], abv: 40, barcodes: ['123'], optional: false, garnish: false, process: 'distilled', serving: 'pour',
    }],
    glassware: 'Coupe', glasswareId: 'coupe', glasswareName: 'Coupe', garnish: 'Lime wheel',
    method: { id: 'shaken', name: 'Shaken' }, methodId: 'shaken', methodName: 'Shaken',
    tags: [{ id: 'classic', name: 'Classic' }], tagDetails: [{ id: 'classic', name: 'Classic' }], servings: 1,
    imageUrl: 'https://example.com/cocktail.png', video: 'https://example.com/video',
  },
  source: { app: 'yourbar', appVersion: '2.0', platform: 'ios' },
};

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  first() { return this.db.first(this.sql, this.values); }
  all() { return this.db.all(this.sql, this.values); }
  run() { return this.db.run(this.sql, this.values); }
}

class MemoryD1 {
  constructor() { this.submissions = new Map(); this.recipes = new Map(); this.saves = new Map(); this.ratings = new Map(); this.audit = []; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) { const results = []; for (const statement of statements) results.push(await this.run(statement.sql, statement.values)); return results; }
  async run(sql, v) {
    if (sql.startsWith('INSERT INTO community_submissions')) {
      const [id, submitter_user_id, author_google_login, payload_json, recipe_checksum, created_at] = v;
      this.submissions.set(id, { id, submitter_user_id, author_google_login, payload_json, recipe_checksum, status: 'pending', rejection_reason: null, moderator_notes: null, created_at, reviewed_at: null, reviewed_by: null });
    } else if (sql.startsWith("UPDATE community_submissions SET status = 'rejected'")) {
      const [rejection_reason, moderator_notes, reviewed_at, reviewed_by, id] = v; Object.assign(this.submissions.get(id), { status: 'rejected', rejection_reason, moderator_notes, reviewed_at, reviewed_by });
    } else if (sql.startsWith("UPDATE community_submissions SET status = 'approved'")) {
      const [moderator_notes, reviewed_at, reviewed_by, id] = v; Object.assign(this.submissions.get(id), { status: 'approved', moderator_notes, reviewed_at, reviewed_by });
    } else if (sql.startsWith('INSERT INTO community_recipes')) {
      const [id, submission_id, author_google_login, payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, random_key, published_at, updated_at] = v;
      const old = [...this.recipes.values()].find((row) => row.submission_id === submission_id);
      this.recipes.set(id, { ...(old ?? {}), id, submission_id, author_google_login, payload_json, recipe_checksum, status: 'published', save_count: old?.save_count ?? 0, rating_count: old?.rating_count ?? 0, rating_sum: old?.rating_sum ?? 0, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, random_key, published_at: old?.published_at ?? published_at, updated_at });
    } else if (sql.startsWith('INSERT INTO admin_moderation_events')) this.audit.push(v);
    else if (sql.startsWith('INSERT OR IGNORE INTO community_recipe_saves')) {
      const [recipeId, userId, createdAt] = v; const key = `${recipeId}:${userId}`;
      if (!this.saves.has(key)) this.saves.set(key, { recipeId, userId, createdAt });
    } else if (sql.startsWith('DELETE FROM community_recipe_saves')) {
      const [recipeId, userId] = v; const key = `${recipeId}:${userId}`;
      this.saves.delete(key);
    } else if (sql.startsWith('UPDATE community_recipes SET save_count = (SELECT COUNT(*)')) {
      const [recipeId, updatedAt, targetId] = v; const row = this.recipes.get(targetId); row.save_count = [...this.saves.values()].filter((save) => save.recipeId === recipeId).length; row.updated_at = updatedAt;
    } else if (sql.startsWith('UPDATE community_recipes SET rating_count = (SELECT COUNT(*)')) {
      const [countRecipeId, sumRecipeId, updatedAt, targetId] = v; const row = this.recipes.get(targetId); const ratings = [...this.ratings.values()].filter((rating) => rating.recipeId === countRecipeId && rating.recipeId === sumRecipeId); row.rating_count = ratings.length; row.rating_sum = ratings.reduce((sum, rating) => sum + rating.rating, 0); row.updated_at = updatedAt;
    } else if (sql.startsWith('INSERT INTO community_recipe_ratings')) {
      const [recipeId, userId, rating, createdAt, updatedAt] = v; const key = `${recipeId}:${userId}`; const old = this.ratings.get(key); const row = this.recipes.get(recipeId);
      this.ratings.set(key, { recipeId, userId, rating, createdAt: old?.createdAt ?? createdAt, updatedAt });
    } else if (sql.startsWith('DELETE FROM community_recipe_ratings')) {
      const [recipeId, userId] = v; const key = `${recipeId}:${userId}`; const old = this.ratings.get(key);
      if (old) this.ratings.delete(key);
    }
    return { success: true, meta: { changes: 1 } };
  }
  personalize(row, userId) {
    if (!row) return null;
    return { ...row, current_user_saved: userId ? Number(this.saves.has(`${row.id}:${userId}`)) : 0, current_user_rating: userId ? this.ratings.get(`${row.id}:${userId}`)?.rating ?? null : null };
  }
  async first(sql, v) {
    if (sql.includes('FROM community_submissions WHERE id = ?')) return this.submissions.get(v[0]) ?? null;
    if (sql.includes('FROM community_recipes r WHERE r.id = ?')) {
      const personalized = sql.includes('s.user_id = ?'); const id = v[personalized ? 2 : 0]; return this.personalize(this.recipes.get(id)?.status === 'published' ? this.recipes.get(id) : null, personalized ? v[0] : null);
    }
    return null;
  }
  async all(sql, v) {
    if (sql.includes('FROM community_submissions WHERE status = ?')) {
      const [status, limit, offset] = v; const rows = [...this.submissions.values()].filter((row) => row.status === status).sort((a,b) => b.created_at.localeCompare(a.created_at)); return { success: true, results: rows.slice(offset, offset + limit) };
    }
    if (sql.includes('FROM community_recipes r WHERE')) {
      const personalized = sql.includes('s.user_id=?'); const userId = personalized ? v[0] : null; let rows = [...this.recipes.values()].filter((row) => row.status === 'published');
      const patterns = v.filter((value) => typeof value === 'string' && value.startsWith('%')).map((value) => value.slice(1, -1).replace(/\\([%_\\])/g, '$1'));
      if (sql.includes('name_normalized LIKE') && patterns[0]) rows = rows.filter((row) => row.name_normalized.includes(patterns[0]) || row.search_tokens_json.includes(patterns[0]));
      if (sql.includes('tag_ids_json LIKE')) { const pattern = patterns.at(sql.includes('name_normalized LIKE') ? 2 : 0); rows = rows.filter((row) => row.tag_ids_json.includes(pattern)); }
      if (sql.includes('method_ids_json LIKE')) { const pattern = patterns.at(-1); rows = rows.filter((row) => row.method_ids_json.includes(pattern)); }
      if (sql.includes('mine.user_id = ?')) rows = rows.filter((row) => this.saves.has(`${row.id}:${userId}`));
      if (sql.includes('name_normalized ASC')) rows.sort((a,b) => a.name_normalized.localeCompare(b.name_normalized));
      else if (sql.includes('save_count DESC')) rows.sort((a,b) => b.save_count-a.save_count);
      else if (sql.includes('rating_sum AS REAL')) rows.sort((a,b) => (b.rating_sum/(b.rating_count||1))-(a.rating_sum/(a.rating_count||1)));
      else rows.sort((a,b) => b.published_at.localeCompare(a.published_at));
      const limit = v.at(-2), offset = v.at(-1); return { success: true, results: rows.slice(offset, offset + limit).map((row) => this.personalize(row, userId)) };
    }
    return { success: true, results: [] };
  }
}

function kv() { return { async get() { return null; }, async put() {}, async delete() {} }; }
function env(database, overrides = {}) { return { RECIPE_SHARES: kv(), YOURBAR_DB: database, COMMUNITY_FEATURE_ENABLED: 'true', COMMUNITY_SUBMISSIONS_ENABLED: 'true', COMMUNITY_ADMIN_ENABLED: 'true', COMMUNITY_PUBLIC_FEED_ENABLED: 'true', AUTH_TEST_MODE: 'true', PUBLIC_BASE_URL: 'https://staging-api.yourbar.app', ...overrides }; }
function userHeaders(extra = {}) { return { 'Content-Type': 'application/json', 'X-Test-User-Id': 'user-1', 'X-Test-User-Email': 'user@example.com', ...extra }; }
async function api(database, path, init = {}) { return handleRequest(new Request(`https://staging-api.yourbar.app${path}`, init), env(database)); }
async function submit(database, payload = richPayload) {
  const response = await api(database, '/api/community/submissions', { method: 'POST', headers: userHeaders(), body: JSON.stringify({ googleLogin: 'author@gmail.com', payload }) });
  assert.equal(response.status, 201); return response.json();
}
async function moderate(database, id, action) {
  return api(database, `/api/admin/community/submissions/${id}`, { method: 'PATCH', headers: userHeaders({ 'X-Test-Admin': 'true' }), body: JSON.stringify({ action }) });
}

test('community master flag is disabled independently of personal routes', async () => {
  const database = new MemoryD1();
  const disabled = await handleRequest(new Request('https://api.yourbar.app/api/community/recipes'), env(database, { COMMUNITY_FEATURE_ENABLED: 'false' }));
  assert.equal(disabled.status, 404); assert.equal((await disabled.json()).error.code, 'feature_disabled');
  const personal = await handleRequest(new Request('https://api.yourbar.app/api/recipes/not-valid'), env(database, { COMMUNITY_FEATURE_ENABLED: 'false' }));
  assert.notEqual((await personal.json()).error.code, 'feature_disabled');
});

test('submission requires auth and googleLogin and reuses recipe validation', async () => {
  const database = new MemoryD1();
  const unauthenticated = await api(database, '/api/community/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googleLogin: 'a@b.com', payload: richPayload }) });
  assert.equal(unauthenticated.status, 401);
  const missing = await api(database, '/api/community/submissions', { method: 'POST', headers: userHeaders(), body: JSON.stringify({ payload: richPayload }) });
  assert.equal(missing.status, 400); assert.deepEqual(await missing.json(), { error: { code: 'validation_failed', message: 'googleLogin is required for community submission' } });
  const invalid = await api(database, '/api/community/submissions', { method: 'POST', headers: userHeaders(), body: JSON.stringify({ googleLogin: 'a@b.com', payload: { ...richPayload, recipe: { ...richPayload.recipe, name: '' } } }) });
  assert.equal(invalid.status, 400); assert.ok((await invalid.json()).error.details.some((issue) => issue.path === 'recipe.name'));
});

test('submission stores trusted auth id and author Google login as pending', async () => {
  const database = new MemoryD1(); const created = await submit(database); const row = database.submissions.get(created.id);
  assert.equal(created.status, 'pending'); assert.equal(created.googleLogin, 'author@gmail.com'); assert.equal(row.author_google_login, 'author@gmail.com'); assert.equal(row.submitter_user_id, 'user-1');
});

test('admin moderation is protected and reject without a reason never publishes', async () => {
  const database = new MemoryD1(); const created = await submit(database);
  const forbidden = await api(database, `/api/admin/community/submissions/${created.id}`, { method: 'PATCH', headers: userHeaders(), body: JSON.stringify({ action: 'approve' }) });
  assert.equal(forbidden.status, 401);
  const rejected = await moderate(database, created.id, 'reject'); assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).rejectionReason, null);
  assert.equal(database.submissions.get(created.id).rejection_reason, null);
  const feed = await api(database, '/api/community/recipes'); assert.deepEqual((await feed.json()).items, []); assert.equal(database.audit.length, 1);
});

test('approve publishes full importable recipe and author in public list/detail', async () => {
  const database = new MemoryD1(); const created = await submit(database); const approved = await moderate(database, created.id, 'approve'); assert.equal(approved.status, 200);
  const recipeId = (await approved.json()).recipeId;
  const list = await api(database, '/api/community/recipes?sort=newest&limit=20'); assert.equal(list.status, 200); const item = (await list.json()).items[0];
  assert.equal(item.id, recipeId); assert.deepEqual(item.recipe, richPayload.recipe); assert.equal(item.author.googleLogin, 'author@gmail.com'); assert.equal(item.source.submissionId, created.id); assert.equal(item.isSavedByCurrentUser, false);
  const detail = await api(database, `/api/community/recipes/${recipeId}`); assert.deepEqual((await detail.json()).recipe.ingredients, richPayload.recipe.ingredients);
});

test('feed supports cursor, search, tag/method filters and required sorts', async () => {
  const database = new MemoryD1(); const first = await submit(database); await moderate(database, first.id, 'approve');
  const secondPayload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Alpine Highball', tags: [{ id: 'long', name: 'Long' }], tagDetails: [{ id: 'long', name: 'Long' }], method: { id: 'built', name: 'Built' }, methodId: 'built', methodName: 'Built' } };
  const second = await submit(database, secondPayload); await moderate(database, second.id, 'approve');
  const page = await api(database, '/api/community/recipes?limit=1&sort=alphabetical'); const pageBody = await page.json(); assert.equal(pageBody.items[0].recipe.name, 'Alpine Highball'); assert.ok(pageBody.nextCursor);
  const next = await api(database, `/api/community/recipes?limit=1&sort=alphabetical&cursor=${encodeURIComponent(pageBody.nextCursor)}`); assert.equal((await next.json()).items[0].recipe.name, 'Garden Daiquiri');
  for (const query of ['q=garden', 'tagIds=classic', 'methodIds=shaken', 'sort=topRated', 'sort=mostSaved', 'sort=newest', 'sort=random&seed=session']) {
    const response = await api(database, `/api/community/recipes?${query}`); assert.equal(response.status, 200, query); assert.ok(Array.isArray((await response.json()).items));
  }
});

test('save is authenticated, idempotent, personalized, and returns mobile import DTO', async () => {
  const database = new MemoryD1(); const created = await submit(database); const approved = await moderate(database, created.id, 'approve'); const recipeId = (await approved.json()).recipeId;
  const noAuth = await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'POST' }); assert.equal(noAuth.status, 401);
  const first = await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'POST', headers: userHeaders() }); const body = await first.json(); assert.equal(body.saveCount, 1); assert.deepEqual(body.import.recipe, richPayload.recipe); assert.equal(body.communityRecipe.isSavedByCurrentUser, true);
  const duplicate = await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'POST', headers: userHeaders() }); assert.equal((await duplicate.json()).saveCount, 1);
  const personalized = await api(database, `/api/community/recipes/${recipeId}`, { headers: userHeaders() }); assert.equal((await personalized.json()).isSavedByCurrentUser, true);
  await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'DELETE', headers: userHeaders() }); const secondDelete = await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'DELETE', headers: userHeaders() }); assert.equal((await secondDelete.json()).saveCount, 0);
});

test('rating create, update, delete maintains aggregates and personalization', async () => {
  const database = new MemoryD1(); const created = await submit(database); const approved = await moderate(database, created.id, 'approve'); const recipeId = (await approved.json()).recipeId;
  const invalid = await api(database, `/api/community/recipes/${recipeId}/rating`, { method: 'PUT', headers: userHeaders(), body: JSON.stringify({ rating: 6 }) }); assert.equal(invalid.status, 400);
  const create = await api(database, `/api/community/recipes/${recipeId}/rating`, { method: 'PUT', headers: userHeaders(), body: JSON.stringify({ rating: 5 }) }); assert.deepEqual(await create.json(), { ratingCount: 1, ratingSum: 5, averageRating: 5, currentUserRating: 5 });
  const update = await api(database, `/api/community/recipes/${recipeId}/rating`, { method: 'PUT', headers: userHeaders(), body: JSON.stringify({ rating: 3 }) }); assert.deepEqual(await update.json(), { ratingCount: 1, ratingSum: 3, averageRating: 3, currentUserRating: 3 });
  const remove = await api(database, `/api/community/recipes/${recipeId}/rating`, { method: 'DELETE', headers: userHeaders() }); assert.deepEqual(await remove.json(), { ratingCount: 0, ratingSum: 0, averageRating: 0, currentUserRating: null });
});

test('staging unverified mode accepts submission googleLogin without JWT', async () => {
  const database = new MemoryD1();
  const response = await handleRequest(new Request('https://staging-api.yourbar.app/api/community/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ googleLogin: 'Fast.User@Gmail.com', payload: richPayload }),
  }), env(database, { AUTH_TEST_MODE: 'false', COMMUNITY_USER_AUTH_MODE: 'unverified' }));
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(database.submissions.get(created.id).submitter_user_id, 'google:fast.user@gmail.com');
});

test('staging unverified mode uses Google login header for save and personalization', async () => {
  const database = new MemoryD1(); const created = await submit(database); const approved = await moderate(database, created.id, 'approve'); const recipeId = (await approved.json()).recipeId;
  const headers = { 'X-YourBar-Google-Login': 'reader@gmail.com' };
  const saved = await handleRequest(new Request(`https://staging-api.yourbar.app/api/community/recipes/${recipeId}/save`, { method: 'POST', headers }), env(database, { AUTH_TEST_MODE: 'false', COMMUNITY_USER_AUTH_MODE: 'unverified' }));
  assert.equal(saved.status, 200);
  const detail = await handleRequest(new Request(`https://staging-api.yourbar.app/api/community/recipes/${recipeId}`, { headers }), env(database, { AUTH_TEST_MODE: 'false', COMMUNITY_USER_AUTH_MODE: 'unverified' }));
  assert.equal((await detail.json()).isSavedByCurrentUser, true);
});
