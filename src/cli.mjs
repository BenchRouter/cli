#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { isMap, isSeq, parseDocument } from "yaml";
import { normalizeRepoFullName, resolveAccountToken, resolveRepoToken, saveRepoToken } from "./config.mjs";
import { apiRequest, ApiError } from "./http.mjs";
import { isControlPlaneCommand, runControlCommand } from "./commands.mjs";
import { controlUsageText, topLevelControlUsageLines } from "./usage-text.mjs";
import { CliUsageError, runRepoRead } from "./repo-read.mjs";
import { readRouteManifest } from "./route-manifest.mjs";
import { CLI_VERSION, newerVersionNotice } from "./version.mjs";
import { unifiedDiff } from "./line-diff.mjs";
import { applyUpgradePacket, prepareUpgradeFiles, preserveCustomerSetup, inspectSignedKit, preparePackageJson, preflightFileApplication, stageFileApplication, UPGRADE_GENERATED_PATHS, BOOTSTRAP_PATH, TRUST_PATH, WORKFLOW_PATH, LOCAL_SCRIPTS } from "./generated-kit.mjs";

// Every option name as typed, kept apart from parsed values so a name such as "_" or
// "__proto__" cannot hide in the positional list or the object prototype.
const OPTION_NAMES = Symbol("option names");
// Flags that every command reads only as on or off.
const BOOLEAN_FLAGS = new Set(["help", "json", "yes", "dry-run", "force", "overwrite-user-edits", "save-token",
  "live-chat-completions", "skip-github-workflow", "check-default-branch"]);
const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const EXECUTABLE_EVAL_PACK_FIELDS = new Set([
  "mode",
  "id",
  "config_path",
  "workflow",
  "result_schema",
  "case_refs",
  "argv",
  "runtime",
  "runtime_version",
  "lockfile",
  "working_directory",
  "isolation",
  "artifacts",
  "input_refs",
  "acceptance_refs",
  "result_path",
  "primary_metric",
  "timeout_minutes",
  "secret_env"
]);
// The env example file names doctor accepts, in the order it checks them. The first file found is the one doctor reads,
// so the two original names stay first.
// .dev.vars.example is the Wrangler (Cloudflare Workers and Pages) convention.
const RUNTIME_ENV_TEMPLATE_NAMES = [".env.example", "env.template", ".env.sample", ".env.template", ".dev.vars.example"];

// Every value a BenchRouter kit or init packet has written, per benchrouter: script name. A different
// old value is the customer's own script, which the kit replaces.
// Mined from the server's full history (2026-11-04).
const KIT_SCRIPT_HISTORY = {
  "benchrouter:capture": [LOCAL_SCRIPTS["benchrouter:capture"]],
  "benchrouter:calibrate": [LOCAL_SCRIPTS["benchrouter:calibrate"], "node .benchrouter/benchrouter-calibrate.mjs", "tsx scripts/benchrouter-calibrate.ts"],
  "benchrouter:eval": ["node .benchrouter/benchrouter-eval.mjs", "tsx scripts/benchrouter-eval.ts"]
};
// Every heading any BenchRouter-written .benchrouter/README.md has had (headings hold no variables),
// besides the new kit README's own headings, which come from the packet.
const KIT_README_HEADINGS = new Set([
  "# BenchRouter", "## What It Does", "## Credentials", "## Request Bodies", "## Folder Shape",
  "## Manage routes and spend from your agent", "## Improving your cases", "## Commands", "## Capture",
  "## Add another route to this repo", "## Executable eval file lists"
]);

// EVAL-012: the protocol a call site speaks. It chooses the BenchRouter base URL value.
const API_FAMILIES = new Set([
  "openai_chat_completions",
  "anthropic_messages",
  "openai_responses"
]);

// The flags each built-in command reads. A flag outside its list is a mistake (for example
// `upgrade --force`, which only init has), so the command stops before it does anything.
// Control-plane and runtime commands parse their own flags and are not listed here.
// json is read by the shared fail() and usage() helpers on every command.
const READ_COMMAND_FLAGS = ["help", "repo", "setup-key", "api-url", "json", "route"];
const LOCAL_COMMAND_FLAGS = {
  init: ["help", "json", "repo", "route-id", "name", "incumbent-model", "provider-id", "provider-ref", "eval-pack", "eval-command",
    "code-ref", "base-url-env", "api-family", "api-url", "dry-run", "force", "overwrite-user-edits", "output-dir", "setup-key", "save-token"],
  doctor: ["help", "json", "repo", "setup-key", "account-token", "api-url", "output-dir", "phase", "route-id", "live-chat-completions", "skip-github-workflow", "check-default-branch"],
  models: ["help", "api-url", "filter", "json"],
  upgrade: ["help", "json", "upgrade-token", "api-key", "repo", "route-id", "api-url", "output-dir", "yes", "dry-run"],
  status: READ_COMMAND_FLAGS,
  frontier: READ_COMMAND_FLAGS,
  failures: READ_COMMAND_FLAGS,
  explain: READ_COMMAND_FLAGS
};

if (Object.hasOwn(LOCAL_COMMAND_FLAGS, command)) {
  // These commands take no positional value that starts with "-", so such a token is a flag
  // the parser left in the positional list (for example -f).
  const unknownFlags = [
    ...args[OPTION_NAMES].filter((name) => !LOCAL_COMMAND_FLAGS[command].includes(name)).map((name) => `--${name}`),
    ...args._.filter((value) => typeof value === "string" && value.startsWith("-") && value.length > 1)
  ];
  if (unknownFlags.length > 0) {
    usage(1, command, `Unknown flag${unknownFlags.length > 1 ? "s" : ""} for benchrouter ${command}: ${[...new Set(unknownFlags)].join(", ")}. Nothing was changed.`);
  }
}

if (args.version === true && args._.length === 0) {
  process.stdout.write(`${CLI_VERSION}\n`);
  const notice = await newerVersionNotice("--version");
  if (notice) process.stderr.write(`${notice}\n`);
} else if (isControlPlaneCommand(command)) {
  await runControlCommand({
    args,
    optionNames: args[OPTION_NAMES],
    command,
    stringArg,
    fail,
    usage,
    confirmPrompt,
    detectGitHubRepo
  });
} else if (["capture", "calibrate", "run"].includes(command)) {
  localRuntimeCommand(command);
} else if (command === "init") {
  await init();
} else if (command === "doctor") {
  await doctor();
} else if (command === "models") {
  await models();
} else if (command === "upgrade") {
  await upgrade();
} else if (["status", "frontier", "failures", "explain"].includes(command)) {
  await readCommand(command);
} else if (command === "help" || args.help) {
  usage(0);
} else {
  usage(1, "all", `Unknown command: ${command}`);
}

function localRuntimeCommand(runtimeCommand) {
  if (args.help) usage(0, runtimeCommand);
  const file = path.resolve(BOOTSTRAP_PATH);
  if (!existsSync(file)) fail(`Missing ${BOOTSTRAP_PATH}. Run benchrouter init in this repository first.`);
  const result = spawnSync(process.execPath, [file, runtimeCommand, ...process.argv.slice(3)], { stdio: "inherit", env: process.env });
  if (result.error) fail(result.error.message);
  if (result.signal) fail(`BenchRouter ${runtimeCommand} stopped by ${result.signal}.`);
  process.exit(result.status ?? 1);
}

async function init() {
  if (args.help) {
    usage(0, "init");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const setupCode = stringArg("setup-key", process.env.BENCHROUTER_SETUP_KEY);
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  // --route-id / --name / --incumbent-model may be repeated to scaffold multiple
  // routes in one init. They are paired positionally: the Nth --route-id goes
  // with the Nth --name and Nth --incumbent-model. The first triple is primary.
  const routeIds = arrayArg("route-id");
  const routeNames = arrayArg("name");
  const incumbentModels = arrayArg("incumbent-model");
  const providerIds = arrayArg("provider-id");
  const providerRefs = arrayArg("provider-ref");
  const evalPackPaths = arrayArg("eval-pack");
  const codeRefs = arrayArg("code-ref");
  const captureCommand = stringArg("eval-command");
  const baseUrlEnvs = arrayArg("base-url-env");
  const apiFamilies = arrayArg("api-family");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const overwriteUserEdits = Boolean(args["overwrite-user-edits"]);
  const forceKitFiles = Boolean(args.force);

  if (!setupCode) {
    fail("Missing setup key. Pass --setup-key or set BENCHROUTER_SETUP_KEY.");
  }
  if (routeIds.length === 0 || routeNames.length === 0 || incumbentModels.length === 0) {
    usage(1, "init", "Missing --route-id, --name, or --incumbent-model.");
  }
  if (routeIds.length !== routeNames.length || routeIds.length !== incumbentModels.length) {
    usage(1, "init", "When repeating routes, pass one --name and one --incumbent-model per --route-id (in the same order).");
  }
  if ((providerIds.length === 0) !== (providerRefs.length === 0)) {
    usage(1, "init", "Pass --provider-id and --provider-ref together.");
  }
  if (providerIds.length > 0 && (providerIds.length !== routeIds.length || providerRefs.length !== routeIds.length)) {
    usage(1, "init", "Pass one --provider-id and --provider-ref per route, or omit both.");
  }
  if (evalPackPaths.length > 0 && evalPackPaths.length !== routeIds.length) {
    usage(1, "init", "Pass one --eval-pack JSON file per route, in the same order, or omit it for every route.");
  }
  if (baseUrlEnvs.length > 1 && baseUrlEnvs.length !== routeIds.length) {
    usage(1, "init", "When repeating --base-url-env, pass one value per --route-id (in the same order), or pass it once for all routes.");
  }
  if (apiFamilies.length > 1 && apiFamilies.length !== routeIds.length) {
    usage(1, "init", "When repeating --api-family, pass one value per --route-id (in the same order), or pass it once for all routes.");
  }
  const invalidApiFamily = apiFamilies.find((family) => !API_FAMILIES.has(family));
  if (invalidApiFamily !== undefined) {
    usage(1, "init", `--api-family ${invalidApiFamily} is not supported. Use openai_chat_completions, anthropic_messages, or openai_responses.`);
  }

  const evalPacks = evalPackPaths.map((evalPackPath, index) =>
    readExecutableEvalPack(evalPackPath, routeIds[index], outputDir)
  );
  const routeSpecs = routeIds.map((id, index) => ({
    route_id: id,
    name: routeNames[index],
    incumbent_model: incumbentModels[index],
    provider_id: providerIds[index],
    provider_ref: providerRefs[index],
    eval_pack: evalPacks[index],
    code_refs: codeRefs,
    eval_command: captureCommand,
    base_url_env: baseUrlEnvs[index] ?? baseUrlEnvs[0] ?? "",
    api_family: apiFamilies[index] ?? apiFamilies[0] ?? ""
  }));
  // EVAL-012: a route that names a base URL env or runs an executable eval declares its protocol.
  const undeclared = routeSpecs.find((spec) => !spec.api_family && (spec.base_url_env || spec.eval_pack));
  if (undeclared) {
    usage(1, "init", `Route ${undeclared.route_id} sets --base-url-env or --eval-pack, so pass --api-family: the protocol its call site speaks (openai_chat_completions, anthropic_messages, or openai_responses).`);
  }
  const routeId = routeSpecs[0].route_id;
  const routeName = routeSpecs[0].name;
  const incumbentModel = routeSpecs[0].incumbent_model;

  const recoveryUrl = existsSync(path.join(outputDir, ".benchrouter/benchrouter.yml"))
    ? "https://benchrouter.com/cli/new"
    : "https://benchrouter.com/cli";
  try {
    const packageFiles = preparePackageJson(outputDir, { scripts: LOCAL_SCRIPTS });
    await preflightFileApplication(outputDir, [...UPGRADE_GENERATED_PATHS.map((filePath) => ({ path: filePath })), ...packageFiles]);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not validate the setup destination.");
  }
  const previewResponse = await fetchSetupPacket({
    apiUrl,
    setupCode,
    repoFullName,
    routeSpecs,
    dryRun: true,
    recoveryUrl
  });
  const previewPacket = previewResponse.setup_packet;
  const targetRepo = repoFullName ?? previewResponse.repo_full_name;



  // The dry run and the real run share this plan, so the preview names exactly what init writes and skips.
  const plannedFiles = [];
  const skippedFiles = [];
  for (const file of previewPacket.files) {
    if (file.path === ".env.example") continue;
    const targetPath = safeTargetPath(outputDir, file.path);
    const previous = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
    let content = file.content;
    if (file.path === ".benchrouter/benchrouter.yml" && previous !== null) {
      content = mergeRequestedRoutesIntoManifest(previous, content, routeIds, declaredApiFamilies(routeSpecs));
    } else if (file.path === WORKFLOW_PATH && previous !== null) {
      content = preserveCustomerSetup(previous, content);
    } else if (previous !== null && previous !== content && !overwriteUserEdits && !(forceKitFiles && isBenchRouterKitFile(file.path))) {
      skippedFiles.push(isBenchRouterKitFile(file.path)
        ? `${file.path} (it differs from BenchRouter's copy; --force replaces BenchRouter kit and README files)`
        : `${file.path} (it differs from BenchRouter's copy; --overwrite-user-edits replaces it)`);
      continue;
    }
    plannedFiles.push({ path: file.path, content, previousContent: previous });
  }

  if (dryRun) {
    process.stdout.write(`Dry run for ${targetRepo}\n`);
    let packageFiles = [];
    try {
      packageFiles = preparePackageJson(outputDir, previewPacket.package_json);
    } catch (error) {
      fail(error instanceof Error ? error.message : "Could not plan the package.json update.");
    }
    writeFilePreview(outputDir, [...plannedFiles, ...packageFiles]);
    writeOwnershipWarnings(outputDir, [...plannedFiles, ...packageFiles]);
    if (packageFiles.length === 0) skippedFiles.push("package.json (no package.json found, so no scripts update)");
    if (skippedFiles.length > 0) {
      process.stdout.write(`Would skip ${skippedFiles.length} file(s):\n`);
      for (const line of skippedFiles) process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write("runtime env configuration is deferred until activation\n");
    process.stdout.write("would request Runtime/host BENCHROUTER_API_KEY during a real init\n");
    return;
  }

  for (const line of skippedFiles) process.stdout.write(`skip-existing ${line}\n`);
  try {
    plannedFiles.push(...preparePackageJson(outputDir, previewPacket.package_json));
    await (await stageFileApplication({
      outputDir, files: plannedFiles,
      onFile(action, filePath) { process.stdout.write(`${action} ${filePath}\n`); }
    })).commit();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not apply the BenchRouter setup packet.");
  }
  if (!existsSync(path.join(outputDir, "package.json"))) process.stdout.write("skipped package.json update; no package.json found\n");

  process.stdout.write("Runtime env configuration is deferred until activation. Existing env examples are unchanged.\n");

  const commitResponse = await fetchSetupPacket({
    apiUrl,
    setupCode,
    repoFullName,
    routeSpecs,
    dryRun: false,
    recoveryUrl
  });
  const committedPacket = commitResponse.setup_packet;
  if (committedPacket.keys_already_provisioned) {
    const rotateUrl = typeof committedPacket.rotate_url === "string" && committedPacket.rotate_url.length > 0
      ? committedPacket.rotate_url
      : "https://benchrouter.com/account";
    process.stdout.write(`Runtime key already issued. Reuse the stored product key at activation. If it is lost, create a replacement at ${rotateUrl} or use benchrouter login followed by benchrouter keys create --product-id <product-id>. Do not restart setup to recover a key.\n`);
  }
  printSetupApiKeys(committedPacket.setup_api_keys);
  await maybeSaveRepoReadToken(setupCode, targetRepo);
  printInitNextSteps();

  process.stdout.write("\nSuggested PR body:\n");
  process.stdout.write(prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel }));
}

function declaredApiFamilies(routeSpecs) {
  return new Map(routeSpecs.filter((spec) => spec.api_family).map((spec) => [spec.route_id, spec.api_family]));
}

// EVAL-012: rerunning init with --api-family updates an existing route's declared family. The
// executable eval's api_family is the copy the signed runtime reads, so it follows.
function setDeclaredApiFamily(route, apiFamily) {
  let changed = false;
  if (route.getIn(["call_site", "api_family"]) !== apiFamily) {
    route.setIn(["call_site", "api_family"], apiFamily);
    changed = true;
  }
  if (route.getIn(["eval_pack", "mode"]) === "repository_executable" && route.getIn(["eval_pack", "api_family"]) !== apiFamily) {
    route.setIn(["eval_pack", "api_family"], apiFamily);
    changed = true;
  }
  return changed;
}

function mergeRequestedRoutesIntoManifest(existingSource, previewSource, requestedRouteIds, apiFamilies) {
  const existingDocument = parseDocument(existingSource);
  const previewDocument = parseDocument(previewSource);
  if (existingDocument.errors.length > 0) {
    throw new Error(`.benchrouter/benchrouter.yml is not valid YAML: ${existingDocument.errors[0].message}`);
  }
  if (previewDocument.errors.length > 0) {
    throw new Error(`Preview .benchrouter/benchrouter.yml is not valid YAML: ${previewDocument.errors[0].message}`);
  }

  const existingRoutes = existingDocument.get("routes", true);
  const previewRoutes = previewDocument.get("routes", true);
  if (!isSeq(existingRoutes) || !isSeq(previewRoutes)) {
    throw new Error("Both the local and preview .benchrouter/benchrouter.yml files must contain a routes sequence.");
  }

  const requested = new Set(requestedRouteIds);
  const existingIds = new Set(
    existingRoutes.items
      .filter(isMap)
      .map((route) => route.get("route_id"))
      .filter((routeId) => typeof routeId === "string")
  );
  let changed = false;
  for (const existingRoute of existingRoutes.items) {
    if (!isMap(existingRoute)) {
      continue;
    }
    const apiFamily = apiFamilies.get(existingRoute.get("route_id"));
    if (apiFamily && setDeclaredApiFamily(existingRoute, apiFamily)) {
      changed = true;
    }
  }
  for (const previewRoute of previewRoutes.items) {
    if (!isMap(previewRoute)) {
      continue;
    }
    const routeId = previewRoute.get("route_id");
    if (typeof routeId !== "string" || !requested.has(routeId) || existingIds.has(routeId)) {
      continue;
    }
    existingRoutes.add(existingDocument.createNode(previewRoute.toJSON()));
    existingIds.add(routeId);
    changed = true;
  }

  const missingRequestedRoute = requestedRouteIds.find((routeId) => !existingIds.has(routeId));
  if (missingRequestedRoute) {
    throw new Error(`Preview .benchrouter/benchrouter.yml is missing requested route ${missingRequestedRoute}.`);
  }

  if (!changed) {
    return existingSource;
  }
  return existingDocument.toString({ lineWidth: 0 });
}

async function upgrade() {
  if (args.help) {
    usage(0, "upgrade");
  }

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const upgradeToken = stringArg("upgrade-token", process.env.BENCHROUTER_UPGRADE_TOKEN);
  const apiKey = upgradeToken ? undefined : stringArg("api-key", process.env.BENCHROUTER_API_KEY);
  const bearer = upgradeToken ?? apiKey;
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  const routeId = stringArg("route-id");
  const outputDir = path.resolve(stringArg("output-dir", process.cwd()));
  const dryRun = Boolean(args["dry-run"]);
  const autoYes = Boolean(args.yes);

  if (!bearer) {
    fail("Missing BenchRouter credential. At a terminal, mint a one-time upgrade token with `benchrouter setup upgrade-token --route-id <id>` (after `benchrouter login`) or from the dashboard banner, then pass --upgrade-token. In CI, pass --api-key or set BENCHROUTER_API_KEY.");
  }
  if (!repoFullName) {
    usage(1, "upgrade", "Missing --repo and unable to detect one from git remote.");
  }
  if (!routeId) {
    usage(1, "upgrade", "Missing --route-id.");
  }

  // Validate canonical route truth before consuming a single-use token.
  try {
    readRouteManifest(outputDir);
    const packageFiles = preparePackageJson(outputDir, { scripts: LOCAL_SCRIPTS });
    await preflightFileApplication(outputDir, [...UPGRADE_GENERATED_PATHS.map((filePath) => ({ path: filePath })), ...packageFiles]);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not validate the existing BenchRouter kit.");
  }

  // 1. Preview — does NOT consume the upgrade token. Preview only supports the
  //    single-use upgrade token flow; API-key auth goes straight to apply (which
  //    is idempotent and re-runnable for API keys).
  if (upgradeToken) {
    const preview = await fetchUpgradePacket({
      apiUrl,
      bearer,
      repoFullName,
      routeId,
      mode: "preview"
    });
    let planned;
    try {
      planned = [...prepareUpgradeFiles(outputDir, preview.files), ...preparePackageJson(outputDir, { scripts: LOCAL_SCRIPTS })];
      await preflightFileApplication(outputDir, planned);
    } catch (error) {
      fail(error instanceof Error ? error.message : "BenchRouter returned an invalid kit upgrade preview.");
    }

    process.stdout.write(`Planned BenchRouter kit upgrade to ${preview.setup_kit_version} for ${preview.repo_full_name} / ${preview.route_id}\n`);
    writeFilePreview(outputDir, planned, "No file changes: every file already matches this kit version.");
    writeOwnershipWarnings(outputDir, planned);

    if (dryRun) {
      return;
    }

    if (!autoYes) {
      const confirmed = await confirmPlan(
        `apply BenchRouter kit ${preview.setup_kit_version} to ${preview.repo_full_name} / ${preview.route_id} as listed above`,
        "Apply these changes? [y/N] "
      );
      if (!confirmed) {
        process.stdout.write("Declined. No changes written.\n");
        return;
      }
    }
  } else if (dryRun) {
    fail("--dry-run requires --upgrade-token; the API-key apply endpoint consumes nothing but cannot be safely previewed without a token.");
  } else if (!autoYes) {
    const confirmed = await confirmPlan(`apply the current BenchRouter kit to ${repoFullName} / ${routeId}`, "Apply these changes? [y/N] ");
    if (!confirmed) {
      process.stdout.write("Declined. No changes written.\n");
      return;
    }
  }

  // 2. Apply — for upgrade tokens this consumes the token, so the preview above
  //    must succeed first. Re-derive the packet server-side; do NOT reuse the
  //    preview response as if it were authoritative.
  try {
    readRouteManifest(outputDir);
    const packageFiles = preparePackageJson(outputDir, { scripts: LOCAL_SCRIPTS });
    await preflightFileApplication(outputDir, [...UPGRADE_GENERATED_PATHS.map((filePath) => ({ path: filePath })), ...packageFiles]);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not validate the existing BenchRouter kit.");
  }
  const applied = await fetchUpgradePacket({
    apiUrl,
    bearer,
    repoFullName,
    routeId,
    mode: "apply"
  });

  process.stdout.write(`Upgrading BenchRouter kit to ${applied.setup_kit_version} for ${applied.repo_full_name} / ${applied.route_id}\n`);
  try {
    await applyUpgradePacket({
      outputDir,
      files: applied.files,
      onFile(action, filePath) {
        process.stdout.write(`${action} ${filePath}\n`);
      }
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not apply the BenchRouter kit upgrade.");
  }

  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Review the diff. benchrouter.yml and route-owned cases, scorers, calibration fixtures, and app files must be unchanged.\n");
  process.stdout.write(`- Run \`npx --yes benchrouter@latest doctor --repo ${repoFullName}\`.\n`);
  process.stdout.write("- Open a PR titled \"Upgrade BenchRouter kit\".\n");
}

// The preview compares each planned file with the file on disk, so a reviewer sees
// only real changes, with a diff for each updated file.
function writeFilePreview(outputDir, planned, noChanges = "No file changes: every file already matches.") {
  const rows = planned.map((file) => {
    const target = safeTargetPath(outputDir, file.path);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    return { ...file, current, action: current === null ? "create" : current === file.content ? "unchanged" : "update" };
  });
  const changed = rows.filter((row) => row.action !== "unchanged");
  const unchanged = rows.filter((row) => row.action === "unchanged");
  if (changed.length === 0) {
    process.stdout.write(`${noChanges}\n`);
  } else {
    process.stdout.write(`Would change ${changed.length} file(s):\n`);
    for (const row of changed) process.stdout.write(`  ${row.action === "create" ? "create" : "update"} ${row.path}\n`);
  }
  if (unchanged.length > 0) {
    process.stdout.write(`Unchanged (${unchanged.length}):\n`);
    for (const row of unchanged) process.stdout.write(`  ${row.path}\n`);
  }
  for (const row of changed) {
    process.stdout.write(`\n${unifiedDiff(row.path, row.current ?? "", row.content)}`);
  }
}

// Warns before BenchRouter replaces content it did not write: a customer's own benchrouter:
// script, or sections a customer added to .benchrouter/README.md. A README heading that the
// new kit README does not have is treated as the customer's.
function writeOwnershipWarnings(outputDir, planned) {
  const warnings = [];
  for (const file of planned) {
    const target = safeTargetPath(outputDir, file.path);
    if (!existsSync(target)) continue;
    const current = readFileSync(target, "utf8");
    if (current === file.content) continue;
    if (file.path === "package.json") {
      let before;
      let after;
      try { before = JSON.parse(current).scripts ?? {}; after = JSON.parse(file.content).scripts ?? {}; } catch { continue; }
      for (const [name, value] of Object.entries(before)) {
        if (!name.startsWith("benchrouter:") || after[name] === value || typeof value !== "string" || (KIT_SCRIPT_HISTORY[name] ?? []).includes(value)) continue;
        warnings.push(`replaces your script ${name} (${value}); keep your own scripts under another name`);
      }
    } else if (file.path === ".benchrouter/README.md") {
      const kitHeadings = new Set(markdownHeadings(file.content));
      const customer = markdownHeadings(current).filter((heading) => !kitHeadings.has(heading) && !KIT_README_HEADINGS.has(heading));
      if (customer.length > 0) {
        warnings.push(`replaces .benchrouter/README.md, which has content BenchRouter did not write (sections: ${customer.join("; ")}). Move your notes to a file BenchRouter does not write`);
      }
    }
  }
  if (warnings.length === 0) return;
  process.stdout.write(`\nWarning: this replaces content BenchRouter did not write:\n`);
  for (const warning of warnings) process.stdout.write(`  - ${warning}\n`);
}

// ATX heading texts (# to ######) outside fenced code blocks, following CommonMark: a fence is
// three or more backticks or tildes indented at most three spaces, and only a run of the same
// character at least as long, with nothing after it, closes it.
function markdownHeadings(text) {
  const headings = [];
  let fence = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let indent = 0;
    while (line[indent] === " ") indent += 1;
    const rest = line.slice(indent);
    const fenceChar = rest[0] === "`" || rest[0] === "~" ? rest[0] : null;
    let run = 0;
    while (fenceChar !== null && rest[run] === fenceChar) run += 1;
    if (fence !== null) {
      if (indent <= 3 && fenceChar === fence.char && run >= fence.length && rest.slice(run).trim() === "") fence = null;
      continue;
    }
    if (indent > 3) continue;
    if (fenceChar !== null && run >= 3 && !(fenceChar === "`" && rest.slice(run).includes("`"))) {
      fence = { char: fenceChar, length: run };
      continue;
    }
    let level = 0;
    while (rest[level] === "#") level += 1;
    const after = rest[level];
    if (level === 0 || level > 6 || (after !== undefined && after !== " " && after !== "\t")) continue;
    let textPart = rest.slice(level).trim();
    // An optional closing run of # preceded by a space is not part of the heading.
    let end = textPart.length;
    while (end > 0 && textPart[end - 1] === "#") end -= 1;
    if (end < textPart.length && (end === 0 || textPart[end - 1] === " " || textPart[end - 1] === "\t")) textPart = textPart.slice(0, end).trim();
    if (textPart !== "") headings.push(`${"#".repeat(level)} ${textPart}`);
  }
  return headings;
}

async function fetchUpgradePacket({ apiUrl, bearer, repoFullName, routeId, mode }) {
  const endpoint = mode === "preview"
    ? "/v1/setup/upgrade-packet/preview"
    : "/v1/control/setup-packet/upgrade";

  const response = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ repo_full_name: repoFullName, route_id: routeId })
  });

  const responseText = await response.text();

  if (!response.ok) {
    if (isTokenInvalid(response.status, parseJson(responseText))) {
      fail("Upgrade token is no longer valid (already used / expired / revoked). Mint a new one in the dashboard.");
    }
    const label = mode === "preview" ? "Setup kit upgrade preview" : "Setup kit upgrade apply";
    fail(`${label} request failed (${response.status}): ${responseText.slice(0, 800)}`);
  }

  const body = parseJson(responseText);
  if (!body || body.ok !== true || !Array.isArray(body.files) || typeof body.setup_kit_version !== "string") {
    fail("BenchRouter did not return a valid upgrade response.");
  }
  return body;
}

function isTokenInvalid(status, parsed) {
  if (status === 410 || status === 404) {
    return true;
  }
  const code = parsed?.error?.code;
  if (typeof code !== "string") {
    return false;
  }
  return code === "upgrade_token_used"
    || code === "upgrade_token_expired"
    || code === "upgrade_token_revoked"
    || code === "invalid_upgrade_token";
}

async function confirmPrompt(question) {
  if (!process.stdin.isTTY) {
    // The caller printed the plan first; say how to confirm it.
    fail("Nothing was changed: this shell cannot answer a confirmation prompt. Rerun with --yes to confirm.", "confirmation_required");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/** State the plan, then ask. JSON mode never prompts: it refuses with the plan and names --yes. */
async function confirmPlan(plan, question) {
  if (args.json) {
    fail(`Plan: ${plan}. Nothing was changed. JSON mode cannot prompt; rerun with --yes to confirm.`, "confirmation_required");
  }
  process.stdout.write(`Plan: ${plan}\n`);
  return confirmPrompt(question);
}

async function maybeSaveRepoReadToken(token, repoFullName) {
  if (!token?.startsWith("br_setup_") || !repoFullName) {
    return;
  }
  let approved = Boolean(args["save-token"]);
  // Optional: only an interactive human run asks; everyone else gets the hint below.
  if (!approved && process.stdin.isTTY && !args.json) {
    process.stdout.write(`Plan: save repo read access for ${repoFullName} on this computer\n`);
    approved = await confirmPrompt("Save it? [y/N] ");
  }
  if (!approved) {
    process.stdout.write("Setup key not saved. The read commands (status, frontier, failures, explain) need it: set BENCHROUTER_SETUP_KEY or pass --setup-key, or rerun init with --save-token.\n");
    return;
  }
  try {
    const target = await saveRepoToken(repoFullName, token);
    process.stdout.write(`Saved repo-scoped read access in ${target}.\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not save repo read access.");
  }
}

function printSetupApiKeys(setupApiKeys) {
  if (!setupApiKeys?.production?.key) {
    return;
  }
  process.stdout.write("\nBenchRouter generated a runtime API key. It is shown once:\n");
  process.stdout.write(`- Runtime/host BENCHROUTER_API_KEY: ${setupApiKeys.production.key}\n`);
  process.stdout.write("Store it now. If it is lost, create a replacement under Account → API keys.\n");
}

function printInitNextSteps() {
  process.stdout.write("\nNext steps:\n");
  process.stdout.write("- Tell your coding agent: read .benchrouter/SETUP_README.md before editing. It explains the evaluation PR, eval evidence, scorer, calibration, and later activation.\n");
  process.stdout.write("- Keep production code and host configuration unchanged in the evaluation PR. Store the runtime key for later activation; it does not expire with the setup code.\n");
  process.stdout.write("- BenchRouter Evals uses GitHub OIDC. Do not add an eval API key to GitHub Actions.\n");
  process.stdout.write("- Run relevant product tests/build and `npx --yes benchrouter@latest doctor --phase evaluation` before opening the PR.\n");
}

function callSiteBody(spec) {
  if (!spec.base_url_env && !spec.api_family) return undefined;
  return { base_url_env: spec.base_url_env || undefined, api_family: spec.api_family || undefined };
}

async function fetchSetupPacket({ apiUrl, setupCode, repoFullName, routeSpecs, dryRun, recoveryUrl }) {
  const [primary, ...additional] = routeSpecs;
  const body = {
    repo_full_name: repoFullName,
    dry_run: dryRun ? true : undefined,
    route: {
      route_id: primary.route_id,
      name: primary.name,
      incumbent_model: primary.incumbent_model,
      provider_id: primary.provider_id,
      provider_ref: primary.provider_ref,
      eval_pack: primary.eval_pack,
      eval_command: primary.eval_command,
      code_refs: primary.code_refs.length > 0 ? primary.code_refs : undefined,
      call_site: callSiteBody(primary)
    },
    routes: additional.length > 0
      ? additional.map((spec) => ({
          route_id: spec.route_id,
          name: spec.name,
          incumbent_model: spec.incumbent_model,
          provider_id: spec.provider_id,
          provider_ref: spec.provider_ref,
          eval_pack: spec.eval_pack,
          eval_command: spec.eval_command,
          code_refs: spec.code_refs.length > 0 ? spec.code_refs : undefined,
          call_site: callSiteBody(spec)
        }))
      : undefined
  };

  const response = await fetch(`${apiUrl}/v1/control/setup-packet`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${setupCode}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify(stripUndefined(body))
  });

  const responseText = await response.text();

  if (!response.ok) {
    const parsed = parseJson(responseText);
    const error = parsed?.error;
    const errorCode = typeof error === "string" ? error : error?.code;
    if (errorCode === "setup_code_expired" || errorCode === "setup_scope_expired") {
      fail(`Setup access expired. Refresh it at ${recoveryUrl} and run init again.`);
    }
    if (isUnsupportedIncumbentModel(response.status, error)) {
      fail(unsupportedIncumbentMessage(primary.incumbent_model));
    }
    if (errorCode === "model_replacement_confirmation_required") {
      fail(modelReplacementMessage(error, matchingReplacementRouteSpec(error, routeSpecs)));
    }
    if (errorCode === "provider_identity_review_required") {
      fail(providerIdentityReviewMessage(error, primary));
    }
    if (errorCode === "approved_baseline_not_available") {
      fail(browserApprovalUnavailableMessage(primary));
    }
    if (errorCode === "incumbent_observation_changed") {
      fail(incumbentObservationChangedMessage(primary));
    }
    fail(`Setup packet request failed (${response.status}): ${responseText.slice(0, 800)}`);
  }

  return JSON.parse(responseText);
}

async function readCommand(kind) {
  if (args.help) {
    usage(0, kind);
  }
  const repoCandidate = stringArg("repo") ?? detectGitHubRepo();
  if (!repoCandidate) {
    usage(1, kind, "Missing --repo and unable to detect one from git remote.");
  }
  let repoFullName;
  try {
    repoFullName = normalizeRepoFullName(repoCandidate);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Repository must use the owner/repo form.", "invalid_repository");
  }
  const routeKey = args._[1];
  const modelId = kind === "explain" ? args._[1] : args._[2];
  if (["frontier", "failures"].includes(kind) && !routeKey) {
    usage(1, kind, "Missing route key.");
  }
  if (kind === "explain" && !modelId) {
    usage(1, kind, "Missing model id.");
  }
  let credential;
  try {
    credential = resolveRepoToken(repoFullName, stringArg("setup-key"));
  } catch (error) {
    fail(error instanceof Error ? error.message : "Could not read BenchRouter credentials.");
  }
  if (!credential) {
    fail("Missing the repository's setup key (br_setup_). Set BENCHROUTER_SETUP_KEY to the key you gave init, pass --setup-key, or rerun init with --save-token to keep it for this repository on this computer. With an account token from `benchrouter login`, `benchrouter routes show <route>` shows what a route serves and `benchrouter evals status <route>` shows its evaluation.");
  }
  try {
    await runRepoRead({
      kind,
      routeKey,
      modelId,
      route: stringArg("route"),
      apiUrl: stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, ""),
      repoFullName,
      token: credential.token,
      json: Boolean(args.json)
    });
  } catch (error) {
    if (error instanceof CliUsageError) {
      usage(1, kind, error.message);
    }
    fail(error instanceof Error ? error.message : `BenchRouter ${kind} failed.`);
  }
}

async function models() {
  if (args.help) {
    usage(0, "models");
  }
  // One model's results on a route: `benchrouter evals model <route-key> <model-id>`.
  if (args._.length > 1) usage(1, "models", "models takes no arguments. For one model on a route, use: benchrouter evals model <route-key> <model-id>");

  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const filter = stringArg("filter");
  let modelIds;
  try {
    modelIds = await fetchModelIds(apiUrl);
  } catch (error) {
    fail(`Could not fetch BenchRouter model catalog: ${error instanceof Error ? error.message : "request failed"}`);
  }

  const filtered = filter
    ? modelIds.filter((id) => id.toLowerCase().includes(filter.toLowerCase()))
    : modelIds;

  if (filtered.length === 0) {
    fail(`No enabled BenchRouter models matched ${JSON.stringify(filter)}.`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, models: filtered }, null, 2)}\n`);
    return;
  }
  for (const id of filtered) {
    process.stdout.write(`${id}\n`);
  }
}

async function doctor() {
  if (args.help) {
    usage(0, "doctor");
  }
  const root = path.resolve(stringArg("output-dir", process.cwd()));
  const apiUrl = stringArg("api-url", "https://api.benchrouter.com").replace(/\/+$/, "");
  const repoFullName = stringArg("repo") ?? detectGitHubRepo();
  const phase = stringArg("phase", "evaluation");
  const selectedRouteId = stringArg("route-id");
  if (phase !== "evaluation" && phase !== "activation") fail("--phase must be evaluation or activation.");
  if (phase === "activation" && !selectedRouteId) fail("Activation checks require --route-id product/route.");
  if (args["live-chat-completions"] && phase !== "activation") fail("--live-chat-completions requires --phase activation and --route-id. It makes a billable diagnostic request.");
  const failures = [];
  const passed = [];
  const skipped = [];
  const notes = [];
  const versionNotice = await newerVersionNotice("doctor");
  if (versionNotice) notes.push(versionNotice);
  const requiredFiles = [
    ".benchrouter/benchrouter.yml", BOOTSTRAP_PATH, TRUST_PATH, WORKFLOW_PATH,
    ".benchrouter/README.md", ".benchrouter/SETUP_README.md"
  ];

  for (const relativePath of requiredFiles) {
    if (!existsSync(path.join(root, relativePath))) {
      failures.push(`missing ${relativePath}`);
    }
  }

  await checkManifestForDoctor({ root, apiUrl, repoFullName, selectedRouteId, failures, passed, skipped });

  let manifestRoutes = [];
  try {
    manifestRoutes = readRouteManifest(root).routes;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "could not read .benchrouter/benchrouter.yml");
  }
  const selectedRoutes = selectedRouteId
    ? manifestRoutes.filter((route) => route.routeId === selectedRouteId)
    : manifestRoutes;
  if (selectedRouteId && selectedRoutes.length !== 1) failures.push(`Expected one declared route matching ${selectedRouteId}.`);
  for (const route of manifestRoutes) {
    validateDeclaredFilesForDoctor(root, route, failures);
  }
  const routeFiles = discoverRouteFilesFromManifest(selectedRoutes, root);
  if (routeFiles.length === 0) {
    failures.push("could not discover route scorer/cases files from .benchrouter/benchrouter.yml");
  }

  // Isolated replay validates runnable case arrays and standalone scorers. Repository-executable
  // routes validate their declared repository inputs without imposing replay-only file shapes.
  for (const routeFile of routeFiles) {
    if (routeFile.evalMode !== "repository_executable") {
      validateCasesForDoctor(routeFile.casesPath, routeFile.casesRelPath, failures);
    }
  }
  for (const { evalMode, scorerPath, scorerRelPath } of routeFiles) {
    if (evalMode === "repository_executable" || !scorerRelPath) {
      continue;
    }
    if (existsSync(scorerPath)) {
      const check = spawnSync(process.execPath, ["--check", scorerPath], { encoding: "utf8" });
      if (check.status !== 0) {
        failures.push(`${scorerRelPath} failed node --check: ${(check.stderr || check.stdout).trim()}`);
      }
    }
  }

  inspectSignedKit(root, failures);
  const bootstrapPath = path.join(root, BOOTSTRAP_PATH);
  if (existsSync(bootstrapPath)) {
    const check = spawnSync(process.execPath, ["--check", bootstrapPath], { encoding: "utf8" });
    if (check.status !== 0) failures.push(`${BOOTSTRAP_PATH} failed node --check: ${(check.stderr || check.stdout).trim()}`);
  }

  const packageJsonPath = path.join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    failures.push("missing package.json");
  } else {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    for (const [name, value] of Object.entries(LOCAL_SCRIPTS)) {
      const current = parsed.scripts?.[name];
      if (current === undefined) failures.push(`package.json scripts.${name} must be ${value}`);
      else if (current !== value && (KIT_SCRIPT_HISTORY[name] ?? []).includes(current)) {
        failures.push(`package.json scripts.${name} is an older BenchRouter value (${JSON.stringify(current)}); run benchrouter upgrade to set ${JSON.stringify(value)}.`);
      } else if (current !== value) {
        failures.push(`package.json scripts.${name} is ${JSON.stringify(current)}, not BenchRouter's ${JSON.stringify(value)}. ` +
          `BenchRouter owns ${name}: rename your script to a name outside benchrouter:, then set ${name} back to ${JSON.stringify(value)} (upgrade does this).`);
      }
    }
  }

  const envTemplate = resolveRuntimeEnvTemplate(root);
  if (!envTemplate && phase === "activation") {
    failures.push(`missing a runtime env example file; doctor looks for ${RUNTIME_ENV_TEMPLATE_NAMES.join(", ")}`);
  } else if (envTemplate) {
    const envExample = readFileSync(envTemplate.path, "utf8");
    const envKeys = parseEnvExampleKeys(envExample);
    const commentedEnvKeys = parseCommentedEnvExampleKeys(envExample);
    const expectedRuntimeKeys = new Set([
      "BENCHROUTER_API_KEY",
      ...manifestRoutes.map((route) => route.callSiteBaseUrlEnv).filter(Boolean)
    ]);
    for (const key of phase === "activation" ? new Set(["BENCHROUTER_API_KEY", ...selectedRoutes.map((route) => route.callSiteBaseUrlEnv)]) : []) {
      if (!envKeys.includes(key)) {
        failures.push(commentedEnvKeys.includes(key)
          ? `found ${key} commented out in ${envTemplate.relativePath}; uncomment it`
          : `${envTemplate.relativePath} missing ${key}`);
      }
    }
    if (envKeys.includes("BENCHROUTER_EVAL_API_KEY")) {
      failures.push(`${envTemplate.relativePath} must not include BENCHROUTER_EVAL_API_KEY; GitHub Actions authenticates with OIDC`);
    }
    const allowedBenchRouterRuntimeKeys = new Set(["BENCHROUTER_API_KEY"]);
    if (expectedRuntimeKeys.has("BENCHROUTER_DISPATCH_API_URL")) {
      allowedBenchRouterRuntimeKeys.add("BENCHROUTER_DISPATCH_API_URL");
    }
    const ciOnlyBenchRouterKeys = envKeys.filter(
      (key) => key.startsWith("BENCHROUTER_")
        && !allowedBenchRouterRuntimeKeys.has(key)
        && key !== "BENCHROUTER_EVAL_API_KEY"
    );
    if (ciOnlyBenchRouterKeys.length > 0) {
      failures.push(`${envTemplate.relativePath} includes CI-only BenchRouter env vars: ${ciOnlyBenchRouterKeys.join(", ")}`);
    }
    if (/br_(live|test|setup)_[A-Za-z0-9_-]+/.test(envExample)) {
      failures.push(`${envTemplate.relativePath} appears to contain a raw BenchRouter secret`);
    }
  }

  if (phase === "activation") {
    notes.push(...runtimeHostChecklist({ root, routes: selectedRoutes, apiUrl }));
    const wiringResult = validateRuntimeWiringForDoctor(root, selectedRoutes, failures);
    if (wiringResult.ok) {
      passed.push(`runtime wiring: ${wiringResult.routesChecked} route${wiringResult.routesChecked === 1 ? "" : "s"} reference call_site.base_url_env from code_refs`);
    }
  } else {
    skipped.push("runtime wiring: evaluation preparation does not require a production call-site change or runtime credentials");
  }

  if (args["live-chat-completions"] && failures.length === 0) {
    const route = selectedRoutes[0];
    if (process.env.BENCHROUTER_API_KEY && route.callSiteApiFamily && route.callSiteApiFamily !== "openai_chat_completions") {
      fail("This route declares a different protocol. Verify it with an authorized application request instead of the Chat Completions diagnostic.");
    }
    const proxyResult = await verifyProxyPingForDoctor({ apiUrl, apiKey: process.env.BENCHROUTER_API_KEY, routeId: selectedRouteId, failures });
    if (proxyResult.ok) {
      passed.push(`live proxy authentication: runtime BENCHROUTER_API_KEY from env worked for ${proxyResult.routeId}`);
      passed.push(`live proxy model resolution: configured route ${proxyResult.routeId} selected ${proxyResult.model} and returned usage`);
      notes.push("The synthetic Chat Completions diagnostic does not verify the application's request contract or behavior.");
    } else if (proxyResult.skipped) {
      skipped.push(`live proxy authentication and route resolution: ${proxyResult.reason}`);
    }
  } else {
    skipped.push("live proxy authentication and route resolution: no request made; --phase activation --route-id product/route --live-chat-completions opts into a billable Chat Completions diagnostic");
  }

  if (!args["skip-github-workflow"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for workflow check; pass --repo owner/repo or --skip-github-workflow");
    } else {
      verifyGitHubWorkflowState(repoFullName, failures, passed, skipped);
      notes.push("GitHub Actions checklist: BenchRouter Evals uses keyless OIDC (id-token: write); no eval API key is stored in the repo");
    }
  } else {
    skipped.push("GitHub workflow state: --skip-github-workflow was passed");
  }

  if (args["check-default-branch"]) {
    if (!repoFullName) {
      failures.push("could not detect GitHub repo for default-branch check; pass --repo owner/repo");
    } else {
      verifyDefaultBranchConfig(repoFullName, failures, passed);
    }
  } else {
    skipped.push("default-branch config: pass --check-default-branch to verify the remote default branch");
  }

  skipped.push(
    `production readiness: run benchrouter setup status${repoFullName ? ` --repo ${repoFullName}` : " --repo owner/repo"} with an account token`
  );
  skipped.push("evaluation quality: local files, calibration, and wiring do not certify eval quality or a production result");

  if (failures.length > 0) {
    printDoctorReport(process.stderr, { passed, skipped, notes, failures });
    process.stderr.write("BenchRouter doctor failed one or more checks.\n");
    process.exit(1);
  }

  printDoctorReport(process.stdout, { passed, skipped, notes, failures });
  process.stdout.write("BenchRouter doctor passed all checks that ran. Skipped checks are listed above.\n");
  process.stdout.write("This result does not certify evaluation quality or production readiness.\n");
}

function printDoctorReport(stream, { passed, skipped, notes, failures }) {
  for (const item of passed) stream.write(`doctor passed: ${item}\n`);
  for (const item of skipped) stream.write(`doctor skipped: ${item}\n`);
  for (const item of notes) stream.write(`doctor note: ${item}\n`);
  for (const item of failures) stream.write(`doctor failed: ${item}\n`);
}

async function checkManifestForDoctor({ root, apiUrl, repoFullName, selectedRouteId, failures, passed, skipped }) {
  let manifest;
  try {
    manifest = readFileSync(path.join(root, ".benchrouter/benchrouter.yml"));
  } catch {
    // The existing local checks report missing or unreadable manifests.
  }
  if (manifest?.length > 256 * 1024) {
    failures.push("manifest check: benchrouter.yml exceeds the 256 KiB UTF-8 limit");
    return;
  }
  let credential;
  try {
    credential = resolveAccountToken(stringArg("account-token"))
      || (repoFullName || stringArg("setup-key") || process.env.BENCHROUTER_SETUP_KEY?.trim()
        ? resolveRepoToken(repoFullName, stringArg("setup-key")) : null);
  } catch {
    failures.push("manifest check: could not read a valid credential; run benchrouter login or use the repo's setup key");
    return;
  }
  if (!credential) {
    skipped.push("manifest rules not checked (no credential)");
    return;
  }
  if (!repoFullName) {
    skipped.push("manifest rules not checked (repo unknown); pass --repo owner/repo");
    return;
  }
  if (!manifest) return;
  const body = { repo_full_name: repoFullName, manifest_yaml: manifest.toString("utf8") };
  if (selectedRouteId) body.route_id = selectedRouteId;
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1024 * 1024) {
    failures.push("manifest check: request exceeds the 1 MiB JSON body limit");
    return;
  }
  const redact = (value) => value.split(credential.token).join("[REDACTED]");
  try {
    const result = await apiRequest({
      apiUrl, token: credential.token, method: "POST", path: "/v1/repo/manifest-check",
      body, label: "manifest check", timeoutMs: 3000, requireBody: true
    });
    const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
    if (typeof result?.ok !== "boolean" || !strings(result.errors) || !Array.isArray(result.routes)
      || !result.routes.every((route) => typeof route?.route_id === "string" && typeof route.ok === "boolean" && strings(route.errors))
      || !Array.isArray(result.not_checked)
      || !result.not_checked.every((item) => typeof item?.check === "string" && typeof item.detail === "string")) {
      skipped.push("manifest check: BenchRouter returned an invalid response; retry later");
      return;
    }
    for (const error of result.errors) failures.push(`manifest check: ${redact(error)}`);
    for (const route of result.routes) {
      for (const error of route.errors) failures.push(`manifest check route ${redact(route.route_id)}: ${redact(error)}`);
    }
    for (const item of result.not_checked) skipped.push(`manifest check ${redact(item.check)}: ${redact(item.detail)}`);
    const hasErrors = result.errors.length > 0 || result.routes.some((route) => route.errors.length > 0);
    if (result.ok && !hasErrors && result.routes.every((route) => route.ok)) {
      passed.push("manifest check: BenchRouter accepted benchrouter.yml");
    } else if (!hasErrors) {
      failures.push("manifest check: BenchRouter did not accept benchrouter.yml");
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      failures.push("manifest check: this credential cannot check this repo; run benchrouter login or use the repo's setup key");
    } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      // Only a bounded error code is safe to print from an error body.
      const code = typeof error.code === "string" && error.code.length <= 100 && error.code.length > 0
        && [...error.code].every((char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "_")
        ? ` (${redact(error.code)})` : "";
      failures.push(`manifest check: HTTP ${error.status}${code}; check benchrouter.yml, its size, and --route-id`);
    } else {
      skipped.push("manifest check: BenchRouter is unavailable or the request failed; retry later");
    }
  }
}

async function fetchModelIds(apiUrl) {
  const response = await fetch(`${apiUrl}/v1/models`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((model) => model?.id)
    .filter((id) => typeof id === "string")
    .sort();
  if (ids.length === 0) {
    throw new Error("catalog returned no enabled model IDs");
  }
  return ids;
}

function discoverRouteFilesFromManifest(routes, root) {
  return routes.map((route) => ({
    evalMode: route.evalMode,
    scorerPath: route.scorerPath ? path.join(root, route.scorerPath) : null,
    scorerRelPath: route.scorerPath,
    casesPath: path.join(root, route.casesPath),
    casesRelPath: route.casesPath,
    repositoryExecutableRefs: route.repositoryExecutableRefs
  }));
}

function validateDeclaredFilesForDoctor(root, route, failures) {
  const refs = new Set([route.configPath, route.scorerPath, ...route.caseRefs, ...route.codeRefs, ...route.repositoryExecutableRefs].filter(Boolean));
  for (const ref of refs) {
    const resolved = resolveDoctorRelativePath(root, ref);
    if (!resolved.ok) {
      failures.push(`route ${route.routeId}: declared file ${ref} is invalid: ${resolved.error}`);
      continue;
    }
    let isFile = false;
    try { isFile = statSync(resolved.path).isFile(); } catch { isFile = false; }
    if (existsSync(resolved.path) && !isFile) {
      failures.push(`route ${route.routeId}: declared file ${ref} is not a regular file`);
    } else if (!isFile) {
      // A declared config may also be one of the required kit files.
      const existing = failures.indexOf(`missing ${ref}`);
      if (existing !== -1) failures.splice(existing, 1);
      failures.push(`route ${route.routeId}: missing declared file ${ref}`);
    }
  }
}

function validateCasesForDoctor(casesPath, relPath, failures) {
  if (!existsSync(casesPath)) {
    return;
  }
  let cases;
  try {
    cases = JSON.parse(readFileSync(casesPath, "utf8"));
  } catch (error) {
    failures.push(`${relPath} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`);
    return;
  }
  if (!Array.isArray(cases)) {
    failures.push(`${relPath} must be a JSON array`);
    return;
  }
  // A real runnable case mirrors the eval harness's isRunnableCase: an id plus either a non-empty
  // input request body (test-derived/authored declared cases) OR a non-empty messages array (captured/legacy).
  // reference_output is optional — the captured source records it as an incumbent calibration sample;
  // test-derived/authored leave it null and carry the expected decision in scorer_metadata / the scorer.
  const realCases = cases.filter(
    (c) =>
      c &&
      !("_README" in c) &&
      typeof c.id === "string" &&
      c.id.length > 0 &&
      ((c.input && typeof c.input === "object" && Object.keys(c.input).length > 0) ||
        (Array.isArray(c.messages) && c.messages.length > 0))
  );
  if (realCases.length === 0) {
    failures.push(`${relPath} has no runnable cases yet — add declared cases (test-derived/authored) or run the capture step (captured) before opening the PR`);
  }
}

function isUnsupportedIncumbentModel(status, error) {
  if (status !== 400 || !error || typeof error !== "object") {
    return false;
  }
  return error.code === "model_not_allowed" && String(error.message ?? "").includes("route.incumbent_model");
}

function unsupportedIncumbentMessage(modelId) {
  return `BenchRouter did not accept the incumbent model: ${modelId}
Do not substitute another model. Confirm the exact model ID.
For a direct provider, also pass --provider-id and --provider-ref.
List catalog IDs with: npx --yes benchrouter@latest models`;
}

function modelReplacementMessage(error, routeSpec) {
  const approvalUrl = typeof error.approval_url === "string" && error.approval_url.length > 0
    ? error.approval_url
    : null;
  const canonicalOriginal = typeof error.canonical_original_model === "string"
    ? error.canonical_original_model
    : null;
  const alternatives = Array.isArray(error.alternatives)
    ? error.alternatives.filter(isReplacementAlternative)
    : [];
  if (!routeSpec || !approvalUrl || !canonicalOriginal || alternatives.length === 0) {
    return `BenchRouter requires a replacement for the observed incumbent, but it did not return complete matching approval evidence.
Do not choose or substitute a model. Start a new setup session and run the same init command again.`;
  }
  const choices = `\nApproved replacement choices:\n${alternatives.map(formatReplacementAlternative).join("\n")}`;
  const expires = typeof error.approval_expires_at === "string"
    ? `\nApproval context expires at: ${error.approval_expires_at}`
    : "";
  return `The observed incumbent cannot serve and needs browser approval for a replacement.
Observed model: ${routeSpec.incumbent_model}
Provider: ${routeSpec.provider_id ?? "not supplied"}
Exact provider reference: ${routeSpec.provider_ref ?? "not supplied"}
Canonical original: ${canonicalOriginal}${choices}${expires}
Open this browser approval page:
  ${approvalUrl}
A signed-in GitHub user with repository write access must choose the replacement there. Do not choose or substitute one yourself.
After browser approval, rerun the exact same init command unchanged.`;
}

function matchingReplacementRouteSpec(error, routeSpecs) {
  return routeSpecs.find((routeSpec) => matchesObservedIncumbent(error.observed_incumbent, routeSpec)) ?? null;
}

function matchesObservedIncumbent(observed, routeSpec) {
  if (!observed || typeof observed !== "object") {
    return false;
  }
  const providerId = typeof observed.provider_id === "string" ? observed.provider_id : undefined;
  const providerRef = typeof observed.provider_ref === "string" ? observed.provider_ref : undefined;
  return observed.observed_model === routeSpec.incumbent_model
    && providerId === routeSpec.provider_id
    && providerRef === routeSpec.provider_ref;
}

function isReplacementAlternative(value) {
  return value
    && typeof value === "object"
    && typeof value.canonical_id === "string"
    && typeof value.relation_type === "string"
    && typeof value.reason === "string";
}

function formatReplacementAlternative(alternative) {
  const prices = [];
  if (typeof alternative.input_usd_per_million === "number") {
    prices.push(`input $${alternative.input_usd_per_million}/1M`);
  }
  if (typeof alternative.output_usd_per_million === "number") {
    prices.push(`output $${alternative.output_usd_per_million}/1M`);
  }
  if (typeof alternative.price_multiple === "number") {
    prices.push(`${alternative.price_multiple}x incumbent price`);
  }
  const priceText = prices.length > 0 ? `; ${prices.join(", ")}` : "";
  return `- ${alternative.canonical_id} (${alternative.relation_type}${priceText}): ${alternative.reason}`;
}

function providerIdentityReviewMessage(error, routeSpec) {
  const reason = typeof error.message === "string" ? `\nReason: ${error.message}` : "";
  return `BenchRouter cannot prove the identity of the observed incumbent.
Observed model: ${routeSpec.incumbent_model}
Provider: ${routeSpec.provider_id ?? "not supplied"}
Exact provider reference: ${routeSpec.provider_ref ?? "not supplied"}${reason}
Do not substitute a model or remove provider metadata. The catalog mapping needs review before setup can continue.`;
}

function browserApprovalUnavailableMessage(routeSpec) {
  return `The browser-approved baseline is no longer an available replacement.
Keep these observed-incumbent inputs unchanged:
  --incumbent-model ${routeSpec.incumbent_model}
  --provider-id ${routeSpec.provider_id ?? "<same-provider-id>"}
  --provider-ref ${routeSpec.provider_ref ?? "<same-provider-ref>"}
Rerun the exact same init command unchanged to request current browser approval options.`;
}

function incumbentObservationChangedMessage(routeSpec) {
  return `The observed incumbent changed after BenchRouter created the replacement approval context.
Current model: ${routeSpec.incumbent_model}
Current provider: ${routeSpec.provider_id ?? "not supplied"}
Current provider reference: ${routeSpec.provider_ref ?? "not supplied"}
Do not substitute a model or remove provider metadata. Restore the exact observed inputs, or start a new setup session if the original observation was wrong.`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function validateRuntimeWiringForDoctor(root, routes, failures) {
  const routeEntries = routes.filter((route) => route.routeId || route.slug);
  if (routeEntries.length === 0) {
    failures.push("runtime wiring: .benchrouter/benchrouter.yml has no routes to verify");
    return { ok: false, routesChecked: 0 };
  }

  let routesChecked = 0;
  for (const route of routeEntries) {
    const label = route.routeId || route.slug;
    const baseUrlEnv = route.callSiteBaseUrlEnv;
    if (!baseUrlEnv) {
      failures.push(`runtime wiring route ${label}: missing call_site.base_url_env`);
      continue;
    }
    if (route.codeRefs.length === 0) {
      failures.push(`runtime wiring route ${label}: missing code_refs for call_site.base_url_env ${baseUrlEnv}`);
      continue;
    }

    let referenced = false;
    for (const codeRef of route.codeRefs) {
      const resolved = resolveDoctorRelativePath(root, codeRef);
      if (!resolved.ok) {
        continue;
      }
      if (!existsSync(resolved.path)) {
        continue;
      }
      let contents;
      try {
        contents = readFileSync(resolved.path, "utf8");
      } catch (error) {
        failures.push(`runtime wiring route ${label}: could not read code_ref ${codeRef}: ${error instanceof Error ? error.message : "read failed"}`);
        continue;
      }
      if (contents.includes(baseUrlEnv)) {
        referenced = true;
      }
    }
    if (!referenced) {
      failures.push(`runtime wiring route ${label}: call_site.base_url_env ${baseUrlEnv} is not referenced by any route code_refs`);
      continue;
    }
    routesChecked += 1;
  }

  return { ok: routesChecked === routeEntries.length, routesChecked };
}

function runtimeHostChecklist({ root, routes, apiUrl }) {
  const baseUrlAssignments = Array.from(new Set(
    routes
      .filter((route) => route.callSiteBaseUrlEnv)
      .map((route) => `${route.callSiteBaseUrlEnv} to ${proxyBaseUrlForApiFamily(apiUrl, route.callSiteApiFamily)}`)
  ));
  const baseUrlLabel = baseUrlAssignments.length > 0
    ? baseUrlAssignments.join("; set ")
    : `call_site.base_url_env to ${proxyBaseUrl(apiUrl)} (record the real env var in .benchrouter/benchrouter.yml)`;
  const checklist = [
    `runtime host checklist: set BENCHROUTER_API_KEY in your runtime host and set ${baseUrlLabel}`,
    "GitHub Actions checklist: ensure BenchRouter Evals is enabled; CI authenticates with GitHub OIDC (no stored eval API key)"
  ];
  const fallbackKeys = detectFallbackProviderEnvKeys(root);
  if (fallbackKeys.length > 0) {
    checklist.push(`optional fallback provider key detected in the runtime env template: ${fallbackKeys.join(", ")} (only needed if the app keeps a direct-provider fallback)`);
  }
  return checklist;
}

function proxyBaseUrl(apiUrl) {
  return `${apiUrl.replace(/\/+$/, "")}/v1`;
}

// EVAL-012: the call site's declared API family chooses the value, never the variable's name.
function proxyBaseUrlForApiFamily(apiUrl, apiFamily) {
  if (!API_FAMILIES.has(apiFamily)) {
    return "the value its call_site.api_family chooses (declare openai_chat_completions, anthropic_messages, or openai_responses in .benchrouter/benchrouter.yml)";
  }
  return apiFamily === "anthropic_messages" ? apiUrl.replace(/\/+$/, "") : proxyBaseUrl(apiUrl);
}

function detectFallbackProviderEnvKeys(root) {
  const envTemplate = resolveRuntimeEnvTemplate(root);
  if (!envTemplate) return [];
  const keys = parseEnvExampleKeys(readFileSync(envTemplate.path, "utf8"));
  return keys
    .filter((key) => key.endsWith("_API_KEY"))
    .filter((key) => !key.startsWith("BENCHROUTER_"))
    .sort();
}

function resolveRuntimeEnvTemplate(root) {
  for (const relativePath of RUNTIME_ENV_TEMPLATE_NAMES) {
    const candidate = path.join(root, relativePath);
    if (existsSync(candidate)) return { path: candidate, relativePath };
  }
  return null;
}

function parseEnvExampleKeys(text) {
  return envExampleLines(text).filter((line) => !line.commented).map((line) => line.key);
}

// Keys a reader left as comments, such as "# BENCHROUTER_API_KEY=" for a secret placeholder.
function parseCommentedEnvExampleKeys(text) {
  return envExampleLines(text).filter((line) => line.commented).map((line) => line.key);
}

// Reads each KEY= assignment in an env example file. A line whose text starts with one or more
// "#" characters followed by an assignment is reported as commented.
function envExampleLines(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let rest = rawLine.trimStart();
    let commented = false;
    while (rest.startsWith("#")) {
      commented = true;
      rest = rest.slice(1).trimStart();
    }
    const key = envAssignmentKey(rest);
    if (key) lines.push({ key, commented });
  }
  return lines;
}

function envAssignmentKey(text) {
  const isStart = (char) => char === "_" || (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
  const isPart = (char) => isStart(char) || (char >= "0" && char <= "9");
  if (!isStart(text[0] ?? "")) return null;
  let end = 1;
  while (end < text.length && isPart(text[end])) end += 1;
  return text.slice(end).trimStart().startsWith("=") ? text.slice(0, end) : null;
}

function resolveDoctorRelativePath(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    return { ok: false, error: "path must be a relative file path inside the repo" };
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return { ok: false, error: "path escapes the repo root" };
  }
  return { ok: true, path: target };
}

async function verifyProxyPingForDoctor({ apiUrl, apiKey, routeId, failures }) {
  if (!apiKey) {
    return { ok: false, skipped: true, reason: "no BENCHROUTER_API_KEY in environment; live proxy ping not run" };
  }
  if (!routeId) {
    failures.push("proxy ping route not found: .benchrouter/benchrouter.yml has no route_id to test");
    return { ok: false };
  }

  let response;
  let responseText;
  try {
    response = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: routeId,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
        max_tokens: 1
      })
    });
    responseText = await response.text();
  } catch (error) {
    failures.push(`proxy ping network: ${proxyNetworkMessage(error)}`);
    return { ok: false };
  }

  const parsed = parseJson(responseText);
  if (!response.ok) {
    const errorCode = proxyErrorCode(parsed);
    if (response.status === 401 || response.status === 403 || ["invalid_token", "invalid_api_key", "unauthorized"].includes(errorCode)) {
      failures.push(`proxy ping auth rejected: HTTP ${response.status}${errorCode ? ` ${errorCode}` : ""}`);
      return { ok: false };
    }
    if (response.status === 404 || ["route_not_found", "model_not_found"].includes(errorCode)) {
      failures.push(`proxy ping route not found: ${routeId}${errorCode ? ` (${errorCode})` : ""}`);
      return { ok: false };
    }
    failures.push(`proxy ping failed: HTTP ${response.status}${errorCode ? ` ${errorCode}` : ""}`);
    return { ok: false };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push("proxy ping malformed response: expected a JSON object");
    return { ok: false };
  }
  const resolvedModel = typeof parsed.model === "string" ? parsed.model : "";
  if (!resolvedModel || resolvedModel === routeId) {
    failures.push("proxy ping malformed response: expected response.model to be a concrete model, not the route id");
    return { ok: false };
  }
  if (!parsed.usage || typeof parsed.usage !== "object" || Array.isArray(parsed.usage)) {
    failures.push("proxy ping malformed response: expected response.usage object");
    return { ok: false };
  }

  return { ok: true, routeId, model: resolvedModel };
}

function proxyErrorCode(parsed) {
  const code = parsed?.error?.code ?? parsed?.code;
  return typeof code === "string" ? code : "";
}

function proxyNetworkMessage(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return "request timed out";
    }
    return error.message;
  }
  return "request failed";
}

function verifyGitHubWorkflowState(repoFullName, failures, passed, skipped) {
  const result = spawnSync("gh", ["api", `repos/${repoFullName}/actions/workflows`], { encoding: "utf8" });
  if (result.error && result.error.code === "ENOENT") {
    skipped.push("GitHub workflow state: gh is unavailable");
    return;
  }
  if (result.status !== 0) {
    failures.push(`could not verify BenchRouter Evals workflow state with gh: ${(result.stderr || result.stdout || "gh failed").trim()}`);
    return;
  }

  let workflows;
  try {
    workflows = JSON.parse(result.stdout).workflows;
  } catch {
    failures.push("could not parse gh workflow listing response");
    return;
  }
  const workflow = Array.isArray(workflows)
    ? workflows.find((entry) => entry && entry.path === ".github/workflows/benchrouter-evals.yml")
    : null;
  if (!workflow) {
    skipped.push("GitHub workflow state: workflow is not registered yet; this is expected before the generated workflow is pushed");
    return;
  }
  const state = typeof workflow.state === "string" ? workflow.state : "unknown";
  if (state !== "active") {
    failures.push(`BenchRouter Evals workflow is ${state}; re-enable it with: gh workflow enable benchrouter-evals.yml --repo ${repoFullName}`);
    return;
  }
  passed.push("GitHub workflow state: BenchRouter Evals is active");
}

function verifyDefaultBranchConfig(repoFullName, failures, passed) {
  const repoResult = spawnSync("gh", ["repo", "view", repoFullName, "--json", "defaultBranchRef"], { encoding: "utf8" });
  if (repoResult.status !== 0) {
    failures.push(`could not look up GitHub default branch with gh: ${(repoResult.stderr || repoResult.stdout || "gh failed").trim()}`);
    return;
  }
  let defaultBranch = "main";
  try {
    defaultBranch = JSON.parse(repoResult.stdout).defaultBranchRef?.name || defaultBranch;
  } catch {
    failures.push("could not parse gh default branch response");
    return;
  }

  const configResult = spawnSync("gh", [
    "api",
    "--method",
    "GET",
    `repos/${repoFullName}/contents/.benchrouter/benchrouter.yml`,
    "-f",
    `ref=${defaultBranch}`
  ], { encoding: "utf8" });
  if (configResult.status !== 0) {
    failures.push(`.benchrouter/benchrouter.yml is not readable on default branch ${defaultBranch}: ${(configResult.stderr || configResult.stdout || "gh failed").trim()}`);
    return;
  }
  passed.push(`default-branch config: .benchrouter/benchrouter.yml is readable on ${defaultBranch}`);
}

function isBenchRouterKitFile(relativePath) {
  return [".benchrouter/.gitignore", ".benchrouter/README.md", ".benchrouter/SETUP_README.md", BOOTSTRAP_PATH, TRUST_PATH, WORKFLOW_PATH].includes(relativePath);
}

function prBodyTemplate({ targetRepo, routeId, routeName, incumbentModel }) {
  return `## BenchRouter setup

Repo: ${targetRepo}
Route: ${routeName} (${routeId})
Incumbent model: ${incumbentModel}

### Evaluation route
- Route ID: ${routeId}
- TODO: identify the existing call site evaluated. Keep its production model, provider, key, and URL unchanged.
- TODO: record code_refs and the intended activation base URL env. Production wiring is a later patch.

### Eval case source + coverage matrix
- Branch: TODO test-derived / captured / authored.
- TODO: list each case, source, critical variant, and expected consumed decision.

### Scorer + import audit
- TODO: summarize the extracted scorer contract and confirm it has no app imports, fs, network, DB, or nondeterministic clocks.

### Certification limits
- Certified layer: TODO model-output contract / parser boundary / human-read judge.
- TODO: list uncovered variants or downstream behavior that this eval does not certify.

### Secrets + CI
- Runtime host: BENCHROUTER_API_KEY.
- GitHub Actions: keyless through GitHub OIDC. Do not store an eval API key in the repository.
- TODO: confirm BenchRouter Evals is enabled and has reported after the kit lands.

### Rollback
The evaluation PR does not change production routing. After results and default-branch import, prepare a separate activation patch for this route with its original provider, model (${incumbentModel}), and credential configuration recorded for rollback.
`;
}

function detectGitHubRepo() {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  const remote = result.stdout.trim();
  const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }
  return undefined;
}

function safeTargetPath(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    fail(`Unsafe packet path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    fail(`Packet path escapes output directory: ${relativePath}`);
  }
  return target;
}

function readExecutableEvalPack(evalPackPath, routeId, outputDir) {
  const sourcePath = path.resolve(outputDir, evalPackPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    fail(`Invalid --eval-pack for route ${routeId}: cannot read valid JSON from ${evalPackPath}: ${error instanceof Error ? error.message : "read failed"}`);
  }
  validateExecutableEvalPack(parsed, routeId, outputDir);
  return parsed;
}

function validateExecutableEvalPack(pack, routeId, outputDir) {
  const at = `--eval-pack for route ${routeId}`;
  if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
    fail(`${at} must contain one JSON object.`);
  }
  if (pack.api_family !== undefined) {
    fail(`${at} must not contain api_family. Pass --api-family for the route; the eval inherits the call site's family.`);
  }
  // EVAL-012: the runtime runs argv and reads result_path, so an executable pack has no command or scorer.
  for (const field of ["command", "scorer"]) {
    if (Object.hasOwn(pack, field)) fail(`${at}: eval_pack.${field} is not accepted for a repository_executable eval pack.`);
  }
  const unknownField = Object.keys(pack).find((field) => !EXECUTABLE_EVAL_PACK_FIELDS.has(field));
  if (unknownField) {
    fail(`${at} contains unknown field ${unknownField}.`);
  }
  if (pack.mode !== "repository_executable") {
    fail(`${at}.mode must be repository_executable.`);
  }
  for (const field of ["id", "config_path", "workflow", "result_path", "primary_metric"]) {
    requireNonEmptyString(pack[field], `${at}.${field}`);
  }
  if (!isMetricName(pack.primary_metric)) {
    fail(`${at}.primary_metric must start with a lowercase letter and use only lowercase letters, digits and underscores.`);
  }
  // EVAL-012: optional fields. Absent or null means the repository root and process isolation.
  const workingDirectory = pack.working_directory ?? null;
  if (workingDirectory !== null) {
    if (!isSafeDirectoryPath(workingDirectory)) {
      fail(`${at}.working_directory must be a repository-relative directory such as apps/web (omit it for the repository root).`);
    }
    let isDirectory = false;
    try { isDirectory = statSync(path.resolve(outputDir, workingDirectory)).isDirectory(); } catch { isDirectory = false; }
    if (!isDirectory) fail(`${at}.working_directory ${workingDirectory} is not a directory in the repository.`);
  }
  if (pack.isolation !== undefined && pack.isolation !== null && pack.isolation !== "process" && pack.isolation !== "job") {
    fail(`${at}.isolation must be process or job.`);
  }
  validateEvalPackArtifacts(pack.artifacts, `${at}.artifacts`);
  if (pack.result_schema !== "benchrouter.executable_result.v1") {
    fail(`${at}.result_schema must be benchrouter.executable_result.v1.`);
  }
  if (pack.runtime !== "node" && pack.runtime !== "bun") {
    fail(`${at}.runtime must be node or bun.`);
  }
  // runtime_version is informational: the job's node or bun runs, and the runtime records its version.
  if (pack.runtime_version !== undefined && (typeof pack.runtime_version !== "string" || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pack.runtime_version))) {
    fail(`${at}.runtime_version must be an exact version such as 22.18.0, not a mutable alias, or be left out.`);
  }
  const allowedLockfiles = pack.runtime === "bun"
    ? new Set(["bun.lock", "bun.lockb"])
    : new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml"]);
  // The lockfile is relative to working_directory and may name a parent directory's lockfile with
  // ../ segments, as long as it stays inside the repository.
  const lockfileParts = typeof pack.lockfile === "string" ? pack.lockfile.split("/") : [];
  if (!allowedLockfiles.has(lockfileParts.at(-1))) {
    fail(`${at}.lockfile is not valid for runtime ${pack.runtime}.`);
  }
  if (pack.lockfile.includes("\0") || pack.lockfile.includes("\\") || pack.lockfile.startsWith("/") || pack.lockfile.startsWith("~")
    || path.win32.isAbsolute(pack.lockfile) || pack.lockfile[1] === ":" || lockfileParts.some((part) => part === "" || part === ".")) {
    fail(`${at}.lockfile must be a relative path such as pnpm-lock.yaml or ../../pnpm-lock.yaml.`);
  }
  const lockfileRepoPath = path.posix.normalize(path.posix.join(workingDirectory ?? ".", pack.lockfile));
  if (lockfileRepoPath === ".." || lockfileRepoPath.startsWith("../")) {
    fail(`${at}.lockfile ${pack.lockfile} leaves the repository from working_directory ${workingDirectory ?? "(the repository root)"}.`);
  }
  for (const field of ["case_refs", "argv", "input_refs", "acceptance_refs"]) {
    requireNonEmptyStringArray(pack[field], `${at}.${field}`);
  }
  for (const field of ["case_refs", "input_refs", "acceptance_refs"]) {
    const duplicate = pack[field].find((ref, index) => pack[field].indexOf(ref) !== index);
    if (duplicate !== undefined) fail(`${at}.${field} lists ${duplicate} twice.`);
  }
  const overlap = pack.input_refs.find((ref) => pack.acceptance_refs.includes(ref));
  if (overlap !== undefined) {
    fail(`${at}: input_refs and acceptance_refs both list ${overlap}. A file is either data the evaluator reads (input_refs) or part of what decides quality (acceptance_refs); an evaluator that holds the checks goes in acceptance_refs.`);
  }
  if (!Array.isArray(pack.secret_env) || pack.secret_env.some((name) => typeof name !== "string")) {
    fail(`${at}.secret_env must be an array of declared environment-variable names.`);
  }
  const duplicateSecret = pack.secret_env.find((name, index) => pack.secret_env.indexOf(name) !== index);
  if (duplicateSecret) {
    fail(`${at}.secret_env contains duplicate name ${duplicateSecret}.`);
  }
  const invalidSecret = pack.secret_env.find(
    (name) => !/^[A-Z][A-Z0-9_]*$/.test(name) || /^(BENCHROUTER|ACTIONS|GITHUB)_/.test(name)
  );
  if (invalidSecret) {
    fail(`${at}.secret_env contains reserved or invalid name ${invalidSecret}.`);
  }
  requirePositiveInteger(pack.timeout_minutes, `${at}.timeout_minutes`);
  if (pack.timeout_minutes > 90) {
    fail(`${at}.timeout_minutes must be from 1 through 90 so the workflow keeps its install and upload buffer.`);
  }
  for (const field of ["config_path", "workflow", "result_path"]) {
    requireSafeRepoPath(pack[field], `${at}.${field}`);
  }
  for (const field of ["case_refs", "input_refs", "acceptance_refs"]) {
    for (const [index, ref] of pack[field].entries()) {
      requireSafeRepoPath(ref, `${at}.${field}[${index}]`);
    }
  }
  const requiredExistingRefs = new Set([lockfileRepoPath, ...pack.case_refs, ...pack.input_refs, ...pack.acceptance_refs]);
  for (const ref of requiredExistingRefs) {
    if (!existsSync(path.resolve(outputDir, ref))) {
      fail(`${at} references missing repository file ${ref}.`);
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    fail(`${label} must be a non-empty string without surrounding whitespace.`);
  }
}

function requireNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty string array.`);
  }
  for (const [index, item] of value.entries()) {
    requireNonEmptyString(item, `${label}[${index}]`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer.`);
  }
}

// EVAL-012: optional files the runtime copies into the run's GitHub Actions artifacts. They may not
// exist yet (the evaluator writes them), so only their shape is checked: at most 16 distinct,
// normalized repository-relative paths or globs (* ** ?), each at most 256 characters.
function validateEvalPackArtifacts(value, label) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) fail(`${label} must be a list of repository paths or globs.`);
  if (value.length > 16) fail(`${label} may list at most 16 entries.`);
  const refused = new Set(['"', ":", "<", ">", "|", "[", "]", "{", "}", "+", "\\"]);
  for (const [index, entry] of value.entries()) {
    const at = `${label}[${index}]`;
    if (typeof entry !== "string" || entry === "" || entry.trim() !== entry) fail(`${at} must be a non-empty string without surrounding whitespace.`);
    if (entry.length > 256) fail(`${at} must be at most 256 characters.`);
    if ([...entry].some((char) => refused.has(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      fail(`${at} contains a character that is not allowed; use a path with only the * ** ? wildcards.`);
    }
    if (entry.startsWith("/") || entry.startsWith("~") || entry.startsWith("!")
      || entry.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".git")) {
      fail(`${at} must be a normalized repository-relative path or glob such as out/drafts/**.`);
    }
    if (value.indexOf(entry) !== index) fail(`${label} lists ${entry} twice.`);
  }
}

// EVAL-012: a safe repository-relative directory: no leading / or ~, no drive letter, backslash or
// NUL, and every segment non-empty and not . or .. (so "." itself is refused).
function isSafeDirectoryPath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.startsWith("~") || path.win32.isAbsolute(value) || value[1] === ":") return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isMetricName(value) {
  const lower = (char) => char >= "a" && char <= "z";
  return typeof value === "string" && lower(value[0] ?? "")
    && [...value].every((char) => lower(char) || (char >= "0" && char <= "9") || char === "_");
}

function requireSafeRepoPath(value, label) {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || value.includes("\\")
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.split("/").includes("..")
    || path.posix.normalize(value) !== value
    || value === ".") {
    fail(`${label} must be a normalized repository-relative path without traversal.`);
  }
}

function parseArgs(values) {
  const parsed = { _: [], [OPTION_NAMES]: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "-y") {
      parsed.yes = true;
      parsed[OPTION_NAMES].push("yes");
      continue;
    }
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }

    const option = value.slice(2);
    const equalsIndex = option.indexOf("=");
    const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : option.slice(equalsIndex + 1);
    parsed[OPTION_NAMES].push(key);
    const next = values[index + 1];
    const databricksBoolean = values[0] === "databricks" && ["json", "help", "force", "reclaim"].includes(key);
    // A boolean flag never takes the next token as its value, so `--yes -f` leaves -f to be checked.
    const takesNoValue = databricksBoolean || BOOLEAN_FLAGS.has(key);
    const argValue = inlineValue !== undefined ? (databricksBoolean && ["true", "false"].includes(inlineValue) ? inlineValue === "true" : inlineValue) : !takesNoValue && next && !next.startsWith("--") ? values[++index] : true;

    if (parsed[key] === undefined) {
      parsed[key] = argValue;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(argValue);
    } else {
      parsed[key] = [parsed[key], argValue];
    }
  }
  return parsed;
}

function stringArg(name, fallback) {
  const value = args[name];
  if (Array.isArray(value)) {
    return String(value[value.length - 1]);
  }
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

// Returns every value passed for a repeatable flag, in CLI order. A flag given
// once yields a single-element array; absent flags yield an empty array.
function arrayArg(name) {
  const value = args[name];
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefined(item)])
    );
  }
  return value;
}

function fail(message, code = "command_failed", exitCode = 1) {
  if (args?.json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
    if (command !== "feedback") process.stderr.write("If BenchRouter's docs don't explain this, report it: benchrouter feedback --kind doc_gap '<what happened>'\n");
  }
  process.exit(exitCode);
}

function usage(status, commandName = "all", message) {
  const stream = status === 0 ? process.stdout : process.stderr;
  if (status !== 0 && args?.json) {
    stream.write(`${JSON.stringify({ ok: false, error: { code: "invalid_arguments", message: message ?? `Invalid arguments for ${commandName}.` } })}\n`);
    process.exit(status);
  }
  if (message) {
    stream.write(`${message}\n\n`);
  }
  const controlHelp = controlUsageText(commandName);
  if (controlHelp) {
    stream.write(controlHelp);
    process.exit(status);
  }
  if (["capture", "calibrate", "run"].includes(commandName)) {
    stream.write(`Usage: benchrouter ${commandName} [runtime options]\n\nRun the signed runtime bootstrap from the current repository.\nCapture starts a local proxy; run your application tests against it separately.\nCalibrate checks local evidence. Run is for GitHub Actions and requires OIDC.\n`);
  } else if (commandName === "init") {
    stream.write(`Usage:
  benchrouter init --setup-key br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model [options]

Multiple routes (paired in order; first triple is primary):
  benchrouter init --setup-key br_setup_... \\
    --route-id product/route-a --name "Route A" --incumbent-model provider/model-a \\
    --route-id product/route-b --name "Route B" --incumbent-model provider/model-b

Routes share one product. Pass repeated route triples during init; the generated
.benchrouter/benchrouter.yml is the single route declaration. The generated kit
contains the signed runtime bootstrap, trust file, and workflow.

Options:
  --repo owner/repo
  --route-id <id>         Repeatable. Pair each with one --name and one --incumbent-model.
  --name <text>           Repeatable. Display name for the matching --route-id.
  --incumbent-model <id>  Repeatable. Incumbent model for the matching --route-id.
  --provider-id <id>      Repeatable. Direct provider for the matching route.
  --provider-ref <ref>    Repeatable. Exact provider model ref; requires --provider-id.
  --eval-pack <path>       Repeatable. Repository-executable eval JSON for the matching route.
  --eval-command <command>  Existing customer test command for optional local capture.
  --code-ref <path>       Repeatable. Call-site files recorded on the primary route.
  --base-url-env <name>   Repeatable. Env var the call site uses for its LLM base URL.
  --api-family <family>   Repeatable. Protocol the call site speaks: openai_chat_completions,
                          anthropic_messages, or openai_responses. It chooses the base URL value.
                          Required with --base-url-env or --eval-pack; an executable eval inherits it.
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --dry-run                Print planned writes without changing files.
  --force                  Replace BenchRouter-owned files that differ from the new copy:
                           .benchrouter/README.md, SETUP_README.md, .gitignore, bootstrap.mjs
                           and trust.json. Without it, init keeps an existing differing file and
                           prints skip-existing. init always refreshes the evals workflow (it keeps
                           your setup steps) and merges benchrouter.yml; --force changes neither.
  --overwrite-user-edits   Replace every existing file that differs, including non-kit files.
  --output-dir <path>      Defaults to current directory.
  --save-token             Save this setup token for repo read commands.
`);
  } else if (commandName === "models") {
    stream.write(`Usage:
  benchrouter models [options]

Options:
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --filter <text>          Print only enabled IDs containing this text.
  --json                   Print machine-readable JSON.
`);
  } else if (commandName === "upgrade") {
    stream.write(`Usage:
  benchrouter upgrade --upgrade-token br_upgrade_... --repo owner/repo --route-id product/route
  benchrouter upgrade --api-key <BENCHROUTER_API_KEY> --repo owner/repo --route-id product/route

The upgrade flow previews the planned changes (without consuming the single-use
upgrade token), prompts for confirmation, then applies. Use --yes to skip the
prompt. The preview lists the files that would change, with a diff for each, and
the files that are already up to date.

Upgrade preserves the existing .benchrouter/benchrouter.yml byte-for-byte
and preserves all route-owned assets and dispatch-only customer setup steps.
It replaces only the bootstrap, trust file, workflow, and README content.
Upgrade has no --force flag: it always replaces those BenchRouter-owned files.
(--force belongs to init, where it replaces differing BenchRouter kit files.)
It validates all generated-file hashes before it writes files.

Options:
  --upgrade-token <token>  Single-use token, valid for one hour. At a terminal, mint one with
                           \`benchrouter setup upgrade-token --route-id <id>\` (needs \`benchrouter login\`),
                           or copy it from the dashboard "Upgrade BenchRouter kit" banner.
                           Falls back to BENCHROUTER_UPGRADE_TOKEN.
  --api-key <key>          The runtime key, for CI only; a person at a terminal uses --upgrade-token.
                           Falls back to BENCHROUTER_API_KEY. Ignored when --upgrade-token is set.
                           API-key upgrades apply without a preview.
  --api-url <url>          Defaults to https://api.benchrouter.com.
  --output-dir <path>      Defaults to current directory.
  --yes, -y                Skip the interactive confirmation after preview.
  --dry-run                Preview only. Requires --upgrade-token. Never calls apply.
`);
  } else if (commandName === "doctor") {
    stream.write(`Usage:
  benchrouter doctor [options]

Options:
  --repo owner/repo          Defaults to the current git remote.
  --account-token br_ctrl_...  Defaults to BENCHROUTER_ACCOUNT_TOKEN, then the saved login.
  --setup-key br_setup_...   Used without an account login; defaults to BENCHROUTER_SETUP_KEY, then the saved repo key.
  --api-url <url>            Defaults to https://api.benchrouter.com.
  --output-dir <path>        Defaults to current directory.
  --phase evaluation|activation  Defaults to evaluation; activation checks production wiring.
  --route-id product/route   Select one declared route. Required for activation.
  --live-chat-completions    Opt into a billable diagnostic for the selected activation route.
  --skip-github-workflow     Skip the GitHub workflow-state check.
  --check-default-branch     Verify the config is present on the default branch.

Both phases check manifest rules with BenchRouter when a repo and credential are available.
Missing credentials and unavailable checks are reported as skipped.
`);
  } else if (["status", "frontier", "failures", "explain"].includes(commandName)) {
    const commandUsage = {
      status: "benchrouter status [--repo owner/repo]",
      frontier: "benchrouter frontier <route-key> [--repo owner/repo]",
      failures: "benchrouter failures <route-key> [model] [--repo owner/repo]",
      explain: "benchrouter explain <model> [--route product/route] [--repo owner/repo]"
    }[commandName];
    stream.write(`Usage:
  ${commandUsage}

Options:
  --repo owner/repo         Defaults to the current git remote.
  --setup-key br_setup_...  Defaults to BENCHROUTER_SETUP_KEY, then the key init --save-token saved.
  --api-url <url>           Defaults to https://api.benchrouter.com.
  --json                    Print machine-readable JSON.
`);
  } else {
    stream.write(`Usage:
  benchrouter init --setup-key br_setup_... --route-id product/route --name "Route Name" --incumbent-model provider/model
  benchrouter upgrade --upgrade-token br_upgrade_... --repo owner/repo --route-id product/route
  benchrouter doctor
  benchrouter --version
  benchrouter capture
  benchrouter calibrate
  benchrouter models [--json]
  benchrouter status [--json]
  benchrouter frontier <route-key> [--json]
  benchrouter failures <route-key> [model] [--json]
  benchrouter explain <model> [--route product/route] [--json]
${topLevelControlUsageLines()}

Run \`benchrouter <command> --help\` for its flags, for example \`benchrouter evals model --help\`.
`);
  }
  process.exit(status);
}
