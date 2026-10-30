import { DatabricksError, encode, uc, isMissing } from './databricks.mjs';
import { numericId, readJob } from './databricks-helpers.mjs';

export { validateCleanup } from './databricks-contract.mjs';
function objectPath(step) {
  const id = encode(step.id);
  if (step.kind === 'secret_scope') return `/api/2.0/secrets/acls/list?scope=${id}`;
  if (step.kind === 'serving_endpoint') return `/api/2.0/serving-endpoints/${id}`;
  if (step.kind === 'provider_service') return `${uc}/model-provider-services/${id}`;
  if (step.kind === 'volume') return `${uc}/volumes/${id}`;
  throw new Error('An account-console SP step cannot be checked with the workspace login.');
}
// A workspace SCIM read cannot prove account SP deletion (A.7). The caller keeps that step.
export async function objectExists(workspace, step) {
  const result = step.kind === 'job' ? await readJob(workspace, step.id) : await workspace.optional('GET', objectPath(step));
  if (!result) return false;
  return true;
}
export async function deleteRecorded(workspace, step) {
  if (step.kind === 'agent_service_principal' || step.actor === 'account_admin') return false;
  try {
    if (!await objectExists(workspace, step)) return 'absent';
    const id = encode(step.id);
    if (step.kind === 'job') await workspace.call('POST', '/api/2.2/jobs/delete', { job_id: numericId(step.id) });
    else if (step.kind === 'secret_scope') await workspace.call('POST', '/api/2.0/secrets/scopes/delete', { scope: step.id });
    else if (step.kind === 'serving_endpoint') await workspace.call('DELETE', `/api/2.0/serving-endpoints/${id}`);
    else if (step.kind === 'provider_service') await workspace.call('DELETE', `${uc}/model-provider-services/${id}`);
    else if (step.kind === 'volume') await workspace.call('DELETE', `${uc}/volumes/${id}`);
    else throw new Error('Unknown cleanup kind.');
    // A successful DELETE can be asynchronous. Acknowledge only an observed absence.
    return !await objectExists(workspace, step) ? 'deleted' : false;
  } catch (error) {
    if (isMissing(error, { job: step.kind === 'job' })) return 'absent';
    // An admin without MANAGE cannot remove a provider service. Keep the server instruction.
    if (error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED')) return false;
    throw error;
  }
}
export function recordedObjects(detail, closedExposures = []) {
  const b = detail.binding;
  const steps = [];
  const add = (kind, id) => { if (id) steps.push({ kind, id, binding_id: b.id, actor: 'workspace_admin' }); };
  for (const e of [...detail.exposures, ...closedExposures]) {
    add('serving_endpoint', e.endpoint_name);
    add('provider_service', e.provider_service_name);
  }
  add('job', b.eval_job_id);
  add('job', b.agent_job_id);
  add('secret_scope', b.secret_scope);
  for (const name of ['benchrouter_artifacts', 'benchrouter_results']) add('volume', `${b.catalog}.${b.schema}.${name}`);
  return steps;
}
// AUTH-012: scope names and UC names identify the same object regardless of casing.
export const objectKey = (s) => JSON.stringify([s.kind, ['secret_scope', 'volume', 'provider_service'].includes(s.kind) ? s.id.toLowerCase() : s.id]);
