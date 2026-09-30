import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { writeAtomic } from "../core/paths";
import type { TeamFeature } from "./team";

export interface TeamAssignmentCandidate { modelRef: string; reason: string }
export interface TeamAssignmentInput {
  featureId: string;
  role: string;
  candidates: TeamAssignmentCandidate[];
  preferredModelRef: string;
  exactModelRef?: string;
}
export interface TeamAssignmentSelection { modelRef: string; source: "jev" | "frontier"; reason: string }
export interface TeamAssignment extends TeamAssignmentInput, TeamAssignmentSelection {
  effort: string;
  featureHash: string;
  catalogHash: string;
  dispatchName: string;
}
export interface TeamAssignmentAdmission { modelRef: string; effort: string }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max && !/[\x00-\x1f]/.test(value);

/** Claims and completion do not change identity; edits and reopenings do. */
export function teamAssignmentFeatureHash(feature: TeamFeature): string {
  return digest({ id: feature.id, objective: feature.objective, scopes: feature.scopes,
    dependencies: feature.dependencies, acceptance: feature.acceptance, generation: feature.history?.length ?? 0 });
}

export function validateTeamAssignment(input: TeamAssignmentInput, feature: TeamFeature, admitted: readonly TeamAssignmentAdmission[]): void {
  if (!input || input.featureId !== feature.id) throw new Error("Assignment must reference an existing feature");
  if (!bounded(input.role, 160)) throw new Error("Assignment role must be bounded descriptive text");
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 8) throw new Error("Assignment requires one to eight candidates");
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || !bounded(candidate.modelRef, 256) || !bounded(candidate.reason, 2048)) throw new Error("Invalid assignment candidate");
    if (seen.has(candidate.modelRef)) throw new Error("Duplicate assignment candidate");
    seen.add(candidate.modelRef);
    if (!admitted.some(model => model.modelRef === candidate.modelRef)) throw new Error(`Model is not admitted: ${candidate.modelRef}`);
  }
  if (!seen.has(input.preferredModelRef)) throw new Error("Preferred model must be a candidate");
  if (input.exactModelRef !== undefined && (!seen.has(input.exactModelRef) || input.preferredModelRef !== input.exactModelRef)) throw new Error("Exact model must be the preferred candidate");
}

export function resolveTeamAssignmentSelection(input: TeamAssignmentInput, selection: TeamAssignmentSelection, admitted: readonly TeamAssignmentAdmission[]): TeamAssignmentSelection & { effort: string } {
  if (!selection || !["jev", "frontier"].includes(selection.source) || !bounded(selection.reason, 2048)) throw new Error("Invalid assignment selection");
  if (!input.candidates.some(candidate => candidate.modelRef === selection.modelRef)) throw new Error("Selected model must be a candidate");
  if (input.exactModelRef !== undefined && selection.modelRef !== input.exactModelRef) throw new Error("Exact model selection cannot be overridden");
  const model = admitted.find(candidate => candidate.modelRef === selection.modelRef);
  if (!model || !bounded(model.effort, 64)) throw new Error("Selected model and effort are not admitted");
  return { ...selection, effort: model.effort };
}

/** The enclosing native run lock serializes writes. Dispatch identities are immutable. */
export class TeamAssignmentStore {
  constructor(private readonly path: string, private readonly catalogHash: string, private readonly admitted: readonly TeamAssignmentAdmission[]) {
    if (!/^[a-f0-9]{64}$/.test(catalogHash)) throw new Error("Invalid assignment catalog fingerprint");
    if (new Set(admitted.map(model => model.modelRef)).size !== admitted.length) throw new Error("Duplicate admitted model");
  }

  load(): TeamAssignment[] {
    if (!existsSync(this.path)) return [];
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error("Invalid assignment file");
    const doc = JSON.parse(readFileSync(this.path, "utf8"));
    if (doc.version !== 1 || doc.catalogHash !== this.catalogHash || !Array.isArray(doc.assignments) || doc.assignments.length > 1024) throw new Error("Assignment catalog changed or document is invalid");
    const names = new Set<string>();
    for (const record of doc.assignments as TeamAssignment[]) {
      if (!record || !bounded(record.featureId, 128) || !/^[a-f0-9]{64}$/.test(record.featureHash) || record.catalogHash !== this.catalogHash || !/^assignment_[a-f0-9]{32}$/.test(record.dispatchName)) throw new Error("Invalid persisted assignment");
      validateTeamAssignment(record, { id: record.featureId } as TeamFeature, this.admitted);
      resolveTeamAssignmentSelection(record, record, this.admitted);
      // Saved effort is historical; a later explicit user override applies at dispatch.
      if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(record.effort) || record.dispatchName !== this.dispatchName(record)) throw new Error("Assignment identity or effort changed");
      if (names.has(record.dispatchName)) throw new Error("Duplicate assignment dispatch identity");
      names.add(record.dispatchName);
    }
    return doc.assignments;
  }

  query(dispatchName: string, feature: TeamFeature): TeamAssignment | undefined {
    const record = this.load().find(item => item.dispatchName === dispatchName);
    if (record && (record.featureId !== feature.id || record.featureHash !== teamAssignmentFeatureHash(feature))) throw new Error("Assignment feature changed or reopened; create a new assignment");
    return record;
  }

  put(input: TeamAssignmentInput, feature: TeamFeature, selection: TeamAssignmentSelection): TeamAssignment {
    validateTeamAssignment(input, feature, this.admitted);
    const resolved = resolveTeamAssignmentSelection(input, selection, this.admitted);
    const record: TeamAssignment = { featureId: input.featureId, role: input.role, candidates: structuredClone(input.candidates),
      preferredModelRef: input.preferredModelRef, ...(input.exactModelRef === undefined ? {} : { exactModelRef: input.exactModelRef }),
      ...resolved, featureHash: teamAssignmentFeatureHash(feature), catalogHash: this.catalogHash, dispatchName: "" };
    record.dispatchName = this.dispatchName(record);
    const assignments = this.load();
    const existing = assignments.find(item => item.dispatchName === record.dispatchName);
    if (existing) return existing;
    if (assignments.length >= 1024) throw new Error("Assignment document capacity reached");
    assignments.push(record);
    const serialized = `${JSON.stringify({ version: 1, catalogHash: this.catalogHash, assignments }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("Assignment document byte capacity reached");
    writeAtomic(this.path, serialized, { mode: 0o600 });
    return record;
  }

  private dispatchName(record: Omit<TeamAssignment, "dispatchName">): string {
    return `assignment_${digest({ featureId: record.featureId, role: record.role, candidates: record.candidates,
      preferredModelRef: record.preferredModelRef, exactModelRef: record.exactModelRef, modelRef: record.modelRef,
      source: record.source, reason: record.reason, effort: record.effort, featureHash: record.featureHash, catalogHash: record.catalogHash }).slice(0, 32)}`;
  }
}
