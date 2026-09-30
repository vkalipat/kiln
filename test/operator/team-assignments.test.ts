import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamAssignmentStore, type TeamAssignmentInput } from "../../src/operator/team-assignments";
import type { TeamFeature } from "../../src/operator/team";

const feature: TeamFeature = { id: "parser", objective: "Parse CSV", scopes: ["src/parser.ts"], dependencies: [], acceptance: ["Reject malformed rows"], status: "planned" };
const input: TeamAssignmentInput = { featureId: "parser", role: "CSV error-handling implementer", candidates: [{ modelRef: "p/fast", reason: "Suitable throughput" }, { modelRef: "p/deep", reason: "Stronger reasoning" }], preferredModelRef: "p/deep" };
const admitted = [{ modelRef: "p/fast", effort: "high" }, { modelRef: "p/deep", effort: "xhigh" }];
const selected = { modelRef: "p/fast", source: "jev" as const, reason: "Compatible and sufficient quality" };
function fixture(run: (store: TeamAssignmentStore, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-assignment-"));
  try { const path = join(dir, "assignments.json"); run(new TeamAssignmentStore(path, "a".repeat(64), admitted), path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("assignments persist exact model effort and immutable repeatable dispatch identity", () => fixture((store, path) => {
  expect(store.load()).toEqual([]);
  const record = store.put(input, feature, selected);
  expect(record.dispatchName).toMatch(/^assignment_[a-f0-9]{32}$/);
  expect(record.effort).toBe("high");
  expect(store.put(input, feature, selected)).toEqual(record);
  expect(store.load()).toHaveLength(1);
  expect(new TeamAssignmentStore(path, "a".repeat(64), admitted).query(record.dispatchName, { ...feature, status: "active", owner: "worker" })).toEqual(record);
  expect(statSync(path).mode & 0o777).toBe(0o600);
}));

test("changed scope and reopened feature reject old dispatch while unrelated status changes preserve identity", () => fixture(store => {
  const record = store.put(input, feature, selected);
  expect(() => store.query(record.dispatchName, { ...feature, scopes: ["src/other.ts"] })).toThrow("changed or reopened");
  const reopened = { ...feature, history: [{ reason: "missing case", reopenedBy: "parent", previous: feature }] };
  expect(() => store.query(record.dispatchName, reopened)).toThrow("changed or reopened");
  expect(store.put(input, reopened, selected).dispatchName).not.toBe(record.dispatchName);
  expect(store.query("unknown", feature)).toBeUndefined();
}));

test("admission, candidates and explicit selection remain hard constraints", () => fixture(store => {
  expect(() => store.put({ ...input, role: "" }, feature, selected)).toThrow("role");
  expect(() => store.put({ ...input, candidates: Array(9).fill(input.candidates[0]) }, feature, selected)).toThrow("eight");
  expect(() => store.put({ ...input, candidates: [input.candidates[0]!, input.candidates[0]!] }, feature, selected)).toThrow("Duplicate");
  expect(() => store.put({ ...input, preferredModelRef: "absent" }, feature, selected)).toThrow("Preferred");
  expect(() => store.put({ ...input, candidates: [{ modelRef: "p/missing", reason: "test" }] }, feature, selected)).toThrow("not admitted");
  expect(() => store.put({ ...input, exactModelRef: "p/deep" }, feature, selected)).toThrow("cannot be overridden");
  expect(store.put({ ...input, exactModelRef: "p/deep" }, feature, { ...selected, modelRef: "p/deep" }).effort).toBe("xhigh");
}));

test("resume fails closed on changed catalog or modified persisted identity", () => fixture((store, path) => {
  store.put(input, feature, selected);
  expect(() => new TeamAssignmentStore(path, "b".repeat(64), admitted).load()).toThrow("catalog");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.assignments[0].reason = "Changed selection provenance";
  writeFileSync(path, JSON.stringify(doc));
  expect(() => store.load()).toThrow("identity");
}));

 test("updated user effort preserves historical assignments and creates a distinct new decision", () => fixture((store, path) => {
  const historical = store.put(input, feature, selected);
  const current = [{ modelRef: "p/fast", effort: "low" }, admitted[1]!];
  const resumed = new TeamAssignmentStore(path, "a".repeat(64), current);
  expect(resumed.load()[0]).toEqual(historical);
  expect(resumed.query(historical.dispatchName, feature)?.effort).toBe("high");
  const updated = resumed.put(input, feature, selected);
  expect(updated.effort).toBe("low");
  expect(updated.dispatchName).not.toBe(historical.dispatchName);
  expect(resumed.load()).toHaveLength(2);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.assignments[0].effort = "imaginary";
  writeFileSync(path, JSON.stringify(doc));
  expect(() => resumed.load()).toThrow("effort");
}));


test("byte capacity rejects before replacing the last readable assignment document", () => fixture((store, path) => {
  const factoryPath = `${path}.fixture`;
  const factory = new TeamAssignmentStore(factoryPath, "a".repeat(64), admitted);
  const records: ReturnType<TeamAssignmentStore["put"]>[] = [];
  const encode = () => `${JSON.stringify({ version: 1, catalogHash: "a".repeat(64), assignments: records }, null, 2)}\n`;
  let previous = encode();
  for (let index = 0; index < 1024; index++) {
    const nextFeature = { ...feature, id: `parser-${index}` };
    const nextInput = { ...input, featureId: nextFeature.id,
      candidates: input.candidates.map(candidate => ({ ...candidate, reason: "é".repeat(2048) })) };
    // Generate valid identities without repeatedly rewriting the growing fixture.
    const record = factory.put(nextInput, nextFeature, selected);
    rmSync(factoryPath);
    records.push(record);
    const next = encode();
    if (Buffer.byteLength(next, "utf8") > 2_000_000) {
      records.pop();
      writeFileSync(path, previous);
      expect(Buffer.byteLength(previous, "utf8")).toBeLessThanOrEqual(2_000_000);
      expect(store.load()).toHaveLength(records.length);
      expect(() => store.put(nextInput, nextFeature, selected)).toThrow("byte capacity");
      expect(readFileSync(path, "utf8")).toBe(previous);
      expect(store.load()).toHaveLength(records.length);
      return;
    }
    previous = next;
  }
  throw new Error("Fixture did not reach the byte boundary");
}));
