/** Explicit, bounded, paid protocol check; never imported by the test suite. */
import { mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core";
import { createBrain } from "../src/brain/agent";
import { loadConfig } from "../src/core/config";
import { createRun } from "../src/core/run";
import { RunRecord } from "../src/core/record";
import { kilnHome, writeAtomic } from "../src/core/paths";
import { authStore, localAuthState } from "../src/onboarding/auth";
import { planAdaptiveRouting } from "../src/routing/adaptive";
import { resolveRole } from "../src/providers/models";
import { redactText, secretValues } from "../src/core/secrets";
import { finishProcess } from "../src/cli/exit";

if (!Bun.argv.includes("--confirm-spend")) throw new Error("This check can incur provider usage; pass --confirm-spend explicitly.");
const home = kilnHome();
const cfg = loadConfig(home);
const available = new Set<string>(localAuthState(home).configured);
const planned = planAdaptiveRouting(cfg, available, "Build a local JSON formatter CLI", new Date(), undefined, { phases: ["frame", "form", "build", "reflect"] });
const store = authStore(home);
const root = mkdtempSync(join(tmpdir(), "kiln-live-protocol-")); chmodSync(root, 0o700);
const run = createRun(root, "Provider interoperability validation; call the confirmation tool.", { id: "protocol" });
const record = new RunRecord(run.record);
const seen = new Set<string>();
const reports: unknown[] = [];
for (const role of ["brain", "critic"] as const) {
  const chosen = resolveRole(role, planned.config, available);
  if (seen.has(chosen.ref)) continue; seen.add(chosen.ref);
  if (record.costUsd() >= 2) break;
  let called = false;
  const tool: AgentTool<any> = {
    name: "confirm_probe", label: "Confirm protocol probe", description: "Confirm the non-sensitive interoperability marker.",
    parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
    execute: async (_id, args: { marker: string }) => {
      called = args.marker === "KILN_LIVE_OK";
      return { content: [{ type: "text", text: called ? "confirmed" : "wrong marker" }], isError: !called };
    },
  };
  const cappedStream: StreamFn = (model, context, options) => streamSimple(model, context, { ...options, maxTokens: 512, reasoning: "low" });
  const signal = AbortSignal.timeout(60_000);
  const brain = createBrain({ model: chosen.model, getApiKey: () => store.apiKeyFor(String(chosen.model.provider)),
    tools: [tool], terminalTools: ["confirm_probe"], systemPrompt: ["You are testing tool-call interoperability. Call confirm_probe with marker KILN_LIVE_OK. Do not browse or call other tools."],
    pinned: "A successful confirmation tool call is the entire task.", record, role, phase: "frame", turnCap: 2,
    usdCap: Math.max(0, 2 - record.costUsd()), effort: "low", signal, streamFn: cappedStream,
    shaping: { cfg: planned.config, runId: run.id },
  });
  const start = Date.now();
  try {
    const result = await brain.run("Call confirm_probe now with marker KILN_LIVE_OK.");
    const summary = { model: chosen.ref, toolCalled: called, stopped: result.stopped, costUsd: result.costUsd, durationMs: Date.now() - start,
      ...(result.error ? { error: redactText(result.error, secretValues()) } : {}) };
    reports.push(summary); console.log(JSON.stringify(summary));
  } catch (error) {
    const summary = { model: chosen.ref, toolCalled: called, error: redactText(String(error), secretValues()), durationMs: Date.now() - start };
    reports.push(summary); console.log(JSON.stringify(summary));
  }
}
writeAtomic(join(root, "report.json"), JSON.stringify({ reports, costUsd: record.costUsd(), completedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ report: join(root, "report.json"), costUsd: record.costUsd(), notes: "Protocol check only; not an end-to-end quality evaluation." }));
await finishProcess(!reports.length || reports.some((r: any) => r.toolCalled !== true) ? 1 : 0);
