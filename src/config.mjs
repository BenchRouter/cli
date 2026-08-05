import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function benchRouterConfigDir() {
  const override = process.env.BENCHROUTER_CONFIG_DIR?.trim();
  return path.resolve(override || path.join(os.homedir(), ".config", "benchrouter"));
}

function repoTokenPath(repoFullName) {
  const token = Buffer.from(normalizeRepoFullName(repoFullName), "utf8").toString("base64url");
  return path.join(benchRouterConfigDir(), "repositories", `${token}.json`);
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
