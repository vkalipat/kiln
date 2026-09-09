/** Explicit paid qualification, separated from bun test. Credentials remain in the real home. */
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { main } from "../src/cli/main";
import { createCliRuntime } from "../src/cli/runtime";
import { loadConfig, saveConfig } from "../src/core/config";
import { initHome } from "../src/core/home";
import { kilnHome, writeAtomic } from "../src/core/paths";
import { RunRecord } from "../src/core/record";
import { readStatus, runPaths } from "../src/core/run";
import { RunControl, withRunControl } from "../src/core/run-control";
import { finishProcess } from "../src/cli/exit";

const args = Bun.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args.includes("--confirm-spend")) throw new Error("Live validation incurs provider usage; pass --confirm-spend.");
const scenario = option("--case") ?? "delivery";
if (!["delivery", "ideation"].includes(scenario)) throw new Error("--case must be delivery or ideation");
const authHome = resolve(kilnHome());
const home = option("--home") ? resolve(option("--home")!) : mkdtempSync(join(tmpdir(), `kiln-live-${scenario}-`));
if (home === authHome) throw new Error("validation must not use the real home as its artifact directory");
initHome(home, { plugAndPlay: true }); chmodSync(home, 0o700);
const id = `live-${scenario}`;
const run = runPaths(home, id);
if (!existsSync(run.status)) {
  const cfg = loadConfig(authHome);
  cfg.routing = { mode: "adaptive" }; cfg.autonomous = true;
  cfg.budgets.usd = scenario === "delivery" ? 8 : 10.5;
  cfg.budgets.wallSeconds = 1500;
  saveConfig(home, cfg);
}
const cfg = loadConfig(home);
const runtime = await createCliRuntime(authHome, cfg, {});
const seed = scenario === "delivery"
  ? "Create and ship a dependency-free Python CLI named slugify.py that converts a supplied UTF-8 string to a lowercase ASCII hyphenated slug. Normalize accents with the standard library, collapse whitespace and punctuation, trim boundary hyphens, and reject an empty resulting slug with a nonzero exit status. Include executable unittest coverage for accents, punctuation, and empty input, plus a concise README with usage. This is a small local implementation task; no external research, hosted service, installation, or deployment is needed. Use the current directory only for the generated project; do not modify unrelated files. Finish when the CLI and tests pass."
  : "Evaluate and refine this supplied concept: a lightweight tool for independent bicycle repair shops to turn repair progress into clear customer status updates. Compare materially different approaches, research current alternatives with actually opened sources, identify major risks and counterevidence, and recommend the most differentiated testable direction. Keep facts, inferences, and hypotheses separate. Deliver a ranked shortlist with the cheapest validation steps. This run is research and ideation only; do not build or deploy anything.";
const output: string[] = [];
const errors: string[] = [];
const control = new RunControl();
const timer = setTimeout(() => control.cancel("live validation 25-minute wall limit"), 1_500_000);
const cappedStream: StreamFn = (model, context, options) => streamSimple(model, context, { ...options, maxTokens: 6144 });
console.log(JSON.stringify({ validationHome: home, scenario, runId: id, targetUsd: cfg.budgets.usd, resume: existsSync(run.status) }));
let code = 1;
try {
  code = await withRunControl(control, () => main(existsSync(run.status)
    ? ["run", "resume", id, "--home", home, "--through", scenario === "delivery" ? "reflect" : "checkpoint", "--autonomous", "--yes", "--json"]
    : ["run", "new", seed, "--id", id, "--home", home, "--autonomous", "--yes", "--json"], {
      write: (text) => output.push(text), error: (text) => { errors.push(text); process.stderr.write(text); },
    }, { apiKeyFor: runtime.apiKeyFor, fetchUsage: runtime.fetchUsage, streamFn: cappedStream,
      onRun: (active) => console.log(JSON.stringify({ attachedRun: active.id, dir: active.dir })) }));
} catch (error) { errors.push(String(error)); }
finally { clearTimeout(timer); }
const status = existsSync(run.status) ? readStatus(run) : undefined;
const costUsd = existsSync(run.record) ? new RunRecord(run.record).costUsd() : 0;
const report = { scenario, home, runId: id, code, status, costUsd, errors, output, activeResources: process.getActiveResourcesInfo?.(), finishedAt: new Date().toISOString() };
writeAtomic(join(home, "validation-report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ scenario, home, code, phase: status?.phase, state: status?.state, costUsd, outcome: status?.outcome, report: join(home, "validation-report.json") }));
await finishProcess(code);
