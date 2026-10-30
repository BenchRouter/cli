import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const execute = promisify(execFile);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const scim = '/api/2.0/preview/scim/v2';
export const rules = '/api/2.0/preview/accounts/access-control/rule-sets';
export const uc = '/api/2.1/unity-catalog';
export const encode = encodeURIComponent;
export const ucPaths = { catalog: 'catalogs', schema: 'schemas', table: 'tables', volume: 'volumes', model_provider_service: 'model-provider-services' };
export class DatabricksError extends Error {
  constructor(message, code = 'databricks_request_failed', status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function workspaceHost(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Pass --host as an HTTPS Databricks workspace URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
      || !['.cloud.databricks.com', '.gcp.databricks.com', '.azuredatabricks.net'].some((suffix) => url.hostname.endsWith(suffix))) {
    throw new Error('Pass --host as an HTTPS Databricks workspace URL with no port, path, query, or fragment.');
  }
  return url.origin;
}
export function jwtClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return header.alg === 'RS256' && typeof claims.scope === 'string' && Number.isFinite(claims.exp) ? claims : null;
  } catch { return null; }
}
export function isMissing(error) {
  return error instanceof DatabricksError && (error.status === 404 || ['RESOURCE_DOES_NOT_EXIST', 'NOT_FOUND'].includes(error.code));
}

export class DatabricksWorkspace {
  #token;
  #claims;
  constructor(host, rememberSecret) {
    this.host = host;
    this.rememberSecret = rememberSecret;
    // Test-only replay boundary. Never changes workspace_url sent to BenchRouter.
    const override = process.env.BENCHROUTER_DATABRICKS_API_BASE;
    if (override) {
      const url = new URL(override);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('BENCHROUTER_DATABRICKS_API_BASE is only for a loopback HTTP test server.');
      }
      this.base = url.origin;
    } else this.base = host;
  }
  async auth(command, flags = []) {
    try {
      const { stdout } = await execute('databricks', ['auth', command, '--host', this.host, '--output', 'json', ...flags], { timeout: 30000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch {
      // AUTH-012 / DATA-001: child stdout/stderr can contain credentials. Never forward them.
      throw new DatabricksError(`Could not read the Databricks OAuth login. Run databricks auth login --host ${this.host}`, 'databricks_login_required');
    }
  }
  async login(force = false) {
    const description = await this.auth('describe');
    const authType = description.details?.auth_type;
    if (authType === 'pat') {
      throw new DatabricksError(`A Databricks OAuth login is required. PAT logins cannot connect. Run databricks auth login --host ${this.host}`, 'pat_login');
    }
    let answer;
    if (authType === 'databricks-cli') {
      answer = await this.auth('token', force ? ['--force-refresh'] : []);
    } else if (authType === 'oauth-m2m') {
      const sensitive = await this.auth('describe', ['--sensitive']);
      const clientId = sensitive.details?.configuration?.client_id?.value;
      const clientSecret = sensitive.details?.configuration?.client_secret?.value;
      // AUTH-012 / DATA-001: credentials and their HTTP representation stay in memory.
      this.rememberSecret(clientSecret);
      if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
        throw new DatabricksError(`Could not read the Databricks M2M credentials. Run databricks auth login --host ${this.host}`, 'databricks_login_required');
      }
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      this.rememberSecret(basic);
      answer = await this.call('POST', '/oidc/v1/token', new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }), { form: true, basic });
    } else {
      throw new DatabricksError(`This Databricks authentication type cannot connect. Run databricks auth login --host ${this.host}`, 'databricks_auth_unsupported');
    }
    const token = answer.access_token;
    if (typeof token === 'string') this.rememberSecret(token);
    const claims = typeof token === 'string' ? jwtClaims(token) : null;
    if (!claims) {
      throw new DatabricksError(`Databricks did not return an OAuth JWT. Run databricks auth login --host ${this.host}`, 'databricks_login_required');
    }
    this.#token = token;
    this.#claims = claims;
    if (claims.exp * 1000 - Date.now() < 300000) {
      if (!force) return this.login(true);
      throw new DatabricksError(`The OAuth login expires in under five minutes. Run databricks auth login --host ${this.host}`, 'databricks_login_required');
    }
    return claims;
  }
  async freshLogin() {
    if (!this.#token || this.#claims.exp * 1000 - Date.now() < 300000) await this.login(Boolean(this.#token));
    return this.#claims;
  }
  async call(method, path, body, { form = false, anonymous = false, basic } = {}) {
    if (!anonymous && !basic) await this.freshLogin();
    const headers = { accept: 'application/json', 'user-agent': `benchrouter-cli/${version}` };
    if (basic) headers.authorization = `Basic ${basic}`;
    else if (!anonymous) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    let response;
    let result;
    try {
      response = await fetch(`${this.base}${path}`, {
        method, headers, body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(30000)
      });
      const text = await response.text();
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new DatabricksError('Databricks request failed or returned invalid JSON.');
    }
    if (!response.ok) {
      // AUTH-012 / DATA-001: never echo a remote error body, which can reflect a token.
      throw new DatabricksError(`Databricks request failed (${response.status}).`, result.error_code ?? result.error, response.status);
    }
    return result;
  }
  async proof() {
    await this.freshLogin();
    const answer = await this.call('POST', '/oidc/v1/token', new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: this.#token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'iam.current-user:read'
    }), { form: true });
    if (typeof answer.access_token === 'string') this.rememberSecret(answer.access_token);
    const claims = typeof answer.access_token === 'string' ? jwtClaims(answer.access_token) : null;
    if (!claims || claims.scope !== 'iam.current-user:read' || claims.exp * 1000 - Date.now() < 300000) {
      throw new DatabricksError('Databricks did not issue a five-minute identity-only workspace proof.', 'workspace_proof_invalid');
    }
    return answer.access_token;
  }
  async optional(method, path, body) {
    try { return await this.call(method, path, body); } catch (error) { if (isMissing(error)) return null; throw error; }
  }
}
