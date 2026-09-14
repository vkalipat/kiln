import type { StoredEvent } from "../core/events";

/** A bounded view of recorded executions, never a producer-authored evidence summary. */
export function formationExecutionEvidence(events: readonly StoredEvent[]): string {
  const executions = events.filter((event) => event.t === "tool.call" && event.name === "bash");
  const entries: unknown[] = [];
  let chars = 0;
  for (const event of executions.slice(-8).reverse()) {
    if (event.t !== "tool.call") continue;
    const metadata = event as typeof event & {
      resultChars?: number;
      excerptTruncated?: boolean;
      process?: { exitCode: number | null; signal?: string | null; timedOut: boolean; cancelled: boolean; outputTruncated?: boolean };
    };
    const args = event.args as { command?: unknown } | null;
    const command = typeof args?.command === "string" ? args.command : "";
    const entry = {
      seq: event.seq, timestamp: event.ts,
      command: command.slice(0, 2000), commandTruncated: command.length > 2000,
      toolOk: event.ok, durationMs: event.durationMs,
      process: metadata.process ?? null,
      excerpt: event.excerpt.slice(0, 1000),
      resultChars: metadata.resultChars ?? null,
      outputCompleteness: metadata.excerptTruncated || metadata.process?.outputTruncated || event.excerpt.length > 1000 ? "truncated"
        : metadata.excerptTruncated === false && metadata.process?.outputTruncated === false ? "complete" : "unknown (legacy record)",
    };
    const size = JSON.stringify(entry).length;
    if (chars + size > 12000) continue;
    chars += size;
    entries.unshift(entry);
  }
  return JSON.stringify({ recordedExecutions: executions.length, omittedExecutions: executions.length - entries.length, entries });
}
