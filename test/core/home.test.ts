import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureIgnored, homeProtectedDirs, initHome } from "../../src/core/home";
import { loadPrompt, PROMPT_FILES } from "../../src/brain/prompts";
import { defaultConfig, saveConfig } from "../../src/core/config";

const BUNDLED = join(import.meta.dir, "../..");
function preEvalsHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kiln-pre-evals-"));
  cpSync(join(BUNDLED, "prompts"), join(home, "prompts"), { recursive: true });
  cpSync(join(BUNDLED, "playbook"), join(home, "playbook"), { recursive: true });
  mkdirSync(join(home, "evolution"), { recursive: true });
  writeFileSync(join(home, "evolution", "deltas.jsonl"), "{\"legacy\":true}\n");
  writeFileSync(join(home, ".gitignore"), ["runs/", "auth.json", "evolution/candidates/", "evolution/work/", "evolution/evolve.lock", ""].join("\n"));
  saveConfig(home, defaultConfig());
  execFileSync("git", ["init", "-q"], { cwd: home });
  execFileSync("git", ["add", "-A", "--", "."], { cwd: home });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "-q", "-m", "legacy home"], { cwd: home });
  return home;
}

describe("initHome", () => {
  test("a new config never overwrites existing evolution history", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-history-preserved-"));
    mkdirSync(join(home, "evolution")); const path = join(home, "evolution", "deltas.jsonl");
    const journal = '{"seq":1,"source":"operator","reason":"existing local history"}\n';
    writeFileSync(path, journal); initHome(home);
    expect(readFileSync(path, "utf8")).toBe(journal);
  });

  test("the initial baseline does not absorb unrelated pre-staged files", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-baseline-scope-"));
    execFileSync("git", ["init", "-q"], { cwd: home });
    writeFileSync(join(home, "operator-note.md"), "already staged\n"); execFileSync("git", ["add", "operator-note.md"], { cwd: home });
    initHome(home);
    expect(execFileSync("git", ["ls-tree", "--name-only", "HEAD"], { cwd: home, encoding: "utf8" })).not.toContain("operator-note.md");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: home, encoding: "utf8" }).trim()).toBe("operator-note.md");
    expect(readFileSync(join(home, "operator-note.md"), "utf8")).toBe("already staged\n");
  });
  test("creates the layout once", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-"));
    expect(initHome(home).created).toBe(true);
    for (const p of [...PROMPT_FILES.map((name) => `prompts/${name}.md`), "prompts/blocks/B01.md", "prompts/blocks/B27.md", "playbook/playbook.md", "config.json", ".gitignore", "evals/seeds", "evals/manifest.json", "evolution/deltas.jsonl", "evolution/candidates", "runs"]) expect(existsSync(join(home, p))).toBe(true);
    const deltas = readFileSync(join(home, "evolution/deltas.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(deltas.map((entry) => entry.id)).toEqual(["B1", "B2", "B3", "FM1", "FM2"]);
    expect(deltas.every((entry) => entry.source === "operator" && entry.kind === "correction")).toBe(true);
    for (const name of PROMPT_FILES) expect(loadPrompt(home, name).trim().length).toBeGreaterThan(0);
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toBe([
      "runs/", "auth.json", "evolution/candidates/", "evolution/work/", "evolution/evolve.lock", "",
    ].join("\n"));
    expect(readFileSync(join(home, "playbook/playbook.md"), "utf8")).toMatch(/^## ideate$/m);
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: home, encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["config", "--local", "user.name"], { cwd: home, encoding: "utf8" }).trim()).toBe("kiln");
    expect(execFileSync("git", ["config", "--local", "user.email"], { cwd: home, encoding: "utf8" }).trim()).toBe("kiln@localhost");
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: home, encoding: "utf8" }).trim()).toBe("chore(home): initial commit");

    // A normal second startup is filesystem-only: removing Git from PATH would expose any spawn.
    const path = process.env.PATH;
    process.env.PATH = "";
    try { expect(initHome(home).created).toBe(false); }
    finally { process.env.PATH = path; }
  });

  test("appends missing ignore lines idempotently and exposes the protected home trees", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-ignored-"));
    writeFileSync(join(home, ".gitignore"), "custom/\nruns/\n");
    ensureIgnored(home, ["runs/", "evolution/work/", "evolution/evolve.lock"]);
    ensureIgnored(home, ["runs/", "evolution/work/", "evolution/evolve.lock"]);
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toBe("custom/\nruns/\nevolution/work/\nevolution/evolve.lock\n");
    expect(homeProtectedDirs(home)).toEqual(["evals", "evolution", "playbook", "prompts"].map((name) => join(home, name)));
  });

  test("does not restore deleted manifest-covered material on a later startup", () => {
    const home = mkdtempSync(join(tmpdir(), "kiln-drifted-")); initHome(home);
    const seed = join(home, "evals", "seeds", "dev", "dev-product-01.md");
    unlinkSync(seed);
    initHome(home);
    expect(existsSync(seed)).toBe(false);
  });

  test("adopts a genuinely absent eval corpus in one locally identified migration commit", () => {
    const home = preEvalsHome(); const journal = readFileSync(join(home, "evolution", "deltas.jsonl"), "utf8");
    expect(initHome(home).created).toBe(false);
    expect(existsSync(join(home, "evals", "manifest.json"))).toBe(true);
    expect(readFileSync(join(home, "evolution", "deltas.jsonl"), "utf8")).toBe(journal);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: home, encoding: "utf8" }).trim()).toBe("chore(home): install eval corpus");
    expect(execFileSync("git", ["log", "-1", "--format=%(trailers:key=Kiln-Operation,valueonly)"], { cwd: home, encoding: "utf8" }).trim()).toBe("home-evals-corpus-v1");
    expect(execFileSync("git", ["config", "--local", "user.name"], { cwd: home, encoding: "utf8" }).trim()).toBe("kiln");
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: home, encoding: "utf8" })).toBe("");
    const path = process.env.PATH; process.env.PATH = "";
    try { expect(initHome(home).created).toBe(false); }
    finally { process.env.PATH = path; }
  });

  test("resumes only a marked partial corpus and leaves an unmarked partial corpus untouched", () => {
    const resumable = preEvalsHome(); const marker = join(resumable, "evolution", "work", "home-evals-corpus-v1.json");
    mkdirSync(join(marker, ".."), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ version: 1, operationId: "home-evals-corpus-v1" }, null, 2)}\n`);
    mkdirSync(join(resumable, "evals"), { recursive: true });
    cpSync(join(BUNDLED, "evals", "README.md"), join(resumable, "evals", "README.md"));
    initHome(resumable);
    expect(existsSync(marker)).toBe(false); expect(existsSync(join(resumable, "evals", "manifest.json"))).toBe(true);

    const partial = preEvalsHome(); mkdirSync(join(partial, "evals"), { recursive: true });
    writeFileSync(join(partial, "evals", "local.txt"), "operator-owned\n"); initHome(partial);
    expect(readFileSync(join(partial, "evals", "local.txt"), "utf8")).toBe("operator-owned\n");
    expect(existsSync(join(partial, "evals", "manifest.json"))).toBe(false);
  });
});
