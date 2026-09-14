import { expect, test } from "bun:test";
import { evaluateDirectChanges } from "../../scripts/benchmarks/direct-change-evaluation";

test("direct consolidation removes clean-path calls while retaining repair and integrity gates", () => {
  const result = evaluateDirectChanges();
  expect(result.attribution).toBe("assertion-backed-current-and-compatibility-cases");
  expect(result.source.historicalGitSource).toBe("not-requested");
  expect(result.testOutput).toEqual({ passed: 7, failed: 0 });
  expect(result.observed.frame).toEqual({ optimizedModelFrameInvocations: 0, compatibilityModelFrameInvocations: 1 });
  expect(result.observed.cleanFormation).toEqual({ optimizedCritiques: 1, optimizedRevisions: 0, compatibilityCritiques: 2, compatibilityRevisions: 1 });
  expect(result.observed.requiredRevision).toEqual({ critiques: 2, revisions: 1 });
  expect(result.observed.builderHandoff).toEqual({ optimizedExactSeedBlocks: 1, compatibilityExactSeedBlocks: 0, seedDriftDispatches: 0 });
  expect(result.observed.integrity).toEqual({ reviewResumeReplayedCritiques: 0, changedBytesApproved: false, interruptedRevisionBorrowedApproval: false });
  expect(Object.values(result.sourceChecks).every(Boolean)).toBe(true);
});
