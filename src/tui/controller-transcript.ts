import type { StoredEvent } from "../core/record";
import type { RunControlEvent } from "../core/run-control";
import type { TuiTextEntry, TuiToolEntry, TuiTranscriptEntry } from "./contracts";

export type TranscriptChange =
  | { type: "text"; entry: TuiTextEntry }
  | { type: "tool"; entry: TuiToolEntry };

function printable(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function restoredEntry(event: StoredEvent): TuiTranscriptEntry | undefined {
  const id = `record:${event.seq}`;
  if (event.t === "run.created") return { id, kind: "user", text: event.seed };
  if (event.t === "model.call") {
    const error = event.error ? `\n[${event.error}]` : "";
    return { id, kind: "brain", text: `[record excerpt · ${event.role}]\n${event.excerpt}${error}` };
  }
  if (event.t === "tool.call") {
    return {
      id,
      kind: "tool",
      status: event.ok ? "done" : "error",
      verb: event.name,
      args: printable(event.args),
      body: event.excerpt,
    };
  }
  if (event.t === "note") return { id, kind: "brain", text: `[record note]\n${event.text}` };
  if (event.t === "checkpoint.decision") {
    const detail = event.id ?? event.reason ?? event.steering ?? "";
    return { id, kind: "brain", text: `[record checkpoint] ${event.kind}${detail ? ` · ${detail}` : ""}` };
  }
  if (event.t === "failure") return { id, kind: "brain", text: `[record failure · ${event.class}] ${event.message}` };
  return undefined;
}

/** Restore only bounded durable excerpts. A JSONL record is not a lossless chat transcript. */
export function restoredTranscript(runId: string, events: readonly StoredEvent[], limit = 24): TuiTranscriptEntry[] {
  const restored = events.flatMap((event) => {
    const entry = restoredEntry(event);
    return entry ? [entry] : [];
  }).slice(-Math.max(0, limit));
  return [
    {
      id: `attach:${runId}`,
      kind: "brain",
      text: `Attached to run ${runId}. Showing bounded durable record excerpts; this is not a full transcript replay.`,
    },
    ...restored,
  ];
}

/** Correlates streaming deltas and tool calls without relying on non-unique display names. */
export class ControllerTranscript {
  #entries: TuiTranscriptEntry[] = [];
  readonly #textBySource = new Map<string, string>();
  readonly #toolByCall = new Map<string, string>();
  #sequence = 0;

  get entries(): readonly TuiTranscriptEntry[] {
    return this.#entries;
  }

  restore(entries: readonly TuiTranscriptEntry[]): void {
    this.#entries = [...entries];
    this.#textBySource.clear();
    this.#toolByCall.clear();
  }

  appendUser(text: string): TuiTextEntry {
    const entry: TuiTextEntry = { id: `user:${++this.#sequence}`, kind: "user", text };
    this.#entries = [...this.#entries, entry];
    return entry;
  }

  appendBrain(text: string): TuiTextEntry {
    const entry: TuiTextEntry = { id: `controller:${++this.#sequence}`, kind: "brain", text };
    this.#entries = [...this.#entries, entry];
    return entry;
  }

  consume(event: RunControlEvent): TranscriptChange {
    if (event.type === "text") {
      const existingId = this.#textBySource.get(event.sourceId);
      if (existingId) {
        const current = this.#entries.find((entry): entry is TuiTextEntry => entry.id === existingId && entry.kind !== "tool" && entry.kind !== "activity" && entry.kind !== "tournament");
        const entry: TuiTextEntry = {
          id: existingId,
          kind: "brain",
          text: `${current?.text ?? ""}${event.text}`,
          streaming: true,
        };
        this.#replace(existingId, entry);
        return { type: "text", entry };
      }
      const entry: TuiTextEntry = {
        id: `source:${event.sourceId}`,
        kind: "brain",
        text: event.text,
        streaming: true,
      };
      this.#textBySource.set(event.sourceId, entry.id);
      this.#entries = [...this.#entries, entry];
      return { type: "text", entry };
    }

    const correlation = `${event.sourceId}\0${event.toolCallId}`;
    const existingId = this.#toolByCall.get(correlation);
    const id = existingId ?? `tool:${event.sourceId}:${event.toolCallId}`;
    const prior = existingId
      ? this.#entries.find((entry): entry is TuiToolEntry => entry.id === existingId && entry.kind === "tool")
      : undefined;
    const entry: TuiToolEntry = event.type === "tool_start"
      ? { id, kind: "tool", status: "running", verb: event.name, args: printable(event.args) }
      : {
          id,
          kind: "tool",
          status: event.ok ? "done" : "error",
          verb: event.name,
          args: prior?.args,
          ...(event.text === undefined ? {} : { body: event.text }),
        };
    if (existingId) this.#replace(existingId, entry);
    else {
      this.#toolByCall.set(correlation, id);
      this.#entries = [...this.#entries, entry];
    }
    return { type: "tool", entry };
  }

  finalize(interrupted: boolean): TranscriptChange[] {
    const changes: TranscriptChange[] = [];
    this.#entries = this.#entries.map((entry) => {
      if ((entry.kind === "brain" || entry.kind === "thinking") && entry.streaming) {
        const next = { ...entry, streaming: false, ...(interrupted ? { interrupted: true } : {}) };
        changes.push({ type: "text", entry: next });
        return next;
      }
      if (entry.kind === "tool" && entry.status === "running") {
        const next = { ...entry, status: interrupted ? "cancelled" as const : "error" as const };
        changes.push({ type: "tool", entry: next });
        return next;
      }
      return entry;
    });
    return changes;
  }

  #replace(id: string, replacement: TuiTranscriptEntry): void {
    this.#entries = this.#entries.map((entry) => entry.id === id ? replacement : entry);
  }
}
