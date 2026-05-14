const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const RECIPE_ID_REGEX = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{10,16}$/;

export function generateRecipeId(length = 12): string {
  if (!Number.isInteger(length) || length < 10 || length > 16) {
    throw new Error("Recipe id length must be an integer from 10 to 16");
  }

  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return id;
}

export function isValidRecipeId(id: string): boolean {
  return RECIPE_ID_REGEX.test(id);
}
