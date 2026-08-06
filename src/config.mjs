import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ACCOUNT_CONTROL_TOKEN_PREFIX = "br_ctrl_";

export function benchRouterConfigDir() {
  const override = process.env.BENCHROUTER_CONFIG_DIR?.trim();
  return path.resolve(override || path.join(os.homedir(), ".config", "benchrouter"));
}

function repoTokenPath(repoFullName) {
  const token = Buffer.from(normalizeRepoFullName(repoFullName), "utf8").toString("base64url");
  return path.join(benchRouterConfigDir(), "repositories", `${token}.json`);
}

function accountTokenPath() {
  return path.join(benchRouterConfigDir(), "account.json");
}

export async function saveRepoToken(repoFullName, token) {
  assertRepoToken(token);
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  const target = repoTokenPath(normalizedRepo);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(
    target,
    `${JSON.stringify({ repo_full_name: normalizedRepo, token, saved_at: new Date().toISOString() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return target;
}

export function resolveRepoToken(repoFullName, explicitToken) {
  const environmentToken = process.env.BENCHROUTER_TOKEN?.trim();
  const candidate = explicitToken?.trim() || environmentToken;
  if (candidate) {
    assertRepoToken(candidate);
    return { token: candidate, source: explicitToken ? "argument" : "environment" };
  }
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  const target = repoTokenPath(normalizedRepo);
  if (!existsSync(target)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new Error(`Stored BenchRouter credentials are not valid JSON: ${target}`);
  }
  if (parsed?.repo_full_name !== normalizedRepo) {
    throw new Error(`Stored BenchRouter credentials do not match ${normalizedRepo}.`);
  }
  assertRepoToken(parsed?.token);
  return { token: parsed.token, source: "config", path: target };
}

/** Owner-only local account control token (br_ctrl_). Never stores runtime keys. */
export async function saveAccountToken(token, meta = {}) {
  assertAccountToken(token);
  const target = accountTokenPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const payload = {
    token,
    saved_at: new Date().toISOString(),
    ...(typeof meta.account_id === "string" ? { account_id: meta.account_id } : {}),
    ...(typeof meta.account_slug === "string" ? { account_slug: meta.account_slug } : {})
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

/**
 * Resolve account control-plane credential.
 * Order: --account-token, BENCHROUTER_ACCOUNT_TOKEN, owner-only local config.
 * Never accepts a runtime (br_live_/br_test_) or repo-read (br_setup_) key.
 */
export function resolveAccountToken(explicitToken) {
  const environmentToken = process.env.BENCHROUTER_ACCOUNT_TOKEN?.trim();
  const candidate = explicitToken?.trim() || environmentToken;
  if (candidate) {
    assertAccountToken(candidate);
    return { token: candidate, source: explicitToken ? "argument" : "environment" };
  }
  const target = accountTokenPath();
  if (!existsSync(target)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new Error(`Stored BenchRouter account credentials are not valid JSON: ${target}`);
  }
  assertAccountToken(parsed?.token);
  return {
    token: parsed.token,
    source: "config",
    path: target,
    account_id: typeof parsed.account_id === "string" ? parsed.account_id : undefined,
    account_slug: typeof parsed.account_slug === "string" ? parsed.account_slug : undefined
  };
}

export function normalizeRepoFullName(repoFullName) {
  const normalized = typeof repoFullName === "string"
    ? repoFullName.trim().replace(/^github\.com[:/]/i, "").replace(/\.git$/i, "").toLowerCase()
    : "";
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Repository must use the owner/repo form.");
  }
  return normalized;
}

function assertRepoToken(token) {
  if (typeof token !== "string" || !token.startsWith("br_setup_")) {
    throw new Error("Repo read access requires a br_setup_ token.");
  }
}

export function assertAccountToken(token) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Account access requires a br_ctrl_ account token.");
  }
  const value = token.trim();
  if (value.startsWith("br_live_") || value.startsWith("br_test_")) {
    throw new Error("Runtime API keys cannot authorize control-plane commands. Use a br_ctrl_ account token.");
  }
  if (value.startsWith("br_setup_")) {
    throw new Error("Repo setup/read tokens cannot authorize account commands. Use a br_ctrl_ account token.");
  }
  if (value.startsWith("br_upgrade_")) {
    throw new Error("Upgrade tokens cannot authorize account commands. Use a br_ctrl_ account token.");
  }
  if (!value.startsWith(ACCOUNT_CONTROL_TOKEN_PREFIX)) {
    throw new Error("Account access requires a br_ctrl_ account token.");
  }
}
