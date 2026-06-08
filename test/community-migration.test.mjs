import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0001_community.sql', import.meta.url);

test('Community migration avoids compound trigger statements that Wrangler 4.91 splits incorrectly', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /CREATE\s+TRIGGER/i);
  assert.doesNotMatch(sql, /\bBEGIN\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS community_submissions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS community_recipes/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS community_recipe_saves/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS community_recipe_ratings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS admin_moderation_events/);
});
