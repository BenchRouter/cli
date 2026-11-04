import { parseDocument } from 'yaml';
import { refusal, numericId, runUcStep } from './databricks-helpers.mjs';
import { DatabricksError, isMissing, uc, encode } from './databricks.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
const envName = (v, max = 64) => text(v, max) && v[0] >= 'A' && v[0] <= 'Z'
  && [...v].every((c) => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_')
  && !v.startsWith('BENCHROUTER_') && !v.startsWith('DATABRICKS_');
const invalid = () => refusal('The eval manifest is invalid. Check .benchrouter/benchrouter.yml against the Databricks runner manifest schema.', 'manifest_invalid');

export async function applyWorkspaceEvalGrants(workspace, binding, { directory, grants }) {
  const spId = binding.agent_sp_application_id;
  const aclPath = `/api/2.0/permissions/directories/${numericId(directory.object_id)}`;
  try {
    await workspace.call('PATCH', aclPath, { access_control_list: [{ service_principal_name: spId, permission_level: 'CAN_READ' }] });
  } catch (error) {
    if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED'))) throw error;
    let acl;
    try { acl = await workspace.optional('GET', aclPath); } catch { /* Owner unavailable; keep the grant refusal exit code. */ }
    const owner = acl?.access_control_list?.find((a) => a.all_permissions?.some((p) => p.permission_level === 'IS_OWNER'));
    throw refusal(`Databricks refused folder CAN_READ. Folder owner: ${owner?.user_name ?? owner?.service_principal_name ?? owner?.group_name ?? 'unknown'}. Ask the owner to grant access.`);
  }
  const [catalog, schema] = grants.casesTable.split('.');
  const table = await workspace.call('GET', `${uc}/tables/${encode(grants.casesTable)}`);
  const steps = [];
  if (catalog.toLowerCase() !== binding.catalog.toLowerCase()) steps.push(['catalog', catalog, ['USE_CATALOG']]);
  if (catalog.toLowerCase() !== binding.catalog.toLowerCase() || schema.toLowerCase() !== binding.schema.toLowerCase()) steps.push(['schema', `${catalog}.${schema}`, ['USE_SCHEMA']]);
  steps.push(['table', grants.casesTable, ['SELECT']]);
  try {
    for (const [securable, full_name, privileges] of steps) await runUcStep(workspace,
      { action: 'grant', securable, full_name, principal: { type: 'service_principal', name: spId }, privileges, only_if: 'always' }, spId, catalog, schema, 'add-eval');
  } catch (error) {
    if (error instanceof DatabricksError && error.code === 'grant_refused') throw refusal(`${error.message} Table owner: ${table.owner ?? 'unknown'}.`);
    throw error;
  }
  const secret_acl_applied = [];
  const secret_acl_commands = [];
  for (const scope of grants.secretScopes) {
    // AUTH-012 / DATA-001: apply an ACL using identifiers only. Never read secret values.
    try {
      await workspace.call('POST', '/api/2.0/secrets/acls/put', { scope, principal: spId, permission: 'READ' });
      secret_acl_applied.push(scope);
    } catch (error) {
      if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED'))) throw error;
      secret_acl_commands.push(`databricks secrets put-acl ${shellWord(scope)} ${shellWord(spId)} READ`);
    }
  }
  return { secret_acl_applied, secret_acl_commands };
}

function shellWord(value) {
  return [...value].every((c) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-'.includes(c)) && value ? value : `'${value.split("'").join("'\\''")}'`;
}

export async function readWorkspaceEvalGrants(workspace, folder, routeKey, { skipUnavailable = false, skipInvalidManifest = true } = {}) {
  let directory;
  try { directory = await workspace.call('GET', `/api/2.0/workspace/get-status?${new URLSearchParams({ path: folder })}`); }
  catch (error) {
    if (skipUnavailable && isMissing(error)) return { reason: 'eval folder is missing' };
    throw error;
  }
  let exported;
  try { exported = await workspace.call('GET', `/api/2.0/workspace/export?${new URLSearchParams({ path: `${folder}/.benchrouter/benchrouter.yml`, format: 'AUTO' })}`); }
  catch (error) {
    if (skipUnavailable && isMissing(error)) return { reason: 'eval manifest is missing' };
    throw error;
  }
  try {
    if (typeof exported?.content !== 'string') throw refusal('Databricks did not export the manifest.', 'manifest_invalid');
    return { directory, grants: readEvalGrants(Buffer.from(exported.content, 'base64').toString('utf8'), routeKey) };
  } catch (error) {
    if (skipUnavailable && skipInvalidManifest && error instanceof DatabricksError) {
      if (error.code === 'route_not_declared') return { reason: 'route_key is no longer declared exactly once in the eval manifest' };
      if (['manifest_invalid', 'secret_scope_reserved'].includes(error.code)) return { reason: 'eval manifest is invalid' };
    }
    throw error;
  }
}

// Match manifest.py for the fields this command consumes. Parse YAML as data, never as shell text.
export function readEvalGrants(content, routeKey) {
  let value;
  try {
    const doc = parseDocument(content, { schema: 'yaml-1.1', uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw invalid();
    value = doc.toJS({ maxAliasCount: 100 });
  } catch { throw invalid(); }
  if (!object(value) || !Array.isArray(value.routes)) throw invalid();
  const entries = value.routes.filter((e) => object(e) && e.route_id === routeKey);
  if (entries.length !== 1) throw refusal('The manifest must declare the route_id exactly once.', 'route_not_declared');
  const entry = entries[0];
  const pack = entry.eval_pack;
  if (!object(pack) || pack.mode !== 'repository_executable' || pack.api_family !== 'openai_chat_completions') throw invalid();
  const block = pack.databricks;
  const allowed = new Set(['cases_table', 'secret_scope', 'cases', 'predict', 'scorers', 'normalization']);
  if (!object(block) || Object.keys(block).some((k) => !allowed.has(k))
      || !['cases_table', 'cases', 'predict', 'scorers', 'normalization'].every((k) => Object.hasOwn(block, k))) throw invalid();
  const table = block.cases_table;
  if (!text(table) || table.split('.').length !== 3 || table.split('.').some((s) => !s || s.includes('`'))) throw invalid();
  const callSite = entry.call_site || {};
  if (!object(callSite) || (callSite.base_url_env != null && !envName(callSite.base_url_env, 256))) throw invalid();
  // Python treats null and empty containers as absent here.
  const rawNames = pack.secret_env;
  const empty = rawNames == null || rawNames === false || rawNames === '' || rawNames === 0
    || (object(rawNames) && Object.keys(rawNames).length === 0);
  const names = empty ? [] : rawNames;
  if (!Array.isArray(names) || new Set(names).size !== names.length) throw invalid();
  const scope = block.secret_scope;
  if (scope != null && !text(scope)) throw invalid();
  if (names.length && scope == null) throw invalid();
  // AUTH-012 / DATA-001: an eval never receives BenchRouter's own secrets.
  if (scope != null && (scope.toLowerCase() === 'benchrouter' || scope.toLowerCase().startsWith('benchrouter-'))) {
    throw refusal('The eval secret scope may not be benchrouter or benchrouter-*.', 'secret_scope_reserved');
  }
  if (names.some((n) => !envName(n) || n === callSite.base_url_env)) throw invalid();
  return { casesTable: table, secretScopes: scope == null ? [] : [scope] };
}
