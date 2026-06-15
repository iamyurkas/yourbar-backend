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
    if (sql.startsWith('INSERT INTO community_submissions') || sql.startsWith('INSERT OR IGNORE INTO community_submissions')) {
      const [id, submitter_user_id, author_google_login, payload_json, recipe_checksum, created_at, target_recipe_id, base_recipe_checksum] = v;
      this.submissions.set(id, { id, submitter_user_id, author_google_login, payload_json, recipe_checksum, status: 'pending', rejection_reason: null, moderator_notes: null, created_at, reviewed_at: null, reviewed_by: null, target_recipe_id, base_recipe_checksum });
    } else if (sql.startsWith("UPDATE community_submissions SET status = 'rejected'") && sql.includes('target_recipe_id = ?')) {
      const [rejectionReason, reviewedAt, reviewedBy, recipeId] = v;
      for (const row of this.submissions.values()) if (row.target_recipe_id === recipeId && row.status === 'pending') Object.assign(row, { status: 'rejected', rejection_reason: rejectionReason, reviewed_at: reviewedAt, reviewed_by: reviewedBy });
    } else if (sql.startsWith("UPDATE community_submissions SET status = 'rejected'")) {
      const [rejection_reason, moderator_notes, reviewed_at, reviewed_by, id] = v; Object.assign(this.submissions.get(id), { status: 'rejected', rejection_reason, moderator_notes, reviewed_at, reviewed_by });
    } else if (sql.startsWith("UPDATE community_submissions SET status = 'approved'")) {
      const [moderator_notes, reviewed_at, reviewed_by, id] = v; Object.assign(this.submissions.get(id), { status: 'approved', moderator_notes, reviewed_at, reviewed_by });
    } else if (sql.startsWith('INSERT INTO community_recipes')) {
      const [id, submission_id, author_user_id, author_google_login, payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, random_key, published_at, updated_at] = v;
      const old = [...this.recipes.values()].find((row) => row.submission_id === submission_id);
      this.recipes.set(id, { ...(old ?? {}), id, submission_id, author_user_id, author_google_login, payload_json, recipe_checksum, status: 'published', save_count: old?.save_count ?? 0, rating_count: old?.rating_count ?? 0, rating_sum: old?.rating_sum ?? 0, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, random_key, published_at: old?.published_at ?? published_at, updated_at });
    } else if (sql.startsWith('UPDATE community_recipes SET submission_id = ?')) {
      const [submission_id, author_user_id, author_google_login, payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, updated_at, id, baseChecksum] = v;
      const row = this.recipes.get(id);
      if (row?.recipe_checksum === baseChecksum) Object.assign(row, { submission_id, author_user_id, author_google_login, payload_json, recipe_checksum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, updated_at });
    } else if (sql.startsWith("UPDATE community_recipes SET status = 'hidden'")) {
      const [updatedAt, id] = v; const row = this.recipes.get(id);
      if (row?.status === 'published') Object.assign(row, { status: 'hidden', updated_at: updatedAt });
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
    if (sql.includes("FROM community_submissions WHERE target_recipe_id = ? AND status = 'pending'")) return [...this.submissions.values()].find((row) => row.target_recipe_id === v[0] && row.status === 'pending') ?? null;
    if (sql.includes('submitter_user_id = ? AND recipe_checksum = ?') && sql.includes("status = 'pending'")) {
      return [...this.submissions.values()].find((row) => row.submitter_user_id === v[0] && row.recipe_checksum === v[1] && row.target_recipe_id == null && row.status === 'pending') ?? null;
    }
    if (sql.includes('author_user_id = ? AND recipe_checksum = ?') && sql.includes("status = 'published'")) {
      return [...this.recipes.values()].find((row) => row.author_user_id === v[0] && row.recipe_checksum === v[1] && row.status === 'published') ?? null;
    }
    if (sql.includes('FROM community_recipes WHERE id = ?')) return this.recipes.get(v[0]) ?? null;
    if (sql.includes('FROM community_recipes WHERE submission_id = ?')) return [...this.recipes.values()].find((row) => row.submission_id === v[0]) ?? null;
    if (sql.includes('FROM community_recipes r WHERE r.id = ?')) {
      const personalized = sql.includes('s.user_id = ?'); const id = v[personalized ? 2 : 0]; return this.personalize(this.recipes.get(id)?.status === 'published' ? this.recipes.get(id) : null, personalized ? v[0] : null);
    }
    return null;
  }
  async all(sql, v) {
    if (sql.includes('INNER JOIN community_recipes r ON r.submission_id = s.id')) {
      const [limit, offset] = v;
      const rows = [...this.recipes.values()]
        .filter((recipe) => recipe.status === 'published')
        .map((recipe) => this.submissions.get(recipe.submission_id))
        .filter((row) => row?.status === 'approved')
        .sort((a,b) => b.created_at.localeCompare(a.created_at));
      return { success: true, results: rows.slice(offset, offset + limit) };
    }
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
async function submitUpdate(database, recipeId, payload, baseRecipeChecksum, headers = userHeaders()) {
  return api(database, '/api/community/submissions', { method: 'POST', headers, body: JSON.stringify({
    googleLogin: 'author@gmail.com', targetRecipeId: recipeId, baseRecipeChecksum, payload,
  }) });
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

test('outdated Community schema returns migration diagnostics and a request id', async () => {
  const database = {
    prepare() {
      throw new Error('D1_ERROR: no such column: target_recipe_id at offset 42');
    },
  };
  const response = await api(database, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders({ 'X-Request-Id': 'mobile-share-123' }),
    body: JSON.stringify({ googleLogin: 'author@gmail.com', payload: richPayload }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-request-id'), 'mobile-share-123');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'community_schema_outdated',
      message: 'Community database migration is required',
      details: {
        requestId: 'mobile-share-123',
        requiredMigration: '0002_community_recipe_updates.sql',
        operation: '/api/community/submissions',
        cause: 'D1_ERROR: no such column: target_recipe_id at offset 42',
        action: 'Apply the pending D1 migrations to this Worker environment, then retry the request.',
      },
    },
  });
});

test('staging internal errors include a safe cause and generated request id', async () => {
  const database = {
    prepare() {
      throw new TypeError('database binding failed');
    },
  };
  const response = await api(database, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify({ googleLogin: 'author@gmail.com', payload: richPayload }),
  });
  assert.equal(response.status, 500);
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.equal(body.error.code, 'internal_error');
  assert.equal(body.error.details.cause, 'database binding failed');
  assert.equal(body.error.details.errorType, 'TypeError');
  assert.equal(body.error.details.operation, '/api/community/submissions');
  assert.equal(body.error.details.requestId, response.headers.get('x-request-id'));
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

test('identical new submissions reuse one pending moderation item', async () => {
  const database = new MemoryD1();
  const first = await submit(database);
  const duplicateResponse = await api(database, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify({ googleLogin: 'author@gmail.com', payload: richPayload }),
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.status, 'pending');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.alreadyPublished, false);
  assert.equal(database.submissions.size, 1);

  const queue = await api(database, '/api/admin/community/submissions?status=pending', {
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  assert.equal((await queue.json()).items.length, 1);
});

test('identical recipe is not resubmitted after approval but may be resubmitted after rejection', async () => {
  const database = new MemoryD1();
  const first = await submit(database);
  const approved = await moderate(database, first.id, 'approve');
  const recipeId = (await approved.json()).recipeId;
  const approvedDuplicate = await api(database, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify({ googleLogin: 'author@gmail.com', payload: richPayload }),
  });
  assert.equal(approvedDuplicate.status, 200);
  assert.deepEqual(await approvedDuplicate.json(), {
    id: first.id,
    status: 'approved',
    createdAt: database.recipes.get(recipeId).published_at,
    recipeChecksum: database.recipes.get(recipeId).recipe_checksum,
    googleLogin: 'author@gmail.com',
    submissionType: 'create',
    targetRecipeId: null,
    baseRecipeChecksum: null,
    recipeId,
    duplicate: true,
    alreadyPublished: true,
  });
  assert.equal(database.submissions.size, 1);

  const rejectedDatabase = new MemoryD1();
  const rejected = await submit(rejectedDatabase);
  await moderate(rejectedDatabase, rejected.id, 'reject');
  const retry = await api(rejectedDatabase, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders(),
    body: JSON.stringify({ googleLogin: 'author@gmail.com', payload: richPayload }),
  });
  assert.equal(retry.status, 201);
  assert.equal(rejectedDatabase.submissions.size, 2);
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

test('admin can delete a published recipe and pending updates cannot republish it', async () => {
  const database = new MemoryD1();
  const created = await submit(database);
  const approved = await moderate(database, created.id, 'approve');
  const recipeId = (await approved.json()).recipeId;
  const detail = await api(database, `/api/admin/community/submissions/${created.id}`, {
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  assert.equal((await detail.json()).publishedRecipe.id, recipeId);

  const updatePayload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Pending removal update' } };
  const update = await submitUpdate(database, recipeId, updatePayload, database.recipes.get(recipeId).recipe_checksum);
  const updateId = (await update.json()).id;
  const unauthorized = await api(database, `/api/admin/community/recipes/${recipeId}`, { method: 'DELETE', headers: userHeaders() });
  assert.equal(unauthorized.status, 401);

  const removed = await api(database, `/api/admin/community/recipes/${recipeId}`, {
    method: 'DELETE',
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  assert.deepEqual(await removed.json(), { recipeId, status: 'hidden', deleted: true, alreadyDeleted: false });
  assert.equal(database.recipes.get(recipeId).status, 'hidden');
  assert.equal(database.submissions.get(updateId).status, 'rejected');
  assert.match(database.submissions.get(updateId).rejection_reason, /removed by administrator/);
  assert.equal((await api(database, `/api/community/recipes/${recipeId}`)).status, 404);
  assert.deepEqual((await (await api(database, '/api/community/recipes')).json()).items, []);
  const approvedQueue = await api(database, '/api/admin/community/submissions?status=approved', {
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  assert.deepEqual((await approvedQueue.json()).items, []);

  const secondDelete = await api(database, `/api/admin/community/recipes/${recipeId}`, {
    method: 'DELETE',
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  assert.deepEqual(await secondDelete.json(), { recipeId, status: 'hidden', deleted: true, alreadyDeleted: true });
});

test('approved admin queue shows only the current published revision', async () => {
  const database = new MemoryD1();
  const original = await submit(database);
  const approved = await moderate(database, original.id, 'approve');
  const recipeId = (await approved.json()).recipeId;
  const payload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Current approved revision' } };
  const update = await submitUpdate(database, recipeId, payload, database.recipes.get(recipeId).recipe_checksum);
  const updateId = (await update.json()).id;
  await moderate(database, updateId, 'approve');

  const queue = await api(database, '/api/admin/community/submissions?status=approved', {
    headers: userHeaders({ 'X-Test-Admin': 'true' }),
  });
  const items = (await queue.json()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, updateId);
  assert.equal(items[0].recipe.name, 'Current approved revision');
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

test('approved update keeps recipe id, ratings, saves, and old recipe public until approval', async () => {
  const database = new MemoryD1();
  const created = await submit(database);
  const firstApproval = await moderate(database, created.id, 'approve');
  const recipeId = (await firstApproval.json()).recipeId;
  await api(database, `/api/community/recipes/${recipeId}/save`, { method: 'POST', headers: userHeaders() });
  await api(database, `/api/community/recipes/${recipeId}/rating`, { method: 'PUT', headers: userHeaders(), body: JSON.stringify({ rating: 5 }) });
  const original = await api(database, `/api/community/recipes/${recipeId}`);
  const originalBody = await original.json();
  const updatedPayload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Updated Garden Daiquiri', description: 'A newly moderated description.' } };
  const updateResponse = await submitUpdate(database, recipeId, updatedPayload, originalBody.recipeChecksum);
  assert.equal(updateResponse.status, 201);
  const update = await updateResponse.json();
  assert.equal(update.submissionType, 'update');
  assert.equal(update.targetRecipeId, recipeId);

  const beforeApproval = await api(database, `/api/community/recipes/${recipeId}`);
  assert.equal((await beforeApproval.json()).recipe.name, 'Garden Daiquiri');
  const adminDetail = await api(database, `/api/admin/community/submissions/${update.id}`, { headers: userHeaders({ 'X-Test-Admin': 'true' }) });
  const adminBody = await adminDetail.json();
  assert.equal(adminBody.publishedRecipe.recipe.name, 'Garden Daiquiri');
  assert.equal(adminBody.recipe.name, 'Updated Garden Daiquiri');

  const approval = await moderate(database, update.id, 'approve');
  assert.equal(approval.status, 200);
  assert.equal((await approval.json()).recipeId, recipeId);
  const afterApproval = await api(database, `/api/community/recipes/${recipeId}`, { headers: userHeaders() });
  const afterBody = await afterApproval.json();
  assert.equal(afterBody.recipe.name, 'Updated Garden Daiquiri');
  assert.equal(afterBody.ratingCount, 1);
  assert.equal(afterBody.ratingSum, 5);
  assert.equal(afterBody.saveCount, 1);
  assert.equal(afterBody.currentUserRating, 5);
  assert.equal(afterBody.isSavedByCurrentUser, true);
});

test('recipe updates enforce ownership, one pending update, and optimistic checksum', async () => {
  const database = new MemoryD1();
  const created = await submit(database);
  const approved = await moderate(database, created.id, 'approve');
  const recipeId = (await approved.json()).recipeId;
  const checksum = database.recipes.get(recipeId).recipe_checksum;
  const payload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Pending update' } };

  const stale = await submitUpdate(database, recipeId, payload, 'stale-checksum');
  assert.equal(stale.status, 409);
  const forbidden = await api(database, '/api/community/submissions', {
    method: 'POST',
    headers: userHeaders({ 'X-Test-User-Id': 'user-2', 'X-Test-User-Email': 'other@example.com' }),
    body: JSON.stringify({ googleLogin: 'other@gmail.com', targetRecipeId: recipeId, baseRecipeChecksum: checksum, payload }),
  });
  assert.equal(forbidden.status, 403);
  const first = await submitUpdate(database, recipeId, payload, checksum);
  assert.equal(first.status, 201);
  const duplicate = await submitUpdate(database, recipeId, payload, checksum);
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.id, (await first.clone().json()).id);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.alreadyPublished, false);

  const newerPayload = { ...richPayload, recipe: { ...richPayload.recipe, name: 'Different pending update' } };
  const conflict = await submitUpdate(database, recipeId, newerPayload, checksum);
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, 'pending_update_conflict');
  assert.equal(conflictBody.error.details.targetRecipeId, recipeId);
  assert.equal(conflictBody.error.details.pendingSubmissionId, duplicateBody.id);
  assert.equal(conflictBody.error.details.pendingRecipeChecksum, duplicateBody.recipeChecksum);
  assert.notEqual(conflictBody.error.details.submittedRecipeChecksum, duplicateBody.recipeChecksum);
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
