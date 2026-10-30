// H1/H2 headless-contract.ts: shared Connect response and setup-item parsers.
// AUTH-012: validate the complete plan before any workspace write using its fields.
/**
 * @typedef {{type: 'user'|'service_principal'|'group', name: string}} DatabricksPrincipal
 * @typedef {'catalog'|'schema'|'volume'|'table'|'model_provider_service'} DatabricksUcSecurable
 * @typedef {'always'|'exists'|'exists_not_agent_owned'} DatabricksStepCondition
 * @typedef {{action: 'grant'|'revoke', securable: DatabricksUcSecurable, full_name: string,
 *   principal: DatabricksPrincipal, privileges: string[], only_if: DatabricksStepCondition} |
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
const string = (v) => typeof v === 'string' && v.length > 0;
const principal = (v) => object(v) && ['user', 'service_principal', 'group'].includes(v.type) && string(v.name);
function ucStep(s) {
  return object(s) && securables.has(s.securable) && string(s.full_name) && principal(s.principal) && conditions.has(s.only_if)
    && (s.action === 'set_owner' ? ['volume', 'table'].includes(s.securable)
      : ['grant', 'revoke'].includes(s.action) && Array.isArray(s.privileges) && s.privileges.length > 0 && s.privileges.every((p) => privileges.has(p)));
}
function revokeStep(s, oldSp = s?.principal?.name) {
  if (!object(s) || s.only_if !== 'exists' || !principal(s.principal) || s.principal.type !== 'service_principal' || s.principal.name !== oldSp) return false;
  const base = ['object', 'action', 'principal', 'only_if'];
  if (s.action === 'revoke') return exact(s, [...base, 'securable', 'full_name', 'privileges']) && ucStep(s)
    && ({ catalog: 'catalog', schema: 'schema', results_table: 'table', provider_service: 'model_provider_service' })[s.object] === s.securable;
  if (s.action === 'manifest_table_revoke') return exact(s, [...base, 'route_key', 'eval_folder', 'privileges'])
    && s.object === 'cases_table' && string(s.route_key) && s.route_key.trim().length > 0 && folder(s.eval_folder) && singleton(s.privileges, 'SELECT');
  if (s.action === 'secret_acl_delete') return exact(s, [...base, 'scope']) && s.object === 'secret_scope' && string(s.scope);
  if (s.action === 'job_acl_remove') return exact(s, [...base, 'job_id']) && ['agent_job', 'eval_job'].includes(s.object) && string(s.job_id);
  if (s.action === 'endpoint_acl_remove') return exact(s, [...base, 'endpoint_name']) && s.object === 'serving_endpoint' && string(s.endpoint_name);
  if (s.action === 'folder_acl_remove') return exact(s, [...base, 'path']) && s.object === 'eval_folder' && folder(s.path);
  return false;
}

const exact = (v, keys) => Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const folder = (v) => string(v) && v.startsWith('/') && !v.includes('\\') && !v.includes('\0')
  && !v.split('/').slice(1).some((p) => !p || p === '.' || p === '..');
const singleton = (v, item) => Array.isArray(v) && v.length === 1 && v[0] === item;
function grantStep(s) {
  if (!object(s) || !principal(s.principal) || s.principal.type !== 'service_principal') return false;
  const base = ['object', 'action', 'principal', 'only_if'];
  if (s.action === 'grant') return exact(s, [...base, 'securable', 'full_name', 'privileges']) && ucStep(s)
    && s.object === 'provider_service' && s.securable === 'model_provider_service' && singleton(s.privileges, 'MANAGE');
  if (s.only_if !== 'exists') return false;
  if (s.action === 'endpoint_acl_add') return exact(s, [...base, 'endpoint_name', 'permission'])
    && s.object === 'serving_endpoint' && string(s.endpoint_name) && s.permission === 'CAN_MANAGE';
  if (s.action === 'folder_acl_add') return exact(s, [...base, 'path', 'permission'])
    && s.object === 'eval_folder' && folder(s.path) && s.permission === 'CAN_READ';
  if (!folder(s.eval_folder) || !string(s.route_key) || !s.route_key.trim()) return false;
  if (s.action === 'manifest_table_grant') return exact(s, [...base, 'eval_folder', 'route_key', 'privileges'])
    && s.object === 'cases_table' && singleton(s.privileges, 'SELECT');
  if (s.action === 'manifest_secret_acl_put') return exact(s, [...base, 'eval_folder', 'route_key', 'permission'])
    && s.object === 'secret_scope' && s.permission === 'READ';
  return false;
}

const cleanupKinds = new Set(['job', 'secret_scope', 'serving_endpoint', 'provider_service', 'volume', 'agent_service_principal']);
function cleanupStep(s) {
  if (!object(s) || !string(s.id) || !string(s.binding_id) || !string(s.instruction)) return false;
  const base = ['kind', 'id', 'binding_id', 'reason', 'actor', 'command', 'instruction'];
  if (s.kind === 'grant' || s.kind === 'revoke') return exact(s, [...base, s.kind])
    && s.reason === 'agent_sp_replaced' && s.actor === 'workspace_admin' && s.command === null
    && (s.kind === 'grant' ? grantStep(s.grant) : revokeStep(s.revoke));
  return cleanupKinds.has(s.kind) && exact(s, base)
    && (s.command === null || typeof s.command === 'string')
    && ['agent_sp_replaced', 'binding_force_closed'].includes(s.reason)
    && s.actor === (s.kind === 'agent_service_principal' ? 'account_admin' : 'workspace_admin');
}
export function validateCleanup(steps) {
  if (!Array.isArray(steps) || !steps.every(cleanupStep)
      || new Set(steps.map((s) => JSON.stringify([s.binding_id, s.kind, s.id]))).size !== steps.length) {
    throw new Error('BenchRouter returned invalid cleanup steps.');
  }
  return steps;
}

/**
 * Validate the response from the shared H1/H2 contract.
 * @param {unknown} value
 * @returns {DatabricksConnectResponse}
 */
export function parseDatabricksConnectResponse(value) {
  const a = value?.agent;
  const schedule = value?.agent_schedule;
  if (!object(value) || !['binding_id', 'account_id', 'poll_key'].every((key) => string(value[key]))
      || !['connecting', 'verified', 'agent_silent'].includes(value.state)
      || !Number.isSafeInteger(value.cadence_seconds) || value.cadence_seconds <= 0
      || !object(schedule) || schedule.cadence_seconds !== value.cadence_seconds
      || !string(schedule.quartz_cron_expression) || schedule.timezone_id !== 'UTC'
      || !object(a) || !string(a.secret_scope) || a.poll_key_secret !== 'poll-key'
      || a.package !== 'benchrouter_databricks' || a.entry_point !== 'agent' || a.max_concurrent_runs !== 1
      || !object(a.environment) || !object(a.job_parameters)
      || !['api_base', 'scope', 'poll_key_name', 'job_id'].every((key) => string(a.job_parameters[key]))
      || a.job_parameters.scope !== a.secret_scope || a.job_parameters.poll_key_name !== a.poll_key_secret
      || a.job_parameters.job_id !== '{{job.id}}'
      || !Array.isArray(value.grants) || !value.grants.every((s) => ucStep(s) && s.only_if === 'always')
      || !Array.isArray(value.heal) || !value.heal.every(ucStep)
      || !Array.isArray(value.cleanup_pending) || !value.cleanup_pending.every(cleanupStep)
      || new Set(value.cleanup_pending.map((s) => JSON.stringify([s.binding_id, s.kind, s.id]))).size !== value.cleanup_pending.length
      || !(value.sp_change === null || (object(value.sp_change) && string(value.sp_change.previous_agent_sp_application_id)
        && exact(value.sp_change, ['previous_agent_sp_application_id', 'grant', 'revoke'])
        && Array.isArray(value.sp_change.grant) && value.sp_change.grant.every(grantStep)
        && Array.isArray(value.sp_change.revoke) && value.sp_change.revoke.every((s) => revokeStep(s, value.sp_change.previous_agent_sp_application_id))))) {
    throw new Error('BenchRouter returned an invalid Databricks Connect response. Check the H1/H2 contract.');
  }
  return /** @type {DatabricksConnectResponse} */ (value);
}

/**
 * Validate the setup_items array on a binding read before deciding completion.
 * @param {unknown} value
 * @returns {DatabricksSetupItemView[]}
 */
export function parseDatabricksSetupItems(value) {
  const instant = (v) => string(v) && Number.isFinite(Date.parse(v));
  const failure = (v) => object(v) && ['code', 'title', 'message'].every((key) => string(v[key]))
    && ['customer', 'unknown'].includes(v.owner) && (v.failed_at === null || instant(v.failed_at));
  if (!Array.isArray(value) || !value.every((item) => object(item)
      && ['volume', 'results_table', 'experiment', 'eval_job', 'serving_endpoint'].includes(item.kind)
      && string(item.target) && ['pending', 'done', 'failed'].includes(item.state) && instant(item.queued_at)
      && (item.state === 'failed' ? failure(item.failure) : item.failure === null))
      || new Set(value.map((item) => JSON.stringify([item.kind, item.target]))).size !== value.length) {
    throw new Error('BenchRouter returned invalid Databricks setup_items. Check the H1/H2 contract.');
  }
  return /** @type {DatabricksSetupItemView[]} */ (value);
}

export const spStepTarget = (step) => step.full_name ?? step.scope ?? step.job_id ?? step.endpoint_name ?? step.path ?? `${step.eval_folder}#${step.route_key}`;
