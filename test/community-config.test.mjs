import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validator = new URL('../tools/validate-community-config.mjs', import.meta.url).pathname;

async function validate(stagingSection) {
  const directory = await mkdtemp(join(tmpdir(), 'yourbar-config-'));
  const config = join(directory, 'wrangler.toml');
  await writeFile(config, `[vars]\nCOMMUNITY_FEATURE_ENABLED = "false"\nCOMMUNITY_SUBMISSIONS_ENABLED = "false"\nCOMMUNITY_ADMIN_ENABLED = "false"\nCOMMUNITY_PUBLIC_FEED_ENABLED = "false"\n\n[env.staging]\n[env.staging.vars]\n${stagingSection}\n`);
  return spawnSync(process.execPath, [validator, 'staging', config], { encoding: 'utf8' });
}

test('staging config rejects enabled Community without YOURBAR_DB', async () => {
  const result = await validate('COMMUNITY_FEATURE_ENABLED = "true"\nCOMMUNITY_SUBMISSIONS_ENABLED = "true"');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /YOURBAR_DB D1 binding is missing/);
});

test('staging config accepts enabled Community with a real-shaped D1 binding', async () => {
  const result = await validate('COMMUNITY_FEATURE_ENABLED = "true"\nCOMMUNITY_SUBMISSIONS_ENABLED = "true"\n\n[[env.staging.d1_databases]]\nbinding = "YOURBAR_DB"\ndatabase_name = "yourbar-community-staging"\ndatabase_id = "00000000-0000-0000-0000-000000000001"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /enabled with D1/);
});

test('staging config rejects enabled administration without required Access secrets', async () => {
  const result = await validate('COMMUNITY_FEATURE_ENABLED = "true"\nCOMMUNITY_ADMIN_ENABLED = "true"\n\n[[env.staging.d1_databases]]\nbinding = "YOURBAR_DB"\ndatabase_name = "yourbar-community-staging"\ndatabase_id = "00000000-0000-0000-0000-000000000001"');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required Cloudflare Access secrets are not declared/);
  assert.match(result.stderr, /CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD/);
});

test('staging config accepts enabled administration with required Access secrets', async () => {
  const result = await validate('COMMUNITY_FEATURE_ENABLED = "true"\nCOMMUNITY_ADMIN_ENABLED = "true"\n\n[env.staging.secrets]\nrequired = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]\n\n[[env.staging.d1_databases]]\nbinding = "YOURBAR_DB"\ndatabase_name = "yourbar-community-staging"\ndatabase_id = "00000000-0000-0000-0000-000000000001"');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /enabled with D1/);
});
