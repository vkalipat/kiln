import { createHash } from "node:crypto";
import { getBundledModel, type GeneratedProvider, type Model } from "@oh-my-pi/pi-catalog";
import { parseModelRef } from "../providers/models";
import type { PreparedStepRouting } from "./routing";

export type OperatorCatalogLookup = (ref: string) => Model | undefined;
const bundledLookup: OperatorCatalogLookup = ref => {
  const { provider, modelId } = parseModelRef(ref);
  return getBundledModel(provider as GeneratedProvider, modelId);
};

/** Canonical JSON metadata only. Credentials are never a catalog fingerprint input. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("Catalog snapshot metadata is too deeply nested");
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Catalog snapshot metadata contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Catalog snapshot requires plain metadata");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|secret)$/i.test(key)) {
      throw new Error("Catalog snapshot cannot contain credential fields");
    }
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = canonical(item, depth + 1);
  }
  return result;
}

/**
 * Freeze model selection and exact admitted catalog metadata for resume checks.
 * User-selected effort and wall-clock/evidence dates intentionally do not participate.
 * Reasoning capabilities in the model definitions DO participate, as do prices,
 * APIs, token limits, static headers, and tool dialects. This is an integrity
 * guard against drift, not proof that a provider accepts a request.
 */
export function operatorCatalogSha256(prepared: PreparedStepRouting, lookup: OperatorCatalogLookup = bundledLookup): string {
  const admitted = Object.fromEntries(Object.entries(prepared.admittedRoleRefs).map(([role, rows]) => [role, rows.map(row => row.ref)]));
  const selected = { ...prepared.selectedRoleRefs };
  const refs = [...new Set([...Object.values(admitted).flat(), ...Object.values(selected)])].sort();
  const models = Object.fromEntries(refs.map(ref => {
    const { provider, modelId } = parseModelRef(ref), model = lookup(ref);
    if (!model) throw new Error(`Catalog snapshot model is unavailable: ${ref}`);
    if (model.provider !== provider || model.id !== modelId) throw new Error(`Catalog snapshot model identity mismatch: ${ref}`);
    return [ref, model];
  }));
  const payload = canonical({ version: 1, admitted, selected, models });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
