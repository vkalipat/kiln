import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRun } from "../../src/core/run";
import { RunRecord } from "../../src/core/record";
import { BUILDER_TOOL_NAMES, PHASE_TOOLS, SCOUT_TOOL_NAMES, brainTools, scoutTools, type ToolContext } from "../../src/brain/tools";
import type { Phase } from "../../src/core/config";
import { clampTimeoutMs } from "../../src/brain/tools/bash";
import { Limiter } from "../../src/core/limiter";
import { RunCancelledError, RunControl, withRunControl } from "../../src/core/run-control";

function ctx(extra: Partial<ToolContext> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kiln-"));
  const run = createRun(home, "seed");
  const cwd = mkdtempSync(join(tmpdir(), "kiln-cwd-"));
  const record = new RunRecord(run.record);
  const c: ToolContext = { cwd, roots: [cwd, run.dir], run, record, ...extra };
  const tools = Object.fromEntries(brainTools(c, "discover").map((t) => [t.name, t]));
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const r = await tools[name]!.execute("id", args as never, signal as never);
    return { text: (r.content[0] as { text: string }).text, isError: r.isError === true };
  };
  return { c, cwd, run, record, call };
}

describe("tools", () => {
  test("a pre-cancelled run never dispatches a recorded side-effecting tool", async () => {
    const { call, cwd, record } = ctx();
    const path = join(cwd, "must-not-exist.txt");
    const control = new RunControl();
    control.cancel("before tool dispatch");
    await expect(withRunControl(control, () => call("write", { path, content: "no" }))).rejects.toBeInstanceOf(RunCancelledError);
    expect(existsSync(path)).toBe(false);
    expect(record.read().some((event) => event.t === "tool.call")).toBe(false);
  });

  test("tool sets have the documented names", () => {
    const { c } = ctx();
    expect(brainTools(c, "discover").map((t) => t.name)).toEqual(["read", "write", "edit", "bash", "search", "web_search", "web_fetch", "scout", "note", "exit"]);
    expect(scoutTools(c).map((t) => t.name)).toEqual(["read", "search", "web_search", "web_fetch", "scholar_search"]);
    for (const t of brainTools(c, "discover")) { expect(t.description.length).toBeLessThan(300); expect(t.examples?.length).toBe(1); }
  });

  test("the phase allowlist follows the record: no bash in ideate, probe_request only there, scout in discover and ideate", () => {
    const { c } = ctx();
    const names = (p: Phase) => brainTools(c, p).map((t) => t.name);
    expect(names("ideate")).not.toContain("bash");
    expect(names("frame")).toContain("bash");
    expect(names("form")).toContain("bash");
    expect(names("build")).toContain("bash");
    expect(names("frame")).not.toContain("scout");
    expect(names("discover")).toContain("scout");
    expect(names("ideate")).toContain("scout");
    for (const p of ["frame", "discover", "ideate", "form", "build", "reflect"] as Phase[]) expect(PHASE_TOOLS[p].filter((n) => n === "probe_request").length).toBe(p === "ideate" ? 1 : 0);
    expect(SCOUT_TOOL_NAMES).toContain("scholar_search");
    expect(BUILDER_TOOL_NAMES).toEqual(["read", "write", "edit", "bash", "search", "exit"]);
    expect(PHASE_TOOLS.build).toBe(BUILDER_TOOL_NAMES);
    // Tools whose factories arrive in a later task are reserved by name and simply absent for now.
    expect(names("ideate")).toContain("probe_request");
  });
  test("write, read, edit round trip and record events", async () => {
    const { call, cwd, record } = ctx();
    expect((await call("write", { path: join(cwd, "a.txt"), content: "one\ntwo\n" })).isError).toBe(false);
    expect((await call("read", { path: join(cwd, "a.txt") })).text).toBe("1: one\n2: two");
    expect((await call("edit", { path: join(cwd, "a.txt"), old: "two", new: "2" })).isError).toBe(false);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n2\n");
    const r = await call("edit", { path: join(cwd, "a.txt"), old: "zzz", new: "y" });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/0 match/);
    expect(record.read().filter((e) => e.t === "tool.call").length).toBe(4);
  });
  test("write outside roots is a policy error", async () => {
    const { call, record } = ctx();
    const r = await call("write", { path: "/tmp/../etc/kiln-should-not-exist", content: "x" });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/policy/);
    expect(record.read().some((e) => e.t === "failure" && e.class === "policy")).toBe(true);
  });
  test("bash captures exit code and stdout", async () => {
    // Generous budget: this only needs to outlast a real `sh` spawn, run, and
    // pipe-drain under full-suite CPU contention — 300ms was tight enough
    // that a loaded machine could blow past it before the process even
    // finished, killing it and turning `exit 2` into a spurious deadline.
    const { call } = ctx({ bashTimeoutMs: 10_000 });
    expect((await call("bash", { command: "echo hi; exit 2" })).text).toMatch(/^exit 2\nhi/);
  });
  test("bash kills a command that overruns its deadline and reports it", async () => {
    // Short budget on purpose: sleep 5 always exceeds 300ms, load or no load,
    // so this is the assertion a tight deadline is meant to prove.
    const { call } = ctx({ bashTimeoutMs: 300 });
    expect((await call("bash", { command: "sleep 5" })).text).toMatch(/deadline/);
  });
  test("bash forwards caller cancellation to the child process", async () => {
    const { call } = ctx({ bashTimeoutMs: 10_000 });
    const controller = new AbortController();
    const t0 = Date.now();
    const pending = call("bash", { command: "trap '' TERM; while :; do sleep 1; done" }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^cancelled: command stopped/);
    expect(result.text).not.toMatch(/deadline/);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
  test("search finds lines and skips node_modules", async () => {
    const { call, cwd } = ctx();
    writeFileSync(join(cwd, "x.ts"), "const needle = 1;\n");
    const nm = join(cwd, "node_modules"); require("node:fs").mkdirSync(nm); writeFileSync(join(nm, "y.ts"), "needle\n");
    const r = await call("search", { pattern: "needle", path: cwd });
    expect(r.text).toMatch(/x\.ts:1: const needle/); expect(r.text).not.toMatch(/node_modules/);
  });
  test("long results are shaped with a full-output path", async () => {
    const { call, cwd, run } = ctx();
    writeFileSync(join(cwd, "big.txt"), Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
    const r = await call("read", { path: join(cwd, "big.txt"), limit: 500 });
    expect(r.text).toMatch(/lines omitted/); expect(r.text).toMatch(new RegExp(run.toolOutputDir));
    expect(existsSync(run.toolOutputDir)).toBe(true);
  });
  test("web_search parses duckduckgo html through injected fetch", async () => {
    const html = `<a class="result__a" href="https://example.com/a">Example A</a><a class="result__snippet">Snippet A</a>`;
    const { call } = ctx({ fetchImpl: (async () => new Response(html)) as unknown as typeof fetch });
    const r = await call("web_search", { query: "x" });
    expect(r.text).toContain("Example A — https://example.com/a"); expect(r.text).toContain("Snippet A");
  });

  test("network searches use their own limiter rather than the model-work gate", async () => {
    let active = 0; let high = 0;
    const fetchImpl = (async () => {
      active += 1; high = Math.max(high, active);
      await Bun.sleep(5); active -= 1;
      return new Response('<a class="result__a" href="https://example.com">x</a>');
    }) as unknown as typeof fetch;
    const { call } = ctx({ fetchImpl, searchLimiter: new Limiter(2), searchJitterMs: 0 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => call("web_search", { query: `q${i}` })));
    expect(high).toBe(2);
  });
  test("web_fetch strips tags", async () => {
    const { call } = ctx({ fetchImpl: (async () => new Response("<html><script>x()</script><body><h1>Hi</h1><p>there</p></body></html>")) as unknown as typeof fetch });
    expect((await call("web_fetch", { url: "https://e.com" })).text).toBe("Hi there");
  });
  test("note appends and exit records", async () => {
    const exits: string[] = [];
    const { call, run, record } = ctx({ onExit: (k) => exits.push(k) });
    await call("note", { text: "remember" });
    expect(readFileSync(run.notes, "utf8")).toMatch(/remember/);
    await call("exit", { kind: "underspecified", reasons: ["no domain"] });
    expect(exits).toEqual(["underspecified"]);
    expect(record.read().some((e) => e.t === "honest_exit" && e.kind === "underspecified" && e.source === "declared")).toBe(true);
    expect((await call("exit", { kind: "bogus", reasons: [] })).isError).toBe(true);
  });
  test("a disallowed phase exit is a policy failure and does not fire onExit", async () => {
    const exits: string[] = [];
    const { call, record } = ctx({ allowedExitKinds: ["not_formable"], onExit: (kind) => exits.push(kind) });
    const refused = await call("exit", { kind: "cannot_be_satisfied", reasons: ["wrong phase"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("policy");
    expect(exits).toEqual([]);
    expect(record.read().some((event) => event.t === "honest_exit")).toBe(false);
    expect(record.read().some((event) => event.t === "failure" && event.class === "policy")).toBe(true);
    expect((await call("exit", { kind: "not_formable", reasons: ["critique failed"] })).isError).toBe(false);
    expect(exits).toEqual(["not_formable"]);
  });
  test("scout delegates and caps length", async () => {
    const { call } = ctx({ spawnScout: async (q) => `${q}:` + "x".repeat(10_000) });
    const r = await call("scout", { question: "q" });
    expect(r.text.length).toBeLessThanOrEqual(6000);
  });
  test("web_search unwraps duckduckgo redirect hrefs", async () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1&rut=abc">Example</a><a class="result__snippet">Snip</a>`;
    const { call } = ctx({ fetchImpl: (async () => new Response(html)) as unknown as typeof fetch });
    const r = await call("web_search", { query: "x" });
    expect(r.text).toContain("Example — https://example.com/path?q=1");
  });
  test("write through a symlink that leaves the roots is a policy error", async () => {
    const { call, cwd, record } = ctx();
    const outside = mkdtempSync(join(tmpdir(), "kiln-outside-"));
    symlinkSync(outside, join(cwd, "escape"));
    const r = await call("write", { path: join(cwd, "escape", "x.txt"), content: "x" });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/policy/);
    expect(record.read().some((e) => e.t === "failure" && e.class === "policy")).toBe(true);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });
  test("write creates missing parents inside an allowed root", async () => {
    const { call, cwd } = ctx();
    const target = join(cwd, "deep", "nested", "b.txt");
    expect((await call("write", { path: target, content: "hi" })).isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("hi");
  });

  test("bash does not hand secret env vars to the shell", async () => {
    process.env.FAKE_API_KEY = "super-secret-value";
    process.env.KILN_TEST_HARMLESS = "harmless-value";
    try {
      const { call } = ctx();
      const r = await call("bash", { command: "echo [$FAKE_API_KEY][$KILN_TEST_HARMLESS]" });
      expect(r.text).toBe("exit 0\n[][harmless-value]\n"); // the key is unset; ordinary vars survive
      // Asserted as a boolean on purpose: a failing `toContain` would print the whole environment.
      const dump = await call("bash", { command: "env" });
      expect(dump.text.includes("super-secret-value")).toBe(false);
      expect(dump.text.includes("FAKE_API_KEY")).toBe(false);
    } finally {
      delete process.env.FAKE_API_KEY;
      delete process.env.KILN_TEST_HARMLESS;
    }
  });
  test("bash clamps an absurd timeout to the 600s ceiling", () => {
    expect(clampTimeoutMs(100_000)).toBe(600_000);
    expect(clampTimeoutMs(30)).toBe(30_000);
    expect(clampTimeoutMs(0)).toBe(1_000);
  });

  test("a token in tool args is redacted in the record", async () => {
    const { call, record } = ctx();
    await call("note", { text: "the key is sk-ant-oat01-abcdefghijklmnop, keep it" });
    const e = record.read().find((x) => x.t === "tool.call");
    const args = JSON.stringify(e && e.t === "tool.call" ? e.args : {});
    expect(args).not.toContain("sk-ant-oat01-abcdefghijklmnop");
    expect(args).toContain("[REDACTED]");
  });
  test("a secret env value in a tool result excerpt is redacted in the record", async () => {
    process.env.FAKE_API_KEY = "super-secret-value";
    try {
      const { call, cwd, record } = ctx();
      writeFileSync(join(cwd, "leak.txt"), "config: super-secret-value\n");
      const r = await call("read", { path: join(cwd, "leak.txt") });
      expect(r.text).toContain("super-secret-value"); // the model still sees the file it asked for
      const e = record.read().find((x) => x.t === "tool.call" && x.name === "read");
      expect(e && e.t === "tool.call" ? e.excerpt : "").not.toContain("super-secret-value");
      expect(e && e.t === "tool.call" ? e.excerpt : "").toContain("[REDACTED]");
    } finally {
      delete process.env.FAKE_API_KEY;
    }
  });

  test("writing the run's own state files is a policy refusal", async () => {
    const { call, run, record } = ctx();
    for (const p of [run.record, run.status, run.features, run.acceptanceLock, run.featureState, join(run.toolOutputDir, "0001-read.txt")]) {
      const r = await call("write", { path: p, content: "x" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/policy/);
    }
    expect(record.read().filter((e) => e.t === "failure" && e.class === "policy").length).toBe(6);
    expect(readFileSync(run.status, "utf8")).toContain('"id"');
  });
  test("caller-supplied protected files and directories are refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiln-protected-"));
    const file = join(root, "project.json");
    const dir = join(root, "checks");
    const { call } = ctx({ roots: [root], protectedPaths: [file], protectedDirs: [dir] });
    expect((await call("write", { path: file, content: "x" })).isError).toBe(true);
    expect((await call("write", { path: join(dir, "check.txt"), content: "x" })).isError).toBe(true);
    expect((await call("write", { path: join(root, "spec.md"), content: "ok" })).isError).toBe(false);
  });
  test("home-owned trees stay protected when a phase widens its writable root", async () => {
    const seeded = ctx();
    const home = dirname(dirname(seeded.run.dir));
    const { call } = ctx({ roots: [home], run: seeded.run, record: seeded.record, cwd: home });
    for (const dir of ["evals", "evolution", "playbook", "prompts"]) {
      expect((await call("write", { path: join(home, dir, "attempt.txt"), content: "x" })).isError).toBe(true);
      expect(existsSync(join(home, dir, "attempt.txt"))).toBe(false);
    }
    expect((await call("write", { path: join(home, "ordinary.txt"), content: "ok" })).isError).toBe(false);
  });
  test("editing the run record is a policy refusal", async () => {
    const { call, run } = ctx();
    const r = await call("edit", { path: run.record, old: "a", new: "b" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/policy/);
  });
  test("writing other files inside the run directory still works", async () => {
    const { call, run } = ctx();
    expect((await call("write", { path: run.brief, content: "# Brief\n" })).isError).toBe(false);
    expect(readFileSync(run.brief, "utf8")).toBe("# Brief\n");
  });

  test("web_fetch gives up at its own timeout when the server never answers", async () => {
    const hang = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted by signal")));
      })) as unknown as typeof fetch;
    const { call } = ctx({ fetchImpl: hang, webTimeoutMs: 50 });
    const r = await call("web_fetch", { url: "https://slow.example" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/web_fetch failed/);
  });
  test("web_search aborts when the caller's signal is already aborted", async () => {
    const hang = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted by signal")));
      })) as unknown as typeof fetch;
    const { call } = ctx({ fetchImpl: hang, webTimeoutMs: 30_000 });
    const r = await call("web_search", { query: "x" }, AbortSignal.abort());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/search failed \(failed\)/);
  });
  test("search stops scanning when the signal is aborted and says so", async () => {
    const { call, cwd } = ctx();
    writeFileSync(join(cwd, "x.ts"), "const needle = 1;\n");
    const r = await call("search", { pattern: "needle", path: cwd }, AbortSignal.abort());
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/cancelled/);
  });

  test("every harness-owned ideate artifact is protected from write and edit", async () => {
    const { call, run } = ctx({ protectedIdeas: new Set(["r1-i0-1"]) });
    const owned = [
      run.tournament,
      run.frontier,
      run.metrics,
      join(run.criteriaDir, "c1.md"),
      join(run.renderedDir, "r1-i0-1-r1.md"),
      join(run.rawIdeasDir, "r1-i0.md"),
      join(run.ideasDir, "r1-i0-1.evidence.json"),
      join(run.ideasDir, "r1-i0-1.md"),
    ];
    for (const p of owned) {
      const w = await call("write", { path: p, content: "x" });
      expect(w.isError).toBe(true);
      expect(w.text).toMatch(/policy/);
      const e = await call("edit", { path: p, old: "a", new: "b" });
      expect(e.isError).toBe(true);
      expect(e.text).toMatch(/policy/);
    }
  });

  test("an idea file the archive has not inserted is still writable", async () => {
    const { call, run } = ctx({ protectedIdeas: new Set(["r1-i0-1"]) });
    const fresh = join(run.ideasDir, "r1-i0-2.md");
    expect((await call("write", { path: fresh, content: "# Idea\n" })).isError).toBe(false);
    expect(readFileSync(fresh, "utf8")).toBe("# Idea\n");
  });

  test("web_search reports blocked when the page is a challenge and records search health", async () => {
    const { call, record } = ctx({ fetchImpl: (async () => new Response("<html><body>Please solve this CAPTCHA to continue</body></html>")) as unknown as typeof fetch });
    const r = await call("web_search", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("search failed (blocked)");
    expect(record.read().some((e) => e.t === "search.health" && e.tool === "web_search" && e.status === "blocked")).toBe(true);
  });

  test("web_search reports ok with a note when the page simply has no results", async () => {
    const { call, record } = ctx({ fetchImpl: (async () => new Response("<html><body>No results found for that query.</body></html>")) as unknown as typeof fetch });
    const r = await call("web_search", { query: "x" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("no results");
    expect(r.text).not.toContain("search failed");
    expect(record.read().some((e) => e.t === "search.health" && e.status === "ok")).toBe(true);
  });

  test("web_search reports failed on an HTTP error and on a network error", async () => {
    const { call, record } = ctx({ fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch });
    const r = await call("web_search", { query: "x" });
    expect(r.text).toContain("search failed (failed)");
    const boom = ctx({ fetchImpl: (async () => { throw new Error("econnreset"); }) as unknown as typeof fetch });
    const r2 = await boom.call("web_search", { query: "x" });
    expect(r2.text).toContain("search failed (failed)");
    expect(record.read().filter((e) => e.t === "search.health" && e.status === "failed").length).toBe(1);
  });

  test("web_search reports blocked on an HTTP 403", async () => {
    const { call } = ctx({ fetchImpl: (async () => new Response("go away", { status: 403 })) as unknown as typeof fetch });
    expect((await call("web_search", { query: "x" })).text).toContain("search failed (blocked)");
  });
});
