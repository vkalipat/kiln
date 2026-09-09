import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("executable shutdown flushes output and exits despite an idle SDK-like resource", async () => {
  const entry = resolve(import.meta.dir, "../../src/cli/exit.ts");
  const child = Bun.spawn([process.execPath, "-e", `import {finishProcess} from ${JSON.stringify(entry)};setInterval(()=>{},60000);process.stdout.write("durable-summary\\n");process.stderr.write("diagnostic\\n");await finishProcess(3);`], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 3000);
  try {
    expect(await child.exited).toBe(3);
    expect(await new Response(child.stdout).text()).toBe("durable-summary\n");
    expect(await new Response(child.stderr).text()).toBe("diagnostic\n");
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
}, 5000);
