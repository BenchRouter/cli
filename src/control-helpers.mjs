import {
  defaultApiUrl,
  requireAccountCredential,
  requireAdminCredential,
  apiRequest
} from "./http.mjs";
import * as render from "./render.mjs";

export function accountClient(ctx) {
  const credential = requireAccountCredential(ctx.stringArg("account-token"));
  return { apiUrl: defaultApiUrl(ctx.stringArg("api-url")), token: credential.token };
}

export function adminClient(ctx) {
  const credential = requireAdminCredential(ctx.stringArg("admin-token"));
  return { apiUrl: defaultApiUrl(ctx.stringArg("api-url")), token: credential.token };
}

/** Send a customer control-plane spec with the br_ctrl_ account token. */
export function accountRequest(ctx, spec) {
  return apiRequest({ ...accountClient(ctx), ...spec });
}

/** Send a public spec with no credential. */
export function publicRequest(ctx, spec) {
  return apiRequest({ apiUrl: defaultApiUrl(ctx.stringArg("api-url")), ...spec });
}

/** Send an admin spec with the bradm_ admin token. Never falls back to another scope. */
export function adminRequest(ctx, spec) {
  return apiRequest({ ...adminClient(ctx), ...spec });
}

/**
 * Every confirming command states its plan before it asks, so a shell that cannot answer
 * still sees what would happen and how to confirm it.
 */
export async function requireMutationConfirmation(ctx, summary) {
  const json = Boolean(ctx.args.json);
  const yes = Boolean(ctx.args.yes);
  if (yes) return;
  if (json) {
    ctx.fail(`Plan: ${summary}. Nothing was changed. JSON mode cannot prompt; rerun with --yes to confirm.`, "confirmation_required");
  }
  process.stdout.write(`Plan: ${summary}\n`);
  const confirmed = await ctx.confirmPrompt("Continue? [y/N] ");
  if (!confirmed) {
    process.stdout.write("Declined. No changes made.\n");
    process.exit(0);
  }
}

export function emit(ctx, body, human) {
  if (ctx.args.json) return render.printJson(body);
  return human();
}

export function subcommand(ctx) {
  return ctx.args._[1];
}

export function unknown(ctx, root, sub) {
  ctx.usage(1, root, `Unknown command: ${root}${sub ? ` ${sub}` : ""}`.trimEnd());
}
