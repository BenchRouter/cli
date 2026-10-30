import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseDatabricksConnectResponse, parseDatabricksSetupItems } from '../src/databricks-contract.mjs';
import { replay as sharedReplay, runDatabricksCli, noSecrets } from './helpers/databricks-replay.mjs';

const fixtureDir = new URL('./fixtures/databricks/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, fixtureDir), 'utf8'));
const [me, sp, sp2, ruleset, run, settings, responseTemplate, metadata] = await Promise.all(['me.json', 'p1-create.json', 'p5-sp3.json', 'p1-ruleset-put.json', 'p2-run.json', 'settings.json', 'connect.json', 'databricks-config.json'].map(fixture));
const setupTemplate = await fixture('binding-read.json');
const deletedJob = await fixture('job-deleted.json');
const manifest = await readFile(new URL('eval-manifest.yml', fixtureDir), 'utf8');
const host = 'https://fixture.cloud.databricks.com';
const account = '00000000-0000-4000-8000-000000000001';
const scim = '/api/2.0/preview/scim/v2';
const rulePath = '/api/2.0/preview/accounts/access-control/rule-sets';
const uc = '/api/2.1/unity-catalog';
const loginMarker = 'fake-login-token-must-not-leak';
const clientId = '00000000-0000-4000-8000-000000000099';
const clientSecret = 'fixture-m2m-client-secret-must-not-leak';
const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const pollMarker = responseTemplate.poll_key;
const principal = (name = sp.applicationId) => ({ type: 'service_principal', name });
const scopeFor = (id) => `benchrouter-${createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0,12)}`;
const step = (action, securable, full_name, privileges, only_if = 'always', name = sp.applicationId) => ({ action, securable, full_name, principal: principal(name), ...(privileges ? { privileges } : {}), only_if });
const jwt = (scope, { seconds = 3500, marker = 'proof-signature', sub = 'admin@example.com', aud = ['7474660687257254'] } = {}) => `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ scope, exp: Math.floor(Date.now()/1000)+seconds, iat: Math.floor(Date.now()/1000), aud, sub, client_id: sub === clientId ? clientId : 'databricks-cli', iss: `${host}/oidc` })).toString('base64url')}.${marker}`;
const binding = (agent = sp, job = '127620839936386') => ({ id: 'dbxb_recorded', account_id: 'acct_fixture', host: new URL(host).hostname, workspace_id: '7474660687257254', databricks_account_id: account, agent_sp_application_id: agent.applicationId, agent_job_id: job, eval_job_id: '55', state: 'verified', disconnect_requested_at: null });
const direct = (name, level, inherited = false) => ({ service_principal_name: name, all_permissions: [{ permission_level: level, inherited }] });

function plan(options = {}) {
  const agent = options.newSp ? sp2 : sp;
  const admin = options.m2m ? { service_principal_name: clientId } : { user_name: 'admin@example.com' };
  const member = options.m2m ? `servicePrincipals/${clientId}` : 'users/admin@example.com';
  const existing = options.existing;
  const c = structuredClone(responseTemplate);
  const scope = scopeFor(agent.applicationId);
  c.agent.secret_scope = c.agent.job_parameters.scope = scope;
  c.grants = [step('grant', 'catalog', 'workspace', ['USE_CATALOG'], 'always', agent.applicationId), step('grant', 'schema', 'workspace.br_design', ['USE_SCHEMA', 'CREATE_TABLE', 'CREATE_VOLUME', 'CREATE_SERVICE'], 'always', agent.applicationId)];
  c.heal = [step('set_owner', 'volume', 'workspace.br_design.benchrouter_artifacts', null, 'exists_not_agent_owned', agent.applicationId), step('set_owner', 'volume', 'workspace.br_design.benchrouter_results', null, 'exists_not_agent_owned', agent.applicationId), step('grant', 'table', 'workspace.br_design.benchrouter_eval_results', ['SELECT', 'MODIFY'], 'exists_not_agent_owned', agent.applicationId)];
  if (options.newSp) c.sp_change = { previous_agent_sp_application_id: sp.applicationId, revoke: options.change ?? [] };
  if (options.invalid) c.agent.job_parameters.job_id = 'wrong';
  const calls = [];
  let queuedAt;
  const add = (method, path, body = {}, status = 200, check, headers) => calls.push({ method, path, body, status, check, headers });
  let m2mToken;
  if (options.m2m) {
    for (const stale of options.m2mRefresh ? [true, false] : [false]) {
      m2mToken = jwt('all-apis', { sub: clientId, seconds: stale ? 60 : 3500, marker: `${loginMarker}-m2m-${stale ? 'first' : 'refreshed'}` });
      add('POST', '/oidc/v1/token', { access_token: m2mToken, token_type: 'Bearer', expires_in: stale ? 60 : 3500 }, 200, (r) => {
        assert.equal(r.headers.authorization, `Basic ${basic}`);
        assert.equal(r.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.deepEqual([...r.form], [['grant_type', 'client_credentials'], ['scope', 'all-apis']]);
      });
    }
  }
  const config = options.metadata ?? metadata;
  add('GET', '/.well-known/databricks-config', config);
  if (options.badWorkspace || options.missingAccount) return { calls, c };
  add('GET', `${scim}/Me`, options.nonAdmin ? { ...me, groups: [] } : options.m2m ? { ...me, applicationId: clientId } : me);
  if (options.nonAdmin) return { calls, c };
  if (!options.warehouseFlag) {
    add('GET', '/api/2.0/sql/warehouses', { warehouses: options.warehouses ?? [{ id: 'f7cf158c6784dd06', name: 'Serverless', enable_serverless_compute: true }] });
    if (options.warehouses) return { calls, c };
  }
  add('GET', '/v1/databricks/bindings', { bindings: existing ? [existing] : [] });
  if (existing?.agent_job_id) add('GET', '/api/2.2/jobs/get', options.jobDeleted ? deletedJob : options.jobMissing ? { error_code: 'RESOURCE_DOES_NOT_EXIST' } : { job_id: Number(existing.agent_job_id), settings: { run_as: { service_principal_name: existing.agent_sp_application_id } } }, options.jobDeleted ? 400 : options.jobMissing ? 404 : 200);
  if (existing) {
    add('GET', `${scim}/ServicePrincipals`, { Resources: options.spMissing ? [] : [sp], totalResults: options.spMissing ? 0 : 1 }, 200, (r) => assert.equal(r.query.get('filter'), `applicationId eq ${JSON.stringify(sp.applicationId)}`));
    if (!options.spMissing) add('GET', rulePath, options.noRole || options.ruleFailure ? { error_code: options.ruleCode ?? 'PERMISSION_DENIED', message: 'Not authorized to perform this operation' } : ruleset, options.noRole || options.ruleFailure ? options.ruleStatus ?? 403 : 200);
    if (options.ruleFailure) return { calls, c };
  }
  if (!existing || options.newSp) {
    add('POST', `${scim}/ServicePrincipals`, agent, 200, (r) => {
      assert.match(r.body.displayName, /^benchrouter-agent-[a-f0-9]{8}$/);
      assert.deepEqual(r.body.entitlements, [{ value: 'workspace-access' }, { value: 'databricks-sql-access' }]);
    });
    add('GET', rulePath, { ...ruleset, grant_rules: ruleset.grant_rules.slice(0, 1) });
    add('PUT', rulePath, ruleset, 200, (r) => {
      const name = `accounts/${account}/servicePrincipals/${agent.applicationId}/ruleSets/default`;
      assert.deepEqual(r.body, { name, rule_set: { name, etag: ruleset.etag, grant_rules: [...ruleset.grant_rules.slice(0, 1), { role: 'roles/servicePrincipal.user', principals: [member] }] } });
    });
  }
  if (!options.noRole || options.newSp) {
    add('PATCH', `${scim}/ServicePrincipals/${agent.id}`, {}, 200, (r) => assert.equal(r.body.Operations[0].path, 'entitlements'));
    const secretsPath = `/api/2.0/accounts/servicePrincipals/${agent.id}/credentials/secrets`;
    add('GET', secretsPath, { secrets: options.secret ? [{ id: 'secret-recorded' }] : [] });
    if (options.secret) add('DELETE', `${secretsPath}/secret-recorded`);
  }
  add('GET', '/api/2.0/settings/types/restrict_workspace_admins/names/default', options.restricted ? { ...settings, restrict_workspace_admins: { status: 'RESTRICT_TOKENS_AND_JOB_RUN_AS' } } : settings);
  add('POST', '/oidc/v1/token', { access_token: jwt('iam.current-user:read', { sub: options.m2m ? clientId : 'admin@example.com' }), scope: 'iam.current-user:read', token_type: 'Bearer', expires_in: 3500 }, 200, (r) => {
    assert.equal(r.form.get('scope'), 'iam.current-user:read');
    assert.ok(r.form.get('subject_token').includes(loginMarker));
    if (options.m2m) assert.equal(r.form.get('subject_token'), m2mToken);
    assert.equal(r.form.get('requested_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
    assert.equal(r.form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
  });
  add('POST', '/v1/databricks/bindings', options.apiError ? { error: { code: options.apiError, message: `${loginMarker} ${pollMarker}` } } : c, options.apiError ? ({ workspace_unreachable: 502, workspace_connected_elsewhere: 409, binding_disconnecting: 409 })[options.apiError] ?? 403 : existing ? 200 : 201, (r) => {
    queuedAt = options.queuedAt ?? new Date().toISOString();
    assert.deepEqual(Object.keys(r.body).sort(), ['agent_sp_application_id', 'catalog', 'databricks_account_id', 'manage_group', 'results_group', 'schema', 'warehouse_id', 'workspace_id', 'workspace_proof', 'workspace_url'].sort());
    assert.equal(r.body.workspace_url, host);
    assert.equal(r.body.workspace_id, metadata.workspace_id);
    assert.equal(r.body.databricks_account_id, account);
    assert.equal(r.body.agent_sp_application_id, agent.applicationId);
    assert.equal(r.body.warehouse_id, 'f7cf158c6784dd06');
    assert.equal(r.body.results_group, 'readers');
    assert.equal(r.body.manage_group, 'managers');
  });
  if (options.apiError || options.invalid) return { calls, c };
  add('POST', '/api/2.0/secrets/scopes/create', existing ? { error_code: 'RESOURCE_ALREADY_EXISTS' } : {}, existing ? 400 : 200);
  add('POST', '/api/2.0/secrets/acls/put', {}, 200, (r) => assert.deepEqual(r.body, { scope, principal: agent.applicationId, permission: 'MANAGE' }));
  add('POST', '/api/2.0/secrets/put', {}, 200, (r) => {
    assert.equal(r.body.scope, scope);
    assert.match(r.body.key, /^poll-key-[a-f0-9]{16}$/);
    assert.equal(r.body.string_value, pollMarker);
  });
  for (const grant of c.grants) {
    add('PATCH', `${uc}/permissions/${grant.securable}/${grant.full_name}`, options.refused ? { error_code: 'PERMISSION_DENIED', message: loginMarker } : {}, options.refused ? 403 : 200, (r) => assert.deepEqual(r.body, { changes: [{ principal: agent.applicationId, add: grant.privileges }] }));
    if (options.refused) {
      add('GET', `${uc}/catalogs/workspace`, { owner: 'catalog-owner' });
      add('GET', `${uc}/schemas/workspace.br_design`, { owner: 'schema-owner' });
      return { calls, c };
    }
  }
  for (const heal of c.heal) {
    const path = `${uc}/${heal.securable === 'volume' ? 'volumes' : 'tables'}/${heal.full_name}`;
    const owner = options.heal ? 'previous-owner' : agent.applicationId;
    add('GET', path, options.absent ? { error_code: 'RESOURCE_DOES_NOT_EXIST' } : { full_name: heal.full_name, owner }, options.absent ? 404 : 200);
    if (options.heal && !options.absent) {
      const refused = options.healRefused && heal.securable === 'table';
      add('PATCH', heal.action === 'set_owner' ? path : `${uc}/permissions/table/${heal.full_name}`, refused ? { error_code: 'PERMISSION_DENIED' } : {}, refused ? 403 : 200, (r) => assert.deepEqual(r.body, heal.action === 'set_owner' ? { owner: agent.applicationId } : { changes: [{ principal: agent.applicationId, add: ['SELECT', 'MODIFY'] }] }));
      if (refused) {
        add('GET', `${uc}/catalogs/workspace`, { owner: 'catalog-owner' });
        add('GET', `${uc}/schemas/workspace.br_design`, { owner: 'schema-owner' });
        return { calls, c };
      }
    }
  }
  if (options.changeCalls) calls.push(...options.changeCalls);
  const hasJob = existing?.agent_job_id && !options.jobMissing && !options.jobDeleted;
  const jobId = hasJob ? existing.agent_job_id : '127620839936386';
  add('POST', `/api/2.2/jobs/${hasJob ? 'reset' : 'create'}`, { job_id: Number(jobId) }, 200, (r) => {
    const s = hasJob ? r.body.new_settings : r.body;
    assert.deepEqual(s.run_as, { service_principal_name: agent.applicationId });
    assert.equal(s.max_concurrent_runs, 1);
    assert.deepEqual(s.tasks[0].python_wheel_task.named_parameters, c.agent.job_parameters);
    assert.deepEqual(s.environments, [{ environment_key: 'agent', spec: c.agent.environment }]);
    assert.equal(s.schedule.quartz_cron_expression, c.agent_schedule.quartz_cron_expression);
  });
  add('PUT', `/api/2.0/permissions/jobs/${jobId}`, {}, 200, (r) => assert.deepEqual(r.body.access_control_list, options.restricted
    ? [{ ...admin, permission_level: 'IS_OWNER' }, { service_principal_name: agent.applicationId, permission_level: 'CAN_MANAGE' }]
    : [{ service_principal_name: agent.applicationId, permission_level: 'IS_OWNER' }]));
  add('POST', '/v1/databricks/bindings/dbxb_recorded/agent', { ok: true }, 200, (r) => assert.deepEqual(r.body, { agent_job_id: jobId, secret_scope: scope }));
  add('POST', '/api/2.2/jobs/run-now', { run_id: run.run_id });
  for (const snapshot of options.setupReads ?? [{}]) {
    add('GET', '/api/2.2/jobs/runs/get', options.runFailed ? { state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED' } } : snapshot.run ?? run);
    add('GET', '/v1/databricks/bindings/dbxb_recorded', () => {
      const items = structuredClone(setupTemplate.setup_items).map((item) => ({ ...item, queued_at: queuedAt }));
      snapshot.items?.(items, queuedAt);
      if (options.setupFailed) Object.assign(items[2], { state: 'failed', failure: setupTemplate.failure });
      return { binding: { ...binding(agent, jobId), ...snapshot.binding }, evals: [], exposures: snapshot.exposures ?? [], setup_items: items, setup_failure: snapshot.setupFailure ?? null };
    });
  }
  return { calls, c };
}

const runCli = (server, args = [], env = {}) => runDatabricksCli(server, ['connect', '--host', host, '--catalog', 'workspace', '--schema', 'br_design', '--results-group', 'readers', '--manage-group', 'managers', ...args], env);
const replay = (t, calls) => sharedReplay(t, calls, (request) => {
  const url = { pathname: request.path, searchParams: request.query };
      if (url.pathname === '/api/2.2/jobs/get') assert.deepEqual([...url.searchParams], [['job_id', '127620839936386']]);
      if (url.pathname === '/api/2.2/jobs/runs/get') assert.deepEqual([...url.searchParams], [['run_id', String(run.run_id)]]);
      if (url.pathname === '/api/2.0/workspace/get-status') assert.deepEqual([...url.searchParams], [['path', '/Shared/eval']]);
      if (url.pathname === rulePath && request.method === 'GET') {
        assert.equal(url.searchParams.get('etag'), '');
        assert.ok([sp, sp2].some((agent) => url.searchParams.get('name') === `accounts/${account}/servicePrincipals/${agent.applicationId}/ruleSets/default`));
      }
});

test('Connect recreates a deleted recorded agent job after the live 400 response', { timeout: 4900 }, async (t) => {
  const p = plan({ existing: binding(sp, '1100628925659126'), jobDeleted: true });
  const server = await sharedReplay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).agent_job_id, '127620839936386');
  assert.equal(server.requests.find((r) => r.path === '/api/2.2/jobs/get').query.get('job_id'), '1100628925659126');
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/create'));
  assert.ok(!server.requests.some((r) => r.path === '/api/2.2/jobs/reset'));
  server.assertDone();
});

for (const id of ['0', '1&job_id=2', '9007199254740992']) test(`Connect rejects invalid recorded job id ${id} before a job request`, { timeout: 4900 }, async (t) => {
  const p = plan({ existing: binding(sp, id) });
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.2/jobs/get'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.message, 'Databricks returned an invalid numeric object id.');
  assert.ok(!server.requests.some((r) => r.path.startsWith('/api/2.2/jobs/')));
  server.assertDone();
});

for (const json of [false, true]) test(`Databricks diagnostics name the call and redact before truncating (${json ? 'JSON' : 'text'}, AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const p = plan({ existing: binding() });
  const at = p.calls.findIndex((c) => c.path === '/api/2.2/jobs/get');
  let token;
  const prefix = 'Reflected login: ' + 'x'.repeat(235);
  p.calls.splice(at, p.calls.length, { method: 'GET', path: '/api/2.2/jobs/get', status: 400,
    check: (r) => { token = r.headers.authorization.slice('Bearer '.length); },
    body: () => ({ error_code: 'BAD_REQUEST', message: prefix + token + 'y'.repeat(400) }) });
  const server = await replay(t, p.calls);
  const result = await runCli(server, json ? ['--json'] : []);
  assert.equal(result.status, 1);
  const message = json ? JSON.parse(result.stderr).error.message : result.stderr.trim();
  assert.equal(message, `Databricks request failed: GET /api/2.2/jobs/get answered 400 BAD_REQUEST. ${(prefix + '[redacted]' + 'y'.repeat(400)).slice(0, 300)}`);
  assert.ok(!message.includes('?job_id='));
  assert.ok(!message.includes(token.slice(0, 40)));
  noSecrets(result);
  server.assertDone();
});

for (const [name, options, expectedStatus] of [
  ['first Connect writes the key before grants and creates a fresh SP (AUTH-006 / AUTH-012 / DATA-001)', { absent: true }, 0],
  ['Reconnect reuses only recorded SP and job ids and deletes OAuth secrets (AUTH-012)', { existing: binding(), secret: true }, 0],
  ['another admin keeps the job after a 403 rule-set refusal without touching SP entitlements or secrets', { existing: binding(), noRole: true, ruleCode: 'OTHER' }, 0],
  ['another admin keeps the job after a 400 PERMISSION_DENIED without touching SP entitlements or secrets', { existing: binding(), noRole: true, ruleStatus: 400 }, 0],
  ['another admin keeps the recorded job after a 401 rule-set refusal', { existing: binding(), noRole: true, ruleStatus: 401, ruleCode: 'OTHER' }, 0],
  ['another admin keeps the recorded job after a 400 UNAUTHORIZED rule-set refusal', { existing: binding(), noRole: true, ruleStatus: 400, ruleCode: 'UNAUTHORIZED' }, 0],
  ['unexpected rule-set errors stop Connect', { existing: binding(), ruleFailure: true, ruleStatus: 500, ruleCode: 'INTERNAL_ERROR' }, 1],
  ['another admin without a surviving job creates a new SP', { existing: binding(), noRole: true, jobMissing: true, newSp: true, heal: true }, 0],
  ['deleted recorded SP causes fresh SP creation and owner heal', { existing: binding(), spMissing: true, newSp: true, heal: true }, 0],
  ['restrict_workspace_admins keeps the connecting admin as owner and grants CAN_MANAGE', { restricted: true }, 0],
  ['refused grant names both owners and has exit code 3', { refused: true }, 3],
  ['refused table heal reports the object owner and keeps the table owner', { heal: true, healRefused: true }, 3],
  ['local workspace_admin_required has exit code 4', { nonAdmin: true }, 4],
  ['server workspace_admin_required has exit code 4 without leaking reflected credentials', { apiError: 'workspace_admin_required' }, 4],
  ['proof replay is refused without continuing workspace writes', { apiError: 'workspace_proof_replayed' }, 1],
  ...['workspace_proof_invalid', 'workspace_unreachable', 'workspace_connected_elsewhere', 'binding_disconnecting'].map((code) => [code, { apiError: code }, 1]),
  ['an invalid contract stops before the scope or key write', { invalid: true }, 1],
  ['explicit warehouse skips warehouse discovery', { warehouseFlag: true }, 0],
  ['several serverless warehouses require an explicit noninteractive choice', { warehouses: [{ id: 'one', name: 'First', enable_serverless_compute: true }, { id: 'two', name: 'Second', enable_serverless_compute: true }] }, 1],
  ['failed agent run does not report a successful Connect', { runFailed: true }, 1],
  ['reported setup failure does not report a successful Connect', { setupFailed: true }, 1]
]) {
  test(name, { timeout: 4900 }, async (t) => {
    const p = plan(options);
    const server = await replay(t, p.calls);
    const result = await runCli(server, ['--json', ...(options.warehouseFlag ? ['--warehouse', 'f7cf158c6784dd06'] : [])]);
    assert.equal(result.status, expectedStatus, result.stderr);
    noSecrets(result);
    server.assertDone();
    if (options.refused) {
      assert.match(result.stderr, /catalog-owner/);
      assert.match(result.stderr, /schema-owner/);
      assert.equal(JSON.parse(result.stderr).error.code, 'grant_refused');
    }
    if (options.healRefused) assert.match(result.stderr, /Object owner: previous-owner/);
    if (options.warehouses) { assert.match(result.stderr, /First/); assert.match(result.stderr, /Second/); }
    if (expectedStatus === 0) {
      const output = JSON.parse(result.stdout);
      assert.equal(output.state, 'verified');
      assert.deepEqual(output.setup_items, setupTemplate.setup_items.map(({ kind, target, state }) => ({ kind, target, state })));
      assert.ok(!Object.hasOwn(output, 'setup_confirmation'));
    }
    else assert.equal(result.stdout, '');
  });
}

test('two Connect runs create one SP and one job; human logs show all eight steps', { timeout: 4900 }, async (t) => {
  const server = await replay(t, [...plan().calls, ...plan({ existing: binding() }).calls]);
  for (let i = 0; i < 2; i++) {
    const result = await runCli(server);
    assert.equal(result.status, 0, result.stderr);
    for (let step = 1; step <= 8; step++) assert.ok(result.stdout.includes(`${step}/8 `));
    for (const item of setupTemplate.setup_items) assert.ok(result.stdout.includes(`${item.kind} ${item.target}: ${item.state}\n`));
    noSecrets(result);
  }
  server.assertDone();
  assert.equal(server.requests.filter((r) => r.method === 'POST' && r.path === `${scim}/ServicePrincipals`).length, 1);
  assert.equal(server.requests.filter((r) => r.path === '/api/2.2/jobs/create').length, 1);
});

test('Connect matches Unity Catalog targets case-insensitively with mixed-case catalog and schema flags', { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan({ setupReads: [{ items: (items) => {
    for (const item of items) {
      if (item.kind === 'volume' || item.kind === 'results_table') item.target = item.target.replace('br_design', 'br_h8');
    }
  } }] }).calls);
  const result = await runCli(server, ['--catalog', 'Workspace', '--schema', 'BR_H8', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, 'verified');
  assert.deepEqual(output.setup_items, setupTemplate.setup_items.map(({ kind, target, state }) => ({ kind, target: target.replace('br_design', 'br_h8'), state })));
  const connect = server.requests.find((r) => r.method === 'POST' && r.path === '/v1/databricks/bindings');
  assert.equal(connect.body.catalog, 'Workspace');
  assert.equal(connect.body.schema, 'BR_H8');
  assert.equal(server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/databricks/bindings/dbxb_recorded').length, 1);
  server.assertDone();
});

test('same-SP same-schema Reconnect succeeds with an older done eval_job row (live H8)', { timeout: 4900 }, async (t) => {
  const setupReads = [{ items: (items, queuedAt) => {
    const evalJob = items.find((item) => item.kind === 'eval_job');
    evalJob.queued_at = new Date(Date.parse(queuedAt) - 86400000).toISOString();
  } }];
  const server = await replay(t, plan({ existing: binding(), setupReads }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'verified');
  assert.deepEqual(JSON.parse(result.stdout).setup_items, [
    { kind: 'volume', target: 'workspace.br_design.benchrouter_artifacts', state: 'done' },
    { kind: 'volume', target: 'workspace.br_design.benchrouter_results', state: 'done' },
    { kind: 'results_table', target: 'workspace.br_design.benchrouter_eval_results', state: 'done' },
    { kind: 'experiment', target: '/Shared/benchrouter/dbxb_recorded', state: 'done' },
    { kind: 'eval_job', target: 'benchrouter-eval-dbxb_recorded', state: 'done' }
  ]);
  assert.equal(server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/databricks/bindings/dbxb_recorded').length, 1);
  noSecrets(result);
  server.assertDone();
});

for (const [name, setupReads, status, reads] of [
  ['all expected rows done succeed without eval_job_id or exposure checks', [{ binding: { eval_job_id: null }, exposures: [{ state: 'exposing', failure: setupTemplate.failure }], setupFailure: setupTemplate.failure }], 0, 1],
  ['a re-queued pending row waits until done', [{ items: (items) => { items[2].state = 'pending'; } }, {}], 0, 2],
  ['done rows still wait for binding verification', [{ binding: { state: 'connecting' } }, {}], 0, 2],
  ['done rows still wait for the started agent run to succeed', [{ run: { ...run, state: { life_cycle_state: 'RUNNING' } } }, {}], 0, 2],
  ['a failed results_table stops with its title, message, and customer owner', [{ items: (items) => { Object.assign(items[2], { state: 'failed', failure: setupTemplate.failure }); } }], 1, 1],
  ['a pending serving_endpoint does not block success', [{ items: (items, queuedAt) => { items.push({ ...setupTemplate.serving_endpoint, queued_at: queuedAt }); } }], 0, 1],
  ['a failed serving_endpoint stops Connect even when core items are done', [{ items: (items, queuedAt) => { items.push({ ...setupTemplate.serving_endpoint, queued_at: queuedAt, state: 'failed', failure: { ...setupTemplate.failure, owner: 'unknown' } }); } }], 1, 1],
  ['an old failed core row stops Connect', [{ items: (items, queuedAt) => { Object.assign(items[2], { queued_at: new Date(Date.parse(queuedAt) - 86400000).toISOString(), state: 'failed', failure: setupTemplate.failure }); } }], 1, 1],
  ['an old failed serving_endpoint stops Connect', [{ items: (items, queuedAt) => { items.push({ ...setupTemplate.serving_endpoint, queued_at: new Date(Date.parse(queuedAt) - 86400000).toISOString(), state: 'failed', failure: { ...setupTemplate.failure, owner: 'unknown' } }); } }], 1, 1],
  ['a binding that closed during Connect fails', [{ binding: { state: 'disconnected' } }], 1, 1],
  ['a binding that requested disconnect during Connect fails', [{ binding: { disconnect_requested_at: setupTemplate.setup_items[0].queued_at } }], 1, 1],
  ['a binding that changed SP during Connect fails', [{ binding: { agent_sp_application_id: sp2.applicationId } }], 1, 1]
]) test(name, { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan({ setupReads }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, status, result.stderr);
  noSecrets(result);
  server.assertDone();
  assert.equal(server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/databricks/bindings/dbxb_recorded').length, reads);
  if (status === 0) {
    const output = JSON.parse(result.stdout);
    assert.ok(!Object.hasOwn(output, 'setup_confirmation'));
    assert.ok(output.setup_items.every((item) => Object.keys(item).sort().join(',') === 'kind,state,target'));
    assert.ok(output.setup_items.filter((item) => item.kind !== 'serving_endpoint').every((item) => item.state === 'done'));
    if (name.startsWith('a pending serving_endpoint')) assert.deepEqual(output.setup_items.at(-1), { kind: 'serving_endpoint', target: setupTemplate.serving_endpoint.target, state: 'pending' });
  } else {
    assert.equal(result.stdout, '');
    if (name.includes('failed')) {
      const message = JSON.parse(result.stderr).error.message;
      assert.ok(message.includes(setupTemplate.failure.title));
      assert.ok(message.includes(setupTemplate.failure.message));
      assert.ok(message.includes(`owner: ${name.includes('serving_endpoint') ? 'unknown' : 'customer'}`));
      assert.equal(message.includes('A workspace admin must fix it.'), !name.includes('serving_endpoint'));
    } else assert.match(result.stderr, /binding changed or closed/);
  }
});

for (const [index, expected] of setupTemplate.setup_items.entries()) {
  test(`missing ${expected.kind} ${expected.target} keeps Connect waiting until it exists and is done`, { timeout: 4900 }, async (t) => {
    const setupReads = [{ items: (items) => { items.splice(index, 1); } }, {}];
    const server = await replay(t, plan({ setupReads }).calls);
    const result = await runCli(server, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/databricks/bindings/dbxb_recorded').length, 2);
    noSecrets(result);
    server.assertDone();
  });

  for (const state of ['missing', 'pending', 'wrong target']) test(`Connect timeout names ${state} ${expected.kind} ${expected.target}`, { timeout: 4900 }, async (t) => {
    const setupReads = [{ items: (items) => {
      if (state === 'missing') items.splice(index, 1);
      else if (state === 'pending') items[index].state = 'pending';
      else items[index].target = `other-${expected.target}`;
    } }];
    const server = await replay(t, plan({ setupReads }).calls);
    const result = await runCli(server, ['--json'], {
      NODE_OPTIONS: `--import=${new URL('./fixtures/databricks/timeout-clock.mjs', import.meta.url).href}`,
      // Node 22 warns that mock timers are experimental. Keep stderr as CLI JSON.
      NODE_NO_WARNINGS: '1'
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const message = JSON.parse(result.stderr).error.message;
    assert.ok(message.includes('Timed out waiting for the agent run'));
    assert.ok(message.includes(`Waiting for missing or incomplete setup items: ${expected.kind} ${expected.target}.`));
    noSecrets(result);
    server.assertDone();
  });
}

test('setup-item failure text redacts credentials in human output', { timeout: 4900 }, async (t) => {
  const p = plan({ m2m: true, setupReads: [{ items: (items) => {
    Object.assign(items[2], { state: 'failed', failure: { ...setupTemplate.failure, message: [...tokens, clientSecret, basic, pollMarker].join(' ') } });
  } }] });
  const tokens = p.calls.filter((call) => call.path === '/oidc/v1/token').map((call) => call.body.access_token);
  const server = await replay(t, p.calls);
  const result = await runCli(server, [], { BR_FIXTURE_AUTH: 'm2m' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(setupTemplate.failure.title));
  assert.match(result.stderr, /owner: customer/);
  assert.match(result.stderr, /\[redacted\]/);
  noSecrets(result);
  server.assertDone();
});

test('setup_items parser accepts the contract and rejects malformed fields', { timeout: 4900 }, () => {
  assert.deepEqual(parseDatabricksSetupItems(setupTemplate.setup_items), setupTemplate.setup_items);
  assert.deepEqual(parseDatabricksSetupItems([]), []);
  const validFailure = { ...setupTemplate.setup_items[2], state: 'failed', failure: setupTemplate.failure };
  assert.deepEqual(parseDatabricksSetupItems([validFailure]), [validFailure]);
  for (const value of [undefined, null, {}, [null], [setupTemplate.setup_items[0], setupTemplate.setup_items[0]],
    ...[{ kind: 'grant_check' }, { target: '' }, { state: 'cancelled' }, { queued_at: 'invalid' }, { queued_at: null }, { failure: undefined }, { failure: setupTemplate.failure }, { state: 'failed', failure: null }].map((fields) => [{ ...setupTemplate.setup_items[0], ...fields }]),
    ...[{ owner: 'admin' }, { code: '' }, { title: null }, { message: undefined }, { failed_at: 'invalid' }, { failed_at: undefined }].map((fields) => [{ ...validFailure, failure: { ...setupTemplate.failure, ...fields } }])
  ]) assert.throws(() => parseDatabricksSetupItems(value), /invalid Databricks setup_items/);
});

for (const [auth, status, code] of [['pat', 5, 'pat_login'], ['unsupported', 1, 'databricks_auth_unsupported'], ['child-error', 1, 'databricks_login_required']]) test(`OAuth login refusal: ${auth} never calls auth token or leaks child output (AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, []);
  const result = await runCli(server, ['--json'], { BR_FIXTURE_AUTH: auth });
  assert.equal(result.status, status);
  assert.match(result.stderr, /databricks auth login/);
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.deepEqual(result.authCalls, [['auth', 'describe', '--host', host, '--output', 'json']]);
  noSecrets(result);
  server.assertDone();
});

test('OAuth login refreshes before proof when fewer than five minutes remain (AUTH-012)', { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan().calls);
  const result = await runCli(server, ['--json'], { BR_FIXTURE_AUTH: 'refresh' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.authCalls.map((args) => args.slice(0, 2)), [['auth', 'describe'], ['auth', 'token'], ['auth', 'describe'], ['auth', 'token']]);
  assert.ok(!result.authCalls[0].includes('--sensitive'));
  assert.ok(result.authCalls.at(-1).includes('--force-refresh'));
  noSecrets(result);
  server.assertDone();
});

for (const json of [false, true]) test(`M2M admin connects and refreshes without leaking its client secret or either access token (${json ? 'JSON' : 'human'}, AUTH-012 / DATA-001)`, { timeout: 4900 }, async (t) => {
  const p = plan({ m2m: true, m2mRefresh: true, restricted: true, secret: true });
  const accessTokens = p.calls.filter((c) => c.path === '/oidc/v1/token' && c.body.access_token.includes(loginMarker)).map((c) => c.body.access_token);
  assert.equal(accessTokens.length, 2);
  assert.notEqual(accessTokens[0], accessTokens[1]);
  const server = await replay(t, p.calls);
  const result = await runCli(server, json ? ['--json'] : [], { BR_FIXTURE_AUTH: 'm2m-refresh' });
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  assert.deepEqual(result.authCalls, Array.from({ length: 2 }, () => [
    ['auth', 'describe', '--host', host, '--output', 'json'],
    ['auth', 'describe', '--host', host, '--output', 'json', '--sensitive']
  ]).flat());
  const tokens = server.requests.filter((r) => r.path === '/oidc/v1/token' && r.form.get('grant_type') === 'client_credentials');
  assert.equal(tokens.length, 2);
  for (const token of accessTokens) assert.ok(!(result.stdout + result.stderr).includes(token));
  for (const request of server.requests.filter((r) => r.path.startsWith('/v1/'))) {
    for (const token of accessTokens) assert.ok(!JSON.stringify(request).includes(token));
  }
  server.assertDone();
});

for (const [name, options, env, status] of [
  ['Connect uses its catalog and schema flags for setup targets rather than the saved binding', { existing: { ...binding(), catalog: 'previous', schema: 'previous' } }, {}, 0],
  ['metadata overrides saved binding and environment account ids on Reconnect', { existing: { ...binding(), databricks_account_id: 'stale-account' } }, { DATABRICKS_ACCOUNT_ID: 'wrong-account' }, 0],
  ['missing metadata account id uses DATABRICKS_ACCOUNT_ID', { metadata: { ...metadata, account_id: undefined } }, { DATABRICKS_ACCOUNT_ID: account }, 0],
  ['missing metadata account id does not reuse a saved binding account id', { existing: binding(), metadata: { ...metadata, account_id: undefined }, missingAccount: true }, {}, 1],
  ['workspace id outside the login token audience refuses before mutations', { metadata: { ...metadata, workspace_id: '123' }, badWorkspace: true }, {}, 1],
  ['missing metadata workspace id refuses rather than using the token audience', { metadata: { ...metadata, workspace_id: undefined }, badWorkspace: true }, {}, 1]
]) test(name, { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan(options).calls);
  const result = await runCli(server, ['--json'], env);
  assert.equal(result.status, status, result.stderr);
  if (options.metadata?.workspace_id === '123') assert.equal(JSON.parse(result.stderr).error.code, 'workspace_proof_invalid');
  noSecrets(result);
  server.assertDone();
});

test('SP change revokes every inventory object, skips missing objects, and removes inherited ACL fields', { timeout: 4900 }, async (t) => {
  const old = sp.applicationId;
  const changes = [
    { ...step('revoke', 'catalog', 'workspace', ['USE_CATALOG'], 'exists', old), object: 'catalog' },
    { ...step('revoke', 'schema', 'workspace.br_design', ['USE_SCHEMA'], 'exists', old), object: 'schema' },
    { ...step('revoke', 'table', 'workspace.br_design.results_table', ['SELECT'], 'exists', old), object: 'results_table' },
    { ...step('revoke', 'model_provider_service', 'workspace.br_design.provider', ['MANAGE'], 'exists', old), object: 'provider_service' },
    { object: 'secret_scope', action: 'secret_acl_delete', scope: 'old-scope', principal: principal(old), only_if: 'exists' },
    ...['agent_job', 'eval_job'].map((object, i) => ({ object, action: 'job_acl_remove', job_id: String(i+70), principal: principal(old), only_if: 'exists' })),
    { object: 'serving_endpoint', action: 'endpoint_acl_remove', endpoint_name: 'recorded-endpoint', principal: principal(old), only_if: 'exists' },
    { object: 'eval_folder', action: 'folder_acl_remove', path: '/Shared/eval', principal: principal(old), only_if: 'exists' }
  ];
  const calls = [];
  const add = (method, path, body = {}, status = 200, check) => calls.push({ method, path, body, status, check });
  for (const change of changes.filter((s) => s.action === 'revoke')) {
    const path = `${uc}/${({ catalog: 'catalogs', schema: 'schemas', table: 'tables', model_provider_service: 'model-provider-services' })[change.securable]}/${change.full_name}`;
    const missing = change.object === 'provider_service';
    add('GET', path, missing ? { error_code: 'RESOURCE_DOES_NOT_EXIST' } : { owner: old }, missing ? 404 : 200);
    if (!missing) add('PATCH', `${uc}/permissions/${change.securable}/${change.full_name}`, {}, 200, (r) => assert.deepEqual(r.body, { changes: [{ principal: old, remove: change.privileges }] }));
  }
  add('GET', '/api/2.0/secrets/acls/get', { principal: old, permission: 'MANAGE' });
  add('POST', '/api/2.0/secrets/acls/delete', {}, 200, (r) => assert.deepEqual(r.body, { scope: 'old-scope', principal: old }));
  for (const id of [70,71]) {
    add('GET', `/api/2.0/permissions/jobs/${id}`, { access_control_list: [direct(old, 'IS_OWNER'), { user_name: 'reader@example.com', all_permissions: [{ permission_level: 'CAN_VIEW' }] }, { group_name: 'admins', all_permissions: [{ permission_level: 'CAN_MANAGE', inherited: true }] }] });
    add('PUT', `/api/2.0/permissions/jobs/${id}`, {}, 200, (r) => assert.deepEqual(r.body, { access_control_list: [{ user_name: 'reader@example.com', permission_level: 'CAN_VIEW' }, { user_name: 'admin@example.com', permission_level: 'IS_OWNER' }] }));
  }
  add('GET', '/api/2.0/serving-endpoints/recorded-endpoint', { id: 'endpoint-id' });
  add('GET', '/api/2.0/permissions/serving-endpoints/endpoint-id', { access_control_list: [direct(old, 'CAN_MANAGE'), { group_name: 'account users', all_permissions: [{ permission_level: 'CAN_QUERY' }] }] });
  add('PUT', '/api/2.0/permissions/serving-endpoints/endpoint-id', {}, 200, (r) => assert.deepEqual(r.body.access_control_list, [{ group_name: 'account users', permission_level: 'CAN_QUERY' }]));
  add('GET', '/api/2.0/workspace/get-status', { object_id: 999 });
  add('GET', '/api/2.0/permissions/directories/999', { access_control_list: [direct(old, 'CAN_READ')] });
  add('PUT', '/api/2.0/permissions/directories/999', {}, 200, (r) => assert.deepEqual(r.body.access_control_list, []));
  const server = await replay(t, plan({ existing: binding(), spMissing: true, newSp: true, heal: true, change: changes, changeCalls: calls }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
  server.assertDone();
});

const manifestRevoke = (fields = {}) => ({ object: 'cases_table', action: 'manifest_table_revoke', route_key: 'support/triage', eval_folder: '/Shared/eval', principal: principal(), privileges: ['SELECT'], only_if: 'exists', ...fields });
function manifestRevokeCalls(change, { content = manifest, folderMissing = false, manifestMissing = false, exported, table = 'main.evals.cases', status = 200, code = 'RESOURCE_DOES_NOT_EXIST' } = {}) {
  const calls = [{ method: 'GET', path: '/api/2.0/workspace/get-status', status: folderMissing ? 404 : 200,
    body: folderMissing ? { error_code: code } : { object_id: 999, object_type: 'DIRECTORY' },
    check: (r) => assert.deepEqual([...r.query], [['path', change.eval_folder]]) }];
  if (folderMissing) return calls;
  calls.push({ method: 'GET', path: '/api/2.0/workspace/export', status: manifestMissing ? 404 : 200,
    body: manifestMissing ? { error_code: code } : exported ?? { content: Buffer.from(content).toString('base64') },
    check: (r) => assert.deepEqual([...r.query], [['path', `${change.eval_folder}/.benchrouter/benchrouter.yml`], ['format', 'AUTO']]) });
  if (manifestMissing || table === null) return calls;
  calls.push({ method: 'PATCH', path: `${uc}/permissions/table/${table}`, status,
    body: status === 200 ? {} : { error_code: code, message: `${loginMarker} ${pollMarker}` },
    check: (r) => assert.deepEqual(r.body, { changes: [{ principal: sp.applicationId, remove: ['SELECT'] }] }) });
  return calls;
}

test('SP change revokes only SELECT for the old SP on each route\'s declared cases table', { timeout: 4900 }, async (t) => {
  const changes = [manifestRevoke(), manifestRevoke({ route_key: 'other/route', eval_folder: '/Shared/other' })];
  const content = manifest + manifest.slice(manifest.indexOf('  - route_id:')).replace('support/triage', 'other/route').replace('main.evals.cases', 'other.data.cases');
  const changeCalls = changes.flatMap((change, i) => manifestRevokeCalls(change, { content, table: i ? 'other.data.cases' : 'main.evals.cases' }));
  const server = await sharedReplay(t, plan({ existing: binding(), spMissing: true, newSp: true, change: changes, changeCalls }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).skipped, []);
  noSecrets(result);
  server.assertDone();
});

for (const [name, options, reason] of [
  ['missing folder', { folderMissing: true }, 'eval folder is missing'],
  ['missing manifest', { manifestMissing: true }, 'eval manifest is missing'],
  ['route no longer declared', { content: manifest.replace('support/triage', 'other/route'), table: null }, 'route_key is no longer declared exactly once in the eval manifest'],
  ['invalid manifest', { content: 'routes: [', table: null }, 'eval manifest is invalid'],
  ['invalid manifest export', { exported: {}, table: null }, 'eval manifest is invalid'],
  ['reserved manifest secret scope', { content: manifest.replace('support-evals', 'benchrouter-private'), table: null }, 'eval manifest is invalid'],
  ['404 table', { status: 404 }, 'cases table is missing'],
  ['table missing by code', { status: 400, code: 'NOT_FOUND' }, 'cases table is missing']
]) for (const json of [false, true]) test(`SP change skips ${name} and Connect succeeds (${json ? 'JSON' : 'text'})`, { timeout: 4900 }, async (t) => {
  const change = manifestRevoke();
  const changeCalls = manifestRevokeCalls(change, options);
  const server = await replay(t, plan({ existing: binding(), spMissing: true, newSp: true, change: [change], changeCalls }).calls);
  const result = await runCli(server, json ? ['--json'] : []);
  assert.equal(result.status, 0, result.stderr);
  if (json) {
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, 'verified');
    assert.deepEqual(output.skipped, [{ object: change.object, action: change.action, route_key: change.route_key, eval_folder: change.eval_folder, reason }]);
  } else {
    assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Skipped ')), [`Skipped cases table revoke for support/triage: ${reason}.`]);
  }
  noSecrets(result);
  server.assertDone();
});

for (const status of [400, 403]) test(`SP change cases table revoke PERMISSION_DENIED (${status}) names owners and exits 3`, { timeout: 4900 }, async (t) => {
  const change = manifestRevoke();
  const changeCalls = [...manifestRevokeCalls(change, { status, code: 'PERMISSION_DENIED' }),
    { method: 'GET', path: `${uc}/catalogs/main`, status: 200, body: { owner: 'cases-catalog-owner' } },
    { method: 'GET', path: `${uc}/schemas/main.evals`, status: 200, body: { owner: 'cases-schema-owner' } }];
  const p = plan({ existing: binding(), spMissing: true, newSp: true, change: [change], changeCalls });
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.2/jobs/reset'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'grant_refused');
  assert.match(result.stderr, /refused revoke on main.evals.cases/);
  assert.match(result.stderr, /Catalog owner: cases-catalog-owner/);
  assert.match(result.stderr, /Schema owner: cases-schema-owner/);
  noSecrets(result);
  server.assertDone();
});

test('SP change rejects the former UC cases_table revoke before the scope or key write', { timeout: 4900 }, async (t) => {
  const change = { ...step('revoke', 'table', 'main.evals.cases', ['SELECT'], 'exists'), object: 'cases_table' };
  const p = plan({ existing: binding(), spMissing: true, newSp: true, change: [change] });
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.0/secrets/scopes/create'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid Databricks Connect response/);
  assert.equal(result.stdout, '');
  noSecrets(result);
  server.assertDone();
});

test('SP change manifest revoke parser validates the route, folder, previous SP, SELECT and exists condition', { timeout: 4900 }, () => {
  const change = manifestRevoke();
  const response = { ...structuredClone(responseTemplate), sp_change: { previous_agent_sp_application_id: sp.applicationId, revoke: [change] } };
  assert.deepEqual(parseDatabricksConnectResponse(response), response);
  for (const fields of [
    { object: 'results_table' }, { action: 'grant' }, { route_key: '' }, { route_key: ' ' }, { route_key: null },
    ...[undefined, '', 'Shared/eval', '/', '/Shared/eval/', '/Shared//eval', '/Shared/./eval', '/Shared/../eval', '/Shared/ev\0al', '/Shared/ev\\al'].map((eval_folder) => ({ eval_folder })),
    { principal: principal(sp2.applicationId) }, { principal: { type: 'user', name: sp.applicationId } }, { principal: null },
    ...[undefined, [], ['MODIFY'], ['SELECT', 'MODIFY'], ['SELECT', 'SELECT']].map((privileges) => ({ privileges })),
    { only_if: 'always' }, { only_if: 'exists_not_agent_owned' }, { only_if: undefined }
  ]) assert.throws(() => parseDatabricksConnectResponse({ ...response, sp_change: { ...response.sp_change, revoke: [{ ...change, ...fields }] } }), /invalid Databricks Connect response/);
});
