import { createHash } from "node:crypto";

export const ARC2_PROVENANCE = {
  dataset: "ARC-AGI-2", split: "public evaluation", license: "Apache-2.0",
  sourceUrl: "https://github.com/arcprize/ARC-AGI-2",
  licenseUrl: "https://github.com/arcprize/ARC-AGI-2/blob/main/LICENSE",
  protocolUrl: "https://arcprize.org/policy",
  scoring: "pass@2; exact grids; every test input must be solved",
  condition: "Native tool-enabled public-subset pilot, not an official verified leaderboard score",
} as const;

export type ArcGrid = number[][];
export interface Arc2PublicTask {
  train: Array<{ input: ArcGrid; output: ArcGrid }>;
  test: Array<{ input: ArcGrid }>;
}
export interface Arc2Score {
  valid: boolean;
  solved: boolean;
  score: 0 | 1;
  testSolved: boolean[];
  error?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function grid(value: unknown, label: string): ArcGrid {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Error(`${label} must have 1–30 rows`);
  const width = Array.isArray(value[0]) ? value[0].length : 0;
  if (width < 1 || width > 30 || Array.from(value).some((row) => !Array.isArray(row) || row.length !== width
    || Array.from(row).some((cell) => !Number.isInteger(cell) || cell < 0 || cell > 9))) {
    throw new Error(`${label} must be rectangular, 1–30 columns, with integer cells 0–9`);
  }
  return value.map((row) => [...row]);
}
function pairs(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty array`);
  return Array.from(value, (pair, i) => object(pair, `${label}[${i}]`));
}

/** Explicit allowlist projection: test labels and all unknown/nested metadata stay controller-only. */
export function projectArc2Task(raw: unknown): Arc2PublicTask {
  const task = object(raw, "task");
  return {
    train: pairs(task.train, "train").map((pair, i) => ({
      input: grid(pair.input, `train[${i}].input`), output: grid(pair.output, `train[${i}].output`),
    })),
    test: pairs(task.test, "test").map((pair, i) => ({ input: grid(pair.input, `test[${i}].input`) })),
  };
}

/** The same serialized input and directive must be supplied to native and baseline arms. */
export function arc2Directive(raw: unknown): string {
  const task = projectArc2Task(raw);
  return [
    "Create answer.json in the output directory by solving the supplied grid transformation task.",
    "Infer the transformation from the demonstration pairs and apply it to each test input. You may use local code and tools to check your reasoning against the demonstrations. No external research or browsing.",
    "Write exactly this JSON structure: {\"predictions\":[{\"attempt_1\":[[0]],\"attempt_2\":[[0]]}]}.",
    `Replace the example grids with your predictions. Include exactly ${task.test.length} prediction row(s), in test-input order, with exactly two candidate grids per row. Candidates may be identical. No other fields or prose. Each grid must be rectangular, 1–30 rows/columns, with integer cells 0–9.`,
    "Do not request hidden answers or feedback on test predictions. Only demonstration outputs are available for checking. Deliver the file, not a proposal for solving the task.",
    JSON.stringify(task),
  ].join("\n\n");
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`${label} has missing or extra fields`);
}

/** Invalid controller data throws; invalid submissions fail the whole task without leaking labels. */
export function scoreArc2Answer(controllerTask: unknown, answer: unknown): Arc2Score {
  projectArc2Task(controllerTask);
  const task = object(controllerTask, "task");
  const labels = pairs(task.test, "test").map((pair, i) => grid(pair.output, `controller test[${i}].output`));
  const invalid = (error: string): Arc2Score => ({ valid: false, solved: false, score: 0, testSolved: labels.map(() => false), error });
  try {
    const parsed = typeof answer === "string" ? JSON.parse(answer) : answer;
    const submission = object(parsed, "answer");
    exactKeys(submission, ["predictions"], "answer");
    if (!Array.isArray(submission.predictions) || submission.predictions.length !== labels.length) {
      return invalid("predictions must contain exactly one entry per test input");
    }
    const predictions = Array.from(submission.predictions, (value, i) => {
      const row = object(value, `predictions[${i}]`);
      exactKeys(row, ["attempt_1", "attempt_2"], `predictions[${i}]`);
      return [grid(row.attempt_1, `predictions[${i}].attempt_1`), grid(row.attempt_2, `predictions[${i}].attempt_2`)];
    });
    const testSolved = labels.map((label, i) => predictions[i]!.some((attempt) => JSON.stringify(attempt) === JSON.stringify(label)));
    const solved = testSolved.every(Boolean);
    return { valid: true, solved, score: solved ? 1 : 0, testSolved };
  } catch {
    // JSON parser errors may quote submitted data; do not echo arbitrary payloads into results.
    return invalid("answer is malformed or violates the two-attempt grid schema");
  }
}

/** Denominator includes malformed and unsolved tasks; empty or corrupted result sets are errors. */
export function aggregateArc2Scores(results: readonly Arc2Score[]): { tasks: number; solved: number; accuracy: number } {
  if (results.length === 0) throw new Error("cannot score an empty task set");
  for (const result of results) {
    if (!result || typeof result.valid !== "boolean" || typeof result.solved !== "boolean"
      || (result.score !== 0 && result.score !== 1) || result.score !== Number(result.solved)
      || (!result.valid && result.solved) || !Array.isArray(result.testSolved) || result.testSolved.length === 0
      || Array.from(result.testSolved).some((value) => typeof value !== "boolean")
      || result.solved !== result.testSolved.every(Boolean)) throw new Error("invalid per-task score");
  }
  const solved = results.reduce((sum, result) => sum + result.score, 0);
  return { tasks: results.length, solved, accuracy: solved / results.length };
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** ID-only selection, before opening task contents. Caller freezes this manifest before loading data. */
export function selectArc2Tasks(ids: readonly string[], priorIds: readonly string[], count: number, seed: string) {
  if (!seed || !Number.isInteger(count) || count < 1) throw new Error("selection requires a seed and positive count");
  for (const id of [...ids, ...priorIds]) if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("invalid ARC task ID");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate candidate task ID");
  const excluded = [...new Set(priorIds)].sort();
  const available = ids.filter((id) => !excluded.includes(id));
  if (available.length < count) throw new Error("insufficient unseen task IDs");
  const selectedIds = available.sort((a, b) => hash(`${seed}\0${a}`).localeCompare(hash(`${seed}\0${b}`)) || a.localeCompare(b)).slice(0, count);
  const manifest = {
    version: 1, algorithm: "sha256(seed + NUL + taskId), ascending hex", seed,
    source: ARC2_PROVENANCE, candidateIds: [...ids].sort(), excludedIds: excluded, selectedIds,
  };
  return { ...manifest, manifestSha256: hash(JSON.stringify(manifest)) };
}
