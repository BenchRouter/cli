import { setTimeout as delay } from 'node:timers/promises';
import { emit } from './control-helpers.mjs';
import { customerPaths } from './control-api.mjs';
import { DatabricksWorkspace, DatabricksError, workspaceHost, scim, uc, encode } from './databricks.mjs';
import { databricksControl, secretRedaction, exits, refusal, workspaceAdmin, numericId, readJob, runUcStep } from './databricks-helpers.mjs';
import { bindingStates, parseDatabricksEval, validateDatabricksBinding, validateDatabricksRead } from './databricks-contract.mjs';
import { readWorkspaceEvalGrants } from './databricks-eval-manifest.mjs';
import { isSpStep, runPendingSpSteps } from './databricks-sp-steps.mjs';
import { objectExists, deleteRecorded, recordedObjects, objectKey } from './databricks-cleanup.mjs';
import { renderDatabricksRead, renderDatabricksEval, renderDatabricksDisconnect } from './render.mjs';

const closed = (b) => ['archived', 'disconnected'].includes(b.state);
function bindingRead(value) {
  validateDatabricksRead(value);
  workspaceHost(`https://${value.binding.host}`);
  return value;
}
async function listBindings(br, host) {
  const answer = await br(customerPaths.databricksBindings());
  if (!Array.isArray(answer.bindings)) throw new Error('BenchRouter returned an invalid binding list.');
  answer.bindings.forEach(validateDatabricksBinding);
  return answer.bindings.filter((b) => !host || b.host === new URL(host).hostname);
}
function selectBinding(bindings) {
  const open = bindings.filter((b) => !closed(b));
  const choices = open.length ? open : bindings.filter((b, i) => bindings.findIndex((other) => other.host === b.host) === i);
  if (choices.length !== 1) throw new Error(choices.length ? 'Several bindings match. Pass --host for one workspace.' : 'No Databricks binding was found.');
  return choices[0];
}
async function requireAdmin(workspace) {
  const claims = await workspace.freshLogin();
  const me = await workspace.call('GET', `${scim}/Me`);
  return workspaceAdmin(claims, me);
}
async function runAgent(workspace, id) {
  if (!id) return false;
  if (await readJob(workspace, id)) {
    return Boolean(await workspace.optional('POST', '/api/2.2/jobs/run-now', { job_id: numericId(id) }));
  }
  return false;
}
export async function runDatabricksCommand(ctx) {
  const { remember, clean } = secretRedaction();
  try {
    const br = databricksControl(ctx);
    const sub = ctx.args._[1];
    for (const flag of ['force', 'reclaim', 'json', 'all']) {
      if (ctx.args[flag] !== undefined && typeof ctx.args[flag] !== 'boolean') return ctx.usage(1, `databricks ${sub}`, `Pass --${flag} as a boolean flag.`);
    }
    if (ctx.args['results-owner'] !== undefined && !ctx.stringArg('results-owner')) return ctx.usage(1, 'databricks disconnect', 'Pass --results-owner <group>.');
    const hostArg = ctx.stringArg('host');
    if (ctx.args.host !== undefined && !hostArg) return ctx.usage(1, `databricks ${sub}`, 'Pass --host <url>.');
    const host = hostArg ? workspaceHost(hostArg) : null;
    const workspace = (url) => new DatabricksWorkspace(workspaceHost(url), remember, clean);
    let result;
    let render;
    if (sub === 'disconnect' && ctx.args.reclaim) {
      if (!host) return ctx.usage(1, 'databricks disconnect', '--reclaim needs --host.');
      if (ctx.args.force || ctx.args['results-owner']) return ctx.usage(1, 'databricks disconnect', '--reclaim cannot use --force or --results-owner.');
      const ws = workspace(host);
      await requireAdmin(ws);
      const metadata = await ws.call('GET', '/.well-known/databricks-config', undefined, { anonymous: true });
      const workspaceId = String(metadata.workspace_id ?? '');
      if (!workspaceId || ![...workspaceId].every((c) => c >= '0' && c <= '9')) throw new Error('Databricks returned an invalid workspace id.');
      // AUTH-012 / DATA-001: only the fresh downscoped proof reaches BenchRouter.
      const answer = await br(customerPaths.databricksReclaim({ workspace_url: host, workspace_id: workspaceId, workspace_proof: await ws.proof() }));
      validateClosedExposures(answer);
      if (!(answer.closed_binding_id === null || typeof answer.closed_binding_id === 'string')) throw new Error('BenchRouter returned an invalid reclaim response.');
      const remaining = [];
      const deleted = [];
      const absent = [];
      for (const e of answer.closed_exposures) for (const [kind, id] of [['serving_endpoint', e.endpoint_name], ['provider_service', e.provider_service_name]]) {
        const outcome = await deleteRecorded(ws, { kind, id, actor: 'workspace_admin' });
        (outcome === 'deleted' ? deleted : outcome === 'absent' ? absent : remaining).push({ kind, id });
      }
      result = { ...answer, deleted, absent, skipped: [], remaining };
      render = renderDatabricksDisconnect;
    } else {
      const bindings = await listBindings(br, host);
      if (sub === 'status') {
        const reads = [];
        for (const b of bindings) {
          let detail = bindingRead(await br(customerPaths.databricksBinding(b.id)));
          if (!ctx.args.all && closed(detail.binding) && !detail.cleanup_pending.length) continue;
          const ws = workspace(`https://${b.host}`);
          let login = false;
          // Missing, unsupported or PAT logins never prevent an account member's status read.
          try { await ws.login(); login = true; } catch (error) { if (!(error instanceof DatabricksError)) throw error; }
          if (login) {
            const done = [];
            for (const step of detail.cleanup_pending) {
              if (step.kind === 'agent_service_principal' || step.actor === 'account_admin' || isSpStep(step)) continue;
              try { if (!await objectExists(ws, step)) done.push({ kind: step.kind, id: step.id }); } catch (error) {
                if (!(error instanceof DatabricksError)) throw error;
              }
            }
            if (done.length) {
              try {
                await br(customerPaths.databricksCleanup(b.id, { done }));
                detail = bindingRead(await br(customerPaths.databricksBinding(b.id)));
              } catch (error) {
                // A member can read status but cannot acknowledge cleanup (owner/admin only).
                if (!(error instanceof DatabricksError && error.code === 'forbidden')) throw error;
              }
            }
            if (!ctx.args.all && closed(detail.binding) && !detail.cleanup_pending.length) continue;
            if (detail.binding.agent_job_id) {
              try {
                const acl = await ws.optional('GET', `/api/2.0/permissions/jobs/${encode(detail.binding.agent_job_id)}`);
                const owner = acl?.access_control_list?.find((entry) => entry.user_name && entry.all_permissions?.some((p) => p.permission_level === 'IS_OWNER'));
                // This workspace observation belongs on stderr. JSON stays equal to server reads.
                if (owner) process.stderr.write(clean(`Warning: Agent job https://${b.host}/jobs/${detail.binding.agent_job_id} is owned by user ${owner.user_name}. Under restrict_workspace_admins, the job stops when that user is removed.\n`));
              } catch (error) { if (!(error instanceof DatabricksError)) throw error; }
            }
          }
          reads.push(detail);
        }
        result = { bindings: reads };
        render = renderDatabricksRead;
      } else {
        const selected = selectBinding(bindings);
        const detail = bindingRead(await br(customerPaths.databricksBinding(selected.id)));
        const b = detail.binding;
        const ws = workspace(`https://${b.host}`);
        if (sub === 'add-eval') {
          const [route, folder] = ctx.args._.slice(2);
          if (!route || !folder || !folder.startsWith('/') || folder.includes('\\') || folder.includes('\0')
              || folder.split('/').slice(1).some((p) => !p || p === '.' || p === '..')) return ctx.usage(1, 'databricks add-eval', 'Pass a route and an absolute, normalized workspace folder.');
          await requireAdmin(ws);
          const { directory, grants } = await readWorkspaceEvalGrants(ws, folder, route);
          const aclPath = `/api/2.0/permissions/directories/${numericId(directory.object_id)}`;
          const answer = await br(customerPaths.databricksAddEval(b.id, { route_key: route, eval_folder: folder }));
          parseDatabricksEval(answer?.eval);
          try {
            await ws.call('PATCH', aclPath, { access_control_list: [{ service_principal_name: b.agent_sp_application_id, permission_level: 'CAN_READ' }] });
          } catch (error) {
            if (!(error instanceof DatabricksError && (error.status === 403 || error.code === 'PERMISSION_DENIED'))) throw error;
            let acl;
            try { acl = await ws.optional('GET', aclPath); } catch { /* Owner unavailable; keep the grant refusal exit code. */ }
            const owner = acl?.access_control_list?.find((a) => a.all_permissions?.some((p) => p.permission_level === 'IS_OWNER'));
            throw refusal(`Databricks refused folder CAN_READ. Folder owner: ${owner?.user_name ?? owner?.service_principal_name ?? owner?.group_name ?? 'unknown'}. Ask the owner to grant access.`);
          }
          const [catalog, schema] = grants.casesTable.split('.');
          const table = await ws.call('GET', `${uc}/tables/${encode(grants.casesTable)}`);
          const steps = [];
          if (catalog.toLowerCase() !== b.catalog.toLowerCase()) steps.push(['catalog', catalog, ['USE_CATALOG']]);
          if (catalog.toLowerCase() !== b.catalog.toLowerCase() || schema.toLowerCase() !== b.schema.toLowerCase()) steps.push(['schema', `${catalog}.${schema}`, ['USE_SCHEMA']]);
          steps.push(['table', grants.casesTable, ['SELECT']]);
          try {
            for (const [securable, full_name, privileges] of steps) await runUcStep(ws, { action: 'grant', securable, full_name, principal: { type: 'service_principal', name: b.agent_sp_application_id }, privileges, only_if: 'always' }, b.agent_sp_application_id, catalog, schema, 'add-eval');
          } catch (error) {
            if (error instanceof DatabricksError && error.code === 'grant_refused') throw refusal(`${error.message} Table owner: ${table.owner ?? 'unknown'}.`);
            throw error;
          }
          // These lines contain identifiers only. Never read a secret value (AUTH-012 / DATA-001).
          const secret_acl_commands = grants.secretScopes.map((scope) => `databricks secrets put-acl ${shellWord(scope)} ${shellWord(b.agent_sp_application_id)} READ`);
          const agent_started = await runAgent(ws, b.agent_job_id);
          result = { ...answer, secret_acl_commands, agent_started };
          render = renderDatabricksEval;
        } else {
          const admin = await requireAdmin(ws);
          const { pending_steps } = !closed(b) ? await runPendingSpSteps(ws, br, detail.cleanup_pending, b, admin,
            (line) => process.stderr.write(clean(`${line}\n`))) : { pending_steps: [] };
          const body = {};
          if (ctx.args.force) body.force = true;
          const group = ctx.stringArg('results-owner');
          if (group) body.results_owner = { type: 'group', name: group };
          const disconnectSent = !closed(b);
          const answer = disconnectSent ? await br(customerPaths.databricksDisconnect(b.id, body)) : null;
          if (answer) validateDisconnect(answer);
          // Kick before waiting or deleting: a queued disconnect cannot finish without its agent.
          if (answer?.cleanup === 'queued') await runAgent(ws, b.agent_job_id);
          let final = detail;
          const deadline = Date.now() + 180000;
          while (!closed(final.binding) && Date.now() < deadline) {
            final = bindingRead(await br(customerPaths.databricksBinding(b.id)));
            if (closed(final.binding)) break;
            if (final.disconnect_failure) throw new Error('The agent could not disconnect. Run status for the server fix, or disconnect --force.');
            await delay(2000);
          }
          if (!closed(final.binding)) throw new Error('Timed out waiting for disconnect. Run status, or disconnect --force.');
          const steps = ctx.args.force && disconnectSent ? final.cleanup_pending.filter((s) => s.binding_id === b.id) : [
            ...recordedObjects({ ...final, exposures: [...detail.exposures, ...final.exposures] }, answer?.closed_exposures ?? []), ...final.cleanup_pending.filter((s) => s.binding_id === b.id)
          ];
          const done = [];
          const deleted = [];
          const absent = [];
          const skipped = [];
          const remaining = [];
          const visited = new Set();
          const accountAdmin = new Set(final.cleanup_pending.filter((s) => s.actor === 'account_admin').map(objectKey));
          // AUTH-012: snapshot other open inventories once before deleting recorded ids.
          const held = new Set();
          for (const other of await listBindings(br, `https://${b.host}`)) {
            if (other.id === b.id || closed(other)) continue;
            const current = bindingRead(await br(customerPaths.databricksBinding(other.id)));
            for (const step of recordedObjects(current)) held.add(objectKey(step));
          }
          for (const step of steps) {
            const key = objectKey(step);
            if (visited.has(key) || step.kind === 'agent_service_principal' || isSpStep(step)) continue;
            visited.add(key);
            if (accountAdmin.has(key)) { remaining.push({ kind: step.kind, id: step.id }); continue; }
            if (held.has(key)) { skipped.push({ kind: step.kind, id: step.id }); continue; }
            const outcome = await deleteRecorded(ws, step);
            const item = { kind: step.kind, id: step.id };
            if (outcome) {
              done.push(item);
              (outcome === 'deleted' ? deleted : absent).push(item);
            } else remaining.push(item);
          }
          if (done.length) await br(customerPaths.databricksCleanup(b.id, { done }));
          final = bindingRead(await br(customerPaths.databricksBinding(b.id)));
          result = { ...(answer ?? {}), disconnect_sent: disconnectSent, ...final, state: final.binding.state, deleted, absent, skipped, remaining, pending_steps };
          render = renderDatabricksDisconnect;
        }
      }
    }
    // AUTH-012 / DATA-001: protect both output modes from reflected credential values.
    result = JSON.parse(clean(JSON.stringify(result)));
    return emit(ctx, result, () => render(result));
  } catch (error) {
    const safeCodes = new Set([...Object.keys(exits), 'workspace_proof_invalid', 'workspace_proof_replayed', 'workspace_unreachable', 'workspace_connected_elsewhere', 'route_eval_in_repo', 'route_eval_hosted', 'route_not_found', 'binding_disconnecting', 'forbidden', 'invalid_results_owner', 'manifest_invalid', 'route_not_declared', 'secret_scope_reserved', 'benchrouter_request_failed']);
    const code = error instanceof DatabricksError ? (safeCodes.has(error.code) ? error.code : 'databricks_request_failed') : 'command_failed';
    ctx.fail(clean(error instanceof Error ? error.message : 'Databricks command failed.'), code, exits[code] ?? 1);
  }
}
function shellWord(value) {
  return [...value].every((c) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-'.includes(c)) && value ? value : `'${value.split("'").join("'\\''")}'`;
}

function validateClosedExposures(answer) {
  if (answer?.ok !== true || !Array.isArray(answer.closed_exposures) || answer.closed_exposures.some((e) => !e
      || !['endpoint_name', 'provider_service_name'].every((k) => typeof e[k] === 'string'))) {
    throw new Error('BenchRouter returned an invalid closed exposure list.');
  }
}

function validateDisconnect(answer) {
  validateClosedExposures(answer);
  if (!bindingStates.includes(answer.state)
      || !['queued', 'none'].includes(answer.cleanup)
      || !(answer.disconnect_requested_at === null || typeof answer.disconnect_requested_at === 'string')) {
    throw new Error('BenchRouter returned an invalid disconnect response.');
  }
}
