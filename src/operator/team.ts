import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";


export interface TeamArtifact { path: string; sha256: string }
export interface TeamCriterionEvidence { criterionId: string; artifacts: TeamArtifact[]; checkIndices: number[] }
export interface TeamHandoffInput { summary: string; artifacts: TeamArtifact[]; checks: string[]; coverage?: TeamCriterionEvidence[] }
export interface TeamReviewPacket {
  version: 1; revision: number; originalSourceHash: string; featureId: string; featureStatus: TeamFeature["status"];
  requirementCompleteness: "not_established"; taskQualityValidated: false; parentReviewRequired: true;
  evidenceIdentity: "fresh" | "invalid" | "unavailable"; evidenceErrors: string[];
  criteria: Array<{ id: string; index: number; text: string; mappingState: "worker_declared" | "unmapped";
    artifacts: Array<TeamArtifact & { identity: "fresh" | "invalid"; error?: string }>;
    checks: Array<{ index: number; text: string; status: "unverified_worker_claim" }>;
    proof: "not_established" }>;
}
export interface TeamFeaturePlan { id: string; objective: string; scopes: string[]; dependencies: string[]; acceptance: string[] }
export interface TeamFeature extends TeamFeaturePlan {
  status: "planned" | "active" | "awaiting_review" | "accepted";
  owner?: string;
  handoff?: TeamHandoffInput & { status: "unverified_claim" };
  history?: Array<{ reason: string; reopenedBy: string; previous: Omit<TeamFeature, "history"> }>;
  /** Parent assessment only: hashes identify evidence, not proof that checks ran. */
  review?: { reviewer: string; criteria: string[]; artifacts: TeamArtifact[]; status: "parent_reviewed" };
}
export interface TeamDocument { version: 1; runId: string; originalSourceHash: string; revision: number; features: TeamFeature[] }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function atomic(path: string, bytes: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function boundedRead(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd); if (!st.isFile() || st.size > limit) throw new Error("Invalid team file size or type");
    const bytes = Buffer.alloc(limit + 1); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > limit) throw new Error("Team file too large");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
const digest = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function text(value: string, max = 4096): void { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error("Invalid team text"); }
function list(values: string[], max = 64): void { if (!Array.isArray(values) || !values.length || values.length > max) throw new Error("Invalid team list"); values.forEach(v => text(v)); }
function path(value: string): void {
  text(value, 1024);
  if (/[?*\[\]{}]/.test(value)) throw new Error("Team paths must be literal file or directory paths, not globs");
  if (isAbsolute(value) || value.includes("\\") || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Team paths must be normalized relative paths");
}
const overlaps = (left: string, right: string) => { const a = left.toLowerCase(), b = right.toLowerCase(); return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); };
function validate(doc: TeamDocument): void {
  if (doc.version !== 1 || !id.test(doc.runId) || !digest.test(doc.originalSourceHash) || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !Array.isArray(doc.features) || doc.features.length > 128) throw new Error("Invalid team document");
  const ids = new Set(doc.features.map(f => f.id));
  if (ids.size !== doc.features.length) throw new Error("Duplicate feature id");
  for (const f of doc.features) {
    if (!id.test(f.id)) throw new Error("Invalid feature id");
    if (f.history && (!Array.isArray(f.history) || f.history.length > 32)) throw new Error("Invalid feature history");
    text(f.objective); list(f.scopes); f.scopes.forEach(path); list(f.acceptance);
    if (!Array.isArray(f.dependencies) || f.dependencies.length > 128 || f.dependencies.some(d => !ids.has(d))) throw new Error("Unknown feature dependency");
    if (!["planned", "active", "awaiting_review", "accepted"].includes(f.status)) throw new Error("Invalid feature state");
    if (f.status !== "planned") text(f.owner!);
    if (f.status === "awaiting_review" || f.status === "accepted") {
      if (!f.handoff || f.handoff.status !== "unverified_claim") throw new Error("Missing worker handoff");
      text(f.handoff.summary); list(f.handoff.checks); validateArtifacts(f.handoff.artifacts); validateCoverage(f, f.handoff);
    }
    if (f.status === "accepted") {
      if (!f.review || f.review.status !== "parent_reviewed" || f.review.criteria.length !== f.acceptance.length) throw new Error("Missing parent review");
      text(f.review.reviewer); list(f.review.criteria); validateArtifacts(f.review.artifacts);
    }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string) => { if (visiting.has(key)) throw new Error("Feature dependency cycle"); if (done.has(key)) return; visiting.add(key); doc.features.find(f => f.id === key)!.dependencies.forEach(visit); visiting.delete(key); done.add(key); };
  ids.forEach(visit);
}
function validateArtifacts(refs: TeamArtifact[]): void {
  if (!Array.isArray(refs) || !refs.length || refs.length > 64) throw new Error("Artifact evidence required");
  refs.forEach(ref => { path(ref.path); if (!digest.test(ref.sha256)) throw new Error("Invalid artifact hash"); });
}

/** Stable for the exact criterion, independent of owner, handoff, review and reopen. */
export function teamCriterionId(featureId: string, index: number, criterion: string): string {
  if (!id.test(featureId) || !Number.isSafeInteger(index) || index < 0 || index >= 64) throw new Error("Invalid team criterion identity");
  text(criterion);
  return `${featureId}:${index}:${hash(Buffer.from(criterion))}`;
}
function validateCoverage(feature: TeamFeaturePlan, handoff: TeamHandoffInput): void {
  if (handoff.coverage === undefined) return;
  if (!Array.isArray(handoff.coverage) || handoff.coverage.length > feature.acceptance.length) throw new Error("Invalid criterion evidence mappings");
  const criterionIds = new Set(feature.acceptance.map((value, index) => teamCriterionId(feature.id, index, value)));
  const seen = new Set<string>();
  for (const mapping of handoff.coverage) {
    if (!mapping || !criterionIds.has(mapping.criterionId)) throw new Error("Unrecognized team criterion id");
    if (seen.has(mapping.criterionId)) throw new Error("Duplicate team criterion mapping"); seen.add(mapping.criterionId);
    if (!Array.isArray(mapping.artifacts) || mapping.artifacts.length > 64 || !Array.isArray(mapping.checkIndices) || mapping.checkIndices.length > 64 || (!mapping.artifacts.length && !mapping.checkIndices.length)) throw new Error("Criterion mapping requires bounded evidence references");
    if (mapping.artifacts.length) validateArtifacts(mapping.artifacts);
    if (mapping.artifacts.some(ref => !handoff.artifacts.some(a => a.path === ref.path && a.sha256 === ref.sha256))) throw new Error("Criterion artifact must match an exact handoff artifact");
    if (new Set(mapping.artifacts.map(a => a.path + ":" + a.sha256)).size !== mapping.artifacts.length) throw new Error("Duplicate criterion artifact");
    if (mapping.checkIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= handoff.checks.length) || new Set(mapping.checkIndices).size !== mapping.checkIndices.length) throw new Error("Invalid criterion check index");
  }
}

/** Advisory coordination ledger, not filesystem isolation, scheduler, or authority over original requirements. */
export function createOperatorTeamStore(options: { runDir: string; cwd: string; runId: string; originalSourceHash: string }) {
  const root = realpathSync(options.cwd), run = realpathSync(options.runDir), file = join(run, "team.json");
  const read = (): TeamDocument => {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error("Team ledger must be a regular file");
    if (lstatSync(file).size > 2 * 1024 * 1024) throw new Error("Team ledger too large");
    const doc = JSON.parse(boundedRead(file, 2 * 1024 * 1024).toString("utf8")) as TeamDocument; validate(doc);
    if (doc.runId !== options.runId || doc.originalSourceHash !== options.originalSourceHash) throw new Error("Team original requirements mismatch");
    return doc;
  };
  const write = (doc: TeamDocument) => { validate(doc); const bytes = JSON.stringify(doc, null, 2) + "\n"; if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Team ledger too large"); atomic(file, bytes); };
  const mutate = (revision: number, fn: (doc: TeamDocument) => void) => withFileLock(file, async () => {
    const doc = read(); if (doc.revision !== revision) throw new Error(`Team revision conflict: current ${doc.revision}`);
    fn(doc); doc.revision++; write(doc); return doc;
  });
  const validateScope = (scope: string) => {
    path(scope);
    let candidate = root;
    for (const part of scope.split("/")) {
      candidate = join(candidate, part);
      try { if (lstatSync(candidate).isSymbolicLink()) throw new Error("Team scopes cannot traverse symlinks"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
  };
  const feature = (doc: TeamDocument, key: string) => { const f = doc.features.find(f => f.id === key); if (!f) throw new Error("Unknown feature"); return f; };
  const verify = (refs: TeamArtifact[]) => {
    validateArtifacts(refs);
    for (const ref of refs) {
      const target = resolve(root, ref.path), physical = realpathSync(target), rel = relative(root, physical);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || lstatSync(target).isSymbolicLink() || !lstatSync(physical).isFile() || lstatSync(physical).size > 16 * 1024 * 1024) throw new Error("Invalid team artifact path or size");
      if (hash(boundedRead(physical, 16 * 1024 * 1024)) !== ref.sha256) throw new Error(`Artifact hash drift: ${ref.path}`);
    }
  };
  const verifyDependencies = (doc: TeamDocument, f: TeamFeature, visited = new Set<string>()) => {
    for (const key of f.dependencies) {
      if (visited.has(key)) continue; visited.add(key);
      const dependency = feature(doc, key);
      if (dependency.status !== "accepted") throw new Error("Feature dependencies are not accepted");
      verify(dependency.handoff!.artifacts); verify(dependency.review!.artifacts);
      verifyDependencies(doc, dependency, visited);
    }
  };
  return {
    path: file,
    initialize: () => withFileLock(file, async () => { if (existsSync(file)) return read(); const doc: TeamDocument = { version: 1, runId: options.runId, originalSourceHash: options.originalSourceHash, revision: 0, features: [] }; write(doc); return doc; }),
    query: read,
    reviewPacket: (key: string): TeamReviewPacket => {
      const doc = read(), f = feature(doc, key), evidenceErrors: string[] = [];
      const snapshots = new Map<string, { identity: "fresh" | "invalid"; error?: string }>();
      const snapshot = (ref: TeamArtifact) => {
        const key = ref.path + ":" + ref.sha256;
        let state = snapshots.get(key);
        if (!state) {
          try { verify([ref]); state = { identity: "fresh" }; }
          catch (error) { state = { identity: "invalid", error: (error as Error).message }; evidenceErrors.push(state.error!); }
          snapshots.set(key, state);
        }
        return { ...ref, ...state };
      };
      try { verifyDependencies(doc, f); } catch (error) { evidenceErrors.push((error as Error).message); }
      f.handoff?.artifacts.forEach(snapshot); f.review?.artifacts.forEach(snapshot);
      return {
        version: 1, revision: doc.revision, originalSourceHash: doc.originalSourceHash, featureId: f.id, featureStatus: f.status,
        requirementCompleteness: "not_established", taskQualityValidated: false, parentReviewRequired: true,
        evidenceIdentity: evidenceErrors.length ? "invalid" : f.handoff ? "fresh" : "unavailable", evidenceErrors,
        criteria: f.acceptance.map((value, index): TeamReviewPacket["criteria"][number] => {
          const criterionId = teamCriterionId(f.id, index, value), mapping = f.handoff?.coverage?.find(m => m.criterionId === criterionId);
          return { id: criterionId, index, text: value, mappingState: mapping ? "worker_declared" : "unmapped",
            artifacts: (mapping?.artifacts ?? []).map(snapshot),
            checks: (mapping?.checkIndices ?? []).map(index => ({ index, text: f.handoff!.checks[index]!, status: "unverified_worker_claim" as const })),
            proof: "not_established" };
        }),
      };
    },
    plan: (plans: TeamFeaturePlan[], revision: number) => mutate(revision, doc => {
      if (!plans.length) throw new Error("Feature plans required");
      plans.forEach(p => p.scopes.forEach(validateScope));
      doc.features.push(...plans.map(p => ({ id: p.id, objective: p.objective, scopes: [...p.scopes], dependencies: [...p.dependencies], acceptance: [...p.acceptance], status: "planned" as const })));
    }),
    claim: (key: string, owner: string, revision: number) => mutate(revision, doc => {
      text(owner); const f = feature(doc, key); f.scopes.forEach(validateScope); if (f.status !== "planned") throw new Error("Feature already claimed");
      verifyDependencies(doc, f);
      if (doc.features.some(other => ["active", "awaiting_review"].includes(other.status) && other.scopes.some(a => f.scopes.some(b => overlaps(a, b))))) throw new Error("Feature scope conflicts with active ownership");
      f.owner = owner; f.status = "active";
    }),
    handoff: (key: string, owner: string, evidence: TeamHandoffInput, revision: number) => mutate(revision, doc => {
      const f = feature(doc, key); if (!["active", "awaiting_review"].includes(f.status) || f.owner !== owner) throw new Error("Only active feature owner may hand off");
      verify(evidence.artifacts); validateCoverage(f, evidence);
      if (!evidence.artifacts.some(a => f.scopes.some(s => a.path === s || a.path.startsWith(s + "/")))) throw new Error("Handoff must identify an artifact within its owned scope");
      f.handoff = { summary: evidence.summary, artifacts: evidence.artifacts.map(a => ({ ...a })), checks: [...evidence.checks], ...(evidence.coverage !== undefined ? { coverage: structuredClone(evidence.coverage) } : {}), status: "unverified_claim" }; f.status = "awaiting_review";
    }),
    reopen: (key: string, reviewer: string, reason: string, revision: number) => mutate(revision, doc => {
      text(reviewer); text(reason); const f = feature(doc, key);
      if (f.status === "planned") throw new Error("Feature is already available for claim");
      if ((f.history?.length ?? 0) >= 32) throw new Error("Feature recovery history limit reached");
      if (doc.features.some(other => other.dependencies.includes(key) && other.status !== "planned")) throw new Error("Reopen dependent features first");
      const { history, ...previous } = structuredClone(f);
      f.history = [...(history ?? []), { reason, reopenedBy: reviewer, previous }];
      f.status = "planned"; delete f.owner; delete f.handoff; delete f.review;
    }),
    /** Host capability: model-facing wrappers must enforce parent session identity. */
    accept: (key: string, reviewer: string, criteria: string[], artifacts: TeamArtifact[], revision: number) => mutate(revision, doc => {
      const f = feature(doc, key); if (f.status !== "awaiting_review" || f.owner === reviewer) throw new Error("Acceptance requires a separate parent review");
      verifyDependencies(doc, f);
      text(reviewer); list(criteria); if (criteria.length !== f.acceptance.length) throw new Error("Review each acceptance criterion in order");
      verify(f.handoff!.artifacts); verify(artifacts); f.review = { reviewer, criteria: [...criteria], artifacts: artifacts.map(a => ({ ...a })), status: "parent_reviewed" }; f.status = "accepted";
    }),
  };
}
export type OperatorTeamStore = ReturnType<typeof createOperatorTeamStore>;
