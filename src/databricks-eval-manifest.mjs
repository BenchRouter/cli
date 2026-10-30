import { parseDocument } from 'yaml';
import { refusal } from './databricks-helpers.mjs';
import { DatabricksError, isMissing } from './databricks.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
const envName = (v, max = 64) => text(v, max) && v[0] >= 'A' && v[0] <= 'Z'
  && [...v].every((c) => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_')
  && !v.startsWith('BENCHROUTER_') && !v.startsWith('DATABRICKS_');
const invalid = () => refusal('The eval manifest is invalid. Check .benchrouter/benchrouter.yml against the Databricks runner manifest schema.', 'manifest_invalid');

export async function readWorkspaceEvalGrants(workspace, folder, routeKey, { skipUnavailable = false } = {}) {
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
    if (skipUnavailable && error instanceof DatabricksError) {
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
