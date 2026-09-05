import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, streamMock } from "@oh-my-pi/pi-ai";
import { appendAudit, type Audit } from "../../src/build/audit-contract";
import type { AuditorSessionResult } from "../../src/build/auditor";
import type { BuilderSessionResult } from "../../src/build/builder";
import type { BuildDeps } from "../../src/build/loop";
import type { CheckResult, RunCheckOptions } from "../../src/build/verify";
import { defaultConfig, saveConfig } from "../../src/core/config";
import { initHome } from "../../src/core/home";
import { Limiter } from "../../src/core/limiter";
import { hashInput, RunRecord } from "../../src/core/record";
import { createRun, writeStatus } from "../../src/core/run";
import type { Feature, FeaturesFile } from "../../src/formation/features";
import { writeAcceptanceLock } from "../../src/formation/lock";
import { projectPaths } from "../../src/formation/paths";
import { FakeGitRunner } from "./fake-git";

export const feature = (id = "f01", acceptance: Feature["acceptance"] = { type: "file", path: `${id}.txt` }): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance });

export const builderResult = (patch: Partial<BuilderSessionResult> = {}): BuilderSessionResult => ({
  stopped: "done", turns: 1, costUsd: 0.2, selfVerified: false, headMoved: false,
  contextPressure: false, pinnedTruncated: false, builderModelRef: "producer/builder",
  beforeHead: "a".repeat(40), afterHead: "a".repeat(40), ...patch,
});

export interface LoopFixture {
  home: string;
  deps: BuildDeps;
  record: RunRecord;
  git: FakeGitRunner;
  features: FeaturesFile;
  project: ReturnType<typeof projectPaths>;
  builderCalls: string[];
  checkCalls: Array<{ featureId?: string; phase: string; cwd: string; timeoutMs: number }>;
  auditCalls: string[];
  checkOutcomes: boolean[];
  auditVerdicts: Array<"agree" | "disagree">;
  builderResults: BuilderSessionResult[];
}

export function setupLoop(input: Feature[] = [feature()], options: { initRecorded?: boolean } = {}): LoopFixture {
  const home = mkdtempSync(join(tmpdir(), "kiln-loop-")); initHome(home);
  const run = createRun(home, "seed"); const record = new RunRecord(run.record); const cfg = defaultConfig(); saveConfig(home, cfg);
  const project = projectPaths(run.project); mkdirSync(project.repo, { recursive: true }); mkdirSync(project.checksDir, { recursive: true }); mkdirSync(project.blockedDir, { recursive: true });
  const spec = "# Spec\n\n## First milestone\nA working artifact.\n"; writeFileSync(project.spec, spec); writeFileSync(project.initSh, "#!/bin/sh\nexit 0\n");
  writeFileSync(run.brief, "# Brief\n\n## Goal\nBuild.\n\n## Constraints\n- local\n\n## Non-goals\n- hosted\n\n## Discovery questions\n- what?\n- how?\n\n## Axes\nmode: a | b\n\n## Shape\nproduct\n");
  const features: FeaturesFile = { version: 1, init: { needs: [] }, features: input };
  writeFileSync(run.features, `${JSON.stringify(features, null, 2)}\n`); writeFileSync(run.acceptanceLock, `${JSON.stringify(writeAcceptanceLock(features, hashInput(spec)), null, 2)}\n`); writeFileSync(run.featureState, "");
  writeFileSync(project.featuresMirror, `${JSON.stringify(features, null, 2)}\n`); writeFileSync(project.lockMirror, `${JSON.stringify(writeAcceptanceLock(features, hashInput(spec)), null, 2)}\n`);
  writeStatus(run, { phase: "build", state: "running", outcome: undefined });
  const initOutput = join(project.checksDir, "init.txt"); writeFileSync(initOutput, "init ok\n");
  if (options.initRecorded !== false) record.append({ t: "check", checkId: "init", kind: "shell", phase: "init", ok: true, exitCode: 0, durationMs: 1, overrunMs: 0, timedOut: false, outputPath: initOutput, outputTruncated: false });
  const git = new FakeGitRunner(); git.head = "a".repeat(40);
  const builderCalls: string[] = []; const checkCalls: LoopFixture["checkCalls"] = []; const auditCalls: string[] = [];
  const checkOutcomes: boolean[] = []; const auditVerdicts: Array<"agree" | "disagree"> = []; const builderResults: BuilderSessionResult[] = [];
  let checks = 0;
  const runCheck = async (_acceptance: Feature["acceptance"], options: RunCheckOptions): Promise<CheckResult> => {
    checks += 1; const ok = checkOutcomes.shift() ?? true; const checkId = `check-${checks}`; const outputPath = join(project.checksDir, `${checkId}.txt`); writeFileSync(outputPath, ok ? "ok\n" : "failed\n");
    checkCalls.push({ featureId: options.featureId, phase: options.phase, cwd: options.cwd, timeoutMs: options.timeoutMs });
    const result: CheckResult = { checkId, ok, kind: _acceptance.type, exitCode: ok ? 0 : 1, durationMs: 10, overrunMs: 0, timedOut: false, output: ok ? "ok" : "failed", outputPath, outputTruncated: false };
    options.record.append({ t: "check", checkId, featureId: options.featureId, attempt: options.attempt, kind: result.kind, phase: options.phase, ok, exitCode: result.exitCode, durationMs: 10, overrunMs: 0, timedOut: false, outputPath, outputTruncated: false });
    return result;
  };
  const runAuditor = async (_deps: any, current: Feature, check: CheckResult, context: any): Promise<AuditorSessionResult> => {
    auditCalls.push(current.id); const verdict = auditVerdicts.shift() ?? "agree";
    const seq = record.append({ t: "audit", featureId: current.id, attempt: context.attempt, checkId: check.checkId, shape: check.ok ? "full" : "short", verdict, verifiedCount: check.ok ? 1 : 0, claimedUnverifiedCount: verdict === "disagree" ? 1 : 0, regressions: [], checkQualityAdequate: check.ok, truncated: false, usdCapHit: false, crossProvider: true, costUsd: 0.1 });
    const audit: Audit = appendAudit(run, { featureId: current.id, attempt: context.attempt, checkId: check.checkId, sourceEventSeq: seq, createdAt: new Date().toISOString(), shape: check.ok ? "full" : "short", raw: { verified: check.ok ? ["ok"] : [], claimedUnverified: verdict === "disagree" ? ["unverified"] : [], regressions: [], nextSessionNotes: "next", checkQuality: { adequate: check.ok, reason: check.ok ? "good" : "failed" }, verdict }, model: { provider: "other", model: "audit", ref: "other/audit" } });
    record.append({ t: "audit.disposition", featureId: current.id, attempt: context.attempt, checkId: check.checkId, rawVerdict: verdict, effectiveVerdict: verdict, emptyDisagree: false, malformed: false, truncated: false, retried: false, evidenceUsable: true, checkVoided: false });
    return { audit, rawVerdict: verdict, effectiveVerdict: verdict, truncated: false, malformed: false, retried: false, evidenceUsable: true, crossProvider: true, costUsd: 0.1, check, recoveredFromVoid: false, finalCheckVoided: false, checkVoided: false };
  };
  const unused = createMockModel({ id: "unused", responses: [{ content: ["unused"] }] as never });
  const deps: BuildDeps = {
    home, run, record, cfg, git, models: () => ({ model: unused as never, ref: "producer/builder" }), apiKeyFor: async () => "key", streamFn: streamMock as never, effort: "medium", limiter: new Limiter(1),
    runBuilder: async (_deps, current) => { builderCalls.push(current.id); return builderResults.shift() ?? builderResult(); },
    runCheck, runAuditor: runAuditor as never,
    runSweep: async (_deps, passed, options) => { record.append({ t: "sweep", featureId: options.triggerFeatureId, planned: passed.length, run: passed.length, skipped: [], durationMs: 1, complete: true, scope: "full" }); return { regressed: [], scope: "full", skipped: [], seconds: 0.001 }; },
  };
  return { home, deps, record, git, features, project, builderCalls, checkCalls, auditCalls, checkOutcomes, auditVerdicts, builderResults };
}
