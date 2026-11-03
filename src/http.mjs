import { resolveAccountToken, resolveAdminToken } from "./config.mjs";

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? null;
    this.code = code ?? null;
    this.body = body ?? null;
  }
}

export function defaultApiUrl(value) {
  return String(value || "https://api.benchrouter.com").replace(/\/+$/, "");
}

export function requireAccountCredential(explicitToken) {
  let credential;
  try {
    credential = resolveAccountToken(explicitToken);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not read account credentials.");
  }
  if (!credential) {
    throw new Error(
      "Missing account token. Pass --account-token, set BENCHROUTER_ACCOUNT_TOKEN, or save a br_ctrl_ token in private local config."
    );
  }
  return credential;
}

export function requireAdminCredential(explicitToken) {
  let credential;
  try {
    credential = resolveAdminToken(explicitToken);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not read admin credentials.");
  }
  if (!credential) {
    throw new Error(
      "Missing admin token. Pass --admin-token, set BENCHROUTER_ADMIN_TOKEN, or save a bradm_ token in private local config."
    );
  }
  return credential;
}

export async function apiRequest({
  apiUrl,
  token,
  method = "GET",
  path,
  body,
  label,
  timeoutMs = 30000,
  signal
}) {
  const headers = {
    accept: "application/json",
    // EVAL-016: a hosted-eval approval records `cli` as its client for this header.
    "x-benchrouter-client": "cli"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const send = async () => {
    try {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
      });
      return { response, text: await response.text() };
    } catch (error) {
      throw new Error(`BenchRouter ${label} request failed: ${networkMessage(error)}`);
    }
  };

  let { response, text } = await send();
  // A read the server could not serve for a moment (503 with Retry-After) is sent once more
  // after the wait it names. A write is never repeated: it could take effect twice.
  const waitMs = method === "GET" && response.status === 503 ? retryAfterMs(response.headers.get("retry-after")) : null;
  if (waitMs !== null) {
    await wait(waitMs, signal, label);
    ({ response, text } = await send());
  }

  const parsed = parseJson(text);
  if (!response.ok) {
    const message = errorMessage(parsed, text);
    const code = errorCode(parsed);
    throw new ApiError(`BenchRouter ${label} failed (${response.status}): ${message}`, {
      status: response.status,
      code,
      body: parsed
    });
  }
  if (parsed === null && text.trim().length > 0) {
    throw new Error(`BenchRouter ${label} returned invalid JSON.`);
  }
  return parsed ?? {};
}

/** Encode a route key for dashboard paths (preserve "/"). */
export function encodeRouteKey(routeKey) {
  return encodeURI(String(routeKey));
}

export function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(parsed, text) {
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  }
  return text.slice(0, 800) || "request failed";
}

function errorCode(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.error === "string") return parsed.error;
  if (parsed.error && typeof parsed.error.code === "string") return parsed.error.code;
  if (typeof parsed.code === "string") return parsed.code;
  return null;
}

/**
 * Retry-After in milliseconds when it asks for at most 10 seconds; null otherwise (absent,
 * malformed or too long). It takes only the two forms HTTP defines: delta-seconds ("3") and an
 * IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT"). Each must print back unchanged, so "+0", "0x0",
 * "1e-6", "01" and "2020-01-01" are refused.
 */
function retryAfterMs(value) {
  if (value === null) return null;
  const text = value.trim();
  const seconds = Number.parseInt(text, 10);
  let ms = null;
  if (String(seconds) === text && seconds >= 0) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(text);
    if (Number.isFinite(date) && new Date(date).toUTCString() === text) ms = date - Date.now();
  }
  if (ms === null || ms > 10000) return null;
  return Math.max(0, ms);
}

/** Sleep for the Retry-After wait; the caller's signal ends it at once. */
function wait(ms, signal, label) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(`BenchRouter ${label} request failed: ${networkMessage(signal.reason)}`));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function networkMessage(error) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : "request failed";
}
