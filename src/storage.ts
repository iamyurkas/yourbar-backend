import type { RecipeSharePayloadV1 } from "./schema.js";

export type RecipeShareRecord = {
  id: string;
  payload: RecipeSharePayloadV1;
  createdAt: string;
  expiresAt: string;
  recipeChecksum: string;
};

export type RecipeShareKV = Pick<KVNamespace, "get" | "put">;

export function recipeKey(id: string): string {
  return `recipe:${id}`;
}

export function recipeChecksumKey(checksum: string): string {
  return `recipe-checksum:${checksum}`;
}

export async function putRecipeShare(kv: RecipeShareKV, record: RecipeShareRecord, ttlSeconds: number): Promise<void> {
  await kv.put(recipeKey(record.id), JSON.stringify(record), { expirationTtl: ttlSeconds });
  await kv.put(recipeChecksumKey(record.recipeChecksum), record.id, { expirationTtl: ttlSeconds });
}

export async function getRecipeShare(kv: RecipeShareKV, id: string): Promise<RecipeShareRecord | null> {
  const record = await kv.get<RecipeShareRecord>(recipeKey(id), "json");
  return record ?? null;
}

export async function getRecipeIdByChecksum(kv: RecipeShareKV, checksum: string): Promise<string | null> {
  return (await kv.get(recipeChecksumKey(checksum))) ?? null;
}
