function canonicalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeForChecksum(item));
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

export async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return bytesToHex(digest);
}

export async function recipeChecksum(recipe: unknown): Promise<string> {
  const canonicalRecipe = JSON.stringify(canonicalizeForChecksum(recipe));
  return sha256Hex(new TextEncoder().encode(canonicalRecipe));
}
