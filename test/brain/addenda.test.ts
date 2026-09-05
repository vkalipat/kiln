import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@oh-my-pi/pi-catalog";
import { ADDENDA, composeAddenda, type AddendumRole, type BlockId } from "../../src/brain/addenda";
import { defaultConfig } from "../../src/core/config";
import { hashInput } from "../../src/core/record";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOCKS = join(ROOT, "prompts", "blocks");
const ROLES: AddendumRole[] = [
  "brain", "builder", "form", "auditor", "critic", "judge", "generator", "scout", "prober", "arbiter", "reflector",
];

function model(id: string, efforts: string[] = ["low", "medium", "high", "xhigh"]): Model {
  return { id, thinking: { efforts } } as unknown as Model;
}

describe("prompt blocks", () => {
  test("B01 through B27 exist with source-anchored front matter and non-empty bodies", () => {
    const names = readdirSync(BLOCKS).filter((name) => /^B\d\d\.md$/.test(name)).sort();
    expect(names).toEqual(Array.from({ length: 27 }, (_, i) => `B${String(i + 1).padStart(2, "0")}.md`));
    for (const name of names) {
      const contents = readFileSync(join(BLOCKS, name), "utf8");
      const parsed = contents.match(/^---\nsource: (https:\/\/[^\n]+#[^\n]+)\n(?:adaptation: [^\n]+\n)?---\n([\s\S]+)$/);
      expect(parsed, name).not.toBeNull();
      expect(parsed?.[2].trim().length, name).toBeGreaterThan(0);
    }
  });

  test("records the two source-directed kiln terminology adaptations", () => {
    const precedence = readFileSync(join(BLOCKS, "B12.md"), "utf8");
    expect(precedence).toContain("guidelines provided in the playbook");
    expect(precedence).not.toContain("SKILL.md");
    const quotation = readFileSync(join(BLOCKS, "B20.md"), "utf8");
    expect(quotation).toContain("[web_fetch:");
    expect(quotation).toContain("[read:");
    expect(quotation).not.toContain("[web_search:");
  });
});

describe("ADDENDA", () => {
  test("holds the static audit rows and leaves other models empty", () => {
    expect(ADDENDA.fable.kernel).toEqual(["B04"]);
    expect(ADDENDA.fable.autonomous).toEqual(["B06"]);
    expect(ADDENDA.fable.interactive).toEqual(["B03", "B16", "B25"]);
    expect(ADDENDA.fable.builder).toEqual(["B01", "B04", "B07", "B08", "B09", "B10", "B24"]);
    expect(ADDENDA.astra.kernel).toEqual(["B12"]);
    expect(ADDENDA.astra.autonomous).toEqual(["B06", "B11"]);
    expect(ADDENDA.astra.builder).toEqual(["B07", "B08", "B12", "B15"]);
    expect(ADDENDA.other).toEqual({});
  });

  test("composes the exact interactive role rows in numeric order", () => {
    const cfg = defaultConfig();
    const fable = model("claude-fable-5-1");
    const astra = model("gpt-6-astra");
    const expected: Record<AddendumRole, { fable: BlockId[]; astra: BlockId[] }> = {
      brain: {
        fable: ["B01", "B02", "B03", "B04", "B05", "B16", "B19", "B24", "B25"],
        astra: ["B02", "B12", "B13", "B14"],
      },
      builder: {
        fable: ["B01", "B04", "B07", "B08", "B09", "B10", "B24"],
        astra: ["B07", "B08", "B12", "B15"],
      },
      form: {
        fable: ["B01", "B02", "B03", "B04", "B05", "B07", "B09", "B16", "B19", "B24", "B25"],
        astra: ["B02", "B12", "B13", "B14"],
      },
      auditor: { fable: ["B04"], astra: ["B12"] },
      critic: { fable: ["B04"], astra: ["B12"] },
      judge: { fable: ["B04"], astra: ["B12"] },
      generator: { fable: ["B04", "B18"], astra: ["B12", "B13"] },
      scout: { fable: ["B04", "B17", "B20"], astra: ["B12", "B20"] },
      prober: { fable: ["B04"], astra: ["B12"] },
      arbiter: { fable: ["B04"], astra: ["B12"] },
      reflector: { fable: ["B04", "B16", "B18"], astra: ["B12", "B13"] },
    };
    for (const role of ROLES) {
      expect(composeAddenda(fable, role, cfg).ids, `fable/${role}`).toEqual(expected[role].fable);
      expect(composeAddenda(astra, role, cfg).ids, `astra/${role}`).toEqual(expected[role].astra);
    }
  });

  test("switches from interactive rows to autonomous rows", () => {
    const cfg = defaultConfig();
    cfg.autonomous = true;
    expect(composeAddenda(model("claude-fable-5-1"), "brain", cfg).ids).toEqual([
      "B01", "B02", "B04", "B06", "B16", "B24",
    ]);
    expect(composeAddenda(model("gpt-6-astra"), "builder", cfg).ids).toEqual([
      "B06", "B07", "B08", "B11", "B12", "B15",
    ]);
  });

  test("adds B23 only when an eligible Fable seat actually runs at xhigh", () => {
    const cfg = defaultConfig();
    cfg.effortByRole = { ...cfg.effortByRole, brain: "xhigh", generator: "xhigh" };
    const supporting = model("claude-fable-5-1");
    expect(composeAddenda(supporting, "form", cfg).ids).toContain("B23");
    expect(composeAddenda(supporting, "generator", cfg).ids).toContain("B23");
    expect(composeAddenda(supporting, "brain", cfg).ids).not.toContain("B23");
    expect(composeAddenda(model("claude-fable-5-1", ["low", "medium", "high"]), "form", cfg).ids).not.toContain("B23");
    expect(composeAddenda(model("gpt-6-astra"), "form", cfg).ids).not.toContain("B23");
  });

  test("returns empty text for other models and hashes only ids plus body text", () => {
    const cfg = defaultConfig();
    for (const role of ROLES) {
      const composed = composeAddenda(model("gpt-5.6-sol"), role, cfg);
      expect(composed).toEqual({ family: "other", ids: [], text: "", hash: hashInput({ ids: [], text: "" }) });
    }
    const once = composeAddenda(model("claude-opus-5"), "builder", cfg);
    const twice = composeAddenda(model("claude-opus-5"), "builder", cfg);
    expect(twice).toEqual(once);
    expect(once.hash).toBe(hashInput({ ids: once.ids, text: once.text }));
    expect(once.text).not.toContain("source:");
    expect(once.text).not.toContain("---");
  });
});
