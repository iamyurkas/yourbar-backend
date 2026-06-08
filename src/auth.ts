import { jsonError } from "./http.js";

export type AuthenticatedUser = { id: string; email?: string };
export type AdminUser = AuthenticatedUser & { email: string };

export interface AuthEnv {
  AUTH_JWT_SECRET?: string;
  AUTH_JWT_ISSUER?: string;
  AUTH_JWT_AUDIENCE?: string;
  AUTH_JWT_USER_ID_CLAIM?: string;
  COMMUNITY_USER_AUTH_MODE?: string;
  COMMUNITY_USER_ID_HEADER?: string;
  AUTH_TEST_MODE?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  COMMUNITY_ADMIN_EMAILS?: string;
}

type JwtPayload = Record<string, unknown> & { sub?: string; email?: string; iss?: string; aud?: string | string[]; exp?: number; nbf?: number };

export class AuthError extends Error {
  constructor(public readonly response: Response) {
    super("Authentication failed");
  }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonPart(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as Record<string, unknown>;
}

function audienceMatches(actual: unknown, expected: string | string[] | undefined): boolean {
  if (!expected || (Array.isArray(expected) && expected.length === 0)) return true;
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const actualValues = Array.isArray(actual) ? actual : [actual];
  return expectedValues.some((value) => actualValues.includes(value));
}

function validateClaims(payload: JwtPayload, issuer?: string, audience?: string | string[]): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Token is expired or has no expiration");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("Token is not active yet");
  if (issuer && payload.iss !== issuer) throw new Error("Token issuer does not match");
  if (!audienceMatches(payload.aud, audience)) throw new Error("Token audience does not match");
}

async function verifyHs256(token: string, secret: string, issuer?: string, audience?: string): Promise<JwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("Malformed JWT");
  const header = decodeJsonPart(parts[0]);
  if (header.alg !== "HS256") throw new Error("Unsupported JWT algorithm");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("Invalid JWT signature");
  const payload = decodeJsonPart(parts[1]) as JwtPayload;
  validateClaims(payload, issuer, audience);
  return payload;
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function testUser(request: Request, env: AuthEnv): AuthenticatedUser | null {
  if (env.AUTH_TEST_MODE !== "true") return null;
  const id = request.headers.get("X-Test-User-Id")?.trim();
  if (!id) return null;
  const email = request.headers.get("X-Test-User-Email")?.trim();
  return email ? { id, email } : { id };
}

function unverifiedUser(request: Request, env: AuthEnv, fallbackId?: string): AuthenticatedUser | null {
  if (env.COMMUNITY_USER_AUTH_MODE !== "unverified") return null;
  const headerName = env.COMMUNITY_USER_ID_HEADER?.trim() || "X-YourBar-Google-Login";
  const id = request.headers.get(headerName)?.trim() || fallbackId?.trim();
  if (!id || id.length > 320) return null;
  return id.includes("@") ? { id: `google:${id.toLowerCase()}`, email: id } : { id: `client:${id}` };
}

export async function getOptionalUser(request: Request, env: AuthEnv, fallbackId?: string): Promise<AuthenticatedUser | null> {
  const testing = testUser(request, env);
  if (testing) return testing;
  const unverified = unverifiedUser(request, env, fallbackId);
  if (unverified) return unverified;
  const token = bearerToken(request);
  if (!token) return null;
  if (!env.AUTH_JWT_SECRET) throw new AuthError(jsonError("unauthorized", "User authentication is not configured", 401));
  try {
    const payload = await verifyHs256(token, env.AUTH_JWT_SECRET, env.AUTH_JWT_ISSUER, env.AUTH_JWT_AUDIENCE);
    const claim = env.AUTH_JWT_USER_ID_CLAIM ?? "sub";
    const id = payload[claim];
    if (typeof id !== "string" || !id.trim()) throw new Error(`JWT claim ${claim} is required`);
    return typeof payload.email === "string" ? { id, email: payload.email } : { id };
  } catch {
    throw new AuthError(jsonError("unauthorized", "Invalid or expired authentication token", 401));
  }
}

export async function requireUser(request: Request, env: AuthEnv, fallbackId?: string): Promise<AuthenticatedUser> {
  const user = await getOptionalUser(request, env, fallbackId);
  if (!user) throw new AuthError(jsonError("unauthorized", "Authentication is required", 401));
  return user;
}

type AccessVerificationCode =
  | "access_not_configured"
  | "access_token_malformed"
  | "access_token_expired"
  | "access_token_not_active"
  | "access_token_issuer_mismatch"
  | "access_token_audience_mismatch"
  | "access_signing_keys_unavailable"
  | "access_signing_key_mismatch"
  | "access_token_signature_invalid"
  | "access_token_identity_missing";

class AccessVerificationError extends Error {
  constructor(public readonly code: AccessVerificationCode, message: string, public readonly status = 401) {
    super(message);
  }
}

const accessKeysByDomain = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();

function accessTeamDomain(value: string | undefined): string {
  return (value ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function accessAudiences(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function validateAccessClaims(payload: JwtPayload, teamDomain: string, audiences: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new AccessVerificationError("access_token_expired", "Cloudflare Access token is expired; sign out of Access and sign in again");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) {
    throw new AccessVerificationError("access_token_not_active", "Cloudflare Access token is not active yet; verify system time and sign in again");
  }
  if (payload.iss !== `https://${teamDomain}`) {
    throw new AccessVerificationError("access_token_issuer_mismatch", "Cloudflare Access token issuer does not match CF_ACCESS_TEAM_DOMAIN");
  }
  if (!audienceMatches(payload.aud, audiences)) {
    throw new AccessVerificationError("access_token_audience_mismatch", "Cloudflare Access token audience does not match CF_ACCESS_AUD");
  }
}

async function verifyAccessJwt(token: string, env: AuthEnv): Promise<JwtPayload> {
  const domain = accessTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const audiences = accessAudiences(env.CF_ACCESS_AUD);
  if (!domain || audiences.length === 0) {
    throw new AccessVerificationError("access_not_configured", "Cloudflare Access validation is not configured; set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD", 503);
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new AccessVerificationError("access_token_malformed", "Cloudflare Access token is malformed");
  }
  let header: Record<string, unknown>;
  try { header = decodeJsonPart(parts[0]); } catch { throw new AccessVerificationError("access_token_malformed", "Cloudflare Access token header is malformed"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AccessVerificationError("access_token_malformed", "Cloudflare Access token does not use the expected RS256 signing algorithm");
  }
  let accessKeys = accessKeysByDomain.get(domain);
  if (!accessKeys || accessKeys.expiresAt < Date.now()) {
    let response: Response;
    try { response = await fetch(`https://${domain}/cdn-cgi/access/certs`); } catch {
      throw new AccessVerificationError("access_signing_keys_unavailable", "Could not load Cloudflare Access signing keys; verify CF_ACCESS_TEAM_DOMAIN", 503);
    }
    if (!response.ok) {
      throw new AccessVerificationError("access_signing_keys_unavailable", "Could not load Cloudflare Access signing keys; verify CF_ACCESS_TEAM_DOMAIN", 503);
    }
    const body = await response.json() as { keys?: JsonWebKey[] };
    accessKeys = { keys: body.keys ?? [], expiresAt: Date.now() + 3_600_000 };
    accessKeysByDomain.set(domain, accessKeys);
  }
  const jwk = accessKeys.keys.find((candidate) => (candidate as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) throw new AccessVerificationError("access_signing_key_mismatch", "Access signing key was not found; verify CF_ACCESS_TEAM_DOMAIN and sign in again");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new AccessVerificationError("access_token_signature_invalid", "Cloudflare Access token signature is invalid; verify CF_ACCESS_TEAM_DOMAIN");
  let payload: JwtPayload;
  try { payload = decodeJsonPart(parts[1]) as JwtPayload; } catch { throw new AccessVerificationError("access_token_malformed", "Cloudflare Access token payload is malformed"); }
  validateAccessClaims(payload, domain, audiences);
  return payload;
}

export async function requireAdmin(request: Request, env: AuthEnv): Promise<AdminUser> {
  if (env.AUTH_TEST_MODE === "true" && request.headers.get("X-Test-Admin") === "true") {
    const user = testUser(request, env);
    if (user?.email) return { ...user, email: user.email };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AuthError(jsonError("unauthorized", "Cloudflare Access authentication is required", 401));
  try {
    const payload = await verifyAccessJwt(token, env);
    if (typeof payload.email !== "string" || !payload.email.trim()) throw new AccessVerificationError("access_token_identity_missing", "Cloudflare Access token does not contain an administrator email");
    const allowed = (env.COMMUNITY_ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(payload.email.toLowerCase())) {
      throw new AuthError(jsonError("forbidden", "Administrator access is required", 403));
    }
    return { id: typeof payload.sub === "string" ? payload.sub : payload.email, email: payload.email };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof AccessVerificationError) {
      console.warn("Cloudflare Access verification failed", { code: error.code, message: error.message });
      throw new AuthError(jsonError(error.code, error.message, error.status));
    }
    console.warn("Cloudflare Access verification failed", { code: "access_token_invalid" });
    throw new AuthError(jsonError("access_token_invalid", "Cloudflare Access token could not be validated", 401));
  }
}
