import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { RecordEvent, StoredEvent } from "./events";
import { appendLine } from "./paths";

export * from "./events";

export function excerpt(text: string, head = 40, tail = 40): { text: string; omitted: number } {
  const lines = text.split("\n");
  if (lines.length <= head + tail) return { text, omitted: 0 };
  const omitted = lines.length - head - tail;
  return { text: [...lines.slice(0, head), `... [${omitted} lines omitted] ...`, ...lines.slice(lines.length - tail)].join("\n"), omitted };
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export function hashInput(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/**
 * Append-only JSONL journal. A crash mid-append can leave a torn final line, and a torn line must
 * never make the whole run unreadable: unparseable lines are skipped and counted, and `seq` picks
 * up one past the *last parseable* line's own `seq` (not past the raw line count), so a resumed run
 * never reuses a sequence number that already reached disk.
 */
export class RunRecord {
  private seq = 0;
  private corruptCount = 0;
  /** Running total, so per-call budget checks never re-read the journal. */
  private total = 0;
  constructor(readonly path: string) {
    if (existsSync(path)) {
      const { events, corrupt } = this.readWithDiagnostics();
      this.corruptCount = corrupt.length;
      const last = events.at(-1);
      this.seq = typeof last?.seq === "number" ? last.seq : events.length;
    }
  }
  /** How many unparseable lines the last read skipped. */
  get corrupt(): number { return this.corruptCount; }
  append(e: RecordEvent): number {
    this.seq += 1;
    if (e.t === "model.call" && Number.isFinite(e.costUsd)) this.total += e.costUsd;
    appendLine(this.path, JSON.stringify({ seq: this.seq, ts: new Date().toISOString(), ...e }));
    return this.seq;
  }
  read(): StoredEvent[] { return this.readWithDiagnostics().events; }
  readWithDiagnostics(): { events: StoredEvent[]; corrupt: string[] } {
    if (!existsSync(this.path)) return { events: [], corrupt: [] };
    const events: StoredEvent[] = [];
    const corrupt: string[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        corrupt.push(line);
      }
    }
    this.corruptCount = corrupt.length;
    // Re-reading is the moment the file is authoritative again (construction, resume, another
    // writer), so the running total is recomputed from what actually parsed. Torn lines carry no
    // cost by definition — they never parsed — so they are simply not counted.
    this.total = events.reduce((s, e) => s + (e.t === "model.call" && Number.isFinite(e.costUsd) ? e.costUsd : 0), 0);
    return { events, corrupt };
  }
  /** O(1): the total is maintained on `append` and refreshed whenever the journal is read. */
  costUsd(): number { return this.total; }
}
