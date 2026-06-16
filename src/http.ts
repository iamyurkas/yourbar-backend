export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function jsonError(code: string, message: string, status: number, details?: unknown, headers: HeadersInit = {}): Response {
  const body: ErrorBody = details === undefined ? { error: { code, message } } : { error: { code, message, details } };
  return jsonResponse(body, status, headers);
}

export function htmlResponse(html: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer-when-downgrade",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; navigate-to *;",
      ...headers,
    },
  });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

export function getAllowedCorsOrigin(origin: string | null, configuredOrigins: string | undefined): string | null {
  if (!origin) return configuredOrigins?.trim() ? null : "*";
  const trimmed = configuredOrigins?.trim();
  if (!trimmed) return "*";
  const allowed = trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

export function withCors(response: Response, request: Request, configuredOrigins: string | undefined): Response {
  const origin = getAllowedCorsOrigin(request.headers.get("Origin"), configuredOrigins);
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", origin === "*" ? "Origin" : "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsPreflight(request: Request, configuredOrigins: string | undefined): Response {
  const origin = getAllowedCorsOrigin(request.headers.get("Origin"), configuredOrigins);
  if (!origin) return jsonError("forbidden_origin", "Origin is not allowed", 403);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ?? "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin, Access-Control-Request-Headers",
    },
  });
}

export function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().split(";")[0]?.trim() === "application/json";
}
