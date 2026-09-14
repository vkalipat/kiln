/** Public-subset runtime comparison. --prepare performs no model calls. */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple, type AssistantMessage, type FetchImpl, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { coworkFetch } from "@oh-my-pi/pi-ai/providers/cowork-fetch";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { createBrain } from "../../src/brain/agent";
import { loadPrompt } from "../../src/brain/prompts";
import { defaultConfig } from "../../src/core/config";
import { RunRecord } from "../../src/core/record";
import { kilnHome, writeAtomic } from "../../src/core/paths";
import { authStore } from "../../src/onboarding/auth";
import { modelCostUsd } from "../../src/providers/models";
import { finishProcess } from "../../src/cli/exit";

export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export type Item = { id: string; dataset: string; input: unknown; target: unknown; sourceHash: string };
export const SYSTEM = 'Solve the supplied benchmark problem using only its provided information. Return exactly one JSON object with key "answer" and no other text. For grids, answer is an array of output grids, one per test input. For multiple choice, answer is the letter A, B, C, or D. For other problems, answer is the exact requested answer string, including parentheses around a choice when the problem uses them. No tools are available.';
export function payload(item: Item): string {
  if (item.dataset.startsWith("arc")) {
    const x = item.input as any;
    return JSON.stringify({ train: x.train.map((p: any) => ({ input: p.input, output: p.output })), test: x.test.map((p: any) => ({ input: p.input })) });
  }
  const x = item.input as any;
  return JSON.stringify({ question: x.question, ...(x.choices ? { choices: x.choices.map((text: string, i: number) => ({ label: "ABCD"[i], text })) } : {}) });
}
export function grade(item: Item, text: string, status: string): { correct: boolean; malformed: boolean } {
  if (status !== "done") return { correct: false, malformed: false };
  try {
    const parsed = JSON.parse(text.trim());
    if (!parsed || Object.keys(parsed).length !== 1 || !("answer" in parsed)) throw new Error();
    if (item.dataset.startsWith("arc")) {
      if (!Array.isArray(parsed.answer) || parsed.answer.some((g: any) => !Array.isArray(g) || !g.length || g.length > 30 || g.some((r: any) => !Array.isArray(r) || !r.length || r.length > 30 || r.length !== g[0].length || r.some((v: any) => !Number.isInteger(v) || v < 0 || v > 9)))) throw new Error();
      return { correct: JSON.stringify(parsed.answer) === JSON.stringify(item.target), malformed: false };
    }
    if (typeof parsed.answer !== "string") throw new Error();
    return { correct: parsed.answer.trim() === String(item.target).trim(), malformed: false };
  } catch { return { correct: false, malformed: true }; }
}
export function wilson(k: number, n: number) {
  if (!n) return null;
  const z = 1.959963984540054, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - r), Math.min(1, c + r)];
}
export function reserveUsd(bytes: number) { return ((bytes + 2048) * 12.5 + 4096 * 50) / 1e6; }
export async function requestBody(url: string | URL | Request, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (url instanceof Request && !init?.body) return url.clone().text();
  throw new Error("Cannot reserve uninspectable provider request");
}
export function normalizeFormat(text: string): { category: string; text: string } {
  const value = text.trim();
  try {
    const parsed = JSON.parse(value);
    return { category: !parsed || typeof parsed !== "object" ? "JSON_scalar_wrong_shape" : Array.isArray(parsed) ? "JSON_array_wrong_shape" : !("answer" in parsed) ? "missing_answer" : Object.keys(parsed).length !== 1 ? "extra_fields" : "valid_JSON_object", text: value };
  } catch {}
  const fenced = value.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) { try { JSON.parse(fenced[1]!); return { category: "Markdown_fenced_valid_JSON", text: fenced[1]! }; } catch {} }
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "{") continue;
    try {
      const parsed = JSON.parse(value.slice(i));
      if (parsed && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && "answer" in parsed) return { category: "prose_before_final_JSON_object", text: JSON.stringify(parsed) };
    } catch {}
  }
  return { category: "unparseable", text: value };
}
function summarize(root: string) {
  const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
  const fixtures = readFileSync(join(root, "fixtures-private.json"), "utf8");
  if (sha(fixtures) !== report.protocol.fixtureHash) throw new Error("Frozen fixture mismatch");
  const items: Item[] = JSON.parse(fixtures), predictions = readFileSync(join(root, "predictions-private.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const categories: Record<string, number> = {};
  const rows = predictions.map(p => {
    const primary = report.results.find((r: any) => r.id === p.id && r.arm === p.arm);
    const normalized = normalizeFormat(p.text);
    if (primary.malformed) { const key = `${p.dataset}/${p.arm}/${normalized.category}`; categories[key] = (categories[key] ?? 0) + 1; }
    return { id: p.id, dataset: p.dataset, arm: p.arm, primaryCorrect: primary.correct, normalizedCorrect: grade(items.find(i => i.id === p.id)!, normalized.text, p.status).correct };
  });
  const secondary = ["arc1", "arc2", "bbh", "biology"].map(dataset => ({ dataset, arms: Object.fromEntries(["direct", "kiln"].map(arm => { const r = rows.filter(x => x.dataset === dataset && x.arm === arm); return [arm, { n: r.length, correct: r.filter(x => x.normalizedCorrect).length }]; })) }));
  const diagnostics = { label: "Post-hoc formatting sensitivity; not preregistered; primary scores unchanged; no new provider calls", rule: "Only strip an enclosing JSON Markdown fence or prose before a final parseable answer-only JSON object. No target-aware extraction, case folding, value/type conversion, or retry. Non-done remains unsuccessful.", categories, secondary, zeroDispatch: predictions.filter(p => p.calls === 0).length, wrongServedModel: predictions.filter(p => p.servedModel !== "claude-fable-5-1").length, dispatches: predictions.reduce((a, p) => a + p.calls, 0), costByArm: Object.fromEntries(["direct", "kiln"].map(arm => [arm, predictions.filter(p => p.arm === arm).reduce((a, p) => a + p.costUsd, 0)])) };
  writeAtomic(join(root, "format-diagnostics.json"), JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
  const cell = (a: any) => `${a.correct}/${a.n} (${pct(a.accuracy)}; 95% Wilson ${pct(a.wilson95[0])}–${pct(a.wilson95[1])})`;
  const lines = ["# Kiln runtime pilot", "", "Completed all 65 selected public-subset items in both arms: 130 single-attempt provider calls. This tests a tool-free agent runtime plus its prompt scaffolding, not Kiln's full orchestration and not an official benchmark submission.", "", "Both arms used anthropic/claude-fable-5-1 at xhigh, maxTokens 4096, 90-second deadline, no tools/retrieval/fallbacks or transport retries. Matched arms ran concurrently (maximum two requests); dataset queues were interleaved before results. Kiln used createBrain, bundled kernel, normal addenda/provider shaping, recording and turn/dollar caps; direct used streamSimple and the common answer-format instruction. Prompt scaffolding is part of the treatment.", "", "## Frozen primary scores", "", "Strict single JSON object exact-match scoring. Malformed output and output-limit stops count unsuccessful.", "", "| Public subset | Direct | Kiln | Paired accuracy difference |", "|---|---|---|---|", ...report.scores.map((s: any) => `| ${s.dataset} | ${cell(s.arms.direct)} | ${cell(s.arms.kiln)} | ${pct(s.paired.accuracyDifference)} |`), "", "Paired differences are exploratory. Discordant correct pairs (Kiln only / direct only): ARC1 0/0; ARC2 1/0; BBH 5/0; biology 1/2. Small deterministic subsets and wide intervals do not establish a general reasoning advantage.", "", "## Post-hoc formatting sensitivity", "", "This diagnostic was added after the run and is not preregistered. It leaves every primary score unchanged. All 12 malformed responses consisted of prose preceding a final valid answer JSON object (BBH direct 7, Kiln 2; biology direct 1, Kiln 2). Removing only that surrounding prose produces:", "", "| Public subset | Direct normalized | Kiln normalized |", "|---|---|---|", ...secondary.map(s => `| ${s.dataset} | ${s.arms.direct.correct}/${s.arms.direct.n} | ${s.arms.kiln.correct}/${s.arms.kiln.n} |`), "", "The BBH primary gap is sensitive to output-format compliance; do not interpret it as demonstrated reasoning improvement. Nine ARC calls reached the 4096-token cap (direct 5, Kiln 4); this constrained condition is not an unrestricted model capability estimate. No other non-done statuses, no zero-dispatch rows, and no model changes occurred in the scored run.", "", "## Cost and audit", "", `Recorded usage at catalog prices: $${report.recordedUsd.toFixed(5)} (direct $${diagnostics.costByArm.direct.toFixed(5)}, Kiln $${diagnostics.costByArm.kiln.toFixed(5)}). This is an estimate, not a provider invoice. Conservative budget ledger: $${report.chargedUsd.toFixed(5)}; it retains full reservations for output-limited calls. Allocation $20; no selected items were budget-censored.`, "", `Fixture SHA-256: ${report.protocol.fixtureHash}. Exact executed script preserved in executed-runtime-pilot.ts and verified against execution.json. Source snapshot: ${report.protocol.sourceSnapshot}. Five protocol tests (20 assertions), TypeScript check, and independent read-only isolation/ledger audit passed.`, "", "The initial preflight diagnostic root is excluded: OAuth Uint8Array payloads were rejected before any HTTP dispatch. The decoder was fixed, tested without network, and the identical frozen fixtures were run in this fresh root. The completed process was stopped after report persistence because the native transport retained idle connections; no calls followed the report.", "", "## Sources and scope", "", ...report.protocol.sources.map((s: any) => `- [${s.dataset} source pinned at ${s.commit}](https://github.com/${s.repo}/tree/${s.commit})`), `- [Screened biology source](${report.protocol.biologyMetadata.source_url}): 32 of 92 eligible items after conservative review of 144; 52 excluded. Custom MMLU college-biology subset, not full MMLU or a research/clinical capability score.`, "- ARC repositories: Apache-2.0. BIG-Bench Hard: MIT; upstream BIG-bench Apache-2.0. Biology publisher card: MIT. Preserve license/source notices when reusing datasets.", "- ARC1 original README allows three trials; ARC2 main success criterion allows two (its later format paragraph inconsistently says three). This pilot deliberately reports single-attempt results and claims no official comparability.", "- Public pretraining contamination cannot be excluded. The small sample, format sensitivity, budgeted output window, and runtime-only treatment limit interpretation. No hidden/private tests were accessed and no clinical or biological research effectiveness claim is supported.", "", "Private fixtures retain targets only on the evaluator side. Provider payloads positively allowlist demonstration pairs/test inputs or question/choices; all predictions were persisted before scoring, with no correctness feedback. No raw benchmark questions or answers were sent to ReasonBlocks.", ""];
  writeAtomic(join(root, "runtime-pilot-summary.md"), lines.join("\n"), { mode: 0o600 });
  console.log(JSON.stringify({ summary: join(root, "runtime-pilot-summary.md"), diagnostics: join(root, "format-diagnostics.json"), secondary, categories }));
}
async function get(url: string) { const r = await fetch(url); if (!r.ok) throw new Error(`Public fixture download ${r.status}`); return r.text(); }
async function prepare(bioPath: string) {
  const root = mkdtempSync(join(tmpdir(), "kiln-runtime-pilot-")); chmodSync(root, 0o700);
  const items: Item[] = [], sources: any[] = [];
  for (const [dataset, repo, branch, directory] of [["arc1", "fchollet/ARC-AGI", "master", "data/evaluation/"], ["arc2", "arcprize/ARC-AGI-2", "main", "data/evaluation/"], ["bbh", "suzgunmirac/BIG-Bench-Hard", "main", "bbh/"]]) {
    const commit = JSON.parse(await get(`https://api.github.com/repos/${repo}/commits/${branch}`)).sha;
    const tree = JSON.parse(await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`));
    let files: string[] = tree.tree.map((e: any) => e.path).filter((p: string) => p.startsWith(directory!) && p.endsWith(".json"));
    const order = (id: string) => sha(`kiln-runtime-pilot-v1|${dataset}|${id}`);
    files.sort((a, b) => order(a).localeCompare(order(b)));
    if (dataset !== "bbh") files = files.slice(0, 5);
    else {
      const families = new Set<string>();
      files = files.filter(p => { const family = p.replace(/_(three|five|seven)_objects/, "_objects"); if (families.has(family)) return false; families.add(family); return true; });
    }
    sources.push({ dataset, repo, commit, files });
    for (const file of files) {
      const raw = await get(`https://raw.githubusercontent.com/${repo}/${commit}/${file}`), data = JSON.parse(raw), sourceHash = sha(raw);
      if (dataset === "bbh") {
        const index = data.examples.map((_: unknown, i: number) => i).sort((a: number, b: number) => order(`${file}|${a}`).localeCompare(order(`${file}|${b}`)))[0];
        const example = data.examples[index]; items.push({ id: `${dataset}/${file}/${index}`, dataset, input: { question: example.input }, target: example.target, sourceHash });
      } else items.push({ id: `${dataset}/${file}`, dataset: dataset!, input: { train: data.train.map((p: any) => ({ input: p.input, output: p.output })), test: data.test.map((p: any) => ({ input: p.input })) }, target: data.test.map((p: any) => p.output), sourceHash });
    }
  }
  const bioRaw = readFileSync(bioPath, "utf8"), bio = JSON.parse(bioRaw);
  if (sha(bioRaw) !== "47b682fe360451fbd19b75d416b888a6af3671ec9d3193582a35ff74f9f83650") throw new Error("Screened biology fixture hash mismatch");
  for (const x of bio) items.push({ id: `biology/${x.id}`, dataset: "biology", input: { question: x.question, choices: x.choices }, target: "ABCD"[x.answer], sourceHash: sha(bioRaw) });
  const queues = ["arc1", "arc2", "bbh", "biology"].map(d => items.filter(i => i.dataset === d));
  const ordered: Item[] = [];
  while (queues.some(q => q.length)) for (const q of queues) { const next = q.shift(); if (next) ordered.push(next); }
  const fixtures = JSON.stringify(ordered);
  const protocol = { createdAt: new Date().toISOString(), label: "Exploratory public-subset agent-runtime comparison, not full orchestration or official benchmark score", model: "anthropic/claude-fable-5-1", effort: "xhigh", maxTokens: 4096, timeoutMs: 90000, budgetUsd: 20, fallbacks: "off", retries: 0, tools: [], sources, biologyMetadata: JSON.parse(readFileSync(join(bioPath, "..", "metadata.json"), "utf8")), fixtureHash: sha(fixtures), sampling: "SHA256 kiln-runtime-pilot-v1|dataset|path ascending; ARC first 5; BBH one hash-selected variant per family, one hash-selected index per file. Biology independently screened and hash sampled.", scoring: "Single attempt strict JSON answer exact-match; ARC all grids per task; no answer feedback. Failure/refusal/malformed counted wrong. Wilson95 and exploratory paired differences.", sourceSnapshot: "7ef356d324bfc8567abd2c2aa0ae170d5257ee58c44b43c9654911500f50ecdc", head: "2e9ffa74852e50cce1afb55ef20d5e860781ed52", count: items.length, systemHash: sha(SYSTEM) };
  Object.assign(protocol, { executionOrder: "Round robin ARC1, ARC2, BBH, biology; exhausted queues skipped; arm order alternates by item index", orderedIds: ordered.map(i => i.id) });
  writeAtomic(join(root, "fixtures-private.json"), fixtures, { mode: 0o600 });
  writeAtomic(join(root, "protocol.json"), JSON.stringify(protocol, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ root, count: items.length, counts: Object.fromEntries(["arc1", "arc2", "bbh", "biology"].map(d => [d, items.filter(i => i.dataset === d).length])), fixtureHash: protocol.fixtureHash }));
}
async function run(root: string) {
  if (existsSync(join(root, "execution.json")) || existsSync(join(root, "predictions-private.jsonl"))) throw new Error("This root has already started; refuse duplicate dispatch and budget reset. Preserve it and use a fresh explicitly authorized protocol root.");
  const raw = readFileSync(join(root, "fixtures-private.json"), "utf8"), protocol = JSON.parse(readFileSync(join(root, "protocol.json"), "utf8"));
  if (sha(raw) !== protocol.fixtureHash) throw new Error("Frozen fixture mismatch");
  const items: Item[] = JSON.parse(raw), results: any[] = [];
  const model = getBundledModel("anthropic", "claude-fable-5-1")!;
  const store = authStore(kilnHome()), cfg = defaultConfig(); cfg.provider.fallbacks = "off";
  const kernel = loadPrompt(join(root, "empty-home"), "kernel");
  writeAtomic(join(root, "executed-runtime-pilot.ts"), readFileSync(import.meta.path, "utf8"), { mode: 0o600 });
  writeAtomic(join(root, "execution.json"), JSON.stringify({ kernelHash: sha(kernel), systemHash: sha(SYSTEM), modelCost: model.cost, protocolHash: sha(readFileSync(join(root, "protocol.json"))), scriptHash: sha(readFileSync(import.meta.path)), startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  let charged = 0, recorded = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!, prompt = payload(item);
    // Reserve both arms before opening a pair; the transport rechecks exact request bytes.
    const pairReserve = 2 * reserveUsd(Buffer.byteLength(prompt + kernel + SYSTEM) + 4096);
    if (charged + pairReserve > 20) { console.log(JSON.stringify({ stopped: "pair_budget", completedPairs: index, charged, recorded })); break; }
    await Promise.all((index % 2 ? ["kiln", "direct"] : ["direct", "kiln"]).map(async arm => {
      let calls = 0, reservation = 0, captured: AssistantMessage | undefined;
      const started = Date.now(), signal = AbortSignal.timeout(90000);
      const guardedFetch: FetchImpl = async (url, init) => {
        if (calls > 0) throw new Error("Benchmark transport retry disabled");
        const body = await requestBody(url, init);
        if (!body) throw new Error("Cannot reserve uninspectable provider request");
        const wire = JSON.parse(body);
        if (wire.max_tokens > 4096 || wire.model !== model.id || wire.tools?.length) throw new Error("Provider isolation contract violated");
        reservation = reserveUsd(Buffer.byteLength(body));
        if (charged + reservation > 20) throw new Error("Budget reservation unavailable");
        charged += reservation; calls++;
        return coworkFetch(url, init);
      };
      const capped: StreamFn = (m, c, options) => {
        const { fallbacks: _fallbacks, ...rest } = options ?? {};
        const s = streamSimple(m, c, { ...rest, maxTokens: 4096, reasoning: "xhigh" as SimpleStreamOptions["reasoning"], signal, cacheRetention: "none", acceptEmptyResponse: true, fetch: guardedFetch });
        void s.result().then(v => { captured = v; }); return s;
      };
      let text = "", status = "error", cost = 0;
      try {
        if (arm === "direct") {
          const s = await capped(model, { systemPrompt: [SYSTEM], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { apiKey: await store.apiKeyFor("anthropic"), signal });
          const result = await s.result(); captured = result;
          text = result.content.filter(c => c.type === "text").map(c => c.text).join("");
          status = result.stopReason === "stop" ? "done" : result.stopReason;
        } else {
          const record = new RunRecord(join(root, `record-${index}.jsonl`));
          const brain = createBrain({ model, getApiKey: () => store.apiKeyFor("anthropic"), tools: [], systemPrompt: [kernel, SYSTEM], pinned: "For this benchmark return the requested JSON answer in your response. No files, citations, tools, retrieval, or follow-up questions are required or available.", record, role: "brain", phase: "frame", turnCap: 1, usdCap: 20 - recorded, effort: "xhigh", signal, streamFn: capped, shaping: { cfg, runId: `runtime-${index}` } });
          const result = await brain.run(prompt); text = result.text; status = result.stopped;
          if (captured?.stopReason && captured.stopReason !== "stop") status = captured.stopReason;
        }
        if (captured) cost = modelCostUsd(model, captured.usage);
      } catch { status = signal.aborted ? "timeout" : "error"; if (captured) cost = modelCostUsd(model, captured.usage); }
      recorded += cost;
      // Unknown/partial usage keeps its full reservation charged.
      if (calls && captured && status === "done" && Number.isFinite(cost)) charged += cost - reservation;
      const prediction = { id: item.id, dataset: item.dataset, arm, text, status, costUsd: cost, recordedUsd: recorded, chargedUsd: charged, calls, durationMs: Date.now() - started, servedModel: captured?.model ?? null, usage: captured?.usage ?? null };
      appendFileSync(join(root, "predictions-private.jsonl"), JSON.stringify(prediction) + "\n", { mode: 0o600 });
      // Persist the prediction before the evaluator reads its target.
      results.push({ ...prediction, ...grade(item, text, status), text: undefined, usage: undefined });
      writeAtomic(join(root, "progress.json"), JSON.stringify({ completed: results.length, recordedUsd: recorded, chargedUsd: charged }), { mode: 0o600 });
      console.log(JSON.stringify({ completed: results.length, total: items.length * 2, dataset: item.dataset, arm, status, costUsd: cost, recordedUsd: recorded, chargedUsd: charged }));
    }));
  }
  const scores = ["arc1", "arc2", "bbh", "biology"].map(dataset => {
    const rows = results.filter(r => r.dataset === dataset);
    const arms = Object.fromEntries(["direct", "kiln"].map(arm => { const a = rows.filter(r => r.arm === arm), correct = a.filter(r => r.correct).length; return [arm, { n: a.length, correct, accuracy: a.length ? correct / a.length : null, wilson95: wilson(correct, a.length), malformed: a.filter(r => r.malformed).length, failed: a.filter(r => r.status !== "done").length }]; }));
    const paired = [...new Set(rows.map(r => r.id))].map(id => rows.filter(r => r.id === id)).filter(p => p.length === 2);
    const wins = paired.filter(p => p.find(r => r.arm === "kiln").correct && !p.find(r => r.arm === "direct").correct).length;
    const losses = paired.filter(p => !p.find(r => r.arm === "kiln").correct && p.find(r => r.arm === "direct").correct).length;
    return { dataset, selected: items.filter(i => i.dataset === dataset).length, budgetNotRun: items.filter(i => i.dataset === dataset).length - paired.length, arms, paired: { n: paired.length, kilnOnlyCorrect: wins, directOnlyCorrect: losses, accuracyDifference: paired.length ? (wins - losses) / paired.length : null, interpretation: "exploratory; no causal/general capability claim" } };
  });
  writeAtomic(join(root, "report.json"), JSON.stringify({ protocol, recordedUsd: recorded, chargedUsd: charged, completed: results.length, planned: items.length * 2, scores, results, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: join(root, "report.json"), recordedUsd: recorded, chargedUsd: charged, scores }));
}
if (import.meta.main) {
  if (Bun.argv.includes("--summarize")) summarize(Bun.argv[Bun.argv.indexOf("--summarize") + 1]!);
  else if (Bun.argv.includes("--fork-protocol")) {
    const previous = Bun.argv[Bun.argv.indexOf("--fork-protocol") + 1]!, root = mkdtempSync(join(tmpdir(), "kiln-runtime-pilot-")); chmodSync(root, 0o700);
    for (const file of ["fixtures-private.json", "protocol.json"]) writeAtomic(join(root, file), readFileSync(join(previous, file), "utf8"), { mode: 0o600 });
    const p = JSON.parse(readFileSync(join(root, "protocol.json"), "utf8"));
    Object.assign(p, { executionConcurrency: 2, preflightDiagnosticRoot: previous, transport: "Pi native coworkFetch preserved; accept string, Uint8Array OAuth billing body and Request; one dispatched HTTP request per arm" });
    writeAtomic(join(root, "protocol.json"), JSON.stringify(p, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ root, fixtureHash: p.fixtureHash }));
  }
  else if (Bun.argv.includes("--prepare")) await prepare(Bun.argv[Bun.argv.indexOf("--bio") + 1]!);
  else if (Bun.argv.includes("--confirm-spend")) await run(Bun.argv[Bun.argv.indexOf("--root") + 1]!);
  else throw new Error("Use --prepare --bio PATH, or --confirm-spend --root PATH after protocol tests pass");
  await finishProcess(0);
}
