import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { emit } from './control-helpers.mjs';
import { customerPaths } from './control-api.mjs';
import { parseDatabricksConnectResponse, parseDatabricksSetupItems } from './databricks-contract.mjs';
import { DatabricksWorkspace, DatabricksError, workspaceHost, scim, rules, encode } from './databricks.mjs';
import { databricksControl, secretRedaction, exits, proofErrors, refusal, workspaceAdmin, numericId, readJob, runUcStep } from './databricks-helpers.mjs';
import { aclPrincipal, runPendingSpSteps } from './databricks-sp-steps.mjs';
import { renderDatabricksConnected } from './render.mjs';

export async function runDatabricksConnect(ctx) {
  const { remember, clean } = secretRedaction();
  try {
    const hostArg = ctx.stringArg('host');
    const catalog = ctx.stringArg('catalog');
    const schema = ctx.stringArg('schema');
    if (!hostArg || !catalog || !schema) return ctx.usage(1, 'databricks connect', 'Pass --host, --catalog, and --schema.');
    const host = workspaceHost(hostArg);
    const br = databricksControl(ctx);
    const log = (line) => { if (!ctx.args.json) process.stdout.write(`${line}\n`); };
    const workspace = new DatabricksWorkspace(host, remember, clean);
    log('1/8 Read the Databricks OAuth login and workspace admin identity.');
    const claims = await workspace.login();
    const metadata = await workspace.call('GET', '/.well-known/databricks-config', undefined, { anonymous: true });
    const workspaceId = String(metadata.workspace_id ?? '');
    if (!workspaceId || ![...workspaceId].every((c) => c >= '0' && c <= '9')) throw new Error('Could not read the numeric workspace id from Databricks.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(workspaceId)) throw refusal('The workspace id is not in the Databricks login token audience. Log in to this workspace and retry.', 'workspace_proof_invalid');
    const accountId = metadata.account_id ?? process.env.DATABRICKS_ACCOUNT_ID;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Databricks did not return its account id. Set DATABRICKS_ACCOUNT_ID from the account console and retry.');
    const me = await workspace.call('GET', `${scim}/Me`);
    const admin = workspaceAdmin(claims, me);
    const warehouseId = await selectWarehouse(workspace, ctx);

    log('2/8 Read the recorded binding and prepare its agent service principal.');
    const listed = await br(customerPaths.databricksBindings());
    if (!Array.isArray(listed.bindings)) throw new Error('BenchRouter returned an invalid Databricks binding list.');
    const open = listed.bindings.filter((b) => b.host === new URL(host).hostname && !['archived', 'disconnected'].includes(b.state));
    if (open.length > 1) throw new Error('BenchRouter returned several open bindings for this workspace.');
    const binding = open[0];
    if (binding?.disconnect_requested_at) throw refusal(proofErrors.binding_disconnecting, 'binding_disconnecting');
    const job = binding?.agent_job_id ? await readJob(workspace, binding.agent_job_id) : null;
    const selection = await prepareAgent(workspace, binding, job, admin, accountId);
    if (selection.created) log('Created a fresh agent service principal.');
    else if (selection.preserveRunAs) log('Reused the recorded agent job and kept its Run as identity.');
    else log('Reused the recorded agent service principal.');
    const sp = selection.sp;
    const spId = sp.applicationId;
    if (selection.preserveRunAs && (job?.settings?.run_as?.service_principal_name ?? job?.run_as_user_name) !== spId) {
      throw new Error('The recorded job no longer runs as the recorded agent SP.');
    }
    const settings = await workspace.call('GET', '/api/2.0/settings/types/restrict_workspace_admins/names/default');
    const status = settings.restrict_workspace_admins?.status;
    if (!['ALLOW_ALL', 'RESTRICT_TOKENS_AND_JOB_RUN_AS'].includes(status)) throw new Error('Databricks returned an unknown restrict_workspace_admins setting.');
    const restricted = status === 'RESTRICT_TOKENS_AND_JOB_RUN_AS';

    log('3/8 Mint an identity-only proof and register the workspace with BenchRouter.');
    // AUTH-012 / DATA-001: only this downscoped proof crosses the BenchRouter boundary.
    const proof = await workspace.proof();
    const request = {
      workspace_url: host, workspace_id: workspaceId, agent_sp_application_id: spId,
      workspace_proof: proof, catalog, schema, warehouse_id: warehouseId,
      databricks_account_id: accountId
    };
    for (const [flag, field] of [['results-group', 'results_group'], ['manage-group', 'manage_group']]) {
      const value = ctx.stringArg(flag);
      if (value) request[field] = value;
    }
    const response = await br(customerPaths.databricksConnect(request));
    remember(response?.poll_key);
    const connected = parseDatabricksConnectResponse(response);
    const expectedScope = `benchrouter-${createHash('sha256').update(spId.toLowerCase()).digest('hex').slice(0, 12)}`;
    if (connected.agent.secret_scope !== expectedScope) throw new Error('BenchRouter returned a scope that does not match the agent service principal.');
    if (connected.sp_change && connected.sp_change.previous_agent_sp_application_id === spId) throw new Error('BenchRouter returned an SP change targeting the current agent.');
    const scope = connected.agent.secret_scope;

    log('4/8 Create the secret scope, grant MANAGE, and write the poll key.');
    try { await workspace.call('POST', '/api/2.0/secrets/scopes/create', { scope, scope_backend_type: 'DATABRICKS' }); }
    catch (error) { if (!(error instanceof DatabricksError && error.code === 'RESOURCE_ALREADY_EXISTS')) throw error; }
    await workspace.call('POST', '/api/2.0/secrets/acls/put', { scope, principal: spId, permission: 'MANAGE' });
    // AUTH-012: the per-Connect nonce preserves another Connect's key and precedes every grant.
    await workspace.call('POST', '/api/2.0/secrets/put', { scope, key: `${connected.agent.poll_key_secret}-${randomBytes(8).toString('hex')}`, string_value: connected.poll_key });

    log('5/8 Apply the ordered catalog and schema grants.');
    for (const step of connected.grants) await runUcStep(workspace, step, spId, catalog, schema);
    log('6/8 Heal existing objects and run pending SP-change grants, then revokes.');
    for (const step of connected.heal) await runUcStep(workspace, step, spId, catalog, schema);
    const { pending_steps, skipped } = await runPendingSpSteps(workspace, br, connected.cleanup_pending,
      { id: connected.binding_id, agent_sp_application_id: spId, catalog, schema }, admin,
      (line) => process.stderr.write(clean(`${line}\n`)));
    for (const step of skipped) log(clean(`Skipped ${step.action === 'manifest_table_revoke' ? 'cases table revoke' : step.action} for ${step.route_key}: ${step.reason}.`));

    log('7/8 Create or reset the recorded agent job and replace its direct ACL.');
    const jobSettings = agentSettings(connected);
    // A.7: a second admin can reset with the same run_as without servicePrincipal.user.
    // Include it explicitly, since reset replaces settings and must not default to the admin.
    jobSettings.run_as = { service_principal_name: spId };
    let jobId;
    if (job) {
      jobId = numericId(binding.agent_job_id);
      await workspace.call('POST', '/api/2.2/jobs/reset', { job_id: jobId, new_settings: jobSettings });
    } else {
      const created = await workspace.call('POST', '/api/2.2/jobs/create', jobSettings);
      jobId = numericId(created.job_id);
    }
    const access = restricted
      ? [{ ...aclPrincipal(admin), permission_level: 'IS_OWNER' }, { service_principal_name: spId, permission_level: 'CAN_MANAGE' }]
      : [{ service_principal_name: spId, permission_level: 'IS_OWNER' }];
    await workspace.call('PUT', `/api/2.0/permissions/jobs/${jobId}`, { access_control_list: access });
    if (restricted) log('The workspace restriction keeps this admin as job owner. Removing the admin can stop the job.');
    await br(customerPaths.databricksRecordAgent(connected.binding_id, { agent_job_id: String(jobId), secret_scope: scope }));

    log('8/8 Start the agent job and wait for its run, setup items, and workspace verification.');
    const started = await workspace.call('POST', '/api/2.2/jobs/run-now', { job_id: jobId });
    const final = await waitForAgent(workspace, br, connected.binding_id, numericId(started.run_id), spId, catalog, schema);
    const result = JSON.parse(clean(JSON.stringify({ ok: true, binding_id: connected.binding_id, account_id: connected.account_id, state: final.binding.state, agent_job_id: String(jobId), agent_sp_application_id: spId, job_owner: restricted ? 'connecting_admin' : 'agent', setup_items: final.setup_items.map(({ kind, target, state }) => ({ kind, target, state })), skipped, pending_steps })));
    return emit(ctx, result, () => renderDatabricksConnected(result));
  } catch (error) {
    const code = error instanceof DatabricksError ? (Object.hasOwn(exits, error.code) || Object.hasOwn(proofErrors, error.code) ? error.code : 'databricks_request_failed') : 'command_failed';
    ctx.fail(clean(error instanceof Error ? error.message : 'Databricks Connect failed.'), code, exits[code] ?? 1);
  }
}

async function selectWarehouse(workspace, ctx) {
  const explicit = ctx.stringArg('warehouse');
  if (explicit) return explicit;
  const answer = await workspace.call('GET', '/api/2.0/sql/warehouses');
  const warehouses = (answer.warehouses ?? []).filter((w) => w.enable_serverless_compute === true);
  if (warehouses.length === 1) return warehouses[0].id;
  const choices = warehouses.map((w, i) => `${i + 1}. ${w.name} (${w.id})`).join('\n');
  if (warehouses.length === 0) throw new Error('No serverless warehouse was found. Pass --warehouse <id>.');
  if (ctx.args.json || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Several serverless warehouses were found. Pass --warehouse <id>:\n${choices}`);
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${choices}\n`);
    const selected = Number(await reader.question('Select a warehouse number: '));
    if (!Number.isInteger(selected) || selected < 1 || selected > warehouses.length) throw new Error('Select a listed warehouse with --warehouse <id>.');
    return warehouses[selected - 1].id;
  } finally { reader.close(); }
}

async function findRecordedSp(workspace, applicationId) {
  if (!applicationId) throw new Error('The binding has no recorded agent_sp_application_id. Deploy H1/H2 before Connect.');
  const query = new URLSearchParams({ filter: `applicationId eq ${JSON.stringify(applicationId)}` });
  const answer = await workspace.call('GET', `${scim}/ServicePrincipals?${query}`);
  return (answer.Resources ?? []).find((s) => s.applicationId === applicationId && s.active !== false) ?? null;
}
async function prepareAgent(workspace, binding, job, admin, accountId) {
  let sp = binding ? await findRecordedSp(workspace, binding.agent_sp_application_id) : null;
  let created = false;
  let preserveRunAs = false;
  let ruleSet;
  const ruleName = (id) => `accounts/${accountId}/servicePrincipals/${id}/ruleSets/default`;
  const readRules = (id) => workspace.call('GET', `${rules}?${new URLSearchParams({ name: ruleName(id), etag: '' })}`);
  const member = `${admin.type === 'service_principal' ? 'servicePrincipals' : 'users'}/${admin.name}`;
  if (sp) {
    try { ruleSet = await readRules(sp.applicationId); }
    catch (error) {
      if (!(error instanceof DatabricksError && ([401, 403].includes(error.status) || ['PERMISSION_DENIED', 'UNAUTHORIZED'].includes(error.code)))) throw error;
    }
    const canUse = ruleSet?.grant_rules?.some((r) => r.role === 'roles/servicePrincipal.user' && r.principals?.includes(member));
    if (!canUse) {
      if (job) preserveRunAs = true;
      else sp = null;
    }
  }
  if (!sp) {
    sp = await workspace.call('POST', `${scim}/ServicePrincipals`, { displayName: `benchrouter-agent-${randomBytes(4).toString('hex')}`, entitlements: [{ value: 'workspace-access' }, { value: 'databricks-sql-access' }] });
    created = true;
    const retry = newSpRuleRetry();
    ruleSet = await retry(() => readRules(sp.applicationId));
    const name = ruleName(sp.applicationId);
    await retry(() => workspace.call('PUT', rules, { name, rule_set: { name, etag: ruleSet.etag, grant_rules: [...(ruleSet.grant_rules ?? []), { role: 'roles/servicePrincipal.user', principals: [member] }] } }));
  }
  if (typeof sp.id !== 'string' || typeof sp.applicationId !== 'string') throw new Error('Databricks returned an invalid service principal.');
  // A.7: another admin can keep the job's Run as identity without a role on its SP.
  if (!preserveRunAs) {
    const entitlements = [...new Set([...(sp.entitlements ?? []).map((e) => e.value), 'workspace-access', 'databricks-sql-access'])];
    await workspace.call('PATCH', `${scim}/ServicePrincipals/${encode(sp.id)}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'add', path: 'entitlements', value: entitlements.map((value) => ({ value })) }] });
    await removeOAuthSecrets(workspace, sp.id);
  }
  return { sp, created, preserveRunAs };
}
// Only a newly created SP can have propagation delay. Share the 60 s budget across GET and PUT.
function newSpRuleRetry() {
  // Test-only: shorten waits only when Databricks uses the validated loopback replay boundary.
  const override = process.env.BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS;
  const wait = override !== undefined && process.env.BENCHROUTER_DATABRICKS_API_BASE ? Number(override) : null;
  if (wait !== null && (!Number.isSafeInteger(wait) || wait < 0 || wait > 100)) throw new Error('Invalid test rule-set retry delay.');
  const waits = [2000, 4000, 8000, 16000, 30000];
  let attempt = 0;
  return async (call) => {
    for (;;) {
      try { return await call(); } catch (error) {
        if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED')) || attempt === waits.length) throw error;
        await delay(wait ?? waits[attempt]);
        attempt++;
      }
    }
  };
}
async function removeOAuthSecrets(workspace, id) {
  const path = `/api/2.0/accounts/servicePrincipals/${encode(id)}/credentials/secrets`;
  let page;
  const ids = [];
  do {
    const answer = await workspace.call('GET', `${path}${page ? `?${new URLSearchParams({ page_token: page })}` : ''}`);
    for (const secret of answer.secrets ?? []) ids.push(secret.id);
    page = answer.next_page_token;
  } while (page);
  for (const id of ids) await workspace.call('DELETE', `${path}/${encode(id)}`);
}
function agentSettings({ agent, agent_schedule: schedule }) {
  return {
    name: 'BenchRouter agent', max_concurrent_runs: agent.max_concurrent_runs, queue: { enabled: true },
    schedule: { quartz_cron_expression: schedule.quartz_cron_expression, timezone_id: schedule.timezone_id, pause_status: 'UNPAUSED' },
    tasks: [{ task_key: 'agent', environment_key: 'agent', max_retries: 0, disable_auto_optimization: true,
      python_wheel_task: { package_name: agent.package, entry_point: agent.entry_point, named_parameters: agent.job_parameters } }],
    environments: [{ environment_key: 'agent', spec: agent.environment }]
  };
}
function expectedSetupItems(bindingId, catalog, schema) {
  // Server setup item targets, confirmed live in H8 (2026-10-30).
  return [
    { kind: 'volume', target: `${catalog}.${schema}.benchrouter_artifacts` },
    { kind: 'volume', target: `${catalog}.${schema}.benchrouter_results` },
    { kind: 'results_table', target: `${catalog}.${schema}.benchrouter_eval_results` },
    { kind: 'experiment', target: `/Shared/benchrouter/${bindingId}` },
    { kind: 'eval_job', target: `benchrouter-eval-${bindingId}` }
  ];
}
async function waitForAgent(workspace, br, bindingId, runId, spId, catalog, schema) {
  const deadline = Date.now() + 180000;
  const expected = expectedSetupItems(bindingId, catalog, schema);
  let pending = expected;
  while (Date.now() < deadline) {
    const run = await workspace.call('GET', `/api/2.2/jobs/runs/get?run_id=${runId}`);
    const view = await br(customerPaths.databricksBinding(bindingId));
    if (!view.binding || view.binding.agent_sp_application_id !== spId || view.binding.disconnect_requested_at || ['disconnected', 'archived'].includes(view.binding.state)) throw new Error('The binding changed or closed during Connect. Run connect again.');
    const items = parseDatabricksSetupItems(view.setup_items);
    const failed = items.find((item) => item.state === 'failed');
    if (failed) {
      const { title, message, owner } = failed.failure;
      throw new Error(`${title}: ${message} (owner: ${owner}).${owner === 'customer' ? ' A workspace admin must fix it.' : ''}`);
    }
    // The binding read returns the newest non-cancelled row per (kind, target).
    pending = expected.filter(({ kind, target }) => !items.some((item) => item.kind === kind && item.state === 'done'
      && (kind === 'volume' || kind === 'results_table' ? item.target.toLowerCase() === target.toLowerCase() : item.target === target)));
    if (['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR'].includes(run.state?.life_cycle_state)) {
      if (run.state.result_state !== 'SUCCESS') throw new Error('The agent job did not finish successfully. Check the recorded job in Databricks.');
      if (view.binding.state === 'verified' && pending.length === 0) return { ...view, setup_items: items };
    }
    await delay(1000);
  }
  const waiting = pending.length ? ` Waiting for missing or incomplete setup items: ${pending.map((item) => `${item.kind} ${item.target}`).join(', ')}.` : '';
  throw new Error(`Timed out waiting for the agent run, setup items, and workspace verification.${waiting} Check the agent job and run connect again.`);
}
