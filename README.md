# YourBar Share API

Minimal Cloudflare Workers backend for sharing YourBar cocktail recipes through public import links. The Expo/React Native app posts a validated recipe payload, receives a short public URL, and other users can open that URL to import the recipe with a `yourbar://` deep link.

## What this service does

- Accepts `RecipeSharePayloadV1` JSON at `POST /api/recipes`.
- Stores short-lived recipe share records in Cloudflare KV under `recipe:{id}`.
- Returns a short public link such as `https://api.yourbar.app/r/{id}` and a canonical API URL.
- Renders a small HTML fallback page for public links that attempts to open `yourbar://import/recipe/{id}`.
- Serves placeholder iOS Universal Link and Android App Link well-known documents.

This service intentionally does **not** include authentication, user accounts, moderation, analytics, or image uploads in the MVP.

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

## Configuration

Set non-secret variables in `wrangler.toml` or Cloudflare dashboard environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Base URL used to build public/API links. |
| `APP_DEEP_LINK_SCHEME` | `yourbar` | Custom app scheme for import links. |
| `DEFAULT_RECIPE_TTL_SECONDS` | `2592000` | KV expiration TTL; default is 30 days. |
| `MAX_RECIPE_PAYLOAD_BYTES` | `65536` | Maximum raw JSON request body size. |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated allowed origins for `/api/*`; empty allows all origins for MVP. |
| `IOS_APP_STORE_URL` | unset | Optional install link shown on landing pages. Use a placeholder until the real listing exists. |
| `ANDROID_PLAY_STORE_URL` | unset | Optional install link shown on landing pages. Use a placeholder until the real listing exists. |
| `APPLE_APP_SITE_ASSOCIATION_JSON` | unset | Optional raw JSON string for iOS Universal Links. |
| `ANDROID_ASSET_LINKS_JSON` | unset | Optional raw JSON string for Android App Links. |

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

### Create recipe share

```bash
curl -i -X POST http://localhost:8787/api/recipes \
  -H 'Content-Type: application/json' \
  -d @recipe-share.json
```

Response:

```json
{
  "id": "AbC234xYz89Q",
  "publicUrl": "https://api.yourbar.app/r/AbC234xYz89Q",
  "apiUrl": "https://api.yourbar.app/api/recipes/AbC234xYz89Q",
  "expiresAt": "2026-06-13T00:00:00.000Z"
}
```

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
  "expiresAt": "2026-06-13T00:00:00.000Z"
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

The route `GET /.well-known/apple-app-site-association` returns either `APPLE_APP_SITE_ASSOCIATION_JSON` or a placeholder document:

```json
{
  "applinks": {
    "details": [
      { "appIDs": [], "paths": ["/r/*"], "components": [{ "/": "/r/*" }] }
    ]
  }
}
```

For production, replace it with the JSON Apple expects for your Team ID and bundle ID. Do not add a `.json` extension to the route. Add the Associated Domains capability in the iOS app with `applinks:api.yourbar.app`.

### Android App Links

The route `GET /.well-known/assetlinks.json` returns `ANDROID_ASSET_LINKS_JSON` when configured. Otherwise it returns an empty JSON array (`[]`) as a safe placeholder.

For production, generate an `assetlinks.json` file containing your Android package name and SHA-256 certificate fingerprint, configure the app intent filter for `https://api.yourbar.app/r/*`, and set the raw JSON string in `ANDROID_ASSET_LINKS_JSON`.

## Security and abuse limitations of the MVP

- Public links are bearer access: anyone with the URL can fetch the payload until expiration.
- KV shares expire but are not user-owned and cannot be deleted by end users in this MVP.
- No rate limiting, bot protection, authentication, spam prevention, or moderation is included.
- Payload size and schema validation reduce abuse but do not fully prevent unwanted content.
- Avoid storing personal data or copyrighted images directly in recipe payloads.
- CORS defaults to allowing all origins when `CORS_ALLOWED_ORIGINS` is empty for MVP convenience.

## Future improvements

- Rate limiting per IP/device/app install.
- Cloudflare Turnstile on public or unauthenticated write flows.
- Authenticated and private shares.
- Moderation, reporting, and takedown workflows.
- D1 migration for queryable metadata and operational reporting.
- Image upload and transformation via R2.
- Signed delete/update token returned at creation time.
- Privacy-preserving analytics for share creation and imports.
