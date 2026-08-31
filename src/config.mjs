import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ACCOUNT_CONTROL_TOKEN_PREFIX = "br_ctrl_";
export const ADMIN_TOKEN_PREFIX = "bradm_";
const OWNER_FILE_MODE = 0o600;
const OWNER_DIR_MODE = 0o700;

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

function adminTokenPath() {
  return path.join(benchRouterConfigDir(), "admin.json");
}

export async function saveRepoToken(repoFullName, token) {
  assertRepoToken(token);
  const normalizedRepo = normalizeRepoFullName(repoFullName);
  const target = repoTokenPath(normalizedRepo);
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR_MODE });
  chmodSync(path.dirname(target), OWNER_DIR_MODE);
  writeOwnerJson(target, {
    repo_full_name: normalizedRepo,
    token,
    saved_at: new Date().toISOString()
  });
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
  const parsed = readJsonFile(target, "Stored BenchRouter credentials are not valid JSON");
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
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR_MODE });
  chmodSync(path.dirname(target), OWNER_DIR_MODE);
  writeOwnerJson(target, {
    token,
    saved_at: new Date().toISOString(),
    ...(typeof meta.account_id === "string" ? { account_id: meta.account_id } : {}),
    ...(typeof meta.account_slug === "string" ? { account_slug: meta.account_slug } : {})
  });
  return target;
}

/**
 * Resolve account control-plane credential.
 * Order: --account-token, BENCHROUTER_ACCOUNT_TOKEN, mode-0600 local config.
 * Never accepts runtime, repo-read, admin, or upgrade tokens.
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
  const parsed = readJsonFile(target, "Stored BenchRouter account credentials are not valid JSON");
  assertAccountToken(parsed?.token);
  return {
    token: parsed.token,
    source: "config",
    path: target,
    account_id: typeof parsed.account_id === "string" ? parsed.account_id : undefined,
    account_slug: typeof parsed.account_slug === "string" ? parsed.account_slug : undefined
  };
}

/** Owner-only local admin bearer (bradm_). */
export async function saveAdminToken(token) {
  assertAdminToken(token);
  const target = adminTokenPath();
  await mkdir(path.dirname(target), { recursive: true, mode: OWNER_DIR_MODE });
  chmodSync(path.dirname(target), OWNER_DIR_MODE);
  writeOwnerJson(target, {
    token,
    saved_at: new Date().toISOString()
  });
  return target;
}

/**
 * Resolve admin bearer credential.
 * Order: --admin-token, BENCHROUTER_ADMIN_TOKEN, mode-0600 local config.
 * Rejects runtime, repo-read, and account control tokens.
 */
export function resolveAdminToken(explicitToken) {
  const environmentToken = process.env.BENCHROUTER_ADMIN_TOKEN?.trim();
  const candidate = explicitToken?.trim() || environmentToken;
  if (candidate) {
    assertAdminToken(candidate);
    return { token: candidate, source: explicitToken ? "argument" : "environment" };
  }
  const target = adminTokenPath();
  if (!existsSync(target)) {
    return null;
  }
  const parsed = readJsonFile(target, "Stored BenchRouter admin credentials are not valid JSON");
  assertAdminToken(parsed?.token);
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

export function assertAccountToken(token) {
  const value = requireNonEmptyToken(token, "Account access requires a br_ctrl_ account token.");
  rejectWrongScope(value, {
    runtime: "Runtime API keys cannot authorize control-plane commands. Use a br_ctrl_ account token.",
    setup: "Repo setup/read tokens cannot authorize account commands. Use a br_ctrl_ account token.",
    upgrade: "Upgrade tokens cannot authorize account commands. Use a br_ctrl_ account token.",
    admin: "Admin tokens cannot authorize account commands. Use a br_ctrl_ account token."
  });
  if (!value.startsWith(ACCOUNT_CONTROL_TOKEN_PREFIX)) {
    throw new Error("Account access requires a br_ctrl_ account token.");
  }
}

export function assertAdminToken(token) {
  const value = requireNonEmptyToken(token, "Admin access requires a bradm_ admin token.");
  rejectWrongScope(value, {
    runtime: "Runtime API keys cannot authorize admin commands. Use a bradm_ admin token.",
    setup: "Repo setup/read tokens cannot authorize admin commands. Use a bradm_ admin token.",
    account: "Account control tokens cannot authorize admin commands. Use a bradm_ admin token.",
    upgrade: "Upgrade tokens cannot authorize admin commands. Use a bradm_ admin token."
  });
  if (!value.startsWith(ADMIN_TOKEN_PREFIX)) {
    throw new Error("Admin access requires a bradm_ admin token.");
  }
}

/** Atomically replace JSON through a mode-0600 sibling file. */
export function writeOwnerJson(target, payload) {
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", OWNER_FILE_MODE);
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file can be absent when open or rename failed.
    }
    throw error;
  }
  chmodSync(target, OWNER_FILE_MODE);
  assertOwnerFileMode(target);
}

export function assertOwnerFileMode(target) {
  const mode = statSync(target).mode & 0o777;
  if (mode !== OWNER_FILE_MODE) {
    throw new Error(`Expected owner-only mode 0600 for ${target}, found ${mode.toString(8).padStart(3, "0")}.`);
  }
  return mode;
}

function requireNonEmptyToken(token, message) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error(message);
  }
  return token.trim();
}

function rejectWrongScope(value, messages) {
  if (value.startsWith("br_live_") || value.startsWith("br_test_")) {
    throw new Error(messages.runtime);
  }
  if (value.startsWith("br_setup_")) {
    throw new Error(messages.setup);
  }
  if (value.startsWith("br_upgrade_")) {
    throw new Error(messages.upgrade);
  }
  if (messages.admin && value.startsWith(ADMIN_TOKEN_PREFIX)) {
    throw new Error(messages.admin);
  }
  if (messages.account && value.startsWith(ACCOUNT_CONTROL_TOKEN_PREFIX)) {
    throw new Error(messages.account);
  }
}

function readJsonFile(target, message) {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch {
    throw new Error(`${message}: ${target}`);
  }
}
