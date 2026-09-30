import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { initHome } from "../../src/core/home";
import { AuthStore } from "../../src/providers/auth";
import { createOperatorRuntime } from "../../src/operator/runtime";
import type { OmpSessionOptions, OmpSessionHandle } from "../../src/operator/session";

test("native operator registers scoped team handoffs and preserves parent-reviewed evidence on resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "kiln-team-runtime-"));
  initHome(home, { plugAndPlay: true });
  const auth = new AuthStore(join(home, "auth.json"));
  auth.setApiKey("anthropic", "synthetic-test-key");
  let tool: any;
  const factory = async (options: OmpSessionOptions): Promise<OmpSessionHandle> => {
    options.extensions![0]!({ zod: z, registerTool(value: any) { if (value.name === "team") tool = value; }, on() {} } as never);
    return { sessionId: "parent-session", sessionFile: join(home, "test-session.jsonl"), connectedProviders: ["anthropic"],
      session: { async prompt() {}, async abort() {} } as never, sdk: {} as never,
      async awaitSettled() {}, async dispose() {} };
  };
  const invoke = (session: string, args: unknown) => tool.execute("test", args, undefined, undefined,
    { sessionManager: { getSessionId: () => session } });
  let runtime: Awaited<ReturnType<typeof createOperatorRuntime>> | undefined;
  try {
    runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, seed: "Build a scoped parser feature", auth, createSession: factory });
    expect(await runtime.prompt("Build a scoped parser feature")).toMatchObject({ stopped: "completed" });
    expect(tool).toBeDefined();
    await invoke("parent-session", { action: "plan", expectedRevision: 0, plans: [{ id: "parser", objective: "Ship parser behavior",
      scopes: ["parser.txt"], dependencies: [], acceptance: ["Parser artifact matches the checked fixture"] }] });
    await invoke("worker-session", { action: "claim", id: "parser", expectedRevision: 1 });
    writeFileSync(join(home, "parser.txt"), "checked fixture");
    const artifact = { path: "parser.txt", sha256: createHash("sha256").update("checked fixture").digest("hex") };
    await invoke("worker-session", { action: "handoff", id: "parser", expectedRevision: 2,
      summary: "Fixture created", checks: ["Worker compared fixture bytes"], artifacts: [artifact] });
    await expect(invoke("worker-session", { action: "accept", id: "parser", expectedRevision: 3,
      criteria: ["Matches"], artifacts: [artifact] })).rejects.toThrow("parent operator");
    expect(readFileSync(join(home, "parser.txt"), "utf8")).toBe("checked fixture");
    await invoke("parent-session", { action: "accept", id: "parser", expectedRevision: 3,
      criteria: ["Independently compared the exact fixture bytes"], artifacts: [artifact] });
    const runId = runtime.run.id;
    await runtime.dispose(); runtime = undefined;
    runtime = await createOperatorRuntime({ jev: { enabled: false }, home, cwd: home, runId, auth, createSession: factory });
    const stored = JSON.parse(readFileSync(join(runtime.run.dir, "team.json"), "utf8"));
    expect(stored.revision).toBe(4);
    expect(stored.features[0]).toMatchObject({ status: "accepted", owner: "worker-session",
      handoff: { status: "unverified_claim" }, review: { status: "parent_reviewed", reviewer: "parent-session" } });
    expect(readFileSync(runtime.run.record, "utf8")).toContain("operator.team");
  } finally { await runtime?.dispose(); rmSync(home, { recursive: true, force: true }); }
});
