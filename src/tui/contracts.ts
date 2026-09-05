/** UI-neutral data passed between the run controller and terminal renderers. */
export const TUI_PHASES = ["frame", "discover", "ideate", "form", "build", "reflect"] as const;
export type TuiPhase = (typeof TUI_PHASES)[number];
export type TuiRunState = "idle" | "running" | "paused" | "stopped" | "done" | "failed";
export type TuiEffort = "low" | "medium" | "high" | "ultra";
export type TuiConfigEffort = Exclude<TuiEffort, "ultra"> | "xhigh";
export type TuiToolStatus = "queued" | "running" | "done" | "error" | "cancelled" | "blocked";

export interface TuiTextEntry {
  id: string;
  kind: "user" | "brain" | "thinking";
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
}

export interface TuiToolEntry {
  id: string;
  kind: "tool";
  status: TuiToolStatus;
  verb: string;
  args?: string;
  body?: string | readonly string[];
  expanded?: boolean;
}

export interface TuiActivityEntry {
  id: string;
  kind: "activity";
  status: TuiToolStatus;
  label: string;
  detail?: string;
  actions: readonly Omit<TuiToolEntry, "kind">[];
  expanded?: boolean;
}

export interface TuiFrontierRow {
  id: string;
  value?: number;
  feasibility?: number;
  cell?: string;
  probe?: string;
}

export interface TuiTournamentEntry {
  id: string;
  kind: "tournament";
  judged: number;
  ties: number;
  frontier: readonly TuiFrontierRow[];
  expanded?: boolean;
}

export type TuiTranscriptEntry = TuiTextEntry | TuiToolEntry | TuiActivityEntry | TuiTournamentEntry;

export interface TuiCheckpointIdea extends TuiFrontierRow {
  title?: string;
  summary?: string;
}

export interface TuiCheckpointSnapshot {
  round: number;
  ideas: readonly TuiCheckpointIdea[];
  groups: readonly (readonly string[])[];
  groupIndex: number;
  valueLadder: readonly string[];
  feasibilityLadder: readonly string[];
}

export interface TuiSnapshot {
  runId?: string;
  phase: TuiPhase;
  state: TuiRunState;
  activity?: string;
  costUsd: number;
  directory: string;
  branch?: string;
  effort: TuiEffort;
  transcript: readonly TuiTranscriptEntry[];
  checkpoint?: TuiCheckpointSnapshot;
  /** Local credential state only; computing it never refreshes a token or contacts a provider. */
  auth?: { required: boolean; configured: readonly string[] };
}

export type TuiCheckpointAnswer =
  | { kind: "bws"; groupIndex: number; best: string; worst: string }
  | { kind: "pick"; id: string }
  | { kind: "reject"; id: string; reason: string }
  | { kind: "another_round"; steering: string };

export type TuiSendResult =
  | { status: "answered" }
  | { status: "delivered"; sourceIds: readonly string[] }
  | { status: "queued"; sendId: string };

export type TuiEvent =
  | { type: "snapshot"; snapshot: TuiSnapshot }
  | { type: "text"; entry: TuiTextEntry }
  | { type: "tool"; entry: TuiToolEntry | TuiActivityEntry | TuiTournamentEntry }
  | { type: "status"; phase: TuiPhase; state: TuiRunState; activity?: string; costUsd?: number }
  | { type: "checkpoint"; checkpoint: TuiCheckpointSnapshot }
  | { type: "input_requested"; prompt: string; secret: boolean }
  | { type: "input_cleared" }
  | { type: "steering_delivered"; sendId: string; text: string; sourceIds: readonly string[] }
  | { type: "cancelled"; phase: TuiPhase };

export type TuiEventListener = (event: TuiEvent) => void;

/** Controller seam. Implementations own persistence, phases, cancellation, and steering. */
export interface TuiControllerPort {
  getSnapshot(): Readonly<TuiSnapshot>;
  subscribe(listener: TuiEventListener): () => void;
  start(input: { seed?: string; runId?: string }): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(): Promise<void>;
  send(text: string): Promise<TuiSendResult>;
  setEffort(effort: TuiConfigEffort): Promise<void>;
  answerCheckpoint(answer: TuiCheckpointAnswer): Promise<void>;
  /** Optional generic palette dispatch; app-local commands need not burden phase controllers. */
  execute?(commandId: string, args?: readonly string[]): Promise<void>;
}
