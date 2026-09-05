import { playbookBulletIds, playbookSections, stripCounters, type PlaybookDelta } from "../build/delta";
import { hashInput } from "../core/record";

export const PLAYBOOK_SECTIONS = ["lenses", "frame", "discover", "ideate", "form", "build", "retired"] as const;
export type PlaybookSectionName = (typeof PLAYBOOK_SECTIONS)[number];

export const MAX_ACTIVE_BULLETS = 120;

const PREFIX: Record<Exclude<PlaybookSectionName, "retired">, string> = {
  lenses: "L",
  frame: "F",
  discover: "D",
  ideate: "M",
  form: "FM",
  build: "B",
};
const BULLET = /^- (\S+) \[helpful:(\d+) harmful:(\d+)\] (.+)$/;

export interface PlaybookLine {
  /** The complete line, including its original line ending when present. */
  raw: string;
  content: string;
  eol: string;
}

export interface PlaybookBullet {
  id: string;
  helpful: number;
  harmful: number;
  /** Everything after the counter block. Legacy lessons may omit `Why:`. */
  text: string;
  section: PlaybookSectionName;
  line: number;
}

export interface PlaybookSection {
  name: PlaybookSectionName;
  line: number;
  bullets: PlaybookBullet[];
}

export interface Playbook {
  lines: PlaybookLine[];
  sections: PlaybookSection[];
}

export interface ApplyDeltaOptions {
  /** Candidate id or `operator`; written into retirement provenance. */
  by: string;
  /** ISO timestamp for retirement provenance. */
  at: string | Date;
  /** An operator edit resets its evidence counters; evaluated edits preserve them. */
  resetCounters?: boolean;
}

export class PlaybookFormatError extends Error {
  constructor(message: string) { super(message); this.name = "PlaybookFormatError"; }
}
export class PlaybookDeltaError extends Error {
  constructor(message: string) { super(message); this.name = "PlaybookDeltaError"; }
}

function splitLines(md: string): PlaybookLine[] {
  const rawLines = md.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
  return rawLines.map((raw) => {
    const match = /(\r\n|\n|\r)$/.exec(raw);
    const eol = match?.[0] ?? "";
    return { raw, content: eol ? raw.slice(0, -eol.length) : raw, eol };
  });
}

function sectionName(value: string): PlaybookSectionName | undefined {
  return (PLAYBOOK_SECTIONS as readonly string[]).includes(value) ? value as PlaybookSectionName : undefined;
}

function validId(section: PlaybookSectionName, id: string): boolean {
  if (section === "retired") {
    return Object.values(PREFIX).some((prefix) => new RegExp(`^${prefix}[1-9]\\d*$`).test(id));
  }
  return new RegExp(`^${PREFIX[section]}[1-9]\\d*$`).test(id);
}

/** Parse the closed playbook grammar while retaining every source byte for exact serialization. */
export function parsePlaybook(md: string): Playbook {
  const headingNames = playbookSections(md);
  for (const heading of headingNames) {
    if (!sectionName(heading)) throw new PlaybookFormatError(`unknown playbook section "${heading}"`);
  }
  if (new Set(headingNames).size !== headingNames.length) throw new PlaybookFormatError("playbook sections must not repeat");

  const lines = splitLines(md);
  const sections: PlaybookSection[] = [];
  const seenIds = new Set<string>();
  let current: PlaybookSection | undefined;
  for (const [line, value] of lines.entries()) {
    if (value.content.startsWith("## ")) {
      const name = sectionName(value.content.slice(3).trim());
      if (!name) throw new PlaybookFormatError(`unknown playbook section "${value.content.slice(3).trim()}"`);
      current = { name, line, bullets: [] };
      sections.push(current);
      continue;
    }
    if (!current || !value.content.startsWith("- ")) continue;
    const match = BULLET.exec(value.content);
    if (!match) throw new PlaybookFormatError(`malformed playbook bullet on line ${line + 1}`);
    const [, id, helpful, harmful, text] = match as RegExpExecArray & { 1: string; 2: string; 3: string; 4: string };
    if (!validId(current.name, id)) throw new PlaybookFormatError(`bullet "${id}" has the wrong prefix for section "${current.name}"`);
    if (seenIds.has(id)) throw new PlaybookFormatError(`duplicate playbook bullet id "${id}"`);
    seenIds.add(id);
    current.bullets.push({ id, helpful: Number(helpful), harmful: Number(harmful), text, section: current.name, line });
  }

  // Keep Task 10's parser helpers authoritative for heading and counted-id recognition.
  const parsedIds = sections.flatMap((section) => section.bullets.map((bullet) => bullet.id));
  if (headingNames.length !== sections.length || playbookBulletIds(md).join("\0") !== parsedIds.join("\0")) {
    throw new PlaybookFormatError("playbook structure is not canonical");
  }
  return { lines, sections };
}

/** Exact for every parsed document, including CRLF and the presence or absence of a final newline. */
export function serializePlaybook(playbook: Playbook): string {
  return playbook.lines.map((line) => line.raw).join("");
}

function renderBullet(bullet: Pick<PlaybookBullet, "id" | "helpful" | "harmful" | "text">): string {
  return `- ${bullet.id} [helpful:${bullet.helpful} harmful:${bullet.harmful}] ${bullet.text}`;
}

function defaultEol(lines: readonly PlaybookLine[]): string {
  return lines.find((line) => line.eol)?.eol ?? "\n";
}

function replaceContent(lines: PlaybookLine[], at: number, content: string): void {
  const line = lines[at];
  if (!line) throw new PlaybookDeltaError(`playbook line ${at + 1} does not exist`);
  lines[at] = { content, eol: line.eol, raw: `${content}${line.eol}` };
}

function replaceEol(lines: PlaybookLine[], at: number, eol: string): void {
  const line = lines[at];
  if (!line) throw new PlaybookDeltaError(`playbook line ${at + 1} does not exist`);
  lines[at] = { content: line.content, eol, raw: `${line.content}${eol}` };
}

function insertContent(lines: PlaybookLine[], at: number, content: string, preserveFinalNewline: boolean): void {
  const eol = defaultEol(lines);
  const previous = lines[at - 1];
  if (previous && previous.eol === "") replaceEol(lines, at - 1, eol);
  const lineEol = at === lines.length && !preserveFinalNewline ? "" : eol;
  lines.splice(at, 0, { content, eol: lineEol, raw: `${content}${lineEol}` });
}

function finalNewline(lines: readonly PlaybookLine[]): boolean {
  return lines.length > 0 && lines.at(-1)!.eol !== "";
}

function normalizedText(delta: PlaybookDelta): string {
  if (/\r|\n/.test(delta.text) || (delta.why !== undefined && /\r|\n/.test(delta.why))) {
    throw new PlaybookDeltaError("playbook delta text must fit on one line");
  }
  const text = delta.text.trim();
  if (delta.why === undefined || /(?:^|\s)Why:\s/.test(text)) return text;
  const why = delta.why.trim();
  if (!why) throw new PlaybookDeltaError("playbook delta why must not be empty");
  return `${text} Why: ${why}`;
}

function activeSection(name: string): Exclude<PlaybookSectionName, "retired"> {
  const parsed = sectionName(name);
  if (!parsed || parsed === "retired") throw new PlaybookDeltaError(`delta section "${name}" is not an active playbook section`);
  return parsed;
}

function sectionOrThrow(playbook: Playbook, name: Exclude<PlaybookSectionName, "retired">): PlaybookSection {
  const section = playbook.sections.find((value) => value.name === name);
  if (!section) throw new PlaybookDeltaError(`playbook section "${name}" does not exist`);
  return section;
}

function nextId(playbook: Playbook, section: Exclude<PlaybookSectionName, "retired">): string {
  const prefix = PREFIX[section];
  let max = 0;
  for (const id of playbook.sections.flatMap((value) => value.bullets.map((bullet) => bullet.id))) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${max + 1}`;
}

function appendRetiredSection(md: string, content: string, keepFinalNewline: boolean): string {
  const playbook = parsePlaybook(md);
  const lines = [...playbook.lines];
  const retired = playbook.sections.find((section) => section.name === "retired");
  if (retired) {
    const at = retired.bullets.at(-1)?.line ?? retired.line;
    insertContent(lines, at + 1, content, keepFinalNewline);
    return serializePlaybook({ lines, sections: [] });
  }

  const eol = defaultEol(lines);
  const last = lines.at(-1);
  if (last?.eol === "") replaceEol(lines, lines.length - 1, eol);
  if (lines.length > 0 && lines.at(-1)!.content !== "") lines.push({ content: "", eol, raw: eol });
  lines.push({ content: "## retired", eol, raw: `## retired${eol}` });
  const bulletEol = keepFinalNewline ? eol : "";
  lines.push({ content, eol: bulletEol, raw: `${content}${bulletEol}` });
  return serializePlaybook({ lines, sections: [] });
}

/** Apply one already-validated delta without rewriting unrelated markdown. */
export function applyDelta(md: string, delta: PlaybookDelta, options: ApplyDeltaOptions): string {
  const playbook = parsePlaybook(md);
  const sectionName = activeSection(delta.section);
  const section = sectionOrThrow(playbook, sectionName);
  const lines = [...playbook.lines];

  if (delta.op === "add") {
    if (activeBulletCount(md) >= MAX_ACTIVE_BULLETS) throw new PlaybookDeltaError(`playbook already has ${MAX_ACTIVE_BULLETS} active bullets`);
    const bullet = { id: nextId(playbook, sectionName), helpful: 0, harmful: 0, text: normalizedText(delta) };
    const at = section.bullets.at(-1)?.line ?? section.line;
    insertContent(lines, at + 1, renderBullet(bullet), finalNewline(lines));
    return serializePlaybook({ lines, sections: [] });
  }

  if (!delta.id) throw new PlaybookDeltaError(`${delta.op} requires a bullet id`);
  const bullet = section.bullets.find((value) => value.id === delta.id);
  if (!bullet) throw new PlaybookDeltaError(`bullet "${delta.id}" does not exist in section "${sectionName}"`);
  if (delta.op === "edit") {
    replaceContent(lines, bullet.line, renderBullet({
      id: bullet.id,
      helpful: options.resetCounters ? 0 : bullet.helpful,
      harmful: options.resetCounters ? 0 : bullet.harmful,
      text: normalizedText(delta),
    }));
    return serializePlaybook({ lines, sections: [] });
  }

  if (!options.by.trim() || /\r|\n/.test(options.by)) throw new PlaybookDeltaError("retirement author must be a non-empty line");
  const date = options.at instanceof Date ? options.at : new Date(options.at);
  if (Number.isNaN(date.valueOf())) throw new PlaybookDeltaError("retirement timestamp must be a valid ISO date");
  const keepFinalNewline = finalNewline(lines);
  lines.splice(bullet.line, 1);
  const without = serializePlaybook({ lines, sections: [] });
  const retired = { ...bullet, text: `${bullet.text} (retired ${date.toISOString()} by ${options.by.trim()})` };
  return appendRetiredSection(without, renderBullet(retired), keepFinalNewline);
}

export function activeBulletCount(md: string): number {
  return parsePlaybook(md).sections
    .filter((section) => section.name !== "retired")
    .reduce((count, section) => count + section.bullets.length, 0);
}

/** Stable across evidence-counter changes, but not instructional changes. */
export function playbookHash(md: string): string {
  return hashInput(stripCounters(md));
}
