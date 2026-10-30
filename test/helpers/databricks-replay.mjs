import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const fixtureDir = new URL('../fixtures/databricks/', import.meta.url);
const loginMarker = 'fake-login-token-must-not-leak';
const clientSecret = 'fixture-m2m-client-secret-must-not-leak';
const basic = Buffer.from(`00000000-0000-4000-8000-000000000099:${clientSecret}`).toString('base64');
const { poll_key: pollMarker } = JSON.parse(await readFile(new URL('connect.json', fixtureDir), 'utf8'));
export async function replay(t, calls, checkRequest) {
  const requests = [];
  const errors = [];
  const queue = [...calls];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://127.0.0.1');
    const request = { received_at: performance.now(), method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, raw, body: raw && req.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : null, form: new URLSearchParams(raw) };
    requests.push(request);
    const expected = queue.shift();
    try {
      assert.equal(`${req.method} ${url.pathname}`, `${expected?.method} ${expected?.path}`);
      if (url.pathname.startsWith('/v1/')) {
        assert.equal(req.headers.authorization, 'Bearer br_ctrl_recorded_fixture');
        for (const secret of [loginMarker, clientSecret, basic]) assert.ok(!JSON.stringify(request).includes(secret), 'AUTH-012 / DATA-001: no login credential reaches BenchRouter');
      } else {
        assert.equal(req.headers['user-agent'], 'codex-research/1.0 contact@example.com');
        if (url.pathname === '/.well-known/databricks-config') assert.equal(req.headers.authorization, undefined);
        else if (url.pathname === '/oidc/v1/token' && request.form.get('grant_type') === 'client_credentials') assert.equal(req.headers.authorization, `Basic ${basic}`);
        else assert.ok(req.headers.authorization?.includes(loginMarker));
      }
      checkRequest?.(request);
      expected.check?.(request);
      if (expected.headers?.date === null) res.sendDate = false;
      const headers = Object.fromEntries(Object.entries(expected.headers ?? {}).filter(([, value]) => value !== null));
      res.writeHead(expected.status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(typeof expected.body === 'function' ? expected.body() : expected.body));
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error_code: 'FIXTURE_MISMATCH' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, assertDone() { assert.deepEqual(errors, []); assert.equal(queue.length, 0, `Uncalled: ${queue.map((x) => `${x.method} ${x.path}`).join(', ')}`); } };
}
export async function runDatabricksCli(server, args = [], env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'databricks-replay-'));
  const authLog = join(dir, 'auth-calls.jsonl');
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/benchrouter.mjs', import.meta.url)), 'databricks', ...args, '--account-token', 'br_ctrl_recorded_fixture', '--api-url', server.url], { env: { ...process.env, BR_FIXTURE_AUTH: '', DATABRICKS_ACCOUNT_ID: '', PATH: `${fileURLToPath(new URL('bin/', fixtureDir))}:${process.env.PATH}`, BENCHROUTER_DATABRICKS_API_BASE: server.url, ...env, BR_FIXTURE_AUTH_LOG: authLog }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI exceeded 4 s')); }, 4000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('error', reject);
      child.on('close', (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
    });
    noSecrets(result);
    return { ...result, authCalls: (await readFile(authLog, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export function noSecrets(result) {
  for (const secret of [loginMarker, clientSecret, basic, pollMarker, 'proof-signature']) assert.ok(!(result.stdout + result.stderr).includes(secret));
}
