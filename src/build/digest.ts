import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { ROLES, type Role } from "../core/config";
import type { StoredEvent } from "../core/events";
import { writeAtomic } from "../core/paths";
import { hashInput, RunRecord } from "../core/record";
import { readStatus, type RunPaths, type RunStatus } from "../core/run";
import { parseFeatures, type Feature, type FeaturesFile } from "../formation/features";
import { foldState, type BuildState } from "./state";

/** Record §13: the digest is capped at 16 kB, dropping per-feature sections first. */
export const DIGEST_CAP_BYTES = 16_384;
export const CHECK_EXCERPT_CHARS = 300;
/** A check's captured output can run to megabytes; only its head can ever reach the digest. */
const CHECK_OUTPUT_READ_BYTES = 4_096;

export interface DigestInputs {
  events: readonly StoredEvent[];
  status: Pick<RunStatus, "phase" | "state" | "outcome">;
  features?: FeaturesFile;
  state?: BuildState;
  /** Reads a check's captured output by path; the default reads the file's head and names a missing one. */
  checkOutput?: (path: string) => string;
}

export interface DigestComposition { text: string; truncated: boolean; droppedFeatures: number }
export interface Digest { text: string; hash: string; bytes: number; truncated: boolean }

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Free text from the run stays on one line so it can never open a `## ` heading of its own. */
function line(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function count(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return out;
}

function section(heading: string, lines: readonly string[]): string {
  return [`## ${heading}`, ...(lines.length > 0 ? lines : ["- none"])].join("\n");
}

function eventCounts(events: readonly StoredEvent[]): string[] {
  const counts = count(events.map((event) => event.t));
  return Object.keys(counts).sort().map((type) => `- ${type}: ${counts[type]}`);
}

function usageLine(label: string, calls: number, cost: number, usage: Usage): string {
  return `- ${label}: calls ${calls}, cost $${cost.toFixed(4)}, input ${usage.input}, output ${usage.output}, cacheRead ${usage.cacheRead}, cacheWrite ${usage.cacheWrite}`;
}

/** Every usage field the brain records survives here (practices §E); nothing is collapsed into a single number. */
function costByRole(events: readonly StoredEvent[]): string[] {
  const byRole = new Map<Role, { calls: number; cost: number; usage: Usage }>();
  const total = { calls: 0, cost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const event of events) {
    if (event.t !== "model.call") continue;
    const held = byRole.get(event.role) ?? { calls: 0, cost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    for (const bucket of [held, total]) {
      bucket.calls += 1; bucket.cost += event.costUsd;
      bucket.usage.input += event.usage.input; bucket.usage.output += event.usage.output;
      bucket.usage.cacheRead += event.usage.cacheRead; bucket.usage.cacheWrite += event.usage.cacheWrite;
    }
    byRole.set(event.role, held);
  }
  const lines = ROLES.flatMap((role) => { const held = byRole.get(role); return held ? [usageLine(role, held.calls, held.cost, held.usage)] : []; });
  return lines.length === 0 ? [] : [...lines, usageLine("total", total.calls, total.cost, total.usage)];
}

function failuresByClass(events: readonly StoredEvent[]): string[] {
  const counts = count(events.flatMap((event) => event.t === "failure" ? [event.class] : []));
  return Object.keys(counts).sort().map((cls) => `- ${cls}: ${counts[cls]}`);
}

function honestExitsByKind(events: readonly StoredEvent[]): string[] {
  const counts = count(events.flatMap((event) => event.t === "honest_exit" ? [`${line(event.kind)} (${event.source ?? "unrecorded"})`] : []));
  return Object.keys(counts).sort().map((key) => `- ${key}: ${counts[key]}`);
}

function checkLine(event: Extract<StoredEvent, { t: "check" }>, checkOutput: (path: string) => string): string {
  const verdict = event.notRunReason !== undefined ? `not run (${line(event.notRunReason)})` : `${event.ok ? "ok" : "failed"}, exit ${event.exitCode ?? "none"}${event.timedOut ? ", timed out" : ""}`;
  return `check ${line(event.checkId)} (${event.phase}): ${verdict}: ${line(checkOutput(event.outputPath)).slice(0, CHECK_EXCERPT_CHARS)}`;
}

function featureSection(feature: Feature, events: readonly StoredEvent[], state: BuildState | undefined, checkOutput: (path: string) => string): string {
  const held = state?.[feature.id];
  const summary = held
    ? `state: ${held.state}, attempts ${held.attempts}${held.blocked ? `, blocked ${line(held.blockedReason ?? "unknown")}` : ""}${held.regressedBy ? `, regressed by ${line(held.regressedBy)}` : ""}`
    : "state: unknown";
  const attempts = events.flatMap((event) => event.t === "attempt" && event.featureId === feature.id ? [event] : []);
  const checks = events.flatMap((event) => event.t === "check" && event.featureId === feature.id ? [event] : []);
  const shown = new Set<number>();
  const lines: string[] = [];
  for (const attempt of attempts) {
    lines.push(`- attempt ${attempt.attempt} (${attempt.arm}): ${attempt.disposition}, builder ${attempt.builderStopped}, cost $${attempt.costUsd.toFixed(4)}, ${attempt.counted ? "counted" : "not counted"}`);
    for (const check of checks) if (check.attempt === attempt.attempt) { shown.add(check.seq); lines.push(`  ${checkLine(check, checkOutput)}`); }
  }
  for (const check of checks) if (!shown.has(check.seq)) lines.push(`- ${checkLine(check, checkOutput)}`);
  return [`## Feature ${line(feature.id)}`, `title: ${line(feature.title)}`, summary, ...lines].join("\n");
}

function toolUse(events: readonly StoredEvent[]): string[] {
  const byName = new Map<string, { calls: number; failed: number }>();
  for (const event of events) {
    if (event.t !== "tool.call") continue;
    const held = byName.get(event.name) ?? { calls: 0, failed: 0 };
    held.calls += 1; if (!event.ok) held.failed += 1;
    byName.set(event.name, held);
  }
  return [...byName.entries()].sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0])).map(([name, held]) => `- ${line(name)}: ${held.calls} calls, ${held.failed} failed`);
}

function stallFingerprints(events: readonly StoredEvent[]): string[] {
  return [...new Set(events.flatMap((event) => event.t === "stall" ? [`- ${line(event.featureId)} attempt ${event.attempt}: ${line(event.tool)} ${line(event.fingerprint)}`] : []))];
}

function stopKind(status: DigestInputs["status"], events: readonly StoredEvent[]): string[] {
  const outcome = status.outcome;
  const lastStop = events.findLast((event) => event.t === "stop");
  // `buildSuccess` leaves the run open (`phase: reflect, state: running`) until reflect closes it; that is a finished run, not a running one.
  const kind = outcome?.kind ?? (status.phase === "reflect" && status.state === "running" ? "success" : status.state);
  const lines = [`- outcome: ${kind}`, `- stopKind: ${outcome?.stopKind ?? (lastStop?.t === "stop" ? lastStop.stopKind : undefined) ?? "none"}`];
  if (outcome?.exitKind) lines.push(`- exitKind: ${line(outcome.exitKind)}`);
  if (outcome?.failureClass) lines.push(`- failureClass: ${outcome.failureClass}`);
  return lines;
}

/** Cut at the cap without leaving a torn multi-byte sequence behind. */
function truncateUtf8(text: string, cap: number): string {
  const buffer = Buffer.from(text, "utf8");
  let end = cap;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function readHead(path: string): string {
  if (!existsSync(path)) return "(output missing)";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(CHECK_OUTPUT_READ_BYTES);
    const read = readSync(fd, buffer, 0, CHECK_OUTPUT_READ_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Pure composition: the fixed aggregates and per-feature histories the record names, each under a `## ` heading. */
export function composeDigest(inputs: DigestInputs): DigestComposition {
  const { events, status } = inputs;
  const checkOutput = inputs.checkOutput ?? readHead;
  const head = [
    section("Event counts", eventCounts(events)),
    section("Cost and tokens by role", costByRole(events)),
    section("Failures by class", failuresByClass(events)),
    section("Honest exits by kind", honestExitsByKind(events)),
  ];
  const perFeature = (inputs.features?.features ?? []).map((feature) => featureSection(feature, events, inputs.state, checkOutput));
  const tail = [section("Tool use", toolUse(events)), section("Stall fingerprints", stallFingerprints(events)), section("Stop kind", stopKind(status, events))];
  const render = (kept: number): string => {
    const note = kept < perFeature.length ? [`(${perFeature.length - kept} per-feature sections dropped to fit the ${DIGEST_CAP_BYTES}-byte cap)`] : [];
    return `${[...head, ...perFeature.slice(0, kept), ...note, ...tail].join("\n\n")}\n`;
  };
  let kept = perFeature.length;
  let text = render(kept);
  while (Buffer.byteLength(text) > DIGEST_CAP_BYTES && kept > 0) { kept -= 1; text = render(kept); }
  const cut = Buffer.byteLength(text) > DIGEST_CAP_BYTES;
  if (cut) text = truncateUtf8(text, DIGEST_CAP_BYTES);
  return { text, truncated: cut || kept < perFeature.length, droppedFeatures: perFeature.length - kept };
}

/** The `## ` headings of a digest text: the namespace a `digest` evidence ref must name. */
export function digestHeadings(text: string): string[] {
  return text.split("\n").flatMap((value) => value.startsWith("## ") ? [value.slice(3).trim()] : []);
}

function readFeatures(paths: RunPaths): FeaturesFile | undefined {
  if (!existsSync(paths.features)) return undefined;
  try { return parseFeatures(readFileSync(paths.features, "utf8")) as FeaturesFile; } catch { return undefined; }
}

/** Composes the digest from the durable run files, writes `reflect/digest.md`, and returns its hash. */
export function buildDigest(paths: RunPaths): Digest {
  const events = new RunRecord(paths.record).read();
  const status = readStatus(paths);
  const features = readFeatures(paths);
  let state: BuildState | undefined;
  if (features) { try { state = foldState(paths); } catch { state = undefined; } }
  const { text, truncated } = composeDigest({ events, status, features, state });
  writeAtomic(paths.digest, text);
  return { text, hash: hashInput(text), bytes: Buffer.byteLength(text), truncated };
}
