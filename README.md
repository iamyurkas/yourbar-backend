# YourBar Share API

Minimal Cloudflare Workers backend for sharing YourBar cocktail recipes through public import links. The Expo/React Native app posts a validated recipe payload, receives a short public URL, and other users can open that URL to import the recipe with a `yourbar://` deep link.

## What this service does

- Accepts `RecipeSharePayloadV1` JSON at `POST /api/recipes`, including optional unit, glassware, method, and tag IDs plus localized display names.
- Accepts recipe image uploads as `multipart/form-data` at `POST /api/images`, stores them in Cloudflare R2, and returns an `imageUrl` that can be attached to recipe payloads.
- Stores short-lived recipe share records in Cloudflare KV under `recipe:{id}`.
- Computes a canonical SHA-256 checksum of each recipe before saving and reuses an existing share when the same recipe is posted again.
- Returns a short public link such as `https://api.yourbar.app/r/{id}` and a canonical API URL.
- Renders a small HTML fallback page for public links that attempts to open `yourbar://import/recipe/{id}` and prefers localized unit, glassware, method, and tag display names when they are supplied.
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
npm run dev             # wrangler dev
npm run deploy          # wrangler deploy (production/default environment)
npm run deploy:staging  # wrangler deploy --env staging
npm run deploy:prod     # wrangler deploy (production/default environment)
npm run typecheck       # tsc --noEmit
npm test                # build and run Node test runner
npm run check           # typecheck + tests
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

## Staging deploys

Staging is configured as a separate Wrangler environment named `staging` with Worker name `yourbar-share-api-staging`, its own `RECIPE_SHARES` KV namespace, and the `yourbar-recipe-images-staging` R2 bucket. Use it for safe validation of upcoming Community changes before touching production.

```bash
npm run deploy:staging
```

Production remains the default Wrangler environment and deploys only with the production script:

```bash
npm run deploy:prod
```

Before deploying, verify the target in the command output: staging deploys should mention `yourbar-share-api-staging`, while production deploys should mention `yourbar-share-api`. To double-check production was not touched during staging validation, inspect the Cloudflare Workers dashboard or run a read-only production health check against `https://api.yourbar.app/health` after the staging deploy.

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

Upload images separately from recipe JSON. The form field name must be `image`, and the file must be JPEG, PNG, or WebP. Uploads are deduplicated by a SHA-256 checksum of the image bytes: if the same image already exists, the API returns the existing `imageUrl` instead of storing another copy. The response `imageUrl` can then be sent in `recipe.imageUrl` when creating a recipe share.

```bash
curl -i -X POST http://localhost:8787/api/images \
  -F 'image=@./daiquiri.webp;type=image/webp'
```

Response:

```json
{
  "key": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.webp",
  "imageUrl": "https://api.yourbar.app/images/9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a.webp",
  "imageChecksum": "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  "duplicate": false
}
```

Uploaded image URLs are public read URLs. New uploads return `201` with `duplicate: false`; repeated uploads of the same bytes return `200` with `duplicate: true` and the original URL. Store only the returned `imageUrl` in recipe payloads rather than embedding Base64 image data.

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

Recipe ingredients may include their own share-row `id`, `baseIngredientId`, `styleIngredientId`, `description`, `imageUrl`, `tags`, `unitId`, `unitName`, and `substitutes`; each substitute is another ingredient object with the same fields as a regular ingredient, including optional `amount`, `unit`, `unitId`, and `unitName`; `baseIngredientId` and `styleIngredientId` may be either legacy string IDs or arrays of detailed ingredient objects containing fields such as `id`, `name`, `description`, `imageUrl`, and `tags`; recipes may include `glasswareId`/`glasswareName`, `methodId`/`methodName`, or a localized `method` object shaped as `{ "id": "method-id", "name": "Localized name" }`; and both recipe-level and ingredient-level `tags` may be either legacy strings or localized tag objects shaped as `{ "id": "tag-id", "name": "Localized name" }`. The landing page displays recipe and ingredient metadata using localized names when present, but it intentionally does not display substitute ingredients; `GET /api/recipes/{id}` returns IDs, detailed base/style ingredient arrays, localized names, ingredient images, descriptions, tags, substitutes, and any other stored payload fields exactly as stored. Legacy `unit`, `glassware`, `method`, and string `tags` values are still accepted and displayed as before.

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
      "ingredients": [
        {
          "id": "ingredient-white-rum",
          "name": "White rum",
          "baseIngredientId": [
            {
              "id": "base-ingredient-rum",
              "name": "Rum",
              "description": "A sugarcane spirit.",
              "imageUrl": "https://api.yourbar.app/images/rum.webp",
              "tags": [{ "id": "ingredient-tag-spirit", "name": "Spirit" }]
            }
          ],
          "styleIngredientId": [
            {
              "id": "style-ingredient-white-rum",
              "name": "White rum",
              "description": "A clean light-bodied rum style.",
              "imageUrl": "https://api.yourbar.app/images/white-rum.webp",
              "tags": ["rum"]
            }
          ],
          "amount": 60,
          "unitId": "unit-ml",
          "unitName": "ml",
          "description": "A clean light-bodied rum.",
          "imageUrl": "https://api.yourbar.app/images/white-rum.webp",
          "tags": [{ "id": "ingredient-tag-spirit", "name": "Spirit" }],
          "substitutes": [
            {
              "id": "ingredient-cachaca",
              "name": "Cachaça",
              "amount": 60,
              "unitId": "unit-ml",
              "unitName": "ml"
            }
          ]
        }
      ],
      "glasswareId": "glass-coupe",
      "glasswareName": "Coupe",
      "methodId": "method-shaken",
      "methodName": "Shaken",
      "tags": [{ "id": "tag-classic", "name": "Classic" }]
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
      {
        "id": "ingredient-white-rum",
        "baseIngredientId": [
          {
            "id": "base-ingredient-rum",
            "name": "Rum",
            "description": "A sugarcane spirit.",
            "imageUrl": "https://api.yourbar.app/images/rum.webp",
            "tags": [{ "id": "ingredient-tag-spirit", "name": "Spirit" }]
          }
        ],
        "styleIngredientId": [
          {
            "id": "style-ingredient-white-rum",
            "name": "White rum",
            "description": "A clean light-bodied rum style.",
            "imageUrl": "https://api.yourbar.app/images/white-rum.webp",
            "tags": ["rum"]
          }
        ],
        "name": "White rum",
        "amount": 60,
        "unitId": "unit-ml",
        "unitName": "ml",
        "description": "A clean light-bodied rum.",
        "imageUrl": "https://api.yourbar.app/images/white-rum.webp",
        "tags": [{ "id": "ingredient-tag-spirit", "name": "Spirit" }]
      },
      {
        "id": "ingredient-lime-juice",
        "baseIngredientId": [
          {
            "id": "base-ingredient-lime",
            "name": "Lime",
            "description": "Fresh citrus used for acidity.",
            "imageUrl": "https://api.yourbar.app/images/lime.webp",
            "tags": [{ "id": "ingredient-tag-citrus", "name": "Citrus" }]
          }
        ],
        "styleIngredientId": [
          {
            "id": "style-ingredient-lime-juice",
            "name": "Fresh lime juice",
            "description": "Freshly squeezed lime juice.",
            "imageUrl": "https://api.yourbar.app/images/lime-juice.webp",
            "tags": [{ "id": "ingredient-tag-citrus", "name": "Citrus" }]
          }
        ],
        "name": "Fresh lime juice",
        "amount": 30,
        "unitId": "unit-ml",
        "unitName": "ml",
        "description": "Freshly squeezed lime juice.",
        "imageUrl": "https://api.yourbar.app/images/lime-juice.webp",
        "tags": [{ "id": "ingredient-tag-citrus", "name": "Citrus" }],
        "substitutes": [
          {
            "id": "ingredient-lemon-juice",
            "name": "Lemon juice",
            "amount": 25,
            "unitId": "unit-ml",
            "unitName": "ml",
            "description": "Freshly squeezed lemon juice.",
            "imageUrl": "https://api.yourbar.app/images/lemon-juice.webp",
            "tags": [{ "id": "ingredient-tag-citrus", "name": "Citrus" }]
          }
        ]
      },
      { "name": "Simple syrup", "amount": 22.5, "unitId": "unit-ml", "unitName": "ml" }
    ],
    "glasswareId": "glass-coupe",
    "glasswareName": "Coupe",
    "garnish": "Lime wheel",
    "methodId": "method-shaken",
    "methodName": "Shaken",
    "tags": [
      { "id": "tag-classic", "name": "Classic" },
      { "id": "tag-rum", "name": "Rum" },
      { "id": "tag-sour", "name": "Sour" }
    ],
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

The generated document delegates URL handling for `https://api.yourbar.app/r/*` and shared login credentials to the configured Android app:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
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

## Community recipes (D1, moderated, feature-flagged)

Community routes are additive and reuse the complete `RecipeSharePayloadV1.recipe` payload for list, detail, save, and import responses. Personal share routes (`POST /api/recipes`, `GET /api/recipes/:id`, `/r/:id`, and `POST /api/images`) remain KV/R2-backed and are independent of Community.

### Safety and feature flags

Production defaults in `wrangler.toml` disable all Community behavior:

- `COMMUNITY_FEATURE_ENABLED=false` is the master switch; Community API routes return `404 feature_disabled`.
- `COMMUNITY_SUBMISSIONS_ENABLED=false` gates new submissions.
- `COMMUNITY_ADMIN_ENABLED=false` gates moderation.
- `COMMUNITY_PUBLIC_FEED_ENABLED=false` gates public list/detail reads.

Staging defaults enable these flags, but routes still return `feature_disabled` until the staging `YOURBAR_DB` binding is configured. Community data is never stored in `RECIPE_SHARES` KV.

### Create and bind D1

Wrangler in this checkout could not discover an existing database because the installed runtime is Node 20 while Wrangler 4 requires Node 22+. No database ID was guessed or added.

Use Node 22+ and create separate databases only when authorized:

```bash
npx wrangler d1 create yourbar-community-staging
# Later, only as part of an explicitly approved production rollout:
npx wrangler d1 create yourbar-community
```

Copy the real staging ID into an `[[env.staging.d1_databases]]` block using binding `YOURBAR_DB`, database name `yourbar-community-staging`, and `migrations_dir = "migrations"`. Do not add a production binding until its real database exists. The commented templates at the bottom of `wrangler.toml` show the exact shape.

Apply migrations to local or staging D1 only:

```bash
npx wrangler d1 migrations apply yourbar-community-staging --local
npx wrangler d1 migrations apply yourbar-community-staging --env staging --remote
```

Never run the production migration command without explicit approval.

### Mobile authentication

Authenticated Community write actions use an HS256 bearer JWT. Store `AUTH_JWT_SECRET` with `wrangler secret put` (never in TOML). Optional claim checks:

- `AUTH_JWT_ISSUER`
- `AUTH_JWT_AUDIENCE`
- `AUTH_JWT_USER_ID_CLAIM` (defaults to `sub`)

JWTs must have a valid signature and non-expired `exp`. `userId` and `submitter_user_id` request fields are ignored. `googleLogin` is required separately on submissions as author metadata and is not authentication.

`AUTH_TEST_MODE=true` enables test-only `X-Test-User-Id` headers and must never be configured in staging or production.

### Cloudflare Access for administrators

Protect `/api/admin/community/*` at Cloudflare Access and configure:

- `CF_ACCESS_TEAM_DOMAIN` (for example `team.cloudflareaccess.com`)
- `CF_ACCESS_AUD` (the Access application audience tag)
- `COMMUNITY_ADMIN_EMAILS` (optional comma-separated second allow-list)

The Worker verifies the `Cf-Access-Jwt-Assertion` RS256 signature against the team JWKS and checks its audience/expiration. Google login values are never accepted for admin authorization.

### Community API

- `POST /api/community/submissions`
- `GET /api/admin/community/submissions`
- `GET|PATCH /api/admin/community/submissions/:id`
- `GET /api/community/recipes`
- `GET /api/community/recipes/:id`
- `POST|DELETE /api/community/recipes/:id/save`
- `PUT|DELETE /api/community/recipes/:id/rating`

The feed implements cursor pagination (default 20, maximum 50), `q`, `tagIds`, `methodIds`, `savedByMe`, and `newest`, `topRated`, `mostSaved`, `alphabetical`, or deterministic seeded `random` sorting. A cursor is tied to its original query and cannot be reused with different filters. Save/rating aggregate counters are maintained by D1 triggers, making duplicate saves and rating replacement atomic with the user-specific row mutation.

Follow-up filters not yet implemented: `minAverageRating` / `ratingBuckets`. A separate admin UI was intentionally not exposed; the protected moderation API is ready for a dedicated frontend.

### Local verification checklist

```bash
npm run check
```

- Confirm Community routes return `feature_disabled` with the master flag off.
- Use local D1 only; never point tests at production KV, R2, or D1.
- Re-run personal share/image tests to verify backward compatibility.

### Staging rollout checklist

1. Use Worker `yourbar-share-api-staging`, `https://staging-api.yourbar.app`, staging KV, `yourbar-recipe-images-staging`, and the real staging D1 binding.
2. Apply `migrations/0001_community.sql` to staging D1.
3. Configure mobile JWT secrets and Cloudflare Access settings.
4. Run `npm run deploy:staging` (never `npm run deploy`).
5. Smoke-test `GET /health`, personal share create/read, image upload/read, authenticated Community submission, missing-`googleLogin` validation, admin approve/reject, feed list/detail, save/unsave, and rating create/update/delete.

### Production rollout checklist (manual approval required)

1. Do **not** run production migrations or create/change production bindings as part of a normal staging deployment.
2. Deploy only while every Community feature flag remains `false`.
3. Smoke-test `GET /health`, `POST /api/recipes`, `GET /api/recipes/:id`, `/r/:id`, and `POST /api/images`.
4. Create/bind production D1 and apply its migration only after explicit approval.
5. Configure production auth/Access secrets, then enable flags incrementally after manual approval.
