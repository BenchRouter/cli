import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { saveAccountToken } from "./config.mjs";
import { apiRequest, ApiError, defaultApiUrl } from "./http.mjs";

const DEFAULT_TOKEN_TTL_DAYS = 90;
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_POLL_MS = 5_000;

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function codeChallenge(verifier) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function authorizationRequest(apiUrl, body, signal) {
  return apiRequest({
    apiUrl,
    method: "POST",
    path: "/v1/cli/authorizations",
    body,
    label: "login authorization",
    signal
  });
}

function transactionRequest(apiUrl, transactionId, action, body, signal, timeoutMs = 30_000) {
  return apiRequest({
    apiUrl,
    method: "POST",
    path: `/v1/cli/authorizations/${encodeURIComponent(transactionId)}/${action}`,
    body,
    label: `login ${action}`,
    timeoutMs,
    signal
  });
}

function assertAuthorizationResponse(body) {
  const transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
  const authorizeUrl = typeof body.authorize_url === "string" ? body.authorize_url : "";
  const expiresAt = typeof body.expires_at === "string" ? body.expires_at : "";
  if (!transactionId || !authorizeUrl || !expiresAt) {
    throw new Error("BenchRouter returned an invalid login authorization.");
  }
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("BenchRouter returned an invalid login expiry.");
  }
  const parsed = new URL(authorizeUrl);
  const queryKeys = [...parsed.searchParams.keys()];
  if (
    parsed.username
    || parsed.password
    || parsed.hash
    || queryKeys.length !== 1
    || queryKeys[0] !== "transaction"
    || parsed.searchParams.get("transaction") !== transactionId
  ) {
    throw new Error("BenchRouter returned an unsafe login URL.");
  }
  return { transactionId, authorizeUrl, expiresAt };
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  child.once("error", () => {
    // The caller already prints the safe authorization URL as a fallback.
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Login interrupted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Login interrupted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelBestEffort(apiUrl, transactionId, nonce) {
  try {
    await transactionRequest(apiUrl, transactionId, "cancel", { nonce }, undefined, 5_000);
  } catch {
    // Server expiry remains the final bound if cancellation cannot reach it.
  }
}

function validateExchange(body) {
  const controlToken = body && typeof body.control_token === "object" ? body.control_token : null;
  const account = body && typeof body.account === "object" ? body.account : null;
  const token = controlToken && typeof controlToken.token === "string" ? controlToken.token : "";
  const accountId = account && typeof account.id === "string" ? account.id : "";
  const accountSlug = account && typeof account.slug === "string" ? account.slug : "";
  const displayName = account && typeof account.display_name === "string" ? account.display_name : "";
  if (!token.startsWith("br_ctrl_") || !accountId || !accountSlug || !displayName) {
    throw new Error("BenchRouter returned an invalid login exchange.");
  }
  return { token, accountId, accountSlug, displayName };
}

function validateSelf(body, expectedAccountId) {
  const account = body && typeof body.account === "object" ? body.account : null;
  if (!body?.ok || !account || account.id !== expectedAccountId) {
    throw new Error("Saved credentials did not prove the authorized account.");
  }
}

export async function runLogin(ctx) {
  const apiUrl = defaultApiUrl(ctx.stringArg("api-url"));
  const tokenName = ctx.stringArg("name", "CLI login").trim();
  const ttlDays = Number(ctx.stringArg("expires-in-days", String(DEFAULT_TOKEN_TTL_DAYS)));
  const timeoutSeconds = Number(ctx.stringArg("timeout-seconds", String(DEFAULT_LOGIN_TIMEOUT_MS / 1000)));
  if (!tokenName || tokenName.length > 80) {
    return ctx.usage(1, "login", "--name must be 1 to 80 characters.");
  }
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    return ctx.usage(1, "login", "--expires-in-days must be an integer from 1 to 365.");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
    return ctx.usage(1, "login", "--timeout-seconds must be greater than 0 and at most 600.");
  }

  const verifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const abortController = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    abortController.abort(new Error("Login interrupted."));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let transactionId = null;
  try {
    const authorization = assertAuthorizationResponse(await authorizationRequest(apiUrl, {
      nonce,
      code_challenge: codeChallenge(verifier),
      client_name: "BenchRouter CLI",
      token_name: tokenName,
      token_ttl_seconds: ttlDays * 24 * 60 * 60
    }, abortController.signal));
    transactionId = authorization.transactionId;

    if (!ctx.args["no-open"]) openBrowser(authorization.authorizeUrl);
    const prompt = ctx.args["no-open"]
      ? `Open this URL to authorize the CLI: ${authorization.authorizeUrl}`
      : `Opened your browser. If it did not open, visit: ${authorization.authorizeUrl}`;
    process.stderr.write(`${prompt}\nWaiting for approval…\n`);

    const deadline = Math.min(
      Date.parse(authorization.expiresAt),
      Date.now() + timeoutSeconds * 1000
    );
    let pollMs = 1_000;
    while (Date.now() < deadline) {
      let statusBody;
      try {
        statusBody = await transactionRequest(
          apiUrl,
          transactionId,
          "status",
          { nonce },
          abortController.signal
        );
      } catch (error) {
        if (error instanceof ApiError && error.status !== null && error.status < 500) throw error;
        await delay(pollMs, abortController.signal);
        pollMs = Math.min(MAX_POLL_MS, Math.ceil(pollMs * 1.5));
        continue;
      }
      const status = typeof statusBody.status === "string" ? statusBody.status : "";
      if (status === "approved") break;
      if (status === "denied") throw new Error("CLI authorization was denied.");
      if (status === "cancelled") throw new Error("CLI authorization was cancelled.");
      if (status === "expired") throw new Error("CLI authorization expired. Run benchrouter login again.");
      if (status !== "pending") throw new Error("BenchRouter returned an invalid login status.");
      const suggested = Number(statusBody.poll_after_ms);
      pollMs = Number.isFinite(suggested)
        ? Math.max(500, Math.min(MAX_POLL_MS, suggested))
        : Math.min(MAX_POLL_MS, Math.ceil(pollMs * 1.5));
      await delay(pollMs, abortController.signal);
    }
    if (Date.now() >= deadline) {
      await cancelBestEffort(apiUrl, transactionId, nonce);
      throw new Error("CLI authorization timed out. Run benchrouter login again.");
    }

    const exchange = validateExchange(await transactionRequest(
      apiUrl,
      transactionId,
      "exchange",
      { nonce, code_verifier: verifier },
      abortController.signal
    ));
    const target = await saveAccountToken(exchange.token, {
      account_id: exchange.accountId,
      account_slug: exchange.accountSlug
    });
    const self = await apiRequest({
      apiUrl,
      token: exchange.token,
      method: "GET",
      path: "/v1/account/control/me",
      label: "login proof",
      signal: abortController.signal
    });
    validateSelf(self, exchange.accountId);

    if (ctx.args.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        account: {
          id: exchange.accountId,
          slug: exchange.accountSlug,
          display_name: exchange.displayName
        },
        credential_path: target
      }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Signed in to ${exchange.displayName} (${exchange.accountSlug}).\nCredentials saved to ${target}.\n`);
  } catch (error) {
    if (interrupted && transactionId) await cancelBestEffort(apiUrl, transactionId, nonce);
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
