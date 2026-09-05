import { join } from "node:path";
import { writeAtomic } from "../core/paths";
import type { RunPaths } from "../core/run";
import {
  type Axis,
  type AxisMapping,
  type Dossier,
  normalizeAxes,
  parseDossier,
  splitIdeas,
} from "./dossier";

/** The small part of an island assignment persisted in a raw session header. */
export interface RawIslandPlan {
  round: number;
  island: number;
  ref: string;
  lens?: { id: string };
  operator?: { id: string };
}

export interface IslandBatch { text: string; bounded: boolean }

const HEADER = /^<!-- kiln island ([^>]*)-->$/m;
const BATCH = /^<!-- kiln batch (\d+) bounded=(true|false) -->$/gm;

/** Serialize a complete island session with the metadata needed for deterministic replay. */
export function formatRawIsland(plan: RawIslandPlan, batches: readonly IslandBatch[]): string {
  const move = plan.lens ? `lens=${plan.lens.id}` : plan.operator ? `operator=${plan.operator.id}` : "";
  const head = `<!-- kiln island round=${plan.round} island=${plan.island} model=${plan.ref}${move ? ` ${move}` : ""} -->`;
  const parts = [head];
  batches.forEach((batch, index) => parts.push(`<!-- kiln batch ${index + 1} bounded=${batch.bounded} -->`, batch.text.trim(), ""));
  return `${parts.join("\n").trimEnd()}\n`;
}

export interface RawIsland {
  meta: { round?: number; island?: number; model?: string; lens?: string; operator?: string };
  batches: IslandBatch[];
}

/** Read what `formatRawIsland` wrote; a legacy markerless file is one unbounded batch. */
export function parseRawIsland(raw: string): RawIsland {
  const meta: RawIsland["meta"] = {};
  const head = HEADER.exec(raw);
  if (head) {
    for (const [, key, value] of head[1]!.matchAll(/(\w+)=(\S+)/g)) {
      if (key === "round" || key === "island") meta[key] = Number(value);
      else if (key === "model" || key === "lens" || key === "operator") meta[key] = value;
    }
  }
  const marks = [...raw.matchAll(BATCH)];
  if (marks.length === 0) return { meta, batches: [{ text: raw.trim(), bounded: false }] };
  return {
    meta,
    batches: marks.map((mark, index) => ({
      text: raw.slice(mark.index! + mark[0]!.length, index + 1 < marks.length ? marks[index + 1]!.index! : raw.length).trim(),
      bounded: mark[2] === "true",
    })),
  };
}

export function rawIslandPath(paths: RunPaths, round: number, island: number): string {
  return join(paths.rawIdeasDir, `r${round}-i${island}.md`);
}

/** Atomically commit a complete island session; callers must never pass a partial/error result. */
export function writeRawIsland(paths: RunPaths, round: number, island: number, raw: string): string {
  const path = rawIslandPath(paths, round, island);
  writeAtomic(path, raw.endsWith("\n") ? raw : `${raw}\n`);
  return path;
}

export interface DerivedIdea {
  dossier: Dossier;
  vsBound: boolean;
  block: string;
  mapped: AxisMapping["mapped"];
  unknown: AxisMapping["unknown"];
}

/** Reconstruct deterministic ids, dossiers and evidence inputs from one committed raw session. */
export function deriveIdeas(raw: string, round: number, island: number, axes: readonly Axis[]): DerivedIdea[] {
  const { meta, batches } = parseRawIsland(raw);
  const out: DerivedIdea[] = [];
  let n = 0;
  for (const batch of batches) {
    for (const block of splitIdeas(batch.text)) {
      n += 1;
      const { dossier } = parseDossier(block);
      const mapping = mapAxes(dossier.axisValues ?? {}, axes);
      const d: Dossier = {
        id: `r${round}-i${island}-${n}`,
        title: dossier.title ?? "",
        mechanism: dossier.mechanism ?? "",
        draws: dossier.draws ?? "",
        axisValues: mapping.axisValues,
        testableClaim: dossier.testableClaim ?? "",
        cheapestTest: dossier.cheapestTest ?? "",
        failureReason: dossier.failureReason ?? "",
        parents: [],
      };
      if (dossier.vsProbability !== undefined) d.vsProbability = dossier.vsProbability;
      if (meta.lens !== undefined) d.lens = meta.lens;
      if (meta.operator !== undefined) d.operator = meta.operator;
      out.push({ dossier: d, vsBound: batch.bounded, block: `${block.trim()}\n`, mapped: mapping.mapped, unknown: mapping.unknown });
    }
  }
  return out;
}

function mapAxes(given: Record<string, string>, axes: readonly Axis[]): { axisValues: Record<string, string> } & Pick<AxisMapping, "mapped" | "unknown"> {
  if (axes.length === 0) return { axisValues: { ...given }, mapped: [], unknown: [] };
  const mapped = normalizeAxes({ axisValues: given }, axes);
  const axisValues: Record<string, string> = {};
  for (const axis of axes) {
    const canonical = mapped.axisValues[axis.name];
    const unknown = mapped.unknown.find((item) => item.axis === axis.name);
    if (canonical !== undefined) axisValues[axis.name] = canonical;
    else if (unknown && unknown.value !== "") axisValues[axis.name] = unknown.value;
  }
  return { axisValues, mapped: mapped.mapped, unknown: mapped.unknown };
}
