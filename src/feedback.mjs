import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveAccountToken, resolveRepoToken } from "./config.mjs";
import { apiRequest, ApiError, defaultApiUrl } from "./http.mjs";
import { CLI_VERSION } from "./version.mjs";

const KINDS = new Set(["question", "doc_gap", "bug", "other"]);
const AUTH_CODES = new Set(["auth_required", "control_token_invalid", "control_token_expired"]);
const FIELDS = new Set(["message", "kind", "context", "repo_full_name", "route", "cli_version", "kit_version", "command", "error_code"]);

export async function runFeedback(ctx) {
  const message = ctx.args._[1];
  const kind = ctx.args.kind === undefined ? "other" : ctx.stringArg("kind");
  if (ctx.args._.length !== 2 || typeof message !== "string" || message.trim().length === 0 || message.length > 8000) {
    return ctx.usage(1, "feedback", "Provide one feedback message with 1 to 8000 characters.");
  }
  if (!KINDS.has(kind)) return ctx.usage(1, "feedback", "--kind must be question, doc_gap, bug, or other.");
  const command = ctx.stringArg("command");
  if (command !== undefined && command.length > 500) return ctx.usage(1, "feedback", "--command must have at most 500 characters.");
  const repo = ctx.stringArg("repo") ?? ctx.detectGitHubRepo();
  if (repo !== undefined && !isRepoName(repo)) return ctx.usage(1, "feedback", "--repo must use the owner/repo form.");
  const context = { cli_version: CLI_VERSION };
  for (const [field, value] of Object.entries({
    repo_full_name: repo,
    route: ctx.stringArg("route"),
    kit_version: kitVersion(),
    command,
    error_code: ctx.stringArg("error-code")
  })) {
    if (value !== undefined) context[field] = value;
  }
  const body = { message, kind, context };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 64 * 1024) {
    return ctx.usage(1, "feedback", "Feedback must fit within 64 KiB. Shorten the message or context.");
  }

  let credential;
  try {
    credential = resolveAccountToken(ctx.stringArg("account-token"));
    if (!credential && (repo || ctx.stringArg("setup-key") || process.env.BENCHROUTER_SETUP_KEY?.trim())) {
      credential = resolveRepoToken(repo, ctx.stringArg("setup-key"));
    }
  } catch {
    return ctx.fail("Feedback requires an account login or a repository setup key. Run benchrouter login or supply --setup-key.", "auth_required");
  }
  if (!credential) return ctx.fail("Run benchrouter login or supply a repository setup key with --setup-key.", "auth_required");
  try {
    const result = await apiRequest({
      apiUrl: defaultApiUrl(ctx.stringArg("api-url")), token: credential.token,
      method: "POST", path: "/v1/feedback", label: "feedback", body, retry503: true
    });
    // Only a feedback receipt counts as sent.
    if (result?.object !== "customer_feedback" || typeof result.id !== "string" || !result.id.startsWith("fb_")) {
      return ctx.fail("BenchRouter did not return a feedback receipt. Retry in a minute.", "feedback_receipt_missing");
    }
    if (ctx.args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Feedback sent: ${result.id}\n`);
  } catch (error) {
    if (!(error instanceof ApiError)) return ctx.fail("BenchRouter feedback request failed. Retry in a minute.", "feedback_request_failed");
    const { status, code } = error;
    if (code === "read_token_invalid" || code === "read_scope_expired") {
      return ctx.fail("The repository setup key is invalid or expired. Run benchrouter login or supply a current --setup-key.", code);
    }
    if (status === 400) {
      const field = error.body?.error?.field;
      const knownField = typeof field === "string" && (FIELDS.has(field) || (field.startsWith("context.") && FIELDS.has(field.slice(8))));
      return ctx.fail(knownField ? `Invalid feedback field: ${field}. Check its value.` : "Invalid feedback. Check the message and context fields.", "invalid_feedback");
    }
    if (status === 401) return ctx.fail("Your account login is missing, invalid, or expired. Run benchrouter login.", AUTH_CODES.has(code) ? code : "auth_required");
    if (status === 403) return ctx.fail("Your BenchRouter access changed. Run benchrouter login to refresh access.", "access_changed");
    if (status === 413) return ctx.fail("Feedback exceeds 64 KiB. Shorten the message or context.", "payload_too_large");
    if (status === 429) return ctx.fail(`Feedback limit reached (20 per person per 24 hours). ${retryHint(error.retryAfter)}`, "feedback_limit_reached");
    if (status === 503) return ctx.fail("BenchRouter feedback is temporarily unavailable. Retry in a minute.", "temporarily_unavailable");
    return ctx.fail("BenchRouter could not accept feedback. Retry in a minute.", "feedback_failed");
  }
}

function isRepoName(value) {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== ".."
    && [...part.toLowerCase()].every((char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || "_.-".includes(char)));
}

function kitVersion() {
  try {
    const workflow = parseYaml(readFileSync(".github/workflows/benchrouter-evals.yml", "utf8"));
    for (const job of Object.values(workflow?.jobs ?? {})) {
      if (!Array.isArray(job?.steps)) continue;
      const version = job.steps.find((step) => step?.id === "benchrouter_runtime")?.env?.BENCHROUTER_KIT_VERSION;
      if (isVersion(version)) return version;
    }
  } catch {
    // Optional context must not prevent reporting a broken or absent workflow.
  }
  return undefined;
}

function isVersion(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0
    && [...part].every((char) => char >= "0" && char <= "9")
    && Number.isSafeInteger(Number(part)) && String(Number(part)) === part);
}

function retryHint(value) {
  if (value !== null) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && String(seconds) === value) {
      const date = new Date(Date.now() + seconds * 1000);
      if (Number.isFinite(date.getTime())) return `Retry after ${date.toISOString()}.`;
    }
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toUTCString() === value) return `Retry after ${date.toISOString()}.`;
  }
  return "Retry in 24 hours.";
}
