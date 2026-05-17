import type { RecipeSharePayloadV1 } from "./schema.js";

export type RecipeShareRecord = {
  id: string;
  payload: RecipeSharePayloadV1;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
  recipeChecksum: string;
};

export type RecipeShareKV = {
  get: KVNamespace["get"];
  put: KVNamespace["put"];
  delete(key: string): Promise<void>;
};

export function recipeKey(id: string): string {
  return `recipe:${id}`;
}

export function recipeChecksumKey(checksum: string): string {
  return `recipe-checksum:${checksum}`;
}

export function imageChecksumKey(checksum: string): string {
  return `image-checksum:${checksum}`;
}

export function imageAccessKey(key: string): string {
  return `image-access:${key}`;
}

export async function putRecipeShare(kv: RecipeShareKV, record: RecipeShareRecord, ttlSeconds: number): Promise<void> {
  await kv.put(recipeKey(record.id), JSON.stringify(record), { expirationTtl: ttlSeconds });
  await kv.put(recipeChecksumKey(record.recipeChecksum), record.id, { expirationTtl: ttlSeconds });
}

export async function getRecipeShare(kv: RecipeShareKV, id: string): Promise<RecipeShareRecord | null> {
  const record = await kv.get<RecipeShareRecord>(recipeKey(id), "json");
  return record ?? null;
}

export async function refreshRecipeShare(kv: RecipeShareKV, record: RecipeShareRecord, ttlSeconds: number, now = Date.now()): Promise<RecipeShareRecord> {
  const refreshed: RecipeShareRecord = {
    ...record,
    lastAccessedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
  await putRecipeShare(kv, refreshed, ttlSeconds);
  return refreshed;
}

export async function getRecipeIdByChecksum(kv: RecipeShareKV, checksum: string): Promise<string | null> {
  return (await kv.get(recipeChecksumKey(checksum))) ?? null;
}

export async function putImageKeyByChecksum(kv: RecipeShareKV, checksum: string, key: string, ttlSeconds?: number): Promise<void> {
  const options = ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds };
  await kv.put(imageChecksumKey(checksum), key, options);
}

export async function putImageAccessMarker(kv: RecipeShareKV, key: string, ttlSeconds: number): Promise<void> {
  await kv.put(imageAccessKey(key), "1", { expirationTtl: ttlSeconds });
}

export async function getImageAccessMarker(kv: RecipeShareKV, key: string): Promise<string | null> {
  return (await kv.get(imageAccessKey(key))) ?? null;
}

export async function deleteImageAccessRecords(kv: RecipeShareKV, key: string, checksum?: string): Promise<void> {
  await kv.delete(imageAccessKey(key));
  if (checksum) await kv.delete(imageChecksumKey(checksum));
}

export async function getImageKeyByChecksum(kv: RecipeShareKV, checksum: string): Promise<string | null> {
  return (await kv.get(imageChecksumKey(checksum))) ?? null;
}
