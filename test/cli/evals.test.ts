import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { evalsCommand } from "../../src/cli/commands/evals";
import { initHome } from "../../src/core/home";
import { buildEvalsManifest } from "../../src/evals/manifest";
import { loadSeeds } from "../../src/evals/seeds";

const bundledHome = join(import.meta.dir, "../..");

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { write: (text: string) => out.push(text), error: (text: string) => err.push(text) },
  };
}

function copiedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-evals-cli-"));
  initHome(home);
  return home;
}

interface TreeEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  mode: number;
  data?: string;
}

function treeSnapshot(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const name = relative(root, path).split(sep).join("/") || ".";
    if (stat.isDirectory()) {
      entries.push({ path: name, type: "directory", mode: stat.mode & 0o777 });
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) {
      entries.push({ path: name, type: "file", mode: stat.mode & 0o777, data: readFileSync(path).toString("base64") });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: name, type: "symlink", mode: stat.mode & 0o777, data: readlinkSync(path) });
    } else {
      entries.push({ path: name, type: "other", mode: stat.mode & 0o777 });
    }
  };
  visit(root);
  return entries;
}

async function invoke(action: "verify" | "leakcheck", home: string, json = false) {
  const captured = output();
  const flags: Record<string, string | boolean> = { home };
  if (json) flags.json = true;
  const code = await evalsCommand([action], flags, captured.io);
  return { code, ...captured };
}

describe("kiln evals", () => {
  test("verify and leakcheck print JSON and readable success on bundled and copied homes", async () => {
    for (const home of [bundledHome, copiedHome()]) {
      const verifiedJson = await invoke("verify", home, true);
      expect(verifiedJson.code).toBe(0);
      expect(JSON.parse(verifiedJson.out.join(""))).toMatchObject({
        ok: true,
        manifest: { ok: true, changed: [], missing: [], extra: [] },
        split: { ok: true, errors: [], changed: [], missing: [], extra: [] },
      });
      expect(verifiedJson.err).toEqual([]);

      const verifiedText = await invoke("verify", home);
      expect(verifiedText.code).toBe(0);
      expect(verifiedText.out.join("")).toBe("evals verify: ok\n");
      expect(verifiedText.err).toEqual([]);

      const leakedJson = await invoke("leakcheck", home, true);
      expect(leakedJson.code).toBe(0);
      expect(JSON.parse(leakedJson.out.join(""))).toEqual({
        ok: true,
        rows: [],
        manifest: { ok: true, changed: [], missing: [], extra: [] },
      });
      expect(leakedJson.err).toEqual([]);

      const leakedText = await invoke("leakcheck", home);
      expect(leakedText.code).toBe(0);
      expect(leakedText.out.join("")).toBe("evals leakcheck: ok\n");
      expect(leakedText.err).toEqual([]);
    }
  });

  test("verify refuses manifest drift and names the changed file in JSON and text", async () => {
    const home = copiedHome();
    writeFileSync(join(home, "evals", "README.md"), "changed evaluator documentation\n");

    const json = await invoke("verify", home, true);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out.join(""))).toMatchObject({
      ok: false,
      manifest: { ok: false, changed: ["README.md"] },
    });

    const text = await invoke("verify", home);
    expect(text.code).toBe(1);
    expect(text.out.join("")).toContain("evals verify: failed");
    expect(text.out.join("")).toContain("manifest changed: README.md");
  });

  test("missing manifest material is reported without being repaired, including by leakcheck", async () => {
    const home = copiedHome(); const missing = join(home, "evals", "README.md"); unlinkSync(missing);
    const verified = await invoke("verify", home, true);
    expect(verified.code).toBe(1);
    expect(JSON.parse(verified.out.join("")).manifest.missing).toEqual(["README.md"]);
    expect(() => lstatSync(missing)).toThrow();

    const leaked = await invoke("leakcheck", home, true);
    expect(leaked.code).toBe(1);
    expect(JSON.parse(leaked.out.join("")).rows).toContainEqual({ kind: "manifest", source: "missing:README.md", seedId: "", score: 1 });
    expect(() => lstatSync(missing)).toThrow();
  });

  test("verify refuses split drift and names the seed whose registered hash no longer matches", async () => {
    const home = copiedHome();
    const splitPath = join(home, "evals", "split.json");
    const split = JSON.parse(readFileSync(splitPath, "utf8")) as { seeds: Array<{ file: string; sha256: string }> };
    const changed = split.seeds[0]!;
    changed.sha256 = "0".repeat(64);
    writeFileSync(splitPath, `${JSON.stringify(split, null, 2)}\n`);
    const manifest = buildEvalsManifest(home, { generatedAt: "2026-09-05T00:00:00.000Z" });
    writeFileSync(join(home, "evals", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const json = await invoke("verify", home, true);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out.join(""))).toMatchObject({
      ok: false,
      manifest: { ok: true },
      split: { ok: false, changed: [changed.file] },
    });

    const text = await invoke("verify", home);
    expect(text.code).toBe(1);
    expect(text.out.join("")).toContain(`split changed: ${changed.file}`);
  });

  test("leakcheck refuses copied held-out text and names its mutable source", async () => {
    const home = copiedHome();
    const seed = loadSeeds(home, "heldout")[0]!;
    writeFileSync(join(home, "playbook", "playbook.md"), `## build\n- B1 [helpful:0 harmful:0] ${seed.text.trim()}\n`);

    const json = await invoke("leakcheck", home, true);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out.join("")).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "trigram", source: "playbook/playbook.md#B1", seedId: seed.id }),
      expect.objectContaining({ kind: "shingle", source: "playbook/playbook.md#B1", seedId: seed.id }),
    ]));

    const text = await invoke("leakcheck", home);
    expect(text.code).toBe(1);
    expect(text.out.join("")).toContain("evals leakcheck: failed");
    expect(text.out.join("")).toContain("playbook/playbook.md#B1");
    expect(text.out.join("")).toContain(seed.id);
  });

  test("both commands leave every home entry and byte unchanged", async () => {
    const home = copiedHome();
    const before = treeSnapshot(home);

    expect((await invoke("verify", home, true)).code).toBe(0);
    expect((await invoke("leakcheck", home)).code).toBe(0);

    expect(treeSnapshot(home)).toEqual(before);
  });

  test("missing, unknown, and over-specified actions are usage errors", async () => {
    for (const cmd of [[], ["unknown"], ["verify", "extra"], ["leakcheck", "extra"]]) {
      const captured = output();
      expect(await evalsCommand(cmd, { home: bundledHome }, captured.io)).toBe(2);
      expect(captured.out).toEqual([]);
      expect(captured.err.join("")).toContain("usage: kiln evals verify");
      expect(captured.err.join("")).toContain("kiln evals leakcheck");
    }
  });

  test("metrics stays read-only and M1/M2 require budgets before dispatching injected runners", async () => {
    const home = copiedHome(); const metrics = await invoke("verify", home, true);
    expect(metrics.code).toBe(0);
    const collected = output(); expect(await evalsCommand(["metrics"], { home, json: true }, collected.io)).toBe(0);
    expect(JSON.parse(collected.out.join(""))).toMatchObject({ version: 1, runs: { total: 0 }, rows: [] });

    let m1Calls = 0; const noBudget = output();
    expect(await evalsCommand(["m1"], { home, json: true }, noBudget.io, { runM1: async () => { m1Calls++; return {} as never; } })).toBe(2);
    expect(m1Calls).toBe(0); expect(noBudget.err.join("")).toContain("--budget");

    const m1 = output();
    expect(await evalsCommand(["m1"], { home, budget: "1000", rounds: "1", json: true }, m1.io, {
      runM1: async (_home, _cfg, options) => { m1Calls++; return { version: 1, kind: "m1", evalId: "m1", status: "complete", comparisons: [], options } as never; },
    })).toBe(0);
    expect(m1Calls).toBe(1); expect(JSON.parse(m1.out.join("")).status).toBe("complete");

    let m2Calls = 0; const m2 = output();
    expect(await evalsCommand(["m2"], { home, budget: "$100", projects: "2", json: true }, m2.io, {
      runM2: async (_home, _cfg, options) => { m2Calls++; return { version: 1, kind: "m2", evalId: "m2", status: "complete", projects: [], options } as never; },
    })).toBe(0);
    expect(m2Calls).toBe(1); expect(JSON.parse(m2.out.join("")).options.projects).toBe(2);
  });

  test("prints the M1 projection once and a declined confirmation starts no runner", async () => {
    const home = copiedHome(); let calls = 0; const captured = output();
    expect(await evalsCommand(["m1"], { home, budget: "1000", rounds: "1" }, { ...captured.io, ask: async () => "no" }, {
      runM1: async () => { calls++; return {} as never; },
    })).toBe(0);
    expect(calls).toBe(0);
    expect(captured.out.join("")).toContain("M1 projection");
    expect(captured.out.join("")).toContain("total");
    expect(captured.out.join("")).toContain("A0 brain");
    expect(captured.out.join("")).toContain("anthropic/claude-opus-4-8");
    expect(captured.out.join("")).toContain("high");
  });

  test("prints M2's derived build assumptions, configured models, and efforts before consent", async () => {
    const home = copiedHome(); let calls = 0; const captured = output();
    expect(await evalsCommand(["m2"], { home, budget: "100", projects: "2" }, { ...captured.io, ask: async () => "no" }, {
      runM2: async () => { calls += 1; return {} as never; },
    })).toBe(0);
    expect(calls).toBe(0);
    const text = captured.out.join("");
    expect(text).toContain("derived max features");
    expect(text).toContain("build assumptions");
    expect(text).toContain("builder");
    expect(text).toContain("anthropic/claude-opus-4-8");
    expect(text).toContain("high");
  });

  test("calibrate validates its paid inputs and dispatches a structured JSON result", async () => {
    const home = copiedHome(); let calls = 0;
    const missing = output(); expect(await evalsCommand(["calibrate"], { home, json: true }, missing.io, { calibrate: async () => { calls++; return {} as never; } })).toBe(2);
    expect(calls).toBe(0);
    const invalid = output(); expect(await evalsCommand(["calibrate"], { home, budget: "10", labels: "robot", json: true }, invalid.io, { calibrate: async () => { calls++; return {} as never; } })).toBe(2);
    expect(calls).toBe(0);

    const captured = output();
    expect(await evalsCommand(["calibrate"], { home, budget: "10", labels: "agent", groups: "2", json: true }, captured.io, {
      calibrate: async (_home, options) => { calls++; return { version: 1, id: "cal", groups: options.groups, agreement: 0.8, orderAgreement: 0.9, calibrated: false, provisional: true, costUsd: 1 } as never; },
    })).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(captured.out.join(""))).toMatchObject({ id: "cal", groups: 2, provisional: true });
  });

  test("calibration refuses insufficient material before resolving a model", async () => {
    const home = copiedHome(); let modelCalls = 0; const captured = output();
    expect(await evalsCommand(["calibrate"], { home, budget: "10", labels: "agent", groups: "1", json: true }, captured.io, {
      calibration: {
        models: () => { modelCalls++; throw new Error("must not resolve"); },
        availableProviders: new Set(), apiKeyFor: async () => undefined,
      },
      git: {} as never,
    })).toBe(1);
    expect(modelCalls).toBe(0);
    expect(captured.err.join("")).toContain("insufficient material");
  });

  test("effort validates target and budget before dispatching the production vehicle seam", async () => {
    const home = copiedHome(); let calls = 0;
    const invalid = output(); expect(await evalsCommand(["effort", "scout"], { home, budget: "10", json: true }, invalid.io, { runEffort: async () => { calls++; return {} as never; } })).toBe(2);
    const missing = output(); expect(await evalsCommand(["effort", "judge"], { home, json: true }, missing.io, { runEffort: async () => { calls++; return {} as never; } })).toBe(2);
    expect(calls).toBe(0);

    const captured = output();
    expect(await evalsCommand(["effort", "judge"], { home, budget: "100", rounds: "1", json: true }, captured.io, {
      effort: {} as never,
      runEffort: async (_home, _cfg, target, options) => { calls++; return { version: 1, target, budgetUsd: options.budgetUsd, verdict: "ok", cells: [], spentUsd: 0 } as never; },
    })).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(captured.out.join(""))).toMatchObject({ target: "judge", budgetUsd: 100, verdict: "ok" });

    const joint = output();
    expect(await evalsCommand(["effort", "brain"], { home, budget: "100", levels: "low,medium", json: true }, joint.io, {
      effort: {} as never,
      runEffort: async (_home, _cfg, target) => ({ version: 1, target, budgetUsd: 100, verdict: "ok", cells: [], spentUsd: 0 }) as never,
    })).toBe(0);
    expect(JSON.parse(joint.out.join("")).target).toBe("generator+brain");
  });

  test("effort confirmation projects exactly the requested levels", async () => {
    const home = copiedHome(); const captured = output(); let calls = 0;
    expect(await evalsCommand(["effort", "judge"], { home, budget: "100", levels: "low,medium" }, { ...captured.io, ask: async () => "no" }, {
      runEffort: async () => { calls += 1; return {} as never; },
    })).toBe(0);
    expect(calls).toBe(0);
    expect(captured.out.join("")).toContain("$12.10");
    expect(captured.out.join("")).not.toContain("$24.20");
  });
});
