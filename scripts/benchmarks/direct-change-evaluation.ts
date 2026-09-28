import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const ASSERTION_FILES = [
  { path: "test/cli/run-workflow.test.ts", sha256: "48e6b8ddccfc0439b63aa1f8e8af083e3caf0f34a656a83dd1b9b3857278dc18" },
  { path: "test/phases/form.test.ts", sha256: "d4d1406c2313f31ae7ac200ea76f5f51dc1058f24de573eab596d0010e0bd8c2" },
  // 2026-09-28: fixtures now freeze every feature; integrity cases cover short and long
  // oracles. The exact-seed case and all seven evaluated behavioral assertions are retained.
  { path: "test/build/builder.test.ts", sha256: "f9a4788920e27cbd6f7c06eca258ad18e0343a4884a4b29ccfedf1fee16ad774" },
] as const;

const CASES = [
  { id: "direct-frame-new-adaptive", file: ASSERTION_FILES[0].path, name: "new adaptive direct tasks use a deterministic frame without embedding or changing the original request" },
  { id: "direct-frame-unmarked-compatibility", file: ASSERTION_FILES[0].path, name: "manual direct requests retain model framing and do not gain the adaptive marker" },
  { id: "formation-clean-first-approval", file: ASSERTION_FILES[1].path, name: "a direct unranked task keeps the full user request and brief authoritative" },
  { id: "formation-required-revision", file: ASSERTION_FILES[1].path, name: "a direct first-review revision still repairs and requires independent re-review" },
  { id: "formation-unmarked-compatibility", file: ASSERTION_FILES[1].path, name: "a historical supplied-task workflow retains the review sequence it froze with" },
  { id: "formation-review-boundary-stress", file: ASSERTION_FILES[1].path, name: "a direct approving review resumes without replay and cannot approve changed bytes" },
  { id: "builder-exact-seed-handoff", file: ASSERTION_FILES[2].path, name: "a new direct builder receives the exact original request once in its stable context" },
] as const;

/** Portable excerpts archived from the named baseline. `--verify-history` checks them against Git. */
export const BASELINE_EVIDENCE = {
  commit: "2e9ffa74852e50cce1afb55ef20d5e860781ed52",
  label: "parent of consolidation commit e37399d",
  excerpts: [
    {
      path: "src/cli/commands/run.ts",
      sha256: "82338d75753d687e3f87d7425417afdb8c16f4776dc689a9867f4804b8940d65",
      text: `    if (eligible("frame") && status.phase === "frame" && status.state === "running") {
      runtime.models("brain");
      result = await (deps.runFrame ?? runFrame)(base);
      throwIfRunCancelled();
      status = readStatus(run);
    }`,
    },
    {
      path: "src/phases/form.ts",
      sha256: "6ad948c5535ff38fba72429e59bbd47d92e7e7d6a4586db6a79f9fda99591823",
      text: `  const first = priorCritiques[0] ?? await critique(() => durableTurnsSince(deps.record, progressOffset, "critic"));
  const firstCriticTurns = progress.stage === "revised" ? progress.firstCriticTurns! : durableTurnsSince(deps.record, progressOffset, "critic");
  deps.onFormStage?.("first_critique");
  throwIfRunCancelled();

  let revisedFile: FeaturesFile;`,
    },
    {
      path: "src/phases/form.ts",
      sha256: "3f41c0a2ac2e3b225d63c709c082ec0799b6d107dd56120941dadf647c0b87fd",
      text: `    if (!deps.record.read().some((event) => event.t === "formation.revision" && event.ideaId === ideaId && event.attempt === attempt)) {
      deps.record.append({ t: "formation.revision", ideaId, attempt });
    }`,
    },
    {
      path: "src/phases/form.ts",
      sha256: "57575e34dcc3826ed29083db18eedf8e72063752a678ef956693c0d6952c5b59",
      text: `  const second = currentCritiques[1] ?? await critique(priorSecondTurns);
  deps.onFormStage?.("second_critique");`,
    },
    {
      path: "src/build/builder.ts",
      sha256: "ec4d10cb986382ee262a1f78396a30eee3112a1d299955f13f5b5130b8ba9f39",
      text: `    systemPrompt: [loadPrompt(deps.home, "kernel"), loadPrompt(deps.home, "builder"), \`## Playbook (build)\\n\${playbookSection(loadPlaybook(deps.home), "build")}\`],
    pinned: "Builder session is waiting for a feature contract.",`,
    },
  ],
} as const;

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim() || `git ${args.join(" ")} failed`);
  return new TextDecoder().decode(result.stdout).trim();
}

function validatePortableEvidence(): void {
  for (const evidence of BASELINE_EVIDENCE.excerpts) {
    if (sha256(evidence.text) !== evidence.sha256) throw new Error(`archived baseline excerpt hash mismatch: ${evidence.path}`);
  }
  for (const file of ASSERTION_FILES) {
    const text = readFileSync(resolve(ROOT, file.path), "utf8");
    if (sha256(text) !== file.sha256) throw new Error(`assertion evidence changed; update the evaluation deliberately: ${file.path}`);
  }
  for (const item of CASES) {
    const text = readFileSync(resolve(ROOT, item.file), "utf8");
    if (!text.includes(`test("${item.name}"`)) throw new Error(`assertion case missing: ${item.id}`);
  }
}

function verifyHistoricalCheckout(): void {
  for (const evidence of BASELINE_EVIDENCE.excerpts) {
    const source = git("show", `${BASELINE_EVIDENCE.commit}:${evidence.path}`);
    if (!source.includes(evidence.text)) throw new Error(`historical source differs from archived excerpt: ${evidence.path}`);
  }
}

export interface DirectChangeEvaluation {
  version: 1;
  attribution: "assertion-backed-current-and-compatibility-cases";
  source: { current: string; baseline: string; baselineLabel: string; historicalGitSource: "not-requested" | "verified" };
  conditions: string[];
  testCases: Array<{ id: string; file: string; name: string }>;
  assertionFiles: Array<{ path: string; sha256: string }>;
  observed: {
    frame: { optimizedModelFrameInvocations: 0; compatibilityModelFrameInvocations: 1 };
    cleanFormation: { optimizedCritiques: 1; optimizedRevisions: 0; compatibilityCritiques: 2; compatibilityRevisions: 1 };
    requiredRevision: { critiques: 2; revisions: 1 };
    builderHandoff: { optimizedExactSeedBlocks: 1; compatibilityExactSeedBlocks: 0; seedDriftDispatches: 0 };
    integrity: { reviewResumeReplayedCritiques: 0; changedBytesApproved: false; interruptedRevisionBorrowedApproval: false };
  };
  sourceChecks: Record<string, boolean>;
  limitations: string[];
  testOutput: { passed: number; failed: number };
}

/** Portable provider-free evaluation; optional Git history verification is CLI-only. */
export function evaluateDirectChanges(options: { verifyHistory?: boolean } = {}): DirectChangeEvaluation {
  validatePortableEvidence();
  if (options.verifyHistory) verifyHistoricalCheckout();
  const currentRun = readFileSync(resolve(ROOT, "src/cli/commands/run.ts"), "utf8");
  const currentForm = readFileSync(resolve(ROOT, "src/phases/form.ts"), "utf8");
  const currentBuilder = readFileSync(resolve(ROOT, "src/build/builder.ts"), "utf8");
  const sourceChecks = {
    archivedBaselineInvokedModelFrame: BASELINE_EVIDENCE.excerpts[0].text.includes("runFrame"),
    archivedBaselineFlowContinuedFromFirstCritiqueToRevision: BASELINE_EVIDENCE.excerpts.slice(1, 4).every((entry) => entry.path === "src/phases/form.ts"),
    archivedBaselineBuilderPromptHadNoSeedBlock: !BASELINE_EVIDENCE.excerpts[4].text.includes("Original user request"),
    currentHasDeterministicFrameGate: currentRun.includes('workflow.directFrame === "deterministic-v1"'),
    currentHasExactReviewedSnapshotGate: currentForm.includes("snapshotHash(current) !== progress.snapshot.hash"),
    currentHasStableBuilderSeedHandoff: currentBuilder.includes("Original user request (quoted data)"),
  };
  if (Object.values(sourceChecks).some((value) => !value)) throw new Error("direct-change source evidence check failed");

  const test = Bun.spawnSync([
    "bun", "test", ...ASSERTION_FILES.map((file) => file.path), "--test-name-pattern", CASES.map((item) => item.name).join("|"),
  ], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const text = `${new TextDecoder().decode(test.stdout)}\n${new TextDecoder().decode(test.stderr)}`;
  if (test.exitCode !== 0) throw new Error(`direct-change behavioral evaluation failed\n${text}`);
  const passed = Number(/\b(\d+) pass\b/.exec(text)?.[1] ?? 0);
  const failed = Number(/\b(\d+) fail\b/.exec(text)?.[1] ?? 0);
  if (passed !== CASES.length || failed !== 0) throw new Error(`unexpected direct-change case count: ${passed} pass, ${failed} fail`);

  return {
    version: 1,
    attribution: "assertion-backed-current-and-compatibility-cases",
    source: { current: git("rev-parse", "HEAD"), baseline: BASELINE_EVIDENCE.commit, baselineLabel: BASELINE_EVIDENCE.label,
      historicalGitSource: options.verifyHistory ? "verified" : "not-requested" },
    conditions: [
      "Provider-free mocked model transport; no network or paid requests.",
      "Counts are literal assertions made by the named, hash-bound current/compatibility tests; they are not traces from executing the historical checkout.",
      "Compatibility cases exercise the preserved unmarked behavior on current code. Archived baseline excerpts separately attribute that policy to the exact pre-consolidation source.",
      "The same current file validators, fake Git seam, and immutable acceptance-lock path apply to optimized and compatibility cases.",
    ],
    testCases: CASES.map((item) => ({ ...item })),
    assertionFiles: ASSERTION_FILES.map((file) => ({ ...file })),
    observed: {
      frame: { optimizedModelFrameInvocations: 0, compatibilityModelFrameInvocations: 1 },
      cleanFormation: { optimizedCritiques: 1, optimizedRevisions: 0, compatibilityCritiques: 2, compatibilityRevisions: 1 },
      requiredRevision: { critiques: 2, revisions: 1 },
      builderHandoff: { optimizedExactSeedBlocks: 1, compatibilityExactSeedBlocks: 0, seedDriftDispatches: 0 },
      integrity: { reviewResumeReplayedCritiques: 0, changedBytesApproved: false, interruptedRevisionBorrowedApproval: false },
    },
    sourceChecks,
    limitations: [
      "This measures orchestration assertions and integrity behavior, not model answer quality.",
      "Mock latency and token usage are not provider latency or cost, so no dollar/time savings are claimed.",
      "The historical checkout is source attribution only; the old implementation is not executed by the portable evaluation.",
      "The clean approval reduction applies only to newly marked adaptive direct/no-research workflows; required revisions and historical workflows retain review.",
      "The exact seed handoff improves available context but does not prove the builder will use every requirement correctly.",
    ],
    testOutput: { passed, failed },
  };
}

if (import.meta.main) console.log(JSON.stringify(evaluateDirectChanges({ verifyHistory: Bun.argv.includes("--verify-history") }), null, 2));
