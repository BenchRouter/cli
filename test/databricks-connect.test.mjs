import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseDatabricksConnectResponse, parseDatabricksSetupItems, spStepTarget } from '../src/databricks-contract.mjs';
import { replay as sharedReplay, runDatabricksCli, noSecrets } from './helpers/databricks-replay.mjs';

const fixtureDir = new URL('./fixtures/databricks/', import.meta.url);
const fixture = async (name) => JSON.parse(await readFile(new URL(name, fixtureDir), 'utf8'));
const [me, sp, sp2, ruleset, run, settings, responseTemplate, metadata] = await Promise.all(['me.json', 'p1-create.json', 'p5-sp3.json', 'p1-ruleset-put.json', 'p2-run.json', 'settings.json', 'connect.json', 'databricks-config.json'].map(fixture));
const m2mMe = await fixture('me-m2m.json');
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

function pendingStep(kind, step, id) {
  return { kind, id, binding_id: 'dbxb_recorded', reason: 'agent_sp_replaced', actor: 'workspace_admin', command: null,
    instruction: `Complete ${kind} ${id}.`, [kind]: step };
}

function plan(options = {}) {
  const agent = options.agent ?? (options.newSp ? sp2 : sp);
  const recordedAgent = options.existing?.agent_sp_application_id === sp2.applicationId ? sp2 : sp;
  const admin = options.m2m ? { service_principal_name: clientId } : { user_name: 'admin@example.com' };
  const member = options.m2m ? `servicePrincipals/${clientId}` : 'users/admin@example.com';
  const existing = options.existing;
  const c = structuredClone(responseTemplate);
  const scope = scopeFor(agent.applicationId);
  c.agent.secret_scope = c.agent.job_parameters.scope = scope;
  c.grants = [step('grant', 'catalog', 'workspace', ['USE_CATALOG'], 'always', agent.applicationId), step('grant', 'schema', 'workspace.br_design', ['USE_SCHEMA', 'CREATE_TABLE', 'CREATE_VOLUME', 'CREATE_SERVICE'], 'always', agent.applicationId)];
  c.heal = [step('set_owner', 'volume', 'workspace.br_design.benchrouter_artifacts', null, 'exists_not_agent_owned', agent.applicationId), step('set_owner', 'volume', 'workspace.br_design.benchrouter_results', null, 'exists_not_agent_owned', agent.applicationId), step('grant', 'table', 'workspace.br_design.benchrouter_eval_results', ['SELECT', 'MODIFY'], 'exists_not_agent_owned', agent.applicationId)];
  if (options.newSp) c.sp_change = { previous_agent_sp_application_id: sp.applicationId, grant: options.grants ?? [], revoke: options.change ?? [] };
  c.cleanup_pending = options.pending ?? [
    ...(c.sp_change?.grant ?? []).map((s, i) => pendingStep('grant', s, `grant-${i}`)),
    ...(c.sp_change?.revoke ?? []).map((s, i) => pendingStep('revoke', s, `revoke-${i}`))
  ];
  if (options.invalid) c.agent.job_parameters.job_id = null;
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
  const identity = options.m2m ? m2mMe : me;
  add('GET', `${scim}/Me`, { ...identity, ...(options.nonAdmin ? { groups: [] } : {}), ...(options.mismatchedMe ? { userName: 'other-principal' } : {}) });
  if (options.nonAdmin || options.mismatchedMe) return { calls, c };
  if (!options.warehouseFlag) {
    add('GET', '/api/2.0/sql/warehouses', { warehouses: options.warehouses ?? [{ id: 'f7cf158c6784dd06', name: 'Serverless', enable_serverless_compute: true }] });
    if (options.warehouses) return { calls, c };
  }
  add('GET', '/v1/databricks/bindings', { bindings: existing ? [existing] : [] });
  if (existing?.agent_job_id) add('GET', '/api/2.2/jobs/get', options.jobDeleted ? deletedJob : options.jobMissing ? { error_code: 'RESOURCE_DOES_NOT_EXIST' } : { job_id: Number(existing.agent_job_id), settings: { run_as: { service_principal_name: existing.agent_sp_application_id } } }, options.jobDeleted ? 400 : options.jobMissing ? 404 : 200);
  if (existing) {
    add('GET', `${scim}/ServicePrincipals`, { Resources: options.spMissing ? [] : [recordedAgent], totalResults: options.spMissing ? 0 : 1 }, 200, (r) => assert.equal(r.query.get('filter'), `applicationId eq ${JSON.stringify(recordedAgent.applicationId)}`));
    if (!options.spMissing) add('GET', rulePath, options.noRole || options.ruleFailure ? { error_code: options.ruleCode ?? 'PERMISSION_DENIED', message: 'Not authorized to perform this operation' } : { ...ruleset, grant_rules: ruleset.grant_rules.map((r) => r.role === 'roles/servicePrincipal.user' ? { ...r, principals: [member] } : r) }, options.noRole || options.ruleFailure ? options.ruleStatus ?? 403 : 200);
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
  const completed = options.done ?? c.cleanup_pending.filter((s) => s.binding_id === c.binding_id).map(({ kind, id }) => ({ kind, id }));
  if (completed.length) add('POST', `/v1/databricks/bindings/${c.binding_id}/cleanup`, { ok: true, cleanup_pending: [] }, 200,
    (r) => assert.deepEqual(r.body, { done: completed }));
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
    if (options.existing && options.noRole && !options.newSp) {
      assert.equal(server.requests.filter((r) => r.path === rulePath).length, 1);
    }
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
  for (const value of [undefined, null, {}, [null],
    ...[{ kind: 'grant_check' }, { state: 'cancelled' }, { queued_at: null }, { failure: undefined }].map((fields) => [{ ...setupTemplate.setup_items[0], ...fields }]),
    ...[{ owner: 'admin' }, { title: null }, { message: undefined }, { failed_at: undefined }].map((fields) => [{ ...validFailure, failure: { ...setupTemplate.failure, ...fields } }])
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

for (const m2m of [false, true]) for (const failure of ['mismatchedMe', 'nonAdmin']) test(`Connect refuses ${m2m ? 'M2M' : 'U2M'} ${failure} before writes`, { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan({ m2m, [failure]: true }).calls);
  const result = await runCli(server, ['--json'], { BR_FIXTURE_AUTH: m2m ? 'm2m' : '' });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, 'workspace_admin_required');
  assert.ok(!server.requests.some((r) => r.method !== 'GET' && r.path !== '/oidc/v1/token'));
  noSecrets(result);
  server.assertDone();
});

test('M2M Reconnect matches the existing servicePrincipal.user grant without creating another SP', { timeout: 4900 }, async (t) => {
  const server = await replay(t, plan({ m2m: true, existing: binding(sp, null) }).calls);
  const result = await runCli(server, ['--json'], { BR_FIXTURE_AUTH: 'm2m' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!server.requests.some((r) => r.method === 'POST' && r.path === `${scim}/ServicePrincipals`));
  noSecrets(result);
  server.assertDone();
});

test('M2M SP change transfers job ownership to the admin SP and removes its old direct permission', { timeout: 4900 }, async (t) => {
  const path = '/api/2.0/permissions/jobs/70';
  const change = { object: 'agent_job', action: 'job_acl_remove', job_id: '70', principal: principal(), only_if: 'exists' };
  const changeCalls = [
    { method: 'GET', path, status: 200, body: { access_control_list: [direct(sp.applicationId, 'IS_OWNER'), direct(clientId, 'CAN_MANAGE'), { user_name: clientId, all_permissions: [{ permission_level: 'CAN_VIEW' }] }] } },
    { method: 'PUT', path, status: 200, body: {}, check: (r) => assert.deepEqual(r.body.access_control_list, [{ user_name: clientId, permission_level: 'CAN_VIEW' }, { service_principal_name: clientId, permission_level: 'IS_OWNER' }]) }
  ];
  const server = await replay(t, plan({ m2m: true, existing: binding(), spMissing: true, newSp: true, change: [change], changeCalls }).calls);
  const result = await runCli(server, ['--json'], { BR_FIXTURE_AUTH: 'm2m' });
  assert.equal(result.status, 0, result.stderr);
  noSecrets(result);
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

function inventoryRevokes(old = sp.applicationId) {
  return [
    { ...step('revoke', 'catalog', 'workspace', ['USE_CATALOG'], 'exists', old), object: 'catalog' },
    { ...step('revoke', 'schema', 'workspace.br_design', ['USE_SCHEMA'], 'exists', old), object: 'schema' },
    { ...step('revoke', 'table', 'workspace.br_design.results_table', ['SELECT'], 'exists', old), object: 'results_table' },
    { ...step('revoke', 'model_provider_service', 'workspace.br_design.provider', ['MANAGE'], 'exists', old), object: 'provider_service' },
    { object: 'secret_scope', action: 'secret_acl_delete', scope: 'old-scope', principal: principal(old), only_if: 'exists' },
    ...['agent_job', 'eval_job'].map((object, i) => ({ object, action: 'job_acl_remove', job_id: String(i+70), principal: principal(old), only_if: 'exists' })),
    { object: 'serving_endpoint', action: 'endpoint_acl_remove', endpoint_name: 'recorded-endpoint', principal: principal(old), only_if: 'exists' },
    { object: 'eval_folder', action: 'folder_acl_remove', path: '/Shared/eval', principal: principal(old), only_if: 'exists' }
  ];
}

test('SP change revokes every inventory object, skips missing objects, and removes inherited ACL fields', { timeout: 4900 }, async (t) => {
  const old = sp.applicationId;
  const changes = inventoryRevokes(old);
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
const manifestSecretRevoke = (fields = {}) => ({ object: 'secret_scope', action: 'manifest_secret_acl_delete', route_key: 'support/triage', eval_folder: '/Shared/eval', principal: principal(), only_if: 'exists', ...fields });
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
  const server = await replay(t, plan({ existing: binding(), spMissing: true, newSp: true, change: [change], changeCalls, ...(!['eval folder is missing', 'eval manifest is missing', 'cases table is missing'].includes(reason) ? { done: [] } : {}) }).calls);
  const result = await runCli(server, json ? ['--json'] : []);
  assert.equal(result.status, 0, result.stderr);
  if (json) {
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, 'verified');
    assert.deepEqual(output.skipped, [{ object: change.object, action: change.action, route_key: change.route_key, eval_folder: change.eval_folder, reason }]);
    const pending = !['eval folder is missing', 'eval manifest is missing', 'cases table is missing'].includes(reason);
    assert.deepEqual(output.pending_steps, pending ? [{ kind: 'revoke', id: 'revoke-0', action: change.action, object: change.object, target: `${change.eval_folder}#${change.route_key}`, reason }] : []);
  } else {
    assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('Skipped ')), [`Skipped cases table revoke for support/triage: ${reason}.`]);
  }
  noSecrets(result);
  server.assertDone();
});

for (const status of [400, 403]) test(`SP change cases table revoke PERMISSION_DENIED (${status}) names owners and continues with exit 0`, { timeout: 4900 }, async (t) => {
  const change = manifestRevoke();
  const changeCalls = [...manifestRevokeCalls(change, { status, code: 'PERMISSION_DENIED' }),
    { method: 'GET', path: `${uc}/catalogs/main`, status: 200, body: { owner: 'cases-catalog-owner' } },
    { method: 'GET', path: `${uc}/schemas/main.evals`, status: 200, body: { owner: 'cases-schema-owner' } }];
  const p = plan({ existing: binding(), spMissing: true, newSp: true, change: [change], changeCalls, done: [] });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pending_steps[0].owner, 'cases-schema-owner');
  assert.match(result.stderr, /Pending revoke.*manifest_table_revoke/);
  assert.match(result.stderr, /Owner: cases-schema-owner.*Re-run benchrouter databricks connect/);
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

test('SP change manifest revoke parser validates string route and folder, previous SP, SELECT and exists condition', { timeout: 4900 }, () => {
  const change = manifestRevoke();
  const response = { ...structuredClone(responseTemplate), sp_change: { previous_agent_sp_application_id: sp.applicationId, grant: [], revoke: [change] } };
  assert.deepEqual(parseDatabricksConnectResponse(response, sp2.applicationId), response);
  for (const fields of [
    { object: 'results_table' }, { action: 'grant' }, { route_key: null },
    { eval_folder: undefined }, { eval_folder: null },
    { principal: null }, { principal: principal(sp2.applicationId) },
    { principal: { type: 'user', name: sp.applicationId } }, { principal: { type: 'group', name: sp.applicationId } },
    ...[undefined, [], ['MODIFY'], ['SELECT', 'MODIFY'], ['SELECT', 'SELECT']].map((privileges) => ({ privileges })),
    { only_if: 'always' }, { only_if: 'exists_not_agent_owned' }, { only_if: undefined }
  ]) assert.throws(() => parseDatabricksConnectResponse({ ...response, sp_change: { ...response.sp_change, revoke: [{ ...change, ...fields }] } }, sp2.applicationId), /invalid Databricks Connect response/);
});

const persistedChange = await fixture('sp-change.json');
const call = (method, path, body = {}, status = 200, check) => ({ method, path, body, status, check });
const bodyIs = (body) => (r) => assert.deepEqual(r.body, body);
function grantCalls(grant, { sameSchema = false } = {}) {
  const id = grant.principal.name;
  if (grant.action === 'grant') return [
    call('GET', `${uc}/model-provider-services/${grant.full_name}`, { owner: 'service-owner' }),
    call('PATCH', `${uc}/permissions/model_provider_service/${grant.full_name}`, {}, 200, bodyIs({ changes: [{ principal: id, add: ['MANAGE'] }] }))
  ];
  if (grant.action === 'endpoint_acl_add' || grant.action === 'folder_acl_add') {
    const endpoint = grant.action === 'endpoint_acl_add';
    return [call('GET', endpoint ? `/api/2.0/serving-endpoints/${grant.endpoint_name}` : '/api/2.0/workspace/get-status', endpoint ? { id: 'endpoint-id' } : { object_id: 999 }, 200,
      endpoint ? undefined : (r) => assert.equal(r.query.get('path'), grant.path)),
    call('PATCH', `/api/2.0/permissions/${endpoint ? 'serving-endpoints/endpoint-id' : 'directories/999'}`, {}, 200,
      bodyIs({ access_control_list: [{ service_principal_name: id, permission_level: grant.permission }] }))];
  }
  const table = sameSchema ? 'workspace.br_design.cases' : 'main.evals.cases';
  const content = sameSchema ? manifest.replace('main.evals.cases', table) : manifest;
  const calls = [
    call('GET', '/api/2.0/workspace/get-status', { object_id: 999 }, 200, (r) => assert.equal(r.query.get('path'), grant.eval_folder)),
    call('GET', '/api/2.0/workspace/export', { content: Buffer.from(content).toString('base64') }, 200,
      (r) => assert.deepEqual([...r.query], [['path', `${grant.eval_folder}/.benchrouter/benchrouter.yml`], ['format', 'AUTO']]))
  ];
  if (grant.action === 'manifest_secret_acl_put') calls.push(call('POST', '/api/2.0/secrets/acls/put', {}, 200,
    bodyIs({ scope: 'support-evals', principal: id, permission: 'READ' })));
  else {
    calls.push(call('GET', `${uc}/tables/${table}`, { owner: 'cases-owner' }));
    const steps = sameSchema ? [] : [['catalog', 'main', ['USE_CATALOG']], ['schema', 'main.evals', ['USE_SCHEMA']]];
    steps.push(['table', table, ['SELECT']]);
    for (const [securable, name, privileges] of steps) calls.push(call('PATCH', `${uc}/permissions/${securable}/${name}`, {}, 200,
      bodyIs({ changes: [{ principal: id, add: privileges }] })));
  }
  return calls;
}
const ucRevokeCalls = (s) => [call('GET', `${uc}/model-provider-services/${s.full_name}`, { owner: 'service-owner' }),
  call('PATCH', `${uc}/permissions/model_provider_service/${s.full_name}`, {}, 200, bodyIs({ changes: [{ principal: s.principal.name, remove: s.privileges }] }))];

const secretRevokeId = (s) => `${s.principal.name}|secret_scope|${s.eval_folder}#${s.route_key}`;
function manifestSecretRevokeCalls(change, { scope = 'support-evals', status = 200, code = 'RESOURCE_DOES_NOT_EXIST', ...options } = {}) {
  const calls = manifestRevokeCalls(change, { ...options, table: null });
  if (options.folderMissing || options.manifestMissing || scope === null) return calls;
  calls.push(call('POST', '/api/2.0/secrets/acls/delete', status === 200 ? {} : { error_code: code, message: `${loginMarker} ${pollMarker}` }, status,
    bodyIs({ scope, principal: change.principal.name })));
  return calls;
}

for (const retry of [false, true]) test(`Connect revokes each eval's old SP secret ACL after its table revoke (${retry ? 'persisted retry' : 'SP change'})`, { timeout: 4900 }, async (t) => {
  const changes = [
    manifestRevoke(), manifestSecretRevoke(),
    manifestRevoke({ route_key: 'other/route', eval_folder: '/Shared/other' }),
    manifestSecretRevoke({ route_key: 'other/route', eval_folder: '/Shared/other' })
  ];
  const content = manifest + manifest.slice(manifest.indexOf('  - route_id:')).replace('support/triage', 'other/route')
    .replace('main.evals.cases', 'other.data.cases').replace('support-evals', 'other-evals');
  const pending = changes.map((s, i) => pendingStep('revoke', s, s.object === 'secret_scope' ? secretRevokeId(s) : `table-${i}`));
  const inherited = pendingStep('revoke', manifestSecretRevoke({ principal: principal(sp2.applicationId) }), 'earlier-binding');
  inherited.binding_id = 'dbxb_older';
  const grant = persistedChange.sp_change.grant.find((s) => s.action === 'manifest_secret_acl_put');
  const grantItem = pendingStep('grant', grant, 'new-sp-secret-read');
  const changeCalls = [...grantCalls(grant), ...changes.flatMap((s, i) => s.object === 'secret_scope'
    ? manifestSecretRevokeCalls(s, { content, scope: i > 1 ? 'other-evals' : 'support-evals' })
    : manifestRevokeCalls(s, { content, table: i > 1 ? 'other.data.cases' : 'main.evals.cases' }))];
  const p = plan({ existing: binding(retry ? sp2 : sp), ...(retry ? { agent: sp2 } : { newSp: true, spMissing: true, grants: [grant], change: changes }),
    pending: [inherited, ...pending, grantItem], changeCalls,
    done: [grantItem, ...pending].map(({ kind, id }) => ({ kind, id })) });
  const server = await sharedReplay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(p.c.sp_change === null, retry);
  assert.deepEqual(JSON.parse(result.stdout).pending_steps, []);
  assert.equal(server.requests.filter((r) => r.path === '/api/2.0/secrets/acls/delete').length, 2);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/cleanup')).length, 1);
  noSecrets(result);
  server.assertDone();
});

for (const [name, options] of [
  ['missing folder', { folderMissing: true }],
  ['missing manifest', { manifestMissing: true }],
  ['scope not declared', { content: manifest.replace('secret_env: [JUDGE_API_KEY]', 'secret_env: []').replace('secret_scope: support-evals', '# no scope'), scope: null }],
  ['missing scope', { status: 404 }],
  ['missing ACL', { status: 400, code: 'RESOURCE_DOES_NOT_EXIST' }]
]) test(`manifest_secret_acl_delete acknowledges ${name}`, { timeout: 4900 }, async (t) => {
  const change = manifestSecretRevoke();
  const item = pendingStep('revoke', change, secretRevokeId(change));
  const server = await replay(t, plan({ agent: sp2, pending: [item], changeCalls: manifestSecretRevokeCalls(change, options) }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).pending_steps, []);
  assert.deepEqual(server.requests.find((r) => r.path.endsWith('/cleanup')).body.done, [{ kind: 'revoke', id: item.id }]);
  noSecrets(result);
  server.assertDone();
});

for (const status of [400, 403]) for (const json of [false, true]) test(`manifest_secret_acl_delete refusal (${status}, ${json ? 'JSON' : 'text'}) names MANAGE holders and Connect exits 0`, { timeout: 4900 }, async (t) => {
  const change = manifestSecretRevoke();
  const item = pendingStep('revoke', change, secretRevokeId(change));
  const success = manifestSecretRevoke({ eval_folder: '/Shared/other' });
  const successItem = pendingStep('revoke', success, secretRevokeId(success));
  const changeCalls = [
    ...manifestSecretRevokeCalls(change, { status, code: 'PERMISSION_DENIED' }),
    call('GET', '/api/2.0/secrets/acls/list', { items: [
      { principal: 'scope-reader', permission: 'READ' },
      { principal: 'scope-owner', permission: 'MANAGE' },
      { principal: 'scope-admins', permission: 'MANAGE' }
    ] }, 200, (r) => assert.deepEqual([...r.query], [['scope', 'support-evals']])),
    ...manifestSecretRevokeCalls(success)
  ];
  const server = await sharedReplay(t, plan({ agent: sp2, pending: [item, successItem], changeCalls,
    done: [{ kind: 'revoke', id: successItem.id }] }).calls);
  const result = await runCli(server, json ? ['--json'] : []);
  assert.equal(result.status, 0, result.stderr);
  if (json) assert.deepEqual(JSON.parse(result.stdout).pending_steps, [{ kind: 'revoke', id: item.id, action: change.action,
    object: change.object, target: `${change.eval_folder}#${change.route_key}`, owner: 'scope-owner, scope-admins' }]);
  assert.match(result.stderr, /Pending revoke.*manifest_secret_acl_delete.*Owner: scope-owner, scope-admins.*Re-run benchrouter databricks connect/);
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/create'));
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/run-now'));
  noSecrets(result);
  server.assertDone();
});

test('secret_scope revoke parser distinguishes direct and manifest actions and validates required fields', { timeout: 4900 }, () => {
  const direct = inventoryRevokes().find((s) => s.action === 'secret_acl_delete');
  const change = manifestSecretRevoke();
  const response = { ...structuredClone(responseTemplate), cleanup_pending: [],
    sp_change: { previous_agent_sp_application_id: sp.applicationId, grant: [], revoke: [direct, change] } };
  assert.deepEqual(parseDatabricksConnectResponse(response, sp2.applicationId), response);
  assert.equal(spStepTarget(direct), direct.scope);
  assert.equal(spStepTarget({ ...change, scope: 'unused-extra-field' }), `${change.eval_folder}#${change.route_key}`);
  for (const invalid of [
    { ...direct, action: change.action }, { ...change, action: direct.action },
    ...[{ object: 'cases_table' }, { action: 'unknown' }, { eval_folder: null }, { eval_folder: undefined },
      { route_key: 1 }, { route_key: undefined }, { principal: null },
      { only_if: 'always' }, { only_if: 'exists_not_agent_owned' }, { only_if: undefined }].map((fields) => ({ ...change, ...fields }))
  ]) assert.throws(() => parseDatabricksConnectResponse({ ...response, sp_change: { ...response.sp_change, revoke: [invalid] } }, sp2.applicationId), /invalid Databricks Connect response/);
});

for (const action of ['manifest_table_grant', 'manifest_secret_acl_put', 'manifest_table_revoke', 'manifest_secret_acl_delete']) for (const [content, reason] of [
  ['routes: [', 'eval manifest is invalid'],
  [manifest.replace('support/triage', 'other/route'), 'route_key is no longer declared exactly once in the eval manifest'],
  [manifest.replace('support-evals', 'benchrouter-private'), 'eval manifest is invalid']
]) test(`Connect keeps ${action} pending for ${reason}${content.includes('benchrouter-private') ? ' (reserved scope)' : ''}`, { timeout: 4900 }, async (t) => {
  const kind = ['manifest_table_revoke', 'manifest_secret_acl_delete'].includes(action) ? 'revoke' : 'grant';
  const step = kind === 'revoke' ? action === 'manifest_secret_acl_delete' ? manifestSecretRevoke() : manifestRevoke()
    : persistedChange.sp_change.grant.find((s) => s.action === action);
  const item = pendingStep(kind, step, 'manifest-pending');
  const success = persistedChange.sp_change.revoke[0];
  const changeCalls = [
    ...manifestRevokeCalls(step, { content, table: null }),
    ...ucRevokeCalls(success)
  ];
  const server = await replay(t, plan({ agent: sp2, pending: [item, pendingStep('revoke', success, 'successful-revoke')], changeCalls, done: [{ kind: 'revoke', id: 'successful-revoke' }] }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).pending_steps, [{ kind, id: item.id, action, object: step.object, target: `${step.eval_folder}#${step.route_key}`, reason }]);
  assert.ok(result.stderr.includes(`Warning: Pending ${kind} ${item.id}:`));
  assert.ok(result.stderr.includes(`Reason: ${reason}.`));
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/create'));
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/run-now'));
  server.assertDone();
});

for (const retry of [false, true]) test(`Connect runs all persisted grants before revokes and acknowledges once (${retry ? 'retry with sp_change null' : 'SP change'})`, { timeout: 4900 }, async (t) => {
  const { sp_change: change, cleanup_pending: steps } = persistedChange;
  // Put revokes first on the wire to prove that grant-first execution is deliberate.
  const pending = [...steps].reverse();
  const grants = pending.filter((s) => s.kind === 'grant').map((s) => s.grant);
  const changeCalls = [...grants.flatMap((g) => grantCalls(g)), ...change.revoke.flatMap(ucRevokeCalls)];
  const p = plan({ existing: retry ? binding(sp2) : binding(), ...(retry ? { agent: sp2 } : { newSp: true, spMissing: true, grants: change.grant, change: change.revoke }),
    pending, changeCalls, done: [...pending.filter((s) => s.kind === 'grant'), ...pending.filter((s) => s.kind === 'revoke')].map(({ kind, id }) => ({ kind, id })) });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(p.c.sp_change === null, retry);
  assert.deepEqual(JSON.parse(result.stdout).pending_steps, []);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/cleanup')).length, 1);
  noSecrets(result);
  server.assertDone();
});

for (const action of ['manifest_table_grant', 'manifest_secret_acl_put', 'manifest_table_revoke', 'manifest_secret_acl_delete']) test(`Connect fails on unexpected ${action} export errors without acknowledgement`, { timeout: 4900 }, async (t) => {
  const kind = ['manifest_table_revoke', 'manifest_secret_acl_delete'].includes(action) ? 'revoke' : 'grant';
  const step = kind === 'revoke' ? action === 'manifest_secret_acl_delete' ? manifestSecretRevoke() : manifestRevoke()
    : persistedChange.sp_change.grant.find((s) => s.action === action);
  const changeCalls = manifestRevokeCalls(step, { table: null });
  changeCalls[1] = { ...changeCalls[1], status: 500, body: { error_code: 'INTERNAL_ERROR' } };
  const p = plan({ agent: sp2, pending: [pendingStep(kind, step, 'failed-export')], changeCalls, done: [] });
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.0/workspace/export') + 1);
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(!server.requests.some((r) => r.path.endsWith('/cleanup') || r.path === '/api/2.2/jobs/create'));
  server.assertDone();
});

for (const json of [false, true]) test(`refused provider grant and revoke stay pending while Connect creates and runs the job (${json ? 'JSON' : 'text'})`, { timeout: 4900 }, async (t) => {
  const grant = persistedChange.sp_change.grant[0];
  const revoke = persistedChange.sp_change.revoke[0];
  const success = persistedChange.sp_change.grant[1];
  const pending = [pendingStep('revoke', revoke, 'refused-revoke'), pendingStep('grant', grant, 'refused-grant'), pendingStep('grant', success, 'successful-grant')];
  const changeCalls = [];
  for (const [s, kind, status] of [[grant, 'add', 403], [success, null, 200], [revoke, 'remove', 400]]) {
    if (!kind) { changeCalls.push(...grantCalls(s)); continue; }
    changeCalls.push(call('GET', `${uc}/model-provider-services/${s.full_name}`, { owner: 'service-owner' }),
      call('PATCH', `${uc}/permissions/model_provider_service/${s.full_name}`, { error_code: 'PERMISSION_DENIED', message: `${loginMarker} ${pollMarker}` }, status,
        bodyIs({ changes: [{ principal: s.principal.name, [kind]: s.privileges }] })),
      call('GET', `${uc}/catalogs/workspace`, { owner: 'catalog-owner' }), call('GET', `${uc}/schemas/workspace.br_design`, { owner: 'schema-owner' }));
  }
  const p = plan({ newSp: true, grants: [grant, success], change: [revoke], pending, changeCalls, done: [{ kind: 'grant', id: 'successful-grant' }] });
  const server = await replay(t, p.calls);
  const result = await runCli(server, json ? ['--json'] : []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split('\n').filter((l) => l.startsWith('Warning:')).length, 2);
  for (const kind of ['grant', 'revoke']) assert.match(result.stderr, new RegExp(`Pending ${kind}.*Owner: service-owner.*Re-run benchrouter databricks connect as that owner or a metastore admin`));
  if (json) assert.deepEqual(JSON.parse(result.stdout).pending_steps, [
    { kind: 'grant', id: 'refused-grant', action: 'grant', object: 'provider_service', target: grant.full_name, owner: 'service-owner' },
    { kind: 'revoke', id: 'refused-revoke', action: 'revoke', object: 'provider_service', target: revoke.full_name, owner: 'service-owner' }
  ]);
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/create'));
  assert.ok(server.requests.some((r) => r.path === '/api/2.2/jobs/run-now'));
  noSecrets(result);
  server.assertDone();
});

for (const grant of persistedChange.sp_change.grant) test(`missing ${grant.action} target is acknowledged`, { timeout: 4900 }, async (t) => {
  const calls = grantCalls(grant);
  calls[0] = { ...calls[0], body: { error_code: 'RESOURCE_DOES_NOT_EXIST' }, status: 404 };
  const p = plan({ agent: sp2, pending: [pendingStep('grant', grant, 'absent')], changeCalls: calls.slice(0, 1) });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

for (const action of ['manifest_table_grant', 'manifest_secret_acl_put']) test(`${action} missing manifest is acknowledged`, { timeout: 4900 }, async (t) => {
  const grant = persistedChange.sp_change.grant.find((s) => s.action === action);
  const calls = grantCalls(grant).slice(0, 2);
  calls[1] = { ...calls[1], body: { error_code: 'NOT_FOUND' }, status: 404 };
  const server = await replay(t, plan({ agent: sp2, pending: [pendingStep('grant', grant, 'absent-manifest')], changeCalls: calls }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

test('manifest table grant in the binding schema applies SELECT without extra namespace grants', { timeout: 4900 }, async (t) => {
  const grant = persistedChange.sp_change.grant.find((s) => s.action === 'manifest_table_grant');
  const server = await replay(t, plan({ agent: sp2, pending: [pendingStep('grant', grant, 'same-schema')], changeCalls: grantCalls(grant, { sameSchema: true }) }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

for (const method of ['GET', 'PUT']) for (const [status, code] of [[403, 'OTHER'], [400, 'PERMISSION_DENIED']]) test(`new SP rule-set ${method} succeeds on try six after ${status} ${code}`, { timeout: 4900 }, async (t) => {
  const p = plan();
  const index = p.calls.findIndex((c) => c.method === method && c.path === rulePath);
  p.calls.splice(index, 0, ...Array.from({ length: 5 }, () => call(method, rulePath, { error_code: code, message: 'Not authorized to perform this operation' }, status)));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json'], { BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === rulePath && r.method === method).length, 6);
  server.assertDone();
});

for (const method of ['GET', 'PUT']) test(`new SP rule-set ${method} stops after six denied tries`, { timeout: 4900 }, async (t) => {
  const p = plan();
  const index = p.calls.findIndex((c) => c.method === method && c.path === rulePath);
  p.calls.splice(index, p.calls.length, ...Array.from({ length: 6 }, () => call(method, rulePath, { error_code: 'PERMISSION_DENIED' }, 403)));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json'], { BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === rulePath && r.method === method).length, 6);
  server.assertDone();
});

for (const method of ['GET', 'PUT']) for (const [status, code] of [[401, 'UNAUTHORIZED'], [500, 'INTERNAL_ERROR']]) test(`new SP rule-set ${method} does not retry ${status} ${code}`, { timeout: 4900 }, async (t) => {
  const p = plan();
  const index = p.calls.findIndex((c) => c.method === method && c.path === rulePath);
  p.calls.splice(index, p.calls.length, call(method, rulePath, { error_code: code }, status));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json'], { BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === rulePath && r.method === method).length, 1);
  server.assertDone();
});

test('new SP shares a bounded retry budget between rule-set GET and PUT', { timeout: 4900 }, async (t) => {
  const p = plan();
  const get = p.calls.findIndex((c) => c.method === 'GET' && c.path === rulePath);
  const denied = (method) => call(method, rulePath, { error_code: 'PERMISSION_DENIED' }, 403);
  p.calls.splice(get, 0, denied('GET'), denied('GET'));
  const put = p.calls.findIndex((c) => c.method === 'PUT' && c.path === rulePath);
  p.calls.splice(put, p.calls.length, denied('PUT'), denied('PUT'), denied('PUT'), denied('PUT'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json'], { BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(server.requests.filter((r) => r.path === rulePath).length, 7);
  server.assertDone();
});

test('Connect parser rejects malformed grant and cleanup union fields before any workspace write', { timeout: 4900 }, () => {
  const response = { ...structuredClone(responseTemplate), ...structuredClone(persistedChange) };
  assert.deepEqual(parseDatabricksConnectResponse(response, sp2.applicationId), response);
  for (const grant of response.sp_change.grant) for (const fields of [
    { object: 'job' }, { action: 'unknown' }, { principal: { type: 'admin', name: 'admin' } },
    { only_if: 'unknown' }, ...(grant.action === 'grant' || grant.action === 'manifest_table_grant' ? [{ privileges: ['MODIFY'] }] : [{ permission: 'MANAGE' }])
  ]) assert.throws(() => parseDatabricksConnectResponse({ ...response, sp_change: { ...response.sp_change, grant: [{ ...grant, ...fields }] } }, sp2.applicationId), /invalid Databricks Connect response/);
  for (const value of [undefined, null, {}, [null], [{ kind: 'grant' }]]) {
    assert.throws(() => parseDatabricksConnectResponse({ ...response, cleanup_pending: value }, sp2.applicationId), /invalid Databricks Connect response/);
  }
  for (const kind of ['grant', 'revoke']) {
    const item = response.cleanup_pending.find((s) => s.kind === kind);
    for (const fields of [{ reason: 'binding_force_closed' }, { reason: 'binding_disconnected' }, { actor: 'account_admin' }, { command: 'run me' }, { id: null },
      { binding_id: null }, { instruction: null }, { [kind]: null }, { [kind]: { ...item[kind], only_if: 'unknown' } }]) {
      assert.throws(() => parseDatabricksConnectResponse({ ...response, cleanup_pending: [{ ...item, ...fields }] }, sp2.applicationId), /invalid Databricks Connect response/);
    }
  }
});

for (const action of ['endpoint_acl_add', 'folder_acl_add', 'manifest_secret_acl_put']) test(`refused ${action} stays pending and reports its ACL owner`, { timeout: 4900 }, async (t) => {
  const grant = persistedChange.sp_change.grant.find((s) => s.action === action);
  const calls = grantCalls(grant);
  const update = calls.at(-1);
  calls[calls.length - 1] = { ...update, status: 403, body: { error_code: 'PERMISSION_DENIED' } };
  const path = action === 'manifest_secret_acl_put' ? '/api/2.0/secrets/acls/list'
    : action === 'folder_acl_add' ? '/api/2.0/permissions/directories/999' : '/api/2.0/permissions/serving-endpoints/endpoint-id';
  calls.push(call('GET', path, action === 'manifest_secret_acl_put' ? { items: [{ principal: 'acl-owner', permission: 'MANAGE' }] }
    : { access_control_list: [{ user_name: 'acl-owner', all_permissions: [{ permission_level: 'IS_OWNER' }] }] }, 200,
  action === 'manifest_secret_acl_put' ? (r) => assert.equal(r.query.get('scope'), 'support-evals') : undefined));
  const server = await replay(t, plan({ agent: sp2, pending: [pendingStep('grant', grant, 'acl-refused')], changeCalls: calls, done: [] }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pending_steps[0].owner, 'acl-owner');
  assert.match(result.stderr, /Owner: acl-owner/);
  server.assertDone();
});

for (const status of [404, 500]) test(`manifest_table_grant table read ${status} ${status === 404 ? 'counts as done' : 'still fails'}`, { timeout: 4900 }, async (t) => {
  const grant = persistedChange.sp_change.grant.find((s) => s.action === 'manifest_table_grant');
  const calls = grantCalls(grant).slice(0, 3);
  calls[2] = { ...calls[2], status, body: { error_code: status === 404 ? 'RESOURCE_DOES_NOT_EXIST' : 'INTERNAL_ERROR' } };
  const p = plan({ agent: sp2, pending: [pendingStep('grant', grant, 'table-read')], changeCalls: calls });
  if (status === 500) p.calls.splice(p.calls.findIndex((c) => c.path.endsWith('/cleanup')));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, status === 404 ? 0 : 1, result.stderr);
  server.assertDone();
});

test('Connect executes and acknowledges only this binding\'s steps alongside an earlier closed binding\'s different SPs', { timeout: 4900 }, async (t) => {
  const current = structuredClone([persistedChange.cleanup_pending[0], persistedChange.cleanup_pending.at(-1)]);
  const inherited = structuredClone(current);
  // The earlier binding rotated in the opposite direction on this host/account.
  for (const item of inherited) {
    item.binding_id = 'dbxb_older';
    item[item.kind].principal.name = item.kind === 'grant' ? sp.applicationId : sp2.applicationId;
  }
  const p = plan({ existing: binding(sp2), agent: sp2, pending: [inherited[0], current[1], inherited[1], current[0]],
    changeCalls: [...grantCalls(current[0].grant), ...ucRevokeCalls(current[1].revoke)],
    done: current.map(({ kind, id }) => ({ kind, id })) });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).pending_steps, []);
  assert.equal(server.requests.filter((r) => r.path.endsWith('/cleanup')).length, 1);
  server.assertDone();
});

for (const binding_id of ['dbxb_recorded', 'dbxb_older']) test(`Connect rejects malformed cleanup_pending from ${binding_id} before the poll-key write`, { timeout: 4900 }, async (t) => {
  const p = plan();
  p.c.cleanup_pending = [{ ...persistedChange.cleanup_pending[0], binding_id, command: 'not allowed' }];
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.0/secrets/scopes/create'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid Databricks Connect response/);
  server.assertDone();
});

test('provider grants accept the UC conditions defined by the shared contract', { timeout: 4900 }, () => {
  for (const only_if of ['always', 'exists', 'exists_not_agent_owned']) {
    const response = { ...structuredClone(responseTemplate), ...structuredClone(persistedChange) };
    response.sp_change.grant[0].only_if = only_if;
    response.cleanup_pending[0].grant.only_if = only_if;
    assert.deepEqual(parseDatabricksConnectResponse(response, sp2.applicationId), response);
  }
});

// Contract variants come from server databricks-dto.ts on origin/main, 2026-10-30.
for (const [name, mutate] of [
  ['independent numeric cadences', (c) => { c.cadence_seconds = 900.5; c.agent_schedule.cadence_seconds = 1800.5; }],
  ['string poll-key prefix', (c) => { c.agent.poll_key_secret = 'custom-key'; }],
  ['independent job parameter strings', (c) => Object.assign(c.agent.job_parameters, { scope: 'other-scope', poll_key_name: 'other-key', job_id: 'server-job-id' })],
  ['empty UC privilege array', (c) => { c.grants[0].privileges = []; }]
]) test(`Connect replays DTO ${name}`, { timeout: 4900 }, async (t) => {
  const p = plan();
  mutate(p.c);
  if (name === 'string poll-key prefix') {
    p.calls.find((r) => r.path === '/api/2.0/secrets/put').check = (r) => assert.match(r.body.key, /^custom-key-[a-f0-9]{16}$/);
  }
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

for (const only_if of ['exists', 'exists_not_agent_owned']) test(`Connect grants replay DTO condition ${only_if}`, { timeout: 4900 }, async (t) => {
  const p = plan();
  p.c.grants[0].only_if = only_if;
  const at = p.calls.findIndex((r) => r.path === `${uc}/permissions/catalog/workspace`);
  p.calls.splice(at, 0, { method: 'GET', path: `${uc}/catalogs/workspace`, body: { owner: 'catalog-owner' }, status: 200 });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

for (const only_if of ['always', 'exists_not_agent_owned']) test(`Connect revokes replay DTO condition ${only_if} for the previous SP`, { timeout: 4900 }, async (t) => {
  const change = { ...inventoryRevokes()[1], object: 'catalog', only_if };
  const changeCalls = [
    ...(only_if === 'always' ? [] : [call('GET', `${uc}/schemas/workspace.br_design`, { owner: 'schema-owner' })]),
    call('PATCH', `${uc}/permissions/schema/workspace.br_design`, {}, 200,
      bodyIs({ changes: [{ principal: sp.applicationId, remove: ['USE_SCHEMA'] }] }))
  ];
  const server = await replay(t, plan({ newSp: true, change: [change], changeCalls }).calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});

// Mutate fixture-derived plans to exercise semantic errors that the DTO permits.
for (const source of ['sp_change', 'cleanup_pending']) for (const kind of ['grant', 'revoke']) {
  test(`${source} ${kind} checks every action's principal`, { timeout: 4900 }, () => {
    const steps = kind === 'grant' ? persistedChange.sp_change.grant : [...inventoryRevokes(), manifestRevoke(), manifestSecretRevoke()];
    for (const step of steps) {
      const valid = { ...structuredClone(responseTemplate), sp_change: null, cleanup_pending: [] };
      if (source === 'sp_change') valid.sp_change = { previous_agent_sp_application_id: sp.applicationId, grant: [], revoke: [], [kind]: [step] };
      else valid.cleanup_pending = [pendingStep(kind, step, 'safe')];
      assert.deepEqual(parseDatabricksConnectResponse(valid, sp2.applicationId), valid);
      const invalid = [
        { type: 'user', name: step.principal.name },
        { type: 'group', name: step.principal.name },
        principal(kind === 'grant' ? sp.applicationId : sp2.applicationId),
        ...(source === 'sp_change' && kind === 'revoke' ? [principal(clientId)] : [])
      ];
      for (const p of invalid) {
        const response = structuredClone(valid);
        const target = source === 'sp_change' ? response.sp_change[kind][0] : response.cleanup_pending[0][kind];
        target.principal = p;
        assert.throws(() => parseDatabricksConnectResponse(response, sp2.applicationId), /contract error.*principal must be/);
      }
    }
  });

  for (const type of ['user', 'group', 'service_principal']) test(`Connect refuses ${source} ${kind} with unsafe ${type} before scope or poll-key writes`, { timeout: 4900 }, async (t) => {
    const p = plan({ newSp: true });
    const step = structuredClone(persistedChange.sp_change[kind][0]);
    step.principal = { type, name: type === 'service_principal'
      ? kind === 'grant' ? sp.applicationId : sp2.applicationId : step.principal.name };
    if (source === 'sp_change') p.c.sp_change[kind] = [step];
    else {
      // Retry path: no sp_change, and a valid grant before an invalid revoke.
      p.c.sp_change = null;
      p.c.cleanup_pending = [pendingStep('grant', persistedChange.sp_change.grant[0], 'valid-first'), pendingStep(kind, step, 'unsafe')];
    }
    p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.0/secrets/scopes/create'));
    const server = await replay(t, p.calls);
    const result = await runCli(server, ['--json']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid Databricks Connect response.*contract error.*principal must be/);
    assert.equal(result.stdout, '');
    assert.equal(server.requests.at(-1).path, '/v1/databricks/bindings');
    server.assertDone();
  });
}

test('Connect refuses an SP-change revoke for an unrelated retired SP before workspace writes', { timeout: 4900 }, async (t) => {
  const p = plan({ newSp: true });
  p.c.sp_change.revoke = [{ ...persistedChange.sp_change.revoke[0], principal: principal(clientId) }];
  p.calls.splice(p.calls.findIndex((c) => c.path === '/api/2.0/secrets/scopes/create'));
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /contract error.*previous agent service principal/);
  server.assertDone();
});

test('Connect handles a DTO failed setup item with null failure', { timeout: 4900 }, async (t) => {
  const p = plan({ setupReads: [{ items: (items) => { items[0].state = 'failed'; items[0].failure = null; } }] });
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Databricks setup failed: volume/);
  assert.doesNotMatch(result.stderr, /invalid Databricks setup_items|Cannot destructure/);
  server.assertDone();
});

test('Connect replays structurally typed DTO fields without an exact-key restriction', { timeout: 4900 }, async (t) => {
  const p = plan();
  p.c.grants[0].description = 'Server context';
  p.c.sp_change = { previous_agent_sp_application_id: sp2.applicationId, grant: [], revoke: [], description: 'Server context' };
  const server = await replay(t, p.calls);
  const result = await runCli(server, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  server.assertDone();
});
