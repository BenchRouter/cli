// H1/H2 headless-contract.ts: this is the single Connect response parser.
// AUTH-012: validate the complete plan before any workspace write using its fields.
/**
 * @typedef {{type: 'user'|'service_principal'|'group', name: string}} DatabricksPrincipal
 * @typedef {'catalog'|'schema'|'volume'|'table'|'model_provider_service'} DatabricksUcSecurable
 * @typedef {'always'|'exists'|'exists_not_agent_owned'} DatabricksStepCondition
 * @typedef {{action: 'grant'|'revoke', securable: DatabricksUcSecurable, full_name: string,
 *   principal: DatabricksPrincipal, privileges: string[], only_if: DatabricksStepCondition} |
 *   {action: 'set_owner', securable: 'volume'|'table', full_name: string,
 *   principal: DatabricksPrincipal, only_if: DatabricksStepCondition}} DatabricksUcStep
 * @typedef {(DatabricksUcStep & {object: 'catalog'|'schema'|'results_table'|'cases_table'|'provider_service'}) |
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
 *   sp_change: {previous_agent_sp_application_id: string, revoke: DatabricksRevokeStep[]}|null}} DatabricksConnectResponse
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
function revokeStep(s, oldSp) {
  if (!object(s) || s.only_if !== 'exists' || !principal(s.principal) || s.principal.type !== 'service_principal' || s.principal.name !== oldSp) return false;
  if (s.action === 'revoke') return ucStep(s) && ({ catalog: 'catalog', schema: 'schema', results_table: 'table', cases_table: 'table', provider_service: 'model_provider_service' })[s.object] === s.securable;
  if (s.action === 'secret_acl_delete') return s.object === 'secret_scope' && string(s.scope);
  if (s.action === 'job_acl_remove') return ['agent_job', 'eval_job'].includes(s.object) && string(s.job_id);
  if (s.action === 'endpoint_acl_remove') return s.object === 'serving_endpoint' && string(s.endpoint_name);
  if (s.action === 'folder_acl_remove') return s.object === 'eval_folder' && string(s.path);
  return false;
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
      || !(value.sp_change === null || (object(value.sp_change) && string(value.sp_change.previous_agent_sp_application_id)
        && Array.isArray(value.sp_change.revoke) && value.sp_change.revoke.every((s) => revokeStep(s, value.sp_change.previous_agent_sp_application_id))))) {
    throw new Error('BenchRouter returned an invalid Databricks Connect response. Check the H1/H2 contract.');
  }
  return /** @type {DatabricksConnectResponse} */ (value);
}
