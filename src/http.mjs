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
    accept: "application/json"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  let text;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
  } catch (error) {
    throw new Error(`BenchRouter ${label} request failed: ${networkMessage(error)}`);
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

function networkMessage(error) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : "request failed";
}
