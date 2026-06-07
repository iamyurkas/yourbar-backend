import { AuthError, getOptionalUser, requireAdmin, requireUser, type AuthEnv, type AuthenticatedUser } from "./auth.js";
import type { D1Database } from "./d1.js";
import { isJsonContentType, jsonError, jsonResponse } from "./http.js";
import { recipeChecksum } from "./checksum.js";
import { validateRecipeSharePayloadV1, type CommunityRecipeListItemDTO, type RecipeSharePayloadV1, type RecipeTag } from "./schema.js";

export interface CommunityEnv extends AuthEnv {
  YOURBAR_DB?: D1Database;
  COMMUNITY_FEATURE_ENABLED?: string;
  COMMUNITY_SUBMISSIONS_ENABLED?: string;
  COMMUNITY_ADMIN_ENABLED?: string;
  COMMUNITY_PUBLIC_FEED_ENABLED?: string;
  MAX_RECIPE_PAYLOAD_BYTES?: string;
  PUBLIC_BASE_URL?: string;
}

type SubmissionRow = {
  id: string; submitter_user_id: string; author_google_login: string; payload_json: string; recipe_checksum: string;
  status: "pending" | "approved" | "rejected"; rejection_reason: string | null; moderator_notes: string | null;
  created_at: string; reviewed_at: string | null; reviewed_by: string | null;
};

type RecipeRow = {
  id: string; submission_id: string; author_google_login: string; payload_json: string; recipe_checksum: string;
  status: "published" | "hidden"; save_count: number; rating_count: number; rating_sum: number;
  name_normalized: string; search_tokens_json: string; tag_ids_json: string; method_ids_json: string;
  random_key: string; published_at: string; updated_at: string;
  current_user_saved?: number | null; current_user_rating?: number | null;
};

const SORTS = new Set(["newest", "topRated", "mostSaved", "alphabetical", "random"]);
const SUBMISSION_STATUSES = new Set(["pending", "approved", "rejected"]);

function enabled(value: string | undefined): boolean { return value === "true"; }
function db(env: CommunityEnv): D1Database | Response {
  return env.YOURBAR_DB ?? jsonError("feature_disabled", "Community storage is not configured", 404);
}
function maxPayloadBytes(env: CommunityEnv): number {
  const parsed = Number(env.MAX_RECIPE_PAYLOAD_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 65_536;
}
function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}
function tagId(tag: RecipeTag): string { return typeof tag === "string" ? tag : tag.id; }
function methodIds(payload: RecipeSharePayloadV1): string[] {
  const recipe = payload.recipe;
  const values = [recipe.methodId];
  if (typeof recipe.method === "object" && !Array.isArray(recipe.method)) values.push(recipe.method.id);
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
function searchable(payload: RecipeSharePayloadV1): { name: string; tokens: string[]; tags: string[]; methods: string[] } {
  const recipe = payload.recipe;
  const tokens = [recipe.name, recipe.description, recipe.garnish, recipe.methodName, recipe.glasswareName,
    ...recipe.ingredients.flatMap((ingredient) => [ingredient.name, ingredient.description, ...(ingredient.synonyms ?? [])]),
    ...(recipe.tags ?? []).map((tag) => typeof tag === "string" ? tag : `${tag.id} ${tag.name}`),
  ].filter((value): value is string => typeof value === "string").map(normalize).filter(Boolean);
  return { name: normalize(recipe.name), tokens: [...new Set(tokens)], tags: [...new Set((recipe.tags ?? []).map(tagId))], methods: methodIds(payload) };
}
function randomKey(): string { return String(crypto.getRandomValues(new Uint32Array(1))[0] ?? 0); }
function id(prefix: string): string { return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`; }
function parseJson<T>(value: string): T { return JSON.parse(value) as T; }
function average(row: RecipeRow): number { return row.rating_count > 0 ? row.rating_sum / row.rating_count : 0; }
function baseUrl(env: CommunityEnv): string | undefined { return env.PUBLIC_BASE_URL?.replace(/\/+$/, ""); }
function recipeDto(row: RecipeRow, env: CommunityEnv): CommunityRecipeListItemDTO {
  const root = baseUrl(env);
  return {
    id: row.id,
    recipe: parseJson<RecipeSharePayloadV1>(row.payload_json).recipe,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    saveCount: row.save_count,
    ratingCount: row.rating_count,
    ratingSum: row.rating_sum,
    averageRating: average(row),
    isSavedByCurrentUser: Boolean(row.current_user_saved),
    currentUserRating: row.current_user_rating ?? null,
    ...(root ? { shareUrl: `${root}/api/community/recipes/${row.id}`, publicUrl: `${root}/api/community/recipes/${row.id}` } : {}),
    source: { kind: "community" as const, submissionId: row.submission_id },
    author: { googleLogin: row.author_google_login },
  };
}
function submissionDto(row: SubmissionRow, includePayload = false) {
  return {
    id: row.id, status: row.status, createdAt: row.created_at, recipeChecksum: row.recipe_checksum,
    googleLogin: row.author_google_login,
    ...(includePayload ? {
      submitterUserId: row.submitter_user_id, recipe: parseJson<RecipeSharePayloadV1>(row.payload_json).recipe,
      rejectionReason: row.rejection_reason, moderatorNotes: row.moderator_notes,
      reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by,
    } : {}),
  };
}
async function jsonBody(request: Request, env: CommunityEnv): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) return jsonError("unsupported_media_type", "Content-Type must be application/json", 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxPayloadBytes(env)) return jsonError("payload_too_large", "Request body is too large", 413);
  try { return JSON.parse(text) as unknown; } catch { return jsonError("invalid_json", "Request body is not valid JSON", 400); }
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function login(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 320 ? trimmed : null;
}
function positiveLimit(value: string | null): number {
  if (!value) return 20;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 20;
}
function encodeCursor(offset: number, fingerprint: string): string {
  return btoa(JSON.stringify({ offset, fingerprint })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(value: string | null, fingerprint: string): number | Response {
  if (!value) return 0;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as { offset?: unknown; fingerprint?: unknown };
    if (!Number.isInteger(decoded.offset) || Number(decoded.offset) < 0 || decoded.fingerprint !== fingerprint) throw new Error();
    return Number(decoded.offset);
  } catch { return jsonError("validation_failed", "cursor is invalid for this query", 400); }
}
function csv(value: string | null): string[] { return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))]; }
function seedNumber(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
async function optionalUser(request: Request, env: CommunityEnv): Promise<AuthenticatedUser | null | Response> {
  try { return await getOptionalUser(request, env); } catch (error) { return error instanceof AuthError ? error.response : jsonError("unauthorized", "Invalid authentication", 401); }
}
async function publishedRecipe(database: D1Database, recipeId: string, user: AuthenticatedUser | null): Promise<RecipeRow | null> {
  const statement = database.prepare(`SELECT r.*,
    ${user ? "EXISTS(SELECT 1 FROM community_recipe_saves s WHERE s.recipe_id = r.id AND s.user_id = ?)" : "0"} AS current_user_saved,
    ${user ? "(SELECT rating FROM community_recipe_ratings x WHERE x.recipe_id = r.id AND x.user_id = ?)" : "NULL"} AS current_user_rating
    FROM community_recipes r WHERE r.id = ? AND r.status = 'published'`);
  return user ? statement.bind(user.id, user.id, recipeId).first<RecipeRow>() : statement.bind(recipeId).first<RecipeRow>();
}

async function createSubmission(request: Request, env: CommunityEnv, database: D1Database): Promise<Response> {
  if (!enabled(env.COMMUNITY_SUBMISSIONS_ENABLED)) return jsonError("feature_disabled", "Community submissions are disabled", 404);
  let user: AuthenticatedUser;
  try { user = await requireUser(request, env); } catch (error) { return error instanceof AuthError ? error.response : jsonError("unauthorized", "Authentication is required", 401); }
  const body = await jsonBody(request, env);
  if (body instanceof Response) return body;
  if (!object(body)) return jsonError("validation_failed", "Request body must be an object", 400);
  const googleLogin = login(body.googleLogin);
  if (!googleLogin) return jsonError("validation_failed", "googleLogin is required for community submission", 400);
  const candidate = object(body.payload) ? body.payload : Object.fromEntries(Object.entries(body).filter(([key]) => key !== "googleLogin" && key !== "userId" && key !== "submitter_user_id"));
  const validation = validateRecipeSharePayloadV1(candidate);
  if (!validation.ok) return jsonError("validation_failed", "Recipe payload is invalid", 400, validation.issues);
  const now = new Date().toISOString();
  const checksum = await recipeChecksum(validation.value.recipe);
  const submissionId = id("sub");
  await database.prepare(`INSERT INTO community_submissions
    (id, submitter_user_id, author_google_login, payload_json, recipe_checksum, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`).bind(submissionId, user.id, googleLogin, JSON.stringify(validation.value), checksum, now).run();
  return jsonResponse({ id: submissionId, status: "pending", createdAt: now, recipeChecksum: checksum, googleLogin }, 201);
}

async function listSubmissions(url: URL, database: D1Database): Promise<Response> {
  const status = url.searchParams.get("status") ?? "pending";
  if (!SUBMISSION_STATUSES.has(status)) return jsonError("validation_failed", "status must be pending, approved, or rejected", 400);
  const limit = positiveLimit(url.searchParams.get("limit"));
  const fingerprint = `admin:${status}:${limit}`;
  const offset = decodeCursor(url.searchParams.get("cursor"), fingerprint);
  if (offset instanceof Response) return offset;
  const result = await database.prepare("SELECT * FROM community_submissions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
    .bind(status, limit + 1, offset).all<SubmissionRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  return jsonResponse({ items: rows.slice(0, limit).map((row) => submissionDto(row, true)), nextCursor: hasMore ? encodeCursor(offset + limit, fingerprint) : null });
}

async function getSubmission(submissionId: string, database: D1Database): Promise<Response> {
  const row = await database.prepare("SELECT * FROM community_submissions WHERE id = ?").bind(submissionId).first<SubmissionRow>();
  return row ? jsonResponse(submissionDto(row, true)) : jsonError("not_found", "Community submission was not found", 404);
}

async function moderate(request: Request, env: CommunityEnv, database: D1Database, submissionId: string, adminId: string): Promise<Response> {
  const body = await jsonBody(request, env);
  if (body instanceof Response) return body;
  if (!object(body) || (body.action !== "approve" && body.action !== "reject")) return jsonError("validation_failed", "action must be approve or reject", 400);
  const row = await database.prepare("SELECT * FROM community_submissions WHERE id = ?").bind(submissionId).first<SubmissionRow>();
  if (!row) return jsonError("not_found", "Community submission was not found", 404);
  if (row.status !== "pending") return jsonError("conflict", "Community submission has already been reviewed", 409);
  const now = new Date().toISOString();
  const notes = typeof body.moderatorNotes === "string" ? body.moderatorNotes.slice(0, 2000) : null;
  const reason = typeof body.rejectionReason === "string" ? body.rejectionReason.slice(0, 2000) : null;
  const eventId = id("audit");
  if (body.action === "reject") {
    await database.batch([
      database.prepare("UPDATE community_submissions SET status = 'rejected', rejection_reason = ?, moderator_notes = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(reason, notes, now, adminId, submissionId),
      database.prepare("INSERT INTO admin_moderation_events (id, admin_user_id, created_at, action, submission_id, recipe_id, moderator_notes, rejection_reason) VALUES (?, ?, ?, 'reject', ?, NULL, ?, ?)").bind(eventId, adminId, now, submissionId, notes, reason),
    ]);
    const updated = { ...row, status: "rejected" as const, rejection_reason: reason, moderator_notes: notes, reviewed_at: now, reviewed_by: adminId };
    return jsonResponse(submissionDto(updated, true));
  }
  const payload = parseJson<RecipeSharePayloadV1>(row.payload_json);
  const search = searchable(payload);
  const recipeId = `recipe_${submissionId}`;
  await database.batch([
    database.prepare("UPDATE community_submissions SET status = 'approved', moderator_notes = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'").bind(notes, now, adminId, submissionId),
    database.prepare(`INSERT INTO community_recipes
      (id, submission_id, author_google_login, payload_json, recipe_checksum, status, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, random_key, published_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(submission_id) DO UPDATE SET author_google_login=excluded.author_google_login, payload_json=excluded.payload_json,
      recipe_checksum=excluded.recipe_checksum, status='published', name_normalized=excluded.name_normalized,
      search_tokens_json=excluded.search_tokens_json, tag_ids_json=excluded.tag_ids_json, method_ids_json=excluded.method_ids_json, updated_at=excluded.updated_at`)
      .bind(recipeId, submissionId, row.author_google_login, row.payload_json, row.recipe_checksum, search.name, JSON.stringify(search.tokens), JSON.stringify(search.tags), JSON.stringify(search.methods), randomKey(), now, now),
    database.prepare("INSERT INTO admin_moderation_events (id, admin_user_id, created_at, action, submission_id, recipe_id, moderator_notes, rejection_reason) VALUES (?, ?, ?, 'approve', ?, ?, ?, NULL)").bind(eventId, adminId, now, submissionId, recipeId, notes),
  ]);
  return jsonResponse({ ...submissionDto({ ...row, status: "approved", moderator_notes: notes, reviewed_at: now, reviewed_by: adminId }, true), recipeId });
}

async function listRecipes(request: Request, env: CommunityEnv, database: D1Database, url: URL): Promise<Response> {
  if (env.COMMUNITY_PUBLIC_FEED_ENABLED !== undefined && !enabled(env.COMMUNITY_PUBLIC_FEED_ENABLED)) return jsonError("feature_disabled", "Community feed is disabled", 404);
  const userResult = await optionalUser(request, env);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const sort = url.searchParams.get("sort") ?? "newest";
  if (!SORTS.has(sort)) return jsonError("validation_failed", "sort must be newest, topRated, mostSaved, alphabetical, or random", 400);
  const seed = url.searchParams.get("seed") ?? "default";
  const limit = positiveLimit(url.searchParams.get("limit"));
  const query = normalize(url.searchParams.get("q") ?? "");
  const tags = csv(url.searchParams.get("tagIds"));
  const methods = csv(url.searchParams.get("methodIds"));
  const savedByMe = url.searchParams.get("savedByMe") === "true";
  if (savedByMe && !user) return jsonError("unauthorized", "Authentication is required for savedByMe", 401);
  const fingerprint = JSON.stringify({ sort, seed, limit, query, tags, methods, savedByMe });
  const offset = decodeCursor(url.searchParams.get("cursor"), fingerprint);
  if (offset instanceof Response) return offset;
  const where = ["r.status = 'published'"];
  const values: unknown[] = [];
  if (query) { where.push("(r.name_normalized LIKE ? ESCAPE '\\' OR r.search_tokens_json LIKE ? ESCAPE '\\')"); const escaped = query.replace(/[\\%_]/g, "\\$&"); values.push(`%${escaped}%`, `%${escaped}%`); }
  for (const tag of tags) { where.push("r.tag_ids_json LIKE ?"); values.push(`%${JSON.stringify(tag)}%`); }
  for (const method of methods) { where.push("r.method_ids_json LIKE ?"); values.push(`%${JSON.stringify(method)}%`); }
  if (savedByMe && user) { where.push("EXISTS(SELECT 1 FROM community_recipe_saves mine WHERE mine.recipe_id = r.id AND mine.user_id = ?)"); values.push(user.id); }
  const order = sort === "topRated" ? "CASE WHEN r.rating_count=0 THEN 0 ELSE CAST(r.rating_sum AS REAL)/r.rating_count END DESC, r.rating_count DESC, r.id DESC"
    : sort === "mostSaved" ? "r.save_count DESC, r.published_at DESC, r.id DESC"
    : sort === "alphabetical" ? "r.name_normalized ASC, r.id ASC"
    : sort === "random" ? "ABS((CAST(r.random_key AS INTEGER) * 1103515245 + ?) % 2147483647), r.id" : "r.published_at DESC, r.id DESC";
  const selectValues: unknown[] = [];
  const savedSql = user ? "EXISTS(SELECT 1 FROM community_recipe_saves s WHERE s.recipe_id=r.id AND s.user_id=?)" : "0";
  const ratingSql = user ? "(SELECT rating FROM community_recipe_ratings x WHERE x.recipe_id=r.id AND x.user_id=?)" : "NULL";
  if (user) selectValues.push(user.id, user.id);
  if (sort === "random") values.push(seedNumber(seed));
  values.push(limit + 1, offset);
  const result = await database.prepare(`SELECT r.*, ${savedSql} AS current_user_saved, ${ratingSql} AS current_user_rating
    FROM community_recipes r WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...selectValues, ...values).all<RecipeRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  return jsonResponse({ items: rows.slice(0, limit).map((row) => recipeDto(row, env)), nextCursor: hasMore ? encodeCursor(offset + limit, fingerprint) : null });
}

async function saveRecipe(request: Request, env: CommunityEnv, database: D1Database, recipeId: string, remove: boolean): Promise<Response> {
  let user: AuthenticatedUser;
  try { user = await requireUser(request, env); } catch (error) { return error instanceof AuthError ? error.response : jsonError("unauthorized", "Authentication is required", 401); }
  const existing = await publishedRecipe(database, recipeId, user);
  if (!existing) return jsonError("not_found", "Community recipe was not found", 404);
  const now = new Date().toISOString();
  if (remove) await database.prepare("DELETE FROM community_recipe_saves WHERE recipe_id = ? AND user_id = ?").bind(recipeId, user.id).run();
  else await database.prepare("INSERT OR IGNORE INTO community_recipe_saves (recipe_id, user_id, created_at) VALUES (?, ?, ?)").bind(recipeId, user.id, now).run();
  const updated = await publishedRecipe(database, recipeId, user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  if (remove) return jsonResponse({ recipeId, saved: false, saveCount: updated.save_count });
  const dto = recipeDto(updated, env);
  return jsonResponse({ recipeId, saved: true, saveCount: updated.save_count, communityRecipe: dto, import: { kind: "yourbar.communityRecipeImport", sourceCommunityRecipeId: recipeId, recipe: dto.recipe } });
}

async function rateRecipe(request: Request, env: CommunityEnv, database: D1Database, recipeId: string, remove: boolean): Promise<Response> {
  let user: AuthenticatedUser;
  try { user = await requireUser(request, env); } catch (error) { return error instanceof AuthError ? error.response : jsonError("unauthorized", "Authentication is required", 401); }
  if (!await publishedRecipe(database, recipeId, user)) return jsonError("not_found", "Community recipe was not found", 404);
  if (remove) await database.prepare("DELETE FROM community_recipe_ratings WHERE recipe_id = ? AND user_id = ?").bind(recipeId, user.id).run();
  else {
    const body = await jsonBody(request, env);
    if (body instanceof Response) return body;
    if (!object(body) || !Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5) return jsonError("validation_failed", "rating must be an integer from 1 to 5", 400);
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO community_recipe_ratings (recipe_id, user_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(recipe_id, user_id) DO UPDATE SET rating=excluded.rating, updated_at=excluded.updated_at`).bind(recipeId, user.id, body.rating, now, now).run();
  }
  const updated = await publishedRecipe(database, recipeId, user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  return jsonResponse({ ratingCount: updated.rating_count, ratingSum: updated.rating_sum, averageRating: average(updated), currentUserRating: updated.current_user_rating ?? null });
}

export async function handleCommunityRequest(request: Request, env: CommunityEnv, path: string, url: URL): Promise<Response | null> {
  const isCommunity = path.startsWith("/api/community/") || path.startsWith("/api/admin/community/");
  if (!isCommunity) return null;
  if (!enabled(env.COMMUNITY_FEATURE_ENABLED)) return jsonError("feature_disabled", "Community feature is disabled", 404);
  const database = db(env);
  if (database instanceof Response) return database;

  if (path === "/api/community/submissions") return request.method === "POST" ? createSubmission(request, env, database) : jsonError("method_not_allowed", "Method not allowed", 405);
  if (path.startsWith("/api/admin/community/")) {
    if (!enabled(env.COMMUNITY_ADMIN_ENABLED)) return jsonError("feature_disabled", "Community administration is disabled", 404);
    let admin;
    try { admin = await requireAdmin(request, env); } catch (error) { return error instanceof AuthError ? error.response : jsonError("unauthorized", "Administrator authentication is required", 401); }
    if (path === "/api/admin/community/submissions") return request.method === "GET" ? listSubmissions(url, database) : jsonError("method_not_allowed", "Method not allowed", 405);
    const match = path.match(/^\/api\/admin\/community\/submissions\/([^/]+)$/);
    if (match?.[1]) {
      if (request.method === "GET") return getSubmission(match[1], database);
      if (request.method === "PATCH") return moderate(request, env, database, match[1], admin.id);
      return jsonError("method_not_allowed", "Method not allowed", 405);
    }
  }
  if (path === "/api/community/recipes") return request.method === "GET" ? listRecipes(request, env, database, url) : jsonError("method_not_allowed", "Method not allowed", 405);
  const action = path.match(/^\/api\/community\/recipes\/([^/]+)\/(save|rating)$/);
  if (action?.[1] && action[2] === "save") {
    if (request.method === "POST") return saveRecipe(request, env, database, action[1], false);
    if (request.method === "DELETE") return saveRecipe(request, env, database, action[1], true);
    return jsonError("method_not_allowed", "Method not allowed", 405);
  }
  if (action?.[1] && action[2] === "rating") {
    if (request.method === "PUT") return rateRecipe(request, env, database, action[1], false);
    if (request.method === "DELETE") return rateRecipe(request, env, database, action[1], true);
    return jsonError("method_not_allowed", "Method not allowed", 405);
  }
  const detail = path.match(/^\/api\/community\/recipes\/([^/]+)$/);
  if (detail?.[1]) {
    if (request.method !== "GET") return jsonError("method_not_allowed", "Method not allowed", 405);
    if (env.COMMUNITY_PUBLIC_FEED_ENABLED !== undefined && !enabled(env.COMMUNITY_PUBLIC_FEED_ENABLED)) return jsonError("feature_disabled", "Community feed is disabled", 404);
    const userResult = await optionalUser(request, env);
    if (userResult instanceof Response) return userResult;
    const row = await publishedRecipe(database, detail[1], userResult);
    return row ? jsonResponse(recipeDto(row, env)) : jsonError("not_found", "Community recipe was not found", 404);
  }
  return jsonError("not_found", "Route not found", 404);
}
