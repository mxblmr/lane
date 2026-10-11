#!/usr/bin/env node
/**
 * Applies Lane's Agent Engine project policies from project-policies.json (U10, KTD9).
 *
 * Owner: Codex, and only after AE1 has passed once on the deployed site. Rerun AE1 after
 * applying. Nobody else runs this script.
 *
 * Usage:
 *   node agents/policies/apply-policies.mjs            # dry run: prints current and planned policies
 *   node agents/policies/apply-policies.mjs --apply    # creates or updates the project policies
 *
 * Environment (never paste values into files or chat):
 *   AGENT_ENGINE_BASE_URL    optional, defaults to https://agentengine.mongodb.com
 *   AGENT_ENGINE_PROJECT_ID  the Agent Engine project id
 *   AGENT_ENGINE_TOKEN       a PROJECT_OWNER bearer token (for example the service account's)
 *
 * Endpoints are from the Policy Engine docs: GET and POST /api/v1/projects/{projectId}/policies,
 * PUT /api/v1/projects/{projectId}/policies/{policyId}, GET .../policies/effective. The docs
 * API readback on 2026-10-11 confirmed flat int_value and string_list fields.
 * The local definitions keep their simple value format; toBody maps it to the API.
 * Dry run prints existing policies before any mutation.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const definitions = JSON.parse(readFileSync(join(here, "project-policies.json"), "utf8"));
const apply = process.argv.includes("--apply");

const baseUrl = (process.env.AGENT_ENGINE_BASE_URL || "https://agentengine.mongodb.com").replace(/\/$/, "");
const projectId = process.env.AGENT_ENGINE_PROJECT_ID || "";
const token = process.env.AGENT_ENGINE_TOKEN || "";

function toBody(policy) {
  const value = Array.isArray(policy.value) ? { string_list: policy.value } : { int_value: policy.value };
  return { type: policy.type, enabled: policy.enabled, ...value };
}

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the raw text for the error message.
  }
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  return json;
}

function policyList(json) {
  if (Array.isArray(json)) return json;
  for (const key of ["policies", "results", "items", "data"]) {
    if (json && Array.isArray(json[key])) return json[key];
  }
  return [];
}

async function main() {
  console.log(`Planned project policies (${apply ? "apply" : "dry run"}):`);
  for (const policy of definitions.policies) console.log(`  ${JSON.stringify(toBody(policy))}`);
  if (!projectId || !token) {
    console.log("AGENT_ENGINE_PROJECT_ID or AGENT_ENGINE_TOKEN is not set; nothing was read or changed.");
    process.exit(apply ? 1 : 0);
  }
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/policies`;
  const existing = policyList(await call("GET", base));
  console.log(`Existing project policies (${existing.length}):`);
  for (const policy of existing) console.log(`  ${JSON.stringify(policy)}`);
  if (!apply) {
    console.log("Dry run only. Check the body shape against the existing policies, then rerun with --apply.");
    return;
  }
  for (const policy of definitions.policies) {
    const match = existing.find((p) => p && (p.type === policy.type || p.policy_type === policy.type || p.policyType === policy.type));
    const id = match && (match.id || match._id || match.policy_id || match.policyId);
    if (id) {
      await call("PUT", `${base}/${encodeURIComponent(String(id))}`, toBody(policy));
      console.log(`updated ${policy.type}`);
    } else {
      await call("POST", base, toBody(policy));
      console.log(`created ${policy.type}`);
    }
  }
  const effective = await call("GET", `${base}/effective`);
  console.log(`Effective policies: ${JSON.stringify(effective)}`);
  console.log("Changes apply within about a minute. Rerun AE1 on the deployed site now.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
