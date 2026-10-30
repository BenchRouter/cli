// Source: server src/shared/databricks-dto.ts, including follow-up H (2026-10-30).
// AUTH-012: validate the complete plan before any workspace write using its fields.
/**
 * @typedef {{type: 'user'|'service_principal'|'group', name: string}} DatabricksPrincipal
 * @typedef {'catalog'|'schema'|'volume'|'table'|'model_provider_service'} DatabricksUcSecurable
 * @typedef {'USE_CATALOG'|'USE_SCHEMA'|'CREATE_TABLE'|'CREATE_VOLUME'|'CREATE_SERVICE'|'SELECT'|'MODIFY'|'READ_VOLUME'|'WRITE_VOLUME'|'MANAGE'|'EXECUTE'} DatabricksUcPrivilege
 * @typedef {'always'|'exists'|'exists_not_agent_owned'} DatabricksStepCondition
 * @typedef {{action: 'grant'|'revoke', securable: DatabricksUcSecurable, full_name: string,
 *   principal: DatabricksPrincipal, privileges: DatabricksUcPrivilege[], only_if: DatabricksStepCondition} |
 *   {action: 'set_owner', securable: 'volume'|'table', full_name: string,
 *   principal: DatabricksPrincipal, only_if: DatabricksStepCondition}} DatabricksUcStep
 * @typedef {(DatabricksUcStep & {action: 'grant', object: 'provider_service', securable: 'model_provider_service', privileges: ['MANAGE']}) |
 *   {object: 'serving_endpoint', action: 'endpoint_acl_add', endpoint_name: string, principal: DatabricksPrincipal, permission: 'CAN_MANAGE', only_if: 'exists'} |
 *   {object: 'eval_folder', action: 'folder_acl_add', path: string, principal: DatabricksPrincipal, permission: 'CAN_READ', only_if: 'exists'} |
 *   {object: 'cases_table', action: 'manifest_table_grant', route_key: string, eval_folder: string, principal: DatabricksPrincipal, privileges: ['SELECT'], only_if: 'exists'} |
 *   {object: 'secret_scope', action: 'manifest_secret_acl_put', route_key: string, eval_folder: string, principal: DatabricksPrincipal, permission: 'READ', only_if: 'exists'}} DatabricksGrantStep
 * @typedef {(DatabricksUcStep & {action: 'revoke', object: 'catalog'|'schema'|'results_table'|'provider_service'}) |
 *   {object: 'cases_table', action: 'manifest_table_revoke', route_key: string, eval_folder: string,
 *   principal: DatabricksPrincipal, privileges: ['SELECT'], only_if: 'exists'} |
 *   {object: 'secret_scope', action: 'secret_acl_delete', scope: string, principal: DatabricksPrincipal, only_if: 'exists'} |
 *   {object: 'secret_scope', action: 'manifest_secret_acl_delete', eval_folder: string, route_key: string, principal: DatabricksPrincipal, only_if: 'exists'} |
 *   {object: 'agent_job'|'eval_job', action: 'job_acl_remove', job_id: string, principal: DatabricksPrincipal, only_if: 'exists'} |
 *   {object: 'serving_endpoint', action: 'endpoint_acl_remove', endpoint_name: string, principal: DatabricksPrincipal, only_if: 'exists'} |
 *   {object: 'eval_folder', action: 'folder_acl_remove', path: string, principal: DatabricksPrincipal, only_if: 'exists'}} DatabricksRevokeStep
 * @typedef {{binding_id: string, account_id: string, poll_key: string, state: 'connecting'|'verified'|'agent_silent',
 *   cadence_seconds: number, agent_schedule: {cadence_seconds: number, quartz_cron_expression: string, timezone_id: 'UTC'},
 *   agent: {secret_scope: string, poll_key_secret: string, package: 'benchrouter_databricks', entry_point: 'agent',
 *     job_parameters: {api_base: string, scope: string, poll_key_name: string, job_id: string},
 *     max_concurrent_runs: 1, environment: Record<string, unknown>},
 *   grants: DatabricksUcStep[], heal: DatabricksUcStep[],
 *   sp_change: {previous_agent_sp_application_id: string, grant: DatabricksGrantStep[], revoke: DatabricksRevokeStep[]}|null, cleanup_pending: object[]}} DatabricksConnectResponse
 * @typedef {{code: string, failed_at: string|null, owner: 'customer'|'unknown', title: string, message: string}} DatabricksFailure
 * @typedef {{kind: 'volume'|'results_table'|'experiment'|'eval_job'|'serving_endpoint', target: string,
 *   state: 'pending'|'done'|'failed', queued_at: string, failure: DatabricksFailure|null}} DatabricksSetupItemView
 */
const securables = new Set(['catalog', 'schema', 'volume', 'table', 'model_provider_service']);
const privileges = new Set(['USE_CATALOG', 'USE_SCHEMA', 'CREATE_TABLE', 'CREATE_VOLUME', 'CREATE_SERVICE', 'SELECT', 'MODIFY', 'READ_VOLUME', 'WRITE_VOLUME', 'MANAGE', 'EXECUTE']);
const conditions = new Set(['always', 'exists_not_agent_owned', 'exists']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string';
const nullableString = (v) => v === null || string(v);
const number = (v) => typeof v === 'number' && Number.isFinite(v);
const strings = (v, keys) => keys.every((key) => string(v[key]));
const principal = (v) => object(v) && ['user', 'service_principal', 'group'].includes(v.type) && string(v.name);
const singleton = (v, item) => Array.isArray(v) && v.length === 1 && v[0] === item;
function ucStep(s) {
  return object(s) && securables.has(s.securable) && string(s.full_name) && principal(s.principal) && conditions.has(s.only_if)
    && (s.action === 'set_owner' ? ['volume', 'table'].includes(s.securable)
      : ['grant', 'revoke'].includes(s.action) && Array.isArray(s.privileges) && s.privileges.every((p) => privileges.has(p)));
}
function revokeStep(s) {
  if (!object(s) || !principal(s.principal)) return false;
  if (s.action === 'revoke') return ucStep(s) && ['catalog', 'schema', 'results_table', 'provider_service'].includes(s.object);
  if (s.only_if !== 'exists') return false;
  if (s.action === 'manifest_table_revoke') return s.object === 'cases_table'
    && strings(s, ['route_key', 'eval_folder']) && singleton(s.privileges, 'SELECT');
  if (s.action === 'secret_acl_delete') return s.object === 'secret_scope' && string(s.scope);
  if (s.action === 'manifest_secret_acl_delete') return s.object === 'secret_scope' && strings(s, ['eval_folder', 'route_key']);
  if (s.action === 'job_acl_remove') return ['agent_job', 'eval_job'].includes(s.object) && string(s.job_id);
  if (s.action === 'endpoint_acl_remove') return s.object === 'serving_endpoint' && string(s.endpoint_name);
  if (s.action === 'folder_acl_remove') return s.object === 'eval_folder' && string(s.path);
  return false;
}
function grantStep(s) {
  if (!object(s) || !principal(s.principal)) return false;
  if (s.action === 'grant') return ucStep(s) && s.object === 'provider_service'
    && s.securable === 'model_provider_service' && singleton(s.privileges, 'MANAGE');
  if (s.only_if !== 'exists') return false;
  if (s.action === 'endpoint_acl_add') return s.object === 'serving_endpoint' && string(s.endpoint_name) && s.permission === 'CAN_MANAGE';
  if (s.action === 'folder_acl_add') return s.object === 'eval_folder' && string(s.path) && s.permission === 'CAN_READ';
  if (!strings(s, ['eval_folder', 'route_key'])) return false;
  if (s.action === 'manifest_table_grant') return s.object === 'cases_table' && singleton(s.privileges, 'SELECT');
  if (s.action === 'manifest_secret_acl_put') return s.object === 'secret_scope' && s.permission === 'READ';
  return false;
}

const cleanupKinds = new Set(['job', 'secret_scope', 'serving_endpoint', 'provider_service', 'volume', 'agent_service_principal']);
function cleanupStep(s) {
  if (!object(s) || !strings(s, ['id', 'binding_id', 'instruction'])) return false;
  if (s.kind === 'grant' || s.kind === 'revoke') return s.reason === 'agent_sp_replaced'
    && s.actor === 'workspace_admin' && s.command === null
    && (s.kind === 'grant' ? grantStep(s.grant) : revokeStep(s.revoke));
  return cleanupKinds.has(s.kind) && nullableString(s.command)
    && ['agent_sp_replaced', 'binding_force_closed', 'binding_disconnected'].includes(s.reason)
    && ['account_admin', 'workspace_admin'].includes(s.actor);
}
// DTO principals are broad. SP replacement plans must only act on the intended SP.
function validateSpPrincipal(step, kind, currentSp, context, previousSp) {
  const p = step.principal;
  if (!string(currentSp) || !currentSp || p.type !== 'service_principal'
      || (kind === 'grant' ? p.name !== currentSp : p.name === currentSp || (previousSp !== undefined && p.name !== previousSp))) {
    const expected = kind === 'grant' ? 'the current agent service principal'
      : previousSp === undefined ? 'a service principal other than the current agent' : 'the previous agent service principal, other than the current agent';
    throw new Error(`BenchRouter returned ${context}: contract error; ${kind} principal must be ${expected}.`);
  }
}
function validateCleanupPrincipals(steps, currentSp, bindingId, context) {
  // Reads also include earlier closed bindings, whose plans name their own SPs.
  for (const item of steps) if (item.binding_id === bindingId && (item.kind === 'grant' || item.kind === 'revoke')) {
    validateSpPrincipal(item[item.kind], item.kind, currentSp, `${context} (${item.kind} ${item.id})`);
  }
}
export function validateCleanup(steps, currentSp, bindingId) {
  if (!Array.isArray(steps) || !steps.every(cleanupStep)) throw new Error('BenchRouter returned invalid cleanup steps.');
  validateCleanupPrincipals(steps, currentSp, bindingId, 'invalid cleanup steps');
  return steps;
}

/** @param {unknown} value @param {string} currentSp @returns {DatabricksConnectResponse} */
export function parseDatabricksConnectResponse(value, currentSp) {
  const a = value?.agent;
  const schedule = value?.agent_schedule;
  if (!object(value) || !strings(value, ['binding_id', 'account_id', 'poll_key'])
      || !['connecting', 'verified', 'agent_silent'].includes(value.state) || !number(value.cadence_seconds)
      || !object(schedule) || !number(schedule.cadence_seconds)
      || !string(schedule.quartz_cron_expression) || schedule.timezone_id !== 'UTC'
      || !object(a) || !strings(a, ['secret_scope', 'poll_key_secret'])
      || a.package !== 'benchrouter_databricks' || a.entry_point !== 'agent' || a.max_concurrent_runs !== 1
      || !jsonObject(a.environment) || !object(a.job_parameters)
      || !strings(a.job_parameters, ['api_base', 'scope', 'poll_key_name', 'job_id'])
      || !Array.isArray(value.grants) || !value.grants.every(ucStep)
      || !Array.isArray(value.heal) || !value.heal.every(ucStep)
      || !Array.isArray(value.cleanup_pending) || !value.cleanup_pending.every(cleanupStep)
      || !(value.sp_change === null || (object(value.sp_change) && string(value.sp_change.previous_agent_sp_application_id)
        && Array.isArray(value.sp_change.grant) && value.sp_change.grant.every(grantStep)
        && Array.isArray(value.sp_change.revoke) && value.sp_change.revoke.every(revokeStep)))) {
    throw new Error('BenchRouter returned an invalid Databricks Connect response. Check the server Databricks DTO.');
  }
  const context = 'an invalid Databricks Connect response';
  if (value.sp_change) {
    for (const step of value.sp_change.grant) validateSpPrincipal(step, 'grant', currentSp, `${context} (sp_change.grant)`);
    for (const step of value.sp_change.revoke) validateSpPrincipal(step, 'revoke', currentSp, `${context} (sp_change.revoke)`, value.sp_change.previous_agent_sp_application_id);
  }
  validateCleanupPrincipals(value.cleanup_pending, currentSp, value.binding_id, `${context} cleanup_pending`);
  return /** @type {DatabricksConnectResponse} */ (value);
}
function jsonValue(v) {
  return v === null || string(v) || typeof v === 'boolean' || number(v)
    || (Array.isArray(v) ? v.every(jsonValue) : jsonObject(v));
}
function jsonObject(v) { return object(v) && Object.values(v).every(jsonValue); }

export const bindingStates = ['connecting', 'verified', 'agent_silent', 'disconnected', 'archived'];
export const bindingStateLabel = {
  connecting: 'Connecting', verified: 'Connected', agent_silent: 'Agent silent',
  disconnected: 'Disconnected', archived: 'Disconnected'
};
export const databricksFailure = (v) => object(v) && strings(v, ['code', 'title', 'message'])
  && ['customer', 'unknown'].includes(v.owner) && nullableString(v.failed_at);
const nullableFailure = (v) => v === null || databricksFailure(v);
const grantKinds = ['folder_read', 'table_select', 'secret_scope_read', 'secret_key_missing', 'volume_read'];
function grantNeeded(v) {
  return v === null || (object(v) && v.owner === 'customer' && strings(v, ['title', 'message'])
    && nullableString(v.since) && Array.isArray(v.grants) && v.grants.every((g) => object(g)
      && grantKinds.includes(g.kind) && strings(g, ['missing', 'fix']) && nullableString(g.command)));
}
export function parseDatabricksEval(v) {
  if (!object(v) || !strings(v, ['id', 'route_key', 'binding_id', 'eval_folder', 'updated_at'])
      || !number(v.desired_revision) || !(v.active_revision === null || number(v.active_revision))
      || !nullableString(v.active_digest) || !['attached', 'detached'].includes(v.state) || !grantNeeded(v.grant_needed)) {
    throw new Error('BenchRouter returned an invalid Databricks eval.');
  }
  return v;
}

/** @param {unknown} value @returns {DatabricksSetupItemView[]} */
export function parseDatabricksSetupItems(value) {
  if (!Array.isArray(value) || !value.every((item) => object(item)
      && ['volume', 'results_table', 'experiment', 'eval_job', 'serving_endpoint'].includes(item.kind)
      && strings(item, ['target', 'queued_at']) && ['pending', 'done', 'failed'].includes(item.state)
      && nullableFailure(item.failure))) {
    throw new Error('BenchRouter returned invalid Databricks setup_items. Check the server Databricks DTO.');
  }
  return /** @type {DatabricksSetupItemView[]} */ (value);
}

export function validateDatabricksBinding(v) {
  if (!object(v) || !strings(v, ['id', 'account_id', 'host', 'workspace_id', 'agent_sp_application_id', 'catalog', 'schema', 'created_at', 'updated_at'])
      || !['databricks_account_id', 'warehouse_id', 'results_group', 'manage_group', 'agent_job_id', 'eval_job_id', 'secret_scope', 'last_poll_at', 'last_agent_version', 'disconnect_requested_at'].every((k) => nullableString(v[k]))
      || !bindingStates.includes(v.state) || !number(v.cadence_seconds)
      || ![null, 'connecting_expired', 'workspace_admin_reclaimed', 'forced'].includes(v.closed_reason)) {
    throw new Error('BenchRouter returned an invalid binding.');
  }
  return v;
}
export function validateDatabricksRead(value) {
  if (!object(value) || !Array.isArray(value.evals) || !Array.isArray(value.routes) || !Array.isArray(value.exposures)
      || !value.routes.every((r) => object(r) && strings(r, ['route_key', 'name', 'model']) && [null, 'databricks', 'repo', 'hosted'].includes(r.eval_source))
      || !value.exposures.every((e) => object(e) && strings(e, ['route_key', 'endpoint_name', 'provider_service_name', 'updated_at'])
        && ['exposing', 'exposed', 'retiring'].includes(e.state) && nullableFailure(e.failure))
      || !nullableFailure(value.setup_failure) || !nullableFailure(value.disconnect_failure)) {
    throw new Error('BenchRouter returned an invalid binding read.');
  }
  validateDatabricksBinding(value.binding);
  value.evals.forEach(parseDatabricksEval);
  parseDatabricksSetupItems(value.setup_items);
  validateCleanup(value.cleanup_pending, value.binding.agent_sp_application_id, value.binding.id);
  return value;
}

export const spStepTarget = (step) => step.action === 'manifest_secret_acl_delete' ? `${step.eval_folder}#${step.route_key}`
  : step.full_name ?? step.scope ?? step.job_id ?? step.endpoint_name ?? step.path ?? `${step.eval_folder}#${step.route_key}`;
