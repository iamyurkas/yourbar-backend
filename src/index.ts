import { generateRecipeId, isValidRecipeId } from "./ids.js";
import { corsPreflight, escapeHtml, htmlResponse, isJsonContentType, jsonError, jsonResponse, withCors } from "./http.js";
import { getRecipeIdByChecksum, getRecipeShare, putRecipeShare, type RecipeShareRecord } from "./storage.js";
import { validateRecipeSharePayloadV1, type Ingredient, type RecipeSharePayloadV1, type RecipeTag } from "./schema.js";

type RecipeImageObject = {
  body: BodyInit;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

type RecipeImageBucket = {
  get(key: string): Promise<RecipeImageObject | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
};

export interface Env {
  RECIPE_SHARES: KVNamespace;
  RECIPE_IMAGES?: RecipeImageBucket;
  PUBLIC_BASE_URL?: string;
  APP_DEEP_LINK_SCHEME?: string;
  DEFAULT_RECIPE_TTL_SECONDS?: string;
  MAX_RECIPE_PAYLOAD_BYTES?: string;
  MAX_IMAGE_BYTES?: string;
  IMAGE_PUBLIC_BASE_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  IOS_APP_STORE_URL?: string;
  ANDROID_PLAY_STORE_URL?: string;
  IOS_APP_IDS?: string;
  ANDROID_PACKAGE_NAME?: string;
  ANDROID_SHA256_CERT_FINGERPRINTS?: string;
  APPLE_APP_SITE_ASSOCIATION_JSON?: string;
  ANDROID_ASSET_LINKS_JSON?: string;
}

const SERVICE_NAME = "yourbar-share-api";
const IMAGE_FIELD_NAME = "image";
const IMAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i;
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function envNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
}

function imagePublicBaseUrl(env: Env): string {
  return (env.IMAGE_PUBLIC_BASE_URL ?? `${publicBaseUrl(env)}/images`).replace(/\/+$/, "");
}

function deepLinkScheme(env: Env): string {
  return env.APP_DEEP_LINK_SCHEME ?? "yourbar";
}

function isMultipartFormData(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(";")[0]?.trim() === "multipart/form-data";
}

async function readJsonWithLimit(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return { ok: false, response: jsonError("payload_too_large", `Payload must be ${maxBytes} bytes or smaller`, 413) };
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return { ok: false, response: jsonError("payload_too_large", `Payload must be ${maxBytes} bytes or smaller`, 413) };
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonError("bad_request", "Request body must be valid JSON", 400) };
  }
}

function recipeUrls(env: Env, id: string): { publicUrl: string; apiUrl: string } {
  const base = publicBaseUrl(env);
  return {
    publicUrl: `${base}/r/${id}`,
    apiUrl: `${base}/api/recipes/${id}`,
  };
}

function imageObjectKey(contentType: string): string {
  const extension = ALLOWED_IMAGE_TYPES[contentType] ?? "bin";
  return `${crypto.randomUUID()}.${extension}`;
}

function canonicalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForChecksum(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalizeForChecksum(entryValue)]),
    );
  }

  return typeof value === "string" ? value.trim() : value;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recipeChecksum(recipe: unknown): Promise<string> {
  const canonicalRecipe = JSON.stringify(canonicalizeForChecksum(recipe));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRecipe));
  return bytesToHex(digest);
}

function normalizeTextLines(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : value.split(/\r?\n/);
  return values.map((item) => item.trim()).filter(Boolean);
}

function renderInlineMarkup(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+?)\*/g, "$1<em>$2</em>");
}

function capitalizeFirstLetter(value: string): string {
  return value.replace(/^(\P{L}*)(\p{L})/u, (_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`);
}

function renderInstructionSection(
  title: string,
  value: string | string[] | undefined,
  options: { capitalizeFirstLetter?: boolean; singleAsParagraph?: boolean } = {},
): string {
  const steps = normalizeTextLines(value).map((step) => (options.capitalizeFirstLetter ? capitalizeFirstLetter(step) : step));
  if (steps.length === 0) return "";
  if (options.singleAsParagraph && steps.length === 1) {
    return `<section><h2>${escapeHtml(title)}</h2><p>${renderInlineMarkup(steps[0] ?? "")}</p></section>`;
  }
  const items = steps.map((step) => `<li>${renderInlineMarkup(step)}</li>`).join("");
  return `<section><h2>${escapeHtml(title)}</h2><ol>${items}</ol></section>`;
}

function displayUnit(ingredient: Ingredient): string | undefined {
  return ingredient.unitName?.trim() || ingredient.unit?.trim() || ingredient.unitId?.trim() || undefined;
}

function displayGlassware(recipe: RecipeSharePayloadV1["recipe"]): string | undefined {
  return recipe.glasswareName?.trim() || recipe.glassware?.trim() || recipe.glasswareId?.trim() || undefined;
}

function displayMethod(recipe: RecipeSharePayloadV1["recipe"]): string | string[] | undefined {
  if (recipe.methodName?.trim()) return recipe.methodName.trim();
  if (recipe.method && typeof recipe.method === "object" && !Array.isArray(recipe.method)) return recipe.method.name;
  return recipe.method;
}

function displayTag(tag: RecipeTag): string {
  return typeof tag === "string" ? tag : tag.name;
}

function renderIngredientAmount(ingredient: Ingredient): string {
  const parts = [ingredient.amount, displayUnit(ingredient)]
    .filter((part) => part !== undefined && String(part).trim().length > 0)
    .map((part) => String(part).trim());
  return parts.join(" ");
}

function renderIngredients(ingredients: Ingredient[]): string {
  const items = ingredients
    .map((ingredient) => {
      const amount = renderIngredientAmount(ingredient);
      const note = ingredient.note?.trim();
      const imageUrl = ingredient.imageUrl?.trim();
      const image = imageUrl
        ? `<img class="ingredient-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(ingredient.name.trim())}" loading="lazy">`
        : "";
      const description = ingredient.description?.trim() ? `<p class="ingredient-description">${renderInlineMarkup(ingredient.description.trim())}</p>` : "";
      const tags = ingredient.tags?.map((tag) => displayTag(tag).trim()).filter(Boolean) ?? [];
      const tagList = tags.length > 0
        ? `<div class="ingredient-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</div>`
        : "";

      return `<li>${image}<div class="ingredient-content"><div>${amount ? `<span class="amount">${escapeHtml(amount)}</span> ` : ""}<span>${escapeHtml(ingredient.name.trim())}</span>${note ? ` <span class="note">(${escapeHtml(note)})</span>` : ""}</div>${description}${tagList}</div></li>`;
    })
    .join("");
  return `<section><h2>Ingredients</h2><ul class="ingredients">${items}</ul></section>`;
}

function renderRecipeDetails(recipe: RecipeSharePayloadV1["recipe"]): string {
  const details: string[] = [];
  const glassware = displayGlassware(recipe);
  if (glassware) details.push(`<dt>Glassware</dt><dd>${escapeHtml(glassware)}</dd>`);
  if (recipe.garnish?.trim()) details.push(`<dt>Garnish</dt><dd>${escapeHtml(recipe.garnish.trim())}</dd>`);
  if (recipe.servings !== undefined) details.push(`<dt>Servings</dt><dd>${recipe.servings}</dd>`);
  const tags = recipe.tags?.map((tag) => displayTag(tag).trim()).filter(Boolean) ?? [];
  if (tags.length > 0) details.push(`<dt>Tags</dt><dd>${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ")}</dd>`);
  return details.length > 0 ? `<section><h2>Details</h2><dl>${details.join("")}</dl></section>` : "";
}

async function handlePostImage(request: Request, env: Env): Promise<Response> {
  if (!env.RECIPE_IMAGES) {
    return jsonError("storage_not_configured", "Image storage is not configured", 503);
  }

  if (!isMultipartFormData(request.headers.get("Content-Type"))) {
    return jsonError("unsupported_media_type", "Content-Type must be multipart/form-data", 415);
  }

  const maxBytes = envNumber(env.MAX_IMAGE_BYTES, 5_242_880);
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return jsonError("payload_too_large", `Image must be ${maxBytes} bytes or smaller`, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("bad_request", "Request body must be valid multipart form data", 400);
  }

  const image = form.get(IMAGE_FIELD_NAME);
  if (!(image instanceof File)) {
    return jsonError("validation_failed", `Multipart form must include an image file in the "${IMAGE_FIELD_NAME}" field`, 400);
  }

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_IMAGE_TYPES, image.type)) {
    return jsonError("validation_failed", "Image must be a JPEG, PNG, or WebP file", 400, [{ path: IMAGE_FIELD_NAME, message: "Unsupported image content type" }]);
  }

  if (image.size < 1) {
    return jsonError("validation_failed", "Image file must not be empty", 400, [{ path: IMAGE_FIELD_NAME, message: "Must not be empty" }]);
  }

  if (image.size > maxBytes) {
    return jsonError("payload_too_large", `Image must be ${maxBytes} bytes or smaller`, 413);
  }

  const key = imageObjectKey(image.type);
  const bytes = await image.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    return jsonError("payload_too_large", `Image must be ${maxBytes} bytes or smaller`, 413);
  }

  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType: image.type },
    customMetadata: { originalName: image.name.slice(0, 256) },
  });

  return jsonResponse({ key, imageUrl: `${imagePublicBaseUrl(env)}/${key}` }, 201);
}

async function handleGetImage(key: string, env: Env): Promise<Response> {
  if (!env.RECIPE_IMAGES) {
    return jsonError("storage_not_configured", "Image storage is not configured", 503);
  }

  if (!IMAGE_KEY_PATTERN.test(key)) {
    return jsonError("bad_request", "Invalid image key", 400);
  }

  const object = await env.RECIPE_IMAGES.get(key);
  if (!object) return jsonError("not_found", "Image was not found", 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(object.body, { headers });
}

async function handlePostRecipe(request: Request, env: Env): Promise<Response> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return jsonError("unsupported_media_type", "Content-Type must be application/json", 415);
  }

  const maxBytes = envNumber(env.MAX_RECIPE_PAYLOAD_BYTES, 65_536);
  const json = await readJsonWithLimit(request, maxBytes);
  if (!json.ok) return json.response;

  const validation = validateRecipeSharePayloadV1(json.value);
  if (!validation.ok) {
    return jsonError("validation_failed", "Recipe share payload is invalid", 400, validation.issues);
  }

  const checksum = await recipeChecksum(validation.value.recipe);
  const existingId = await getRecipeIdByChecksum(env.RECIPE_SHARES, checksum);
  if (existingId) {
    const existingRecord = await getRecipeShare(env.RECIPE_SHARES, existingId);
    if (existingRecord) {
      return jsonResponse({
        id: existingRecord.id,
        ...recipeUrls(env, existingRecord.id),
        expiresAt: existingRecord.expiresAt,
        recipeChecksum: existingRecord.recipeChecksum,
        duplicate: true,
      }, 200);
    }
  }

  const ttlSeconds = envNumber(env.DEFAULT_RECIPE_TTL_SECONDS, 2_592_000);
  const now = Date.now();
  const id = generateRecipeId();
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  const record: RecipeShareRecord = {
    id,
    payload: validation.value,
    createdAt: new Date(now).toISOString(),
    expiresAt,
    recipeChecksum: checksum,
  };

  await putRecipeShare(env.RECIPE_SHARES, record, ttlSeconds);
  return jsonResponse({ id, ...recipeUrls(env, id), expiresAt, recipeChecksum: checksum, duplicate: false }, 201);
}

async function handleGetRecipe(id: string, env: Env): Promise<Response> {
  if (!isValidRecipeId(id)) return jsonError("bad_request", "Invalid recipe id", 400);
  const record = await getRecipeShare(env.RECIPE_SHARES, id);
  if (!record) return jsonError("not_found", "Recipe share was not found", 404);
  return jsonResponse(record);
}

export function renderRecipeLandingPage(record: RecipeShareRecord, env: Env): string {
  const { id, payload } = record;
  const recipe = payload.recipe;
  const recipeName = recipe.name.trim();
  const title = `${recipeName} cocktail recipe | YourBar`;
  const escapedTitle = escapeHtml(title);
  const escapedRecipeName = escapeHtml(recipeName);
  const description = recipe.description?.trim() || `Full recipe for ${recipeName}: ingredients, method, and import link for YourBar.`;
  const escapedDescription = escapeHtml(description);
  const urls = recipeUrls(env, id);
  const apiUrl = escapeHtml(urls.apiUrl);
  const publicUrl = escapeHtml(urls.publicUrl);
  const deepLink = `${deepLinkScheme(env)}://import/recipe/${encodeURIComponent(id)}`;
  const escapedDeepLink = escapeHtml(deepLink);
  const iosLink = env.IOS_APP_STORE_URL ? `<a class="secondary" href="${escapeHtml(env.IOS_APP_STORE_URL)}">Install for iOS</a>` : "";
  const androidLink = env.ANDROID_PLAY_STORE_URL ? `<a class="secondary" href="${escapeHtml(env.ANDROID_PLAY_STORE_URL)}">Install for Android</a>` : "";
  const imageUrl = recipe.imageUrl?.trim();
  const escapedImageUrl = imageUrl ? escapeHtml(imageUrl) : "";
  const imageMeta = escapedImageUrl ? `\n  <meta property="og:image" content="${escapedImageUrl}">\n  <meta name="twitter:card" content="summary_large_image">` : `\n  <meta name="twitter:card" content="summary">`;
  const image = escapedImageUrl ? `<img class="recipe-image" src="${escapedImageUrl}" alt="${escapedRecipeName} cocktail photo" loading="eager">` : "";
  const detailsSection = renderRecipeDetails(recipe);
  const ingredientsSection = renderIngredients(recipe.ingredients);
  const methodSection = renderInstructionSection("Method", displayMethod(recipe), { capitalizeFirstLetter: true, singleAsParagraph: true });
  const instructionsSection = renderInstructionSection("Instructions", recipe.instructions);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=${escapedDeepLink}">
  <title>${escapedTitle}</title>
  <meta property="og:title" content="${escapedTitle}">
  <meta name="description" content="${escapedDescription}">
  <meta property="og:description" content="${escapedDescription}">
  <meta property="og:type" content="website">${imageMeta}
  <meta property="og:url" content="${publicUrl}">
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem 0; background: #130f1c; color: #fff7ed; }
    main { width: min(92vw, 42rem); overflow: hidden; border: 1px solid rgb(255 255 255 / 14%); border-radius: 1.5rem; background: rgb(255 255 255 / 8%); box-shadow: 0 24px 80px rgb(0 0 0 / 35%); }
    .content { padding: 2rem; }
    .eyebrow { margin-top: 0; text-transform: uppercase; letter-spacing: 0.12em; font-size: 0.78rem; color: #ffbd86; }
    .recipe-image { display: block; width: 100%; max-height: 28rem; object-fit: cover; background: rgb(0 0 0 / 28%); }
    h1 { margin: 0 0 0.75rem; font-size: clamp(2rem, 8vw, 3.5rem); line-height: 0.95; }
    h2 { margin: 1.75rem 0 0.75rem; font-size: 1.1rem; color: #ffe0c2; }
    p, li, dd { color: #f3d9c2; line-height: 1.6; }
    ol, ul { padding-left: 1.35rem; }
    li + li { margin-top: 0.35rem; }
    .ingredients { padding-left: 0; list-style: none; }
     .ingredients li { display: flex; gap: 0.85rem; margin: 0.75rem 0; }
    .ingredient-image { flex: 0 0 4rem; width: 4rem; height: 4rem; object-fit: cover; border-radius: 0.75rem; background: rgb(0 0 0 / 28%); }
    .ingredient-content { min-width: 0; }
    .ingredient-description { margin: 0.35rem 0 0; color: #f8d4b4; }
    .ingredient-tags { margin-top: 0.45rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1rem; }
    dt { color: #ffbd86; font-weight: 700; }
    dd { margin: 0; }
    .amount { color: #fff7ed; font-weight: 700; }
    .note { color: #d7b89d; }
    .tag { display: inline-block; margin: 0 0.3rem 0.3rem 0; padding: 0.15rem 0.55rem; border-radius: 999px; background: rgb(255 255 255 / 12%); color: #ffe0c2; }
    a.button, a.secondary { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: 0 1rem; border-radius: 999px; text-decoration: none; font-weight: 700; }
    a.button { background: #ff8a3d; color: #1f1208; }
    a.secondary { margin-top: 0.75rem; margin-right: 0.5rem; border: 1px solid rgb(255 255 255 / 22%); color: #fff7ed; }
    code { display: block; overflow-wrap: anywhere; padding: 0.85rem; border-radius: 0.75rem; background: rgb(0 0 0 / 28%); color: #ffe0c2; }
  </style>
</head>
<body>
  <main>
    ${image}
    <div class="content">
      <p class="eyebrow">YourBar cocktail recipe</p>
      <h1>${escapedRecipeName}</h1>
      <p>${renderInlineMarkup(description)}</p>
      ${detailsSection}
      ${ingredientsSection}
      ${methodSection}
      ${instructionsSection}
      <section>
        <h2>Open in the app</h2>
        <p>If YourBar is installed, this page will try to open the app automatically. You can also use the button below.</p>
        <p><a class="button" href="${escapedDeepLink}">Open in YourBar</a></p>
        ${iosLink || androidLink ? `<p>${iosLink}${androidLink}</p>` : ""}
      </section>
      <section>
        <h2>Canonical API URL</h2>
        <code>${apiUrl}</code>
      </section>
    </div>
  </main>
</body>
</html>`;
}

function renderNotFoundPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recipe not found</title></head><body><main><h1>Recipe not found</h1><p>This YourBar recipe share may have expired or been removed.</p></main></body></html>`;
}

async function handleRecipeLanding(id: string, env: Env): Promise<Response> {
  if (!isValidRecipeId(id)) return htmlResponse(renderNotFoundPage(), 404);
  const record = await getRecipeShare(env.RECIPE_SHARES, id);
  if (!record) return htmlResponse(renderNotFoundPage(), 404);
  return htmlResponse(renderRecipeLandingPage(record, env));
}

function commaSeparatedValues(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function appleAppSiteAssociation(env: Env): unknown {
  const appIDs = commaSeparatedValues(env.IOS_APP_IDS);
  return {
    applinks: {
      details: [
        {
          appIDs,
          paths: ["/r/*"],
          components: [{ "/": "/r/*", comment: "Matches YourBar recipe share links" }],
        },
      ],
    },
  };
}

function androidAssetLinks(env: Env): unknown {
  const packageName = env.ANDROID_PACKAGE_NAME?.trim();
  const fingerprints = commaSeparatedValues(env.ANDROID_SHA256_CERT_FINGERPRINTS);
  if (!packageName || fingerprints.length === 0) return [];

  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

function wellKnownJson(rawJson: string | undefined, fallback: unknown): Response {
  if (rawJson?.trim()) {
    try {
      JSON.parse(rawJson);
      return new Response(rawJson, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    } catch {
      return jsonError("internal_error", "Configured well-known JSON is invalid", 500);
    }
  }
  return jsonResponse(fallback, 200, { "Cache-Control": "public, max-age=3600" });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path.startsWith("/api/") && request.method === "OPTIONS") {
      return corsPreflight(request, env.CORS_ALLOWED_ORIGINS);
    }

    let response: Response;
    if (path === "/health") {
      response = request.method === "GET"
        ? jsonResponse({ ok: true, service: SERVICE_NAME })
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET" });
    } else if (path === "/api/images") {
      response = request.method === "POST"
        ? await handlePostImage(request, env)
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "POST, OPTIONS" });
    } else if (path === "/api/recipes") {
      response = request.method === "POST"
        ? await handlePostRecipe(request, env)
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "POST, OPTIONS" });
    } else if (path.startsWith("/api/recipes/")) {
      const id = path.slice("/api/recipes/".length);
      response = request.method === "GET"
        ? await handleGetRecipe(id, env)
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET, OPTIONS" });
    } else if (path.startsWith("/images/")) {
      const key = path.slice("/images/".length);
      response = request.method === "GET"
        ? await handleGetImage(key, env)
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET" });
    } else if (path.startsWith("/r/")) {
      const id = path.slice("/r/".length);
      response = request.method === "GET"
        ? await handleRecipeLanding(id, env)
        : htmlResponse(renderNotFoundPage(), 405, { Allow: "GET" });
    } else if (path === "/.well-known/apple-app-site-association") {
      response = request.method === "GET"
        ? wellKnownJson(env.APPLE_APP_SITE_ASSOCIATION_JSON, appleAppSiteAssociation(env))
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET" });
    } else if (path === "/.well-known/assetlinks.json") {
      response = request.method === "GET"
        ? wellKnownJson(env.ANDROID_ASSET_LINKS_JSON, androidAssetLinks(env))
        : jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET" });
    } else {
      response = jsonError("not_found", "Not found", 404);
    }

    return path.startsWith("/api/") ? withCors(response, request, env.CORS_ALLOWED_ORIGINS) : response;
  } catch {
    const response = jsonError("internal_error", "Internal server error", 500);
    return path.startsWith("/api/") ? withCors(response, request, env.CORS_ALLOWED_ORIGINS) : response;
  }
}

export default {
  fetch: handleRequest,
};
