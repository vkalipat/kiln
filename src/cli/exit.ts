/** Executable-only shutdown. Library main() remains composable and never exits its host. */
export async function finishProcess(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) { resolve(); return; }
    try { stream.write("", () => resolve()); } catch { resolve(); }
  })));
  // All run work has been awaited and durable journals are synchronous. Provider SDKs retain
  // process-wide transport resources with no public disposer; they must not keep a CLI job alive.
  process.exit(code);
}
