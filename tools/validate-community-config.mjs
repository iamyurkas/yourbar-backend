import { readFile } from "node:fs/promises";

const environment = process.argv[2] ?? "production";
const configPath = process.argv[3] ? new URL(process.argv[3], `file://${process.cwd()}/`) : new URL("../wrangler.toml", import.meta.url);
if (environment !== "production" && environment !== "staging") {
  console.error("Usage: node tools/validate-community-config.mjs [production|staging]");
  process.exit(2);
}

const config = await readFile(configPath, "utf8");
const stagingMarker = "[env.staging]";
const stagingStart = config.indexOf(stagingMarker);
if (stagingStart < 0) {
  console.error("wrangler.toml does not define [env.staging]");
  process.exit(1);
}

const section = environment === "staging" ? config.slice(stagingStart) : config.slice(0, stagingStart);
const flag = (name) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1];
const communityEnabled = flag("COMMUNITY_FEATURE_ENABLED") === "true";
const submissionsEnabled = flag("COMMUNITY_SUBMISSIONS_ENABLED") === "true";
const adminEnabled = flag("COMMUNITY_ADMIN_ENABLED") === "true";
const feedEnabled = flag("COMMUNITY_PUBLIC_FEED_ENABLED") === "true";
const hasD1Binding = new RegExp(`^\\[\\[${environment === "staging" ? "env\\.staging\\." : ""}d1_databases\\]\\][\\s\\S]*?^binding\\s*=\\s*"YOURBAR_DB"`, "m").test(section);
const secretsSectionName = environment === "staging" ? "env.staging.secrets" : "secrets";
const secretsMarker = `[${secretsSectionName}]`;
const secretsStart = section.indexOf(secretsMarker);
const secretsEnd = secretsStart < 0 ? -1 : section.indexOf("\n[", secretsStart + secretsMarker.length);
const secretsSection = secretsStart < 0 ? "" : section.slice(secretsStart, secretsEnd < 0 ? undefined : secretsEnd);
const requiredSecrets = new Set(secretsSection.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1)) ?? []);
const missingAdminSecrets = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"].filter((name) => !requiredSecrets.has(name));

const enabledFlags = [
  ["COMMUNITY_FEATURE_ENABLED", communityEnabled],
  ["COMMUNITY_SUBMISSIONS_ENABLED", submissionsEnabled],
  ["COMMUNITY_ADMIN_ENABLED", adminEnabled],
  ["COMMUNITY_PUBLIC_FEED_ENABLED", feedEnabled],
].filter(([, enabled]) => enabled).map(([name]) => name);

if (!communityEnabled && enabledFlags.length > 0) {
  console.error(`${environment}: subordinate Community flags cannot be enabled while COMMUNITY_FEATURE_ENABLED is false`);
  process.exit(1);
}

if (communityEnabled && !hasD1Binding) {
  console.error(`${environment}: Community is enabled but the YOURBAR_DB D1 binding is missing.`);
  console.error(`Add a real [[${environment === "staging" ? "env.staging." : ""}d1_databases]] binding and apply migrations before enabling Community.`);
  process.exit(1);
}

if (adminEnabled && missingAdminSecrets.length > 0) {
  console.error(`${environment}: Community administration is enabled but required Cloudflare Access secrets are not declared: ${missingAdminSecrets.join(", ")}.`);
  console.error(`Declare them in [${environment === "staging" ? "env.staging.secrets" : "secrets"}] so Wrangler rejects deployments where Access validation is not configured.`);
  process.exit(1);
}

console.log(`${environment}: Community configuration is safe (${communityEnabled ? "enabled with D1" : "disabled"}).`);
