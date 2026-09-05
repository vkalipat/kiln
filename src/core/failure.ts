import { createHash } from "node:crypto";

export type FailureClass = "transient" | "verify" | "unsatisfiable" | "budget" | "deadline" | "integrity" | "policy" | "refusal";

export interface FailureStopDetails {
  type: string;
  category?: string | null;
}

export interface FailureInput {
  error?: unknown;
  status?: number;
  timedOut?: boolean;
  exitCode?: number | null;
  message?: string;
  stopDetails?: FailureStopDetails;
}

export function classifyFailure(i: FailureInput): FailureClass {
  const msg = (i.message ?? (i.error instanceof Error ? i.error.message : typeof i.error === "string" ? i.error : "")).toLowerCase();
  const name = i.error instanceof Error ? i.error.name : "";

  if (i.stopDetails?.type === "refusal" || i.stopDetails?.type === "sensitive") return "refusal";
  if (i.timedOut || name === "AbortError" || name === "TimeoutError" || /deadline|timed? ?out/.test(msg)) return "deadline";
  if (msg.startsWith("policy") || /outside allowed roots|permission denied by policy/.test(msg)) return "policy";
  if (/integrity|acceptance lock/.test(msg)) return "integrity";
  if (/budget exhausted|over budget|usd[_ -]?cap|dollar cap/.test(msg)) return "budget";
  if (/cannot be satisfied|unsatisfiable/.test(msg)) return "unsatisfiable";
  if (i.status === 429 || (i.status !== undefined && i.status >= 500)) return "transient";
  if (name === "TypeError" && /fetch failed|network|econn|socket/.test(msg)) return "transient";
  if (/rate limit|overloaded|econnreset|etimedout|enotfound|socket hang up/.test(msg)) return "transient";
  if (i.exitCode !== undefined && i.exitCode !== null && i.exitCode !== 0) return "verify";
  if (i.status !== undefined && i.status >= 400) return "verify";
  return "verify";
}

export class StallDetector {
  private last = "";
  private lastTool = "";
  private count = 0;

  constructor(private readonly limit = 3) {}

  observe(toolName: string, resultPreview: string): boolean {
    const fp = createHash("sha256").update(`${toolName}\0${resultPreview.slice(0, 200)}`).digest("hex");
    if (fp === this.last) {
      this.count += 1;
    } else {
      this.last = fp;
      this.lastTool = toolName;
      this.count = 1;
    }
    return this.count >= this.limit;
  }

  /** Evidence for the most recently observed fingerprint, available once observe has run. */
  get fingerprint(): string | undefined { return this.last || undefined; }
  get tool(): string | undefined { return this.lastTool || undefined; }
}
