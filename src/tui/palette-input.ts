export interface PaletteInvocation {
  readonly args?: readonly string[];
  readonly missing?: string;
}

const words = (draft: string) => draft.trim().split(/\s+/).filter(Boolean);

/** Bind run-scoped palette actions to the attached run and take remaining values from the prompt draft. */
export function paletteInvocation(commandId: string, runId: string | undefined, draft: string): PaletteInvocation {
  const values = words(draft);
  if (["auth: login anthropic", "auth: login openai", "auth: status", "model: roles", "mode: toggle", "build: pause"].includes(commandId)) return { args: [] };
  if (commandId === "auth: logout") return { args: values.length ? values : ["all"] };
  if (commandId === "evals: calibrate") return values.length ? { args: values } : { missing: "type --labels human|agent --budget USD, then reopen the command palette" };
  if (commandId === "run: new") return values.length > 0 ? { args: values } : { missing: "type a seed, then reopen the command palette" };
  if (commandId === "run: resume") return runId ? { args: [runId] } : values.length === 1 ? { args: values } : { missing: "type one run id, then reopen the command palette" };
  if (["run: show record", "ideas: frontier", "project: form", "build: start"].includes(commandId)) {
    return runId ? { args: [runId] } : { missing: "attach a run first" };
  }
  if (["ideas: pick", "ideas: another round"].includes(commandId)) {
    return runId && values.length > 0 ? { args: [runId, ...values] } : { missing: "type the idea or steering, then reopen the command palette" };
  }
  return { args: values };
}
