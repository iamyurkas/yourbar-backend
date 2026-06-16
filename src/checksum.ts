function canonicalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeForChecksum(entry)]),
    );
  }
  return typeof value === "string" ? value.trim() : value;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return bytesToHex(digest);
}

export async function recipeChecksum(recipe: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalizeForChecksum(recipe));
  return sha256Hex(new TextEncoder().encode(canonical));
}

export async function bytesChecksum(bytes: BufferSource): Promise<string> {
  return sha256Hex(bytes);
}
