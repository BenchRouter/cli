// Repeated-trial stress measurement for one route.
//
// Reuses the repository's generated eval runner (`.benchrouter/benchrouter-eval.mjs`)
// so a stress pass means exactly what an eval pass means: same replay body, same
// sandboxed scorer, same judge path. The CLI only drives trials and aggregates.
//
// Nothing here writes to the control plane. Model calls are paid runtime calls
// on the account's key. See docs/plan-eval-stress-trials.md in the service repo.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readRouteManifest } from "./route-manifest.mjs";

export const STRESS_MODEL_ENV = "BENCHROUTER_STRESS_MODEL";
export const DEFAULT_TRIALS = 20;
export const EARLY_STOP_BLOCK = 5;
export const BUDGET_REQUIRED_ABOVE_CALLS = 200;
export const DEFAULT_RUNNER_PATH = ".benchrouter/benchrouter-eval.mjs";

const Z_95 = 1.959963984540054;

/** Wilson score interval for a binomial proportion. Returns nulls for n = 0. */
export function wilsonInterval(passes, trials, z = Z_95) {
  if (!Number.isFinite(trials) || trials <= 0) {
    return { mean: null, lower: null, upper: null };
  }
  const n = trials;
  const p = passes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    mean: round(p),
    lower: round(Math.max(0, center - halfWidth)),
    upper: round(Math.min(1, center + halfWidth))
  };
}

export function classifyCase(passes, trials) {
  if (trials === 0) return "no_trials";
  if (passes === trials) return "stable_pass";
  if (passes === 0) return "stable_fail";
  return "flaky";
}

/**
 * A (model, case) is decided once its interval can no longer cross the threshold.
 * With threshold 1 (no baseline), any failure decides it; an all-pass streak never
 * does, so it runs to the trial cap. With a baseline mean below 1, an all-pass
 * streak stops once the lower bound clears the baseline.
 */
export function isDecided({ passes, trials, threshold }) {
  if (trials === 0) return false;
  const { lower, upper } = wilsonInterval(passes, trials);
  if (upper < threshold) return true;
  if (threshold < 1 && lower >= threshold) return true;
  return false;
}

export function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * Aggregate raw runner rows into the stress report.
 * `runs` is `[{ model: <requested model or null for live>, trial, rows: [runnerRow] }]`.
 */
export function aggregateStress(runs, { threshold = 1, live = false } = {}) {
  const byModel = new Map();
  for (const run of runs) {
    const key = run.model ?? "__live__";
    if (!byModel.has(key)) byModel.set(key, { model: run.model, rows: [] });
    for (const row of run.rows) {
      byModel.get(key).rows.push({ ...row, trial: run.trial });
    }
  }

  const models = [...byModel.values()].map(({ model, rows }) => summarizeModel(model, rows, threshold, live));
  const caseIds = uniqueOrdered(runs.flatMap((run) => run.rows.map((row) => row.case_id)));
  const cases = caseIds.map((caseId) => {
    const perModel = models.map((model) => model.cases.find((entry) => entry.case_id === caseId)).filter(Boolean);
    return {
      case_id: caseId,
      critical: perModel.some((entry) => entry.critical),
      discrimination: discriminationLabel(perModel, live)
    };
  });

  const totalCalls = models.reduce((sum, model) => sum + model.trial_calls + model.error_calls, 0);
  const totalCost = models.reduce((sum, model) => sum + (model.total_cost_usd ?? 0), 0);
  return {
    ok: true,
    mode: live ? "live" : "model",
    threshold,
    total_calls: totalCalls,
    total_cost_usd: round(totalCost, 6),
    models,
    cases
  };
}

function summarizeModel(model, rows, threshold, live) {
  const byCase = new Map();
  for (const row of rows) {
    if (!byCase.has(row.case_id)) byCase.set(row.case_id, []);
    byCase.get(row.case_id).push(row);
  }
  const cases = [...byCase.entries()].map(([caseId, caseRows]) => {
    const scored = caseRows.filter((row) => !isErroredRow(row));
    const passes = scored.filter((row) => row.pass === true).length;
    const interval = wilsonInterval(passes, scored.length);
    const latencies = scored.map((row) => row.latency_ms).filter(Number.isFinite);
    const costs = scored.map((row) => row.cost_usd).filter(Number.isFinite);
    return {
      case_id: caseId,
      critical: caseRows.some((row) => row.critical === true),
      trials: scored.length,
      passes,
      errors: caseRows.length - scored.length,
      pass_rate: interval.mean,
      lower: interval.lower,
      upper: interval.upper,
      classification: classifyCase(passes, scored.length),
      decided: isDecided({ passes, trials: scored.length, threshold }),
      latency_p50_ms: percentile(latencies, 0.5),
      latency_p95_ms: percentile(latencies, 0.95),
      mean_cost_usd: costs.length > 0 ? round(costs.reduce((sum, value) => sum + value, 0) / costs.length, 6) : null,
      served: live ? histogram(caseRows.map((row) => row.selected_model)) : undefined
    };
  });

  const scoredRows = rows.filter((row) => !isErroredRow(row));
  const passes = scoredRows.filter((row) => row.pass === true).length;
  const interval = wilsonInterval(passes, scoredRows.length);
  const costs = scoredRows.map((row) => row.cost_usd).filter(Number.isFinite);
  const flaky = cases.filter((entry) => entry.classification === "flaky");
  const summary = {
    model,
    trial_calls: scoredRows.length,
    error_calls: rows.length - scoredRows.length,
    passes,
    pass_rate: interval.mean,
    lower: interval.lower,
    upper: interval.upper,
    flaky_case_count: flaky.length,
    flaky_critical_case_count: flaky.filter((entry) => entry.critical).length,
    stable_fail_case_count: cases.filter((entry) => entry.classification === "stable_fail").length,
    total_cost_usd: costs.length > 0 ? round(costs.reduce((sum, value) => sum + value, 0), 6) : null,
    latency_p95_ms: percentile(scoredRows.map((row) => row.latency_ms), 0.95),
    cases
  };
  if (live) {
    summary.served = histogram(rows.map((row) => row.selected_model));
  }
  return summary;
}

function discriminationLabel(perModel, live) {
  if (live || perModel.length < 2) return null;
  const classes = new Set(perModel.map((entry) => entry.classification));
  if (classes.size === 1 && classes.has("stable_pass")) return "ceiling";
  if (classes.size === 1 && classes.has("stable_fail")) return "floor";
  return "discriminating";
}

export function isErroredRow(row) {
  return Boolean(row.technical_failure) || (typeof row.error === "string" && row.error.length > 0 && row.pass !== true);
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) {
    const key = typeof value === "string" && value.length > 0 ? value : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([model, count]) => ({ model, count }));
}

function uniqueOrdered(values) {
  return [...new Set(values)];
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Resolve the generated runner from package.json, falling back to the kit default. */
export function resolveRunnerPath(root) {
  const packageJsonPath = path.join(root, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const command = parsed?.scripts?.["benchrouter:eval"];
      const fromCommand = runnerPathFromCommand(command);
      if (fromCommand) return fromCommand;
    } catch {
      // fall through to the default path
    }
  }
  return DEFAULT_RUNNER_PATH;
}

export function runnerPathFromCommand(command) {
  if (typeof command !== "string") return "";
  const match = command.trim().match(/^node(?:\s+--[A-Za-z0-9_./:=+-]+)*\s+(\.benchrouter\/[^\s'"`;&|<>]+\.mjs)$/);
  return match?.[1] ?? "";
}

export function runnerSupportsStressModel(runnerSource) {
  return typeof runnerSource === "string" && runnerSource.includes(STRESS_MODEL_ENV);
}

/** Environment for one runner invocation. Secrets are passed through, never printed. */
export function buildRunnerEnv({ baseEnv, apiUrl, apiKey, routeId, casesPath, resultsSuffix, model, concurrency }) {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BENCHROUTER_") && key !== "BENCHROUTER_API_KEY") delete env[key];
  }
  env.BENCHROUTER_API_URL = apiUrl;
  env.BENCHROUTER_API_KEY = apiKey;
  env.BENCHROUTER_ROUTE_ID = routeId;
  env.BENCHROUTER_RESULTS_SUFFIX = resultsSuffix;
  if (casesPath) env.BENCHROUTER_CASES_PATH = casesPath;
  if (model) env[STRESS_MODEL_ENV] = model;
  if (concurrency) env.BENCHROUTER_EVAL_CONCURRENCY = String(concurrency);
  delete env.BENCHROUTER_UPLOAD_RESULTS;
  delete env.BENCHROUTER_MODEL_RUN_ID;
  delete env.BENCHROUTER_RESULT_SET_ID;
  return env;
}

export function sanitizeSuffix(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Run the generated runner once and return its rows. The runner writes
 * `.benchrouter/results.<suffix>.jsonl` under cwd; that file is read and removed.
 * A non-zero exit with rows present means technical failures, which the rows carry.
 */
export async function runRunnerOnce({ root, runnerPath, env }) {
  const resultsPath = path.join(root, ".benchrouter", `results.${env.BENCHROUTER_RESULTS_SUFFIX}.jsonl`);
  await rm(resultsPath, { force: true });
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ status: 1, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stderr }));
  });
  if (!existsSync(resultsPath)) {
    throw new Error(`Eval runner produced no results file (exit ${exit.status}): ${exit.stderr.trim().slice(0, 800)}`);
  }
  const rows = (await readFile(resultsPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  await rm(resultsPath, { force: true });
  return { rows, status: exit.status, stderr: exit.stderr };
}

export function readRouteCases(root, route) {
  const casesPath = path.join(root, route.casesPath);
  const parsed = JSON.parse(readFileSync(casesPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${route.casesPath} must be a JSON array of declared cases.`);
  return parsed.filter((entry) => {
    const entryRoute = typeof entry?.route === "string" ? entry.route.trim() : "";
    return entryRoute.length === 0 || entryRoute === route.routeId;
  });
}

/**
 * Plan and execute the stress run. `spawnRunner` is injectable for tests.
 */
export async function runStress(options) {
  const {
    root,
    routeKey,
    models,
    live,
    trials,
    caseIds,
    concurrency,
    maxCostUsd,
    earlyStop,
    threshold = 1,
    apiUrl,
    apiKey,
    baseEnv = process.env,
    spawnRunner = runRunnerOnce,
    log = () => {}
  } = options;

  const manifest = readRouteManifest(root);
  const route = manifest.routes.find((entry) => entry.routeId === routeKey);
  if (!route) throw new Error(`Route not found in ${manifest.product.repo}: ${routeKey}`);
  if (route.evalMode === "repository_executable") {
    throw new Error("stress supports isolated-replay routes only; repository_executable routes own their evaluator.");
  }

  const runnerPath = resolveRunnerPath(root);
  const runnerAbsolute = path.join(root, runnerPath);
  if (!existsSync(runnerAbsolute)) throw new Error(`missing ${runnerPath}; run benchrouter upgrade to restore the generated runner.`);
  if (!live && !runnerSupportsStressModel(readFileSync(runnerAbsolute, "utf8"))) {
    throw new Error(`${runnerPath} predates model-level stress (no ${STRESS_MODEL_ENV} support). Run benchrouter upgrade to refresh the generated kit, or use --live.`);
  }

  const allCases = readRouteCases(root, route);
  const selectedCases = caseIds.length > 0
    ? allCases.filter((entry) => caseIds.includes(entry.id))
    : allCases;
  const unknown = caseIds.filter((id) => !allCases.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case id(s) for ${routeKey}: ${unknown.join(", ")}`);
  if (selectedCases.length === 0) throw new Error(`No runnable cases for ${routeKey}.`);

  const targets = live ? [null] : models;
  const plannedCalls = selectedCases.length * trials * targets.length;
  if (plannedCalls > BUDGET_REQUIRED_ABOVE_CALLS && !(Number.isFinite(maxCostUsd) && maxCostUsd > 0)) {
    throw new Error(`${plannedCalls} planned calls exceed ${BUDGET_REQUIRED_ABOVE_CALLS}; pass --max-cost-usd to set a hard stop.`);
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "benchrouter-stress-"));
  const runs = [];
  let spentUsd = 0;
  let budgetStopped = false;
  try {
    for (const model of targets) {
      let remaining = selectedCases;
      const tally = new Map(selectedCases.map((entry) => [entry.id, { passes: 0, trials: 0 }]));
      for (let trial = 0; trial < trials && remaining.length > 0 && !budgetStopped; trial += 1) {
        const casesPath = remaining.length === allCases.length
          ? null
          : path.join(tempDir, `cases.${sanitizeSuffix(model ?? "live")}.${trial}.json`);
        if (casesPath) await writeFile(casesPath, JSON.stringify(remaining));
        const env = buildRunnerEnv({
          baseEnv,
          apiUrl,
          apiKey,
          routeId: route.routeId,
          casesPath,
          resultsSuffix: `stress.${sanitizeSuffix(model ?? "live")}.${trial}`,
          model,
          concurrency
        });
        const { rows } = await spawnRunner({ root, runnerPath, env });
        runs.push({ model, trial, rows });
        for (const row of rows) {
          spentUsd += Number.isFinite(row.cost_usd) ? row.cost_usd : 0;
          spentUsd += Number.isFinite(row.judge_cost_usd) ? row.judge_cost_usd : 0;
          if (isErroredRow(row)) continue;
          const entry = tally.get(row.case_id);
          if (!entry) continue;
          entry.trials += 1;
          if (row.pass === true) entry.passes += 1;
        }
        log(`${model ?? "live"} trial ${trial + 1}/${trials}: ${rows.filter((row) => row.pass === true).length}/${rows.length} passed`);
        if (Number.isFinite(maxCostUsd) && maxCostUsd > 0 && spentUsd >= maxCostUsd) {
          budgetStopped = true;
        }
        if (earlyStop && (trial + 1) % EARLY_STOP_BLOCK === 0) {
          remaining = remaining.filter((entry) => {
            const state = tally.get(entry.id);
            return !isDecided({ passes: state.passes, trials: state.trials, threshold });
          });
        }
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const report = aggregateStress(runs, { threshold, live });
  report.route_key = route.routeId;
  report.runner = runnerPath;
  report.requested_trials = trials;
  report.budget_stopped = budgetStopped;
  report.spent_usd = round(spentUsd, 6);
  return report;
}

export function renderStressReport(report) {
  const lines = [];
  const header = report.mode === "live"
    ? `Stress ${report.route_key} (live route, ${report.requested_trials} trials requested)`
    : `Stress ${report.route_key} (${report.models.length} model${report.models.length === 1 ? "" : "s"}, ${report.requested_trials} trials requested)`;
  lines.push(header);
  lines.push(`Calls: ${report.total_calls}; spent $${report.spent_usd ?? report.total_cost_usd ?? 0}${report.budget_stopped ? "; stopped at --max-cost-usd" : ""}`);
  lines.push("");
  for (const model of report.models) {
    const title = model.model ?? "live route";
    const interval = model.pass_rate === null ? "no scored trials" : `${pct(model.pass_rate)} [${pct(model.lower)}, ${pct(model.upper)}]`;
    lines.push(`${title}: ${interval}; flaky ${model.flaky_case_count} (critical ${model.flaky_critical_case_count}); stable-fail ${model.stable_fail_case_count}; errors ${model.error_calls}; p95 ${model.latency_p95_ms ?? "n/a"} ms; cost $${model.total_cost_usd ?? 0}`);
    if (model.served) {
      lines.push(`  served: ${model.served.map((entry) => `${entry.model} ${entry.count}`).join(", ")}`);
    }
    const rows = model.cases.map((entry) => [
      entry.case_id + (entry.critical ? "*" : ""),
      `${entry.passes}/${entry.trials}`,
      entry.pass_rate === null ? "-" : pct(entry.pass_rate),
      entry.lower === null ? "-" : `[${pct(entry.lower)}, ${pct(entry.upper)}]`,
      entry.classification,
      entry.latency_p95_ms === null ? "-" : `${entry.latency_p95_ms} ms`,
      entry.errors > 0 ? `${entry.errors} err` : ""
    ]);
    lines.push(...table(["case", "pass", "rate", "95% interval", "class", "p95", ""], rows).map((line) => `  ${line}`));
    lines.push("");
  }
  const labeled = report.cases.filter((entry) => entry.discrimination);
  if (labeled.length > 0) {
    const ceiling = labeled.filter((entry) => entry.discrimination === "ceiling").length;
    const floor = labeled.filter((entry) => entry.discrimination === "floor").length;
    const discriminating = labeled.filter((entry) => entry.discrimination === "discriminating");
    lines.push(`Discrimination across ${report.models.length} models: ${discriminating.length} discriminating, ${ceiling} ceiling, ${floor} floor.`);
    if (discriminating.length > 0) {
      lines.push(`  discriminating: ${discriminating.map((entry) => entry.case_id).join(", ")}`);
    }
    if (ceiling === labeled.length) {
      lines.push("  Every case is at the ceiling for every model stressed; these cases cannot rank models.");
    }
  }
  lines.push("Stress is a local diagnostic. It writes nothing to BenchRouter; calls are billed as runtime usage.");
  return `${lines.join("\n")}\n`;
}

function pct(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
  const format = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  return [format(headers), ...rows.map(format)];
}
