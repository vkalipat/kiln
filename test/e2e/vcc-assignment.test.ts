import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai/providers/mock";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { main } from "../../src/cli/main";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { RunRecord } from "../../src/core/record";

const BRIEF = `# Brief
## Problem
Explore computational biology Virtual Cell Challenge evaluation ideas.
## Constraints
- Real held-out data is unavailable; synthetic tests only check preconditions.
## Search success
- Preserve uncertainty; no biological validation without actual data and metrics.
## Non-goals
- Claiming real VCC scores from a synthetic smoke test.
## Shape
research
## Axes
- audience: labs | benchmarkers | analysts
- method: calibration | splits | normalization
## Discovery questions
- Which input data is actually available?
- Which checks are only synthetic preconditions?
`;
const LANDSCAPE = "# Landscape\n## Obvious list\n- Validate the evaluation pipeline.\n## Atoms\n- Held-out data is unavailable.\n## Tensions\n- Synthetic checks cannot establish real biological metrics.\n## Distant domains\n- Compiler preflight checks.\n";

test("native VCC checkpoint preserves exact assignments and does not turn synthetic scope into biological completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-vcc-native-mock-")); initHome(home);
  const cfg = defaultConfig(); cfg.routing = { mode: "adaptive" };
  cfg.ideation.rounds = 1; cfg.ideation.islands = 1; cfg.ideation.cheapIsland = false; cfg.ideation.ideasPerBatch = 2;
  cfg.ideation.entrantsCap = 4; cfg.ideation.anchorsCap = 2; cfg.ideation.pairCap = 6; cfg.ideation.minComparisons = 3; cfg.ideation.bootstrapSamples = 20;
  saveConfig(home, cfg);
  let batch = 0; const assigned = new Map<string, string>(); const received = new Map<string, string>(); const judged: string[] = [];
  const output: string[] = [];
  // Only the transport is mocked: the native CLI chooses its real workflow and catalog seats.
  const stream: StreamFn = (model, context, options) => {
    const system = Array.isArray(context.systemPrompt) ? context.systemPrompt.join("\n") : String(context.systemPrompt ?? "");
    const messages = JSON.stringify(context.messages); const offered = context.tools ?? [];
    const descriptions = offered.map((tool) => tool.description).join("\n");
    const has = (name: string) => offered.some((tool) => tool.name === name) || descriptions.includes(`"name":"${name}"`);
    const call = (name: string, args: unknown) => ({ content: [{ type: "toolCall", name: offered.some((tool) => tool.name === "exec") ? "exec" : name,
      arguments: offered.some((tool) => tool.name === "exec") ? { input: `text(await tools[${JSON.stringify(name)}](${JSON.stringify(args)}));` } : args }] });
    let response: unknown;
    const target = /Output file: (\S+)/.exec(system)?.[1];
    if (target?.endsWith("brief.md")) response = call("write", { path: target, content: BRIEF });
    else if (target?.endsWith("landscape.md")) response = call("write", { path: target, content: LANDSCAPE });
    else if (has("probe_spec")) {
      const packet = JSON.parse(system.match(/Exact assigned probe packet \(unabridged\):\n([^\n]+)/)![1]!);
      received.set(packet.dossier.id, packet.assignment.rationale);
      response = packet.assignment.rationale.startsWith("UNAVAILABLE")
        ? call("cannot_probe", { reason: "Real held-out input data is not available; no biological metric was measured." })
        : call("probe_spec", { files: [], command: "echo SYNTHETIC_SCHEMA_OK", needs: [], networkRequired: false, timeoutSeconds: 5,
          successPredicate: { type: "substring", value: "SYNTHETIC_SCHEMA_OK" }, scope: "precondition" });
    } else if (has("probe_request")) {
      const ids = [...new Set([...messages.matchAll(/Idea (r\d+-i\d+-\d+)/g)].map((match) => match[1]!))];
      response = call("probe_request", { ideas: ids.map((ideaId, i) => {
        const rationale = `${i === 0 ? "UNAVAILABLE: evaluate real held-out inputs" : "SYNTHETIC: check schema plumbing only"}. ${"Preserve this exact assignment. ".repeat(12)}No synthetic result is a real VCC metric.`;
        assigned.set(ideaId, rationale); return { ideaId, rationale };
      }) });
    } else if (has("collision")) response = call("collision", { coverageAdequate: false, same: false, reason: "No actual biological evaluation evidence is available in this test." });
    else if (has("novelty")) response = call("novelty", { restatement: false, reason: "Different bounded evaluation mechanisms." });
    else if (has("axis_map")) response = call("axis_map", { value: "labs", reason: "Matching test vocabulary." });
    else if (has("verdict")) { judged.push(messages); response = call("verdict", { valueWinner: "A", feasibilityWinner: "B", reason: "A comparison of proposed methods, not measured biological performance." }); }
    else if (system.includes("# Scout")) response = messages.includes("Prior-art check") && !messages.includes("toolResult")
      ? call("scholar_search", { query: "evaluation methods", maxResults: 1 }) : { content: ["Only proposed evaluation methods; real data and metrics remain unavailable."] };
    else if (system.includes("# Generator")) {
      const start = batch++ * 2;
      response = { content: [Array.from({ length: 2 }, (_, i) => `# Idea ${i + 1}\n## Title\nEvaluation method ${start + i}\n## Mechanism\nComputational evaluation variant ${start + i}\n## Draws on\nValidation pipelines\n## Axes\n- audience: ${["labs", "benchmarkers", "analysts"][(start + i) % 3]}\n- method: ${["calibration", "splits", "normalization"][(start + i) % 3]}\n## Testable claim\nValidate method ${start + i} only when real held-out data becomes available.\n## Cheapest test\nCheck data availability or explicitly synthetic schema preconditions.\n## Strongest failure reason\nSynthetic success does not imply a real VCC metric.\n`).join("\n")] };
    } else response = { content: ["Prefer clear assumptions and executable preconditions; actual biological validation remains outstanding."] };
    const scripted = createMockModel({ id: model.id, provider: model.provider, responses: [response] as never });
    return streamMock(scripted, context, options);
  };
  const code = await main(["run", "new", "Explore computational biology Virtual Cell Challenge evaluation ideas; real held-out data is unavailable, and synthetic checks must never be called biological validation.", "--home", home, "--through", "checkpoint", "--autonomous", "--yes", "--json"],
    { write: (text) => output.push(text), error: (text) => output.push(text) }, { streamFn: stream, apiKeyFor: async () => "mock-key", fetchUsage: async () => ({ used: 0, limit: 1 }),
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch });
  expect({ code, output: output.join("") }).toMatchObject({ code: 0 });
  const summary = JSON.parse(output.join(""));
  const routing = JSON.parse(readFileSync(join(summary.dir, "routing.json"), "utf8"));
  expect(routing.report.workloadPreference.workload).toBe("computational_biology_vcc");
  expect(routing.report.workloadPreference.status).toBe("applied");
  expect(summary.status).toMatchObject({ phase: "form", state: "running" }); // Checkpoint selection is not task completion.
  expect(assigned.has(summary.status.chosenIdeaId)).toBe(true); expect(assigned.size).toBeGreaterThan(1); expect(received).toEqual(assigned);
  const evidence = [...assigned.keys()].map((id) => JSON.parse(readFileSync(join(summary.dir, "ideas", `${id}.evidence.json`), "utf8")).probe);
  expect(evidence.some((probe) => probe.status === "not_run" && probe.reason.startsWith("cannot_probe:"))).toBe(true);
  expect(evidence.some((probe) => probe.status === "pass" && probe.scope === "precondition")).toBe(true);
  expect(evidence.every((probe) => /^[a-f0-9]{64}$/.test(probe.assignmentHash))).toBe(true);
  expect(judged.some((text) => text.includes("Probe scope: precondition") && text.includes("not independent verification"))).toBe(true);
  expect(judged.some((text) => text.includes("no biological metric was measured"))).toBe(true);
  const events = new RunRecord(join(summary.dir, "record.jsonl")).read();
  for (const role of ["generator", "prober"] as const) {
    const calls = events.filter((event) => event.t === "model.call" && event.role === role);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((event) => event.t === "model.call" && event.model === "gpt-6-astra")).toBe(true);
  }
  expect(events.some((event) => event.t === "checkpoint.decision")).toBe(true);
  for (const event of events) if (event.t === "probe.request") for (const request of event.ideas) {
    expect(assigned.has(request.ideaId)).toBe(true);
    expect(request.rationale).toBe(assigned.get(request.ideaId)!);
  }
  for (const [i, id] of [...assigned.keys()].entries()) if (evidence[i].status === "pass") {
    const artifact = JSON.parse(readFileSync(join(summary.dir, "probes", `${id}.${evidence[i].assignmentHash}.json`), "utf8"));
    expect(artifact.spec.assignmentContext.assignment.rationale).toBe(assigned.get(id));
    expect(artifact.result.assignmentHash).toBe(evidence[i].assignmentHash);
  }
}, 20_000);
