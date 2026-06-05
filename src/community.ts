import { getOptionalUser, requireAdmin, requireUser, type AuthenticatedUser } from "./auth.js";
import { isJsonContentType, jsonError, jsonResponse } from "./http.js";
import type { Env } from "./index.js";
import { recipeChecksum } from "./checksum.js";
import { validateRecipeSharePayloadV1, type RecipeSharePayloadV1, type RecipeTag } from "./schema.js";

type D1Result<T = unknown> = { results?: T[]; meta?: { changes?: number } };
type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
};
type D1Database = { prepare(query: string): D1PreparedStatement; batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> };

type CommunityEnv = Env & { YOURBAR_DB?: D1Database };

type SubmissionRow = {
  id: string;
  submitter_user_id: string;
  payload_json: string;
  recipe_checksum: string;
  status: "pending" | "approved" | "rejected";
  rejection_reason?: string | null;
  moderator_notes?: string | null;
  created_at: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
};

type RecipeRow = {
  id: string;
  submission_id: string;
  payload_json: string;
  recipe_checksum: string;
  status: "published" | "hidden";
  save_count: number;
  rating_count: number;
  rating_sum: number;
  name_normalized: string;
  search_tokens_json: string;
  tag_ids_json: string;
  method_ids_json: string;
  published_at: string;
  updated_at: string;
  current_user_rating?: number | null;
  is_saved_by_current_user?: number | null;
};

export type SharedRecipeDTO = RecipeSharePayloadV1["recipe"];

type CommunityRecipeDTO = {
  id: string;
  recipe: SharedRecipeDTO;
  publishedAt: string;
  updatedAt: string;
  saveCount: number;
  ratingCount: number;
  ratingSum: number;
  averageRating: number;
  isSavedByCurrentUser?: boolean;
  currentUserRating?: number | null;
  publicUrl: string;
  shareUrl: string;
  source: { kind: "community"; submissionId: string };
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const COMMUNITY_PREFIX = "/api/community";
const ADMIN_PREFIX = "/api/admin/community";

function flagEnabled(value: string | undefined): boolean {
  return value === "true";
}

function maxPayloadBytes(env: Env): number {
  const parsed = Number(env.MAX_RECIPE_PAYLOAD_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 65_536;
}

async function readJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return { ok: false, response: jsonError("unsupported_media_type", "Content-Type must be application/json", 415) };
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) return { ok: false, response: jsonError("payload_too_large", `Payload must be ${maxBytes} bytes or smaller`, 413) };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonError("bad_request", "Request body must be valid JSON", 400) };
  }
}

function dbOrError(env: CommunityEnv): { ok: true; db: D1Database } | { ok: false; response: Response } {
  if (!env.YOURBAR_DB) return { ok: false, response: jsonError("storage_not_configured", "Community D1 database is not configured", 503) };
  return { ok: true, db: env.YOURBAR_DB };
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tagId(tag: RecipeTag): string {
  return typeof tag === "string" ? tag : tag.id;
}

function methodIds(recipe: RecipeSharePayloadV1["recipe"]): string[] {
  const ids = new Set<string>();
  if (recipe.methodId?.trim()) ids.add(recipe.methodId.trim());
  if (recipe.method && typeof recipe.method === "object" && !Array.isArray(recipe.method) && recipe.method.id.trim()) ids.add(recipe.method.id.trim());
  if (typeof recipe.method === "string" && recipe.method.trim()) ids.add(normalize(recipe.method));
  return [...ids];
}

function searchTokens(recipe: RecipeSharePayloadV1["recipe"]): string[] {
  const values = [recipe.name, recipe.description, recipe.garnish, recipe.glassware, recipe.glasswareName, recipe.methodName];
  for (const tag of recipe.tags ?? []) values.push(typeof tag === "string" ? tag : tag.name);
  for (const ingredient of recipe.ingredients) values.push(ingredient.name, ingredient.description, ...(ingredient.tags ?? []).map((tag) => typeof tag === "string" ? tag : tag.name));
  return [...new Set(values.flatMap((value) => normalize(value).split(/[^a-z0-9_-]+/)).filter((value) => value.length >= 2))];
}

function tagIds(recipe: RecipeSharePayloadV1["recipe"]): string[] {
  return [...new Set((recipe.tags ?? []).map(tagId).map((value) => value.trim()).filter(Boolean))];
}

function average(ratingCount: number, ratingSum: number): number {
  return ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 100) / 100 : 0;
}

function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
}

function communityPublicUrl(env: Env, id: string): string {
  return `${publicBaseUrl(env)}/community/recipes/${id}`;
}

function parsePayload(row: { payload_json: string }): RecipeSharePayloadV1 {
  return JSON.parse(row.payload_json) as RecipeSharePayloadV1;
}

function toCommunityRecipe(row: RecipeRow, env: Env, user: AuthenticatedUser | null): CommunityRecipeDTO {
  const payload = parsePayload(row);
  const dto: CommunityRecipeDTO = {
    id: row.id,
    recipe: payload.recipe,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    saveCount: row.save_count,
    ratingCount: row.rating_count,
    ratingSum: row.rating_sum,
    averageRating: average(row.rating_count, row.rating_sum),
    publicUrl: communityPublicUrl(env, row.id),
    shareUrl: communityPublicUrl(env, row.id),
    source: { kind: "community", submissionId: row.submission_id },
  };
  if (user) {
    dto.isSavedByCurrentUser = Number(row.is_saved_by_current_user ?? 0) > 0;
    dto.currentUserRating = row.current_user_rating ?? null;
  }
  return dto;
}

function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ offset })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string | null): number {
  if (!value) return 0;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return typeof parsed.offset === "number" && parsed.offset >= 0 ? Math.floor(parsed.offset) : 0;
  } catch {
    return 0;
  }
}

function limitFromUrl(url: URL): number {
  const parsed = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function id(): string {
  return crypto.randomUUID();
}

function submissionDto(row: SubmissionRow) {
  return {
    id: row.id,
    submitterUserId: row.submitter_user_id,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: row.reviewed_by ?? null,
    rejectionReason: row.rejection_reason ?? null,
    moderatorNotes: row.moderator_notes ?? null,
    recipeChecksum: row.recipe_checksum,
    payload: parsePayload(row),
  };
}

async function handleCreateSubmission(request: Request, env: CommunityEnv): Promise<Response> {
  if (!flagEnabled(env.COMMUNITY_SUBMISSIONS_ENABLED)) return jsonError("feature_disabled", "Community submissions are disabled", 404);
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireUser(request, env); if (!auth.ok) return auth.response;
  const json = await readJson(request, maxPayloadBytes(env)); if (!json.ok) return json.response;
  const validation = validateRecipeSharePayloadV1(json.value);
  if (!validation.ok) return jsonError("validation_failed", "Recipe share payload is invalid", 400, validation.issues);
  const checksum = await recipeChecksum(validation.value.recipe);
  const now = new Date().toISOString();
  const submissionId = id();
  await db.db.prepare(`INSERT INTO community_submissions (id, submitter_user_id, payload_json, recipe_checksum, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`).bind(submissionId, auth.user.id, JSON.stringify(validation.value), checksum, now).run();
  return jsonResponse({ id: submissionId, status: "pending", createdAt: now, recipeChecksum: checksum }, 201);
}

async function handleListSubmissions(request: Request, env: CommunityEnv): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireAdmin(request, env); if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected"].includes(status)) return jsonError("validation_failed", "Invalid submission status", 400);
  const limit = limitFromUrl(url);
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const rows = (await db.db.prepare(`SELECT * FROM community_submissions WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(status, limit + 1, offset).all<SubmissionRow>()).results ?? [];
  const items = rows.slice(0, limit).map(submissionDto);
  return jsonResponse({ items, nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null });
}

async function handleGetSubmission(request: Request, env: CommunityEnv, submissionId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireAdmin(request, env); if (!auth.ok) return auth.response;
  const row = await db.db.prepare(`SELECT * FROM community_submissions WHERE id = ?`).bind(submissionId).first<SubmissionRow>();
  if (!row) return jsonError("not_found", "Submission was not found", 404);
  return jsonResponse(submissionDto(row));
}

async function approveSubmission(db: D1Database, env: Env, row: SubmissionRow, admin: AuthenticatedUser, moderatorNotes: string | undefined): Promise<CommunityRecipeDTO> {
  const payload = parsePayload(row);
  const now = new Date().toISOString();
  const existing = await db.prepare(`SELECT * FROM community_recipes WHERE submission_id = ?`).bind(row.id).first<RecipeRow>();
  const recipeId = existing?.id ?? id();
  const recipe = payload.recipe;
  const searchable = {
    name: normalize(recipe.name),
    tokens: searchTokens(recipe),
    tags: tagIds(recipe),
    methods: methodIds(recipe),
  };
  await db.batch([
    existing
      ? db.prepare(`UPDATE community_recipes SET payload_json = ?, recipe_checksum = ?, status = 'published', name_normalized = ?, search_tokens_json = ?, tag_ids_json = ?, method_ids_json = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(payload), row.recipe_checksum, searchable.name, JSON.stringify(searchable.tokens), JSON.stringify(searchable.tags), JSON.stringify(searchable.methods), now, recipeId)
      : db.prepare(`INSERT INTO community_recipes (id, submission_id, payload_json, recipe_checksum, status, save_count, rating_count, rating_sum, name_normalized, search_tokens_json, tag_ids_json, method_ids_json, published_at, updated_at) VALUES (?, ?, ?, ?, 'published', 0, 0, 0, ?, ?, ?, ?, ?, ?)`).bind(recipeId, row.id, JSON.stringify(payload), row.recipe_checksum, searchable.name, JSON.stringify(searchable.tokens), JSON.stringify(searchable.tags), JSON.stringify(searchable.methods), now, now),
    db.prepare(`UPDATE community_submissions SET status = 'approved', reviewed_at = ?, reviewed_by = ?, moderator_notes = ?, rejection_reason = NULL WHERE id = ?`).bind(now, admin.id, moderatorNotes ?? null, row.id),
    db.prepare(`INSERT INTO admin_moderation_events (id, admin_user_id, action, submission_id, recipe_id, notes, reason, created_at) VALUES (?, ?, 'approve', ?, ?, ?, NULL, ?)`).bind(id(), admin.id, row.id, recipeId, moderatorNotes ?? null, now),
  ]);
  const recipeRow = await db.prepare(`SELECT * FROM community_recipes WHERE id = ?`).bind(recipeId).first<RecipeRow>();
  if (!recipeRow) throw new Error("approved recipe missing");
  return toCommunityRecipe(recipeRow, env, null);
}

async function handlePatchSubmission(request: Request, env: CommunityEnv, submissionId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireAdmin(request, env); if (!auth.ok) return auth.response;
  const json = await readJson(request, 8192); if (!json.ok) return json.response;
  if (!json.value || typeof json.value !== "object") return jsonError("validation_failed", "Patch body is invalid", 400);
  const body = json.value as { action?: unknown; rejectionReason?: unknown; moderatorNotes?: unknown };
  const row = await db.db.prepare(`SELECT * FROM community_submissions WHERE id = ?`).bind(submissionId).first<SubmissionRow>();
  if (!row) return jsonError("not_found", "Submission was not found", 404);
  const notes = typeof body.moderatorNotes === "string" ? body.moderatorNotes : undefined;
  if (body.action === "approve") {
    const communityRecipe = await approveSubmission(db.db, env, row, auth.user, notes);
    return jsonResponse({ submission: { ...submissionDto({ ...row, status: "approved", moderator_notes: notes ?? null, reviewed_by: auth.user.id, reviewed_at: new Date().toISOString() }), payload: parsePayload(row) }, communityRecipe });
  }
  if (body.action === "reject") {
    const reason = typeof body.rejectionReason === "string" ? body.rejectionReason : undefined;
    const now = new Date().toISOString();
    await db.db.batch([
      db.db.prepare(`UPDATE community_submissions SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, rejection_reason = ?, moderator_notes = ? WHERE id = ?`).bind(now, auth.user.id, reason ?? null, notes ?? null, row.id),
      db.db.prepare(`INSERT INTO admin_moderation_events (id, admin_user_id, action, submission_id, recipe_id, notes, reason, created_at) VALUES (?, ?, 'reject', ?, NULL, ?, ?, ?)`).bind(id(), auth.user.id, row.id, notes ?? null, reason ?? null, now),
    ]);
    return jsonResponse({ submission: { ...submissionDto({ ...row, status: "rejected", rejection_reason: reason ?? null, moderator_notes: notes ?? null, reviewed_by: auth.user.id, reviewed_at: now }), payload: parsePayload(row) } });
  }
  return jsonError("validation_failed", "Action must be approve or reject", 400);
}

function arrayFilterClause(column: string, values: string[], params: unknown[]): string {
  if (values.length === 0) return "";
  const clauses = values.map((value) => {
    params.push(`%\"${value.replace(/[\\%_]/g, "")}\"%`);
    return `${column} LIKE ?`;
  });
  return ` AND (${clauses.join(" OR ")})`;
}

function listOrder(sort: string, seed: string, params: unknown[]): string {
  switch (sort) {
    case "topRated": return "rating_count DESC, rating_sum DESC, published_at DESC, id DESC";
    case "mostSaved": return "save_count DESC, published_at DESC, id DESC";
    case "alphabetical": return "name_normalized ASC, id ASC";
    case "random": {
      const seedValue = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) || 17;
      params.push(seedValue);
      return "((unicode(substr(id, 1, 1)) * ? + unicode(substr(id, 2, 1))) % 997) ASC, id ASC";
    }
    case "newest":
    default: return "published_at DESC, id DESC";
  }
}

async function handleListRecipes(request: Request, env: CommunityEnv): Promise<Response> {
  if (!flagEnabled(env.COMMUNITY_PUBLIC_FEED_ENABLED ?? env.COMMUNITY_FEATURE_ENABLED)) return jsonError("feature_disabled", "Community public feed is disabled", 404);
  const db = dbOrError(env); if (!db.ok) return db.response;
  const user = await getOptionalUser(request, env);
  const url = new URL(request.url);
  const limit = limitFromUrl(url);
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const params: unknown[] = [];
  let where = "r.status = 'published'";
  const q = normalize(url.searchParams.get("q") ?? undefined);
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    where += " AND (r.name_normalized LIKE ? OR r.search_tokens_json LIKE ?)";
  }
  where += arrayFilterClause("r.tag_ids_json", (url.searchParams.get("tagIds") ?? "").split(",").map((v) => v.trim()).filter(Boolean), params);
  where += arrayFilterClause("r.method_ids_json", (url.searchParams.get("methodIds") ?? "").split(",").map((v) => v.trim()).filter(Boolean), params);
  const minAverageRating = Number(url.searchParams.get("minAverageRating"));
  if (Number.isFinite(minAverageRating) && minAverageRating > 0) {
    params.push(minAverageRating);
    where += " AND r.rating_count > 0 AND (CAST(r.rating_sum AS REAL) / r.rating_count) >= ?";
  }
  let join = "";
  if (user) {
    join += " LEFT JOIN community_recipe_ratings ur ON ur.recipe_id = r.id AND ur.user_id = ? LEFT JOIN community_recipe_saves us ON us.recipe_id = r.id AND us.user_id = ?";
    params.unshift(user.id, user.id);
  }
  if (url.searchParams.get("savedByMe") === "true") {
    if (!user) return jsonError("unauthorized", "Authentication is required for savedByMe", 401);
    where += " AND us.user_id IS NOT NULL";
  }
  const orderParams: unknown[] = [];
  const order = listOrder(url.searchParams.get("sort") ?? "newest", url.searchParams.get("seed") ?? "", orderParams);
  const selectUser = user ? ", ur.rating AS current_user_rating, CASE WHEN us.user_id IS NULL THEN 0 ELSE 1 END AS is_saved_by_current_user" : ", NULL AS current_user_rating, NULL AS is_saved_by_current_user";
  const rows = (await db.db.prepare(`SELECT r.*${selectUser} FROM community_recipes r${join} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params, ...orderParams, limit + 1, offset).all<RecipeRow>()).results ?? [];
  const items = rows.slice(0, limit).map((row) => toCommunityRecipe(row, env, user));
  return jsonResponse({ items, nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null });
}

async function getPublishedRecipe(db: D1Database, recipeId: string, user: AuthenticatedUser | null): Promise<RecipeRow | null> {
  if (user) {
    return db.prepare(`SELECT r.*, ur.rating AS current_user_rating, CASE WHEN us.user_id IS NULL THEN 0 ELSE 1 END AS is_saved_by_current_user FROM community_recipes r LEFT JOIN community_recipe_ratings ur ON ur.recipe_id = r.id AND ur.user_id = ? LEFT JOIN community_recipe_saves us ON us.recipe_id = r.id AND us.user_id = ? WHERE r.id = ? AND r.status = 'published'`).bind(user.id, user.id, recipeId).first<RecipeRow>();
  }
  return db.prepare(`SELECT r.*, NULL AS current_user_rating, NULL AS is_saved_by_current_user FROM community_recipes r WHERE r.id = ? AND r.status = 'published'`).bind(recipeId).first<RecipeRow>();
}

async function handleGetRecipe(request: Request, env: CommunityEnv, recipeId: string): Promise<Response> {
  if (!flagEnabled(env.COMMUNITY_PUBLIC_FEED_ENABLED ?? env.COMMUNITY_FEATURE_ENABLED)) return jsonError("feature_disabled", "Community public feed is disabled", 404);
  const db = dbOrError(env); if (!db.ok) return db.response;
  const user = await getOptionalUser(request, env);
  const row = await getPublishedRecipe(db.db, recipeId, user);
  if (!row) return jsonError("not_found", "Community recipe was not found", 404);
  return jsonResponse(toCommunityRecipe(row, env, user));
}

async function handleSave(request: Request, env: CommunityEnv, recipeId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireUser(request, env); if (!auth.ok) return auth.response;
  const now = new Date().toISOString();
  const recipe = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!recipe) return jsonError("not_found", "Community recipe was not found", 404);
  const insert = await db.db.prepare(`INSERT OR IGNORE INTO community_recipe_saves (recipe_id, user_id, created_at) VALUES (?, ?, ?)`).bind(recipeId, auth.user.id, now).run();
  if ((insert.meta?.changes ?? 0) > 0) await db.db.prepare(`UPDATE community_recipes SET save_count = save_count + 1, updated_at = ? WHERE id = ?`).bind(now, recipeId).run();
  const updated = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  const communityRecipe = toCommunityRecipe(updated, env, auth.user);
  return jsonResponse({ recipeId, saved: true, saveCount: communityRecipe.saveCount, communityRecipe, import: { kind: "yourbar.communityRecipeImport", sourceCommunityRecipeId: recipeId, recipe: communityRecipe.recipe } });
}

async function handleUnsave(request: Request, env: CommunityEnv, recipeId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireUser(request, env); if (!auth.ok) return auth.response;
  const now = new Date().toISOString();
  const deleted = await db.db.prepare(`DELETE FROM community_recipe_saves WHERE recipe_id = ? AND user_id = ?`).bind(recipeId, auth.user.id).run();
  if ((deleted.meta?.changes ?? 0) > 0) await db.db.prepare(`UPDATE community_recipes SET save_count = MAX(save_count - 1, 0), updated_at = ? WHERE id = ?`).bind(now, recipeId).run();
  const updated = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  const communityRecipe = toCommunityRecipe(updated, env, auth.user);
  return jsonResponse({ recipeId, saved: false, saveCount: communityRecipe.saveCount, communityRecipe });
}

async function handlePutRating(request: Request, env: CommunityEnv, recipeId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireUser(request, env); if (!auth.ok) return auth.response;
  const json = await readJson(request, 1024); if (!json.ok) return json.response;
  const rating = (json.value as { rating?: unknown })?.rating;
  if (![1, 2, 3, 4, 5].includes(Number(rating))) return jsonError("validation_failed", "Rating must be an integer from 1 to 5", 400);
  const recipe = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!recipe) return jsonError("not_found", "Community recipe was not found", 404);
  const old = await db.db.prepare(`SELECT rating FROM community_recipe_ratings WHERE recipe_id = ? AND user_id = ?`).bind(recipeId, auth.user.id).first<{ rating: number }>();
  const now = new Date().toISOString();
  if (old) {
    await db.db.batch([
      db.db.prepare(`UPDATE community_recipe_ratings SET rating = ?, updated_at = ? WHERE recipe_id = ? AND user_id = ?`).bind(rating, now, recipeId, auth.user.id),
      db.db.prepare(`UPDATE community_recipes SET rating_sum = rating_sum + ?, updated_at = ? WHERE id = ?`).bind(Number(rating) - old.rating, now, recipeId),
    ]);
  } else {
    await db.db.batch([
      db.db.prepare(`INSERT INTO community_recipe_ratings (recipe_id, user_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).bind(recipeId, auth.user.id, rating, now, now),
      db.db.prepare(`UPDATE community_recipes SET rating_count = rating_count + 1, rating_sum = rating_sum + ?, updated_at = ? WHERE id = ?`).bind(rating, now, recipeId),
    ]);
  }
  const updated = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  return jsonResponse({ recipeId, ratingCount: updated.rating_count, ratingSum: updated.rating_sum, averageRating: average(updated.rating_count, updated.rating_sum), currentUserRating: Number(rating) });
}

async function handleDeleteRating(request: Request, env: CommunityEnv, recipeId: string): Promise<Response> {
  const db = dbOrError(env); if (!db.ok) return db.response;
  const auth = await requireUser(request, env); if (!auth.ok) return auth.response;
  const old = await db.db.prepare(`SELECT rating FROM community_recipe_ratings WHERE recipe_id = ? AND user_id = ?`).bind(recipeId, auth.user.id).first<{ rating: number }>();
  const now = new Date().toISOString();
  if (old) {
    await db.db.batch([
      db.db.prepare(`DELETE FROM community_recipe_ratings WHERE recipe_id = ? AND user_id = ?`).bind(recipeId, auth.user.id),
      db.db.prepare(`UPDATE community_recipes SET rating_count = MAX(rating_count - 1, 0), rating_sum = MAX(rating_sum - ?, 0), updated_at = ? WHERE id = ?`).bind(old.rating, now, recipeId),
    ]);
  }
  const updated = await getPublishedRecipe(db.db, recipeId, auth.user);
  if (!updated) return jsonError("not_found", "Community recipe was not found", 404);
  return jsonResponse({ recipeId, ratingCount: updated.rating_count, ratingSum: updated.rating_sum, averageRating: average(updated.rating_count, updated.rating_sum), currentUserRating: null });
}

export async function handleCommunityRequest(request: Request, env: CommunityEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith(COMMUNITY_PREFIX) && !path.startsWith(ADMIN_PREFIX)) return null;
  if (!flagEnabled(env.COMMUNITY_FEATURE_ENABLED)) return jsonError("feature_disabled", "Community feature is disabled", 404);

  if (path === `${COMMUNITY_PREFIX}/submissions`) {
    return request.method === "POST" ? handleCreateSubmission(request, env) : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "POST, OPTIONS" });
  }
  if (path === `${ADMIN_PREFIX}/submissions`) {
    if (!flagEnabled(env.COMMUNITY_ADMIN_ENABLED)) return jsonError("feature_disabled", "Community admin is disabled", 404);
    return request.method === "GET" ? handleListSubmissions(request, env) : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET, OPTIONS" });
  }
  if (path.startsWith(`${ADMIN_PREFIX}/submissions/`)) {
    if (!flagEnabled(env.COMMUNITY_ADMIN_ENABLED)) return jsonError("feature_disabled", "Community admin is disabled", 404);
    const submissionId = path.slice(`${ADMIN_PREFIX}/submissions/`.length);
    if (request.method === "GET") return handleGetSubmission(request, env, submissionId);
    if (request.method === "PATCH") return handlePatchSubmission(request, env, submissionId);
    return jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET, PATCH, OPTIONS" });
  }
  if (path === `${COMMUNITY_PREFIX}/recipes`) {
    return request.method === "GET" ? handleListRecipes(request, env) : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET, OPTIONS" });
  }
  if (path.startsWith(`${COMMUNITY_PREFIX}/recipes/`)) {
    const rest = path.slice(`${COMMUNITY_PREFIX}/recipes/`.length);
    const [recipeId, action] = rest.split("/");
    if (!recipeId) return jsonError("not_found", "Not found", 404);
    if (action === "save") {
      if (request.method === "POST") return handleSave(request, env, recipeId);
      if (request.method === "DELETE") return handleUnsave(request, env, recipeId);
      return jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "POST, DELETE, OPTIONS" });
    }
    if (action === "rating") {
      if (request.method === "PUT") return handlePutRating(request, env, recipeId);
      if (request.method === "DELETE") return handleDeleteRating(request, env, recipeId);
      return jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "PUT, DELETE, OPTIONS" });
    }
    if (!action && request.method === "GET") return handleGetRecipe(request, env, recipeId);
    return jsonError("not_found", "Not found", 404);
  }
  return jsonError("not_found", "Not found", 404);
}
