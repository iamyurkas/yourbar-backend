import { jsonError } from "./http.js";

export type AuthenticatedUser = {
  id: string;
  email?: string;
};

export type AuthEnv = {
  AUTH_JWT_HS256_SECRET?: string;
  AUTH_JWT_SUB_CLAIM?: string;
  AUTH_TRUSTED_USER_HEADER_ENABLED?: string;
  COMMUNITY_TEST_USER_HEADER?: string;
  COMMUNITY_ADMIN_EMAILS?: string;
  COMMUNITY_ADMIN_AUDIENCES?: string;
};

export type AuthResult = { ok: true; user: AuthenticatedUser } | { ok: false; response: Response };

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

async function verifyHs256Jwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedBytes = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signedBytes));
  const actual = base64UrlDecode(encodedSignature);
  if (!timingSafeEqual(expected, actual)) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp <= nowSeconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) return null;
  return payload;
}

function userFromTrustedHeader(request: Request, env: AuthEnv): AuthenticatedUser | null {
  if (env.AUTH_TRUSTED_USER_HEADER_ENABLED !== "true") return null;
  const headerName = env.COMMUNITY_TEST_USER_HEADER?.trim() || "X-YourBar-User-Id";
  const id = request.headers.get(headerName)?.trim();
  if (!id) return null;
  const email = request.headers.get("X-YourBar-User-Email")?.trim();
  return email ? { id, email } : { id };
}

export async function getOptionalUser(request: Request, env: AuthEnv): Promise<AuthenticatedUser | null> {
  const trusted = userFromTrustedHeader(request, env);
  if (trusted) return trusted;

  const authorization = request.headers.get("Authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) return null;
  const secret = env.AUTH_JWT_HS256_SECRET?.trim();
  if (!secret) return null;
  const payload = await verifyHs256Jwt(authorization.slice("Bearer ".length).trim(), secret);
  if (!payload) return null;
  const claimName = env.AUTH_JWT_SUB_CLAIM?.trim() || "sub";
  const id = payload[claimName];
  if (typeof id !== "string" || !id.trim()) return null;
  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : undefined;
  return email ? { id: id.trim(), email } : { id: id.trim() };
}

export async function requireUser(request: Request, env: AuthEnv): Promise<AuthResult> {
  const user = await getOptionalUser(request, env);
  if (!user) return { ok: false, response: jsonError("unauthorized", "Authentication is required", 401) };
  return { ok: true, user };
}

function accessUser(request: Request): AuthenticatedUser | null {
  const email = request.headers.get("CF-Access-Authenticated-User-Email")?.trim();
  const jwt = request.headers.get("CF-Access-Jwt-Assertion")?.trim();
  if (!email && !jwt) return null;
  return email ? { id: email, email } : { id: "cloudflare-access-user" };
}

export async function requireAdmin(request: Request, env: AuthEnv): Promise<AuthResult> {
  const access = accessUser(request);
  if (!access) return { ok: false, response: jsonError("unauthorized", "Cloudflare Access authentication is required", 401) };
  const allowedEmails = env.COMMUNITY_ADMIN_EMAILS?.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
  if (allowedEmails.length > 0 && (!access.email || !allowedEmails.includes(access.email.toLowerCase()))) {
    return { ok: false, response: jsonError("forbidden", "Admin access is not allowed", 403) };
  }
  return { ok: true, user: access };
}
