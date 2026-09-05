import { createInterface } from "node:readline/promises";
import type { CliDeps, CliIo } from "../cli/main";

/** Read one non-secret answer through the embedding/TUI seam before touching process stdin. */
export async function askText(prompt: string, io: CliIo, deps: CliDeps): Promise<string> {
  if (io.ask) return io.ask(prompt);
  if (deps.stdin) return deps.stdin();
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return await input.question(prompt); }
  finally { input.close(); }
}

async function pipedLine(): Promise<string> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) return line;
    return "";
  } finally { input.close(); }
}

export async function readSecretStdin(deps: CliDeps): Promise<string> {
  if (deps.stdin) return deps.stdin();
  if (process.stdin.isTTY) throw new Error("--api-key-stdin expects a piped API key");
  return pipedLine();
}

/** Minimal raw-terminal reader: only bullets are rendered; the value never reaches argv or output. */
function maskedLine(prompt: string, io: CliIo, onCancel?: () => void): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return pipedLine();
  io.write(prompt);
  const wasRaw = stdin.isRaw; const wasPaused = stdin.isPaused();
  stdin.setRawMode(true);
  stdin.resume();
  let value = ""; let finished = false;
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      stdin.off("data", onData); stdin.off("end", onEnd); stdin.off("error", onError);
      stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) stdin.pause();
      io.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new Error("input ended before an API key was received"));
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer | string) => {
      const data = String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      for (const char of data) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\x03") { onCancel?.(); finish(new Error("input cancelled")); return; }
        if (char === "\x7f" || char === "\b") {
          if (value) { value = value.slice(0, -1); io.write("\b \b"); }
          continue;
        }
        if (char >= " " && char !== "\x7f") { value += char; io.write("•"); }
      }
    };
    stdin.on("data", onData); stdin.once("end", onEnd); stdin.once("error", onError);
  });
}

/** Secret answers are always routed through a secret-aware UI seam when one is present. */
export async function askSecret(prompt: string, io: CliIo, deps: CliDeps, onCancel?: () => void): Promise<string> {
  if (io.askSecret) return io.askSecret(prompt);
  if (deps.stdin) return deps.stdin();
  return maskedLine(prompt, io, onCancel);
}
