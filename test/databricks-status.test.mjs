import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { replay, runDatabricksCli as runCli, noSecrets } from './helpers/databricks-replay.mjs';

const fixtureDir = new URL('./fixtures/databricks/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, fixtureDir), 'utf8'));
const states = ['connecting', 'verified', 'agent_silent', 'disconnecting', 'disconnected', 'archived'];
const reads = Object.fromEntries(await Promise.all(states.map(async (s) => [s, await fixture(`binding-${s}.json`)])));
const [me, metadata, run] = await Promise.all(['me.json', 'databricks-config.json', 'p2-run.json'].map(fixture));
const deletedJob = await fixture('job-deleted.json');
const manifest = await readFile(new URL('eval-manifest.yml', fixtureDir), 'utf8');
const host = 'https://fixture.cloud.databricks.com';
const base = '/v1/databricks/bindings';
const bindingPath = `${base}/dbxb_recorded`;
const uc = '/api/2.1/unity-catalog';
const scim = '/api/2.0/preview/scim/v2';
const call = (method, path, body = {}, status = 200, check) => ({ method, path, body, status, check });
const list = (bindings = [reads.verified.binding]) => call('GET', base, { bindings });
const read = (detail = reads.verified) => call('GET', bindingPath, detail);
const jobAcl = () => call('GET', `/api/2.0/permissions/jobs/${reads.verified.binding.agent_job_id}`, { access_control_list: [{ service_principal_name: reads.verified.binding.agent_sp_application_id, all_permissions: [{ permission_level: 'IS_OWNER' }] }] });
const admin = (nonAdmin = false) => call('GET', `${scim}/Me`, nonAdmin ? { ...me, groups: [] } : me);
const missing = (path) => call('GET', path, { error_code: 'RESOURCE_DOES_NOT_EXIST' }, 404);
const checkBody = (value) => (r) => assert.deepEqual(r.body, value);
const key = (step) => ({ kind: step.kind, id: step.id });

function assertFacts(text, value) {
  if (value && typeof value === 'object') for (const v of Object.values(value)) assertFacts(text, v);
  else if (value !== null) assert.ok(text.includes(String(value)), `missing fact: ${value}`);
}
function assertIndented(text, value, indent = '    ') {
  if (value !== null) assert.ok(text.includes(`\n${value.split('\n').map((line) => `${indent}${line}`).join('\n')}\n`));
}
for (const state of states) test(`status ${state}: text and JSON show all binding facts (AUTH-006 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const detail = reads[state];
  const server = await replay(t, [list([detail.binding]), read(detail), list([detail.binding]), read(detail)]);
  const json = await runCli(server, ['status', '--host', host, '--json'], { BR_FIXTURE_AUTH: 'child-error' });
  const human = await runCli(server, ['status', '--host', host], { BR_FIXTURE_AUTH: 'child-error' });
  for (const r of [json, human]) { assert.equal(r.status, 0, r.stderr); noSecrets(r); }
  assert.deepEqual(JSON.parse(json.stdout), { bindings: [detail] });
  assertFacts(human.stdout, detail);
  for (const label of ['Last check-in:', 'Agent SP application id:', 'Catalog/schema:', 'Results group:', 'Setup items', 'Exposures', 'Evals', 'Leftovers']) assert.ok(human.stdout.includes(label));
  for (const id of [detail.binding.agent_job_id, detail.binding.eval_job_id]) assert.ok(human.stdout.includes(`${host}/jobs/${id}`));
  for (const step of detail.cleanup_pending) {
    assertIndented(human.stdout, step.instruction);
    assertIndented(human.stdout, step.command);
  }
  for (const e of detail.evals) for (const grant of e.grant_needed?.grants ?? []) {
    assertIndented(human.stdout, grant.fix, '      ');
    assertIndented(human.stdout, grant.command, '      ');
  }
  server.assertDone();
});

test('status indents every server instruction and command line without changing its text', { timeout: 4900 }, async (t) => {
  const detail = structuredClone(reads.disconnected);
  const step = detail.cleanup_pending[0];
  const grant = detail.evals[0].grant_needed.grants[0];
  for (const [item, fields] of [[step, ['instruction', 'command']], [grant, ['fix', 'command']]]) {
    for (const field of fields) item[field] = `${item[field]}\n  ${item[field]}  `;
  }
  const server = await replay(t, [list([detail.binding]), read(detail)]);
  const result = await runCli(server, ['status'], { BR_FIXTURE_AUTH: 'child-error' });
  assert.equal(result.status, 0, result.stderr);
  for (const field of ['instruction', 'command']) assertIndented(result.stdout, step[field]);
  for (const field of ['fix', 'command']) assertIndented(result.stdout, grant[field], '      ');
  server.assertDone();
});

test('status filters hosts without a workspace login', { timeout: 4900 }, async (t) => {
  const another = { ...reads.verified.binding, id: 'dbxb_other', host: 'other.cloud.databricks.com' };
  const server = await replay(t, [list([another, reads.verified.binding]), read()]);
  const result = await runCli(server, ['status', '--host', host, '--json'], { BR_FIXTURE_AUTH: 'child-error' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.authCalls.map((args) => args.slice(0, 2)), [['auth', 'describe']]);
  assert.deepEqual(JSON.parse(result.stdout), { bindings: [reads.verified] });
  noSecrets(result);
  server.assertDone();
});

test('status clears gone leftovers, keeps refused reads, and never treats absent workspace SP membership as account deletion', { timeout: 4900 }, async (t) => {
  const detail = structuredClone(reads.disconnected);
  detail.cleanup_pending = detail.cleanup_pending.filter((s) => ['job', 'secret_scope', 'agent_service_principal'].includes(s.kind));
  const done = detail.cleanup_pending.filter((s) => s.kind === 'job').map(key);
  const final = { ...detail, cleanup_pending: detail.cleanup_pending.filter((s) => s.kind !== 'job') };
  const server = await replay(t, [list([detail.binding]), read(detail),
    ...done.map((s) => missing('/api/2.2/jobs/get')),
    call('GET', '/api/2.0/secrets/acls/list', { error_code: 'PERMISSION_DENIED' }, 403),
    call('POST', `${bindingPath}/cleanup`, { ok: true, cleanup_pending: final.cleanup_pending }, 200, checkBody({ done })), read(final), jobAcl()]);
  const result = await runCli(server, ['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bindings: [final] });
  noSecrets(result);
  server.assertDone();
});

test('status remains readable to members when cleanup acknowledgement is forbidden', { timeout: 4900 }, async (t) => {
  const detail = { ...reads.disconnected, cleanup_pending: [reads.disconnected.cleanup_pending[2]] };
  const server = await replay(t, [list([detail.binding]), read(detail), missing('/api/2.2/jobs/get'), call('POST', `${bindingPath}/cleanup`, { error: { code: 'forbidden' } }, 403), jobAcl()]);
  const result = await runCli(server, ['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bindings: [detail] });
  server.assertDone();
});

function evalPreflight(content = manifest, nonAdmin = false) {
  const calls = [list(), read(), admin(nonAdmin)];
  if (nonAdmin) return calls;
  return [...calls,
    call('GET', '/api/2.0/workspace/get-status', { object_id: 999, object_type: 'DIRECTORY' }, 200, (r) => assert.equal(r.query.get('path'), '/Shared/eval')),
    call('GET', '/api/2.0/workspace/export', { content: Buffer.from(content).toString('base64') }, 200, (r) => assert.deepEqual([...r.query], [['path', '/Shared/eval/.benchrouter/benchrouter.yml'], ['format', 'AUTO']]))];
}
function evalPlan({ content = manifest, refused, nonAdmin = false } = {}) {
  const b = reads.verified.binding;
  const calls = evalPreflight(content, nonAdmin);
  if (nonAdmin || content !== manifest) return calls;
  calls.push(call('POST', `${bindingPath}/evals`, { eval: reads.verified.evals[0] }, 200, checkBody({ route_key: 'support/triage', eval_folder: '/Shared/eval' })),
    call('PATCH', '/api/2.0/permissions/directories/999', refused === 'folder' ? { error_code: 'PERMISSION_DENIED' } : {}, refused === 'folder' ? 403 : 200,
      checkBody({ access_control_list: [{ service_principal_name: b.agent_sp_application_id, permission_level: 'CAN_READ' }] })));
  if (refused === 'folder') return [...calls, call('GET', '/api/2.0/permissions/directories/999', { access_control_list: [{ user_name: 'folder-owner', all_permissions: [{ permission_level: 'IS_OWNER' }] }] })];
  calls.push(call('GET', `${uc}/tables/main.evals.cases`, { full_name: 'main.evals.cases', owner: 'table-owner' }));
  for (const [kind, name, grant] of [['catalog', 'main', 'USE_CATALOG'], ['schema', 'main.evals', 'USE_SCHEMA'], ['table', 'main.evals.cases', 'SELECT']]) {
    calls.push(call('PATCH', `${uc}/permissions/${kind}/${name}`, refused === kind ? { error_code: 'PERMISSION_DENIED' } : {}, refused === kind ? 403 : 200,
      checkBody({ changes: [{ principal: b.agent_sp_application_id, add: [grant] }] })));
    if (refused === kind) return [...calls, call('GET', `${uc}/catalogs/main`, { owner: 'catalog-owner' }), call('GET', `${uc}/schemas/main.evals`, { owner: 'schema-owner' })];
  }
  return [...calls, call('GET', '/api/2.2/jobs/get', { job_id: Number(b.agent_job_id) }), call('POST', '/api/2.2/jobs/run-now', { run_id: run.run_id }, 200, checkBody({ job_id: Number(b.agent_job_id) }))];
}
for (const json of [false, true]) test(`add-eval PATCH grants preserve ACLs, print secret lines and run agent (${json ? 'JSON' : 'text'}, AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, evalPlan());
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', ...(json ? ['--json'] : [])]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`databricks secrets put-acl support-evals ${reads.verified.binding.agent_sp_application_id} READ`));
  noSecrets(result);
  server.assertDone();
});
for (const code of ['route_eval_in_repo', 'route_eval_hosted', 'route_not_found', 'binding_disconnecting']) test(`add-eval preserves refusal ${code} without a workspace write`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, [...evalPreflight(), call('POST', `${bindingPath}/evals`, { error: { code, message: 'fake-login-token-must-not-leak' } }, 409)]);
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.ok(!server.requests.some((r) => r.method === 'PATCH'));
  noSecrets(result);
  server.assertDone();
});
for (const refused of ['folder', 'catalog', 'schema', 'table']) test(`add-eval ${refused} grant refusal names owners and exits 3`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, evalPlan({ refused }));
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', '--json']);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, refused === 'folder' ? /folder-owner/ : /catalog-owner.*schema-owner.*table-owner/);
  noSecrets(result);
  server.assertDone();
});
const invalidManifests = [
  ['route_not_declared', manifest.replace('support/triage', 'other/route')],
  ['route_not_declared', manifest + manifest.slice(manifest.indexOf('  - route_id:'))],
  ['secret_scope_reserved', manifest.replace('support-evals', 'BeNcHrOuTeR-private')],
  ['secret_scope_reserved', manifest.replace('support-evals', 'BENCHROUTER')],
  ['manifest_invalid', 'routes: ['],
  ['manifest_invalid', manifest.replace('main.evals.cases', 'main.cases')],
  ['manifest_invalid', manifest.replace('JUDGE_API_KEY', 'DATABRICKS_TOKEN')],
  ['manifest_invalid', manifest.replace('[JUDGE_API_KEY]', '[JUDGE_API_KEY, JUDGE_API_KEY]')],
  ['manifest_invalid', manifest.replace('support-evals', 'null')],
  ['manifest_invalid', manifest.replace('repository_executable', 'other')],
  ['manifest_invalid', manifest.replace('openai_chat_completions', 'other')]
];
for (const [index, [code, content]] of invalidManifests.entries()) test(`add-eval runner manifest refusal ${index}: ${code} (AUTH-012)`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, evalPlan({ content }));
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', '--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.ok(!server.requests.some((r) => r.path.startsWith('/v1/') && r.method === 'POST'));
  noSecrets(result);
  server.assertDone();
});

function cleanupRead(s, present = true) {
  const paths = { job: '/api/2.2/jobs/get', secret_scope: '/api/2.0/secrets/acls/list', serving_endpoint: `/api/2.0/serving-endpoints/${s.id}`, provider_service: `${uc}/model-provider-services/${s.id}`, volume: `${uc}/volumes/${s.id}` };
  return present ? call('GET', paths[s.kind], { id: s.id }, 200, s.kind === 'job' ? (r) => assert.equal(r.query.get('job_id'), s.id) : s.kind === 'secret_scope' ? (r) => assert.equal(r.query.get('scope'), s.id) : undefined) : missing(paths[s.kind]);
}
function cleanupDelete(s, refused = false) {
  if (s.kind === 'job') return call('POST', '/api/2.2/jobs/delete', {}, 200, checkBody({ job_id: Number(s.id) }));
  if (s.kind === 'secret_scope') return call('POST', '/api/2.0/secrets/scopes/delete', {}, 200, checkBody({ scope: s.id }));
  const paths = { serving_endpoint: `/api/2.0/serving-endpoints/${s.id}`, provider_service: `${uc}/model-provider-services/${s.id}`, volume: `${uc}/volumes/${s.id}` };
  return call('DELETE', paths[s.kind], refused ? { error_code: 'PERMISSION_DENIED', message: 'fake-login-token-must-not-leak' } : {}, refused ? 403 : 200);
}
function disconnectPlan({ force = false, immediate = false, protect = false, casefold = false, absent = false, providerRefused = false, providerPending = false, failed = false, resultsOwner = false } = {}) {
  const queued = !force && !immediate;
  const initial = structuredClone(reads.verified);
  const final = structuredClone(reads[queued ? 'archived' : 'disconnected']);
  const b = initial.binding;
  const answer = { ok: true, state: queued ? 'verified' : 'disconnected', disconnect_requested_at: '2026-10-30T10:00:00.000Z', cleanup: queued ? 'queued' : 'none', closed_exposures: queued ? [] : initial.exposures.map(({ endpoint_name, provider_service_name }) => ({ endpoint_name, provider_service_name })) };
  const calls = [list(), read(initial), admin(), call('POST', `${bindingPath}/disconnect`, answer, 200, checkBody({ ...(force ? { force: true } : {}), ...(resultsOwner ? { results_owner: { type: 'group', name: 'results-owners' } } : {}) }))];
  if (queued) {
    calls.push(call('GET', '/api/2.2/jobs/get', { job_id: Number(b.agent_job_id) }), call('POST', '/api/2.2/jobs/run-now', { run_id: run.run_id }, 200, checkBody({ job_id: Number(b.agent_job_id) })));
    const pending = { ...reads.disconnecting, disconnect_failure: failed ? reads.disconnecting.disconnect_failure : null };
    calls.push(read(pending));
    if (failed) return { calls };
  }
  calls.push(read(final));
  const other = { ...reads.verified, binding: { ...b, id: 'dbxb_newer', agent_job_id: '77', eval_job_id: '55', secret_scope: 'new-scope' }, exposures: [] };
  if (casefold) { other.binding.catalog = 'WORKSPACE'; other.binding.schema = 'BR_DESIGN'; other.binding.secret_scope = b.secret_scope.toUpperCase(); }
  const held = new Set(protect ? ['job:55', 'volume:workspace.br_design.benchrouter_artifacts', 'volume:workspace.br_design.benchrouter_results'] : []);
  if (casefold) held.add(`secret_scope:${b.secret_scope}`);
  const done = [];
  const remaining = [];
  const steps = final.cleanup_pending.filter((s) => s.kind !== 'agent_service_principal');
  calls.push(list(protect ? [other.binding, final.binding] : [final.binding]));
  if (protect) calls.push(call('GET', `${base}/dbxb_newer`, other));
  for (const s of steps) {
    if (held.has(`${s.kind}:${s.id}`)) { remaining.push(s); continue; }
    calls.push(cleanupRead(s, !absent));
    if (!absent) {
      calls.push(cleanupDelete(s, providerRefused && s.kind === 'provider_service'));
      if (!(providerRefused && s.kind === 'provider_service')) calls.push(cleanupRead(s, providerPending && s.kind === 'provider_service'));
    }
    if ((providerRefused || providerPending) && s.kind === 'provider_service' && !absent) remaining.push(s);
    else done.push(key(s));
  }
  const after = { ...final, cleanup_pending: [...remaining, final.cleanup_pending.find((s) => s.kind === 'agent_service_principal')] };
  calls.push(call('POST', `${bindingPath}/cleanup`, { ok: true, cleanup_pending: after.cleanup_pending }, 200, checkBody({ done })), read(after));
  return { calls, after, done };
}

test('disconnect acknowledges both jobs removed by the agent after the live 400 response and continues cleanup', { timeout: 4900 }, async (t) => {
  const p = disconnectPlan();
  const at = p.calls.findIndex((c) => c.path === base && c.body.bindings[0]?.state === 'archived');
  for (let i = p.calls.length - 1; i > at; i--) {
    if (p.calls[i].path === '/api/2.2/jobs/get' && p.calls[i].status === 200) {
      p.calls.splice(i, 3, call('GET', '/api/2.2/jobs/get', deletedJob, 400, p.calls[i].check));
    }
  }
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['disconnect', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.deepEqual(answer.absent, p.done.filter((s) => s.kind === 'job'));
  assert.deepEqual(answer.cleanup_pending, p.after.cleanup_pending);
  assert.ok(!server.requests.some((r) => r.path === '/api/2.2/jobs/delete'));
  assert.ok(server.requests.some((r) => r.path === '/api/2.0/secrets/scopes/delete'));
  server.assertDone();
});

test('disconnect acknowledges a job deleted between its read and cleanup delete', { timeout: 4900 }, async (t) => {
  const p = disconnectPlan({ force: true });
  const at = p.calls.findIndex((c) => c.path === '/api/2.2/jobs/delete');
  const job = p.calls[at - 1];
  p.calls.splice(at, 2, call('POST', '/api/2.2/jobs/delete', deletedJob, 400, p.calls[at].check));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['disconnect', '--force', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).absent, [{ kind: 'job', id: job.body.id }]);
  assert.deepEqual(JSON.parse(result.stdout).cleanup_pending, p.after.cleanup_pending);
  server.assertDone();
});

for (const [path, method, body] of [
  ['/api/2.2/jobs/get', 'GET', { ...deletedJob, error_code: 'BAD_REQUEST' }],
  ['/api/2.2/jobs/delete', 'POST', { ...deletedJob, error_code: 'BAD_REQUEST' }],
  ['/api/2.0/secrets/acls/list', 'GET', deletedJob],
  ['/api/2.0/secrets/scopes/delete', 'POST', deletedJob]
]) test(`disconnect keeps other 400 errors fatal: ${method} ${path}`, { timeout: 4900 }, async (t) => {
  const p = disconnectPlan({ force: true });
  const at = p.calls.findIndex((c) => c.path === path && c.method === method);
  p.calls.splice(at, p.calls.length, call(method, path, body, 400));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['disconnect', '--force', '--json']);
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stderr).error.message.includes(`${method} ${path} answered 400 ${body.error_code}.`));
  server.assertDone();
});

for (const [name, options] of [
  ['default waits for archive before deleting recorded objects', {}],
  ['default never deletes an id held by a newer open binding (AUTH-012)', { protect: true }],
  ['default protects scope and UC ids with different casing (AUTH-012)', { protect: true, casefold: true }],
  ['force keeps asynchronous deletion pending until a read confirms absence', { force: true, providerPending: true }],
  ['force deletes every workspace-admin cleanup step and status keeps only the agent SP', { force: true }],
  ['force acknowledges missing objects without DELETE', { force: true, absent: true }],
  ['force keeps unmanageable provider service with its server instruction', { force: true, providerRefused: true }],
  ['results-owner sends the exact typed group body', { resultsOwner: true }]
]) test(`disconnect ${name}`, { timeout: 4900 }, async (t) => {
  const p = disconnectPlan(options);
  const server = await replay(t, [...p.calls, ...(options.force && !options.absent && !options.providerRefused && !options.providerPending ? [list([p.after.binding]), read(p.after), jobAcl()] : [])]);
  const result = await runCli(server, ['disconnect', ...(options.force ? ['--force'] : []), ...(options.resultsOwner ? ['--results-owner', 'results-owners'] : []), '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).cleanup_pending, p.after.cleanup_pending);
  noSecrets(result);
  assert.equal(server.requests.filter((r) => r.path === base).length, 2, 'one selection list and one inventory list');
  if (options.protect) assert.equal(server.requests.filter((r) => r.path === `${base}/dbxb_newer`).length, 1);
  if (!options.force) {
    const polls = server.requests.filter((r) => r.path === bindingPath);
    assert.ok(polls[2].received_at - polls[1].received_at >= 1950, 'binding polls wait two seconds');
  }
  if (options.protect) {
    const deletes = server.requests.filter((r) => r.method === 'DELETE' || r.path.endsWith('/delete'));
    assert.ok(!deletes.some((r) => r.body?.job_id === 55 || r.path.includes('/volumes/')));
    assert.equal(JSON.parse(result.stdout).skipped.length, options.casefold ? 4 : 3);
  }
  if (options.force && !options.absent && !options.providerRefused && !options.providerPending) {
    const status = await runCli(server, ['status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).bindings[0].cleanup_pending.map((s) => s.kind), ['agent_service_principal']);
    noSecrets(status);
  }
  assert.ok(!server.requests.some((r) => r.method === 'DELETE' && r.path.includes('/ServicePrincipals')));
  server.assertDone();
});

test('disconnect agent failure stops before admin cleanup', { timeout: 4900 }, async (t) => {
  const server = await replay(t, disconnectPlan({ failed: true }).calls);
  const result = await runCli(server, ['disconnect', '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent could not disconnect/);
  noSecrets(result);
  server.assertDone();
});

test('force does not clean inherited leftovers from a different binding and skips a job already gone', { timeout: 4900 }, async (t) => {
  const final = structuredClone(reads.disconnected);
  final.cleanup_pending = [final.cleanup_pending[2], { ...final.cleanup_pending[4], binding_id: 'dbxb_older' }, final.cleanup_pending.at(-1)];
  const after = { ...final, cleanup_pending: final.cleanup_pending.slice(1) };
  const server = await replay(t, [list(), read(), admin(), call('POST', `${bindingPath}/disconnect`, { ok: true, state: 'disconnected', disconnect_requested_at: '2026-10-30T10:00:00.000Z', cleanup: 'none', closed_exposures: [] }), read(final), list([final.binding]), cleanupRead(final.cleanup_pending[0], false), call('POST', `${bindingPath}/cleanup`, { ok: true, cleanup_pending: after.cleanup_pending }, 200, checkBody({ done: [key(final.cleanup_pending[0])] })), read(after)]);
  const result = await runCli(server, ['disconnect', '--force', '--json']);
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  server.assertDone();
});

function proofToken(marker) {
  return `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ scope: 'iam.current-user:read', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.${marker}`;
}
test('reclaim mints a fresh narrow proof each time without reading the holding account binding (AUTH-012 / DATA-001)', { timeout: 4900 }, async (t) => {
  const exposure = reads.verified.exposures[0];
  const calls = [];
  for (let i = 0; i < 2; i++) {
    const proof = proofToken(`proof-signature-${i}`);
    calls.push(admin(), call('GET', '/.well-known/databricks-config', metadata), call('POST', '/oidc/v1/token', { access_token: proof }, 200, (r) => {
      assert.equal(r.form.get('scope'), 'iam.current-user:read');
      assert.equal(r.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
      assert.ok(r.form.get('subject_token').includes('fake-login-token-must-not-leak'));
    }), call('POST', `${base}/reclaim`, { ok: true, closed_binding_id: 'dbxb_other_account', closed_exposures: [{ endpoint_name: exposure.endpoint_name, provider_service_name: exposure.provider_service_name }] }, 200,
      checkBody({ workspace_url: host, workspace_id: metadata.workspace_id, workspace_proof: proof })));
    for (const s of reads.disconnected.cleanup_pending.slice(0, 2)) calls.push(cleanupRead(s), cleanupDelete(s), cleanupRead(s, false));
  }
  const server = await replay(t, calls);
  for (let i = 0; i < 2; i++) {
    const result = await runCli(server, ['disconnect', '--reclaim', '--host', host, '--json']);
    assert.equal(result.status, 0, result.stderr);
    noSecrets(result);
  }
  const sent = server.requests.filter((r) => r.path.endsWith('/reclaim')).map((r) => r.body.workspace_proof);
  assert.notEqual(sent[0], sent[1]);
  server.assertDone();
});
for (const command of ['add-eval', 'disconnect']) for (const [auth, status] of [['pat', 5], ['child-error', 1]]) test(`${command} ${auth} login credentials never leak (AUTH-006 / AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const prefix = [list(), read()];
  const server = await replay(t, prefix);
  const result = await runCli(server, [command, ...(command === 'add-eval' ? ['support/triage', '/Shared/eval'] : []), '--json'], { BR_FIXTURE_AUTH: auth });
  assert.equal(result.status, status, result.stderr);
  noSecrets(result);
  server.assertDone();
});

test('workspace-admin refusal exits 4 before a Databricks write', { timeout: 4900 }, async (t) => {
  const server = await replay(t, evalPlan({ nonAdmin: true }));
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', '--json']);
  assert.equal(result.status, 4, result.stderr);
  assert.ok(!server.requests.some((r) => r.path.startsWith('/v1/') && r.method === 'POST'));
  noSecrets(result);
  server.assertDone();
});
for (const command of ['status', 'add-eval', 'disconnect']) test(`${command} help documents JSON and exit codes without a login`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, []);
  const result = await runCli(server, [command, '--help']);
  assert.equal(result.status, 0, result.stderr);
  for (const s of ['--json', 'Exit codes:', '3 ', '4 ', '5 ']) assert.ok(result.stdout.includes(s));
  server.assertDone();
});

const clientId = '00000000-0000-4000-8000-000000000099';
function m2mToken() {
  return `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ scope: 'all-apis', exp: Math.floor(Date.now() / 1000) + 3500, sub: clientId })).toString('base64url')}.fake-login-token-must-not-leak-m2m`;
}
function m2mCall(token) {
  return call('POST', '/oidc/v1/token', { access_token: token }, 200, (r) => {
    assert.deepEqual([...r.form], [['grant_type', 'client_credentials'], ['scope', 'all-apis']]);
  });
}
for (const command of ['add-eval', 'disconnect']) test(`${command} completes with M2M without sending its credentials to BenchRouter (AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const p = command === 'add-eval' ? { calls: evalPlan() } : disconnectPlan({ force: true });
  const token = m2mToken();
  const at = p.calls.findIndex((c) => c.path === `${scim}/Me`);
  p.calls.splice(at, 0, m2mCall(token));
  p.calls[at + 1].body = { ...me, applicationId: clientId };
  const server = await replay(t, p.calls);
  const result = await runCli(server, [command, ...(command === 'add-eval' ? ['support/triage', '/Shared/eval'] : ['--force']), '--json'], { BR_FIXTURE_AUTH: 'm2m' });
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  assert.ok(!(result.stdout + result.stderr).includes(token));
  for (const r of server.requests.filter((r) => r.path.startsWith('/v1/'))) assert.ok(!r.raw.includes(token));
  assert.ok(!result.authCalls.some((args) => args[1] === 'token'));
  server.assertDone();
});

test('status M2M login clears a missing object with no credential disclosure (AUTH-012 / DATA-001)', { timeout: 4900 }, async (t) => {
  const detail = { ...reads.disconnected, cleanup_pending: [reads.disconnected.cleanup_pending[2]] };
  const after = { ...detail, cleanup_pending: [] };
  const token = m2mToken();
  const server = await replay(t, [list([detail.binding]), read(detail), m2mCall(token), missing('/api/2.2/jobs/get'), call('POST', `${bindingPath}/cleanup`, { ok: true, cleanup_pending: [] }), read(after), jobAcl()]);
  const result = await runCli(server, ['status', '--json'], { BR_FIXTURE_AUTH: 'm2m' });
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  assert.ok(!JSON.stringify(result).includes(token));
  server.assertDone();
});

test('reclaim refuses a replayed proof without echoing a reflected credential (AUTH-012 / DATA-001)', { timeout: 4900 }, async (t) => {
  const proof = proofToken('proof-signature-reflected');
  const server = await replay(t, [admin(), call('GET', '/.well-known/databricks-config', metadata), call('POST', '/oidc/v1/token', { access_token: proof }), call('POST', `${base}/reclaim`, { error: { code: 'workspace_proof_replayed', message: proof } }, 403)]);
  const result = await runCli(server, ['disconnect', '--reclaim', '--host', host, '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'workspace_proof_replayed');
  noSecrets(result);
  server.assertDone();
});

for (const auth of ['pat', 'unsupported']) test(`status ${auth} login does not prevent showing leftovers`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, [list([reads.disconnected.binding]), read(reads.disconnected)]);
  const result = await runCli(server, ['status', '--json'], { BR_FIXTURE_AUTH: auth });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bindings: [reads.disconnected] });
  noSecrets(result);
  server.assertDone();
});

test('add-eval in the binding schema needs SELECT without new namespace grants, and accepts --json before positionals', { timeout: 4900 }, async (t) => {
  const content = manifest.replace('main.evals.cases', 'workspace.br_design.cases');
  const calls = evalPlan();
  const exp = calls.find((c) => c.path === '/api/2.0/workspace/export');
  exp.body.content = Buffer.from(content).toString('base64');
  const at = calls.findIndex((c) => c.path === `${uc}/tables/main.evals.cases`);
  calls[at].path = `${uc}/tables/workspace.br_design.cases`;
  calls.splice(at + 1, 3, call('PATCH', `${uc}/permissions/table/workspace.br_design.cases`, {}, 200,
    checkBody({ changes: [{ principal: reads.verified.binding.agent_sp_application_id, add: ['SELECT'] }] })));
  const server = await replay(t, calls);
  const result = await runCli(server, ['add-eval', '--json', 'support/triage', '/Shared/eval']);
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  server.assertDone();
});

for (const force of [false, true]) test(`disconnect cleanup none skips agent startup (${force ? 'forced' : 'immediate close'})`, { timeout: 4900 }, async (t) => {
  const p = disconnectPlan({ force, immediate: true });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['disconnect', ...(force ? ['--force'] : []), '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cleanup, 'none');
  assert.equal(server.requests[4].path, bindingPath, 'read the binding immediately after Disconnect, without an agent job lookup');
  assert.ok(!server.requests.some((r) => r.path.endsWith('/run-now')), 'revoked poll keys must not be used by a new agent run');
  noSecrets(result);
  server.assertDone();
});

test('remote Databricks error codes cannot reflect a credential into JSON errors (AUTH-012 / DATA-001)', { timeout: 4900 }, async (t) => {
  const p = evalPlan();
  let token;
  p.splice(3, p.length, call('GET', '/api/2.0/workspace/get-status', () => ({ error_code: token, message: token }), 500,
    (r) => { token = r.headers.authorization.slice('Bearer '.length); }));
  const server = await replay(t, p);
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval', '--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'databricks_request_failed');
  assert.equal(JSON.parse(result.stderr).error.message, 'Databricks request failed: GET /api/2.0/workspace/get-status answered 500. [redacted]');
  noSecrets(result);
  server.assertDone();
});

for (const count of [0, 2]) test(`status JSON has the same bindings envelope for ${count} matches`, { timeout: 4900 }, async (t) => {
  const details = count ? [reads.verified, { ...reads.connecting, binding: { ...reads.connecting.binding, id: 'dbxb_other', host: 'other.cloud.databricks.com' } }] : [];
  const server = await replay(t, [list(details.map((d) => d.binding)), ...details.map((d) => call('GET', `${base}/${d.binding.id}`, d))]);
  const result = await runCli(server, ['status', '--json'], { BR_FIXTURE_AUTH: 'child-error' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { bindings: details });
  server.assertDone();
});

test('status shows pending and failed setup items with failure title, message and owner', { timeout: 4900 }, async (t) => {
  const setup = await fixture('binding-read.json');
  const detail = structuredClone(reads.connecting);
  detail.setup_items = structuredClone(setup.setup_items);
  detail.setup_items[0].state = 'pending';
  Object.assign(detail.setup_items[2], { state: 'failed', failure: setup.failure });
  const calls = [list([detail.binding]), read(detail)];
  const server = await replay(t, [...calls, ...calls]);
  const human = await runCli(server, ['status'], { BR_FIXTURE_AUTH: 'child-error' });
  const json = await runCli(server, ['status', '--json'], { BR_FIXTURE_AUTH: 'child-error' });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(json.status, 0, json.stderr);
  assertFacts(human.stdout, detail);
  assert.ok(human.stdout.includes(`Owner: ${setup.failure.owner}`));
  assert.deepEqual(JSON.parse(json.stdout), { bindings: [detail] });
  server.assertDone();
});

test('status validates setup_items with the shared contract parser before workspace calls', { timeout: 4900 }, async (t) => {
  const detail = { ...reads.verified, setup_items: [{ ...reads.verified.setup_items[0], state: 'failed', failure: null }] };
  const server = await replay(t, [list(), read(detail)]);
  const result = await runCli(server, ['status', '--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid Databricks setup_items/);
  assert.deepEqual(result.authCalls, []);
  server.assertDone();
});

for (const json of [false, true]) test(`status warns about a user-owned agent job without altering server reads (${json ? 'JSON' : 'text'})`, { timeout: 4900 }, async (t) => {
  const acl = jobAcl();
  acl.body.access_control_list = [{ user_name: 'fixture-admin@example.com', all_permissions: [{ permission_level: 'IS_OWNER' }] }];
  const server = await replay(t, [list(), read(), acl]);
  const result = await runCli(server, ['status', ...(json ? ['--json'] : [])]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /fixture-admin@example.com.*restrict_workspace_admins.*job stops when that user is removed/);
  assert.ok(result.stderr.includes(`${host}/jobs/${reads.verified.binding.agent_job_id}`));
  if (json) assert.deepEqual(JSON.parse(result.stdout), { bindings: [reads.verified] });
  else assertFacts(result.stdout, reads.verified);
  server.assertDone();
});

for (const permission of ['sp-owner', 'denied', 'missing']) test(`status job ACL ${permission} does not warn or prevent the read`, { timeout: 4900 }, async (t) => {
  const acl = permission === 'sp-owner' ? jobAcl() : call('GET', jobAcl().path, { error_code: permission === 'denied' ? 'PERMISSION_DENIED' : 'RESOURCE_DOES_NOT_EXIST' }, permission === 'denied' ? 403 : 404);
  const server = await replay(t, [list(), read(), acl]);
  const result = await runCli(server, ['status', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { bindings: [reads.verified] });
  server.assertDone();
});

for (const state of ['archived', 'disconnected']) for (const force of [false, true]) test(`disconnect resumes ${state} cleanup without a disconnect request or run-now (${force ? 'force JSON' : 'text'})`, { timeout: 4900 }, async (t) => {
  const detail = reads[state];
  const steps = [2, 3, 4, 5, 6, 0, 1].map((i) => detail.cleanup_pending[i]);
  const after = { ...detail, cleanup_pending: detail.cleanup_pending.filter((s) => s.kind === 'agent_service_principal') };
  const done = steps.map(key);
  const server = await replay(t, [list([detail.binding]), read(detail), admin(), list([detail.binding]),
    ...steps.flatMap((s) => [cleanupRead(s), cleanupDelete(s), cleanupRead(s, false)]),
    call('POST', `${bindingPath}/cleanup`, { ok: true, cleanup_pending: after.cleanup_pending }, 200, checkBody({ done })), read(after)]);
  const result = await runCli(server, ['disconnect', ...(force ? ['--force', '--json'] : [])]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!server.requests.some((r) => r.path.endsWith('/disconnect') || r.path.endsWith('/run-now')));
  if (force) {
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.disconnect_sent, false);
    for (const invented of ['ok', 'cleanup', 'closed_exposures']) assert.ok(!Object.hasOwn(answer, invented));
    assert.deepEqual(answer.deleted, done);
    assert.deepEqual(answer.cleanup_pending, after.cleanup_pending);
  } else {
    assert.ok(result.stdout.includes(`Binding is already ${state}. No disconnect was sent.`));
    for (const s of steps) assert.ok(result.stdout.includes(`${s.kind}: ${s.id}`));
    assert.ok(result.stdout.includes(after.cleanup_pending[0].instruction));
  }
  server.assertDone();
});

test('disconnect text reports deleted, absent, skipped and remaining objects with exact server instructions', { timeout: 4900 }, async (t) => {
  const p = disconnectPlan({ force: true, protect: true, providerRefused: true });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['disconnect', '--force']);
  assert.equal(result.status, 0, result.stderr);
  for (const text of ['Disconnect sent.', 'Deleted:', 'Already absent:', 'Skipped (held by an open binding):', 'Left in Databricks:']) assert.ok(result.stdout.includes(text));
  for (const s of p.after.cleanup_pending) {
    assertIndented(result.stdout, s.instruction);
    assertIndented(result.stdout, s.command);
  }
  server.assertDone();
});

test('add-eval reports an absent agent job without claiming it was started', { timeout: 4900 }, async (t) => {
  const calls = evalPlan();
  calls.splice(-2, 2, missing('/api/2.2/jobs/get'));
  const server = await replay(t, calls);
  const result = await runCli(server, ['add-eval', 'support/triage', '/Shared/eval']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('Eval registered. Folder and cases-table grants applied.'));
  assert.ok(result.stdout.includes('No agent job was started.'));
  server.assertDone();
});
