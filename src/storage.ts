import type { RecipeSharePayloadV1 } from "./schema.js";

export type RecipeShareRecord = {
  id: string;
  payload: RecipeSharePayloadV1;
  createdAt: string;
  expiresAt: string;
};

export type RecipeShareKV = Pick<KVNamespace, "get" | "put">;

export function recipeKey(id: string): string {
  return `recipe:${id}`;
}

export async function putRecipeShare(kv: RecipeShareKV, record: RecipeShareRecord, ttlSeconds: number): Promise<void> {
  await kv.put(recipeKey(record.id), JSON.stringify(record), { expirationTtl: ttlSeconds });
}

export async function getRecipeShare(kv: RecipeShareKV, id: string): Promise<RecipeShareRecord | null> {
  const record = await kv.get<RecipeShareRecord>(recipeKey(id), "json");
  return record ?? null;
}
