# YourBar Share API

Minimal Cloudflare Workers backend for sharing YourBar cocktail recipes through public import links. The Expo/React Native app posts a validated recipe payload, receives a short public URL, and other users can open that URL to import the recipe with a `yourbar://` deep link.

## What this service does

- Accepts `RecipeSharePayloadV1` JSON at `POST /api/recipes`.
- Accepts recipe image uploads as `multipart/form-data` at `POST /api/images`, stores them in Cloudflare R2, and returns an `imageUrl` that can be attached to recipe payloads.
- Stores short-lived recipe share records in Cloudflare KV under `recipe:{id}`.
- Computes a canonical SHA-256 checksum of each recipe before saving and reuses an existing share when the same recipe is posted again.
- Returns a short public link such as `https://api.yourbar.app/r/{id}` and a canonical API URL.
- Renders a small HTML fallback page for public links that attempts to open `yourbar://import/recipe/{id}`.
- Serves placeholder iOS Universal Link and Android App Link well-known documents.

This service intentionally does **not** include authentication, user accounts, moderation, or analytics in the MVP.

## Local setup

```bash
npm install
npm run dev
```

The local default public base URL is `http://localhost:8787`.

Useful scripts:

```bash
npm run dev        # wrangler dev
npm run deploy     # wrangler deploy
npm run typecheck  # tsc --noEmit
npm test           # build and run Node test runner
npm run check      # typecheck + tests
```

## Cloudflare KV setup

Create production and preview KV namespaces, then copy their IDs into `wrangler.toml`:

```bash
npx wrangler kv namespace create RECIPE_SHARES
npx wrangler kv namespace create RECIPE_SHARES --preview
```

Update:

```toml
[[kv_namespaces]]
binding = "RECIPE_SHARES"
id = "<production namespace id>"
preview_id = "<preview namespace id>"
```

The Worker uses the binding name `RECIPE_SHARES`.

## Cloudflare R2 setup

Before creating buckets, make sure R2 is enabled for the Cloudflare account in the Cloudflare Dashboard under **R2 object storage**. If Wrangler returns `Please enable R2 through the Cloudflare Dashboard. [code: 10042]`, open the dashboard, enable R2 for the selected account, and then rerun the bucket creation commands.

Create production and preview R2 buckets for uploaded recipe images after R2 is enabled:

```bash
npx wrangler r2 bucket create yourbar-recipe-images
npx wrangler r2 bucket create yourbar-recipe-images-preview
```

`wrangler.toml` binds those buckets as `RECIPE_IMAGES`:

```toml
[[r2_buckets]]
binding = "RECIPE_IMAGES"
bucket_name = "yourbar-recipe-images"
preview_bucket_name = "yourbar-recipe-images-preview"
```

By default, uploaded images are served back through this Worker at `${PUBLIC_BASE_URL}/images/{key}`. If you put R2 behind a CDN or custom public domain, set `IMAGE_PUBLIC_BASE_URL` to that image base URL.

## Configuration

Set non-secret variables in `wrangler.toml` or Cloudflare dashboard environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Base URL used to build public/API links. |
| `APP_DEEP_LINK_SCHEME` | `yourbar` | Custom app scheme for import links. |
| `DEFAULT_RECIPE_TTL_SECONDS` | `2592000` | KV expiration TTL; default is 30 days. |
| `MAX_RECIPE_PAYLOAD_BYTES` | `65536` | Maximum raw JSON request body size. |
| `MAX_IMAGE_BYTES` | `5242880` | Maximum uploaded image size; default is 5 MiB. |
| `IMAGE_PUBLIC_BASE_URL` | `${PUBLIC_BASE_URL}/images` | Optional public base URL for uploaded images, for example a CDN/custom domain. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:8081,https://yourbar.app,https://www.yourbar.app` | Comma-separated allowed browser origins for `/api/*`. Keep this in sync with the web clients that call the API. |
| `IOS_APP_STORE_URL` | unset | Optional install link shown on landing pages. Use a placeholder until the real listing exists. |
| `ANDROID_PLAY_STORE_URL` | unset | Optional install link shown on landing pages. Use a placeholder until the real listing exists. |
| `IOS_APP_IDS` | unset | Comma-separated iOS app IDs in `TEAMID.bundle.id` format used to generate `/.well-known/apple-app-site-association`. |
| `ANDROID_PACKAGE_NAME` | unset | Android package name used to generate `/.well-known/assetlinks.json`. |
| `ANDROID_SHA256_CERT_FINGERPRINTS` | unset | Comma-separated Android signing certificate SHA-256 fingerprints used to generate `/.well-known/assetlinks.json`. |
| `APPLE_APP_SITE_ASSOCIATION_JSON` | unset | Optional raw JSON string for iOS Universal Links. Overrides generated output from `IOS_APP_IDS`. |
| `ANDROID_ASSET_LINKS_JSON` | unset | Optional raw JSON string for Android App Links. Overrides generated output from Android package/fingerprint variables. |

Do not commit secrets or real unpublished app identifiers unless they are intended to be public. If you prefer Cloudflare secrets for raw JSON values, use:

```bash
npx wrangler secret put APPLE_APP_SITE_ASSOCIATION_JSON
npx wrangler secret put ANDROID_ASSET_LINKS_JSON
```

## API examples

### Health check

```bash
curl http://localhost:8787/health
```

Response:

```json
{
  "ok": true,
  "service": "yourbar-share-api"
}
```


### Upload recipe image

Upload images separately from recipe JSON. The form field name must be `image`, and the file must be JPEG, PNG, or WebP. The response `imageUrl` can then be sent in `recipe.imageUrl` when creating a recipe share.

```bash
curl -i -X POST http://localhost:8787/api/images \
  -F 'image=@./daiquiri.webp;type=image/webp'
```

Response:

```json
{
  "key": "2f1a4b7e-9f2d-4f8a-bb2b-c54b5a3a5e9c.webp",
  "imageUrl": "https://api.yourbar.app/images/2f1a4b7e-9f2d-4f8a-bb2b-c54b5a3a5e9c.webp"
}
```

Uploaded image URLs are public read URLs. Store only the returned `imageUrl` in recipe payloads rather than embedding Base64 image data.

### Create recipe share

The repository includes `recipe-share.example.json` as a ready-to-send sample payload. Copy it before editing if you want to keep the original example unchanged:

```bash
cp recipe-share.example.json recipe-share.json
```

Then post it to the local Worker:

```bash
curl -i -X POST http://localhost:8787/api/recipes \
  -H 'Content-Type: application/json' \
  --data-binary @recipe-share.json
```

For the deployed API, use the production base URL:

```bash
curl -i -X POST https://api.yourbar.app/api/recipes \
  -H 'Content-Type: application/json' \
  --data-binary @recipe-share.json
```

In PowerShell, call `curl.exe` rather than the `curl` alias. If you create `recipe-share.json` manually in Windows PowerShell, save it as UTF-8 without a BOM; a BOM at the start of the file makes the Worker return `400 Request body must be valid JSON`.

Response:

```json
{
  "id": "AbC234xYz89Q",
  "publicUrl": "https://api.yourbar.app/r/AbC234xYz89Q",
  "apiUrl": "https://api.yourbar.app/api/recipes/AbC234xYz89Q",
  "expiresAt": "2026-06-13T00:00:00.000Z",
  "recipeChecksum": "8a0f...64-hex-chars",
  "duplicate": false
}
```

If the canonicalized `recipe` object already exists, the Worker returns the existing share with `200 OK` and `"duplicate": true` rather than writing another `recipe:{id}` record. Canonicalization sorts object keys and trims string values before hashing, while preserving array order.

### Fetch recipe share

```bash
curl https://api.yourbar.app/api/recipes/AbC234xYz89Q
```

Response:

```json
{
  "id": "AbC234xYz89Q",
  "payload": {
    "schemaVersion": 1,
    "kind": "yourbar.recipeShare",
    "recipe": {
      "name": "Daiquiri",
      "ingredients": [{ "name": "Rum", "amount": 2, "unit": "oz" }]
    }
  },
  "createdAt": "2026-05-14T00:00:00.000Z",
  "expiresAt": "2026-06-13T00:00:00.000Z",
  "recipeChecksum": "8a0f...64-hex-chars"
}
```

### Validation error shape

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Recipe share payload is invalid",
    "details": [
      { "path": "recipe.name", "message": "Must be a string with trimmed length from 1 to 120" }
    ]
  }
}
```

## Example `RecipeSharePayloadV1`

```json
{
  "schemaVersion": 1,
  "kind": "yourbar.recipeShare",
  "recipe": {
    "name": "Daiquiri",
    "description": "A crisp rum sour.",
    "instructions": ["Shake with ice.", "Strain into a chilled coupe."],
    "ingredients": [
      { "name": "White rum", "amount": 2, "unit": "oz" },
      { "name": "Fresh lime juice", "amount": 1, "unit": "oz" },
      { "name": "Simple syrup", "amount": 0.75, "unit": "oz" }
    ],
    "glassware": "Coupe",
    "garnish": "Lime wheel",
    "method": "Shaken",
    "tags": ["classic", "rum", "sour"],
    "servings": 1,
    "imageUrl": "https://example.com/daiquiri.jpg"
  },
  "source": {
    "app": "yourbar",
    "appVersion": "1.0.0",
    "platform": "ios"
  }
}
```

## Custom domain: `api.yourbar.app`

Use the `api.yourbar.app` subdomain for this Worker so the root domain (`yourbar.app`) remains available for a marketing site, web app, or other public website later.

1. Add `yourbar.app` to Cloudflare DNS and make sure the zone is active.
2. Deploy the Worker with `npm run deploy`.
3. In Cloudflare Workers custom domains, attach this Worker to `https://api.yourbar.app`. In the Cloudflare dashboard, open Workers & Pages → `yourbar-share-api` → Domains → Add Domain → select `yourbar.app` → enter `api` as the optional subdomain.
4. Set `PUBLIC_BASE_URL=https://api.yourbar.app` in the production environment.
5. Ensure the Expo app handles the custom deep link scheme `yourbar://import/recipe/{id}`.

If you later decide the public recipe links should live on the root domain, attach the Worker or a website route to `https://yourbar.app/r/*` and update `PUBLIC_BASE_URL` accordingly.

## Universal Links and App Links

### iOS Universal Links

The route `GET /.well-known/apple-app-site-association` returns the Apple association document directly from the Worker with `Content-Type: application/json`. Configure `IOS_APP_IDS` as a comma-separated list of app IDs in `TEAMID.bundle.id` format, for example:

```toml
IOS_APP_IDS = "ABCDE12345.app.yourbar.ios,ABCDE12345.app.yourbar.ios.dev"
```

The generated document matches recipe share URLs under `/r/*`:

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["ABCDE12345.app.yourbar.ios"],
        "paths": ["/r/*"],
        "components": [{ "/": "/r/*", "comment": "Matches YourBar recipe share links" }]
      }
    ]
  }
}
```

If you need a fully custom Apple document, set `APPLE_APP_SITE_ASSOCIATION_JSON`; it overrides the generated output. Do not add a `.json` extension to the route. Add the Associated Domains capability in the iOS app with `applinks:api.yourbar.app`.

### Android App Links

The route `GET /.well-known/assetlinks.json` returns the Android association document directly from the Worker with `Content-Type: application/json`. Configure the package name and one or more signing certificate SHA-256 fingerprints, for example:

```toml
ANDROID_PACKAGE_NAME = "app.yourbar"
ANDROID_SHA256_CERT_FINGERPRINTS = "AA:BB:CC:..."
```

The generated document delegates URL handling for `https://api.yourbar.app/r/*` to the configured Android app:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "app.yourbar",
      "sha256_cert_fingerprints": ["AA:BB:CC:..."]
    }
  }
]
```

If you need a fully custom Android document, set `ANDROID_ASSET_LINKS_JSON`; it overrides the generated output. Configure the app intent filter for `https://api.yourbar.app/r/*` and deploy with the same signing certificate fingerprint listed here.

## Security and abuse limitations of the MVP

- Public links are bearer access: anyone with the URL can fetch the payload until expiration.
- KV shares expire but are not user-owned and cannot be deleted by end users in this MVP.
- No rate limiting, bot protection, authentication, spam prevention, or moderation is included.
- Payload size and schema validation reduce abuse but do not fully prevent unwanted content.
- Avoid storing personal data or copyrighted images directly in recipe payloads; upload image files separately and store only `imageUrl`.
- CORS is allow-listed through `CORS_ALLOWED_ORIGINS`; add any future web client origins before they call `/api/*`.

## Future improvements

- Rate limiting per IP/device/app install.
- Cloudflare Turnstile on public or unauthenticated write flows.
- Authenticated and private shares.
- Moderation, reporting, and takedown workflows.
- D1 migration for queryable metadata and operational reporting.
- Image transformation and thumbnail generation for R2 uploads.
- Signed delete/update token returned at creation time.
- Privacy-preserving analytics for share creation and imports.
