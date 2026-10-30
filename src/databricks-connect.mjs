import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { accountClient, emit } from './control-helpers.mjs';
import { apiRequest, ApiError } from './http.mjs';
import { customerPaths } from './control-api.mjs';
import { parseDatabricksConnectResponse, parseDatabricksSetupItems } from './databricks-contract.mjs';
import { DatabricksWorkspace, DatabricksError, workspaceHost, scim, rules, uc, ucPaths, encode } from './databricks.mjs';
import { renderDatabricksConnected } from './render.mjs';

const exits = { grant_refused: 3, workspace_admin_required: 4, pat_login: 5, databricks_login_required: 1, databricks_auth_unsupported: 1 };
const proofErrors = {
  workspace_proof_invalid: 'The workspace proof was refused. Log in to Databricks again and retry.',
  workspace_admin_required: 'Connect requires a Databricks workspace admin. Log in as a workspace admin and retry.',
  workspace_proof_replayed: 'The workspace proof was already used. Run connect again for a fresh proof.',
  workspace_unreachable: 'BenchRouter could not reach the workspace to verify its proof.',
  workspace_connected_elsewhere: 'This workspace is connected to another BenchRouter account.',
  binding_disconnecting: 'This workspace is disconnecting. Wait for it to finish before Connect.'
};
function refusal(message, code = 'grant_refused') { return new DatabricksError(message, code); }
function numericId(value) {
  const text = String(value ?? '');
  if (!text || ![...text].every((c) => c >= '0' && c <= '9') || BigInt(text) <= 0n || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Databricks returned an invalid numeric object id.');
  return Number(text);
}
function aclPrincipal(p) {
  return { [p.type === 'user' ? 'user_name' : p.type === 'group' ? 'group_name' : 'service_principal_name']: p.name };
}
function samePrincipal(entry, p) { return Object.entries(aclPrincipal(p)).every(([key, value]) => entry[key] === value); }

export async function runDatabricksConnect(ctx) {
  const secrets = new Set();
  const remember = (s) => { if (typeof s === 'string' && s) secrets.add(s); };
  const clean = (s) => {
    let result = String(s);
    for (const secret of secrets) {
      for (const representation of new Set([secret, encode(secret), JSON.stringify(secret).slice(1, -1)])) result = result.split(representation).join('[redacted]');
    }
    return result;
  };
  try {
    const hostArg = ctx.stringArg('host');
    const catalog = ctx.stringArg('catalog');
    const schema = ctx.stringArg('schema');
    if (!hostArg || !catalog || !schema) return ctx.usage(1, 'databricks connect', 'Pass --host, --catalog, and --schema.');
    const host = workspaceHost(hostArg);
    // AUTH-006: reuse the CLI control-token login, resolved before workspace mutations.
    const control = accountClient(ctx);
    const br = async (spec) => {
      try { return await apiRequest({ ...control, ...spec }); } catch (error) {
        if (error instanceof ApiError) throw refusal(proofErrors[error.code] ?? `BenchRouter Databricks request failed (${error.status}).`, Object.hasOwn(proofErrors, error.code) ? error.code : 'benchrouter_request_failed');
        throw new Error('BenchRouter Databricks request failed.');
      }
    };
    const log = (line) => { if (!ctx.args.json) process.stdout.write(`${line}\n`); };
    const workspace = new DatabricksWorkspace(host, remember);
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
    const admin = me.applicationId ? { type: 'service_principal', name: me.applicationId } : { type: 'user', name: me.userName };
    if (!admin.name || !me.groups?.some((g) => g.display === 'admins')) throw refusal(proofErrors.workspace_admin_required, 'workspace_admin_required');
    const warehouseId = await selectWarehouse(workspace, ctx);

    log('2/8 Read the recorded binding and prepare its agent service principal.');
    const { body: listed, headers } = await br({ ...customerPaths.databricksBindings(), includeHeaders: true });
    // The server Date rounds down to seconds and precedes the register batch.
    // Use its clock so an admin's laptop clock cannot make fresh items look old.
    const connectStartedAt = Date.parse(headers.get('date'));
    if (!Number.isFinite(connectStartedAt)) throw new Error('BenchRouter Databricks binding list response has a missing or invalid HTTP Date header. Connect requires the server clock. Retry Connect.');
    if (!Array.isArray(listed.bindings)) throw new Error('BenchRouter returned an invalid Databricks binding list.');
    const open = listed.bindings.filter((b) => b.host === new URL(host).hostname && !['archived', 'disconnected'].includes(b.state));
    if (open.length > 1) throw new Error('BenchRouter returned several open bindings for this workspace.');
    const binding = open[0];
    if (binding?.disconnect_requested_at) throw refusal(proofErrors.binding_disconnecting, 'binding_disconnecting');
    const job = binding?.agent_job_id ? await workspace.optional('GET', `/api/2.2/jobs/get?job_id=${encode(binding.agent_job_id)}`) : null;
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
    log('6/8 Heal existing objects and revoke the previous agent service principal.');
    for (const step of connected.heal) await runUcStep(workspace, step, spId, catalog, schema);
    for (const step of connected.sp_change?.revoke ?? []) await runRevoke(workspace, step, admin, spId, catalog, schema);

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
    const final = await waitForAgent(workspace, br, connected.binding_id, numericId(started.run_id), spId, connectStartedAt);
    const result = { ok: true, binding_id: connected.binding_id, account_id: connected.account_id, state: final.binding.state, agent_job_id: String(jobId), agent_sp_application_id: spId, job_owner: restricted ? 'connecting_admin' : 'agent', setup_items: final.setup_items.map(({ kind, target, state }) => ({ kind, target, state })) };
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
    ruleSet = await readRules(sp.applicationId);
    await workspace.call('PUT', rules, { name: ruleName(sp.applicationId), rule_set: { etag: ruleSet.etag, grant_rules: [...(ruleSet.grant_rules ?? []), { role: 'roles/servicePrincipal.user', principals: [member] }] } });
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
function objectPath(step) { return `${uc}/${ucPaths[step.securable]}/${encode(step.full_name)}`; }
async function runUcStep(workspace, step, spId, catalog, schema) {
  let object;
  try {
    if (step.only_if !== 'always') {
      object = await workspace.optional('GET', objectPath(step));
      if (!object || (step.only_if === 'exists_not_agent_owned' && object.owner === spId)) return;
    }
    if (step.action === 'set_owner') await workspace.call('PATCH', objectPath(step), { owner: step.principal.name });
    else await workspace.call('PATCH', `${uc}/permissions/${step.securable}/${encode(step.full_name)}`, { changes: [{ principal: step.principal.name, [step.action === 'grant' ? 'add' : 'remove']: step.privileges }] });
  } catch (error) {
    if (!(error instanceof DatabricksError && error.code === 'PERMISSION_DENIED')) throw error;
    const owner = async (path) => { try { return (await workspace.call('GET', path)).owner ?? 'unknown'; } catch { return 'unknown'; } };
    const catalogOwner = await owner(`${uc}/catalogs/${encode(catalog)}`);
    const schemaOwner = await owner(`${uc}/schemas/${encode(`${catalog}.${schema}`)}`);
    throw refusal(`Databricks refused ${step.action} on ${step.full_name}. Catalog owner: ${catalogOwner}. Schema owner: ${schemaOwner}.${step.only_if !== 'always' ? ` Object owner: ${object?.owner ?? 'unknown'}.` : ''} Ask the owner or a metastore admin to run connect.`);
  }
}
async function removeAcl(workspace, path, principal, admin) {
  const existing = await workspace.optional('GET', path);
  if (!existing) return;
  let removedOwner = false;
  const list = [];
  for (const entry of existing.access_control_list ?? []) {
    const direct = (entry.all_permissions ?? []).filter((p) => p.inherited !== true);
    if (samePrincipal(entry, principal)) { removedOwner ||= direct.some((p) => p.permission_level === 'IS_OWNER'); continue; }
    for (const permission of direct) {
      const field = ['user_name', 'service_principal_name', 'group_name'].find((key) => typeof entry[key] === 'string');
      if (field) list.push({ [field]: entry[field], permission_level: permission.permission_level });
    }
  }
  if (removedOwner) {
    for (let i = list.length - 1; i >= 0; i--) if (samePrincipal(list[i], admin)) list.splice(i, 1);
    list.push({ ...aclPrincipal(admin), permission_level: 'IS_OWNER' });
  }
  await workspace.call('PUT', path, { access_control_list: list });
}
async function runRevoke(workspace, step, admin, spId, catalog, schema) {
  if (step.action === 'revoke') return runUcStep(workspace, step, spId, catalog, schema);
  if (step.action === 'secret_acl_delete') {
    const found = await workspace.optional('GET', `/api/2.0/secrets/acls/get?${new URLSearchParams({ scope: step.scope, principal: step.principal.name })}`);
    if (found) await workspace.call('POST', '/api/2.0/secrets/acls/delete', { scope: step.scope, principal: step.principal.name });
  } else if (step.action === 'job_acl_remove') await removeAcl(workspace, `/api/2.0/permissions/jobs/${encode(step.job_id)}`, step.principal, admin);
  else if (step.action === 'endpoint_acl_remove') {
    const endpoint = await workspace.optional('GET', `/api/2.0/serving-endpoints/${encode(step.endpoint_name)}`);
    if (endpoint) await removeAcl(workspace, `/api/2.0/permissions/serving-endpoints/${encode(endpoint.id)}`, step.principal, admin);
  } else if (step.action === 'folder_acl_remove') {
    const folder = await workspace.optional('GET', `/api/2.0/workspace/get-status?${new URLSearchParams({ path: step.path })}`);
    if (folder) await removeAcl(workspace, `/api/2.0/permissions/directories/${encode(folder.object_id)}`, step.principal, admin);
  }
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
async function waitForAgent(workspace, br, bindingId, runId, spId, connectStartedAt) {
  const deadline = Date.now() + 180000;
  let pending = [];
  while (Date.now() < deadline) {
    const run = await workspace.call('GET', `/api/2.2/jobs/runs/get?run_id=${runId}`);
    const view = await br(customerPaths.databricksBinding(bindingId));
    if (!view.binding || view.binding.agent_sp_application_id !== spId || view.binding.disconnect_requested_at || ['disconnected', 'archived'].includes(view.binding.state)) throw new Error('The binding changed or closed during Connect. Run connect again.');
    const items = parseDatabricksSetupItems(view.setup_items);
    const fresh = (item) => Date.parse(item.queued_at) >= connectStartedAt;
    const failed = items.find((item) => fresh(item) && item.state === 'failed');
    if (failed) {
      const { title, message, owner } = failed.failure;
      throw new Error(`${title}: ${message} (owner: ${owner}).${owner === 'customer' ? ' A workspace admin must fix it.' : ''}`);
    }
    pending = items.filter((item) => item.kind !== 'serving_endpoint' && (item.state !== 'done' || !fresh(item)));
    if (['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR'].includes(run.state?.life_cycle_state)) {
      if (run.state.result_state !== 'SUCCESS') throw new Error('The agent job did not finish successfully. Check the recorded job in Databricks.');
      if (view.binding.state === 'verified' && pending.length === 0) return { ...view, setup_items: items };
    }
    await delay(1000);
  }
  const waiting = pending.length ? ` Waiting for setup items from this Connect: ${pending.map((item) => `${item.kind} ${item.target}`).join(', ')}.` : '';
  throw new Error(`Timed out waiting for the agent run, setup items, and workspace verification.${waiting} Check the agent job and run connect again.`);
}
