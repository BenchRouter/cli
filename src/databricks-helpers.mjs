import { accountClient } from './control-helpers.mjs';
import { apiRequest, ApiError } from './http.mjs';
import { DatabricksError, uc, ucPaths, encode, isMissing } from './databricks.mjs';

export const exits = { grant_refused: 3, workspace_admin_required: 4, pat_login: 5, databricks_login_required: 1, databricks_auth_unsupported: 1 };
export const proofErrors = {
  workspace_proof_invalid: 'The workspace proof was refused. Log in to Databricks again and retry.',
  workspace_admin_required: 'Connect requires a Databricks workspace admin. Log in as a workspace admin and retry.',
  workspace_proof_replayed: 'The workspace proof was already used. Run connect again for a fresh proof.',
  workspace_unreachable: 'BenchRouter could not reach the workspace to verify its proof.',
  workspace_connected_elsewhere: 'This workspace is connected to another BenchRouter account.',
  binding_disconnecting: 'This workspace is disconnecting. Wait for it to finish before Connect.'
};
export function refusal(message, code = 'grant_refused') { return new DatabricksError(message, code); }
export function workspaceAdmin(claims, me) {
  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub || me.userName !== sub || !Array.isArray(me.groups) || !me.groups.some((g) => g.display === 'admins')) {
    throw refusal(proofErrors.workspace_admin_required, 'workspace_admin_required');
  }
  return { type: claims.client_id === sub ? 'service_principal' : 'user', name: sub };
}
export function numericId(value) {
  const text = String(value ?? '');
  if (!text || ![...text].every((c) => c >= '0' && c <= '9') || BigInt(text) <= 0n || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Databricks returned an invalid numeric object id.');
  return Number(text);
}
export async function readJob(workspace, id) {
  // With job_id as the only validated parameter, the recorded 400 means absence.
  const jobId = numericId(id);
  try { return await workspace.call('GET', `/api/2.2/jobs/get?job_id=${jobId}`); }
  catch (error) { if (isMissing(error, { job: true })) return null; throw error; }
}

function objectPath(step) { return `${uc}/${ucPaths[step.securable]}/${encode(step.full_name)}`; }
export async function runUcStep(workspace, step, spId, catalog, schema, command = 'connect') {
  let object;
  try {
    if (step.only_if !== 'always') {
      object = await workspace.optional('GET', objectPath(step));
      if (!object || (step.only_if === 'exists_not_agent_owned' && object.owner === spId)) return;
    }
    if (step.action === 'set_owner') await workspace.call('PATCH', objectPath(step), { owner: step.principal.name });
    else await workspace.call('PATCH', `${uc}/permissions/${step.securable}/${encode(step.full_name)}`, { changes: [{ principal: step.principal.name, [step.action === 'grant' ? 'add' : 'remove']: step.privileges }] });
  } catch (error) {
    if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED'))) throw error;
    const owner = async (path) => { try { return (await workspace.call('GET', path)).owner ?? 'unknown'; } catch { return 'unknown'; } };
    const catalogOwner = await owner(`${uc}/catalogs/${encode(catalog)}`);
    const schemaOwner = await owner(`${uc}/schemas/${encode(`${catalog}.${schema}`)}`);
    const refused = refusal(`Databricks refused ${step.action} on ${step.full_name}. Catalog owner: ${catalogOwner}. Schema owner: ${schemaOwner}.${step.only_if !== 'always' ? ` Object owner: ${object?.owner ?? 'unknown'}.` : ''} Ask the owner or a metastore admin to run ${command}.`);
    refused.owner = object?.owner ?? (schemaOwner !== 'unknown' ? schemaOwner : catalogOwner);
    throw refused;
  }
}

export function secretRedaction() {
  const secrets = new Set();
  const remember = (s) => { if (typeof s === 'string' && s) secrets.add(s); };
  const clean = (s) => {
    let result = String(s);
    for (const secret of secrets) {
      for (const representation of new Set([secret, encode(secret), JSON.stringify(secret).slice(1, -1)])) result = result.split(representation).join('[redacted]');
    }
    return result;
  };
  return { remember, clean };
}
const refusalMessages = {
  route_eval_in_repo: 'This route has an eval in its repository. Edit its repository manifest.',
  route_eval_hosted: 'This route has a hosted eval. Remove that eval before attaching a Databricks eval.',
  route_not_found: 'The route was not found in this account.',
  binding_disconnecting: 'This binding is disconnecting. Wait for it to finish.',
  forbidden: 'An owner or admin role is required for this action.',
  invalid_results_owner: 'BenchRouter refused results_owner. Check the H2 principal contract.'
};
export function databricksControl(ctx) {
  // AUTH-006: use the existing account control-token login before workspace writes.
  const control = accountClient(ctx);
  return async (spec) => {
    try { return await apiRequest({ ...control, ...spec }); } catch (error) {
      // AUTH-012 / DATA-001: do not echo remote messages or arbitrary error codes.
      if (error instanceof ApiError) throw refusal(refusalMessages[error.code] ?? proofErrors[error.code] ?? `BenchRouter Databricks request failed (${error.status}).`,
        Object.hasOwn(refusalMessages, error.code) || Object.hasOwn(proofErrors, error.code) ? error.code : 'benchrouter_request_failed');
      throw new Error('BenchRouter Databricks request failed.');
    }
  };
}
