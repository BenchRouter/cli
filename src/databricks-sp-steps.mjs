import { spStepTarget, validateCleanup } from './databricks-contract.mjs';
import { customerPaths } from './control-api.mjs';
import { DatabricksError, encode, uc, isMissing } from './databricks.mjs';
import { runUcStep } from './databricks-helpers.mjs';
import { readWorkspaceEvalGrants } from './databricks-eval-manifest.mjs';

export function aclPrincipal(p) {
  return { [p.type === 'user' ? 'user_name' : p.type === 'group' ? 'group_name' : 'service_principal_name']: p.name };
}
function samePrincipal(entry, p) { return Object.entries(aclPrincipal(p)).every(([key, value]) => entry[key] === value); }

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
async function runRevoke(workspace, step, admin, spId, catalog, schema, diagnostic) {
  if (step.action === 'revoke') return runUcStep(workspace, step, spId, catalog, schema);
  if (step.action === 'manifest_table_revoke') {
    const { grants, reason } = await readWorkspaceEvalGrants(workspace, step.eval_folder, step.route_key, { skipUnavailable: true });
    if (reason) return reason;
    const [casesCatalog, casesSchema] = grants.casesTable.split('.');
    try {
      // The PATCH itself checks existence. Reuse UC owner diagnostics on refusal.
      await runUcStep(workspace, { action: 'revoke', securable: 'table', full_name: grants.casesTable, principal: step.principal, privileges: ['SELECT'], only_if: 'always' }, spId, casesCatalog, casesSchema);
    } catch (error) {
      if (isMissing(error)) return 'cases table is missing';
      throw error;
    }
    return;
  }
  if (step.action === 'manifest_secret_acl_delete') {
    const { grants, reason } = await readWorkspaceEvalGrants(workspace, step.eval_folder, step.route_key, { skipUnavailable: true });
    if (reason) return reason;
    for (const scope of grants.secretScopes) {
      diagnostic.read = () => workspace.call('GET', `/api/2.0/secrets/acls/list?${new URLSearchParams({ scope })}`);
      try {
        await workspace.call('POST', '/api/2.0/secrets/acls/delete', { scope, principal: step.principal.name });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  } else if (step.action === 'secret_acl_delete') {
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

export const isSpStep = (step) => step.kind === 'grant' || step.kind === 'revoke';

async function runGrant(workspace, step, b, diagnostic) {
  if (step.action === 'grant') return runUcStep(workspace, step, b.agent_sp_application_id, b.catalog, b.schema);
  if (step.action === 'endpoint_acl_add' || step.action === 'folder_acl_add') {
    const endpoint = step.action === 'endpoint_acl_add';
    const path = endpoint ? `/api/2.0/serving-endpoints/${encode(step.endpoint_name)}`
      : `/api/2.0/workspace/get-status?${new URLSearchParams({ path: step.path })}`;
    diagnostic.read = () => workspace.call('GET', path);
    const object = await workspace.optional('GET', path);
    if (!object) return;
    const acl = `/api/2.0/permissions/${endpoint ? 'serving-endpoints' : 'directories'}/${encode(endpoint ? object.id : object.object_id)}`;
    diagnostic.read = () => workspace.call('GET', acl);
    await workspace.call('PATCH', acl, { access_control_list: [{ ...aclPrincipal(step.principal), permission_level: step.permission }] });
    return;
  }
  diagnostic.read = () => workspace.call('GET', `/api/2.0/workspace/get-status?${new URLSearchParams({ path: step.eval_folder })}`);
  const { grants, reason } = await readWorkspaceEvalGrants(workspace, step.eval_folder, step.route_key, { skipUnavailable: true });
  if (reason) return reason;
  if (step.action === 'manifest_table_grant') {
    const [catalog, schema] = grants.casesTable.split('.');
    // Match add-eval: namespace access when the cases table is outside the binding schema.
    diagnostic.read = () => workspace.call('GET', `${uc}/tables/${encode(grants.casesTable)}`);
    const table = await workspace.optional('GET', `${uc}/tables/${encode(grants.casesTable)}`);
    if (!table) return;
    const steps = [];
    if (catalog.toLowerCase() !== b.catalog.toLowerCase()) steps.push(['catalog', catalog, ['USE_CATALOG']]);
    if (catalog.toLowerCase() !== b.catalog.toLowerCase() || schema.toLowerCase() !== b.schema.toLowerCase()) steps.push(['schema', `${catalog}.${schema}`, ['USE_SCHEMA']]);
    steps.push(['table', grants.casesTable, step.privileges]);
    for (const [securable, full_name, privileges] of steps) {
      diagnostic.read = () => workspace.call('GET', `${uc}/tables/${encode(grants.casesTable)}`);
      await runUcStep(workspace, { action: 'grant', securable, full_name, principal: step.principal, privileges, only_if: 'always' }, b.agent_sp_application_id, catalog, schema);
    }
  } else {
    for (const scope of grants.secretScopes) {
      diagnostic.read = () => workspace.call('GET', `/api/2.0/secrets/acls/list?${new URLSearchParams({ scope })}`);
      await workspace.call('POST', '/api/2.0/secrets/acls/put', { scope, principal: step.principal.name, permission: step.permission });
    }
  }
}
async function stepOwner(workspace, step, diagnostic) {
  try {
    let value;
    if (diagnostic.read) value = await diagnostic.read();
    else if (step.action === 'job_acl_remove') value = await workspace.call('GET', `/api/2.0/permissions/jobs/${encode(step.job_id)}`);
    else if (step.action === 'secret_acl_delete') value = await workspace.call('GET', `/api/2.0/secrets/acls/list?${new URLSearchParams({ scope: step.scope })}`);
    else if (step.action === 'endpoint_acl_remove') {
      const endpoint = await workspace.call('GET', `/api/2.0/serving-endpoints/${encode(step.endpoint_name)}`);
      value = await workspace.call('GET', `/api/2.0/permissions/serving-endpoints/${encode(endpoint.id)}`);
    } else {
      const folder = await workspace.call('GET', `/api/2.0/workspace/get-status?${new URLSearchParams({ path: step.path ?? step.eval_folder })}`);
      value = await workspace.call('GET', `/api/2.0/permissions/directories/${encode(folder.object_id)}`);
    }
    const owner = value?.access_control_list?.find((a) => a.all_permissions?.some((p) => p.permission_level === 'IS_OWNER'));
    return value?.owner ?? owner?.user_name ?? owner?.service_principal_name ?? owner?.group_name
      ?? (value?.items?.filter((a) => a.permission === 'MANAGE').map((a) => a.principal).join(', ') || 'unknown');
  } catch { return 'unknown'; }
}

export async function runPendingSpSteps(workspace, br, steps, binding, admin, warn) {
  validateCleanup(steps, binding.agent_sp_application_id, binding.id);
  const done = [], pending_steps = [], skipped = [];
  for (const kind of ['grant', 'revoke']) for (const item of steps.filter((s) => s.kind === kind && s.binding_id === binding.id)) {
    const step = item[kind];
    const diagnostic = {};
    try {
      const reason = kind === 'grant' ? await runGrant(workspace, step, binding, diagnostic)
        : await runRevoke(workspace, step, admin, binding.agent_sp_application_id, binding.catalog, binding.schema, diagnostic);
      if (reason) {
        skipped.push({ object: step.object, action: step.action, route_key: step.route_key, eval_folder: step.eval_folder, reason });
        // A malformed or changed manifest cannot determine safe grants or revokes.
        if (!['eval folder is missing', 'eval manifest is missing', 'cases table is missing'].includes(reason)) {
          const pending = { kind, id: item.id, action: step.action, object: step.object, target: spStepTarget(step), reason };
          pending_steps.push(pending);
          warn(`Warning: Pending ${kind} ${item.id}: ${step.action} on ${step.object} ${pending.target}. Reason: ${reason}. Fix the eval manifest and re-run benchrouter databricks connect.`);
          continue;
        }
      }
      done.push({ kind, id: item.id });
    } catch (error) {
      if (isMissing(error)) { done.push({ kind, id: item.id }); continue; }
      if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED' || error.code === 'grant_refused'))) throw error;
      const owner = error.owner ?? await stepOwner(workspace, step, diagnostic);
      const pending = { kind, id: item.id, action: step.action, object: step.object, target: spStepTarget(step), owner };
      pending_steps.push(pending);
      warn(`Warning: Pending ${kind} ${item.id}: ${step.action} on ${step.object} ${pending.target}. Owner: ${owner}. Re-run benchrouter databricks connect as that owner or a metastore admin.`);
    }
  }
  if (done.length) await br(customerPaths.databricksCleanup(binding.id, { done }));
  return { pending_steps, skipped };
}
