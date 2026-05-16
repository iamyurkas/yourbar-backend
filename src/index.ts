import { generateRecipeId, isValidRecipeId } from "./ids.js";
import { corsPreflight, escapeHtml, htmlResponse, isJsonContentType, jsonError, jsonResponse, withCors } from "./http.js";
import { getRecipeIdByChecksum, getRecipeShare, putRecipeShare, type RecipeShareRecord } from "./storage.js";
import { staticAssetResponse } from "./static-assets.js";
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

const TAG_COLORS = [
  "#ec5a5a",
  "#F06292",
  "#BA68C8",
  "#9575CD",
  "#7986CB",
  "#64B5F6",
  "#4FC3F7",
  "#4DD0E1",
  "#4DB6AC",
  "#81C784",
  "#AED581",
  "#CBD664",
  "#FFD54F",
  "#FFB74D",
  "#FF8A65",
  "#a8a8a8",
  "#707070",
] as const;

const COCKTAIL_TAG_COLORS: Record<string, string> = {
  "IBA Official": TAG_COLORS[9],
  "Equal Parts": TAG_COLORS[5],
  Bitter: TAG_COLORS[3],
  Tiki: TAG_COLORS[7],
  Strong: TAG_COLORS[0],
  Medium: TAG_COLORS[1],
  Soft: TAG_COLORS[12],
  Long: TAG_COLORS[13],
  Shot: TAG_COLORS[14],
  "Non-alcoholic": TAG_COLORS[11],
  Custom: TAG_COLORS[15],
};

const INGREDIENT_TAG_COLORS: Record<string, string> = {
  "Base spirit": TAG_COLORS[16],
  Liqueur: TAG_COLORS[0],
  "Wine/Vermouth": TAG_COLORS[1],
  "Beer/Cider": TAG_COLORS[3],
  Bitters: TAG_COLORS[14],
  Syrup: TAG_COLORS[13],
  Mixer: TAG_COLORS[9],
  "Fruit/Veg & Juice": TAG_COLORS[10],
  "Fridge/Pantry": TAG_COLORS[6],
  Other: TAG_COLORS[15],
};

const DEFAULT_TAG_COLOR = "#9CCAFF";
const DARK_TAG_TEXT_COLOR = "#0B1017";

function normalizeTagName(value: string): string {
  return value.trim().toLowerCase();
}

function createTagColorLookup(source: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(source).map(([name, color]) => [normalizeTagName(name), color]));
}

const COCKTAIL_TAG_COLOR_BY_NAME = createTagColorLookup(COCKTAIL_TAG_COLORS);
const INGREDIENT_TAG_COLOR_BY_NAME = createTagColorLookup(INGREDIENT_TAG_COLORS);

function getCocktailTagColor(name: string): string {
  return COCKTAIL_TAG_COLOR_BY_NAME.get(normalizeTagName(name)) ?? DEFAULT_TAG_COLOR;
}

function getIngredientTagColor(name: string): string {
  return INGREDIENT_TAG_COLOR_BY_NAME.get(normalizeTagName(name)) ?? DEFAULT_TAG_COLOR;
}

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

function renderCocktailTag(tag: string): string {
  return `<span class="tag-chip" style="--tag-color: ${getCocktailTagColor(tag)}">${escapeHtml(tag)}</span>`;
}

function renderIngredientTag(tag: string): string {
  return `<span class="ingredient-tag" style="--tag-color: ${getIngredientTagColor(tag)}">${escapeHtml(tag)}</span>`;
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
      const ingredientName = ingredient.name.trim();
      const image = imageUrl
        ? `<div class="ingredient-thumb"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(ingredientName)}" loading="lazy"></div>`
        : `<div class="ingredient-thumb ingredient-thumb-placeholder" aria-hidden="true">${escapeHtml(ingredientName.slice(0, 1).toLocaleUpperCase())}</div>`;
      const description = ingredient.description?.trim() ? `<p class="ingredient-description">${renderInlineMarkup(ingredient.description.trim())}</p>` : "";
      const tags = ingredient.tags?.map((tag) => displayTag(tag).trim()).filter(Boolean) ?? [];
      const tagList = tags.length > 0
        ? `<div class="ingredient-tags">${tags.map((tag) => renderIngredientTag(tag)).join(" ")}</div>`
        : "";

      return `<li class="ingredient-row">${image}<div class="ingredient-content"><div class="ingredient-line"><span class="ingredient-name">${escapeHtml(ingredientName)}</span>${amount ? `<span class="ingredient-amount">${escapeHtml(amount)}</span>` : ""}</div>${note ? `<span class="note">${escapeHtml(note)}</span>` : ""}${description}${tagList}</div></li>`;
    })
    .join("");
  return `<section><h2>Ingredients</h2><ul class="ingredients">${items}</ul></section>`;
}

type VideoService = "youtube" | "tiktok" | "instagram" | "vimeo" | "generic";

function safeHttpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function videoServiceForUrl(videoUrl: string): VideoService {
  const hostname = new URL(videoUrl).hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "youtu.be" || hostname.endsWith(".youtube.com") || hostname === "youtube.com") return "youtube";
  if (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) return "tiktok";
  if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) return "instagram";
  if (hostname === "vimeo.com" || hostname.endsWith(".vimeo.com")) return "vimeo";
  return "generic";
}

function videoServiceLabel(service: VideoService): string {
  switch (service) {
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "instagram":
      return "Instagram";
    case "vimeo":
      return "Vimeo";
    case "generic":
      return "Video";
  }
}

function videoServiceIcon(service: VideoService): string {
  switch (service) {
    case "youtube":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M21.58 7.19a2.55 2.55 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.78.39a2.55 2.55 0 0 0-1.8 1.8A26.6 26.6 0 0 0 2 12a26.6 26.6 0 0 0 .42 4.81 2.55 2.55 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.78-.39a2.55 2.55 0 0 0 1.8-1.8A26.6 26.6 0 0 0 22 12a26.6 26.6 0 0 0-.42-4.81ZM10 15.01V8.99L15.2 12 10 15.01Z"/></svg>`;
    case "tiktok":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M16.6 3c.36 2.12 1.55 3.4 3.65 3.54v3.3a7.42 7.42 0 0 1-3.58-1.08v5.94c0 3.01-1.9 5.3-4.79 5.3A4.74 4.74 0 0 1 7 15.23c0-3.05 2.33-5.13 5.6-4.84v3.38c-1.48-.48-2.48.22-2.48 1.43 0 1 .79 1.66 1.7 1.66 1.05 0 1.72-.63 1.72-2.11V3h3.06Z"/></svg>`;
    case "instagram":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M7.75 2h8.5A5.76 5.76 0 0 1 22 7.75v8.5A5.76 5.76 0 0 1 16.25 22h-8.5A5.76 5.76 0 0 1 2 16.25v-8.5A5.76 5.76 0 0 1 7.75 2Zm0 2A3.75 3.75 0 0 0 4 7.75v8.5A3.75 3.75 0 0 0 7.75 20h8.5A3.75 3.75 0 0 0 20 16.25v-8.5A3.75 3.75 0 0 0 16.25 4h-8.5ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm5.25-2.1a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z"/></svg>`;
    case "vimeo":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M21.5 7.23c-.08 1.86-1.38 4.4-3.91 7.61-2.62 3.36-4.84 5.04-6.65 5.04-1.12 0-2.07-1.04-2.84-3.12-.52-1.91-1.04-3.82-1.55-5.73-.58-2.08-1.2-3.12-1.86-3.12-.14 0-.65.31-1.51.91L2.28 7.65c.95-.84 1.89-1.68 2.82-2.52 1.27-1.1 2.22-1.68 2.85-1.74 1.49-.14 2.41.88 2.76 3.06.38 2.36.64 3.83.79 4.4.44 1.96.92 2.94 1.45 2.94.41 0 1.03-.65 1.85-1.95.82-1.3 1.26-2.29 1.32-2.97.12-1.12-.32-1.68-1.32-1.68-.47 0-.95.11-1.45.32.96-3.16 2.8-4.69 5.51-4.6 2.01.06 2.89 1.5 2.64 4.32Z"/></svg>`;
    case "generic":
      return `<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Zm5 3.1v6.8L15 12 9 8.6Z"/></svg>`;
  }
}

function renderVideoLink(videoUrl: string | undefined): string {
  const safeUrl = safeHttpUrl(videoUrl);
  if (!safeUrl) return "";
  const service = videoServiceForUrl(safeUrl);
  const label = videoServiceLabel(service);
  return `<a class="video-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Watch cocktail video on ${escapeHtml(label)}" title="Watch on ${escapeHtml(label)}">${videoServiceIcon(service)}<span>${escapeHtml(label)}</span></a>`;
}

const shareText = {
  share: "Share cocktail",
  exportAsPhoto: "Export as photo",
  shareAsLink: "Share as link",
} as const;

function renderShareMenu(publicUrl: string, imageUrl?: string): string {
  const escapedPublicUrl = escapeHtml(publicUrl);
  const exportHref = imageUrl?.trim() ? escapeHtml(imageUrl.trim()) : escapedPublicUrl;
  const exportAttributes = imageUrl?.trim() ? ` download` : "";

  return `<details class="share-menu">
        <summary class="button share-trigger">${shareText.share}</summary>
        <div class="share-popover" role="dialog" aria-label="${shareText.share}">
          <a class="button secondary-button" href="${exportHref}"${exportAttributes}>${shareText.exportAsPhoto}</a>
          <button class="button secondary-button" type="button" data-share-link="${escapedPublicUrl}">${shareText.shareAsLink}</button>
        </div>
      </details>`;
}

function renderRecipeDetails(recipe: RecipeSharePayloadV1["recipe"]): string {
  const details: string[] = [];
  const glassware = displayGlassware(recipe);
  if (glassware) details.push(`<dt>Glassware</dt><dd>${escapeHtml(glassware)}</dd>`);
  if (recipe.garnish?.trim()) details.push(`<dt>Garnish</dt><dd>${escapeHtml(recipe.garnish.trim())}</dd>`);
  if (recipe.servings !== undefined) details.push(`<dt>Servings</dt><dd>${recipe.servings}</dd>`);
  const tags = recipe.tags?.map((tag) => displayTag(tag).trim()).filter(Boolean) ?? [];
  if (tags.length > 0) details.push(`<dt>Tags</dt><dd>${tags.map((tag) => renderCocktailTag(tag)).join(" ")}</dd>`);
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


function appStoreLinks(env: Env): { iosLink: string; androidLink: string } {
  const iosStoreUrl = env.IOS_APP_STORE_URL?.trim() || "https://apps.apple.com/app/your-bar-cocktail-recipes/id6758964503";
  const androidStoreUrl = env.ANDROID_PLAY_STORE_URL?.trim() || "https://play.google.com/store/apps/details?id=com.yourbarapp.free";
  return {
    iosLink: `<a class="store-badge" href="${escapeHtml(iosStoreUrl)}" aria-label="Download YourBar on the App Store"><img src="/assets/images/appstore.png" alt="Download on the App Store" loading="lazy"></a>`,
    androidLink: `<a class="store-badge" href="${escapeHtml(androidStoreUrl)}" aria-label="Get YourBar on Google Play"><img src="/assets/images/playmarket.png" alt="Get it on Google Play" loading="lazy"></a>`,
  };
}

export function renderHomePage(env: Env): string {
  const { iosLink, androidLink } = appStoreLinks(env);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Bar | Cocktail recipes you can actually make</title>
  <meta name="description" content="Track your home bar, discover cocktails you can make, plan parties, and share recipes with friends.">
  <meta property="og:title" content="Your Bar">
  <meta property="og:description" content="Track your home bar, discover cocktails you can make, plan parties, and share recipes with friends.">
  <meta property="og:type" content="website">
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --brand-blue: #4DABF7;
      --sky: var(--brand-blue);
      --sky-deep: #126ba8;
      --ink: #152235;
      --muted: #5c6977;
      --cream: #fff7ec;
      --card: rgba(255, 255, 255, 0.88);
      --card-strong: rgba(255, 255, 255, 0.96);
      --line: rgba(34, 44, 57, 0.1);
      --shadow: rgba(39, 69, 94, 0.18);
      --warm: #ffb866;
      --rose: #e65c6a;
      --mint: #4db6ac;
    }
    * { box-sizing: border-box; }
    html {
      min-height: 100%;
      background: var(--sky);
    }
    body {
      margin: 0;
      min-height: 100svh;
      color: var(--ink);
      background:
        radial-gradient(circle at 13% 14%, rgba(255, 248, 230, 0.88), transparent 24rem),
        radial-gradient(circle at 87% 11%, rgba(255, 184, 102, 0.46), transparent 21rem),
        radial-gradient(circle at 78% 92%, rgba(77, 182, 172, 0.28), transparent 22rem),
        linear-gradient(140deg, #4dabf7 0%, #dff2ff 54%, #fff7ec 100%);
      overflow-x: hidden;
    }
    a { color: inherit; }
    .page {
      width: min(1230px, 100%);
      min-height: 100svh;
      margin: 0 auto;
      padding: clamp(12px, 2.1vw, 24px);
      display: grid;
      place-items: center;
    }
    .app-shell {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(300px, 0.83fr) minmax(0, 1.17fr);
      gap: clamp(12px, 1.8vw, 22px);
      align-items: stretch;
    }
    .hero-card,
    .feature-card,
    .cta-card {
      border: 1px solid var(--line);
      background: var(--card);
      box-shadow: 0 18px 54px var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero-card {
      min-height: 100%;
      border-radius: clamp(28px, 4vw, 44px);
      padding: clamp(18px, 3.2vw, 36px);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden;
      position: relative;
    }
    .hero-card::after {
      content: "";
      position: absolute;
      width: 15rem;
      height: 15rem;
      right: -6rem;
      bottom: -7rem;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255, 184, 102, 0.46), transparent 68%);
      pointer-events: none;
    }
    .brand-lockup {
      position: relative;
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: clamp(16px, 2.4vw, 28px);
      z-index: 1;
    }
    .logo-tile {
      width: clamp(70px, 8.5vw, 104px);
      aspect-ratio: 1;
      flex: 0 0 auto;
      border-radius: 28%;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, var(--sky), #2d91dd);
      box-shadow: 0 18px 38px rgba(18, 107, 168, 0.31), inset 0 0 0 1px rgba(255, 255, 255, 0.42);
    }
    .logo-tile img {
      width: 67%;
      height: 67%;
      object-fit: contain;
      filter: brightness(0) invert(1);
    }
    h1 {
      margin: 0;
      font-size: clamp(2.35rem, 5vw, 4.4rem);
      line-height: 0.92;
      letter-spacing: -0.08em;
    }
    .eyebrow {
      margin: 0 0 4px;
      color: var(--sky-deep);
      font-size: 0.76rem;
      font-weight: 850;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .lede {
      position: relative;
      z-index: 1;
      margin: 0;
      font-size: clamp(1.45rem, 3vw, 2.55rem);
      line-height: 1.02;
      letter-spacing: -0.055em;
      font-weight: 850;
    }
    .sublede {
      position: relative;
      z-index: 1;
      margin: clamp(12px, 1.8vw, 18px) 0 0;
      color: var(--muted);
      font-size: clamp(0.94rem, 1.35vw, 1.06rem);
      line-height: 1.45;
    }
    .highlight-strip {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin: clamp(16px, 2.4vw, 26px) 0;
    }
    .mini-stat {
      min-height: 74px;
      padding: 12px;
      border-radius: 20px;
      background: rgba(255, 255, 255, 0.58);
      border: 1px solid var(--line);
    }
    .mini-stat strong {
      display: block;
      margin-bottom: 4px;
      color: var(--ink);
      font-size: 0.92rem;
      letter-spacing: -0.02em;
    }
    .mini-stat span {
      display: block;
      color: var(--muted);
      font-size: 0.78rem;
      line-height: 1.25;
    }
    .cta-card {
      position: relative;
      z-index: 1;
      border-radius: 26px;
      padding: clamp(14px, 1.9vw, 20px);
      background: var(--card-strong);
    }
    .free-note {
      margin: 0 0 12px;
      color: var(--ink);
      font-weight: 850;
      font-size: 1.02rem;
      letter-spacing: -0.02em;
    }
    .store-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .store-badge {
      display: inline-flex;
      align-items: center;
      min-height: 42px;
      transition: transform 160ms ease, filter 160ms ease;
    }
    .store-badge:hover { transform: translateY(-2px); filter: brightness(0.98); }
    .store-badge img {
      display: block;
      height: clamp(40px, 4.5vw, 48px);
      width: auto;
    }
    .content-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: clamp(10px, 1.35vw, 14px);
      align-content: stretch;
    }
    .feature-card {
      border-radius: 26px;
      padding: clamp(14px, 1.8vw, 20px);
      background: var(--card-strong);
    }
    .feature-card.large { grid-column: span 3; }
    .feature-card.medium { grid-column: span 2; }
    .feature-card.wide { grid-column: 1 / -1; }
    .card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      color: var(--ink);
      font-size: clamp(0.95rem, 1.25vw, 1.08rem);
      letter-spacing: -0.025em;
    }
    .icon-dot {
      width: 26px;
      height: 26px;
      border-radius: 10px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      color: #ffffff;
      font-size: 0.84rem;
      background: linear-gradient(145deg, var(--rose), var(--warm));
      box-shadow: 0 9px 18px rgba(230, 92, 106, 0.22);
    }
    .feature-list,
    .chip-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .feature-list {
      display: grid;
      gap: 7px;
    }
    .feature-list li,
    .note {
      color: var(--muted);
      font-size: clamp(0.78rem, 0.96vw, 0.9rem);
      line-height: 1.32;
    }
    .feature-list li {
      position: relative;
      padding-left: 1rem;
    }
    .feature-list li::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0.54em;
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--sky);
    }
    .note { margin: 0; }
    .query-example {
      display: block;
      margin: 9px 0;
      padding: 9px 10px;
      border-radius: 14px;
      background: #eef7ff;
      color: #0b5f99;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: clamp(0.72rem, 0.9vw, 0.84rem);
      line-height: 1.25;
      white-space: normal;
    }
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .chip-list li {
      border: 1px solid rgba(18, 107, 168, 0.13);
      border-radius: 999px;
      padding: 6px 9px;
      background: rgba(238, 247, 255, 0.8);
      color: #244963;
      font-size: clamp(0.74rem, 0.9vw, 0.84rem);
      line-height: 1;
      white-space: nowrap;
    }
    .feature-card.accent {
      background: linear-gradient(145deg, rgba(255, 248, 236, 0.96), rgba(255, 255, 255, 0.94));
    }
    @media (max-width: 900px) {
      body { min-height: 100dvh; }
      .page {
        min-height: 100dvh;
        padding: 10px;
        align-items: start;
      }
      .app-shell {
        grid-template-columns: 1fr;
        gap: 9px;
      }
      .hero-card {
        min-height: 0;
        border-radius: 28px;
        padding: 14px;
      }
      .brand-lockup {
        margin-bottom: 8px;
        gap: 10px;
      }
      .logo-tile { width: 58px; }
      h1 { font-size: clamp(2.35rem, 13vw, 3.25rem); }
      .eyebrow { font-size: 0.66rem; }
      .lede { font-size: clamp(1.25rem, 5.8vw, 1.85rem); }
      .sublede {
        margin-top: 8px;
        font-size: 0.88rem;
        line-height: 1.32;
      }
      .highlight-strip {
        display: none;
      }
      .cta-card {
        margin-top: 12px;
        padding: 10px;
        border-radius: 20px;
      }
      .free-note {
        margin-bottom: 8px;
        font-size: 0.92rem;
      }
      .store-badges { gap: 8px; }
      .store-badge { min-height: 34px; }
      .store-badge img { height: 36px; }
      .content-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .feature-card,
      .feature-card.large,
      .feature-card.medium,
      .feature-card.wide {
        grid-column: auto;
        border-radius: 18px;
        padding: 10px;
      }
      .feature-card.core,
      .feature-card.wide {
        grid-column: 1 / -1;
      }
      .card-title {
        margin-bottom: 6px;
        font-size: 0.9rem;
      }
      .icon-dot {
        width: 22px;
        height: 22px;
        border-radius: 8px;
        font-size: 0.72rem;
      }
      .feature-list { gap: 4px; }
      .feature-list li,
      .note {
        font-size: 0.72rem;
        line-height: 1.22;
      }
      .chip-list { gap: 5px; }
      .chip-list li {
        padding: 5px 7px;
        font-size: 0.68rem;
      }
      .query-example {
        margin: 6px 0;
        padding: 7px;
        font-size: 0.65rem;
      }
    }
    @media (max-width: 420px) {
      .page { padding: 8px; }
      .sublede { font-size: 0.82rem; }
      .store-badge img { height: 32px; }
      .feature-card:not(.core):not(.wide) .feature-list li:nth-child(n + 3) { display: none; }
      .chip-list li { font-size: 0.64rem; }
    }
    @media (max-height: 740px) and (min-width: 901px) {
      .page { padding-block: 12px; }
      .hero-card { padding: 22px; }
      .brand-lockup { margin-bottom: 16px; }
      .highlight-strip { margin: 18px 0; }
      .mini-stat { min-height: 64px; padding: 10px; }
      .feature-card { padding: 14px; }
      .feature-list { gap: 5px; }
      .feature-list li,
      .note { line-height: 1.22; }
      .query-example { margin: 7px 0; padding: 8px 10px; }
      .store-badge img { height: 42px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="app-shell" aria-labelledby="app-title">
      <article class="hero-card">
        <div>
          <div class="brand-lockup">
            <div class="logo-tile" aria-label="Your Bar app logo">
              <img src="/assets/images/cocktails.svg" alt="" aria-hidden="true">
            </div>
            <div>
              <p class="eyebrow">Cocktail companion</p>
              <h1 id="app-title">Your Bar</h1>
            </div>
          </div>
          <p class="lede">Your Bar helps you discover cocktails you can actually make.</p>
          <p class="sublede">Add the ingredients you already have and instantly see which cocktails are available. No more scrolling through recipes that are missing half the ingredients.</p>
          <div class="highlight-strip" aria-label="Your Bar highlights">
            <div class="mini-stat"><strong>Home bar tracking</strong><span>Track ingredients and build your home bar.</span></div>
            <div class="mini-stat"><strong>Barcode scanning</strong><span>Add ingredients manually or by scanning barcodes.</span></div>
            <div class="mini-stat"><strong>Make it now</strong><span>Discover cocktails you can make right now.</span></div>
            <div class="mini-stat"><strong>Missing ingredients</strong><span>See missing ingredients for each recipe.</span></div>
            <div class="mini-stat"><strong>Public links</strong><span>Share cocktail recipes with friends using public links.</span></div>
          </div>
        </div>
        <div class="cta-card" aria-label="Download Your Bar">
          <p class="free-note">Completely free. No ads. No account required for normal use.</p>
          <div class="store-badges">
            ${iosLink}
            ${androidLink}
          </div>
        </div>
      </article>
      <div class="content-grid" aria-label="Your Bar features">
        <section class="feature-card large core">
          <h2 class="card-title"><span class="icon-dot">🍸</span> Build your bar</h2>
          <ul class="feature-list">
            <li>Track ingredients and build your home bar</li>
            <li>Add ingredients manually or by scanning barcodes</li>
            <li>Discover cocktails you can make right now</li>
            <li>See missing ingredients for each recipe</li>
            <li>Save and rate your favorite drinks</li>
            <li>Sort ingredients and cocktails</li>
          </ul>
        </section>
        <section class="feature-card large">
          <h2 class="card-title"><span class="icon-dot">🔗</span> Share recipes</h2>
          <ul class="feature-list">
            <li>Share cocktail recipes with friends using public links</li>
            <li>Open shared recipes and import them into your bar</li>
            <li>Preview shared recipe ingredients before importing</li>
          </ul>
        </section>
        <section class="feature-card medium accent">
          <h2 class="card-title"><span class="icon-dot">🛒</span> Plan your next party with ease:</h2>
          <ul class="feature-list">
            <li>Select cocktails for your party</li>
            <li>Automatically add all required ingredients to your shopping list</li>
          </ul>
        </section>
        <section class="feature-card medium">
          <h2 class="card-title"><span class="icon-dot">☁️</span> Keep your data in sync across devices:</h2>
          <p class="note">Optionally sync your bars, ingredients, cocktails, and settings via Google Drive</p>
        </section>
        <section class="feature-card medium">
          <h2 class="card-title"><span class="icon-dot">⚖️</span> Choose how recipes are displayed:</h2>
          <p class="note">Metric (ml), Imperial (oz), or Parts. You can also set the number of servings — quantities adjust automatically.</p>
        </section>
        <section class="feature-card wide">
          <h2 class="card-title"><span class="icon-dot">🔎</span> Search cocktails the way you think:</h2>
          <code class="query-example">(rum OR gin) AND (campari OR aperol)</code>
          <p class="note">The app understands ingredient substitutions, so you’ll see drinks you can realistically make.</p>
        </section>
        <section class="feature-card wide">
          <h2 class="card-title"><span class="icon-dot">✨</span> More helpful features:</h2>
          <ul class="chip-list">
            <li>“One more ingredient” suggestions for your next bottle</li>
            <li>Multiple bars for different setups</li>
            <li>Dark mode</li>
            <li>Completely free. No ads.</li>
            <li>No account required for normal use</li>
          </ul>
        </section>
      </div>
    </section>
  </main>
</body>
</html>`;
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
  const { iosLink, androidLink } = appStoreLinks(env);
  const imageUrl = recipe.imageUrl?.trim();
  const escapedImageUrl = imageUrl ? escapeHtml(imageUrl) : "";
  const imageMeta = escapedImageUrl ? `\n  <meta property="og:image" content="${escapedImageUrl}">\n  <meta name="twitter:card" content="summary_large_image">` : `\n  <meta name="twitter:card" content="summary">`;
  const recipeMedia = escapedImageUrl
    ? `<div class="cocktail-image-frame"><img class="cocktail-image" src="${escapedImageUrl}" alt="${escapedRecipeName} cocktail photo" loading="eager"></div>`
    : `<div class="cocktail-image-placeholder" aria-label="No photo for ${escapedRecipeName}">${escapeHtml(recipeName.slice(0, 1).toLocaleUpperCase() || "No photo")}</div>`;
  const videoLink = renderVideoLink(recipe.video);
  const detailsSection = renderRecipeDetails(recipe);
  const ingredientsSection = renderIngredients(recipe.ingredients);
  const methodSection = renderInstructionSection("Method", displayMethod(recipe), { capitalizeFirstLetter: true, singleAsParagraph: true });
  const instructionsSection = renderInstructionSection("Instructions", recipe.instructions);
  const shareMenu = renderShareMenu(urls.publicUrl, imageUrl);

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
  <link rel="canonical" href="${publicUrl}">
  <link rel="alternate" type="application/json" href="${apiUrl}">
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --background: #0B1017;
      --surface: #0F1720;
      --surface-bright: #1B2733;
      --surface-variant: #1B2733;
      --outline: #3C4C5F;
      --outline-variant: #2A3947;
      --on-surface: #E5EAF0;
      --on-surface-muted: #B7C1CC;
      --on-surface-variant: #959CA5;
      --on-background: #E5EAF0;
      --primary: #9CCAFF;
      --primary-container: #1E2936;
      --on-primary: #001529;
      --on-primary-container: #D6E4FF;
      --secondary: #FACC15;
      --tertiary: #ff3366;
      --danger: #F28B82;
      --success: #81C784;
      --shadow: #000000;
    }
    * { box-sizing: border-box; }
    html { background: var(--background); }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--background);
      color: var(--on-surface);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    a { color: inherit; }
    .app-detail-screen {
      width: min(100vw, 30rem);
      min-height: 100vh;
      margin: 0 auto;
      padding: max(1rem, env(safe-area-inset-top)) 24px max(1.25rem, env(safe-area-inset-bottom));
      background: var(--background);
    }
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      grid-template-columns: 4.5rem 1fr 4.5rem;
      align-items: center;
      gap: 0.75rem;
      margin: calc(max(1rem, env(safe-area-inset-top)) * -1) -24px 16px;
      padding: max(0.75rem, env(safe-area-inset-top)) 24px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--outline-variant);
      backdrop-filter: blur(18px);
    }
    .top-bar-title {
      grid-column: 2;
      margin: 0;
      color: var(--on-surface);
      font-size: 17px;
      font-weight: 600;
      line-height: 22px;
      text-align: center;
    }
    .top-bar .button {
      grid-column: 3;
      min-height: 36px;
      width: 100%;
      padding: 0 12px;
      border-radius: 999px;
      font-size: 14px;
    }
    .recipe-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      text-align: center;
    }
    h1 {
      margin: 0;
      color: var(--on-surface);
      font-size: 20px;
      font-weight: 700;
      line-height: 26px;
      letter-spacing: -0.01em;
    }
    .recipe-media {
      display: flex;
      justify-content: center;
      width: 100%;
    }
    .cocktail-image-frame {
      width: 150px;
      height: 150px;
      border-radius: 16px;
      background: #ffffff;
      border: 1px solid var(--outline-variant);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .cocktail-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .cocktail-image-placeholder {
      display: grid;
      place-items: center;
      width: 150px;
      height: 150px;
      border-radius: 16px;
      background: var(--surface-bright);
      border: 1px solid var(--outline-variant);
      color: var(--on-surface-variant);
      font-size: 48px;
      font-weight: 700;
    }
    .recipe-description {
      width: 100%;
      margin: 0;
      color: var(--on-surface-muted);
      font-size: 14px;
      line-height: 22px;
      text-align: left;
    }
    .video-link {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 8px 12px;
      border: 1px solid rgba(255, 51, 102, 0.42);
      border-radius: 999px;
      color: var(--tertiary);
      font-size: 14px;
      font-weight: 700;
      line-height: 20px;
      text-decoration: none;
    }
    .video-link:hover { background: rgba(255, 51, 102, 0.12); }
    .video-link:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 3px rgba(255, 51, 102, 0.28);
    }
    .video-link svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
      flex: 0 0 auto;
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 0;
    }
    section {
      margin: 0;
      padding: 0;
      background: transparent;
    }
    section > h2 {
      margin: 0 0 12px;
      color: var(--on-surface);
      font-size: 16px;
      font-weight: 600;
      line-height: 22px;
      letter-spacing: 0;
      text-transform: none;
    }
    p, li, dd {
      color: var(--on-surface-muted);
      font-size: 14px;
      line-height: 22px;
    }
    section > p { margin: 0; }
    ol {
      margin: 0;
      padding-left: 1.35rem;
    }
    ol li { padding-left: 0.2rem; }
    li + li { margin-top: 8px; }
    dl {
      display: grid;
      grid-template-columns: minmax(5.25rem, max-content) 1fr;
      gap: 10px 14px;
      margin: 0;
      padding: 12px 0;
      border-top: 1px solid var(--outline-variant);
      border-bottom: 1px solid var(--outline-variant);
    }
    dt {
      color: var(--on-surface-variant);
      font-size: 13px;
      font-weight: 500;
      line-height: 20px;
    }
    dd {
      margin: 0;
      color: var(--on-surface);
      font-weight: 600;
    }
    .ingredients {
      margin: 0;
      padding: 0;
      list-style: none;
      border-top: 1px solid var(--outline-variant);
      border-bottom: 1px solid var(--outline-variant);
    }
    .ingredient-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 72px;
      margin: 0;
      padding: 14px 0;
      border-bottom: 1px solid var(--outline-variant);
    }
    .ingredient-row:last-child { border-bottom: 0; }
    .ingredient-thumb {
      width: 56px;
      height: 56px;
      border-radius: 10px;
      background: #ffffff;
      border: 1px solid var(--outline-variant);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex: 0 0 auto;
    }
    .ingredient-thumb img {
      width: calc(100% - 8px);
      height: calc(100% - 8px);
      object-fit: contain;
      display: block;
    }
    .ingredient-thumb-placeholder {
      background: var(--surface-bright);
      color: var(--on-surface-variant);
      font-size: 18px;
      font-weight: 700;
    }
    .ingredient-content {
      flex: 1;
      min-width: 0;
      color: var(--on-surface);
      font-size: 14px;
      line-height: 20px;
    }
    .ingredient-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      color: var(--on-surface);
      font-weight: 600;
    }
    .ingredient-name { min-width: 0; }
    .ingredient-amount {
      margin-left: auto;
      color: var(--on-surface-muted);
      font-size: 14px;
      font-weight: 600;
      line-height: 20px;
      text-align: right;
      white-space: nowrap;
    }
    .note {
      display: block;
      margin-top: 2px;
      color: var(--on-surface-muted);
      font-size: 13px;
      line-height: 18px;
    }
    .ingredient-description {
      margin: 4px 0 0;
      color: var(--on-surface-muted);
      font-size: 13px;
      line-height: 20px;
    }
    .ingredient-tags { margin-top: 8px; }
    .tag-chip,
    .ingredient-tag {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--tag-color);
      color: ${DARK_TAG_TEXT_COLOR};
      border: 0;
      white-space: nowrap;
      font-weight: 700;
    }
    .tag-chip {
      margin: 0 6px 6px 0;
      padding: 8px 14px;
      font-size: 14px;
      line-height: 18px;
    }
    .ingredient-tag {
      margin: 0 6px 6px 0;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 16px;
    }
    .action-panel {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--outline-variant);
      border-radius: 16px;
      background: var(--surface);
    }
    .action-panel h2, .action-panel p { margin: 0; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 56px;
      width: 100%;
      padding: 0 18px;
      border-radius: 10px;
      border: 1px solid transparent;
      background: var(--primary);
      color: var(--on-primary);
      font-size: 15px;
      font-weight: 700;
      line-height: 20px;
      text-align: center;
      text-decoration: none;
      box-shadow: none;
    }
    .button:hover { background: #B7D8FF; }
    .button:focus-visible {
      outline: 0;
      box-shadow: 0 0 0 3px rgba(156, 202, 255, 0.28);
    }
    .secondary-button {
      min-height: 48px;
      border-color: var(--outline-variant);
      background: var(--surface-bright);
      color: var(--on-surface);
    }
    .secondary-button:hover { background: #243445; }
    .share-menu {
      position: relative;
      width: 100%;
    }
    .share-menu > summary {
      cursor: pointer;
      list-style: none;
    }
    .share-menu > summary::-webkit-details-marker { display: none; }
    .share-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      z-index: 4;
      display: grid;
      width: min(100%, 18rem);
      gap: 8px;
      padding: 12px;
      border: 1px solid var(--outline-variant);
      border-radius: 14px;
      background: var(--surface);
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.36);
    }
    .store-badges {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .store-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      border-radius: 12px;
      text-decoration: none;
    }
    .store-badge img {
      display: block;
      width: 100%;
      max-width: 180px;
      height: auto;
    }
    .visually-hidden-api { display: none; }
    @media (min-width: 28rem) {
      .store-badges { grid-template-columns: 1fr 1fr; }
    }
    @media (min-width: 48rem) {
      body { padding: 2rem 0; }
      .app-detail-screen {
        min-height: auto;
        border: 1px solid var(--outline-variant);
        border-radius: 28px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
        overflow: clip;
      }
      .top-bar { border-radius: 28px 28px 0 0; }
    }
  </style>
</head>
<body>
  <main class="app-detail-screen">
    <div class="top-bar">
      <p class="top-bar-title">Recipe details</p>
      <a class="button" href="${escapedDeepLink}">Open</a>
    </div>
    <header class="recipe-header">
      <h1>${escapedRecipeName}</h1>
      <div class="recipe-media">${recipeMedia}</div>
      ${videoLink}
      <p class="recipe-description">${renderInlineMarkup(description)}</p>
      ${shareMenu}
    </header>
    <div class="content">
      ${detailsSection}
      ${ingredientsSection}
      ${methodSection}
      ${instructionsSection}
      <section class="action-panel">
        <h2>Open in the app</h2>
        <p>If YourBar is installed, this page will try to open the app automatically. You can also use the button below.</p>
        <a class="button" href="${escapedDeepLink}">Open in YourBar</a>
        <div class="store-badges">
          ${iosLink}
          ${androidLink}
        </div>
      </section>
      <span class="visually-hidden-api" hidden aria-hidden="true">${apiUrl}</span>
    </div>
  </main>
  <script>
    (() => {
      const shareButton = document.querySelector('[data-share-link]');
      shareButton?.addEventListener('click', async () => {
        const url = shareButton.getAttribute('data-share-link') || window.location.href;
        if (navigator.share) {
          await navigator.share({ title: document.title, url });
          return;
        }
        await navigator.clipboard?.writeText(url);
      });
      document.addEventListener('click', (event) => {
        document.querySelectorAll('.share-menu[open]').forEach((menu) => {
          if (!menu.contains(event.target)) menu.removeAttribute('open');
        });
      });
    })();
  </script>
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
    } else if (path === "/") {
      response = request.method === "GET"
        ? htmlResponse(renderHomePage(env))
        : htmlResponse(renderNotFoundPage(), 405, { Allow: "GET" });
    } else if (path.startsWith("/assets/")) {
      const assetResponse = staticAssetResponse(path);
      if (!assetResponse) {
        response = jsonError("not_found", "Not found", 404);
      } else if (request.method !== "GET") {
        response = jsonError("method_not_allowed", "Method not allowed", 405, undefined, { Allow: "GET" });
      } else {
        response = assetResponse;
      }
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
