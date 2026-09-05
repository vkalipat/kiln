import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: `src/brain/prompts.ts` → `kiln/`, where the bundled `prompts/` and `playbook/` live. */
const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type PromptName = "kernel" | "brain" | "scout" | "judge" | "generator" | "prober" | "arbiter" | "critic" | "builder" | "auditor" | "reflector";

/** Every prompt a fresh home gets a copy of, relative to the package root. */
export const PROMPT_FILES: readonly PromptName[] = ["kernel", "brain", "scout", "judge", "generator", "prober", "arbiter", "critic", "builder", "auditor", "reflector"];

/** Reads `<home>/prompts/<name>.md`, falling back to the bundled copy so a fresh home works unedited. */
export function loadPrompt(home: string, name: PromptName): string {
  const local = join(home, "prompts", `${name}.md`);
  return readFileSync(existsSync(local) ? local : join(BUNDLED, "prompts", `${name}.md`), "utf8");
}

/** Reads `<home>/playbook/playbook.md`, falling back to the bundled copy. */
export function loadPlaybook(home: string): string {
  const local = join(home, "playbook", "playbook.md");
  return readFileSync(existsSync(local) ? local : join(BUNDLED, "playbook", "playbook.md"), "utf8");
}

/** The bullets under `## <section>`, trimmed; empty string when the section is absent or empty. */
export function playbookSection(md: string, section: string): string {
  const found = md.split(/^## /m).find((s) => s.startsWith(`${section}\n`) || s.trimEnd() === section);
  return found ? found.slice(section.length).trim() : "";
}
