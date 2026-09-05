import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { Effort, KilnConfig, Role } from "../core/config";
import { hashInput } from "../core/record";
import { clampEffort, modelFamily, type ModelFamily } from "../providers/models";

export type BlockId =
  | "B01" | "B02" | "B03" | "B04" | "B05" | "B06" | "B07" | "B08" | "B09"
  | "B10" | "B11" | "B12" | "B13" | "B14" | "B15" | "B16" | "B17" | "B18"
  | "B19" | "B20" | "B21" | "B22" | "B23" | "B24" | "B25" | "B26" | "B27";

/** `form` adds form-only guidance to the ordinary brain row. */
export type AddendumRole = Role | "form";
export type AddendumRow = AddendumRole | "kernel" | "autonomous" | "interactive";

export interface ComposedAddenda {
  family: ModelFamily;
  ids: BlockId[];
  text: string;
  hash: string;
}

type AddendaConfig = Pick<KilnConfig, "autonomous" | "effort" | "effortByRole">;
type AddendaTable = Record<ModelFamily, Partial<Record<AddendumRow, readonly BlockId[]>>>;

/**
 * Static portions of audit §5(e). B22/B26 have per-turn and budget delivery paths;
 * B21 belongs to future compaction and B27 is satisfied by the detached auditor architecture.
 */
export const ADDENDA: AddendaTable = {
  fable: {
    kernel: ["B04"],
    autonomous: ["B06"],
    interactive: ["B03", "B16", "B25"],
    brain: ["B01", "B02", "B16", "B24"],
    builder: ["B01", "B04", "B07", "B08", "B09", "B10", "B24"],
    form: ["B07", "B09"],
    auditor: ["B04"],
    critic: ["B04"],
    generator: ["B18"],
    scout: ["B17", "B20"],
    reflector: ["B04", "B16", "B18"],
  },
  astra: {
    kernel: ["B12"],
    autonomous: ["B06", "B11"],
    brain: ["B02", "B12", "B13", "B14"],
    builder: ["B07", "B08", "B12", "B15"],
    form: ["B13"],
    auditor: ["B12"],
    critic: ["B12"],
    judge: ["B12"],
    generator: ["B13"],
    scout: ["B12", "B20"],
    prober: ["B12"],
    arbiter: ["B12"],
    reflector: ["B12", "B13"],
  },
  other: {},
};

const INTERACTIVE_BY_ROLE: Partial<Record<ModelFamily, Partial<Record<AddendumRole, readonly BlockId[]>>>> = {
  fable: { brain: ["B05", "B19"], form: ["B05", "B19"] },
};

const XHIGH_BY_ROLE: Partial<Record<ModelFamily, Partial<Record<AddendumRole, readonly BlockId[]>>>> = {
  fable: { form: ["B23"], generator: ["B23"] },
};

const BUNDLED_BLOCKS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "blocks");

function readBlock(id: BlockId): string {
  const source = readFileSync(join(BUNDLED_BLOCKS, `${id}.md`), "utf8");
  const frontMatter = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (!frontMatter) throw new Error(`prompt block ${id} is missing front matter`);
  return frontMatter[1]!.trim();
}

function configuredEffort(role: AddendumRole, cfg: AddendaConfig): Effort {
  const configRole: Role = role === "form" ? "brain" : role;
  return cfg.effortByRole?.[configRole] ?? cfg.effort;
}

/** Compose the model-family prefix in stable numeric block order. */
export function composeAddenda(model: Model, role: AddendumRole, cfg: AddendaConfig): ComposedAddenda {
  const family = modelFamily(model);
  const table = ADDENDA[family];
  const roleRows: AddendumRole[] = role === "form" ? ["brain", "form"] : [role];
  const selected: BlockId[] = [...(table.kernel ?? [])];
  for (const row of roleRows) selected.push(...(table[row] ?? []));
  if (cfg.autonomous) selected.push(...(table.autonomous ?? []));
  else if (role === "brain" || role === "form") {
    selected.push(...(table.interactive ?? []));
    selected.push(...(INTERACTIVE_BY_ROLE[family]?.[role] ?? []));
  }
  if (clampEffort(model, configuredEffort(role, cfg)) === "xhigh") {
    selected.push(...(XHIGH_BY_ROLE[family]?.[role] ?? []));
  }
  const ids = [...new Set(selected)].sort() as BlockId[];
  const text = ids.map(readBlock).join("\n\n");
  return { family, ids, text, hash: hashInput({ ids, text }) };
}
