// The installed CLI version, and a notice when npm's `latest` benchrouter is newer.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export const CLI_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * One line telling the user to run the newest CLI, or null when this CLI is current or the
 * registry cannot answer within 3 seconds (offline, a proxy, a slow mirror). It reads the
 * registry npm itself uses (`npm_config_registry`), so a private mirror answers for it.
 */
export async function newerVersionNotice(command) {
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  const latest = (await getJson(`${registry}/benchrouter/latest`, 3000))?.version;
  if (typeof latest !== "string" || !isNewer(latest, CLI_VERSION)) return null;
  return `benchrouter ${latest} is available; this is ${CLI_VERSION}. Run: npx --yes benchrouter@latest ${command}`;
}

/**
 * GET a JSON body, or null on any failure. One deadline covers the request and up to 3
 * redirects (an http:// registry URL redirects to https). Aborting destroys the socket, so a
 * stalled connection cannot keep the process alive past the deadline (fetch leaves the
 * connection open until its own connect timeout).
 */
function getJson(url, timeoutMs) {
  return requestJson(url, AbortSignal.timeout(timeoutMs), 3);
}

function requestJson(url, signal, redirectsLeft) {
  return new Promise((resolve) => {
    let request;
    try {
      const client = new URL(url).protocol === "https:" ? https : http;
      request = client.get(url, { signal, headers: { accept: "application/json" } }, (response) => {
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirectsLeft > 0) {
          response.resume();
          let next;
          try {
            next = new URL(location, url).href;
          } catch {
            resolve(null);
            return;
          }
          resolve(requestJson(next, signal, redirectsLeft - 1));
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("error", () => resolve(null));
        response.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(null);
          }
        });
      });
    } catch {
      resolve(null);
      return;
    }
    request.on("error", () => resolve(null));
  });
}

/** Plain x.y.z only: a prerelease or malformed version never counts as newer. */
function isNewer(candidate, current) {
  const parse = (version) => {
    const parts = version.split(".");
    const numbers = parts.map(Number);
    // String(n) === part rejects "1-beta", "01", " 1" and "1e2"; each part must be a plain integer.
    const plain = parts.length === 3 && numbers.every((n, index) => Number.isSafeInteger(n) && n >= 0 && String(n) === parts[index]);
    return plain ? numbers : null;
  };
  const next = parse(candidate);
  const now = parse(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
}
